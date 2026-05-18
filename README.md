# 실시간 한→영 통역기

OpenAI Realtime API + WebRTC 로 한국어 발화를 실시간으로 영어 자막 + 영어 TTS 로 변환.

## 실행

```bash
cd /Users/im_1699/dev/260518-realtimetrans
python3 -m http.server 8000
```

브라우저에서 http://localhost:8000 열기. (마이크 권한은 `localhost` 또는 HTTPS 에서만 허용됨 — `file://` 로 더블클릭은 동작 안 함.)

## 사용
1. **시작** 버튼 클릭
2. 처음이면 OpenAI API 키 입력 (sk- 로 시작, localStorage 저장됨)
3. 마이크 권한 허용
4. 한국어로 말하면 좌측에 한국어 전사, 우측에 영어 번역이 스트리밍됨. 영어 음성도 자동 재생.
5. 종료할 땐 **중지**

## 키 관리
- 키는 브라우저 `localStorage` 에만 저장. 서버 전송 없음 (OpenAI 제외).
- 푸터 "API 키 재설정" 으로 삭제 가능.

## 모델
- 기본: `gpt-realtime`
- 실패 시 자동 폴백: `gpt-4o-realtime-preview`

## 한계
- 비용은 OpenAI Realtime API 단가대로 발생 (오디오 입출력 분당 과금).
- 마이크 의존 자동 테스트 없음. 수동 검증.
