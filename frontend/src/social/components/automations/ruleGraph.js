import { GATE_DEFAULTS, followupPreview, delayLabel } from "./shared.jsx";

// A Quick Automation (Graph-format rule fields) as a Flow Builder graph, so the
// same simulator + player (flows/useFlowSimulator.js) can run it. Mirrors
// services/commentAutomation.js: public reply → (opening DM button → follow
// check) → the DM + tags → questions → thank-you. Only used for testing.
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "answer";

export function ruleToGraph(r, account) {
  const nodes = [], edges = [];
  const add = (id, type, data) => { nodes.push({ id, type, position: { x: nodes.length * 360, y: 0 }, data }); return id; };
  const link = (source, sourceHandle, target) => target && edges.push({ id: `${source}-${sourceHandle}-${target}`, source, sourceHandle, target });

  const kw = (r.keywords || []).filter(Boolean);
  const kind = r.trigger === "postback" ? "dm" : r.trigger;
  add("trigger", "trigger", { triggers: [{
    id: "t", kind, keywords: kw, match: r.trigger === "postback" ? "exact" : (r.match_type || "contains"),
    anyWord: !kw.length && kind !== "dm", exclude: [],
    replyTexts: (r.reply_texts || []).filter(Boolean), oncePerUser: r.once_per_user !== false,
  }] });

  // Build the chain backwards: thank-you ← questions ← tags ← DM.
  const collect = Array.isArray(r.collect) ? r.collect : [];
  let next = null;
  // Follow-up: a wait, then the second message (the engine skips it if they tapped
  // or replied — questions mean they reply, so it never follows a question flow).
  if (r.followup_enabled && r.dm_message && !collect.length) {
    const fu = add("followup", "message", { raw: [followupPreview(r)] });
    const cond = add("fu_note", "action", { actions: [{ id: "n", kind: "note", text: "Follow-up: only sent if they haven't tapped the link or replied, and within 24 h of their last message" }] });
    link(cond, "next", fu);
    const m = Number(r.followup_delay_min) || 240;
    const wait = add("fu_wait", "delay", m % 60 ? { amount: m, unit: "minutes" } : { amount: m / 60, unit: m === 60 ? "hour" : "hours", label: delayLabel(m) });
    link(wait, "next", cond);
    next = wait;
  }
  if (collect.length) {
    const fields = collect.map(q => q.key || slug(q.label || q.type));
    next = add("lead", "action", { actions: [{ id: "n", kind: "note", text: "Lead saved: " + collect.map((q, i) => `${q.label || q.type}: {${fields[i]}}`).join(" · ") }] });
    const done = add("done", "message", { raw: [{ text: r.collect_done_text || GATE_DEFAULTS.collect_done_text }] });
    link(done, "next", next); next = done;
    for (let i = collect.length - 1; i >= 0; i--) {
      const q = collect[i];
      const id = add(`q${i}`, "collect", { prompt: q.prompt || "…", kind: q.type === "text" ? "text" : q.type, field: fields[i] });
      link(id, "next", next); next = id;
    }
  }
  if (r.tags?.length) { const id = add("tags", "action", { actions: [{ id: "a", kind: "add_tag", tags: r.tags }] }); link(id, "next", next); next = id; }
  if (r.dm_message) { const id = add("dm", "message", { raw: [r.dm_message] }); link(id, "next", next); next = id; }

  // DM / story / button triggers: the follow check comes straight away.
  if (r.follow_gate && r.trigger !== "comment") {
    const cond = add("follows", "condition", { match: "all", rules: [{ id: "f", subject: "follows", op: "is" }] });
    const ask = add("follow_ask", "message", { blocks: [{ id: "b", type: "text", text: (r.follow_gate_text || GATE_DEFAULTS.follow_gate_text).replace(/\{account\}/g, account || "us"), buttons: [{ id: "fg", title: "I've followed", kind: "next" }] }], quickReplies: [] });
    link(cond, "yes", next); link(cond, "no", ask); link(ask, "btn:fg", cond);
    next = cond;
  }

  // Comment automations with a follow check / questions open with a button first.
  const gated = r.trigger === "comment" && (r.opening_dm || r.follow_gate || collect.length > 0 || r.followup_enabled);
  if (gated) {
    let afterGate = next;
    if (r.follow_gate) {
      const cond = add("follows", "condition", { match: "all", rules: [{ id: "f", subject: "follows", op: "is" }] });
      const ask = add("follow_ask", "message", { blocks: [{ id: "b", type: "text", text: (r.follow_gate_text || GATE_DEFAULTS.follow_gate_text).replace(/\{account\}/g, account || "us"), buttons: [{ id: "fg", title: "I've followed", kind: "next" }] }], quickReplies: [] });
      link(cond, "yes", next); link(cond, "no", ask); link(ask, "btn:fg", cond);
      afterGate = cond;
    }
    const gate = add("gate", "message", { blocks: [{ id: "b", type: "text", text: r.gate_text || GATE_DEFAULTS.gate_text, buttons: [{ id: "g", title: r.gate_button || GATE_DEFAULTS.gate_button, kind: "next" }] }], quickReplies: [] });
    link(gate, "btn:g", afterGate);
    next = gate;
  }
  link("trigger", "next", next);
  return { nodes, edges };
}
