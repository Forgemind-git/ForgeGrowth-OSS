// ============================================================
// auth.js — ForgeSocial Auth
// ============================================================
const { Router } = require('express');
const pool       = require('./db');

// ── Session bridge ───────────────────────────────────────────
// The Social section has NO login of its own: it runs inside ForgeGrowth, so the
// ForgeGrowth session cookie is the only credential. Each ForgeGrowth user is
// mirrored into this schema's `users` table under the SAME id (a "shadow" row),
// because ported tables reference users(id) (inbox assignment, activity log).
const fgAuth = require('../auth');
const fgPool = require('../db');
const { hasPermission } = require('../permissions');

// ── Database bootstrap ───────────────────────────────────────
async function ensureTables() {
  // Only create the schema when it is missing: Postgres checks the database's
  // CREATE privilege even for IF NOT EXISTS, and the app role may not hold it
  // (in production the schema is created once by the database owner).
  const { rows: haveSchema } = await pool.query(
    'SELECT 1 FROM pg_namespace WHERE nspname = $1', [pool.schema]);
  if (!haveSchema.length) await pool.query(`CREATE SCHEMA ${pool.schema}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            BIGSERIAL PRIMARY KEY,
      auth_id       UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
      email         TEXT UNIQUE NOT NULL,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
      avatar_url    TEXT,
      created_at    TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS platforms (
      id          BIGSERIAL PRIMARY KEY,
      key         TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      short       TEXT NOT NULL,
      color       TEXT NOT NULL,
      bg          TEXT NOT NULL,
      text_on_bg  TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS posts (
      id            BIGSERIAL PRIMARY KEY,
      platform_id   BIGINT NOT NULL REFERENCES platforms(id),
      external_id   TEXT,
      title         TEXT NOT NULL,
      caption       TEXT,
      type          TEXT NOT NULL,
      media_type    TEXT,
      topic         TEXT,
      date          DATE NOT NULL,
      views         BIGINT NOT NULL DEFAULT 0,
      engagements   BIGINT NOT NULL DEFAULT 0,
      likes         BIGINT NOT NULL DEFAULT 0,
      comments      BIGINT NOT NULL DEFAULT 0,
      shares        BIGINT NOT NULL DEFAULT 0,
      saves         BIGINT NOT NULL DEFAULT 0,
      clicks        BIGINT NOT NULL DEFAULT 0,
      score         INTEGER NOT NULL DEFAULT 0,
      permalink     TEXT,
      thumbnail_url TEXT,
      raw_data      JSONB,
      fetched_at    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT now(),
      UNIQUE(platform_id, external_id)
    );

    CREATE TABLE IF NOT EXISTS platform_stats (
      id              BIGSERIAL PRIMARY KEY,
      platform_id     BIGINT NOT NULL REFERENCES platforms(id),
      followers       BIGINT NOT NULL DEFAULT 0,
      growth          BIGINT NOT NULL DEFAULT 0,
      growth_pct      NUMERIC(5,2) NOT NULL DEFAULT 0,
      impressions     BIGINT NOT NULL DEFAULT 0,
      reach           BIGINT NOT NULL DEFAULT 0,
      engagement_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
      posts_count     INTEGER NOT NULL DEFAULT 0,
      period          TEXT NOT NULL DEFAULT '30D',
      recorded_at     TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sync_snapshots (
      id          BIGSERIAL PRIMARY KEY,
      platform    TEXT NOT NULL,
      period      TEXT NOT NULL DEFAULT '30D',
      data        JSONB NOT NULL,
      fetched_at  TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_sync_snapshots_platform_period_fetched
      ON sync_snapshots(platform, period, fetched_at DESC);

    -- Gap-free follower time-series: ONE absolute count per account per sample,
    -- written by the dedicated every-30-min sampler (1 cheap Graph call/account).
    -- Powers the Overview "Hours" followers trend without page-view dependence.
    CREATE TABLE IF NOT EXISTS follower_samples (
      id          BIGSERIAL PRIMARY KEY,
      platform    TEXT NOT NULL,
      account_id  TEXT NOT NULL,
      followers   BIGINT NOT NULL,
      sampled_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_follower_samples_lookup
      ON follower_samples(platform, account_id, sampled_at DESC);

    -- Per-post metric history: ONE row per post per IST day, written by the
    -- daily post-metrics logger straight from the posts table (which the
    -- syncs keep fresh) — zero extra API calls. Lifetime counters are stored
    -- as-of that day, so the per-day DELTA between consecutive rows is "how
    -- many views / likes this reel actually gained that day". This is what the
    -- per-post performance line charts read.
    CREATE TABLE IF NOT EXISTS post_metric_samples (
      id          BIGSERIAL PRIMARY KEY,
      platform    TEXT NOT NULL,
      account_key TEXT,
      external_id TEXT NOT NULL,
      post_id     BIGINT,
      day         DATE NOT NULL,
      views       BIGINT NOT NULL DEFAULT 0,
      likes       BIGINT NOT NULL DEFAULT 0,
      comments    BIGINT NOT NULL DEFAULT 0,
      shares      BIGINT NOT NULL DEFAULT 0,
      saves       BIGINT NOT NULL DEFAULT 0,
      engagements BIGINT NOT NULL DEFAULT 0,
      score       INTEGER,
      sampled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (platform, external_id, day)
    );

    CREATE INDEX IF NOT EXISTS idx_post_metric_samples_lookup
      ON post_metric_samples(platform, external_id, day);
    CREATE INDEX IF NOT EXISTS idx_post_metric_samples_day
      ON post_metric_samples(platform, day);
    CREATE INDEX IF NOT EXISTS idx_post_metric_samples_post
      ON post_metric_samples(post_id, day);

    CREATE TABLE IF NOT EXISTS sync_logs (
      id              BIGSERIAL PRIMARY KEY,
      platform        TEXT,
      status          TEXT NOT NULL CHECK (status IN ('started','success','error')),
      message         TEXT,
      records_synced  INTEGER DEFAULT 0,
      started_at      TIMESTAMPTZ DEFAULT now(),
      completed_at    TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS integrations (
      id          BIGSERIAL PRIMARY KEY,
      name        TEXT UNIQUE NOT NULL,
      platform    TEXT,
      status      TEXT NOT NULL DEFAULT 'disconnected',
      last_sync   TEXT,
      last_sync_at TIMESTAMPTZ,
      token       TEXT,
      account     TEXT,
      icon_bg     TEXT,
      icon_color  TEXT,
      created_at  TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS reports (
      id          BIGSERIAL PRIMARY KEY,
      report_type TEXT NOT NULL,
      label       TEXT NOT NULL,
      audience    BIGINT NOT NULL DEFAULT 0,
      growth      BIGINT NOT NULL DEFAULT 0,
      impressions BIGINT NOT NULL DEFAULT 0,
      engagement_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'ready',
      created_at  TIMESTAMPTZ DEFAULT now()
    );

    -- Media library — uploaded images/videos (assets for future posting flow)
    CREATE TABLE IF NOT EXISTS media (
      id          BIGSERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      caption     TEXT,
      cover_url   TEXT,
      cover_type  TEXT,                       -- 'image' | 'video'
      files       JSONB NOT NULL DEFAULT '[]',-- [{ url, name, size, mime }]
      file_count  INTEGER NOT NULL DEFAULT 0,
      total_size  BIGINT NOT NULL DEFAULT 0,
      format      TEXT,                        -- 'Image' | 'Video' | 'Mixed'
      uploaded_by TEXT,
      created_at  TIMESTAMPTZ DEFAULT now()
    );
    -- Accounts an asset belongs to ("My accounts" tokens: 'instagram|<id>' or a platform key). [] = shared.
    ALTER TABLE media ADD COLUMN IF NOT EXISTS accounts JSONB NOT NULL DEFAULT '[]';

    -- ── Instagram webhook ingestion (DMs + comments) ──────────
    -- Raw audit log of every webhook delivery (verified or rejected)
    CREATE TABLE IF NOT EXISTS instagram_webhook_events (
      id            BIGSERIAL PRIMARY KEY,
      object_type   TEXT,
      fields        TEXT,
      remote_ip     TEXT,
      signature_ok  BOOLEAN,
      payload       JSONB NOT NULL,
      received_at   TIMESTAMPTZ DEFAULT now(),
      created_at    TIMESTAMPTZ DEFAULT now()
    );

    -- Direct messages (Messenger-Platform format under entry[].messaging[])
    CREATE TABLE IF NOT EXISTS instagram_messages (
      id            BIGSERIAL PRIMARY KEY,
      mid           TEXT UNIQUE,
      account_id    TEXT,
      sender_id     TEXT,
      recipient_id  TEXT,
      direction     TEXT,
      text          TEXT,
      attachments   JSONB,
      raw           JSONB,
      ts            TIMESTAMPTZ,
      seen          BOOLEAN DEFAULT false,
      seen_at       TIMESTAMPTZ,
      read_by_us    BOOLEAN DEFAULT false,
      created_at    TIMESTAMPTZ DEFAULT now()
    );

    -- Comments (entry[].changes[] where field = 'comments')
    CREATE TABLE IF NOT EXISTS instagram_comments (
      id            BIGSERIAL PRIMARY KEY,
      comment_id    TEXT UNIQUE,
      account_id    TEXT,
      media_id      TEXT,
      parent_id     TEXT,
      from_id       TEXT,
      from_username TEXT,
      text          TEXT,
      raw           JSONB,
      ts            TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT now()
    );

    -- Registry of connected accounts (one row per entry.id seen, auto-discovered)
    CREATE TABLE IF NOT EXISTS instagram_accounts (
      account_id        TEXT PRIMARY KEY,
      name              TEXT,
      username          TEXT,
      page_id           TEXT,
      token             TEXT,
      token_expires_at  TIMESTAMPTZ,
      hidden            BOOLEAN DEFAULT false,   -- excluded from chips/composer/inbox (not deleted)
      first_seen        TIMESTAMPTZ DEFAULT now(),
      last_event        TIMESTAMPTZ
    );

    -- Meta data-deletion requests (compliance callback audit + status lookup)
    CREATE TABLE IF NOT EXISTS instagram_deletion_requests (
      code         TEXT PRIMARY KEY,
      user_id      TEXT,
      status       TEXT NOT NULL DEFAULT 'completed',
      requested_at TIMESTAMPTZ DEFAULT now()
    );

    -- Resolved IG user profiles (DM senders — webhook only gives the opaque IGSID)
    CREATE TABLE IF NOT EXISTS instagram_users (
      igsid       TEXT PRIMARY KEY,
      username    TEXT,
      name        TEXT,
      profile_pic TEXT,
      updated_at  TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_ig_messages_ts        ON instagram_messages(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_ig_comments_ts        ON instagram_comments(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_ig_webhook_events_rcv ON instagram_webhook_events(received_at DESC);

    -- Tag categories (admin-managed). Tags belong to one category; categories have
    -- no direct relation to contacts. id is a text slug so it stays stable across
    -- renames and is what gets written into contacts.tags JSONB arrays.
    CREATE TABLE IF NOT EXISTS categories (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  TIMESTAMPTZ DEFAULT now(),
      updated_at  TIMESTAMPTZ DEFAULT now()
    );

    -- Tags (admin-managed). Each tag has a name, hex color, and FK to a category.
    -- contact_id is NOT stored here; tag→contact attachment lives in contacts.tags JSONB.
    CREATE TABLE IF NOT EXISTS tags (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      color       TEXT NOT NULL DEFAULT '#dc2626',
      category_id TEXT REFERENCES categories(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ DEFAULT now(),
      updated_at  TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_tags_category ON tags(category_id);

    -- CRM-style contacts list — one row per (connected account, peer) pair, auto-upserted
    -- whenever a DM is ingested or sent. Identity (name/username/pic) is sourced from
    -- instagram_users (the API-resolution cache) at upsert time and refreshed as it
    -- improves. notes is user-editable; tags is reserved for Phase 3.
    CREATE TABLE IF NOT EXISTS contacts (
      id               BIGSERIAL PRIMARY KEY,
      platform         TEXT NOT NULL DEFAULT 'instagram',
      account_id       TEXT NOT NULL,              -- our connected IG account
      peer_id          TEXT NOT NULL,              -- the contact's IGSID
      name             TEXT,                       -- resolved name (or user-edited)
      username         TEXT,                       -- @handle (resolved)
      profile_pic      TEXT,                       -- local /api/uploads/ path or remote
      notes            TEXT,                       -- user-editable free text
      tags             JSONB NOT NULL DEFAULT '[]',-- tag ids array (Phase 3)
      first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_msg_preview TEXT,
      last_msg_dir     TEXT,                       -- 'incoming' | 'outgoing'
      message_count    BIGINT NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_uniq
      ON contacts(platform, account_id, peer_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_last_seen ON contacts(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contacts_account   ON contacts(account_id);

    -- MCP access (Settings → MCP Access): bearer API keys are stored as
    -- SHA-256 hashes only (plaintext shown once at creation); mcp_settings is
    -- a single row holding the master switch + per-capability toggles.
    CREATE TABLE IF NOT EXISTS mcp_api_keys (
      id           BIGSERIAL PRIMARY KEY,
      label        TEXT NOT NULL,
      key_prefix   TEXT NOT NULL,
      key_last4    TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,
      is_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
      last_used_at TIMESTAMPTZ,
      created_by   BIGINT,
      created_at   TIMESTAMPTZ DEFAULT now(),
      -- Account scope: NULL/NULL = the key sees every account (the default).
      -- When both are set the key is locked to exactly ONE account on ONE
      -- platform — every MCP tool it calls is filtered to that account.
      scope_platform   TEXT,
      scope_account_id TEXT
    );
    CREATE TABLE IF NOT EXISTS mcp_settings (
      id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      master_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      capabilities   JSONB NOT NULL DEFAULT '{"analytics":true,"content":true,"inbox":true,"contacts":true,"engage":false}'::jsonb,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`INSERT INTO mcp_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);

  // ── Migrations: add columns/constraints that may be missing on existing tables ──
  const migrationQueries = [
    `DO $$ BEGIN ALTER TABLE mcp_api_keys ADD COLUMN scope_platform TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE mcp_api_keys ADD COLUMN scope_account_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE instagram_messages ADD COLUMN account_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE instagram_messages ADD COLUMN seen BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE instagram_messages ADD COLUMN seen_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE instagram_messages ADD COLUMN read_by_us BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE instagram_comments ADD COLUMN account_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE instagram_accounts ADD COLUMN token TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE instagram_accounts ADD COLUMN hidden BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE instagram_accounts ADD COLUMN token_expires_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `CREATE INDEX IF NOT EXISTS idx_ig_messages_account ON instagram_messages(account_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ig_comments_account ON instagram_comments(account_id)`,
    `DO $$ BEGIN ALTER TABLE posts ADD COLUMN external_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE posts ADD COLUMN caption TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE posts ADD COLUMN media_type TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE posts ADD COLUMN engagements BIGINT NOT NULL DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE posts ADD COLUMN likes BIGINT NOT NULL DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE posts ADD COLUMN comments BIGINT NOT NULL DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE posts ADD COLUMN shares BIGINT NOT NULL DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE posts ADD COLUMN saves BIGINT NOT NULL DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE posts ADD COLUMN permalink TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE posts ADD COLUMN thumbnail_url TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE posts ADD COLUMN raw_data JSONB; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE posts ADD COLUMN account_key TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE sync_snapshots ADD COLUMN account_key TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE posts ADD COLUMN fetched_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE integrations ADD COLUMN last_sync_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE posts ALTER COLUMN topic DROP NOT NULL; EXCEPTION WHEN others THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE posts ADD CONSTRAINT posts_platform_external_id_unique UNIQUE (platform_id, external_id); EXCEPTION WHEN duplicate_table THEN NULL; END $$`,
    // Token auto-refresh health tracking (tokenService.js)
    `DO $$ BEGIN ALTER TABLE instagram_accounts ADD COLUMN last_refresh_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE instagram_accounts ADD COLUMN last_refresh_error TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE instagram_accounts ADD COLUMN needs_reconnect BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    // IG comment like counts (synced via syncComments, not available in webhooks)
    `DO $$ BEGIN ALTER TABLE instagram_comments ADD COLUMN like_count INTEGER; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `CREATE INDEX IF NOT EXISTS idx_ig_comments_parent ON instagram_comments(parent_id)`,
    // Repair: the IG comments edge lists replies as top-level entries too, and the
    // sync used to store them parentless before seeing them as replies. Re-link
    // every reply to the parent whose stored reply list names it (idempotent).
    `UPDATE instagram_comments ch SET parent_id = p.comment_id
       FROM instagram_comments p, jsonb_array_elements(COALESCE(p.raw->'replies'->'data', '[]'::jsonb)) r
      WHERE ch.parent_id IS NULL AND r->>'id' = ch.comment_id AND p.comment_id <> ch.comment_id`,
  ];
  for (const q of migrationQueries) {
    try { await pool.query(q); } catch (e) { /* ignore */ }
  }

  // Seed default platforms
  const platforms = [
    { key: 'instagram', name: 'Instagram', short: 'IG', color: '#C13584', bg: '#FBE8F2', textOnBg: '#7A1F52' },
  ];
  for (const p of platforms) {
    await pool.query(`
      INSERT INTO platforms (key, name, short, color, bg, text_on_bg)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (key) DO NOTHING
    `, [p.key, p.name, p.short, p.color, p.bg, p.textOnBg]);
  }

  // Seed default integrations
  // Seeded NOT connected. ForgeSocial shipped demo rows here ("connected · 12 min
  // ago"), and the three without a platform tester (GA, WhatsApp, HubSpot) are
  // never re-checked — on a fresh install they would claim a live connection.
  const integrations = [
    { name: 'Instagram', platform: 'instagram' },
    { name: 'Google Analytics', platform: null, iconBg: '#FFF3E0', iconColor: '#E65100' },
    { name: 'WhatsApp Business', platform: null, iconBg: '#E6F9ED', iconColor: '#25D366' },
    { name: 'CRM (HubSpot)', platform: null, iconBg: '#FFE5DA', iconColor: '#E65100' },
  ].map(i => ({ status: 'disconnected', lastSync: null, token: null, account: 'Not connected', ...i }));

  for (const i of integrations) {
    await pool.query(`
      INSERT INTO integrations (name, platform, status, last_sync, token, account, icon_bg, icon_color)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (name) DO NOTHING
    `, [i.name, i.platform, i.status, i.lastSync, i.token, i.account, i.iconBg || null, i.iconColor || null]);
  }

  // (No seeded admin: users are mirrored from ForgeGrowth on first request.)

  // Activity log (P4) — who did what, for team accountability. Written at the key
  // mutation sites (user changes, inbox assignment, comment deletes). Read-only audit trail in Settings → Activity.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id          BIGSERIAL PRIMARY KEY,
      user_id     BIGINT,
      user_name   TEXT,
      action      TEXT NOT NULL,      -- e.g. inbox.update | user.invite
      entity_type TEXT,               -- user | inbox_item | comment
      entity_id   TEXT,
      meta        JSONB,
      created_at  TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at DESC)`);

  // Saved replies / canned responses (P3) — reusable text snippets for the inbox.
  // {name} is substituted with the recipient/commenter name at insert time.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS canned_replies (
      id         BIGSERIAL PRIMARY KEY,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Inbox item metadata (P3) — assignment / status / internal note for any inbox
  // item, as a SIDE table so the comment-sync upserts never clobber it (and so DM
  // CONVERSATIONS, which aren't a single row, can carry meta too). item_type:
  // 'comment' (any platform, keyed by comment_id) or 'conversation' (keyed by
  // accountId|peerId). status: open | snoozed | resolved.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inbox_meta (
      id            BIGSERIAL PRIMARY KEY,
      item_type     TEXT NOT NULL,
      item_id       TEXT NOT NULL,
      platform      TEXT,
      assigned_to   BIGINT REFERENCES users(id) ON DELETE SET NULL,
      status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','snoozed','resolved')),
      internal_note TEXT,
      updated_at    TIMESTAMPTZ DEFAULT now(),
      updated_by    TEXT,
      UNIQUE (item_type, item_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inbox_meta_item ON inbox_meta(item_type, item_id)`);

  // Goals / KPI targets (P5) — track progress vs a target per metric/platform.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS goals (
      id         BIGSERIAL PRIMARY KEY,
      platform   TEXT,                          -- null = all platforms combined
      metric     TEXT NOT NULL,                 -- followers | engagement_rate | posts
      target     NUMERIC NOT NULL,
      label      TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Shareable report links (P5) — a public, read-only snapshot link for a report.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_shares (
      id         BIGSERIAL PRIMARY KEY,
      token      TEXT UNIQUE NOT NULL,
      platforms  TEXT NOT NULL,                 -- comma-separated platform keys
      from_date  DATE NOT NULL,
      to_date    DATE NOT NULL,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Notifications — in-app alert feed (new DMs/comments, token
  // health, insight anomalies). read_by is the set of user ids who've read it;
  // dedupe_key (UNIQUE) prevents the same event/daily-check notifying twice.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id          BIGSERIAL PRIMARY KEY,
      type        TEXT NOT NULL,                 -- dm|comment|token|anomaly
      severity    TEXT NOT NULL DEFAULT 'info',  -- info|good|warn|error
      title       TEXT NOT NULL,
      body        TEXT,
      link        TEXT,                          -- in-app hash route, e.g. #/social/inbox
      platform    TEXT,
      account_key TEXT,
      dedupe_key  TEXT UNIQUE,
      read_by     JSONB NOT NULL DEFAULT '[]',
      created_at  TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC)`);
  // meta carries deep-link targets (e.g. {kind:'dm',accountId,peerId} or
  // {kind:'comment',platform,accountId,mediaId}) so clicking opens the exact chat/post.
  await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS meta JSONB`);

  // ── AI Agents (LLM-driven Inbox auto-responders) + AI model credentials ──
  // ai_models: workspace-wide LLM provider credentials (API key AES-256-GCM
  // encrypted). agents reference one by FK. agent_tools/runs/run_steps mirror
  // the ForgeChat agent builder, wired to ForgeSocial's social channels.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_models (
      id                 BIGSERIAL PRIMARY KEY,
      provider           TEXT NOT NULL,              -- openai|anthropic|kimi|gemini
      label              TEXT,
      api_key_encrypted  TEXT,
      base_url           TEXT,
      available_models   JSONB NOT NULL DEFAULT '[]'::jsonb,
      enabled_models     JSONB,                      -- null = all enabled
      last_synced_at     TIMESTAMPTZ,
      last_sync_error    TEXT,
      created_at         TIMESTAMPTZ DEFAULT now(),
      updated_at         TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS agents (
      id                      BIGSERIAL PRIMARY KEY,
      name                    TEXT NOT NULL,
      description             TEXT,
      system_prompt           TEXT NOT NULL,
      ai_model_id             BIGINT REFERENCES ai_models(id) ON DELETE SET NULL,
      llm_model               TEXT,
      status                  TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active')),
      is_active               BOOLEAN NOT NULL DEFAULT false,
      platform                TEXT,                  -- instagram
      account_id              TEXT,
      account_label           TEXT,
      reply_dms               BOOLEAN NOT NULL DEFAULT false,  -- IG DMs (instagram only)
      reply_comments          BOOLEAN NOT NULL DEFAULT true,
      trigger_mode            TEXT NOT NULL DEFAULT 'any' CHECK (trigger_mode IN ('any','keyword')),
      trigger_keyword         TEXT,
      trigger_match_type      TEXT NOT NULL DEFAULT 'contains' CHECK (trigger_match_type IN ('exact','contains','starts')),
      trigger_case_sensitive  BOOLEAN NOT NULL DEFAULT false,
      context_window_messages INT NOT NULL DEFAULT 20,
      max_tool_iterations     INT NOT NULL DEFAULT 6,
      accept_images           BOOLEAN NOT NULL DEFAULT false,
      humanize                BOOLEAN NOT NULL DEFAULT true,   -- jittered delay + varied replies
      min_delay_sec           INT NOT NULL DEFAULT 5,
      max_delay_sec           INT NOT NULL DEFAULT 10,
      capabilities            JSONB NOT NULL DEFAULT '{"analytics":true,"content":true,"inbox":true,"contacts":false,"engage":false}'::jsonb,
      created_by              BIGINT,
      created_at              TIMESTAMPTZ DEFAULT now(),
      updated_at              TIMESTAMPTZ DEFAULT now()
    );
    -- At most one ACTIVE agent per channel (platform + account).
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_agent_channel
      ON agents(platform, account_id) WHERE is_active = TRUE;

    CREATE TABLE IF NOT EXISTS agent_tools (
      id          BIGSERIAL PRIMARY KEY,
      agent_id    BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      tool_type   TEXT NOT NULL,                 -- google_sheets | http_request
      config      JSONB NOT NULL,
      is_enabled  BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tools_agent ON agent_tools(agent_id);

    CREATE TABLE IF NOT EXISTS agent_runs (
      id                  BIGSERIAL PRIMARY KEY,
      agent_id            BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      platform            TEXT,
      channel             TEXT,                   -- dm | comment | test | manual
      account_id          TEXT,
      peer_id             TEXT,
      inbound_ref         TEXT,                   -- DM snippet / comment_id (dedupe key for sweeps)
      trigger_label       TEXT,
      status              TEXT NOT NULL DEFAULT 'running',  -- running|completed|failed|capped|skipped
      total_input_tokens  INT,
      total_output_tokens INT,
      final_reply         TEXT,
      error_message       TEXT,
      started_at          TIMESTAMPTZ DEFAULT now(),
      ended_at            TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_agent   ON agent_runs(agent_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_inbound ON agent_runs(inbound_ref);

    CREATE TABLE IF NOT EXISTS agent_run_steps (
      id            BIGSERIAL PRIMARY KEY,
      run_id        BIGINT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      step_index    INT,
      step_type     TEXT,                         -- llm_call | tool_call
      tool_type     TEXT,
      input         JSONB,
      output        JSONB,
      status        TEXT,
      latency_ms    INT,
      error_message TEXT,
      created_at    TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_run_steps_run ON agent_run_steps(run_id, step_index);
  `);
  // Session continuity window for keyword-triggered agents: once an agent
  // replies, follow-up messages within this window continue the conversation
  // without re-matching the keyword.
  await pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS trigger_session_minutes INT NOT NULL DEFAULT 30`);
  // transcribe_audio: when on, voice notes in DMs are transcribed via OpenAI
  // Whisper before the agent runs (accept_images already exists for vision).
  await pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS transcribe_audio BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS enable_handoff BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS handoff_instructions TEXT`);
  await pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS auto_tags JSONB NOT NULL DEFAULT '[]'`);

  // AI usage tracking: model/provider snapshot + media flags on each run
  await pool.query(`ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS model_name TEXT`);
  await pool.query(`ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS provider_name TEXT`);
  await pool.query(`ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS has_image BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS has_audio BOOLEAN NOT NULL DEFAULT false`);

  // Seed workspace settings
  const settings = [
    { key: 'workspace_name', value: 'My Workspace' },
    { key: 'workspace_handle', value: '' },
    { key: 'workspace_timezone', value: 'Asia/Kolkata (IST · UTC+5:30)' },
  ];
  for (const s of settings) {
    await pool.query(`
      INSERT INTO app_settings (key, value) VALUES ($1, $2)
      ON CONFLICT (key) DO NOTHING
    `, [s.key, s.value]);
  }

  // Seed the rule-based content-theme map (used by categorize.js to fill
  // posts.topic from captions + hashtags — zero LLM cost). Admin-editable later;
  // ON CONFLICT DO NOTHING preserves any edits. Each theme → keyword/hashtag list.
  const DEFAULT_CONTENT_THEMES = {
    'AI Agents':      ['agent', 'agents', 'mcp', 'claude', 'llm', 'gpt', 'copilot', 'autonomous', 'chatbot'],
    'Automation':     ['automation', 'automate', 'n8n', 'workflow', 'zapier', 'make.com', 'no-code', 'nocode', 'integration'],
    'Product Demo':   ['demo', 'launch', 'feature', 'release', 'update', 'introducing', 'now available', 'sneak peek'],
    'Tutorial':       ['tutorial', 'how to', 'howto', 'guide', 'step by step', 'learn', 'tips', 'walkthrough'],
    'Case Study':     ['case study', 'results', 'roi', 'success', 'customer', 'client', 'testimonial', 'before and after'],
    'Behind the Scenes': ['behind the scenes', 'bts', 'team', 'culture', 'day in', 'building', 'journey', 'we built'],
    'Industry News':  ['news', 'trend', 'trending', 'announcement', 'report', 'study finds', 'breaking'],
    'Engagement':     ['giveaway', 'poll', 'question', 'comment below', 'tag a', 'contest', 'ask me'],
  };
  await pool.query(`
    INSERT INTO app_settings (key, value) VALUES ('content_themes', $1)
    ON CONFLICT (key) DO NOTHING
  `, [JSON.stringify(DEFAULT_CONTENT_THEMES)]);

  // Notification preferences (workspace-global). Each key gates whether emit()
  // records that notification type; email_digest is the optional daily email.
  const DEFAULT_NOTIF_PREFS = {
    dm: true, comment: true,
    token: true, anomaly: true, email_digest: false,
  };
  await pool.query(`
    INSERT INTO app_settings (key, value) VALUES ('notification_prefs', $1)
    ON CONFLICT (key) DO NOTHING
  `, [JSON.stringify(DEFAULT_NOTIF_PREFS)]);

  // ── Contacts backfill ──────────────────────────────────────
  // One-shot population from existing IG messages so the Contacts page is useful
  // immediately (without waiting for new DMs to flow in). Idempotent via ON CONFLICT,
  // so safe to re-run on every boot. Identity (name/username/pic) is LEFT JOINed
  // from instagram_users which already caches it from the Graph API.
  try {
    await pool.query(`
      INSERT INTO contacts (platform, account_id, peer_id, name, username, profile_pic,
                            first_seen_at, last_seen_at, last_msg_preview, last_msg_dir, message_count)
      SELECT 'instagram',
             m.account_id,
             CASE WHEN m.direction = 'incoming' THEN m.sender_id ELSE m.recipient_id END AS peer_id,
             u.name, u.username, u.profile_pic,
             MIN(m.ts) AS first_seen_at,
             MAX(m.ts) AS last_seen_at,
             (ARRAY_AGG(m.text ORDER BY m.ts DESC) FILTER (WHERE m.text IS NOT NULL))[1] AS last_msg_preview,
             (ARRAY_AGG(m.direction ORDER BY m.ts DESC))[1] AS last_msg_dir,
             COUNT(*) AS message_count
        FROM instagram_messages m
        LEFT JOIN instagram_users u
          ON u.igsid = CASE WHEN m.direction = 'incoming' THEN m.sender_id ELSE m.recipient_id END
       WHERE m.account_id IS NOT NULL
         AND (CASE WHEN m.direction = 'incoming' THEN m.sender_id ELSE m.recipient_id END) IS NOT NULL
       GROUP BY m.account_id, peer_id, u.name, u.username, u.profile_pic
      ON CONFLICT (platform, account_id, peer_id) DO UPDATE SET
        first_seen_at = LEAST(contacts.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at  = GREATEST(contacts.last_seen_at, EXCLUDED.last_seen_at),
        message_count = EXCLUDED.message_count,
        last_msg_preview = COALESCE(EXCLUDED.last_msg_preview, contacts.last_msg_preview),
        last_msg_dir     = COALESCE(EXCLUDED.last_msg_dir,     contacts.last_msg_dir),
        name        = COALESCE(EXCLUDED.name,        contacts.name),
        username    = COALESCE(EXCLUDED.username,    contacts.username),
        profile_pic = COALESCE(EXCLUDED.profile_pic, contacts.profile_pic)
    `);
  } catch (e) { console.error('Contacts backfill failed (non-fatal):', e.message); }
}

// ── Auth middleware ──────────────────────────────────────────
// ForgeGrowth cookie → page permission 'social' → shadow user row → req.user in
// the shape the ported routes expect ({ id, email, role: admin|member, displayName }).
const SHADOW_TTL_MS = 5 * 60 * 1000;
const shadowSeen = new Map();   // userId -> { at, sig }

async function ensureShadowUser(u) {
  const email = (u.email && String(u.email).trim()) || `user-${u.id}@forgegrowth.local`;
  const displayName = u.display_name || u.username || email;
  const role = u.role === 'admin' ? 'admin' : 'member';
  const sig = `${email}|${displayName}|${role}`;
  const hit = shadowSeen.get(u.id);
  if (hit && hit.sig === sig && Date.now() - hit.at < SHADOW_TTL_MS) return;
  await pool.query(
    `INSERT INTO users (id, email, display_name, password_hash, role)
     VALUES ($1, $2, $3, '!forgegrowth-session', $4)
     ON CONFLICT (id) DO UPDATE
       SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, role = EXCLUDED.role`,
    [u.id, email, displayName, role]);
  shadowSeen.set(u.id, { at: Date.now(), sig });
}

function authMiddleware(req, res, next) {
  fgAuth.authMiddleware(req, res, async () => {
    try {
      const { rows } = await fgPool.query(
        `SELECT id, username, email, display_name, role, permissions, is_active
           FROM coexistence.forgecrm_users WHERE id = $1`, [req.user.id]);
      const u = rows[0];
      if (!u || u.is_active === false) return res.status(401).json({ error: 'Not authenticated' });
      if (!hasPermission({ role: u.role, permissions: u.permissions }, 'social')) {
        return res.status(403).json({ error: 'You do not have access to Social' });
      }
      await ensureShadowUser(u);
      req.user = {
        id: Number(u.id),
        email: u.email,
        role: u.role === 'admin' ? 'admin' : 'member',
        displayName: u.display_name || u.username,
        forgegrowthRole: u.role,
      };
      next();
    } catch (err) {
      console.error('[social] auth bridge error:', err.message);
      res.status(500).json({ error: 'Could not check your access to Social' });
    }
  });
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ── Auth routes ──────────────────────────────────────────────
// Login/logout belong to ForgeGrowth. Only /me survives so the ported frontend
// can still ask who is signed in.
const router = Router();
router.get('/me', authMiddleware, (req, res) => res.json({ user: req.user }));

module.exports = { router, authMiddleware, adminOnly, ensureTables };
