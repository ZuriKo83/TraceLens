(() => {
  const MAX_YOUTUBE_DELETE_SELECTION = 100;
  const token = document.querySelector('meta[name="tracelens-extension-token"]')?.content?.trim();
  const serverUrl = document.querySelector('meta[name="tracelens-server-url"]')?.content?.trim() || location.origin;
  const userEmail = document.querySelector('meta[name="tracelens-user-email"]')?.content?.trim() || "";
  if (!token) return;

  const config = {serverUrl, collectorToken: token, userEmail};
  const publish = (detail) => window.dispatchEvent(new CustomEvent("TRACELENS_EXTENSION_EVENT", {detail}));
  const query = new URLSearchParams(location.search);
  const deletionMode = location.pathname === "/app" && query.get("mode") === "delete";

  chrome.runtime.sendMessage({type: "WEB_CONNECT", config}, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      publish({type: "CONNECTION", connected: false, error: chrome.runtime.lastError?.message || response?.error || "연결 실패"});
      return;
    }
    document.documentElement.dataset.tracelensExtension = "connected";
    document.documentElement.dataset.tracelensExtensionUser = response.userEmail || userEmail;
    publish({type: "CONNECTION", connected: true, userEmail: response.userEmail || userEmail});
    if (deletionMode) installDeletionCenter();
  });

  window.addEventListener("TRACELENS_WEB_COMMAND", (event) => {
    const detail = event.detail || {};
    if (detail.type === "PING") {
      publish({type: "CONNECTION", connected: true, userEmail});
      return;
    }
    if (detail.type !== "START_SCAN") return;

    const sites = Array.isArray(detail.sites) ? detail.sites : [];
    if (!sites.length) {
      publish({type: "SCAN_RESULT", ok: false, error: "조회할 사이트를 하나 이상 선택하세요."});
      return;
    }

    publish({type: "SCAN_STARTED", sites});
    chrome.runtime.sendMessage({type: "SCAN_SITES", sites, config}, (response) => {
      if (chrome.runtime.lastError) {
        publish({type: "SCAN_RESULT", ok: false, error: chrome.runtime.lastError.message});
        return;
      }
      publish({type: "SCAN_RESULT", ...(response || {ok: false, error: "응답이 없습니다."})});
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "PLATFORM_DELETE_PROGRESS" || message?.platform !== "youtube") return false;
    updateYouTubeDeletionStatus(message);
    return false;
  });

  function installDeletionCenter() {
    const canonical = "/app?mode=delete&platform=youtube&activity_type=comment";
    if (query.get("platform") !== "youtube" || query.get("activity_type") !== "comment") {
      location.replace(canonical);
      return;
    }
    if (document.getElementById("tracelens-deletion-center")) return;

    document.title = `삭제 관리 · ${document.title.split("·").pop()?.trim() || "TraceLens"}`;
    injectDeletionStyles();
    for (const selector of [".dashboard-hero", ".stats", ".web-scan-card", ".scan-card"]) {
      document.querySelector(selector)?.classList.add("tracelens-delete-hidden");
    }

    const resultCard = document.querySelector(".result-card");
    const activityList = document.getElementById("activity-group-list");
    if (!resultCard || !activityList) return;
    resultCard.classList.add("tracelens-delete-result-card");
    resultCard.querySelector(".filters")?.classList.add("tracelens-delete-hidden");
    resultCard.querySelector(".result-head")?.classList.add("tracelens-delete-hidden");

    const center = document.createElement("section");
    center.id = "tracelens-deletion-center";
    center.className = "card tracelens-deletion-center";
    center.innerHTML = `
      <div class="tracelens-delete-heading">
        <div>
          <p class="card-kicker">DELETE CENTER</p>
          <h1>삭제 관리</h1>
          <p class="muted">내 활동 보관함과 분리된 화면입니다. 플랫폼과 활동 유형을 선택해 실제 원문을 삭제합니다.</p>
        </div>
        <a class="button secondary" href="/app">내 활동으로 돌아가기</a>
      </div>
      <div class="tracelens-platform-grid" aria-label="삭제 플랫폼 선택">
        <section class="tracelens-platform-card active">
          <div><b>YouTube</b><span>사용 가능</span></div>
          <a href="${canonical}" aria-current="page">댓글</a>
          <button type="button" disabled>실시간 채팅 · 준비 중</button>
        </section>
        <section class="tracelens-platform-card"><div><b>Instagram</b><span>준비 중</span></div><button type="button" disabled>댓글</button></section>
        <section class="tracelens-platform-card"><div><b>Threads</b><span>준비 중</span></div><button type="button" disabled>게시글</button><button type="button" disabled>답글</button></section>
        <section class="tracelens-platform-card"><div><b>Facebook</b><span>준비 중</span></div><button type="button" disabled>게시글</button><button type="button" disabled>댓글</button></section>
        <section class="tracelens-platform-card"><div><b>X</b><span>준비 중</span></div><button type="button" disabled>게시글·답글</button></section>
        <section class="tracelens-platform-card"><div><b>네이버</b><span>준비 중</span></div><button type="button" disabled>블로그 게시글</button><button type="button" disabled>지식iN 질문·답변</button></section>
      </div>
    `;
    resultCard.parentElement?.insertBefore(center, resultCard);

    installYouTubeDeletionUi(resultCard, activityList);
  }

  function installYouTubeDeletionUi(resultCard, activityList) {
    const youtubeGroups = [...activityList.querySelectorAll(".activity-group")].filter((group) =>
      group.querySelector(".badge.platform-youtube")
    );
    for (const group of [...activityList.querySelectorAll(".activity-group")]) {
      if (!youtubeGroups.includes(group)) group.classList.add("tracelens-delete-hidden");
    }

    const rows = youtubeGroups.flatMap((group) => [...group.querySelectorAll(".activity-row")]);
    const eligibleRows = rows.filter((row) => {
      const title = row.querySelector("h3")?.textContent?.trim() || "";
      return title && !title.startsWith("[실시간 채팅]");
    });
    for (const row of rows) {
      if (!eligibleRows.includes(row)) row.classList.add("tracelens-delete-hidden");
    }

    eligibleRows.forEach((row, index) => {
      row.dataset.tracelensYoutubeTargetId = `youtube-row-${index + 1}`;
      row.classList.add("tracelens-youtube-delete-row");
      if (row.querySelector(".tracelens-youtube-delete-check")) return;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "tracelens-youtube-delete-check";
      checkbox.setAttribute("aria-label", "삭제할 YouTube 댓글 선택");
      row.prepend(checkbox);
      checkbox.addEventListener("change", enforceDeletionSelectionLimit);
    });

    const toolbar = document.createElement("div");
    toolbar.id = "tracelens-youtube-delete-toolbar";
    toolbar.innerHTML = `
      <div class="tracelens-delete-toolbar-head">
        <div><p class="card-kicker">YOUTUBE · COMMENTS</p><h2>YouTube 댓글 삭제</h2></div>
        <span id="tracelens-youtube-delete-count">0/${MAX_YOUTUBE_DELETE_SELECTION}개 선택</span>
      </div>
      <div class="tracelens-youtube-delete-actions">
        <button type="button" id="tracelens-youtube-select-all">최대 100개 선택</button>
        <button type="button" id="tracelens-youtube-clear">선택 해제</button>
        <button type="button" id="tracelens-youtube-delete-start" disabled>선택 댓글 삭제</button>
      </div>
      <p id="tracelens-youtube-delete-status">최대 100개를 아래쪽부터 20개씩 처리하고, 새로고침 후 전체 기록을 다시 확인합니다.</p>
    `;
    resultCard.insertBefore(toolbar, activityList);

    document.getElementById("tracelens-youtube-select-all")?.addEventListener("click", () => {
      eligibleRows.forEach((row, index) => {
        row.querySelector(".tracelens-youtube-delete-check").checked = index < MAX_YOUTUBE_DELETE_SELECTION;
      });
      if (eligibleRows.length > MAX_YOUTUBE_DELETE_SELECTION) {
        updateYouTubeDeletionStatus({message: `위에서부터 ${MAX_YOUTUBE_DELETE_SELECTION}개만 선택했습니다.`});
      }
      refreshDeletionSelection();
    });
    document.getElementById("tracelens-youtube-clear")?.addEventListener("click", () => {
      eligibleRows.forEach((row) => { row.querySelector(".tracelens-youtube-delete-check").checked = false; });
      refreshDeletionSelection();
    });
    document.getElementById("tracelens-youtube-delete-start")?.addEventListener("click", startYouTubeDeletion);
    refreshDeletionSelection();
  }

  function injectDeletionStyles() {
    if (document.getElementById("tracelens-delete-style")) return;
    const style = document.createElement("style");
    style.id = "tracelens-delete-style";
    style.textContent = `
      .tracelens-delete-hidden { display: none !important; }
      .tracelens-deletion-center { margin-bottom: 18px; }
      .tracelens-delete-heading, .tracelens-delete-toolbar-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
      .tracelens-delete-heading h1, .tracelens-delete-toolbar-head h2 { margin: 0; }
      .tracelens-platform-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(190px,1fr)); gap: 12px; margin-top: 20px; }
      .tracelens-platform-card { border: 1px solid rgba(0,0,0,.12); border-radius: 14px; padding: 14px; background: rgba(0,0,0,.018); display: grid; gap: 8px; }
      .tracelens-platform-card.active { border-color: rgba(196,52,52,.5); background: rgba(196,52,52,.055); }
      .tracelens-platform-card > div { display: flex; justify-content: space-between; gap: 8px; }
      .tracelens-platform-card span { font-size: 12px; color: var(--muted,#666); }
      .tracelens-platform-card a, .tracelens-platform-card button { text-align: left; border: 1px solid rgba(0,0,0,.12); border-radius: 9px; padding: 8px 10px; background: #fff; color: inherit; text-decoration: none; }
      .tracelens-platform-card button:disabled { opacity: .55; }
      #tracelens-youtube-delete-toolbar { margin-bottom: 16px; padding: 16px; border: 1px solid rgba(196,52,52,.35); border-radius: 14px; background: rgba(196,52,52,.06); }
      #tracelens-youtube-delete-count { color: var(--muted,#666); font-size: 13px; }
      .tracelens-youtube-delete-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
      .tracelens-youtube-delete-actions button { border: 1px solid rgba(0,0,0,.14); border-radius: 10px; padding: 8px 12px; background: #fff; cursor: pointer; }
      #tracelens-youtube-delete-start { background: #a92d2d; color: #fff; border-color: #a92d2d; }
      #tracelens-youtube-delete-start:disabled { opacity: .5; cursor: not-allowed; }
      #tracelens-youtube-delete-status { margin: 10px 0 0; color: var(--muted,#666); font-size: 13px; }
      .tracelens-youtube-delete-row { position: relative; padding-left: 42px !important; }
      .tracelens-youtube-delete-check { position: absolute; left: 14px; top: 18px; width: 17px; height: 17px; }
    `;
    document.head.appendChild(style);
  }

  function selectedDeletionRows() {
    return [...document.querySelectorAll(".tracelens-youtube-delete-row")].filter((row) =>
      row.querySelector(".tracelens-youtube-delete-check")?.checked
    );
  }

  function enforceDeletionSelectionLimit(event) {
    const rows = selectedDeletionRows();
    if (rows.length > MAX_YOUTUBE_DELETE_SELECTION) {
      event.currentTarget.checked = false;
      updateYouTubeDeletionStatus({message: `한 번에 최대 ${MAX_YOUTUBE_DELETE_SELECTION}개까지 선택할 수 있습니다.`});
    }
    refreshDeletionSelection();
  }

  function refreshDeletionSelection() {
    const rows = selectedDeletionRows();
    const count = document.getElementById("tracelens-youtube-delete-count");
    const button = document.getElementById("tracelens-youtube-delete-start");
    if (count) count.textContent = `${rows.length}/${MAX_YOUTUBE_DELETE_SELECTION}개 선택`;
    if (button) button.disabled = rows.length === 0 || rows.length > MAX_YOUTUBE_DELETE_SELECTION || button.dataset.running === "1";
  }

  function rowTarget(row) {
    let locator = {};
    try {
      locator = JSON.parse(row.dataset.tracelensYoutubeDeletionLocator || "{}");
    } catch {}
    return {
      id: row.dataset.tracelensYoutubeTargetId,
      title: row.querySelector("h3")?.textContent?.trim() || "",
      content: row.querySelector("p")?.textContent?.trim() || "",
      sourceUrl: row.querySelector("a.source-link")?.href || "",
      locator,
    };
  }

  function startYouTubeDeletion() {
    const rows = selectedDeletionRows();
    if (!rows.length) return;
    if (rows.length > MAX_YOUTUBE_DELETE_SELECTION) {
      alert(`한 번에 최대 ${MAX_YOUTUBE_DELETE_SELECTION}개까지 선택하세요.`);
      return;
    }
    if (!confirm(`선택한 YouTube 댓글 ${rows.length}개를 실제로 삭제합니다.\n\n삭제 후 되돌릴 수 없습니다. 계속하시겠습니까?`)) return;

    const button = document.getElementById("tracelens-youtube-delete-start");
    if (button) {
      button.dataset.running = "1";
      button.disabled = true;
      button.textContent = "삭제 진행 중…";
    }
    setDeletionControlsDisabled(true);
    updateYouTubeDeletionStatus({message: "전체 기록에서 대상을 찾은 뒤 아래쪽부터 삭제합니다. 작업 탭을 닫거나 이동하지 마세요."});

    chrome.runtime.sendMessage({type: "DELETE_PLATFORM_ITEMS", platform: "youtube", targets: rows.map(rowTarget), config}, (response) => {
      if (chrome.runtime.lastError) {
        finishDeletionUi({ok: false, error: chrome.runtime.lastError.message});
        return;
      }
      finishDeletionUi(response || {ok: false, error: "삭제 결과를 받지 못했습니다."});
    });
  }

  function setDeletionControlsDisabled(disabled) {
    for (const element of document.querySelectorAll("#tracelens-youtube-delete-toolbar button, .tracelens-youtube-delete-check")) {
      element.disabled = disabled;
    }
  }

  function updateYouTubeDeletionStatus(message) {
    const status = document.getElementById("tracelens-youtube-delete-status");
    if (status && message?.message) status.textContent = message.message;
  }

  function finishDeletionUi(result) {
    const button = document.getElementById("tracelens-youtube-delete-start");
    if (button) {
      delete button.dataset.running;
      button.textContent = "선택 댓글 삭제";
    }
    if (!result?.ok && !result?.synced) {
      updateYouTubeDeletionStatus({message: result?.error || "삭제 작업에 실패했습니다."});
      setDeletionControlsDisabled(false);
      refreshDeletionSelection();
      return;
    }
    const summary = `삭제 확인 ${result.deleted || 0}개, 이미 없음 ${result.alreadyMissing || 0}개, 실패 ${result.failed || 0}개`;
    updateYouTubeDeletionStatus({message: `${summary}. 삭제 목록을 새로고침합니다.`});
    setTimeout(() => location.reload(), 2200);
  }
})();