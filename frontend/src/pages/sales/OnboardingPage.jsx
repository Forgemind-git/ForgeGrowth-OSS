// Sales Log — every paying customer (a lead at the won 'enrolled' stage), with the
// profile collected on the Razorpay payment page (Full Name / Email / Phone / Age /
// Profession / Pincode) OR entered via Add Sale. Clicking a row opens a dedicated
// detail PAGE (route #/onboarding/<id>) with the customer's transactions (Razorpay
// captured payments + manual ones) and an Add Transaction button for split /
// multi-method payments. Admins can delete a sale. (Formerly the "Students" tab.)
//
// Columns, labels and dropdown options are REGISTRY-DRIVEN (Admin Settings →
// Fields): lead fields flagged show_in_sales are the table/detail columns, and
// custom transaction fields appear in the transactions table + both modals.
import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import { Plus, Receipt, Check, Trash2, ArrowLeft, Pencil, Download, ChevronDown, FileSpreadsheet, FileText, MessageCircle } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import { showError, showSuccess } from '../../lib/feedback.js';
import { PageShell, Button, Table, Td, Modal, Field, inputStyle, EmptyState, Badge, StageBadge, fmtINR, fmtDate } from '../academy/shared.jsx';
import { Shimmer, KpiCard } from '../../components/charts.jsx';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import { useFunnelConfig } from '../../hooks/useFunnelConfig.js';
import { useFieldRegistry, formatFieldValue } from '../../hooks/useFieldRegistry.js';
import CustomFieldInput from '../../components/CustomFieldInput.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';

const iconBtn = { background: 'none', border: `1.5px solid ${C.border}`, borderRadius: 7, padding: '5px 7px', cursor: 'pointer', color: C.textSecondary, display: 'inline-flex' };

// Registry helpers shared by the list / detail / modals.
const optsOf = (field, fallback = []) => (field?.options?.length ? field.options : fallback);
const withEmpty = (opts, label = '— Not set —') => [{ value: '', label }, ...opts.map(o => ({ value: o, label: o }))];

// Custom (non-system) lead fields that appear on Sales Log surfaces.
const saleCustomFields = (leadFields) => leadFields.filter(f => !f.isSystem && f.showInSales);
// Custom transaction fields shown in the transactions table + modals.
const txCustomFields = (txFields) => txFields.filter(f => !f.isSystem && f.showInSales);

// One transactions-table cell per registry field — system renames and Shown
// toggles in Admin Settings → Fields → Transactions take real effect here.
const txTd = { padding: '9px 4px', fontSize: 15 };
function TxCell({ f, it }) {
  if (f.isSystem) {
    switch (f.fieldKey) {
      case 'payment_date': return <td style={{ ...txTd, color: C.textSecondary }}>{fmtDate(it.date)}</td>;
      case 'amount': return <td style={{ ...txTd, fontFamily: MONO, fontWeight: 600 }}>{fmtINR(it.amount)}</td>;
      case 'method': return <td style={txTd}><Badge label={it.method} color={it.kind === 'razorpay' ? 'var(--c-successText, #0F6E56)' : 'var(--c-textSecondary, #6B7280)'} bg={it.kind === 'razorpay' ? 'var(--c-successBg, #E1F5EE)' : 'var(--c-surfaceMuted, #F1F1EE)'} /></td>;
      case 'notes': return <td style={{ ...txTd, color: C.textMuted, fontFamily: MONO, fontSize: 13, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.ref || it.notes || '—'}</td>;
      case 'product': return <td style={txTd}>{it.productLabel || '—'}</td>;
      default: return <td style={{ ...txTd, color: C.textSecondary }}>—</td>;
    }
  }
  return <td style={{ ...txTd, color: C.textSecondary }}>{formatFieldValue(it.customFields?.[f.fieldKey]) ?? '—'}</td>;
}

function requiredCustomError(fields, values) {
  for (const f of fields) {
    if (!f.required) continue;
    const v = values[f.fieldKey];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return `"${f.label}" is required`;
  }
  return null;
}

// Small "Export" split-button with a CSV / Excel choice, downloaded via GET /students/export.
function ExportMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <Button icon={Download} onClick={() => setOpen(o => !o)}>Export <ChevronDown size={13} style={{ marginLeft: 2 }} /></Button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: '0 6px 20px rgba(0,0,0,.12)', overflow: 'hidden', zIndex: 20, minWidth: 170 }}>
          <a href={api.students.exportUrl('csv')} download onClick={() => setOpen(false)}
            style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 14px', fontFamily: FONT, fontSize: 15, color: C.text, textDecoration: 'none' }}>
            <FileText size={14} color={C.textSecondary} /> CSV (.csv)
          </a>
          <a href={api.students.exportUrl('xlsx')} download onClick={() => setOpen(false)}
            style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 14px', fontFamily: FONT, fontSize: 15, color: C.text, textDecoration: 'none', borderTop: `1px solid ${C.border}` }}>
            <FileSpreadsheet size={14} color={C.textSecondary} /> Excel (.xlsx)
          </a>
        </div>
      )}
    </div>
  );
}


// A customer's WhatsApp number, linked to their chat when a thread exists.
// stopPropagation matters: in the Sales Log table the whole ROW is clickable
// (it opens the sale), so without it a click would fire both navigations.
function ChatNumber({ number, waNumber, contactNumber, navigate }) {
  if (!number) return <span style={{ color: C.textMuted }}>—</span>;
  if (!waNumber || !contactNumber || !navigate) {
    return <span title="No WhatsApp chat for this number yet">{number}</span>;
  }
  return (
    <span
      role="link"
      tabIndex={0}
      title="Open this chat"
      onClick={e => { e.stopPropagation(); navigate('chats', waNumber, contactNumber); }}
      onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); navigate('chats', waNumber, contactNumber); } }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: C.primary, cursor: 'pointer' }}
    >
      {number}<MessageCircle size={12} />
    </span>
  );
}

// One Sales Log cell per registry field (system renderers preserved; custom
// fields read the sale's custom_fields bag).
function SaleCell({ f, s, navigate }) {
  if (f.isSystem) {
    switch (f.fieldKey) {
      case 'name': return <Td bold>{s.name || '—'}</Td>;
      case 'whatsapp_number': return (
        <Td mono color={C.textSecondary}>
          <ChatNumber number={s.whatsappNumber} waNumber={s.chatWaNumber}
            contactNumber={s.chatContactNumber} navigate={navigate} />
        </Td>
      );
      case 'email': return <Td color={C.textSecondary} style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.email || '—'}</Td>;
      case 'age': return <Td align="center" mono>{s.age ?? '—'}</Td>;
      case 'profession': return <Td>{s.profession || '—'}</Td>;
      case 'pincode': return <Td mono color={C.textSecondary}>{s.pincode || '—'}</Td>;
      case 'city': return <Td>{s.city || '—'}</Td>;
      case 'source': return <Td>{s.source || '—'}</Td>;
      case 'stage': return <Td><StageBadge stage={s.stage} /></Td>;
      case 'paid_course': return <Td>{s.paidCourse || '—'}</Td>;
      case 'total_paid': return <Td mono align="right" bold>{fmtINR(s.totalPaid)}</Td>;
      case 'payment_date': return <Td color={C.textSecondary}>{s.paymentDate ? fmtDate(s.paymentDate) : '—'}</Td>;
      case 'created_at': return <Td color={C.textSecondary}>{fmtDate(s.createdAt)}</Td>;
      case 'last_activity_at': return <Td color={C.textSecondary}>{fmtDate(s.lastActivityAt)}</Td>;
      case 'follow_up_count': return <Td align="center" mono>{s.followUpCount}</Td>;
      case 'assigned_to': return <Td>{s.assignedUserName || s.assignedBda || <span style={{ color: C.textMuted }}>—</span>}</Td>;
      default: return <Td color={C.textSecondary}>—</Td>;
    }
  }
  return <Td>{formatFieldValue(s.customFields?.[f.fieldKey]) ?? '—'}</Td>;
}

export default function OnboardingPage({ user, navigate, subParts }) {
  const saleId = subParts && /^\d+$/.test(subParts[0] || '') ? Number(subParts[0]) : null;
  if (saleId) return <SaleDetailPage saleId={saleId} user={user} navigate={navigate} />;
  return <SalesLogList user={user} navigate={navigate} />;
}

// ── List view ─────────────────────────────────────────────────────────────────
function SalesLogList({ user, navigate }) {
  const isAdmin = user?.role === 'admin';
  const { sources } = useFunnelConfig();
  const { lead: leadFields, transaction: txFields } = useFieldRegistry();
  const [sales, setSales] = useState(null);
  const [products, setProducts] = useState([]);
  const [addSale, setAddSale] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  const load = useCallback(async () => {
    try { const r = await api.students.list(); setSales(r.students || []); }
    catch (e) { showError(e.message); setSales([]); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.products.list().then(r => setProducts(r.products || [])).catch(() => {}); }, []);

  const totalRevenue = (sales || []).reduce((a, s) => a + (s.totalPaid || 0), 0);

  async function remove(sale, e) {
    e.stopPropagation();
    if (!(await confirm({
      title: 'Delete sale',
      body: `Delete the sale for “${sale.name || sale.whatsappNumber}”? This removes the customer and their manual transactions from the CRM (gateway payment history is kept but un-linked). This cannot be undone.`,
      confirmLabel: 'Delete', danger: true,
    }))) return;
    try { await api.students.delete(sale.id); showSuccess('Sale deleted'); load(); }
    catch (err) { showError(err.message); }
  }

  // Columns from the registry (fields flagged for the Sales Log), in order.
  const visible = leadFields.filter(f => f.showInSales);
  const columns = [
    ...visible.map(f => ({
      label: f.label,
      align: f.isSystem && f.fieldKey === 'age' ? 'center' : f.isSystem && f.fieldKey === 'total_paid' ? 'right' : 'left',
    })),
    ...(isAdmin ? [{ label: '', align: 'right' }] : []),
  ];

  return (
    <PageShell title="Sales Log" subtitle="Every paying customer — click a sale to open its details."
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <ExportMenu />
          <Button variant="primary" icon={Plus} onClick={() => setAddSale(true)}>Add Sale</Button>
        </div>
      }>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 18 }}>
        <KpiCard label="Sales" value={sales ? sales.length : '—'} icon={Receipt} info="Paying customers (enrolled leads)." />
        <KpiCard label="Total collected" value={sales ? fmtINR(totalRevenue) : '—'} accent={C.green} info="Sum of all transactions across sales." />
      </div>

      {sales == null ? <Shimmer height={300} radius={12} /> :
        sales.length === 0 ? <EmptyState Icon={Receipt} title="No sales yet" hint="Add a sale, or a captured Razorpay payment records one automatically." /> :
          <Table columns={columns} rows={sales} keyOf={s => s.id} onRowClick={s => navigate('onboarding', String(s.id))}
            renderRow={s => (
              <>
                {visible.map(f => <Fragment key={f.fieldKey}><SaleCell f={f} s={s} navigate={navigate} /></Fragment>)}
                {isAdmin && (
                  <Td align="right">
                    <button title="Delete sale" onClick={(e) => remove(s, e)} style={{ ...iconBtn, color: C.primary }}><Trash2 size={14} /></button>
                  </Td>
                )}
              </>
            )} />}

      {addSale && (
        <AddSaleModal products={products} sources={sources} leadFields={leadFields} txFields={txFields}
          onClose={() => setAddSale(false)} onSaved={() => { setAddSale(false); load(); }} />
      )}
      {confirmEl}
    </PageShell>
  );
}

// ── Sale detail PAGE (profile + onboarding checklist + transactions) ───────────
function SaleDetailPage({ saleId, user, navigate }) {
  const isAdmin = user?.role === 'admin';
  const { sources } = useFunnelConfig();
  const { lead: leadFields, transaction: txFields, byKey } = useFieldRegistry();
  const [data, setData] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [products, setProducts] = useState([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [cfForm, setCfForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  const load = useCallback(async () => {
    try { setData(await api.students.installments(saleId)); }
    catch (e) { if (e.status === 404) setNotFound(true); else showError(e.message); }
  }, [saleId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.products.list().then(r => setProducts(r.products || [])).catch(() => {}); }, []);

  const s = data?.student;
  const saleCustoms = saleCustomFields(leadFields);
  const professionOpts = withEmpty(optsOf(byKey('lead', 'profession'),
    ['Student', 'Engineer', 'Freelancer', 'Business Owner', 'Marketing Professional', 'Other']));
  const lbl = (key, fallback) => byKey('lead', key)?.label || fallback;

  async function toggle(field) {
    const next = !s[field];
    setData(d => ({ ...d, student: { ...d.student, [field]: next } }));
    try { await api.leads.update(saleId, { [field]: next }); }
    catch (e) { showError(e.message); load(); }
  }

  function startEdit() {
    setForm({
      name: s.name || '', whatsappNumber: s.whatsappNumber || '', email: s.email || '',
      age: s.age ?? '', profession: s.profession || '', pincode: s.pincode || '',
      source: s.source || '', paidCourse: s.paidCourse || '',
    });
    setCfForm(Object.fromEntries(saleCustoms.map(f => [f.fieldKey, s.customFields?.[f.fieldKey] ?? ''])));
    setEditing(true);
  }

  async function saveDetails() {
    if (!form.name.trim()) return showError('Full name is required');
    if (String(form.whatsappNumber).replace(/\D/g, '').length < 7) return showError('A valid WhatsApp number is required');
    const reqErr = requiredCustomError(saleCustoms, cfForm);
    if (reqErr) return showError(reqErr);
    setSaving(true);
    try {
      await api.leads.update(saleId, {
        name: form.name.trim(), whatsappNumber: form.whatsappNumber.trim(), email: form.email || '',
        age: form.age === '' ? '' : Number(form.age), profession: form.profession || '',
        pincode: form.pincode || '', source: form.source || '', paidCourse: form.paidCourse || '',
        // Merge-based write: only the keys edited here — concurrent editors
        // (or an automation writing another key) are never clobbered.
        customFieldsMerge: cfForm,
      });
      showSuccess('Customer details updated');
      setEditing(false);
      load();
    } catch (e) { showError(e.message); } finally { setSaving(false); }
  }

  async function remove() {
    if (!(await confirm({
      title: 'Delete sale',
      body: `Delete the sale for “${s.name || s.whatsappNumber}”? This removes the customer and their manual transactions from the CRM (gateway payment history is kept but un-linked). This cannot be undone.`,
      confirmLabel: 'Delete', danger: true,
    }))) return;
    try { await api.students.delete(saleId); showSuccess('Sale deleted'); navigate('onboarding'); }
    catch (err) { showError(err.message); }
  }

  const back = <Button icon={ArrowLeft} onClick={() => navigate('onboarding')}>Sales Log</Button>;

  if (notFound) return (
    <PageShell title="Sale not found" actions={back}>
      <EmptyState Icon={Receipt} title="This sale no longer exists" hint="It may have been deleted." />
    </PageShell>
  );
  if (!s) return <PageShell title="Sale" actions={back}><Shimmer height={280} radius={12} /></PageShell>;

  const CheckRow = ({ field, label }) => (
    <button onClick={() => toggle(field)} style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'none', border: 'none', cursor: 'pointer', padding: '7px 0', fontFamily: FONT, fontSize: 15, color: C.text }}>
      <span style={{ width: 20, height: 20, borderRadius: 6, border: `1.5px solid ${s[field] ? C.green : C.border}`, background: s[field] ? C.green : 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {s[field] && <Check size={13} color="#fff" />}
      </span>
      {label}
    </button>
  );

  // ALL transaction fields flagged Shown — system + custom, in configured
  // order — so a rename or a visibility toggle is never a dead control.
  const txVisible = txFields.filter(f => f.showInSales);

  return (
    <PageShell
      title={s.name || 'Customer'}
      subtitle={s.whatsappNumber}
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {back}
          {isAdmin && <Button variant="danger" icon={Trash2} onClick={remove}>Delete Sale</Button>}
        </div>
      }>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 18, alignItems: 'start' }}>
        {/* Left: profile + onboarding */}
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: '20px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: editing ? 12 : 0 }}>
            <SectionTitle nomargin>Customer details</SectionTitle>
            {!editing && (
              <button title="Edit customer details" onClick={startEdit} style={{ ...iconBtn, color: C.textSecondary }}><Pencil size={14} /></button>
            )}
          </div>

          {editing ? (
            <div style={{ marginTop: 10, marginBottom: 22 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div style={{ gridColumn: '1 / -1' }}><Field label={lbl('name', 'Full name')}><input autoFocus value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inputStyle} /></Field></div>
                <Field label={`Phone (${lbl('whatsapp_number', 'WhatsApp')})`}><input value={form.whatsappNumber} onChange={e => setForm(f => ({ ...f, whatsappNumber: e.target.value }))} style={{ ...inputStyle, fontFamily: MONO }} /></Field>
                <Field label={lbl('email', 'Email')}><input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} style={inputStyle} /></Field>
                <Field label={lbl('age', 'Age')}><input type="number" min="0" value={form.age} onChange={e => setForm(f => ({ ...f, age: e.target.value }))} style={{ ...inputStyle, fontFamily: MONO }} /></Field>
                <Field label={lbl('profession', 'Profession')}><SearchableSelect value={form.profession} onChange={v => setForm(f => ({ ...f, profession: v }))} options={professionOpts} placeholder="— Not set —" /></Field>
                <Field label={lbl('pincode', 'Pincode')}><input value={form.pincode} onChange={e => setForm(f => ({ ...f, pincode: e.target.value }))} style={{ ...inputStyle, fontFamily: MONO }} /></Field>
                <Field label={lbl('source', 'Source')}><SearchableSelect value={form.source} onChange={v => setForm(f => ({ ...f, source: v }))} options={[{ value: '', label: '— Not set —' }, ...sources.map(src => ({ value: src, label: src }))]} placeholder="— Not set —" /></Field>
                <Field label={lbl('paid_course', 'Product')}><SearchableSelect value={form.paidCourse} onChange={v => setForm(f => ({ ...f, paidCourse: v }))} options={[{ value: '', label: '— None —' }, ...products.map(c => ({ value: c.name, label: c.name })), ...(form.paidCourse && !products.some(c => c.name === form.paidCourse) ? [{ value: form.paidCourse, label: form.paidCourse }] : [])]} placeholder="— None —" /></Field>
                {saleCustoms.map(f => (
                  <Field key={f.fieldKey} label={f.required ? `${f.label} *` : f.label}>
                    <CustomFieldInput field={f} value={cfForm[f.fieldKey]} onChange={v => setCfForm(prev => ({ ...prev, [f.fieldKey]: v }))} />
                  </Field>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <Button variant="primary" onClick={saveDetails} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
                <Button onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14, marginBottom: 22 }}>
              <Meta label={lbl('name', 'Full name')} value={s.name || '—'} />
              <Meta label="Phone" mono value={
                <ChatNumber number={s.whatsappNumber} waNumber={s.chatWaNumber}
                  contactNumber={s.chatContactNumber} navigate={navigate} />
              } />
              <Meta label={lbl('email', 'Email')} value={s.email || '—'} />
              <Meta label={lbl('age', 'Age')} value={s.age ?? '—'} mono />
              <Meta label={lbl('profession', 'Profession')} value={s.profession || '—'} />
              <Meta label={lbl('pincode', 'Pincode')} value={s.pincode || '—'} mono />
              <Meta label={lbl('source', 'Source')} value={s.source || '—'} />
              <Meta label={lbl('paid_course', 'Product')} value={s.paidCourse || '—'} />
              <Meta label={lbl('total_paid', 'Total paid')} value={fmtINR(data.totalPaid)} mono />
              <Meta label="Stage" value={<StageBadge stage={s.stage} />} />
              {saleCustoms.map(f => (
                <Meta key={f.fieldKey} label={f.label} value={formatFieldValue(s.customFields?.[f.fieldKey]) ?? '—'} />
              ))}
            </div>
          )}

          <SectionTitle>Onboarding</SectionTitle>
          <div>
            <CheckRow field="toolAccess" label="Tool access granted" />
            <CheckRow field="batchGroupAdded" label="Added to batch group" />
            <CheckRow field="prebatchReminderSent" label="Pre-batch reminder sent" />
          </div>
        </div>

        {/* Right: transactions */}
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: '20px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <SectionTitle nomargin>Transactions ({data.installments.length})</SectionTitle>
            <Button icon={Plus} onClick={() => setAdding(true)} style={{ padding: '6px 11px', fontSize: 14 }}>Add Transaction</Button>
          </div>
          {data.installments.length === 0 ? <div style={{ fontSize: 15, color: C.textMuted, padding: '10px 0' }}>No payments recorded yet.</div> :
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT }}>
              <thead>
                <tr style={{ textAlign: 'left', fontSize: 13, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                  {txVisible.map(f => <th key={f.fieldKey} style={{ padding: '6px 4px' }}>{f.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.installments.map((it) => (
                  <tr key={`${it.kind}-${it.id}`} style={{ borderTop: `1px solid ${C.border}`, fontSize: 15 }}>
                    {txVisible.map(f => <Fragment key={f.fieldKey}><TxCell f={f} it={it} /></Fragment>)}
                  </tr>
                ))}
                <tr style={{ borderTop: `2px solid ${C.border}`, fontSize: 15 }}>
                  <td colSpan={Math.max(txVisible.length, 1)} style={{ padding: '9px 4px', fontWeight: 700 }}>
                    Total <span style={{ fontFamily: MONO, color: C.green, marginLeft: 8 }}>{fmtINR(data.totalPaid)}</span>
                  </td>
                </tr>
              </tbody>
            </table>}
        </div>
      </div>

      {adding && (
        <AddTransactionModal studentId={saleId} products={products} txFields={txFields}
          onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />
      )}
      {confirmEl}
    </PageShell>
  );
}

function SectionTitle({ children, nomargin }) {
  return <div style={{ fontSize: 14, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: nomargin ? 0 : 12 }}>{children}</div>;
}

function Meta({ label, value, mono }) {
  return (
    <div>
      <div style={{ fontSize: 13, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 15, color: C.text, fontWeight: 600, fontFamily: mono ? MONO : FONT }}>{value}</div>
    </div>
  );
}

// ── Add Transaction (manual payment on an existing sale) ──────────────────────
function AddTransactionModal({ studentId, products, txFields, onClose, onSaved }) {
  const txCustoms = txCustomFields(txFields || []);
  const txLbl = (key, fb) => (txFields || []).find(x => x.fieldKey === key)?.label || fb;
  const methodOpts = optsOf((txFields || []).find(f => f.fieldKey === 'method'),
    ['UPI', 'Card', 'Cash', 'Bank Transfer', 'Other']).map(m => ({ value: m, label: m }));
  const [f, setF] = useState({ amount: '', paymentDate: new Date().toISOString().slice(0, 10), method: methodOpts[0]?.value || '', courseId: '', notes: '' });
  const [cf, setCf] = useState({});
  const pickProduct = (v) => setF(s => ({ ...s, courseId: v, amount: prefillAmount(products, s.courseId, v, s.amount) }));
  const [saving, setSaving] = useState(false);
  const productOpts = [{ value: '', label: '— Same as enrolment —' }, ...products.map(c => ({ value: String(c.id), label: c.name }))];
  async function save() {
    if (!(Number(f.amount) > 0)) return showError('Enter a payment amount');
    const reqErr = requiredCustomError(txCustoms, cf);
    if (reqErr) return showError(reqErr);
    setSaving(true);
    try {
      await api.students.addInstallment(studentId, {
        amount: Number(f.amount), paymentDate: f.paymentDate, method: f.method || null,
        courseId: f.courseId || null, notes: f.notes || null, customFields: cf,
      });
      showSuccess('Transaction added'); onSaved();
    }
    catch (e) { showError(e.message); } finally { setSaving(false); }
  }
  return (
    <Modal title="Add transaction" onClose={onClose} width={440}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Add'}</Button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Field label={`${txLbl('amount', 'Amount')} (₹)`}><input type="number" min="0" autoFocus value={f.amount} onChange={e => setF(s => ({ ...s, amount: e.target.value }))} style={{ ...inputStyle, fontFamily: MONO }} placeholder="0" /></Field>
        <Field label={txLbl('payment_date', 'Payment date')}><input type="date" value={f.paymentDate} onChange={e => setF(s => ({ ...s, paymentDate: e.target.value }))} style={inputStyle} /></Field>
        <Field label={txLbl('method', 'Payment method')}><SearchableSelect value={f.method} onChange={v => setF(s => ({ ...s, method: v }))} options={methodOpts} placeholder="Method" /></Field>
        <Field label={`${txLbl('product', 'Product')} (optional)`}><SearchableSelect value={f.courseId} onChange={pickProduct} options={productOpts} placeholder="— Same as enrolment —" /></Field>
        {txCustoms.map(fld => (
          <Field key={fld.fieldKey} label={fld.required ? `${fld.label} *` : fld.label}>
            <CustomFieldInput field={fld} value={cf[fld.fieldKey]} onChange={v => setCf(prev => ({ ...prev, [fld.fieldKey]: v }))} />
          </Field>
        ))}
        <div style={{ gridColumn: '1 / -1' }}><Field label="Note (optional)"><input value={f.notes} onChange={e => setF(s => ({ ...s, notes: e.target.value }))} style={inputStyle} placeholder="e.g. 2nd installment · txn ref" /></Field></div>
      </div>
    </Modal>
  );
}

// Picking a product fills the amount with its default price — but only when
// the box is empty or still holds the PREVIOUS product's default. Someone who
// typed a real figure (a part payment, a negotiated rate) then corrected the
// product must not silently lose it; that is the difference between a helpful
// default and a destructive one. Returns the amount the box should now show.
function prefillAmount(products, prevId, nextId, current) {
  const priceOf = (id) => {
    const p = (products || []).find(x => String(x.id) === String(id));
    return p?.default_price_paise != null ? String(Number(p.default_price_paise) / 100) : '';
  };
  const typedByHand = current !== '' && current !== priceOf(prevId);
  return typedByHand ? current : priceOf(nextId);
}

// ── Add Sale (create a paying customer + first transaction) ───────────────────
function AddSaleModal({ products, sources, leadFields, txFields, onClose, onSaved }) {
  const saleCustoms = saleCustomFields(leadFields || []);
  const txCustoms = txCustomFields(txFields || []);
  const byKey = (key) => (leadFields || []).find(x => x.fieldKey === key);
  const showSys = (key) => byKey(key)?.showInSales !== false; // hidden system fields drop off the form too
  const lbl = (key, fallback) => byKey(key)?.label || fallback;
  const txLbl = (key, fb) => (txFields || []).find(x => x.fieldKey === key)?.label || fb;
  const professionOpts = withEmpty(optsOf(byKey('profession'),
    ['Student', 'Engineer', 'Freelancer', 'Business Owner', 'Marketing Professional', 'Other']));
  const methodOpts = optsOf((txFields || []).find(x => x.fieldKey === 'method'),
    ['UPI', 'Card', 'Cash', 'Bank Transfer', 'Other']).map(m => ({ value: m, label: m }));

  const [f, setF] = useState({ studentName: '', phone: '', email: '', age: '', profession: '', pincode: '', courseId: '', amount: '', method: methodOpts[0]?.value || '', paymentDate: new Date().toISOString().slice(0, 10), source: '', notes: '' });
  const [cf, setCf] = useState({});
  const [txCf, setTxCf] = useState({});
  const [saving, setSaving] = useState(false);
  const productOpts = [{ value: '', label: '— None —' }, ...products.map(c => ({ value: String(c.id), label: c.name }))];
  const pickProduct = (v) => setF(s => ({ ...s, courseId: v, amount: prefillAmount(products, s.courseId, v, s.amount) }));
  const sourceOpts = [{ value: '', label: '— Not set —' }, ...sources.map(s => ({ value: s, label: s }))];
  async function save() {
    if (!f.studentName.trim()) return showError('Customer name is required');
    if (String(f.phone).replace(/\D/g, '').length < 7) return showError('A valid WhatsApp number is required');
    const reqErr = requiredCustomError(saleCustoms, cf) || requiredCustomError(txCustoms, txCf);
    if (reqErr) return showError(reqErr);
    setSaving(true);
    try {
      await api.students.addSale({
        studentName: f.studentName.trim(), phone: f.phone, email: f.email || null,
        age: f.age || null, profession: f.profession || null, pincode: f.pincode || null,
        courseId: f.courseId || null, amount: Number(f.amount) || 0, method: f.method || null,
        paymentDate: f.paymentDate, source: f.source || null, notes: f.notes || null,
        customFields: cf, transactionCustomFields: txCf,
      });
      showSuccess('Sale recorded'); onSaved();
    } catch (e) { showError(e.message); } finally { setSaving(false); }
  }
  return (
    <Modal title="Add sale" onClose={onClose} width={560} preventBackdropClose showBackButton
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Record sale'}</Button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div style={{ gridColumn: '1 / -1' }}><Field label={lbl('name', 'Full name')}><input autoFocus value={f.studentName} onChange={e => setF(s => ({ ...s, studentName: e.target.value }))} style={inputStyle} placeholder="Who purchased" /></Field></div>
        {showSys('email') && <Field label={lbl('email', 'Email')}><input type="email" value={f.email} onChange={e => setF(s => ({ ...s, email: e.target.value }))} style={inputStyle} placeholder="name@example.com" /></Field>}
        <Field label={`Phone (${lbl('whatsapp_number', 'WhatsApp')})`} hint="Links to their chat/lead if it exists, else creates one."><input value={f.phone} onChange={e => setF(s => ({ ...s, phone: e.target.value }))} style={{ ...inputStyle, fontFamily: MONO }} placeholder="91XXXXXXXXXX" /></Field>
        {showSys('age') && <Field label={lbl('age', 'Age')}><input type="number" min="0" value={f.age} onChange={e => setF(s => ({ ...s, age: e.target.value }))} style={{ ...inputStyle, fontFamily: MONO }} placeholder="—" /></Field>}
        {showSys('profession') && <Field label={lbl('profession', 'Profession')}><SearchableSelect value={f.profession} onChange={v => setF(s => ({ ...s, profession: v }))} options={professionOpts} placeholder="— Not set —" /></Field>}
        {showSys('pincode') && <Field label={lbl('pincode', 'Pincode')}><input value={f.pincode} onChange={e => setF(s => ({ ...s, pincode: e.target.value }))} style={{ ...inputStyle, fontFamily: MONO }} placeholder="—" /></Field>}
        <Field label={lbl('source', 'Source')}><SearchableSelect value={f.source} onChange={v => setF(s => ({ ...s, source: v }))} options={sourceOpts} placeholder="— Not set —" /></Field>
        <Field label={lbl('paid_course', 'Product')}><SearchableSelect value={f.courseId} onChange={pickProduct} options={productOpts} placeholder="— None —" /></Field>
        {saleCustoms.map(fld => (
          <Field key={fld.fieldKey} label={fld.required ? `${fld.label} *` : fld.label}>
            <CustomFieldInput field={fld} value={cf[fld.fieldKey]} onChange={v => setCf(prev => ({ ...prev, [fld.fieldKey]: v }))} />
          </Field>
        ))}
        <Field label={`${txLbl('amount', 'Amount paid')} (₹)`} hint="Pre-filled from the product's default price — change it if they paid something else."><input type="number" min="0" value={f.amount} onChange={e => setF(s => ({ ...s, amount: e.target.value }))} style={{ ...inputStyle, fontFamily: MONO }} placeholder="First transaction" /></Field>
        <Field label={txLbl('method', 'Payment method')}><SearchableSelect value={f.method} onChange={v => setF(s => ({ ...s, method: v }))} options={methodOpts} placeholder="Method" /></Field>
        <Field label={txLbl('payment_date', 'Payment date')}><input type="date" value={f.paymentDate} onChange={e => setF(s => ({ ...s, paymentDate: e.target.value }))} style={inputStyle} /></Field>
        {txCustoms.map(fld => (
          <Field key={fld.fieldKey} label={`${fld.label} (transaction)${fld.required ? ' *' : ''}`}>
            <CustomFieldInput field={fld} value={txCf[fld.fieldKey]} onChange={v => setTxCf(prev => ({ ...prev, [fld.fieldKey]: v }))} />
          </Field>
        ))}
        <div style={{ gridColumn: '1 / -1' }}><Field label="Notes (optional)"><input value={f.notes} onChange={e => setF(s => ({ ...s, notes: e.target.value }))} style={inputStyle} placeholder="Anything worth remembering" /></Field></div>
      </div>
    </Modal>
  );
}
