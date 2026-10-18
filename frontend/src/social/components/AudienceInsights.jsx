import { useState } from "react";
import { Users, Clock, Info, HeartHandshake } from "lucide-react";
import { C, FONT, MONO, T } from "../constants.js";
import { fmtCompact } from "../data/mockData.js";
import { Card, SectionHead, Badge, Tooltip } from "./UI.jsx";

// ── Label helpers — show full forms, not API codes ───────────
const GENDER_LABELS = {
  M: "Male", F: "Female", U: "Not specified",
  Male: "Male", Female: "Female", User_specified: "Not specified", Unknown: "Not specified",
};
let _regionNames = null;
try { _regionNames = new Intl.DisplayNames(["en"], { type: "region" }); } catch (_) { /* old browsers: fall back to codes */ }
function expandLabel(label, kind) {
  if (kind === "gender") return GENDER_LABELS[label] || label;
  if (kind === "country" && _regionNames && /^[A-Z]{2}$/.test(label)) {
    try { return _regionNames.of(label) || label; } catch (_) { return label; }
  }
  return label;
}

// Sub-heading inside a card: label style (12/650 uppercase), text-secondary.
const subLabel = { ...T.label, color: C.textSecondary, fontFamily: FONT };

// Info icon + hover tooltip explaining where the data comes from.
function InfoTip({ text }) {
  const [tip, setTip] = useState(null);
  return (
    <>
      <span
        style={{ display: "inline-flex", cursor: "help", opacity: 0.55 }}
        onMouseEnter={(e) => setTip({ x: e.clientX + 8, y: e.clientY - 8 })}
        onMouseMove={(e) => setTip(prev => prev ? { ...prev, x: e.clientX + 8, y: e.clientY - 8 } : null)}
        onMouseLeave={() => setTip(null)}
      >
        <Info size={13} strokeWidth={2.4} />
      </span>
      {tip && <Tooltip x={tip.x} y={tip.y}>{text}</Tooltip>}
    </>
  );
}

// Horizontal bar list — top entries of one demographic breakdown, drawn with
// the shared rail recipe (22px rounded rail on the surface tint, label left,
// count right). Values are absolute follower counts (IG/Threads) or % (YT).
function BarList({ title, items, accent, kind, unit = "followers", max = 6 }) {
  const [tip, setTip] = useState(null);
  if (!items?.length) return null;
  const top = items.slice(0, max);
  const peak = Math.max(...top.map(i => i.value), 1);
  return (
    <div style={{ flex: 1, minWidth: 220 }}>
      <div style={{ ...subLabel, marginBottom: 10 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {top.map(i => {
          const label = expandLabel(i.label, kind);
          const valStr = i.suffix ? `${i.value}${i.suffix}` : fmtCompact(i.value);
          return (
            <div key={i.label}
              onMouseEnter={(e) => setTip({ x: e.clientX + 8, y: e.clientY - 8, content: `${label}: ${valStr}${i.suffix ? "" : ` ${unit}`}` })}
              onMouseMove={(e) => setTip(prev => prev ? { ...prev, x: e.clientX + 8, y: e.clientY - 8 } : null)}
              onMouseLeave={() => setTip(null)}
              style={{ display: "grid", gridTemplateColumns: "minmax(0, 104px) 1fr 56px", alignItems: "center", gap: 10, cursor: "default" }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: C.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: FONT }}>{label}</span>
              <div style={{ height: 22, background: C.surface, borderRadius: 999, overflow: "hidden", minWidth: 0 }}>
                <div style={{ width: `${Math.max(2, (i.value / peak) * 100)}%`, height: "100%", background: accent, borderRadius: 999 }} />
              </div>
              <span style={{ fontSize: 15, fontFamily: FONT, fontWeight: 600, fontVariantNumeric: "tabular-nums", color: C.text, textAlign: "right", whiteSpace: "nowrap" }}>{valStr}</span>
            </div>
          );
        })}
      </div>
      {tip && <Tooltip x={tip.x} y={tip.y}>{tip.content}</Tooltip>}
    </div>
  );
}

// 24-hour "audience online" histogram (IST) — Instagram online_followers.
export function OnlineFollowersStrip({ buckets, accent = C.primary }) {
  const [hover, setHover] = useState(null);   // { x, y, hour }
  if (!buckets?.length) return null;
  const peak = Math.max(...buckets, 1);
  const peakHour = buckets.indexOf(Math.max(...buckets));
  const hourLabel = (h) => `${((h + 11) % 12) + 1} ${h < 12 ? "AM" : "PM"}`;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 12 }}>
        <div style={{ ...subLabel, display: "flex", alignItems: "center", gap: 6 }}>
          <Clock size={13} strokeWidth={2.4} /> When your audience is online (IST)
          <InfoTip text="Based on Instagram's online_followers insight: how many of your followers were active on Instagram in each hour, averaged over the last 30 days. Hours converted from UTC to IST. Updated once a day." />
        </div>
        <Badge label={`Peak ${hourLabel(peakHour)}`} bg={C.greenSoft} color={C.green} />
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 56 }}>
        {buckets.map((v, h) => {
          const isPeak = h === peakHour;
          const isHover = hover?.hour === h;
          // Peak = solid accent; hover = accent at half strength; rest = surface-2.
          const fill = isPeak ? accent : isHover ? `color-mix(in srgb, ${accent} 50%, transparent)` : C.surface2;
          return (
            <div key={h}
              onMouseEnter={(e) => setHover({ x: e.clientX + 8, y: e.clientY - 28, hour: h })}
              onMouseMove={(e) => setHover(prev => prev ? { ...prev, x: e.clientX + 8, y: e.clientY - 28 } : null)}
              onMouseLeave={() => setHover(null)}
              style={{ flex: 1, height: `${Math.max(8, (v / peak) * 100)}%`, background: fill, borderRadius: 12, transition: "background .12s", cursor: "default" }} />
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 12, color: C.textMuted, fontFamily: MONO }}>
        <span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>11 PM</span>
      </div>
      {hover && (
        <Tooltip x={hover.x} y={hover.y}>
          <span style={{ fontWeight: 700 }}>{hourLabel(hover.hour)}</span>
          {" — on average "}{fmtCompact(buckets[hover.hour])} of your followers are on Instagram at this hour (30-day average)
        </Tooltip>
      )}
    </div>
  );
}

const hasDemo = (demo) => !!(demo?.age?.length || demo?.gender?.length || demo?.country?.length);

// A row of Age / Gender / Top countries bar lists for one demographic set.
// countryUnit: IG/Threads report follower counts per country; YT reports views.
function DemoRow({ demo, accent, countryUnit = "followers" }) {
  return (
    <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
      <BarList title="Age" items={demo.age} accent={accent} kind="age" />
      <BarList title="Gender" items={demo.gender} accent={accent} kind="gender" max={4} />
      <BarList title="Top countries" items={demo.country} accent={accent} kind="country" unit={countryUnit} />
    </div>
  );
}

const TitleWithInfo = ({ icon: IconCmp, title, infoText }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
    {IconCmp && <IconCmp size={13} strokeWidth={2.4} />} {title}
    <InfoTip text={infoText} />
  </span>
);

// Full audience section for a platform tab on the Overview.
// audience = the /api/platforms/:key/audience payload.
export function AudienceSection({ audience, accent, platformName }) {
  if (!audience || audience.available === false) return null;
  const hasAnything = audience.age?.length || audience.gender?.length || audience.country?.length
    || audience.engaged || audience.onlineFollowers || audience.trafficSources;
  if (!hasAnything) return null;

  const followerSource = platformName === "YouTube"
    ? "Reported by the YouTube Analytics API: viewer age/gender as a percentage of watch time and top countries by views, last 90 days. Updated once a day."
    : `Reported by the ${platformName} API: demographic breakdown of your current followers (lifetime totals, accounts with 100+ followers only). Updated once a day.`;
  const engagedInfo = `Reported by the ${platformName} API: demographics of accounts that interacted with your content (engaged audience), which can differ from who follows you. Updated once a day.`;
  const showFollows = hasDemo(audience);
  const showEngaged = hasDemo(audience.engaged);

  return (
    <>
      {(showFollows || showEngaged) && (
        <Card style={{ marginBottom: 16 }}>
          <SectionHead right={<Badge label="Updated daily" bg={C.surface} color={C.textMuted} />}>
            {showFollows
              ? <TitleWithInfo icon={Users} title={platformName === "YouTube" ? "Audience · who watches you" : "Audience · who follows you"} infoText={followerSource} />
              : <TitleWithInfo icon={HeartHandshake} title="Audience · who engages with you" infoText={engagedInfo} />}
          </SectionHead>
          {showFollows && <DemoRow demo={audience} accent={accent} countryUnit={platformName === "YouTube" ? "views" : "followers"} />}
          {/* The engaged-audience breakdown sits ON the raised card as a surface card. */}
          {showFollows && showEngaged && (
            <div style={{ marginTop: 18, background: C.surface, borderRadius: 16, padding: 18 }}>
              <SectionHead>
                <TitleWithInfo icon={HeartHandshake} title="Audience · who engages with you" infoText={engagedInfo} />
              </SectionHead>
              <DemoRow demo={audience.engaged} accent={accent} />
            </div>
          )}
          {!showFollows && showEngaged && <DemoRow demo={audience.engaged} accent={accent} />}
        </Card>
      )}
      {audience.onlineFollowers && (
        <Card style={{ marginBottom: 16 }}>
          <OnlineFollowersStrip buckets={audience.onlineFollowers} accent={accent} />
        </Card>
      )}
      {audience.trafficSources && (
        <Card style={{ marginBottom: 16 }}>
          <SectionHead right={<Badge label={`Last ${audience.windowDays || 90} days`} bg={C.surface} color={C.textMuted} />}>
            <TitleWithInfo title={`Where ${platformName} views come from`} infoText="Reported by the YouTube Analytics API: views grouped by traffic source (search, suggested videos, Shorts feed, external links, etc.) over the last 90 days. Updated once a day." />
          </SectionHead>
          <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
            <BarList title="Traffic source" items={audience.trafficSources} accent={accent} kind="source" max={8} />
          </div>
        </Card>
      )}
    </>
  );
}
