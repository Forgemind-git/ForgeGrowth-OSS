import { useApi } from "../hooks/useApi.js";
import { api } from "../api.js";
import { C, T, FONT, MONO } from "../constants.js";
import { PLATFORMS, fmtCompact, platformColor } from "../data/mockData.js";

// Read-only, link-shareable report — no login required.
// Outer frame follows the floating shell: a black header band and a content card, both
// radius 24, floating on the page ground with the 16px gutter around them.
export default function PublicReportPage({ token }) {
  const { data, loading, error } = useApi(() => api.getPublicReport(token), [token]);

  const wrap = { minHeight: "calc(100vh / var(--fg-zoom, 1))", background: C.pageBg, fontFamily: FONT, padding: 16, boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 16 };
  const band = { background: C.headerBg, height: 64, borderRadius: 24, padding: "0 20px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 };
  const pane = { background: C.card, borderRadius: 24, padding: "28px 24px 40px", flex: 1 };

  if (loading) return <div style={wrap}><div style={band}><Logo /></div><div style={pane}><div style={{ padding: 60, textAlign: "center", color: C.textMuted, ...T.body }}>Loading report…</div></div></div>;
  if (error || !data) return <div style={wrap}><div style={band}><Logo /></div><div style={pane}><div style={{ padding: 60, textAlign: "center", color: C.errText, ...T.body }}>{error || "This report link is invalid or has been revoked."}</div></div></div>;

  const platforms = (data.platforms || []).filter(p => p.connected);

  return (
    <div style={wrap}>
      <div style={band}><Logo /></div>
      <div style={pane}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <div style={{ marginBottom: 22 }}>
            <div style={{ ...T.label, color: C.textMuted, fontFamily: MONO }}>Social Media Performance Report</div>
            <h1 style={{ ...T.h2, color: C.text, margin: "6px 0 0" }}>{data.range?.from} → {data.range?.to}</h1>
            <div style={{ ...T.small, color: C.textMuted, marginTop: 6 }}>Read-only shared report · generated {new Date(data.generatedAt).toLocaleDateString()}</div>
          </div>

          {platforms.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: C.textMuted, ...T.body }}>No data for this range.</div>
          ) : platforms.map(p => (
            <div key={p.platform} style={{ background: C.raised, borderRadius: 16, padding: 18, marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                <div style={{ width: 30, height: 30, borderRadius: 12, background: platformColor(p.platform), color: C.onAccent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11.5, fontWeight: 700 }}>{PLATFORMS[p.platform]?.short}</div>
                <div style={{ ...T.h3, color: C.text }}>{p.name}</div>
                <div style={{ ...T.small, color: C.textMuted }}>{p.account}</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
                <Kpi label={p.audience?.label || "Followers"} value={p.audience ? fmtCompact(p.audience.end) : "—"} delta={p.audience?.pct} />
                <Kpi label="Posts" value={p.content?.postsInRange ?? "—"} />
                <Kpi label="Engagement" value={p.content?.totalEngagements != null ? fmtCompact(p.content.totalEngagements) : "—"} />
                <Kpi label="Eng. rate" value={p.content?.engagementRate != null ? `${p.content.engagementRate}%` : "—"} />
              </div>
              {p.content?.topPosts?.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ ...T.label, color: C.textMuted, fontFamily: MONO, marginBottom: 6 }}>Top posts</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {p.content.topPosts.slice(0, 3).map((post, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "9px 12px", borderRadius: 12, background: C.surface }}>
                        <span style={{ ...T.small, color: C.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{post.caption || post.title || "Untitled"}</span>
                        <span style={{ fontSize: 12.5, fontFamily: MONO, color: C.textMuted, whiteSpace: "nowrap" }}>{fmtCompact(post.engagements || 0)} eng</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
          <div style={{ textAlign: "center", ...T.small, fontSize: 12.5, color: C.textMuted, marginTop: 24 }}>Forge Growth</div>
        </div>
      </div>
    </div>
  );
}

function Logo() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 780, textTransform: "uppercase", color: C.headerText, fontFamily: FONT, letterSpacing: ".02em" }}>
      FORGE<span style={{ background: C.primary, color: C.onAccent, padding: "2px 8px", borderRadius: 999 }}>SOCIAL</span>
    </span>
  );
}
function Kpi({ label, value, delta }) {
  return (
    <div style={{ background: C.surface, borderRadius: 12, padding: "12px 14px" }}>
      <div style={{ ...T.label, color: C.textMuted }}>{label}</div>
      <div style={{ ...T.metricSm, color: C.text, marginTop: 6 }}>{value}</div>
      {delta != null && <div style={{ fontSize: 12.5, fontWeight: 650, marginTop: 4, color: delta >= 0 ? C.green : C.errText }}>{delta >= 0 ? "+" : ""}{delta}%</div>}
    </div>
  );
}
