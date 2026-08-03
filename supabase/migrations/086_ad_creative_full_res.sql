-- ─── Migration 086: full-resolution ad creatives for the CTWA drill-in ───────
-- Mirrors ensureAdSetTables() in backend/src/routes/marketing.js (runtime source
-- of truth). Idempotent.
--
-- WHY THIS EXISTS
-- The Click-to-WhatsApp drill-in showed a blurry smear where the ad creative
-- should be, and its play button never played anything. Both trace back to what
-- the Meta sync stored, not to the UI:
--
--   1. `campaign_ads.creative_thumbnail_url` is Meta's /adcreatives
--      `thumbnail_url`, which it ALWAYS returns at 64x64 (`stp=...p64x64...`).
--      Measured on the live ad 120251798993750169: 1,627 bytes, 64x64 px, being
--      stretched into a ~470px frame. Asking for a size does NOT help —
--      `thumbnail_url.width(1080).height(1080)` was verified against the live
--      token and comes back with the identical p64x64 URL. The field simply has
--      no larger form.
--
--   2. `ctwa_referrals.video_url` is not a video file. It is a watch PAGE
--      (https://www.facebook.com/story.php?story_fbid=...) returning
--      `content-type: text/html`, so <video src> could never play it and every
--      card silently fell through to the still image.
--
-- WHAT IS ACTUALLY REACHABLE (verified against the live ad account)
-- Full resolution exists, but under a different field per creative type — which
-- is why one column could not have been filled by simply asking for more fields:
--   * object_type=SHARE  -> `image_url` is full-res (27 of 33 live creatives).
--   * object_type=VIDEO  -> `video_id` -> GET /{video-id}?fields=thumbnails
--                           returns 1440x2560 stills (37 of 37 live creatives).
-- The MP4 itself is NOT reachable: requesting `source` on the video returns
-- `{"id": "..."}` with the field silently omitted (not an error). So inline
-- playback is impossible and the UI links out to `creative_watch_url` instead
-- of offering a play button that cannot work.

-- The best full-resolution still we can obtain, whatever the creative type.
-- Kept SEPARATE from creative_thumbnail_url rather than overwriting it: the
-- 64x64 stays useful as a table-row thumbnail (it is cheap and always present),
-- and keeping both means a failed video-thumbnail lookup degrades to the small
-- image instead of to nothing.
ALTER TABLE coexistence.campaign_ads ADD COLUMN IF NOT EXISTS creative_image_url TEXT;

-- Where a human can actually watch the ad, since we cannot embed it.
ALTER TABLE coexistence.campaign_ads ADD COLUMN IF NOT EXISTS creative_watch_url TEXT;

-- Kept so a later sync can re-resolve thumbnails without re-walking creatives,
-- and so it is obvious from the row alone why an ad has no image_url.
ALTER TABLE coexistence.campaign_ads ADD COLUMN IF NOT EXISTS creative_video_id TEXT;

COMMENT ON COLUMN coexistence.campaign_ads.creative_image_url IS
  'Full-resolution creative still. From adcreatives.image_url for SHARE creatives, or the preferred/largest video thumbnail for VIDEO creatives. creative_thumbnail_url is Metas 64x64 and cannot be enlarged.';
COMMENT ON COLUMN coexistence.campaign_ads.creative_watch_url IS
  'Facebook permalink for watching the ad video. Meta withholds the MP4 source, so the UI links out rather than embedding.';
