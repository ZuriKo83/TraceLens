(() => {
  if (location.pathname !== "/delete-credits/purchase") return;

  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const nativeConfirm = window.confirm.bind(window);
  let scheduled = false;

  function countFrom(text, pattern) {
    const match = text.match(pattern);
    return match ? Number(match[1] || 0) : 0;
  }

  function labelFrom(text) {
    return text.includes("실시간 채팅") ? "실시간 채팅" : "댓글";
  }

  function balanceText(text) {
    const balance = text.match(/(?:잔여|남은 삭제권은?)\s*(\d+)개/);
    return balance ? ` 남은 삭제권은 ${balance[1]}개입니다.` : "";
  }

  function hideInternalDetails(rawText) {
    const text = clean(rawText);
    if (!text) return text;

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
      return {
        text: `${label} 삭제 보류 ${Math.max(1, failed)}개 · 항목을 정확히 확인하지 못해 목록에 그대로 두었습니다. 삭제권은 사용되지 않았습니다.`,
        tone: "notice",
      };
    }

    if (/전체 확인이 끝나지 않아|결과를 확정할 수 없|끝까지 완료되지|결과를 모두 확인하지 못/.test(text)) {
      return {
        text: `${label} 삭제 보류 ${Math.max(1, failed)}개 · 결과 확인이 끝나지 않아 목록에 그대로 두었습니다. 삭제권은 사용되지 않았습니다. 잠시 후 다시 시도해 주세요.`,
        tone: "notice",
      };
    }

    if (/동일한 항목이 Google 내 활동에 남아|Google 내 활동에 남아 있습니다|항목이 Google에 남아/.test(text)) {
      return {
        text: `${label} 삭제 실패 ${Math.max(1, failed)}개 · Google에 항목이 남아 있어 목록에 그대로 두었습니다. 삭제권은 사용되지 않았습니다.`,
        tone: "error",
      };
    }

    if (/목록 반영|목록 동기화|반영이 아직 끝나지|항목 정보가 .*부족/.test(text)) {
      return {
        text: `${label} 삭제는 확인했지만 목록 반영이 아직 끝나지 않았습니다. 잠시 후 페이지를 새로고침해 주세요.${balanceText(text)}`,
        tone: "notice",
      };
    }

    if (deleted > 0 || missing > 0) {
      if (deleted > 0 && missing > 0) {
        return {
          text: `${label} 처리 완료 · ${deleted}개를 삭제하고, Google에 이미 없던 ${missing}개를 목록에서 정리했습니다. 삭제권은 실제로 삭제한 ${charged || deleted}개에만 사용되었습니다.${balanceText(text)}`,
          tone: "success",
        };
      }
      if (deleted > 0) {
        return {
          text: `${label} 삭제 완료 ${deleted}개 · 목록에서도 제거했습니다. 삭제권 ${charged || deleted}개를 사용했습니다.${balanceText(text)}`,
          tone: "success",
        };
      }
      return {
        text: `${label} 목록 정리 완료 ${missing}개 · Google에 이미 없던 항목을 목록에서 정리했습니다. 삭제권은 사용되지 않았습니다.${balanceText(text)}`,
        tone: "success",
      };
    }

    if (/삭제 결과를 확인하지 못|응답이 없습니다|결과를 받지 못/.test(text)) {
      return {
        text: `${label} 삭제 결과를 확인하지 못했습니다. 항목은 목록에 그대로 두었고 삭제권은 사용되지 않았습니다. 잠시 후 다시 시도해 주세요.`,
        tone: "notice",
      };
    }

    return null;
  }

  function friendlyStatus(rawText) {
    let text = clean(rawText);
    const last = text.startsWith("마지막 삭제 결과 · ") || text.startsWith("마지막 결과 · ");
    text = text.replace(/^마지막 삭제 결과\s*·\s*/, "").replace(/^마지막 결과\s*·\s*/, "");

    const final = finalResultMessage(text);
    if (final) return {...final, text: `${last ? "마지막 결과 · " : ""}${final.text}`};

    if (/확장 프로그램.*연결됨/.test(text)) {
      return {text: "삭제할 YouTube 댓글 또는 실시간 채팅을 선택하세요. 한 번에 최대 100개까지 선택할 수 있습니다.", tone: "success"};
    }
    if (/확장 프로그램 연결에 실패|서비스 워커|Could not load|ReferenceError|SyntaxError/i.test(text)) {
      return {text: "삭제 기능을 시작하지 못했습니다. 확장 프로그램을 새로고침한 뒤 다시 시도해 주세요.", tone: "error"};
    }
    if (/삭제권\s*\d+개를 확인/.test(text)) {
      return {text: "사용 가능한 삭제권을 확인하고 있습니다.", tone: ""};
    }
    if (/전체 .*기록에서 대상을 찾|삭제 대상 탐색|개 대상을 전체 기록에서 찾/.test(text)) {
      return {text: "선택한 항목을 찾고 있습니다. 잠시 기다려 주세요.", tone: ""};
    }
    if (/행 탐색|항목 확인|삭제 요청 완료/.test(text)) {
      const count = countFrom(text, /(\d+)개\s*삭제 요청/);
      return {text: count ? `${count}개 항목의 삭제를 요청했습니다. 결과를 확인하고 있습니다.` : "선택한 항목을 확인하고 삭제를 진행하고 있습니다.", tone: ""};
    }
    if (/삭제 반영을 .*기다|settling/i.test(text)) {
      return {text: "삭제 결과가 반영될 때까지 잠시 기다리고 있습니다.", tone: ""};
    }
    if (/전체 확인 완료|전수 확인|삭제 결과 확인/.test(text)) {
      return {text: "삭제 결과를 확인하고 있습니다.", tone: ""};
    }
    if (/남은 항목만 다시 삭제|재삭제/.test(text)) {
      const count = countFrom(text, /(\d+)개/);
      return {text: count ? `아직 남아 있는 ${count}개 항목을 다시 확인하고 있습니다.` : "아직 남아 있는 항목을 다시 확인하고 있습니다.", tone: ""};
    }
    if (/작업 창.*닫|다른 주소로 이동|자동 복구|다시 엽니다|자동으로 다시/.test(text)) {
      return {text: "작업 창이 닫혀 다시 열고 있습니다. 삭제 작업은 취소되지 않았습니다. 잠시 기다려 주세요.", tone: "notice"};
    }
    if (/삭제·.*동기화|목록과 삭제권을 동기화|목록을 직접 동기화|삭제 결과를 반영/.test(text)) {
      return {text: "삭제 결과를 저장하고 있습니다. 잠시 기다려 주세요.", tone: ""};
    }
    if (/삭제 작업이 완료|작업 창을 닫습니다/.test(text)) {
      return {text: "삭제 처리를 마쳤습니다. 결과를 확인해 주세요.", tone: "success"};
    }

    const safe = hideInternalDetails(text);
    if (safe !== text && /^처리 중 문제가/.test(safe)) return {text: safe, tone: "error"};
    return {text: `${last ? "마지막 결과 · " : ""}${safe}`, tone: ""};
  }

  function applyTone(status, tone) {
    status.classList.remove("error", "success", "notice");
    if (tone) status.classList.add(tone);
  }

  function polishStatus() {
    const status = document.getElementById("delete-operation-status");
    if (!status) return;
    const result = friendlyStatus(status.textContent || "");
    if (!result) return;
    if (status.textContent !== result.text) status.textContent = result.text;
    applyTone(status, result.tone);
  }

  function replaceExact(selector, before, after) {
    const element = document.querySelector(selector);
    if (element && clean(element.textContent) === before) element.textContent = after;
  }

  function polishStaticText() {
    replaceExact("#delete-execute .archive-head h2", "플랫폼별 삭제 실행", "작성한 항목 삭제");
    replaceExact("#delete-execute .archive-head .muted", "삭제권 구매 영역과 실제 삭제 실행 영역을 분리했습니다.", "삭제할 항목을 선택하면 Google에서 삭제를 진행합니다.");
    replaceExact("#delete-operation-status", "확장 프로그램 연결 확인 중입니다.", "삭제 기능을 준비하고 있습니다.");
    replaceExact("#selected-delete-button", "선택 항목 삭제", "선택한 항목 삭제");
    replaceExact(".empty-archive div", "먼저 내 활동에서 사이트 조회를 실행하세요.", "먼저 ‘내 활동’에서 YouTube 조회를 실행해 주세요.");

    const help = document.getElementById("youtube-selection-help");
    if (help) help.textContent = help.textContent.replace("까지 처리합니다.", "까지 선택할 수 있습니다.");
    const selectVisible = document.getElementById("select-visible");
    if (selectVisible) selectVisible.textContent = selectVisible.textContent.replace(/^현재 (.+) 선택$/, "보이는 $1 모두 선택");
  }

  function schedulePolish() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      polishStaticText();
      polishStatus();
    });
  }

  window.confirm = function(message) {
    const text = String(message || "");
    if (/선택한 YouTube/.test(text) && /실제로 삭제/.test(text)) {
      const count = text.match(/(\d+)개/)?.[1] || "선택한";
      const label = text.includes("실시간 채팅") ? "실시간 채팅" : "댓글";
      return nativeConfirm(`선택한 ${label} ${count}개를 삭제할까요?\n\nGoogle에서 삭제가 확인된 항목에만 삭제권이 사용됩니다.`);
    }
    return nativeConfirm(friendlyStatus(text)?.text || hideInternalDetails(text));
  };

  const style = document.createElement("style");
  style.textContent = ".delete-operation-status.notice{background:#fff8e6;color:#8a5a00;border:1px solid #f1d48a}";
  document.documentElement.appendChild(style);

  new MutationObserver(schedulePolish).observe(document.documentElement, {subtree: true, childList: true, characterData: true});
  schedulePolish();
})();