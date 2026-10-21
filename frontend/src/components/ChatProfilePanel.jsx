// Everything the CRM knows about whoever is on the other end of a chat.
//
// Opened from the contact's name/avatar in the chat header, the way WhatsApp's
// own profile pane is. It is NOT a second copy of the Leads page:
// it reads the same lead record, the same registry-driven fields and the same
// payments, and it writes through the same endpoints — so a change
// made here and a change made there cannot land differently.
//
// ⚠ TWO WRITE PATHS, DELIBERATELY.
//   · every ordinary field  -> PUT /leads/:id
//   · the STAGE             -> PUT /leads/:id/move
// The stage is not in the update route's column map on purpose: moving a lead
// writes the `lead_events` row that the CAPI, CLO, follow-up and funnel-tag
// dispatchers all read off a cursor. Writing `stage` as a plain column would
// move the lead and silently tell none of them.
import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  X, Loader2, Pencil, Check, Plus, Wallet, User as UserIcon, Tag as TagIcon,
} from 'lucide-react';
import { C, FONT, MONO, T, W } from '../constants.js';
import { api } from '../api.js';
import { showError, showSuccess } from '../lib/feedback.js';
import MaskedNumber from './MaskedNumber.jsx';
import SearchableSelect from './SearchableSelect.jsx';
import { useFieldRegistry } from '../hooks/useFieldRegistry.js';
import { useFunnelConfig } from '../hooks/useFunnelConfig.js';
import { StageBadge } from '../pages/academy/shared.jsx';

// ⚠ A LITERAL MAP, never `entity_fields.system_column`. That column is
// admin-editable free text and already names `total_paid`, which does not exist
// on `leads` — it is computed from payments. Deriving the writable set from it
// would send an UPDATE for a column that isn't there. (Same reason
// services/leadFields.js keeps its own map.)
const WRITABLE = {
  name: 'name', email: 'email', age: 'age', profession: 'profession',
  pincode: 'pincode', city: 'city', source: 'source', paid_course: 'paidCourse',
  payment_date: 'paymentDate',
};

// Which registry fields belong in which block. Anything not listed falls into
// "Details", so a field added in Admin Settings shows up here on its own rather
// than having to be registered in a second place.
const FUNNEL_KEYS = new Set(['source', 'stage', 'assigned_to']);
const MONEY_KEYS = new Set(['paid_course', 'total_paid', 'payment_date']);
const IDENTITY_KEYS = new Set(['name', 'whatsapp_number']);

const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const shortDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

function Section({ title, Icon, action, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        {Icon && <Icon size={14} color={C.textSecondary} />}
        <span style={{
          fontSize: T.label, fontWeight: W.medium, color: C.textSecondary,
          textTransform: 'uppercase', letterSpacing: '.04em', fontFamily: FONT,
        }}>{title}</span>
        <div style={{ marginLeft: 'auto' }}>{action}</div>
      </div>
      {children}
    </div>
  );
}

/** One label + value row. Read mode shows a dash for an empty value rather than
 *  collapsing the row — "we don't know this" is information. */
function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', padding: '7px 0' }}>
      <span style={{ width: 132, flexShrink: 0, fontSize: T.meta, color: C.textMuted, fontFamily: FONT }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0, fontSize: T.body, color: C.text, fontFamily: FONT }}>{children}</div>
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: '9px 11px', borderRadius: 12, border: 'none',
  background: 'var(--fc-surface)', color: C.text, fontFamily: FONT,
  fontSize: T.body, outline: 'none', boxSizing: 'border-box',
};

export default function ChatProfilePanel({ contactNumber, contactName, avatarUrl, user, onClose, inline = false }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({});
  const [products, setProducts] = useState([]);
  const [assignees, setAssignees] = useState(null);
  const [addingPay, setAddingPay] = useState(false);

  const { lead: leadFields } = useFieldRegistry();
  const { stages, sources } = useFunnelConfig();
  const isAdmin = user?.role === 'admin';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.leads.byPhone(contactNumber));
    } catch (e) {
      showError(e.message || 'Could not load this profile.');
      setData({ lead: null, installments: [], totalPaid: 0, isCustomer: false });
    } finally { setLoading(false); }
  }, [contactNumber]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.products.list().then(r => setProducts(r.products || r.courses || [])).catch(() => {});
    // /users is admin-only by design; a 403 is an ordinary answer for a BDA and
    // just means the assignee row stays read-only for them.
    if (isAdmin) api.users.list().then(r => setAssignees(r.users || r || [])).catch(() => setAssignees(null));
  }, [isAdmin]);

  const lead = data?.lead || null;

  // Seed the draft from the lead every time editing opens, so Cancel is a real
  // cancel and a refetch cannot leave half-edited values on screen.
  const startEdit = () => {
    if (!lead) return;
    const d = { stage: lead.stage, assignedUserId: lead.assignedUserId ?? '' };
    for (const [col, key] of Object.entries(WRITABLE)) d[col] = lead[key] ?? '';
    for (const f of leadFields) if (!f.isSystem) d[f.fieldKey] = lead.customFields?.[f.fieldKey] ?? '';
    setDraft(d);
    setEditing(true);
  };

  const save = async () => {
    if (!lead) return;
    setSaving(true);
    try {
      const body = {};
      for (const [col, key] of Object.entries(WRITABLE)) {
        const v = draft[col];
        if (String(v ?? '') !== String(lead[key] ?? '')) body[key] = v === '' ? null : v;
      }
      const merge = {};
      for (const f of leadFields) {
        if (f.isSystem) continue;
        const v = draft[f.fieldKey];
        if (String(v ?? '') !== String(lead.customFields?.[f.fieldKey] ?? '')) merge[f.fieldKey] = v === '' ? null : v;
      }
      // ⚠ MERGE, never a wholesale replace: the write happens in SQL so two
      // people editing different fields cannot discard each other's keys.
      if (Object.keys(merge).length) body.customFieldsMerge = merge;
      if (isAdmin && String(draft.assignedUserId ?? '') !== String(lead.assignedUserId ?? '')) {
        body.assignedUserId = draft.assignedUserId === '' ? null : draft.assignedUserId;
      }
      if (Object.keys(body).length) await api.leads.update(lead.id, body);
      // The stage goes through its own route — see the header note.
      if (draft.stage && draft.stage !== lead.stage) await api.leads.move(lead.id, draft.stage);
      setEditing(false);
      await load();
      showSuccess('Profile updated.');
    } catch (e) {
      showError(e.message || 'Could not save the profile.');
    } finally { setSaving(false); }
  };

  const productOptions = useMemo(
    () => products.filter(p => p.active !== false).map(p => ({ value: p.name, label: p.name })),
    [products]
  );

  const fieldControl = (f) => {
    const isCustom = !f.isSystem;
    const key = isCustom ? f.fieldKey : f.fieldKey;
    const set = (v) => setDraft(d => ({ ...d, [key]: v }));
    const val = draft[key] ?? '';
    if (f.fieldKey === 'stage') {
      return <SearchableSelect value={draft.stage || ''} onChange={v => setDraft(d => ({ ...d, stage: v }))}
        options={stages.map(s => ({ value: s.stageKey, label: s.label }))} placeholder="Pick a stage…" />;
    }
    if (f.fieldKey === 'assigned_to') {
      if (!isAdmin || !assignees) return <span style={{ color: C.textMuted }}>{lead.assignedUserName || 'Unassigned'}</span>;
      return <SearchableSelect value={String(draft.assignedUserId ?? '')} onChange={v => setDraft(d => ({ ...d, assignedUserId: v }))}
        options={[{ value: '', label: 'Unassigned' }, ...assignees.map(u => ({ value: String(u.id), label: u.displayName || u.username, sublabel: u.role }))]}
        placeholder="Unassigned" />;
    }
    if (f.fieldKey === 'source') {
      return <SearchableSelect value={val} onChange={set}
        options={(sources || []).map(s => ({ value: s, label: s }))} placeholder="Pick a source…" />;
    }
    if (f.fieldKey === 'paid_course') {
      return <SearchableSelect value={val} onChange={set} options={productOptions} placeholder="No product" />;
    }
    if (f.fieldType === 'dropdown' && (f.options || []).length) {
      return <SearchableSelect value={val} onChange={set}
        options={f.options.map(o => ({ value: o, label: o }))} placeholder="Not set" />;
    }
    if (f.fieldType === 'textarea') {
      return <textarea value={val} onChange={e => set(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />;
    }
    return <input
      value={val}
      onChange={e => set(e.target.value)}
      type={f.fieldType === 'number' ? 'number' : f.fieldType === 'date' ? 'date' : 'text'}
      style={inputStyle}
    />;
  };

  const readValue = (f) => {
    if (f.fieldKey === 'stage') return <StageBadge stage={lead.stage} />;
    if (f.fieldKey === 'assigned_to') return lead.assignedUserName || <span style={{ color: C.textMuted }}>Unassigned</span>;
    if (f.fieldKey === 'whatsapp_number') return <MaskedNumber number={lead.whatsappNumber} prefix="+" />;
    if (f.fieldKey === 'total_paid') return data.totalPaid > 0 ? rupees(data.totalPaid) : <span style={{ color: C.textMuted }}>—</span>;
    if (f.fieldKey === 'follow_up_count') return lead.followUpCount ?? 0;
    if (f.fieldType === 'date') {
      const raw = f.isSystem ? lead[WRITABLE[f.fieldKey] || camel(f.fieldKey)] : lead.customFields?.[f.fieldKey];
      return raw ? shortDate(raw) : <span style={{ color: C.textMuted }}>—</span>;
    }
    const raw = f.isSystem ? lead[WRITABLE[f.fieldKey] || camel(f.fieldKey)] : lead.customFields?.[f.fieldKey];
    if (raw == null || raw === '') return <span style={{ color: C.textMuted }}>—</span>;
    return Array.isArray(raw) ? raw.join(', ') : String(raw);
  };

  const editable = (f) => f.fieldKey === 'stage' || f.fieldKey === 'assigned_to' || !!WRITABLE[f.fieldKey] || !f.isSystem;

  const group = (keys, invert) => leadFields.filter(f => (invert ? !keys.has(f.fieldKey) : keys.has(f.fieldKey)));
  const detailFields = leadFields.filter(f =>
    !IDENTITY_KEYS.has(f.fieldKey) && !FUNNEL_KEYS.has(f.fieldKey) && !MONEY_KEYS.has(f.fieldKey));

  return (
    <>
      {/* `inline`: docked as a pane (Leads → My list) — no scrim, fills its column. */}
      {!inline && <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'var(--fc-scrim)',
        backdropFilter: 'blur(4px)', zIndex: 400,
      }} />}
      <div style={inline ? {
        width: '100%', height: '100%', background: 'var(--fc-card)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: FONT,
      } : {
        position: 'fixed', top: 'var(--fc-gutter)', right: 'var(--fc-gutter)', bottom: 'var(--fc-gutter)',
        width: 440, maxWidth: 'calc(calc(100vw / var(--fg-zoom, 1)) - 32px)', background: 'var(--fc-card)',
        borderRadius: 'var(--fc-r-lg)', boxShadow: 'var(--fc-shadow-lg)', zIndex: 401,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        animation: 'fc-pop-in .2s ease', fontFamily: FONT,
      }}>
        {/* Identity */}
        <div style={{ padding: '20px 22px 16px', flexShrink: 0, position: 'relative' }}>
          {onClose && <button onClick={onClose} title="Close" style={{
            position: 'absolute', top: 16, right: 16, width: 32, height: 32, borderRadius: 999,
            border: 'none', background: 'var(--fc-surface)', color: C.text, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><X size={16} /></button>}

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
            <div style={{
              width: 84, height: 84, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
              background: avatarUrl ? 'transparent' : C.primary, color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 30, fontWeight: W.heavy,
            }}>
              {avatarUrl
                ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : (contactName || '?').charAt(0).toUpperCase()}
            </div>
            <div>
              <div style={{ fontSize: T.h3, fontWeight: W.bold, color: C.text }}>
                {lead?.name || contactName || 'Unknown'}
              </div>
              <div style={{ fontSize: T.meta, color: C.textMuted, fontFamily: MONO, marginTop: 3 }}>
                <MaskedNumber number={contactNumber} prefix="+" />
              </div>
            </div>
            {lead && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                <StageBadge stage={lead.stage} />
                {data.isCustomer && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999,
                    fontSize: 11.5, fontWeight: W.medium, background: 'var(--c-successBg)', color: C.successText,
                  }}><Wallet size={11} /> Customer · {rupees(data.totalPaid)}</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 22px 20px' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0' }}>
              <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', color: C.textMuted }} />
            </div>
          ) : !lead ? (
            <div style={{ textAlign: 'center', padding: '40px 10px', color: C.textMuted, fontSize: T.body, lineHeight: 1.6 }}>
              <UserIcon size={30} strokeWidth={1.5} style={{ opacity: .5 }} />
              <div style={{ marginTop: 12, color: C.text, fontWeight: W.medium }}>Not in the funnel</div>
              <div style={{ marginTop: 4 }}>
                This conversation has no lead record — it predates the funnel, or the number
                is stored differently. A lead is created automatically the next time they message.
              </div>
            </div>
          ) : (
            <>
              <Section title="Funnel" Icon={TagIcon}>
                {group(FUNNEL_KEYS).map(f => (
                  <Row key={f.fieldKey} label={f.label}>
                    {editing && editable(f) ? fieldControl(f) : readValue(f)}
                  </Row>
                ))}
              </Section>

              <Section title="Details" Icon={UserIcon}>
                {detailFields.map(f => (
                  <Row key={f.fieldKey} label={f.label}>
                    {editing && editable(f) ? fieldControl(f) : readValue(f)}
                  </Row>
                ))}
              </Section>

              <Section
                title="Purchase"
                Icon={Wallet}
                action={!editing && (
                  <button onClick={() => setAddingPay(a => !a)} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px',
                    borderRadius: 999, border: 'none', background: 'var(--fc-surface-2)',
                    color: C.text, fontSize: T.meta, fontWeight: W.medium, cursor: 'pointer', fontFamily: FONT,
                  }}><Plus size={13} /> Payment</button>
                )}
              >
                {group(MONEY_KEYS).map(f => (
                  <Row key={f.fieldKey} label={f.label}>
                    {editing && editable(f) ? fieldControl(f) : readValue(f)}
                  </Row>
                ))}

                {addingPay && (
                  <AddPaymentForm
                    leadId={lead.id}
                    products={products}
                    onCancel={() => setAddingPay(false)}
                    onSaved={async () => { setAddingPay(false); await load(); }}
                  />
                )}

                <div style={{ marginTop: 10 }}>
                  {data.installments.length === 0 ? (
                    <div style={{ fontSize: T.meta, color: C.textMuted, padding: '6px 0' }}>
                      No payments recorded.
                    </div>
                  ) : data.installments.map(t => (
                    <div key={`${t.kind}-${t.id}`} style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                      borderRadius: 12, background: 'var(--fc-surface)', marginBottom: 6,
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: T.body, fontWeight: W.medium, color: C.text }}>{rupees(t.amount)}</div>
                        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                          {shortDate(t.date)} · {t.method}{t.productLabel ? ` · ${t.productLabel}` : ''}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            </>
          )}
        </div>

        {/* Footer — Edit, or Save/Cancel while editing. */}
        {lead && (
          <div style={{ flexShrink: 0, padding: '14px 22px', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            {editing ? (
              <>
                <button onClick={() => setEditing(false)} disabled={saving} style={{
                  padding: '10px 18px', borderRadius: 999, border: 'none', cursor: 'pointer',
                  background: 'var(--fc-surface-2)', color: C.text, fontSize: T.body, fontWeight: W.medium, fontFamily: FONT,
                }}>Cancel</button>
                <button onClick={save} disabled={saving} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  padding: '10px 18px', borderRadius: 999, border: 'none', cursor: saving ? 'wait' : 'pointer',
                  background: C.primary, color: '#fff', fontSize: T.body, fontWeight: W.medium, fontFamily: FONT,
                }}>
                  {saving ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={14} />}
                  Save changes
                </button>
              </>
            ) : (
              <button onClick={startEdit} style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                padding: '10px 18px', borderRadius: 999, border: 'none', cursor: 'pointer',
                background: 'var(--fc-surface-2)', color: C.text, fontSize: T.body, fontWeight: W.medium, fontFamily: FONT,
              }}><Pencil size={14} /> Edit profile</button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** snake_case system key -> the camelCase name leadRow() returns. */
function camel(k) { return k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }

function AddPaymentForm({ leadId, products, onCancel, onSaved }) {
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState('UPI');
  const [courseId, setCourseId] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const { transaction: txFields } = useFieldRegistry();
  const methodOpts = (txFields.find(f => f.fieldKey === 'method')?.options || ['UPI', 'Card', 'Cash', 'Bank Transfer', 'Other']);

  const submit = async () => {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return showError('Enter a payment amount.');
    if (!date) return showError('Pick a payment date.');
    setBusy(true);
    try {
      await api.students.addInstallment(leadId, {
        amount: amt, paymentDate: date, method,
        courseId: courseId || null, notes: notes || null,
      });
      showSuccess('Payment recorded.');
      onSaved();
    } catch (e) {
      showError(e.message || 'Could not record the payment.');
    } finally { setBusy(false); }
  };

  return (
    <div style={{ background: 'var(--fc-surface)', borderRadius: 14, padding: 14, marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input value={amount} onChange={e => setAmount(e.target.value)} type="number" placeholder="Amount ₹"
          style={{ ...inputStyle, background: 'var(--fc-surface-2)' }} />
        <input value={date} onChange={e => setDate(e.target.value)} type="date"
          style={{ ...inputStyle, background: 'var(--fc-surface-2)' }} />
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <SearchableSelect value={method} onChange={setMethod}
          options={methodOpts.map(m => ({ value: m, label: m }))} style={{ flex: 1 }} />
        <SearchableSelect value={courseId} onChange={setCourseId} style={{ flex: 1 }}
          options={[{ value: '', label: '— Same as enrolment —' },
            ...products.filter(p => p.active !== false).map(p => ({ value: String(p.id), label: p.name }))]} />
      </div>
      <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Note (optional)"
        style={{ ...inputStyle, background: 'var(--fc-surface-2)', marginBottom: 10 }} />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} disabled={busy} style={{
          padding: '8px 14px', borderRadius: 999, border: 'none', background: 'transparent',
          color: C.textSecondary, fontSize: T.meta, fontWeight: W.medium, cursor: 'pointer', fontFamily: FONT,
        }}>Cancel</button>
        <button onClick={submit} disabled={busy} style={{
          padding: '8px 16px', borderRadius: 999, border: 'none', background: C.primary,
          color: '#fff', fontSize: T.meta, fontWeight: W.medium, cursor: busy ? 'wait' : 'pointer', fontFamily: FONT,
        }}>{busy ? 'Saving…' : 'Record payment'}</button>
      </div>
    </div>
  );
}
