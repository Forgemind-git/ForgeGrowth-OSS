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
