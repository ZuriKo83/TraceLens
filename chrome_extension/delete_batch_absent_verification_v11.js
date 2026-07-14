(() => {
  const originalExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);

  chrome.scripting.executeScript = async function(details, callback) {
    const results = await originalExecuteScript(details);
    if (details?.func?.name !== "clickBatchHiddenV8") {
      if (typeof callback === "function") callback(results);
      return results;
    }

    const first = results?.[0]?.result;
    if (!first?.ok || !Array.isArray(first.failures)) {
      if (typeof callback === "function") callback(results);
      return results;
    }

    const verificationOnlyIds = new Set(
      first.failures
        .filter((failure) => String(failure?.diagnostics?.stage || "") === "not_found")
        .map((failure) => Number(failure.item_id))
        .filter((itemId) => Number.isFinite(itemId) && itemId > 0)
    );

    if (!verificationOnlyIds.size) {
      if (typeof callback === "function") callback(results);
      return results;
    }

    // A selected TraceLens record may already have been deleted by an earlier
    // attempt even though that attempt lost its verification result. Send those
    // not-found items through the existing reload + complete recollection path.
    // They are only resolved when the complete recollection also confirms that
    // the exact record is absent.
    const patched = {
      ...first,
      applied_item_ids: [...new Set([
        ...(first.applied_item_ids || []).map(Number),
        ...verificationOnlyIds,
      ])],
      failures: first.failures.filter(
        (failure) => !verificationOnlyIds.has(Number(failure.item_id))
      ),
      evidence_by_item: {
        ...(first.evidence_by_item || {}),
        ...Object.fromEntries(
          [...verificationOnlyIds].map((itemId) => [String(itemId), "verification_only_not_found"])
        ),
      },
      verification_only_count: verificationOnlyIds.size,
    };

    const patchedResults = [{...results[0], result: patched}, ...results.slice(1)];
    if (typeof callback === "function") callback(patchedResults);
    return patchedResults;
  };
})();
