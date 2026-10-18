const socialEnv = require('../env');
// Google Sheets operations for agent tools — read / append / update / upsert.
//
// ForgeSocial has no interactive Google OAuth/Sheets connection flow, so this
// authenticates with a SERVICE ACCOUNT. Set GOOGLE_SERVICE_ACCOUNT_JSON in the
// backend env to the full service-account JSON (or GOOGLE_SHEETS_SA_JSON), then
// SHARE each target spreadsheet with that service account's client_email. The
// agent's Sheets tool config holds only the spreadsheet id + tab name + ops, so
// no per-user token handling is needed.

const { google } = require('googleapis');

let _sheetsClient = null;
let _saEmail = null;

function loadServiceAccount() {
  const raw = socialEnv.GOOGLE_SERVICE_ACCOUNT_JSON || socialEnv.GOOGLE_SHEETS_SA_JSON || '';
  if (!raw || !raw.trim()) {
    throw new Error('Google Sheets is not configured on the server. Set GOOGLE_SERVICE_ACCOUNT_JSON and share the sheet with the service account email.');
  }
  let creds;
  try { creds = JSON.parse(raw); } catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.'); }
  if (!creds.client_email || !creds.private_key) throw new Error('Service-account JSON is missing client_email / private_key.');
  return creds;
}

async function getSheets() {
  if (_sheetsClient) return _sheetsClient;
  const creds = loadServiceAccount();
  _saEmail = creds.client_email;
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets'],
  );
  await auth.authorize();
  _sheetsClient = google.sheets({ version: 'v4', auth });
  return _sheetsClient;
}

// Return the configured service-account email (for the UI "share with" hint).
function serviceAccountEmail() {
  try { return loadServiceAccount().client_email; } catch { return null; }
}

function a1(sheetName, range) {
  const tab = `'${String(sheetName).replace(/'/g, "''")}'`;
  return range ? `${tab}!${range}` : tab;
}

// Execute one Sheets op. Returns a compact JSON the LLM can read; throws on
// hard failures (the engine catches and feeds the error back to the model).
async function executeOp({ op, toolConfig, args }) {
  const cfg = toolConfig || {};
  const spreadsheetId = cfg.spreadsheet_id;
  const sheetName = cfg.sheet_name;
  if (!spreadsheetId || !sheetName) throw new Error('Sheets tool is misconfigured (missing spreadsheet id or tab).');
  const sheets = await getSheets();

  if (op === 'read') {
    const max = Math.max(1, Math.min(500, parseInt(args?.max_rows, 10) || 100));
    const range = args?.range ? a1(sheetName, args.range) : a1(sheetName);
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const values = (res.data.values || []).slice(0, max + 1);
    return { ok: true, rowCount: values.length, values };
  }

  if (op === 'append') {
    const values = Array.isArray(args?.values) ? args.values : [];
    if (values.length === 0) return { ok: false, error: 'No values provided to append.' };
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: a1(sheetName),
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] },
    });
    return { ok: true, appended: true, columns: values.length };
  }

  if (op === 'update') {
    const range = args?.range;
    const values = Array.isArray(args?.values) ? args.values : [];
    if (!range || values.length === 0) return { ok: false, error: 'update needs a range and values.' };
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: a1(sheetName, range),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [values] },
    });
    return { ok: true, updated: true, range };
  }

  if (op === 'upsert') {
    const keyColumn = args?.key_column;
    const keyValue = args?.key_value;
    const fields = args?.fields && typeof args.fields === 'object' ? args.fields : null;
    if (!keyColumn || keyValue == null || !fields) {
      return { ok: false, error: 'upsert needs key_column, key_value and a fields object.' };
    }
    // Read header + all rows to find the key column + existing row.
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: a1(sheetName) });
    const grid = res.data.values || [];
    const header = grid[0] || [];
    const colIdx = header.findIndex(h => String(h).trim().toLowerCase() === String(keyColumn).trim().toLowerCase());
    if (colIdx === -1) return { ok: false, error: `Key column "${keyColumn}" not found in the sheet header.` };

    // Build the target row from the existing header order.
    const target = header.map((h, i) => {
      const want = Object.keys(fields).find(k => k.trim().toLowerCase() === String(h).trim().toLowerCase());
      if (want != null) return fields[want];
      return undefined; // preserve existing on update; blank on insert
    });

    let foundRow = -1;
    for (let r = 1; r < grid.length; r++) {
      if (String(grid[r]?.[colIdx] ?? '').trim().toLowerCase() === String(keyValue).trim().toLowerCase()) { foundRow = r; break; }
    }

    if (foundRow >= 0) {
      const existing = grid[foundRow] || [];
      const merged = header.map((h, i) => (target[i] !== undefined ? target[i] : (existing[i] ?? '')));
      // Also set the key cell so a brand-new key value persists.
      merged[colIdx] = existing[colIdx] ?? keyValue;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: a1(sheetName, `A${foundRow + 1}`),
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [merged] },
      });
      return { ok: true, action: 'updated', row: foundRow + 1 };
    }

    const newRow = header.map((h, i) => (i === colIdx ? keyValue : (target[i] !== undefined ? target[i] : '')));
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: a1(sheetName),
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [newRow] },
    });
    return { ok: true, action: 'inserted' };
  }

  return { ok: false, error: `Unknown Sheets op '${op}'.` };
}

module.exports = { executeOp, serviceAccountEmail };
