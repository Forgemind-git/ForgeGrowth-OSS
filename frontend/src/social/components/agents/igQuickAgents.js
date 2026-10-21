import { HelpCircle, MessageCircle, UserPlus, GraduationCap, CalendarCheck, LifeBuoy, KeyRound } from "lucide-react";

/**
 * Quick Instagram AI agents — the presets behind Automations → AI Agents.
 *
 * Same idea as the WhatsApp Quick AI Agents (components/agents/quickAgents.js
 * in the main app): a preset is a few plain questions about the business plus
 * a `build` that writes the system prompt, so nobody has to write one. Nothing
 * here is stored — a quick agent is an ordinary Social agent
 * (backend services/agentService.js) and reopens as one.
 *
 * `replyDms` / `replyComments` are only the preset's starting point; the
 * editor lets the operator switch either on or off.
 */

export const IG_TONES = [
  { id: "friendly", label: "Friendly", line: "Be warm and friendly, like a helpful person on the team." },
  { id: "professional", label: "Professional", line: "Be polite, clear and professional." },
  { id: "short", label: "Short & simple", line: "Keep every reply very short and simple — one or two sentences." },
];

export const IG_LANGUAGES = [
  { id: "match", label: "Match the follower", line: "Reply in the language the person writes in (English, Tamil or a mix)." },
  { id: "english", label: "English only", line: "Always reply in English." },
  { id: "tanglish", label: "Tamil + English", line: "Reply in a natural Tamil-English mix (Tanglish) written in English letters." },
];

const has = (v) => !!String(v || "").trim();
const line = (label, v) => (has(v) ? `- ${label}: ${String(v).trim()}` : null);
const lines = (...xs) => xs.filter(Boolean).join("\n");
const who = (v) => `You are the Instagram assistant for ${has(v.business) ? v.business.trim() : "our business"}.`;

// The parts every Instagram quick agent shares: who it is, how to talk, where
// it is answering (DM vs a PUBLIC comment), and the safety rules.
function compose({ intro, knowledge, job, tone, language, dms, comments }) {
  const t = IG_TONES.find(x => x.id === tone) || IG_TONES[0];
  const l = IG_LANGUAGES.find(x => x.id === language) || IG_LANGUAGES[0];
  const where = [
    dms ? "- In a DM: reply in 2-4 short sentences, like a person typing on Instagram." : null,
    comments ? "- On a comment: your reply is PUBLIC. One short friendly sentence. Never share prices, phone numbers or personal details there — invite them to DM instead." : null,
  ];
  return lines(
    intro,
    knowledge ? `\nWhat you know:\n${knowledge}` : null,
    job ? `\nYour job:\n${job}` : null,
    `\nHow to reply:\n- ${t.line}\n- ${l.line}`,
    ...where,
    "- Never invent prices, dates, offers or promises. If you do not know, say a team member will reply soon.",
  );
}

const BUSINESS = { key: "business", label: "Business or page name", placeholder: "e.g. Acme Academy", required: true };

export const IG_QUICK_AGENTS = [
  {
    id: "ig_faq", goal: "questions", popular: true, Icon: HelpCircle,
    title: "Answer DM questions",
    body: "Replies to DMs about what you sell, prices, timings and where you are.",
    keywords: "faq questions prices dm inbox answer",
    name: "Instagram FAQ assistant", replyDms: true, replyComments: false, triggerMode: "any",
    fields: [
      BUSINESS,
      { key: "offer", label: "What you sell, with prices", placeholder: "e.g. Data Analytics Bootcamp — ₹9,999, 8 weeks, online", multiline: true, required: true },
      { key: "timings", label: "Timings / location", placeholder: "e.g. Mon–Sat 10am–7pm · Coimbatore + online" },
      { key: "extra", label: "Anything else it should know", placeholder: "e.g. EMI available, certificate on completion", multiline: true },
    ],
    build: (v, s) => compose({ ...s, intro: who(v),
      knowledge: lines(line("What we sell", v.offer), line("Timings / location", v.timings), line("Also", v.extra)),
      job: "- Answer questions about the above.\n- End with one helpful next step, e.g. asking which option they are interested in." }),
  },
  {
    id: "ig_comments", goal: "engage", popular: true, Icon: MessageCircle,
    title: "Reply to comments",
    body: "Answers comments on your posts and reels with a short public reply, and moves real questions to DM.",
    keywords: "comments reels posts public reply engagement",
    name: "Comment replier", replyDms: false, replyComments: true, triggerMode: "any",
    fields: [
      BUSINESS,
      { key: "about", label: "What your posts are about", placeholder: "e.g. AI tools, automation tips, our courses", required: true },
      { key: "cta", label: "Where to send interested people", placeholder: "e.g. DM us “COURSE” or tap the link in bio" },
    ],
    build: (v, s) => compose({ ...s, intro: who(v),
      knowledge: lines(line("Our posts are about", v.about), line("Where to send interested people", v.cta)),
      job: "- Thank people, answer simple questions in one line, and point anyone asking about prices or joining to DM." + (has(v.cta) ? `\n- When it fits, mention: ${v.cta.trim()}` : "") }),
  },
  {
    id: "ig_leads", goal: "leads", popular: true, Icon: UserPlus,
    title: "Turn DMs into leads",
    body: "Greets people who DM, finds out what they need, and asks for their WhatsApp number so the team can follow up.",
    keywords: "leads qualify enquiry whatsapp number sales capture",
    name: "Lead qualifier", replyDms: true, replyComments: false, triggerMode: "any",
    fields: [
      BUSINESS,
      { key: "offer", label: "What you offer", placeholder: "e.g. AI courses for working professionals", required: true },
      { key: "ask", label: "What to find out", placeholder: "e.g. their profession, goal and when they want to start" },
    ],
    build: (v, s) => compose({ ...s, intro: who(v),
      knowledge: line("What we offer", v.offer),
      job: lines(
        "- Greet them and find out what they need, one question at a time.",
        has(v.ask) ? `- Find out: ${v.ask.trim()}.` : null,
        "- Then ask for their WhatsApp number so the team can share details there.",
        "- Once you have it, thank them and say a team member will message them soon.") }),
  },
  {
    id: "ig_course", goal: "sales", Icon: GraduationCap,
    title: "Course or product enquiry",
    body: "Explains one course or product — price, duration, dates — on DMs and comments, and shares the link.",
    keywords: "course product price batch fees link enroll education",
    name: "Course enquiry assistant", replyDms: true, replyComments: true, triggerMode: "any",
    fields: [
      BUSINESS,
      { key: "course", label: "Course or product name", placeholder: "e.g. Data Analytics Bootcamp", required: true },
      { key: "details", label: "Price, duration and dates", placeholder: "e.g. ₹7,499 · 6 weeks · starts 5 Nov · weekends", multiline: true, required: true },
      { key: "link", label: "Link to share in DMs", placeholder: "e.g. https://example.com" },
    ],
    build: (v, s) => compose({ ...s, intro: who(v),
      knowledge: lines(line("Course", v.course), line("Details", v.details), line("Link", v.link)),
      job: "- Explain the course clearly and answer questions about it." + (has(v.link) ? "\n- In a DM, share the link when they are ready to join." : "") }),
  },
  {
    id: "ig_booking", goal: "sales", Icon: CalendarCheck,
    title: "Book calls & demos",
    body: "Collects a preferred day and time for a call, demo or consultation from DMs.",
    keywords: "booking appointment schedule demo call consultation",
    name: "Booking assistant", replyDms: true, replyComments: false, triggerMode: "any",
    fields: [
      BUSINESS,
      { key: "what", label: "What they can book", placeholder: "e.g. a free 15-minute career call", required: true },
      { key: "slots", label: "When you are available", placeholder: "e.g. Mon–Fri, 11am–6pm IST" },
    ],
    build: (v, s) => compose({ ...s, intro: who(v),
      knowledge: lines(line("What they can book", v.what), line("Available", v.slots)),
      job: "- Help them book. Ask for their name, preferred day and time, and a WhatsApp number.\n- Confirm the details back and say the team will send the confirmation." }),
  },
  {
    id: "ig_support", goal: "support", Icon: LifeBuoy,
    title: "Help existing customers",
    body: "Answers common questions from people who already bought, and hands the rest to your team.",
    keywords: "support help customers complaint issue access refund",
    name: "Support assistant", replyDms: true, replyComments: false, triggerMode: "any",
    fields: [
      BUSINESS,
      { key: "common", label: "Common questions and answers", placeholder: "e.g. Class recordings are in the portal within 24h; certificates are emailed after the last class", multiline: true, required: true },
      { key: "contact", label: "How to reach the team", placeholder: "e.g. WhatsApp 98765 43210" },
    ],
    build: (v, s) => compose({ ...s, intro: who(v),
      knowledge: lines(line("Common questions", v.common), line("Team contact", v.contact)),
      job: "- Help with the common questions above.\n- For anything else, apologise briefly and say the team will reply" + (has(v.contact) ? `, or share: ${v.contact.trim()}.` : ".") }),
  },
  {
    id: "ig_keyword", goal: "leads", Icon: KeyRound,
    title: "Reply to a keyword",
    body: "Only wakes up when someone DMs or comments a word — like PRICE or JOIN — then chats about that offer.",
    keywords: "keyword trigger word campaign price join reel",
    name: "Keyword agent", replyDms: true, replyComments: true, triggerMode: "keyword", keyword: "PRICE",
    fields: [
      BUSINESS,
      { key: "offer", label: "The offer this keyword is for", placeholder: "e.g. Diwali batch — ₹5,999 instead of ₹7,499 till 31 Oct", multiline: true, required: true },
      { key: "link", label: "Link to share in DMs", placeholder: "e.g. https://example.com" },
    ],
    build: (v, s) => compose({ ...s, intro: who(v),
      knowledge: lines(line("The offer", v.offer), line("Link", v.link)),
      job: "- Someone asked about this offer. Explain it briefly and answer their questions." + (has(v.link) ? "\n- In a DM, share the link." : "") }),
  },
];

export const igInitialAnswers = (t) => Object.fromEntries((t?.fields || []).map(f => [f.key, ""]));
export const igMissingAnswers = (t, answers) => (t?.fields || []).filter(f => f.required && !has(answers[f.key])).map(f => f.label);

// Customer-facing quick agents get NO business-data tools: an Instagram
// follower must never be able to ask the agent for follower counts, other
// people's DMs. (Defaults would otherwise switch
// analytics/content/inbox on.)
export const IG_AGENT_CAPABILITIES = { analytics: false, content: false, inbox: false, contacts: false, engage: false };
