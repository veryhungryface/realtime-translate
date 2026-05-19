const $ = (id) => document.getElementById(id);
const apiKeyEl = $("apiKey"), langEl = $("lang"), voiceEl = $("voice"), vadEl = $("vad"), noiseEl = $("noise"), muteEl = $("muteTts");
const gateEl = $("localGate"), gateThrEl = $("gateThreshold"), gateThrVal = $("gateThresholdVal");
function fmtGate(v) { return (parseInt(v, 10) / 100).toFixed(2); }
gateThrEl.addEventListener("input", () => { gateThrVal.textContent = fmtGate(gateThrEl.value); });

function applyGateEnabled() {
  const on = gateEl.checked;
  gateThrEl.disabled = !on;
  gateThrEl.style.opacity = on ? "1" : "0.4";
  gateThrVal.style.opacity = on ? "1" : "0.4";
}
gateEl.addEventListener("change", applyGateEnabled);
const startBtn = $("startBtn"), stopBtn = $("stopBtn"), statusEl = $("status");

// 설정 로드
chrome.storage.local.get(["apiKey", "lang", "voice", "vad", "noise", "muteTts", "localGate", "gateThreshold", "running"], (cfg) => {
  if (cfg.apiKey) apiKeyEl.value = cfg.apiKey;
  if (cfg.lang) langEl.value = cfg.lang;
  if (cfg.voice) voiceEl.value = cfg.voice;
  if (cfg.vad) vadEl.value = cfg.vad;
  if (cfg.noise) noiseEl.value = cfg.noise;
  if (cfg.muteTts) muteEl.checked = !!cfg.muteTts;
  if (cfg.localGate) gateEl.checked = !!cfg.localGate;
  if (cfg.gateThreshold) { gateThrEl.value = cfg.gateThreshold; gateThrVal.textContent = fmtGate(cfg.gateThreshold); }
  applyGateEnabled();
  setRunning(!!cfg.running);
});

function setRunning(on) {
  startBtn.disabled = on;
  stopBtn.disabled = !on;
  statusEl.className = on ? "live" : "";
  statusEl.textContent = on ? "● 통역 중 — 자막은 활성 탭 상단에 표시됨" : "대기 중";
}
function showError(msg) {
  statusEl.className = "err";
  statusEl.textContent = msg;
}

// 설정 변경은 즉시 저장 + (실행 중이면) 즉시 반영
function saveAndPush() {
  const cfg = {
    apiKey: apiKeyEl.value.trim(),
    lang: langEl.value,
    voice: voiceEl.value,
    vad: vadEl.value,
    noise: noiseEl.value,
    muteTts: muteEl.checked,
    localGate: gateEl.checked,
    gateThreshold: parseInt(gateThrEl.value, 10),
  };
  chrome.storage.local.set(cfg);
  chrome.runtime.sendMessage({ type: "config-changed", cfg }).catch(() => {});
}
[langEl, voiceEl, vadEl, noiseEl, muteEl, gateEl, gateThrEl].forEach((el) => el.addEventListener("change", saveAndPush));
apiKeyEl.addEventListener("change", saveAndPush);

startBtn.addEventListener("click", async () => {
  if (!apiKeyEl.value.trim()) { showError("API 키를 입력하세요"); return; }
  saveAndPush();
  startBtn.disabled = true;
  statusEl.className = "";
  statusEl.textContent = "연결 중…";
  const res = await chrome.runtime.sendMessage({
    type: "start",
    cfg: {
      apiKey: apiKeyEl.value.trim(),
      lang: langEl.value,
      voice: voiceEl.value,
      vad: vadEl.value,
      noise: noiseEl.value,
      muteTts: muteEl.checked,
      localGate: gateEl.checked,
      gateThreshold: parseInt(gateThrEl.value, 10),
    },
  });
  if (!res?.ok) {
    showError(res?.error || "시작 실패");
    startBtn.disabled = false;
    return;
  }
  setRunning(true);
});

stopBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "stop" });
  setRunning(false);
});

// background에서 상태 변경 알림
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "state") {
    setRunning(!!msg.running);
    if (msg.error) showError(msg.error);
  }
});
