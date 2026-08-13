// Forms — a no-presets, Google-Forms-style capture builder. List + per-form
// Build/Responses/Dashboard, matching the visual conventions of the other
// Chats-section pages (MessageFormatsPage, MediaLibraryPage).
//
// Two form types, and the whole page keys off the difference:
//   link     — shared as a plain URL. The respondent is anonymous unless they
//              volunteer a phone through a field mapped to the Phone column.
//   whatsapp — sent through an approved Utility/Marketing template whose URL
//              button carries a per-recipient token, so the phone is captured
//              automatically and every response links to a lead.
//
// The route key stays `lead-forms` so links already shared over WhatsApp, the
// broadcast FK and the MCP tools all keep resolving.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Plus, Trash2, ArrowLeft, FormInput, Loader2, Copy, Check,
  ExternalLink, ArrowUp, ArrowDown, ImagePlus, X, Download, ListChecks,
  BarChart3, Table as TableIcon, Settings, ChevronDown, Send, Link2,
  MessageCircle, Users, UserX, AlertTriangle, Megaphone, Bell, Info,
  Circle, Square, FolderKanban, Star,
} from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO } from '../constants.js';
import DeleteConfirmModal from '../components/DeleteConfirmModal.jsx';
import SearchableSelect from '../components/SearchableSelect.jsx';
import SortControl from '../components/SortControl.jsx';
import { sortList, DEFAULT_SORT } from '../lib/listSort.js';
import { useFieldRegistry } from '../hooks/useFieldRegistry.js';
import {
  RATING_SCALES, DEFAULT_RATING_SCALE, DEFAULT_FEEDBACK_LABEL,
  isDisplayOnly, answerToText,
} from '../lib/formAnswers.js';
import AccountHealthBanner from '../components/AccountHealthBanner.jsx';
import { KpiCard, Card, LineTrend, FunnelBars, Shimmer, EmptyChart } from '../components/charts.jsx';

const B = {
  card: C.cardBg, cardBorder: C.border, innerBg: C.surfaceInner, innerBorder: C.borderSubtle,
  rowSep: C.rowSep, t1: C.t1, t2: C.t2, t3: C.t3, t4: C.t4,
  t5: C.t5, t6: C.t6, t7: C.t7,
};

const FORM_TYPES = [
  {
    value: 'link', label: 'Link form', Icon: Link2,
    tagline: 'Share a plain URL',
    detail: 'Anyone with the link can respond. The phone number is optional — add a field mapped to Phone if you want people to volunteer one, otherwise the Phone column stays empty.',
  },
  {
    value: 'whatsapp', label: 'WhatsApp form', Icon: MessageCircle,
    tagline: 'Send through a template',
    detail: "Sent from one of your WhatsApp numbers using a Utility or Marketing template. Each recipient gets their own link, so their phone number is filled in automatically — they're never asked for it.",
  },
];
const formTypeMeta = (v) => FORM_TYPES.find(t => t.value === v) || FORM_TYPES[0];

const FIELD_TYPE_OPTS = [
  { value: 'text', label: 'Short text' },
  { value: 'textarea', label: 'Paragraph' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'radio', label: 'Multiple choice' },
  { value: 'checkbox', label: 'Checkboxes' },
  { value: 'boolean', label: 'Yes / No' },
  { value: 'rating', label: 'Star rating' },
  { value: 'section', label: 'Section heading' },
];
// Types the respondent cannot answer, and types that carry no lead value —
// both hide controls that would otherwise be dead: a section can't be required
// or mapped, and a rating out of N can't fill Name or Phone.
const NO_MAPPING = ['rating', 'section'];
// The answer's destination column. `phone` is the mapping the spec calls out:
// pick it on a field and that field's answer lands in the table's Phone column.
const MAPS_TO_OPTS = [
  { value: '', label: 'Its own column (no mapping)' },
  { value: 'phone', label: 'Phone', sublabel: 'Fills the Phone column and links the response to a lead' },
  { value: 'name', label: 'Name' },
  { value: 'email', label: 'Email' },
  { value: 'age', label: 'Age' },
  { value: 'profession', label: 'Profession' },
  { value: 'pincode', label: 'Pincode' },
  { value: 'city', label: 'City' },
  { value: 'source', label: 'Source' },
];
const NEEDS_OPTIONS = ['dropdown', 'radio', 'checkbox'];

const TEMPLATE_CATEGORIES = [
  { value: 'UTILITY', label: 'Utility', Icon: Bell, color: 'var(--c-infoText, #1565C0)', bg: 'var(--c-infoBg, #E3F2FD)', desc: 'Follow-ups on something the person already started — a booking, an order, an enquiry they made.' },
  { value: 'MARKETING', label: 'Marketing', Icon: Megaphone, color: 'var(--c-sb45309, #B45309)', bg: 'var(--c-sfef3c7, #FEF3C7)', desc: 'Promotions, offers and anything sent to people who did not ask for it. Costs more and needs opt-in.' },
];

function newField(n) {
  return { key: `field_${Date.now()}_${n}`, label: '', type: 'text', required: false, mapsTo: null, options: [] };
}

// Defaults applied when an existing field is switched TO a type, so the editor
// opens on a working configuration instead of a blank one.
function typeDefaults(type, field) {
  if (type === 'rating') {
    return {
      scale: RATING_SCALES.includes(parseInt(field.scale, 10)) ? field.scale : DEFAULT_RATING_SCALE,
      feedback: field.feedback ?? true,
      feedbackLabel: field.feedbackLabel || DEFAULT_FEEDBACK_LABEL,
    };
  }
  // Cleared on the way out, so a field switched away from rating doesn't carry
  // an invisible scale that reappears if it's switched back later.
  return { scale: undefined, feedback: undefined, feedbackLabel: undefined };
}

const btn = (variant = 'secondary') => ({
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 15px', borderRadius: 8,
  fontFamily: FONT, fontWeight: 700, fontSize: 15, cursor: 'pointer', whiteSpace: 'nowrap',
  border: variant === 'secondary' ? `1.5px solid ${B.cardBorder}` : 'none',
  background: variant === 'primary' ? C.primary : variant === 'danger' ? 'var(--c-dangerBgSoft, #FEF2F2)' : C.cardBg,
  color: variant === 'primary' ? '#fff' : variant === 'danger' ? 'var(--c-dangerStrong, #991B1B)' : B.t2,
});

export default function LeadFormsPage({ user, subParts = [], navigate }) {
  const id = subParts[0] && /^\d+$/.test(subParts[0]) ? Number(subParts[0]) : null;
  if (id) return <FormBuilder id={id} navigate={navigate} />;
  return <FormsList navigate={navigate} />;
}

// ── List ──────────────────────────────────────────────────────────────────────
const FORM_FIELDS = { created: f => f.createdAt, updated: f => f.updatedAt, name: f => f.name };

function FormsList({ navigate }) {
  const [forms, setForms] = useState(null);
  const [error, setError] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteModal, setDeleteModal] = useState({ open: false, item: null });
  const [toast, setToast] = useState(null);
  const [sort, setSort] = useState(DEFAULT_SORT);

  // Newest first by default, matching the Created column the table already shows.
  const sortedForms = useMemo(
    () => (forms ? sortList(forms, sort, FORM_FIELDS) : forms),
    [forms, sort]
  );

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2500); };

  const load = useCallback(async () => {
    try { const r = await api.leadForms.list(); setForms(r.forms || []); setError(null); }
    catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function handleDelete(item) {
    try { await api.leadForms.delete(item.id); showToast('Form deleted'); load(); }
    catch (e) { showToast(e.message); }
    setDeleteModal({ open: false, item: null });
  }

  return (
    <div style={{ padding: '22px 26px', fontFamily: FONT, flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, letterSpacing: '-0.02em', color: B.t1 }}>Forms</h1>
          <p style={{ fontSize: 14, color: B.t5, margin: '4px 0 0' }}>
            Build a form with your own fields and branding — share it as a link, or send it over WhatsApp.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {forms && forms.length > 0 && <SortControl value={sort} onChange={setSort} />}
          <button style={btn('primary')} onClick={() => setCreateOpen(true)}><Plus size={16} /> New Form</button>
        </div>
      </div>

      {error && <div style={{ padding: 10, background: 'var(--c-dangerBgSoft, #FEF2F2)', color: 'var(--c-dangerStrong, #991B1B)', borderRadius: 8, marginBottom: 14, fontSize: 15 }}>{error}</div>}

      {forms == null ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{[0, 1, 2].map(i => <Shimmer key={i} height={48} radius={10} />)}</div>
      ) : forms.length === 0 ? (
        <EmptyState onCreate={() => setCreateOpen(true)} />
      ) : (
        <div style={{ background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT }}>
            <thead>
              <tr style={{ background: B.innerBg, borderBottom: `1px solid ${B.cardBorder}` }}>
                {/* Alignment keys off the LABEL, not the column index — inserting
                    a column used to silently right-align whatever landed at 4. */}
                {['Name', 'Type', 'Status', 'Project', 'Fields', 'Responses', 'Created', ''].map((h, i) => (
                  <th key={i} style={{ padding: '10px 14px', fontSize: 13, fontWeight: 700, color: B.t4, textAlign: h === 'Responses' ? 'right' : 'left', textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedForms.map(f => (
                <tr key={f.id} onClick={() => navigate('lead-forms', f.id)}
                  style={{ borderBottom: `1px solid ${B.rowSep}`, cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.background = B.innerBg}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <td style={{ padding: '12px 14px', fontSize: 15, fontWeight: 600, color: B.t2 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><FormInput size={14} color={C.primary} /> {f.name}</div>
                  </td>
                  <td style={{ padding: '12px 14px' }}><TypeBadge type={f.formType} /></td>
                  <td style={{ padding: '12px 14px' }}><StatusBadge status={f.status} /></td>
                  {/* Which campaign this form belongs to. Read-only here — filing
                      happens on the Projects page, which can move every kind at
                      once (same convention as Templates and Follow-ups). */}
                  <td style={{ padding: '12px 14px', fontSize: 14, fontFamily: FONT }}>
                    {f.projectName
                      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 99, background: 'var(--c-surfaceMuted, #F1F1EC)', color: B.t3, fontWeight: 600 }}>
                          <FolderKanban size={11} /> {f.projectName}
                        </span>
                      : <span style={{ color: B.t7 }}>—</span>}
                  </td>
                  <td style={{ padding: '12px 14px', fontSize: 14, color: B.t4, fontFamily: MONO }}>{f.fields.length}</td>
                  <td style={{ padding: '12px 14px', fontSize: 14, color: B.t4, fontFamily: MONO, textAlign: 'right' }}>{f.submissionCount ?? 0}</td>
                  <td style={{ padding: '12px 14px', fontSize: 14, color: B.t5 }}>{fmtDate(f.createdAt)}</td>
                  <td style={{ padding: '12px 14px' }}>
                    <button onClick={(e) => { e.stopPropagation(); setDeleteModal({ open: true, item: f }); }}
                      style={{ padding: 6, borderRadius: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--c-dangerStrong, #991B1B)' }} title="Delete">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && <CreateFormModal onClose={() => setCreateOpen(false)} onCreated={(id) => { setCreateOpen(false); navigate('lead-forms', id); }} />}
      <DeleteConfirmModal open={deleteModal.open} title="Delete Form"
        message={`Delete "${deleteModal.item?.name}"? All its responses will be removed. This cannot be undone.`}
        onConfirm={() => handleDelete(deleteModal.item)} onCancel={() => setDeleteModal({ open: false, item: null })} />
      {toast && <Toast>{toast}</Toast>}
    </div>
  );
}

function EmptyState({ onCreate }) {
  return (
    <div style={{ background: B.card, border: `1px dashed ${B.cardBorder}`, borderRadius: 12, padding: 60, textAlign: 'center', marginTop: 20 }}>
      <FormInput size={36} style={{ color: B.t7, marginBottom: 12 }} />
      <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 6, color: B.t2 }}>No forms yet</div>
      <div style={{ fontSize: 15, color: B.t5, marginBottom: 18 }}>Build a form with any fields you want — no presets.</div>
      <button style={btn('primary')} onClick={onCreate}><Plus size={15} /> Create your first form</button>
    </div>
  );
}

function CreateFormModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [formType, setFormType] = useState('link');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!name.trim()) return setError('Name is required');
    setSaving(true);
    try {
      const r = await api.leadForms.create({ name: name.trim(), description: description.trim() || null, formType });
      onCreated(r.form.id);
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <ModalShell onClose={onClose} width={560}>
      <h2 style={{ margin: '0 0 18px', fontSize: 20, fontWeight: 700, color: B.t1 }}>New Form</h2>
      <FieldRow label="Name *">
        <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Course Interest Form" style={inputStyle} />
      </FieldRow>
      <FieldRow label="Description (optional)">
        <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} placeholder="Shown at the top of the form" style={{ ...inputStyle, resize: 'vertical' }} />
      </FieldRow>
      <FieldRow label="How will you share it?" hint="You can change this later.">
        <FormTypePicker value={formType} onChange={setFormType} />
      </FieldRow>
      {error && <div style={{ color: 'var(--c-dangerStrong, #991B1B)', fontSize: 15, marginBottom: 12 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
        <button style={btn()} onClick={onClose}>Cancel</button>
        <button style={btn('primary')} onClick={submit} disabled={saving}>{saving ? 'Creating…' : 'Create'}</button>
      </div>
    </ModalShell>
  );
}

function FormTypePicker({ value, onChange }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
      {FORM_TYPES.map(t => {
        const on = value === t.value;
        return (
          <button key={t.value} onClick={() => onChange(t.value)} style={{
            textAlign: 'left', padding: '12px 14px', borderRadius: 10, cursor: 'pointer', fontFamily: FONT,
            border: `1.5px solid ${on ? C.primary : B.cardBorder}`,
            background: on ? 'rgba(220,38,38,.05)' : B.card,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
              <t.Icon size={15} color={on ? C.primary : B.t4} />
              <span style={{ fontSize: 15, fontWeight: 700, color: on ? C.primary : B.t2 }}>{t.label}</span>
            </div>
            <div style={{ fontSize: 13, color: B.t5, lineHeight: 1.5 }}>{t.detail}</div>
          </button>
        );
      })}
    </div>
  );
}

// ── Builder shell (Build / Responses / Dashboard tabs) ─────────────────────────
function FormBuilder({ id, navigate }) {
  const [form, setForm] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState('builder');
  const [toast, setToast] = useState(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2500); };

  const load = useCallback(async () => {
    try { const r = await api.leadForms.get(id); setForm(r.form); }
    catch (e) { if (e.status === 404) setNotFound(true); else showToast(e.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function handleDelete() {
    try { await api.leadForms.delete(id); navigate('lead-forms'); }
    catch (e) { showToast(e.message); }
  }

  async function setStatus(status) {
    try { const r = await api.leadForms.update(id, { status }); setForm(r.form); showToast(`Form ${status}`); }
    catch (e) { showToast(e.message); }
  }

  const back = <button style={btn()} onClick={() => navigate('lead-forms')}><ArrowLeft size={14} /> Back</button>;

  if (notFound) return (
    <div style={{ padding: '22px 26px', fontFamily: FONT, flex: 1 }}>
      <div style={{ marginBottom: 16 }}>{back}</div>
      <EmptyState onCreate={() => navigate('lead-forms')} />
    </div>
  );
  if (!form) return (
    <div style={{ padding: '22px 26px', fontFamily: FONT, flex: 1 }}>
      <div style={{ marginBottom: 16 }}>{back}</div>
      <Shimmer height={300} radius={12} />
    </div>
  );

  const publicUrl = `${window.location.origin}/f/${form.slug}`;
  const isWhatsApp = form.formType === 'whatsapp';

  return (
    <div style={{ padding: '22px 26px', fontFamily: FONT, flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
        {back}
        <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0, color: B.t1, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{form.name}</h1>
        {form.projectName && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 14, color: B.t4, fontWeight: 600 }}>
            <FolderKanban size={13} color={C.primary} /> {form.projectName}
          </span>
        )}
        <TypeBadge type={form.formType} />
        <StatusBadge status={form.status} />
        {isWhatsApp && form.status === 'published' && (
          <button style={btn('primary')} onClick={() => setSendOpen(true)}><Send size={14} /> Send</button>
        )}
        <StatusMenu form={form} onChange={setStatus} />
        <button style={btn('danger')} onClick={() => setDeleteOpen(true)}><Trash2 size={14} /> Delete</button>
      </div>

      {form.status === 'published' && !isWhatsApp && (
        <div style={{ marginBottom: 16 }}><ShareLink url={publicUrl} /></div>
      )}

      <div style={{ display: 'flex', gap: 4, marginBottom: 18, borderBottom: `1px solid ${B.cardBorder}` }}>
        <TabBtn active={tab === 'builder'} onClick={() => setTab('builder')} icon={Settings}>Build</TabBtn>
        <TabBtn active={tab === 'table'} onClick={() => setTab('table')} icon={TableIcon}>Responses</TabBtn>
        <TabBtn active={tab === 'dashboard'} onClick={() => setTab('dashboard')} icon={BarChart3}>Dashboard</TabBtn>
      </div>

      {tab === 'builder' && <BuilderTab form={form} setForm={setForm} showToast={showToast} reload={load} />}
      {tab === 'table' && <TableTab form={form} />}
      {tab === 'dashboard' && <DashboardTab form={form} />}

      <DeleteConfirmModal open={deleteOpen} title="Delete Form"
        message={`Delete "${form.name}"? All its responses will be removed. This cannot be undone.`}
        onConfirm={handleDelete} onCancel={() => setDeleteOpen(false)} />
      {sendOpen && <SendModal form={form} onClose={() => setSendOpen(false)} showToast={showToast} />}
      {toast && <Toast>{toast}</Toast>}
    </div>
  );
}

function TabBtn({ active, onClick, icon: Icon, children }) {
  return (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 14px', border: 'none',
      background: 'none', cursor: 'pointer', fontFamily: FONT, fontSize: 15, fontWeight: 700,
      color: active ? C.primary : B.t4, borderBottom: `2px solid ${active ? C.primary : 'transparent'}`, marginBottom: -1,
    }}>
      <Icon size={14} /> {children}
    </button>
  );
}

function StatusMenu({ form, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const opts = [
    { v: 'draft', label: 'Move to Draft' },
    { v: 'published', label: 'Publish' },
    { v: 'closed', label: 'Close (stop accepting responses)' },
  ].filter(o => o.v !== form.status);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button style={btn()} onClick={() => setOpen(o => !o)}>Status <ChevronDown size={13} /></button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 10, boxShadow: C.shadowMd, overflow: 'hidden', zIndex: 20, minWidth: 220 }}>
          {opts.map(o => (
            <button key={o.v} onClick={() => { onChange(o.v); setOpen(false); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px', border: 'none', background: 'none', cursor: 'pointer', fontFamily: FONT, fontSize: 15, color: B.t2 }}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ShareLink({ url }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ background: B.innerBg, border: `1px solid ${B.innerBorder}`, borderRadius: 10, padding: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: B.t5, textTransform: 'uppercase', letterSpacing: '.05em', marginRight: 4 }}>Link</div>
      <input readOnly value={url} style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: `1px solid ${B.cardBorder}`, fontFamily: MONO, fontSize: 14, background: B.card, color: B.t2 }} />
      <button style={btn()} onClick={() => { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
        {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
      </button>
      <a href={url} target="_blank" rel="noopener noreferrer" style={{ ...btn(), textDecoration: 'none' }} title="Open form"><ExternalLink size={14} /></a>
    </div>
  );
}

// ── Builder tab ─────────────────────────────────────────────────────────────
function BuilderTab({ form, setForm, showToast, reload }) {
  const [details, setDetails] = useState({ name: form.name, description: form.description || '', successMessage: form.successMessage || '', defaultSource: form.defaultSource || '' });
  const [formType, setFormType] = useState(form.formType);
  const [fields, setFields] = useState(form.fields.length ? form.fields : []);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [uploading, setUploading] = useState(null);
  const [assetVersion, setAssetVersion] = useState(0);

  useEffect(() => {
    setDetails({ name: form.name, description: form.description || '', successMessage: form.successMessage || '', defaultSource: form.defaultSource || '' });
    setFields(form.fields);
    setFormType(form.formType);
    setDirty(false);
  }, [form.id]);

  function markDirty() { setDirty(true); }
  function updateDetail(k, v) { setDetails(d => ({ ...d, [k]: v })); markDirty(); }

  function addField() { setFields(f => [...f, newField(f.length + 1)]); markDirty(); }
  function updateField(i, patch) { setFields(f => f.map((x, idx) => idx === i ? { ...x, ...patch } : x)); markDirty(); }
  function removeField(i) { setFields(f => f.filter((_, idx) => idx !== i)); markDirty(); }
  function moveField(i, dir) {
    setFields(f => {
      const j = i + dir;
      if (j < 0 || j >= f.length) return f;
      const copy = f.slice();
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
    markDirty();
  }

  async function save() {
    if (!details.name.trim()) return showToast('Name is required');

    // A blank option row is an editing artifact, not a choice — drop it before
    // validating, so a half-typed row can't block the save. Trimming matters
    // beyond tidiness: the dashboard groups answers by exact value, so " Red"
    // and "Red" would be counted as two different options.
    const cleaned = fields.map(f => (NEEDS_OPTIONS.includes(f.type)
      ? { ...f, options: (f.options || []).map(o => String(o).trim()).filter(Boolean) }
      : f));

    for (const f of cleaned) {
      if (!f.label.trim()) return showToast('Every field needs a label');
      if (NEEDS_OPTIONS.includes(f.type)) {
        if (!f.options.length) return showToast(`"${f.label}" needs at least one option`);
        const dupe = f.options.find((o, i) => f.options.indexOf(o) !== i);
        // Flagged rather than silently deduped — removing something they typed
        // without saying so is worse than asking.
        if (dupe) return showToast(`"${f.label}" lists "${dupe}" twice — every option should be different`);
      }
    }

    setSaving(true);
    try {
      const r = await api.leadForms.update(form.id, {
        name: details.name.trim(), description: details.description || null,
        successMessage: details.successMessage || null, defaultSource: details.defaultSource || null,
        formType, fields: cleaned,
      });
      setForm(r.form);
      setFields(r.form.fields);   // reflect the cleaned shape that was stored
      setDirty(false);
      showToast('Saved');
    } catch (e) { showToast(e.message); } finally { setSaving(false); }
  }

  async function handleUpload(kind, file) {
    if (!file) return;
    if (!file.type?.startsWith('image/')) return showToast('That file is not an image');
    setUploading(kind);
    try { await api.leadForms.uploadAsset(form.id, kind, file); const r = await api.leadForms.get(form.id); setForm(r.form); setAssetVersion(v => v + 1); }
    catch (e) { showToast(e.message); } finally { setUploading(null); }
  }
  async function handleRemoveAsset(kind) {
    try { await api.leadForms.removeAsset(form.id, kind); const r = await api.leadForms.get(form.id); setForm(r.form); }
    catch (e) { showToast(e.message); }
  }

  const phoneField = fields.find(f => f.mapsTo === 'phone');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {formType === 'whatsapp' && <WhatsAppSetupCard form={form} showToast={showToast} reload={reload} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 380px) 1fr', gap: 20, alignItems: 'start' }}>
        {/* Left: details + type + branding */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12, padding: 18 }}>
            <SectionTitle>Details</SectionTitle>
            <FieldRow label="Name"><input value={details.name} onChange={e => updateDetail('name', e.target.value)} style={inputStyle} /></FieldRow>
            <FieldRow label="Description"><textarea value={details.description} onChange={e => updateDetail('description', e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} /></FieldRow>
            <FieldRow label="Success message"><input value={details.successMessage} onChange={e => updateDetail('successMessage', e.target.value)} placeholder="Thanks — your response has been recorded." style={inputStyle} /></FieldRow>
            <FieldRow label="Default lead source" hint="Written to the lead's Source unless a field maps to Source.">
              <input value={details.defaultSource} onChange={e => updateDetail('defaultSource', e.target.value)} placeholder={form.name} style={inputStyle} />
            </FieldRow>
          </div>

          <div style={{ background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12, padding: 18 }}>
            <SectionTitle>Form type</SectionTitle>
            <FormTypePicker value={formType} onChange={v => { setFormType(v); markDirty(); }} />
          </div>

          <div style={{ background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12, padding: 18 }}>
            <SectionTitle>Branding</SectionTitle>
            <AssetPicker label="Logo" hasAsset={form.hasLogo} url={api.leadForms.assetUrl(form.id, 'logo') + `?v=${assetVersion}`}
              uploading={uploading === 'logo'} onPick={f => handleUpload('logo', f)} onRemove={() => handleRemoveAsset('logo')} round />
            <AssetPicker label="Banner" hasAsset={form.hasBanner} url={api.leadForms.assetUrl(form.id, 'banner') + `?v=${assetVersion}`}
              uploading={uploading === 'banner'} onPick={f => handleUpload('banner', f)} onRemove={() => handleRemoveAsset('banner')} />
          </div>
        </div>

        {/* Right: fields */}
        <div style={{ background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12, padding: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <SectionTitle nomargin>Fields</SectionTitle>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={btn()} onClick={addField}><Plus size={14} /> Add field</button>
              <button style={btn('primary')} onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}</button>
            </div>
          </div>

          <PhoneMappingNote formType={formType} phoneField={phoneField} />

          {!fields.length ? (
            <div style={{ padding: '30px 0', textAlign: 'center', color: B.t5, fontSize: 15 }}>No fields yet — add one to start building the form.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
              {fields.map((f, i) => (
                <FieldEditorRow key={f.key} field={f} index={i} count={fields.length}
                  onChange={patch => updateField(i, patch)} onRemove={() => removeField(i)} onMove={dir => moveField(i, dir)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Says plainly where the Phone column's values will come from. The spec's
// "manual mapping of the phone-number field to the corresponding table column"
// is the `mapsTo: 'phone'` control on a field; this is the readout for it.
function PhoneMappingNote({ formType, phoneField }) {
  const wa = formType === 'whatsapp';
  const tone = wa || phoneField
    ? { bg: 'rgba(15,110,86,.08)', color: C.green, Icon: Check }
    : { bg: B.innerBg, color: B.t4, Icon: Info };
  // The send token wins over a typed value (routes/leadForms.js only reads a
  // phone field when the link carried no token), so say that plainly rather
  // than leaving someone to assume the field overrides it.
  const text = wa
    ? phoneField
      ? `Phone comes from each recipient's own link. "${phoneField.label || 'your phone field'}" is only used when someone opens the form without one — a forwarded link, say.`
      : "Phone is filled in automatically from each recipient's own link — you don't need a phone field."
    : phoneField
      ? `"${phoneField.label || 'Untitled field'}" fills the Phone column${phoneField.required ? ' and is required' : ' — it is optional, so it can be left blank'}.`
      : 'No field maps to Phone, so the Phone column stays empty and responses will not link to a lead. Add a field and set "Save to column" to Phone if you want people to volunteer one.';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: tone.bg, borderRadius: 9, padding: '9px 11px', marginTop: 12 }}>
      <tone.Icon size={14} color={tone.color} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ fontSize: 14, color: B.t3, lineHeight: 1.5 }}>{text}</div>
    </div>
  );
}

// ── WhatsApp setup (template) ───────────────────────────────────────────────
function WhatsAppSetupCard({ form, showToast, reload }) {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState(form.waAccountId ? String(form.waAccountId) : '');
  const [templates, setTemplates] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => { api.whatsappAccounts.list(true).then(setAccounts).catch(() => {}); }, []);

  const loadTemplates = useCallback(() => {
    if (!accountId) { setTemplates([]); return; }
    setTemplates(null);
    api.leadForms.templates(form.id, accountId).then(r => setTemplates(r.templates || [])).catch(() => setTemplates([]));
  }, [form.id, accountId]);
  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  async function pickAccount(v) {
    setAccountId(v);
    try { await api.leadForms.update(form.id, { waAccountId: v ? Number(v) : null }); }
    catch (e) { showToast(e.message); }
  }

  const approved = (templates || []).filter(t => t.status === 'APPROVED');
  const pending = (templates || []).filter(t => t.status === 'SUBMITTED');

  return (
    <div style={{ background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12, padding: 18 }}>
      <SectionTitle>WhatsApp setup</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18, alignItems: 'start' }}>
        <div>
          <FieldRow label="Send from" hint="The WhatsApp number this form goes out on.">
            <SearchableSelect value={accountId} onChange={pickAccount}
              options={accounts.map(a => ({ value: String(a.id), label: a.displayName ? `${a.displayName} (${a.displayPhoneNumber})` : a.displayPhoneNumber }))}
              placeholder="Choose a WhatsApp number" />
          </FieldRow>
          {accountId && <AccountHealthBanner accountId={accountId} style={{ marginTop: 4, marginBottom: 0 }} />}
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
            <label style={{ fontSize: 14, fontWeight: 600, color: B.t4 }}>Template</label>
            <button style={{ ...btn(), padding: '6px 11px', fontSize: 14 }} onClick={() => setCreateOpen(true)} disabled={!accountId}>
              <Plus size={13} /> Create template
            </button>
          </div>
          {!accountId ? (
            <div style={{ fontSize: 14, color: B.t6 }}>Pick a number first.</div>
          ) : templates == null ? (
            <div style={{ fontSize: 14, color: B.t6 }}>Loading templates…</div>
          ) : templates.length === 0 ? (
            <div style={{ fontSize: 14, color: B.t6, lineHeight: 1.55 }}>
              No template carries this form's link yet. Create one — Meta has to approve it before you can send, which usually takes a few minutes to a day.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {templates.map(t => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: B.innerBg, borderRadius: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: B.t2, fontFamily: MONO, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
                  <CategoryBadge category={t.category} />
                  <TemplateStatusBadge status={t.status} />
                </div>
              ))}
              {!approved.length && pending.length > 0 && (
                <div style={{ fontSize: 13, color: B.t6, marginTop: 2 }}>Waiting on Meta's approval — you can send as soon as one turns Approved.</div>
              )}
            </div>
          )}
        </div>
      </div>

      {createOpen && (
        <CreateTemplateModal form={form} accountId={accountId}
          onClose={() => setCreateOpen(false)}
          onCreated={(msg) => { setCreateOpen(false); showToast(msg); loadTemplates(); reload(); }} />
      )}
    </div>
  );
}

function CreateTemplateModal({ form, accountId, onClose, onCreated }) {
  const [category, setCategory] = useState('UTILITY');
  const [body, setBody] = useState("Hi! We'd love to hear from you — please fill out this quick form.");
  const [footer, setFooter] = useState('');
  const [buttonText, setButtonText] = useState('Open form');
  const [submitToMeta, setSubmitToMeta] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const cat = TEMPLATE_CATEGORIES.find(c => c.value === category);

  async function submit() {
    setError('');
    if (!body.trim()) return setError('Message text is required');
    if (!buttonText.trim()) return setError('Button text is required');
    setSaving(true);
    try {
      const r = await api.leadForms.createTemplate(form.id, {
        category, body: body.trim(), footer: footer.trim() || null,
        buttonText: buttonText.trim(), waAccountId: Number(accountId), submit: submitToMeta,
      });
      // A Meta rejection still leaves a saved draft, so this is a partial
      // success — say which half worked rather than a flat "done".
      if (r.submitError) onCreated(`Template saved as a draft — Meta did not accept it: ${r.submitError}`);
      else if (r.warning) onCreated(r.warning);
      else onCreated(submitToMeta ? 'Template sent to Meta for approval' : 'Template saved as a draft');
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <ModalShell onClose={onClose} width={560}>
      <h2 style={{ margin: '0 0 6px', fontSize: 20, fontWeight: 700, color: B.t1 }}>Create WhatsApp template</h2>
      <p style={{ margin: '0 0 18px', fontSize: 14, color: B.t5, lineHeight: 1.55 }}>
        The button linking to this form is added for you. Meta has to approve the template before you can send it.
      </p>

      <FieldRow label="Category">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {TEMPLATE_CATEGORIES.map(c => {
            const on = category === c.value;
            return (
              <button key={c.value} onClick={() => setCategory(c.value)} style={{
                textAlign: 'left', padding: '11px 13px', borderRadius: 10, cursor: 'pointer', fontFamily: FONT,
                border: `1.5px solid ${on ? c.color : B.cardBorder}`, background: on ? c.bg : B.card,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                  <c.Icon size={15} color={on ? c.color : B.t4} />
                  <span style={{ fontSize: 15, fontWeight: 700, color: on ? c.color : B.t2 }}>{c.label}</span>
                </div>
                <div style={{ fontSize: 13, color: B.t5, lineHeight: 1.5 }}>{c.desc}</div>
              </button>
            );
          })}
        </div>
      </FieldRow>

      <FieldRow label="Message" hint="Plain text only here. For variables or a media header, use the Template Builder.">
        <textarea value={body} onChange={e => setBody(e.target.value)} rows={4} style={{ ...inputStyle, resize: 'vertical' }} />
      </FieldRow>
      <FieldRow label="Footer (optional)">
        <input value={footer} onChange={e => setFooter(e.target.value)} maxLength={60} placeholder="e.g. Forgemind AI Academy" style={inputStyle} />
      </FieldRow>
      <FieldRow label="Button text" hint="What the tappable button says. Max 25 characters.">
        <input value={buttonText} onChange={e => setButtonText(e.target.value)} maxLength={25} style={inputStyle} />
      </FieldRow>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, color: B.t3, cursor: 'pointer', marginBottom: 14 }}>
        <input type="checkbox" checked={submitToMeta} onChange={e => setSubmitToMeta(e.target.checked)} />
        Send to Meta for approval now
      </label>

      <div style={{ background: B.innerBg, borderRadius: 9, padding: '10px 12px', marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: B.t5, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Preview</div>
        <div style={{ fontSize: 15, color: B.t2, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{body || '…'}</div>
        {footer && <div style={{ fontSize: 13, color: B.t6, marginTop: 6 }}>{footer}</div>}
        <div style={{ marginTop: 9, paddingTop: 9, borderTop: `1px solid ${B.cardBorder}`, textAlign: 'center', fontSize: 15, fontWeight: 600, color: cat?.color || C.primary }}>
          {buttonText || 'Open form'}
        </div>
      </div>

      {error && <div style={{ color: 'var(--c-dangerStrong, #991B1B)', fontSize: 15, marginBottom: 12 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button style={btn()} onClick={onClose}>Cancel</button>
        <button style={btn('primary')} onClick={submit} disabled={saving}>{saving ? 'Creating…' : 'Create template'}</button>
      </div>
    </ModalShell>
  );
}

// ── Send ────────────────────────────────────────────────────────────────────
// Each recipient's link gets its own token at send time (routes/broadcasts.js),
// which is what makes the phone capture silent.
function SendModal({ form, onClose, showToast }) {
  const [accounts, setAccounts] = useState([]);
  const [templates, setTemplates] = useState(null);
  const [templateId, setTemplateId] = useState(form.templateId ? String(form.templateId) : '');
  const [recipientsText, setRecipientsText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const accountId = form.waAccountId ? String(form.waAccountId) : '';

  useEffect(() => { api.whatsappAccounts.list(true).then(setAccounts).catch(() => {}); }, []);
  useEffect(() => {
    if (!accountId) { setTemplates([]); return; }
    api.leadForms.templates(form.id, accountId)
      .then(r => setTemplates((r.templates || []).filter(t => t.status === 'APPROVED')))
      .catch(() => setTemplates([]));
  }, [form.id, accountId]);

  async function send() {
    setError('');
    if (!accountId) return setError('This form has no WhatsApp number set — pick one under WhatsApp setup.');
    if (!templateId) return setError('Pick an approved template');
    const recipients = recipientsText.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
      const [num, ...rest] = line.split(',');
      return { contact_number: (num || '').trim(), name: rest.join(',').trim() };
    }).filter(r => r.contact_number);
    if (!recipients.length) return setError('Add at least one recipient (one per line)');

    const account = accounts.find(a => String(a.id) === accountId);
    setSending(true);
    try {
      const created = await api.broadcasts.create({
        from_number: account?.displayPhoneNumber, recipient_numbers: recipients,
        template_id: Number(templateId), message_type: 'template',
        name: `Form: ${form.name}`, lead_form_id: form.id, status: 'DRAFT',
      });
      await api.broadcasts.send(created.id);
      showToast(`Sending to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}`);
      onClose();
    } catch (e) { setError(e.message); } finally { setSending(false); }
  }

  return (
    <ModalShell onClose={onClose} width={520}>
      <h2 style={{ margin: '0 0 6px', fontSize: 20, fontWeight: 700, color: B.t1 }}>Send form</h2>
      <p style={{ margin: '0 0 18px', fontSize: 14, color: B.t5, lineHeight: 1.55 }}>
        Every recipient gets their own link, so their number is filled in for them.
      </p>

      <FieldRow label="Template">
        {templates == null ? (
          <div style={{ fontSize: 14, color: B.t6 }}>Loading templates…</div>
        ) : templates.length === 0 ? (
          <div style={{ fontSize: 14, color: B.t6, lineHeight: 1.55 }}>
            No approved template carries this form's link yet. Create one under WhatsApp setup on the Build tab and wait for Meta to approve it.
          </div>
        ) : (
          <SearchableSelect value={templateId} onChange={setTemplateId}
            options={templates.map(t => ({ value: String(t.id), label: t.name, sublabel: t.category }))}
            placeholder="Choose template" />
        )}
      </FieldRow>

      <FieldRow label="Recipients" hint="One per line — phone number, optional name (e.g. 91XXXXXXXXXX, Jane Doe)">
        <textarea rows={5} value={recipientsText} onChange={e => setRecipientsText(e.target.value)}
          placeholder={'91XXXXXXXXXX, Jane Doe\n91YYYYYYYYYY'} style={{ ...inputStyle, resize: 'vertical', fontFamily: MONO, fontSize: 14 }} />
      </FieldRow>

      {error && <div style={{ color: 'var(--c-dangerStrong, #991B1B)', fontSize: 15, marginBottom: 12 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button style={btn()} onClick={onClose}>Cancel</button>
        <button style={btn('primary')} onClick={send} disabled={sending}><Send size={14} /> {sending ? 'Sending…' : 'Send'}</button>
      </div>
    </ModalShell>
  );
}

// ── Branding picker ─────────────────────────────────────────────────────────
// Click to browse, drop an image on it, or hover it and press Ctrl+V — every
// file input in a Forge app takes a paste.
function AssetPicker({ label, hasAsset, url, uploading, onPick, onRemove, round }) {
  const ref = useRef(null);
  const [armed, setArmed] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Only listens while the pointer is over this picker, so with a logo and a
  // banner side by side the paste can never land on the wrong one.
  useEffect(() => {
    if (!armed) return;
    const onPaste = (e) => {
      const file = [...(e.clipboardData?.files || [])][0];
      if (file) { e.preventDefault(); onPick(file); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [armed, onPick]);

  return (
    <div style={{ marginBottom: 14 }}
      onMouseEnter={() => setArmed(true)} onMouseLeave={() => setArmed(false)}>
      <div style={{ fontSize: 14, fontWeight: 600, color: B.t4, marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          onClick={() => ref.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) onPick(f); }}
          style={{
            width: round ? 52 : 90, height: 52, borderRadius: round ? 12 : 8,
            border: `1.5px dashed ${dragOver || armed ? C.primary : B.cardBorder}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
            background: dragOver ? 'rgba(220,38,38,.05)' : B.innerBg, flexShrink: 0, cursor: 'pointer',
          }}>
          {uploading ? <Loader2 size={16} className="spin" /> : hasAsset ? <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <ImagePlus size={16} color={B.t6} />}
        </div>
        <button style={btn()} onClick={() => ref.current?.click()} disabled={!!uploading}>{hasAsset ? 'Replace' : 'Upload'}</button>
        {hasAsset && <button style={{ ...btn(), color: 'var(--c-dangerStrong, #991B1B)' }} onClick={onRemove} title={`Remove ${label.toLowerCase()}`}><X size={13} /></button>}
        <input ref={ref} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { onPick(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      <div style={{ fontSize: 13, color: B.t6, marginTop: 5 }}>Drop an image here, or hover and press Ctrl+V.</div>
      <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } } .spin { animation: spin 1s linear infinite; }`}</style>
    </div>
  );
}

function FieldEditorRow({ field, index, count, onChange, onRemove, onMove }) {
  // Registered custom Leads fields (Admin Settings → Fields) are extra mapping
  // targets: 'cf:<field_key>' stores the answer under that field on the lead,
  // so it shows on the Leads/Sales Log tables and resolves as {{lead.<key>}}.
  const { leadCustom } = useFieldRegistry();
  const mapsToOpts = [
    ...MAPS_TO_OPTS,
    ...leadCustom.map(f => ({ value: `cf:${f.fieldKey}`, label: `Custom field: ${f.label}` })),
  ];
  return (
    <div style={{ border: `1px solid ${B.cardBorder}`, borderRadius: 10, padding: 12, background: B.innerBg }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 4 }}>
          <button disabled={index === 0} onClick={() => onMove(-1)} style={{ ...iconBtnStyle, opacity: index === 0 ? 0.35 : 1 }} title="Move up"><ArrowUp size={12} /></button>
          <button disabled={index === count - 1} onClick={() => onMove(1)} style={{ ...iconBtnStyle, opacity: index === count - 1 ? 0.35 : 1 }} title="Move down"><ArrowDown size={12} /></button>
        </div>
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 160px', gap: 8 }}>
          <input value={field.label} onChange={e => onChange({ label: e.target.value })}
            placeholder={isDisplayOnly(field.type) ? 'Section heading' : 'Question label'}
            style={{ ...inputStyle, fontWeight: 600 }} />
          {/* Switching TO a choice type seeds one empty option so the editor
              opens with a box to type in rather than an empty panel; switching
              to a rating seeds its scale + feedback prompt for the same reason.
              Switching to a section also clears `required` and `mapsTo`, which
              the server would force off anyway — doing it here too means the
              saved payload matches what the editor is showing. */}
          <SearchableSelect value={field.type} onChange={v => onChange({
            type: v,
            ...typeDefaults(v, field),
            ...(NEEDS_OPTIONS.includes(v)
              ? ((field.options || []).length ? {} : { options: [''] })
              : { options: [] }),
            ...(isDisplayOnly(v) ? { required: false } : {}),
            ...(NO_MAPPING.includes(v) ? { mapsTo: null } : {}),
          })} options={FIELD_TYPE_OPTS} triggerStyle={{ padding: '8px 28px 8px 10px', fontSize: 15 }} />
        </div>
        <button onClick={onRemove} style={{ ...iconBtnStyle, color: 'var(--c-dangerStrong, #991B1B)', marginTop: 4 }} title="Remove field"><Trash2 size={14} /></button>
      </div>

      {NEEDS_OPTIONS.includes(field.type) && (
        <div style={{ marginTop: 10, marginLeft: 24 }}>
          <OptionsEditor type={field.type} options={field.options} onChange={options => onChange({ options })} />
        </div>
      )}

      {field.type === 'rating' && (
        <div style={{ marginTop: 10, marginLeft: 24 }}>
          <RatingConfig field={field} onChange={onChange} />
        </div>
      )}

      {/* One description box, two audiences depending on the field type — and
          they never overlap, so this is one control rather than two that would
          drift. On a SECTION it is the body text shown under the heading on the
          public form. On a QUESTION it is guidance for an AI agent filling this
          column in chat, and the public form does not render it (nor does the
          public API return it). */}
      <div style={{ marginTop: 10, marginLeft: 24 }}>
        <textarea value={field.description || ''} onChange={e => onChange({ description: e.target.value })}
          rows={2} maxLength={1000}
          placeholder={isDisplayOnly(field.type)
            ? 'Optional text shown under the heading'
            : 'Optional — tell the AI agent what belongs in this column, e.g. "the city only, not the state"'}
          style={{ ...inputStyle, resize: 'vertical', fontSize: 14 }} />
        {!isDisplayOnly(field.type) && (
          <div style={{ fontSize: 13, color: B.t5, marginTop: 4 }}>
            Only the agent reads this. People filling the form never see it.
          </div>
        )}
      </div>

      {/* A section collects nothing, so Required and Save-to-column are hidden
          rather than shown-and-ignored — a control that saves and then does
          nothing is worse than no control. Rating hides only the mapping: it
          is a real, answerable question that can be Required. */}
      {!isDisplayOnly(field.type) && (
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 8, marginLeft: 24, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: B.t3, cursor: 'pointer' }}>
            <input type="checkbox" checked={field.required} onChange={e => onChange({ required: e.target.checked })} /> Required
          </label>
          {NO_MAPPING.includes(field.type) ? (
            <span style={{ fontSize: 14, color: B.t5 }}>Answers are kept in this form's own column.</span>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flex: '1 1 240px', minWidth: 200 }}>
              <span style={{ fontSize: 14, color: B.t5, whiteSpace: 'nowrap' }}>Save to column</span>
              <div style={{ flex: 1 }}>
                <SearchableSelect value={field.mapsTo || ''} onChange={v => onChange({ mapsTo: v || null })} options={mapsToOpts} triggerStyle={{ padding: '6px 26px 6px 9px', fontSize: 14 }} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Scale + optional feedback box, with a live preview of the stars the
// respondent will see — the scale is the whole point of the field, and a
// number in a dropdown does not show that a 4-star form looks different.
function RatingConfig({ field, onChange }) {
  const scale = RATING_SCALES.includes(parseInt(field.scale, 10)) ? parseInt(field.scale, 10) : DEFAULT_RATING_SCALE;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, color: B.t5, whiteSpace: 'nowrap' }}>Scale</span>
        <div style={{ display: 'flex', gap: 5 }}>
          {RATING_SCALES.map(n => {
            const on = n === scale;
            return (
              <button key={n} onClick={() => onChange({ scale: n })}
                style={{
                  fontFamily: FONT, fontSize: 14, fontWeight: on ? 700 : 500, cursor: 'pointer',
                  padding: '5px 11px', borderRadius: 7,
                  border: `1px solid ${on ? C.primary : B.cardBorder}`,
                  background: on ? 'var(--c-dangerBgSoft, #FEF2F2)' : C.cardBg, color: on ? C.primary : B.t3,
                }}>
                {n}-star
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 1, marginLeft: 2 }}>
          {Array.from({ length: scale }, (_, i) => (
            <Star key={i} size={13} strokeWidth={1.75} color="#F59E0B" fill="#F59E0B" />
          ))}
        </div>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: B.t3, cursor: 'pointer' }}>
        <input type="checkbox" checked={!!field.feedback} onChange={e => onChange({ feedback: e.target.checked })} />
        Ask for feedback under the stars
      </label>

      {field.feedback && (
        <input value={field.feedbackLabel ?? DEFAULT_FEEDBACK_LABEL}
          onChange={e => onChange({ feedbackLabel: e.target.value })}
          placeholder={DEFAULT_FEEDBACK_LABEL}
          style={{ ...inputStyle, fontSize: 14 }} />
      )}
      {field.feedback && (
        <span style={{ fontSize: 13, color: B.t5 }}>
          The comment box is always optional, even when the rating is required.
        </span>
      )}
    </div>
  );
}

// One row per choice, the way the respondent will actually see them.
//
// This replaced a single "Options, comma-separated" input, which had two real
// defects on top of looking dated: an option could never CONTAIN a comma
// ("Yes, definitely" silently became two options), and because the input's
// value was re-derived from `options.join(', ')` on every keystroke, typing a
// comma rewrote the string under the cursor and moved it. Binding each option
// to its own input removes both — nothing is parsed, so nothing can be
// misparsed.
//
// Bulk entry is preserved through paste rather than through a separator:
// pasting multiple lines into any option box expands into one option per line.
function OptionsEditor({ type, options, onChange }) {
  const list = Array.isArray(options) ? options : [];
  const [justAdded, setJustAdded] = useState(-1);

  const set = (i, v) => onChange(list.map((o, idx) => (idx === i ? v : o)));
  const add = () => { setJustAdded(list.length); onChange([...list, '']); };
  const remove = (i) => onChange(list.filter((_, idx) => idx !== i));
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const copy = list.slice();
    [copy[i], copy[j]] = [copy[j], copy[i]];
    onChange(copy);
  };
  // Multi-line paste becomes one option per line, replacing the box pasted
  // into. This is what the comma format was really being used for, without
  // making a comma a reserved character.
  const onPaste = (i, e) => {
    const text = e.clipboardData?.getData('text') || '';
    if (!/[\r\n]/.test(text)) return;
    e.preventDefault();
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) return;
    onChange([...list.slice(0, i), ...lines, ...list.slice(i + 1)]);
  };

  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 600, color: B.t4, marginBottom: 7 }}>Options</div>

      {!list.length && (
        <div style={{ fontSize: 14, color: B.t6, marginBottom: 8 }}>No options yet — add the first choice people can pick.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {list.map((opt, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            {/* Mirrors the control the respondent sees, so the field type is
                readable at a glance without re-checking the type dropdown. */}
            <ChoiceGlyph type={type} index={i} />
            <input
              autoFocus={justAdded === i}
              value={opt}
              onChange={e => set(i, e.target.value)}
              onPaste={e => onPaste(i, e)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); add(); }
                // Backspace on an empty box removes it — the same shortcut a
                // list editor anywhere else gives you.
                if (e.key === 'Backspace' && !opt && list.length > 1) { e.preventDefault(); remove(i); }
              }}
              placeholder={`Option ${i + 1}`}
              style={{ ...inputStyle, padding: '7px 11px' }}
            />
            <button onClick={() => move(i, -1)} disabled={i === 0}
              style={{ ...iconBtnStyle, padding: '3px 5px', opacity: i === 0 ? 0.3 : 1 }} title="Move up"><ArrowUp size={11} /></button>
            <button onClick={() => move(i, 1)} disabled={i === list.length - 1}
              style={{ ...iconBtnStyle, padding: '3px 5px', opacity: i === list.length - 1 ? 0.3 : 1 }} title="Move down"><ArrowDown size={11} /></button>
            <button onClick={() => remove(i)}
              style={{ ...iconBtnStyle, padding: '3px 5px', color: 'var(--c-dangerStrong, #991B1B)' }} title="Remove option"><X size={12} /></button>
          </div>
        ))}
      </div>

      <button onClick={add} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: list.length ? 8 : 0,
        padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: FONT,
        fontSize: 14, fontWeight: 700, color: C.primary,
        background: 'transparent', border: `1.5px dashed ${B.cardBorder}`,
      }}>
        <Plus size={13} /> Add option
      </button>
      <div style={{ fontSize: 13, color: B.t6, marginTop: 6 }}>
        Press Enter for the next one, or paste a list to add several at once.
      </div>
    </div>
  );
}

function ChoiceGlyph({ type, index }) {
  const common = { width: 18, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: B.t6 };
  if (type === 'radio') return <div style={common}><Circle size={13} /></div>;
  if (type === 'checkbox') return <div style={common}><Square size={13} /></div>;
  return <div style={{ ...common, fontSize: 13, fontFamily: MONO }}>{index + 1}.</div>;
}

// ── Responses tab ───────────────────────────────────────────────────────────
function TableTab({ form }) {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const load = useCallback(async () => {
    try { setData(await api.leadForms.submissions(form.id, { page, pageSize })); }
    catch { setData({ submissions: [], total: 0 }); }
  }, [form.id, page]);
  useEffect(() => { load(); }, [load]);

  if (!data) return <Shimmer height={240} radius={12} />;

  const totalPages = Math.max(1, Math.ceil(data.total / pageSize));
  // ONE list drives both the header cells and the body cells. Filtering the
  // headers and the rows separately is how a table silently shifts every
  // answer one column to the left.
  const answerFields = form.fields.filter(f => !isDisplayOnly(f.type));

  return (
    <div style={{ background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: `1px solid ${B.cardBorder}` }}>
        <div style={{ fontSize: 15, color: B.t4 }}>{data.total} response{data.total === 1 ? '' : 's'}</div>
        <a href={api.leadForms.exportUrl(form.id)} download style={{ textDecoration: 'none' }}>
          <button style={btn()}><Download size={14} /> Export CSV</button>
        </a>
      </div>
      {!data.submissions.length ? <EmptyChart text="No responses yet" /> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, minWidth: 600 }}>
            <thead>
              <tr style={{ background: B.innerBg, borderBottom: `1px solid ${B.cardBorder}` }}>
                {['Submitted', 'Phone', ...answerFields.map(f => f.label), 'Lead'].map((h, i) => (
                  <th key={i} style={{ padding: '9px 12px', fontSize: 13, fontWeight: 700, color: B.t4, textAlign: 'left', textTransform: 'uppercase', letterSpacing: '.05em', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.submissions.map(s => (
                <tr key={s.id} style={{ borderBottom: `1px solid ${B.rowSep}`, fontSize: 14 }}>
                  <td style={{ padding: '9px 12px', color: B.t5, whiteSpace: 'nowrap' }}>{fmtDate(s.submittedAt)}</td>
                  <td style={{ padding: '9px 12px', color: s.phoneNumber ? B.t3 : B.t7, fontFamily: s.phoneNumber ? MONO : FONT, whiteSpace: 'nowrap' }}>
                    {s.phoneNumber || <span style={{ fontSize: 14 }}>Not given</span>}
                  </td>
                  {answerFields.map(f => {
                    // Formatted, never rendered raw: a rating answer is an
                    // object, and React throws "Objects are not valid as a
                    // React child" on one — which blanks the whole page here,
                    // since the app has no error boundary.
                    const text = answerToText(f, s.answers[f.key]);
                    return (
                      <td key={f.key} title={text || undefined}
                        style={{ padding: '9px 12px', color: B.t2, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {text || '—'}
                      </td>
                    );
                  })}
                  <td style={{ padding: '9px 12px', color: s.leadId ? B.t3 : B.t7 }}>
                    {s.leadName || (s.leadId ? `#${s.leadId}` : <span style={{ fontSize: 14 }}>Not linked</span>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, padding: 12, borderTop: `1px solid ${B.cardBorder}`, fontSize: 14 }}>
          <button style={btn()} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</button>
          <span style={{ color: B.t4, padding: '9px 0' }}>Page {page} of {totalPages}</span>
          <button style={btn()} disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

// ── Dashboard tab ───────────────────────────────────────────────────────────
function DashboardTab({ form }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    api.leadForms.dashboard(form.id)
      .then(setData)
      .catch(() => setData({ totalSubmissions: 0, leadsCreated: 0, peopleCompleted: 0, identifiedSubmissions: 0, anonymousSubmissions: 0, dailySubmissions: [], fieldBreakdown: {}, ratingBreakdown: {}, recentSubmissions: [] }));
  }, [form.id]);

  if (!data) return <Shimmer height={240} radius={12} />;

  const breakdownEntries = Object.entries(data.fieldBreakdown || {});
  const ratingEntries = Object.entries(data.ratingBreakdown || {});
  const recent = data.recentSubmissions || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
        <KpiCard label="People Completed" value={data.peopleCompleted ?? data.totalSubmissions} icon={Users}
          info="Distinct people who finished the form. Someone who filled it twice counts once; responses with no phone number can't be matched, so each counts on its own." />
        <KpiCard label="Total Responses" value={data.totalSubmissions} icon={ListChecks}
          info="Every completed submission, including repeat fills by the same person." />
        <KpiCard label="With Phone" value={data.identifiedSubmissions ?? 0} accent={C.green}
          info="Responses that carry a phone number — from the recipient's own link, or a field mapped to Phone." />
        <KpiCard label="Anonymous" value={data.anonymousSubmissions ?? 0} icon={UserX}
          info="Responses with no phone number. They are kept in full here, but cannot link to a lead." />
        <KpiCard label="Leads Created" value={data.leadsCreated} accent={C.green}
          info="Responses that created or updated a lead in the funnel." />
      </div>

      {(data.anonymousSubmissions ?? 0) > 0 && form.formType === 'link' && (
        <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', background: 'var(--c-warnBgSoft, #FEF9E7)', borderRadius: 10, padding: '11px 13px' }}>
          <AlertTriangle size={15} color="var(--c-s92680b, #92680B)" style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 14, color: 'var(--c-s92680b, #92680B)', lineHeight: 1.55 }}>
            {data.anonymousSubmissions} response{data.anonymousSubmissions === 1 ? '' : 's'} came in without a phone number, so {data.anonymousSubmissions === 1 ? 'it is' : 'they are'} recorded here but not in the funnel. Mark your phone field Required on the Build tab if you need every respondent reachable.
          </div>
        </div>
      )}

      <Card title="Responses — last 30 days">
        {data.dailySubmissions.length ? <LineTrend data={data.dailySubmissions} /> : <EmptyChart text="No responses in the last 30 days" />}
      </Card>

      <Card title="Latest responses">
        {!recent.length ? <EmptyChart text="No responses yet" /> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${B.cardBorder}` }}>
                  {['Name', 'Phone', 'Email', 'Submitted', 'Lead'].map((h, i) => (
                    <th key={i} style={{ padding: '8px 10px', fontSize: 13, fontWeight: 700, color: B.t4, textAlign: 'left', textTransform: 'uppercase', letterSpacing: '.05em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recent.map(r => (
                  <tr key={r.id} style={{ borderBottom: `1px solid ${B.rowSep}`, fontSize: 14 }}>
                    <td style={{ padding: '8px 10px', color: r.name ? B.t2 : B.t7, fontWeight: r.name ? 600 : 400 }}>{r.name || 'Anonymous'}</td>
                    <td style={{ padding: '8px 10px', color: r.phoneNumber ? B.t3 : B.t7, fontFamily: r.phoneNumber ? MONO : FONT, whiteSpace: 'nowrap' }}>{r.phoneNumber || 'Not given'}</td>
                    <td style={{ padding: '8px 10px', color: r.email ? B.t3 : B.t7 }}>{r.email || '—'}</td>
                    <td style={{ padding: '8px 10px', color: B.t5, whiteSpace: 'nowrap' }}>{fmtDate(r.submittedAt)}</td>
                    <td style={{ padding: '8px 10px', color: r.leadId ? C.green : B.t7 }}>{r.leadId ? 'Linked' : 'Not linked'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {ratingEntries.map(([key, r]) => <RatingCard key={key} rating={r} />)}

      {breakdownEntries.map(([key, b]) => (
        <Card key={key} title={b.label}>
          <FunnelBars data={Object.entries(b.counts).map(([label, count]) => ({ label, count }))} />
        </Card>
      ))}
    </div>
  );
}

// Average + distribution + the comments themselves.
//
// The comments are shown, not just counted: on a rating question the number is
// the summary and the free text is the reason, and a dashboard that reports
// "3.4 average, 12 comments" without showing any of them makes someone open the
// CSV to learn anything actionable.
function RatingCard({ rating }) {
  const { label, max, counts, average, responses, withFeedback, feedback = [] } = rating;
  return (
    <Card title={label}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontFamily: MONO, fontSize: 30, fontWeight: 700, color: B.t2 }}>
          {average == null ? '—' : average.toFixed(2)}
        </span>
        <span style={{ fontSize: 14, color: B.t5 }}>
          average out of {max} · {responses} rating{responses === 1 ? '' : 's'}
          {withFeedback ? ` · ${withFeedback} with a comment` : ''}
        </span>
      </div>

      {!responses ? <EmptyChart text="No ratings yet" /> : (
        // Highest star first: people read a rating distribution top-down.
        <FunnelBars data={Object.entries(counts)
          .sort((a, b) => Number(b[0]) - Number(a[0]))
          .map(([star, count]) => ({ label: `${star} star${star === '1' ? '' : 's'}`, count }))} />
      )}

      {feedback.length > 0 && (
        <div style={{ marginTop: 14, borderTop: `1px solid ${B.cardBorder}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: B.t5, textTransform: 'uppercase', letterSpacing: '.05em' }}>
            Comments
          </div>
          {feedback.map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0, fontFamily: MONO, fontSize: 13, color: B.t5, paddingTop: 1 }}>
                <Star size={11} strokeWidth={2} color="#F59E0B" fill="#F59E0B" />
                {f.rating ?? '—'}
              </span>
              <span style={{ fontSize: 14, color: B.t2, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{f.text}</span>
            </div>
          ))}
          {withFeedback > feedback.length && (
            <div style={{ fontSize: 13, color: B.t6 }}>
              Showing {feedback.length} of {withFeedback} — export the responses for the rest.
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ── shared bits ───────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const map = { draft: { bg: 'var(--c-surfaceMuted, #F1F1EE)', color: 'var(--c-textSecondary, #6B7280)', label: 'Draft' }, published: { bg: 'var(--c-successBg, #E1F5EE)', color: 'var(--c-successText, #0F6E56)', label: 'Published' }, closed: { bg: 'var(--c-dangerBgSoft, #FEF2F2)', color: 'var(--c-dangerStrong, #991B1B)', label: 'Closed' } };
  const m = map[status] || map.draft;
  return <span style={{ background: m.bg, color: m.color, fontSize: 13, fontWeight: 700, padding: '3px 9px', borderRadius: 99, fontFamily: FONT, whiteSpace: 'nowrap' }}>{m.label}</span>;
}

function TypeBadge({ type }) {
  const m = formTypeMeta(type);
  const wa = type === 'whatsapp';
  return (
    <span title={m.detail} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, background: wa ? 'var(--c-successBg, #E1F5EE)' : 'var(--c-seef2ff, #EEF2FF)',
      color: wa ? 'var(--c-successText, #0F6E56)' : 'var(--c-s4338ca, #4338CA)', fontSize: 13, fontWeight: 700, padding: '3px 9px',
      borderRadius: 99, fontFamily: FONT, whiteSpace: 'nowrap',
    }}>
      <m.Icon size={11} /> {wa ? 'WhatsApp' : 'Link'}
    </span>
  );
}

function CategoryBadge({ category }) {
  const c = TEMPLATE_CATEGORIES.find(x => x.value === category);
  if (!c) return null;
  return <span style={{ background: c.bg, color: c.color, fontSize: 12, fontWeight: 700, padding: '2px 7px', borderRadius: 99, fontFamily: FONT, whiteSpace: 'nowrap' }}>{c.label}</span>;
}

function TemplateStatusBadge({ status }) {
  const map = {
    APPROVED: { bg: 'var(--c-successBg, #E1F5EE)', color: 'var(--c-successText, #0F6E56)', label: 'Approved' },
    SUBMITTED: { bg: 'var(--c-warnBgSoft, #FEF9E7)', color: 'var(--c-s92680b, #92680B)', label: 'In review' },
    REJECTED: { bg: 'var(--c-dangerBgSoft, #FEF2F2)', color: 'var(--c-dangerStrong, #991B1B)', label: 'Rejected' },
    DRAFT: { bg: 'var(--c-surfaceMuted, #F1F1EE)', color: 'var(--c-textSecondary, #6B7280)', label: 'Draft' },
  };
  const m = map[status] || map.DRAFT;
  return <span style={{ background: m.bg, color: m.color, fontSize: 12, fontWeight: 700, padding: '2px 7px', borderRadius: 99, fontFamily: FONT, whiteSpace: 'nowrap' }}>{m.label}</span>;
}

function SectionTitle({ children, nomargin }) {
  return <div style={{ fontSize: 14, fontWeight: 700, color: B.t5, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: nomargin ? 0 : 12 }}>{children}</div>;
}

function FieldRow({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: B.t4, marginBottom: 5 }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 13, color: B.t6, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function ModalShell({ onClose, width = 480, children }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: B.card, borderRadius: 14, padding: '24px 28px', width, maxWidth: '90vw', maxHeight: '86vh', overflowY: 'auto', boxShadow: C.shadowLg }}>
        {children}
      </div>
    </div>
  );
}

function Toast({ children }) {
  return <div style={{ position: 'fixed', bottom: 20, right: 20, padding: '10px 16px', background: 'var(--c-toastBg, #111111)', color: 'var(--c-toastText, #ffffff)', borderRadius: 8, fontSize: 15, fontWeight: 600, boxShadow: C.shadowLg, zIndex: 1000, maxWidth: 420, lineHeight: 1.45 }}>{children}</div>;
}

const inputStyle = { width: '100%', padding: '9px 12px', borderRadius: 10, border: `1.5px solid ${B.cardBorder}`, fontFamily: FONT, fontSize: 15, boxSizing: 'border-box', outline: 'none', background: B.card, color: B.t2 };
const iconBtnStyle = { background: 'none', border: `1.5px solid ${B.cardBorder}`, borderRadius: 6, padding: '4px 6px', cursor: 'pointer', color: B.t4, display: 'inline-flex' };

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
