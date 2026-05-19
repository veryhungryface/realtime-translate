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
  return `You are a simultaneous interpreter. The user speaks Korean.
Translate every utterance into fluent, natural ${lang}.
Do not answer questions, do not add commentary, do not refuse — only translate.
Keep the speaker's tone, register, and intent. Always reply in ${lang} only.`;
}

function buildTurnDetection(mode) {
  // PTT: 서버 자동 턴 종료 끔 (클라이언트가 수동 commit)
  if (mode === "ptt") return null;
  // interrupt_response: false → 모델이 번역 발화 중일 때 들어온 새 오디오로
  // 진행 중 응답을 끊지 않음. 잡음에 의한 중단 방지.
  const common = { create_response: true, interrupt_response: false };
  if (mode === "server") {
    return { type: "server_vad", threshold: 0.55, silence_duration_ms: 700, prefix_padding_ms: 300, ...common };
  }
  return { type: "semantic_vad", eagerness: "auto", ...common };
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
          turn_detection: buildTurnDetection(cfg.vad),
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
