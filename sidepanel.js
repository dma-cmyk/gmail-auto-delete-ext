// sidepanel.js - 全件チェック＋全件削除UI
const $ = (id) => document.getElementById(id);
let lastCheckedIds = [];
let cancelRequested = false;

function log(msg) {
  const el = $("log");
  const time = new Date().toLocaleTimeString();
  el.textContent += `[${time}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
  chrome.storage.local.set({ popupLog: el.textContent.slice(-8000) });
}

function buildQuery() {
  const parts = [];
  if ($("inbox-only").checked) parts.push("in:inbox");
  const rs = $("read-status").value;
  if (rs === "unread") parts.push("is:unread");
  else if (rs === "read") parts.push("is:read");
  const from = $("from-input").value.trim();
  if (from) parts.push(`from:${from}`);
  const subject = $("subject-input").value.trim();
  if (subject) parts.push(`subject:(${subject})`);
  const older = parseInt($("older-input").value, 10);
  if (!isNaN(older) && older > 0) parts.push(`older_than:${older}d`);
  const extra = $("extra-input").value.trim();
  if (extra) parts.push(`(${extra})`);
  return parts.join(" ").trim();
}

function refreshQueryPreview() {
  $("query-preview").textContent = "検索式: " + (buildQuery() || "(全メール ※危険)");
}
["read-status", "inbox-only", "from-input", "subject-input", "older-input", "extra-input"].forEach((id) => {
  $(id).addEventListener("input", refreshQueryPreview);
  $(id).addEventListener("change", refreshQueryPreview);
});

function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(token);
    });
  });
}

async function gmailFetch(token, path, options = {}) {
  const { _token, ...fetchOpts } = options;
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
    ...fetchOpts,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(fetchOpts.headers || {}) },
  });
  if (res.status === 401) {
    if (_token) await new Promise((r) => chrome.identity.removeCachedAuthToken({ token: _token }, r));
    throw new Error("認証切れ (401)。再ログインしてください。");
  }
  if (!res.ok) throw new Error(`Gmail APIエラー ${res.status}: ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

// 条件一致IDをページングで全件取得
async function listAllMessageIds(token, q, onProgress) {
  const ids = [];
  let pageToken = undefined;
  let estimate = 0;
  let page = 0;
  do {
    if (cancelRequested) throw new Error("中断しました");
    const params = new URLSearchParams({ q, maxResults: "500" });
    if (pageToken) params.set("pageToken", pageToken);
    const list = await gmailFetch(token, `/users/me/messages?${params.toString()}`, { _token: token });
    const msgs = list.messages || [];
    msgs.forEach((m) => ids.push(m.id));
    estimate = list.resultSizeEstimate ?? ids.length;
    pageToken = list.nextPageToken;
    page++;
    onProgress?.(ids.length, estimate, page);
    // 安全弁: 2万件で停止
    if (ids.length >= 20000) {
      log("安全弁: 20000件で取得を停止しました。条件を絞ってください。");
      break;
    }
  } while (pageToken);
  return { ids, estimate };
}

function setBusy(busy) {
  $("check-btn").disabled = busy;
  $("delete-btn").disabled = busy || lastCheckedIds.length === 0;
  $("stop-btn").disabled = !busy;
  $("progress").hidden = !busy;
  if (!busy) $("progress").value = 0;
}

async function updateAuthStatus() {
  try {
    const token = await getAuthToken(false);
    if (!token) throw new Error("no token");
    const profile = await gmailFetch(token, "/users/me/profile", { _token: token });
    $("auth-status").textContent = profile.emailAddress;
    return true;
  } catch {
    $("auth-status").textContent = "未ログイン";
    return false;
  }
}

async function checkAllMails() {
  const q = buildQuery();
  if (!q && !confirm("検索条件が空です。全メールが対象になり危険です。続行しますか？")) return;
  cancelRequested = false;
  setBusy(true);
  $("result-list").innerHTML = "";
  lastCheckedIds = [];
  try {
    const token = await getAuthToken(true);
    await updateAuthStatus();
    log(`全件チェック開始: q="${q}"`);
    const onProgress = (got, est, page) => {
      $("progress-text").textContent = `${got} 件取得中… (推定${est}件, ${page}ページ)`;
      $("progress").value = est ? Math.min((got / est) * 100, 99) : 50;
    };
    const { ids, estimate } = await listAllMessageIds(token, q, onProgress);
    lastCheckedIds = ids;
    $("result-count").textContent = `${ids.length} 件（推定${estimate}件）`;
    $("progress").value = 100;
    $("progress-text").textContent = `取得完了: ${ids.length} 件`;
    $("delete-btn").disabled = ids.length === 0;
    // 先頭30件だけ詳細表示
    for (const id of ids.slice(0, 30)) {
      if (cancelRequested) break;
      const d = await gmailFetch(token, `/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { _token: token });
      const headers = Object.fromEntries((d.payload?.headers || []).map((h) => [h.name, h.value]));
      const li = document.createElement("li");
      li.textContent = `${headers.Subject || "(件名なし)"} / ${headers.From || "?"} [${(d.labelIds || []).includes("UNREAD") ? "未読" : "既読"}]`;
      $("result-list").appendChild(li);
    }
    if (ids.length > 30) {
      const li = document.createElement("li");
      li.textContent = `…ほか ${ids.length - 30} 件（全件削除の対象になります）`;
      $("result-list").appendChild(li);
    }
    log(`全件チェック完了: ${ids.length} 件`);
  } catch (e) {
    log(`チェック失敗: ${e.message}`);
  } finally {
    setBusy(false);
  }
}

async function deleteAllChecked() {
  if (lastCheckedIds.length === 0) return;
  const mode = $("delete-mode").value;
  const label = mode === "trash" ? "ゴミ箱送り" : "完全削除（復元不可）";
  const q = buildQuery();
  if (!confirm(`${lastCheckedIds.length} 件を${label}します。\n条件: ${q}\n本当によろしいですか？`)) return;
  if (mode === "permanent" && !confirm("完全削除は元に戻せません。実行しますか？")) return;
  cancelRequested = false;
  setBusy(true);
  $("delete-btn").disabled = true;
  try {
    const token = await getAuthToken(true);
    let ok = 0, ng = 0;
    const total = lastCheckedIds.length;
    log(`全件削除開始: ${total} 件 mode=${mode}`);
    for (let i = 0; i < total; i += 5) {
      if (cancelRequested) { log(`中断: ${i}/${total} で停止`); break; }
      const chunk = lastCheckedIds.slice(i, i + 5);
      const results = await Promise.allSettled(
        chunk.map((id) =>
          mode === "trash"
            ? gmailFetch(token, `/users/me/messages/${id}/trash`, { method: "POST", _token: token })
            : gmailFetch(token, `/users/me/messages/${id}`, { method: "DELETE", _token: token })
        )
      );
      results.forEach((r) => (r.status === "fulfilled" ? ok++ : ng++));
      const done = Math.min(i + 5, total);
      $("progress").value = (done / total) * 100;
      $("progress-text").textContent = `削除中: ${done}/${total}（成功${ok} 失敗${ng}）`;
      if (done % 100 === 0 || done === total) log(`進捗: ${done}/${total}（成功${ok} 失敗${ng}）`);
    }
    log(`削除完了: 成功${ok} 失敗${ng}`);
    $("result-count").textContent = `完了: 成功${ok} / 失敗${ng}`;
    lastCheckedIds = [];
    $("result-list").innerHTML = "";
  } catch (e) {
    log(`削除失敗: ${e.message}`);
  } finally {
    setBusy(false);
    $("delete-btn").disabled = lastCheckedIds.length === 0;
  }
}

function collectFilter() {
  return {
    readStatus: $("read-status").value,
    inboxOnly: $("inbox-only").checked,
    from: $("from-input").value.trim(),
    subject: $("subject-input").value.trim(),
    older: $("older-input").value.trim(),
    extra: $("extra-input").value.trim(),
  };
}

async function loadSettings() {
  const s = await chrome.storage.sync.get(["filter", "deleteMode", "autoEnabled", "autoInterval"]);
  if (s.filter) {
    $("read-status").value = s.filter.readStatus || "unread";
    $("inbox-only").checked = s.filter.inboxOnly !== false;
    $("from-input").value = s.filter.from || "";
    $("subject-input").value = s.filter.subject || "";
    $("older-input").value = s.filter.older || "";
    $("extra-input").value = s.filter.extra || "";
  }
  if (s.deleteMode) $("delete-mode").value = s.deleteMode;
  $("auto-enabled").checked = !!s.autoEnabled;
  $("auto-interval").value = s.autoInterval || 60;
  $("auto-status").textContent = s.autoEnabled ? `自動削除ON (${s.autoInterval}分間隔・全件処理)` : "自動削除OFF";
  const local = await chrome.storage.local.get("popupLog");
  if (local.popupLog) $("log").textContent = local.popupLog;
  refreshQueryPreview();
}

$("check-btn").addEventListener("click", checkAllMails);
$("delete-btn").addEventListener("click", deleteAllChecked);
$("stop-btn").addEventListener("click", () => { cancelRequested = true; log("停止要求を受け付けました…"); });
$("login-btn").addEventListener("click", async () => {
  try { await getAuthToken(true); await updateAuthStatus(); log("ログイン成功"); }
  catch (e) { log(`ログイン失敗: ${e.message}`); }
});
$("logout-btn").addEventListener("click", async () => {
  try {
    const token = await getAuthToken(false).catch(() => null);
    if (token) {
      await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
      await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
    }
    await chrome.identity.clearAllCachedAuthTokens();
    $("auth-status").textContent = "未ログイン";
    log("ログアウトしました");
  } catch (e) { log(`ログアウト失敗: ${e.message}`); }
});
$("save-auto-btn").addEventListener("click", async () => {
  const autoEnabled = $("auto-enabled").checked;
  const autoInterval = Math.max(parseInt($("auto-interval").value, 10) || 60, 1);
  await chrome.storage.sync.set({ autoEnabled, autoInterval, filter: collectFilter(), deleteMode: $("delete-mode").value });
  await chrome.runtime.sendMessage({ type: "UPDATE_ALARM" });
  $("auto-status").textContent = autoEnabled ? `自動削除ON (${autoInterval}分間隔・全件処理)で保存` : "自動削除OFFで保存";
  log(`自動削除設定を保存: ON=${autoEnabled} 間隔=${autoInterval}分`);
});
$("clear-log-btn").addEventListener("click", async () => {
  $("log").textContent = "";
  await chrome.storage.local.remove("popupLog");
});

loadSettings();
updateAuthStatus();
