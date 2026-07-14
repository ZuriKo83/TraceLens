(() => {
  const originalExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);

  chrome.scripting.executeScript = function(details, callback) {
    const isBatchDelete = details?.func?.name === "deleteYouTubeBatchOnPage"
      && Array.isArray(details?.args?.[0]);

    const operation = originalExecuteScript(details).then(async (result) => {
      if (!isBatchDelete) return result;

      const outcomes = result?.[0]?.result?.outcomes;
      if (!Array.isArray(outcomes)) return result;

      const failedIds = new Set(
        outcomes
          .filter((outcome) => !outcome?.ok && outcome?.diagnostics?.stage === "verification")
          .map((outcome) => Number(outcome.item_id))
      );
      if (!failedIds.size) return result;

      const pageItems = details.args[0].filter((item) => failedIds.has(Number(item.item_id)));
      const expectedPage = details.args[1];
      if (!pageItems.length) return result;

      await new Promise((resolve) => setTimeout(resolve, 650));
      const verification = await originalExecuteScript({
        target: details.target,
        func: verifyBatchDeletionAbsence,
        args: [pageItems, expectedPage],
      });
      const verified = verification?.[0]?.result;
      if (!verified || !Array.isArray(verified.absent_item_ids)) return result;

      const absent = new Set(verified.absent_item_ids.map(Number));
      for (const outcome of outcomes) {
        if (!absent.has(Number(outcome.item_id))) continue;
        outcome.ok = true;
        outcome.reason = null;
        outcome.diagnostics = {
          ...(outcome.diagnostics || {}),
          stage: "verified_absent_rescan",
          original_stage: "verification",
          expected_page: expectedPage,
          verification_steps: verified.steps,
          verification_end_reached: verified.end_reached,
        };
      }
      return result;
    });

    if (typeof callback === "function") {
      operation.then((value) => callback(value)).catch(() => callback(undefined));
      return undefined;
    }
    return operation;
  };

  async function verifyBatchDeletionAbsence(items, expectedPage) {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const fnv = (value) => {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    };
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const decodeValues = (raw) => {
      const queue = [String(raw || "")];
      const output = [];
      const seen = new Set();
      while (queue.length && output.length < 36) {
        const current = queue.shift();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        output.push(current);
        const unescaped = current
          .replace(/\\u003d/gi, "=").replace(/\\u0026/gi, "&")
          .replace(/\\u003f/gi, "?").replace(/\\u002f/gi, "/")
          .replace(/\\x3d/gi, "=").replace(/\\x26/gi, "&")
          .replace(/\\x2f/gi, "/").replace(/\\\//g, "/");
        if (!seen.has(unescaped)) queue.push(unescaped);
        try {
          const decoded = decodeURIComponent(unescaped);
          if (!seen.has(decoded)) queue.push(decoded);
        } catch {
          // Google attributes can contain incomplete percent encoding.
        }
      }
      return output;
    };
    const sourceKeys = (raw) => {
      const keys = new Set();
      for (const value of decodeValues(raw)) {
        for (const match of value.matchAll(/(?:youtube\.com)?\/post\/([A-Za-z0-9_-]{10,160})/gi)) keys.add(`post:${match[1]}`);
        for (const match of value.matchAll(/[?&]v=([A-Za-z0-9_-]{6,20})/gi)) keys.add(`video:${match[1]}`);
        for (const match of value.matchAll(/\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{6,20})/gi)) keys.add(`video:${match[1]}`);
        for (const match of value.matchAll(/youtu\.be\/([A-Za-z0-9_-]{6,20})/gi)) keys.add(`video:${match[1]}`);
      }
      return keys;
    };

    const actualPage = new URL(location.href).searchParams.get("page");
    if (location.hostname !== "myactivity.google.com" || actualPage !== expectedPage) {
      return {absent_item_ids: [], present_item_ids: [], steps: 0, end_reached: false};
    }

    const targets = items.map((item) => {
      const locator = item?.locator && typeof item.locator === "object" ? item.locator : {};
      const content = clean(locator.content || item.content || "");
      const sourceType = clean(locator.source_type || "").toLowerCase();
      const sourceId = clean(locator.source_id || "");
      return {
        itemId: Number(item.item_id),
        contentNeedle: content.length > 300 ? content.slice(0, 300) : content,
        sourceKey: sourceType && sourceId ? `${sourceType}:${sourceId}` : "",
        rowDataId: String(locator.row_data_id || ""),
        rowJsdata: String(locator.row_jsdata || ""),
        rowVed: String(locator.row_data_ved || ""),
        rowHash: String(locator.row_text_hash || ""),
      };
    });
    const present = new Set();

    const deleteButtons = () => [...document.querySelectorAll("button,[role='button']")].filter((button) => {
      if (!visible(button)) return false;
      const label = clean(`${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`);
      const text = clean(button.innerText || button.textContent);
      return /삭제|delete|remove|활동 삭제/i.test(label) || ["×", "✕", "X"].includes(text);
    });
    const rowForButton = (button) => {
      const direct = button.closest("[role='listitem'],article,li,div[data-id]");
      if (direct) return direct;
      let node = button.parentElement;
      for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
        const text = clean(node.innerText || node.textContent);
        if (text.length >= 3 && text.length <= 12000 && /YouTube/i.test(text)) return node;
      }
      return null;
    };
    const descriptor = (row) => {
      const text = clean(row.innerText || row.textContent);
      return {
        text,
        hash: fnv(text),
        dataId: String(row.getAttribute("data-id") || ""),
        jsdata: String(row.getAttribute("jsdata") || ""),
        ved: String(row.getAttribute("data-ved") || ""),
        sources: sourceKeys(`${row.outerHTML || ""} ${[...row.querySelectorAll("a[href]")].map((anchor) => anchor.href).join(" ")}`),
      };
    };
    const stableMatch = (target, desc) => Boolean(
      (target.rowDataId && target.rowDataId === desc.dataId)
      || (target.rowJsdata && target.rowJsdata === desc.jsdata)
      || (target.rowVed && target.rowVed === desc.ved)
      || (target.rowHash && target.rowHash === desc.hash)
    );
    const matchesTarget = (target, desc) => {
      if (!target.contentNeedle || !desc.text.includes(target.contentNeedle)) return false;
      if (target.sourceKey) return desc.sources.has(target.sourceKey);
      return stableMatch(target, desc);
    };
    const scanCurrent = () => {
      for (const button of deleteButtons()) {
        const row = rowForButton(button);
        if (!row) continue;
        const desc = descriptor(row);
        for (const target of targets) {
          if (!present.has(target.itemId) && matchesTarget(target, desc)) present.add(target.itemId);
        }
      }
    };

    const scrollers = () => {
      const doc = document.scrollingElement || document.documentElement;
      const candidates = [doc, document.documentElement, document.body, ...document.querySelectorAll("main,c-wiz,section,div")]
        .filter(Boolean)
        .filter((node, index, all) => all.indexOf(node) === index)
        .filter((node) => node === doc || node.scrollHeight > node.clientHeight + 40)
        .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight));
      return candidates.slice(0, 8);
    };
    const resetScroll = () => {
      const doc = document.scrollingElement || document.documentElement;
      window.scrollTo(0, 0);
      doc.scrollTop = 0;
      for (const node of scrollers()) node.scrollTop = 0;
    };
    const moveDown = () => {
      let moved = false;
      for (const node of scrollers()) {
        const before = node.scrollTop || 0;
        const bottom = Math.max(0, node.scrollHeight - node.clientHeight);
        const amount = Math.max(360, Math.floor((node.clientHeight || innerHeight) * 0.72));
        node.scrollTop = Math.min(bottom, before + amount);
        node.dispatchEvent(new Event("scroll", {bubbles: true}));
        if ((node.scrollTop || 0) !== before) moved = true;
      }
      const doc = document.scrollingElement || document.documentElement;
      window.scrollTo(0, doc.scrollTop || 0);
      return moved;
    };
    const signature = () => scrollers()
      .map((node) => `${Math.round(node.scrollTop || 0)}:${Math.round(node.scrollHeight || 0)}`)
      .join("|");

    resetScroll();
    await wait(500);
    let steps = 0;
    let stable = 0;
    let previousSignature = "";
    let endSeen = 0;
    let endReached = false;

    for (let step = 0; step < 700; step += 1) {
      steps = step + 1;
      scanCurrent();
      if (present.size === targets.length) break;

      const pageText = clean(document.body?.innerText || "");
      endReached = /더 이상 표시할 콘텐츠가 없습니다|no more content/i.test(pageText);
      endSeen = endReached ? endSeen + 1 : 0;
      if (endSeen >= 2) break;

      const moved = moveDown();
      await wait(moved ? 300 : 700);
      const nextSignature = signature();
      stable = nextSignature === previousSignature ? stable + 1 : 0;
      previousSignature = nextSignature;
      if (!moved && stable >= 10) break;
    }

    scanCurrent();
    resetScroll();
    return {
      absent_item_ids: targets.filter((target) => !present.has(target.itemId)).map((target) => target.itemId),
      present_item_ids: [...present],
      steps,
      end_reached: endReached,
    };
  }
})();
