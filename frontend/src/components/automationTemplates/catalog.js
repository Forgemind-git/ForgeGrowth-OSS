/**
 * The WhatsApp automation template library.
 *
 * Organised the way the most-used WhatsApp tools organise theirs (AiSensy and
 * WATI both file flows by industry, with general welcome / FAQ / away flows
 * beside them): INDUSTRY → SUB-DIVISION, plus a goal and a trigger on every
 * template so the picker can be sliced three ways.
 *
 * Each template carries:
 *   fields  — the Quick-setup form (every field has a working default, so a
 *             template is usable without typing anything)
 *   trigger — how the flow starts; the setup form edits keyword / tracking
 *             code / tag for it
 *   build(v, ctx) — the flow, written with flowKit (see flowKit.js for the
 *             shapes and the pacing/layout rules applied automatically)
 *
 * Nothing here talks to the server. A template becomes a DRAFT automation via
 * the ordinary create call, so going live still passes the builder's own
 * activation check.
 */
import { createFlow } from "./flowKit.js";

// ── Taxonomy ──────────────────────────────────────────────────────────────
export const INDUSTRIES = [
  { id: "ecommerce",  label: "E-commerce & retail", icon: "ShoppingBag",     subs: [
    { id: "sales", label: "Sales & offers" }, { id: "orders", label: "Orders & delivery" }, { id: "after", label: "Returns & reviews" } ] },
  { id: "support",    label: "Customer care",       icon: "LifeBuoy",        subs: [
    { id: "helpdesk", label: "FAQs & help desk" }, { id: "tickets", label: "Complaints & service" }, { id: "feedback", label: "Feedback & surveys" } ] },
  { id: "services",   label: "Services & bookings", icon: "CalendarCheck",   subs: [
    { id: "booking", label: "Appointments" }, { id: "quotes", label: "Quotes & pricing" } ] },
  { id: "education",  label: "Education & coaching", icon: "GraduationCap",  subs: [
    { id: "courses", label: "Course enquiries" }, { id: "admissions", label: "Admissions & demos" } ] },
  { id: "realestate", label: "Real estate",         icon: "Building2",       subs: [
    { id: "enquiry", label: "Property enquiries" }, { id: "visits", label: "Site visits" } ] },
  { id: "health",     label: "Healthcare & clinics", icon: "Stethoscope",    subs: [
    { id: "appointments", label: "Appointments" }, { id: "patients", label: "Patient information" } ] },
  { id: "food",       label: "Restaurants & food",  icon: "UtensilsCrossed", subs: [
    { id: "orders", label: "Menu & orders" }, { id: "tables", label: "Reservations" } ] },
  { id: "travel",     label: "Travel & hospitality", icon: "Plane",          subs: [
    { id: "packages", label: "Packages & enquiries" }, { id: "stays", label: "Stays & bookings" } ] },
  { id: "wellness",   label: "Beauty, salon & fitness", icon: "Sparkles",    subs: [
    { id: "salon", label: "Salon & spa" }, { id: "fitness", label: "Gym & fitness" } ] },
  { id: "leads",      label: "Lead generation",     icon: "Megaphone",       subs: [
    { id: "ads", label: "Ads & links" }, { id: "capture", label: "Capture & qualify" }, { id: "events", label: "Events & webinars" } ] },
  { id: "engagement", label: "Engagement & retention", icon: "HeartHandshake", subs: [
    { id: "welcome", label: "Welcome" }, { id: "winback", label: "Win-back & loyalty" }, { id: "compliance", label: "Opt-out" } ] },
];

export const GOALS = [
  { id: "leads",   label: "Capture leads" },
  { id: "sell",    label: "Sell more" },
  { id: "book",    label: "Book appointments" },
  { id: "support", label: "Support customers" },
  { id: "retain",  label: "Engage & retain" },
];

export const TRIGGERS = [
  { id: "keyword",    label: "Keyword message",  desc: "Someone sends a word, e.g. PRICE" },
  { id: "link",       label: "Ad or wa.me link", desc: "Someone taps a tracked link" },
  { id: "newContact", label: "New contact",      desc: "Someone messages for the first time" },
  { id: "anyMessage", label: "Any message",      desc: "Every inbound message" },
  { id: "tagApplied", label: "Tag added",        desc: "A tag is added to a contact" },
];

// ── Shared field definitions ──────────────────────────────────────────────
const F = {
  business: { key: "business", label: "Business name", type: "text", default: "our team", help: "Used in greetings, e.g. “Welcome to Forgemind”." },
  site: (def = "https://example.com") => ({ key: "site", label: "Website / shop link", type: "url", default: def }),
  hours: { key: "hours", label: "Working hours", type: "text", default: "Mon–Sat, 9 AM – 6 PM" },
  humanTag: { key: "humanTag", label: "Tag chats that need a person", type: "tag", default: "", help: "Optional. Leave empty to skip tagging." },
};
const bn = (v) => (v.business && v.business !== "our team" ? v.business : "us");
const opts = (v, k) => (Array.isArray(v[k]) ? v[k] : []).map((x) => (typeof x === "string" ? x : x?.title)).filter(Boolean);
const rows = (v, k) => (Array.isArray(v[k]) ? v[k] : []).filter((r) => r && r.title);
const ctxOf = (v, ctx) => ({ ...ctx, humanTag: v.humanTag || "" });

// ── Templates ─────────────────────────────────────────────────────────────
export const TEMPLATES = [

  // ═══ E-COMMERCE ═══
  {
    id: "ecom_catalogue", title: "Product catalogue menu", popular: true, kind: "quick",
    body: "Show your product categories as a menu and send a shop link for the one they pick.",
    industry: "ecommerce", sub: "sales", goal: "sell",
    trigger: { kind: "keyword", keyword: "SHOP", matchType: "exact" },
    fields: [F.business, F.site("https://yourstore.com"),
      { key: "categories", label: "Categories (up to 9)", type: "rows", max: 9, default: [
        { title: "New arrivals", description: "Fresh drops this week" }, { title: "Best sellers", description: "Customer favourites" },
        { title: "Offers", description: "Up to 40% off" } ] }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Customer asks to shop" });
      const hi = f.text("Welcome", `Hi {{first_name}} 👋 Welcome to ${bn(v)}! What are you shopping for today?`);
      const cats = rows(v, "categories");
      const menu = f.list("Category menu", "Pick a category and I'll send you the right link.", "Browse", [...cats, { title: "Talk to us", description: "Chat with our team" }], "Shop by category");
      f.chain(t, hi, menu);
      const targets = cats.map((c) => f.cta(`Link: ${c.title}`, `Great choice! Here's our *${c.title}* collection 👇`, "Shop now", v.site));
      targets.push(f.human());
      f.branch(menu, targets);
      return f.build();
    },
  },
  {
    id: "ecom_welcome_offer", title: "Welcome discount code", popular: true, kind: "quick",
    body: "Greet first-time shoppers with a discount code and a link to your store.",
    industry: "ecommerce", sub: "sales", goal: "sell",
    trigger: { kind: "keyword", keyword: "OFFER", matchType: "exact" },
    fields: [F.business, F.site("https://yourstore.com"),
      { key: "code", label: "Discount code", type: "text", default: "WELCOME10" },
      { key: "offer", label: "Offer line", type: "text", default: "10% off your first order" }],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Customer asks for the offer" });
      const m = f.text("Offer", `Hi {{first_name}}! 🎁 Here's *${v.offer}* at ${bn(v)}.\n\nUse code *${v.code}* at checkout.`);
      const c = f.cta("Shop link", "Tap below to start shopping — the code works on everything in store.", "Shop now", v.site);
      f.chain(t, m, c, f.stage("Mark lead as engaged", "engaged"));
      return f.build();
    },
  },
  {
    id: "ecom_cart_recovery", title: "Abandoned cart recovery", kind: "flow",
    body: "When a contact is tagged “Cart abandoned”, nudge them back to checkout with a code.",
    industry: "ecommerce", sub: "sales", goal: "sell", windowNote: true,
    trigger: { kind: "tagApplied", tag: "" },
    fields: [F.site("https://yourstore.com/cart"), { key: "code", label: "Recovery code", type: "text", default: "COMEBACK5" }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Tag added: cart abandoned" });
      const q = f.buttons("Still thinking?", "Hi {{first_name}}, you left a few things in your cart 🛒 Want to finish your order?", ["Complete my order", "I have a question"]);
      f.chain(t, q);
      const go = f.cta("Checkout link", `Here you go! Use *${v.code}* for an extra discount.`, "Checkout", v.site);
      f.branch(q, [go, f.human()]);
      return f.build();
    },
  },
  {
    id: "ecom_order_status", title: "Track my order", popular: true, kind: "quick",
    body: "Ask for the order ID, send the tracking page, and hand over if they still need help.",
    industry: "ecommerce", sub: "orders", goal: "support",
    trigger: { kind: "keyword", keyword: "TRACK", matchType: "exact" },
    fields: [{ key: "trackUrl", label: "Order tracking page", type: "url", default: "https://yourstore.com/track" }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Customer wants to track an order" });
      const ask = f.ask("Ask order ID", "Sure! Please type your *order ID* (you'll find it in your confirmation message).");
      const link = f.cta("Tracking link", "Thanks! You can see live status for order *{{answer}}* here:", "Track order", v.trackUrl);
      const help = f.buttons("Did that help?", "Did that answer your question?", ["Yes, thanks", "Talk to a person"]);
      f.chain(t, ask, link);
      f.link(link, help);
      f.branch(help, [f.text("Thanks", "Happy to help! 😊 Message us anytime."), f.human()]);
      return f.build();
    },
  },
  {
    id: "ecom_cod_confirm", title: "COD order confirmation", kind: "flow",
    body: "Ask cash-on-delivery buyers to confirm, cancel or change the address before you ship.",
    industry: "ecommerce", sub: "orders", goal: "sell", windowNote: true,
    trigger: { kind: "tagApplied", tag: "" },
    fields: [F.business, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Tag added: COD order" });
      const q = f.buttons("Confirm COD", `Hi {{first_name}}, thanks for ordering from ${bn(v)}! Please confirm your *cash-on-delivery* order so we can ship it.`, ["Confirm order", "Change address", "Cancel order"]);
      f.chain(t, q);
      const ok = f.text("Confirmed", "Thank you! ✅ Your order is confirmed and will be dispatched soon.");
      const addr = f.ask("Ask new address", "No problem — please type the full delivery address with PIN code.");
      f.chain(addr, f.text("Address noted", "Got it! Our team will update the address and confirm here."), f.tag("Tag: needs a person", v.humanTag));
      const cancel = f.text("Cancelled", "Okay, we've noted your cancellation. If this was a mistake, just reply here.");
      f.branch(q, [ok, addr, cancel]);
      return f.build();
    },
  },
  {
    id: "ecom_returns", title: "Returns, exchanges & refunds", kind: "flow",
    body: "Let customers pick return / exchange / refund status, collect the order ID, and log the request.",
    industry: "ecommerce", sub: "after", goal: "support",
    trigger: { kind: "keyword", keyword: "RETURN", matchType: "exact" },
    fields: [{ key: "policyUrl", label: "Return policy page", type: "url", default: "https://yourstore.com/returns" }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Customer asks about a return" });
      const menu = f.list("What do you need?", "Sorry to hear something wasn't right. What would you like to do?", "Choose", [
        { title: "Return an item" }, { title: "Exchange size/colour" }, { title: "Refund status" }, { title: "Read return policy" }]);
      f.chain(t, menu);
      const askId = f.ask("Ask order ID", "Please type your *order ID* and a short reason.");
      f.chain(askId, f.text("Request logged", "Thanks! Your request is logged ✅ Our team will confirm the next steps here within 24 hours."),
        f.tag("Tag: needs a person", v.humanTag));
      const policy = f.cta("Policy link", "Here's our full return & exchange policy:", "Read policy", v.policyUrl);
      f.branch(menu, [askId, askId, askId, policy]);
      return f.build();
    },
  },
  {
    id: "ecom_review", title: "Post-delivery review request", kind: "flow",
    body: "After delivery, ask how it went: send happy buyers to your review page, route unhappy ones to a person.",
    industry: "ecommerce", sub: "after", goal: "retain", windowNote: true,
    trigger: { kind: "tagApplied", tag: "" },
    fields: [{ key: "reviewUrl", label: "Review page", type: "url", default: "https://g.page/r/your-review-link" }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Tag added: delivered" });
      const q = f.buttons("How was it?", "Hi {{first_name}}! Your order was delivered 📦 How was your experience?", ["Loved it 😍", "It was okay", "Not happy"]);
      f.chain(t, q);
      const love = f.cta("Review link", "That makes our day! Would you leave us a quick review? It really helps 🙏", "Leave a review", v.reviewUrl);
      const ok = f.ask("What to improve", "Thanks for the honest answer. What's one thing we could do better?");
      f.chain(ok, f.text("Thanks", "Thank you — we read every reply. 🙏"));
      f.branch(q, [love, ok, f.human("We're really sorry about that. A member of our team will reach out here to make it right.")]);
      return f.build();
    },
  },
  {
    id: "ecom_back_in_stock", title: "Back-in-stock alert signup", kind: "quick",
    body: "Collect which product someone wants and tag them so you can message them when it's back.",
    industry: "ecommerce", sub: "sales", goal: "leads",
    trigger: { kind: "keyword", keyword: "NOTIFY", matchType: "exact" },
    fields: [{ key: "waitTag", label: "Tag to add", type: "tag", default: "", help: "e.g. “Back-in-stock list”. Broadcast to this tag when stock returns." }],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Customer wants a restock alert" });
      const ask = f.ask("Ask product", "Which product (and size/colour) are you waiting for?");
      f.chain(t, ask, f.tag("Tag: waiting list", v.waitTag), f.stage("Mark lead as engaged", "engaged"),
        f.text("You're on the list", "Done! ✅ We'll message you here as soon as *{{answer}}* is back in stock."));
      return f.build();
    },
  },

  // ═══ CUSTOMER CARE ═══
  {
    id: "support_faq", title: "FAQ help menu", popular: true, kind: "quick",
    body: "Answer your most common questions from a menu, with a “talk to a person” option.",
    industry: "support", sub: "helpdesk", goal: "support",
    trigger: { kind: "keyword", keyword: "HELP", matchType: "exact" },
    fields: [F.business,
      { key: "faqs", label: "Questions & answers (up to 8)", type: "faqs", max: 8, default: [
        { title: "Pricing", answer: "Our plans start at ₹999/month. Reply PRICE for the full list." },
        { title: "Delivery time", answer: "Orders are delivered in 3–5 working days across India." },
        { title: "Payment options", answer: "We accept UPI, cards, net banking and cash on delivery." } ] }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Customer asks for help" });
      const faqs = rows(v, "faqs");
      const menu = f.list("FAQ menu", `Hi {{first_name}}! How can ${bn(v) === "us" ? "we" : bn(v)} help you today?`, "See questions",
        [...faqs.map((q) => ({ title: q.title })), { title: "Talk to a person" }], "Common questions");
      f.chain(t, menu);
      const helped = f.buttons("Did that help?", "Did that answer your question?", ["Yes, thanks", "Talk to a person"]);
      f.branch(helped, [f.text("Glad to help", "Great! 😊 Type HELP anytime to see the menu again."), f.human()]);
      const answers = faqs.map((q) => { const a = f.text(`Answer: ${q.title}`, q.answer || ""); f.link(a, helped); return a; });
      f.branch(menu, [...answers, f.human()]);
      return f.build();
    },
  },
  {
    id: "support_away", title: "After-hours auto-reply", popular: true, kind: "quick",
    body: "Outside business hours (Mon–Sat 9–6 IST), tell people when you'll be back. Silent during hours.",
    industry: "support", sub: "helpdesk", goal: "support",
    trigger: { kind: "newContact" },
    fields: [F.business, F.hours,
      { key: "away", label: "Away message", type: "textarea", default: "Thanks for messaging! We're closed right now and will reply first thing during working hours." }],
    note: "Business hours are fixed at Mon–Sat, 9 AM – 6 PM IST by the engine. Starts on a new contact; switch the trigger to “Any message” in the builder to reply to every message after hours.",
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Someone messages us" });
      const c = f.businessHours();
      f.chain(t, c);
      f.link(c, f.text("Away reply", `${v.away}\n\n🕘 ${v.hours}`), "no");
      return f.build();
    },
  },
  {
    id: "support_human", title: "Talk to a human", kind: "quick",
    body: "When someone asks for an agent, confirm a person will reply and flag the chat for the team.",
    industry: "support", sub: "helpdesk", goal: "support",
    trigger: { kind: "keyword", keyword: "AGENT", matchType: "exact" },
    fields: [F.hours, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Customer asks for a person" });
      f.chain(t, f.human(`Sure! A member of our team will reply here shortly. 🙋\nWe're available ${v.hours}.`));
      return f.build();
    },
  },
  {
    id: "support_complaint", title: "Register a complaint", kind: "flow",
    body: "Collect the issue type, details and reference number, then confirm the complaint is logged.",
    industry: "support", sub: "tickets", goal: "support",
    trigger: { kind: "keyword", keyword: "COMPLAINT", matchType: "exact" },
    fields: [{ key: "types", label: "Issue types (up to 9)", type: "options", max: 9, maxLen: 24, default: ["Product issue", "Delivery problem", "Billing / payment", "Staff behaviour", "Something else"] }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Customer raises a complaint" });
      const types = opts(v, "types");
      const menu = f.list("Issue type", "We're sorry for the trouble. What is this about?", "Choose", types.map((x) => ({ title: x })), "Issue type");
      f.chain(t, menu);
      const details = f.ask("Ask details", "Please describe what happened in a few lines.");
      const ref = f.ask("Ask reference", "Thanks. Do you have an order/invoice number? Type it, or type NA.");
      f.chain(details, ref, f.text("Complaint logged", "Your complaint is registered ✅ Our team will get back to you here within 24 hours."),
        f.stage("Mark lead as engaged", "engaged"), f.tag("Tag: needs a person", v.humanTag));
      f.branch(menu, types.map(() => details));
      return f.build();
    },
  },
  {
    id: "support_service", title: "Warranty / service request", kind: "flow",
    body: "Take a service request: product, problem and city — saved on the lead for your service team.",
    industry: "support", sub: "tickets", goal: "support",
    trigger: { kind: "keyword", keyword: "SERVICE", matchType: "exact" },
    fields: [F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Customer needs service" });
      const p = f.ask("Ask product", "Which product needs service? (model name if you have it)");
      const i = f.ask("Ask problem", "What's the problem you're facing?");
      const c = f.ask("Ask city", "Which city are you in?");
      f.chain(t, p, i, c, f.saveField("Save city", "city"),
        f.text("Request received", "Thanks! 🛠️ Your service request is registered. Our technician team will call you to fix a time."),
        f.tag("Tag: needs a person", v.humanTag));
      return f.build();
    },
  },
  {
    id: "support_csat", title: "Customer satisfaction survey", kind: "flow",
    body: "After a chat is resolved, ask for a quick rating and collect what to improve.",
    industry: "support", sub: "feedback", goal: "retain", windowNote: true,
    trigger: { kind: "tagApplied", tag: "" },
    fields: [F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Tag added: resolved" });
      const q = f.buttons("Rate us", "How would you rate the help you got today?", ["Great 👍", "Okay", "Poor 👎"]);
      f.chain(t, q);
      const improve = f.ask("What to improve", "Thanks for telling us. What could we have done better?");
      f.chain(improve, f.text("Thanks", "Thank you — this goes straight to our team. 🙏"));
      f.branch(q, [f.text("Thanks", "Thank you! 😊 We're glad we could help."), improve, f.human("We're sorry it wasn't good enough. A senior team member will reach out here.")]);
      return f.build();
    },
  },
  {
    id: "support_nps", title: "Quick feedback (0–10 style)", kind: "quick",
    body: "Ask how likely they are to recommend you, with three simple choices and a follow-up question.",
    industry: "support", sub: "feedback", goal: "retain",
    trigger: { kind: "keyword", keyword: "FEEDBACK", matchType: "exact" },
    fields: [{ key: "reviewUrl", label: "Review page", type: "url", default: "https://g.page/r/your-review-link" }],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Customer leaves feedback" });
      const q = f.list("Recommend us?", "How likely are you to recommend us to a friend?", "Choose", [
        { title: "9–10 · Very likely" }, { title: "7–8 · Likely" }, { title: "0–6 · Not likely" }]);
      f.chain(t, q);
      const fan = f.cta("Review link", "Thank you! 🙌 Would you share that in a quick review?", "Leave a review", v.reviewUrl);
      const why = f.ask("Ask why", "Thanks! What would make it a 10 for you?");
      f.chain(why, f.text("Thanks", "Noted — thank you for helping us improve. 🙏"));
      f.branch(q, [fan, why, why]);
      return f.build();
    },
  },

  // ═══ SERVICES & BOOKINGS ═══
  {
    id: "svc_booking", title: "Appointment booking request", popular: true, kind: "quick",
    body: "Pick a service, collect preferred date/time and name, then confirm you'll lock the slot.",
    industry: "services", sub: "booking", goal: "book",
    trigger: { kind: "keyword", keyword: "BOOK", matchType: "exact" },
    fields: [F.business, { key: "services", label: "Services (up to 9)", type: "rows", max: 9, default: [
      { title: "Consultation", description: "30 minutes" }, { title: "Full session", description: "60 minutes" }, { title: "Follow-up visit", description: "20 minutes" }] }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Customer wants to book" });
      const svc = rows(v, "services");
      const menu = f.list("Pick a service", `Let's get you booked at ${bn(v)}! Which service would you like?`, "Services", svc, "Services");
      f.chain(t, menu);
      const when = f.ask("Ask date & time", "Great! What *date and time* suits you? (e.g. Sat 10 AM)");
      const name = f.ask("Ask name", "And your full name, please?");
      f.chain(when, name, f.saveField("Save name", "name"), f.stage("Mark lead as hot", "hot"),
        f.text("Request received", "Thanks {{answer}}! 📅 We've got your request and will confirm the slot here shortly."), f.tag("Tag: needs a person", v.humanTag));
      f.branch(menu, svc.map(() => when));
      return f.build();
    },
  },
  {
    id: "svc_quote", title: "Get a quote", kind: "flow",
    body: "Qualify a quote request: service, requirement, city and urgency — hot leads flagged automatically.",
    industry: "services", sub: "quotes", goal: "leads",
    trigger: { kind: "keyword", keyword: "QUOTE", matchType: "exact" },
    fields: [{ key: "services", label: "Services (up to 9)", type: "options", max: 9, maxLen: 24, default: ["Website design", "Digital marketing", "App development", "Something else"] }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Customer asks for a quote" });
      const svc = opts(v, "services");
      const menu = f.list("Which service?", "Happy to send you a quote! Which service do you need?", "Choose", svc.map((x) => ({ title: x })), "Services");
      f.chain(t, menu);
      const need = f.ask("Ask requirement", "Briefly, what do you need? (size, quantity, features…)");
      const city = f.ask("Ask city", "Which city are you in?");
      const when = f.buttons("How soon?", "When do you need it?", ["This week", "This month", "Just exploring"]);
      f.chain(need, city, f.saveField("Save city", "city"), when);
      f.branch(menu, svc.map(() => need));
      const thanks = f.text("Quote coming", "Thanks! 🧾 Our team is preparing your quote and will share it here.");
      const hot = f.stage("Mark lead as hot", "hot");
      f.chain(hot, thanks, f.tag("Tag: needs a person", v.humanTag));
      const warm = f.stage("Mark lead as engaged", "engaged");
      f.chain(warm, thanks);
      f.branch(when, [hot || thanks, hot || thanks, warm || thanks]);
      return f.build();
    },
  },
  {
    id: "svc_callback", title: "Request a callback", kind: "quick",
    body: "Let people pick a callback window — the lead is marked hot for your sales team.",
    industry: "services", sub: "booking", goal: "leads",
    trigger: { kind: "keyword", keyword: "CALL", matchType: "exact" },
    fields: [F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Customer wants a call" });
      const q = f.buttons("Best time?", "Sure! When is the best time to call you?", ["Morning", "Afternoon", "Evening"]);
      f.chain(t, q);
      const done = f.text("Call booked", "Done ✅ We'll call you on this number at that time.");
      const s = f.stage("Mark lead as hot", "hot");
      f.chain(s, done, f.tag("Tag: needs a person", v.humanTag));
      f.branch(q, [s || done, s || done, s || done]);
      return f.build();
    },
  },
  {
    id: "svc_pricing", title: "Services & pricing", popular: true, kind: "quick",
    body: "Reply to PRICE with a service menu showing prices, then offer to book or talk.",
    industry: "services", sub: "quotes", goal: "sell",
    trigger: { kind: "keyword", keyword: "PRICE", matchType: "exact" },
    fields: [{ key: "services", label: "Services with prices (up to 9)", type: "rows", max: 9, default: [
      { title: "Basic plan", description: "₹999 / month" }, { title: "Pro plan", description: "₹2,499 / month" }, { title: "Custom", description: "Tailored quote" }] },
      { key: "bookUrl", label: "Booking / payment link", type: "url", default: "https://example.com/book" }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Customer asks for prices" });
      const svc = rows(v, "services");
      const menu = f.list("Price list", "Here's our pricing — tap one for details 👇", "See prices", svc, "Plans");
      f.chain(t, menu);
      const next = f.buttons("Next step", "Would you like to go ahead?", ["Book now", "Talk to us"]);
      const details = svc.map((s) => { const d = f.text(`Details: ${s.title}`, `*${s.title}* — ${s.description || ""}`); f.link(d, next); return d; });
      f.branch(menu, details);
      f.branch(next, [f.cta("Booking link", "Great! Book or pay here:", "Book now", v.bookUrl), f.human()]);
      return f.build();
    },
  },

  // ═══ EDUCATION ═══
  {
    id: "edu_course", title: "Course enquiry funnel", popular: true, kind: "flow",
    body: "Course menu → profession → brochure → “ready to enrol?” with a payment link or a counsellor.",
    industry: "education", sub: "courses", goal: "leads",
    trigger: { kind: "keyword", keyword: "COURSE", matchType: "contains" },
    fields: [F.business, { key: "courses", label: "Courses (up to 9)", type: "rows", max: 9, default: [
      { title: "Beginner course", description: "4 weeks · ₹4,999" }, { title: "Advanced course", description: "8 weeks · ₹9,999" }] },
      { key: "professions", label: "Profession choices (up to 9)", type: "options", max: 9, maxLen: 24, default: ["Student", "Working professional", "Business owner", "Freelancer"] },
      { key: "brochure", label: "Brochure (PDF)", type: "media", mediaType: "document", default: null, help: "Optional — pick from the Media Library." },
      { key: "payUrl", label: "Enrolment / payment link", type: "url", default: "https://example.com/enrol" }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Course enquiry" });
      const hi = f.text("Welcome", `Hi {{first_name}}! 👋 Thanks for your interest in ${bn(v)}.`);
      const courses = rows(v, "courses");
      const menu = f.list("Pick a course", "Which course are you interested in?", "Courses", courses, "Courses");
      f.chain(t, hi, menu);
      const profs = opts(v, "professions");
      const prof = f.list("Ask profession", "What best describes you?", "Choose", profs.map((x) => ({ title: x })), "About you");
      f.branch(menu, courses.map(() => prof));
      const save = f.saveField("Save profession", "profession");
      f.branch(prof, profs.map(() => save));
      const doc = f.media("document", "Brochure", v.brochure, "Here's the full brochure with syllabus & fees 📘", "Brochure.pdf");
      const ready = f.buttons("Ready to enrol?", "Would you like to enrol?", ["Yes, enrol me", "Talk to counsellor"]);
      f.chain(save, doc, ready);
      const pay = f.cta("Enrol link", "Brilliant! 🎉 Complete your enrolment here:", "Enrol now", v.payUrl);
      const hot = f.stage("Mark lead as hot", "hot");
      f.chain(hot, pay);
      f.branch(ready, [hot || pay, f.human("Sure! A counsellor will message you here shortly to answer your questions. 🎓")]);
      return f.build();
    },
  },
  {
    id: "edu_demo", title: "Book a free demo class", kind: "quick",
    body: "Collect the student's name and a preferred demo slot, then confirm with the joining link.",
    industry: "education", sub: "admissions", goal: "book",
    trigger: { kind: "keyword", keyword: "DEMO", matchType: "exact" },
    fields: [{ key: "slots", label: "Demo slots (up to 9)", type: "options", max: 9, maxLen: 24, default: ["Sat 10:00 AM", "Sat 4:00 PM", "Sun 11:00 AM"] },
      { key: "joinUrl", label: "Joining link", type: "url", default: "https://meet.google.com/your-link" }],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Demo class request" });
      const name = f.ask("Ask name", "Let's book your free demo! 🎓 What's the student's name?");
      const slots = opts(v, "slots");
      const slot = f.list("Pick a slot", "Pick a demo slot that works for you:", "Slots", slots.map((x) => ({ title: x })), "Demo slots");
      f.chain(t, name, f.saveField("Save name", "name"), f.stage("Mark lead as hot", "hot"), slot);
      const conf = f.cta("Joining link", "You're booked ✅ Use this link to join at your chosen time:", "Join demo", v.joinUrl);
      f.branch(slot, slots.map(() => conf));
      return f.build();
    },
  },
  {
    id: "edu_admission", title: "Admission enquiry", kind: "flow",
    body: "Collect student name, class/programme and city for your admissions counsellor.",
    industry: "education", sub: "admissions", goal: "leads",
    trigger: { kind: "keyword", keyword: "ADMISSION", matchType: "contains" },
    fields: [{ key: "grades", label: "Classes / programmes (up to 9)", type: "options", max: 9, maxLen: 24, default: ["Pre-school", "Primary (1–5)", "Middle (6–8)", "High school (9–12)"] }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Admission enquiry" });
      const name = f.ask("Ask student name", "Welcome! 🏫 What's the student's full name?");
      const grades = opts(v, "grades");
      const g = f.list("Pick class", "Which class/programme is the admission for?", "Choose", grades.map((x) => ({ title: x })), "Admissions");
      f.chain(t, name, f.saveField("Save name", "name"), g);
      const city = f.ask("Ask city", "Which city/area do you live in?");
      f.branch(g, grades.map(() => city));
      f.chain(city, f.saveField("Save city", "city"), f.stage("Mark lead as hot", "hot"),
        f.text("Counsellor will call", "Thank you! Our admissions counsellor will call you within one working day. 📞"), f.tag("Tag: needs a person", v.humanTag));
      return f.build();
    },
  },

  // ═══ REAL ESTATE ═══
  {
    id: "re_qualify", title: "Property enquiry qualifier", popular: true, kind: "flow",
    body: "Buy or rent → budget → preferred location → offer a site visit. Visit requests become hot leads.",
    industry: "realestate", sub: "enquiry", goal: "leads",
    trigger: { kind: "keyword", keyword: "PROPERTY", matchType: "contains" },
    fields: [{ key: "budgets", label: "Budget ranges (up to 9)", type: "options", max: 9, maxLen: 24, default: ["Under ₹50 L", "₹50 L – 1 Cr", "₹1 – 2 Cr", "Above ₹2 Cr"] }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Property enquiry" });
      const intent = f.buttons("Buy or rent?", "Hi {{first_name}}! 🏠 Are you looking to buy or rent?", ["Buy", "Rent", "Sell my property"]);
      f.chain(t, intent);
      const budgets = opts(v, "budgets");
      const budget = f.list("Budget", "What's your budget range?", "Budget", budgets.map((x) => ({ title: x })), "Budget");
      f.branch(intent, [budget, budget, f.human("Great! Our team will contact you to understand your property and give you a valuation. 📋")]);
      const loc = f.ask("Ask location", "Which area or locality do you prefer?");
      f.branch(budget, budgets.map(() => loc));
      const visit = f.buttons("Site visit?", "We have matching options! Would you like to book a site visit?", ["Yes, book a visit", "Send details first"]);
      f.chain(loc, f.saveField("Save city", "city"), visit);
      const when = f.ask("Ask visit time", "Great! Which day and time suits you for the visit?");
      f.chain(when, f.stage("Mark lead as hot", "hot"), f.text("Visit requested", "Noted ✅ Our property advisor will confirm the visit here."), f.tag("Tag: needs a person", v.humanTag));
      f.branch(visit, [when, f.human("Sure! Our advisor will share matching listings here shortly. 📲")]);
      return f.build();
    },
  },
  {
    id: "re_visit", title: "Site visit booking", kind: "quick",
    body: "Pick a project, give a preferred day/time, and get the location link — booked as a hot lead.",
    industry: "realestate", sub: "visits", goal: "book",
    trigger: { kind: "keyword", keyword: "VISIT", matchType: "exact" },
    fields: [{ key: "projects", label: "Projects (up to 9)", type: "rows", max: 9, default: [
      { title: "Green Meadows", description: "2 & 3 BHK · Ready to move" }, { title: "Skyline Towers", description: "3 BHK · Possession 2027" }] },
      { key: "mapUrl", label: "Location (Google Maps link)", type: "url", default: "https://maps.google.com/?q=your+site" }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Site visit request" });
      const proj = rows(v, "projects");
      const menu = f.list("Pick project", "Which project would you like to visit?", "Projects", proj, "Projects");
      f.chain(t, menu);
      const when = f.ask("Ask day & time", "Which day and time works for you?");
      f.branch(menu, proj.map(() => when));
      f.chain(when, f.stage("Mark lead as hot", "hot"),
        f.cta("Location", "Booked ✅ Here's the site location — our advisor will confirm your slot.", "Open map", v.mapUrl), f.tag("Tag: needs a person", v.humanTag));
      return f.build();
    },
  },

  // ═══ HEALTHCARE ═══
  {
    id: "health_appt", title: "Clinic appointment booking", popular: true, kind: "quick",
    body: "Department/doctor → patient name → preferred date. Your front desk confirms the slot.",
    industry: "health", sub: "appointments", goal: "book",
    trigger: { kind: "keyword", keyword: "APPOINTMENT", matchType: "contains" },
    fields: [{ key: "depts", label: "Departments / doctors (up to 9)", type: "rows", max: 9, default: [
      { title: "General physician", description: "Dr. Sharma" }, { title: "Dermatology", description: "Dr. Iyer" }, { title: "Paediatrics", description: "Dr. Khan" }] }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Appointment request" });
      const d = rows(v, "depts");
      const menu = f.list("Pick department", "Which department would you like to book? 🩺", "Departments", d, "Departments");
      f.chain(t, menu);
      const name = f.ask("Ask patient name", "Please type the patient's full name.");
      f.branch(menu, d.map(() => name));
      const date = f.ask("Ask date", "Which date would you prefer? (e.g. 14 Oct, morning)");
      f.chain(name, f.saveField("Save name", "name"), date, f.stage("Mark lead as hot", "hot"),
        f.text("Request received", "Thank you! 🗓️ Our front desk will confirm your appointment time here shortly."), f.tag("Tag: needs a person", v.humanTag));
      return f.build();
    },
  },
  {
    id: "health_info", title: "Clinic timings & location", kind: "quick",
    body: "Share timings and a map link, then offer to book an appointment or talk to the desk.",
    industry: "health", sub: "patients", goal: "support",
    trigger: { kind: "keyword", keyword: "TIMINGS", matchType: "contains" },
    fields: [F.business, F.hours, { key: "mapUrl", label: "Location (Google Maps link)", type: "url", default: "https://maps.google.com/?q=your+clinic" }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Timings & location" });
      const m = f.cta("Timings & map", `🕘 ${bn(v) === "us" ? "We're" : bn(v) + " is"} open ${v.hours}.\nTap below for directions:`, "Get directions", v.mapUrl);
      const next = f.buttons("Anything else?", "Can we help with anything else?", ["Book appointment", "Talk to desk"]);
      f.chain(t, m);
      f.link(m, next);
      f.branch(next, [f.text("How to book", "Just reply *APPOINTMENT* and we'll book you in. 🙂"), f.human()]);
      return f.build();
    },
  },
  {
    id: "health_report", title: "Lab report request", kind: "quick",
    body: "Collect patient name and booking ID, then let the patient know the report will be shared here.",
    industry: "health", sub: "patients", goal: "support",
    trigger: { kind: "keyword", keyword: "REPORT", matchType: "contains" },
    fields: [F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Report request" });
      const n = f.ask("Ask patient name", "Sure — please type the patient's full name.");
      const id = f.ask("Ask booking ID", "And the booking/sample ID from your receipt?");
      f.chain(t, n, id, f.text("Report coming", "Thank you! 🧾 Our lab team will share the report here as soon as it's ready."), f.tag("Tag: needs a person", v.humanTag));
      return f.build();
    },
  },

  // ═══ FOOD ═══
  {
    id: "food_menu", title: "Menu & online order", popular: true, kind: "quick",
    body: "Send your menu (PDF or image) with an order-online link, plus table booking and a talk option.",
    industry: "food", sub: "orders", goal: "sell",
    trigger: { kind: "keyword", keyword: "MENU", matchType: "contains" },
    fields: [F.business, { key: "menuFile", label: "Menu (PDF)", type: "media", mediaType: "document", default: null, help: "Optional — pick from the Media Library." },
      { key: "orderUrl", label: "Order online link", type: "url", default: "https://yourrestaurant.com/order" }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Customer asks for the menu" });
      const hi = f.text("Welcome", `Hi {{first_name}}! 🍽️ Welcome to ${bn(v)}.`);
      const doc = f.media("document", "Menu", v.menuFile, "Here's our menu 😋", "Menu.pdf");
      const q = f.buttons("What next?", "What would you like to do?", ["Order online", "Book a table", "Talk to us"]);
      f.chain(t, hi, doc, q);
      f.branch(q, [f.cta("Order link", "Order here — fresh and fast 🚀", "Order now", v.orderUrl), f.text("How to book", "Reply *TABLE* to reserve a table. 🙂"), f.human()]);
      return f.build();
    },
  },
  {
    id: "food_table", title: "Table reservation", kind: "quick",
    body: "Guests pick party size, date/time and name; you confirm the reservation.",
    industry: "food", sub: "tables", goal: "book",
    trigger: { kind: "keyword", keyword: "TABLE", matchType: "exact" },
    fields: [F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Table booking" });
      const size = f.list("Party size", "How many guests? 🍴", "Guests", [{ title: "2 people" }, { title: "3–4 people" }, { title: "5–6 people" }, { title: "7+ people" }], "Party size");
      f.chain(t, size);
      const when = f.ask("Ask date & time", "Which date and time?");
      f.branch(size, [when, when, when, when]);
      const name = f.ask("Ask name", "And the name for the booking?");
      f.chain(when, name, f.saveField("Save name", "name"), f.text("Reservation noted", "Thank you! 🎉 We'll confirm your table here shortly."), f.tag("Tag: needs a person", v.humanTag));
      return f.build();
    },
  },

  // ═══ TRAVEL ═══
  {
    id: "travel_package", title: "Holiday package enquiry", popular: true, kind: "flow",
    body: "Destination → travellers → dates → budget, then hand over to a travel expert as a hot lead.",
    industry: "travel", sub: "packages", goal: "leads",
    trigger: { kind: "keyword", keyword: "TRIP", matchType: "contains" },
    fields: [{ key: "places", label: "Destinations (up to 9)", type: "rows", max: 9, default: [
      { title: "Goa", description: "3N/4D from ₹14,999" }, { title: "Kerala", description: "4N/5D from ₹19,999" }, { title: "Dubai", description: "4N/5D from ₹49,999" }] }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Package enquiry" });
      const places = rows(v, "places");
      const menu = f.list("Destination", "Where would you like to go? ✈️", "Destinations", places, "Destinations");
      f.chain(t, menu);
      const who = f.buttons("Travellers", "Who's travelling?", ["Couple", "Family", "Group / friends"]);
      f.branch(menu, places.map(() => who));
      const dates = f.ask("Ask dates", "When are you planning to travel? (month or dates)");
      f.branch(who, [dates, dates, dates]);
      f.chain(dates, f.stage("Mark lead as hot", "hot"),
        f.text("Expert will call", "Lovely! 🌴 A travel expert will share the best options and prices here shortly."), f.tag("Tag: needs a person", v.humanTag));
      return f.build();
    },
  },
  {
    id: "travel_stay", title: "Hotel / stay booking request", kind: "quick",
    body: "Room type, check-in date and guests — then the front desk confirms availability.",
    industry: "travel", sub: "stays", goal: "book",
    trigger: { kind: "keyword", keyword: "ROOM", matchType: "contains" },
    fields: [{ key: "rooms", label: "Room types (up to 9)", type: "rows", max: 9, default: [
      { title: "Deluxe room", description: "₹3,500 / night" }, { title: "Suite", description: "₹6,500 / night" }] }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Room booking" });
      const r = rows(v, "rooms");
      const menu = f.list("Room type", "Which room would you like? 🛏️", "Rooms", r, "Rooms");
      f.chain(t, menu);
      const d = f.ask("Ask dates", "Your check-in and check-out dates?");
      f.branch(menu, r.map(() => d));
      const g = f.ask("Ask guests", "How many guests (adults/children)?");
      f.chain(d, g, f.stage("Mark lead as hot", "hot"), f.text("Checking", "Thanks! We're checking availability and will confirm here. 🏨"), f.tag("Tag: needs a person", v.humanTag));
      return f.build();
    },
  },

  // ═══ WELLNESS ═══
  {
    id: "salon_booking", title: "Salon / spa booking", kind: "quick",
    body: "Service menu with prices → preferred slot → name, and the desk confirms.",
    industry: "wellness", sub: "salon", goal: "book",
    trigger: { kind: "keyword", keyword: "BOOK", matchType: "exact" },
    fields: [{ key: "services", label: "Services (up to 9)", type: "rows", max: 9, default: [
      { title: "Haircut & style", description: "₹499" }, { title: "Facial", description: "₹1,299" }, { title: "Spa massage", description: "₹1,999 · 60 min" }] }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Salon booking" });
      const s = rows(v, "services");
      const menu = f.list("Pick a service", "Treat yourself! 💆 Which service would you like?", "Services", s, "Services");
      f.chain(t, menu);
      const when = f.ask("Ask slot", "Which day and time suits you?");
      f.branch(menu, s.map(() => when));
      const name = f.ask("Ask name", "And your name?");
      f.chain(when, name, f.saveField("Save name", "name"), f.stage("Mark lead as hot", "hot"), f.text("Requested", "Lovely, {{answer}}! ✨ We'll confirm your slot here shortly."), f.tag("Tag: needs a person", v.humanTag));
      return f.build();
    },
  },
  {
    id: "gym_trial", title: "Free trial & membership plans", kind: "flow",
    body: "Show plans with prices, then book a free trial or connect them with a trainer.",
    industry: "wellness", sub: "fitness", goal: "sell",
    trigger: { kind: "keyword", keyword: "JOIN", matchType: "exact" },
    fields: [{ key: "plans", label: "Plans (up to 9)", type: "rows", max: 9, default: [
      { title: "Monthly", description: "₹1,999" }, { title: "Quarterly", description: "₹4,999 · save 17%" }, { title: "Yearly", description: "₹14,999 · best value" }] }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Membership enquiry" });
      const p = rows(v, "plans");
      const menu = f.list("Plans", "💪 Here are our membership plans:", "See plans", p, "Plans");
      f.chain(t, menu);
      const next = f.buttons("Try first?", "Want to try us out first?", ["Book free trial", "Talk to a trainer"]);
      f.branch(menu, p.map(() => next));
      const when = f.ask("Ask trial time", "Which day and time would you like your free trial?");
      f.chain(when, f.stage("Mark lead as hot", "hot"), f.text("Trial booked", "You're in! 🏋️ We'll confirm your trial here. Bring water and comfy shoes."), f.tag("Tag: needs a person", v.humanTag));
      f.branch(next, [when, f.human()]);
      return f.build();
    },
  },

  // ═══ LEAD GENERATION ═══
  {
    id: "lead_ctwa", title: "Click-to-WhatsApp ad qualifier", popular: true, kind: "flow",
    body: "For people arriving from your ad's pre-filled message: name → interest → city → call or details.",
    industry: "leads", sub: "ads", goal: "leads",
    trigger: { kind: "keyword", keyword: "I want to know more", matchType: "contains" },
    fields: [F.business, { key: "interests", label: "What can they be interested in? (up to 9)", type: "options", max: 9, maxLen: 24, default: ["Product A", "Product B", "Pricing", "Something else"] },
      { key: "detailsUrl", label: "Details / brochure link", type: "url", default: "https://example.com" }, F.humanTag],
    note: "Set the keyword to your ad's pre-filled message text (match: contains).",
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Ad message received" });
      const name = f.ask("Ask name", `Hi! 👋 Thanks for reaching out to ${bn(v)}. May I know your name?`);
      const ints = opts(v, "interests");
      const what = f.list("Interest", "Nice to meet you, {{answer}}! What are you interested in?", "Choose", ints.map((x) => ({ title: x })), "Interests");
      f.chain(t, name, f.saveField("Save name", "name"), what);
      const city = f.ask("Ask city", "Which city are you from?");
      f.branch(what, ints.map(() => city));
      const next = f.buttons("Next step", "How would you like to continue?", ["Call me", "Send details"]);
      f.chain(city, f.saveField("Save city", "city"), next);
      const call = f.text("Call booked", "Perfect! 📞 Our team will call you shortly.");
      const hot = f.stage("Mark lead as hot", "hot");
      f.chain(hot, call, f.tag("Tag: needs a person", v.humanTag));
      const send = f.cta("Details link", "Here are the full details 👇 Reply anytime with questions.", "View details", v.detailsUrl);
      const eng = f.stage("Mark lead as engaged", "engaged");
      f.chain(eng, send);
      f.branch(next, [hot || call, eng || send]);
      return f.build();
    },
  },
  {
    id: "lead_capture", title: "Collect name, email & city", popular: true, kind: "quick",
    body: "Ask three questions and save the answers straight onto the lead record.",
    industry: "leads", sub: "capture", goal: "leads",
    trigger: { kind: "keyword", keyword: "INFO", matchType: "exact" },
    fields: [F.business],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Lead details request" });
      const n = f.ask("Ask name", `Hi! I'm the ${bn(v) === "us" ? "" : bn(v) + " "}assistant 🙂 What's your name?`);
      const e = f.ask("Ask email", "Thanks! What's your email address?");
      const c = f.ask("Ask city", "And which city are you in?");
      f.chain(t, n, f.saveField("Save name", "name"), e, f.saveField("Save email", "email"), c, f.saveField("Save city", "city"),
        f.stage("Mark lead as engaged", "engaged"), f.text("Thanks", "All set — thank you! ✅ Our team will be in touch here."));
      return f.build();
    },
  },
  {
    id: "lead_brochure", title: "Send brochure / catalogue", kind: "quick",
    body: "Reply to BROCHURE with your PDF, then ask if they're interested or have a question.",
    industry: "leads", sub: "capture", goal: "leads",
    trigger: { kind: "keyword", keyword: "BROCHURE", matchType: "contains" },
    fields: [{ key: "brochure", label: "Brochure (PDF)", type: "media", mediaType: "document", default: null, help: "Pick from the Media Library." },
      { key: "brochureUrl", label: "…or a brochure link", type: "url", default: "https://example.com/brochure.pdf" }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Brochure request" });
      const doc = f.media("document", "Brochure", v.brochure || (v.brochureUrl ? { url: v.brochureUrl } : null), "Here's our brochure 📘", "Brochure.pdf");
      const q = f.buttons("Interested?", "Have a look — would you like to take the next step?", ["I'm interested", "I have a question"]);
      f.chain(t, f.text("Sending", "Sure! Sending it now…"), doc, q);
      f.branch(q, [f.human("Wonderful! 🎉 Our team will contact you here with the next steps."), f.human()]);
      return f.build();
    },
  },
  {
    id: "lead_link", title: "Tracked wa.me link welcome", kind: "quick",
    body: "Welcome people who tap a tracked link (QR, bio, poster) and show a quick menu.",
    industry: "leads", sub: "ads", goal: "leads",
    trigger: { kind: "link", trackingCode: "QR01" },
    fields: [F.business, { key: "menu", label: "Menu buttons (up to 3)", type: "options", max: 3, maxLen: 20, default: ["See prices", "Book a call", "Talk to us"] },
      { key: "priceUrl", label: "Prices link", type: "url", default: "https://example.com/pricing" }, F.humanTag],
    note: "Put the tracking code inside your link's pre-filled message, e.g. wa.me/91XXXXXXXXXX?text=Hi%20QR01",
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Tracked link tapped" });
      const hi = f.text("Welcome", `Hi {{first_name}}! 👋 Thanks for scanning — welcome to ${bn(v)}.`);
      const m = opts(v, "menu");
      const q = f.buttons("Menu", "How can we help?", m);
      f.chain(t, f.stage("Mark lead as engaged", "engaged"), hi, q);
      const targets = m.map((label, i) => (i === 0 ? f.cta("Prices", "Here's everything with prices 👇", "View prices", v.priceUrl) : f.human()));
      f.branch(q, targets);
      return f.build();
    },
  },
  {
    id: "event_register", title: "Webinar / event registration", popular: true, kind: "quick",
    body: "Register attendees with name and email, then send the event details and joining link.",
    industry: "leads", sub: "events", goal: "leads",
    trigger: { kind: "keyword", keyword: "REGISTER", matchType: "contains" },
    fields: [{ key: "event", label: "Event name", type: "text", default: "Live Masterclass" },
      { key: "when", label: "Date & time", type: "text", default: "Sat 19 Oct, 7 PM IST" },
      { key: "joinUrl", label: "Joining link", type: "url", default: "https://zoom.us/j/your-link" }],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Event registration" });
      const n = f.ask("Ask name", `Let's get you registered for *${v.event}*! 🎟️ Your full name?`);
      const e = f.ask("Ask email", "Thanks! Your email (for the reminder)?");
      f.chain(t, n, f.saveField("Save name", "name"), e, f.saveField("Save email", "email"), f.stage("Mark lead as engaged", "engaged"),
        f.cta("Joining link", `You're registered ✅\n\n📅 *${v.event}*\n🕖 ${v.when}\n\nSave this link to join:`, "Join event", v.joinUrl));
      return f.build();
    },
  },

  // ═══ ENGAGEMENT ═══
  {
    id: "eng_welcome", title: "Welcome new contacts", popular: true, kind: "quick",
    body: "Greet every first-time contact and show three quick options.",
    industry: "engagement", sub: "welcome", goal: "retain",
    trigger: { kind: "newContact" },
    fields: [F.business, { key: "menu", label: "Menu buttons (up to 3)", type: "options", max: 3, maxLen: 20, default: ["Our products", "Prices", "Talk to us"] },
      { key: "site", label: "Products / website link", type: "url", default: "https://example.com" }, F.humanTag],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "First message from a new contact" });
      const hi = f.text("Welcome", `Hi {{first_name}}! 👋 Welcome to ${bn(v)}. We usually reply within a few minutes.`);
      const m = opts(v, "menu");
      const q = f.buttons("Menu", "What can we help you with?", m);
      f.chain(t, hi, q);
      f.branch(q, m.map((label, i) => (i < m.length - 1 ? f.cta(`Link: ${label}`, `Here you go — ${label.toLowerCase()} 👇`, "Open", v.site) : f.human())));
      return f.build();
    },
  },
  {
    id: "eng_winback", title: "Win-back inactive customers", kind: "flow",
    body: "When a contact is tagged inactive, ask if they're still interested and send an offer — or mark them lost.",
    industry: "engagement", sub: "winback", goal: "retain", windowNote: true,
    trigger: { kind: "tagApplied", tag: "" },
    fields: [{ key: "offerUrl", label: "Offer link", type: "url", default: "https://example.com/offer" }, { key: "code", label: "Comeback code", type: "text", default: "MISSYOU15" }],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Tag added: inactive" });
      const q = f.buttons("Still interested?", "Hi {{first_name}}, we miss you! 💛 Still interested in hearing from us?", ["Yes, show me", "Not right now"]);
      f.chain(t, q);
      const yes = f.cta("Offer", `Welcome back! Here's *${v.code}* — an extra discount just for you.`, "See offer", v.offerUrl);
      const eng = f.stage("Mark lead as engaged", "engaged");
      f.chain(eng, yes);
      const no = f.text("No problem", "No worries — we'll be here whenever you need us. 🙂");
      const lost = f.stage("Mark lead as lost", "cold_lost");
      f.chain(lost, no);
      f.branch(q, [eng || yes, lost || no], { fallback: false });
      return f.build();
    },
  },
  {
    id: "eng_referral", title: "Referral programme", kind: "quick",
    body: "Reply to REFER with your referral reward and a link to share.",
    industry: "engagement", sub: "winback", goal: "retain",
    trigger: { kind: "keyword", keyword: "REFER", matchType: "exact" },
    fields: [{ key: "reward", label: "Reward line", type: "text", default: "₹500 off for you and your friend" },
      { key: "referUrl", label: "Referral link", type: "url", default: "https://example.com/refer" }],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Referral request" });
      f.chain(t, f.text("Reward", `Love that you want to share us! 🎁 Refer a friend and get *${v.reward}*.`),
        f.cta("Referral link", "Share this link with friends — the reward is applied automatically:", "Get my link", v.referUrl));
      return f.build();
    },
  },
  {
    id: "eng_optout", title: "Opt-out (STOP) handling", kind: "quick",
    body: "When someone sends STOP, confirm the opt-out, mark them lost and tag them so broadcasts skip them.",
    industry: "engagement", sub: "compliance", goal: "retain",
    trigger: { kind: "keyword", keyword: "STOP", matchType: "exact" },
    fields: [{ key: "optTag", label: "Opt-out tag", type: "tag", default: "", help: "Exclude this tag from your broadcasts." }],
    build(v, ctx) {
      const f = createFlow(ctxOf(v, ctx));
      const t = f.trigger({ ...this.trigger, ...v.__trigger, title: "Contact sends STOP" });
      f.chain(t, f.tag("Tag: opted out", v.optTag), f.stage("Mark lead as lost", "cold_lost"),
        f.text("Opt-out confirmed", "You've been unsubscribed ✅ You won't receive promotional messages from us. Reply START anytime to rejoin."));
      return f.build();
    },
  },
];

export const findTemplate = (id) => TEMPLATES.find((t) => t.id === id);

/** Initial setup values for a template (fields' defaults + its trigger). */
export function defaultValues(tpl) {
  const v = {};
  (tpl.fields || []).forEach((fd) => { v[fd.key] = Array.isArray(fd.default) ? fd.default.map((x) => (typeof x === "object" ? { ...x } : x)) : fd.default; });
  v.__trigger = { ...tpl.trigger };
  v.__name = tpl.title;
  return v;
}

/** Build the automation config for a template with the given setup values. */
export function buildTemplate(tpl, values, ctx = {}) {
  return tpl.build.call(tpl, values, ctx);
}
