// MV3 service worker — offscreen 문서 라이프사이클 + 메시지 라우팅

const OFFSCREEN_PATH = "offscreen.html";
let running = false;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],
    justification: "마이크 입력으로 OpenAI Realtime API 와 WebRTC 통신",
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

async function broadcastToTabs(msg) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.id) continue;
    chrome.tabs.sendMessage(t.id, msg).catch(() => {});
  }
}

async function injectContentToAllTabs() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.id || !t.url) continue;
    if (/^(chrome|edge|about|chrome-extension|devtools):/i.test(t.url)) continue;
    if (t.url.startsWith("https://chrome.google.com/webstore")) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] });
      await chrome.scripting.insertCSS({ target: { tabId: t.id }, files: ["content.css"] });
    } catch (_) { /* 일부 페이지(403, 로그인 페이지 등)는 거부 — 무시 */ }
  }
}

async function openPermissionTab() {
  const url = chrome.runtime.getURL("permission.html");
  // 이미 열려있으면 그것을 활성화
  const existing = await chrome.tabs.query({ url });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}

function isPermissionError(err) {
  const s = (err || "").toString().toLowerCase();
  return s.includes("permission") || s.includes("notallowed") || s.includes("dismissed") || s.includes("denied");
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "start") {
      try {
        await ensureOffscreen();
        const r = await chrome.runtime.sendMessage({ type: "offscreen-start", cfg: msg.cfg });
        if (!r?.ok) {
          if (isPermissionError(r?.error)) {
            await closeOffscreen();
            await openPermissionTab();
            sendResponse({ ok: false, error: "마이크 권한이 필요합니다. 새 탭에서 '허용' 후 다시 시작해주세요." });
            return;
          }
          throw new Error(r?.error || "offscreen 시작 실패");
        }
        running = true;
        await injectContentToAllTabs();
        await broadcastToTabs({ type: "overlay-show" });
        sendResponse({ ok: true });
      } catch (e) {
        running = false;
        await closeOffscreen();
        sendResponse({ ok: false, error: e.message });
      }
      return;
    }
    if (msg.type === "mic-granted") {
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "stop") {
      try { await chrome.runtime.sendMessage({ type: "offscreen-stop" }); } catch {}
      await closeOffscreen();
      running = false;
      await broadcastToTabs({ type: "overlay-hide" });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "config-changed") {
      // 실행 중이면 offscreen 에 설정 푸시
      if (running) {
        try { await chrome.runtime.sendMessage({ type: "offscreen-config", cfg: msg.cfg }); } catch {}
      }
      sendResponse({ ok: true });
      return;
    }
    // offscreen → background → 모든 탭
    if (msg.type === "caption") {
      await broadcastToTabs({ type: "caption", text: msg.text, streaming: !!msg.streaming, lang: msg.lang });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "offscreen-status") {
      // 알릴 거 있으면 popup 으로
      chrome.runtime.sendMessage({ type: "state", running: msg.running, error: msg.error }).catch(() => {});
      if (msg.error) {
        running = false;
        await closeOffscreen();
        await broadcastToTabs({ type: "overlay-hide" });
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "ping-running") {
      sendResponse({ running });
      return;
    }
  })();
  return true; // async sendResponse
});

// 새 탭/페이지에 자막 바 표시 상태 동기화
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "complete" && running) {
    chrome.tabs.sendMessage(tabId, { type: "overlay-show" }).catch(() => {});
  }
});
