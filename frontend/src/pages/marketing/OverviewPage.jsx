// Marketing Overview — the single top-of-funnel screen.
//
// Lead Sources used to be its own tab; it is folded in here because "which
// channels bring leads" is the same question this page already answers with the
// donut, just at table depth. The page also carries two compact activity strips:
// Click-to-WhatsApp (are the ads producing conversations?) and Conversion API
// (is Meta being told what those conversations became?), each linking to its own
// tab for the detail.
import { useState, useEffect, useCallback } from 'react';
import {
  Users, IndianRupee, Megaphone, GraduationCap, GitBranch, MousePointerClick,
  ArrowRight, AlertTriangle, CheckCircle2,
} from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import { showError } from '../../lib/feedback.js';
import { PageShell, Table, Td, EmptyState, Badge, fmtINR, fmtDate, STAGE_META } from '../academy/shared.jsx';
import { KpiCard, Card, Donut, FunnelBars, LineTrend, Shimmer, SERIES } from '../../components/charts.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import FlowRow from '../../components/FlowRow.jsx';
import DateRangeControl, { useMarketingRange, rangeParams, rangeLabel, SpendCoverageNote } from '../../components/DateRangeControl.jsx';
import { useFunnelConfig, funnelStageMeta } from '../../hooks/useFunnelConfig.js';

function num(n) { return Number(n || 0).toLocaleString('en-IN'); }

export default function OverviewPage({ user, navigate }) {
  const { sources: sourceOptions } = useFunnelConfig();
  // Shared with Campaigns and Click-to-WhatsApp, and survives a refresh.
  const [range, setRange] = useMarketingRange();
  const params = rangeParams(range);
  const paramsKey = JSON.stringify(params);
  const label = rangeLabel(range);
  const [source, setSource] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  // Folded-in Lead Sources table.
  const [sources, setSources] = useState(null);

  // Activity strips. Both are best-effort: this page must still render for a
  // user whose role can't reach those tabs, so a rejection means "hide the
  // strip", never an error modal.
  const [ctwa, setCtwa] = useState(null);
  const [capi, setCapi] = useState(null);

  const isAdmin = user?.role === 'admin';
  const canSeeCtwa = isAdmin || (user?.pages || []).includes('ctwa-ads');

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api.marketing.overview(JSON.parse(paramsKey), source || undefined)); }
    catch (e) { showError(e.message); }
    finally { setLoading(false); }
  }, [paramsKey, source]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    setSources(null);
    api.leads.sources(JSON.parse(paramsKey)).then(d => setSources(d.sources)).catch(() => setSources([]));
  }, [paramsKey]);

  useEffect(() => {
    if (!canSeeCtwa) { setCtwa(false); return; }
    setCtwa(null);
    api.ctwa.overview(JSON.parse(paramsKey)).then(setCtwa).catch(() => setCtwa(false));
  }, [paramsKey, canSeeCtwa]);

  useEffect(() => {
    if (!isAdmin) { setCapi(false); return; }   // /capi/config is admin-only by design
    api.capi.config().then(setCapi).catch(() => setCapi(false));
  }, [isAdmin]);

  const k = data?.kpis || {};

  return (
    <PageShell
      subtitle="Single-glance top-of-funnel health check — where leads come from, and what the ad loop is doing."
      actions={
        <>
          <div style={{ width: 170 }}>
            <SearchableSelect value={source} onChange={setSource}
              options={[{ value: '', label: 'All sources' }, ...sourceOptions.map(s => ({ value: s, label: s }))]}
              placeholder="All sources" />
          </div>
          <DateRangeControl value={range} onChange={setRange} />
        </>
      }
    >
      <div style={{ fontSize: 14, color: C.textMuted, fontFamily: FONT, marginBottom: 10 }}>
        Every figure on this page covers leads that arrived in <strong style={{ color: C.textSecondary }}>{label}</strong>
        {data?.spendBasis === 'lifetime' ? ', and spend is the lifetime total from Meta.' : ', and spend is Meta’s per-day spend for the same days.'}
      </div>

      {/* KPI row, in the order money turns into students: we spend → leads
          arrive → what each one cost → who enrolled. */}
      {loading ? (
        <div style={{ display: 'flex', gap: 12, marginBottom: 18 }}>
          {[0, 1, 2, 3].map(i => <div key={i} style={{ flex: 1 }}><Shimmer height={110} radius={12} /></div>)}
        </div>
      ) : (
        <FlowRow style={{ marginBottom: 18 }} steps={[
          { key: 'spend', step: 'We spent', node: (
            <KpiCard label="Ad Spend" icon={Megaphone} value={k.spend != null ? fmtINR(k.spend) : '—'}
              sub={data?.spendBasis === 'lifetime' ? 'lifetime, from Meta' : data?.spendCoverage?.partial ? 'incomplete — see note' : 'for this range'}
              info={data?.spendBasis === 'lifetime'
                ? 'All time is selected, so this is every campaign’s lifetime spend from the Meta Ads sync.'
                : 'Meta’s per-day spend for exactly these days. Campaign spend totals are lifetime and cannot be split by date, so they are not used here.'} />
          ) },
          { key: 'leads', step: 'Leads came in', node: (
            <KpiCard label="New Leads" icon={Users} value={k.newLeads} info={`Leads created in ${label}.`} />
          ) },
          { key: 'cpl', step: 'Cost of each', node: (
            <KpiCard label="Cost / Lead" icon={IndianRupee} value={k.costPerLead != null ? fmtINR(k.costPerLead) : '—'}
              sub={k.metaLeads != null ? `${num(k.metaLeads)} Meta leads` : undefined}
              info="Meta ad spend ÷ the leads Meta attributes to those ads, over the same days." />
          ) },
          { key: 'enrolled', step: 'They enrolled', node: (
            <KpiCard label="Enrollments" icon={GraduationCap} value={k.enrollments} accent={C.green} info={`Leads that reached Enrolled in ${label}.`} />
          ) },
        ]} />
      )}
      {!loading && <SpendCoverageNote coverage={data?.spendCoverage} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16, marginBottom: 16 }}>
        <Card title="Leads by source">
          {loading ? <Shimmer height={180} /> :
            <Donut maxSlices={6} data={(data.bySource || []).map(s => ({ label: s.source, value: s.count }))} />}
        </Card>
        <Card title="Funnel snapshot" right={<LinkText onClick={() => navigate && navigate('leads')}>Open pipeline</LinkText>}>
          {loading ? <Shimmer height={180} /> :
            <FunnelBars data={(data.funnel || []).map(f => ({ stage: f.stage, count: f.count }))}
              unit="leads" empty="No leads in the funnel yet."
              colorFor={(f) => funnelStageMeta(f.stage)?.color || STAGE_META[f.stage]?.color}
              onClick={() => navigate && navigate('leads')} />}
        </Card>
      </div>


      {/* ── Lead sources (was its own tab) ─────────────────────────────────── */}
      <Card title="Lead sources" style={{ marginBottom: 16 }}
        right={<span style={{ fontSize: 14, color: C.textMuted, fontFamily: FONT }}>Leads from {label}, ranked by quality</span>}>
        {!sources ? <Shimmer height={220} radius={10} /> : (
          <Table
            columns={[{ label: 'Source' }, { label: 'Leads', align: 'right' }, { label: 'Entry Stage' },
              { label: '→ Hot' }, { label: '→ Enrolled' },
              { label: 'Cost / Lead', align: 'right' }]}
            rows={sources} keyOf={s => s.source}
            empty={<EmptyState Icon={GitBranch} title="No lead sources yet"
              hint="Sources are set automatically from where each conversation started." />}
            onRowClick={() => navigate && navigate('leads', 'list')}
            renderRow={(s) => (
              <>
                <Td bold>{s.source}</Td>
                <Td align="right" mono>{s.leads}</Td>
                <Td color={C.textSecondary} style={{ textTransform: 'capitalize' }}>{s.entryStage}</Td>
                <Td><Bar pct={s.hotPct} color={C.amber} /></Td>
                <Td><Bar pct={s.enrolledPct} color={C.green} /></Td>
                <Td align="right" mono>{s.costPerLead != null ? fmtINR(s.costPerLead) : '—'}</Td>
              </>
            )}
          />
        )}
      </Card>
      {/* Ad-loop activity: the two halves of the click → conversation → conversion
          chain, each a summary with a way through to the full tab. */}
      {(canSeeCtwa || isAdmin) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16, marginBottom: 16 }}>
          {canSeeCtwa && <CtwaStrip data={ctwa} label={label} navigate={navigate} />}
          {isAdmin && <CapiStrip data={capi} navigate={navigate} />}
        </div>
      )}

      <Card title="Leads trend">
        {loading ? <Shimmer height={150} /> : <LineTrend data={data.trend || []} />}
      </Card>
    </PageShell>
  );
}

function Bar({ pct, color }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      <span style={{ width: 54, height: 6, borderRadius: 4, background: C.hover, overflow: 'hidden' }}>
        <span style={{ display: 'block', width: `${Math.min(100, pct)}%`, height: '100%', background: color }} />
      </span>
      <span style={{ fontFamily: MONO, fontSize: 14, color: C.text, minWidth: 32 }}>{pct}%</span>
    </span>
  );
}

function LinkText({ onClick, children }) {
  return (
    <span onClick={onClick}
      style={{ fontSize: 14, color: C.primary, cursor: 'pointer', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {children} <ArrowRight size={12} />
    </span>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div style={{ minWidth: 74 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: C.textMuted }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, fontFamily: MONO, color: accent || C.text, marginTop: 2 }}>{value}</div>
    </div>
  );
}

// ── Click-to-WhatsApp strip ─────────────────────────────────────────────────
function CtwaStrip({ data, label, navigate }) {
  return (
    <Card title="Click-to-WhatsApp"
      right={<LinkText onClick={() => navigate && navigate('ctwa-ads')}>Open</LinkText>}>
      {data === null ? <Shimmer height={110} /> : data === false ? (
        <div style={{ fontSize: 14, color: C.textMuted, fontFamily: FONT }}>Not available for your account.</div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
            <MousePointerClick size={15} color={C.textSecondary} />
            <span style={{ fontSize: 14, color: C.textSecondary, fontFamily: FONT }}>
              Conversations that started from an ad, {label}.
            </span>
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 12 }}>
            <Stat label="Clicks" value={num(data.kpis?.clicks)} />
            <Stat label="Leads" value={num(data.kpis?.leads)} />
            <Stat label="Enrolled" value={num(data.kpis?.enrolled)} accent={C.green} />
            <Stat label="Cost/Lead" value={data.kpis?.costPerLead != null ? fmtINR(data.kpis.costPerLead) : '—'} />
            <Stat label="ROAS" value={data.kpis?.roas != null ? `${data.kpis.roas.toFixed(2)}x` : '—'}
              accent={data.kpis?.roas >= 1 ? C.green : C.text} />
          </div>
          {(data.allPlatforms || []).length > 0 && (
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
              {(data.allPlatforms || []).slice(0, 4).map(p => (
                <Badge key={p.platform} label={`${p.platform} · ${num(p.clicks)}`} color={C.textSecondary} bg={C.hover} />
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ── Conversion API strip ────────────────────────────────────────────────────
function CapiStrip({ data, navigate }) {
  const cfg = data && data.config;
  const s = (data && data.stats) || {};
  const on = !!cfg?.enabled;

  return (
    <Card title="Conversion API"
      right={<LinkText onClick={() => navigate && navigate('conversion-api')}>Open</LinkText>}>
      {data === null ? <Shimmer height={110} /> : data === false ? (
        <div style={{ fontSize: 14, color: C.textMuted, fontFamily: FONT }}>Not available for your account.</div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
            {on ? <CheckCircle2 size={15} color={C.green} /> : <AlertTriangle size={15} color="var(--c-warnText, #854F0B)" />}
            <span style={{ fontSize: 14, color: C.textSecondary, fontFamily: FONT }}>
              {on
                ? `Sending conversions to Meta in ${cfg.mode === 'live' ? 'live' : 'test'} mode.`
                : 'Off — stage changes are recorded but nothing is sent to Meta.'}
            </span>
            <Badge label={on ? (cfg.mode === 'live' ? 'LIVE' : 'TEST') : 'OFF'}
              color={on ? (cfg.mode === 'live' ? 'var(--c-primary, #dc2626)' : 'var(--c-warnText, #854F0B)') : C.textMuted}
              bg={on ? (cfg.mode === 'live' ? 'var(--c-dangerBg, #FCEBEB)' : 'var(--c-warnBg, #FAEEDA)') : C.hover}
              style={{ marginLeft: 'auto' }} />
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 12 }}>
            <Stat label="Sent" value={num(s.sent)} accent={C.green} />
            <Stat label="Failed" value={num(s.failed)} accent={Number(s.failed) ? 'var(--c-primary, #dc2626)' : C.text} />
            <Stat label="Skipped" value={num(s.skipped)} />
            <Stat label="Waiting" value={num(s.eligible)} />
          </div>
          <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10, fontSize: 13, color: C.textMuted, fontFamily: FONT }}>
            {cfg?.lastSentAt ? `Last sent ${fmtDate(cfg.lastSentAt)}` : 'Nothing transmitted yet'}
            {data.unreachableClicks > 0 && (
              <span style={{ color: 'var(--c-s8a1f1f, #8A1F1F)' }}>
                {' · '}{num(data.unreachableClicks)} clicks on an account with no dataset
              </span>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
