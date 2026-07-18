(() => {
  if (location.pathname !== "/app") return;

  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  let waiting = false;

  function replaceText(selector, before, after) {
    const element = document.querySelector(selector);
    if (element && clean(element.textContent) === before) element.textContent = after;
  }

  function hideInternalDetails(rawText) {
    const text = String(rawText || "");
    if (/HTTP\s*\d+|CSRF|token|collector|ReferenceError|SyntaxError|Could not load|응답 본문|활동 ID|adapter|어댑터|service worker|서비스 워커|chrome-extension:\/\//i.test(text)) {
      console.warn("TraceLens internal scan message:", rawText);
      return "처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요. 문제가 계속되면 문의해 주세요.";
    }
    return text
      .replace(/^오류:\s*/gim, "확인 필요 · ")
      .replace(/공통 전수조사기(?:로)?/g, "")
      .replace(/원문 링크\s*\d+개 확인(?:,\s*\d+개 미노출)?\.?/g, "")
      .replace(/끝까지 확인했습니다\.?/g, "전체 기록 확인을 완료했습니다.")
      .replace(/부분 결과로 저장했습니다\.?/g, "일부 기록만 확인했습니다. 다시 조회해 주세요.")
      .replace(/동기화/g, "반영")
      .replace(/전수조사|전수 확인/g, "전체 확인")
      .replace(/행 탐색/g, "항목 확인")
      .replace(/활동 ID/g, "항목 정보")
      .replace(/extractor|snapshot|scope/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function simplifyLog() {
    const log = document.getElementById("web-scan-log");
    if (!log) return;
    const next = hideInternalDetails(log.textContent || "");
    if (next && log.textContent !== next) log.textContent = next;
  }

  function polish() {
    replaceText(".web-scan-card .card-kicker", "웹에서 바로 조회", "사이트 활동 조회");
    replaceText(".web-scan-card h2", "조회할 사이트를 선택하세요", "조회할 사이트 선택");
    replaceText(".web-scan-card .section-head .muted", "확장 프로그램 팝업을 열지 않아도 됩니다. 아래에서 사이트를 선택하고 조회를 시작하면 설치된 확장 프로그램이 자동으로 작업합니다.", "조회할 사이트를 선택하면 작성한 게시글과 댓글을 찾아 보관함에 정리합니다.");
    replaceText(".scan-card h2", "플랫폼별 실행 결과", "최근 조회 결과");
    replaceText(".scan-card .section-head .muted", "게시글·댓글처럼 나뉜 조회도 플랫폼 한 줄에 묶어서 표시합니다.", "사이트별로 확인된 활동을 보여줍니다.");
    replaceText("#extension-status-title", "확장 프로그램 연결 확인 중", "조회 기능 준비 중");
    replaceText("#extension-status-title", "확장 프로그램 자동 연결됨", "조회 준비 완료");
    replaceText("#extension-status-title", "확장 프로그램이 필요합니다", "조회 기능을 사용할 수 없습니다");
    replaceText("#extension-status-text", "대시보드를 열면 자동 연결됩니다.", "잠시만 기다려 주세요.");
    replaceText("#web-start-scan", "확장 프로그램 연결 확인 중", "조회 준비 중");
    replaceText("#web-start-scan", "선택 사이트 조회 시작", "선택한 사이트 조회");
    replaceText("#web-start-scan", "확장 프로그램 연결 필요", "확장 프로그램 확인");
    replaceText("#web-scan-help", "확장 프로그램이 설치되어 있으면 자동으로 연결됩니다.", "잠시만 기다려 주세요.");
    replaceText("#web-scan-help", "조회 중 각 사이트의 본인 활동 페이지가 잠시 열릴 수 있습니다.", "조회 중 사이트 활동 페이지가 잠시 열릴 수 있습니다.");
    replaceText("#web-progress-title", "조회 실패", "확인 필요");
    replaceText("#web-progress-state", "오류", "다시 시도");

    const progressState = document.getElementById("web-progress-state");
    const progressMatch = clean(progressState?.textContent).match(/(\d+)개 작업 완료/);
    if (progressState && progressMatch) progressState.textContent = `${progressMatch[1]}개 사이트 확인`;

    document.querySelectorAll(".scan-status").forEach((status) => {
      const text = clean(status.textContent);
      if (text === "오류" || text === "실패") status.textContent = "확인 필요";
      else if (text === "부분" || text === "일부 완료") status.textContent = "일부 확인";
      else if (text === "성공") status.textContent = "완료";
    });

    document.querySelectorAll(".scan-count").forEach((count) => {
      const match = clean(count.textContent).match(/(\d+)개 확인\s*·\s*(\d+)개 신규/);
      if (match) count.textContent = `${match[1]}개 확인 · ${match[2]}개 새로 저장`;
    });

    document.querySelectorAll(".scan-detail, .scan-message, .platform-message, .task-message").forEach((element) => {
      const next = hideInternalDetails(element.textContent || "");
      if (next && element.textContent !== next) element.textContent = next;
    });

    simplifyLog();
  }

  function schedule() {
    if (waiting) return;
    waiting = true;
    requestAnimationFrame(() => {
      waiting = false;
      polish();
    });
  }

  new MutationObserver(schedule).observe(document.documentElement, {subtree: true, childList: true, characterData: true});
  schedule();
})();