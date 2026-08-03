// Funnel Chart Viewer (spec §5) — funnel-shaped chart driven by the configured
// Funnel Stage order, filterable by Funnel Source + date range, with click-to-
// drill-down into the leads currently in a stage. Lives in the Sales section.
import { useState, useEffect, useMemo } from 'react';
import { Filter, X, Users } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import { showError } from '../../lib/feedback.js';
import { PageShell, Segmented, EmptyState, fmtDate } from '../academy/shared.jsx';
import { KpiCard, Card, Shimmer, EmptyChart } from '../../components/charts.jsx';
import { useFunnelConfig } from '../../hooks/useFunnelConfig.js';
import SearchableSelect from '../../components/SearchableSelect.jsx';

// Compute [from,to] ISO dates for a named range (IST-ish, uses local date).
function rangeDates(key) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  if (key === 'week') {
    const d = new Date(now); const day = (d.getDay() + 6) % 7; // Mon=0
    d.setDate(d.getDate() - day);
    return { from: iso(d), to: iso(now) };
  }
  if (key === 'month') {
    return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
  }
  return { from: '', to: '' }; // all
}

export default function FunnelViewerPage({ user }) {
  const { sources } = useFunnelConfig();
  const [range, setRange] = useState('all');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [source, setSource] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState(null); // { stage, label, leads|null }

  const dates = range === 'custom' ? custom : rangeDates(range);

  async function load() {
    setLoading(true);
    try {
      const res = await api.funnel.chart({ source, from: dates.from, to: dates.to });
      setData(res);
    } catch (e) { showError(e.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [source, range, custom.from, custom.to]);

  const funnel = data?.funnel || [];
  const branches = data?.branches || [];
  const topCount = funnel.length ? Math.max(1, funnel[0].count) : 1;
  const totalIn = useMemo(() => funnel.reduce((a, s) => a + s.count, 0) + branches.reduce((a, s) => a + s.count, 0), [data]);
  const wonCount = funnel.filter((_, i) => i === funnel.length - 1).reduce((a, s) => a + s.count, 0);
  const overallPct = funnel.length && funnel[0].count ? Math.round((funnel[funnel.length - 1].count / funnel[0].count) * 100) : 0;

  async function openDrill(stage, label) {
    setDrill({ stage, label, leads: null });
    try {
      const res = await api.leads.list({ stage, ...(source ? { source } : {}) });
      setDrill({ stage, label, leads: res.leads || res || [] });
    } catch (e) { showError(e.message); setDrill(null); }
  }

  const sourceOpts = [{ value: '', label: 'All sources' }, ...sources.map(s => ({ value: s, label: s }))];

  return (
    <PageShell
      title="Funnel"
      subtitle="Live lead distribution across your configured funnel stages."
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <SearchableSelect value={source} onChange={setSource} options={sourceOpts} placeholder="All sources"
            triggerStyle={{ padding: '8px 30px 8px 11px' }} />
          <Segmented value={range} onChange={setRange}
            options={[{ value: 'week', label: 'This week' }, { value: 'month', label: 'This month' }, { value: 'all', label: 'All time' }, { value: 'custom', label: 'Custom' }]} />
        </div>
      }
    >
      {range === 'custom' && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, fontFamily: FONT, fontSize: 13, color: C.textSecondary }}>
          <span>From</span>
          <input type="date" value={custom.from} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))}
            style={{ padding: '7px 10px', border: `1.5px solid ${C.border}`, borderRadius: 8, fontFamily: FONT }} />
          <span>to</span>
          <input type="date" value={custom.to} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))}
            style={{ padding: '7px 10px', border: `1.5px solid ${C.border}`, borderRadius: 8, fontFamily: FONT }} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 18 }}>
        <KpiCard label="Leads in view" value={loading ? '—' : totalIn} icon={Users}
          info="Total leads matching the current source + date filter (all stages)." />
        <KpiCard label="Top of funnel" value={loading ? '—' : (funnel[0]?.count ?? 0)} accent="#2563eb"
          info={`Leads at the first stage (${funnel[0]?.label || '—'}).`} />
        <KpiCard label="Reached won stage" value={loading ? '—' : wonCount} accent={C.green}
          info={`Leads at the final funnel stage (${funnel[funnel.length - 1]?.label || '—'}).`} />
        <KpiCard label="Overall conversion" value={loading ? '—' : `${overallPct}%`} accent={C.primary}
          info="First stage → final funnel stage." />
      </div>

      <Card title="Funnel">
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[0, 1, 2, 3, 4].map(i => <Shimmer key={i} height={40} radius={8} />)}
          </div>
        ) : !funnel.length ? (
          <EmptyChart text="No funnel stages configured" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }}>
            {funnel.map((s, i) => {
              const widthPct = Math.max(8, Math.round((s.count / topCount) * 100));
              const prev = i > 0 ? funnel[i - 1].count : null;
              const stepPct = prev ? Math.round((s.count / prev) * 100) : null;
              return (
                <div key={s.stageKey}>
                  {stepPct != null && (
                    <div style={{ textAlign: 'center', fontFamily: MONO, fontSize: 11, color: C.textMuted, margin: '1px 0 3px' }}>
                      ↓ {stepPct}%
                    </div>
                  )}
                  <div onClick={() => openDrill(s.stageKey, s.label)} title={`${s.label}: ${s.count} — click to view leads`}
                    style={{ display: 'flex', justifyContent: 'center', cursor: 'pointer' }}>
                    <div style={{
                      width: `${widthPct}%`, minWidth: 150, background: s.color || C.primary, color: '#fff',
                      borderRadius: 8, padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      gap: 12, boxShadow: C.shadowSm, transition: 'transform .12s', fontFamily: FONT,
                    }}
                      onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.01)'; }}
                      onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}>
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{s.label}</span>
                      <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 600 }}>{s.count}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {!loading && branches.length > 0 && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px dashed ${C.border}` }}>
            <div style={{ fontFamily: FONT, fontSize: 12, color: C.textMuted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.04em' }}>Branches off funnel</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {branches.map(s => (
                <div key={s.stageKey} onClick={() => openDrill(s.stageKey, s.label)}
                  style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, border: `1.5px solid ${C.border}`, fontFamily: FONT, fontSize: 13 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 99, background: s.color }} />
                  <span style={{ color: C.text, fontWeight: 600 }}>{s.label}</span>
                  <span style={{ fontFamily: MONO, color: C.textMuted }}>{s.count}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {drill && (
        <div onClick={() => setDrill(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 200, display: 'flex', justifyContent: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(460px, 92vw)', height: '100%', background: C.cardBg, boxShadow: C.shadowLg, display: 'flex', flexDirection: 'column', fontFamily: FONT }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${C.border}` }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{drill.label}</div>
                <div style={{ fontSize: 12, color: C.textSecondary }}>{drill.leads == null ? 'Loading…' : `${drill.leads.length} lead(s) in this stage`}</div>
              </div>
              <button onClick={() => setDrill(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textSecondary }}><X size={18} /></button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
              {drill.leads == null ? (
                <div style={{ padding: 20 }}><Shimmer height={20} /></div>
              ) : drill.leads.length === 0 ? (
                <EmptyState Icon={Filter} title="No leads here" hint="No leads currently in this stage for the selected filter." />
              ) : drill.leads.map(l => (
                <div key={l.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 20px', borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name || 'Unnamed'}</div>
                    <div style={{ fontSize: 11.5, color: C.textMuted, fontFamily: MONO }}>{l.source || '—'} · {fmtDate(l.lastActivityAt || l.createdAt)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
