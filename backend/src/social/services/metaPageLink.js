const socialEnv = require('../env');
// "Receive Instagram DMs" settings card (Settings → Integrations → Instagram).
//
// Instagram DMs and button taps reach ForgeSocial through each Facebook Page that
// is linked to an Instagram account: the Page must be subscribed to the
// ForgeSocial Meta app. That needs an access token issued BY the ForgeSocial app
// (a system-user token generated with App = ForgeSocial). An admin pastes it in
// the card; we store it encrypted in app_settings and use it only to
//   - list the Pages (with their linked Instagram account),
//   - show whether each Page is linked to the ForgeSocial app,
//   - link / unlink a Page (POST / DELETE /{page-id}/subscribed_apps).
// The optional App Secret lets the webhook verify events Meta signs with the
// ForgeSocial app's own secret (see instagram.candidateSecrets).
//
// Nothing here touches the shared sample-wa-int token (META_ACCESS_TOKEN).

const pool = require('../db');
const fetch = require('../rateLimiter').gatedFetch;
const { encrypt, decrypt, maskSecret } = require('../util/crypto');

const GRAPH = 'https://graph.facebook.com/v21.0';
// This section's own Meta app. Read on every use so an ID saved in Settings →
// Integrations applies at once; never falls back to the old ForgeSocial app.
const appId = () => String(socialEnv.FORGESOCIAL_META_APP_ID || socialEnv.FACEBOOK_APP_ID || '');
const TOKEN_KEY = 'forgesocial_meta_token_enc';
const SECRET_KEY = 'forgesocial_meta_app_secret_enc';
const PAGE_FIELDS = 'messages,messaging_postbacks';

async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows[0]?.value || null;
}
async function setSetting(key, value) {
  if (value == null) { await pool.query('DELETE FROM app_settings WHERE key = $1', [key]); return; }
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2)
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
}

async function graph(path, token, { method = 'GET', params = {} } = {}) {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries({ ...params, access_token: token })) url.searchParams.set(k, v);
  const res = await fetch(url, { method });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Meta request failed');
  return data;
}

async function loadToken() {
  const enc = await getSetting(TOKEN_KEY);
  if (!enc) return null;
  try { return decrypt(enc); } catch (_) { return null; }
}

// ── App secret cache (the webhook signature check is synchronous) ──
let cachedSecret = null;
async function refreshSecretCache() {
  const enc = await getSetting(SECRET_KEY).catch(() => null);
  try { cachedSecret = enc ? decrypt(enc) : null; } catch (_) { cachedSecret = null; }
}
refreshSecretCache();
function appSecretForWebhook() { return cachedSecret; }

// ── public API ──────────────────────────────────────────────
async function status() {
  const token = await loadToken();
  const base = { appId: appId() || null, hasToken: !!token, hasSecret: !!cachedSecret, pages: [] };
  if (!token) return base;

  let app;
  try { app = await graph('app', token, { params: { fields: 'id,name' } }); }
  catch (e) { return { ...base, tokenError: `This key no longer works: ${e.message}` }; }
  base.tokenApp = { id: app.id, name: app.name };
  base.tokenPreview = maskSecret(token);
  if (!appId() || app.id !== appId()) return { ...base, wrongApp: true };

  const accounts = await graph('me/accounts', token, { params: { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 100 } });
  for (const p of accounts.data || []) {
    const page = { id: p.id, name: p.name, instagram: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username } : null, linked: false };
    try {
      const subs = await graph(`${p.id}/subscribed_apps`, p.access_token);
      const mine = (subs.data || []).find(a => String(a.id) === appId());
      page.linked = !!mine;
      page.fields = mine?.subscribed_fields || [];
    } catch (e) { page.error = e.message; }
    base.pages.push(page);
  }
  base.pages.sort((a, b) => (b.instagram ? 1 : 0) - (a.instagram ? 1 : 0) || a.name.localeCompare(b.name));
  return base;
}

async function saveToken(raw) {
  const token = String(raw || '').trim();
  if (!token) throw new Error('Paste the key first.');
  let app;
  try { app = await graph('app', token, { params: { fields: 'id,name' } }); }
  catch (e) { throw new Error(`Meta did not accept this key: ${e.message}`); }
  if (!appId()) throw new Error('Set the Meta App ID in the App credentials card first.');
  if (app.id !== appId()) throw new Error(`This key was made for the "${app.name}" app. Make a new one with App set to your ForgeGrowth Social app.`);
  await setSetting(TOKEN_KEY, encrypt(token));
  return { ok: true, appName: app.name };
}

async function saveSecret(raw) {
  const secret = String(raw || '').trim();
  if (!/^[a-f0-9]{32}$/i.test(secret)) throw new Error('The App Secret is 32 letters and numbers (Meta app → Settings → Basic → App secret).');
  await setSetting(SECRET_KEY, encrypt(secret));
  await refreshSecretCache();
  return { ok: true };
}

async function removeToken() {
  await setSetting(TOKEN_KEY, null);
  return { ok: true };
}

async function pageToken(pageId) {
  const token = await loadToken();
  if (!token) throw new Error('Add the ForgeSocial key first.');
  const p = await graph(String(pageId), token, { params: { fields: 'id,name,access_token' } });
  if (!p.access_token) throw new Error('This key cannot manage that Page. Check the Page is assigned to the system user.');
  return p.access_token;
}

async function linkPage(pageId) {
  const pt = await pageToken(pageId);
  await graph(`${pageId}/subscribed_apps`, pt, { method: 'POST', params: { subscribed_fields: PAGE_FIELDS } });
  return { ok: true };
}

async function unlinkPage(pageId) {
  const pt = await pageToken(pageId);
  await graph(`${pageId}/subscribed_apps`, pt, { method: 'DELETE' });   // removes only the ForgeSocial app
  return { ok: true };
}

// Page tokens minted from the saved key — one per Page the system user manages.
// Messenger (messenger.js) reads conversations with these when the Page is not
// otherwise connected. Empty when no key is saved.
async function pageTokens() {
  const token = await loadToken();
  if (!token) return [];
  const accounts = await graph('me/accounts', token, { params: { fields: 'id,name,access_token', limit: 100 } });
  return (accounts.data || []).filter(p => p.access_token)
    .map(p => ({ pageId: String(p.id), name: p.name || null, token: p.access_token }));
}

module.exports = { pageTokens, status, saveToken, saveSecret, removeToken, linkPage, unlinkPage, appSecretForWebhook };
