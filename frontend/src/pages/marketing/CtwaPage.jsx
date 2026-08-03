// Click-to-WhatsApp — how every CTWA ad actually performs, end to end.
//
// The data is NOT another Meta pull: every inbound message from a CTWA ad
// carries a `referral` block (click id, ad id, placement, and the exact
// creative the person saw). The webhook stores it in coexistence.ctwa_referrals,
// so this page joins ad → conversation → lead → stage → revenue locally, and
// only borrows spend/impressions from the Meta Ads sync.
import { useState, useEffect, useCallback } from 'react';
import {
  MousePointerClick, Users, Film, Image as ImageIcon, ExternalLink, X, Info,
  TrendingUp, Wallet, Target, CalendarDays, PlayCircle, MessageSquare,
} from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import { showError } from '../../lib/feedback.js';
import {
  PageShell, Table, Td, Badge, EmptyState, Segmented, StageBadge, fmtINR, fmtDate,
} from '../academy/shared.jsx';
import { Card, KpiCard, Donut, LineTrend, Shimmer, EmptyChart } from '../../components/charts.jsx';

const PLATFORM_COLOR = {
  Instagram: '#db2777',
  Facebook: '#2563eb',
  WhatsApp: '#0F6E56',
  Other: '#6B7280',
  Unknown: '#6B7280',
};

const RANGES = [
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
  { value: '', label: 'All' },
];

function num(n) {
  return Number(n || 0).toLocaleString('en-IN');
}

// Meta's creative URLs are signed and expire; never let a dead image leave a
// broken icon in the table.
function Thumb({ src, mediaType, size = 40 }) {
  const [ok, setOk] = useState(true);
  const Icon = mediaType === 'video' ? Film : ImageIcon;
  if (!src || !ok) {
    return (
      <div style={{ width: size, height: size, borderRadius: 8, background: C.hover, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon size={size * 0.42} color={C.textMuted} />
      </div>
    );
  }
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <img src={src} alt="" onError={() => setOk(false)}
        style={{ width: size, height: size, borderRadius: 8, objectFit: 'cover', display: 'block', border: `1px solid ${C.border}` }} />
      {mediaType === 'video' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.28)', borderRadius: 8 }}>
          <Film size={size * 0.34} color="#fff" />
        </div>
      )}
    </div>
  );
}

function PlatformBadge({ platform, all }) {
  const color = PLATFORM_COLOR[platform] || PLATFORM_COLOR.Other;
  const extra = all && all.split(', ').filter(p => p !== platform);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <Badge label={platform || '—'} color={color} bg={`${color}18`} />
      {extra && extra.length > 0 && (
        <span title={`Also ran on ${extra.join(', ')}`} style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO }}>
          +{extra.length}
        </span>
      )}
    </span>
  );
}

export default function CtwaPage({ navigate }) {
  const [days, setDays] = useState('30');
  const [platform, setPlatform] = useState('');
  const [data, setData] = useState(null);
  const [popup, setPopup] = useState(null);

  // The placement toggle is rendered from THIS list, never from data.platforms.
  // data.platforms is the filtered breakdown, so selecting "Instagram" shrinks it
  // to a single entry — which used to make the toggle disappear with no way back.
  // Held in its own state so it also survives the null-data gap during a refetch.
  const [placements, setPlacements] = useState([]);

  const load = useCallback(async () => {
    setData(null);
    try {
      const d = await api.ctwa.overview({ days, platform });
      setData(d);
      // allPlatforms is placement-blind (date range still applies). Fall back to
      // the filtered list only on an older backend that doesn't send it.
      const all = d.allPlatforms || d.platforms || [];
      if (all.length) setPlacements(all.map(p => p.platform).filter(Boolean));
    } catch (e) {
      showError(e.message);
      setData({ kpis: {}, ads: [], platforms: [], allPlatforms: [], timeseries: [], stages: [], creatives: [] });
    }
  }, [days, platform]);
  useEffect(() => { load(); }, [load]);

  const k = data?.kpis || {};
  const ads = data?.ads || [];

  return (
    <PageShell
      title="Click-to-WhatsApp"
      subtitle="Every conversation that started from a click-to-WhatsApp ad — the ad, the creative they saw, and what happened after."
      actions={
        <>
          {placements.length > 0 && (
            <Segmented
              options={[{ value: '', label: 'All placements' }, ...placements.map(p => ({ value: p, label: p }))]}
              value={platform} onChange={setPlatform}
            />
          )}
          {/* Date range gets its own labelled control so it reads as a filter
              rather than a second, unrelated set of tabs next to placements. */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 4px 4px 11px',
            border: `1.5px solid ${C.border}`, borderRadius: 11, background: C.cardBg }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11,
              fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textMuted, fontFamily: FONT }}>
              <CalendarDays size={14} /> Period
            </span>
            <Segmented options={RANGES} value={days} onChange={setDays} />
          </div>
        </>
      }
    >
      {!data ? <Shimmer height={110} radius={12} /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 16 }}>
          <KpiCard label="Ad clicks" value={num(k.clicks)} icon={MousePointerClick}
            sub={`${num(k.trackedClicks)} with a click ID`}
            info="One row per click-to-WhatsApp click that opened a conversation. Clicks without a click ID (organic post CTAs) can be measured but not sent to Meta." />
          <KpiCard label="People" value={num(k.people)} icon={Users} sub={`${num(k.ads)} ads`} />
          <KpiCard label="Leads" value={num(k.leads)} sub="in the funnel" />
          <KpiCard label="Enrolled" value={num(k.enrolled)} accent="#0F6E56" icon={Target}
            sub={k.leadToEnrolPct != null ? `${k.leadToEnrolPct.toFixed(1)}% of leads` : '—'} />
          <KpiCard label="Revenue" value={fmtINR(k.revenue)} accent="#0F6E56" icon={TrendingUp}
            info="Gateway payments (deduped) plus manually logged sales, for leads that came from these ads." />
          <KpiCard label="Spend" value={fmtINR(k.spend)} icon={Wallet}
            sub={data.spendIsLifetime ? 'lifetime, from Meta' : undefined}
            info="Comes from the Meta Ads sync and is LIFETIME spend per ad — it does not shrink when you narrow the date range above." />
          <KpiCard label="Cost / lead" value={k.costPerLead != null ? fmtINR(k.costPerLead) : '—'} />
          <KpiCard label="ROAS" value={k.roas != null ? `${k.roas.toFixed(2)}x` : '—'}
            accent={k.roas >= 1 ? '#0F6E56' : C.text}
            sub={k.costPerEnrolment != null ? `${fmtINR(k.costPerEnrolment)} / enrolment` : undefined} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14, marginBottom: 16 }}>
        <Card title="Clicks over time">
          {!data ? <Shimmer height={150} /> :
            data.timeseries.length ? <LineTrend data={data.timeseries} valueKey="clicks" labelKey="day" /> : <EmptyChart />}
        </Card>
        <Card title="Where the clicks came from">
          {!data ? <Shimmer height={168} /> : data.platforms.length ? (
            <>
              {/* Donut carries its own legend (placement + clicks) — the strip
                  below adds what the legend can't: what those clicks became. */}
              <Donut data={data.platforms.map(p => ({ label: p.platform, value: p.clicks, color: PLATFORM_COLOR[p.platform] || PLATFORM_COLOR.Other }))} />
              <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                {data.platforms.map(p => (
                  <div key={p.platform} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontFamily: FONT, fontSize: 12.5 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 3, background: PLATFORM_COLOR[p.platform] || PLATFORM_COLOR.Other, flexShrink: 0 }} />
                    <span style={{ flex: 1, color: C.textSecondary }}>{p.platform}</span>
                    <span style={{ fontFamily: MONO, color: C.text }}>{num(p.leads)} leads</span>
                    <span style={{ fontFamily: MONO, color: p.enrolled ? '#0F6E56' : C.textMuted, minWidth: 70, textAlign: 'right' }}>{num(p.enrolled)} enrolled</span>
                  </div>
                ))}
              </div>
            </>
          ) : <EmptyChart />}
        </Card>
        <Card title="Where those leads are now">
          {!data ? <Shimmer height={150} /> : data.stages.length ? (
            <div>
              {data.stages.map(s => {
                const total = data.stages.reduce((a, b) => a + b.count, 0) || 1;
                const pct = (s.count / total) * 100;
                return (
                  <div key={s.stage} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <StageBadge stage={s.stage} />
                      <span style={{ flex: 1 }} />
                      <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.textSecondary }}>{num(s.count)} · {pct.toFixed(0)}%</span>
                    </div>
                    <div style={{ height: 6, background: C.hover, borderRadius: 99 }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: C.primary, borderRadius: 99 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : <EmptyChart />}
        </Card>
      </div>

      {data?.spendIsLifetime && ads.some(a => a.spend != null) && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 13px', marginBottom: 12,
          background: '#FFF8E6', border: '1px solid #F0DCA8', borderRadius: 9, fontFamily: FONT, fontSize: 12.5, color: '#6B5312' }}>
          <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            Clicks, leads and revenue respect the date range. <strong>Spend, impressions and Meta&apos;s own lead count are lifetime
            totals</strong> for each ad, taken from the Meta Ads sync — so cost-per-lead is conservative on short ranges.
            Per-ad revenue is <strong>multi-touch</strong>: someone who clicked two ads counts their full amount against both, so
            the revenue column can sum to more than the Revenue KPI above (which counts each person once).
          </span>
        </div>
      )}

      {!data ? <Shimmer height={260} radius={12} /> : (
        <Table
          columns={[
            { label: 'Ad' }, { label: 'Placement' }, { label: 'Clicks', align: 'right' }, { label: 'Leads', align: 'right' },
            { label: 'Enrolled', align: 'right' }, { label: 'Revenue', align: 'right' }, { label: 'Spend', align: 'right' },
            { label: 'Cost/Lead', align: 'right' }, { label: 'ROAS', align: 'right' }, { label: 'Last click' },
          ]}
          rows={ads} keyOf={a => a.sourceId}
          onRowClick={a => setPopup(a)}
          empty={<EmptyState Icon={MousePointerClick} title="No click-to-WhatsApp traffic yet"
            hint="As soon as someone taps a CTWA ad and messages you, they appear here automatically." />}
          renderRow={(a) => {
            const cpl = a.spend != null && a.leads ? a.spend / a.leads : null;
            const roas = a.spend ? a.revenue / a.spend : null;
            return (
              <>
                <Td style={{ whiteSpace: 'normal', maxWidth: 380 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Thumb src={a.thumbnailUrl} mediaType={a.mediaType} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: C.text }}>
                        {a.adName || (a.sourceType === 'post' ? 'Organic post CTA' : 'Unmatched ad')}
                      </div>
                      <div style={{ fontSize: 11.5, color: C.textMuted, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>
                        {a.campaignName || a.sourceId}
                        {a.creativeVariants > 1 && ` · ${a.creativeVariants} creatives`}
                      </div>
                    </div>
                  </div>
                </Td>
                <Td><PlatformBadge platform={a.platform} all={a.platforms} /></Td>
                <Td mono align="right" bold>{num(a.clicks)}</Td>
                <Td mono align="right">{num(a.leads)}</Td>
                <Td mono align="right" color={a.enrolled ? '#0F6E56' : C.textMuted}>{num(a.enrolled)}</Td>
                <Td mono align="right" color={a.revenue ? '#0F6E56' : C.textMuted}>{a.revenue ? fmtINR(a.revenue) : '—'}</Td>
                <Td mono align="right">{a.spend != null ? fmtINR(a.spend) : '—'}</Td>
                <Td mono align="right">{cpl != null ? fmtINR(cpl) : '—'}</Td>
                <Td mono align="right" color={roas != null && roas >= 1 ? '#0F6E56' : C.textSecondary}>
                  {roas != null ? `${roas.toFixed(2)}x` : '—'}
                </Td>
                <Td color={C.textSecondary}>{fmtDate(a.lastClick)}</Td>
              </>
            );
          }}
        />
      )}

      {popup && (
        <AdPopup
          ad={popup}
          onClose={() => setPopup(null)}
          // ChatsPage deep-links on subParts[0]/[1]. Closing first means the
          // modal isn't left mounted over the page we just navigated to.
          onOpenChat={(wa, contact) => {
            setPopup(null);
            if (navigate) navigate('chats', wa, contact);
          }}
        />
      )}
    </PageShell>
  );
}

// ── Drill-in popup: one ad's creatives + the people it actually brought ───────
//
// A centered pop-up that rises from below, NOT a side drawer — the creative is
// the point of this view, and a 620px side panel gave it nowhere to live.
//
// Laid out as creative-beside-numbers rather than numbers-then-creative: the
// question this view answers is "what did they see, and did it work?", and
// those two halves have to be readable together.
function AdPopup({ ad, onClose, onOpenChat }) {
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState('people');

  useEffect(() => {
    setDetail(null);
    api.ctwa.ad(ad.sourceId)
      .then(setDetail)
      .catch(e => { showError(e.message); setDetail({ referrals: [], leads: [], stages: [], timeseries: [] }); });
  }, [ad.sourceId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // The page behind must not scroll while a modal owns the screen.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  // Group this ad's clicks by the creative that was actually shown. Keyed on
  // media type + body, since one ad id can serve several bodies/videos.
  const creatives = [];
  for (const r of detail?.referrals || []) {
    const key = `${r.mediaType}|${r.body || ''}`;
    let c = creatives.find(x => x.key === key);
    if (!c) { c = { key, ...r, clicks: 0 }; creatives.push(c); }
    c.clicks++;
  }
  creatives.sort((a, b) => b.clicks - a.clicks);

  const syncedAd = detail?.ad || null;
  const hero = creatives[0] || null;

  // Derived rates, computed here rather than server-side so they always agree
  // with the row the user just clicked.
  const cpl = ad.spend != null && ad.leads ? ad.spend / ad.leads : null;
  const roas = ad.spend ? ad.revenue / ad.spend : null;
  const clickToLead = ad.clicks ? (ad.leads / ad.clicks) * 100 : null;
  const leadToEnrol = ad.leads ? (ad.enrolled / ad.leads) * 100 : null;
  const cpEnrol = ad.spend != null && ad.enrolled ? ad.spend / ad.enrolled : null;

  const leads = detail?.leads || [];
  const stages = detail?.stages || [];
  const series = detail?.timeseries || [];

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}>
      <style>{`
        @keyframes ctwaPopIn { from { opacity: 0; transform: translateY(28px) scale(.99); } to { opacity: 1; transform: none; } }
      `}</style>
      <div onClick={e => e.stopPropagation()}
        style={{
          position: 'relative', width: 'min(1120px, 100%)', maxHeight: '90vh', overflowY: 'auto',
          background: C.pageBg, borderRadius: 16, boxShadow: C.shadowLg, fontFamily: FONT,
          animation: 'ctwaPopIn .2s ease-out',
        }}>

        {/* Header: the ad's place in Meta's hierarchy, so it's clear which of
            several similarly-named "New Leads Ad" rows this actually is. */}
        <div style={{ position: 'sticky', top: 0, background: C.headerBg, color: C.headerText,
          padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12, zIndex: 3,
          borderRadius: '16px 16px 0 0' }}>
          <Thumb src={ad.thumbnailUrl} mediaType={ad.mediaType} size={38} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 15.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ad.adName || 'Click-to-WhatsApp ad'}
              </span>
              {ad.adStatus && (
                <Badge label={ad.adStatus.toUpperCase()}
                  color={ad.adStatus === 'active' ? '#0F6E56' : C.headerMuted}
                  bg={ad.adStatus === 'active' ? '#0F6E5622' : 'rgba(255,255,255,.1)'} />
              )}
            </div>
            <div style={{ fontSize: 11.5, color: C.headerMuted, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {[ad.campaignName, ad.adsetName || syncedAd?.adsetName].filter(Boolean).join('  ›  ') || 'No campaign linked'}
              <span style={{ fontFamily: MONO, marginLeft: 8, opacity: .75 }}>{ad.sourceId}</span>
            </div>
          </div>
          <button onClick={onClose} title="Close (Esc)"
            style={{ background: 'rgba(255,255,255,.1)', border: 'none', color: C.headerText,
              cursor: 'pointer', padding: 6, borderRadius: 8, display: 'flex' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '16px 20px 24px' }}>

          {/* ── Creative beside the funnel ─────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 380px) 1fr', gap: 16,
            alignItems: 'start', marginBottom: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {detail == null
                ? <Shimmer height={300} radius={12} />
                : <HeroCreative ad={ad} syncedAd={syncedAd} creative={hero} variants={creatives.length} />}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: 10 }}>
                <KpiCard label="Clicks" value={num(ad.clicks)} icon={MousePointerClick}
                  sub={`${num(ad.people)} people`} />
                <KpiCard label="Leads" value={num(ad.leads)}
                  sub={clickToLead != null ? `${clickToLead.toFixed(0)}% of clicks` : undefined} />
                <KpiCard label="Enrolled" value={num(ad.enrolled)} accent="#0F6E56" icon={Target}
                  sub={leadToEnrol != null ? `${leadToEnrol.toFixed(1)}% of leads` : undefined} />
                <KpiCard label="Revenue" value={fmtINR(ad.revenue)} accent="#0F6E56" icon={TrendingUp} />
                <KpiCard label="Spend" value={ad.spend != null ? fmtINR(ad.spend) : '—'} icon={Wallet}
                  sub="lifetime"
                  info="Lifetime spend for this ad, from the Meta Ads sync. It does not shrink when the date range on the page is narrowed, so cost-per-lead is conservative on short ranges." />
                <KpiCard label="Cost / lead" value={cpl != null ? fmtINR(cpl) : '—'}
                  sub={cpEnrol != null ? `${fmtINR(cpEnrol)} / enrolment` : undefined} />
                <KpiCard label="ROAS" value={roas != null ? `${roas.toFixed(2)}x` : '—'}
                  accent={roas != null && roas >= 1 ? '#0F6E56' : C.text} />
                <KpiCard label="Impressions" value={ad.impressions != null ? num(ad.impressions) : '—'}
                  sub={ad.metaLeads != null ? `${num(ad.metaLeads)} Meta leads` : undefined}
                  info="Meta's own count of messaging conversations started by this ad — usually a little higher than ours, since it counts taps we never saw a message from." />
              </div>

              {/* Side by side, and deliberately NOT tabs: these two are short,
                  and putting them here fills the column the tall creative
                  would otherwise leave empty. */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
                <Card title="Where this ad's people are now" style={{ margin: 0 }}>
                  {detail == null ? <Shimmer height={120} />
                    : stages.length ? <StageBars stages={stages} />
                    : <EmptyChart />}
                </Card>
                <Card title="Clicks per day" style={{ margin: 0 }}>
                  {detail == null ? <Shimmer height={120} />
                    : series.length ? <LineTrend data={series} valueKey="clicks" labelKey="day" />
                    : <EmptyChart />}
                </Card>
              </div>
            </div>
          </div>

          {/* ── Tabs: only the two long lists, so neither buries the other ─── */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, borderBottom: `1px solid ${C.border}` }}>
            <PopTab active={tab === 'people'} onClick={() => setTab('people')}
              label={`People (${leads.length})`} Icon={Users} />
            <PopTab active={tab === 'creatives'} onClick={() => setTab('creatives')}
              label={`Creatives (${creatives.length})`} Icon={ImageIcon} />
          </div>

          {tab === 'people' && (detail == null ? <Shimmer height={200} radius={10} /> : (
            <Table
              columns={[{ label: 'Name' }, { label: 'Stage' }, { label: 'Placement' },
                { label: 'Paid', align: 'right' }, { label: 'Clicked' }, { label: '' }]}
              rows={leads} keyOf={l => l.id}
              empty={<EmptyState Icon={Users} title="No leads yet"
                hint="Clicks on this ad haven't produced a conversation we could match to a lead." />}
              renderRow={(l) => (
                <>
                  <Td>
                    <div style={{ fontWeight: 600 }}>{l.name || 'Unnamed'}</div>
                    <div style={{ fontSize: 11.5, fontFamily: MONO, color: C.textMuted }}>{l.whatsappNumber}</div>
                  </Td>
                  <Td><StageBadge stage={l.stage} /></Td>
                  <Td><PlatformBadge platform={l.platform} /></Td>
                  <Td mono align="right" color={l.paid ? '#0F6E56' : C.textMuted}>{l.paid ? fmtINR(l.paid) : '—'}</Td>
                  <Td color={C.textSecondary}>{fmtDate(l.clickedAt)}</Td>
                  <Td align="right">
                    {/* Only rendered when a thread actually exists, so the link
                        is never dead. */}
                    {l.chatWaNumber && l.chatContactNumber ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); onOpenChat(l.chatWaNumber, l.chatContactNumber); }}
                        title="Open this conversation"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none',
                          border: `1px solid ${C.border}`, borderRadius: 7, padding: '4px 9px',
                          color: C.primary, cursor: 'pointer', fontFamily: FONT, fontSize: 12, fontWeight: 600 }}>
                        <MessageSquare size={13} /> Chat
                      </button>
                    ) : <span style={{ fontSize: 11.5, color: C.textMuted }}>No thread</span>}
                  </Td>
                </>
              )}
            />
          ))}

          {tab === 'creatives' && (detail == null ? <Shimmer height={220} radius={10} /> : (
            creatives.length === 0
              ? <EmptyState Icon={ImageIcon} title="No creative recorded"
                  hint="Meta didn't include creative details on these clicks." />
              : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 12 }}>
                  {creatives.map(c => (
                    <CreativeCard key={c.key} creative={c}
                      fullResImage={syncedAd?.imageUrl || ad.imageUrl}
                      smallThumb={ad.thumbnailUrl}
                      watchUrl={syncedAd?.watchUrl || ad.watchUrl} />
                  ))}
                </div>
              )
          ))}

        </div>
      </div>
    </div>
  );
}

function PopTab({ active, onClick, label, Icon }) {
  return (
    <button onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none',
        borderBottom: `2px solid ${active ? C.primary : 'transparent'}`, cursor: 'pointer',
        padding: '8px 12px', marginBottom: -1, fontFamily: FONT, fontSize: 13,
        fontWeight: active ? 700 : 500, color: active ? C.text : C.textSecondary,
      }}>
      <Icon size={14} /> {label}
    </button>
  );
}

function StageBars({ stages }) {
  const total = stages.reduce((a, b) => a + b.count, 0) || 1;
  return (
    <div>
      {stages.map(s => {
        const pct = (s.count / total) * 100;
        return (
          <div key={s.stage} style={{ marginBottom: 9 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <StageBadge stage={s.stage} />
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.textSecondary }}>
                {s.count} · {pct.toFixed(0)}%
              </span>
            </div>
            <div style={{ height: 6, background: C.hover, borderRadius: 99 }}>
              <div style={{ width: `${pct}%`, height: '100%', background: C.primary, borderRadius: 99 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// The single big "this is the ad" panel. Deliberately image-only with a link
// out: Meta does not expose the MP4 (requesting `source` on the video returns
// the id with the field silently omitted), so an inline player could only ever
// show a play button that fails.
function HeroCreative({ ad, syncedAd, creative, variants }) {
  const watch = syncedAd?.watchUrl || ad.watchUrl || creative?.videoUrl || creative?.sourceUrl || ad.igPermalink;
  const isVideo = (creative?.mediaType || ad.mediaType) === 'video';
  return (
    <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
      <CreativeMedia
        // Priority is RESOLUTION first, then freshness. The synced 64x64
        // thumbnail is last: it is the most reliably fresh URL but is far too
        // small to fill this frame, so it only serves as a final fallback
        // before the placeholder.
        imageUrls={[syncedAd?.imageUrl, ad.imageUrl, creative?.thumbnailUrl, ad.thumbnailUrl]}
        mediaType={creative?.mediaType || ad.mediaType}
        watchUrl={watch}
        isVideo={isVideo}
      />
      <div style={{ padding: '12px 14px' }}>
        {(creative?.headline || syncedAd?.title) && (
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 5 }}>
            {creative?.headline || syncedAd?.title}
          </div>
        )}
        <div style={{ fontSize: 12.5, color: C.textSecondary, whiteSpace: 'pre-wrap', lineHeight: 1.5,
          maxHeight: 132, overflowY: 'auto' }}>
          {creative?.body || syncedAd?.body || 'No ad copy recorded.'}
        </div>
        {creative?.welcomeMessage && (
          <div style={{ marginTop: 10, padding: '8px 10px', background: C.surfaceAlt, borderRadius: 8,
            fontSize: 12, color: C.textMuted, fontStyle: 'italic' }}>
            Opens WhatsApp with: “{creative.welcomeMessage}”
          </div>
        )}
        {variants > 1 && (
          <div style={{ marginTop: 10, fontSize: 11.5, color: C.textMuted }}>
            Showing the most-seen of {variants} creatives — the rest are under the Creatives tab.
          </div>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase',
      color: C.textMuted, marginBottom: 10 }}>
      {children}
    </div>
  );
}

// One creative variant, for the Creatives tab.
function CreativeCard({ creative: c, fullResImage, smallThumb, watchUrl }) {
  const watch = c.videoUrl || watchUrl || c.sourceUrl;
  return (
    <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
      {/* RESOLUTION first. The per-creative referral image (~640px) beats the
          synced 64x64, and the full-res synced image beats both. Passed as a
          chain so a dead URL walks on instead of dropping to an icon. */}
      <CreativeMedia
        imageUrls={[fullResImage, c.thumbnailUrl, smallThumb]}
        mediaType={c.mediaType}
        watchUrl={watch}
        isVideo={c.mediaType === 'video'}
        maxHeight={300}
      />
      <div style={{ padding: '12px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <Badge label={c.mediaType === 'video' ? 'VIDEO' : 'IMAGE'} color={C.textSecondary} bg={C.hover} />
          <span style={{ fontFamily: MONO, fontSize: 12, color: C.textSecondary }}>{c.clicks} clicks</span>
          {c.sourceUrl && (
            <a href={c.sourceUrl} target="_blank" rel="noreferrer"
              style={{ marginLeft: 'auto', color: C.primary, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, textDecoration: 'none', fontWeight: 600 }}>
              Open on Meta <ExternalLink size={12} />
            </a>
          )}
        </div>
        {c.headline && <div style={{ fontSize: 13.5, fontWeight: 600, color: C.text, marginBottom: 4 }}>{c.headline}</div>}
        <div style={{ fontSize: 12.5, color: C.textSecondary, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{c.body || '—'}</div>
        {c.welcomeMessage && (
          <div style={{ marginTop: 9, padding: '8px 10px', background: C.surfaceAlt, borderRadius: 8,
            fontSize: 12, color: C.textMuted, fontStyle: 'italic' }}>
            Opens WhatsApp with: “{c.welcomeMessage}”
          </div>
        )}
      </div>
    </div>
  );
}

// Shows the ad's creative.
//
// There is NO inline player, on purpose. Meta does not expose the video file:
// `ctwa_referrals.video_url` is a watch PAGE (story.php, content-type
// text/html), and asking the Graph API for the video's `source` returns the id
// with the field silently omitted. A <video> element could therefore only ever
// render a play button that fails on click — worse than not offering one. For
// video ads we show the full-resolution frame and link out to watch it.
//
// Image priority is RESOLUTION-first. Meta's /adcreatives `thumbnail_url` is
// locked at 64x64 (asking for width/height changes nothing), so preferring it
// for freshness — as this did — guaranteed a blurry card. It is kept last in
// the chain, where being small still beats being absent.
function CreativeMedia({ imageUrls = [], mediaType, watchUrl, isVideo, maxHeight = 400 }) {
  const [imgIdx, setImgIdx] = useState(0);

  // Reset when the creative changes, or a previously-exhausted chain would
  // stay exhausted for the next ad opened.
  const candidates = imageUrls.filter(Boolean);
  const key = candidates.join('|');
  useEffect(() => { setImgIdx(0); }, [key]);

  const imageUrl = candidates[imgIdx] || null;
  const exhausted = candidates.length > 0 && imgIdx >= candidates.length;
  const nextImage = () => setImgIdx(i => i + 1);

  // `contain`, never `cover`. Ad creatives are mostly 9:16 reels whose hook
  // text and CTA sit at the very top and bottom — cropping them to fill a 4:5
  // box hides the part of the ad that does the work. Letterboxing on the dark
  // frame shows the creative exactly as it ran. maxHeight keeps a tall vertical
  // creative from pushing the rest of the drill-in below the fold.
  const frame = {
    position: 'relative', width: '100%', aspectRatio: '4 / 5', maxHeight,
    background: '#0F0F10',
    display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  };

  const WatchButton = () => (
    watchUrl ? (
      <a href={watchUrl} target="_blank" rel="noreferrer"
        title="Meta doesn't allow the video to be embedded — this opens it on Facebook"
        style={{ position: 'absolute', left: 10, bottom: 10, display: 'inline-flex', alignItems: 'center',
          gap: 6, padding: '7px 12px', borderRadius: 99, background: 'rgba(0,0,0,.68)', color: '#fff',
          fontSize: 12.5, fontWeight: 600, textDecoration: 'none', backdropFilter: 'blur(3px)' }}>
        <PlayCircle size={15} /> Watch on Facebook
      </a>
    ) : null
  );

  if (imageUrl) {
    return (
      <div style={frame}>
        <img src={imageUrl} alt="" referrerPolicy="no-referrer" onError={nextImage}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        {isVideo && <WatchButton />}
      </div>
    );
  }

  const Icon = mediaType === 'video' ? Film : ImageIcon;
  return (
    <div style={{ ...frame, background: C.hover, flexDirection: 'column', gap: 10 }}>
      <Icon size={30} color={C.textMuted} strokeWidth={1.5} />
      <div style={{ fontSize: 12, color: C.textMuted, textAlign: 'center', padding: '0 20px' }}>
        {exhausted
          ? "Meta's link to this creative has expired."
          : 'No creative was captured for this click.'}
      </div>
      {watchUrl && (
        <a href={watchUrl} target="_blank" rel="noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: C.primary,
            fontSize: 12.5, fontWeight: 600, textDecoration: 'none' }}>
          {isVideo ? 'Watch on Facebook' : 'Open on Meta'} <ExternalLink size={12} />
        </a>
      )}
    </div>
  );
}
