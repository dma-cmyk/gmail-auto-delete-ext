// background.js - 定期自動削除用 Service Worker (MV3)
const ALARM_NAME = "gmail-auto-delete";

function buildQueryFromFilter(f = {}) {
  const parts = [];
  if (f.inboxOnly !== false) parts.push("in:inbox");
  if (f.readStatus === "unread") parts.push("is:unread");
  else if (f.readStatus === "read") parts.push("is:read");
  if (f.from) parts.push(`from:${f.from}`);
  if (f.subject) parts.push(`subject:(${f.subject})`);
  const older = parseInt(f.older, 10);
  if (!isNaN(older) && older > 0) parts.push(`older_than:${older}d`);
  if (f.extra) parts.push(`(${f.extra})`);
  return parts.join(" ").trim();
}

function getAuthTokenNonInteractive() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(token);
    });
  });
}

async function gmailFetch(token, path, options = {}) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

async function runAutoDelete() {
  const s = await chrome.storage.sync.get(["autoEnabled", "autoInterval", "filter", "deleteMode"]);
  if (!s.autoEnabled) return;
  const q = buildQueryFromFilter(s.filter || { readStatus: "unread" });
  if (!q) {
    console.warn("[gmail-auto-delete] 空クエリのため自動削除をスキップ（安全装置）");
    return;
  }
  const mode = s.deleteMode || "trash";
  console.log(`[gmail-auto-delete] 実行 q="${q}" mode=${mode}（全件処理）`);
  const token = await getAuthTokenNonInteractive();
  // 全ページ取得（安全弁5000件）
  const ids = [];
  let pageToken = undefined;
  do {
    const params = new URLSearchParams({ q, maxResults: "500" });
    if (pageToken) params.set("pageToken", pageToken);
    const list = await gmailFetch(token, `/users/me/messages?${params.toString()}`);
    (list.messages || []).forEach((m) => ids.push(m.id));
    pageToken = list.nextPageToken;
    if (ids.length >= 5000) {
      console.warn("[gmail-auto-delete] 安全弁: 5000件で停止");
      break;
    }
  } while (pageToken);
  const msgs = ids;
  if (msgs.length === 0) {
    console.log("[gmail-auto-delete] 対象なし");
    return;
  }
  let ok = 0;
  for (let i = 0; i < msgs.length; i += 5) {
    const chunk = msgs.slice(i, i + 5);
    const results = await Promise.allSettled(
      chunk.map((id) =>
        mode === "trash"
          ? gmailFetch(token, `/users/me/messages/${id}/trash`, { method: "POST" })
          : gmailFetch(token, `/users/me/messages/${id}`, { method: "DELETE" })
      )
    );
    ok += results.filter((r) => r.status === "fulfilled").length;
  }
  console.log(`[gmail-auto-delete] 完了 ${ok}/${msgs.length}`);
  await chrome.storage.local.set({ lastAutoRun: new Date().toISOString(), lastAutoCount: ok });
}

async function refreshAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  const s = await chrome.storage.sync.get(["autoEnabled", "autoInterval"]);
  if (s.autoEnabled) {
    const minutes = Math.max(s.autoInterval || 60, 1);
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
    console.log(`[gmail-auto-delete] アラーム設定: ${minutes}分間隔`);
  } else {
    console.log("[gmail-auto-delete] 自動削除OFF");
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runAutoDelete().catch((e) => console.error(e));
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "UPDATE_ALARM") {
    refreshAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  refreshAlarm();
  // アイコンクリックでサイドパネルを開く
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => console.error(e));
  }
});
chrome.runtime.onStartup.addListener(() => refreshAlarm());

// 古いChrome用フォールバック: クリックで明示的に開く
if (chrome.sidePanel?.open) {
  chrome.action?.onClicked.addListener(async (tab) => {
    try { await chrome.sidePanel.open({ windowId: tab.windowId }); } catch (e) { console.error(e); }
  });
}
