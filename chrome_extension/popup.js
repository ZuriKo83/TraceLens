const SITE_ORIGINS = {
  youtube: ["https://www.youtube.com/*", "https://myactivity.google.com/*", "https://accounts.google.com/*"],
  instagram: ["https://www.instagram.com/*"],
  facebook: ["https://www.facebook.com/*"],
  threads: ["https://www.threads.com/*", "https://threads.com/*"],
  x: ["https://x.com/*", "https://twitter.com/*"],
  naver_blog: ["https://blog.naver.com/*"],
  naver_kin: ["https://kin.naver.com/*"]
};

const SITE_CATALOG = [
  {id: "youtube", name: "YouTube", scope: "내 댓글"},
  {id: "instagram", name: "Instagram", scope: "내 댓글"},
  {id: "threads", name: "Threads", scope: "내 게시글·답글"},
  {id: "facebook", name: "Facebook", scope: "내 게시글·댓글"},
  {id: "x", name: "X", scope: "내 게시글·답글"},
  {id: "naver_blog", name: "네이버 블로그", scope: "내 게시글"},
  {id: "naver_kin", name: "네이버 지식iN", scope: "내 질문·답변"}
];

const state = document.getElementById("connection-state");
const userBox = document.getElementById("connected-user");
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
  let text = String(value || "").trim();
  if (!text) return "";
  if (/HTTP\s*\d+|collector|token|CSRF|서버|응답 본문|ReferenceError|SyntaxError|Could not load|https?:\/\//i.test(text)) {
    console.warn("TraceLens internal popup message:", text);
    return "처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.";
  }
  text = text
    .replace(/^오류:\s*/i, "")
    .replace(/공통 전수조사기(?:로)?/g, "")
    .replace(/원문 링크\s*\d+개 확인(?:,\s*\d+개 미노출)?\.?/g, "")
    .replace(/끝까지 확인했습니다\.?/g, "")
    .replace(/부분 결과로 저장했습니다\.?/g, "일부 기록은 확인하지 못했습니다.")
    .replace(/동기화/g, "목록 반영")
    .replace(/전수조사|전수 확인/g, "전체 확인")
    .replace(/행 탐색/g, "항목 확인")
    .replace(/활동 ID/g, "항목 정보")
    .replace(/\s{2,}/g, " ")
    .trim();
  return text || "처리가 완료되었습니다.";
}

function friendlyError(error, fallback = "처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.") {
  const text = String(error?.message || error || "");
  if (/로그인/.test(text)) return "TraceLens에 로그인한 뒤 다시 시도해 주세요.";
  if (/권한/.test(text)) return "선택한 사이트를 확인하려면 조회 권한이 필요합니다.";
  if (/사이트를 하나 이상 선택/.test(text)) return "조회할 사이트를 하나 이상 선택해 주세요.";
  if (/일반 웹페이지 탭/.test(text)) return "확인할 웹페이지를 먼저 연 뒤 다시 시도해 주세요.";
  if (/확장 프로그램을 새로고침/.test(text)) return text;
  const friendly = friendlyLine(text);
  return friendly && friendly !== "처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요." ? friendly : fallback;
}

function setLog(message) {
  const lines = String(message || "").split("\n").map(friendlyLine).filter(Boolean);
  log.textContent = lines.join("\n") || "조회할 사이트를 선택하세요.";
}
function normalizeServer(value) { return String(value || "https://tracelens.kr").trim().replace(/\/$/, ""); }
function setConnection(kind, text) {
  state.className = `state ${kind || ""}`.trim();
  state.innerHTML = `<i></i>${text}`;
}
function normalizedSites(value) {
  const valid = new Set(SITE_CATALOG.map((site) => site.id));
  const source = Array.isArray(value) ? value : SITE_CATALOG.map((site) => site.id);
  return [...new Set(source.filter((site) => valid.has(site)))];
}
async function saveSelectedSites() { await chrome.storage.local.set({selectedSites: [...selectedSites]}); }
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
  if (!stored.collectorToken) throw new Error("TraceLens에 로그인한 뒤 ‘내 활동’ 페이지를 한 번 열어 주세요.");
  return {
    serverUrl: normalizeServer(stored.serverUrl),
    collectorToken: stored.collectorToken,
    userEmail: stored.userEmail || ""
  };
}

async function testConnection(config) {
  const response = await fetch(`${config.serverUrl}/api/collector/status`, {
    headers: {Authorization: `Bearer ${config.collectorToken}`}
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.warn("TraceLens connection response:", response.status, body);
    throw new Error("TraceLens 로그인 상태를 확인하지 못했습니다.");
  }
  return body;
}

async function connect() {
  setConnection("", "확인 중");
  try {
    currentConfig = await loadConfig();
    const result = await testConnection(currentConfig);
    scanWrap.hidden = false;
    manualCard.hidden = false;
    setConnection("connected", "준비 완료");
    userBox.innerHTML = `<b>${result.user_email}</b><span>이 계정의 TraceLens 보관함에 결과를 저장합니다.</span>`;
    setLog("조회할 사이트를 선택하세요.");
    return true;
  } catch (error) {
    currentConfig = null;
    scanWrap.hidden = true;
    manualCard.hidden = true;
    setConnection("failed", "로그인 필요");
    setLog(friendlyError(error));
    return false;
  }
}

async function sendMessage(message) { return chrome.runtime.sendMessage(message); }

scanButton.addEventListener("click", async () => {
  scanButton.disabled = true;
  try {
    if (!currentConfig) throw new Error("TraceLens 로그인이 필요합니다.");
    await testConnection(currentConfig);
    const sites = [...selectedSites];
    if (!sites.length) throw new Error("조회할 사이트를 하나 이상 선택하세요.");
    const origins = [...new Set(sites.flatMap((site) => SITE_ORIGINS[site] || []))];
    const granted = await chrome.permissions.request({origins});
    if (!granted) throw new Error("선택한 사이트의 조회 권한이 필요합니다.");
    setLog(`${sites.length}개 사이트를 확인하고 있습니다. 작업이 끝날 때까지 잠시 기다려 주세요.`);
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
  try {
    if (!currentConfig) throw new Error("TraceLens 로그인이 필요합니다.");
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) throw new Error("확인할 웹페이지를 먼저 열어 주세요.");
    const result = await sendMessage({type: "CAPTURE_CURRENT", tabId: tab.id, config: currentConfig});
    if (!result?.ok) throw new Error(result?.error || "현재 페이지를 확인하지 못했습니다.");
    setLog(result.message || "현재 페이지 확인을 마쳤습니다.");
  } catch (error) {
    setLog(`확인 필요 · ${friendlyError(error)}`);
  } finally {
    captureButton.disabled = false;
  }
});

document.getElementById("select-all").addEventListener("click", async () => { selectedSites = new Set(SITE_CATALOG.map((site) => site.id)); renderSites(); await saveSelectedSites(); });
document.getElementById("select-default").addEventListener("click", async () => { selectedSites = new Set(["youtube", "instagram", "threads", "facebook", "x"]); renderSites(); await saveSelectedSites(); });
document.getElementById("clear-sites").addEventListener("click", async () => { selectedSites.clear(); renderSites(); await saveSelectedSites(); });
document.getElementById("clear-log").addEventListener("click", () => setLog("조회할 사이트를 선택하세요."));
document.getElementById("open-dashboard").addEventListener("click", async () => {
  const stored = await chrome.storage.local.get(["serverUrl"]);
  chrome.tabs.create({url: `${normalizeServer(stored.serverUrl)}/app`});
});
document.getElementById("open-login").addEventListener("click", async () => {
  const stored = await chrome.storage.local.get(["serverUrl"]);
  chrome.tabs.create({url: `${normalizeServer(stored.serverUrl)}/login?next=/app`});
});

connect();