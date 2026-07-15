(() => {
  const previousExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);

  chrome.scripting.executeScript = async function(details, callback) {
    if (details?.func?.name !== "scanThenDeleteV16") {
      const results = await previousExecuteScript(details);
      if (typeof callback === "function") callback(results);
      return results;
    }

    const results = await previousExecuteScript(details);
    const result = results?.[0]?.result;
    if (!result?.ok) {
      if (typeof callback === "function") callback(results);
      return results;
    }

    const clicked = new Set((result.clicked_item_ids || []).map(Number));
    const evidence = {...(result.evidence_by_item || {})};
    const remainingFailures = [];

    for (const failure of result.failures || []) {
      const stage = String(failure?.diagnostics?.stage || "");
      const itemId = Number(failure?.item_id);

      // A missing toast/DOM signal is not proof that deletion failed. Google
      // often applies the delete asynchronously after the confirm button closes.
      // Treat it as an attempted deletion and let the existing complete reload +
      // full-list count verification decide success or failure.
      if (stage === "click_unconfirmed" && Number.isFinite(itemId) && itemId > 0) {
        clicked.add(itemId);
        evidence[String(itemId)] = failure?.diagnostics?.confirm_clicked
          ? "confirm_clicked_pending_full_verification"
          : "delete_clicked_pending_full_verification";
        continue;
      }

      remainingFailures.push(failure);
    }

    const patched = {
      ...result,
      clicked_item_ids: [...clicked],
      evidence_by_item: evidence,
      failures: remainingFailures,
      final_verification_required: true,
    };
    const patchedResults = [{...results[0], result: patched}, ...results.slice(1)];

    if (typeof callback === "function") callback(patchedResults);
    return patchedResults;
  };
})();
