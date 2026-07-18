(() => {
  const isTraceLens = /(^|\.)tracelens\.kr$/i.test(location.hostname)
    || ["localhost", "127.0.0.1"].includes(location.hostname);
  const isGoogleActivity = location.hostname === "myactivity.google.com";
  if (!isTraceLens && !isGoogleActivity) return;

  const normalizeSpaces = (value) => String(value || "").replace(/\s+/g, " ").trim();

  function userMessage(input) {
    let text = normalizeSpaces(input);
    if (!text) return text;

    // Google 작업창 안내
    text = text
      .replace(/^TraceLens가 전체 (.+?) 기록에서 선택 대상을 찾고 있습니다\.$/, "삭제할 $1을 찾고 있습니다. 잠시만 기다려 주세요.")
      .replace(/^삭제 후 전체 (.+?) 기록을 끝까지 전수 확인하고 있습니다\.$/, "삭제 결과를 확인하고 있습니다. 잠시만 기다려 주세요.")
      .replace(/^삭제 후 전체 (.+?) 기록 (\d+)개 전수 확인을 완료했습니다\.$/, "$1 삭제 결과 확인을 완료했습니다.")
      .replace(/^전체 (.+?) 기록 확인이 끝까지 완료되지 않았습니다\.$/, "$1 결과를 모두 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.")
      .replace(/^대상을 찾았습니다\. 아래쪽 (.+?)부터 삭제를 요청합니다\.$/, "삭제할 $1을 확인했습니다. 삭제를 진행합니다.")
      .replace(/^선택한 (.+?)이 보이지 않아 전체 기록 확인 결과로 처리합니다\.$/, "선택한 $1을 정확히 확인하지 못했습니다. 안전을 위해 삭제하지 않습니다.")
      .replace(/^(\d+)개 삭제 요청 완료 · 새로고침 후 전체 (.+?) 기록을 전수 확인합니다\.$/, "$1개 삭제를 요청했습니다. 결과를 확인하고 있습니다.")
      .replace(/^선택 대상은 현재 Google 내 활동에 없습니다\. TraceLens 목록을 정리합니다\.$/, "선택한 항목을 정확히 확인하지 못했습니다. 안전을 위해 목록에 유지합니다.")
      .replace(/^선택한 (.+?)을 찾지 못했고 전체 확인도 끝나지 않았습니다\.$/, "선택한 $1을 확인하지 못했습니다. 목록은 그대로 유지됩니다.");

    // 삭제 진행 상태
    text = text
      .replace(/^삭제권 \d+개를 확인합니다\.$/, "삭제 준비 중입니다.")
      .replace(/^전체 (댓글|실시간 채팅) 기록에서 대상을 찾은 뒤 삭제 또는 이미 삭제된 상태를 확인합니다\. 작업 창을 닫거나 이동하지 마세요\.$/, "삭제할 $1을 찾고 있습니다. 작업이 끝날 때까지 잠시만 기다려 주세요.")
      .replace(/^(\d+)개 행 탐색, (\d+)개 삭제 요청 완료$/, "$2개 항목의 삭제를 요청했습니다.")
      .replace(/^삭제 반영을 \d+초 기다립니다\. 작업 창을 닫아도 자동으로 복구됩니다\.$/, "삭제 결과를 확인하고 있습니다.")
      .replace(/^Google 내 활동 전체 확인 완료: 남은 대상 0개$/, "삭제 결과를 확인했습니다.")
      .replace(/^Google 내 활동 전체 확인 완료: 남은 대상 (\d+)개$/, "아직 남아 있는 항목 $1개를 다시 확인합니다.")
      .replace(/^(\d+)개 남은 항목만 다시 삭제합니다\.$/, "삭제되지 않은 항목 $1개를 다시 시도합니다.")
      .replace(/^삭제·전수 확인·동기화가 끝나 작업 창을 닫습니다\.$/, "처리를 마무리하고 있습니다.")
      .replace(/^삭제 작업이 완료됐습니다\.$/, "삭제 작업을 마쳤습니다.")
      .replace(/^Google 삭제 확인이 끝났습니다\. TraceLens 목록과 삭제권을 동기화합니다\.$/, "삭제 결과를 반영하고 있습니다.")
      .replace(/^삭제 작업 (탭|창)이 닫혔습니다\. 삭제 작업은 취소되지 않으며 자동으로 다시 엽니다\.$/, "작업 창이 닫혔습니다. 삭제 작업을 자동으로 이어서 진행합니다.")
      .replace(/^삭제 작업 페이지에서 다른 주소로 이동했습니다\. 삭제 작업은 취소되지 않으며 자동으로 다시 엽니다\.$/, "작업 페이지가 변경되었습니다. 삭제 작업을 자동으로 이어서 진행합니다.")
      .replace(/^.+을 계속하기 위해 작업 창을 자동 복구합니다\. \(\d+\/3\)$/, "삭제 작업을 이어서 진행하기 위해 작업 창을 다시 엽니다.");

    // 최종 결과
    text = text
      .replace(/^마지막 삭제 결과 · /, "마지막 결과 · ")
      .replace(/^(댓글|실시간 채팅) 삭제 확인 (\d+)개, 이미 삭제됨 0개 · 해당 항목을 TraceLens 목록에서도 제거했습니다\.(.*)$/, "$1 $2개 삭제 완료 · 목록에서도 정리했습니다.$3")
      .replace(/^(댓글|실시간 채팅) 삭제 확인 0개, 이미 삭제됨 (\d+)개 · 해당 항목을 TraceLens 목록에서도 제거했습니다\.(.*)$/, "$1 $2개 목록 정리 완료 · Google에 이미 없어 TraceLens 목록에서만 정리했습니다. · 삭제권은 사용되지 않았습니다.$3")
      .replace(/^(댓글|실시간 채팅) 삭제 확인 (\d+)개, 이미 삭제됨 (\d+)개 · 해당 항목을 TraceLens 목록에서도 제거했습니다\.(.*)$/, "$1 처리 완료 · $2개 삭제, $3개 목록 정리 · TraceLens 목록에 반영했습니다.$4")
      .replace(/^(댓글|실시간 채팅) 실패 (\d+)개 · Google 내 활동에서 대상을 정확히 특정하지 못해 TraceLens 목록에 유지합니다\.(.*)$/, "$1 삭제 보류 $2개 · Google에서 항목을 정확히 확인하지 못해 목록에 유지했습니다. · 삭제권은 사용되지 않았습니다.$3")
      .replace(/^(댓글|실시간 채팅) 실패 (\d+)개 · 새로고침 후에도 동일한 항목이 Google 내 활동에 남아 있습니다\.(.*)$/, "$1 삭제 실패 $2개 · 항목이 Google에 남아 있어 목록을 유지했습니다. · 삭제권은 사용되지 않았습니다.$3")
      .replace(/^(댓글|실시간 채팅) 실패 (\d+)개 · Google 내 활동 전체 확인이 끝나지 않아 결과를 확정할 수 없습니다\.(.*)$/, "$1 삭제 보류 $2개 · 결과를 모두 확인하지 못해 목록에 유지했습니다. · 삭제권은 사용되지 않았습니다.$3")
      .replace(/^(댓글|실시간 채팅) 실패 (\d+)개 · 삭제 버튼 클릭 기록이 없어 삭제 여부를 확정할 수 없습니다\.(.*)$/, "$1 삭제 보류 $2개 · 삭제 여부를 확인하지 못해 목록에 유지했습니다. · 삭제권은 사용되지 않았습니다.$3")
      .replace(/^(댓글|실시간 채팅) 삭제 확인 (\d+)개, 이미 삭제됨 (\d+)개 · Google 내 활동 상태는 확인했지만 (.+)$/, "$1 반영 대기 · Google 삭제는 확인했지만 TraceLens 목록 반영이 완료되지 않았습니다. 잠시 후 새로고침해 주세요.")
      .replace(/삭제권 (\d+)개 차감, 잔여 (\d+)개/g, "삭제권 $1개 사용 · 남은 삭제권 $2개")
      .replace(/삭제권 (\d+)개 차감/g, "삭제권 $1개 사용");

    // 조회 결과와 내부 표현
    text = text
      .replace(/공통 전수조사기로/g, "전체 기록에서")
      .replace(/삭제 후 끝까지 전수 확인했습니다\./g, "삭제 결과를 모두 확인했습니다.")
      .replace(/끝까지 전수 확인했습니다\./g, "전체 기록 확인을 완료했습니다.")
      .replace(/원문 링크 \d+개 확인(?:, \d+개 미노출)?\.?/g, "")
      .replace(/끝까지 확인하지 못해 부분 결과로 저장했습니다\./g, "일부 기록만 확인했습니다. 다시 조회해 주세요.")
      .replace(/전수조사/g, "전체 확인")
      .replace(/동기화/g, "반영")
      .replace(/행 탐색/g, "항목 확인");

    // 일반 사용자에게 불필요한 내부 오류 정보
    if (/HTTP \d{3}:|TraceLens 활동 ID|응답 본문 없음|삭제 페이지 함수|어댑터 등록|자동 복구 한도|클릭 기록/.test(text)) {
      return "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요. 문제가 계속되면 문의해 주세요.";
    }

    return normalizeSpaces(text);
  }

  function updateTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const parent = node.parentElement;
    if (!parent || ["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "OPTION"].includes(parent.tagName)) return;
    const before = node.nodeValue || "";
    const after = userMessage(before);
    if (after && after !== normalizeSpaces(before)) node.nodeValue = after;
  }

  function updateElement(element) {
    if (!(element instanceof Element)) return;
    if (element.matches("#delete-operation-status, #tracelens-delete-banner")) {
      const before = element.textContent || "";
      const after = userMessage(before);
      if (after && after !== normalizeSpaces(before)) element.textContent = after;
      return;
    }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) updateTextNode(node);
  }

  function refresh() {
    if (!document.body) return;
    updateElement(document.body);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") updateTextNode(mutation.target);
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) updateTextNode(node);
        else if (node instanceof Element) updateElement(node);
      }
    }
  });

  const start = () => {
    refresh();
    observer.observe(document.documentElement, {subtree: true, childList: true, characterData: true});
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, {once: true});
  else start();
})();