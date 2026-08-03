// Sales → Payments. Create Razorpay payment links from inside ForgeGrowth and
// track what comes back.
//
// WHY THIS PAGE EXISTS
// A link created in the Razorpay dashboard arrives at our webhook with no way
// to tell who it was for — it can only be matched by its rupee amount, which
// collides between products, is impossible for an open amount, and mis-books
// when the payer checks out with a different phone. A link created HERE carries
// the lead id, so the payment attributes itself and lands in the Sales Log with
// no manual step.
//
// Three link types, because collecting money is not always "the full price":
//   Fixed        — one exact amount.
//   Part payment — a total, with the least they may pay now. They can come back
//                  and pay the rest against the same link.
//   Open         — they decide the amount. (Razorpay requires an amount on every
//                  link, so this is a part-payment link with a ₹1 floor and the
//                  figure shown as a suggestion.)
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  CreditCard, Plus, Copy, Check, ExternalLink, RefreshCw, XCircle, Trash2,
  Download, Search, IndianRupee, AlertTriangle, MessageCircle, ArrowLeft, Loader2,
} from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO, maskPhone } from '../../constants.js';
import {
  PageShell, Button, Modal, Field, inputStyle, EmptyState, Table, Td,
  Segmented, fmtDate,
} from '../academy/shared.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import MaskedNumber from '../../components/MaskedNumber.jsx';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import { notify } from '../../lib/feedback.js';

const rupee = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// `created:false` is its own state — a row that never reached Razorpay must
// never read as "unpaid link someone is waiting on".
const STATUS_META = {
  created:        { label: 'Awaiting payment', color: '#7A5500', bg: '#FFF8E1' },
  partially_paid: { label: 'Part paid',        color: '#1D4ED8', bg: '#E8EFFF' },
  paid:           { label: 'Paid',             color: '#0F6E56', bg: '#E3F5EF' },
  cancelled:      { label: 'Cancelled',        color: '#6B7280', bg: '#F1F1EE' },
  expired:        { label: 'Expired',          color: '#6B7280', bg: '#F1F1EE' },
  not_created:    { label: 'Not created',      color: '#A32D2D', bg: '#FCEBEB' },
};

const KIND_LABEL = { fixed: 'Fixed', partial: 'Part payment', open: 'Open amount' };

function StatusPill({ request }) {
  const key = request.created ? request.status : 'not_created';
  const m = STATUS_META[key] || STATUS_META.created;
  return (
    <span style={{ display: 'inline-block', padding: '3px 9px', borderRadius: 999, fontSize: 11.5,
      fontWeight: 600, color: m.color, background: m.bg, whiteSpace: 'nowrap' }}>
      {m.label}
    </span>
  );
}

function CopyLinkButton({ url, compact }) {
  const [copied, setCopied] = useState(false);
  if (!url) return null;
  const copy = async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    catch { notify({ variant: 'error', message: 'Could not copy — your browser blocked clipboard access. Open the link and copy it from the address bar.' }); }
  };
  return (
    <button onClick={copy} title={copied ? 'Copied' : 'Copy payment link'}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: copied ? '#E3F5EF' : C.cardBg,
        border: `1.5px solid ${copied ? '#0F6E56' : C.border}`, color: copied ? '#0F6E56' : C.textSecondary,
        borderRadius: 7, padding: compact ? '4px 7px' : '6px 10px', cursor: 'pointer', fontSize: 12,
        fontFamily: FONT, fontWeight: 600 }}>
      {copied ? <Check size={13} /> : <Copy size={13} />}{!compact && (copied ? 'Copied' : 'Copy link')}
    </button>
  );
}

// Opens WhatsApp with the link pre-filled. Purely a client-side wa.me deep
// link — it does NOT go through the Chats send path, so nothing about the live
// messaging pipeline is touched.
function WhatsAppSendButton({ request, compact }) {
  if (!request.shortUrl || !request.customerPhone) return null;
  const text = [
    request.customerName ? `Hi ${request.customerName},` : 'Hi,',
    request.purpose ? `here is the payment link for ${request.purpose}:` : 'here is your payment link:',
    request.shortUrl,
  ].join(' ');
  const href = `https://wa.me/${request.customerPhone}?text=${encodeURIComponent(text)}`;
  return (
    <a href={href} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
      title="Send this link on WhatsApp"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: C.cardBg,
        border: `1.5px solid ${C.border}`, color: '#0F6E56', borderRadius: 7,
        padding: compact ? '4px 7px' : '6px 10px', cursor: 'pointer', fontSize: 12,
        fontFamily: FONT, fontWeight: 600, textDecoration: 'none' }}>
      <MessageCircle size={13} />{!compact && 'Send'}
    </a>
  );
}

function Kpi({ label, value, hint, accent }) {
  return (
    <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
        color: C.textMuted, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: MONO, color: accent || C.text, letterSpacing: '-.02em' }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

// ─── Create modal ────────────────────────────────────────────────────────────
function NewLinkModal({ onClose, onCreated, presetLead }) {
  const [kind, setKind] = useState('fixed');
  const [leadId, setLeadId] = useState(presetLead?.id || '');
  const [leads, setLeads] = useState([]);
  const [products, setProducts] = useState([]);
  const [courseId, setCourseId] = useState('');
  const [name, setName] = useState(presetLead?.name || '');
  const [phone, setPhone] = useState(presetLead?.whatsappNumber || '');
  const [email, setEmail] = useState(presetLead?.email || '');
  const [purpose, setPurpose] = useState('');
  const [amount, setAmount] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [description, setDescription] = useState('');
  const [notifySms, setNotifySms] = useState(false);
  const [notifyEmail, setNotifyEmail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const amountTouched = useRef(false);

  useEffect(() => { api.products.list().then(d => setProducts(d.products || [])).catch(() => {}); }, []);

  // Loaded once and filtered inside SearchableSelect (which searches label +
  // sublabel client-side, so name AND number both match). A server-side search
  // would need an onSearch prop the component does not have, and at this scale
  // one fetch is cheaper than a request per keystroke anyway.
  // GET /leads returns the 1000 most recently active leads (a fixed cap in the
  // route, not a parameter) — well above the current book, but if the list ever
  // outgrows it this picker is the thing that needs a real search.
  useEffect(() => {
    api.leads.list()
      .then(d => setLeads(d.leads || []))
      .catch(() => setLeads([]));
  }, []);

  // Picking a product pre-fills the amount, but never clobbers a figure someone
  // typed — same rule as prefillAmount() in the Sales Log. A negotiated rate
  // must survive correcting the product.
  const pickProduct = (v) => {
    setCourseId(v);
    const p = products.find(x => String(x.id) === String(v));
    const dflt = p?.default_price_paise != null ? Number(p.default_price_paise) / 100 : null;
    if (dflt != null && !amountTouched.current) setAmount(String(dflt));
  };

  const pickLead = (v) => {
    setLeadId(v);
    const l = leads.find(x => String(x.id) === String(v));
    if (l) {
      if (!name) setName(l.name || '');
      if (!phone) setPhone(l.whatsappNumber || '');
      if (!email) setEmail(l.email || '');
    }
  };

  const submit = async () => {
    setErr(null);
    if (!leadId && !phone.trim() && !email.trim()) {
      setErr('Pick a lead, or enter a phone number or email so we know who this link is for.');
      return;
    }
    if (!amount || Number(amount) <= 0) { setErr('Enter the amount to collect.'); return; }
    if (kind === 'partial' && (!minAmount || Number(minAmount) <= 0)) {
      setErr('A part payment needs a minimum first amount.'); return;
    }
    if (kind === 'partial' && Number(minAmount) > Number(amount)) {
      setErr('The minimum first payment cannot be more than the total.'); return;
    }
    try {
      setSaving(true);
      const created = await api.paymentRequests.create({
        leadId: leadId || null,
        customerName: name.trim() || null,
        customerPhone: phone.trim() || null,
        customerEmail: email.trim() || null,
        courseId: courseId || null,
        purpose: purpose.trim() || null,
        kind,
        amount: Number(amount),
        minAmount: kind === 'partial' ? Number(minAmount) : null,
        description: description.trim() || null,
        notifySms, notifyEmail,
      });
      onCreated(created);
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const KIND_HINT = {
    fixed: 'One exact amount. Best for a full-price sale.',
    partial: 'They can pay part of the total now and the rest later against the same link.',
    open: 'They choose what to pay. The amount below is shown as a suggestion.',
  };

  return (
    <Modal title="New payment link" onClose={onClose} width={620} preventBackdropClose
      footer={<>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={saving} icon={saving ? Loader2 : Plus}>
          {saving ? 'Creating…' : 'Create link'}
        </Button>
      </>}>
      {err && (
        <div style={{ background: '#FCEBEB', color: '#A32D2D', padding: '10px 12px', borderRadius: 8,
          fontSize: 12.5, marginBottom: 14, fontFamily: FONT }}>{err}</div>
      )}

      <Field label="Payment type">
        <Segmented
          options={[{ value: 'fixed', label: 'Fixed' }, { value: 'partial', label: 'Part payment' }, { value: 'open', label: 'Open amount' }]}
          value={kind} onChange={setKind} />
        <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 6 }}>{KIND_HINT[kind]}</div>
      </Field>

      <Field label="Lead" hint="Search by name or number. Leave blank and fill the details below to raise a link for someone new.">
        <SearchableSelect
          value={leadId} onChange={pickLead}
          options={leads.map(l => ({
            value: String(l.id),
            label: l.name || maskPhone(l.whatsappNumber),
            sublabel: maskPhone(l.whatsappNumber),
          }))}
          placeholder="Search leads…" searchPlaceholder="Type a name or number…"
          emptyText="No leads match" />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <Field label="Customer name">
          <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="Full name" />
        </Field>
        <Field label="Phone">
          <input style={inputStyle} value={phone} onChange={e => setPhone(e.target.value)} placeholder="919876543210" />
        </Field>
        <Field label="Email">
          <input style={inputStyle} value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" />
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <Field label="Product">
          <SearchableSelect
            value={courseId} onChange={pickProduct}
            options={products.filter(p => p.active).map(p => ({
              value: String(p.id), label: p.name,
              sublabel: p.default_price_paise != null ? rupee(Number(p.default_price_paise) / 100) : undefined,
            }))}
            placeholder="No product" emptyText="No products yet" />
        </Field>
        <Field label="Purpose" hint="What kind of payment this is — shows in the log and the export.">
          <input style={inputStyle} value={purpose} onChange={e => setPurpose(e.target.value)}
            placeholder="Advance / 2nd instalment / workshop seat" />
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: kind === 'partial' ? '1fr 1fr' : '1fr', gap: 12 }}>
        <Field label={kind === 'open' ? 'Suggested amount (₹)' : kind === 'partial' ? 'Total amount (₹)' : 'Amount (₹)'}>
          <input style={inputStyle} type="number" min="1" value={amount}
            onChange={e => { amountTouched.current = true; setAmount(e.target.value); }} placeholder="5000" />
        </Field>
        {kind === 'partial' && (
          <Field label="Minimum first payment (₹)">
            <input style={inputStyle} type="number" min="1" value={minAmount}
              onChange={e => setMinAmount(e.target.value)} placeholder="2000" />
          </Field>
        )}
      </div>

      <Field label="Description" hint="Shown to the customer on the Razorpay checkout page.">
        <input style={inputStyle} value={description} onChange={e => setDescription(e.target.value)}
          placeholder="Applied AI with Claude — part payment" />
      </Field>

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 4 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: C.textSecondary, fontFamily: FONT, cursor: 'pointer' }}>
          <input type="checkbox" checked={notifySms} onChange={e => setNotifySms(e.target.checked)} />
          Let Razorpay SMS the link
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: C.textSecondary, fontFamily: FONT, cursor: 'pointer' }}>
          <input type="checkbox" checked={notifyEmail} onChange={e => setNotifyEmail(e.target.checked)} />
          Let Razorpay email the link
        </label>
      </div>
    </Modal>
  );
}

// ─── Detail (routed at #/payments/<id>) ──────────────────────────────────────
function PaymentDetail({ id, navigate }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  const load = useCallback(async () => {
    try { setLoading(true); setError(null); setData(await api.paymentRequests.get(id)); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const doRefresh = async () => {
    try { setBusy(true); await api.paymentRequests.refresh(id); await load(); }
    catch (e) { notify(e.message); } finally { setBusy(false); }
  };
  const doCancel = async () => {
    const ok = await confirm({
      title: 'Cancel this payment link?',
      body: 'The customer will no longer be able to pay with it. Payments already received stay recorded.',
      confirmLabel: 'Cancel link',
      danger: true,
    });
    if (!ok) return;
    try { setBusy(true); await api.paymentRequests.cancel(id); await load(); }
    catch (e) { notify(e.message); } finally { setBusy(false); }
  };

  if (loading && !data) return <PageShell title="Payment link"><div style={{ padding: 60, textAlign: 'center', color: C.textMuted, fontFamily: FONT }}>Loading…</div></PageShell>;
  if (error || !data) {
    return (
      <PageShell title="Payment link" actions={<Button icon={ArrowLeft} onClick={() => navigate('payments')}>Payments</Button>}>
        <EmptyState Icon={AlertTriangle} title="Payment link not found" hint={error || 'It may have been removed.'} />
      </PageShell>
    );
  }

  const r = data.request;
  const rows = [
    ['Customer', r.customerName || '—'],
    ['Phone', r.customerPhone ? <MaskedNumber number={r.customerPhone} /> : '—'],
    ['Email', r.customerEmail || '—'],
    ['Product', r.productLabel || '—'],
    ['Purpose', r.purpose || '—'],
    ['Type', KIND_LABEL[r.kind] || r.kind],
    ['Amount', rupee(r.amount)],
    ...(r.kind === 'partial' ? [['Minimum first payment', rupee(r.minAmount)]] : []),
    ['Paid so far', rupee(r.amountPaid)],
    ['Still due', rupee(r.amountDue)],
    ['Created', fmtDate(r.createdAt)],
    ['Paid on', r.paidAt ? fmtDate(r.paidAt) : '—'],
    ['Raised by', r.createdBy || '—'],
    ['Razorpay link id', r.razorpayLinkId || 'not created'],
  ];

  return (
    <PageShell
      title={r.customerName || 'Payment link'}
      subtitle={[KIND_LABEL[r.kind], r.purpose, r.productLabel].filter(Boolean).join(' · ')}
      actions={<>
        <Button icon={ArrowLeft} onClick={() => navigate('payments')}>Payments</Button>
        {r.created && <Button icon={RefreshCw} onClick={doRefresh} disabled={busy}>Refresh</Button>}
        {r.created && r.status !== 'paid' && r.status !== 'cancelled' && (
          <Button icon={XCircle} onClick={doCancel} disabled={busy}>Cancel link</Button>
        )}
      </>}>
      {confirmEl}

      {r.syncError && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: '#FFF8E1', color: '#7A5500',
          border: '1px solid #F0E0B0', borderRadius: 10, padding: '11px 14px', marginBottom: 16, fontFamily: FONT, fontSize: 12.5 }}>
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{r.syncError}</span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16 }}>
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.text, fontFamily: FONT }}>Link details</span>
            <StatusPill request={r} />
          </div>
          {r.shortUrl && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
              <code style={{ fontFamily: MONO, fontSize: 12, background: C.pageBg, border: `1px solid ${C.border}`,
                borderRadius: 7, padding: '7px 10px', flex: 1, minWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {r.shortUrl}
              </code>
              <CopyLinkButton url={r.shortUrl} />
              <WhatsAppSendButton request={r} />
              <a href={r.shortUrl} target="_blank" rel="noreferrer" title="Open"
                style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', border: `1.5px solid ${C.border}`,
                  borderRadius: 7, color: C.textSecondary }}><ExternalLink size={14} /></a>
            </div>
          )}
          <div style={{ display: 'grid', gap: 9 }}>
            {rows.map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, fontSize: 13, fontFamily: FONT }}>
                <span style={{ color: C.textSecondary }}>{k}</span>
                <span style={{ color: C.text, fontWeight: 500, textAlign: 'right' }}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, fontFamily: FONT, marginBottom: 4 }}>Payments received</div>
          <div style={{ fontSize: 11.5, color: C.textMuted, fontFamily: FONT, marginBottom: 14 }}>
            Each payment made against this link. A part-payment link can have several.
          </div>
          {data.payments.length === 0 ? (
            <EmptyState Icon={IndianRupee} title="Nothing received yet" hint="Payments appear here automatically once Razorpay confirms them." />
          ) : (
            <Table
              columns={[{ label: 'Received' }, { label: 'Amount', align: 'right' }, { label: 'Method' }, { label: 'Status' }]}
              rows={data.payments} keyOf={p => p.id}
              renderRow={p => (<>
                <Td>{fmtDate(p.receivedAt)}</Td>
                <Td mono align="right" bold>{rupee(p.amount)}</Td>
                <Td>{p.method || '—'}</Td>
                <Td>{p.status || '—'}</Td>
              </>)} />
          )}
        </div>
      </div>
    </PageShell>
  );
}

// ─── List ────────────────────────────────────────────────────────────────────
const STATUS_TABS = [
  { value: '', label: 'All' },
  { value: 'created', label: 'Awaiting' },
  { value: 'partially_paid', label: 'Part paid' },
  { value: 'paid', label: 'Paid' },
  { value: 'cancelled', label: 'Cancelled' },
];

function PaymentsList({ navigate, user, tab, setTab }) {
  const [requests, setRequests] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [confirmEl, confirm] = useConfirm();
  const isAdmin = user?.role === 'admin';

  const filters = { status: status || undefined, q: q || undefined };

  const load = useCallback(async () => {
    try {
      setLoading(true); setError(null);
      const [list, sum] = await Promise.all([
        api.paymentRequests.list({ status: status || undefined, q: q || undefined, limit: 100 }),
        api.paymentRequests.summary().catch(() => null),
      ]);
      setRequests(list.requests || []);
      setSummary(sum);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [status, q]);

  // Debounce the search so typing doesn't fire a request per keystroke.
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);

  const doRefresh = async (r) => {
    try { setBusyId(r.id); await api.paymentRequests.refresh(r.id); await load(); }
    catch (e) { notify(e.message); } finally { setBusyId(null); }
  };
  const doCancel = async (r) => {
    const ok = await confirm({
      title: 'Cancel this payment link?',
      body: `${r.customerName || 'The customer'} will no longer be able to pay with it. Payments already received stay recorded.`,
      confirmLabel: 'Cancel link',
      danger: true,
    });
    if (!ok) return;
    try { setBusyId(r.id); await api.paymentRequests.cancel(r.id); await load(); }
    catch (e) { notify(e.message); } finally { setBusyId(null); }
  };
  const doDelete = async (r) => {
    const ok = await confirm({
      title: 'Remove this row?',
      body: 'This request never reached Razorpay, so there is no link to cancel — the row is just noise.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try { setBusyId(r.id); await api.paymentRequests.delete(r.id); await load(); }
    catch (e) { notify(e.message); } finally { setBusyId(null); }
  };

  return (
    <PageShell
      title="Payments"
      subtitle="Create a Razorpay link for a lead — full amount, part payment, or let them choose. Because the link is raised here, the payment attributes itself and shows up in the Sales Log on its own."
      actions={<>
        <a href={api.paymentRequests.exportUrl(filters)} download
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 13px', borderRadius: 9,
            border: `1.5px solid ${C.border}`, background: C.cardBg, color: C.text, fontSize: 13,
            fontWeight: 600, fontFamily: FONT, textDecoration: 'none' }}>
          <Download size={15} /> Export
        </a>
        <Button variant="primary" icon={Plus} onClick={() => setShowNew(true)}>New payment link</Button>
      </>}>
      <PaymentsTabs tab={tab} setTab={setTab} />

      {confirmEl}

      {error && (
        <div style={{ background: '#FCEBEB', color: '#A32D2D', padding: '10px 12px', borderRadius: 8,
          fontSize: 12.5, marginBottom: 14, fontFamily: FONT }}>{error}</div>
      )}

      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 18 }}>
          <Kpi label="Collected" value={rupee(summary.collected)} accent="#0F6E56"
            hint="Received against links raised here" />
          <Kpi label="Outstanding" value={rupee(summary.outstanding)}
            hint="Still owed on open links" />
          <Kpi label="Paid links" value={summary.paid} hint={`${summary.partial} part paid`} />
          <Kpi label="Awaiting payment" value={summary.pending}
            hint={summary.notCreated ? `${summary.notCreated} never reached Razorpay` : 'All links created'} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <Segmented options={STATUS_TABS} value={status} onChange={setStatus} />
        <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 320 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: C.textMuted }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, number, purpose…"
            style={{ ...inputStyle, paddingLeft: 30 }} />
        </div>
      </div>

      {loading && !requests ? (
        <div style={{ padding: 60, textAlign: 'center', color: C.textMuted, fontFamily: FONT }}>Loading payment links…</div>
      ) : requests && requests.length === 0 ? (
        <EmptyState Icon={CreditCard} title="No payment links yet"
          hint="Raise one for a lead — the payment will attribute itself when it lands." />
      ) : (
        <Table
          columns={[
            { label: 'Customer' }, { label: 'Purpose' }, { label: 'Product' }, { label: 'Type' },
            { label: 'Amount', align: 'right' }, { label: 'Paid', align: 'right' },
            { label: 'Status' }, { label: 'Created' }, { label: '', align: 'right' },
          ]}
          rows={requests || []} keyOf={r => r.id}
          onRowClick={r => navigate('payments', String(r.id))}
          renderRow={r => (<>
            <Td bold>
              {r.customerName || '—'}
              {r.customerPhone && (
                <div style={{ fontSize: 11.5, color: C.textMuted, fontFamily: MONO, fontWeight: 400 }}>
                  <MaskedNumber number={r.customerPhone} />
                </div>
              )}
            </Td>
            <Td color={r.purpose ? C.text : C.textMuted}>{r.purpose || '—'}</Td>
            <Td color={r.productLabel ? C.text : C.textMuted}>{r.productLabel || '—'}</Td>
            <Td color={C.textSecondary}>{KIND_LABEL[r.kind] || r.kind}</Td>
            <Td mono align="right">{rupee(r.amount)}</Td>
            <Td mono align="right" bold color={r.amountPaid > 0 ? '#0F6E56' : C.textMuted}>{rupee(r.amountPaid)}</Td>
            <Td><StatusPill request={r} /></Td>
            <Td color={C.textSecondary}>{fmtDate(r.createdAt)}</Td>
            <Td align="right">
              <div style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
                {r.created && <CopyLinkButton url={r.shortUrl} compact />}
                {r.created && r.status !== 'paid' && r.status !== 'cancelled' && <WhatsAppSendButton request={r} compact />}
                {r.created && (
                  <button onClick={() => doRefresh(r)} disabled={busyId === r.id} title="Refresh from Razorpay"
                    style={{ background: C.cardBg, border: `1.5px solid ${C.border}`, borderRadius: 7,
                      padding: '4px 7px', cursor: 'pointer', color: C.textSecondary, display: 'inline-flex' }}>
                    <RefreshCw size={13} />
                  </button>
                )}
                {r.created && r.status !== 'paid' && r.status !== 'cancelled' && (
                  <button onClick={() => doCancel(r)} disabled={busyId === r.id} title="Cancel link"
                    style={{ background: C.cardBg, border: `1.5px solid ${C.border}`, borderRadius: 7,
                      padding: '4px 7px', cursor: 'pointer', color: C.primary, display: 'inline-flex' }}>
                    <XCircle size={13} />
                  </button>
                )}
                {!r.created && isAdmin && (
                  <button onClick={() => doDelete(r)} disabled={busyId === r.id} title="Remove this row"
                    style={{ background: C.cardBg, border: `1.5px solid ${C.border}`, borderRadius: 7,
                      padding: '4px 7px', cursor: 'pointer', color: C.primary, display: 'inline-flex' }}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </Td>
          </>)} />
      )}

      {showNew && (
        <NewLinkModal
          onClose={() => setShowNew(false)}
          onCreated={(created) => {
            setShowNew(false);
            load();
            if (created?.id) navigate('payments', String(created.id));
          }} />
      )}
    </PageShell>
  );
}

// Detail is a routed sub-part (#/payments/<id>) rather than a drawer, so the
// Payments nav item stays highlighted and the section stays `sales` — same
// pattern as the Sales Log.
export default function PaymentsPage({ user, navigate, subParts = [] }) {
  // Two views of money, kept deliberately separate:
  //   links  — what ForgeGrowth raised. Exact attribution, because the lead id
  //            is stamped on the link itself.
  //   all    — the ledger pulled from Razorpay. Everything the gateway holds,
  //            including payments taken before this app existed, matched to a
  //            lead only where phone or email lines up.
  // Merging them would blur an exact attribution into a guessed one.
  const [tab, setTab] = useState('links');
  const sub = subParts[0];
  if (sub && /^\d+$/.test(sub)) {
    return <PaymentDetail id={sub} navigate={navigate} />;
  }
  return tab === 'all'
    ? <AllPaymentsList tab={tab} setTab={setTab} user={user} />
    : <PaymentsList navigate={navigate} user={user} tab={tab} setTab={setTab} />;
}

function PaymentsTabs({ tab, setTab }) {
  const item = (key, label) => (
    <button key={key} onClick={() => setTab(key)}
      style={{
        background: 'none', border: 'none', cursor: 'pointer', padding: '8px 14px', marginBottom: -1,
        borderBottom: `2px solid ${tab === key ? C.primary : 'transparent'}`, fontFamily: FONT,
        fontSize: 13.5, fontWeight: tab === key ? 700 : 500, color: tab === key ? C.text : C.textSecondary,
      }}>
      {label}
    </button>
  );
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 16 }}>
      {item('links', 'Links raised here')}
      {item('all', 'All payments')}
    </div>
  );
}

// ── All payments: the ledger pulled from Razorpay ────────────────────────────
//
// Read-only by design. This records what the gateway holds and changes no CRM
// state — it will not enrol anyone or create a lead. That is what makes it safe
// to import years of history that predate the funnel.
function AllPaymentsList({ tab, setTab, user }) {
  const [rows, setRows] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('captured');
  const [q, setQ] = useState('');
  const [syncing, setSyncing] = useState(false);
  const isAdmin = user?.role === 'admin';

  const load = useCallback(async () => {
    try {
      setLoading(true); setError(null);
      const [list, sum] = await Promise.all([
        api.razorpay.payments({ status: status || undefined, q: q || undefined, limit: 100 }),
        api.razorpay.paymentsSummary().catch(() => null),
      ]);
      setRows(list.payments || []);
      setSummary(sum);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [status, q]);

  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);

  const doSync = async (full) => {
    try {
      setSyncing(true);
      const r = await api.razorpay.syncPayments(full);
      notify(`Read ${r.fetched} payment${r.fetched === 1 ? '' : 's'} from Razorpay — the ledger now holds ${r.total}.`);
      await load();
    } catch (e) { notify(e.message); }
    finally { setSyncing(false); }
  };

  const noKeys = summary && summary.hasApiKeys === false;

  return (
    <PageShell
      title="Payments"
      subtitle="Every payment Razorpay holds, pulled straight from the gateway — including the ones taken before this dashboard existed. Read-only: nothing here changes a lead or the funnel."
      actions={isAdmin ? (
        <>
          <Button variant="ghost" onClick={() => doSync(false)} disabled={syncing || noKeys}>
            {syncing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} Sync now
          </Button>
          <Button variant="ghost" onClick={() => doSync(true)} disabled={syncing || noKeys}
            title="Walk the entire payment history. Slower, and only needed once.">
            <Download size={15} /> Import all history
          </Button>
        </>
      ) : null}
    >
      <PaymentsTabs tab={tab} setTab={setTab} />

      {noKeys && (
        <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '11px 14px', marginBottom: 14,
          background: '#FFF8E6', border: '1px solid #F0DCA8', borderRadius: 9, fontSize: 13, color: '#6B5312' }}>
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>Add a Razorpay Key ID and Key Secret in <b>Admin Settings → Webhooks → Razorpay Payments</b> before payments can be pulled.</span>
        </div>
      )}

      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
          <LedgerKpi label="Collected" value={rupee(summary.collected)} accent="#0F6E56"
               sub={`${summary.captured} captured payment${summary.captured === 1 ? '' : 's'}`} />
          <LedgerKpi label="Refunded" value={rupee(summary.refundedAmount)} sub={`${summary.refunded} refunded`} />
          <LedgerKpi label="Failed" value={String(summary.failed)} sub="not collected" />
          {/* Stated plainly rather than implied: most historical payers were
              never leads in this funnel, so a low match rate is expected and
              is not a fault to chase. */}
          <LedgerKpi label="Matched to a lead" value={`${summary.matched} / ${summary.captured}`}
               sub="others predate the funnel" />
          <LedgerKpi label="Ledger covers"
               value={summary.firstPayment ? fmtDate(summary.firstPayment) : '—'}
               sub={summary.lastPayment ? `to ${fmtDate(summary.lastPayment)}` : 'nothing synced yet'} />
        </div>
      )}

      {summary?.syncError && (
        <div style={{ padding: '10px 13px', marginBottom: 14, background: '#FCEBEB', border: '1px solid #F0C8C8',
          borderRadius: 9, fontSize: 13, color: '#A32D2D' }}>
          Last sync failed: {summary.syncError}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <Segmented
          options={[
            { value: 'captured', label: 'Captured' },
            { value: 'failed', label: 'Failed' },
            { value: 'refunded', label: 'Refunded' },
            { value: '', label: 'All' },
          ]}
          value={status} onChange={setStatus}
        />
        <div style={{ position: 'relative', flex: 1, minWidth: 220, maxWidth: 380 }}>
          <Search size={15} color={C.textMuted} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)' }} />
          <input value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search name, phone, email, payment id…"
            style={{ ...inputStyle, paddingLeft: 34 }} />
        </div>
        {summary?.syncedAt && (
          <span style={{ fontSize: 12, color: C.textMuted, fontFamily: FONT }}>
            Synced {fmtDate(summary.syncedAt)}
          </span>
        )}
      </div>

      {error ? (
        <div style={{ padding: 14, background: '#FCEBEB', color: '#A32D2D', borderRadius: 9, fontSize: 13 }}>{error}</div>
      ) : loading && rows === null ? (
        <div style={{ padding: 40, textAlign: 'center', color: C.textMuted }}>
          <Loader2 size={20} className="spin" />
        </div>
      ) : (
        <Table
          columns={[
            { label: 'Payer' }, { label: 'Amount', align: 'right' }, { label: 'Status' },
            { label: 'Method' }, { label: 'For' }, { label: 'Lead' }, { label: 'Paid on' },
          ]}
          rows={rows} keyOf={p => p.paymentId}
          empty={<EmptyState Icon={CreditCard} title="No payments synced yet"
            hint={noKeys
              ? 'Add Razorpay API keys, then use Import all history.'
              : 'Use “Import all history” to pull everything Razorpay holds.'} />}
          renderRow={(p) => (
            <>
              <Td>
                <div style={{ fontWeight: 600 }}>{p.contact ? maskPhone(p.contact) : (p.email || '—')}</div>
                <div style={{ fontSize: 11.5, fontFamily: MONO, color: C.textMuted }}>
                  {p.contact && p.email ? p.email : p.paymentId}
                </div>
              </Td>
              <Td mono align="right" bold color={p.status === 'captured' ? '#0F6E56' : C.text}>
                {rupee(p.amount)}
                {p.refunded > 0 && (
                  <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 400 }}>−{rupee(p.refunded)} refunded</div>
                )}
              </Td>
              <Td><LedgerStatus p={p} /></Td>
              <Td color={C.textSecondary}>{p.method || '—'}</Td>
              <Td style={{ whiteSpace: 'normal', maxWidth: 260 }} color={C.textSecondary}>{p.description || '—'}</Td>
              <Td>
                {p.leadName
                  ? <span style={{ fontSize: 12.5 }}>{p.leadName}</span>
                  : <span style={{ fontSize: 11.5, color: C.textMuted }}>Not in funnel</span>}
              </Td>
              <Td color={C.textSecondary}>{fmtDate(p.paidAt)}</Td>
            </>
          )}
        />
      )}
    </PageShell>
  );
}

function LedgerStatus({ p }) {
  const m = p.refunded > 0 ? { label: 'Refunded', color: '#6B7280', bg: '#F1F1EE' }
    : p.status === 'captured' ? { label: 'Captured', color: '#0F6E56', bg: '#E3F5EF' }
    : p.status === 'failed' ? { label: 'Failed', color: '#A32D2D', bg: '#FCEBEB' }
    : { label: p.status || '—', color: '#7A5500', bg: '#FFF8E1' };
  return (
    <span title={p.errorDescription || undefined}
      style={{ display: 'inline-block', padding: '3px 9px', borderRadius: 999, fontSize: 11.5,
        fontWeight: 600, color: m.color, background: m.bg, whiteSpace: 'nowrap' }}>
      {m.label}
    </span>
  );
}

function LedgerKpi({ label, value, sub, accent }) {
  return (
    <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: '13px 15px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
        color: C.textMuted, fontFamily: FONT }}>{label}</div>
      <div style={{ fontSize: 21, fontWeight: 700, color: accent || C.text, fontFamily: MONO, marginTop: 5 }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}
