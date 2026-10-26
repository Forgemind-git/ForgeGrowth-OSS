// Sales → Contacts → Funnel. How far the contacts who arrived in a period got,
// through the configured funnel stages, filterable by source + date range, with
// a click-through to the contacts in each stage.
//
// ⚠ A FUNNEL COUNTS WHO REACHED A STAGE, NOT WHO IS STANDING IN IT. The old
// chart divided each stage's CURRENT headcount by the one before it, so with
// 48 contacts in Engaged and 186 in Hot it reported "388%" — a funnel that
// widens is a sign the numbers are wrong. Stages are ordered, so a contact in
// Hot has been through Engaged: reached(stage) = everyone in that stage or any
// later funnel stage. Every step is then ≤ 100% and the drop-off between two
// rows is a real number of people. "Now here" (the current headcount) is still
// shown, and is what the drill-down lists.
//
// Branch stages (Cold / Lost) sit outside the order — a lost contact could have
// left from any stage — so they are reported beside the funnel, not in it.
//
// The date range filters on when the contact ARRIVED (created_at), so a range is
// a cohort: "of the people who came in this month, how far did they get".
import { useState, useEffect, useMemo } from 'react';
import { Filter, X, Users, Trophy, TrendingDown, ChevronRight } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO, T, W } from '../../constants.js';
import { showError } from '../../lib/feedback.js';
import { PageShell, Segmented, EmptyState, fmtDate } from '../academy/shared.jsx';
import { KpiCard, Card, Shimmer, EmptyChart } from '../../components/charts.jsx';
import { useFunnelConfig } from '../../hooks/useFunnelConfig.js';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import ContactProfileModal, { ContactAvatar, contactName } from './ContactProfileModal.jsx';

function rangeDates(key) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  if (key === 'week') {
    const d = new Date(now); const day = (d.getDay() + 6) % 7; // Mon=0
    d.setDate(d.getDate() - day);
    return { from: iso(d), to: iso(now) };
  }
  if (key === 'month') return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
  if (key === '90d') { const d = new Date(now); d.setDate(d.getDate() - 89); return { from: iso(d), to: iso(now) }; }
  return { from: '', to: '' };
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const fmtPct = (v) => `${v % 1 === 0 ? v : v.toFixed(1)}%`;

/** Current headcounts per stage → the funnel rows. Pure, for the tests. */
export function funnelRows(funnel) {
  const list = Array.isArray(funnel) ? funnel : [];
  let running = 0;
  const reached = new Array(list.length);
  for (let i = list.length - 1; i >= 0; i--) { running += list[i].count || 0; reached[i] = running; }
  const top = reached[0] || 0;
  return list.map((s, i) => ({
    ...s,
    now: s.count || 0,
    reached: reached[i],
    ofTop: pct(reached[i], top),
    // Conversion from the previous stage: of those who reached it, how many went on.
    step: i === 0 ? null : pct(reached[i], reached[i - 1]),
    dropped: i === 0 ? 0 : reached[i - 1] - reached[i],
  }));
}

export default function FunnelViewerPage({ user, navigate, tabs }) {
  const { sources } = useFunnelConfig();
  const [range, setRange] = useState('all');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [source, setSource] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState(null); // { stage, label, color, leads|null }
  const [open, setOpen] = useState(null);

  const dates = range === 'custom' ? custom : rangeDates(range);

  async function load() {
    setLoading(true);
    try {
      setData(await api.funnel.chart({ source, from: dates.from, to: dates.to, dateField: 'created_at' }));
    } catch (e) { showError(e.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [source, range, custom.from, custom.to]);

  const rows = useMemo(() => funnelRows(data?.funnel), [data]);
  const branches = data?.branches || [];
  const branchTotal = branches.reduce((a, s) => a + s.count, 0);
  const top = rows[0]?.reached || 0;
  const total = top + branchTotal;
  const last = rows[rows.length - 1];
  const won = last?.reached || 0;
  // The step that loses the most people — what to work on first.
  // The step that loses the largest SHARE of the people who reached the stage
  // before it — that is the step to work on, whatever its absolute size.
  const worst = rows.slice(1).map((r, i) => ({ ...r, prevLabel: rows[i].label }))
    .filter(r => r.step != null && rows[0].reached > 0)
    .reduce((w, r) => (!w || r.step < w.step ? r : w), null);

  async function openDrill(s) {
    setDrill({ stage: s.stageKey, label: s.label, color: s.color, leads: null });
    try {
      const res = await api.leads.list({ stage: s.stageKey, ...(source ? { source } : {}) });
      setDrill(d => d && d.stage === s.stageKey ? { ...d, leads: res.leads || [] } : d);
    } catch (e) { showError(e.message); setDrill(null); }
  }

  const sourceOpts = [{ value: '', label: 'All sources' }, ...sources.map(s => ({ value: s, label: s }))];
  const inputStyle = { padding: '7px 10px', border: `1.5px solid ${C.border}`, borderRadius: 8, fontFamily: FONT, background: C.cardBg, color: C.text };

  return (
    <PageShell
      subtitle="How far your contacts got through the funnel. A contact counts at every stage they passed through."
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', maxWidth: '100%', minWidth: 0 }}>
          <div style={{ width: 210, maxWidth: '100%' }}><SearchableSelect value={source} onChange={setSource} options={sourceOpts} placeholder="All sources" /></div>
          <Segmented value={range} onChange={setRange}
            options={[{ value: 'week', label: 'This week' }, { value: 'month', label: 'This month' }, { value: '90d', label: '90 days' }, { value: 'all', label: 'All time' }, { value: 'custom', label: 'Custom' }]} />
        </div>
      }
    >
      {tabs}
      {range === 'custom' && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, fontFamily: FONT, fontSize: T.bodyLg, color: C.textSecondary }}>
          <span>Arrived from</span>
          <input type="date" value={custom.from} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))} style={inputStyle} />
          <span>to</span>
          <input type="date" value={custom.to} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))} style={inputStyle} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14, marginBottom: 18 }}>
        <KpiCard label="Contacts" value={loading ? '—' : total.toLocaleString('en-IN')} icon={Users}
          info="Everyone who arrived in this period (and matches the source), in or out of the funnel." />
        <KpiCard label={last?.label || 'Last stage'} value={loading ? '—' : won.toLocaleString('en-IN')} icon={Trophy} accent={C.green}
          sub={loading ? undefined : `${fmtPct(pct(won, top))} of everyone who started`}
          info={`Contacts who reached the final funnel stage (${last?.label || '—'}).`} />
        <KpiCard label="Biggest drop-off" value={loading || !worst ? '—' : `${fmtPct(100 - worst.step)}`} icon={TrendingDown} accent={C.warnText}
          sub={worst ? `${worst.prevLabel} → ${worst.label} · ${worst.dropped.toLocaleString('en-IN')} people` : undefined}
          info="The step that loses the largest share of the people who reached it — where to look first." />
        <KpiCard label="Left the funnel" value={loading ? '—' : branchTotal.toLocaleString('en-IN')} accent={C.textSecondary}
          sub={branches.length ? branches.map(b => b.label).join(', ') : undefined}
          info="Contacts moved to a branch stage such as Cold / Lost." />
      </div>

      <Card title="Funnel" right={!loading && rows.length > 0 && <span style={{ fontSize: T.meta, color: C.textMuted }}>Click a stage to see who is in it now</span>}>
        {loading ? (
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', height: 300 }}>{[260, 190, 140, 90].map((h, i) => <div key={i} style={{ flex: 1 }}><Shimmer height={h} radius={10} /></div>)}</div>
        ) : !rows.length ? (
          <EmptyChart text="No funnel stages configured" />
        ) : (
          <>
            {/* The columns keep a readable width; on a narrow screen they scroll
                inside the card rather than making the whole page pan sideways. */}
            <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
              <FunnelColumns rows={rows} onOpen={openDrill} />
            </div>
            {branches.length > 0 && (
              <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${C.borderSubtle}`, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: T.meta, fontWeight: W.medium, color: C.textSecondary }}>Left the funnel:</span>
                {branches.map(s => (
                  <button key={s.stageKey} onClick={() => openDrill(s)}
                    style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 99, border: `1px solid ${C.border}`, background: C.cardBg, fontFamily: FONT, fontSize: T.body }}>
                    <span style={{ width: 8, height: 8, borderRadius: 99, background: s.color || C.textMuted }} />
                    <span style={{ color: C.text, fontWeight: W.medium }}>{s.label}</span>
                    <span style={{ color: C.textSecondary, fontWeight: W.bold }}>{s.count.toLocaleString('en-IN')}</span>
                  </button>
                ))}
                <span style={{ fontSize: T.label, color: C.textMuted }}>Not in the stages above — they could have left from any of them.</span>
              </div>
            )}
          </>
        )}
      </Card>

      {drill && (
        <div onClick={() => setDrill(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 170, display: 'flex', justifyContent: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()} data-testid="funnel-drill" style={{ width: 'min(480px, calc(92vw / var(--fg-zoom, 1)))', height: '100%', background: C.cardBg, boxShadow: C.shadowLg, display: 'flex', flexDirection: 'column', fontFamily: FONT }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: `1px solid ${C.border}` }}>
              <span style={{ width: 11, height: 11, borderRadius: 99, background: drill.color || C.primary }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: T.lead, fontWeight: W.bold, color: C.text }}>{drill.label}</div>
                <div style={{ fontSize: T.meta, color: C.textSecondary }}>{drill.leads == null ? 'Loading…' : `${drill.leads.length} contact${drill.leads.length === 1 ? '' : 's'} in this stage now`}</div>
              </div>
              <button onClick={() => setDrill(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textSecondary }} aria-label="Close"><X size={18} /></button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
              {drill.leads == null ? <div style={{ padding: 20 }}><Shimmer height={20} /></div>
                : drill.leads.length === 0 ? <EmptyState Icon={Filter} title="Nobody here" hint="No contacts are in this stage for the selected source." />
                : drill.leads.map(l => (
                  <button key={l.id} onClick={() => setOpen(l)}
                    style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '10px 20px', border: 'none', borderBottom: `1px solid ${C.borderSubtle}`, background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: FONT }}
                    onMouseEnter={e => { e.currentTarget.style.background = C.rowHover; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                    <ContactAvatar label={contactName(l)} seed={l.whatsappNumber} size={32} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: T.body, fontWeight: W.medium, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contactName(l)}</span>
                      <span style={{ display: 'block', fontSize: T.label, color: C.textMuted }}>{l.source || '—'} · {fmtDate(l.lastActivityAt || l.createdAt)}</span>
                    </span>
                    <ChevronRight size={15} color={C.textMuted} />
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}
      {open && <ContactProfileModal lead={open} user={user} navigate={navigate} onClose={() => setOpen(null)} onChanged={load} />}
    </PageShell>
  );
}


// The step funnel: one column per stage, the bar's height is how many people
// REACHED that stage, and a faded ghost behind it is the height of the stage
// before, so the drop-off is the visible gap. The conversion between two
// stages sits on the connector between their columns. Clicking a column opens
// the contacts who are in that stage now.
const CHART_H = 260;
const HEAD_H = 78;
const GAP = 48;
function FunnelColumns({ rows, onOpen }) {
  const top = Math.max(1, rows[0]?.reached || 0);
  const h = (n) => Math.max(n > 0 ? 6 : 0, Math.round((n / top) * CHART_H));
  return (
    <div data-testid="funnel" style={{ overflowX: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: GAP, minWidth: rows.length * 120 + (rows.length - 1) * GAP }}>
        {rows.map((r, i) => (
          <div key={r.stageKey} style={{ position: 'relative', display: 'flex', flex: 1, minWidth: 0 }}>
            {i > 0 && (
              <div title={`${r.step}% of the people who reached ${rows[i - 1].label} went on to ${r.label}`}
                style={{ position: 'absolute', left: -GAP / 2, top: HEAD_H + CHART_H / 2, transform: 'translate(-50%, -50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, zIndex: 1, pointerEvents: 'auto' }}>
                <span style={{ padding: '4px 9px', borderRadius: 99, background: C.cardBg, border: `1px solid ${C.border}`, boxShadow: C.shadowSm, fontSize: T.meta, fontWeight: W.bold, color: C.text, whiteSpace: 'nowrap' }}>{fmtPct(r.step)}</span>
                <ChevronRight size={15} color={C.textMuted} />
              </div>
            )}
            <button onClick={() => onOpen(r)} data-testid={`funnel-row-${r.stageKey}`} data-reached={r.reached} data-step={r.step ?? ''}
              title={`${r.label}: ${r.reached.toLocaleString('en-IN')} reached · ${r.now.toLocaleString('en-IN')} here now — click to see them`}
              className="fg-funnel-col"
              style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: '0 4px 6px', border: 'none', borderRadius: 12, background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: FONT }}>
              <div style={{ height: HEAD_H, padding: '4px 4px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 99, background: r.color || C.primary, flexShrink: 0 }} />
                  <span style={{ fontSize: T.body, fontWeight: W.bold, color: C.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', columnGap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                  <span style={{ fontSize: T.h2 + 4, fontWeight: W.heavy, color: C.text, lineHeight: 1 }}>{r.reached.toLocaleString('en-IN')}</span>
                  <span style={{ fontSize: T.meta, color: C.textMuted, whiteSpace: 'nowrap' }}>{i === 0 ? 'started' : `${fmtPct(r.ofTop)} of all`}</span>
                </div>
              </div>
              <div style={{ position: 'relative', height: CHART_H, width: '100%', borderBottom: `1px solid ${C.border}` }}>
                {/* the stage before it: the gap above the bar is who dropped off */}
                {i > 0 && (
                  <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: h(rows[i - 1].reached), borderRadius: '10px 10px 0 0',
                    background: `repeating-linear-gradient(135deg, ${C.surfaceMuted} 0 4px, transparent 4px 10px)`, opacity: 0.7, borderTop: `1px dashed ${C.borderStrong}` }} />
                )}
                <div className="fg-funnel-bar" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: h(r.reached), borderRadius: '10px 10px 0 0', background: r.color || C.primary, transition: 'height .4s, filter .15s' }} />
                {i > 0 && r.dropped > 0 && h(rows[i - 1].reached) - h(r.reached) > 26 && (
                  <div style={{ position: 'absolute', left: 0, right: 0, bottom: h(r.reached) + 6, textAlign: 'center', fontSize: T.label, fontWeight: W.medium, color: C.textSecondary }}>
                    −{r.dropped.toLocaleString('en-IN')}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginTop: 10, padding: '0 4px', fontSize: T.meta, color: C.textSecondary }}>
                <span>Here now <b style={{ color: C.text }}>{r.now.toLocaleString('en-IN')}</b></span>
                <ChevronRight size={14} color={C.textMuted} />
              </div>
            </button>
          </div>
        ))}
      </div>
      <style>{'.fg-funnel-col:hover{background:var(--c-rowHover)!important}.fg-funnel-col:hover .fg-funnel-bar{filter:brightness(1.06)}'}</style>
    </div>
  );
}
