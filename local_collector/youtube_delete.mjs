import {SERVER, SITES} from './policy.mjs';

export async function deleteYouTubeComments(collector, transport, token, activityIds, notify = () => {}) {
  if (!Array.isArray(activityIds) || !activityIds.length || activityIds.length > 100
      || activityIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('삭제할 유튜브 댓글을 1~100개 선택하세요.');
  }
  const ids = [...new Set(activityIds)];
  const post = async (path, body) => {
    const response = await transport(`${SERVER}/api/collector/youtube/${path}`, {
      method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(typeof result.detail === 'string' ? result.detail : '삭제 요청을 처리하지 못했습니다.');
    return result;
  };
  const approved = await post('delete-targets', {activity_ids: ids});
  if (!Array.isArray(approved.targets) || approved.targets.length !== ids.length
      || approved.targets.some(target => !ids.includes(Number(target.id)) || !target.commentId || target.strictMatch !== true)) {
    throw new Error('서버의 삭제 대상 정보가 유효하지 않습니다.');
  }
  let tab;
  let confirmed = [];
  try {
    notify('선택한 댓글을 Google 내 활동에서 찾고 삭제합니다.');
    tab = await collector.tabs.create({url: SITES.youtube, active: false});
    const deletion = await collector.processYouTubePage(tab.id, approved.targets, {batchSize: 10, batchPauseMs: 1000});
    const clicked = new Set(deletion.clickedIds || []);
    if (!clicked.size) {
      return {ok: true, deleted_ids: [], removed_ids: [], failed: ids,
        lines: ['삭제한 댓글이 없습니다. 로그인 계정 또는 댓글 ID가 일치하지 않거나 삭제 요청이 실패했습니다.']};
    }
    notify('삭제 요청을 마쳤습니다. 페이지를 다시 읽어 삭제 결과를 확인합니다.');
    await collector.tabs.update(tab.id, {url: SITES.youtube});
    const verification = await collector.processYouTubePage(tab.id, approved.targets, null);
    if (verification.complete !== true) {
      return {ok: true, deleted_ids: [], removed_ids: [], failed: ids,
        lines: ['삭제 요청은 보냈지만 전체 확인을 마치지 못했습니다. 완료로 처리하지 않았습니다. 다시 조회해 확인하세요.']};
    }
    const found = new Set(verification.foundIds || []);
    // A missing target alone is never evidence of a deletion by this run.
    confirmed = approved.targets.filter(target => clicked.has(target.id) && !found.has(target.id)).map(target => Number(target.id));
    let removed = [];
    if (confirmed.length) {
      notify(`${confirmed.length}개 댓글 삭제를 확인했습니다. 대시보드 목록을 갱신합니다.`);
      try {
        const synced = await post('delete-confirm', {activity_ids: confirmed, receipt: approved.receipt, verification_complete: true});
        removed = synced.removed_ids;
      } catch (error) {
        return {ok: true, deleted_ids: confirmed, removed_ids: [], failed: ids.filter(id => !confirmed.includes(id)),
          sync_pending: true, lines: [`${confirmed.length}개 댓글 삭제 확인 · 목록 갱신 실패: ${error.message}`, '다시 조회하면 현재 기록으로 갱신됩니다.']};
      }
    }
    const failed = ids.filter(id => !confirmed.includes(id));
    return {ok: true, deleted_ids: confirmed, removed_ids: removed, failed,
      lines: [`${confirmed.length}개 삭제 확인 · ${failed.length}개 미완료`, ...(failed.length ? ['미완료 댓글은 목록에 남겼습니다. 로그인 계정과 원문을 확인하세요.'] : [])]};
  } catch (error) {
    throw new Error(`${error.message} 삭제 요청이 일부 진행되었을 수 있으므로 다시 조회해 확인하세요.`);
  } finally { if (tab) await collector.tabs.remove(tab.id).catch(() => {}); }
}
