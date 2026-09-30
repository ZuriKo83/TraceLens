(() => {
  const status = document.getElementById('delete-operation-status');
  const dialog = document.getElementById('youtube-delete-dialog');
  let pending = [];
  let deleting = false;
  const finish = () => window.dispatchEvent(new CustomEvent('TRACELENS_PC_DELETE_FINISHED'));
  function showStatus(text, state = '') {
    status.hidden = false;
    status.className = `delete-operation-status ${state}`;
    status.textContent = text;
  }
  window.addEventListener('TRACELENS_PC_EVENT', event => {
    if (deleting && event.detail?.type === 'DELETE_PROGRESS') showStatus(event.detail.text);
  });
  window.addEventListener('TRACELENS_PC_DELETE_REQUEST', () => {
    if (deleting) return;
    pending = [...document.querySelectorAll('.delete-activity-checkbox:checked:not(:disabled)')].map(input => Number(input.value));
    if (!pending.length || pending.length > 100) { finish(); return; }
    const preview = document.getElementById('youtube-delete-preview');
    preview.replaceChildren();
    for (const id of pending.slice(0, 5)) {
      const row = document.querySelector(`[data-activity-id="${id}"]`);
      const item = document.createElement('li');
      item.textContent = [row?.querySelector('h3')?.textContent, row?.querySelector('p')?.textContent].filter(Boolean).join(' · ').slice(0, 240);
      preview.append(item);
    }
    document.getElementById('youtube-delete-summary').textContent = `${pending.length}개 선택${pending.length > 5 ? ' · 처음 5개 미리보기' : ''}. 수집할 때 사용한 Google 계정으로 로그인되어 있어야 합니다.`;
    dialog.showModal();
  });
  dialog.addEventListener('close', () => { if (!deleting) { pending = []; finish(); } });
  document.getElementById('youtube-confirm-delete').addEventListener('click', async () => {
    if (deleting || !pending.length) return;
    const ids = pending;
    pending = [];
    deleting = true;
    dialog.close();
    showStatus(`${ids.length}개 댓글을 확인하고 삭제합니다. 이 탭과 수집기를 닫지 마세요.`);
    status.scrollIntoView({behavior: 'smooth', block: 'center'});
    try {
      const token = document.querySelector('meta[name="tracelens-extension-token"]').content;
      const result = await window.traceLensLocal({type: 'DELETE_YOUTUBE', activityIds: ids, token});
      if (!result.ok) throw new Error(result.error || '삭제 결과를 확인하지 못했습니다.');
      for (const id of result.removed_ids) document.querySelector(`[data-activity-id="${id}"]`)?.remove();
      showStatus(result.lines.join('\n'), result.failed.length || result.sync_pending ? 'error' : 'success');
    } catch (error) { showStatus(error.message, 'error'); }
    finally { deleting = false; finish(); }
  });
  (async () => {
    try {
      if (typeof window.traceLensLocal !== 'function') throw new Error('시작 메뉴에서 TraceLens를 실행한 뒤 전용 브라우저의 삭제 페이지를 이용하세요.');
      await window.traceLensLocal({type: 'PING'});
      showStatus('PC 수집기 연결됨 · 댓글을 선택해 삭제하세요.');
      window.dispatchEvent(new CustomEvent('TRACELENS_PC_DELETE_READY'));
    } catch (error) { showStatus(error.message, 'error'); }
  })();
})();
