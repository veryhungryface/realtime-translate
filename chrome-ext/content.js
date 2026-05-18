// 활성 페이지 상단에 얇은 자막 바를 주입한다.
(() => {
  if (window.__rttOverlayInjected) return;
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
          padding: 12px 24px;
          min-height: 32px;
          display: flex; align-items: center; justify-content: center; gap: 14px;
          font-size: 28px; font-weight: 700; line-height: 1.35;
          text-align: center;
          letter-spacing: -0.005em;
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
          color: rgba(255,255,255,0.5); font-weight: 500; font-size: 22px;
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
      </style>
      <div class="bar hidden" id="bar" dir="auto">
        <span class="live">● LIVE</span>
        <span id="text"></span>
        <button class="close" id="close" title="이 탭에서 자막 숨김 (더블클릭으로 토글)">✕</button>
      </div>
    `;
    bar = shadow.getElementById("bar");
    text = shadow.getElementById("text");
    bar.addEventListener("dblclick", () => bar.classList.toggle("hidden"));
    shadow.getElementById("close").addEventListener("click", () => bar.classList.add("hidden"));
    (document.body || document.documentElement).appendChild(host);
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
    else if (msg.type === "overlay-show") show();
    else if (msg.type === "overlay-hide") hide();
  });

  // 페이지 로드 시 background에 현재 running 여부 묻고 표시
  chrome.runtime.sendMessage({ type: "ping-running" }).then((res) => {
    if (res?.running) show();
  }).catch(() => {});
})();
