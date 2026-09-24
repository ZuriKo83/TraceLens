export const SERVER = process.env.TRACELENS_SERVER_URL || 'http://localhost:8021';
export const BROWSERS = Object.freeze({
  chromium: {engine: 'chromium'},
  chrome: {engine: 'chromium', channel: 'chrome'},
  edge: {engine: 'chromium', channel: 'msedge'},
  firefox: {engine: 'firefox'},
});
export const SITES = Object.freeze({
  youtube: 'https://myactivity.google.com/page?page=youtube_comments',
  instagram: 'https://www.instagram.com/',
  facebook: 'https://www.facebook.com/',
  threads: 'https://www.threads.com/',
  x: 'https://x.com/home',
  naver_blog: 'https://blog.naver.com/MyBlog.naver',
  naver_kin: 'https://kin.naver.com/myinfo/index.naver',
});
const HOSTS = new Set([
  'www.youtube.com', 'myactivity.google.com', 'accounts.google.com',
  'www.instagram.com', 'instagram.com', 'www.facebook.com', 'facebook.com',
  'm.facebook.com', 'www.threads.com', 'threads.com', 'x.com', 'twitter.com',
  'blog.naver.com', 'kin.naver.com', 'nid.naver.com',
]);
export function allowedPage(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && HOSTS.has(u.hostname) && !u.username && !u.password && !u.port; }
  catch { return false; }
}
export function dashboardSource(source) {
  if (!source.page || source.frame !== source.page.mainFrame()) return false;
  try { const u = new URL(source.frame.url()); return u.origin === SERVER && u.pathname === '/app'; }
  catch { return false; }
}
export function selectedSites(value) {
  if (!Array.isArray(value) || !value.length || value.length > 7 || value.some(x => !Object.hasOwn(SITES, x))) {
    throw new Error('지원하는 사이트를 선택하세요.');
  }
  return [...new Set(value)];
}
export function allowedApi(url) {
  try {
    const u = new URL(url);
    return u.origin === SERVER && !u.username && !u.password && !u.search && !u.hash &&
      /^\/api\/collector\/(status|import|jobs\/[a-zA-Z0-9-]+)$/.test(u.pathname);
  } catch { return false; }
}
