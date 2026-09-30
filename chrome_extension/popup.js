const SITE_ORIGINS = {
  youtube: ["https://www.youtube.com/*", "https://myactivity.google.com/*", "https://accounts.google.com/*"],
  instagram: ["https://www.instagram.com/*"],
  facebook: ["https://www.facebook.com/*"],
  threads: ["https://www.threads.com/*", "https://threads.com/*"],
  x: ["https://x.com/*", "https://twitter.com/*"],
  naver_blog: ["https://blog.naver.com/*"],
  naver_kin: ["https://kin.naver.com/*"],
};

const SITE_CATALOG = [
  {id: "youtube", name: "YouTube", scope: "댓글"},
  {id: "instagram", name: "Instagram", scope: "댓글"},
  {id: "threads", name: "Threads", scope: "게시글·답글"},
  {id: "facebook", name: "Facebook", scope: "게시글·댓글"},
  {id: "x", name: "X", scope: "게시글·답글"},
  {id: "naver_blog", name: "네이버 블로그", scope: "게시글"},
  {id: "naver_kin", name: "네이버 지식iN", scope: "질문·답변"},
];

const connectionCard = document.getElementById("connection-card");
const connectionState = document.getElementById("connection-state");
const userBox = document.getElementById("connected-user");
const logWrap = document.getElementById("log-wrap");
const log = document.getElementById("log");
const scanButton = document.getElementById("scan-sites");
const captureButton = document.getElementById("capture-current");
const scanWrap = document.getElementById("scan-wrap");
const manualCard = document.getElementById("manual-card");
const siteRoot = document.getElementById("site-options");
const selectionCount = document.getElementById("selection-count");

let selectedSites = new Set(SITE_CATALOG.map((site) => site.id));
let currentConfig = null;

function friendlyLine(value) {
  const original = String(value || "").trim();
  if (!original) return "";
  const taskLine = original.match(/^([✓✕])\s*([^:]+):\s*(.*)$/s);
  if (taskLine) {
    const [, , label, detail] = taskLine;
    return `${label.replace(/\b내\s*/g, "").trim()} · ${friendlyLine(detail)}`;
  }
  if (/로그인 상태를 확인하지 못|로그인된 .*?(?:프로필|계정|ID|주소).*찾지 못/.test(original)) {
    return "해당 사이트에 로그인한 뒤 다시 조회해 주세요.";
  }
  if (/본인 활동 페이지 확인에 실패|활동 페이지를 확인하지 못/.test(original)) {
    return "해당 사이트의 활동 페이지를 확인하지 못했습니다. 로그인 상태를 확인한 뒤 다시 조회해 주세요.";
  }
  if (/페이지 로딩 시간이 초과|조회 탭을 찾을 수 없/.test(original)) {
    return "사이트 응답이 늦어 조회를 마치지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }
  if (/HTTP\s*\d+|collector|token|CSRF|서버|응답 본문|ReferenceError|SyntaxError|Could not load|https?:\/\//i.test(original)) {
    console.warn("TraceLens internal popup message:", original);
    return "처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.";
  }
  return original
    .replace(/^오류:\s*/i, "")
    .replace(/공통 전수조사기(?:로)?/g, "")
    .replace(/원문 링크\s*\d+개 확인(?:,\s*\d+개 미노출)?\.?/g, "")
    .replace(/끝까지 확인했습니다\.?/g, "")
    .replace(/부분 결과로 저장했습니다\.?/g, "일부 기록은 확인하지 못했습니다.")
    .replace(/(\d+)개 확인,\s*(\d+)개 신규/g, "$1개 확인 · $2개 새로 저장")
    .replace(/(\d+)개 신규/g, "$1개 새로 저장")
    .replace(/동기화/g, "반영")
    .replace(/전수조사|전수 확인/g, "전체 확인")
    .replace(/행 탐색/g, "항목 확인")
    .replace(/활동 ID/g, "항목 정보")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function friendlyError(error) {
  const text = String(error?.message || error || "");
  if (/로그인/.test(text)) return "TraceLens에 로그인한 뒤 다시 시도해 주세요.";
  if (/권한/.test(text)) return "선택한 사이트의 조회 권한을 허용해 주세요.";
  if (/사이트를 하나 이상 선택/.test(text)) return "조회할 사이트를 하나 이상 선택해 주세요.";
  if (/웹페이지/.test(text)) return "조회할 페이지를 먼저 열어 주세요.";
  if (/확장 프로그램을 새로고침/.test(text)) return text;
  return friendlyLine(text) || "처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.";
}

function setLog(message) {
  const lines = String(message || "").split("\n").map(friendlyLine).filter(Boolean);
  log.textContent = lines.join("\n");
  logWrap.hidden = lines.length === 0;
}

function normalizeServer(value) {
  const server = String(value || "http://localhost:8021").trim().replace(/\/$/, "");
  return ["http://localhost:8021", "http://127.0.0.1:8021"].includes(server)
    ? server : "http://localhost:8021";
}

function normalizedSites(value) {
  const valid = new Set(SITE_CATALOG.map((site) => site.id));
  const source = Array.isArray(value) ? value : SITE_CATALOG.map((site) => site.id);
  return [...new Set(source.filter((site) => valid.has(site)))];
}

async function saveSelectedSites() {
  await chrome.storage.local.set({selectedSites: [...selectedSites]});
}

function renderSites() {
  siteRoot.innerHTML = SITE_CATALOG.map((site) => {
    const checked = selectedSites.has(site.id) ? "checked" : "";
    return `<label class="site-option"><input type="checkbox" value="${site.id}" ${checked}><span><b>${site.name}</b><small>${site.scope}</small></span></label>`;
  }).join("");
  siteRoot.querySelectorAll("input[type=checkbox]").forEach((input) => {
    input.addEventListener("change", async (event) => {
      if (event.currentTarget.checked) selectedSites.add(event.currentTarget.value);
      else selectedSites.delete(event.currentTarget.value);
      selectionCount.textContent = `${selectedSites.size}개 선택`;
      await saveSelectedSites();
    });
  });
  selectionCount.textContent = `${selectedSites.size}개 선택`;
}

async function loadConfig() {
  const stored = await chrome.storage.local.get(["serverUrl", "collectorToken", "userEmail", "selectedSites"]);
  selectedSites = new Set(normalizedSites(stored.selectedSites));
  renderSites();
  if (!stored.collectorToken) throw new Error("TraceLens 로그인이 필요합니다.");
  return {
    serverUrl: normalizeServer(stored.serverUrl),
    collectorToken: stored.collectorToken,
    userEmail: stored.userEmail || "",
  };
}

async function testConnection(config) {
  const response = await fetch(`${config.serverUrl}/api/collector/status`, {
    headers: {Authorization: `Bearer ${config.collectorToken}`},
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.warn("TraceLens connection response:", response.status, body);
    throw new Error("TraceLens 로그인 상태를 확인하지 못했습니다.");
  }
  return body;
}

async function connect() {
  connectionCard.hidden = true;
  setLog("");
  try {
    currentConfig = await loadConfig();
    await testConnection(currentConfig);
    scanWrap.hidden = false;
    manualCard.hidden = false;
    connectionCard.hidden = true;
    scanButton.textContent = "조회";
    return true;
  } catch (error) {
    currentConfig = null;
    scanWrap.hidden = true;
    manualCard.hidden = true;
    connectionCard.hidden = false;
    connectionState.className = "state failed";
    connectionState.innerHTML = "<i></i>로그인 필요";
    userBox.textContent = friendlyError(error);
    return false;
  }
}

async function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

scanButton.addEventListener("click", async () => {
  scanButton.disabled = true;
  setLog(`${selectedSites.size}개 사이트를 조회하고 있습니다.`);
  try {
    if (!currentConfig) throw new Error("TraceLens 로그인이 필요합니다.");
    await testConnection(currentConfig);
    const sites = [...selectedSites];
    if (!sites.length) throw new Error("조회할 사이트를 하나 이상 선택하세요.");
    const origins = [...new Set(sites.flatMap((site) => SITE_ORIGINS[site] || []))];
    const granted = await chrome.permissions.request({origins});
    if (!granted) throw new Error("선택한 사이트의 조회 권한이 필요합니다.");
    const result = await sendMessage({type: "SCAN_SITES", sites, config: currentConfig});
    if (!result?.ok) throw new Error(result?.error || "조회를 완료하지 못했습니다.");
    setLog((result.lines || ["조회가 완료되었습니다."]).join("\n"));
  } catch (error) {
    setLog(`확인 필요 · ${friendlyError(error)}`);
  } finally {
    scanButton.disabled = false;
  }
});

captureButton.addEventListener("click", async () => {
  captureButton.disabled = true;
  setLog("현재 페이지를 조회하고 있습니다.");
  try {
    if (!currentConfig) throw new Error("TraceLens 로그인이 필요합니다.");
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) throw new Error("조회할 웹페이지를 먼저 열어 주세요.");
    const result = await sendMessage({type: "CAPTURE_CURRENT", tabId: tab.id, config: currentConfig});
    if (!result?.ok) throw new Error(result?.error || "현재 페이지를 조회하지 못했습니다.");
    setLog(result.message || "현재 페이지 조회를 마쳤습니다.");
  } catch (error) {
    setLog(`확인 필요 · ${friendlyError(error)}`);
  } finally {
    captureButton.disabled = false;
  }
});

document.getElementById("select-all").addEventListener("click", async () => {
  selectedSites = new Set(SITE_CATALOG.map((site) => site.id));
  renderSites();
  await saveSelectedSites();
});
document.getElementById("select-default").addEventListener("click", async () => {
  selectedSites = new Set(["youtube", "instagram", "threads", "facebook", "x"]);
  renderSites();
  await saveSelectedSites();
});
document.getElementById("clear-sites").addEventListener("click", async () => {
  selectedSites.clear();
  renderSites();
  await saveSelectedSites();
});
document.getElementById("open-dashboard").addEventListener("click", async () => {
  const stored = await chrome.storage.local.get(["serverUrl"]);
  chrome.tabs.create({url: `${normalizeServer(stored.serverUrl)}/app`});
});
document.getElementById("open-login").addEventListener("click", async () => {
  const stored = await chrome.storage.local.get(["serverUrl"]);
  chrome.tabs.create({url: `${normalizeServer(stored.serverUrl)}/login?next=/app`});
});

connect();
