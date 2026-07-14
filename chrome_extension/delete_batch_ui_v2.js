(() => {
  const token = document.querySelector('meta[name="tracelens-extension-token"]')?.content?.trim();
  const serverUrl = (document.querySelector('meta[name="tracelens-server-url"]')?.content?.trim() || location.origin).replace(/\/+$/, "");
  if (!token) return;

  const PORT_NAME = "tracelens-delete-batch-v3";
  const config = {serverUrl, collectorToken: token};
  const button = document.getElementById("selected-delete-button");
  const statusBox = document.getElementById("delete-status");
  const balanceNode = document.getElementById("delete-credit-balance");
  const selectionBalanceNode = document.getElementById("selection-balance");
  if (!button || !statusBox) return;

  let running = false;
  let activeJobId = null;
  let port = null;
  let heartbeat = null;
  let lastPongAt = 0;
  let automaticRetryUsed = false;
  let overallTotal = 0;
  let overallSuccess = 0;

  const selectedChecks = () => [...document.querySelectorAll(".delete-activity-checkbox")]
    .filter((check) => check instanceof HTMLInputElement && check.checked && !check.disabled && check.isConnected);

  function setStatus(message, kind = "running") {
    statusBox.textContent = message;
    statusBox.style.whiteSpace = "pre-wrap";
    statusBox.className = `delete-status show ${kind}`.trim();
  }

  function setBalance(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    if (balanceNode) balanceNode.textContent = `${number}개`;
    if (selectionBalanceNode) selectionBalanceNode.textContent = String(number);
  }

  function setRunning(value, text = null) {
    running = value;
    button.disabled = value;
    if (text) button.textContent = text;
  }

  function stopHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  function startHeartbeat(jobId) {
    stopHeartbeat();
    lastPongAt = Date.now();

    const ping = () => {
      try {
        port?.postMessage({
          type: "DELETE_BATCH_PING",
          jobId,
          at: Date.now(),
        });
      } catch {
        // onDisconnect handles cancellation and refund.
      }
    };

    ping();
    heartbeat = setInterval(ping, 10000);
  }

  function extensionRequest(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "확장 프로그램 요청에 실패했습니다."));
          return;
        }
        resolve(response);
      });
    });
  }

  async function cancelActive(reason) {
    if (!activeJobId) return;
    try {
      const response = await extensionRequest({
        type: "CANCEL_DELETE_BATCH_JOB",
        jobId: activeJobId,
        reason,
        config,
      });
      setBalance(response.result?.balance);
    } catch {
      // The stale-job timeout remains the final refund safety net.
    }
  }

  function rowLabel(activityId) {
    const row = document.querySelector(`.delete-activity-row[data-activity-id="${CSS.escape(String(activityId))}"]`);
    const title = row?.querySelector("h3")?.textContent?.trim();
    const content = row?.querySelector("p")?.textContent?.trim();
    return {
      row,
      label: title || content || `기록 ${activityId}`,
    };
  }

  function refreshVisibleCounters() {
    const selectedNode = document.getElementById("selected-count");
    const visibleNode = document.getElementById("visible-count");
    if (selectedNode) selectedNode.textContent = String(selectedChecks().length);
    if (visibleNode) {
      const visibleRows = [...document.querySelectorAll(".delete-activity-row")]
        .filter((row) => row.isConnected && !row.hidden);
      visibleNode.textContent = String(visibleRows.length);
    }
  }

  async function startAutomaticRetry(activityIds) {
    setRunning(true, `검증 실패 ${activityIds.length}건 자동 재시도`);
    setStatus(
      `Google이 빠른 연속 삭제 중 일부 클릭을 반영하지 않았습니다.\n${activityIds.length}건을 잠시 기다린 뒤 한 번 자동 재시도합니다.`,
      "running"
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));

    try {
      const response = await extensionRequest({
        type: "CREATE_DELETE_BATCH_JOB",
        activityIds,
        config,
      });
      const job = response.job;
      activeJobId = job.job_id;
      setBalance(job.balance);
      startPort(job);
    } catch (error) {
      running = false;
      activeJobId = null;
      button.disabled = false;
      button.textContent = `실패 ${selectedChecks().length}건 다시 삭제`;
      setStatus(`자동 재시도 작업 생성 실패: ${error.message || String(error)}`, "error");
    }
  }

  function finish(result) {
    stopHeartbeat();
    const server = result?.server || null;
    const failedDetails = [];
    const outcomeByItem = new Map(
      (result?.outcomes || []).map((outcome) => [Number(outcome.item_id), outcome])
    );
    const retryActivityIds = [];

    if (server) {
      setBalance(server.balance);
      overallSuccess += Number(server.successful_count || 0);
      for (const item of server.items || []) {
        const {row, label} = rowLabel(item.activity_id);
        if (item.status === "success") {
          row?.remove();
          continue;
        }
        const outcome = outcomeByItem.get(Number(item.item_id));
        const stage = String(outcome?.diagnostics?.stage || "");
        if (!automaticRetryUsed && stage === "verification_present") {
          retryActivityIds.push(Number(item.activity_id));
        }
        failedDetails.push({
          label,
          reason: item.reason || "삭제 대상 확인 또는 삭제 검증에 실패했습니다.",
        });
      }
    }

    running = false;
    activeJobId = null;
    try { port?.disconnect(); } catch {}
    port = null;
    refreshVisibleCounters();

    if (server && retryActivityIds.length && !automaticRetryUsed) {
      automaticRetryUsed = true;
      void startAutomaticRetry(retryActivityIds);
      return;
    }

    const attemptFailed = Number(server?.failed_count ?? result?.failedCount ?? 0);
    const finalFailed = Math.max(0, overallTotal - overallSuccess);
    if (server) {
      const lines = [
        automaticRetryUsed
          ? `배치 삭제와 자동 재시도가 끝났습니다. 전체 성공 ${overallSuccess}건, 실패 ${finalFailed}건.`
          : `배치 삭제가 끝났습니다. 성공 ${overallSuccess}건, 실패 ${finalFailed}건.`
      ];
      if (attemptFailed > 0 && failedDetails.length) {
        lines.push("", "실패 사유:");
        for (const detail of failedDetails.slice(0, 10)) {
          lines.push(`- ${detail.label}: ${detail.reason}`);
        }
        if (failedDetails.length > 10) {
          lines.push(`- 외 ${failedDetails.length - 10}건`);
        }
        lines.push("", "실패한 항목은 선택된 상태로 남아 있습니다.");
      }
      setStatus(lines.join("\n"), finalFailed ? (overallSuccess ? "running" : "error") : "success");
    } else {
      setStatus(result?.error || "배치 삭제 결과를 확인하지 못했습니다.", "error");
    }

    const remaining = selectedChecks().length;
    button.disabled = remaining < 1;
    button.textContent = remaining > 0 ? `실패 ${remaining}건 다시 삭제` : "선택한 기록 삭제";
  }

  function startPort(job) {
    port = chrome.runtime.connect({name: PORT_NAME});
    let completed = false;

    port.onMessage.addListener((message) => {
      if (message?.type === "DELETE_BATCH_PONG") {
        lastPongAt = Date.now();
        return;
      }
      if (message?.type === "DELETE_BATCH_ACCEPTED") {
        setStatus(`선택한 ${job.items.length}건을 Google 내 활동 페이지별로 한 번씩 검색합니다.`, "running");
        return;
      }
      if (message?.type === "DELETE_BATCH_PROGRESS") {
        setRunning(true, `삭제 처리 중 ${message.processed}/${message.total}`);
        setStatus(message.message || `${message.processed}/${message.total} 처리 중`, "running");
        return;
      }
      if (message?.type !== "DELETE_BATCH_RESULT") return;
      completed = true;
      finish(message.result || {ok: false, error: "삭제 응답이 없습니다."});
    });

    port.onDisconnect.addListener(async () => {
      stopHeartbeat();
      if (completed || !running) return;
      const elapsed = lastPongAt ? Math.round((Date.now() - lastPongAt) / 1000) : null;
      const reason = chrome.runtime.lastError?.message
        || `확장 프로그램의 배치 삭제 연결이 중간에 종료되었습니다.${elapsed !== null ? ` 마지막 응답 ${elapsed}초 전.` : ""}`;
      await cancelActive(reason);
      running = false;
      activeJobId = null;
      button.disabled = false;
      button.textContent = "선택한 기록 삭제";
      setStatus(reason, "error");
    });

    startHeartbeat(job.job_id);
    port.postMessage({
      type: "START_DELETE_BATCH",
      job,
      config,
    });
  }

  document.addEventListener("click", async (event) => {
    const target = event.target instanceof Element ? event.target.closest("#selected-delete-button") : null;
    if (!target) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (running) return;

    const chosen = selectedChecks();
    if (!chosen.length) {
      setStatus("삭제할 기록을 하나 이상 선택하세요.", "error");
      return;
    }
    if (chosen.length > 100) {
      setStatus("한 번에 최대 100개까지 삭제할 수 있습니다.", "error");
      return;
    }

    const confirmed = confirm(
      `선택한 YouTube 기록 ${chosen.length}개를 실제로 삭제합니다.\n\n`
      + "Google 내 활동 페이지를 종류별로 한 번만 검색하며, 성공한 건만 삭제권이 사용됩니다. 계속하시겠습니까?"
    );
    if (!confirmed) return;

    automaticRetryUsed = false;
    overallTotal = chosen.length;
    overallSuccess = 0;
    setRunning(true, `삭제 준비 중 0/${chosen.length}`);
    setStatus(`삭제권 ${chosen.length}개를 임시 예약하고 배치 작업을 생성합니다.`, "running");

    try {
      const response = await extensionRequest({
        type: "CREATE_DELETE_BATCH_JOB",
        activityIds: chosen.map((check) => Number(check.value)),
        config,
      });
      const job = response.job;
      activeJobId = job.job_id;
      setBalance(job.balance);
      startPort(job);
    } catch (error) {
      stopHeartbeat();
      running = false;
      activeJobId = null;
      button.disabled = false;
      button.textContent = "선택한 기록 삭제";
      setStatus(error.message || String(error), "error");
    }
  }, true);
})();
