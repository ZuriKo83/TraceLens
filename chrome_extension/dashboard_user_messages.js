(() => {
  if (location.pathname !== "/app") return;

  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  let waiting = false;

  function hideInternalDetails(rawText) {
    const text = String(rawText || "");
    const taskLine = text.match(/^([✓✕])\s*([^:]+):\s*(.*)$/s);
    if (taskLine) {
      const [, mark, label, detail] = taskLine;
      const friendlyDetail = hideInternalDetails(detail);
      return mark === "✓"
        ? `${clean(label).replace(/\b내\s*/g, "")} · ${friendlyDetail}`
        : `${clean(label).replace(/\b내\s*/g, "")} · ${friendlyDetail}`;
    }
    if (/로그인 상태를 확인하지 못|로그인된 .*?(?:프로필|계정|ID|주소).*찾지 못/.test(text)) {
      return "해당 사이트에 로그인한 뒤 다시 조회해 주세요.";
    }
    if (/본인 활동 페이지 확인에 실패|활동 페이지를 확인하지 못/.test(text)) {
      return "해당 사이트의 활동 페이지를 확인하지 못했습니다. 로그인 상태를 확인한 뒤 다시 조회해 주세요.";
    }
    if (/페이지 로딩 시간이 초과|조회 탭을 찾을 수 없/.test(text)) {
      return "사이트 응답이 늦어 조회를 마치지 못했습니다. 잠시 후 다시 시도해 주세요.";
    }
    if (/HTTP\s*\d+|CSRF|token|collector|ReferenceError|SyntaxError|Could not load|응답 본문|활동 ID|adapter|어댑터|service worker|서비스 워커|chrome-extension:\/\/|https?:\/\//i.test(text)) {
      console.warn("TraceLens internal scan message:", rawText);
      return "처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요. 문제가 계속되면 문의해 주세요.";
    }
    return text
      .replace(/^오류:\s*/gim, "")
      .replace(/공통 전수조사기(?:로)?/g, "")
      .replace(/원문 링크\s*\d+개 확인(?:,\s*\d+개 미노출)?\.?/g, "")
      .replace(/끝까지 확인했습니다\.?/g, "")
      .replace(/부분 결과로 저장했습니다\.?/g, "일부 기록만 확인했습니다. 다시 조회해 주세요.")
      .replace(/(\d+)개 확인,\s*(\d+)개 신규/g, "$1개 확인 · $2개 새로 저장")
      .replace(/(\d+)개 신규/g, "$1개 새로 저장")
      .replace(/동기화/g, "반영")
      .replace(/전수조사|전수 확인/g, "전체 확인")
      .replace(/행 탐색/g, "항목 확인")
      .replace(/활동 ID/g, "항목 정보")
      .replace(/extractor|snapshot|scope/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function hideNonessentialElements() {
    document.querySelectorAll([
      ".user-hero .eyebrow",
      ".user-hero .lead",
      ".stats small",
      ".web-scan-card .card-kicker",
      ".web-scan-card .section-head .muted",
      ".scan-card .card-kicker",
      ".scan-card .section-head .muted",
      ".result-card .card-kicker",
      "#web-scan-help",
    ].join(",")).forEach((element) => { element.hidden = true; });
  }

  function polishConnectionCard() {
    const card = document.getElementById("extension-status-card");
    const title = document.getElementById("extension-status-title");
    if (!card || !title) return;
    const connected = document.documentElement.dataset.tracelensExtension === "connected";
    if (connected) {
      card.hidden = true;
      return;
    }
    const text = clean(title.textContent);
    const needsAction = /필요|사용할 수 없|설치|로그인|실패|확인 필요/.test(text);
    card.hidden = !needsAction;
  }

  function polishResults() {
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

    document.querySelectorAll(".scan-scope-row").forEach((row) => {
      const status = clean(row.querySelector(".scan-status")?.textContent);
      const message = row.querySelector("p");
      if (!message) return;
      if (status === "완료") {
        message.hidden = true;
        return;
      }
      const next = hideInternalDetails(message.textContent || "");
      message.hidden = !next;
      if (next && next !== message.textContent) message.textContent = next;
    });
  }

  function polishDynamicMessages() {
    const progressTitle = document.getElementById("web-progress-title");
    const progressState = document.getElementById("web-progress-state");
    if (progressTitle && clean(progressTitle.textContent) === "조회 실패") progressTitle.textContent = "확인 필요";
    if (progressState && clean(progressState.textContent) === "오류") progressState.textContent = "";

    const complete = clean(progressState?.textContent).match(/(\d+)개 작업 완료/);
    if (progressState && complete) progressState.textContent = `${complete[1]}개 완료`;

    for (const selector of ["#web-scan-log", ".scan-detail", ".scan-message", ".platform-message", ".task-message"]) {
      document.querySelectorAll(selector).forEach((element) => {
        const next = hideInternalDetails(element.textContent || "");
        if (next !== element.textContent) element.textContent = next;
      });
    }
  }

  function polish() {
    hideNonessentialElements();
    polishConnectionCard();
    polishResults();
    polishDynamicMessages();
  }

  function schedule() {
    if (waiting) return;
    waiting = true;
    requestAnimationFrame(() => {
      waiting = false;
      polish();
    });
  }

  new MutationObserver(schedule).observe(document.documentElement, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class", "data-tracelens-extension"]});
  schedule();
})();