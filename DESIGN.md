# 실시간 한→영 통역기 (DESIGN)

날짜: 2026-05-18

## 목표
브라우저에서 마이크로 한국어 발화 → OpenAI Realtime API → 영어 자막(스트리밍) + 영어 TTS 동시 출력.

## 구성
- 단일 정적 페이지: `index.html` (HTML + JS 인라인)
- 백엔드 없음. API 키는 첫 실행 시 `prompt()` → `localStorage` 저장
- 로컬 서버: `python3 -m http.server 8000` 으로 띄움 (마이크는 secure context/localhost 필요)

## 핵심 흐름 (WebRTC)
1. **Start 클릭** → `navigator.mediaDevices.getUserMedia({audio: true})`
2. `RTCPeerConnection` 생성
   - 마이크 트랙 `addTrack`
   - `ontrack`: remote audio 를 `<audio autoplay>` 에 연결 (영어 TTS 재생)
   - `RTCDataChannel("oai-events")` 열어 이벤트 송수신
3. `createOffer()` → `setLocalDescription` → POST
   - URL: `https://api.openai.com/v1/realtime?model=gpt-realtime`
   - Headers: `Authorization: Bearer <KEY>`, `Content-Type: application/sdp`
   - Body: offer SDP
   - 응답 SDP 로 `setRemoteDescription({type:"answer", sdp})`
4. 데이터 채널 `open` 직후 `session.update` 송신:
   ```json
   {
     "type": "session.update",
     "session": {
       "modalities": ["audio", "text"],
       "voice": "alloy",
       "instructions": "You are a simultaneous interpreter. The user speaks Korean. Translate every utterance into fluent, natural English. Do not answer questions, do not add commentary — only translate. Keep the speaker's tone.",
       "input_audio_transcription": { "model": "whisper-1", "language": "ko" },
       "turn_detection": { "type": "server_vad" }
     }
   }
   ```
5. 이벤트 처리
   - `conversation.item.input_audio_transcription.delta/.completed` → 좌측 한국어 패널에 표시
   - `response.audio_transcript.delta` → 우측 영어 패널에 스트리밍 누적
   - `response.audio_transcript.done` → 해당 발화를 히스토리로 이동
   - `error` → 화면 + console 에 표시
6. **Stop 클릭** → `pc.close()`, 트랙 정리

## UI
- 헤더: 제목, Start/Stop, 상태 indicator(점)
- 본문 2열:
  - 좌: 한국어 (현재 발화 강조 + 이전 발화 dim)
  - 우: 영어 (스트리밍 커서 표시)
- 푸터: API 키 재설정 버튼

## 에러/엣지케이스
- 키 누락/401 → prompt 재요청
- 마이크 거부 → 안내문
- ICE 실패/네트워크 끊김 → "Disconnected" 표시 + Retry 버튼
- 모델 이름 401/404 → `gpt-4o-realtime-preview` 로 폴백 시도 후 사용자에게 알림

## 비기능
- 자동 테스트 없음 (마이크 의존). 수동 검증: "안녕하세요, 오늘 날씨 좋네요" 같은 문장 3-4개로 확인.
- 의존성 없음 (CDN 도 안 씀). 순수 HTML/JS.

## 파일
- `DESIGN.md` (이 문서)
- `index.html`
- `README.md` — 실행법 (`python3 -m http.server`, 키 입력 방법)
