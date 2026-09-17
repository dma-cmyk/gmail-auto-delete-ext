// popup.js - Gmailチェック＋削除UI
const $ = (id) => document.getElementById(id);

function log(msg) {
  const el = $("log");
  const time = new Date().toLocaleTimeString();
  el.textContent += `[${time}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
  chrome.storage.local.set({ popupLog: el.textContent.slice(-4000) });
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
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (res.status === 401) {
    // トークン切れの可能性があるのでキャッシュ削除してエラーを投げる
    const t = options._token;
    if (t) await new Promise((r) => chrome.identity.removeCachedAuthToken({ token: t }, r));
    throw new Error("認証切れ (401)。再ログインしてください。");
  }
  if (!res.ok) throw new Error(`Gmail APIエラー ${res.status}: ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

let lastCheckedIds = [];

async function updateAuthStatus() {
  try {
    const token = await getAuthToken(false);
    if (!token) throw new Error("no token");
    const profile = await gmailFetch(token, "/users/me/profile", { _token: token });
    $("auth-status").textContent = `ログイン中: ${profile.emailAddress}`;
    log(`ログイン確認: ${profile.emailAddress}`);
  } catch {
    $("auth-status").textContent = "未ログイン";
  }
}

async function checkMails() {
  const q = buildQuery();
  const max = Math.min(Math.max(parseInt($("max-input").value, 10) || 20, 1), 500);
  if (!q) {
    if (!confirm("検索条件が空です。全メールが対象になり危険です。続行しますか？")) return;
  }
  log(`チェック開始: q="${q}" max=${max}`);
  $("check-btn").disabled = true;
  try {
    const token = await getAuthToken(true);
    await updateAuthStatus();
    const list = await gmailFetch(token, `/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${max}`, { _token: token });
    const msgs = list.messages || [];
    lastCheckedIds = msgs.map((m) => m.id);
    $("result-count").textContent = `${msgs.length} 件見つかりました${list.resultSizeEstimate ? ` (推定 ${list.resultSizeEstimate} 件中)` : ""}`;
    $("result-list").innerHTML = "";
    $("delete-btn").disabled = msgs.length === 0;
    // 詳細を最大20件まで取得して表示
    for (const m of msgs.slice(0, 20)) {
      const detail = await gmailFetch(token, `/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { _token: token });
      const headers = Object.fromEntries((detail.payload?.headers || []).map((h) => [h.name, h.value]));
      const li = document.createElement("li");
      li.textContent = `${headers.Subject || "(件名なし)"} / ${headers.From || "?"} / ${headers.Date || ""} [${(detail.labelIds || []).includes("UNREAD") ? "未読" : "既読"}]`;
      $("result-list").appendChild(li);
    }
    if (msgs.length > 20) {
      const li = document.createElement("li");
      li.textContent = `…ほか ${msgs.length - 20} 件`;
      $("result-list").appendChild(li);
    }
    log(`チェック完了: ${msgs.length} 件`);
  } catch (e) {
    log(`チェック失敗: ${e.message}`);
    alert(`チェック失敗: ${e.message}`);
  } finally {
    $("check-btn").disabled = false;
  }
}

async function deleteChecked() {
  if (lastCheckedIds.length === 0) return;
  const mode = $("delete-mode").value; // trash | permanent
  const label = mode === "trash" ? "ゴミ箱送り" : "完全削除 (復元不可)";
  if (!confirm(`${lastCheckedIds.length} 件を${label}します。本当によろしいですか？`)) return;
  log(`削除開始: ${lastCheckedIds.length} 件 mode=${mode}`);
  $("delete-btn").disabled = true;
  try {
    const token = await getAuthToken(true);
    let ok = 0, ng = 0;
    // 並列5件ずつで実行
    for (let i = 0; i < lastCheckedIds.length; i += 5) {
      const chunk = lastCheckedIds.slice(i, i + 5);
      const results = await Promise.allSettled(
        chunk.map((id) => {
          if (mode === "trash") return gmailFetch(token, `/users/me/messages/${id}/trash`, { method: "POST", _token: token });
          return gmailFetch(token, `/users/me/messages/${id}`, { method: "DELETE", _token: token });
        })
      );
      results.forEach((r) => (r.status === "fulfilled" ? ok++ : ng++));
      log(`進捗: ${Math.min(i + 5, lastCheckedIds.length)}/${lastCheckedIds.length} (成功${ok} 失敗${ng})`);
    }
    log(`削除完了: 成功${ok} 失敗${ng}`);
    alert(`完了: 成功${ok}件 / 失敗${ng}件`);
    lastCheckedIds = [];
    $("result-count").textContent = "";
    $("result-list").innerHTML = "";
  } catch (e) {
    log(`削除失敗: ${e.message}`);
    alert(`削除失敗: ${e.message}`);
  } finally {
    $("delete-btn").disabled = lastCheckedIds.length === 0;
  }
}

async function loadSettings() {
  const s = await chrome.storage.sync.get(["filter", "deleteMode", "autoEnabled", "autoInterval", "maxResults"]);
  if (s.filter) {
    $("read-status").value = s.filter.readStatus || "unread";
    $("inbox-only").checked = s.filter.inboxOnly !== false;
    $("from-input").value = s.filter.from || "";
    $("subject-input").value = s.filter.subject || "";
    $("older-input").value = s.filter.older || "";
    $("extra-input").value = s.filter.extra || "";
  }
  if (s.deleteMode) $("delete-mode").value = s.deleteMode;
  if (s.maxResults) $("max-input").value = s.maxResults;
  $("auto-enabled").checked = !!s.autoEnabled;
  $("auto-interval").value = s.autoInterval || 60;
  $("auto-status").textContent = s.autoEnabled ? `自動削除ON (${s.autoInterval}分間隔)` : "自動削除OFF";
  const local = await chrome.storage.local.get("popupLog");
  if (local.popupLog) $("log").textContent = local.popupLog;
  refreshQueryPreview();
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

$("check-btn").addEventListener("click", checkMails);
$("delete-btn").addEventListener("click", deleteChecked);
$("login-btn").addEventListener("click", async () => {
  try {
    await getAuthToken(true);
    await updateAuthStatus();
    log("ログイン成功");
  } catch (e) {
    log(`ログイン失敗: ${e.message}`);
  }
});
$("logout-btn").addEventListener("click", async () => {
  try {
    const token = await getAuthToken(false).catch(() => null);
    if (token) {
      await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
      await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
    }
    // 全トークンキャッシュをクリア
    await chrome.identity.clearAllCachedAuthTokens();
    $("auth-status").textContent = "未ログイン";
    log("ログアウトしました");
  } catch (e) {
    log(`ログアウト失敗: ${e.message}`);
  }
});
$("save-auto-btn").addEventListener("click", async () => {
  const autoEnabled = $("auto-enabled").checked;
  const autoInterval = Math.max(parseInt($("auto-interval").value, 10) || 60, 1);
  const filter = collectFilter();
  const deleteMode = $("delete-mode").value;
  const maxResults = Math.min(Math.max(parseInt($("max-input").value, 10) || 20, 1), 500);
  await chrome.storage.sync.set({ autoEnabled, autoInterval, filter, deleteMode, maxResults });
  await chrome.runtime.sendMessage({ type: "UPDATE_ALARM" });
  $("auto-status").textContent = autoEnabled ? `自動削除ON (${autoInterval}分間隔)で保存` : "自動削除OFFで保存";
  log(`自動削除設定を保存: ON=${autoEnabled} 間隔=${autoInterval}分 mode=${deleteMode}`);
});
$("clear-log-btn").addEventListener("click", async () => {
  $("log").textContent = "";
  await chrome.storage.local.remove("popupLog");
});

// フィルタ変更時は自動保存しない（明示保存のみ）がプレビューは更新
loadSettings();
updateAuthStatus();
