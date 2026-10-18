import { useState, useEffect } from "react";
import { Star, Inbox as InboxIcon } from "lucide-react";
import { useOverview } from '../hooks/useOverview.js';
import { usePlatformStats } from '../hooks/usePlatformStats.js';
import { useFollowersTrend } from '../hooks/useFollowersTrend.js';
import { PLATFORMS, PLATFORM_ORDER, platformColor } from '../data/mockData.js';
import { fmtNum } from '../data/mockData.js';
import { C, FONT, T } from '../constants.js';
import { StatCard, PageHeader, PeriodPills, SectionHead, Card, PlatformBadge, LiveBadge, DataQualityBadge, UnderlineTabs } from '../components/UI.jsx';
import { useScope } from '../components/scope/scopeStore.js';
import { LineChart } from '../components/Charts.jsx';
import PostPreviewModal from '../components/PostPreviewModal.jsx';

// Top-post thumbnail — renders the post's real image, falling back to the
// platform badge / play glyph when there's no thumbnail or it fails to load.
function PostThumb({ post, platformKey }) {
  const [err, setErr] = useState(false);
  const col = platformColor(platformKey);
  const box = { width: 56, height: 40, borderRadius: 12, background: `color-mix(in srgb, ${col} 12%, transparent)`, flexShrink: 0, position: "relative", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" };
  if (!post.thumbnail || err) {
    return (
      <div style={box}>
        {platformKey === "youtube"
          ? <svg width="20" height="20" viewBox="0 0 24 24" fill={col}><polygon points="9,7 18,12 9,17" /></svg>
          : <PlatformBadge platform={platformKey} size="md" />}
      </div>
    );
  }
  return (
    <div style={box}>
      <img src={post.thumbnail} alt="" loading="lazy" onError={() => setErr(true)}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      {platformKey === "youtube" && (
        <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill={C.onAccent} style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,.65))" }}><polygon points="9,7 18,12 9,17" /></svg>
        </span>
      )}
    </div>
  );
}

// Tab icon for the platform underline tabs (UnderlineTabs passes lucide props; ignore them).
const platformTabIcon = (key) => () => <PlatformBadge platform={key} size="sm" />;

// Inline stat in the top-post row header (views / eng / clicks / score).
const MiniStat = ({ label, value, color }) => (
  <div style={{ textAlign: "center", minWidth: 44 }}>
    <div style={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: color || C.text }}>{value}</div>
    <div style={{ ...T.label, fontSize: 11.5, color: C.textMuted, marginTop: 1 }}>{label}</div>
  </div>
);

const emptyBox = { padding: '40px 20px', textAlign: 'center' };
const NoData = ({ body, style }) => (
  <Card style={{ ...emptyBox, ...style }}>
    <div style={{ display: "flex", justifyContent: "center", marginBottom: 8, color: C.textMuted }}><InboxIcon size={28} strokeWidth={1.6} /></div>
    <div style={{ ...T.h3, color: C.textSecondary, marginBottom: 4 }}>No data synced yet</div>
    <div style={{ ...T.small, color: C.textMuted }}>{body}</div>
  </Card>
);

// Social → Overview, kept minimal on purpose (2026-10-16): for one platform /
// account at a time, the four numbers that say how it is going — followers
// (with growth), reach, engagement rate, posts — one followers chart that
// follows the period, and the top five posts. Everything else (impressions,
// clicks, platform-specific extras, audience, daily performance, YouTube video
// health) was removed from this page; the same data is reachable over MCP for
// a custom dashboard.
const TOP_POSTS = 5;

export default function OverviewPage({ period, setPeriod }) {
  const { data: overview, loading: ovLoading } = useOverview(period);
  const [activeTab, setActiveTab] = useState("instagram");
  const [account, setAccount] = useState(null);   // null = use primary (default); else a specific accountId
  // "My accounts" preset (top bar): open on the first preset platform, show only preset tabs/accounts.
  const scope = useScope();
  useEffect(() => {
    if (scope.loaded && scope.active && !scope.hasPlatform(activeTab)) { setActiveTab(scope.firstPlatform(PLATFORM_ORDER) || "instagram"); setAccount(null); }
  }, [scope.loaded, scope.tokens.join(",")]);
  const [previewPost, setPreviewPost] = useState(null);   // { platform, post } → in-app post viewer

  const days = overview?.periodInfo?.days || 30;
  const { data: platformData, loading: plLoading } = usePlatformStats(activeTab, period, account || undefined);
  // The chart follows the page's period — one control, not a second one.
  const { data: followersTrend, loading: ftLoading } = useFollowersTrend(activeTab, account || undefined, "days", Math.min(90, Math.max(7, days)));
  // Primary Instagram account outside "My accounts" → open on the first preset account instead.
  useEffect(() => {
    if (activeTab !== "instagram" || account || !platformData?.accounts) return;
    const shown = platformData.accounts.filter(x => scope.hasIg(x.accountId));
    if (shown.length && !shown.some(x => x.accountId === platformData.primaryAccount)) setAccount(shown[0].accountId);
  }, [platformData, activeTab, account, scope.tokens.join(",")]);

  if (ovLoading || !overview) {
    return <div style={{ padding: 40, textAlign: 'center', color: C.textMuted, fontSize: 14 }}>Loading overview…</div>;
  }

  const info = overview.periodInfo;
  const platform = PLATFORMS[activeTab];
  const shownAccounts = (platformData?.accounts || []).filter(a => activeTab !== "instagram" || scope.hasIg(a.accountId));
  const selectedAccount = account || platformData?.primaryAccount;
  const accountLabel = platformData?.accounts?.find(a => a.accountId === selectedAccount)?.accountLabel || null;
  // Threads reports no reach — views is the closest thing it does report.
  const reachCard = platformData?.reach != null
    ? { label: "Reach", value: platformData.reach, delta: platformData.reachDelta, info: "Unique people who saw your content." }
    : { label: "Views", value: platformData?.impressions, delta: platformData?.impressionsDelta, info: "Views across your content in the period." };

  return (
    <div>
      <PageHeader
        cycle={`${new Date().toLocaleDateString("en-IN", { month: "long", year: "numeric" })} · ${info.label}`}
        title="Overview"
        right={<div style={{ display: "flex", alignItems: "center", gap: 10 }}>{overview.estimated && <DataQualityBadge kind="estimated" />}<LiveBadge ts={overview.lastSyncAt} /><PeriodPills value={period} onChange={setPeriod} /></div>}
      />

      {overview.synced === false ? (
        <NoData body="Sync your platforms from the Integrations page to see analytics." style={{ marginBottom: 24 }} />
      ) : (<>
        <UnderlineTabs
          style={{ marginBottom: 18 }}
          tabs={(PLATFORM_ORDER.some(k => scope.hasPlatform(k)) ? PLATFORM_ORDER.filter(k => scope.hasPlatform(k)) : PLATFORM_ORDER).map(key => ({ id: key, label: PLATFORMS[key].name, Icon: platformTabIcon(key) }))}
          value={activeTab}
          onChange={(key) => { setActiveTab(key); setAccount(null); }}
        />

        {shownAccounts.length > 1 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
            {shownAccounts.map(a => {
              const on = selectedAccount === a.accountId;
              const isPrimary = a.accountId === platformData.primaryAccount;
              return (
                <button key={a.accountId} onClick={() => setAccount(a.accountId)} title={isPrimary ? "Primary account" : undefined}
                  style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, fontFamily: FONT, fontWeight: on ? 700 : 600, padding: "6px 14px", borderRadius: 999, cursor: "pointer", border: "none", background: on ? C.primary : C.surface, color: on ? C.onAccent : C.textSecondary, transition: "background .12s, color .12s" }}>
                  {isPrimary && <Star size={12} fill="currentColor" strokeWidth={0} style={{ opacity: on ? 1 : 0.7 }} />}
                  {a.accountLabel}
                </button>
              );
            })}
          </div>
        )}

        {plLoading || !platformData ? (
          <div style={{ padding: 40, textAlign: 'center', color: C.textMuted, fontSize: 14 }}>Loading {platform.name}…</div>
        ) : platformData.synced === false ? (
          <NoData body={`Go to Integrations and click Re-sync to fetch data from ${platform.name}.`} />
        ) : (<>
          <div data-testid="overview-kpis" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginBottom: 16 }}>
            <StatCard label={activeTab === "youtube" ? "Subscribers" : "Followers"} value={platformData.followers} delta={platformData.growthPct} deltaLabel={`+${platformData.scaledGrowth} in ${info.days}d`} positive info="People following or subscribed to this account." />
            <StatCard label={reachCard.label} value={reachCard.value} delta={reachCard.delta} deltaLabel={`vs prev. ${info.days}d`} positive={(reachCard.delta ?? 0) >= 0} info={reachCard.info} />
            <StatCard label="Engagement rate" value={platformData.engagementRate} suffix="%" delta={platformData.engagementDelta} deltaLabel="pp vs prev." positive={platformData.engagementDelta >= 0} info="Share of viewers who liked, commented, shared or clicked." />
            <StatCard label="Posts" value={platformData.posts} delta={platformData.postsDelta} deltaLabel={`vs prev. ${info.days}d`} positive={platformData.postsDelta >= 0} info="Posts, videos or reels published in the period." />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 16 }}>
            <Card>
              <SectionHead right={<span style={{ fontSize: 12.5, color: C.textMuted, fontWeight: 500 }}>{info.label}</span>}>{activeTab === "youtube" ? "Subscribers" : "Followers"}</SectionHead>
              {ftLoading && !followersTrend ? (
                <div style={{ height: 300, display: "flex", alignItems: "center", justifyContent: "center", color: C.textMuted, fontSize: 14 }}>Loading…</div>
              ) : followersTrend?.points?.length ? (
                <LineChart
                  data={{ [activeTab]: followersTrend.points.map(p => p.value) }}
                  days={followersTrend.points.map(p => p.label)}
                  meta={followersTrend.points.map(p => ({ delta: p.delta, estimated: p.estimated, carried: p.carried }))}
                  unit={activeTab === "youtube" ? "subscribers" : "followers"}
                  height={300}
                />
              ) : (
                <div style={{ height: 240, display: "flex", alignItems: "center", justifyContent: "center", color: C.textMuted, fontSize: 14, textAlign: "center", padding: "0 20px" }}>
                  No follower history for this period yet — it builds up as {platform.name} syncs.
                </div>
              )}
            </Card>

            <Card>
              <SectionHead right={<span style={{ fontSize: 12.5, color: C.textMuted, fontWeight: 500 }}>{info.label}</span>}>{activeTab === "youtube" ? "Top videos" : "Top posts"}</SectionHead>
              {platformData.topPosts.length === 0 ? (
                <div style={{ height: 240, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: C.textMuted, textAlign: "center", padding: "0 20px" }}>
                  No posts on {platform.name} in this period. Try a longer one.
                </div>
              ) : (
                <div data-testid="top-posts" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {platformData.topPosts.slice(0, TOP_POSTS).map((post, i) => (
                    <button key={post.id} className="rc" onClick={() => setPreviewPost({ platform: activeTab, post: { ...post, accountLabel } })}
                      title="Open this post"
                      style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 8px", borderRadius: 12, cursor: "pointer", border: "none", background: "transparent", textAlign: "left", fontFamily: FONT, width: "100%" }}>
                      <span style={{ width: 18, fontSize: 13, fontWeight: 700, color: C.textMuted, textAlign: "center", flexShrink: 0 }}>{i + 1}</span>
                      <PostThumb post={post} platformKey={activeTab} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 14, fontWeight: 650, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{post.title}</span>
                        <span style={{ display: "block", fontSize: 12.5, color: C.textMuted, fontWeight: 500, marginTop: 2 }}>{post.date}</span>
                      </span>
                      <MiniStat label="Views" value={fmtNum(post.views)} />
                      <MiniStat label="Eng." value={fmtNum(post.eng)} />
                    </button>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </>)}
      </>)}

      {previewPost && (
        <PostPreviewModal platform={previewPost.platform} post={previewPost.post} onClose={() => setPreviewPost(null)} />
      )}
    </div>
  );
}
