(() => {
  if (location.pathname !== "/app") return;

  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const scopeOrder = new Map([
    ["게시글", 0],
    ["댓글", 1],
    ["답글", 1],
    ["질문", 2],
    ["답변", 3],
    ["실시간 채팅", 4],
    ["전체", 9],
  ]);

  function platformKey(group) {
    const badge = group.querySelector(".scan-group-identity .badge");
    const platformClass = [...(badge?.classList || [])].find((name) => name.startsWith("platform-"));
    return platformClass ? platformClass.slice("platform-".length) : clean(badge?.textContent);
  }

  function scopeKey(element) {
    return clean(element.querySelector("b")?.textContent);
  }

  function accountLabel(group) {
    return clean(group.querySelector("summary .account-badge")?.textContent);
  }

  function statusKind(status) {
    if (status?.classList.contains("status-success")) return "success";
    if (status?.classList.contains("status-partial")) return "partial";
    if (status?.classList.contains("status-error")) return "error";
    if (status?.classList.contains("status-login_required")) return "login_required";
    return "partial";
  }

  function annotateRows(group) {
    const account = accountLabel(group);
    group.querySelectorAll(".scan-scope-row").forEach((row) => {
      row.dataset.accountLabel = account;
    });
  }

  function updateAccountBadge(group) {
    const labels = new Set(
      [...group.querySelectorAll(".scan-scope-row")]
        .map((row) => row.dataset.accountLabel || "")
        .filter(Boolean)
    );
    const identity = group.querySelector(".scan-group-identity");
    let badge = identity?.querySelector(".account-badge");
    if (!labels.size) {
      badge?.remove();
      return;
    }
    if (!badge && identity) {
      badge = document.createElement("span");
      badge.className = "account-badge";
      identity.querySelector(".scan-status")?.before(badge);
    }
    if (badge) badge.textContent = labels.size === 1 ? [...labels][0] : "여러 계정";
  }

  function updateStatus(group) {
    const kinds = [...group.querySelectorAll(".scan-scope-row .scan-status")].map(statusKind);
    let result = "partial";
    if (kinds.length && kinds.every((value) => value === "success")) result = "success";
    else if (kinds.includes("success") || kinds.includes("partial")) result = "partial";
    else if (kinds.includes("error")) result = "error";
    else if (kinds.includes("login_required")) result = "login_required";

    const summary = group.querySelector("summary .scan-status");
    if (!summary) return;
    summary.className = `scan-status status-${result}`;
    summary.textContent = result === "success" ? "완료" : result === "partial" ? "일부 확인" : "확인 필요";
  }

  function sortScopes(group) {
    const details = group.querySelector(".scan-group-details");
    const counts = group.querySelector(".scan-group-counts");
    const sorter = (left, right) => (scopeOrder.get(scopeKey(left)) ?? 99) - (scopeOrder.get(scopeKey(right)) ?? 99);
    [...(details?.children || [])].sort(sorter).forEach((row) => details.appendChild(row));
    [...(counts?.children || [])].sort(sorter).forEach((item) => counts.appendChild(item));
  }

  function mergeRecentScans() {
    const list = document.querySelector(".scan-group-list");
    if (!list || list.dataset.platformMerged === "1") return;
    list.dataset.platformMerged = "1";

    const latestByPlatform = new Map();
    const groups = [...list.querySelectorAll(":scope > .scan-group")];
    groups.forEach(annotateRows);

    for (const group of groups) {
      const platform = platformKey(group);
      if (!platform) continue;
      const primary = latestByPlatform.get(platform);
      if (!primary) {
        latestByPlatform.set(platform, group);
        continue;
      }

      const details = primary.querySelector(".scan-group-details");
      const counts = primary.querySelector(".scan-group-counts");
      const existingScopes = new Set([...primary.querySelectorAll(".scan-scope-row")].map(scopeKey));
      const sourceCounts = new Map([...group.querySelectorAll(".scan-group-counts > span")].map((item) => [scopeKey(item), item]));

      for (const row of group.querySelectorAll(".scan-scope-row")) {
        const scope = scopeKey(row);
        if (!scope || existingScopes.has(scope)) continue;
        existingScopes.add(scope);
        details?.appendChild(row);
        const count = sourceCounts.get(scope);
        if (count) counts?.appendChild(count);
      }
      group.remove();
    }

    for (const group of latestByPlatform.values()) {
      sortScopes(group);
      updateAccountBadge(group);
      updateStatus(group);
    }
  }

  mergeRecentScans();
})();
