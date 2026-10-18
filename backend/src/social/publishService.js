const socialEnv = require('./env');
// ============================================================
// publishService.js — Outbound posting: validation, scheduler worker,
// and the per-platform PUBLISH ADAPTER seam.
//
// All five platforms publish for REAL now — each adapter calls the platform
// module's publisher (the same rate-gated Graph/API path the rest of the app
// uses). Going live per platform still requires the account to be RECONNECTED
// with the publishing OAuth scope (added to each module's consent URL), and
// production use by non-admins needs Meta/Google/LinkedIn App Review.
//
// Publish scopes per platform: IG instagram_business_content_publish, FB
// pages_manage_posts, YT youtube.upload, Threads threads_content_publish,
// LinkedIn w_organization_social.
// ============================================================
const pool = require('./db');
const { forgeCommandNotify } = require('./forgeCommandNotify');
const fs = require('fs');
const path = require('path');
const instagram = require('./instagram');
const facebook = require('./facebook');
const youtube = require('./youtube');
const threads = require('./threads');
const linkedin = require('./linkedin');
const notify = require('./notificationService');

const UPLOADS_DIR = socialEnv.UPLOADS_DIR || '/app/uploads';
const MAX_ATTEMPTS = 3;

const cap = (s) => s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s;
const snippet = (s) => { s = (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim(); return s.length > 80 ? s.slice(0, 79) + '…' : s; };

// ── Validation rules (source of truth shared with the create handler) ──
// post_type ids MUST stay in sync with the frontend POST_TYPES config
// (frontend/src/data/postTypes.js). mediaRequired/requiredDetails are per type.
const PUBLISH_RULES = {
  instagram: {
    post:      { mediaRequired: true },
    reel:      { mediaRequired: true },
    story:     { mediaRequired: true },
    highlight: { mediaRequired: true },
  },
  youtube: {
    video:     { mediaRequired: true,  requiredDetails: ['title'] },
    short:     { mediaRequired: true,  requiredDetails: ['title'] },
    community: { mediaRequired: false },
  },
  facebook: {
    post:      { mediaRequired: false },
    reel:      { mediaRequired: true },
    story:     { mediaRequired: true },
  },
  threads: {
    text:      { mediaRequired: false },
    image:     { mediaRequired: true },
    carousel:  { mediaRequired: true },
  },
  linkedin: {
    post:      { mediaRequired: false },
    article:   { mediaRequired: false, requiredDetails: ['title'] },
    document:  { mediaRequired: true,  requiredDetails: ['title'] },
    poll:      { mediaRequired: false, requiredDetails: ['pollQuestion'] },
  },
};

// Validate a create-job request body. Returns an error string, or null if OK.
// `media` here is the RESOLVED snapshot array (after the handler maps mediaIds).
function validatePublishJob(body, media) {
  const b = body || {};
  const rules = PUBLISH_RULES[b.platform];
  if (!rules) return 'Unknown or unsupported platform';
  const rule = rules[b.postType];
  if (!rule) return `Invalid post type "${b.postType}" for ${b.platform}`;

  const mediaArr = Array.isArray(media) ? media : [];
  if (rule.mediaRequired && !mediaArr.length)
    return `${b.platform} ${b.postType} requires at least one media file`;
  if (!rule.mediaRequired && !mediaArr.length && !(b.caption || '').trim() &&
      !(b.details && Object.values(b.details).some(v => typeof v === 'string' && v.trim())))
    return 'Post requires text or media';

  for (const f of (rule.requiredDetails || [])) {
    const v = b.details ? b.details[f] : undefined;
    if (v == null || String(v).trim() === '') return `${b.platform} ${b.postType} requires "${f}"`;
  }

  if (b.platform === 'instagram' && !b.accountId)
    return 'Select an Instagram account to publish to';

  if (b.scheduleType === 'scheduled') {
    const t = new Date(b.scheduledAt).getTime();
    if (!t || Number.isNaN(t)) return 'A valid scheduled time is required';
    if (t < Date.now() - 60000) return 'Scheduled time must be in the future';
  }
  return null;
}

// ── Per-platform publish adapters (LIVE) ──────────────────────
// Each returns { ok, simulated:false, externalId, permalink? }. Throw to fail the job.

// Soft check: warn if a referenced upload is gone (platforms fetch it by URL).
function _mediaFilesPresent(job) {
  for (const m of (job.media || [])) {
    if (typeof m.url === 'string' && m.url.startsWith('/api/social/uploads/')) {
      const fpath = path.join(UPLOADS_DIR, path.basename(m.url));
      if (!fs.existsSync(fpath)) {
        console.warn(`[publish] job ${job.id}: media file missing on disk: ${m.url}`);
      }
    }
  }
}

// LIVE: real two-step Graph publish via instagram.publishContent (graph.instagram.com,
// scope instagram_business_content_publish). Instagram fetches the media over the
// public /api/uploads URL, so files must be present on disk and reachable.
async function publishInstagram(job) {
  if (!job.media.length && job.post_type !== 'highlight')
    throw new Error('Instagram requires at least one media file');
  _mediaFilesPresent(job);
  return instagram.publishContent(job);
}

// LIVE: YouTube Data API v3 videos.insert (resumable upload from disk,
// scope youtube.upload). Community posts aren't API-publishable (throws).
async function publishYouTube(job) {
  if (!job.media.length)    throw new Error('YouTube requires a video file');
  if (!job.details?.title)  throw new Error('YouTube requires a title');
  _mediaFilesPresent(job);
  return youtube.publishVideo(job);
}

// LIVE: Facebook Page publish (feed/photos/videos/reels/stories,
// scope pages_manage_posts). Media fetched from the public /api/uploads URL.
async function publishFacebook(job) {
  if (!job.caption && !job.media.length) throw new Error('Facebook post requires text or media');
  _mediaFilesPresent(job);
  return facebook.publishContent(job);
}

// LIVE: Threads two-step create→publish (scope threads_content_publish).
async function publishThreads(job) {
  if (!job.caption && !job.media.length) throw new Error('Threads post requires text or media');
  _mediaFilesPresent(job);
  return threads.publishContent(job);
}

// LIVE: LinkedIn company-Page UGC post (scope w_organization_social).
async function publishLinkedIn(job) {
  if (!job.caption && !job.media.length && !job.details?.title)
    throw new Error('LinkedIn post requires text or media');
  _mediaFilesPresent(job);
  return linkedin.publishContent(job);
}

const ADAPTERS = {
  instagram: publishInstagram,
  youtube:   publishYouTube,
  facebook:  publishFacebook,
  threads:   publishThreads,
  linkedin:  publishLinkedIn,
};

async function publishJob(job) {
  const fn = ADAPTERS[job.platform];
  if (!fn) throw new Error(`Unsupported platform: ${job.platform}`);
  return fn(job);
}

// Delete an ALREADY-PUBLISHED post from its platform. Returns
// { platformDeleted: boolean, reason?: string }. Most networks here can't be
// deleted via API yet, so this reports honestly rather than pretending.
async function deletePublishedPost(job) {
  if (!job || job.simulated === true || !job.external_post_id) {
    return { platformDeleted: false, reason: 'No live post to remove from the platform.' };
  }
  if (job.platform === 'instagram') {
    // Verified live: Instagram's Graph API returns "Unsupported delete request" for
    // media — there is NO endpoint to delete a post. It can only be removed in the
    // Instagram app; the next sync then prunes it from ForgeSocial automatically.
    return { platformDeleted: false, reason: "Instagram doesn't allow deleting posts via API — remove it in the Instagram app and ForgeSocial will sync it out automatically." };
  }
  // FB / YT / Threads / LinkedIn all support deleting an own post via API.
  const deleters = {
    facebook: () => facebook.deletePost(job.external_post_id, job.account_id),
    youtube:  () => youtube.deletePost(job.external_post_id, job.account_id),
    threads:  () => threads.deletePost(job.external_post_id, job.account_id),
    linkedin: () => linkedin.deletePost(job.external_post_id, job.account_id),
  };
  const del = deleters[job.platform];
  if (!del) return { platformDeleted: false, reason: `Deleting ${job.platform} posts via API isn't supported.` };
  try {
    await del();
    return { platformDeleted: true };
  } catch (e) {
    return { platformDeleted: false, reason: e.message || `Could not delete the ${job.platform} post via API.` };
  }
}

// ── Worker: claim → publish → record ──────────────────────────

// Atomic claim: flip queued→publishing only if still queued. Returns the row
// if WE won the claim (so the immediate-fire path and the cron can't double-fire).
async function _claimJob(id) {
  const { rows } = await pool.query(
    `UPDATE publish_jobs
        SET status = 'publishing', attempts = attempts + 1
      WHERE id = $1 AND status = 'queued'
      RETURNING *`,
    [id]
  );
  return rows[0];
}

async function processJob(id) {
  const job = await _claimJob(id);
  if (!job) return; // already claimed, canceled, or gone
  try {
    const r = await publishJob(job);
    await pool.query(
      `UPDATE publish_jobs
          SET status='published', external_post_id=$2, result=$3,
              simulated=$4, last_error=NULL, published_at=now()
        WHERE id=$1`,
      [id, r.externalId || null, JSON.stringify(r), r.simulated !== false]
    );
    notify.emit('publish_published', {
      title: `Published to ${cap(job.platform)}`,
      body: `${job.account_label || job.platform}: ${snippet(job.caption) || job.post_type}`,
      link: '#/social/publish', severity: 'good', platform: job.platform, accountKey: job.account_id,
      dedupeKey: `publish_published:${id}`,
    });
    // Notify ForgeCommand about the published post (fire-and-forget).
    forgeCommandNotify('post_published', {
      post_id: String(id),
      platform: job.platform,
      caption_preview: snippet(job.caption) || job.post_type || '',
      account: job.account_label || job.platform,
    });
  } catch (err) {
    // Retry until MAX_ATTEMPTS, then fail permanently.
    const retry = job.attempts < MAX_ATTEMPTS;
    await pool.query(
      `UPDATE publish_jobs
          SET status=$2, last_error=$3, result=$4
        WHERE id=$1`,
      [id, retry ? 'queued' : 'failed', err.message,
       JSON.stringify({ ok: false, error: err.message })]
    );
    if (!retry) notify.emit('publish_failed', {
      title: `Publish failed — ${cap(job.platform)}`,
      body: `${job.account_label || job.platform}: ${err.message}`,
      link: '#/social/publish', severity: 'error', platform: job.platform, accountKey: job.account_id,
      dedupeKey: `publish_failed:${id}`,
    });
  }
}

// Cron tick — publish all jobs that are due.
async function runDueJobs() {
  const { rows: due } = await pool.query(
    `SELECT id FROM publish_jobs
      WHERE status = 'queued' AND scheduled_at <= now()
      ORDER BY scheduled_at ASC
      LIMIT 25`
  );
  for (const { id } of due) {
    await processJob(id).catch(err =>
      console.error(`[publish] job ${id} failed:`, err.message));
  }
}

// Immediate jobs: fire right after insert; the cron is the safety net.
function fireSoon(id) {
  setTimeout(() => { processJob(id).catch(() => {}); }, 500);
}

// Crash recovery: reset jobs orphaned mid-publish back to queued so the worker retries.
async function reapStalePublishing() {
  await pool.query(
    `UPDATE publish_jobs
        SET status='queued'
      WHERE status='publishing'
        AND attempts < $1
        AND created_at < now() - interval '10 minutes'`,
    [MAX_ATTEMPTS]
  );
}

module.exports = {
  publishJob, deletePublishedPost, processJob, runDueJobs, fireSoon, reapStalePublishing,
  validatePublishJob, PUBLISH_RULES,
};
