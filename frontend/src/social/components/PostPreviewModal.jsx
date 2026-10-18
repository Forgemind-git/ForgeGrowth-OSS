import { useEffect, useState } from "react";
import { X, ExternalLink, PlayCircle } from "lucide-react";
import { C, FONT, T, BTN } from "../constants.js";
import { PLATFORMS, fmtCompact } from "../data/mockData.js";
import { PlatformPill, PillTabs } from "./UI.jsx";
import { LineChart } from "./Charts.jsx";
import { api } from "../api.js";

// In-app post viewer — opens the ACTUAL post from the platform in a modal via
// each platform's embed endpoint, so content can be reviewed without leaving
// ForgeGrowth. Falls back to the stored thumbnail + caption when a platform
// has no embeddable URL (private post, missing permalink).
//
// post: { id (external id), permalink, title, caption, thumbnail, date,
//         views, eng, likes, comments, score }
function embedUrl(platform, post) {
  const link = post.permalink || "";
  try {
    if (platform === "youtube" && post.id) {
      return { url: `https://www.youtube.com/embed/${post.id}`, ratio: "16x9" };
    }
    if (platform === "instagram") {
      // Canonical embed URL — extract the shortcode and rebuild as
      // `/p|reel|tv/{code}/embed/captioned/`. Requesting `/embed` without the
      // trailing slash makes instagram.com 301 to `/embed/`, which (combined
      // with its login/session redirects) loops → ERR_TOO_MANY_REDIRECTS.
      const m = link.match(/instagram\.com\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
      if (m) return { url: `https://www.instagram.com/${m[1]}/${m[2]}/embed/captioned/`, ratio: "tall" };
    }
    if (platform === "facebook" && link) {
      return { url: `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(link)}&width=500&show_text=true`, ratio: "tall" };
    }
    if (platform === "threads") {
      // Same trailing-slash requirement as Instagram (shared infra).
      const m = link.match(/threads\.(?:net|com)\/(@[^/]+\/post\/[A-Za-z0-9_-]+|t\/[A-Za-z0-9_-]+)/);
      if (m) return { url: `https://www.threads.net/${m[1]}/embed/`, ratio: "tall" };
    }
    if (platform === "linkedin" && post.id && /^urn:li:/.test(String(post.id))) {
      return { url: `https://www.linkedin.com/embed/feed/update/${post.id}`, ratio: "tall" };
    }
  } catch (_) { /* malformed permalink → fallback card */ }
  return null;
}

// For Instagram, route the open-link through the REGULAR sign-in page with
// `next` pointing back at the post: a logged-out (or broken) browser session
// gets Instagram's normal login screen — where any account can be chosen —
// and an already-valid session just redirects straight to the post.
function openOnPlatformUrl(platform, post) {
  const link = post.permalink || "";
  if (platform === "instagram") {
    try {
      const u = new URL(link);
      if (/instagram\.com$/.test(u.hostname.replace(/^www\./, "")) && u.pathname.length > 1) {
        return `https://www.instagram.com/accounts/login/?next=${encodeURIComponent(u.pathname)}`;
      }
    } catch (_) { /* malformed permalink → use it as-is */ }
  }
  return link || null;
}

// Instagram & Threads embeds are served from instagram.com/threads.net behind
// login/session redirects. The classic failure is ERR_TOO_MANY_REDIRECTS — but
// it's triggered by the VIEWER's own instagram.com session cookies, not the
// embed URL (the canonical /embed/captioned/ URL is already correct). We dodge
// it by loading these embeds CREDENTIAL-LESS (no cookies sent → instagram.com
// just serves the public post), so they can auto-load like YouTube. A load
// timeout still falls back to our stored snapshot if the frame never renders.
const COOKIELESS_EMBED = new Set(["instagram", "threads"]);

// Platforms that are NOT auto-loaded (live embed is opt-in via a button). With
// the credential-less fix above, Instagram now auto-loads like YouTube/Facebook;
// nothing is opt-in by default, but the set is kept so a platform can be parked
// here if its embed ever proves unreliable again.
const NO_AUTOLOAD = new Set();

// If the live embed hasn't rendered within this window we assume it failed
// (a redirect loop never fires `onLoad`) and fall back to the snapshot card.
const EMBED_LOAD_TIMEOUT_MS = 8000;


// ── Daily performance history ────────────────────────────────
// Reads the per-post metric log (one row per post per IST day, written by the
// daily logger). We plot what the post GAINED each day rather than its lifetime
// total, because that is the question people actually ask of a reel: is it still
// picking up views, or did it stop? History necessarily starts the day the
// logger first saw this post — never before — and we say so instead of drawing
// a line back to publication that we cannot substantiate.
const HISTORY_METRICS = [
  { key: "gainedViews", label: "Views", unit: "views/day" },
  { key: "gainedEngagements", label: "Engagement", unit: "engagements/day" },
  { key: "gainedLikes", label: "Likes", unit: "likes/day" },
  { key: "gainedComments", label: "Comments", unit: "comments/day" },
];

function PostHistory({ platform, postId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [metric, setMetric] = useState("gainedViews");

  useEffect(() => {
    let alive = true;
    setData(null); setErr(null);
    api.getPostMetricsTrend(postId, platform, 90)
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, [platform, postId]);

  if (err || !data) return null;

  // The first logged day has no previous day to diff against, so it carries no
  // gain — we need at least two logged days before there is anything to plot.
  const pts = data.points.filter(p => p[metric] !== null && p[metric] !== undefined);
  const started = data.loggingStartedAt
    ? new Date(data.loggingStartedAt + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" })
    : null;

  return (
    <div style={{ background: C.raised, borderRadius: 16, padding: "14px 16px", flexShrink: 0, marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ ...T.label, color: C.textSecondary }}>Daily performance</span>
        <span style={{ flex: 1 }} />
        <PillTabs tabs={HISTORY_METRICS.map(m => ({ id: m.key, label: m.label }))} value={metric} onChange={setMetric} size="sm" />
      </div>
      {pts.length >= 2 ? (
        <>
          <LineChart
            data={{ [platform]: pts.map(p => p[metric]) }}
            days={pts.map(p => p.label)}
            unit={HISTORY_METRICS.find(m => m.key === metric)?.unit || "per day"}
            height={150}
          />
          <div style={{ fontSize: 12.5, color: C.textMuted, fontWeight: 500, marginTop: 6 }}>
            Gained per day, measured from this post's own daily metric log{started ? ` (tracking since ${started})` : ""}.
          </div>
        </>
      ) : (
        <div style={{ fontSize: 13, color: C.textMuted, fontWeight: 500, padding: "4px 0" }}>
          {started
            ? `Daily tracking for this post started on ${started}. The first day-over-day numbers appear after the next daily log.`
            : "Daily tracking for this post hasn't started yet — it begins with the next daily log."}
        </div>
      )}
    </div>
  );
}

export default function PostPreviewModal({ platform, post, onClose }) {
  const meta = PLATFORMS[platform] || {};
  const embed = embedUrl(platform, post);
  const openUrl = openOnPlatformUrl(platform, post);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // Auto-load the live embed unless the platform is parked in NO_AUTOLOAD.
  const [showLive, setShowLive] = useState(!NO_AUTOLOAD.has(platform));

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const showEmbed = embed && showLive && !loadFailed;

  // Watchdog: a cross-origin redirect loop never fires the iframe's onLoad
  // event, so we can't detect it directly. Instead, if the frame hasn't
  // reported loaded within EMBED_LOAD_TIMEOUT_MS we treat it as failed and
  // drop back to the snapshot card (which always renders).
  useEffect(() => {
    if (!showEmbed || frameLoaded) return;
    const t = setTimeout(() => setLoadFailed(true), EMBED_LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [showEmbed, frameLoaded]);
  const isWide = embed?.ratio === "16x9";
  const stats = [
    ["Views", post.views], ["Engagements", post.eng],
    ["Likes", post.likes], ["Comments", post.comments], ["Score", post.score],
  ].filter(([, v]) => v != null && v !== 0 || v === 0);

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.42)", backdropFilter: "blur(4px)", zIndex: 300 }} />
      {/* Centred by a flex box, not a translate — the pop-in animation ends on
          `transform: none`, which would undo a translate-based centring. */}
      <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 301, pointerEvents: "none" }}>
      <div style={{
        width: isWide ? "min(860px, calc(92vw / var(--fg-zoom, 1)))" : "min(560px, calc(92vw / var(--fg-zoom, 1)))",
        maxHeight: "calc(90vh / var(--fg-zoom, 1))", display: "flex", flexDirection: "column", pointerEvents: "auto",
        background: C.card, borderRadius: 24, boxShadow: C.shadowLg,
        fontFamily: FONT, padding: 24, boxSizing: "border-box",
        animation: "fc-pop-in .2s ease-out both",
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexShrink: 0, minWidth: 0 }}>
          <PlatformPill platform={platform} />
          {/* Owning connected account — so it's always clear WHICH account's post
              this is. Instagram offers no way for an external app to choose the
              signed-in account on instagram.com, so this chip is the cue for
              which account to switch to there if you want to act on the post. */}
          {(post.accountUsername || post.accountLabel) && (
            <span title={`This post belongs to your connected account ${post.accountUsername ? "@" + post.accountUsername : post.accountLabel}`}
              style={{ fontSize: 12, fontWeight: 650, color: C.textSecondary, background: C.surface, padding: "3px 10px", borderRadius: 999, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 150, minWidth: 0, flexShrink: 1 }}>
              via {post.accountUsername ? "@" + post.accountUsername : post.accountLabel}
            </span>
          )}
          {post.date && <span style={{ fontSize: 12.5, color: C.textMuted, fontWeight: 500, whiteSpace: "nowrap" }}>{post.date}</span>}
          <span style={{ flex: 1 }} />
          {openUrl && (
            <a href={openUrl} target="_blank" rel="noopener noreferrer"
              title={platform === "instagram"
                ? "Opens via Instagram's regular sign-in: if your browser isn't logged in you get the normal login screen (pick any account), then it lands on this post. An existing session goes straight to the post — switch accounts from Instagram's profile menu if it's the wrong one."
                : `Opens ${meta.name || platform} in a new tab using your browser's current ${meta.name || platform} session. Replying/deleting from ForgeGrowth's Inbox always acts as the owning account.`}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 650, color: C.primary, textDecoration: "none", whiteSpace: "nowrap" }}>
              <ExternalLink size={14} strokeWidth={2.4} /> Open on {meta.name || platform}
            </a>
          )}
          <button onClick={onClose} aria-label="Close" style={{ ...BTN.icon, width: 32, height: 32, marginLeft: 4 }}>
            <X size={16} strokeWidth={2.4} />
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          {/* Body — the stored snapshot is always reliable; the LIVE platform
              embed is auto-loaded for stable platforms and opt-in for fragile
              ones (IG/Threads), so an embed redirect-loop can never appear here
              unsolicited. */}
          <div style={{ flexShrink: 0, background: C.surface, borderRadius: 16, overflow: "hidden" }}>
            {showEmbed ? (
              <div style={{ position: "relative" }}>
                {!frameLoaded && (
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: C.textMuted }}>
                    Loading post…
                  </div>
                )}
                <iframe
                  ref={(el) => {
                    // `credentialless` loads the embed in a fresh, cookie-less
                    // context so the viewer's instagram.com/threads.net session
                    // can't trigger the login redirect loop. Set via ref because
                    // React doesn't reliably pass the boolean attribute through.
                    if (el && COOKIELESS_EMBED.has(platform)) el.setAttribute("credentialless", "");
                  }}
                  src={embed.url}
                  title="Post preview"
                  onLoad={() => setFrameLoaded(true)}
                  referrerPolicy="no-referrer"
                  allow="autoplay; encrypted-media; picture-in-picture"
                  allowFullScreen
                  style={{
                    display: "block", width: "100%", border: "none",
                    height: isWide ? "min(460px, calc(52vw / var(--fg-zoom, 1)))" : "min(600px, calc(62vh / var(--fg-zoom, 1)))",
                    opacity: frameLoaded ? 1 : 0, transition: "opacity .2s",
                  }}
                />
              </div>
            ) : (
              <div style={{ padding: 18 }}>
                {post.thumbnail && (
                  <img src={post.thumbnail} alt="" style={{ width: "100%", borderRadius: 12, display: "block", marginBottom: 12 }} />
                )}
                <div style={{ fontSize: 14, color: C.textSecondary, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                  {post.caption || post.title || "No preview available for this post."}
                </div>
                {/* Honest note when the live embed couldn't render (timed out /
                    redirect loop) — we fell back to the stored snapshot. */}
                {loadFailed && (
                  <div style={{ marginTop: 12, fontSize: 12.5, color: C.textMuted, fontWeight: 500 }}>
                    The live {meta.name || platform} preview didn't load — showing the saved snapshot. Use "Open on {meta.name || platform}" above to view it on {meta.name || platform}.
                  </div>
                )}
                {/* Live embed retry — appears when auto-load failed or a platform
                    is parked in NO_AUTOLOAD. "Open on {platform}" above is always
                    the bulletproof path. */}
                {embed && (!showLive || loadFailed) && (
                  <button
                    onClick={() => { setFrameLoaded(false); setLoadFailed(false); setShowLive(true); }}
                    title={`Loads the interactive ${meta.name || platform} post inside this window. If it doesn't appear, use "Open on ${meta.name || platform}" above.`}
                    style={{ ...BTN.secondary, marginTop: 14 }}>
                    <PlayCircle size={15} strokeWidth={2.4} color={C.primary} />
                    {loadFailed ? "Retry live post" : "Load live post"}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Per-day history — what this post actually gained each day */}
          {post.id && <PostHistory platform={platform} postId={post.id} />}

          {/* Metrics — small KPI tiles */}
          {stats.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))`, gap: 8, marginTop: 12, flexShrink: 0 }}>
              {stats.map(([label, v]) => (
                <div key={label} style={{ background: C.raised, borderRadius: 16, padding: "12px 14px", minWidth: 0 }}>
                  <div style={{ ...T.label, color: C.textSecondary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
                  <div style={{ ...T.metricSm, color: C.text, marginTop: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{fmtCompact(v)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      </div>
    </>
  );
}
