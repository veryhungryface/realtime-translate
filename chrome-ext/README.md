# Realtime Translator — Chrome Extension

한국어로 말하면 *임의의 페이지* 상단에 얇은 자막 바로 선택한 언어의 번역이 실시간으로 표시됩니다. OpenAI Realtime API (`gpt-realtime`) + WebRTC.

## 설치 (개발자 모드)

1. Chrome 에서 `chrome://extensions` 열기
2. 우상단 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드** 클릭 → 이 `chrome-ext` 폴더 선택
4. 툴바에서 핀 고정

## 사용

1. 확장 아이콘 클릭 → **OpenAI API 키** 입력 (sk-...)
2. 번역 언어 / 음성 / 발화 감지 모드 선택
3. **시작** 클릭 → 마이크 권한 허용 (최초 1회)
4. 활성 탭 상단에 검은 자막 바 등장. 모든 탭에 표시됨.
5. 한국어로 말하면 선택한 언어의 자막이 스트리밍됨

**자막 바 더블클릭 = 임시 숨김** (해당 탭만)

## 구조

| 파일 | 역할 |
|------|------|
| `manifest.json` | MV3 매니페스트 |
| `popup.html/js` | 설정 UI + Start/Stop |
| `background.js` | Service worker, offscreen 라이프사이클, 메시지 라우팅 |
| `offscreen.html/js` | 마이크 + WebRTC + Realtime API 이벤트 파싱 |
| `content.js` | 페이지 상단 자막 바 주입 (Shadow DOM) |

## 주의

- API 키는 `chrome.storage.local` 에 평문 저장 (브라우저 로컬). 외부 전송은 OpenAI API 호출 외 없음.
- `host_permissions: <all_urls>` 가 필요한 이유: 모든 페이지에 자막 바를 주입하기 위해.
- 일부 페이지(예: `chrome://`, Chrome 웹스토어)는 content script 주입이 금지되어 자막 바가 안 보일 수 있음 — 그 외 일반 사이트(키노트 웹, 구글 슬라이드, PDF 뷰어 등)는 정상 동작.
- Push-to-Talk 모드는 키 입력이 페이지에 가로채일 수 있어 v0.1에서는 제외. Server VAD / Semantic VAD 만 지원.

## 아이콘

현재 아이콘 미포함 — Chrome 기본 아이콘으로 표시됨. `icons/icon16.png`, `icon48.png`, `icon128.png` 추가하고 `manifest.json` 에 `icons` 필드 넣으면 적용됨.
