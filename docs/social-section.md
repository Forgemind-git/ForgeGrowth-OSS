# Instagram (the Social section)

The **Social** header tab manages your Instagram accounts from inside Forge Growth: Overview,
Content Library (synced posts + media), Inbox, Contacts and Automations (DM automations, flows, AI
agents and their activity). Its settings live in the one Settings page: **Instagram** (connection,
privacy policy), **AI models → Instagram AI (OpenRouter)**, **Tags** and **Fields** (the Instagram
sections), **General → Instagram notifications** and the **Activity log**.

## How it is wired

| Piece | Where |
|---|---|
| Backend | `backend/src/social/` — an Express sub-app, mounted at `/api/social` in `src/index.js` |
| Database | ForgeGrowth's database, schema **`social`** (created at boot) |
| Login | ForgeGrowth's session. No separate Social login. Access = page key **`social`** (admins always; grant others in Settings → Team) |
| Frontend | `frontend/src/social/` — routes `#/social/...`, styles scoped under `.social-root` |
| Public pages | `#/social-privacy` (privacy policy) and `#/social-share/<token>` (shared report) |
| Background jobs | **Off** until `SOCIAL_JOBS_ENABLED=1` |
| Uploads | `/app/uploads/social` (inside the `forgegrowth-uploads` volume), served at `/api/social/uploads/` |

Only the `social` page key, the router mount and the header/sidebar entries
touch existing ForgeGrowth files.

## Environment

Every Social setting is read as **`SOCIAL_<NAME>`**. Only the database and Redis
connection fall back to ForgeGrowth's own values. This is deliberate: ForgeGrowth
and the Social section use many of the same variable names with different
meanings, and the Social section can run on its **own Meta app**.

Required:

| Variable | Purpose |
|---|---|
| `SOCIAL_ENCRYPTION_KEY` | Encrypts stored secrets (AI keys, Instagram tokens). Saving any secret is refused until it is set. **The installer generates it** (3.1.1 and later; re-run `./install.sh` on an older install). By hand: a long random string, `openssl rand -hex 32`. Never change it once secrets are saved. |
| `SOCIAL_PUBLIC_BASE_URL` | Defaults to this install's own address (`https://$TLS_DOMAIN`, else the first `CORS_ORIGIN`). The OAuth callback is `<base>/api/social/instagram/oauth/callback`. |

The Meta app (Instagram, Webhooks). These can also be entered in
Settings → Instagram → Connection → App credentials instead of `.env`:

| Variable | Value |
|---|---|
| `SOCIAL_FACEBOOK_APP_ID` / `SOCIAL_FACEBOOK_APP_SECRET` | The app's App ID / App Secret |
| `SOCIAL_INSTAGRAM_OAUTH_CLIENT_ID` / `SOCIAL_INSTAGRAM_OAUTH_CLIENT_SECRET` | Instagram API with Instagram Login — the app's Instagram App ID / secret |
| `SOCIAL_INSTAGRAM_APP_SECRET` | The Instagram app secret (verifies webhook signatures) |
| `SOCIAL_INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | Any random string; paste the same into the app's webhook setup |
| `SOCIAL_META_APP_ID` | The app's App ID (used to check saved page tokens belong to it) |

Optional: `SOCIAL_REDIS_URL` (defaults to ForgeGrowth's), `SOCIAL_SYNC_INTERVAL_MINUTES` (30).

### URLs to register in the Meta app

- Instagram OAuth redirect: `https://<your-host>/api/social/instagram/oauth/callback`
- Webhook callback (Instagram): `https://<your-host>/api/social/instagram/webhook`
- Privacy policy URL: `https://<your-host>/#/social-privacy`

## Turning it on

1. Check `SOCIAL_ENCRYPTION_KEY` is set in `.env` — the installer generates it; if it is empty,
   re-run `./install.sh`. The `social` schema is created on boot.
2. Settings → Instagram → Connection: enter the app credentials and connect each
   account.
3. Set `SOCIAL_JOBS_ENABLED=1` and restart the backend to start syncing.

## Limitations

- Social has no separate users: people are Forge Growth users (Settings → Team
  lists everyone with Social access).
- Social has no MCP server of its own: its `social_*` tools are on Forge Growth's
  one MCP server (`/api/mcp`), switched on under Settings → Claude & MCP.
- Social's AI features use their own OpenRouter key, set under
  Settings → AI models → Instagram AI (OpenRouter).
