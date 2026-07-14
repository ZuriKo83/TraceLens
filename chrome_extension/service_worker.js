importScripts("background.js", "youtube_activity_collector.js", "youtube_live_chat_collector_v2.js", "youtube_live_chat_collector_v3.js", "youtube_live_chat_collector_v4.js", "youtube_live_chat_collector_v5.js", "youtube_live_chat_collector_v6.js", "youtube_comment_collector_v2.js", "youtube_comment_load_more_v3.js", "youtube_comment_collector_v4.js", "scan_channel_v2.js", "delete_worker_v2.js", "delete_batch_session.js", "delete_batch_api_bridge.js", "delete_batch_keepalive_v4.js", "delete_batch_two_pass_v16.js", "delete_batch_visual_mask_v14.js");

const stableCommentRunExtractor = runExtractor;
runExtractor = async function(tabId, platform, activityType, ownershipScope = "self_activity", accountContext = null) {
  const result = await stableCommentRunExtractor(tabId, platform, activityType, ownershipScope, accountContext);
  if (platform !== "youtube" || activityType !== "comment" || !Array.isArray(result?.items)) return result;

  for (const item of result.items) {
    const metadata = item?.metadata;
    if (!metadata || typeof metadata !== "object") continue;
    const commentId = String(metadata.comment_id || metadata.youtube_comment_id || "");
    if (!commentId.startsWith("youtube-comment-")) continue;
    delete metadata.comment_id;
    delete metadata.youtube_comment_id;
  }
  return result;
};
