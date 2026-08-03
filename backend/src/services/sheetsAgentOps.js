// Google Sheets agent-tool dispatcher.
//
// Wraps the existing integrations/googleClient.js helpers so the agent's
// tool-use loop can execute exactly the ops the operator enabled on the
// tool row (read / append / update). The `ops` allow-list is enforced here
// even though the LLM only ever sees the ops we registered in the tool
// schema — belt-and-braces against prompt injection that tries to call
// disabled operations by name.

const { sheetsReadRange, sheetsUpdateRange } = require('../integrations/googleClient');

const DEFAULT_READ_RANGE = 'A:Z';   // whole tab when the LLM doesn't specify

// ── helpers for the `upsert` op ────────────────────────────────────────────
function colLetter(idx) {
  let s = ''; let n = Number(idx);
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}
function normCell(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function digitsOnly(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
// Match a cell against a key — exact (case-insensitive) OR digits-only (so
// "+91 94877 22330" matches "919876543210" for phone-number keys).
function keyMatch(cell, key) {
  if (normCell(cell) !== '' && normCell(cell) === normCell(key)) return true;
  const dc = digitsOnly(cell); const dk = digitsOnly(key);
  return dc !== '' && dc === dk;
}
// Parse the start row/col index from a returned A1 range like
// "'Enquiry tracker'!A1:G23" → { row: 1, col: 0 } (1-based row, 0-based col).
function parseStart(rangeA1) {
  const m = String(rangeA1 || '').match(/!\$?([A-Z]+)\$?(\d+)/);
  if (!m) return { row: 1, col: 0 };
  let col = 0; for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: parseInt(m[2], 10), col: col - 1 };
}

async function executeOp({ op, toolConfig, args }) {
  const allowed = Array.isArray(toolConfig.ops) ? toolConfig.ops : [];
  if (!allowed.includes(op)) {
    throw new Error(`Operation '${op}' is not enabled for this Sheets tool. Enabled: ${allowed.join(', ') || 'none'}`);
  }

  const spreadsheetId = toolConfig.spreadsheet_id;
  const sheetName = toolConfig.sheet_name;
  if (!spreadsheetId) throw new Error('Sheets tool config is missing spreadsheet_id');
  if (!sheetName) throw new Error('Sheets tool config is missing sheet_name');

  // A1-prefix the range with the sheet name when the model gives us a bare
  // range — so the call always targets the tab the operator configured.
  function fqRange(maybeRange) {
    const r = maybeRange || DEFAULT_READ_RANGE;
    if (r.includes('!')) return r;
    return `'${sheetName}'!${r}`;
  }

  if (op === 'read') {
    const out = await sheetsReadRange({
      spreadsheetId,
      range: fqRange(args?.range),
    });
    const maxRows = Math.max(1, Math.min(500, parseInt(args?.max_rows || 100, 10)));
    return {
      range: out.range,
      rowCount: out.rows.length,
      truncated: out.rows.length > maxRows,
      rows: out.rows.slice(0, maxRows),
    };
  }

  if (op === 'append') {
    if (!Array.isArray(args?.values)) throw new Error('append requires args.values (array)');
    // Deterministic placement: read the tab, find the LAST non-empty row, and
    // write the new row right after it. We do NOT use Google's values:append
    // here because its "table detection" lands on the styled header row when
    // the sheet has a title banner above the headers (the new Sheets "Tables"
    // feature) — that produced rows landing on/over the header band instead of
    // the next free line.
    const read = await sheetsReadRange({ spreadsheetId, range: `'${sheetName}'!A1:Z2000` });
    const rows = read.rows || [];
    const start = parseStart(read.range); // 1-based first row of the read window
    let lastNonEmpty = -1;
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i] || []).some(c => String(c == null ? '' : c).trim() !== '')) lastNonEmpty = i;
    }
    const targetRow = start.row + lastNonEmpty + 1; // first empty row after content
    const endCol = colLetter(Math.max(0, args.values.length - 1));
    const out = await sheetsUpdateRange({
      spreadsheetId,
      range: `'${sheetName}'!A${targetRow}:${endCol}${targetRow}`,
      values: [args.values],
    });
    return {
      action: 'appended',
      row: targetRow,
      updatedRange: out.updatedRange,
      updatedRows: out.updatedRows,
      updatedCells: out.updatedCells,
    };
  }

  if (op === 'update') {
    if (!args?.range) throw new Error('update requires args.range');
    if (!Array.isArray(args?.values)) throw new Error('update requires args.values (array)');
    const out = await sheetsUpdateRange({
      spreadsheetId,
      range: fqRange(args.range),
      values: args.values,
    });
    return {
      updatedRange: out.updatedRange,
      updatedRows: out.updatedRows,
      updatedCells: out.updatedCells,
    };
  }

  // Find-or-create a row by a key column, writing only named columns. The
  // engine handles header discovery, row numbers and the column offset so the
  // LLM never deals with A1 ranges — it just gives { key_column, key_value,
  // fields:{ "Header Name": value } }. This is the reliable way to keep a
  // single evolving row per contact (vs. raw append/update).
  if (op === 'upsert') {
    const keyColumn = args?.key_column;
    const keyValue = args?.key_value;
    const fields = args?.fields;
    if (!keyColumn) throw new Error('upsert requires args.key_column (a header name, e.g. "Phone Number")');
    if (keyValue == null || keyValue === '') throw new Error('upsert requires args.key_value');
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error('upsert requires args.fields as an object of { "Column Header": value, ... }');
    }

    const read = await sheetsReadRange({ spreadsheetId, range: `'${sheetName}'!A1:Z2000` });
    const rows = read.rows || [];
    const start = parseStart(read.range);

    // 1. Locate the header row (first row that contains the key column name).
    let hIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i] || []).some(c => normCell(c) === normCell(keyColumn))) { hIdx = i; break; }
    }
    if (hIdx === -1) throw new Error(`Could not find a header row containing "${keyColumn}" in tab "${sheetName}". Check the column name.`);
    const header = rows[hIdx];
    const colOf = (name) => header.findIndex(c => normCell(c) === normCell(name));
    const keyCol = colOf(keyColumn);

    // 2. Resolve each field name → its column index (skip unknown columns).
    const writes = []; const skippedUnknownColumns = [];
    for (const [name, value] of Object.entries(fields)) {
      const c = colOf(name);
      if (c === -1) skippedUnknownColumns.push(name); else writes.push({ col: c, value });
    }
    if (writes.length === 0) throw new Error(`None of the given field names matched a column header in "${sheetName}". Headers are: ${header.filter(Boolean).join(', ')}`);

    // 3. Find the existing data row whose key column matches key_value.
    let dIdx = -1;
    for (let i = hIdx + 1; i < rows.length; i++) {
      if (keyMatch((rows[i] || [])[keyCol], keyValue)) { dIdx = i; break; }
    }

    if (dIdx !== -1) {
      // Update only the touched cells, in one contiguous span (preserving the
      // cells in between that we aren't changing).
      const absRow = start.row + dIdx;
      const cols = writes.map(w => w.col);
      const minC = Math.min(...cols); const maxC = Math.max(...cols);
      const existing = rows[dIdx] || [];
      const span = [];
      for (let c = minC; c <= maxC; c++) {
        const w = writes.find(x => x.col === c);
        span.push(w ? w.value : (existing[c] != null ? existing[c] : ''));
      }
      await sheetsUpdateRange({ spreadsheetId, range: `'${sheetName}'!${colLetter(minC)}${absRow}:${colLetter(maxC)}${absRow}`, values: [span] });
      return { action: 'updated', row: absRow, key: { column: keyColumn, value: keyValue }, wrote: writes.map(w => header[w.col]), skippedUnknownColumns };
    }

    // 4. No match → write a new row right after the last non-empty row. We use
    // an explicit update (not values:append) so the row lands on the next free
    // line even when the tab is a Sheets "Table" with a title banner — and we
    // reuse the rows we already read (no extra round-trip).
    const maxC = Math.max(keyCol, ...writes.map(w => w.col));
    const rowArr = new Array(maxC + 1).fill('');
    rowArr[keyCol] = keyValue;
    for (const w of writes) rowArr[w.col] = w.value;
    let lastNonEmpty = -1;
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i] || []).some(c => normCell(c) !== '')) lastNonEmpty = i;
    }
    const targetRow = start.row + lastNonEmpty + 1;
    const out = await sheetsUpdateRange({ spreadsheetId, range: `'${sheetName}'!A${targetRow}:${colLetter(maxC)}${targetRow}`, values: [rowArr] });
    return { action: 'appended', row: targetRow, updatedRange: out.updatedRange, key: { column: keyColumn, value: keyValue }, wrote: writes.map(w => header[w.col]), skippedUnknownColumns };
  }

  throw new Error(`Unknown Sheets op: ${op}`);
}

module.exports = { executeOp };
