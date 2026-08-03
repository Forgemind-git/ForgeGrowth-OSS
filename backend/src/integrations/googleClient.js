// Google OAuth + REST helpers for the Integrations feature.
//
// Why no `googleapis` SDK? It pulls ~50MB of generated clients we don't need
// — we only call ~3 endpoints (Sheets append, Calendar insert, Gmail send).
// Direct REST + fetch keeps the image small and the dependency surface tight.
//
// Tokens flow:
//   1. Admin saves Client ID/Secret/Redirect URI via the Integrations tab.
//   2. User clicks "Connect Gmail" → /api/integrations/oauth/start mints a
//      nonce, redirects browser to Google consent.
//   3. Google redirects back to /oauth/callback with ?code= → we POST that
//      to https://oauth2.googleapis.com/token, get access + refresh tokens,
//      encrypt, store, fetch the connected account's email via userinfo.
//   4. Every engine call goes through getValidAccessToken(provider) which
//      refreshes silently when the cached access token is <60s from expiry.

const pool = require('../db');
const { encrypt, decrypt } = require('../util/crypto');

// One row per provider; we look up the credentials row each time so an admin
// can rotate Client ID/Secret without a backend restart.
async function getGoogleOAuthCredentials() {
  const { rows } = await pool.query(
    `SELECT client_id_encrypted, client_secret_encrypted, redirect_uri
       FROM coexistence.google_oauth_credentials
      ORDER BY id DESC LIMIT 1`
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    clientId: decrypt(r.client_id_encrypted),
    clientSecret: decrypt(r.client_secret_encrypted),
    redirectUri: r.redirect_uri,
  };
}

// Scopes per provider. We keep scopes intentionally narrow to the action we
// actually perform — gmail.send, not gmail.modify; spreadsheets, not
// spreadsheets.readonly + drive.
const PROVIDER_SCOPES = {
  google_sheets: [
    'https://www.googleapis.com/auth/spreadsheets',
    // drive.readonly is required to LIST the user's spreadsheets — the Sheets
    // API itself can only read/write a spreadsheet you already know the ID of.
    // We need Drive's files.list endpoint to discover them in the picker.
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
  google_calendar: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
  gmail: [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',  // for labels + profile + thread list
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
};

const PROVIDER_LABELS = {
  google_sheets: 'Google Sheets',
  google_calendar: 'Google Calendar',
  gmail: 'Gmail',
};

function buildAuthUrl(provider, state, creds) {
  const scopes = PROVIDER_SCOPES[provider];
  if (!scopes) throw new Error(`Unknown provider: ${provider}`);
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: creds.redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    // access_type=offline + prompt=consent forces Google to issue a refresh
    // token EVERY time, not just first connect — without this a re-connect
    // returns no refresh_token and we lose the ability to refresh later.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Exchange ?code= for tokens. Returns {access_token, refresh_token, expires_in, scope}.
async function exchangeCodeForTokens(code, creds) {
  const body = new URLSearchParams({
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: creds.redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${json.error_description || json.error || res.status}`);
  }
  return json;
}

async function refreshAccessToken(refreshToken, creds) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${json.error_description || json.error || res.status}`);
  }
  return json;
}

async function fetchUserInfo(accessToken) {
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function revokeToken(token) {
  if (!token) return;
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  } catch {/* best-effort; we still delete the local row */}
}

// Returns a usable access token for the given provider, refreshing if needed.
// Throws with a clear message when the integration is missing or revoked.
async function getValidAccessToken(provider) {
  const { rows } = await pool.query(
    `SELECT id, access_token_encrypted, refresh_token_encrypted, token_expiry_at, status
       FROM coexistence.integrations
      WHERE provider = $1`,
    [provider]
  );
  if (rows.length === 0) {
    throw new Error(`${PROVIDER_LABELS[provider] || provider} is not connected. Connect it in Admin Settings → Integrations.`);
  }
  const row = rows[0];
  if (row.status === 'revoked') {
    throw new Error(`${PROVIDER_LABELS[provider] || provider} connection was revoked. Reconnect in Admin Settings → Integrations.`);
  }

  let accessToken = decrypt(row.access_token_encrypted);
  const refreshToken = decrypt(row.refresh_token_encrypted);
  const expiresAt = row.token_expiry_at ? new Date(row.token_expiry_at).getTime() : 0;
  const now = Date.now();

  // Refresh 60s before expiry to avoid races
  if (!accessToken || !expiresAt || expiresAt - now < 60_000) {
    if (!refreshToken) {
      throw new Error(`${PROVIDER_LABELS[provider] || provider} token expired and no refresh token is stored. Reconnect it.`);
    }
    const creds = await getGoogleOAuthCredentials();
    if (!creds) throw new Error('Google OAuth credentials are not configured.');
    const refreshed = await refreshAccessToken(refreshToken, creds);
    accessToken = refreshed.access_token;
    const newExpiry = new Date(now + (refreshed.expires_in || 3600) * 1000);
    await pool.query(
      `UPDATE coexistence.integrations
          SET access_token_encrypted = $1,
              token_expiry_at = $2,
              status = 'connected',
              last_error = NULL,
              updated_at = NOW()
        WHERE id = $3`,
      [encrypt(accessToken), newExpiry, row.id]
    );
  }

  // Stamp last_used_at lazily so the UI can show "Last used 2 minutes ago"
  pool.query(
    `UPDATE coexistence.integrations SET last_used_at = NOW() WHERE id = $1`,
    [row.id]
  ).catch(() => {});

  return accessToken;
}

// Marks an integration as errored. Called by engine handlers when a Google API
// call fails so the Integrations tab can show a red badge + reconnect hint.
async function markIntegrationError(provider, errorMessage) {
  await pool.query(
    `UPDATE coexistence.integrations
        SET status = 'error', last_error = $1, updated_at = NOW()
      WHERE provider = $2`,
    [String(errorMessage || '').slice(0, 500), provider]
  ).catch(() => {});
}

// ─── REST wrappers per provider ─────────────────────────────────────────

async function sheetsAppendRow({ spreadsheetId, range, values }) {
  const token = await getValidAccessToken('google_sheets');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [values] }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `Sheets append failed (${res.status})`;
    await markIntegrationError('google_sheets', msg);
    throw new Error(msg);
  }
  return json;
}

// Read a range. Used by the agent's Sheets `read` tool so the LLM can look up
// existing rows before deciding to append or update.
async function sheetsReadRange({ spreadsheetId, range }) {
  const token = await getValidAccessToken('google_sheets');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `Sheets read failed (${res.status})`;
    await markIntegrationError('google_sheets', msg);
    throw new Error(msg);
  }
  return { range: json.range, rows: json.values || [] };
}

// Overwrite a range. Used by the agent's Sheets `update` tool to edit an
// existing row the LLM identified via a prior read call.
async function sheetsUpdateRange({ spreadsheetId, range, values }) {
  const token = await getValidAccessToken('google_sheets');
  // Single row → wrap in outer array; matrix → pass through.
  const body = Array.isArray(values[0]) ? values : [values];
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `Sheets update failed (${res.status})`;
    await markIntegrationError('google_sheets', msg);
    throw new Error(msg);
  }
  return json;
}

async function calendarInsertEvent({ calendarId, summary, description, location, startISO, endISO, attendees }) {
  const token = await getValidAccessToken('google_calendar');
  const cal = calendarId || 'primary';
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events`;
  const body = {
    summary: summary || 'Event',
    description: description || undefined,
    location: location || undefined,
    start: { dateTime: startISO },
    end:   { dateTime: endISO },
  };
  if (attendees && attendees.length) {
    body.attendees = attendees.filter(Boolean).map(email => ({ email }));
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `Calendar insert failed (${res.status})`;
    await markIntegrationError('google_calendar', msg);
    throw new Error(msg);
  }
  return json;
}

// Encode a UTF-8 string into RFC 2047 "encoded-word" form so non-ASCII
// subjects/bodies survive Gmail's MIME parsing.
function encodeMimeHeader(s) {
  if (!s) return '';
  // ASCII-only? just return it.
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function buildMimeMessage({ to, from, subject, text, html }) {
  const boundary = `bnd_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const headers = [
    `To: ${to}`,
    from ? `From: ${from}` : null,
    `Subject: ${encodeMimeHeader(subject || '')}`,
    'MIME-Version: 1.0',
    html ? `Content-Type: multipart/alternative; boundary="${boundary}"` : 'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 7bit',
  ].filter(Boolean).join('\r\n');

  if (!html) {
    return `${headers}\r\n\r\n${text || ''}`;
  }
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    text || '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    html,
    `--${boundary}--`,
  ].join('\r\n');
  return `${headers}\r\n\r\n${body}`;
}

// Gmail expects the raw MIME message base64-URL-encoded (not standard base64).
function toBase64Url(s) {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function gmailSend({ to, subject, text, html }) {
  const token = await getValidAccessToken('gmail');
  // Look up the connected account's email so the From: header matches and
  // Gmail doesn't reject the send with a sender-mismatch error.
  const { rows } = await pool.query(
    `SELECT account_email FROM coexistence.integrations WHERE provider = 'gmail'`
  );
  const from = rows[0]?.account_email || undefined;
  const raw = toBase64Url(buildMimeMessage({ to, from, subject, text, html }));
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `Gmail send failed (${res.status})`;
    await markIntegrationError('gmail', msg);
    throw new Error(msg);
  }
  return json;
}

// ─── Discovery helpers (for picker UIs in the Integrations tab and
// future automation-node configurators) ────────────────────────────────

async function authedGet(provider, url) {
  const token = await getValidAccessToken(provider);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || json?.error_description || `${res.status}`;
    await markIntegrationError(provider, msg);
    throw new Error(msg);
  }
  return json;
}

// Sheets discovery — uses Drive to LIST, Sheets to drill in.
// Returns [{id, name, modifiedTime, owners}].
async function driveListSpreadsheets({ pageSize = 100, q = '' } = {}) {
  const params = new URLSearchParams({
    // mimeType filter narrows to spreadsheets; orderBy puts the most-recently-
    // edited at the top so the user finds what they were just working on.
    q: [`mimeType='application/vnd.google-apps.spreadsheet'`, `trashed=false`, q && `name contains '${q.replace(/'/g, "\\'")}'`].filter(Boolean).join(' and '),
    fields: 'files(id,name,modifiedTime,owners(emailAddress,displayName)),nextPageToken',
    orderBy: 'modifiedTime desc',
    pageSize: String(Math.min(pageSize, 1000)),
  });
  const out = await authedGet('google_sheets', `https://www.googleapis.com/drive/v3/files?${params.toString()}`);
  return (out.files || []).map(f => ({
    id: f.id,
    name: f.name,
    modifiedTime: f.modifiedTime,
    ownerEmail: f.owners?.[0]?.emailAddress,
    ownerName: f.owners?.[0]?.displayName,
  }));
}

// Returns the spreadsheet's metadata + tabs (sheets).
async function sheetsGetSpreadsheet(spreadsheetId) {
  const out = await authedGet(
    'google_sheets',
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,properties(title),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))`
  );
  return {
    id: out.spreadsheetId,
    title: out.properties?.title,
    tabs: (out.sheets || []).map(s => ({
      sheetId: s.properties.sheetId,
      title: s.properties.title,
      index: s.properties.index,
      rowCount: s.properties.gridProperties?.rowCount,
      columnCount: s.properties.gridProperties?.columnCount,
    })),
  };
}

// Returns the header row + first N data rows of a tab. Used as a preview so
// the operator can confirm they picked the right sheet before wiring an
// automation Action to it.
async function sheetsGetTabPreview(spreadsheetId, tabTitle, { rows = 5 } = {}) {
  const range = `${tabTitle}!A1:Z${Math.max(rows + 1, 2)}`;
  const out = await authedGet(
    'google_sheets',
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`
  );
  const values = out.values || [];
  const headers = values[0] || [];
  const dataRows = values.slice(1);
  return { range: out.range, headers, rows: dataRows };
}

// Calendar discovery.
async function calendarListCalendars() {
  const out = await authedGet(
    'google_calendar',
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?fields=items(id,summary,description,primary,accessRole,timeZone,backgroundColor)'
  );
  return (out.items || []).map(c => ({
    id: c.id,
    summary: c.summary,
    description: c.description,
    primary: !!c.primary,
    accessRole: c.accessRole,
    timeZone: c.timeZone,
    color: c.backgroundColor,
  }));
}

// Gmail profile + label list.
async function gmailGetProfile() {
  const profile = await authedGet('gmail', 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
  return {
    emailAddress: profile.emailAddress,
    messagesTotal: profile.messagesTotal,
    threadsTotal: profile.threadsTotal,
    historyId: profile.historyId,
  };
}

async function gmailListLabels() {
  const out = await authedGet('gmail', 'https://gmail.googleapis.com/gmail/v1/users/me/labels');
  return (out.labels || []).map(l => ({
    id: l.id,
    name: l.name,
    type: l.type,        // 'system' | 'user'
  }));
}

module.exports = {
  PROVIDER_SCOPES,
  PROVIDER_LABELS,
  getGoogleOAuthCredentials,
  buildAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  fetchUserInfo,
  revokeToken,
  getValidAccessToken,
  markIntegrationError,
  sheetsAppendRow,
  sheetsReadRange,
  sheetsUpdateRange,
  calendarInsertEvent,
  gmailSend,
  driveListSpreadsheets,
  sheetsGetSpreadsheet,
  sheetsGetTabPreview,
  calendarListCalendars,
  gmailGetProfile,
  gmailListLabels,
};
