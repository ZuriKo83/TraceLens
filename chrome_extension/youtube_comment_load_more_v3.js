(() => {
  const previousRunExtractor = runExtractor;

  runExtractor = async function(tabId, platform, activityType, ownershipScope = "self_activity", accountContext = null) {
    if (platform !== "youtube" || activityType !== "comment") {
      return previousRunExtractor(tabId, platform, activityType, ownershipScope, accountContext);
    }

    const preload = await preloadAllYouTubeCommentPages(tabId);
    const result = await previousRunExtractor(tabId, platform, activityType, ownershipScope, accountContext);

    const baseMessage = String(result?.message || "").trim();
    const preloadMessage = preload.clicks
      ? `추가 댓글 묶음 ${preload.clicks}회를 더 불러왔습니다.`
      : "추가 댓글 묶음 버튼이 없었습니다.";

    result.message = `${baseMessage} ${preloadMessage}`.trim();
    result.preload_diagnostics = preload;

    if (!preload.complete) {
      result.snapshot_complete = false;
      if (Array.isArray(result.items) && result.items.length) {
        result.status = "success";
        result.message = `${result.message} 전체 페이지 로딩 완료를 확인하지 못해 삭제 동기화는 보류합니다.`;
      }
    }
    return result;
  };

  async function preloadAllYouTubeCommentPages(tabId) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let clicks = 0;
    let noButtonChecks = 0;
    let stagnantClicks = 0;
    let lastCount = -1;
    let lastHeight = -1;
    let finalState = null;

    for (let step = 0; step < 250; step += 1) {
      const injected = await chrome.scripting.executeScript({
        target: {tabId},
        func: loadMoreYouTubeCommentsStep,
      });
      const state = injected?.[0]?.result;
      if (!state?.ok) {
        throw new Error(state?.message || "YouTube 댓글 추가 목록을 불러오지 못했습니다.");
      }
      finalState = state;

      const grew = state.item_count > lastCount || state.document_height > lastHeight;
      if (grew) stagnantClicks = 0;
      lastCount = Math.max(lastCount, Number(state.item_count || 0));
      lastHeight = Math.max(lastHeight, Number(state.document_height || 0));

      if (state.clicked) {
        clicks += 1;
        noButtonChecks = 0;
        stagnantClicks = grew ? 0 : stagnantClicks + 1;
        await sleep(950);
        continue;
      }

      if (state.loading) {
        noButtonChecks = 0;
        await sleep(700);
        continue;
      }

      if (state.load_more_present) {
        noButtonChecks = 0;
        stagnantClicks += 1;
        if (stagnantClicks >= 8) {
          return {
            complete: false,
            clicks,
            reason: "load_more_stalled",
            item_count: state.item_count,
            document_height: state.document_height,
            button_text: state.button_text || null,
          };
        }
        await sleep(750);
        continue;
      }

      noButtonChecks += 1;
      if (noButtonChecks >= 3) {
        return {
          complete: Boolean(state.end_marker),
          clicks,
          reason: state.end_marker ? "final_end_marker" : "no_load_more_button",
          item_count: state.item_count,
          document_height: state.document_height,
          button_text: null,
        };
      }
      await sleep(550);
    }

    return {
      complete: false,
      clicks,
      reason: "preload_step_limit",
      item_count: finalState?.item_count || 0,
      document_height: finalState?.document_height || 0,
      button_text: finalState?.button_text || null,
    };
  }

  function loadMoreYouTubeCommentsStep() {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden";
    };

    const current = new URL(location.href);
    if (location.hostname !== "myactivity.google.com" || current.searchParams.get("page") !== "youtube_comments") {
      return {
        ok: false,
        message: `Google 내 활동의 youtube_comments 페이지가 아닙니다. 현재 주소: ${location.href}`,
      };
    }

    const doc = document.scrollingElement || document.documentElement;
    const candidates = [doc, document.documentElement, document.body, ...document.querySelectorAll("main,c-wiz,section,div")]
      .filter(Boolean)
      .filter((node, index, all) => all.indexOf(node) === index)
      .filter((node) => node === doc || node.scrollHeight > node.clientHeight + 30)
      .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight));

    for (const node of candidates.slice(0, 8)) {
      node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
      node.dispatchEvent(new Event("scroll", {bubbles: true}));
    }
    window.scrollTo(0, Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0));

    const loading = [...document.querySelectorAll("[aria-busy='true'],[data-active='true']")]
      .some((node) => visible(node));
    const endPattern = /더 이상 표시할 콘텐츠가 없습니다|더 이상 표시할 활동이 없습니다|Looks like you(?:'|’)ve reached the end|no more content/i;
    const endMarker = [...document.querySelectorAll("body *")].some((node) => {
      if (!visible(node)) return false;
      const text = clean(node.textContent || "");
      return text.length <= 140 && endPattern.test(text);
    });

    const morePattern = /^(?:더\s*(?:보기|불러오기|로드)|이전\s*활동\s*더\s*보기|Load\s+more|Show\s+more|More\s+results|Older)$/i;
    const controls = [...document.querySelectorAll("button,[role='button'],a")]
      .filter((node) => visible(node))
      .map((node) => ({
        node,
        text: clean(`${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`),
      }))
      .filter(({node, text}) => (
        morePattern.test(text)
        && !node.closest("[role='listitem'],article,li,div[data-id]")
      ));

    const actionable = controls.find(({node}) => (
      !node.disabled
      && node.getAttribute("aria-disabled") !== "true"
    ));
    let clicked = false;
    if (actionable && !loading) {
      actionable.node.scrollIntoView({block: "center"});
      actionable.node.click();
      clicked = true;
    }

    const commentLinks = new Set(
      [...document.querySelectorAll("a[href*='youtube.com/watch'],a[href*='youtu.be/'],a[href*='/post/']")]
        .map((anchor) => anchor.href)
        .filter(Boolean)
    );
    const deleteControls = [...document.querySelectorAll("button,[role='button']")].filter((button) => {
      const label = clean(`${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`);
      const text = clean(button.innerText || button.textContent);
      return /삭제|delete|remove|활동 삭제/i.test(label) || ["×", "✕", "X"].includes(text);
    }).length;

    return {
      ok: true,
      clicked,
      loading,
      end_marker: endMarker,
      load_more_present: controls.length > 0,
      button_text: actionable?.text || controls[0]?.text || null,
      item_count: Math.max(commentLinks.size, deleteControls),
      document_height: Math.max(
        document.body?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0,
        ...candidates.slice(0, 8).map((node) => node.scrollHeight || 0)
      ),
    };
  }
})();
