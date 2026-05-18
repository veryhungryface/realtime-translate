const btn = document.getElementById("grantBtn");
const msg = document.getElementById("msg");

btn.addEventListener("click", async () => {
  btn.disabled = true;
  msg.innerHTML = "";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // 트랙 즉시 정리 — 권한만 받으면 됨
    stream.getTracks().forEach((t) => t.stop());
    msg.innerHTML = '<p class="ok">✓ 권한이 부여되었습니다. 이 탭은 자동으로 닫힙니다…</p>';
    // 통보 후 닫기
    chrome.runtime.sendMessage({ type: "mic-granted" }).catch(() => {});
    setTimeout(() => window.close(), 1500);
  } catch (e) {
    btn.disabled = false;
    msg.innerHTML = `<p class="err">권한 획득 실패: ${e.message}<br>주소창 왼쪽 자물쇠 아이콘에서 마이크 권한을 수동으로 허용해 주세요.</p>`;
  }
});
