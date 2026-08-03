// Three read-only panels for the Conversion API tab: the click-ID inspector,
// Meta's learning-phase progress, and the before/after comparison.
import { useState, useEffect, useCallback } from 'react';
import {
  Search, Copy, Check, Fingerprint, CheckCircle2, AlertTriangle, MinusCircle,
  TrendingUp, TrendingDown, Minus, GraduationCap, Clock,
} from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO } from '../constants.js';
import { showError } from '../lib/feedback.js';
import { Table, Td, Badge, EmptyState, Button, inputStyle, fmtINR, fmtDate } from '../pages/academy/shared.jsx';
import { Card, Shimmer } from './charts.jsx';
import SearchableSelect from './SearchableSelect.jsx';
import { NoteBanner } from './CapiNotes.jsx';

const num = (n) => Number(n || 0).toLocaleString('en-IN');

// ── Click-ID inspector ──────────────────────────────────────────────────────
const VERDICT = {
  confirmed:   { label: 'Confirmed by Meta', color: '#0F6E56', bg: '#E1F5EE', Icon: CheckCircle2 },
  unverified:  { label: 'Not yet sent',      color: '#6B7280', bg: '#F1F1EE', Icon: MinusCircle },
  check:       { label: 'Needs a look',      color: '#854F0B', bg: '#FAEEDA', Icon: AlertTriangle },
  no_click_id: { label: 'No click ID',       color: '#6B7280', bg: '#F1F1EE', Icon: MinusCircle },
};

export function ClickIdInspector({ note }) {
  const [filters, setFilters] = useState({ search: '', status: '', days: '', page: 1 });
  const [data, setData] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    setData(null);
    try { setData(await api.capi.clickIds({ ...filters, limit: 50 })); }
    catch (e) { showError(e.message); setData({ rows: [], total: 0 }); }
  }, [filters]);
  useEffect(() => { load(); }, [load]);

  return (
    <Card
      title="Click IDs"
      right={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative' }}>
            <Search size={14} color={C.textMuted} style={{ position: 'absolute', left: 10, top: 10 }} />
            <input placeholder="Click ID, number or name"
              style={{ ...inputStyle, width: 230, paddingLeft: 30 }}
              onKeyDown={e => e.key === 'Enter' && setFilters(f => ({ ...f, search: e.target.value, page: 1 }))}
              onBlur={e => setFilters(f => (f.search === e.target.value ? f : { ...f, search: e.target.value, page: 1 }))} />
          </div>
          <SearchableSelect value={filters.status} onChange={v => setFilters(f => ({ ...f, status: v, page: 1 }))}
            options={[
              { value: '', label: 'All clicks' },
              { value: 'present', label: 'Has a click ID' },
              { value: 'missing', label: 'No click ID' },
              { value: 'sent', label: 'Confirmed by Meta' },
              { value: 'duplicate', label: 'Shared by 2+ people' },
            ]} style={{ width: 180 }} />
          <SearchableSelect value={filters.days} onChange={v => setFilters(f => ({ ...f, days: v, page: 1 }))}
            options={[{ value: '', label: 'All time' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]}
            style={{ width: 130 }} />
        </div>
      }
      style={{ marginBottom: 16 }}
    >
      <NoteBanner note={note} style={{ marginBottom: 14 }} />
      {!data ? <Shimmer height={240} radius={10} /> : (
        <>
          <Table
            columns={[{ label: 'Person' }, { label: 'Click ID' }, { label: 'Ad' }, { label: 'Clicked' },
              { label: 'Age', align: 'right' }, { label: 'Status' }]}
            rows={data.rows} keyOf={r => r.id}
            onRowClick={r => setDetail(r)}
            empty={<EmptyState Icon={Fingerprint} title="No clicks recorded yet"
              hint="Every click-to-WhatsApp tap that starts a conversation appears here." />}
            renderRow={(r) => {
              const v = VERDICT[r.verdict] || VERDICT.unverified;
              return (
                <>
                  <Td>
                    <div style={{ fontWeight: 600 }}>{r.leadName || 'Unnamed'}</div>
                    <div style={{ fontSize: 11.5, fontFamily: MONO, color: C.textMuted }}>{r.contactNumber}</div>
                  </Td>
                  <Td><ClickIdCell clid={r.ctwaClid} /></Td>
                  <Td color={C.textSecondary} style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.adName || (r.sourceType === 'post' ? 'Organic post' : r.sourceId || '—')}
                  </Td>
                  <Td color={C.textSecondary}>{fmtDate(r.clickedAt)}</Td>
                  <Td mono align="right" color={C.textSecondary}>{r.ageDays != null ? `${r.ageDays}d` : '—'}</Td>
                  <Td><Badge label={v.label} color={v.color} bg={v.bg} /></Td>
                </>
              );
            }}
          />
          {data.total > (data.limit || 50) && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, fontFamily: FONT, fontSize: 12.5, color: C.textSecondary }}>
              <span>{num(data.total)} clicks</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button disabled={filters.page <= 1} onClick={() => setFilters(f => ({ ...f, page: f.page - 1 }))}>Previous</Button>
                <Button disabled={filters.page * (data.limit || 50) >= data.total} onClick={() => setFilters(f => ({ ...f, page: f.page + 1 }))}>Next</Button>
              </div>
            </div>
          )}
        </>
      )}
      {detail && <ClickIdDetail row={detail} onClose={() => setDetail(null)} />}
    </Card>
  );
}

// The click id itself, truncated but copyable in full — verifying one means
// comparing it against Events Manager, which needs the whole string.
function ClickIdCell({ clid }) {
  const [copied, setCopied] = useState(false);
  if (!clid) return <span style={{ color: C.textMuted, fontSize: 12 }}>—</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.text }}>{clid.slice(0, 14)}…</span>
      <button title="Copy the full click ID"
        onClick={(e) => {
          e.stopPropagation();
          navigator.clipboard?.writeText(clid).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); });
        }}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied ? C.green : C.textMuted, padding: 2, display: 'inline-flex' }}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </span>
  );
}

function ClickIdDetail({ row, onClose }) {
  const v = VERDICT[row.verdict] || VERDICT.unverified;
  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: 'min(560px, 100%)', maxHeight: '86vh', overflowY: 'auto', background: C.cardBg, borderRadius: 14, boxShadow: C.shadowLg, fontFamily: FONT, padding: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <v.Icon size={20} color={v.color} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{row.leadName || 'Unnamed'} · {v.label}</div>
            <div style={{ fontSize: 12, color: C.textSecondary, fontFamily: MONO }}>{row.contactNumber}</div>
          </div>
        </div>

        <div style={{ padding: '10px 12px', background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 9, marginBottom: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 4 }}>Full click ID</div>
          <div style={{ fontFamily: MONO, fontSize: 12, color: C.text, wordBreak: 'break-all' }}>{row.ctwaClid || 'None recorded'}</div>
        </div>

        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 8 }}>Checks</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {row.checks.map(c => (
            <div key={c.key} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
              {c.ok
                ? <CheckCircle2 size={15} color="#0F6E56" style={{ flexShrink: 0, marginTop: 1 }} />
                : <AlertTriangle size={15} color="#854F0B" style={{ flexShrink: 0, marginTop: 1 }} />}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text }}>{c.label}</div>
                {c.detail && <div style={{ fontSize: 12, color: C.textSecondary, lineHeight: 1.5, marginTop: 1 }}>{c.detail}</div>}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 16 }}>
          {[
            ['Ad', row.adName || row.sourceId || '—'],
            ['Placement', row.platform || '—'],
            ['Clicked', fmtDate(row.clickedAt)],
            ['Times seen', row.timesSeen],
            ['Last event', row.lastEvent || '—'],
            ['Match keys sent', (row.lastMatchKeys || []).length ? row.lastMatchKeys.join(', ') : '—'],
          ].map(([k, val]) => (
            <div key={k}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.textMuted }}>{k}</div>
              <div style={{ fontSize: 12.5, color: C.text, fontFamily: MONO, wordBreak: 'break-word' }}>{val}</div>
            </div>
          ))}
        </div>

        <Button onClick={onClose} style={{ width: '100%' }}>Close</Button>
      </div>
    </div>
  );
}

// ── Learning phase ──────────────────────────────────────────────────────────
export function LearningPhasePanel() {
  const [data, setData] = useState(null);
  useEffect(() => { api.capi.learning().then(setData).catch(() => setData(false)); }, []);

  if (data === false) return null;
  const g = data?.guidance;

  return (
    <Card title="Is Meta getting enough conversions to optimise?" style={{ marginBottom: 16 }}>
      {!data ? <Shimmer height={180} radius={10} /> : (
        <>
          <div style={{ display: 'flex', gap: 9, padding: '11px 13px', marginBottom: 14, background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 10 }}>
            <GraduationCap size={16} color={C.textMuted} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text, marginBottom: 4 }}>{g?.headline}</div>
              {(g?.detail || []).map((p, i) => (
                <p key={i} style={{ margin: i === g.detail.length - 1 ? 0 : '0 0 7px', fontSize: 12.5, lineHeight: 1.55, color: C.textSecondary }}>{p}</p>
              ))}
            </div>
          </div>

          {data.adsets.length === 0 ? (
            <EmptyState Icon={GraduationCap} title="No ad sets synced yet"
              hint="Sync Meta Ads to see how each ad set is tracking against the threshold." />
          ) : (
            <>
              {!data.anyMeeting && (
                <div style={{ padding: '10px 13px', marginBottom: 12, background: '#FFF8E6', border: '1px solid #F0DCA8', borderRadius: 9, fontSize: 12.5, color: '#6B5312', fontFamily: FONT, lineHeight: 1.5 }}>
                  No ad set is at {data.target} conversions a week yet. {g?.belowTargetHint}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {data.adsets.slice(0, 12).map(a => (
                  <div key={a.adsetExternalId || a.name}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{a.name}</span>
                      {a.campaignName && <span style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO }}>{a.campaignName}</span>}
                      <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 12.5, color: a.meetsTarget ? C.green : C.textSecondary }}>
                        {a.strongestCount} / {data.target}
                        {a.strongestEvent ? ` ${a.strongestEvent}` : ''} per week
                      </span>
                    </div>
                    <div style={{ height: 7, background: C.hover, borderRadius: 99, overflow: 'hidden' }}>
                      <div style={{ width: `${a.pctOfTarget}%`, height: '100%', background: a.meetsTarget ? C.green : '#E8A317', borderRadius: 99 }} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Card>
  );
}

// ── Click-to-stage timing ───────────────────────────────────────────────────
//
// The single number that decides whether CTWA optimisation can work: does a lead
// reach the qualifying stage inside Meta's 7-day window? Meta returns SUCCESS
// for a late event and then discards it, so without this you would see healthy
// send counts, no optimisation effect, and nothing explaining the gap.
export function TimingPanel() {
  const [data, setData] = useState(null);
  useEffect(() => { api.capi.timing().then(setData).catch(() => setData(false)); }, []);
  if (data === false) return null;

  const VERDICT = {
    inside: { label: 'Inside the window', color: '#0F6E56', bg: '#E1F5EE' },
    outside: { label: 'Past the window', color: '#dc2626', bg: '#FCEBEB' },
    no_data: { label: 'No data', color: '#6B7280', bg: '#F1F1EE' },
  };

  return (
    <Card title="How long from ad click to each stage" style={{ marginBottom: 16 }}>
      {!data ? <Shimmer height={180} radius={10} /> : (
        <>
          <div style={{ fontSize: 12.5, color: C.textSecondary, marginBottom: 14, lineHeight: 1.55, fontFamily: FONT }}>
            Meta only counts a click-to-WhatsApp conversion if it happens within <strong>{data.windowDays} days</strong> of
            the click. It returns success for a later one and then discards it, so a stage typically reached after that
            can never optimise anything — however well everything else is configured.
          </div>

          {data.diagnosis && (
            <div style={{
              display: 'flex', gap: 9, padding: '12px 14px', marginBottom: 14, background: '#FFF8E6',
              border: '1px solid #F0DCA8', borderRadius: 10, fontFamily: FONT,
            }}>
              <AlertTriangle size={15} color="#B7791F" style={{ flexShrink: 0, marginTop: 1 }} />
              <span style={{ fontSize: 12.5, color: '#6B5312', lineHeight: 1.55 }}>{data.diagnosis}</span>
            </div>
          )}

          <Table
            columns={[{ label: 'Stage' }, { label: 'Leads reached', align: 'right' },
              { label: 'Median days', align: 'right' }, { label: 'Within window', align: 'right' }, { label: 'Verdict' }]}
            rows={data.stages} keyOf={s => s.stageKey}
            empty={<EmptyState Icon={Clock} title="No timing data yet" />}
            renderRow={(s) => {
              const v = VERDICT[s.verdict] || VERDICT.no_data;
              return (
                <>
                  <Td bold>{s.label}</Td>
                  <Td mono align="right" color={s.leads ? C.text : C.textMuted}>{num(s.leads)}</Td>
                  <Td mono align="right">{s.medianDays == null ? '—' : s.medianDays.toFixed(1)}</Td>
                  <Td mono align="right" color={s.withinWindowPct === 100 ? C.green : C.textSecondary}>
                    {s.withinWindowPct == null ? '—' : `${s.withinWindowPct.toFixed(0)}%`}
                  </Td>
                  <Td><Badge label={v.label} color={v.color} bg={v.bg} /></Td>
                </>
              );
            }}
          />
        </>
      )}
    </Card>
  );
}

// ── Before / after ──────────────────────────────────────────────────────────
export function PerformancePanel() {
  const [data, setData] = useState(null);
  useEffect(() => { api.capi.performance().then(setData).catch(() => setData(false)); }, []);
  if (data === false) return null;

  return (
    <Card title="Before and after switching on" style={{ marginBottom: 16 }}>
      {!data ? <Shimmer height={160} radius={10} /> : !data.ready ? (
        <>
          <NoteBanner note={data.note} style={{ marginBottom: 12 }} />
          <div style={{ padding: '14px 16px', background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 13, color: C.textSecondary, fontFamily: FONT, lineHeight: 1.55 }}>
            {data.message}
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: C.textSecondary, marginBottom: 12, fontFamily: FONT }}>
            Comparing the {data.spanDays} days before conversions started flowing ({fmtDate(data.enabledAt)}) with the {data.spanDays} days since.
          </div>
          {data.spendNote && (
            <div style={{ padding: '10px 13px', marginBottom: 12, background: '#FFF8E6', border: '1px solid #F0DCA8', borderRadius: 9, fontSize: 12.5, color: '#6B5312', fontFamily: FONT }}>
              {data.spendNote}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 14 }}>
            <Delta label="Leads" before={data.before.leads} after={data.after.leads} fmt={num} />
            <Delta label="Enrolments" before={data.before.enrolled} after={data.after.enrolled} fmt={num} />
            <Delta label="Lead → enrolment" before={data.before.leadToEnrolPct} after={data.after.leadToEnrolPct} fmt={v => v == null ? '—' : `${v.toFixed(1)}%`} />
            <Delta label="Revenue" before={data.before.revenue} after={data.after.revenue} fmt={fmtINR} />
            {data.hasDailySpend && <>
              <Delta label="Spend" before={data.before.spend} after={data.after.spend} fmt={fmtINR} lowerIsBetter />
              <Delta label="Cost / lead" before={data.before.costPerLead} after={data.after.costPerLead} fmt={v => v == null ? '—' : fmtINR(v)} lowerIsBetter />
              <Delta label="ROAS" before={data.before.roas} after={data.after.roas} fmt={v => v == null ? '—' : `${v.toFixed(2)}x`} />
            </>}
          </div>
          <div style={{ padding: '10px 13px', background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 9, fontSize: 12, color: C.textMuted, fontFamily: FONT, lineHeight: 1.5 }}>
            {data.caveat}
          </div>
        </>
      )}
    </Card>
  );
}

// A before→after pair with its direction. `lowerIsBetter` flips the colour for
// cost metrics, where a fall is the good outcome.
function Delta({ label, before, after, fmt, lowerIsBetter }) {
  const b = before == null ? null : Number(before);
  const a = after == null ? null : Number(after);
  const comparable = b != null && a != null && b !== 0;
  const pct = comparable ? ((a - b) / Math.abs(b)) * 100 : null;
  const up = pct != null && pct > 0.5;
  const down = pct != null && pct < -0.5;
  const good = lowerIsBetter ? down : up;
  const bad = lowerIsBetter ? up : down;
  const Icon = up ? TrendingUp : down ? TrendingDown : Minus;
  const color = pct == null ? C.textMuted : good ? C.green : bad ? C.primary : C.textSecondary;

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 11, background: C.cardBg, padding: '11px 13px' }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
        <span style={{ fontFamily: MONO, fontSize: 13, color: C.textMuted }}>{fmt(before)}</span>
        <span style={{ color: C.textMuted, fontSize: 12 }}>→</span>
        <span style={{ fontFamily: MONO, fontSize: 17, fontWeight: 700, color: C.text }}>{fmt(after)}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, fontSize: 12, color, fontFamily: MONO }}>
        <Icon size={12} />
        {pct == null ? 'no comparison' : `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`}
      </div>
    </div>
  );
}
