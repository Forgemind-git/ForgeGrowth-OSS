/**
 * flowKit — builds automation graphs for the WhatsApp template library.
 *
 * Every template in catalog.js describes its flow with this small DSL instead
 * of hand-writing node JSON, so the shapes below are the ONLY place a template
 * can get a node wrong. They mirror what the engine and the validator accept:
 *
 *   - fields sit FLAT on the node (no config/data wrapper)
 *   - a question is a `message` with `waitForReply: true` (there is no
 *     `question` type); a free-text question branches on `replied`, a buttons
 *     question on `btn:N`, a list on `row:<section>:<row>`, plus `nomatch`
 *   - button titles ≤ 20 chars, list rows ≤ 24, row descriptions ≤ 72,
 *     at most 3 buttons and 10 list rows in total (the engine trims anything
 *     longer, so a template that relied on the extra would silently lose it)
 *
 * Two rules are applied for every template, so no catalog entry has to
 * remember them:
 *   1. PACING — a plain text or media message wired straight into an
 *      interactive one (buttons / list / link button) gets a 2-second Delay
 *      between them; interactive messages reach the handset faster and would
 *      otherwise land on top of the text they answer.
 *   2. LAYOUT — nodes are placed left-to-right by depth, never stacked on the
 *      origin, so the builder opens on a readable canvas.
 *
 * `timeout` branches are deliberately left unwired: a reply-wait times out
 * after 24 h, by which point WhatsApp's 24-hour window has closed and a
 * free-form follow-up would be refused anyway.
 */
import { nodeH, NODE_W } from "../builder/nodeLayout.js";

export const LIMITS = { button: 20, row: 24, rowDesc: 72, section: 24, listButton: 20, buttons: 3, rows: 10 };

const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const INTERACTIVE = new Set(["quick_reply", "list", "cta_url"]);
const MEDIA = new Set(["image", "video", "audio", "document"]);

export function createFlow(ctx = {}) {
  const nodes = [];
  const edges = [];
  let seq = 0;
  const nextId = (p) => `${p}${++seq}`;
  const byId = new Map();
  const add = (n) => { nodes.push(n); byId.set(n.id, n); return n.id; };
  const humanIds = new Map();

  const msg = (title, directType, directData, extra = {}) => add({
    id: nextId("m"), type: "message", title: clip(title, 60) || "Message", sub: "",
    templateId: "", bindings: {}, messageMode: "direct", directType, directData, ...extra,
  });

  const f = {
    nodes, edges, ctx,

    trigger(t) {
      const base = { id: "trigger1", type: "trigger", x: 0, y: 0, title: t.title || "Trigger", sub: t.sub || "", triggerAccounts: t.accounts || [] };
      let fields = {};
      if (t.kind === "keyword") fields = { triggerKind: "keyword", keyword: t.keyword || "", matchType: t.matchType || "exact", caseSensitive: false, triggerDirection: "inbound", landingSource: "" };
      else if (t.kind === "link") fields = { triggerKind: "link", trackingCode: t.trackingCode || "" };
      else if (t.kind === "tagApplied") fields = { triggerKind: "tagApplied", tag: t.tag || "", tagDirection: "added", fireOncePerTag: true };
      else fields = { triggerKind: t.kind };
      return add({ ...base, ...fields });
    },

    text(title, body) { return msg(title, "text", { body: String(body || "") }); },

    /** A free-text question; branches: `replied`. */
    ask(title, body) {
      return msg(title, "text", { body: String(body || "") }, { waitForReply: true, waitTimeoutHours: 24 });
    },

    /** Reply buttons; branches: `btn:0..2` + `nomatch`. */
    buttons(title, body, labels, opts = {}) {
      const bs = (labels || []).map((l) => clip(l, LIMITS.button)).filter(Boolean).slice(0, LIMITS.buttons);
      return msg(title, "quick_reply", { body: String(body || ""), buttons: bs.map((t) => ({ title: t })), ...(opts.footer ? { footer: opts.footer } : {}) },
        { waitForReply: true, waitTimeoutHours: 24 });
    },

    /** A list menu; branches: `row:0:<i>` + `nomatch`. rows: [{title, description}] */
    list(title, body, buttonText, rows, sectionTitle = "Options") {
      const rs = (rows || [])
        .map((r) => (typeof r === "string" ? { title: r } : r))
        .filter((r) => r && String(r.title || "").trim())
        .slice(0, LIMITS.rows)
        .map((r) => ({ title: clip(r.title, LIMITS.row), ...(r.description ? { description: clip(r.description, LIMITS.rowDesc) } : {}) }));
      return msg(title, "list", {
        body: String(body || ""), button_text: clip(buttonText || "Choose", LIMITS.listButton),
        sections: [{ title: clip(sectionTitle, LIMITS.section), rows: rs }],
      }, { waitForReply: true, waitTimeoutHours: 24 });
    },

    /** A tappable link button. WhatsApp reports nothing on tap, so it cannot branch. */
    cta(title, body, buttonText, url) {
      return msg(title, "cta_url", { body: String(body || ""), button_text: clip(buttonText || "Open", LIMITS.button), url: String(url || "") });
    },

    /** Media from the Media Library (preferred) or a public URL. Returns null when neither is set. */
    media(kind, title, src, caption, filename) {
      if (!src || (!src.mediaLibraryId && !src.url)) return null;
      const dd = { caption: kind === "audio" ? "" : String(caption || "") };
      if (src.mediaLibraryId) dd.mediaLibraryId = src.mediaLibraryId; else dd.url = src.url;
      if (kind === "document") dd.filename = filename || src.name || "document.pdf";
      return msg(title, kind, dd);
    },

    delay(seconds = 2, title) {
      return add({ id: nextId("d"), type: "delay", title: title || `Pause ${seconds}s`, sub: "",
        delayMode: "duration", waitValue: String(seconds), waitUnit: "seconds", useContactTz: false });
    },

    actions(title, acts) {
      const list = (acts || []).filter(Boolean);
      if (!list.length) return null;
      return add({ id: nextId("a"), type: "action", title: clip(title, 60), sub: "Run one or more actions",
        actions: list.map((a, i) => ({ id: `${nextId("x")}_${i}`, ...a })) });
    },

    /** Move the lead to a funnel stage — skipped when this workspace has no such stage. */
    stage(title, stageKey) {
      if (Array.isArray(ctx.stageKeys) && !ctx.stageKeys.includes(stageKey)) return null;
      return f.actions(title, [{ kind: "Set Funnel Stage", value: stageKey }]);
    },
    /** Store a value on the lead (name, email, city, profession, …). */
    saveField(title, field, value = "{{answer}}") {
      return f.actions(title, [{ kind: "Set Lead Field", field, fieldKey: field, value }]);
    },
    /** Add a tag — only when one was chosen (Add Tag fails on a tag that does not exist). */
    tag(title, tagName) {
      if (!tagName) return null;
      return f.actions(title, [{ kind: "Add Tag", value: tagName }]);
    },

    /** Business-hours check (Mon–Sat 09:00–18:00 IST). Branches: yes / no. */
    businessHours(title = "During business hours?") {
      return add({ id: nextId("c"), type: "condition", title, sub: "Check contact data or message", matchMode: "all",
        rules: [{ source: "time", field: "Current time", op: "equals", value: "business" }] });
    },

    /** One shared "a person will reply" step per flow, for typed answers and talk-to-us taps. */
    human(text) {
      const body = text || ctx.humanReply || "Thanks! A member of our team will reply to you here shortly.";
      if (humanIds.has(body)) return humanIds.get(body);
      const t = f.text("Hand over to the team", body);
      const s = f.stage("Mark lead as engaged", "engaged");
      const tg = f.tag("Tag: needs a person", ctx.humanTag);
      f.chain(t, s, tg);
      humanIds.set(body, t);
      return t;
    },

    /** Wire from → to. Inserts the 2s pacing delay where a text/media step feeds an interactive one. */
    link(from, to, handle = "default") {
      if (!from || !to) return;
      const a = byId.get(from), b = byId.get(to);
      const plainFrom = a && a.type === "message" && !a.waitForReply && (a.directType === "text" || MEDIA.has(a.directType));
      const interactiveTo = b && b.type === "message" && INTERACTIVE.has(b.directType);
      if (plainFrom && interactiveTo && handle === "default") {
        const d = f.delay(2);
        edges.push({ from, to: d, fromHandle: "default" });
        edges.push({ from: d, to, fromHandle: "default" });
        return;
      }
      edges.push({ from, to, fromHandle: handle });
    },

    /** Link a run of steps on their default handles, skipping nulls (optional steps). */
    chain(...ids) {
      const xs = ids.flat().filter(Boolean);
      for (let i = 0; i < xs.length - 1; i++) {
        const a = byId.get(xs[i]);
        const handle = a && a.waitForReply && !INTERACTIVE.has(a.directType) ? "replied" : "default";
        f.link(xs[i], xs[i + 1], handle);
      }
      return xs[xs.length - 1] || null;
    },

    /** Wire each button / row of an interactive step. targets[i] is the step for option i. */
    branch(from, targets, { fallback = true } = {}) {
      const n = byId.get(from);
      if (!n) return;
      const isList = n.directType === "list";
      targets.forEach((to, i) => { if (to) f.link(from, to, isList ? `row:0:${i}` : `btn:${i}`); });
      if (fallback) f.link(from, f.human(), "nomatch");
    },

    build() { return { nodes: layout(nodes, edges), edges }; },
  };
  return f;
}

/** Left-to-right by depth from the trigger; each column stacked by real card height. */
function layout(nodes, edges) {
  const depth = new Map([["trigger1", 0]]);
  const order = ["trigger1"];
  for (let i = 0; i < order.length && i < nodes.length * 4; i++) {
    const id = order[i];
    edges.filter((e) => e.from === id).forEach((e) => {
      if (!depth.has(e.to)) { depth.set(e.to, depth.get(id) + 1); order.push(e.to); }
    });
  }
  nodes.forEach((n) => { if (!depth.has(n.id)) { depth.set(n.id, 1); order.push(n.id); } });
  const colY = new Map();
  const GAP_X = NODE_W + 110, GAP_Y = 60;
  const placed = new Map();
  order.forEach((id) => {
    const n = nodes.find((x) => x.id === id);
    if (!n || placed.has(id)) return;
    const d = depth.get(id);
    const y = colY.get(d) ?? 120;
    placed.set(id, { x: 120 + d * GAP_X, y });
    colY.set(d, y + nodeH(n) + GAP_Y);
  });
  return nodes.map((n) => ({ ...n, ...placed.get(n.id) }));
}

/** Walk the "happy path" for the preview: first button / first row / replied / default. */
export function happyPath(config, limit = 14) {
  const { nodes, edges } = config;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = [];
  let cur = "trigger1";
  const seen = new Set();
  while (cur && out.length < limit && !seen.has(cur)) {
    seen.add(cur);
    const n = byId.get(cur);
    if (!n) break;
    out.push(n);
    const pref = ["default", "replied", "btn:0", "row:0:0", "yes", "no"];
    let next = null;
    for (const h of pref) {
      const e = edges.find((x) => x.from === cur && (x.fromHandle || "default") === h && x.to);
      if (e) { next = e.to; break; }
    }
    cur = next;
  }
  return out;
}
