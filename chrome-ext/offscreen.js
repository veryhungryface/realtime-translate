// Offscreen 문서: WebRTC + 마이크 + Realtime API 이벤트 파싱
// 백그라운드 서비스 워커는 DOM/마이크 못 쓰므로 모든 미디어 작업은 여기서.

const MODEL = "gpt-realtime";
const REALTIME_URL = "https://api.openai.com/v1/realtime/calls";

const LANGS = {
  en: "English", ar: "Arabic", ja: "Japanese", zh: "Mandarin Chinese",
  es: "Spanish", fr: "French",
};

let pc = null, dc = null, micStream = null;
let currentCfg = null;
let enBuffer = "";
let responseActive = false;

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

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

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
  dc.onclose = () => sendStatus({ running: false });
  dc.onerror = (e) => sendStatus({ error: "DataChannel error: " + (e?.message || e) });

  pc.onconnectionstatechange = () => {
    if (pc?.connectionState === "failed" || pc?.connectionState === "disconnected") {
      sendStatus({ error: "연결이 끊어졌습니다", running: false });
      cleanup();
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
    const detail = `${e.type || "error"}${e.code ? "/" + e.code : ""}: ${e.message || JSON.stringify(evt)}`;
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
      dc.send(JSON.stringify({ type: "response.create" }));
    } catch (e) { console.error(e); }
  }
}

function cleanup() {
  if (dc) { try { dc.close(); } catch {} dc = null; }
  if (pc) { try { pc.close(); } catch {} pc = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  ttsAudio.srcObject = null;
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
