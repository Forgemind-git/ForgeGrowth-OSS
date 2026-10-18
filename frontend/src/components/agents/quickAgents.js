import { HelpCircle, ShoppingBag, GraduationCap, CalendarCheck, LifeBuoy, KeyRound } from 'lucide-react';

/**
 * Quick AI Agents — the WhatsApp counterpart of Social's Quick Automations.
 *
 * A template is a handful of plain questions about the business ("What do you
 * sell?") plus a `build` that turns the answers into a system prompt. The
 * operator never has to write a prompt — but the composed prompt is shown, and
 * editing it by hand switches the quick editor to "custom" so their wording is
 * never overwritten by a later answer.
 *
 * Nothing here is stored. A quick agent is an ordinary agent (same 33-key
 * payload, see buildAgentPayload) and opens in the full editor like any other.
 */

export const QUICK_GOALS = [
  { id: 'questions', label: 'Answer questions' },
  { id: 'leads',     label: 'Get more leads' },
  { id: 'sales',     label: 'Sell & book' },
  { id: 'support',   label: 'Support customers' },
];

export const TONES = [
  { id: 'friendly',     label: 'Friendly',     line: 'Be warm and friendly, like a helpful person on the team.' },
  { id: 'professional', label: 'Professional', line: 'Be polite, clear and professional.' },
  { id: 'short',        label: 'Short & simple', line: 'Keep every reply very short and simple — one or two sentences.' },
];

export const LANGUAGES = [
  { id: 'match',   label: 'Match the customer', line: 'Reply in the language the customer writes in (English, Tamil or a mix).' },
  { id: 'english', label: 'English only',       line: 'Always reply in English.' },
  { id: 'tanglish', label: 'Tamil + English',   line: 'Reply in a natural Tamil-English mix (Tanglish) written in English letters.' },
];

const has = (v) => !!String(v || '').trim();
const line = (label, v) => (has(v) ? `- ${label}: ${String(v).trim()}` : null);
const lines = (...xs) => xs.filter(Boolean).join('\n');

// The parts every quick agent shares: who it is, how to talk, the safety rules.
function compose({ intro, knowledge, job, tone, language }) {
  const t = TONES.find(x => x.id === tone) || TONES[0];
  const l = LANGUAGES.find(x => x.id === language) || LANGUAGES[0];
  return lines(
    intro,
    knowledge ? `\nWhat you know:\n${knowledge}` : null,
    job ? `\nYour job:\n${job}` : null,
    `\nHow to reply:
- ${t.line}
- ${l.line}
- Reply in 2-4 short sentences on WhatsApp — no long paragraphs.
- Never invent prices, dates, offers or promises. If you do not know, say a team member will help.`,
  );
}

const who = (v) => `You are the WhatsApp assistant for ${has(v.business) ? v.business.trim() : 'our business'}.`;

export const QUICK_AGENTS = [
  {
    id: 'faq', goal: 'questions', popular: true, Icon: HelpCircle,
    title: 'Answer customer questions',
    keywords: 'faq questions prices timings location hours',
    body: 'Replies to questions about what you sell, prices, timings and where you are.',
    name: 'FAQ assistant', triggerMode: 'any',
    fields: [
      { key: 'business', label: 'Business name', placeholder: 'e.g. Acme Academy', required: true },
      { key: 'offer', label: 'What you sell, with prices', placeholder: 'e.g. Data Analytics Bootcamp — ₹9,999, 8 weeks, online', multiline: true, required: true },
      { key: 'timings', label: 'Timings / location', placeholder: 'e.g. Mon–Sat 10am–7pm · Coimbatore + online' },
      { key: 'extra', label: 'Anything else it should know', placeholder: 'e.g. EMI available, certificate on completion', multiline: true },
    ],
    build: (v, s) => compose({
      ...s, intro: who(v),
      knowledge: lines(line('What we sell', v.offer), line('Timings / location', v.timings), line('Also', v.extra)),
      job: '- Answer questions about the above.\n- End with one helpful next step, e.g. asking which option they are interested in.',
    }),
  },
  {
    id: 'leads', goal: 'leads', popular: true, Icon: ShoppingBag,
    title: 'Qualify new enquiries',
    keywords: 'leads enquiry inquiry qualify new customers sales',
    body: 'Greets first-time enquiries, finds out what they need, then hands them to your team.',
    name: 'Lead qualifier', triggerMode: 'new',
    fields: [
      { key: 'business', label: 'Business name', placeholder: 'e.g. Acme Academy', required: true },
      { key: 'offer', label: 'What you sell', placeholder: 'e.g. AI courses for working professionals', multiline: true, required: true },
      { key: 'ask', label: 'What to find out', placeholder: 'e.g. their name, which course, when they want to start', multiline: true, default: 'their name, what they are looking for, and when they want to start' },
      { key: 'next', label: 'What happens after', placeholder: 'e.g. a counsellor will call within 2 hours', default: 'someone from the team will reach out shortly' },
    ],
    build: (v, s) => compose({
      ...s, intro: `${who(v)} New enquiries come from our ads and website.`,
      knowledge: line('What we sell', v.offer),
      job: lines(
        `- Over a few friendly messages, find out ${has(v.ask) ? v.ask.trim() : 'what they need'}. Ask one question at a time.`,
        '- Answer simple questions, but never promise discounts or dates.',
        `- When you have the answers, thank them and tell them ${has(v.next) ? v.next.trim() : 'the team will reach out shortly'}.`,
      ),
    }),
  },
  {
    id: 'course', goal: 'sales', popular: true, Icon: GraduationCap,
    title: 'Course enquiry assistant',
    keywords: 'course class batch fees payment link education training',
    body: 'Explains one course — price, duration, batch dates — and shares the payment link.',
    name: 'Course assistant', triggerMode: 'any',
    fields: [
      { key: 'business', label: 'Academy / business name', placeholder: 'e.g. Acme Academy', required: true },
      { key: 'course', label: 'Course name', placeholder: 'e.g. Data Analytics Bootcamp', required: true },
      { key: 'details', label: 'Price, duration & what they learn', placeholder: 'e.g. ₹7,499 · 6 weeks · live classes on weekends · build 5 real projects', multiline: true, required: true },
      { key: 'batch', label: 'Next batch date', placeholder: 'e.g. Starts 1 November, 7pm IST' },
      { key: 'link', label: 'Payment / registration link', placeholder: 'https://…' },
    ],
    build: (v, s) => compose({
      ...s, intro: who(v),
      knowledge: lines(line('Course', v.course), line('Details', v.details), line('Next batch', v.batch), line('Payment / registration link', v.link)),
      job: lines(
        '- Explain the course clearly and answer questions about it.',
        has(v.link) ? '- When someone is interested, share the payment / registration link above.' : '- When someone is interested, tell them the team will share how to join.',
      ),
    }),
  },
  {
    id: 'booking', goal: 'sales', Icon: CalendarCheck,
    title: 'Book calls & visits',
    keywords: 'booking appointment schedule demo call visit meeting',
    body: 'Collects a preferred day and time for a call, demo or visit.',
    name: 'Booking assistant', triggerMode: 'any',
    fields: [
      { key: 'business', label: 'Business name', placeholder: 'e.g. Forge Fitness', required: true },
      { key: 'what', label: 'What they book', placeholder: 'e.g. a free 15-minute counselling call', required: true },
      { key: 'slots', label: 'When you take bookings', placeholder: 'e.g. Mon–Fri, 11am–6pm', required: true },
    ],
    build: (v, s) => compose({
      ...s, intro: `${who(v)} You help people book ${has(v.what) ? v.what.trim() : 'an appointment'}.`,
      knowledge: line('Available slots', v.slots),
      job: lines(
        '- Ask for their name, preferred day and preferred time — one question at a time.',
        '- Repeat the booking back to confirm it. Suggest the nearest available slot if they ask for a time outside the hours above.',
        '- Never confirm a slot you were not told about; say the team will confirm.',
      ),
    }),
  },
  {
    id: 'support', goal: 'support', Icon: LifeBuoy,
    title: 'Customer support',
    keywords: 'support help complaint issue refund service',
    body: 'Helps existing customers with common requests and hands the rest to your team.',
    name: 'Support assistant', triggerMode: 'any',
    fields: [
      { key: 'business', label: 'Business name', placeholder: 'e.g. Acme Academy', required: true },
      { key: 'answers', label: 'Common questions and answers', placeholder: 'e.g. Class recordings → in the student portal within 24h', multiline: true, required: true },
      { key: 'policy', label: 'Refund / cancellation policy', placeholder: 'e.g. Full refund within 7 days of joining', multiline: true },
    ],
    build: (v, s) => compose({
      ...s, intro: `${who(v)} You help existing customers.`,
      knowledge: lines(has(v.answers) ? `- Common requests:\n${String(v.answers).trim()}` : null, line('Refunds / cancellations', v.policy)),
      job: lines(
        '- Be calm and kind, even if the customer is upset. Apologise once, then help.',
        '- If the problem is not covered above, say a team member will follow up. Never guess.',
      ),
    }),
  },
  {
    id: 'keyword', goal: 'leads', Icon: KeyRound,
    title: 'Reply to a keyword',
    keywords: 'keyword trigger word campaign price join offer',
    body: 'Only wakes up when someone sends a word — like PRICE or JOIN — then chats about that offer.',
    name: 'Keyword assistant', triggerMode: 'keyword', keyword: 'PRICE',
    fields: [
      { key: 'business', label: 'Business name', placeholder: 'e.g. Acme Academy', required: true },
      { key: 'offer', label: 'What the keyword is about', placeholder: 'e.g. our ₹999 weekend workshop on AI agents', multiline: true, required: true },
      { key: 'link', label: 'Link to share (optional)', placeholder: 'https://…' },
    ],
    build: (v, s) => compose({
      ...s, intro: `${who(v)} People message you a keyword after seeing our post or ad.`,
      knowledge: lines(line('The offer', v.offer), line('Link', v.link)),
      job: lines(
        '- Explain the offer in a friendly way and answer questions about it.',
        has(v.link) ? '- Share the link when they are interested.' : null,
      ),
    }),
  },
];

/** Starting answers for a template: each field's default, else empty. */
export function initialAnswers(tpl) {
  return Object.fromEntries((tpl?.fields || []).map(f => [f.key, f.default || '']));
}

/** Required questions still unanswered, by label. */
export function missingAnswers(tpl, answers) {
  return (tpl?.fields || []).filter(f => f.required && !has(answers[f.key])).map(f => f.label);
}
