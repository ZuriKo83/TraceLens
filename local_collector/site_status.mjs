import {SITES} from './policy.mjs';

const LOGIN_PATH = /\/(login|signin|checkpoint|challenge|authwall)(?:\/|$)/i;

export async function probeSite(page, site) {
  try {
    await page.goto(SITES[site], {waitUntil: 'domcontentloaded', timeout: 18000});
    await page.waitForTimeout(900);
    const current = new URL(page.url());
    if (LOGIN_PATH.test(current.pathname) || current.hostname === 'accounts.google.com'
        || current.hostname === 'nid.naver.com') return {site, state: 'login_required'};
    const detail = await page.evaluate(() => {
      const links = [...document.querySelectorAll("nav a[href], [role='navigation'] a[href], aside a[href]")];
      const profileLinks = links.filter(anchor => {
        const labels = [anchor.getAttribute('aria-label'), anchor.getAttribute('title'), anchor.textContent];
        return labels.some(label => /^(내\s*)?(프로필|profile)$/i.test((label || '').trim()));
      });
      return {
        hasPassword: Boolean(document.querySelector("input[type='password']")),
        profileUrls: profileLinks.map(anchor => anchor.href),
        xProfile: document.querySelector("a[data-testid='AppTabBar_Profile_Link']")?.href || null,
        securityScreen: /(추가\s*보안|보안\s*확인|보호\s*조치)/i.test(document.body?.innerText?.slice(0, 1000) || ''),
      };
    });
    if (detail.hasPassword) return {site, state: 'login_required'};
    if (detail.securityScreen && site.startsWith('naver_')) return {site, state: 'security_required'};
    if (site === 'youtube') {
      const accessible = current.hostname === 'myactivity.google.com' && current.pathname === '/page'
        && current.searchParams.get('page') === 'youtube_comments';
      return {site, state: accessible ? 'accessible' : 'login_required'};
    }
    if (site === 'instagram') {
      const accessible = current.hostname === 'www.instagram.com'
        && /^\/your_activity\/interactions\/comments\/?$/.test(current.pathname);
      return {site, state: accessible ? 'accessible' : 'profile_required'};
    }
    if (site === 'facebook') {
      const accessible = current.hostname === 'www.facebook.com' && /\/allactivity\//.test(current.pathname);
      return {site, state: accessible ? 'accessible' : 'profile_required'};
    }
    if (site === 'threads') {
      const owners = new Set(detail.profileUrls.map(href => {
        try { const url = new URL(href); return ['threads.com', 'www.threads.com'].includes(url.hostname)
          ? url.pathname.match(/^\/@([A-Za-z0-9._]+)\/?$/)?.[1]?.toLowerCase() : null; }
        catch { return null; }
      }).filter(Boolean));
      return {site, state: owners.size === 1 ? 'accessible' : 'profile_required'};
    }
    if (site === 'x') {
      let verified = false;
      try { const url = new URL(detail.xProfile); verified = ['x.com', 'twitter.com'].includes(url.hostname)
        && /^\/[A-Za-z0-9_]+\/?$/.test(url.pathname); } catch {}
      return {site, state: verified ? 'accessible' : 'profile_required'};
    }
    if (site === 'naver_blog') {
      return {site, state: current.hostname === 'blog.naver.com' && current.pathname.toLowerCase().includes('postlist.naver')
        && Boolean(current.searchParams.get('blogId')) ? 'accessible' : 'profile_required'};
    }
    if (site === 'naver_kin') {
      return {site, state: current.hostname === 'kin.naver.com' && /^\/myinfo\//.test(current.pathname)
        ? 'accessible' : 'profile_required'};
    }
    return {site, state: 'unknown'};
  } catch { return {site, state: 'unknown'}; }
}

export async function checkSites(openPage, sites = Object.keys(SITES)) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({length: Math.min(2, sites.length)}, async () => {
    for (;;) {
      const index = next++;
      if (index >= sites.length) break;
      let page;
      try { page = await openPage(); results[index] = await probeSite(page, sites[index]); }
      catch { results[index] = {site: sites[index], state: 'unknown'}; }
      finally { await page?.close().catch(() => {}); }
    }
  }));
  return results;
}
