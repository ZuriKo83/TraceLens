(() => {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  let scheduled = false;

  function friendlyBanner(rawText) {
    const text = clean(rawText);
    const label = text.includes("실시간 채팅") ? "실시간 채팅" : "댓글";
    const count = text.match(/(\d+)개/)?.[1] || "";

    if (/전체 .*기록에서 선택 대상을 찾/.test(text)) {
      return `선택한 ${label}을 찾고 있습니다. 잠시 기다려 주세요.`;
    }
    if (/삭제 후 전체 .*기록을 끝까지 전수 확인/.test(text)) {
      return "삭제 결과를 확인하고 있습니다. 잠시 기다려 주세요.";
    }
    if (/대상을 찾았습니다.*삭제를 요청/.test(text)) {
      return `선택한 ${label}을 확인했습니다. 삭제를 진행하고 있습니다.`;
    }
    if (/보이지 않아 전체 기록 확인 결과로 처리|현재 Google 내 활동에 없습니다.*목록을 정리/.test(text)) {
      return `선택한 ${label}을 정확히 확인하지 못했습니다. 안전을 위해 삭제하지 않고 결과를 확인합니다.`;
    }
    if (/삭제 요청 완료.*새로고침 후/.test(text)) {
      return count
        ? `${count}개 항목의 삭제를 요청했습니다. 결과를 확인하고 있습니다.`
        : "삭제를 요청했습니다. 결과를 확인하고 있습니다.";
    }
    if (/전체 .*기록 .*전수 확인을 완료/.test(text)) {
      return "삭제 결과 확인을 마쳤습니다.";
    }
    if (/전체 .*기록 확인이 끝까지 완료되지/.test(text)) {
      return "결과 확인이 끝나지 않았습니다. 안전을 위해 확인되지 않은 항목은 삭제하지 않습니다.";
    }
    if (/찾지 못했고 전체 확인도 끝나지/.test(text)) {
      return `선택한 ${label}을 찾지 못했습니다. 안전을 위해 삭제하지 않습니다.`;
    }
    if (/삭제 작업|자동 복구|동기화|전수조사|행 탐색|활동 ID/.test(text)) {
      return text
        .replace(/자동 복구/g, "다시 연결")
        .replace(/동기화/g, "결과 저장")
        .replace(/전수조사|전수 확인/g, "전체 확인")
        .replace(/행 탐색/g, "항목 확인")
        .replace(/활동 ID/g, "항목 정보");
    }
    return text;
  }

  function polish() {
    const banner = document.getElementById("tracelens-delete-banner");
    if (!banner) return;
    const next = friendlyBanner(banner.textContent || "");
    if (next && banner.textContent !== next) banner.textContent = next;
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      polish();
    });
  }

  new MutationObserver(schedule).observe(document.documentElement, {subtree: true, childList: true, characterData: true});
  schedule();
})();