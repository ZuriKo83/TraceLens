(() => {
  if (location.pathname !== "/delete-credits/purchase") return;

  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const nativeConfirm = window.confirm.bind(window);
  let scheduled = false;

  const countFrom = (text, pattern) => Number(text.match(pattern)?.[1] || 0);
  const labelFrom = (text) => text.includes("실시간 채팅") ? "실시간 채팅" : "댓글";
  const balanceText = (text) => {
    const balance = text.match(/(?:잔여|남은 삭제권은?)\s*(\d+)개/);
    return balance ? ` 남은 삭제권은 ${balance[1]}개입니다.` : "";
  };

  function hideInternalDetails(rawText) {
    const text = clean(rawText);
    if (!text) return "";
    if (/HTTP\s*\d+|CSRF|token|collector|ReferenceError|SyntaxError|Could not load|응답 본문|활동 ID|adapter|어댑터|service worker|서비스 워커|stack|chrome-extension:\/\//i.test(text)) {
      console.warn("TraceLens internal deletion message:", rawText);
      return "처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요. 문제가 계속되면 문의해 주세요.";
    }
    return text
      .replace(/동기화/g, "반영")
      .replace(/전수조사|전수 확인/g, "전체 확인")
      .replace(/행 탐색/g, "항목 확인")
      .replace(/자동 복구/g, "작업 이어가기")
      .replace(/클릭 기록/g, "처리 기록")
      .replace(/삭제 페이지 함수/g, "삭제 기능")
      .replace(/활동 ID/g, "항목 정보");
  }

  function finalResultMessage(rawText) {
    const text = hideInternalDetails(rawText);
    const label = labelFrom(text);
    const failed = countFrom(text, /실패\s*(\d+)개/);
    const deleted = countFrom(text, /삭제 확인\s*(\d+)개/);
    const missing = countFrom(text, /이미 삭제됨\s*(\d+)개/);
    const charged = countFrom(text, /삭제권\s*(\d+)개\s*(?:차감|사용)/);

    if (/대상을 정확히 특정하지 못|정확히 확인하지 못|처리 기록이 없어|저장한 위치에서 대상/.test(text)) {
      return {text: `${label} 삭제 보류 ${Math.max(1, failed)}개 · 항목을 정확히 확인하지 못해 목록에 그대로 두었습니다. 삭제권은 사용되지 않았습니다.`, tone: "notice"};
    }
    if (/전체 확인이 끝나지 않아|결과를 확정할 수 없|끝까지 완료되지|결과를 모두 확인하지 못/.test(text)) {
      return {text: `${label} 삭제 보류 ${Math.max(1, failed)}개 · 결과 확인이 끝나지 않아 목록에 그대로 두었습니다. 삭제권은 사용되지 않았습니다. 잠시 후 다시 시도해 주세요.`, tone: "notice"};
    }
    if (/동일한 항목이 Google 내 활동에 남아|Google 내 활동에 남아 있습니다|항목이 Google에 남아/.test(text)) {
      return {text: `${label} 삭제 실패 ${Math.max(1, failed)}개 · Google에 항목이 남아 있어 목록에 그대로 두었습니다. 삭제권은 사용되지 않았습니다.`, tone: "error"};
    }
    if (/목록 반영|목록 동기화|반영이 아직 끝나지|항목 정보가 .*부족/.test(text)) {
      return {text: `${label} 삭제는 확인했지만 목록 반영이 끝나지 않았습니다. 잠시 후 페이지를 새로고침해 주세요.${balanceText(text)}`, tone: "notice"};
    }
    if (deleted > 0 && missing > 0) {
      return {text: `${label} 처리 완료 · ${deleted}개를 삭제하고 ${missing}개를 목록에서 정리했습니다. 삭제권은 실제로 삭제한 ${charged || deleted}개에만 사용되었습니다.${balanceText(text)}`, tone: "success"};
    }
    if (deleted > 0) {
      return {text: `${label} 삭제 완료 ${deleted}개 · 목록에서도 제거했습니다. 삭제권 ${charged || deleted}개를 사용했습니다.${balanceText(text)}`, tone: "success"};
    }
    if (missing > 0) {
      return {text: `${label} 목록 정리 완료 ${missing}개 · Google에 이미 없던 항목을 목록에서 정리했습니다. 삭제권은 사용되지 않았습니다.${balanceText(text)}`, tone: "success"};
    }
    if (/삭제 결과를 확인하지 못|응답이 없습니다|결과를 받지 못/.test(text)) {
      return {text: `${label} 삭제 결과를 확인하지 못했습니다. 항목은 목록에 그대로 두었고 삭제권은 사용되지 않았습니다. 잠시 후 다시 시도해 주세요.`, tone: "notice"};
    }
    return null;
  }

  function friendlyStatus(rawText) {
    let text = clean(rawText);
    if (!text || /확장 프로그램.*(?:연결됨|연결 확인 중)|삭제 기능을 준비하고 있습니다/.test(text)) {
      return {text: "", tone: "", hidden: true};
    }

    const last = text.startsWith("마지막 삭제 결과 · ") || text.startsWith("마지막 결과 · ");
    text = text.replace(/^마지막 삭제 결과\s*·\s*/, "").replace(/^마지막 결과\s*·\s*/, "");
    const final = finalResultMessage(text);
    if (final) return {...final, text: `${last ? "마지막 결과 · " : ""}${final.text}`, hidden: false};

    if (/확장 프로그램 연결에 실패|서비스 워커|Could not load|ReferenceError|SyntaxError/i.test(text)) {
      return {text: "삭제 기능을 준비하지 못했습니다. 페이지와 확장 프로그램을 새로고침한 뒤 다시 시도해 주세요.", tone: "error", hidden: false};
    }
    if (/삭제권\s*\d+개를 확인/.test(text)) return {text: "삭제권을 확인하고 있습니다.", tone: "", hidden: false};
    if (/전체 .*기록에서 대상을 찾|삭제 대상 탐색|개 대상을 전체 기록에서 찾/.test(text)) return {text: "선택한 항목을 찾고 있습니다.", tone: "", hidden: false};
    if (/행 탐색|항목 확인|삭제 요청 완료/.test(text)) {
      const count = countFrom(text, /(\d+)개\s*삭제 요청/);
      return {text: count ? `${count}개 항목을 삭제하고 있습니다.` : "선택한 항목을 삭제하고 있습니다.", tone: "", hidden: false};
    }
    if (/삭제 반영을 .*기다|전체 확인 완료|전수 확인|삭제 결과 확인|settling/i.test(text)) return {text: "삭제 결과를 확인하고 있습니다.", tone: "", hidden: false};
    if (/남은 항목만 다시 삭제|재삭제/.test(text)) return {text: "삭제되지 않은 항목을 다시 확인하고 있습니다.", tone: "", hidden: false};
    if (/작업 창.*닫|다른 주소로 이동|자동 복구|다시 엽니다|자동으로 다시/.test(text)) return {text: "작업 창을 다시 열고 있습니다. 삭제 작업은 계속됩니다.", tone: "notice", hidden: false};
    if (/삭제·.*동기화|목록과 삭제권을 동기화|목록을 직접 동기화|삭제 결과를 반영/.test(text)) return {text: "삭제 결과를 저장하고 있습니다.", tone: "", hidden: false};
    if (/삭제 작업이 완료|작업 창을 닫습니다/.test(text)) return {text: "삭제 처리를 마쳤습니다.", tone: "success", hidden: false};

    const safe = hideInternalDetails(text);
    return {text: `${last ? "마지막 결과 · " : ""}${safe}`, tone: /^처리 중 문제가/.test(safe) ? "error" : "", hidden: false};
  }

  function polishStatus() {
    const status = document.getElementById("delete-operation-status");
    if (!status) return;
    const result = friendlyStatus(status.textContent || "");
    status.hidden = Boolean(result.hidden);
    status.classList.remove("error", "success", "notice");
    if (result.tone) status.classList.add(result.tone);
    if (!result.hidden && status.textContent !== result.text) status.textContent = result.text;
  }

  function hideLegacyCopy() {
    document.querySelectorAll("#delete-execute .eyebrow,#delete-execute .muted,#youtube-selection-help,.selection-help").forEach((element) => { element.hidden = true; });
  }

  function schedulePolish() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      hideLegacyCopy();
      polishStatus();
    });
  }

  window.confirm = function(message) {
    const text = String(message || "");
    if (/선택한 YouTube/.test(text) && /실제로 삭제/.test(text)) {
      const count = text.match(/(\d+)개/)?.[1] || "선택한";
      const label = text.includes("실시간 채팅") ? "실시간 채팅" : "댓글";
      return nativeConfirm(`선택한 ${label} ${count}개를 삭제할까요?\n\n실제로 삭제된 항목에만 삭제권이 사용됩니다.`);
    }
    return nativeConfirm(friendlyStatus(text)?.text || hideInternalDetails(text));
  };

  const style = document.createElement("style");
  style.textContent = ".delete-operation-status.notice{background:#fff8e6;color:#8a5a00;border:1px solid #f1d48a}";
  document.documentElement.appendChild(style);

  new MutationObserver(schedulePolish).observe(document.documentElement, {subtree: true, childList: true, characterData: true});
  schedulePolish();
})();