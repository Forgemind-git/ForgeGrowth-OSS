import { useState, useEffect, useCallback } from 'react';
import { Save, X, Loader2, AlertCircle, ExternalLink } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import SearchableSelect from '../SearchableSelect.jsx';

const OPS = [
  { key: 'read',   label: 'Read',   desc: 'Look up existing rows' },
  { key: 'append', label: 'Append', desc: 'Add a new row' },
  { key: 'update', label: 'Update', desc: 'Overwrite a specific range' },
  { key: 'upsert', label: 'Upsert (recommended for logging)', desc: 'Find a row by a key column (e.g. phone) and update it, or add it if new — no duplicate rows, no column tracking' },
];

/**
 * Sheets tool config for an agent. Uses the existing workspace-wide Google
 * integration (Admin Settings → Integrations) — there's no per-agent OAuth
 * account to pick, so the picker starts straight at the spreadsheet step.
 *
 * Spreadsheet + tab pickers call the existing
 * /api/integrations/google-sheets/* endpoints (driveListSpreadsheets +
 * sheetsGetSpreadsheet).
 */
export default function GoogleSheetsToolConfig({ agentId, ensureAgentId, existingTool, onCancel, onSaved }) {
  const isEdit = !!existingTool;
  const initial = existingTool?.config || {};

  const [integrations, setIntegrations] = useState([]);
  const [spreadsheets, setSpreadsheets] = useState([]);
  const [spreadsheetId, setSpreadsheetId] = useState(initial.spreadsheet_id || '');
  const [spreadsheetName, setSpreadsheetName] = useState(initial.spreadsheet_name || '');
  const [tabs, setTabs] = useState([]);
  const [sheetName, setSheetName] = useState(initial.sheet_name || '');
  const [ops, setOps] = useState(Array.isArray(initial.ops) ? initial.ops : ['read', 'append']);
  const [loadingIntegrations, setLoadingIntegrations] = useState(true);
  const [loadingSheets, setLoadingSheets] = useState(false);
  const [loadingTabs, setLoadingTabs] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Step 1: confirm Google Sheets is connected workspace-wide.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await api.integrations.list();
        if (!alive) return;
        setIntegrations(list);
      } catch (e) {
        if (alive) setError(pretty(e));
      } finally {
        if (alive) setLoadingIntegrations(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const sheetsIntegration = integrations.find(i => i.provider === 'google_sheets');
  const sheetsConnected = !!sheetsIntegration && sheetsIntegration.status !== 'revoked';

  // Step 2: load spreadsheets from Drive once the integration is confirmed.
  const loadSpreadsheets = useCallback(async () => {
    setLoadingSheets(true); setError('');
    try {
      const res = await api.integrations.sheets.listSpreadsheets();
      setSpreadsheets(Array.isArray(res) ? res : (res?.spreadsheets || []));
    } catch (e) {
      setError(pretty(e));
    } finally {
      setLoadingSheets(false);
    }
  }, []);

  useEffect(() => {
    if (sheetsConnected && spreadsheets.length === 0) loadSpreadsheets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetsConnected]);

  // Step 3: load tabs when a spreadsheet is picked.
  useEffect(() => {
    if (!spreadsheetId) return;
    let alive = true;
    setLoadingTabs(true); setError('');
    (async () => {
      try {
        const info = await api.integrations.sheets.getSpreadsheet(spreadsheetId);
        if (!alive) return;
        const list = info.tabs || [];
        setTabs(list);
        if (sheetName && !list.find(t => t.title === sheetName)) setSheetName(list[0]?.title || '');
        if (!sheetName) setSheetName(list[0]?.title || '');
      } catch (e) {
        if (alive) setError(pretty(e));
      } finally {
        if (alive) setLoadingTabs(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spreadsheetId]);

  const handleSpreadsheetSelect = (id) => {
    setSpreadsheetId(id);
    const sel = spreadsheets.find(s => s.id === id);
    setSpreadsheetName(sel?.name || '');
    setSheetName('');
    setTabs([]);
  };

  const toggleOp = (key) => {
    setOps(prev => prev.includes(key) ? prev.filter(o => o !== key) : [...prev, key]);
  };

  const handleSave = async () => {
    if (!spreadsheetId || !sheetName || ops.length === 0) {
      setError('Pick a spreadsheet, tab, and at least one operation.');
      return;
    }
    setSaving(true); setError('');
    try {
      const payload = {
        toolType: 'google_sheets',
        isEnabled: existingTool?.isEnabled !== false,
        config: {
          spreadsheet_id: spreadsheetId,
          spreadsheet_name: spreadsheetName,
          sheet_name: sheetName,
          ops,
        },
      };
      if (isEdit) {
        await api.agents.updateTool(agentId, existingTool.id, payload);
      } else {
        // In create mode the agent may not be saved yet — persist it as a draft
        // first (ensureAgentId) so the tool has a real agent id to attach to.
        const id = agentId != null ? agentId : (ensureAgentId ? await ensureAgentId() : agentId);
        if (id == null) throw new Error('Save the agent first, then add tools.');
        await api.agents.addTool(id, payload);
      }
      onSaved();
    } catch (e) {
      setError(pretty(e));
    } finally {
      setSaving(false);
    }
  };

  if (loadingIntegrations) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: C.textMuted, fontSize: 12 }}>
        <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', verticalAlign: 'middle', marginRight: 6 }} />
        Loading integrations…
      </div>
    );
  }

  if (!sheetsConnected) {
    return (
      <div style={{ padding: 16, background: 'var(--c-surfaceAlt)', borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 12, fontFamily: FONT }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.text, fontWeight: 600, marginBottom: 6 }}>
          <AlertCircle size={14} /> Google Sheets isn't connected yet
        </div>
        <div style={{ color: C.textSecondary, lineHeight: 1.5, marginBottom: 10 }}>
          Connect Google Sheets in <strong>Admin Settings → Integrations</strong> first, then come back here.
        </div>
        <a href="#/admin-settings/integrations" style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          color: C.primary, textDecoration: 'none', fontWeight: 600,
        }}>Open Integrations <ExternalLink size={11} /></a>
        <button onClick={onCancel} style={{ ...cancelBtn, marginLeft: 8 }}>Close</button>
      </div>
    );
  }

  return (
    <div style={{
      padding: 16, background: 'var(--c-surfaceAlt)', borderRadius: 10,
      border: `1px solid ${C.border}`, fontFamily: FONT,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
          {isEdit ? 'Edit Google Sheets tool' : 'Add Google Sheets tool'}
        </div>
        <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted, display: 'flex', padding: 6 }}>
          <X size={14} />
        </button>
      </div>

      {sheetsIntegration?.accountEmail && (
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 12, fontFamily: MONO }}>
          Connected as {sheetsIntegration.accountEmail}
        </div>
      )}

      {error && (
        <div style={{ padding: '8px 12px', borderRadius: 8, marginBottom: 12,
          background: '#FCEBEB', color: '#A32D2D', border: '1px solid #FBC8C8', fontSize: 12 }}>
          {error}
        </div>
      )}

      <Field label="Spreadsheet" hint="Drive-listed spreadsheets you've granted this app access to.">
        {loadingSheets ? (
          <div style={{ fontSize: 12, color: C.textMuted, padding: '8px 0' }}>
            <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', verticalAlign: 'middle' }} /> Loading spreadsheets…
          </div>
        ) : (
          <SearchableSelect
            value={spreadsheetId}
            onChange={v => handleSpreadsheetSelect(v)}
            options={spreadsheets.map(s => ({ value: String(s.id), label: s.name }))}
            placeholder="— Select —"
            searchPlaceholder="Search spreadsheets…"
            triggerStyle={{ padding: '9px 32px 9px 12px', fontSize: 13 }}
          />
        )}
      </Field>

      <Field label="Sheet tab">
        {loadingTabs ? (
          <div style={{ fontSize: 12, color: C.textMuted, padding: '8px 0' }}>
            <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', verticalAlign: 'middle' }} /> Loading tabs…
          </div>
        ) : (
          <SearchableSelect
            value={sheetName}
            onChange={v => setSheetName(v)}
            options={tabs.map(t => ({ value: t.title, label: t.title }))}
            placeholder="— Select —"
            searchPlaceholder="Search tabs…"
            disabled={!spreadsheetId}
            triggerStyle={{ padding: '9px 32px 9px 12px', fontSize: 13 }}
          />
        )}
      </Field>

      <Field label="Allowed operations" hint="What the agent's LLM is allowed to do on this sheet. The model only sees the ops you enable here.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {OPS.map(o => (
            <label key={o.key} style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '10px 12px', borderRadius: 8,
              border: ops.includes(o.key) ? `1.5px solid ${C.primary}` : `1px solid ${C.border}`,
              background: ops.includes(o.key) ? '#FEF1F1' : C.cardBg,
              cursor: 'pointer',
            }}>
              <input type="checkbox" checked={ops.includes(o.key)} onChange={() => toggleOp(o.key)}
                style={{ marginTop: 3 }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{o.label}</div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{o.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </Field>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button onClick={onCancel} style={cancelBtn}>Cancel</button>
        <button onClick={handleSave} disabled={saving} style={saveBtn(saving)}>
          {saving ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={13} />}
          {isEdit ? 'Save tool' : 'Add tool'}
        </button>
      </div>
    </div>
  );
}

const input = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: `1px solid ${C.border}`, fontSize: 13, fontFamily: FONT,
  color: C.text, background: C.cardBg, outline: 'none',
  boxSizing: 'border-box',
};
const cancelBtn = {
  padding: '8px 14px', borderRadius: 8,
  border: `1px solid ${C.border}`, background: C.cardBg,
  color: C.text, fontSize: 12, fontFamily: FONT, fontWeight: 600,
  cursor: 'pointer',
};
const saveBtn = (busy) => ({
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '8px 16px', borderRadius: 8,
  border: 'none', background: C.primary, color: '#fff',
  fontSize: 12, fontFamily: FONT, fontWeight: 700,
  cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1,
});

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.textSecondary,
        textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6, lineHeight: 1.45 }}>{hint}</div>}
    </div>
  );
}

function pretty(e) {
  if (!e) return 'Unknown error';
  const msg = e.message || String(e);
  try {
    const m = msg.match(/^\d+\s+(.+)$/);
    if (m) {
      const body = JSON.parse(m[1]);
      if (body && body.error) return body.error;
    }
  } catch { /* fall through */ }
  return msg;
}
