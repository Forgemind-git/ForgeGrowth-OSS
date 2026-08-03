// Sales Log — every paying customer (a lead at the won 'enrolled' stage), with the
// profile collected on the Razorpay payment page (Full Name / Email / Phone / Age /
// Profession / Pincode) OR entered via Add Sale. Clicking a row opens a dedicated
// detail PAGE (route #/onboarding/<id>) with the customer's transactions (Razorpay
// captured payments + manual ones) and an Add Transaction button for split /
// multi-method payments. Admins can delete a sale. (Formerly the "Students" tab.)
import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, X, Receipt, Check, Trash2, ArrowLeft, Pencil, Download, ChevronDown, FileSpreadsheet, FileText, MessageCircle } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import { showError, showSuccess } from '../../lib/feedback.js';
import { PageShell, Button, Table, Td, Modal, Field, inputStyle, EmptyState, Badge, StageBadge, fmtINR, fmtDate } from '../academy/shared.jsx';
import { Shimmer, KpiCard } from '../../components/charts.jsx';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import { useFunnelConfig } from '../../hooks/useFunnelConfig.js';
import SearchableSelect from '../../components/SearchableSelect.jsx';

// The Razorpay payment page uses a fixed Profession dropdown; mirror it here.
const PROFESSIONS = ['Student', 'Engineer', 'Freelancer', 'Business Owner', 'Marketing Professional', 'Other'];
const PROFESSION_OPTS = [{ value: '', label: '— Not set —' }, ...PROFESSIONS.map(p => ({ value: p, label: p }))];
// Payment method for a manual transaction (Razorpay rows carry their real method).
const METHODS = ['UPI', 'Card', 'Cash', 'Bank Transfer', 'Other'];
const METHOD_OPTS = METHODS.map(m => ({ value: m, label: m }));

const iconBtn = { background: 'none', border: `1.5px solid ${C.border}`, borderRadius: 7, padding: '5px 7px', cursor: 'pointer', color: C.textSecondary, display: 'inline-flex' };

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
            style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 14px', fontFamily: FONT, fontSize: 13, color: C.text, textDecoration: 'none' }}>
            <FileText size={14} color={C.textSecondary} /> CSV (.csv)
          </a>
          <a href={api.students.exportUrl('xlsx')} download onClick={() => setOpen(false)}
            style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 14px', fontFamily: FONT, fontSize: 13, color: C.text, textDecoration: 'none', borderTop: `1px solid ${C.border}` }}>
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

export default function OnboardingPage({ user, navigate, subParts }) {
  const saleId = subParts && /^\d+$/.test(subParts[0] || '') ? Number(subParts[0]) : null;
  if (saleId) return <SaleDetailPage saleId={saleId} user={user} navigate={navigate} />;
  return <SalesLogList user={user} navigate={navigate} />;
}

// ── List view ─────────────────────────────────────────────────────────────────
function SalesLogList({ user, navigate }) {
  const isAdmin = user?.role === 'admin';
  const { sources } = useFunnelConfig();
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

  const columns = [
    { label: 'Customer' }, { label: 'WhatsApp' }, { label: 'Email' }, { label: 'Age', align: 'center' },
    { label: 'Profession' }, { label: 'Pincode' }, { label: 'Product' },
    { label: 'Total Paid', align: 'right' }, { label: 'Source' },
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
                <Td bold>{s.name || '—'}</Td>
                <Td mono color={C.textSecondary}>
                  <ChatNumber number={s.whatsappNumber} waNumber={s.chatWaNumber}
                    contactNumber={s.chatContactNumber} navigate={navigate} />
                </Td>
                <Td color={C.textSecondary} style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.email || '—'}</Td>
                <Td align="center" mono>{s.age ?? '—'}</Td>
                <Td>{s.profession || '—'}</Td>
                <Td mono color={C.textSecondary}>{s.pincode || '—'}</Td>
                <Td>{s.paidCourse || '—'}</Td>
                <Td mono align="right" bold>{fmtINR(s.totalPaid)}</Td>
                <Td>{s.source || '—'}</Td>
                {isAdmin && (
                  <Td align="right">
                    <button title="Delete sale" onClick={(e) => remove(s, e)} style={{ ...iconBtn, color: C.primary }}><Trash2 size={14} /></button>
                  </Td>
                )}
              </>
            )} />}

      {addSale && <AddSaleModal products={products} sources={sources} onClose={() => setAddSale(false)} onSaved={() => { setAddSale(false); load(); }} />}
      {confirmEl}
    </PageShell>
  );
}

// ── Sale detail PAGE (profile + onboarding checklist + transactions) ───────────
function SaleDetailPage({ saleId, user, navigate }) {
  const isAdmin = user?.role === 'admin';
  const { sources } = useFunnelConfig();
  const [data, setData] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [products, setProducts] = useState([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  const load = useCallback(async () => {
    try { setData(await api.students.installments(saleId)); }
    catch (e) { if (e.status === 404) setNotFound(true); else showError(e.message); }
  }, [saleId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.products.list().then(r => setProducts(r.products || [])).catch(() => {}); }, []);

  const s = data?.student;

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
    setEditing(true);
  }

  async function saveDetails() {
    if (!form.name.trim()) return showError('Full name is required');
    if (String(form.whatsappNumber).replace(/\D/g, '').length < 7) return showError('A valid WhatsApp number is required');
    setSaving(true);
    try {
      await api.leads.update(saleId, {
        name: form.name.trim(), whatsappNumber: form.whatsappNumber.trim(), email: form.email || '',
        age: form.age === '' ? '' : Number(form.age), profession: form.profession || '',
        pincode: form.pincode || '', source: form.source || '', paidCourse: form.paidCourse || '',
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
    <button onClick={() => toggle(field)} style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'none', border: 'none', cursor: 'pointer', padding: '7px 0', fontFamily: FONT, fontSize: 13.5, color: C.text }}>
      <span style={{ width: 20, height: 20, borderRadius: 6, border: `1.5px solid ${s[field] ? C.green : C.border}`, background: s[field] ? C.green : 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {s[field] && <Check size={13} color="#fff" />}
      </span>
      {label}
    </button>
  );

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
                <div style={{ gridColumn: '1 / -1' }}><Field label="Full name"><input autoFocus value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inputStyle} /></Field></div>
                <Field label="Phone (WhatsApp)"><input value={form.whatsappNumber} onChange={e => setForm(f => ({ ...f, whatsappNumber: e.target.value }))} style={{ ...inputStyle, fontFamily: MONO }} /></Field>
                <Field label="Email"><input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} style={inputStyle} /></Field>
                <Field label="Age"><input type="number" min="0" value={form.age} onChange={e => setForm(f => ({ ...f, age: e.target.value }))} style={{ ...inputStyle, fontFamily: MONO }} /></Field>
                <Field label="Profession"><SearchableSelect value={form.profession} onChange={v => setForm(f => ({ ...f, profession: v }))} options={PROFESSION_OPTS} placeholder="— Not set —" /></Field>
                <Field label="Pincode"><input value={form.pincode} onChange={e => setForm(f => ({ ...f, pincode: e.target.value }))} style={{ ...inputStyle, fontFamily: MONO }} /></Field>
                <Field label="Source"><SearchableSelect value={form.source} onChange={v => setForm(f => ({ ...f, source: v }))} options={[{ value: '', label: '— Not set —' }, ...sources.map(src => ({ value: src, label: src }))]} placeholder="— Not set —" /></Field>
                <Field label="Product"><SearchableSelect value={form.paidCourse} onChange={v => setForm(f => ({ ...f, paidCourse: v }))} options={[{ value: '', label: '— None —' }, ...products.map(c => ({ value: c.name, label: c.name })), ...(form.paidCourse && !products.some(c => c.name === form.paidCourse) ? [{ value: form.paidCourse, label: form.paidCourse }] : [])]} placeholder="— None —" /></Field>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <Button variant="primary" onClick={saveDetails} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
                <Button onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14, marginBottom: 22 }}>
              <Meta label="Full name" value={s.name || '—'} />
              <Meta label="Phone" mono value={
                <ChatNumber number={s.whatsappNumber} waNumber={s.chatWaNumber}
                  contactNumber={s.chatContactNumber} navigate={navigate} />
              } />
              <Meta label="Email" value={s.email || '—'} />
              <Meta label="Age" value={s.age ?? '—'} mono />
              <Meta label="Profession" value={s.profession || '—'} />
              <Meta label="Pincode" value={s.pincode || '—'} mono />
              <Meta label="Source" value={s.source || '—'} />
              <Meta label="Product" value={s.paidCourse || '—'} />
              <Meta label="Total paid" value={fmtINR(data.totalPaid)} mono />
              <Meta label="Stage" value={<StageBadge stage={s.stage} />} />
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
            <Button icon={Plus} onClick={() => setAdding(true)} style={{ padding: '6px 11px', fontSize: 12 }}>Add Transaction</Button>
          </div>
          {data.installments.length === 0 ? <div style={{ fontSize: 13, color: C.textMuted, padding: '10px 0' }}>No payments recorded yet.</div> :
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT }}>
              <thead>
                <tr style={{ textAlign: 'left', fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                  <th style={{ padding: '6px 4px' }}>Date</th><th style={{ padding: '6px 4px' }}>Amount</th>
                  <th style={{ padding: '6px 4px' }}>Method</th><th style={{ padding: '6px 4px' }}>Ref / Note</th>
                </tr>
              </thead>
              <tbody>
                {data.installments.map((it) => (
                  <tr key={`${it.kind}-${it.id}`} style={{ borderTop: `1px solid ${C.border}`, fontSize: 13 }}>
                    <td style={{ padding: '9px 4px', color: C.textSecondary }}>{fmtDate(it.date)}</td>
                    <td style={{ padding: '9px 4px', fontFamily: MONO, fontWeight: 600 }}>{fmtINR(it.amount)}</td>
                    <td style={{ padding: '9px 4px' }}><Badge label={it.method} color={it.kind === 'razorpay' ? '#0F6E56' : '#6B7280'} bg={it.kind === 'razorpay' ? '#E1F5EE' : '#F1F1EE'} /></td>
                    <td style={{ padding: '9px 4px', color: C.textMuted, fontFamily: MONO, fontSize: 11.5, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.ref || it.notes || '—'}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: `2px solid ${C.border}`, fontSize: 13 }}>
                  <td style={{ padding: '9px 4px', fontWeight: 700 }}>Total</td>
                  <td style={{ padding: '9px 4px', fontFamily: MONO, fontWeight: 700, color: C.green }}>{fmtINR(data.totalPaid)}</td>
                  <td colSpan={2} />
                </tr>
              </tbody>
            </table>}
        </div>
      </div>

      {adding && <AddTransactionModal studentId={saleId} products={products} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
      {confirmEl}
    </PageShell>
  );
}

function SectionTitle({ children, nomargin }) {
  return <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: nomargin ? 0 : 12 }}>{children}</div>;
}

function Meta({ label, value, mono }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 14, color: C.text, fontWeight: 600, fontFamily: mono ? MONO : FONT }}>{value}</div>
    </div>
  );
}

// ── Add Transaction (manual payment on an existing sale) ──────────────────────
function AddTransactionModal({ studentId, products, onClose, onSaved }) {
  const [f, setF] = useState({ amount: '', paymentDate: new Date().toISOString().slice(0, 10), method: 'UPI', courseId: '', notes: '' });
  const pickProduct = (v) => setF(s => ({ ...s, courseId: v, amount: prefillAmount(products, s.courseId, v, s.amount) }));
  const [saving, setSaving] = useState(false);
  const productOpts = [{ value: '', label: '— Same as enrolment —' }, ...products.map(c => ({ value: String(c.id), label: c.name }))];
  async function save() {
    if (!(Number(f.amount) > 0)) return showError('Enter a payment amount');
    setSaving(true);
    try { await api.students.addInstallment(studentId, { amount: Number(f.amount), paymentDate: f.paymentDate, method: f.method || null, courseId: f.courseId || null, notes: f.notes || null }); showSuccess('Transaction added'); onSaved(); }
    catch (e) { showError(e.message); } finally { setSaving(false); }
  }
  return (
    <Modal title="Add transaction" onClose={onClose} width={440}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Add'}</Button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Field label="Amount (₹)"><input type="number" min="0" autoFocus value={f.amount} onChange={e => setF(s => ({ ...s, amount: e.target.value }))} style={{ ...inputStyle, fontFamily: MONO }} placeholder="0" /></Field>
        <Field label="Payment date"><input type="date" value={f.paymentDate} onChange={e => setF(s => ({ ...s, paymentDate: e.target.value }))} style={inputStyle} /></Field>
        <Field label="Payment method"><SearchableSelect value={f.method} onChange={v => setF(s => ({ ...s, method: v }))} options={METHOD_OPTS} placeholder="Method" /></Field>
        <Field label="Product (optional)"><SearchableSelect value={f.courseId} onChange={pickProduct} options={productOpts} placeholder="— Same as enrolment —" /></Field>
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
function AddSaleModal({ products, sources, onClose, onSaved }) {
  const [f, setF] = useState({ studentName: '', phone: '', email: '', age: '', profession: '', pincode: '', courseId: '', amount: '', method: 'UPI', paymentDate: new Date().toISOString().slice(0, 10), source: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const productOpts = [{ value: '', label: '— None —' }, ...products.map(c => ({ value: String(c.id), label: c.name }))];
  const pickProduct = (v) => setF(s => ({ ...s, courseId: v, amount: prefillAmount(products, s.courseId, v, s.amount) }));
  const sourceOpts = [{ value: '', label: '— Not set —' }, ...sources.map(s => ({ value: s, label: s }))];
  async function save() {
    if (!f.studentName.trim()) return showError('Customer name is required');
    if (String(f.phone).replace(/\D/g, '').length < 7) return showError('A valid WhatsApp number is required');
    setSaving(true);
    try {
      await api.students.addSale({
        studentName: f.studentName.trim(), phone: f.phone, email: f.email || null,
        age: f.age || null, profession: f.profession || null, pincode: f.pincode || null,
        courseId: f.courseId || null, amount: Number(f.amount) || 0, method: f.method || null,
        paymentDate: f.paymentDate, source: f.source || null, notes: f.notes || null,
      });
      showSuccess('Sale recorded'); onSaved();
    } catch (e) { showError(e.message); } finally { setSaving(false); }
  }
  return (
    <Modal title="Add sale" onClose={onClose} width={560} preventBackdropClose showBackButton
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Record sale'}</Button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div style={{ gridColumn: '1 / -1' }}><Field label="Full name"><input autoFocus value={f.studentName} onChange={e => setF(s => ({ ...s, studentName: e.target.value }))} style={inputStyle} placeholder="Who purchased" /></Field></div>
        <Field label="Email"><input type="email" value={f.email} onChange={e => setF(s => ({ ...s, email: e.target.value }))} style={inputStyle} placeholder="name@example.com" /></Field>
        <Field label="Phone (WhatsApp)" hint="Links to their chat/lead if it exists, else creates one."><input value={f.phone} onChange={e => setF(s => ({ ...s, phone: e.target.value }))} style={{ ...inputStyle, fontFamily: MONO }} placeholder="91XXXXXXXXXX" /></Field>
        <Field label="Age"><input type="number" min="0" value={f.age} onChange={e => setF(s => ({ ...s, age: e.target.value }))} style={{ ...inputStyle, fontFamily: MONO }} placeholder="—" /></Field>
        <Field label="Profession"><SearchableSelect value={f.profession} onChange={v => setF(s => ({ ...s, profession: v }))} options={PROFESSION_OPTS} placeholder="— Not set —" /></Field>
        <Field label="Pincode"><input value={f.pincode} onChange={e => setF(s => ({ ...s, pincode: e.target.value }))} style={{ ...inputStyle, fontFamily: MONO }} placeholder="—" /></Field>
        <Field label="Source"><SearchableSelect value={f.source} onChange={v => setF(s => ({ ...s, source: v }))} options={sourceOpts} placeholder="— Not set —" /></Field>
        <Field label="Product"><SearchableSelect value={f.courseId} onChange={pickProduct} options={productOpts} placeholder="— None —" /></Field>
        <Field label="Amount paid (₹)" hint="Pre-filled from the product's default price — change it if they paid something else."><input type="number" min="0" value={f.amount} onChange={e => setF(s => ({ ...s, amount: e.target.value }))} style={{ ...inputStyle, fontFamily: MONO }} placeholder="First transaction" /></Field>
        <Field label="Payment method"><SearchableSelect value={f.method} onChange={v => setF(s => ({ ...s, method: v }))} options={METHOD_OPTS} placeholder="Method" /></Field>
        <Field label="Payment date"><input type="date" value={f.paymentDate} onChange={e => setF(s => ({ ...s, paymentDate: e.target.value }))} style={inputStyle} /></Field>
        <div style={{ gridColumn: '1 / -1' }}><Field label="Notes (optional)"><input value={f.notes} onChange={e => setF(s => ({ ...s, notes: e.target.value }))} style={inputStyle} placeholder="Anything worth remembering" /></Field></div>
      </div>
    </Modal>
  );
}
