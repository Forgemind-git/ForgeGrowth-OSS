import { useState, useEffect } from "react";
import { Inbox, SearchX, Eye, Heart, Play, LayoutGrid, List, ExternalLink, Info } from "lucide-react";
import { useContentLibrary } from '../hooks/useContentLibrary.js';
import { PLATFORMS, PLATFORM_ORDER, SCORE_TIERS, DATE_FILTER_MAP } from '../data/mockData.js';
import { fmtCompact, fmtNum } from '../data/mockData.js';
import { C, FONT, T, BTN } from '../constants.js';
import { PlatformBadge, PageHeader, SearchBar, EmptyState, Tooltip } from '../components/UI.jsx';
import { SearchableSelect, MultiSelect } from '../components/Dropdown.jsx';
import PostPreviewModal from '../components/PostPreviewModal.jsx';
import { useScope } from '../components/scope/scopeStore.js';
import DefaultViewButton from '../components/scope/DefaultViewButton.jsx';

// Content Library: every synced post across platforms, as a visual grid (default)
// or a compact list. Click a post to open it in the in-app viewer (embed + daily
// performance). Filters: search, platform, accounts, format, topic, date; sort.

const DATE_FILTER_OPTIONS = Object.keys(DATE_FILTER_MAP);
const SORTS = [
  { value: "date", label: "Newest" },
  { value: "score", label: "Content score" },
  { value: "views", label: "Views" },
  { value: "eng", label: "Engagements" },
  { value: "saves", label: "Saves" },
];
const SCORE_INFO = "Content score (1–99): how this post ranks against your other posts on the same platform, on engagement rate, views and strong interactions. 90 = better than ~90% of them.";

const scoreTier = (score) => {
  if (score >= SCORE_TIERS.excellent) return { color: C.green, bg: C.greenSoft, label: "Top-performing" };
  if (score >= SCORE_TIERS.good)      return { color: C.amber, bg: C.amberSoft, label: "Above average" };
  return { color: C.textSecondary, bg: C.surface2, label: score >= SCORE_TIERS.average ? "Average" : "Needs work" };
};
const engRate = (c) => c.views > 0 ? (c.eng * 100 / c.views) : null;
const isVideo = (t) => /reel|video|short/i.test(t || "");
const caption = (c) => (c.caption || c.title || "").replace(/\s+/g, " ").trim() || "No caption";

function readView() { try { return localStorage.getItem("fs.library.view") || "grid"; } catch (_) { return "grid"; } }
function saveView(v) { try { localStorage.setItem("fs.library.view", v); } catch (_) {} }

export default function ContentLibraryPage() {
  const [view, setView] = useState(readView);
  const [search, setSearch] = useState("");
  const [platformFilter, setPlatformFilter] = useState(null);
  const [accountFilter, setAccountFilter] = useState([]);
  // Start from the "My accounts" preset (top bar) — same token format as this filter.
  const scope = useScope();
  useEffect(() => { if (scope.loaded) setAccountFilter(scope.tokens); }, [scope.loaded, scope.tokens.join(",")]);
  const [topicFilter, setTopicFilter] = useState(null);
  const [formatFilter, setFormatFilter] = useState(null);
  const [dateFilter, setDateFilter] = useState("Last 90 days");
  const [sortBy, setSortBy] = useState("date");
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState(null);
  const limit = view === "grid" ? 24 : 25;

  const { data, loading } = useContentLibrary({
    platform: platformFilter, topic: topicFilter, format: formatFilter, dateFilter,
    account: accountFilter.join(","), sortBy, search, page, limit,
  });
  useEffect(() => { setPage(1); }, [platformFilter, topicFilter, formatFilter, dateFilter, accountFilter, sortBy, search, view]);

  const posts = data?.posts || [];
  const total = data?.total || 0;
  const totalPages = data?.totalPages || 1;
  const stats = data?.stats;
  const platformKey = PLATFORM_ORDER.find(k => PLATFORMS[k].name === platformFilter);
  const accountOptions = (data?.accounts || [])
    .filter(a => !platformKey || a.platform === platformKey)
    .map(a => ({ value: a.value, label: a.label, group: a.platformName }));

  const active = [platformFilter, topicFilter, formatFilter, search].filter(Boolean).length + (accountFilter.join(",") !== scope.tokens.join(",") ? 1 : 0) + (dateFilter !== "Last 90 days" ? 1 : 0);
  const clearAll = () => { setSearch(""); setPlatformFilter(null); setAccountFilter(scope.tokens); setTopicFilter(null); setFormatFilter(null); setDateFilter("Last 90 days"); };
  const setV = (v) => { setView(v); saveView(v); };
  const open = (c) => setPreview({ platform: c.platform, post: { ...c, id: c.externalId } });


  return (
    <div style={{ fontFamily: FONT }}>
      <PageHeader title="Content Library" sub={loading && !data ? "Loading…" : `${fmtNum(total)} posts${dateFilter ? ` · ${dateFilter.toLowerCase()}` : " · all time"}`}
        right={<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <SearchableSelect label="Sort" value={sortBy} options={SORTS} onChange={(v) => setSortBy(v || "date")} />
          <ViewToggle view={view} onChange={setV} />
        </div>} />

      {/* toolbar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <SearchBar value={search} onChange={setSearch} placeholder="Search captions…" />
        <SearchableSelect label="Platform" value={platformFilter} options={PLATFORM_ORDER.map(p => PLATFORMS[p].name)}
          onChange={(v) => { setPlatformFilter(v); setAccountFilter([]); }} allLabel="All" />
        <MultiSelect label="Accounts" values={accountFilter} options={accountOptions} onChange={setAccountFilter} placeholder="All" />
        <DefaultViewButton tokens={accountFilter} />
        <SearchableSelect label="Format" value={formatFilter} options={data?.formats || []} onChange={setFormatFilter} allLabel="All" />
        <SearchableSelect label="Topic" value={topicFilter} options={data?.topics || []} onChange={setTopicFilter} allLabel="All" />
        <SearchableSelect label="Date" value={dateFilter} options={DATE_FILTER_OPTIONS} onChange={setDateFilter} allLabel="All time" />
        {active > 0 && <button onClick={clearAll} style={{ ...BTN.ghost, padding: "8px 10px", fontSize: 13 }}>Clear filters</button>}
      </div>

      {/* totals for the filtered set */}
      {stats && total > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(150px, 100%), 1fr))", gap: 10, marginBottom: 14 }}>
          <Stat label="Posts" value={fmtNum(total)} />
          <Stat label="Views" value={fmtCompact(stats.views)} />
          <Stat label="Engagements" value={fmtCompact(stats.eng)} />
          <Stat label="Avg. engagement rate" value={stats.avgEngRate != null ? `${stats.avgEngRate}%` : "—"} />
          <Stat label="Avg. content score" value={stats.avgScore ?? "—"} info={SCORE_INFO} />
        </div>
      )}

      {loading && !data ? (
        <GridSkeleton />
      ) : total === 0 ? (
        <div style={{ background: C.raised, borderRadius: 16 }}>
          {active > 0
            ? <EmptyState Icon={SearchX} title="No posts match these filters" body="Try a wider date range or clear the filters." action={<button onClick={clearAll} style={BTN.secondary}>Clear filters</button>} />
            : <EmptyState Icon={Inbox} title="No posts yet" body="Posts appear here after your platforms sync." />}
        </div>
      ) : view === "grid" ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 14, opacity: loading ? .6 : 1, transition: "opacity .15s" }}>
          {posts.map(c => <PostCard key={c.id} c={c} onOpen={() => open(c)} />)}
        </div>
      ) : (
        <PostList posts={posts} onOpen={open} loading={loading} />
      )}

      {totalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 10, marginTop: 18 }}>
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} style={BTN.secondary}>Previous</button>
          <span style={{ fontSize: 13, color: C.textMuted, fontVariantNumeric: "tabular-nums" }}>Page {page} of {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} style={BTN.secondary}>Next</button>
        </div>
      )}

      {preview && <PostPreviewModal platform={preview.platform} post={preview.post} onClose={() => setPreview(null)} />}
    </div>
  );
}

function ViewToggle({ view, onChange }) {
  const b = (v, Icon, label) => (
    <button onClick={() => onChange(v)} aria-label={label} title={label} aria-pressed={view === v}
      style={{ ...BTN.icon, width: 34, height: 34, background: view === v ? C.primarySoft : "transparent", color: view === v ? C.primary : C.textSecondary }}>
      <Icon size={16} />
    </button>
  );
  return <div style={{ display: "flex", gap: 2, background: C.surface, padding: 3, borderRadius: 10 }}>{b("grid", LayoutGrid, "Grid view")}{b("list", List, "List view")}</div>;
}

function Stat({ label, value, info }) {
  return (
    <div style={{ background: C.raised, borderRadius: 14, padding: "12px 14px", minWidth: 0 }}>
      <div style={{ fontSize: 12.5, fontWeight: 650, color: C.textMuted, display: "flex", alignItems: "center", gap: 4 }}>{label}{info && <InfoTip text={info} />}</div>
      <div style={{ ...T.metricSm, fontSize: 22, color: C.text, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function InfoTip({ text }) {
  const [tip, setTip] = useState(null);
  return (
    <span style={{ display: "inline-flex", cursor: "help", color: C.textMuted }}
      onMouseEnter={(e) => setTip({ x: e.clientX + 8, y: e.clientY + 14 })} onMouseMove={(e) => setTip({ x: e.clientX + 8, y: e.clientY + 14 })} onMouseLeave={() => setTip(null)}>
      <Info size={13} />
      {tip && <Tooltip x={tip.x} y={tip.y}>{text}</Tooltip>}
    </span>
  );
}

function Thumb({ c, ratio = "4 / 5", radius = 12, size }) {
  const [err, setErr] = useState(false);
  const p = PLATFORMS[c.platform] || {};
  const box = size ? { width: size, height: size } : { width: "100%", aspectRatio: ratio };
  return (
    <div style={{ ...box, borderRadius: radius, overflow: "hidden", background: p.bg || C.surface2, position: "relative", flexShrink: 0 }}>
      {c.thumbnail && !err
        ? <img src={c.thumbnail} alt="" loading="lazy" onError={() => setErr(true)} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: size ? 0 : 16, color: p.textOnBg || C.textSecondary, fontSize: size ? 11 : 13, lineHeight: 1.4, textAlign: "center", overflow: "hidden" }}>
            {size ? (p.short || "") : <span style={{ display: "-webkit-box", WebkitLineClamp: 6, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{caption(c)}</span>}
          </div>}
      {isVideo(c.type) && !size && (
        <span style={{ position: "absolute", top: 8, right: 8, width: 24, height: 24, borderRadius: "50%", background: "rgba(0,0,0,.55)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Play size={12} fill="#fff" />
        </span>
      )}
    </div>
  );
}

function PostCard({ c, onOpen }) {
  const tier = scoreTier(c.score);
  const er = engRate(c);
  return (
    <div className="fs-lib-card" onClick={onOpen} role="button" tabIndex={0} onKeyDown={e => e.key === "Enter" && onOpen()}
      style={{ background: C.raised, borderRadius: 16, padding: 8, cursor: "pointer", display: "flex", flexDirection: "column", gap: 10, position: "relative" }}>
      <div style={{ position: "relative" }}>
        <Thumb c={c} />
        <span style={{ position: "absolute", top: 8, left: 8 }}><PlatformBadge platform={c.platform} size="sm" /></span>
        <span title={`${tier.label} — ${SCORE_INFO}`} style={{ position: "absolute", bottom: 8, left: 8, display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, padding: "3px 8px", borderRadius: 8, background: "rgba(0,0,0,.62)", color: "#fff", fontVariantNumeric: "tabular-nums" }}>
          <i style={{ width: 7, height: 7, borderRadius: "50%", background: tier.color === C.textSecondary ? "#bbb" : tier.color }} />Score {c.score}
        </span>
      </div>
      <div style={{ padding: "0 4px", display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: C.text, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: 38 }}>{caption(c)}</div>
        <div style={{ fontSize: 12, color: C.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {c.accountUsername ? `@${c.accountUsername.replace(/^@/, "")} · ` : ""}{c.type} · {c.date}
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 12.5, color: C.textSecondary, fontVariantNumeric: "tabular-nums", marginTop: 2, paddingBottom: 4 }}>
          <span title="Views" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Eye size={13} /> {fmtCompact(c.views)}</span>
          <span title={`Engagements — ${fmtNum(c.likes || 0)} likes, ${fmtNum(c.comments || 0)} comments, ${fmtNum(c.shares || 0)} shares, ${fmtNum(c.saves || 0)} saves`} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Heart size={13} /> {fmtCompact(c.eng)}</span>
          {er != null && <span title="Engagement rate (engagements ÷ views)" style={{ marginLeft: "auto", fontWeight: 650, color: C.text }}>{er.toFixed(1)}%</span>}
        </div>
      </div>
      <style>{".fs-lib-card{transition:background .14s}.fs-lib-card:hover{background:var(--fc-surface) !important}"}</style>
    </div>
  );
}

function PostList({ posts, onOpen, loading }) {
  const th = { padding: "10px 12px", fontSize: 12, fontWeight: 650, color: C.textMuted, textAlign: "right", whiteSpace: "nowrap" };
  const td = { padding: "10px 12px", fontSize: 13.5, color: C.text, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
  return (
    <div style={{ background: C.raised, borderRadius: 16, overflow: "hidden", opacity: loading ? .6 : 1 }}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
          <thead><tr>
            <th style={{ ...th, textAlign: "left", paddingLeft: 16 }}>Post</th>
            <th style={th}>Views</th><th style={th}>Engagements</th><th style={th}>Eng. rate</th><th style={th}>Score</th><th style={{ ...th, width: 70 }} />
          </tr></thead>
          <tbody>
            {posts.map(c => {
              const tier = scoreTier(c.score);
              const er = engRate(c);
              return (
                <tr key={c.id} className="fs-lib-row" onClick={() => onOpen(c)} style={{ cursor: "pointer", boxShadow: `inset 0 1px 0 ${C.surface2}` }}>
                  <td style={{ padding: "8px 12px 8px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                      <div style={{ position: "relative" }}>
                        <Thumb c={c} size={48} radius={10} />
                        <span style={{ position: "absolute", bottom: -4, right: -4 }}><PlatformBadge platform={c.platform} size="sm" /></span>
                      </div>
                      <div style={{ minWidth: 0, maxWidth: 520 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{caption(c)}</div>
                        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{c.accountUsername ? `@${c.accountUsername.replace(/^@/, "")} · ` : ""}{c.type} · {c.topic} · {c.date}</div>
                      </div>
                    </div>
                  </td>
                  <td style={td}>{fmtCompact(c.views)}</td>
                  <td style={td} title={`${fmtNum(c.likes || 0)} likes · ${fmtNum(c.comments || 0)} comments · ${fmtNum(c.shares || 0)} shares · ${fmtNum(c.saves || 0)} saves`}>{fmtCompact(c.eng)}</td>
                  <td style={td}>{er != null ? `${er.toFixed(1)}%` : "—"}</td>
                  <td style={td}><span title={tier.label} style={{ fontSize: 12.5, fontWeight: 750, padding: "3px 9px", borderRadius: 8, background: tier.bg, color: tier.color }}>{c.score}</span></td>
                  <td style={{ ...td, paddingRight: 12 }}>
                    <span style={{ display: "inline-flex", gap: 4 }}>
                      {c.permalink && <a href={c.permalink} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} aria-label="Open on platform" title="Open on platform" style={{ ...BTN.icon, width: 30, height: 30, background: "transparent" }}><ExternalLink size={14} /></a>}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <style>{".fs-lib-row:hover td{background:var(--fc-surface)}"}</style>
    </div>
  );
}

function GridSkeleton() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 14 }}>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} style={{ background: C.raised, borderRadius: 16, padding: 8 }}>
          <div style={{ width: "100%", aspectRatio: "4 / 5", borderRadius: 12, background: C.surface2 }} />
          <div style={{ height: 12, borderRadius: 6, background: C.surface2, margin: "12px 4px 6px" }} />
          <div style={{ height: 12, width: "60%", borderRadius: 6, background: C.surface2, margin: "0 4px 8px" }} />
        </div>
      ))}
    </div>
  );
}
