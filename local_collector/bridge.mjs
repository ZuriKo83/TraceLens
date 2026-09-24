// Runs only on the dashboard in the browser launched by this collector.
export function installBridge({server}) {
  if (location.origin !== server || window !== window.top) return;
  document.addEventListener('DOMContentLoaded', () => {
    if (location.pathname === '/delete-credits/purchase') {
      const notice = document.createElement('p');
      notice.className = 'alert';
      notice.textContent = '로컬 수집기는 현재 조회와 저장을 지원합니다. 원본 사이트에서의 삭제는 아직 지원하지 않습니다.';
      document.querySelector('main')?.prepend(notice);
      return;
    }
    if (location.pathname !== '/app') return;
    const token = document.querySelector('meta[name="tracelens-extension-token"]')?.content;
    if (!token) return;
    const publish = detail => window.dispatchEvent(new CustomEvent('TRACELENS_EXTENSION_EVENT', {detail}));
    const connect = async () => {
      try {
        const result = await window.traceLensLocal({type: 'PING'});
        document.documentElement.dataset.tracelensLocalCollector = result.browserName;
        publish({type: 'CONNECTION', connected: true, local: true, browserName: result.browserName});
        document.getElementById('local-site-logins')?.removeAttribute('hidden');
      } catch { publish({type: 'CONNECTION', connected: false, error: '로컬 수집기를 다시 실행하세요.'}); }
    };
    window.addEventListener('TRACELENS_WEB_COMMAND', async event => {
      const command = event.detail || {};
      if (command.type === 'PING') { await connect(); return; }
      if (command.type !== 'START_SCAN') return;
      publish({type: 'SCAN_STARTED'});
      try {
        const result = await window.traceLensLocal({type: 'START_SCAN', sites: command.sites, token});
        publish({type: 'SCAN_RESULT', ...result});
      } catch (error) { publish({type: 'SCAN_RESULT', ok: false, error: error.message}); }
    });
    document.querySelectorAll('[data-local-login]').forEach(button => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        const status = document.getElementById('local-login-status');
        try {
          await window.traceLensLocal({type: 'OPEN_SITE', sites: [button.dataset.localLogin], token});
          status.textContent = '열린 사이트에서 직접 로그인한 뒤 이 대시보드로 돌아와 조회하세요.';
        } catch (error) { status.textContent = error.message; }
        finally { button.disabled = false; }
      });
    });
    connect();
  });
}
