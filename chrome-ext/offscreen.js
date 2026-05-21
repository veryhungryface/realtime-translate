// Offscreen 문서: WebRTC + 마이크 + Realtime API 이벤트 파싱
// 백그라운드 서비스 워커는 DOM/마이크 못 쓰므로 모든 미디어 작업은 여기서.

const MODEL = "gpt-realtime";
const REALTIME_URL = "https://api.openai.com/v1/realtime/calls";

const LANGS = {
  en: "English", ar: "Arabic", ja: "Japanese", zh: "Mandarin Chinese",
  es: "Spanish", fr: "French",
};

let pc = null, dc = null, micStream = null;
let rawMicStream = null;          // getUserMedia 원본
let gateCtx = null, gateNode = null, gateAnalyser = null, gateTimer = null;
let currentCfg = null;
let enBuffer = "";
let responseActive = false;
let serverResponseActive = false; // 서버 측 response 진행 여부 (response.created ~ response.done)
let userInitiatedStop = false;    // 사용자가 중지 눌렀을 때 true → 자동 재연결 안 함
let reconnectAttempts = 0;
const MAX_RECONNECT = 8;
const BENIGN_ERROR_CODES = new Set([
  "conversation_already_has_active_response",
  "input_audio_buffer_commit_empty",
]);

const ttsAudio = document.getElementById("tts");

function buildInstructions(code) {
  const lang = LANGS[code] || "English";
  return `You are a strict simultaneous interpreter. The user speaks Korean.

ABSOLUTE RULES — never break these:
1. NEVER greet, NEVER introduce yourself, NEVER ask what the user wants.
2. NEVER answer questions, give opinions, or add commentary of any kind.
3. NEVER explain, summarize, apologize, or describe what you are doing.
4. NEVER output anything in Korean — output ONLY in ${lang}.
5. If the incoming audio is silence, noise, music, coughing, breathing,
   non-speech sounds, or audio you cannot clearly understand as Korean
   speech, output absolutely nothing — produce an empty response.
6. If the user says something like "hello" or "test", just translate
   those exact words — do not respond as if greeted.

Your ONLY job: take Korean speech and output the equivalent ${lang}
translation, keeping tone and register. Nothing else, ever.`;
}

// 소음 정도 → VAD 파라미터 매핑
const NOISE_PRESETS = {
  quiet:    { threshold: 0.40, silence: 500,  eagerness: "auto" },
  normal:   { threshold: 0.55, silence: 700,  eagerness: "auto" },
  noisy:    { threshold: 0.70, silence: 900,  eagerness: "low"  },
  veryNoisy:{ threshold: 0.85, silence: 1200, eagerness: "low"  },
};

function buildTurnDetection(mode, noise) {
  if (mode === "ptt") return null;
  const preset = NOISE_PRESETS[noise] || NOISE_PRESETS.normal;
  const common = { create_response: true, interrupt_response: false };
  if (mode === "server") {
    return {
      type: "server_vad",
      threshold: preset.threshold,
      silence_duration_ms: preset.silence,
      prefix_padding_ms: 300,
      ...common,
    };
  }
  return { type: "semantic_vad", eagerness: preset.eagerness, ...common };
}

function setMicEnabled(on) {
  if (!micStream) return;
  micStream.getAudioTracks().forEach((t) => (t.enabled = on));
}

// Web Audio 기반 클라이언트 측 볼륨 게이트
// 원본 마이크 → AnalyserNode + GainNode → MediaStreamDestination → pc 트랙
// 히스테리시스로 깜빡임 방지 (열림 임계값, 닫힘 임계값 분리)
function buildGatedStream(srcStream, openLevel) {
  const closeLevel = Math.max(0.005, openLevel * 0.5);
  gateCtx = new (self.AudioContext || self.webkitAudioContext)();
  const source = gateCtx.createMediaStreamSource(srcStream);
  gateNode = gateCtx.createGain();
  gateNode.gain.value = 0;
  gateAnalyser = gateCtx.createAnalyser();
  gateAnalyser.fftSize = 1024;
  const dest = gateCtx.createMediaStreamDestination();
  source.connect(gateAnalyser);
  source.connect(gateNode);
  gateNode.connect(dest);

  const buf = new Uint8Array(gateAnalyser.fftSize);
  let openHoldUntil = 0;
  const HOLD_MS = 250; // 떨어진 뒤에도 250ms 더 유지 → 단어 사이 묵음에 끊기지 않음
  gateTimer = setInterval(() => {
    gateAnalyser.getByteTimeDomainData(buf);
    let max = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i] - 128) / 128;
      if (v > max) max = v;
    }
    const now = performance.now();
    if (max > openLevel) {
      gateNode.gain.value = 1;
      openHoldUntil = now + HOLD_MS;
    } else if (max < closeLevel && now > openHoldUntil) {
      gateNode.gain.value = 0;
    }
  }, 30);
  return dest.stream;
}

function teardownGate() {
  if (gateTimer) { clearInterval(gateTimer); gateTimer = null; }
  if (gateCtx) { try { gateCtx.close(); } catch {} gateCtx = null; }
  gateNode = null; gateAnalyser = null;
}

function buildSessionUpdate(cfg) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: buildInstructions(cfg.lang),
      audio: {
        input: {
          transcription: { model: "gpt-4o-mini-transcribe", language: "ko" },
          turn_detection: buildTurnDetection(cfg.vad, cfg.noise),
        },
        output: { voice: cfg.voice },
      },
    },
  };
}

async function start(cfg) {
  currentCfg = cfg;
  enBuffer = "";
  responseActive = false;
  userInitiatedStop = false;
  reconnectAttempts = 0;
  await connect();
}

async function reconnect() {
  if (userInitiatedStop) return;
  if (reconnectAttempts >= MAX_RECONNECT) {
    sendStatus({ error: `자동 재연결 ${MAX_RECONNECT}회 실패 — 수동으로 다시 시작해주세요`, running: false });
    return;
  }
  reconnectAttempts++;
  const delay = Math.min(8000, 500 * Math.pow(2, reconnectAttempts - 1));
  console.log(`[rtt] 재연결 시도 ${reconnectAttempts}/${MAX_RECONNECT} (${delay}ms 후)`);
  sendCaption(`🔄 재연결 중… (${reconnectAttempts}/${MAX_RECONNECT})`, false);
  cleanupPeer();
  await new Promise((r) => setTimeout(r, delay));
  if (userInitiatedStop) return;
  try {
    await connect();
    console.log("[rtt] 재연결 성공");
    reconnectAttempts = 0;
  } catch (e) {
    console.error("[rtt] 재연결 실패:", e);
    reconnect(); // 다음 시도
  }
}

async function connect() {
  const cfg = currentCfg;
  serverResponseActive = false;
  enBuffer = "";
  responseActive = false;

  // AGC(Auto Gain Control)는 멀리서 나는 소리를 자동으로 증폭해서
  // 가까운 내 목소리와 비슷한 음량으로 만들어버린다 — 잡음 환경에서는 끔.
  const noiseLvl = cfg.noise || "normal";
  const disableAgc = noiseLvl === "noisy" || noiseLvl === "veryNoisy" || !!cfg.localGate;
  rawMicStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: !disableAgc,
    },
  });
  console.log("[mic] AGC =", !disableAgc, "noise level =", noiseLvl);
  // 로컬 게이트 적용 시 원본 → 게이트 → 전송 스트림
  if (cfg.localGate) {
    const openLevel = (cfg.gateThreshold || 8) / 100;
    micStream = buildGatedStream(rawMicStream, openLevel);
  } else {
    micStream = rawMicStream;
  }

  pc = new RTCPeerConnection();
  pc.ontrack = (e) => {
    ttsAudio.srcObject = e.streams[0];
    ttsAudio.muted = !!cfg.muteTts;
    ttsAudio.volume = 1.0;
    ttsAudio.play().catch((err) => {
      console.error("[oai] audio play failed", err);
      sendStatus({ error: "오디오 재생 실패: " + err.message });
    });
  };
  micStream.getTracks().forEach((t) => pc.addTrack(t, micStream));

  dc = pc.createDataChannel("oai-events");
  dc.onopen = () => dc.send(JSON.stringify(buildSessionUpdate(cfg)));
  dc.onmessage = (e) => {
    try { handleEvent(JSON.parse(e.data)); }
    catch (err) { console.error("[oai] parse err", err); }
  };
  dc.onclose = () => {
    console.warn("[rtt] DataChannel closed");
    if (!userInitiatedStop) reconnect();
  };
  dc.onerror = (e) => console.error("[rtt] DataChannel error", e);

  pc.onconnectionstatechange = () => {
    const s = pc?.connectionState;
    console.log("[rtt] pc.connectionState =", s);
    if (s === "failed" || s === "disconnected" || s === "closed") {
      if (!userInitiatedStop) reconnect();
    }
  };

  // PTT 모드면 마이크 기본 비활성 (버튼/스페이스 누른 동안만 전송)
  if (cfg.vad === "ptt") setMicEnabled(false);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const res = await fetch(`${REALTIME_URL}?model=${MODEL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/sdp" },
    body: offer.sdp,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  const answerSdp = await res.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
}

function handleEvent(evt) {
  const t = evt.type || "";
  if (t === "response.created") serverResponseActive = true;
  if (t === "response.done") serverResponseActive = false;
  // 출력 transcript 스트리밍
  if (/^response\.(output_)?(audio_transcript|text)\.delta$/.test(t) && evt.delta) {
    if (!responseActive) {
      enBuffer = "";
      responseActive = true;
    }
    enBuffer += evt.delta;
    sendCaption(enBuffer, true);
    return;
  }
  if (/^response\.(output_)?(audio_transcript|text)\.done$/.test(t)) {
    const finalText = evt.transcript || evt.text || enBuffer;
    enBuffer = finalText;
    sendCaption(finalText, false);
    responseActive = false;
    return;
  }
  if (t === "response.output_item.done") return; // 중복 방지
  if (t === "error") {
    const e = evt.error || {};
    const code = e.code || "";
    const detail = `${e.type || "error"}${code ? "/" + code : ""}: ${e.message || JSON.stringify(evt)}`;
    // 일시적/예상된 에러는 콘솔만 남기고 화면에는 안 띄움
    if (BENIGN_ERROR_CODES.has(code)) {
      console.debug("[oai] benign error (suppressed)", detail);
      return;
    }
    console.error("[oai] error", detail, evt);
    sendStatus({ error: detail });
    sendCaption("⚠ " + detail, false);
  }
}

function sendCaption(text, streaming) {
  chrome.runtime.sendMessage({ type: "caption", text, streaming, lang: currentCfg?.lang || "en" }).catch(() => {});
}
function sendStatus(payload) {
  chrome.runtime.sendMessage({ type: "offscreen-status", ...payload }).catch(() => {});
}

function applyConfigLive(cfg) {
  const prevVad = currentCfg?.vad;
  currentCfg = { ...currentCfg, ...cfg };
  if (dc && dc.readyState === "open") {
    dc.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: buildInstructions(currentCfg.lang),
        audio: { input: { turn_detection: buildTurnDetection(currentCfg.vad) } },
      },
    }));
  }
  if (ttsAudio) ttsAudio.muted = !!currentCfg.muteTts;
  // 모드 전환 시 마이크 enable 상태 조정
  if (currentCfg.vad === "ptt" && prevVad !== "ptt") setMicEnabled(false);
  else if (currentCfg.vad !== "ptt" && prevVad === "ptt") setMicEnabled(true);
}

function pttDown() {
  if (currentCfg?.vad !== "ptt") return;
  setMicEnabled(true);
}
function pttUp() {
  if (currentCfg?.vad !== "ptt") return;
  setMicEnabled(false);
  if (dc && dc.readyState === "open") {
    try {
      dc.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      // 이미 진행 중인 응답이 있으면 새 응답 만들지 않음 (서버가 거부)
      if (!serverResponseActive) {
        dc.send(JSON.stringify({ type: "response.create" }));
      } else {
        console.warn("[oai] PTT: 이전 응답 진행 중 → 이번 발화는 큐에 쌓이고 자동 처리됨");
      }
    } catch (e) { console.error(e); }
  }
}

function cleanupPeer() {
  if (dc) { try { dc.onopen = dc.onmessage = dc.onclose = dc.onerror = null; dc.close(); } catch {} dc = null; }
  if (pc) { try { pc.onconnectionstatechange = pc.ontrack = null; pc.close(); } catch {} pc = null; }
  teardownGate();
  if (rawMicStream) { rawMicStream.getTracks().forEach((t) => t.stop()); rawMicStream = null; }
  micStream = null;
  ttsAudio.srcObject = null;
}

function cleanup() {
  userInitiatedStop = true;
  cleanupPeer();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "offscreen-start") {
      try { await start(msg.cfg); sendResponse({ ok: true }); }
      catch (e) { cleanup(); sendResponse({ ok: false, error: e.message }); }
      return;
    }
    if (msg.type === "offscreen-stop") {
      cleanup();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "offscreen-config") {
      applyConfigLive(msg.cfg);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "offscreen-ptt-down") { pttDown(); sendResponse({ ok: true }); return; }
    if (msg.type === "offscreen-ptt-up") { pttUp(); sendResponse({ ok: true }); return; }
    if (msg.type === "offscreen-mode") {
      sendResponse({ vad: currentCfg?.vad || null });
      return;
    }
  })();
  return true;
});
