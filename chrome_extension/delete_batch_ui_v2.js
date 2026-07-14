(() => {
  const token = document.querySelector('meta[name="tracelens-extension-token"]')?.content?.trim();
  const serverUrl = (document.querySelector('meta[name="tracelens-server-url"]')?.content?.trim() || location.origin).replace(/\/+$/, "");
  if (!token) return;

  const PORT_NAME = "tracelens-delete-batch-v2";
  const config = {serverUrl, collectorToken: token};
  const button = document.getElementById("selected-delete-button");
  const statusBox = document.getElementById("delete-status");
  const balanceNode = document.getElementById("delete-credit-balance");
  const selectionBalanceNode = document.getElementById("selection-balance");
  if (!button || !statusBox) return;

  let running = false;
  let activeJobId = null;
  let port = null;

  const selectedChecks = () => [...document.querySelectorAll(".delete-activity-checkbox")]
    .filter((check) => check instanceof HTMLInputElement && check.checked && !check.disabled && check.isConnected);

  function setStatus(message, kind = "running") {
    statusBox.textContent = message;
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

  function finish(result) {
    const server = result?.server || null;
    if (server) {
      setBalance(server.balance);
      for (const item of server.items || []) {
        if (item.status !== "success") continue;
        document.querySelector(`.delete-activity-row[data-activity-id="${CSS.escape(String(item.activity_id))}"]`)?.remove();
      }
    }

    const success = Number(server?.successful_count ?? result?.successfulCount ?? 0);
    const failed = Number(server?.failed_count ?? result?.failedCount ?? 0);
    if (server) {
      setStatus(`배치 삭제가 끝났습니다. 성공 ${success}건, 실패 ${failed}건.`, failed ? (success ? "running" : "error") : "success");
    } else {
      setStatus(result?.error || "배치 삭제 결과를 확인하지 못했습니다.", "error");
    }

    running = false;
    activeJobId = null;
    button.disabled = false;
    button.textContent = "선택한 기록 삭제";
    try { port?.disconnect(); } catch {}
    port = null;
    setTimeout(() => location.reload(), 2200);
  }

  function startPort(job) {
    port = chrome.runtime.connect({name: PORT_NAME});
    let completed = false;

    port.onMessage.addListener((message) => {
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
      if (completed || !running) return;
      const reason = chrome.runtime.lastError?.message || "확장 프로그램의 배치 삭제 연결이 중간에 종료되었습니다.";
      await cancelActive(reason);
      running = false;
      activeJobId = null;
      button.disabled = false;
      button.textContent = "선택한 기록 삭제";
      setStatus(reason, "error");
    });

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
      running = false;
      activeJobId = null;
      button.disabled = false;
      button.textContent = "선택한 기록 삭제";
      setStatus(error.message || String(error), "error");
    }
  }, true);
})();
