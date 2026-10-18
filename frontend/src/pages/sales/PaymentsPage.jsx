// Sales → Payments: the Razorpay ledger, as a Dashboard (money over time) and an
// All payments list, each with saved views.
//
// The "Links raised here" tab (create a payment link for a lead and track it)
// was removed on 2026-10-07. Payment links are still minted by automations, AI
// agents and payment templates (routes/paymentRequests.js, services/paymentFlow.js),
// and a link's detail page still opens at #/payments/<id> for old bookmarks.
// Campaign-level money (spend vs revenue per Meta campaign) lives in
// Marketing → Campaign ROI.
import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  CreditCard, Copy, Check, ExternalLink, RefreshCw, XCircle,
  Download, Search, IndianRupee, AlertTriangle, MessageCircle, ArrowLeft, Loader2,
} from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO, maskPhone } from '../../constants.js';
import {
  PageShell, Button, inputStyle, EmptyState, Table, Td,
  Segmented, fmtDate,
} from '../academy/shared.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import MaskedNumber from '../../components/MaskedNumber.jsx';
import { DateFromTo } from '../../components/DateRangeControl.jsx';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import { notify } from '../../lib/feedback.js';
import PaymentsDashboard from './PaymentsDashboard.jsx';
import {
  RANGE_PRESETS, cleanDate, oneOf, resolveRange, rangeText, SinceInput, monthStart,
  useSavedViews, SavedViewsBar,
} from './savedViews.jsx';

const rupee = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// `created:false` is its own state — a row that never reached Razorpay must
// never read as "unpaid link someone is waiting on".
const STATUS_META = {
  created:        { label: 'Awaiting payment', color: 'var(--c-s7a5500, #7A5500)', bg: 'var(--c-warnBgSoft, #FFF8E1)' },
  partially_paid: { label: 'Part paid',        color: 'var(--c-s1d4ed8, #1D4ED8)', bg: 'var(--c-infoBg, #E8EFFF)' },
  paid:           { label: 'Paid',             color: 'var(--c-successText, #0F6E56)', bg: 'var(--c-successBg, #E3F5EF)' },
  cancelled:      { label: 'Cancelled',        color: 'var(--c-textSecondary, #6B7280)', bg: 'var(--c-surfaceMuted, #F1F1EE)' },
  expired:        { label: 'Expired',          color: 'var(--c-textSecondary, #6B7280)', bg: 'var(--c-surfaceMuted, #F1F1EE)' },
  not_created:    { label: 'Not created',      color: 'var(--c-dangerText, #A32D2D)', bg: 'var(--c-dangerBg, #FCEBEB)' },
};

const KIND_LABEL = { fixed: 'Fixed', partial: 'Part payment', open: 'Open amount' };

// ── Filter/sort controls shared by both tabs ────────────────────────────────
// Values are keys into the backend's whitelisted sort maps — never raw SQL.
const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'amount_desc', label: 'Amount: high to low' },
  { value: 'amount_asc', label: 'Amount: low to high' },
];

const METHOD_LABELS = {
  upi: 'UPI', card: 'Card', netbanking: 'Netbanking', wallet: 'Wallet',
  emi: 'EMI', bank_transfer: 'Bank transfer', paylater: 'Pay Later',
};
const methodLabel = (m) => METHOD_LABELS[m] || (m ? m.charAt(0).toUpperCase() + m.slice(1) : m);

// The shared from–to pair (components/DateRangeControl), so Payments and the
// Marketing pages render one date control rather than a copy each.
const DateRangeFilter = DateFromTo;

function StatusPill({ request }) {
  const key = request.created ? request.status : 'not_created';
  const m = STATUS_META[key] || STATUS_META.created;
  return (
    <span style={{ display: 'inline-block', padding: '3px 9px', borderRadius: 999, fontSize: 13,
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
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: copied ? 'var(--c-successBg, #E3F5EF)' : C.cardBg,
        border: `1.5px solid ${copied ? '#0F6E56' : C.border}`, color: copied ? 'var(--c-successText, #0F6E56)' : C.textSecondary,
        borderRadius: 7, padding: compact ? '4px 7px' : '6px 10px', cursor: 'pointer', fontSize: 14,
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
        border: `1.5px solid ${C.border}`, color: 'var(--c-successText, #0F6E56)', borderRadius: 7,
        padding: compact ? '4px 7px' : '6px 10px', cursor: 'pointer', fontSize: 14,
        fontFamily: FONT, fontWeight: 600, textDecoration: 'none' }}>
      <MessageCircle size={13} />{!compact && 'Send'}
    </a>
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

  if (loading && !data) return <PageShell><div style={{ padding: 60, textAlign: 'center', color: C.textMuted, fontFamily: FONT }}>Loading…</div></PageShell>;
  if (error || !data) {
    return (
      <PageShell actions={<Button icon={ArrowLeft} onClick={() => navigate('payments')}>Payments</Button>}>
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
    <PageShell heading={r.customerName || 'Payment link'}
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
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: 'var(--c-warnBgSoft, #FFF8E1)', color: 'var(--c-s7a5500, #7A5500)',
          border: '1px solid #F0E0B0', borderRadius: 10, padding: '11px 14px', marginBottom: 16, fontFamily: FONT, fontSize: 14 }}>
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{r.syncError}</span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16 }}>
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: C.text, fontFamily: FONT }}>Link details</span>
            <StatusPill request={r} />
          </div>
          {r.shortUrl && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
              <code style={{ fontFamily: MONO, fontSize: 14, background: C.pageBg, border: `1px solid ${C.border}`,
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
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, fontSize: 15, fontFamily: FONT }}>
                <span style={{ color: C.textSecondary }}>{k}</span>
                <span style={{ color: C.text, fontWeight: 500, textAlign: 'right' }}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, fontFamily: FONT, marginBottom: 4 }}>Payments received</div>
          <div style={{ fontSize: 13, color: C.textMuted, fontFamily: FONT, marginBottom: 14 }}>
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

// Detail is a routed sub-part (#/payments/<id>) rather than a drawer, so the
// Payments nav item stays highlighted and the section stays `sales` — same
// pattern as the Sales Log.
export default function PaymentsPage({ user, navigate, subParts = [] }) {
  // Two tabs over the Razorpay ledger: Dashboard (money over time) and All
  // payments (the list). The "Links raised here" tab was removed on 2026-10-07;
  // payment links are still minted by automations, agents and payment templates,
  // and an old #/payments/<id> link still opens that link's detail page below.
  const [tab, setTab] = useState('dashboard');
  const sub = subParts[0];
  if (sub && /^\d+$/.test(sub)) {
    return <PaymentDetail id={sub} navigate={navigate} />;
  }
  return tab === 'all'
    ? <AllPaymentsList tab={tab} setTab={setTab} user={user} />
    : <PaymentsDashboardTab tab={tab} setTab={setTab} />;
}

function PaymentsTabs({ tab, setTab }) {
  const item = (key, label) => (
    <button key={key} onClick={() => setTab(key)}
      style={{
        background: 'none', border: 'none', cursor: 'pointer', padding: '8px 14px', marginBottom: -1,
        borderBottom: `2px solid ${tab === key ? C.primary : 'transparent'}`, fontFamily: FONT,
        fontSize: 15, fontWeight: tab === key ? 700 : 500, color: tab === key ? C.text : C.textSecondary,
      }}>
      {label}
    </button>
  );
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 16 }}>
      {item('dashboard', 'Dashboard')}
      {item('all', 'All payments')}
    </div>
  );
}

// ── Dashboard: money over time from the ledger ──────────────────────────────
function PaymentsDashboardTab({ tab, setTab }) {
  return (
    <PageShell subtitle="When payments came in, how much, and how each day splits by method, product or status — from every payment Razorpay holds. Click any point, bar or row to see the payments behind it.">
      <PaymentsTabs tab={tab} setTab={setTab} />
      <PaymentsDashboard />
    </PageShell>
  );
}

// ── All payments: the ledger pulled from Razorpay ────────────────────────────
//
// Saved views for this tab (scope 'ledger'): same bar and range rules as the
// Dashboard, its own filter set. Default range 'all' = what the tab always showed.
const LEDGER_STATUSES = [
  { value: 'captured', label: 'Captured' },
  { value: 'failed', label: 'Failed' },
  { value: 'refunded', label: 'Refunded' },
  { value: '', label: 'All' },
];
const LEDGER_VIEW_KEYS = ['preset', 'from', 'to', 'since', 'status', 'method', 'q', 'sort'];
function normalizeLedgerView(f) {
  const o = f && typeof f === 'object' ? f : {};
  return {
    preset: oneOf(RANGE_PRESETS, o.preset, 'all'),
    from: cleanDate(o.from), to: cleanDate(o.to), since: cleanDate(o.since),
    status: oneOf(LEDGER_STATUSES, o.status, 'captured'),
    method: typeof o.method === 'string' ? o.method : '',
    q: typeof o.q === 'string' ? o.q : '',
    sort: oneOf(SORT_OPTIONS, o.sort, 'newest'),
  };
}
function canonicalLedgerView(v) {
  const n = normalizeLedgerView(v);
  if (n.preset !== 'custom') { n.from = ''; n.to = ''; }
  if (n.preset !== 'since') n.since = '';
  n.q = n.q.trim();
  return JSON.stringify(LEDGER_VIEW_KEYS.map(k => n[k]));
}
function describeLedgerView(v) {
  const n = normalizeLedgerView(v);
  return [
    rangeText(n),
    LEDGER_STATUSES.find(x => x.value === n.status)?.label,
    n.method && methodLabel(n.method),
    n.q.trim() && `“${n.q.trim()}”`,
    SORT_OPTIONS.find(x => x.value === n.sort)?.label,
  ].filter(Boolean).join(' · ');
}

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
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [preset, setPreset] = useState('all');   // range rule; 'custom' uses from/to
  const [since, setSince] = useState('');
  const [method, setMethod] = useState('');
  const [sort, setSort] = useState('newest');
  const range = useMemo(() => resolveRange(preset, from, to, since), [preset, from, to, since]);
  const applyView = useCallback((f) => {
    const n = normalizeLedgerView(f);
    setPreset(n.preset); setFrom(n.from); setTo(n.to); setSince(n.since);
    setStatus(n.status); setMethod(n.method); setQ(n.q); setSort(n.sort);
  }, []);
  const views = useSavedViews('ledger', applyView);
  const currentView = { preset, from, to, since, status, method, q, sort };
  const pickRange = (v) => {
    setPreset(v);
    if (v === 'since' && !since) setSince(monthStart());
  };
  // The method option list lives in its OWN state so a failed summary refetch
  // can't unmount the control that created the filter (anti-pattern #25).
  const [methods, setMethods] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const isAdmin = user?.role === 'admin';

  const load = useCallback(async () => {
    // Hold the first request until the default view (if any) is applied.
    if (!views.ready) return;
    try {
      setLoading(true); setError(null);
      const [list, sum] = await Promise.all([
        api.razorpay.payments({
          status: status || undefined, q: q || undefined,
          from: range.from || undefined, to: range.to || undefined,
          method: method || undefined,
          sort: sort !== 'newest' ? sort : undefined,
          limit: 100,
        }),
        // KPIs follow the slice (dates/method/search) but NOT the status pills —
        // the cards themselves are the status breakdown.
        api.razorpay.paymentsSummary({
          from: range.from || undefined, to: range.to || undefined,
          method: method || undefined, q: q || undefined,
        }).catch(() => null),
      ]);
      setRows(list.payments || []);
      setSummary(sum);
      if (Array.isArray(sum?.methods)) setMethods(sum.methods);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [status, q, range, method, sort, views.ready]);

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
      subtitle="Every payment Razorpay holds, pulled straight from the gateway — including the ones taken before this dashboard existed. Read-only: nothing here changes a lead or the funnel."
      actions={isAdmin ? (
        <>
          <Button variant="ghost" onClick={() => doSync(false)} disabled={syncing || noKeys}>
            {syncing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} Sync now
          </Button>
          <Button variant="ghost" onClick={() => doSync(true)} disabled={syncing || noKeys}>
            <Download size={15} /> Import all history
          </Button>
        </>
      ) : null}
    >
      <PaymentsTabs tab={tab} setTab={setTab} />

      {noKeys && (
        <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '11px 14px', marginBottom: 14,
          background: 'var(--c-warnBgSoft, #FFF8E6)', border: '1px solid var(--c-warnBorder, #F0DCA8)', borderRadius: 9, fontSize: 15, color: 'var(--c-warnDeep, #6B5312)' }}>
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>Add a Razorpay Key ID and Key Secret in <b>Admin Settings → Webhooks → Razorpay Payments</b> before payments can be pulled.</span>
        </div>
      )}

      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
          <LedgerKpi label="Collected" value={rupee(summary.collected)} accent="var(--c-successText, #0F6E56)"
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
        <div style={{ padding: '10px 13px', marginBottom: 14, background: 'var(--c-dangerBg, #FCEBEB)', border: '1px solid #F0C8C8',
          borderRadius: 9, fontSize: 15, color: 'var(--c-dangerText, #A32D2D)' }}>
          Last sync failed: {summary.syncError}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <Segmented options={RANGE_PRESETS} value={preset} onChange={pickRange} />
        {preset === 'custom' && <DateRangeFilter from={from} to={to} setFrom={setFrom} setTo={setTo} />}
        {preset === 'since' && <SinceInput value={since} onChange={setSince} />}
      </div>

      <div style={{ marginBottom: 14 }}>
        <SavedViewsBar scope="ledger" views={views} current={currentView} applyView={applyView}
          normalize={normalizeLedgerView} canonical={canonicalLedgerView} describe={describeLedgerView} />
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <Segmented options={LEDGER_STATUSES} value={status} onChange={setStatus} />
        <div style={{ position: 'relative', flex: 1, minWidth: 220, maxWidth: 380 }}>
          <Search size={15} color={C.textMuted} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)' }} />
          <input value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search name, phone, email, payment id…"
            style={{ ...inputStyle, paddingLeft: 34 }} />
        </div>
        {summary?.syncedAt && (
          <span style={{ fontSize: 14, color: C.textMuted, fontFamily: FONT }}>
            Synced {fmtDate(summary.syncedAt)}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ width: 160 }}>
          <SearchableSelect value={method} onChange={setMethod}
            options={[{ value: '', label: 'All methods' }, ...methods.map(m => ({ value: m, label: methodLabel(m) }))]}
            placeholder="All methods" triggerStyle={{ padding: '8px 30px 8px 11px' }} />
        </div>
        <div style={{ width: 190 }}>
          <SearchableSelect value={sort} onChange={setSort} options={SORT_OPTIONS}
            placeholder="Sort" triggerStyle={{ padding: '8px 30px 8px 11px' }} />
        </div>
      </div>

      {error ? (
        <div style={{ padding: 14, background: 'var(--c-dangerBg, #FCEBEB)', color: 'var(--c-dangerText, #A32D2D)', borderRadius: 9, fontSize: 15 }}>{error}</div>
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
                <div style={{ fontSize: 13, fontFamily: MONO, color: C.textMuted }}>
                  {p.contact && p.email ? p.email : p.paymentId}
                </div>
              </Td>
              <Td mono align="right" bold color={p.status === 'captured' ? 'var(--c-successText, #0F6E56)' : C.text}>
                {rupee(p.amount)}
                {p.refunded > 0 && (
                  <div style={{ fontSize: 13, color: C.textMuted, fontWeight: 400 }}>−{rupee(p.refunded)} refunded</div>
                )}
              </Td>
              <Td><LedgerStatus p={p} /></Td>
              <Td color={C.textSecondary}>{p.method || '—'}</Td>
              <Td style={{ whiteSpace: 'normal', maxWidth: 260 }} color={C.textSecondary}>{p.description || '—'}</Td>
              <Td>
                {p.leadName
                  ? <span style={{ fontSize: 14 }}>{p.leadName}</span>
                  : <span style={{ fontSize: 13, color: C.textMuted }}>Not in funnel</span>}
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
  const m = p.refunded > 0 ? { label: 'Refunded', color: 'var(--c-textSecondary, #6B7280)', bg: 'var(--c-surfaceMuted, #F1F1EE)' }
    : p.status === 'captured' ? { label: 'Captured', color: 'var(--c-successText, #0F6E56)', bg: 'var(--c-successBg, #E3F5EF)' }
    : p.status === 'failed' ? { label: 'Failed', color: 'var(--c-dangerText, #A32D2D)', bg: 'var(--c-dangerBg, #FCEBEB)' }
    : { label: p.status || '—', color: 'var(--c-s7a5500, #7A5500)', bg: 'var(--c-warnBgSoft, #FFF8E1)' };
  return (
    <span title={p.errorDescription || undefined}
      style={{ display: 'inline-block', padding: '3px 9px', borderRadius: 999, fontSize: 13,
        fontWeight: 600, color: m.color, background: m.bg, whiteSpace: 'nowrap' }}>
      {m.label}
    </span>
  );
}

function LedgerKpi({ label, value, sub, accent }) {
  return (
    <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: '13px 15px' }}>
      <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
        color: C.textMuted, fontFamily: FONT }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent || C.text, fontFamily: MONO, marginTop: 5 }}>{value}</div>
      {sub && <div style={{ fontSize: 13, color: C.textMuted, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}
