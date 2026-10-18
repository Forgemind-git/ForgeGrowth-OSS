import { Zap, Send, Sparkles, ListChecks, GitBranch, Shuffle, Clock, ClipboardList, ArrowRightCircle, MessageCircle, MessageSquare, Reply, AtSign, UserPlus } from "lucide-react";

// Node registry for the Flow Builder. `ink` is a theme token name from
// constants.js C (each step type gets its own hue, like ManyChat's palette).
// Mirrors backend services/flowEngine.js EXEC — keep the two in sync.
export const NODE_TYPES = {
  trigger:    { label: "When…",               Icon: Zap,              ink: "green" },
  message:    { label: "Send Message",        Icon: Send,             ink: "blue",   hint: "Text, buttons, images, cards and quick replies" },
  collect:    { label: "Ask a Question",      Icon: ClipboardList,    ink: "purple", hint: "Collect an email, phone, name or any answer" },
  ai:         { label: "AI Step",             Icon: Sparkles,         ink: "pink",   hint: "Let an AI model write the reply" },
  action:     { label: "Perform Actions",     Icon: ListChecks,       ink: "amber",  hint: "Tag, set fields, notify your team, webhooks, Sheets" },
  condition:  { label: "Condition",           Icon: GitBranch,        ink: "blue",   hint: "Branch on tags, fields, follows, time" },
  follow:     { label: "Follow Check",        Icon: UserPlus,         ink: "green",  hint: "Ask non-followers to follow, then check again" },
  randomizer: { label: "Randomizer",          Icon: Shuffle,          ink: "purple", hint: "A/B test different paths" },
  delay:      { label: "Smart Delay",         Icon: Clock,            ink: "primary", hint: "Wait minutes, hours or days" },
  goto:       { label: "Start another Automation", Icon: ArrowRightCircle, ink: "green", hint: "Jump into another flow" },
};
export const NEXT_STEP_MENU = ["message", "collect", "follow", "ai", "action", "condition", "randomizer", "delay", "goto"];

export const TRIGGER_KINDS = [
  { id: "comment",       label: "Post or Reel comment", Icon: MessageCircle },
  { id: "dm",            label: "Direct message",        Icon: MessageSquare },
  { id: "story_reply",   label: "Story reply",           Icon: Reply },
  { id: "story_mention", label: "Story mention",         Icon: AtSign },
  // No Instagram event fires this: only a "Start another Automation" step sends people here.
  { id: "called",        label: "Started by another automation", Icon: ArrowRightCircle },
];

export const rid = () => Math.random().toString(36).slice(2, 9);

export function defaultData(type) {
  switch (type) {
    case "trigger":    return { triggers: [] };
    case "message":    return { blocks: [{ id: rid(), type: "text", text: "", buttons: [] }], quickReplies: [] };
    case "collect":    return { prompt: "What's your email address?", kind: "email", field: "email", retryText: "", skipLabel: "" };
    case "ai":         return { modelId: "", model: "", instructions: "You are a friendly assistant for this Instagram business. Answer briefly and helpfully.", saveTo: "", send: true };
    case "action":     return { actions: [{ id: rid(), kind: "add_tag", tags: [] }] };
    case "condition":  return { match: "all", rules: [{ id: rid(), subject: "tag", op: "has", key: "", value: "" }] };
    case "randomizer": return { variants: [{ id: rid(), label: "A", weight: 50 }, { id: rid(), label: "B", weight: 50 }] };
    case "delay":      return { amount: 1, unit: "hours" };
    case "goto":       return { flowId: "" };
    case "follow":     return { askText: "Almost there! Please follow @{account} first, then tap the button below.", button: "I've followed", maxAsks: 2, openText: "Thanks! Tap below to continue.", openButton: "Continue" };
    default:           return {};
  }
}

export function newTrigger(kind) {
  if (kind === "comment") return { id: rid(), kind, postMode: "any", mediaId: "", keywords: [], exclude: [], anyWord: false, match: "contains", replyTexts: ["Thanks! Please see DMs.", "Sent you a message! Check it out!", "Nice! Check your DMs!"], oncePerUser: true, includeReplies: false };
  if (kind === "dm") return { id: rid(), kind, keywords: [], exclude: [], anyWord: false, match: "contains" };
  if (kind === "story_reply") return { id: rid(), kind, keywords: [], exclude: [], anyWord: true, match: "contains" };
  return { id: rid(), kind };
}

// Readable one-liner for a trigger (node card + automation list).
export function triggerText(t) {
  if (!t) return "No trigger yet";
  const words = t.anyWord || !(t.keywords || []).length ? "any word" : `“${t.keywords.slice(0, 3).join("”, “")}”${t.keywords.length > 3 ? "…" : ""}`;
  if (t.kind === "comment") return `Comments ${words} on ${t.postMode === "one" ? "a specific post" : t.postMode === "next" ? "your next post" : "any post"}`;
  if (t.kind === "dm") return (t.keywords || []).length ? `DMs ${words}` : "DMs a keyword (add one)";
  if (t.kind === "story_reply") return `Replies ${words} to your story`;
  if (t.kind === "story_mention") return "Mentions you in a story";
  if (t.kind === "called") return "Started by another automation";
  return t.kind;
}

// ── flow templates (Flow Builder) ───────────────────────────
const N = (id, type, x, y, data) => ({ id, type, position: { x, y }, data: { ...defaultData(type), ...data } });
const E = (source, sourceHandle, target) => ({ id: `${source}-${sourceHandle}-${target}`, source, sourceHandle, target });
const text = (t, buttons = []) => ({ id: rid(), type: "text", text: t, buttons });
const btn = (id, title, kind = "next", url = "") => ({ id, title, kind, url });

export function blankGraph(kind) {
  return { nodes: [N("trigger", "trigger", 0, 120, { triggers: kind ? [newTrigger(kind)] : [] })], edges: [] };
}

export const FLOW_TEMPLATES = [
  {
    id: "grow_followers", goal: "followers", trigger: "comment", title: "Grow followers from comments",
    body: "Hand over the link only after they follow you.",
    graph: () => ({
      nodes: [
        N("trigger", "trigger", 0, 120, { triggers: [{ ...newTrigger("comment"), keywords: ["link"] }] }),
        // The private reply opens with a button: Instagram only lets us check follows after they tap.
        N("m1", "message", 380, 80, { blocks: [text("Hey {first_name}! Thanks for the comment. Tap below and I'll send it over.", [btn("b1", "Send me the link")])] }),
        N("f1", "follow", 760, 60, { askText: "Almost there! Follow @{account} first, then tap the button below.", button: "I've followed", maxAsks: 2 }),
        N("m2", "message", 1140, 0, { blocks: [text("Thanks for following! Here's your link:", [btn("b2", "Open link", "url", "https://")])] }),
        N("m3", "message", 1140, 260, { blocks: [text("No problem! Follow @{account} whenever you're ready and comment again to get the link.")] }),
      ],
      edges: [E("trigger", "next", "m1"), E("m1", "btn:b1", "f1"), E("f1", "yes", "m2"), E("f1", "no", "m3")],
    }),
  },
  {
    id: "dm_followers_link", goal: "followers", trigger: "dm", title: "Follow-to-unlock from DMs",
    body: "DM keyword → Follow Check (asks up to twice) → link, with a polite fallback. Extend it on the canvas.",
    graph: () => ({
      nodes: [
        N("trigger", "trigger", 0, 120, { triggers: [{ ...newTrigger("dm"), keywords: ["link", "guide"] }] }),
        N("f1", "follow", 380, 80, { askText: "Hi {first_name}! This one's for followers. Follow @{account}, then tap the button below.", button: "I've followed", maxAsks: 2 }),
        N("m1", "message", 760, 0, { blocks: [text("Thanks for following! Here it is:", [btn("b1", "Open link", "url", "https://")])] }),
        N("m2", "message", 760, 260, { blocks: [text("No worries! Follow @{account} and message us again any time.")] }),
      ],
      edges: [E("trigger", "next", "f1"), E("f1", "yes", "m1"), E("f1", "no", "m2")],
    }),
  },
  {
    id: "story_leads", goal: "leads", trigger: "story_reply", title: "Generate leads with stories",
    body: "Turn story replies into emails, then alert your team.",
    graph: () => ({
      nodes: [
        N("trigger", "trigger", 0, 120, { triggers: [newTrigger("story_reply")] }),
        N("m1", "message", 380, 100, { blocks: [text("Thanks for replying to our story! Want the offer?")], quickReplies: [{ id: "q1", title: "Yes, send it" }, { id: "q2", title: "Not now" }] }),
        N("q", "collect", 760, 40, { prompt: "Great! What's your email? We'll send it there.", kind: "email", field: "email" }),
        N("a", "action", 1140, 40, { actions: [{ id: rid(), kind: "add_tag", tags: [] }, { id: rid(), kind: "notify", title: "New story lead", body: "@{username} left their email: {email}" }] }),
        N("m2", "message", 1520, 40, { blocks: [text("Done! Check your inbox, {first_name}.")] }),
        N("m3", "message", 760, 280, { blocks: [text("No worries! Message us any time.")] }),
      ],
      edges: [E("trigger", "next", "m1"), E("m1", "qr:q1", "q"), E("m1", "qr:q2", "m3"), E("q", "next", "a"), E("a", "next", "m2")],
    }),
  },
  {
    id: "dm_menu", goal: "engage", trigger: "dm", title: "Respond to all your DMs",
    body: "Greet people with a menu of quick answers.",
    graph: () => ({
      nodes: [
        N("trigger", "trigger", 0, 160, { triggers: [{ ...newTrigger("dm"), keywords: ["hi", "hello", "info"] }] }),
        N("m1", "message", 380, 140, { blocks: [text("Hi {first_name}! What can we help you with?")], quickReplies: [{ id: "q1", title: "Pricing" }, { id: "q2", title: "Courses" }, { id: "q3", title: "Talk to us" }] }),
        N("m2", "message", 760, 0, { blocks: [text("Our plans start at …", [btn("b1", "See pricing", "url", "https://")])] }),
        N("m3", "message", 760, 200, { blocks: [text("Here are our courses:", [btn("b2", "View courses", "url", "https://")])] }),
        N("a", "action", 760, 400, { actions: [{ id: rid(), kind: "notify", title: "Someone wants to talk", body: "@{username} asked for a person" }] }),
        N("m4", "message", 1140, 400, { blocks: [text("Got it! A teammate will reply here shortly.")] }),
      ],
      edges: [E("trigger", "next", "m1"), E("m1", "qr:q1", "m2"), E("m1", "qr:q2", "m3"), E("m1", "qr:q3", "a"), E("a", "next", "m4")],
    }),
  },
  {
    id: "comment_phone_sheet", goal: "leads", trigger: "comment", title: "Comments → phone numbers in a Sheet",
    body: "Ask commenters for name and phone, save to Google Sheets.",
    graph: () => ({
      nodes: [
        N("trigger", "trigger", 0, 120, { triggers: [{ ...newTrigger("comment"), keywords: ["details"] }] }),
        N("m1", "message", 380, 100, { blocks: [text("Hi {first_name}! Tap below and I'll share the details.", [btn("b1", "Get details")])] }),
        N("q1", "collect", 760, 100, { prompt: "What's your name?", kind: "name", field: "name" }),
        N("q2", "collect", 1140, 100, { prompt: "And your phone number?", kind: "phone", field: "phone" }),
        N("a", "action", 1520, 100, { actions: [{ id: rid(), kind: "sheet", sheetId: "", tab: "Leads", columns: "{username}, {name}, {phone}" }, { id: rid(), kind: "notify", title: "New lead", body: "{name} · {phone}" }] }),
        N("m2", "message", 1900, 100, { blocks: [text("Thanks {name}! Our team will call you soon.")] }),
      ],
      edges: [E("trigger", "next", "m1"), E("m1", "btn:b1", "q1"), E("q1", "next", "q2"), E("q2", "next", "a"), E("a", "next", "m2")],
    }),
  },
  {
    id: "quiz", goal: "engage", trigger: "dm", title: "Qualify with a quiz",
    body: "Ask a question, tag people by their answer.",
    graph: () => ({
      nodes: [
        N("trigger", "trigger", 0, 160, { triggers: [{ ...newTrigger("dm"), keywords: ["quiz"] }] }),
        N("m1", "message", 380, 140, { blocks: [text("Quick question: what's your experience level?")], quickReplies: [{ id: "q1", title: "Beginner" }, { id: "q2", title: "Intermediate" }, { id: "q3", title: "Advanced" }] }),
        N("a1", "action", 760, 0, { actions: [{ id: rid(), kind: "set_field", key: "level", value: "beginner" }] }),
        N("a2", "action", 760, 180, { actions: [{ id: rid(), kind: "set_field", key: "level", value: "intermediate" }] }),
        N("a3", "action", 760, 360, { actions: [{ id: rid(), kind: "set_field", key: "level", value: "advanced" }] }),
        N("m2", "message", 1140, 180, { blocks: [text("Thanks! Here's what we recommend for a {level} learner:", [btn("b1", "See it", "url", "https://")])] }),
      ],
      edges: [E("trigger", "next", "m1"), E("m1", "qr:q1", "a1"), E("m1", "qr:q2", "a2"), E("m1", "qr:q3", "a3"), E("a1", "next", "m2"), E("a2", "next", "m2"), E("a3", "next", "m2")],
    }),
  },
  {
    id: "business_hours", goal: "engage", trigger: "dm", title: "Business-hours replies",
    body: "Different answer inside and outside working hours.",
    graph: () => ({
      nodes: [
        N("trigger", "trigger", 0, 120, { triggers: [{ ...newTrigger("dm"), keywords: ["help", "support"] }] }),
        N("c1", "condition", 380, 100, { rules: [{ id: rid(), subject: "time", op: "is", from: 9, to: 18 }] }),
        N("m1", "message", 760, 0, { blocks: [text("Thanks! A teammate will reply in a few minutes.")] }),
        N("m2", "message", 760, 240, { blocks: [text("We're closed right now (9am–6pm IST). We'll reply first thing tomorrow.")] }),
      ],
      edges: [E("trigger", "next", "c1"), E("c1", "yes", "m1"), E("c1", "no", "m2")],
    }),
  },
  {
    id: "ai_faq", goal: "engage", trigger: "dm", title: "AI answers to DMs",
    body: "Let an AI model reply to questions, hand off when asked.",
    graph: () => ({
      nodes: [
        N("trigger", "trigger", 0, 120, { triggers: [{ ...newTrigger("dm"), keywords: ["question", "?"] }] }),
        N("ai", "ai", 380, 100, {}),
        N("m1", "message", 760, 100, { blocks: [text("Did that help?")], quickReplies: [{ id: "q1", title: "Yes, thanks" }, { id: "q2", title: "Talk to a person" }] }),
        N("a", "action", 1140, 200, { actions: [{ id: rid(), kind: "notify", title: "Handoff requested", body: "@{username} wants a person" }] }),
      ],
      edges: [E("trigger", "next", "ai"), E("ai", "next", "m1"), E("m1", "qr:q2", "a")],
    }),
  },
  {
    id: "comment_followup", goal: "traffic", trigger: "comment", title: "Link + follow-up nudge",
    body: "Send the link, then a reminder two hours later if they haven't opened it.",
    graph: () => ({
      nodes: [
        N("trigger", "trigger", 0, 120, { triggers: [{ ...newTrigger("comment"), keywords: ["link"] }] }),
        N("m1", "message", 380, 100, { blocks: [text("Hey {first_name}! Tap below to get the link.", [btn("b1", "Get the link")])] }),
        // "If they don't respond": the reminder only goes to people who didn't tap the link or reply.
        N("m2", "message", 760, 100, { blocks: [text("Here it is:", [btn("b2", "Open", "url", "https://")])], noReply: { enabled: true, amount: 2, unit: "hours" } }),
        N("m3", "message", 1140, 160, { blocks: [text("Did you get a chance to check it out? Reply here if you have questions.", [btn("b3", "Open", "url", "https://")])] }),
      ],
      edges: [E("trigger", "next", "m1"), E("m1", "btn:b1", "m2"), E("m2", "noreply", "m3")],
    }),
  },
  // Reusable blocks: "Started by another automation" — pick them in a "Start another Automation" step.
  {
    id: "sub_collect_email", goal: "leads", trigger: "called", title: "Reusable: collect an email",
    body: "Started by your other automations: asks for an email, saves it, tags the contact and thanks them.",
    graph: () => ({
      nodes: [
        N("trigger", "trigger", 0, 120, { triggers: [newTrigger("called")] }),
        N("q", "collect", 380, 100, { prompt: "What's the best email to send it to?", kind: "email", field: "email", retryText: "That doesn't look like an email. Please try again (or type STOP to cancel)." }),
        N("a", "action", 760, 100, { actions: [{ id: rid(), kind: "add_tag", tags: [] }, { id: rid(), kind: "notify", title: "New email lead", body: "@{username} left their email: {email}" }] }),
        N("m", "message", 1140, 100, { blocks: [text("Thanks {first_name}! We'll send it to {email}.")] }),
      ],
      edges: [E("trigger", "next", "q"), E("q", "next", "a"), E("a", "next", "m")],
    }),
  },
  {
    id: "sub_handoff", goal: "engage", trigger: "called", title: "Reusable: hand off to your team",
    body: "Started by your other automations: tells the person a teammate will reply, alerts your team and keeps the AI agent quiet.",
    graph: () => ({
      nodes: [
        N("trigger", "trigger", 0, 120, { triggers: [newTrigger("called")] }),
        N("m", "message", 380, 100, { blocks: [text("Thanks {first_name}! A teammate will reply here shortly.")] }),
        N("a", "action", 760, 100, { actions: [{ id: rid(), kind: "notify", title: "Someone wants a person", body: "@{username} is waiting for a reply" }, { id: rid(), kind: "stop_ai" }] }),
      ],
      edges: [E("trigger", "next", "m"), E("m", "next", "a")],
    }),
  },
];

export const TEMPLATE_GOALS = [
  { id: "followers", label: "Grow your followers" },
  { id: "engage", label: "Engage your audience" },
  { id: "leads", label: "Collect leads" },
  { id: "traffic", label: "Drive traffic" },
];
