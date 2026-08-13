import { useState, useEffect } from 'react';
import { Save, X, Loader2, AlertCircle, ExternalLink, ClipboardList } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT } from '../../constants.js';
import SearchableSelect from '../SearchableSelect.jsx';
import { isDisplayOnly, ratingScale } from '../../lib/formAnswers.js';

/**
 * Connect a Form's TABLE to this agent.
 *
 * A form is two things — a page people fill in, and the table their answers land
 * in. What is picked here is the TABLE: the agent collects the same columns in
 * conversation and writes a row into the same store the public form writes to,
 * so a row it added and a row someone typed themselves sit side by side and read
 * identically everywhere downstream.
 *
 * The whole config is one form id. The columns are read live from the form on
 * every run, so editing the form changes what the agent collects immediately —
 * which is why this panel SHOWS the columns rather than letting you edit them
 * here. The form is the single place they live.
 */

// A column the agent can fill. Mirrors isAskable() in
// backend/src/services/agentFormTools.js — a section is a heading with no
// answer, and a phone column is filled from the chat contact.
const isAskable = (f) => !isDisplayOnly(f.type) && f.mapsTo !== 'phone';

// What the agent is told a column holds. Mirrors propertyFor() in
// backend/src/services/agentFormTools.js: the point of showing it is that the
// operator can see the agent will be made to send a number where the column is
// a number, and one of the exact choices where the column is a dropdown.
function typeLabel(f) {
  switch (f.type) {
    case 'number': return 'number';
    case 'boolean': return 'yes / no';
    case 'date': return 'date';
    case 'rating': return `rating 1–${ratingScale(f)}`;
    case 'checkbox': return 'one or more choices';
    case 'dropdown':
    case 'radio': return 'one choice';
    case 'textarea': return 'long text';
    case 'email': return 'email';
    default: return 'text';
  }
}

export default function LeadFormToolConfig({ agentId, ensureAgentId, existingTool, onCancel, onSaved }) {
  const isEdit = !!existingTool;
  const initial = existingTool?.config || {};

  const [forms, setForms] = useState([]);
  const [formId, setFormId] = useState(initial.form_id ? String(initial.form_id) : '');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    // ⚠ `GET /lead-forms` answers `{ forms: [...] }`, NOT a bare array. This
    // used to be `Array.isArray(list) ? list : []`, so it always fell to the
    // empty branch and the picker said "You have no forms yet" no matter how
    // many were published — which made the whole tool unusable, silently, with
    // a perfectly healthy backend behind it. Both shapes accepted here so a
    // future change to the envelope cannot re-break it the same way.
    api.leadForms.list()
      .then(r => {
        if (!alive) return;
        setForms(Array.isArray(r) ? r : (Array.isArray(r?.forms) ? r.forms : []));
      })
      .catch(e => { if (alive) setError(pretty(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const selected = forms.find(f => String(f.id) === String(formId)) || null;
  const questions = selected ? (selected.fields || []).filter(isAskable) : [];
  const published = selected ? selected.status === 'published' : true;

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = { toolType: 'lead_form', config: { form_id: Number(formId) } };
      if (isEdit) {
        await api.agents.updateTool(agentId, existingTool.id, payload);
      } else {
        // Adding a tool before the agent has ever been saved persists it as a
        // draft first — same behaviour as the Sheets and HTTP tools.
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

  return (
    <div style={{ padding: 16, background: 'var(--c-surfaceAlt)', borderRadius: 10, border: `1px solid ${C.border}`, fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
          {isEdit ? 'Edit connected table' : 'Connect a form’s table'}
        </div>
        <button type="button" onClick={onCancel} style={iconBtn} title="Cancel">
          <X size={14} />
        </button>
      </div>

      {error && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px', borderRadius: 8,
          background: 'var(--c-dangerBg, #FCEBEB)', color: 'var(--c-dangerText, #A32D2D)',
          border: '1px solid var(--c-dangerBorder, #FBC8C8)', fontSize: 14, marginBottom: 12 }}>
          <AlertCircle size={13} /> {error}
        </div>
      )}

      <div style={{ fontSize: 13, color: C.textSecondary, lineHeight: 1.55, marginBottom: 12 }}>
        Pick a form and the agent gets access to <strong>its table</strong>. It collects the columns in
        conversation, in its own words, and writes a row into the same place people who fill the form in
        themselves land — so both sit together in Responses. It can also correct a row it added, but never
        one a person submitted. It never asks for the phone number: that comes from the conversation.
      </div>

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: C.textMuted }}>
          <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Loading forms…
        </div>
      ) : forms.length === 0 ? (
        <div style={{ fontSize: 14, color: C.textSecondary, lineHeight: 1.6 }}>
          You have no forms yet. Build one under <strong>Forms</strong>, publish it, then come back.
          <a href="#/lead-forms" style={{ color: C.primary, fontWeight: 600, textDecoration: 'none', marginLeft: 6 }}>
            Open Forms <ExternalLink size={10} style={{ verticalAlign: 'middle' }} />
          </a>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', fontSize: 13, fontWeight: 700, color: C.textSecondary,
            textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
            Form
          </div>
          <SearchableSelect
            value={formId}
            onChange={setFormId}
            placeholder="— Select a form —"
            searchPlaceholder="Search forms…"
            options={forms.map(f => ({
              value: String(f.id),
              label: f.name,
              sublabel: `${(f.fields || []).filter(isAskable).length} column(s)${f.status === 'published' ? '' : ` · ${f.status}`}`,
            }))}
          />

          {selected && !published && (
            <div style={{ fontSize: 13, color: 'var(--c-s7a5510, #7A5510)', background: 'var(--c-warnBgSoft, #FFF6E8)',
              border: '1px solid #F0D08A', borderRadius: 8, padding: '9px 11px', marginTop: 10, lineHeight: 1.55 }}>
              <strong>“{selected.name}” is a {selected.status}.</strong> The agent cannot write to the table of a form that is not
              published — the same reason its link does not work yet. You can save this now, but publish the form
              under Forms before the agent will offer it.
            </div>
          )}

          {selected && questions.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700,
                color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 7 }}>
                <ClipboardList size={12} /> Columns the agent will fill
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9, maxHeight: 280, overflowY: 'auto',
                border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, background: C.cardBg }}>
                {questions.map(q => (
                  <div key={q.key} style={{ fontSize: 14, color: C.text, lineHeight: 1.5 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600 }}>{q.label}</span>
                      {/* The stored TYPE, because that is what the agent is
                          made to honour — a number column cannot receive
                          "about twenty". */}
                      <span style={{ fontSize: 12, color: C.textSecondary, background: 'var(--c-surfaceAlt)',
                        borderRadius: 20, padding: '1px 7px', whiteSpace: 'nowrap' }}>
                        {typeLabel(q)}
                      </span>
                      {q.required
                        ? <span style={{ color: C.primary, fontWeight: 700, fontSize: 12 }}>REQUIRED</span>
                        : <span style={{ color: C.textMuted, fontSize: 12 }}>optional</span>}
                    </div>
                    {Array.isArray(q.options) && q.options.length > 0 && (
                      <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>
                        Choices: {q.options.join(' / ')}
                      </div>
                    )}
                    {/* The per-column guidance written under Forms. Shown here
                        because a column with no description is the one the
                        agent is most likely to fill badly, and this is where
                        someone notices. */}
                    {q.description ? (
                      <div style={{ fontSize: 13, color: C.textSecondary, marginTop: 2, fontStyle: 'italic' }}>
                        {q.description}
                      </div>
                    ) : (
                      <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>
                        No description — the agent only has the column name to go on.
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 13, color: C.textMuted, marginTop: 7, lineHeight: 1.5 }}>
                Add or edit these columns — and the description that tells the agent what belongs in each —
                under <strong>Forms</strong>. The agent re-reads them on every conversation, so a change takes
                effect straight away.
                <a href="#/lead-forms" style={{ color: C.primary, fontWeight: 600, textDecoration: 'none', marginLeft: 6 }}>
                  Open Forms <ExternalLink size={10} style={{ verticalAlign: 'middle' }} />
                </a>
              </div>
            </div>
          )}

          {selected && questions.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--c-dangerText, #A32D2D)', background: 'var(--c-dangerBg, #FCEBEB)',
              border: '1px solid var(--c-dangerBorder, #FBC8C8)', borderRadius: 8, padding: '9px 11px', marginTop: 10, lineHeight: 1.55 }}>
              This form’s table has no columns the agent could fill — only section headings, or only a phone
              number (which it already has). Add a field under Forms first.
            </div>
          )}
        </>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" onClick={onCancel} style={{
          padding: '9px 14px', borderRadius: 8, border: `1px solid ${C.border}`,
          background: C.cardBg, color: C.text, fontSize: 15, fontFamily: FONT, fontWeight: 600, cursor: 'pointer',
        }}>
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !formId || questions.length === 0}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '9px 16px', borderRadius: 8, border: 'none',
            background: C.primary, color: '#fff', fontSize: 15, fontFamily: FONT, fontWeight: 700,
            cursor: (saving || !formId || questions.length === 0) ? 'not-allowed' : 'pointer',
            opacity: (saving || !formId || questions.length === 0) ? 0.6 : 1,
          }}
        >
          {saving ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={13} />}
          {isEdit ? 'Save table' : 'Connect table'}
        </button>
      </div>
    </div>
  );
}

const iconBtn = {
  background: 'transparent', border: `1px solid ${C.border}`,
  borderRadius: 8, cursor: 'pointer', padding: '6px',
  color: C.textSecondary, display: 'flex', alignItems: 'center', fontFamily: FONT,
};

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
