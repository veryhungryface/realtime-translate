// 활성 페이지 상단에 얇은 자막 바를 주입한다.
(() => {
  const VERSION = 5;
  if (window.__rttOverlayVersion >= VERSION) return;
  // 이전 버전이 살아있으면 DOM 만 제거 (이벤트 리스너는 페이지 새로고침 전까지 그대로)
  const oldHost = document.getElementById("__rtt_overlay_host__");
  if (oldHost) oldHost.remove();
  if (window.__rttOverlayVersion) {
    console.warn("[rtt] 이전 버전 content script 감지 — 페이지 새로고침(Cmd+R) 권장.");
  }
  window.__rttOverlayVersion = VERSION;
  window.__rttOverlayInjected = true;

  const HOST_ID = "__rtt_overlay_host__";
  let host = null, shadow = null, bar = null, text = null;

  function ensureBar() {
    if (host) return;
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = `
      position: fixed !important;
      top: 0 !important; left: 0 !important; right: 0 !important;
      width: 100vw !important;
      z-index: 2147483647 !important;
      pointer-events: none !important;
      transform: none !important;
      margin: 0 !important; padding: 0 !important;
    `;
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .bar {
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Pretendard", "Noto Sans KR", sans-serif;
          background: rgba(0, 0, 0, 0.88);
          color: #fff;
          padding: 18px 32px;
          min-height: 48px;
          display: flex; align-items: center; justify-content: center; gap: 16px;
          font-size: 44px; font-weight: 900; line-height: 1.25;
          text-align: center;
          letter-spacing: -0.015em;
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border-bottom: 2px solid rgba(91, 157, 255, 0.4);
          pointer-events: auto;
          user-select: text;
          cursor: default;
          box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        }
        .live {
          font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 4px;
          background: #4ade80; color: #000; letter-spacing: 0.05em;
          animation: pulse 1.8s ease-in-out infinite;
          flex-shrink: 0;
        }
        @keyframes pulse { 50% { opacity: 0.5; } }
        #text:empty::before {
          content: "통역 대기 중 · 한국어로 말씀하세요";
          color: rgba(255,255,255,0.5); font-weight: 600; font-size: 28px;
        }
        .bar.streaming #text::after {
          content: "▍"; color: #5b9dff; margin-left: 6px;
          animation: blink 1s steps(1) infinite;
        }
        @keyframes blink { 50% { opacity: 0; } }
        .bar.rtl {
          font-family: "SF Arabic", "Geeza Pro", "Noto Naskh Arabic", "Tahoma", sans-serif;
          line-height: 1.55;
        }
        .bar.hidden { display: none; }
        .close {
          position: absolute; right: 8px; top: 8px;
          width: 22px; height: 22px; border: none; border-radius: 4px;
          background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.6);
          font-size: 14px; cursor: pointer; line-height: 1;
        }
        .close:hover { background: rgba(255,255,255,0.22); color: #fff; }
        .ptt {
          font-size: 13px; font-weight: 700; padding: 8px 14px; border-radius: 6px;
          border: 2px solid rgba(255,255,255,0.25);
          background: rgba(255,255,255,0.08); color: #fff;
          cursor: pointer; user-select: none; flex-shrink: 0;
          display: none;
        }
        .bar.ptt-mode .ptt { display: inline-block; }
        .ptt.active {
          background: #4ade80; color: #000; border-color: #4ade80;
          box-shadow: 0 0 16px rgba(74, 222, 128, 0.6);
        }
        .bar.ptt-mode #text:empty::before {
          content: "🎙️ 버튼 또는 왼쪽 Shift 키를 누르고 한국어로 말하세요";
        }
      </style>
      <div class="bar hidden" id="bar" dir="auto">
        <span class="live">● LIVE</span>
        <button class="ptt" id="ptt" title="누르고 있는 동안 녹음 (왼쪽 Shift)">🎙 PUSH</button>
        <span id="text"></span>
        <button class="close" id="close" title="이 탭에서 자막 숨김 (더블클릭으로 토글)">✕</button>
      </div>
    `;
    bar = shadow.getElementById("bar");
    text = shadow.getElementById("text");
    bar.addEventListener("dblclick", () => bar.classList.toggle("hidden"));
    shadow.getElementById("close").addEventListener("click", () => bar.classList.add("hidden"));
    setupPtt(shadow);
    (document.body || document.documentElement).appendChild(host);
  }

  let pttMode = false;
  let pttHolding = false;
  let pttBtn = null;

  function pttDown() {
    if (!pttMode || pttHolding) return;
    pttHolding = true;
    if (pttBtn) { pttBtn.classList.add("active"); pttBtn.textContent = "● REC"; }
    chrome.runtime.sendMessage({ type: "ptt-down" }).catch(() => {});
  }
  function pttUp() {
    if (!pttHolding) return;
    pttHolding = false;
    if (pttBtn) { pttBtn.classList.remove("active"); pttBtn.textContent = "🎙 PUSH"; }
    chrome.runtime.sendMessage({ type: "ptt-up" }).catch(() => {});
  }
  function setupPtt(shadowRoot) {
    pttBtn = shadowRoot.getElementById("ptt");
    pttBtn.addEventListener("mousedown", (e) => { e.preventDefault(); pttDown(); });
    pttBtn.addEventListener("touchstart", (e) => { e.preventDefault(); pttDown(); }, { passive: false });
    window.addEventListener("mouseup", pttUp);
    window.addEventListener("touchend", pttUp);
    // 왼쪽 Shift 키 — 입력 필드 포커스 무관 (Shift 단독은 입력에 영향 없음)
    const isLeftShift = (e) => e.code === "ShiftLeft";
    window.addEventListener("keydown", (e) => {
      if (!pttMode || e.repeat || !isLeftShift(e)) return;
      pttDown();
    }, true);
    window.addEventListener("keyup", (e) => {
      if (!pttMode || !isLeftShift(e)) return;
      pttUp();
    }, true);
  }
  function setPttMode(on) {
    pttMode = !!on;
    if (bar) bar.classList.toggle("ptt-mode", pttMode);
    if (!pttMode && pttHolding) pttUp();
  }

  function show() { ensureBar(); bar.classList.remove("hidden"); }
  function hide() { if (bar) bar.classList.add("hidden"); }

  const RTL = new Set(["ar", "he", "fa", "ur"]);

  function setCaption(t, streaming, lang) {
    ensureBar();
    bar.classList.remove("hidden");
    bar.classList.toggle("streaming", !!streaming);
    bar.classList.toggle("rtl", RTL.has(lang));
    bar.setAttribute("dir", RTL.has(lang) ? "rtl" : "ltr");
    text.textContent = t || "";
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "caption") setCaption(msg.text, msg.streaming, msg.lang);
    else if (msg.type === "overlay-show") { show(); setPttMode(msg.vad === "ptt"); }
    else if (msg.type === "overlay-hide") { hide(); setPttMode(false); }
  });

  // 페이지 로드 시 background에 현재 running 여부 묻고 표시
  chrome.runtime.sendMessage({ type: "ping-running" }).then((res) => {
    if (res?.running) { show(); setPttMode(res.vad === "ptt"); }
  }).catch(() => {});
})();
