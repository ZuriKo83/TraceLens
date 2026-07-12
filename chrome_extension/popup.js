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

function setLog(message) { log.textContent = message; }
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
  if (!stored.collectorToken) throw new Error("TraceLens 웹 앱에 로그인한 뒤 내 활동 페이지를 한 번 열어주세요.");
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
  if (!response.ok) throw new Error(body.detail || `연결 실패 (${response.status})`);
  return body;
}

async function connect() {
  setConnection("", "확인 중");
  try {
    currentConfig = await loadConfig();
    const result = await testConnection(currentConfig);
    scanWrap.hidden = false;
    manualCard.hidden = false;
    setConnection("connected", "연결됨");
    userBox.innerHTML = `<b>${result.user_email}</b><span>이 사용자 보관함으로 결과를 전송합니다.</span>`;
    setLog(`${result.workspace}에 연결되었습니다.`);
    return true;
  } catch (error) {
    currentConfig = null;
    scanWrap.hidden = true;
    manualCard.hidden = true;
    setConnection("failed", "로그인 필요");
    setLog(error.message);
    return false;
  }
}

async function sendMessage(message) { return chrome.runtime.sendMessage(message); }

scanButton.addEventListener("click", async () => {
  scanButton.disabled = true;
  try {
    if (!currentConfig) throw new Error("웹 앱 사용자 연결이 필요합니다.");
    await testConnection(currentConfig);
    const sites = [...selectedSites];
    if (!sites.length) throw new Error("조회할 사이트를 하나 이상 선택하세요.");
    const origins = [...new Set(sites.flatMap((site) => SITE_ORIGINS[site] || []))];
    const granted = await chrome.permissions.request({origins});
    if (!granted) throw new Error("선택한 사이트의 읽기 권한이 승인되지 않았습니다.");
    setLog(`${currentConfig.userEmail || "로그인 사용자"} 보관함 조회 시작: ${sites.length}개 사이트`);
    const result = await sendMessage({type: "SCAN_SITES", sites, config: currentConfig});
    if (!result?.ok) throw new Error(result?.error || "조회에 실패했습니다.");
    setLog(result.lines.join("\n"));
  } catch (error) { setLog(`오류: ${error.message}`); }
  finally { scanButton.disabled = false; }
});

captureButton.addEventListener("click", async () => {
  captureButton.disabled = true;
  try {
    if (!currentConfig) throw new Error("웹 앱 사용자 연결이 필요합니다.");
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) throw new Error("일반 웹페이지 탭에서 실행하세요.");
    const result = await sendMessage({type: "CAPTURE_CURRENT", tabId: tab.id, config: currentConfig});
    if (!result?.ok) throw new Error(result?.error || "현재 페이지 조회에 실패했습니다.");
    setLog(result.message);
  } catch (error) { setLog(`오류: ${error.message}`); }
  finally { captureButton.disabled = false; }
});

document.getElementById("select-all").addEventListener("click", async () => { selectedSites = new Set(SITE_CATALOG.map((site) => site.id)); renderSites(); await saveSelectedSites(); });
document.getElementById("select-default").addEventListener("click", async () => { selectedSites = new Set(["youtube", "instagram", "threads", "facebook", "x"]); renderSites(); await saveSelectedSites(); });
document.getElementById("clear-sites").addEventListener("click", async () => { selectedSites.clear(); renderSites(); await saveSelectedSites(); });
document.getElementById("clear-log").addEventListener("click", () => setLog("대기 중"));
document.getElementById("open-dashboard").addEventListener("click", async () => {
  const stored = await chrome.storage.local.get(["serverUrl"]);
  chrome.tabs.create({url: `${normalizeServer(stored.serverUrl)}/app`});
});
document.getElementById("open-login").addEventListener("click", async () => {
  const stored = await chrome.storage.local.get(["serverUrl"]);
  chrome.tabs.create({url: `${normalizeServer(stored.serverUrl)}/login?next=/app`});
});

connect();
