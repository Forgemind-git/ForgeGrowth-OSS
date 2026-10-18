import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft, MoreHorizontal, Heart, MessageCircle, Send, Bookmark, Home, Search, PlusSquare, Clapperboard,
  Signal, Wifi, BatteryFull, Phone, Video, Camera, Image as ImageIcon, Smile, PlusCircle, Link2, RotateCcw, Play, Eye, AtSign,
} from "lucide-react";
import { C, FONT, BTN } from "../../constants.js";
import { PillTabs } from "../UI.jsx";
import useFlowSimulator from "../flows/useFlowSimulator.js";
import { PlayerBar, Timeline } from "../flows/SimPlayer.jsx";
import { ruleToGraph } from "./ruleGraph.js";
import { buildDmSteps, hasPostView } from "./shared.jsx";

// A phone-shaped mock of Instagram: the post, the comment thread with our
// public reply, and the DM conversation. In "Test it" mode it becomes a
// simulator — type a comment or DM, tap buttons, answer questions — run by the
// Flow Builder's simulator on the rule converted to steps (ruleGraph.js), with
// the same player (back / play / next / speed / timeline). Nothing is sent.
//
// The screen deliberately mimics Instagram's own dark UI in every app theme,
// so it uses a fixed palette instead of the app's theme tokens.
const IG = {
  frame: "#1d2027", screen: "#000", sheet: "#1c1c1e", text: "#f5f5f5", muted: "#a8a8a8",
  faint: "#6e6e73", bubble: "#262626", button: "#363636", mine: "#3797f0", line: "#2a2a2a",
  brand: "#dc2626", input: "#121212", note: "#2c2c2e",
};

export const PREVIEW_VIEWS = [
  { id: "post", label: "Post" },
  { id: "comments", label: "Comments" },
  { id: "dm", label: "DM" },
];

// Preview + "Test it" simulator around one rule (Graph-format fields).
// `view`/`onView` let the editor steer the screen as the user edits.
// Width the phone column needs to hold "What happened" beside the phone.
const SIDE_W = 220, NEED_W = 330 + 14 + SIDE_W;
export function SimPhone({ rule, account, post, view, onView, previewSteps, timelineSlot = null, onTestingChange }) {
  const [mode, setMode] = useState("preview");
  // Measure our own column: beside the phone when it fits; otherwise into the page's
  // slot (timelineSlot) when the page offers one; stacked under it only as a last resort.
  const rootRef = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = rootRef.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const openDm = useCallback(() => onView("dm"), [onView]);
  const graph = useMemo(() => ruleToGraph(rule, account), [rule, account]);
  const sim = useFlowSimulator(graph, { account, onOpenDm: openDm });
  const kw = rule.keywords?.[0] || "";
  const playTrigger = () => {
    if (rule.trigger === "comment") { onView("comments"); sim.comment(kw || "Interested"); }
    else if (rule.trigger === "story_mention") sim.storyMention();
    else sim.send(kw || "Hi");
  };
  const views = hasPostView(rule.trigger) ? PREVIEW_VIEWS : PREVIEW_VIEWS.filter(v => v.id === "dm");
  const testing = mode === "test";

  useEffect(() => { onTestingChange?.(mode === "test"); }, [mode]);
  function switchMode(m) {
    setMode(m);
    sim.reset();
    if (m === "test") onView(hasPostView(rule.trigger) ? "comments" : "dm");
  }

  const hint = testing
    ? (rule.trigger === "comment" ? "Comment like a follower would. Tap the buttons in the DM. Nothing is sent."
      : rule.trigger === "story_mention" ? "Tap “Mention in story” to try it. Nothing is sent."
      : "Type a DM like a follower would. Nothing is sent.") + " Or press ▶ to play it for you."
    : "This is what followers see. Switch to Test it to try it yourself.";
  const phone = (
    <PhonePreview view={view} onView={onView} views={views} account={account} post={post}
      keyword={rule.keywords?.[0] || ""} replyText={rule.reply_texts?.[0] || ""}
      steps={testing ? sim.dm : (previewSteps || buildDmSteps(rule, account))}
      sim={testing ? { ...sim, trigger: rule.trigger } : null} />
  );

  // Test it: the phone and "What happened" sit SIDE BY SIDE, and the step list
  // scrolls inside its own column — stacked under the phone it made the whole
  // page grow and scroll with every step. It wraps underneath only when there
  // is genuinely no room beside the phone.
  const placement = !testing ? null : width >= NEED_W ? "side" : timelineSlot ? "slot" : "below";
  const sidePanel = (
    <div data-testid="sim-side" style={{ width: placement === "slot" ? "100%" : SIDE_W, flexShrink: 0, display: "flex", flexDirection: "column", gap: 10, minHeight: 0,
      ...(placement === "slot" ? { height: 420, background: C.raised, borderRadius: 16, padding: 12, boxSizing: "border-box", marginBottom: 22 } : { maxHeight: "min(720px, calc(calc(100vh / var(--fg-zoom, 1)) - 140px))" }) }}>
      {placement === "slot" && <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Test run</div>}
      {/* The player lives with the step list (not above the phone) so Test it is no taller than Preview. */}
      <div style={{ flexShrink: 0, margin: "0 -12px -10px" }}><PlayerBar sim={sim} onDemo={playTrigger} /></div>
      <div style={{ fontSize: 12.5, color: C.textMuted, lineHeight: 1.45, background: placement === "slot" ? C.surface : C.raised, borderRadius: 12, padding: "10px 12px", flexShrink: 0 }}>{hint}</div>
      <Timeline sim={sim} side />
    </div>
  );

  return (
    <div ref={rootRef} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, fontFamily: FONT, width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <PillTabs size="sm" value={mode} onChange={switchMode}
          tabs={[{ id: "preview", label: "Preview", Icon: Eye }, { id: "test", label: "Test it", Icon: Play }]} />
        {testing && <button type="button" onClick={() => sim.reset()} style={{ ...BTN.icon, width: 30, height: 30 }} title="Start over" aria-label="Start over"><RotateCcw size={14} /></button>}
      </div>
      {!testing ? (
        <>
          {phone}
          <div style={{ fontSize: 12, color: C.textMuted, textAlign: "center", maxWidth: 280, lineHeight: 1.4 }}>{hint}</div>
        </>
      ) : (
        <div style={{ display: "flex", gap: 14, alignItems: "stretch", justifyContent: "center", flexDirection: placement === "below" ? "column" : "row", width: "100%" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            {placement === "below" && <div style={{ width: "100%", maxWidth: 330 }}><PlayerBar sim={sim} onDemo={playTrigger} /></div>}
            {phone}
          </div>
          {placement === "side" && sidePanel}
          {placement === "below" && <div style={{ width: "100%", maxWidth: 330, alignSelf: "center" }}><div style={{ fontSize: 12, color: C.textMuted, textAlign: "center", lineHeight: 1.4, marginBottom: 6 }}>{hint}</div><Timeline sim={sim} /></div>}
        </div>
      )}
      {placement === "slot" && createPortal(sidePanel, timelineSlot)}
    </div>
  );
}

export default function PhonePreview({ view, onView, views = PREVIEW_VIEWS, account, post, keyword, replyText, steps, sim }) {
  const handle = account || "your_account";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, fontFamily: FONT }}>
      <div className="fs-ig-phone" style={{ width: 300, maxWidth: "100%", background: IG.frame, borderRadius: 46, padding: 10, boxShadow: sim ? `0 0 0 3px ${C.primary}, 0 18px 40px rgba(0,0,0,.18)` : "0 18px 40px rgba(0,0,0,.18)", transition: "box-shadow .2s" }}>
        <div style={{ background: IG.screen, borderRadius: 37, height: 600, overflow: "hidden", display: "flex", flexDirection: "column", color: IG.text, position: "relative" }}>
          <StatusBar />
          {view === "post" && <PostScreen handle={handle} post={post} onComment={sim && onView ? () => onView("comments") : null} />}
          {view === "comments" && <CommentsScreen handle={handle} post={post} keyword={keyword} replyText={replyText} sim={sim} />}
          {view === "dm" && <DmScreen handle={handle} steps={steps} sim={sim} />}
        </div>
      </div>
      {views.length > 1 && onView && <PillTabs tabs={views} value={view} onChange={onView} size="sm" />}
    </div>
  );
}

function StatusBar() {
  return (
    <div style={{ height: 40, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 26px", flexShrink: 0, fontSize: 13, fontWeight: 650 }}>
      <span>8:18</span>
      <span style={{ width: 74, height: 20, borderRadius: 12, background: "#111" }} />
      <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}><Signal size={13} /><Wifi size={13} /><BatteryFull size={15} /></span>
    </div>
  );
}

function Avatar({ handle, size = 26, ours = true }) {
  return (
    <span style={{ width: size, height: size, borderRadius: "50%", flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
      background: ours ? IG.brand : IG.button, color: "#fff", fontSize: size * 0.42, fontWeight: 750 }}>
      {ours ? (handle || "?").slice(0, 1).toUpperCase() : ""}
    </span>
  );
}

function PostMedia({ post, height, dim }) {
  return (
    <div style={{ height, background: IG.bubble, position: "relative", flexShrink: 0 }}>
      {post?.thumbnail
        ? <img src={post.thumbnail} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: dim ? .45 : 1 }} />
        : <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: IG.muted, fontSize: 12.5, opacity: dim ? .5 : 1 }}>
            <ImageIcon size={26} />{post?.any ? "Any of your posts or reels" : "Pick a post or reel"}
          </div>}
    </div>
  );
}

function TopBar({ handle }) {
  return (
    <div style={{ display: "flex", alignItems: "center", padding: "2px 12px 8px" }}>
      <ChevronLeft size={20} />
      <div style={{ flex: 1, textAlign: "center", lineHeight: 1.15, marginRight: 20 }}>
        <div style={{ fontSize: 10.5, color: IG.muted, textTransform: "uppercase", letterSpacing: ".04em" }}>{handle}</div>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Posts</div>
      </div>
    </div>
  );
}

function PostScreen({ handle, post, onComment }) {
  return (
    <>
      <TopBar handle={handle} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px" }}>
        <Avatar handle={handle} />
        <span style={{ fontSize: 12.5, fontWeight: 650, flex: 1 }}>{handle}</span>
        <MoreHorizontal size={16} />
      </div>
      <PostMedia post={post} height={290} />
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 12px 6px", fontSize: 12.5, fontWeight: 650 }}>
        <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}><Heart size={19} />{fmt(post?.likes)}</span>
        <span onClick={onComment || undefined} style={{ display: "inline-flex", gap: 5, alignItems: "center", cursor: onComment ? "pointer" : "default" }}><MessageCircle size={19} />{fmt(post?.comments)}</span>
        <Send size={18} />
        <Bookmark size={18} style={{ marginLeft: "auto" }} />
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <div style={{ padding: "0 12px", fontSize: 12, lineHeight: 1.4, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical" }}>
          <b>{handle}</b> {post?.caption || (post?.any ? "Your caption…" : "")}
        </div>
        {onComment && <div onClick={onComment} style={{ padding: "6px 12px", fontSize: 12, color: IG.muted, cursor: "pointer" }}>Add a comment…</div>}
      </div>
      <div style={{ display: "flex", justifyContent: "space-around", alignItems: "center", padding: "10px 6px 18px", borderTop: `1px solid ${IG.line}`, flexShrink: 0 }}>
        <Home size={20} /><Search size={20} /><PlusSquare size={20} /><Clapperboard size={20} /><Avatar handle={handle} size={21} />
      </div>
    </>
  );
}

function CommentsScreen({ handle, post, keyword, replyText, sim }) {
  const listRef = useRef(null);
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [sim?.comments?.length]);
  return (
    <>
      <TopBar handle={handle} />
      <PostMedia post={post} height={96} dim />
      <div style={{ flex: 1, background: IG.sheet, borderRadius: "20px 20px 0 0", marginTop: -14, position: "relative", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ width: 36, height: 4, borderRadius: 4, background: IG.faint, margin: "8px auto 0" }} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "10px 14px", borderBottom: `1px solid ${IG.line}`, position: "relative" }}>
          <span style={{ fontSize: 13.5, fontWeight: 700 }}>Comments</span>
          <Send size={17} style={{ position: "absolute", right: 14 }} />
        </div>
        <div ref={listRef} style={{ padding: "14px 14px 0", flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
          {sim ? (
            sim.comments.length === 0
              ? <div style={{ margin: "auto", fontSize: 12, color: IG.faint, textAlign: "center", padding: 16, lineHeight: 1.5 }}>
                  Write a comment below{keyword ? <>, e.g. <b style={{ color: IG.text }}>{keyword}</b></> : ""}.
                </div>
              : sim.comments.map((c, i) => c.note
                  ? <Note key={i} text={c.note} />
                  : <div key={i} style={{ paddingLeft: c.ours ? 36 : 0 }}><CommentRow name={c.ours ? handle : "you"} text={c.text} ours={!!c.ours} handle={handle} /></div>)
          ) : (
            <>
              <CommentRow name="username" text={keyword ? keyword : "Leaves any comment"} ours={false} />
              {replyText
                ? <div style={{ paddingLeft: 36 }}><CommentRow name={handle} text={replyText} handle={handle} /></div>
                : <div style={{ paddingLeft: 36, fontSize: 11.5, color: IG.faint }}>No public reply. They only get the DM.</div>}
            </>
          )}
        </div>
        <Composer sim={sim} onSend={sim?.comment} placeholder={sim ? "Add a comment…" : "Add a comment for username…"} avatar={<Avatar handle="you" ours={false} size={28} />} />
      </div>
    </>
  );
}

function CommentRow({ name, text, ours = true, handle }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <Avatar handle={handle || name} size={26} ours={ours} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11.5 }}><b>{name}</b> <span style={{ color: IG.faint }}>Now</span></div>
        <div style={{ fontSize: 12.5, marginTop: 2, lineHeight: 1.35, overflowWrap: "anywhere" }}>{text}</div>
        <div style={{ fontSize: 11, color: IG.faint, marginTop: 4, fontWeight: 600 }}>Reply</div>
      </div>
      <Heart size={13} color={IG.muted} style={{ marginTop: 6 }} />
    </div>
  );
}

function Note({ text, children }) {
  return (
    <div style={{ alignSelf: "center", maxWidth: "90%", fontSize: 10.5, color: IG.muted, textAlign: "center", padding: "5px 10px", lineHeight: 1.4, background: IG.note, borderRadius: 10 }}>
      {text}{children}
    </div>
  );
}

// Text box at the bottom of the comments / DM screen; live only in test mode.
function Composer({ sim, onSend, placeholder, avatar, dm }) {
  const [v, setV] = useState("");
  const submit = (e) => { e.preventDefault(); if (!v.trim() || !onSend) return; onSend(v); setV(""); };
  const live = !!(sim && onSend);
  return (
    <form onSubmit={submit} style={dm
      ? { display: "flex", alignItems: "center", gap: 8, margin: "0 10px 16px", padding: "6px 10px 6px 6px", background: IG.input, borderRadius: 24 }
      : { display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 18px" }}>
      {dm ? <span style={{ width: 28, height: 28, borderRadius: "50%", background: IG.mine, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Camera size={15} /></span> : avatar}
      <input value={v} onChange={e => setV(e.target.value)} disabled={!live} placeholder={placeholder}
        style={{ flex: 1, minWidth: 0, borderRadius: 20, border: dm ? "none" : `1px solid ${live ? IG.faint : IG.button}`, padding: dm ? "6px 4px" : "8px 12px",
          fontSize: 12, background: "transparent", color: IG.text, outline: "none", fontFamily: FONT }} />
      {live && v.trim()
        ? <button type="submit" style={{ border: "none", background: "transparent", color: IG.mine, fontWeight: 700, fontSize: 12.5, cursor: "pointer", padding: "0 4px", fontFamily: FONT }}>{dm ? "Send" : "Post"}</button>
        : dm && <><ImageIcon size={17} color={IG.muted} /><Smile size={17} color={IG.muted} /><PlusCircle size={17} color={IG.muted} /></>}
    </form>
  );
}

function DmScreen({ handle, steps = [], sim }) {
  const listRef = useRef(null);
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [steps.length, steps[steps.length - 1]?.typing]);
  const canType = sim && sim.trigger !== "story_mention";
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "2px 14px 10px", borderBottom: `1px solid ${IG.line}` }}>
        <ChevronLeft size={20} />
        <Avatar handle={handle} size={30} />
        <span style={{ fontSize: 13.5, fontWeight: 700, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{handle}</span>
        <Phone size={18} /><Video size={20} />
      </div>
      <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "14px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
        {steps.length === 0 && (
          <div style={{ margin: "auto", fontSize: 12, color: IG.faint, textAlign: "center", padding: 20, lineHeight: 1.5 }}>
            {sim ? (sim.trigger === "comment" ? "No DM yet. Comment on the post first." : sim.trigger === "story_mention" ? "Tap below to mention the account in a story." : "Send a message to start.") : "Nothing will be sent yet. Write the DM on the left."}
          </div>
        )}
        {steps.map((s, i) => s.typing
          ? <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-end" }}><Avatar handle={handle} size={22} /><Typing /></div>
          : s.from === "them"
            ? <div key={i} style={{ alignSelf: "flex-end", maxWidth: "75%", background: IG.mine, color: "#fff", borderRadius: 18, padding: "7px 12px", fontSize: 12.5, lineHeight: 1.4, overflowWrap: "anywhere" }}>{s.text}</div>
            : s.note
              ? <Note key={i} text={s.note}>
                  {s.choice && sim && <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 6 }}>
                    {s.choice.map(c => <button key={c.id} type="button" onClick={() => sim.choose(c.id)} style={{ border: "none", borderRadius: 999, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", background: c.id === "yes" ? IG.mine : IG.button, color: "#fff", fontFamily: FONT }}>{c.label}</button>)}
                  </div>}
                </Note>
              : <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-end", alignSelf: "flex-start", maxWidth: "88%" }}>
                  <Avatar handle={handle} size={22} />
                  <DmBubble m={s.message} onTap={sim?.tap} />
                </div>)}
      </div>
      {sim && sim.trigger === "story_mention" ? (
        <div style={{ padding: "0 10px 16px" }}>
          <button type="button" onClick={sim.storyMention} style={{ width: "100%", border: "none", borderRadius: 999, padding: "10px 0", background: IG.mine, color: "#fff", fontWeight: 700, fontSize: 12.5, cursor: "pointer", fontFamily: FONT, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}><AtSign size={14} />Mention in story</button>
        </div>
      ) : <Composer sim={canType ? sim : null} onSend={sim?.send} placeholder="Message…" dm />}
    </>
  );
}

function Typing() {
  return (
    <div style={{ background: IG.bubble, borderRadius: 18, padding: "10px 12px", display: "inline-flex", gap: 4 }}>
      {[0, 1, 2].map(i => <i key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: IG.muted, animation: `fsTyping 1s ${i * 0.15}s infinite ease-in-out` }} />)}
      <style>{"@keyframes fsTyping{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}"}</style>
    </div>
  );
}

function DmBubble({ m, onTap }) {
  if (!m) return null;
  const p = m.attachment?.payload;
  const box = { background: IG.bubble, borderRadius: 18, overflow: "hidden", fontSize: 12.5, lineHeight: 1.4, minWidth: 0 };
  const btn = (b, i) => {
    const style = { margin: "0 8px 8px", padding: "8px 10px", borderRadius: 10, background: IG.button, textAlign: "center", fontWeight: 650, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, color: IG.text, border: "none", fontFamily: FONT, width: "calc(100% - 16px)" };
    const inner = <>{b.type === "web_url" && <Link2 size={12} color={IG.muted} />}{b.title || "Button"}</>;
    return onTap
      ? <button key={i} type="button" onClick={() => onTap(b)} style={{ ...style, cursor: "pointer" }}><span style={{ display: "contents" }}>{inner}</span></button>
      : <div key={i} style={style}>{inner}</div>;
  };
  if (p?.template_type === "button") {
    return <div style={box}><div style={{ padding: "9px 12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{p.text}</div>{(p.buttons || []).map(btn)}</div>;
  }
  if (p?.template_type === "generic") {
    const e = p.elements?.[0] || {};
    return (
      <div style={{ ...box, width: 200 }}>
        {e.image_url
          ? <img src={e.image_url} alt="" style={{ width: "100%", height: 104, objectFit: "cover", display: "block" }} onError={ev => { ev.currentTarget.style.display = "none"; }} />
          : <div style={{ height: 80, background: IG.button, display: "flex", alignItems: "center", justifyContent: "center", color: IG.muted }}><ImageIcon size={20} /></div>}
        <div style={{ padding: "8px 12px" }}>
          <div style={{ fontWeight: 700 }}>{e.title}</div>
          {e.subtitle && <div style={{ color: IG.muted, fontSize: 11.5 }}>{e.subtitle}</div>}
        </div>
        {(e.buttons || []).map(btn)}
      </div>
    );
  }
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...box, padding: "8px 12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{m.text}</div>
      {m.quick_replies?.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
          {m.quick_replies.map((q, i) => onTap
            ? <button key={i} type="button" onClick={() => onTap({ type: "postback", title: q.title, payload: q.payload })} style={{ padding: "5px 11px", borderRadius: 999, border: `1px solid ${IG.mine}`, background: "transparent", color: IG.mine, fontSize: 11.5, fontWeight: 650, cursor: "pointer", fontFamily: FONT }}>{q.title}</button>
            : <span key={i} style={{ padding: "5px 11px", borderRadius: 999, border: `1px solid ${IG.mine}`, color: IG.mine, fontSize: 11.5, fontWeight: 650 }}>{q.title}</span>)}
        </div>
      )}
    </div>
  );
}

function fmt(n) {
  const v = Number(n) || 0;
  return v >= 1e6 ? (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : v >= 1e3 ? (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K" : String(v);
}
