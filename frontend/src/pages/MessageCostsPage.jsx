// Message Costs — what WhatsApp messaging actually costs, in money.
//
// Answers, for a chosen period: the total owed to Meta, which template
// contributed what, how many runs each had, the average cost per message, and
// the same split by message type and category.
//
// TWO NUMBERS ARE SHOWN SIDE BY SIDE ON PURPOSE:
//   "Attributed here" — our own per-message figure, the only one that can be
//                       broken down by template
//   "Meta reports"    — the WABA's own pricing_analytics, i.e. the invoice
// They can legitimately differ, and the page says why rather than picking one
// and hoping nobody checks.

import { useState, useEffect, useCallback } from 'react';
import {
  IndianRupee, MessageSquare, Layers, RefreshCw, Info, AlertTriangle, Gift,
  Settings, LayoutTemplate, ChevronRight,
} from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO } from '../constants.js';
import { PageShell, Button, Badge, Table, Td, EmptyState, Segmented, inputStyle, fmtDate, Modal } from './academy/shared.jsx';
import { KpiCard, Card, LineTrend, BarChart, Shimmer, EmptyChart } from '../components/charts.jsx';
import { showError, showSuccess } from '../lib/feedback.js';
import SearchableSelect from '../components/SearchableSelect.jsx';

const RANGES = [{ value: 7, label: '7d' }, { value: 30, label: '30d' }, { value: 90, label: '90d' }];

// Exact rupees, not the lakh/crore compaction used elsewhere. Message costs are
// small and per-unit — "₹0.9K" would destroy the only detail that matters here.
function rs(v, dp = 2) {
  const n = Number(v || 0);
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}
// Per-message rates run to four decimals (₹0.1150), so they get their own format.
const rate = v => `₹${Number(v || 0).toFixed(4)}`;

const CATEGORY_COLOR = {
  marketing: { color: 'var(--c-primary, #dc2626)', bg: 'var(--c-dangerBg, #FCEBEB)' },
  utility: { color: 'var(--c-infoBright, #2563eb)', bg: 'var(--c-infoBg, #E7F0FE)' },
  authentication: { color: 'var(--c-purple, #534AB7)', bg: 'var(--c-purpleBg, #EEEDFE)' },
  service: { color: 'var(--c-successText, #0F6E56)', bg: 'var(--c-successBg, #E1F5EE)' },
  referral_conversion: { color: '#E8A317', bg: 'var(--c-warnBg, #FAEEDA)' },
};

const RATE_SOURCE_LABEL = {
  meta_exact: 'Meta’s own rate for that day and country',
  meta_blended: 'Meta’s rate for that day, averaged across countries',
  fallback: 'Your fallback rate card — Meta has not reported this yet',
  free: 'Meta charged nothing',
  unknown: 'No rate available',
};

const BREAKDOWNS = [
  { value: 'category', label: 'Category' },
  { value: 'type', label: 'Message type' },
  { value: 'origin', label: 'Sent by' },
  { value: 'number', label: 'Number' },
  { value: 'pricingType', label: 'Why charged' },
  { value: 'country', label: 'Country' },
];

function daysAgo(n) { return new Date(Date.now() - (n - 1) * 86400000).toISOString().slice(0, 10); }

export default function MessageCostsPage({ user, navigate }) {
  const [days, setDays] = useState(30);
  const [overview, setOverview] = useState(null);
  const [templates, setTemplates] = useState(null);
  const [trend, setTrend] = useState(null);
  const [by, setBy] = useState('category');
  const [breakdown, setBreakdown] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const from = daysAgo(days);

  const load = useCallback(async () => {
    try {
      const [o, t, tr] = await Promise.all([
        api.messageCosts.overview({ from }),
        api.messageCosts.templates({ from }),
        api.messageCosts.trend({ from }),
      ]);
      setOverview(o); setTemplates(t.templates || []); setTrend(tr.days || []);
    } catch (e) { showError(e.message); setOverview({}); setTemplates([]); setTrend([]); }
  }, [from]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.messageCosts.breakdown({ from, by })
      .then(r => setBreakdown(r.rows || []))
      .catch(() => setBreakdown([]));
  }, [from, by]);

  const sync = async () => {
    setSyncing(true);
    try {
      await api.messageCosts.sync(Math.max(days, 30));
      await load();
      showSuccess('Refreshed the real cost figures from Meta.');
    } catch (e) { showError(e.message); }
    finally { setSyncing(false); }
  };

  const o = overview;
  const estimated = (o?.rateSources || []).find(s => s.source === 'fallback');

  return (
    <PageShell
      title="Message Costs"
      subtitle="What WhatsApp messaging costs you, per template and per message type."
      actions={
        <>
          <Segmented options={RANGES} value={days} onChange={setDays} />
          <Button icon={RefreshCw} onClick={sync} disabled={syncing}>{syncing ? 'Refreshing…' : 'Refresh from Meta'}</Button>
          <Button icon={Settings} onClick={() => setSettingsOpen(true)}>Settings</Button>
        </>
      }
    >
      {/* ── Headline money ─────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gap: 13, gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', marginBottom: 18 }}>
        {o === null
          ? [0, 1, 2, 3, 4].map(i => <Shimmer key={i} height={86} radius={12} />)
          : <>
            <KpiCard label="Cost incurred" value={rs(o.cost)} icon={IndianRupee}
              sub={o.taxPercent ? `${rs(o.totalWithTax)} incl. ${o.taxPercent}% GST` : undefined} accent={C.primary} />
            <KpiCard label="Charged messages" value={(o.billable ?? 0).toLocaleString('en-IN')} icon={MessageSquare}
              sub={`of ${(o.messages ?? 0).toLocaleString('en-IN')} delivered`} />
            <KpiCard label="Free messages" value={(o.free ?? 0).toLocaleString('en-IN')} icon={Gift}
              sub="service window & ad clicks" accent="var(--c-successText, #0F6E56)" />
            <KpiCard label="Average per charged message" value={rate(o.avgPerBillable)}
              sub={o.messages ? `${rate(o.avgPerMessage)} across all messages` : undefined} />
            <KpiCard label="Templates used" value={o.templatesUsed ?? 0} icon={LayoutTemplate}
              sub={`${(o.templateMessages ?? 0).toLocaleString('en-IN')} template sends`} />
          </>}
      </div>

      {/* ── Reconciliation: ours vs Meta's, and why they differ ─────────── */}
      {o && <Reconciliation o={o} />}

      {/* Honest note when part of the figure is an estimate rather than Meta's
          own number. Without this, a fallback-priced day reads as invoice-exact. */}
      {estimated && estimated.messages > 0 && (
        <div style={{ marginTop: 14 }}>
          <Note tone="info">
            {estimated.messages} message{estimated.messages === 1 ? ' is' : 's are'} priced from your fallback rate card
            ({rs(estimated.cost)}) because Meta has not reported those days yet — usually today's traffic. They settle to
            Meta's real figure at the next refresh.
          </Note>
        </div>
      )}

      {/* ── Daily cost ─────────────────────────────────────────────────── */}
      <div style={{ marginTop: 18 }}>
        <Card title="Cost per day">
          {trend === null && <Shimmer height={150} />}
          {trend && trend.length === 0 && <EmptyChart text="No messages in this period" />}
          {trend && trend.length > 0 && (
            <LineTrend data={trend.map(d => ({ day: d.day, count: d.cost }))} height={170} />
          )}
        </Card>
      </div>

      {/* ── Per template — the headline table ───────────────────────────── */}
      <div style={{ marginTop: 18 }}>
        <Card
          title="Cost by template"
          right={<span style={{ fontSize: 13, color: C.textMuted }}>
            Runs = messages delivered. A template inside the 24-hour window is free.
          </span>}
        >
          {templates === null && <Shimmer height={200} />}
          {templates && templates.length === 0 && (
            <EmptyState Icon={LayoutTemplate} title="No messages in this period" />
          )}
          {templates && templates.length > 0 && (
            <Table
              columns={[
                { label: 'Template' }, { label: 'Category' },
                { label: 'Runs', align: 'right' }, { label: 'Charged', align: 'right' },
                { label: 'Recipients', align: 'right' },
                { label: 'Avg / run', align: 'right' }, { label: 'Total cost', align: 'right' },
                { label: 'Last sent' },
              ]}
              rows={templates}
              keyOf={t => `${t.templateId || 'x'}-${t.name}`}
              renderRow={t => {
                const cat = CATEGORY_COLOR[t.pricingCategory] || { color: C.textMuted, bg: C.hover };
                return (
                  <>
                    <Td>
                      <div style={{ fontWeight: 600, color: t.templateId ? C.text : C.textMuted }}>{t.name}</div>
                      {t.templateStatus && t.templateStatus !== 'APPROVED' && (
                        <div style={{ fontSize: 13, color: C.textMuted }}>{t.templateStatus}</div>
                      )}
                    </Td>
                    <Td>
                      {t.pricingCategory
                        ? <Badge label={t.pricingCategory.replace('_', ' ')} color={cat.color} bg={cat.bg} />
                        : <span style={{ color: C.textMuted }}>—</span>}
                    </Td>
                    <Td align="right" bold>{t.runs.toLocaleString('en-IN')}</Td>
                    <Td align="right" color={t.billableRuns ? C.text : C.textMuted}>
                      {t.billableRuns.toLocaleString('en-IN')}
                      {t.runs > 0 && t.billableRuns < t.runs && (
                        <span style={{ fontSize: 13, color: C.textMuted }}> ({Math.round((1 - t.billableRuns / t.runs) * 100)}% free)</span>
                      )}
                    </Td>
                    <Td align="right" color={C.textSecondary}>{t.recipients.toLocaleString('en-IN')}</Td>
                    <Td align="right" color={C.textSecondary}>{rate(t.avgCost)}</Td>
                    <Td align="right" bold color={t.cost > 0 ? C.text : C.textMuted}>{rs(t.cost)}</Td>
                    <Td color={C.textSecondary}>{fmtDate(t.lastSent)}</Td>
                  </>
                );
              }}
            />
          )}
        </Card>
      </div>

      {/* ── Breakdowns ─────────────────────────────────────────────────── */}
      <div style={{ marginTop: 18 }}>
        <Card
          title="Where the money goes"
          right={
            <SearchableSelect value={by} onChange={setBy} options={BREAKDOWNS}
              triggerStyle={{ minWidth: 160 }} />
          }
        >
          {breakdown === null && <Shimmer height={160} />}
          {breakdown && breakdown.length === 0 && <EmptyChart text="Nothing to break down yet" />}
          {breakdown && breakdown.length > 0 && (
            <div style={{ display: 'grid', gap: 18, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
              <BarChart data={breakdown.filter(r => r.cost > 0).map(r => ({ label: r.bucket, value: r.cost }))} height={170} />
              <Table
                columns={[{ label: BREAKDOWNS.find(b => b.value === by)?.label || 'Bucket' },
                  { label: 'Messages', align: 'right' }, { label: 'Charged', align: 'right' },
                  { label: 'Avg', align: 'right' }, { label: 'Cost', align: 'right' }]}
                rows={breakdown}
                keyOf={r => r.bucket}
                renderRow={r => (
                  <>
                    <Td bold>{String(r.bucket).replace(/_/g, ' ')}</Td>
                    <Td align="right">{r.messages.toLocaleString('en-IN')}</Td>
                    <Td align="right" color={C.textSecondary}>{r.billable.toLocaleString('en-IN')}</Td>
                    <Td align="right" color={C.textSecondary}>{rate(r.avgCost)}</Td>
                    <Td align="right" bold>{rs(r.cost)}</Td>
                  </>
                )}
              />
            </div>
          )}
        </Card>
      </div>

      {settingsOpen && (
        <CostSettingsModal onClose={() => setSettingsOpen(false)} onChanged={load} />
      )}
    </PageShell>
  );
}

/**
 * Configuration, in the same place as the numbers it governs.
 *
 * This used to be an Admin Settings tab, which had two problems: the tab never
 * opened (its key was missing from a hand-maintained VALID_TABS list, so it fell
 * through to General), and splitting a dashboard from its own settings meant two
 * places to look for one feature.
 */
function CostSettingsModal({ onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);
  const [tax, setTax] = useState('');
  const [rates, setRates] = useState({});

  const load = useCallback(async () => {
    try {
      const r = await api.messageCosts.config();
      setData(r);
      setTax(String(r.config.taxPercent ?? ''));
      setRates(Object.fromEntries((r.rates || []).map(x => [x.id, String(x.rate)])));
    } catch (e) { showError(e.message); setData({ rates: [], wabaSync: [], config: {} }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveTax = async () => {
    setBusy('tax');
    try { await api.messageCosts.saveConfig({ taxPercent: Number(tax) }); await load(); await onChanged(); showSuccess('Saved.'); }
    catch (e) { showError(e.message); } finally { setBusy(null); }
  };
  const saveRate = async (id) => {
    setBusy(`rate-${id}`);
    try { await api.messageCosts.saveRate(id, Number(rates[id])); await load(); await onChanged(); showSuccess('Rate saved.'); }
    catch (e) { showError(e.message); } finally { setBusy(null); }
  };
  const run = async (kind) => {
    setBusy(kind);
    try {
      const r = kind === 'sync' ? await api.messageCosts.sync(90) : await api.messageCosts.backfill(400);
      await load(); await onChanged();
      showSuccess(kind === 'sync'
        ? 'Pulled the latest cost figures from Meta.'
        : `Recovered ${r.stored ?? 0} priced message(s) from the webhook history.`);
    } catch (e) { showError(e.message); } finally { setBusy(null); }
  };

  return (
    <Modal title="Message cost settings" onClose={onClose} width={620}
      footer={<Button onClick={onClose}>Close</Button>}>
      {!data && <Shimmer height={200} />}
      {data && (
        <>
          <Section title="Where the numbers come from">
            <p style={para}>
              Meta tells us <b>which</b> messages were charged on every delivery receipt, and reports the{' '}
              <b>actual cost</b> separately per day and country. The per-message rate is worked out from
              Meta&rsquo;s own figures rather than a fixed price list, so it stays right when Meta reprices or a
              volume discount kicks in.
            </p>
            <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
              <Button onClick={() => run('sync')} disabled={busy === 'sync'}>
                {busy === 'sync' ? 'Refreshing…' : 'Refresh costs from Meta'}
              </Button>
              <Button onClick={() => run('backfill')} disabled={busy === 'backfill'}>
                {busy === 'backfill' ? 'Recovering…' : 'Recover past messages'}
              </Button>
            </div>
            <p style={{ ...para, marginTop: 9 }}>
              Costs refresh automatically every 6 hours. &ldquo;Recover past messages&rdquo; re-reads the stored
              webhook history to pick up messages sent before cost tracking existed — safe to run more than once.
              {data.config?.lastPricingSyncAt && ` Last refreshed ${new Date(data.config.lastPricingSyncAt).toLocaleString('en-IN')}.`}
            </p>
          </Section>

          <Section title="WhatsApp accounts">
            {(data.wabaSync || []).length === 0 && <p style={para}>Nothing read yet — use &ldquo;Refresh costs from Meta&rdquo;.</p>}
            {(data.wabaSync || []).map(w => (
              <div key={w.wabaId} style={{ display: 'flex', justifyContent: 'space-between', gap: 12,
                alignItems: 'center', padding: '9px 0', borderBottom: `1px solid ${C.border}` }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, color: C.text, fontWeight: 600 }}>{w.numbers || 'Unlinked account'}</div>
                  <div style={{ fontFamily: MONO, fontSize: 13, color: C.textMuted }}>{w.wabaId}</div>
                  {w.status === 'unauthorized' && (
                    <div style={{ fontSize: 13, color: 'var(--c-s7a5a12, #7A5A12)', marginTop: 3, lineHeight: 1.5 }}>
                      The stored Meta token cannot read this account&rsquo;s spend, so its cost is unknown rather
                      than zero. Reconnect Meta with a token that covers it to include it.
                    </div>
                  )}
                </div>
                <Badge
                  label={w.status === 'ok' ? 'Reading' : w.status === 'unauthorized' ? 'No permission' : w.status}
                  color={w.status === 'ok' ? 'var(--c-successText, #0F6E56)' : 'var(--c-dangerText, #A32D2D)'}
                  bg={w.status === 'ok' ? 'var(--c-successBg, #E1F5EE)' : 'var(--c-dangerBg, #FCEBEB)'} />
              </div>
            ))}
          </Section>

          <Section title="Tax">
            <p style={para}>
              Shown as a separate line, never folded into the per-message cost — that keeps our totals directly
              comparable with what Meta reports, which is before tax.
            </p>
            <div style={{ display: 'flex', gap: 9, alignItems: 'flex-end' }}>
              <div>
                <div style={miniLabel}>GST %</div>
                <input value={tax} onChange={e => setTax(e.target.value)} type="number" min="0" max="100" step="0.1"
                  style={{ ...inputStyle, width: 120 }} />
              </div>
              <Button onClick={saveTax} disabled={busy === 'tax'}>{busy === 'tax' ? 'Saving…' : 'Save'}</Button>
            </div>
          </Section>

          <Section title="Fallback rates" last>
            <p style={para}>
              Used <b>only</b> for messages Meta has not reported a cost for yet — normally just today&rsquo;s
              traffic. Editing these does not change past figures: once Meta reports a day, its real numbers take over.
            </p>
            {(data.rates || []).map(r => (
              <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0' }}>
                <span style={{ fontSize: 14, color: C.textSecondary, width: 190 }}>
                  {r.country} · {String(r.category).replace(/_/g, ' ')}
                </span>
                <input value={rates[r.id] ?? ''} onChange={e => setRates(s2 => ({ ...s2, [r.id]: e.target.value }))}
                  type="number" min="0" step="0.0001"
                  style={{ ...inputStyle, width: 130, fontFamily: MONO }} />
                <span style={{ fontSize: 13, color: C.textMuted }}>{r.currency} per message</span>
                {String(rates[r.id]) !== String(r.rate) && (
                  <Button onClick={() => saveRate(r.id)} disabled={busy === `rate-${r.id}`}>
                    {busy === `rate-${r.id}` ? 'Saving…' : 'Save'}
                  </Button>
                )}
              </div>
            ))}
          </Section>
        </>
      )}
    </Modal>
  );
}

function Section({ title, children, last }) {
  return (
    <div style={{ paddingBottom: 16, marginBottom: last ? 0 : 16, borderBottom: last ? 'none' : `1px solid ${C.border}` }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

const para = { fontSize: 14, color: C.textSecondary, lineHeight: 1.6, margin: '0 0 12px' };
const miniLabel = { fontSize: 13, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textSecondary, marginBottom: 5 };

// Our attributed total against Meta's own, with the reasons they differ. Both
// reasons below are real on this instance and neither is a defect.
function Reconciliation({ o }) {
  const gap = Number(o.coverage?.gap || 0);
  const unreadable = o.coverage?.unreadableWabas || [];
  const unconnected = o.coverage?.unconnectedNumbers || [];
  const explained = unreadable.length > 0 || unconnected.length > 0;

  return (
    <Card title="Checked against Meta">
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', alignItems: 'start' }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textMuted }}>Attributed here</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: C.text, marginTop: 4 }}>{rs(o.cost)}</div>
          <div style={{ fontSize: 14, color: C.textMuted, marginTop: 3 }}>broken down by template below</div>
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textMuted }}>Meta reports</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: C.text, marginTop: 4 }}>{rs(o.metaReportedCost)}</div>
          <div style={{ fontSize: 14, color: C.textMuted, marginTop: 3 }}>
            {(o.metaReportedVolume ?? 0).toLocaleString('en-IN')} charged messages across every number on your accounts
          </div>
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textMuted }}>Difference</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: Math.abs(gap) < 0.01 ? 'var(--c-successText, #0F6E56)' : C.textSecondary, marginTop: 4 }}>
            {Math.abs(gap) < 0.01 ? 'None' : rs(gap)}
          </div>
          <div style={{ fontSize: 14, color: C.textMuted, marginTop: 3 }}>
            {Math.abs(gap) < 0.01 ? 'every charged message is accounted for' : explained ? 'explained below' : 'unexplained'}
          </div>
        </div>
      </div>

      {explained && (
        <div style={{ marginTop: 14, display: 'grid', gap: 9 }}>
          {unconnected.length > 0 && (
            <Note tone="info">
              Meta bills per WhatsApp Business Account, and{' '}
              {unconnected.length === 1 ? 'one number on your accounts is' : `${unconnected.length} numbers on your accounts are`}{' '}
              not connected to this app ({unconnected.map(u => u.number).join(', ')}). Their messages are inside Meta's
              total and can never appear in the per-template breakdown, because this app never receives their delivery
              receipts.
            </Note>
          )}
          {unreadable.length > 0 && (
            <Note tone="warn">
              {unreadable.length === 1 ? 'One WhatsApp Business Account cannot' : `${unreadable.length} WhatsApp Business Accounts cannot`}{' '}
              be read with the stored Meta token, so their spend is missing from <b>both</b> figures — it is not zero,
              it is unknown. Reconnect Meta with a token that covers {unreadable.join(', ')} to include it.
            </Note>
          )}
        </div>
      )}

      {(o.wabaSync || []).length > 0 && (
        <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
          {o.wabaSync.map(w => (
            <div key={w.wabaId} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '5px 0', fontSize: 14 }}>
              <span style={{ fontFamily: MONO, color: C.textSecondary }}>{w.numbers || w.wabaId}</span>
              <Badge
                label={w.status === 'ok' ? 'Reading' : w.status === 'unauthorized' ? 'No permission' : w.status}
                color={w.status === 'ok' ? 'var(--c-successText, #0F6E56)' : 'var(--c-dangerText, #A32D2D)'}
                bg={w.status === 'ok' ? 'var(--c-successBg, #E1F5EE)' : 'var(--c-dangerBg, #FCEBEB)'}
              />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Note({ children, tone = 'info' }) {
  const tones = {
    info: { bg: 'var(--c-infoBg, #EEF4FF)', border: '#C7D9F7', color: 'var(--c-s1e3a6b, #1E3A6B)', Icon: Info },
    warn: { bg: 'var(--c-warnBgSoft, #FDF6E3)', border: '#EDD9A3', color: 'var(--c-s7a5a12, #7A5A12)', Icon: AlertTriangle },
  };
  const t = tones[tone] || tones.info;
  return (
    <div style={{
      display: 'flex', gap: 9, alignItems: 'flex-start', background: t.bg, border: `1px solid ${t.border}`,
      color: t.color, borderRadius: 9, padding: '10px 13px', fontSize: 14, lineHeight: 1.55, fontFamily: FONT,
    }}>
      <t.Icon size={15} style={{ flexShrink: 0, marginTop: 1 }} />
      <div>{children}</div>
    </div>
  );
}

export { rs, rate, RATE_SOURCE_LABEL };
