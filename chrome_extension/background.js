const SITE_TASKS = {
  youtube: [
    {platform: "youtube", label: "YouTube 댓글", activityType: "comment", url: "https://myactivity.google.com/page?hl=ko&utm_medium=web&utm_source=youtube&page=youtube_comments"}
  ],
  threads: [
    {platform: "threads", label: "Threads 내 게시글", activityType: "post", url: "https://www.threads.com/", ownershipScope: "self_activity", resolver: "threads_posts"},
    {platform: "threads", label: "Threads 내 답글", activityType: "comment", url: "https://www.threads.com/", ownershipScope: "self_activity", resolver: "threads_replies"}
  ],
  instagram: [
    {platform: "instagram", label: "Instagram 내 댓글", activityType: "comment", url: "https://www.instagram.com/your_activity/interactions/comments/", ownershipScope: "self_activity", resolver: "instagram_comments"}
  ],
  facebook: [
    {platform: "facebook", label: "Facebook 내가 쓴 게시글", activityType: "post", url: "https://www.facebook.com/me/allactivity/?category_key=YOURPOSTS", ownershipScope: "self_activity", resolver: "facebook_posts"},
    {platform: "facebook", label: "Facebook 내가 쓴 댓글", activityType: "comment", url: "https://www.facebook.com/me/allactivity/?activity_history=false&category_key=COMMENTSCLUSTER&manage_mode=false&should_load_landing_page=false", ownershipScope: "self_activity", resolver: "facebook_comments"}
  ],
  x: [
    {platform: "x", label: "X 게시글·답글", activityType: "post", url: "https://x.com/home", ownershipScope: "self_profile", resolver: "x_profile"}
  ],
  naver_blog: [
    {platform: "naver_blog", label: "네이버 블로그 게시글", activityType: "post", url: "https://blog.naver.com/MyBlog.naver", resolver: "naver_blog_posts"}
  ],
  naver_kin: [
    {platform: "naver_kin", label: "네이버 지식iN 질문", activityType: "question", url: "https://kin.naver.com/myinfo/index.naver", ownershipScope: "self_profile", resolver: "naver_kin_questions"},
    {platform: "naver_kin", label: "네이버 지식iN 답변", activityType: "answer", url: "https://kin.naver.com/myinfo/index.naver", ownershipScope: "self_profile", resolver: "naver_kin_answers"}
  ]
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "WEB_CONNECT") {
    const config = message.config || {};
    if (!config.serverUrl || !config.collectorToken) {
      sendResponse({ok: false, error: "연결 정보가 없습니다."});
      return false;
    }
    chrome.storage.local.set({
      serverUrl: normalizeServer(config.serverUrl),
      collectorToken: config.collectorToken,
      userEmail: config.userEmail || ""
    }).then(() => sendResponse({ok: true, userEmail: config.userEmail || ""}));
    return true;
  }

  if (message?.type === "SCAN_SITES") {
    resolveCollectorConfig(message.config).then((config) => scanSites(message.sites, config))
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ok: false, error: error.message}));
    return true;
  }

  if (message?.type === "CAPTURE_CURRENT") {
    captureCurrent(message.tabId, message.config)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ok: false, error: error.message}));
    return true;
  }

  return false;
});


async function resolveCollectorConfig(explicitConfig) {
  if (explicitConfig?.serverUrl && explicitConfig?.collectorToken) {
    return {
      serverUrl: normalizeServer(explicitConfig.serverUrl),
      collectorToken: explicitConfig.collectorToken,
      userEmail: explicitConfig.userEmail || ""
    };
  }
  const stored = await chrome.storage.local.get(["serverUrl", "collectorToken", "userEmail"]);
  if (!stored.serverUrl || !stored.collectorToken) {
    throw new Error("TraceLens 웹사이트에 로그인한 뒤 대시보드를 다시 여세요.");
  }
  return {
    serverUrl: normalizeServer(stored.serverUrl),
    collectorToken: stored.collectorToken,
    userEmail: stored.userEmail || ""
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPageSettled(tabId, timeoutMs = 12000) {
  const started = Date.now();
  let lastSignature = "";
  let stableCount = 0;
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("조회 탭을 찾을 수 없습니다.");
    if (tab.status !== "complete") {
      await sleep(350);
      continue;
    }
    const result = await chrome.scripting.executeScript({
      target: {tabId},
      func: () => ({
        ready: document.readyState,
        length: document.body?.innerText?.length || 0,
        url: location.href,
      }),
    }).catch(() => []);
    const state = result?.[0]?.result || {};
    const signature = `${state.ready}|${state.length}|${state.url}`;
    if (state.ready === "complete" && state.length > 80 && signature === lastSignature) stableCount += 1;
    else stableCount = 0;
    if (stableCount >= 2) return;
    lastSignature = signature;
    await sleep(600);
  }
}

function waitForTabComplete(tabId, timeoutMs = 35000) {
  return new Promise(async (resolve, reject) => {
    const existing = await chrome.tabs.get(tabId).catch(() => null);
    if (!existing) return reject(new Error("조회 탭을 찾을 수 없습니다."));
    if (existing.status === "complete") return resolve(existing);

    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("페이지 로딩 시간이 초과되었습니다."));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function scanSites(sites, config) {
  const tasks = sites.flatMap((site) => SITE_TASKS[site] || []);
  const lines = [];

  for (const task of tasks) {
    let tab;
    let resolved = null;
    try {
      const needsVisibleTab = ["instagram", "facebook", "threads", "x"].includes(task.platform);
      tab = await chrome.tabs.create({url: task.url, active: needsVisibleTab});
      await waitForTabComplete(tab.id);
      await waitForPageSettled(tab.id);
      resolved = task.resolver ? await resolveTaskTarget(tab.id, task.resolver) : null;
      await waitForPageSettled(tab.id);
      await assertOwnedTaskUrl(tab.id, task);
      const extraction = await runExtractor(
        tab.id,
        task.platform,
        task.activityType,
        task.ownershipScope || "self_activity",
        resolved || null
      );
      const response = await postExtraction(config, extraction);
      const account = resolved?.accountLabel ? ` (${resolved.accountLabel})` : "";
      lines.push(`✓ ${task.label}${account}: ${response.found}개 확인, ${response.imported}개 신규`);
    } catch (error) {
      lines.push(`✕ ${task.label}: ${error.message}`);
      const account = resolved?.accountLabel ? `${resolved.accountLabel}: ` : "";
      await postScanFailure(config, task, `${account}${error.message}`, resolved?.accountLabel || null).catch(() => undefined);
    } finally {
      if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => undefined);
    }
  }

  return {ok: true, lines, completed: tasks.length};
}

async function assertOwnedTaskUrl(tabId, task) {
  const tab = await chrome.tabs.get(tabId);
  const current = new URL(tab.url || "about:blank");
  const host = current.hostname.toLowerCase();
  const path = current.pathname;
  const query = decodeURIComponent(current.searchParams.get("q") || "").toLowerCase();
  const pageState = await chrome.scripting.executeScript({
    target: {tabId},
    func: () => ({
      hasPassword: Boolean(document.querySelector("input[type='password']")),
      text: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 1800),
    }),
  }).catch(() => []);
  const auth = pageState?.[0]?.result || {};
  const loginPath = /(login|signin|checkpoint|challenge|authwall)/i.test(`${host}${path}`);
  const loginText = /(로그인|log in|sign in).{0,80}(비밀번호|password|계정|account)/i.test(auth.text || "");
  if (loginPath || auth.hasPassword || loginText) {
    throw new Error("현재 Chrome 프로필에서 이 사이트의 로그인 상태를 확인하지 못했습니다. 해당 사이트에 먼저 로그인한 뒤 다시 조회하세요.");
  }

  let valid = false;
  switch (task.platform) {
    case "youtube": {
      const youtubeHistory = host === "www.youtube.com" && path.replace(/\/$/, "") === "/feed/history/comment_history";
      const myActivityComments = host === "myactivity.google.com"
        && path.replace(/\/$/, "") === "/page"
        && current.searchParams.get("page") === "youtube_comments";
      valid = youtubeHistory || myActivityComments;
      break;
    }
    case "instagram":
      valid = host === "www.instagram.com" && /^\/your_activity\/interactions\/comments\/?$/.test(path);
      break;
    case "facebook": {
      const activityPath = /\/(allactivity|activitylog|your_activity)\/?/i.test(path)
        || current.searchParams.has("category_key")
        || current.searchParams.get("tab") === "activity_log";
      valid = host === "www.facebook.com" && activityPath;
      break;
    }
    case "threads":
      valid = (host === "www.threads.com" || host === "threads.com")
        && /^\/@[A-Za-z0-9._]+(?:\/replies)?\/?$/.test(path);
      break;
    case "x":
      valid = (host === "x.com" || host === "twitter.com") && /^\/[A-Za-z0-9_]+\/?$/.test(path);
      break;
    case "naver_blog":
      valid = host === "blog.naver.com" && path.toLowerCase().includes("postlist.naver");
      break;
    case "naver_kin":
      valid = host === "kin.naver.com" && (/^\/(myinfo|userinfo)\//i.test(path) || /profile/i.test(path));
      break;
    default:
      valid = false;
  }

  if (!valid) {
    throw new Error(`본인 활동 페이지 확인에 실패했습니다. 이동된 주소: ${current.href}`);
  }
}

async function resolveTaskTarget(tabId, resolver) {
  if (resolver === "instagram_comments") {
    const results = await chrome.scripting.executeScript({
      target: {tabId},
      func: () => {
        const reserved = new Set([
          "", "accounts", "direct", "explore", "reels", "your_activity", "settings",
          "about", "legal", "developer", "web", "privacy", "terms"
        ]);
        const normalizeUsername = (href) => {
          try {
            const parsed = new URL(href, location.href);
            const parts = parsed.pathname.split("/").filter(Boolean);
            const username = parts.length === 1 ? parts[0] : "";
            if (parsed.hostname !== "www.instagram.com") return null;
            if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) return null;
            if (reserved.has(username.toLowerCase())) return null;
            return username.toLowerCase();
          } catch {
            return null;
          }
        };

        // Only trust the signed-in account control in Instagram's persistent
        // navigation. Never infer the user from comment-list authors or post
        // owners, because those belong to other people.
        const candidates = [];
        for (const anchor of document.querySelectorAll("a[href]")) {
          const username = normalizeUsername(anchor.href);
          if (!username) continue;
          const rect = anchor.getBoundingClientRect();
          const label = `${anchor.getAttribute("aria-label") || ""} ${anchor.getAttribute("title") || ""} ${anchor.textContent || ""}`;
          const imageAlt = [...anchor.querySelectorAll("img[alt]")].map((img) => img.alt || "").join(" ");
          const inNavigation = Boolean(anchor.closest("nav, aside"));
          const onLeftRail = rect.left < Math.max(180, innerWidth * 0.18);
          const profileSignal = /(프로필|profile)/i.test(`${label} ${imageAlt}`);
          if (!inNavigation && !onLeftRail) continue;
          if (!profileSignal && !anchor.querySelector("img")) continue;
          let score = 0;
          if (profileSignal) score += 100;
          if (inNavigation) score += 70;
          if (onLeftRail) score += 45;
          if (anchor.querySelector("img")) score += 15;
          candidates.push({username, score});
        }
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0] || null;
        return {
          accountLabel: best ? `@${best.username}` : "Instagram 로그인 계정",
          instagramUsername: best?.username || null,
          instagramIdentityVerified: Boolean(best && best.score >= 100),
        };
      },
    });
    return results?.[0]?.result || {
      accountLabel: "Instagram 로그인 계정",
      instagramUsername: null,
      instagramIdentityVerified: false,
    };
  }

  if (resolver === "facebook_posts" || resolver === "facebook_comments") {
    const mode = resolver === "facebook_posts" ? "posts" : "comments";
    const identityResults = await chrome.scripting.executeScript({
      target: {tabId},
      func: () => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const reserved = new Set(["", "home.php", "watch", "marketplace", "gaming", "groups", "events", "friends", "settings", "login", "help", "notifications", "me", "allactivity", "activitylog"]);
        const parseIdentity = (href) => {
          try {
            const parsed = new URL(href, location.href);
            if (parsed.hostname !== "www.facebook.com" && parsed.hostname !== "facebook.com") return null;
            if (parsed.pathname === "/profile.php") {
              const id = parsed.searchParams.get("id");
              return id ? {kind: "id", value: id} : null;
            }
            const first = parsed.pathname.split("/").filter(Boolean)[0] || "";
            if (!first || reserved.has(first.toLowerCase())) return null;
            if (/^\d+$/.test(first)) return {kind: "id", value: first};
            if (/^[A-Za-z0-9.]+$/.test(first)) return {kind: "slug", value: first.toLowerCase()};
          } catch {}
          return null;
        };
        const current = new URL(location.href);
        const currentFirst = current.pathname.split("/").filter(Boolean)[0] || "";
        let currentIdentity = null;
        if (/^\d+$/.test(currentFirst)) currentIdentity = {kind: "id", value: currentFirst};
        else if (current.pathname === "/profile.php" && current.searchParams.get("id")) currentIdentity = {kind: "id", value: current.searchParams.get("id")};
        else if (currentFirst && !reserved.has(currentFirst.toLowerCase()) && /^[A-Za-z0-9.]+$/.test(currentFirst)) currentIdentity = {kind: "slug", value: currentFirst.toLowerCase()};

        const candidates = [...document.querySelectorAll("a[href]")]
          .map((anchor) => {
            const identity = parseIdentity(anchor.href);
            if (!identity) return null;
            const imageAlt = clean(anchor.querySelector("img[alt]")?.getAttribute("alt"));
            const aria = clean(anchor.getAttribute("aria-label"));
            const text = clean(anchor.textContent);
            const label = imageAlt || text || aria;
            const score = /(프로필|profile|계정|account)/i.test(`${aria} ${text}`) ? 2 : 0;
            return {identity, label: label && label.length <= 80 ? label : null, score};
          })
          .filter(Boolean)
          .sort((a, b) => b.score - a.score);
        const matched = currentIdentity
          ? candidates.find((candidate) => candidate.identity.kind === currentIdentity.kind && candidate.identity.value === currentIdentity.value)
          : null;
        const chosen = matched || candidates[0] || null;
        return {
          accountLabel: chosen?.label || "Facebook 로그인 계정",
          profileKind: currentIdentity?.kind || chosen?.identity?.kind || null,
          profileIdentity: currentIdentity?.value || chosen?.identity?.value || null,
        };
      },
    });
    const identity = identityResults?.[0]?.result || {};
    const accountLabel = identity.accountLabel || "Facebook 로그인 계정";
    const current = new URL((await chrome.tabs.get(tabId)).url);
    const firstSegment = current.pathname.split("/").filter(Boolean)[0] || "me";
    const resolvedProfileSegment = identity.profileIdentity && /^(?:\d+|[A-Za-z0-9.]+)$/.test(identity.profileIdentity)
      ? identity.profileIdentity
      : null;
    const profileSegment = resolvedProfileSegment
      || (/^(?:me|\d+|[A-Za-z0-9.]+)$/i.test(firstSegment) && firstSegment.toLowerCase() !== "profile.php" ? firstSegment : "me");
    current.pathname = `/${profileSegment}/allactivity/`;
    current.search = "";
    current.searchParams.set("activity_history", "false");
    current.searchParams.set("category_key", mode === "posts" ? "YOURPOSTS" : "COMMENTSCLUSTER");
    current.searchParams.set("manage_mode", "false");
    current.searchParams.set("should_load_landing_page", "false");
    await chrome.tabs.update(tabId, {url: current.href});
    await waitForTabComplete(tabId);
    await waitForPageSettled(tabId, 18000);
    return {
      accountLabel,
      facebookProfileKind: identity.profileKind || null,
      facebookProfileIdentity: identity.profileIdentity || null,
    };
  }

  if (resolver === "naver_kin_questions" || resolver === "naver_kin_answers") {
    const wanted = resolver === "naver_kin_questions" ? "question" : "answer";
    const results = await chrome.scripting.executeScript({
      target: {tabId, allFrames: true},
      func: (kind) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const labelPattern = kind === "question" ? /(나의?\s*질문|내\s*질문|질문\s*목록)/i : /(나의?\s*답변|내\s*답변|답변\s*목록)/i;
        const hrefPattern = kind === "question" ? /(question|qna|myinfo)/i : /(answer|qna|myinfo)/i;
        const anchors = [...document.querySelectorAll("a[href]")];
        const candidates = anchors
          .map((anchor) => {
            try {
              const url = new URL(anchor.href, location.href);
              if (url.hostname !== "kin.naver.com") return null;
              const label = clean(anchor.textContent || anchor.getAttribute("aria-label"));
              const score = (labelPattern.test(label) ? 4 : 0) + (hrefPattern.test(`${url.pathname}${url.search}`) ? 1 : 0);
              return score ? {url: url.href, score, label} : null;
            } catch { return null; }
          })
          .filter(Boolean)
          .sort((a, b) => b.score - a.score);
        const nicknameSelectors = [
          ".profile_name", ".nick", ".nickname", ".my_profile strong",
          "[class*='profile_name']", "[class*='nickname']"
        ];
        const nickname = nicknameSelectors
          .map((selector) => clean(document.querySelector(selector)?.textContent || ""))
          .find((value) => value && value.length <= 40 && !/(권장 브라우저|업데이트 안내|지식iN|NAVER)/i.test(value));
        return {targetUrl: candidates[0]?.url || location.href, accountLabel: nickname || "네이버 로그인 계정"};
      },
      args: [wanted],
    });
    const currentUrl = (await chrome.tabs.get(tabId)).url;
    const resolved = (results || [])
      .map((entry) => entry.result)
      .filter(Boolean)
      .sort((a, b) => Number(b.targetUrl !== currentUrl) - Number(a.targetUrl !== currentUrl))[0] || {};
    if (resolved.targetUrl && resolved.targetUrl !== currentUrl) {
      await chrome.tabs.update(tabId, {url: resolved.targetUrl});
      await waitForTabComplete(tabId);
      await waitForPageSettled(tabId);
    }
    return {accountLabel: resolved.accountLabel || "네이버 로그인 계정"};
  }

  if (resolver === "threads_posts" || resolver === "threads_replies") {
    const results = await chrome.scripting.executeScript({
      target: {tabId},
      func: () => {
        const reserved = new Set(["", "activity", "search", "settings", "login", "signup", "privacy", "terms"]);
        const candidates = [];
        for (const anchor of document.querySelectorAll("a[href]")) {
          try {
            const parsed = new URL(anchor.href, location.href);
            if (!['www.threads.com', 'threads.com'].includes(parsed.hostname)) continue;
            const match = parsed.pathname.match(/^\/@([A-Za-z0-9._]+)\/?$/);
            if (!match || reserved.has(match[1].toLowerCase())) continue;
            const label = `${anchor.getAttribute('aria-label') || ''} ${anchor.textContent || ''}`;
            let score = 0;
            if (/(프로필|profile)/i.test(label)) score += 80;
            if (anchor.closest('nav, aside')) score += 40;
            if (anchor.querySelector('img')) score += 15;
            candidates.push({username: match[1], score});
          } catch {}
        }
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0]?.username || null;
      }
    });
    const username = results?.[0]?.result;
    if (!username) throw new Error("로그인된 Threads 프로필 주소를 찾지 못했습니다.");
    const suffix = resolver === "threads_replies" ? "/replies" : "";
    const targetUrl = `https://www.threads.com/@${username}${suffix}`;
    await chrome.tabs.update(tabId, {url: targetUrl});
    await waitForTabComplete(tabId);
    await waitForPageSettled(tabId, 18000);
    return {accountLabel: `@${username}`, threadsUsername: username};
  }

  if (resolver === "x_profile") {
    const results = await chrome.scripting.executeScript({
      target: {tabId},
      func: () => {
        const direct = document.querySelector("a[data-testid='AppTabBar_Profile_Link']");
        if (direct?.href) return direct.href;
        const reserved = new Set(["home", "explore", "notifications", "messages", "i", "compose", "search", "settings"]);
        const fallback = [...document.querySelectorAll("nav a[href]")].find((item) => {
          const path = (item.getAttribute("href") || "").replace(/^\//, "").split("/")[0];
          return /^[A-Za-z0-9_]+$/.test(path) && !reserved.has(path.toLowerCase());
        });
        return fallback?.href || null;
      }
    });
    const profileUrl = results?.[0]?.result;
    if (!profileUrl) throw new Error("로그인된 X 프로필 주소를 찾지 못했습니다.");
    await chrome.tabs.update(tabId, {url: profileUrl});
    await waitForTabComplete(tabId);
    await sleep(1400);
    const handle = new URL(profileUrl).pathname.split("/").filter(Boolean)[0];
    return {accountLabel: handle ? `@${handle}` : "X 로그인 계정"};
  }

  if (resolver === "naver_blog_posts") {
    const results = await chrome.scripting.executeScript({
      target: {tabId, allFrames: true},
      func: () => {
        const found = new Set();
        const reserved = new Set([
          "myblog.naver", "postlist.naver", "postview.naver", "blogprofile.naver",
          "blog", "www", "section", "prologue"
        ]);
        const add = (value) => {
          const candidate = decodeURIComponent(String(value || "")).trim().replace(/^\/+|\/+$/g, "");
          if (/^[A-Za-z0-9_-]{2,50}$/.test(candidate) && !reserved.has(candidate.toLowerCase())) found.add(candidate);
        };
        try {
          const current = new URL(location.href);
          add(current.searchParams.get("blogId"));
          if (current.hostname === "blog.naver.com") add(current.pathname.split("/").filter(Boolean)[0]);
        } catch {}
        const ogUrl = document.querySelector("meta[property='og:url']")?.content;
        if (ogUrl) {
          try {
            const parsed = new URL(ogUrl, location.href);
            add(parsed.searchParams.get("blogId"));
            if (parsed.hostname === "blog.naver.com") add(parsed.pathname.split("/").filter(Boolean)[0]);
          } catch {}
        }
        for (const anchor of [...document.querySelectorAll("a[href]")].slice(0, 500)) {
          try {
            const parsed = new URL(anchor.getAttribute("href"), location.href);
            if (!parsed.hostname.endsWith("naver.com")) continue;
            add(parsed.searchParams.get("blogId"));
            if (parsed.hostname === "blog.naver.com") add(parsed.pathname.split("/").filter(Boolean)[0]);
          } catch {}
        }
        return [...found];
      }
    });
    const blogIds = (results || []).flatMap((entry) => entry.result || []);
    const blogId = blogIds.find(Boolean);
    if (!blogId) throw new Error("로그인된 네이버 블로그 ID를 찾지 못했습니다.");
    const postListUrl = `https://blog.naver.com/PostList.naver?blogId=${encodeURIComponent(blogId)}&from=postList&categoryNo=0`;
    await chrome.tabs.update(tabId, {url: postListUrl});
    await waitForTabComplete(tabId);
    await sleep(1800);
    return {accountLabel: blogId};
  }
  return null;
}

async function captureCurrent(tabId, config) {
  const tab = await chrome.tabs.get(tabId);
  const currentUrl = new URL(tab.url || "about:blank");
  const knownSocialHosts = new Set([
    "www.youtube.com", "myactivity.google.com", "www.threads.com", "threads.com",
    "www.instagram.com", "www.facebook.com", "x.com", "twitter.com",
    "blog.naver.com", "kin.naver.com"
  ]);
  if (knownSocialHosts.has(currentUrl.hostname)) {
    throw new Error("지원 사이트는 '선택 사이트 조회 시작'으로만 조회하세요. 본인 활동 전용 경로를 확인한 뒤 수집합니다.");
  }
  const extraction = await runExtractor(tabId, "generic", "post", "user_confirmed_list_page");
  const response = await postExtraction(config, extraction);
  return {ok: true, message: `${platformLabel(extraction.platform)}: 게시글·댓글 ${response.found}개 확인, ${response.imported}개 신규`};
}

function platformLabel(platform) {
  const labels = {
    youtube: "YouTube", threads: "Threads", instagram: "Instagram",
    facebook: "Facebook",
    x: "X", naver_blog: "네이버 블로그", naver_kin: "네이버 지식iN", naver: "네이버"
  };
  return labels[platform] || platform;
}

async function runExtractor(tabId, platform, activityType, ownershipScope = "self_activity", accountContext = null) {
  const results = await chrome.scripting.executeScript({
    target: {tabId, allFrames: true},
    func: extractPage,
    args: [platform, activityType, ownershipScope, accountContext]
  });
  const payloads = (results || []).map((entry) => entry.result).filter(Boolean);
  if (!payloads.length) throw new Error("페이지에서 조회 결과를 받지 못했습니다.");

  const items = [];
  const seen = new Set();
  for (const payload of payloads) {
    for (const item of payload.items || []) {
      const dedupeKey = platform === "facebook"
        ? `facebook|${item.activity_type}|${String(item.source_url || "").replace(/[?#].*$/, "")}|${String(item.title || "").replace(/\s+/g, " ").trim()}`
        : item.external_id;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      items.push(item);
    }
  }

  const statusOrder = ["success", "partial", "login_required", "error"];
  const status = statusOrder.find((candidate) => payloads.some((payload) => payload.status === candidate)) || "partial";
  const primary = payloads.find((payload) => payload.items?.length) || payloads[0];
  return {
    platform: primary.platform || platform,
    source_url: primary.source_url,
    scan_scope: activityType || "default",
    status: items.length ? "success" : status,
    message: items.length
      ? `${accountContext?.accountLabel ? `${accountContext.accountLabel} 계정에서 ` : ""}현재 화면에 로드된 게시글·댓글 ${items.length}개를 확인했습니다.`
      : `${accountContext?.accountLabel ? `${accountContext.accountLabel}: ` : ""}${primary.message || "조회 결과가 없습니다."}`,
    account_label: accountContext?.accountLabel || null,
    items: items.slice(0, 1000)
  };
}

async function postExtraction(config, extraction) {
  const response = await fetch(`${normalizeServer(config.serverUrl)}/api/collector/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.collectorToken || ""}`
    },
    body: JSON.stringify(extraction)
  });
  let body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `로컬 서버 오류 (${response.status})`);
  if (body.queued && body.status_url) {
    const statusUrl = `${normalizeServer(config.serverUrl)}${body.status_url}`;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const statusResponse = await fetch(statusUrl, {
        headers: {"Authorization": `Bearer ${config.collectorToken || ""}`}
      });
      body = await statusResponse.json().catch(() => ({}));
      if (!statusResponse.ok) throw new Error(body.detail || `수집 작업 확인 오류 (${statusResponse.status})`);
      if (!body.queued) {
        if (!body.ok) throw new Error(body.detail || "수집 작업 처리에 실패했습니다.");
        return body;
      }
    }
    throw new Error("수집 작업 대기 시간이 초과되었습니다.");
  }
  return body;
}

async function postScanFailure(config, task, message, accountLabel = null) {
  return postExtraction(config, {platform: task.platform, source_url: task.url, scan_scope: task.activityType || "default", status: "error", message, account_label: accountLabel, items: []});
}

function normalizeServer(value) {
  return String(value || "https://tracelens.kr").trim().replace(/\/$/, "");
}

async function extractPage(requestedPlatform, defaultActivityType, ownershipScope, accountContext) {
  const accountLabel = typeof accountContext === "string"
    ? accountContext
    : (accountContext?.accountLabel || null);
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const clip = (value, max) => clean(value).slice(0, max);
  const absolute = (value) => {
    try { return value ? new URL(value, location.href).href : null; } catch { return null; }
  };
  const fnv = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  };
  const firstDate = (element) => {
    const time = element.querySelector?.("time[datetime]");
    if (!time) return null;
    const parsed = new Date(time.getAttribute("datetime"));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  };
  const relativeDate = (value) => {
    const text = clean(value);
    const match = text.match(/^(\d+)\s*(초|분|시간|일|주|개월|달|년)(?:\s*전)?$/i)
      || text.match(/^(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return null;
    const unit = match[2].toLowerCase();
    const milliseconds = {
      "초": 1000, second: 1000,
      "분": 60000, minute: 60000,
      "시간": 3600000, hour: 3600000,
      "일": 86400000, day: 86400000,
      "주": 604800000, week: 604800000,
      "개월": 2629800000, "달": 2629800000, month: 2629800000,
      "년": 31557600000, year: 31557600000,
    }[unit];
    return unit && milliseconds ? new Date(Date.now() - amount * milliseconds).toISOString() : null;
  };
  const hostPlatform = () => {
    const host = location.hostname.toLowerCase();
    if (host.includes("youtube.com") || (host === "myactivity.google.com" && new URL(location.href).searchParams.get("page") === "youtube_comments")) return "youtube";
    if (host.includes("threads.com")) return "threads";
    if (host.includes("instagram.com")) return "instagram";
    if (host.includes("facebook.com")) return "facebook";
    if (host === "x.com" || host.includes("twitter.com")) return "x";
    if (host.includes("blog.naver.com")) return "naver_blog";
    if (host.includes("kin.naver.com")) return "naver_kin";
    if (host.includes("naver.com")) return "naver";
    const slug = host.replace(/^www\./, "").split(".")[0].replace(/[^a-z0-9_-]/g, "");
    return slug || "generic";
  };
  const platform = requestedPlatform === "generic" ? hostPlatform() : requestedPlatform;

  const findScrollable = () => [...document.querySelectorAll("body *")]
    .filter((element) => {
      const style = getComputedStyle(element);
      return element.scrollHeight > element.clientHeight + 180 && /(auto|scroll)/.test(style.overflowY || "");
    })
    .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || null;
  const scrollTarget = findScrollable();
  for (let step = 0; step < 12; step += 1) {
    window.scrollTo(0, document.documentElement.scrollHeight);
    if (scrollTarget) scrollTarget.scrollTop = scrollTarget.scrollHeight;
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
  window.scrollTo(0, 0);
  if (scrollTarget) scrollTarget.scrollTop = 0;
  await new Promise((resolve) => setTimeout(resolve, 300));

  const pageText = clean(document.body?.innerText).toLowerCase();
  const loginByUrl = /(login|signin|accounts\.google\.com|checkpoint)/i.test(location.href);
  const loginByText = /(^|\s)(log in|sign in|로그인)(\s|$)/i.test(pageText.slice(0, 1600));

  const selectors = {
    youtube: "ytd-comment-history-renderer, ytd-comment-renderer, c-wiz [role='listitem'], [role='listitem']",
    threads: "article, [role='article'], [data-pressable-container='true']",
    facebook: "div[role='main'] div[role='article'], div[role='main'] [role='listitem'], div[role='main'] [data-pagelet], div[role='main'] a[href*='story_fbid']",
    x: "article[data-testid='tweet']",
    naver_kin: ".my_answer_wrap li, .my_qna_list li, .board_box li, .list_qna li, .profile_list li, .question-content, .answer-content, main li, #content li",
    generic: "article, [role='article'], [class*='comment'], [class*='Comment'], [class*='reply'], [class*='Reply'], [class*='post'], [class*='Post']"
  };

  if (platform === "youtube") {
    const currentUrl = new URL(location.href);
    const isYouTubeHistory = location.hostname === "www.youtube.com"
      && location.pathname.replace(/\/$/, "") === "/feed/history/comment_history";
    const isMyActivityComments = location.hostname === "myactivity.google.com"
      && location.pathname.replace(/\/$/, "") === "/page"
      && currentUrl.searchParams.get("page") === "youtube_comments";
    if (!isYouTubeHistory && !isMyActivityComments) {
      return {
        platform,
        source_url: location.href,
        status: loginByUrl || loginByText ? "login_required" : "partial",
        message: "YouTube 댓글 기록 전용 화면이 아니어서 수집을 중단했습니다.",
        items: []
      };
    }

    const videoPattern = /(youtube\.com\/(watch|shorts)|youtu\.be\/)/i;
    const videoAnchors = [...document.querySelectorAll("a[href]")].filter((anchor) => {
      const href = absolute(anchor.getAttribute("href")) || "";
      return videoPattern.test(href);
    });
    const youtubeItems = [];
    const youtubeSeen = new Set();

    for (const anchor of videoAnchors) {
      if (youtubeItems.length >= 500) break;
      const sourceUrl = absolute(anchor.getAttribute("href"));
      if (!sourceUrl) continue;

      let row = anchor.closest("ytd-comment-history-renderer, ytd-comment-renderer, [role='listitem'], li, article");
      if (!row) {
        let node = anchor;
        for (let depth = 0; depth < 9 && node?.parentElement; depth += 1) {
          node = node.parentElement;
          const text = clean(node.innerText || node.textContent);
          const links = [...node.querySelectorAll("a[href]")].filter((item) => videoPattern.test(absolute(item.getAttribute("href")) || ""));
          if (text.length >= 8 && text.length <= 5000 && links.length <= 2) {
            row = node;
            if (/남긴 댓글|commented on|youtube/i.test(text)) break;
          }
        }
      }
      if (!row) continue;

      const rowText = clean(row.innerText || row.textContent);
      if (!rowText || rowText.length > 6000) continue;
      const rowVideoAnchors = [...row.querySelectorAll("a[href]")].filter((item) => videoPattern.test(absolute(item.getAttribute("href")) || ""));
      const bestVideoAnchor = [anchor, ...rowVideoAnchors]
        .filter(Boolean)
        .sort((a, b) => clean(b.innerText || b.textContent).length - clean(a.innerText || a.textContent).length)[0];
      let title = clip(bestVideoAnchor?.innerText || bestVideoAnchor?.textContent || "YouTube 동영상", 2000);
      if (!title || /^(youtube|동영상|video)$/i.test(title)) title = "YouTube 동영상";

      const explicitComment = row.querySelector(
        "#content-text, [data-comment-text], [data-testid='comment-content'], " +
        "[class*='comment-text'], [class*='commentText'], yt-attributed-string#content-text"
      );
      let content = clip(explicitComment?.innerText || explicitComment?.textContent, 20000);
      if (!content || content === title) {
        let working = rowText.replace(/^YouTube\s*/i, "").trim();
        const titleIndex = title !== "YouTube 동영상" ? working.lastIndexOf(title) : -1;
        if (titleIndex > 0) working = working.slice(0, titleIndex).trim();
        working = working
          .replace(/\s+(에\s*남긴\s*댓글|에\s*작성한\s*댓글).*$/i, "")
          .replace(/\s+(commented on|comment on).*$/i, "")
          .replace(/\s*(오전|오후)?\s*\d{1,2}:\d{2}.*$/i, "")
          .replace(/\s*세부정보.*$/i, "")
          .replace(/\s*details.*$/i, "")
          .trim();
        content = clip(working, 20000);
      }
      if (!content || content === title || /^(youtube|댓글 기록|comment history)$/i.test(content)) continue;

      const key = `${platform}|${sourceUrl}|${content.slice(0, 1200)}`;
      const externalId = `${platform}-${fnv(key)}`;
      if (youtubeSeen.has(externalId)) continue;
      youtubeSeen.add(externalId);
      youtubeItems.push({
        external_id: externalId,
        activity_type: "comment",
        title,
        content,
        source_url: sourceUrl,
        occurred_at: firstDate(row),
        metadata: {
          captured_from: location.href,
          page_title: document.title,
          ownership_scope: "self_activity",
          extractor_version: "0.9.1",
          account_label: accountLabel
        }
      });
    }

    return {
      platform,
      source_url: location.href,
      status: youtubeItems.length ? "success" : (loginByUrl || loginByText ? "login_required" : "partial"),
      message: youtubeItems.length
        ? `YouTube 댓글 기록에서 ${youtubeItems.length}개를 확인했습니다.`
        : "YouTube 댓글 기록 화면에서 공개 댓글을 찾지 못했습니다. 현재 Google 계정과 댓글 기록을 확인하세요.",
      items: youtubeItems
    };
  }

  if (platform === "x") {
    const ownerHandle = location.pathname.split("/").filter(Boolean)[0] || "";
    const tweetItems = [];
    const tweetSeen = new Set();
    for (const article of [...document.querySelectorAll("article[data-testid='tweet']")]) {
      if (tweetItems.length >= 500) break;
      const statusAnchor = [...article.querySelectorAll("a[href*='/status/']")].find((anchor) => {
        try {
          const parsed = new URL(anchor.href, location.href);
          const handle = parsed.pathname.split("/").filter(Boolean)[0] || "";
          return handle.toLowerCase() === ownerHandle.toLowerCase();
        } catch { return false; }
      });
      if (!statusAnchor) continue;
      const sourceUrl = absolute(statusAnchor.getAttribute("href"));
      if (!sourceUrl) continue;
      const textNode = article.querySelector("[data-testid='tweetText']");
      const tweetText = clip(textNode?.innerText || textNode?.textContent, 20000);
      const hasMedia = Boolean(article.querySelector("[data-testid='tweetPhoto'], [data-testid='videoPlayer'], video"));
      if (!tweetText && !hasMedia) continue;
      const raw = clean(article.innerText || article.textContent);
      const isReply = /(Replying to|님에게 보내는 답글|답글을 보내는 중)/i.test(raw);
      const display = tweetText || "미디어 게시물";
      const externalId = `x-${fnv(sourceUrl)}`;
      if (tweetSeen.has(externalId)) continue;
      tweetSeen.add(externalId);
      tweetItems.push({
        external_id: externalId,
        activity_type: isReply ? "comment" : "post",
        title: display,
        content: "",
        source_url: sourceUrl,
        occurred_at: firstDate(article),
        metadata: {
          captured_from: location.href,
          page_title: document.title,
          ownership_scope: "self_profile",
          extractor_version: "0.9.1",
          account_label: accountLabel,
          x_handle: ownerHandle
        }
      });
    }
    return {
      platform,
      source_url: location.href,
      status: tweetItems.length ? "success" : "partial",
      message: tweetItems.length
        ? `X 프로필에서 본인 게시글·답글 ${tweetItems.length}개를 확인했습니다.`
        : "X 프로필에서 본인이 작성한 게시글·답글을 찾지 못했습니다.",
      items: tweetItems
    };
  }

  if (platform === "threads") {
    const ownerUsername = String(accountContext?.threadsUsername || accountLabel || "").replace(/^@/, "").toLowerCase();
    const repliesMode = defaultActivityType === "comment";
    if (!ownerUsername) {
      return {platform, source_url: location.href, status: "partial", message: "Threads 로그인 계정을 확인하지 못했습니다.", items: []};
    }
    const threadsItems = [];
    const threadsSeen = new Set();
    const uiLine = /^(팔로우|팔로잉|좋아요|답글|재게시|공유|번역 보기|더 보기|follow|following|like|reply|repost|share|see translation)$/i;
    const relativeLine = /^\d+\s*(초|분|시간|일|주|개월|달|년)(\s*전)?$/i;

    const scanThreads = () => {
      const postAnchors = [...document.querySelectorAll("a[href*='/post/']")];
      for (const postAnchor of postAnchors) {
        let parsed;
        try { parsed = new URL(postAnchor.href, location.href); } catch { continue; }
        if (!['www.threads.com', 'threads.com'].includes(parsed.hostname)) continue;
        const postMatch = parsed.pathname.match(/^\/@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)/);
        if (!postMatch || postMatch[1].toLowerCase() !== ownerUsername) continue;
        const sourceUrl = `https://www.threads.com/@${postMatch[1]}/post/${postMatch[2]}`;
        let container = postAnchor.closest("article, [role='article'], [data-pressable-container='true']");
        if (!container) {
          let current = postAnchor.parentElement;
          for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
            const text = clean(current.innerText || current.textContent);
            if (text.length >= 10 && text.length <= 6000) { container = current; break; }
          }
        }
        if (!container) continue;
        const actorAnchors = [...container.querySelectorAll("a[href]")].filter((anchor) => {
          try {
            const url = new URL(anchor.href, location.href);
            return url.pathname.replace(/\/$/, '').toLowerCase() === `/@${ownerUsername}`;
          } catch { return false; }
        });
        if (!actorAnchors.length) continue;

        const candidates = [...container.querySelectorAll("div[dir='auto'], span[dir='auto'], div[data-text='true']")]
          .map((node) => clean(node.innerText || node.textContent))
          .filter((value) => value.length > 0 && value.length <= 5000)
          .filter((value) => value.toLowerCase() !== ownerUsername && value.toLowerCase() !== `@${ownerUsername}`)
          .filter((value) => !uiLine.test(value) && !relativeLine.test(value));
        let body = candidates.sort((a, b) => b.length - a.length)[0] || "";
        if (!body) {
          const lines = clean(container.innerText || container.textContent).split(/\n+/).map(clean)
            .filter((value) => value && !uiLine.test(value) && !relativeLine.test(value))
            .filter((value) => value.toLowerCase() !== ownerUsername && value.toLowerCase() !== `@${ownerUsername}`);
          body = lines.sort((a, b) => b.length - a.length)[0] || "";
        }
        if (!body || body.length < 1) continue;
        const externalId = `threads-${fnv(`${repliesMode ? 'reply' : 'post'}|${sourceUrl}`)}`;
        if (threadsSeen.has(externalId)) continue;
        threadsSeen.add(externalId);
        threadsItems.push({
          external_id: externalId,
          activity_type: repliesMode ? "comment" : "post",
          title: clip(body, 2000),
          content: "",
          source_url: sourceUrl,
          occurred_at: firstDate(container),
          metadata: {
            captured_from: location.href,
            page_title: document.title,
            ownership_scope: "self_activity",
            ownership_verified: true,
            threads_scope: repliesMode ? "authored_replies" : "authored_posts",
            threads_owner: ownerUsername,
            threads_actor: ownerUsername,
            extractor_version: "0.9.1",
            account_label: accountLabel
          }
        });
      }
    };

    let previousCount = -1;
    let unchanged = 0;
    for (let step = 0; step < 18 && unchanged < 3; step += 1) {
      scanThreads();
      if (threadsItems.length === previousCount) unchanged += 1; else unchanged = 0;
      previousCount = threadsItems.length;
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((resolve) => setTimeout(resolve, 650));
    }
    window.scrollTo(0, 0);
    return {
      platform,
      source_url: location.href,
      status: threadsItems.length ? "success" : "partial",
      message: threadsItems.length
        ? `Threads 프로필에서 내 ${repliesMode ? "답글" : "게시글"} ${threadsItems.length}개를 확인했습니다.`
        : `Threads 프로필에서 내 ${repliesMode ? "답글" : "게시글"}을 찾지 못했습니다.`,
      items: threadsItems
    };
  }

  if (platform === "facebook") {
    const main = document.querySelector("div[role='main'], main") || document.body;
    const commentMode = defaultActivityType === "comment";
    const ownerKind = accountContext?.facebookProfileKind || null;
    const ownerIdentity = String(accountContext?.facebookProfileIdentity || "").toLowerCase();
    const actionPattern = commentMode
      ? /(댓글을\s*남겼|답글을\s*남겼|댓글을\s*작성|commented on|replied to|left a comment)/i
      : /(게시물을\s*(작성|공유|게시|올렸)|사진을\s*(추가|게시|올렸)|동영상을\s*(추가|게시|올렸)|created a post|posted|shared a post|added (?:a )?(?:photo|video))/i;
    const taggedSignals = /(태그(?:되|함)|회원님을 태그|함께 있습니다|언급했습니다|tagged you|mentioned you|is with you|added to your profile)/i;
    const controlLine = /^(모두|삭제|보기|사용자 지정|옵션 더 보기|좋아요|댓글 달기|공유하기|더 보기|공개|친구만|나만 보기|All|Delete|View|More|Like|Comment|Share)$/i;
    const timeLine = /^((오전|오후)\s*\d{1,2}:\d{2}|\d+\s*(초|분|시간|일|주|개월|달|년)(\s*전)?|\d{4}년\s*\d{1,2}월\s*\d{1,2}일|\d{4}[./-]\d{1,2}[./-]\d{1,2})$/i;
    const facebookItems = [];
    const facebookSeen = new Set();
    const reservedFacebookPaths = new Set(["", "home.php", "watch", "marketplace", "gaming", "groups", "events", "friends", "settings", "login", "help", "notifications", "me", "allactivity", "activitylog", "photo.php", "story.php", "reel", "posts"]);

    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };

    const parseFacebookIdentity = (href) => {
      try {
        const parsed = new URL(href, location.href);
        if (!['www.facebook.com', 'facebook.com'].includes(parsed.hostname)) return null;
        if (parsed.pathname === '/profile.php') {
          const id = parsed.searchParams.get('id');
          return id ? {kind: 'id', value: id.toLowerCase()} : null;
        }
        const first = parsed.pathname.split('/').filter(Boolean)[0] || '';
        if (!first || reservedFacebookPaths.has(first.toLowerCase())) return null;
        if (/^\d+$/.test(first)) return {kind: 'id', value: first.toLowerCase()};
        if (/^[A-Za-z0-9.]+$/.test(first)) return {kind: 'slug', value: first.toLowerCase()};
      } catch {}
      return null;
    };

    const identityMatchesOwner = (identity) => Boolean(
      identity
      && ownerKind
      && ownerIdentity
      && identity.kind === ownerKind
      && identity.value === ownerIdentity
    );

    const rowFromNode = (node) => {
      let current = node;
      for (let depth = 0; depth < 11 && current && current !== main.parentElement; depth += 1) {
        const textValue = clean(current.innerText || current.textContent);
        const rect = current.getBoundingClientRect();
        if (
          current !== main
          && visible(current)
          && rect.width >= 300
          && rect.height >= 48
          && rect.height <= 360
          && textValue.length >= 8
          && textValue.length <= 5000
          && actionPattern.test(textValue)
          && !taggedSignals.test(textValue)
        ) return current;
        current = current.parentElement;
      }
      return null;
    };

    const collectVisibleFacebookRows = () => {
      const rows = new Set();
      for (const checkbox of main.querySelectorAll("input[type='checkbox'], [role='checkbox']")) {
        const label = clean(checkbox.getAttribute("aria-label") || checkbox.parentElement?.innerText || "");
        if (/^(모두|all)$/i.test(label)) continue;
        const row = rowFromNode(checkbox);
        if (row) rows.add(row);
      }
      for (const node of main.querySelectorAll("span, div")) {
        if (node.children.length > 2) continue;
        const value = clean(node.innerText || node.textContent);
        if (!actionPattern.test(value) || taggedSignals.test(value)) continue;
        const row = rowFromNode(node);
        if (row) rows.add(row);
      }
      return [...rows];
    };

    const canonicalFacebookUrl = (href) => {
      try {
        const parsed = new URL(href || location.href, location.href);
        parsed.hash = '';
        const keep = new Set(['id', 'comment_id', 'story_fbid', 'fbid', 'activity_id', 'set']);
        [...parsed.searchParams.keys()].forEach((key) => {
          if (!keep.has(key)) parsed.searchParams.delete(key);
        });
        return parsed.href;
      } catch {
        return String(href || location.href);
      }
    };

    const actorMatchesOwner = (row, summary) => {
      if (!ownerKind || !ownerIdentity) return false;
      const normalizedSummary = clean(summary).replace(/^Facebook\s*/i, '');
      const candidates = [...row.querySelectorAll('a[href]')]
        .map((anchor) => {
          const identity = parseFacebookIdentity(anchor.href);
          const label = clean(anchor.textContent || anchor.getAttribute('aria-label') || anchor.querySelector('img[alt]')?.getAttribute('alt'));
          if (!identity || !label) return null;
          const startsSummary = normalizedSummary.startsWith(label)
            || normalizedSummary.startsWith(`${label}님`)
            || normalizedSummary.startsWith(`${label} 님`);
          return {identity, label, startsSummary};
        })
        .filter(Boolean);
      return candidates.some((candidate) => candidate.startsSummary && identityMatchesOwner(candidate.identity));
    };

    const parseFacebookRow = (row) => {
      const rawText = clean(row.innerText || row.textContent);
      if (!actionPattern.test(rawText) || taggedSignals.test(rawText)) return;
      const leafLines = [...row.querySelectorAll("span, a, div[dir='auto']")]
        .filter((node) => node.children.length === 0)
        .map((node) => clean(node.innerText || node.textContent))
        .filter(Boolean)
        .filter((value) => value.length <= 1800)
        .filter((value) => !controlLine.test(value) && !timeLine.test(value));
      const rowLines = String(row.innerText || row.textContent || "")
        .split(/\r?\n/)
        .map(clean)
        .filter(Boolean)
        .filter((value) => !controlLine.test(value) && !timeLine.test(value));
      const merged = [...new Set([...leafLines, ...rowLines])];
      const summary = merged.find((value) => actionPattern.test(value) && !taggedSignals.test(value));
      if (!summary || !actorMatchesOwner(row, summary)) return;

      const sourceAnchor = [...row.querySelectorAll("a[href]")].find((anchor) => {
        const href = absolute(anchor.getAttribute("href")) || "";
        return /(comment_id=|story_fbid=|\/posts\/|\/permalink\/|story\.php|\/photo(?:\.php|\/)|\/reel\/|activity_id=)/i.test(href);
      });
      const sourceUrl = canonicalFacebookUrl(absolute(sourceAnchor?.getAttribute("href")) || location.href);
      const details = merged
        .filter((value) => value !== summary)
        .filter((value) => !/^\d{4}년\s*\d{1,2}월\s*\d{1,2}일$/.test(value))
        .filter((value) => !/^Facebook$/i.test(value))
        .slice(0, 5)
        .join(" · ");
      const stableText = rawText
        .split(/\r?\n/)
        .map(clean)
        .filter(Boolean)
        .filter((value) => !controlLine.test(value) && !timeLine.test(value))
        .join('|');
      const activityKey = `${defaultActivityType}|${ownerKind}:${ownerIdentity}|${sourceUrl}|${stableText}`;
      const externalId = `facebook-${fnv(activityKey)}`;
      if (facebookSeen.has(externalId)) return;
      facebookSeen.add(externalId);

      const relative = merged.find((value) => relativeDate(value));
      facebookItems.push({
        external_id: externalId,
        activity_type: defaultActivityType || "post",
        title: clip(summary, 2000),
        content: clip(details, 20000),
        source_url: sourceUrl,
        occurred_at: firstDate(row) || (relative ? relativeDate(relative) : null),
        metadata: {
          captured_from: location.href,
          page_title: document.title,
          ownership_scope: "self_activity",
          ownership_verified: true,
          extractor_version: "0.9.1",
          account_label: accountLabel,
          facebook_owner_kind: ownerKind,
          facebook_owner_identity: ownerIdentity,
          facebook_actor_identity: ownerIdentity,
          facebook_scope: commentMode ? "authored_comments" : "authored_posts"
        }
      });
    };

    if (!ownerKind || !ownerIdentity) {
      return {
        platform,
        source_url: location.href,
        status: "partial",
        message: "Facebook 로그인 계정의 프로필 ID를 확인하지 못해 타인 활동 유입 방지를 위해 수집을 중단했습니다.",
        items: []
      };
    }

    const scrollCandidates = [main, ...main.querySelectorAll("*")]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return visible(element)
          && rect.height >= 300
          && element.scrollHeight > element.clientHeight + 120
          && /(auto|scroll)/.test(style.overflowY || "");
      })
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    const facebookScroller = scrollCandidates[0] || document.scrollingElement || document.documentElement;
    let unchanged = 0;
    let previousCount = -1;
    for (let step = 0; step < 45; step += 1) {
      for (const row of collectVisibleFacebookRows()) parseFacebookRow(row);
      if (facebookItems.length === previousCount) unchanged += 1;
      else unchanged = 0;
      previousCount = facebookItems.length;
      const before = facebookScroller.scrollTop;
      const increment = Math.max(420, Math.floor(facebookScroller.clientHeight * 0.78));
      facebookScroller.scrollTop = Math.min(facebookScroller.scrollHeight, before + increment);
      await new Promise((resolve) => setTimeout(resolve, 520));
      const atBottom = facebookScroller.scrollTop + facebookScroller.clientHeight >= facebookScroller.scrollHeight - 8;
      if (atBottom && unchanged >= 3) break;
    }
    for (const row of collectVisibleFacebookRows()) parseFacebookRow(row);
    facebookScroller.scrollTop = 0;

    return {
      platform,
      source_url: location.href,
      status: facebookItems.length ? "success" : "partial",
      message: facebookItems.length
        ? `Facebook 활동 로그에서 로그인 계정이 직접 작성한 ${commentMode ? "댓글" : "게시글"} ${facebookItems.length}개를 확인했습니다.`
        : `Facebook 활동 로그의 ${commentMode ? "댓글" : "내 게시물"} 화면은 열렸지만 로그인 계정이 작성자로 확인되는 항목을 찾지 못했습니다.`,
      items: facebookItems
    };
  }

  if (platform === "instagram") {
    const expectedPath = /^\/your_activity\/interactions\/comments\/?$/;
    if (!expectedPath.test(location.pathname)) {
      return {
        platform,
        source_url: location.href,
        status: loginByUrl || loginByText ? "login_required" : "partial",
        message: "Instagram 내 댓글 전용 화면이 아니어서 수집을 중단했습니다.",
        items: []
      };
    }

    // Instagram's comment-management screen is already a self-activity view.
    // Each list row contains: post owner + the signed-in user's comment, a
    // separate post preview/caption, and a relative time. Extract only the
    // inline text that shares the post-owner header cluster. Never save the
    // lower post-preview text.
    const instagramItems = [];
    const instagramSeen = new Set();
    const processedRows = new Set();
    let candidateRowCount = 0;
    let rejectedRowCount = 0;

    const accountName = String(accountContext?.instagramUsername || "")
      .replace(/^@/, "")
      .trim()
      .toLowerCase();
    const identityVerified = accountContext?.instagramIdentityVerified === true;
    if (!accountName || !identityVerified) {
      return {
        platform,
        source_url: location.href,
        status: "partial",
        message: "Instagram의 현재 로그인 계정을 확실히 확인하지 못해 수집을 중단했습니다. 다른 사용자의 게시글이나 댓글은 저장하지 않습니다.",
        items: []
      };
    }

    const relativePattern = /^(\d+)\s*(초|분|시간|일|주|개월|달|년)(?:\s*전)?$/i;
    const controlLine = /^(선택|모두 선택|정렬 및 필터|최신순|필터|삭제|취소|완료|답글 달기|답글|좋아요(?:\s*\d+[만천백개]?)?|댓글 더 보기|이전 댓글 보기|더 보기|번역 보기|팔로우|공유|댓글|Comments?|Select|Sort and filter|Newest|Reply|Like|View replies|View all comments|Load more comments|See translation)$/i;
    const navigationNoise = /^(내 활동|계정 내역.*|사진 및 동영상.*|반응\s*(좋아요|댓글|회원님의 기타 반응).*)$/i;
    const reservedProfiles = new Set(["", "accounts", "direct", "explore", "reels", "your_activity", "settings", "about", "legal"]);

    const visible = (element) => {
      if (!(element instanceof Element)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const leafText = (node) => clean(node?.innerText || node?.textContent || "");
    const relativeLeaves = (root) => [...root.querySelectorAll("span, time, div")]
      .filter((node) => node.children.length === 0)
      .filter((node) => relativePattern.test(leafText(node)));

    const marker = [...document.querySelectorAll("button, span, div")]
      .find((node) => /^(정렬 및 필터|Sort and filter)$/i.test(leafText(node)));
    let instagramPanel = null;
    if (marker) {
      let current = marker.parentElement;
      for (let depth = 0; depth < 14 && current; depth += 1) {
        const rect = current.getBoundingClientRect();
        if (visible(current) && rect.width >= 330 && rect.height >= 250 && relativeLeaves(current).length >= 1) {
          instagramPanel = current;
          if (relativeLeaves(current).length >= 3) break;
        }
        current = current.parentElement;
      }
    }
    if (!instagramPanel) {
      const panels = [...document.querySelectorAll("main, [role='main'], body > div, body div")]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return visible(element)
            && rect.width >= 330
            && rect.height >= 260
            && rect.width <= Math.max(1100, innerWidth * 0.9)
            && relativeLeaves(element).length >= 1;
        })
        .map((element) => ({
          element,
          score: relativeLeaves(element).length * 20
            + element.querySelectorAll("img").length * 2
            + (/(정렬 및 필터|Sort and filter)/i.test(element.innerText || "") ? 100 : 0)
        }))
        .sort((a, b) => b.score - a.score);
      instagramPanel = panels[0]?.element || document.querySelector("main, [role='main']") || document.body;
    }

    const rowFromNode = (node) => {
      let current = node instanceof Element ? node : node?.parentElement;
      let fallback = null;
      for (let depth = 0; depth < 12 && current && current !== instagramPanel.parentElement; depth += 1) {
        const rect = current.getBoundingClientRect();
        const textValue = clean(current.innerText || current.textContent || "");
        const times = relativeLeaves(current).length;
        const images = current.querySelectorAll("img").length;
        const childRows = [...current.children].filter((child) => relativeLeaves(child).length >= 1).length;
        const valid = current !== instagramPanel
          && visible(current)
          && rect.width >= 260
          && rect.height >= 42
          && rect.height <= 280
          && textValue.length >= 2
          && textValue.length <= 3000
          && times >= 1
          && times <= 2
          && images >= 1
          && childRows <= 1
          && !navigationNoise.test(textValue);
        if (valid) {
          fallback = current;
          if (rect.height <= 190) return current;
        }
        current = current.parentElement;
      }
      return fallback;
    };

    const collectVisibleRows = () => {
      const rows = new Set();
      for (const timeLeaf of relativeLeaves(instagramPanel)) {
        const row = rowFromNode(timeLeaf);
        if (row) rows.add(row);
      }
      if (!rows.size) {
        for (const image of instagramPanel.querySelectorAll("img")) {
          const row = rowFromNode(image);
          if (row) rows.add(row);
        }
      }
      return [...rows].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    };

    const escapeRegExp = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const accountPrefixPattern = new RegExp(`^@?${escapeRegExp(accountName)}(?:\\s+|[·•:]\\s*|$)`, "i");

    const visualTextLines = (row) => {
      const rowRect = row.getBoundingClientRect();
      const tokens = [];
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const textValue = clean(node.nodeValue || "");
        const parent = node.parentElement;
        if (!textValue || !parent || !visible(parent)) continue;
        const rect = parent.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rect.bottom < rowRect.top - 2 || rect.top > rowRect.bottom + 2) continue;
        if (navigationNoise.test(textValue)) continue;
        tokens.push({
          text: textValue,
          left: rect.left,
          top: rect.top,
          bottom: rect.bottom,
          center: rect.top + rect.height / 2,
        });
      }
      tokens.sort((a, b) => a.top - b.top || a.left - b.left);
      const groups = [];
      for (const token of tokens) {
        let group = groups.find((candidate) => Math.abs(candidate.center - token.center) <= 7);
        if (!group) {
          group = {center: token.center, top: token.top, tokens: []};
          groups.push(group);
        }
        group.tokens.push(token);
        group.center = group.tokens.reduce((sum, item) => sum + item.center, 0) / group.tokens.length;
        group.top = Math.min(group.top, token.top);
      }
      return groups
        .sort((a, b) => a.top - b.top)
        .map((group) => {
          const pieces = group.tokens
            .sort((a, b) => a.left - b.left)
            .map((item) => item.text)
            .filter((item, index, values) => index === 0 || item !== values[index - 1]);
          return {text: clean(pieces.join(" ")), top: group.top};
        })
        .filter((line) => line.text);
    };

    const normalizedRowLines = (row) => {
      const visual = visualTextLines(row).map((line) => line.text);
      if (visual.length) return visual;
      return String(row.innerText || row.textContent || "")
        .split(/\r?\n/)
        .map(clean)
        .filter(Boolean);
    };

    const cleanSignedInComment = (value) => {
      let textValue = clean(value || "");
      if (!textValue) return "";
      textValue = textValue.replace(accountPrefixPattern, "").trim();
      textValue = textValue.replace(/(?:^|\s)\d+\s*(초|분|시간|일|주|개월|달|년)(?:\s*전)?(?:\s|$)/gi, " ").trim();
      textValue = textValue.replace(/\s+(좋아요(?:\s*\d+[만천백개]?)?|답글 달기|답글|번역 보기|Reply|Like|See translation)(?:\s+.*)?$/i, "").trim();
      if (!textValue || controlLine.test(textValue) || navigationNoise.test(textValue) || relativePattern.test(textValue)) return "";
      return clip(textValue, 2000);
    };

    const signedInCommentFromRow = (row) => {
      const lines = normalizedRowLines(row);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!accountPrefixPattern.test(line)) continue;

        const parts = [];
        const inline = cleanSignedInComment(line);
        if (inline) parts.push(inline);

        for (let next = index + 1; next < Math.min(lines.length, index + 5); next += 1) {
          const candidate = lines[next];
          if (relativePattern.test(candidate) || controlLine.test(candidate) || navigationNoise.test(candidate)) break;
          if (/^@?[A-Za-z0-9._]{1,30}(?:\s+|$)/.test(candidate) && !accountPrefixPattern.test(candidate)) break;
          const cleaned = cleanSignedInComment(candidate);
          if (cleaned) parts.push(cleaned);
        }

        const comment = clip(clean(parts.join(" ")), 2000);
        if (comment) return {comment, lines, matched: true};
      }
      return {comment: "", lines, matched: false};
    };

    const sourceUrlFromRow = (row) => {
      for (const anchor of row.querySelectorAll("a[href*='/p/'], a[href*='/reel/']")) {
        try {
          const parsed = new URL(anchor.href, location.href);
          if (parsed.hostname === "www.instagram.com" && /^\/(p|reel)\//.test(parsed.pathname)) return parsed.href;
        } catch {}
      }
      return "https://www.instagram.com/your_activity/interactions/comments/";
    };

    const rowFingerprint = (row) => {
      const textValue = clean(row.innerText || row.textContent || "");
      const images = [...row.querySelectorAll("img")].map((image) => image.currentSrc || image.src || "").join("|");
      return `${textValue.slice(0, 1200)}|${images.slice(0, 800)}`;
    };

    let accountMatchedRowCount = 0;
    const diagnosticAuthors = new Set();
    const inspectManagementRow = (row) => {
      const fingerprint = rowFingerprint(row);
      if (processedRows.has(fingerprint)) return;
      processedRows.add(fingerprint);
      candidateRowCount += 1;

      const result = signedInCommentFromRow(row);
      const firstLine = result.lines.find((line) => !relativePattern.test(line) && !controlLine.test(line));
      const firstUsername = String(firstLine || "").match(/^@?([A-Za-z0-9._]{1,30})(?:\s+|$)/)?.[1];
      if (firstUsername) diagnosticAuthors.add(firstUsername.toLowerCase());
      if (!result.matched || !result.comment) {
        rejectedRowCount += 1;
        return;
      }
      accountMatchedRowCount += 1;

      const sourceUrl = sourceUrlFromRow(row);
      const key = `${sourceUrl}|${accountName}|${result.comment}`;
      const externalId = `instagram-${fnv(key)}`;
      if (instagramSeen.has(externalId)) return;
      instagramSeen.add(externalId);
      instagramItems.push({
        external_id: externalId,
        activity_type: "comment",
        title: result.comment,
        content: "Instagram 내 활동 댓글 관리에서 확인된 내 댓글",
        source_url: sourceUrl,
        occurred_at: firstDate(row),
        metadata: {
          captured_from: "https://www.instagram.com/your_activity/interactions/comments/",
          page_title: document.title,
          ownership_scope: "self_activity",
          ownership_verified: true,
          extractor_version: "1.0.0",
          account_label: accountLabel,
          instagram_scope: "self_comments",
          instagram_username: accountName,
          comment_text_verified: true,
          comment_text_source: "management-row-signed-in-visual-line"
        }
      });
    };

    const scrollCandidates = [instagramPanel, ...instagramPanel.querySelectorAll("*")]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return visible(element)
          && rect.height >= 230
          && element.scrollHeight > element.clientHeight + 60
          && /(auto|scroll)/.test(style.overflowY || "");
      })
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    const instagramScroller = scrollCandidates[0] || instagramPanel;

    let unchanged = 0;
    let previousProcessed = -1;
    for (let step = 0; step < 100 && processedRows.size < 500; step += 1) {
      for (const row of collectVisibleRows()) inspectManagementRow(row);
      if (processedRows.size === previousProcessed) unchanged += 1;
      else unchanged = 0;
      previousProcessed = processedRows.size;
      const before = instagramScroller.scrollTop;
      instagramScroller.scrollTop = Math.min(
        instagramScroller.scrollHeight,
        before + Math.max(280, Math.floor(instagramScroller.clientHeight * 0.72))
      );
      await new Promise((resolve) => setTimeout(resolve, 420));
      const atBottom = instagramScroller.scrollTop + instagramScroller.clientHeight >= instagramScroller.scrollHeight - 8;
      if (atBottom && unchanged >= 3) break;
    }
    instagramScroller.scrollTop = 0;

    return {
      platform,
      source_url: location.href,
      status: instagramItems.length ? "success" : "partial",
      message: instagramItems.length
        ? `Instagram 관리 목록 ${candidateRowCount}개에서 로그인 계정 @${accountName} 표시 행 ${accountMatchedRowCount}개, 내 댓글 ${instagramItems.length}개를 확인했습니다.`
        : `Instagram 관리 목록 ${candidateRowCount}개를 확인했지만 @${accountName} 표시 댓글 행을 찾지 못했습니다. 감지된 작성자: ${[...diagnosticAuthors].slice(0, 8).join(", ") || "없음"}. 제외 ${rejectedRowCount}개입니다.`,
      items: instagramItems
    };
  }

  let elements = [];
  if (platform === "naver_blog") {
    const postPattern = /(PostView\.naver\?.*logNo=|blog\.naver\.com\/[A-Za-z0-9_-]+\/\d+)/i;
    const postAnchors = [...document.querySelectorAll("a[href]")].filter((anchor) => postPattern.test(absolute(anchor.getAttribute("href")) || ""));
    elements = [...new Set(postAnchors.map((anchor) => anchor.closest("li, article, div[id^='post_'], .post, .blog2_series, .wrap_post") || anchor))];
  } else if (platform === "naver_kin") {
    const qnaPattern = /kin\.naver\.com\/qna\/detail\.naver/i;
    const qnaAnchors = [...document.querySelectorAll("a[href]")].filter((anchor) => qnaPattern.test(absolute(anchor.getAttribute("href")) || ""));
    elements = [...new Set(qnaAnchors.map((anchor) => anchor.closest("li, article, tr, .qna_list, .list_item, .profile_list, .board_box") || anchor))];
  } else {
    elements = [...document.querySelectorAll(selectors[platform] || selectors.generic)];
  }


  const items = [];
  const seen = new Set();
  const linkPatterns = {
    youtube: /youtube\.com\/(watch|shorts)|youtu\.be\//i,
    threads: /threads\.com\/@[^/]+\/post\//i,
    instagram: /instagram\.com\/(p|reel)\//i,
    facebook: /facebook\.com\/.+(posts|activity|story_fbid|comment_id|permalink|story\.php|reel)/i,
    x: /(x\.com|twitter\.com)\/.+\/status\//i,
    naver_blog: /(PostView\.naver\?.*logNo=|blog\.naver\.com\/[A-Za-z0-9_-]+\/\d+)/i,
    naver_kin: /kin\.naver\.com\/qna\/detail\.naver/i
  };
  const requiresLink = new Set(["youtube", "threads", "facebook", "x", "naver_blog", "naver_kin"]);

  for (const element of elements) {
    if (items.length >= 500) break;
    const rawText = clip(element.innerText || element.textContent, 12000);
    if (rawText.length < 3 || rawText.length > 10000) continue;

    if (platform === "facebook") {
      const taggedSignals = /(님이 .*게시|태그(?:되|함)|회원님을 태그|함께 있습니다|언급했습니다|posted on your (timeline|profile)|tagged you|mentioned you|is with you|added to your profile)/i;
      if (taggedSignals.test(rawText)) continue;
      const authoredSignals = defaultActivityType === "post"
        ? /(내 게시물|게시물을 (작성|공유)|사진을 추가|동영상을 추가|you (posted|shared|created)|your post|added a (photo|video)|shared a post)/i
        : /(댓글을 (남겼|작성)|답글을 (남겼|작성)|you commented|you replied|your comment)/i;
      if (!authoredSignals.test(rawText)) continue;
    }

    const anchors = element.matches?.("a[href]") ? [element, ...element.querySelectorAll("a[href]")] : [...element.querySelectorAll("a[href]")];
    const pattern = linkPatterns[platform];
    let linkElement = pattern
      ? anchors.find((anchor) => pattern.test(absolute(anchor.getAttribute("href")) || ""))
      : anchors[0];
    if (platform === "naver_blog" && pattern) {
      const postLinks = anchors.filter((anchor) => pattern.test(absolute(anchor.getAttribute("href")) || ""));
      linkElement = postLinks.find((anchor) => {
        const text = clean(anchor.innerText || anchor.textContent);
        return text.length >= 2 && !/^(공감|댓글|수정|삭제|목록|더보기|이웃추가|블로그)$/i.test(text);
      }) || postLinks[0];
    }

    if (requiresLink.has(platform) && !linkElement) continue;
    const sourceUrl = absolute(linkElement?.getAttribute("href")) || location.href;
    const heading = element.querySelector?.("h1,h2,h3,h4,[role='heading'],strong");
    let title = clip(heading?.innerText || linkElement?.innerText || document.title, 2000);
    let content = rawText;

    if (platform === "youtube") {
      const videoLink = anchors.find((anchor) => {
        const href = absolute(anchor.getAttribute("href")) || "";
        return /youtube\.com\/(watch|shorts)|youtu\.be\//i.test(href) && clean(anchor.innerText).length >= 2;
      });
      const videoTitleNode = element.querySelector(
        "a#video-title, #video-title, yt-formatted-string#video-title, yt-attributed-string#video-title, [data-video-title]"
      );
      title = clip(videoTitleNode?.innerText || videoLink?.innerText || heading?.innerText || document.title, 2000);

      const commentNode = element.querySelector(
        "#content-text, yt-attributed-string#content-text, yt-formatted-string#content-text, " +
        "ytd-comment-view-model #content-text, ytd-comment-renderer #content-text, " +
        "[data-testid='comment-content'], [class*='comment-text'], [class*='commentText']"
      );
      content = clip(commentNode?.innerText || commentNode?.textContent, 20000);

      if (!content || content === title) {
        const titleIndex = title ? rawText.lastIndexOf(title) : -1;
        if (titleIndex > 0) content = clean(rawText.slice(0, titleIndex)).replace(/^YouTube\s*/i, "").trim();
      }
      if (!content || content === title) {
        content = rawText
          .replace(/^YouTube\s*/i, "")
          .replace(title, "")
          .replace(/에 남긴 댓글.*$/i, "")
          .replace(/\b세부정보\b.*$/i, "")
          .trim();
      }
    }

    if (platform === "naver_blog") {
      const titleNode = element.querySelector?.(
        "a[class*='title'], .pcol2, .se-title-text, .ell2, .title, strong, h3, h4"
      );
      const linkTitle = clip(linkElement?.innerText || linkElement?.textContent, 2000);
      title = /^(공감|댓글|수정|삭제|목록|더보기|이웃추가|블로그)$/i.test(linkTitle)
        ? clip(titleNode?.innerText, 2000)
        : (linkTitle || clip(titleNode?.innerText, 2000));
      content = "";
      if (!title || title.length < 2) continue;
    }

    if (content === title) content = "";
    if (!title && !content) continue;

    let activityType = defaultActivityType || "post";
    if (requestedPlatform === "generic") {
      const marker = `${element.id || ""} ${typeof element.className === "string" ? element.className : ""}`.toLowerCase();
      activityType = /(comment|reply|repl|댓글|답글)/i.test(marker) ? "comment" : "post";
    }

    const key = `${platform}|${sourceUrl}|${title}|${content.slice(0, 500)}`;
    const externalId = `${platform}-${fnv(key)}`;
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    items.push({
      external_id: externalId,
      activity_type: activityType,
      title,
      content,
      source_url: sourceUrl,
      occurred_at: firstDate(element),
      metadata: {
        captured_from: location.href,
        page_title: document.title,
        ownership_scope: ownershipScope,
        extractor_version: "0.9.1",
        account_label: accountLabel,
        facebook_scope: platform === "facebook"
          ? (activityType === "post" ? "authored_posts" : "authored_comments")
          : null
      }
    });
  }

  let status = "success";
  let message = `현재 페이지에 로드된 게시글·댓글 ${items.length}개를 확인했습니다.`;
  if ((loginByUrl || loginByText) && items.length === 0) {
    status = "login_required";
    message = "로그인이 필요하거나 로그인 페이지로 이동했습니다.";
  } else if (items.length === 0) {
    status = "partial";
    message = "현재 화면에서 작성한 게시글·댓글을 찾지 못했습니다. 로그인 상태와 내 활동 페이지를 확인하세요.";
  }

  return {platform, source_url: location.href, status, message, items};
}
