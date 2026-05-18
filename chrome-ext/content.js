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
      position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
      pointer-events: none;
    `;
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .bar {
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Pretendard", "Noto Sans KR", sans-serif;
          background: rgba(0, 0, 0, 0.82);
          color: #fff;
          padding: 10px 24px;
          min-height: 28px;
          display: flex; align-items: center; justify-content: center;
          font-size: 28px; font-weight: 700; line-height: 1.35;
          text-align: center;
          letter-spacing: -0.005em;
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border-bottom: 1px solid rgba(255,255,255,0.08);
          pointer-events: auto;
          user-select: text;
          cursor: default;
        }
        .bar.streaming::after {
          content: "▍"; color: #5b9dff; margin-left: 6px;
          animation: blink 1s steps(1) infinite;
        }
        @keyframes blink { 50% { opacity: 0; } }
        .bar.rtl {
          font-family: "SF Arabic", "Geeza Pro", "Noto Naskh Arabic", "Tahoma", sans-serif;
          line-height: 1.55;
        }
        .bar.hidden { display: none; }
      </style>
      <div class="bar hidden" id="bar" dir="auto"><span id="text"></span></div>
    `;
    bar = shadow.getElementById("bar");
    text = shadow.getElementById("text");
    bar.addEventListener("dblclick", () => bar.classList.toggle("hidden"));
    document.documentElement.appendChild(host);
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
