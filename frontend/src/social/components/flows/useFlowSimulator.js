import { useState, useRef, useCallback, useEffect } from "react";
import { api } from "../../api.js";

// Client-side dry run of a Flow Builder automation, mirroring the server engine
// (backend services/flowEngine.js EXEC): trigger matching, the one private reply
// after a comment (then wait for the person), buttons / quick replies that
// continue along their branch, Ask a Question with validation + STOP, conditions
// (you answer "do they follow?"), randomizer, delays (skipped), actions (notes +
// a test contact) and AI Step (a real reply through OpenRouter).
// Nothing is sent to Instagram and nothing is saved to the contact.
//
// Player: every executed step and every follower action saves a snapshot, so the
// run can be paused, stepped (Next), rewound (Back), replayed at 0.5×–4× speed or
// jumped to from the timeline. The next step waits in `pending` until played.
//
// Returns what PhonePreview's simulator expects:
//   { comments, dm, comment(text), send(text), tap(button), choose(id), storyMention(), reset() }
// plus player controls and `activeNode` (highlighted on the canvas).

const TYPING_MS = 800;
const STEP_MS = 650;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const P = "SIM:";   // tap payload: SIM:<nodeId>:<handle>

function matchTrigger(t, text) {
  const hay = String(text || "").trim().toLowerCase();
  const kws = (t.keywords || []).map(k => String(k).trim().toLowerCase()).filter(Boolean);
  const ex = (t.exclude || []).map(k => String(k).trim().toLowerCase()).filter(Boolean);
  if (ex.some(k => hay.includes(k))) return false;
  if (t.anyWord || !kws.length) return t.kind !== "dm" || t.anyWord;   // DM triggers need keywords (same as the engine)
  return kws.some(k => t.match === "exact" ? hay === k : t.match === "starts_with" ? hay.startsWith(k) : hay.includes(k));
}
function validate(kind, raw) {
  const s = String(raw || "").trim();
  if (!s) return false;
  if (kind === "email") return EMAIL_RE.test(s);
  if (kind === "phone") { const d = s.replace(/[^\d]/g, ""); return d.length >= 7 && d.length <= 15; }
  if (kind === "number") return !isNaN(Number(s.replace(/,/g, "")));
  if (kind === "url") return /^(https?:\/\/)?[^\s.]+\.[^\s]{2,}/i.test(s);
  return true;
}
const clip = (s, n) => String(s || "").slice(0, n);
const short = (s, n = 48) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const STEP_LABEL = { trigger: "Trigger", message: "Send Message", collect: "Ask a Question", ai: "AI Step", action: "Perform Actions", condition: "Condition", randomizer: "Randomizer", delay: "Smart Delay", goto: "Start another Automation", follow: "Follow Check" };

export default function useFlowSimulator(graph, { account, tagName = (id) => id, flowName = (id) => `automation #${id}`, onOpenDm, onNode, persona = {}, flows = [] } = {}) {
  const [, force] = useState(0);
  const g = useRef(graph); g.current = graph;
  const flowsRef = useRef(flows); flowsRef.current = flows;   // other automations (with graphs), for "Start another Automation"
  const st = useRef(null);
  const timers = useRef([]);
  const gen = useRef(0);
  const speed = useRef(1);
  const playing = useRef(true);
  const userPaused = useRef(false);   // Pause pressed: follower actions don't auto-resume
  const hist = useRef({ list: [], cursor: -1 });

  const fresh = () => ({
    vars: { _username: persona.username || "test_user", _name: persona.name || "Test User", _account: account || "" },
    tags: [], wait: null, needsReply: false, privatePending: false, handled: false, steps: 0,
    dm: [], comments: [], pending: null, active: null, typing: false,
  });
  if (!st.current) st.current = fresh();

  // Inside another automation (after a "Start another Automation" step) its steps aren't on this canvas.
  const render = () => { force(x => x + 1); onNode?.(st.current.sub ? null : st.current.active); };
  // Timers belong to one generation; a reset / rewind starts a new one and drops the rest.
  const later = (fn, ms) => { const g0 = gen.current; timers.current.push(setTimeout(() => { if (g0 === gen.current) fn(); }, ms / speed.current)); };
  const cancel = () => { timers.current.forEach(clearTimeout); timers.current = []; gen.current += 1; };

  const s = () => st.current;
  const pushDm = (...items) => { s().typing = false; s().dm.push(...items); render(); };
  const note = (text, extra) => pushDm({ note: text, ...extra });
  const pushComment = (c) => { s().comments.push(c); render(); };

  // ── history (snapshots) ──
  function snap(label, nodeId = null, kind = "step") {
    const h = hist.current;
    const state = JSON.parse(JSON.stringify({ ...st.current, typing: false }));
    h.list = h.list.slice(0, h.cursor + 1);
    h.list.push({ label, nodeId, kind, state });
    h.cursor = h.list.length - 1;
    render();
  }
  function restore(i) {
    const h = hist.current;
    if (i < 0 || i >= h.list.length) return;
    cancel();
    playing.current = false;
    h.cursor = i;
    st.current = JSON.parse(JSON.stringify(h.list[i].state));
    render();
  }

  const reset = useCallback(() => {
    cancel();
    st.current = fresh();
    hist.current = { list: [], cursor: -1 };
    playing.current = true; userPaused.current = false;
    render();
  }, [account, persona.username]);
  useEffect(() => () => cancel(), []);

  // The graph being run: this automation's, or the one a "Start another Automation" step jumped into.
  const subFlow = () => { const id = st.current?.sub; return id ? flowsRef.current.find(f => String(f.id) === String(id)) : null; };
  const cg = () => (st.current?.sub ? subFlow()?.graph || { nodes: [], edges: [] } : g.current);
  const nodeById = (id) => (cg()?.nodes || []).find(n => n.id === id);
  const nextOf = (id, handle) => (cg()?.edges || []).find(e => e.source === id && (e.sourceHandle || "next") === handle)?.target || null;
  const triggerNode = () => (g.current?.nodes || []).find(n => n.type === "trigger");   // always this automation's own trigger
  const fill = (text) => String(text || "").replace(/\{([a-z0-9_]+)\}/gi, (m, k) => {
    const v = s().vars, key = k.toLowerCase();
    if (key === "first_name") return (v._name || v._username || "").split(" ")[0] || "there";
    if (key === "username") return v._username || "";
    if (key === "account") return v._account || "";
    return v[key] != null ? String(v[key]) : m;
  });
  const hasTaps = (n) => (n.data?.quickReplies || []).some(q => q.title) || (n.data?.blocks || []).some(b => (b.buttons || []).some(x => x.title && x.kind !== "url"));

  // Send Message node → PhonePreview messages (same rules as buildMessages on the server).
  function buildMessages(node) {
    const d = node.data || {};
    // Quick Automations: ready-made Graph messages (their DM), with {variables} filled.
    if (Array.isArray(d.raw)) return d.raw.filter(Boolean).map(m => JSON.parse(JSON.stringify(m), (k, v) => (k === "text" && typeof v === "string") ? fill(v) : v));
    const out = [];
    const toButton = (b) => b.kind === "url"
      ? { type: "web_url", title: clip(fill(b.title), 20) || "Open", url: fill(b.url) }
      : { type: "postback", title: clip(fill(b.title), 20) || "Next", payload: `${P}${node.id}:btn:${b.id}` };
    for (const blk of d.blocks || []) {
      if (blk.type === "text") {
        const text = fill(blk.text).trim();
        if (!text) continue;
        const btns = (blk.buttons || []).filter(b => b.title && (b.kind !== "url" || b.url)).slice(0, 3).map(toButton);
        out.push(btns.length ? { attachment: { type: "template", payload: { template_type: "button", text, buttons: btns } } } : { text });
      } else if (blk.type === "image" && blk.url) {
        out.push({ attachment: { type: "template", payload: { template_type: "generic", elements: [{ title: "Image", image_url: blk.url }] } } });
      } else if (blk.type === "card" && blk.title) {
        const el = { title: fill(blk.title), subtitle: blk.subtitle ? fill(blk.subtitle) : undefined, image_url: blk.image_url || undefined };
        const btns = (blk.buttons || []).filter(b => b.title && (b.kind !== "url" || b.url)).slice(0, 3).map(toButton);
        if (btns.length) el.buttons = btns;
        out.push({ attachment: { type: "template", payload: { template_type: "generic", elements: [el] } } });
      }
    }
    const qrs = (d.quickReplies || []).filter(q => q.title).slice(0, 13).map(q => ({ title: clip(fill(q.title), 20), payload: `${P}${node.id}:qr:${q.id}` }));
    if (qrs.length) {
      const lastText = [...out].reverse().find(m => m.text);
      if (lastText) lastText.quick_replies = qrs;
      else out.push({ text: fill(d.quickText || "Choose one:"), quick_replies: qrs });
    }
    return out;
  }

  // ── scheduling: the next node waits in `pending` until played ──
  function schedule(id, delay = STEP_MS) {
    s().pending = id;
    s().active = id;
    render();
    if (playing.current) later(runPending, delay);
  }
  function runPending() {
    const id = s().pending;
    if (!id) return;
    s().pending = null;
    run(id);
  }
  function advance(fromId, handle = "next") {
    const target = nextOf(fromId, handle);
    if (!target) {
      const n = nodeById(fromId);
      if (handle === "next" && n?.type === "message" && hasTaps(n)) { s().active = fromId; render(); return; }   // continues from a tap
      finish();
      return;
    }
    schedule(target);
  }
  function finish() {
    s().active = null;
    if (!s().wait) note(s().noReply ? "Nothing more on this path. It waits to see if they respond." : "End of this path. The automation stops here.");
    snap(s().noReply ? "Waiting to see if they respond" : "End of this path", null, "end");
  }

  async function run(id) {
    const node = nodeById(id);
    const S = s();
    if (!node) { finish(); return; }
    if (++S.steps > 60) { note("Stopped after 60 steps (a loop?)."); S.active = null; snap("Stopped (loop?)"); return; }
    S.active = id; render();
    const d = node.data || {};
    const label = (detail) => `${STEP_LABEL[node.type] || node.type}${detail ? ` · ${detail}` : ""}`;

    // After the one private reply, Instagram allows nothing more until they answer.
    const parkIfNeeded = () => {
      if (!S.needsReply) return false;
      S.wait = { kind: "reply", nodeId: id };
      note("Instagram allows only one message after a comment, so this step waits until they tap or reply.");
      snap(label("waits for their reply"), id, "wait");
      return true;
    };

    if (node.type === "message") {
      const msgs = buildMessages(node);
      if (!msgs.length) { note("This Send Message step is empty."); snap(label("empty"), id); advance(id); return; }
      if (parkIfNeeded()) return;
      const wasPrivate = S.privatePending;
      const out = wasPrivate ? msgs.slice(0, 1) : msgs;
      if (S.privatePending) { S.privatePending = false; S.needsReply = true; }
      S.typing = true; render();
      later(() => {
        pushDm(...out.map(m => ({ message: m })));
        if (msgs.length > out.length) note(`The other ${msgs.length - out.length} message(s) in this step aren't sent: a comment's private reply is a single message.`);
        // "If they don't respond": offer to act as someone who ignores it (mirrors armNoReply).
        const nr = d.noReply;
        if (nr?.enabled && nextOf(id, "noreply")) {
          if (wasPrivate) note("“If no response” isn't used after a comment's private reply.");
          else { S.noReply = { nodeId: id }; note(`If they don't respond within ${nr.amount || 1} ${nr.unit === "hours" ? "hours" : "minutes"}:`, { choice: [{ id: "noreply", label: "Don't respond" }], noreply: true }); }
        }
        snap(label(`“${short(out[0].text || out[0].attachment?.payload?.text || "message")}”`), id);
        advance(id);
      }, TYPING_MS);
      return;
    }
    if (node.type === "follow") {
      if (parkIfNeeded()) return;
      if (S.privatePending) {   // can't look them up before they tap / reply (mirrors EXEC.follow)
        S.privatePending = false; S.needsReply = true;
        S.wait = { kind: "reply", nodeId: id };
        S.typing = true; render();
        later(() => {
          pushDm({ message: followButton(id, d.openText || "Thanks! Tap below to continue.", d.openButton || "Continue") });
          note("Instagram can't check follows until they tap or reply, so this goes first.");
          snap(label("tap to continue"), id, "wait");
        }, TYPING_MS);
        return;
      }
      S.wait = { kind: "follows", nodeId: id, followStep: true };
      note(`Does @${S.vars._username} follow @${account || "your account"}? (the real automation checks Instagram)`, { choice: [{ id: "yes", label: "Follows" }, { id: "no", label: "Doesn't follow" }] });
      snap(label("asks: do they follow?"), id, "wait");
      return;
    }
    if (node.type === "collect") {
      if (parkIfNeeded()) return;
      S.wait = { kind: "input", nodeId: id, retries: 0 };
      const msg = { text: fill(d.prompt || "Please reply with your answer.") };
      if (d.skipLabel) msg.quick_replies = [{ title: clip(d.skipLabel, 20), payload: `${P}${id}:skip` }];
      if (S.privatePending) { S.privatePending = false; S.needsReply = true; }
      S.typing = true; render();
      later(() => { pushDm({ message: msg }); snap(label(`asks “${short(msg.text, 36)}”`), id, "wait"); }, TYPING_MS);
      return;
    }
    if (node.type === "condition") {
      const rules = d.rules || [];
      if (!rules.length) { snap(label("no rules → yes"), id); advance(id, "yes"); return; }
      const results = rules.map(r => evalRule(r, id));
      if (results.includes("ask")) return;
      const ok = d.match === "any" ? results.some(Boolean) : results.every(Boolean);
      note(`Condition: ${ok ? "yes" : "no"}`);
      snap(label(ok ? "yes" : "no"), id);
      advance(id, ok ? "yes" : "no");
      return;
    }
    if (node.type === "randomizer") {
      const vs = (d.variants || []).filter(v => Number(v.weight) > 0);
      if (!vs.length) { finish(); return; }
      const total = vs.reduce((a, v) => a + Number(v.weight), 0);
      let x = Math.random() * total, pick = vs[vs.length - 1];
      for (const v of vs) { x -= Number(v.weight); if (x <= 0) { pick = v; break; } }
      note(`Randomizer picked ${pick.label || "a path"} (${pick.weight}%)`);
      snap(label(`picked ${pick.label || "a path"}`), id);
      advance(id, `v:${pick.id}`);
      return;
    }
    if (node.type === "delay") {
      note(`Waits ${d.amount || 1} ${d.unit || "hours"}. Skipped in this test.`);
      snap(label(`${d.amount || 1} ${d.unit || "hours"} (skipped)`), id);
      advance(id);
      return;
    }
    if (node.type === "action") {
      const lines = [];
      for (const a of d.actions || []) {
        if (a.kind === "add_tag" && a.tags?.length) { a.tags.forEach(t => { if (!S.tags.includes(t)) S.tags.push(t); }); lines.push(`Tag added: ${a.tags.map(tagName).join(", ")}`); }
        else if (a.kind === "remove_tag" && a.tags?.length) { S.tags = S.tags.filter(t => !a.tags.includes(t)); lines.push(`Tag removed: ${a.tags.map(tagName).join(", ")}`); }
        else if (a.kind === "set_field" && a.key) { S.vars[a.key] = fill(a.value); lines.push(`Field {${a.key}} = ${fill(a.value) || "(empty)"}`); }
        else if (a.kind === "clear_field" && a.key) { delete S.vars[a.key]; lines.push(`Field {${a.key}} cleared`); }
        else if (a.kind === "notify") lines.push(`Team notified: ${fill(a.title || "Automation needs you")}`);
        else if (a.kind === "http") lines.push(`Webhook ${a.method || "POST"} ${a.url || ""} (not called in a test)`);
        else if (a.kind === "sheet") lines.push(`Google Sheet row: ${String(a.columns || "{username}").split(",").map(c => fill(c.trim())).join(" | ")} (not written in a test)`);
        else if (a.kind === "stop_ai") lines.push("AI agent kept quiet for this person");
        else if (a.kind === "note" && a.text) lines.push(fill(a.text));
      }
      note(lines.length ? lines.join(" · ") : "No actions set in this step.");
      snap(label(short(lines.join(", ") || "none", 44)), id);
      advance(id);
      return;
    }
    if (node.type === "ai") {
      if (parkIfNeeded()) return;
      S.typing = true; render();
      const g0 = gen.current;
      try {
        const r = await api.automations.flowAiTest({ instructions: fill(d.instructions), model: d.model || "", messages: dmHistory() });
        if (g0 !== gen.current) return;   // rewound / reset while the AI was thinking
        const text = String(r.text || "").trim();
        if (d.saveTo) S.vars[d.saveTo] = text;
        if (d.send !== false && text) { if (S.privatePending) { S.privatePending = false; S.needsReply = true; } pushDm({ message: { text } }); }
        else note(d.saveTo ? `AI reply saved to {${d.saveTo}} (not sent)` : "AI wrote nothing.");
        note(`AI Step · ${r.model}${r.costInr != null ? ` · ≈ ₹${r.costInr.toFixed(4)}` : ""}`);
        snap(label(`“${short(text, 40)}”`), id);
      } catch (e) {
        if (g0 !== gen.current) return;
        note(`AI Step couldn't run: ${e.message}`);
        snap(label("failed"), id);
      }
      advance(id);
      return;
    }
    if (node.type === "goto") {   // mirrors EXEC.goto
      const target = flowsRef.current.find(f => String(f.id) === String(d.flowId));
      const stop = (msg, detail) => { note(msg); S.active = null; snap(label(detail), id, "end"); };
      if (!d.flowId) return stop("No automation picked in this step.", "none");
      if (!target) return stop(`“${flowName(d.flowId)}” isn't on this account any more.`, "missing");
      if (!target.active) return stop(`“${target.name}” is off, so nothing happens. Set it live so this step can start it.`, `${target.name} is off`);
      if ((S.gotoDepth || 0) >= 5) return stop("Stopped: automations started each other 5 times in a row (a loop?).", "loop stopped");
      const t = (target.graph?.nodes || []).find(n => n.type === "trigger");
      if (!t) return stop(`“${target.name}” has no steps.`, "empty");
      S.gotoDepth = (S.gotoDepth || 0) + 1;
      note(`Continues in “${target.name}” (same conversation, fields and tags carried over). Its steps aren't on this canvas.`);
      snap(label(target.name), id);
      S.sub = target.id;
      advance(t.id);
      return;
    }
    advance(id);
  }

  function dmHistory() {
    const out = [];
    for (const x of s().dm) {
      if (x.from === "them" && x.text) out.push({ role: "user", content: x.text });
      else if (x.message) { const t = x.message.text || x.message.attachment?.payload?.text; if (t) out.push({ role: "assistant", content: t }); }
    }
    while (out.length && out[0].role !== "user") out.shift();
    if (!out.length) out.push({ role: "user", content: s().vars._last_text || "Hi" });
    return out.slice(-12);
  }

  function evalRule(r, nodeId) {
    const S = s();
    const val = (k) => S.vars[String(k || "").toLowerCase()] != null ? String(S.vars[String(k || "").toLowerCase()]) : "";
    switch (r.subject) {
      case "tag": { const has = S.tags.includes(r.key); return r.op === "not" ? !has : has; }
      case "field": {
        const v = val(r.key), want = String(r.value || "").toLowerCase();
        if (r.op === "set") return v !== ""; if (r.op === "unset") return v === "";
        if (r.op === "eq") return v.toLowerCase() === want; if (r.op === "neq") return v.toLowerCase() !== want;
        if (r.op === "contains") return v.toLowerCase().includes(want);
        if (r.op === "gt") return Number(v) > Number(r.value); if (r.op === "lt") return Number(v) < Number(r.value);
        return false;
      }
      case "last_text": {
        const v = String(S.vars._last_text || "").toLowerCase();
        const hit = String(r.value || "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean).some(w => v.includes(w));
        return r.op === "not" ? !hit : hit;
      }
      case "follows": {
        S.wait = { kind: "follows", nodeId, op: r.op };
        note(`Does @${S.vars._username} follow @${account || "your account"}? (the real automation checks Instagram)`, { choice: [{ id: "yes", label: "Follows" }, { id: "no", label: "Doesn't follow" }] });
        snap("Condition · asks: do they follow?", nodeId, "wait");
        return "ask";
      }
      case "time": {
        const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date()));
        const from = Number(r.from ?? 9), to = Number(r.to ?? 18);
        const inside = from <= to ? h >= from && h < to : h >= from || h < to;
        return r.op === "not" ? !inside : inside;
      }
      default: return false;
    }
  }

  // A Follow Check message: one postback button whose tap re-runs the step.
  function followButton(nodeId, text, label) {
    return { attachment: { type: "template", payload: { template_type: "button", text: fill(text), buttons: [{ type: "postback", title: clip(label, 20), payload: `${P}${nodeId}:recheck` }] } } };
  }

  // They tapped / clicked / wrote back: a pending "no response" path no longer applies.
  function responded() {
    const S = s();
    if (!S.noReply) return;
    S.dm = S.dm.map(x => x.noreply ? { note: x.note.replace(/:$/, "") + " · they responded, so it's skipped." } : x);
    S.noReply = null;
  }

  const triggers = () => triggerNode()?.data?.triggers || [];
  const resume = () => { if (!userPaused.current) playing.current = true; };

  const comment = useCallback((text) => {
    const t0 = String(text || "").trim();
    if (!t0) return;
    resume();
    const S = s();
    pushComment({ name: "you", text: t0 });
    const any = triggers().find(x => x.kind === "comment");
    const trig = triggers().find(x => x.kind === "comment" && matchTrigger(x, t0));
    if (!any) { pushComment({ note: "This automation doesn't start from comments." }); snap(`You commented “${short(t0, 30)}” · no comment trigger`, null, "you"); return; }
    if (!trig) { pushComment({ note: `No keyword match, so nothing happens. Try “${any.keywords?.[0] || "…"}”.` }); snap(`You commented “${short(t0, 30)}” · no match`, null, "you"); return; }
    if (trig.oncePerUser !== false && S.handled) { pushComment({ note: "Already handled you on this post (once per person)." }); snap("You commented again · once per person", null, "you"); return; }
    S.handled = true; S.vars._last_text = t0;
    const replies = (trig.replyTexts || []).filter(Boolean);
    if (replies.length) pushComment({ name: account || "your_account", text: fill(replies[Math.floor(Math.random() * replies.length)]), ours: true });
    pushComment({ note: "Sent you a DM. Tap DM to see it." });
    S.dm = []; S.privatePending = true; S.needsReply = false; S.wait = null; S.sub = null; S.gotoDepth = 0;
    note("Private reply to your comment");
    const t = triggerNode();
    S.active = t.id;
    snap(`Trigger · comment “${short(t0, 30)}” matched`, t.id, "you");
    later(() => onOpenDm?.(), 500);
    advance(t.id);
  }, [account, onOpenDm]);

  const send = useCallback((text) => {
    const t0 = String(text || "").trim();
    if (!t0) return;
    resume();
    const S = s();
    responded();
    pushDm({ from: "them", text: t0 });
    S.vars._last_text = t0;
    const w = S.wait;
    if (w?.kind === "input") {
      const node = nodeById(w.nodeId); const d = node?.data || {};
      S.needsReply = false;
      if (/^\s*(stop|cancel)\s*$/i.test(t0)) {
        S.wait = null; pushDm({ message: { text: "No problem, I have stopped. Message us any time if you need anything." } });
        S.active = null; snap("You typed STOP · automation stopped", w.nodeId, "you"); return;
      }
      if (!validate(d.kind, t0) && w.retries < (Number(d.maxRetries) || 2)) {
        w.retries += 1;
        pushDm({ message: { text: fill(d.retryText || "That doesn't look right. Please try again (or type STOP to cancel).") } });
        snap(`You answered “${short(t0, 24)}” · not a valid ${d.kind || "answer"}, asks again`, w.nodeId, "you");
        return;
      }
      if (d.field) { S.vars[d.field] = t0; note(`Saved {${d.field}} = ${t0}`); }
      if (d.kind === "name") S.vars._name = t0;
      S.wait = null;
      snap(`You answered “${short(t0, 24)}”${d.field ? ` · saved {${d.field}}` : ""}`, w.nodeId, "you");
      advance(w.nodeId);
      return;
    }
    if (w?.kind === "reply") { S.wait = null; S.needsReply = false; snap(`You replied “${short(t0, 30)}” · continues`, w.nodeId, "you"); schedule(w.nodeId); return; }
    if (w?.kind === "follows") { note("Answer the follow question above first."); return; }
    const t = triggerNode();
    const trig = triggers().find(x => x.kind === "dm" && matchTrigger(x, t0));
    const storyTrig = triggers().find(x => x.kind === "story_reply" && matchTrigger(x, t0));
    if (trig || storyTrig) {
      if (storyTrig && !trig) note("Treated as a reply to your story");
      S.needsReply = false; S.privatePending = false; S.sub = null; S.gotoDepth = 0; S.active = t.id;
      snap(`Trigger · ${trig ? "DM" : "story reply"} “${short(t0, 30)}” matched`, t.id, "you");
      advance(t.id);
      return;
    }
    const dmT = triggers().find(x => x.kind === "dm");
    note(dmT ? `No keyword match, so no reply. Try “${dmT.keywords?.[0] || "…"}”.` : triggers().some(x => x.kind === "comment") ? "Typed DMs don't start this automation. Comment on the post instead." : "Nothing happens.");
    snap(`You sent “${short(t0, 30)}” · no match`, null, "you");
  }, [account]);

  const tap = useCallback((b) => {
    if (b.type === "web_url") {
      responded();
      note(`Opened ${b.url || "the link"} (counted as a click)`);
      if (/^https?:\/\/.+/i.test(b.url || "")) window.open(b.url, "_blank", "noopener");
      return;
    }
    resume();
    const S = s();
    responded();
    pushDm({ from: "them", text: b.title });
    const m = String(b.payload || "").match(/^SIM:([^:]+):(.+)$/);
    if (!m) {   // a Quick Automation button code: another "Button tap" automation answers it
      note(`Sends the code “${b.payload || "…"}”. A Button tap automation with that code would answer.`);
      snap(`You tapped “${b.title}” · sends code ${b.payload || "…"}`, null, "you");
      return;
    }
    S.needsReply = false;
    const [, nodeId, handle] = m;
    S.wait = null;
    if (handle === "skip") { snap(`You tapped “${b.title}” · skipped`, nodeId, "you"); advance(nodeId); return; }
    if (handle === "recheck") { snap(`You tapped “${b.title}” · checks again`, nodeId, "you"); schedule(nodeId); return; }
    const target = nextOf(nodeId, handle);
    if (!target) { note("This button isn't connected to a next step yet."); S.active = nodeId; snap(`You tapped “${b.title}” · not connected`, nodeId, "you"); return; }
    snap(`You tapped “${b.title}”`, nodeId, "you");
    schedule(target);
  }, []);

  const choose = useCallback((id) => {
    const S = s();
    if (id === "noreply") {
      const nr = S.noReply;
      if (!nr) return;
      resume();
      S.dm = S.dm.map(x => x.noreply ? { note: x.note.replace(/:$/, "") + " · no response." } : x);
      S.noReply = null; S.wait = null; S.needsReply = false;
      snap("No response · takes the “No response” path", nr.nodeId, "you");
      schedule(nextOf(nr.nodeId, "noreply"));
      return;
    }
    const w = S.wait;
    if (w?.kind !== "follows") return;
    resume();
    if (w.followStep) {   // Follow Check step (mirrors EXEC.follow)
      S.dm = S.dm.map(x => x.choice && !x.noreply ? { note: x.note.replace(/\?.*$/, "?") + (id === "yes" ? " Yes." : " No.") } : x);
      S.wait = null;
      if (id === "yes") { snap("Follow Check · follows", w.nodeId, "you"); advance(w.nodeId, "yes"); return; }
      const d = nodeById(w.nodeId)?.data || {};
      const key = `_follow_asks_${w.nodeId}`, asks = Number(S.vars[key]) || 0;
      const max = Math.min(5, Math.max(1, Number(d.maxAsks) || 2));
      if (asks >= max) { note(`Still not following after ${max} ask${max > 1 ? "s" : ""}.`); snap("Follow Check · still not following", w.nodeId, "you"); advance(w.nodeId, "no"); return; }
      S.vars[key] = asks + 1;
      S.wait = { kind: "reply", nodeId: w.nodeId };   // replying instead of tapping also re-checks
      S.typing = true; render();
      later(() => { pushDm({ message: followButton(w.nodeId, d.askText || "Almost there! Please follow @{account} first, then tap the button below.", d.button || "I've followed") }); snap(`Follow Check · asks them to follow (${asks + 1}/${max})`, w.nodeId, "wait"); }, TYPING_MS);
      return;
    }
    S.dm = S.dm.map(x => x.choice && !x.noreply ? { note: x.note.replace(/\?.*$/, "?") + (id === "yes" ? " Yes." : " No.") } : x);
    S.wait = null;
    const yes = w.op === "not" ? id !== "yes" : id === "yes";
    note(`Condition: ${yes ? "yes" : "no"}`);
    snap(`Condition · ${id === "yes" ? "follows" : "doesn't follow"} → ${yes ? "yes" : "no"}`, w.nodeId, "you");
    advance(w.nodeId, yes ? "yes" : "no");
  }, []);

  // "Started by another automation": play it as if a Start another Automation step sent them here.
  const startCalled = useCallback(() => {
    const t = triggerNode();
    if (!(t?.data?.triggers || []).some(x => x.kind === "called")) { note("This automation isn't started by another automation."); return; }
    resume();
    const S = s();
    S.sub = null; S.needsReply = false; S.privatePending = false; S.wait = null;
    note("Started by another automation: the conversation is already open.");
    S.active = t.id;
    snap("Trigger · started by another automation", t.id, "you");
    advance(t.id);
  }, []);

  const storyMention = useCallback(() => {
    const t = triggerNode();
    const trig = triggers().find(x => x.kind === "story_mention");
    if (!trig) { note("This automation doesn't start from story mentions."); return; }
    resume();
    note("You mentioned the account in your story");
    s().sub = null; s().gotoDepth = 0; s().active = t.id;
    snap("Trigger · story mention", t.id, "you");
    advance(t.id);
  }, []);

  // ── player controls ──
  const setSpeed = useCallback((x) => { speed.current = x; render(); }, []);
  const pause = useCallback(() => { userPaused.current = true; playing.current = false; cancel(); render(); }, []);
  const play = useCallback(() => {
    cancel();
    userPaused.current = false;
    playing.current = true;
    render();
    const g0 = gen.current;
    // Rewound: replay the recorded steps in order, then carry on with the pending one.
    const tick = () => {
      if (g0 !== gen.current || !playing.current) return;
      const h = hist.current;
      if (h.cursor < h.list.length - 1) {
        h.cursor += 1;
        st.current = JSON.parse(JSON.stringify(h.list[h.cursor].state));
        render();
        timers.current.push(setTimeout(tick, STEP_MS / speed.current));
      } else if (st.current.pending) later(runPending, 150);
    };
    tick();
  }, []);
  const next = useCallback(() => {
    const h = hist.current;
    if (h.cursor < h.list.length - 1) { restore(h.cursor + 1); return; }   // forward through recorded steps
    if (s().pending) { cancel(); playing.current = false; runPending(); render(); }
  }, []);
  const back = useCallback(() => { const h = hist.current; if (h.cursor > 0) restore(h.cursor - 1); }, []);
  const jump = useCallback((i) => restore(i), []);

  const S = st.current;
  const h = hist.current;
  return {
    comments: S.comments,
    dm: S.typing ? [...S.dm, { typing: true }] : S.dm,
    comment, send, tap, choose, storyMention, startCalled, reset,
    activeNode: S.sub ? null : S.active, pendingNode: S.pending, inFlow: S.sub ? subFlow()?.name || null : null,
    vars: { ...S.vars, _tags: S.tags },
    // player
    playing: playing.current, speed: speed.current, setSpeed, play, pause, next, back, jump,
    timeline: h.list.map(x => ({ label: x.label, nodeId: x.nodeId, kind: x.kind })), cursor: h.cursor,
    canBack: h.cursor > 0, canNext: h.cursor < h.list.length - 1 || !!S.pending,
    waiting: S.wait?.kind || null,
  };
}
