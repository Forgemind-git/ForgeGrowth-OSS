import { useState } from 'react';
import { Check, ChevronRight, ChevronDown, HelpCircle, ShoppingBag, CalendarCheck, LifeBuoy, Sparkles, FilePlus2 } from 'lucide-react';
import { C, FONT, T, W, LH } from '../../constants.js';

/**
 * The guided half of the agent editor.
 *
 * Nothing in here owns a setting. It READS the editor's form and tells the
 * operator what is still missing, and the starter picker only WRITES fields the
 * editor already has (instructions, description, trigger mode). So the saved
 * payload is byte-for-byte the shape agentService validates, whatever path the
 * operator took to fill it in — the guide is a map over the tabs, not a second
 * form beside them.
 */

// The prompt a brand-new agent starts with. Kept here because "has the
// operator told it what to do yet?" is answered by comparing against it.
export const DEFAULT_PROMPT = 'You are a helpful WhatsApp assistant. Keep replies concise.';

// A [bracketed] blank left in a starter's instructions. Two-to-sixty chars so a
// lone "[ ]" or a pasted markdown link does not read as a blank to fill in.
const BLANK_RE = /\[[^\]\n]{2,60}\]/;

/**
 * Starting points for "what should this agent do?". Each one fills the
 * Instructions box with a brief written the way a good prompt is written — who
 * you are, what to do, how to talk, what never to do — with [bracketed] blanks
 * for the business-specific parts. The readiness check refuses to call the
 * instructions done while a blank is still there.
 */
export const STARTERS = [
  {
    key: 'faq', title: 'Answer questions', icon: HelpCircle,
    blurb: 'Replies to questions about your business, prices and timings.',
    description: 'Answers customer questions on WhatsApp',
    triggerMode: 'any',
    prompt: `You are the WhatsApp assistant for [your business name], which [what you do, in one line].

What you know:
- Products / services: [list them with prices]
- Timings: [opening hours or batch timings]
- Location / how it works: [address, online or offline]

How to reply:
- Answer in 2-4 short sentences. Match the customer's language (English, Tamil or a mix).
- If you do not know something, say so and offer to connect them with the team. Never invent prices, dates or offers.
- End with one helpful next step, e.g. asking which option they are interested in.`,
  },
  {
    key: 'leads', title: 'Qualify new leads', icon: ShoppingBag,
    blurb: 'Greets first-time enquiries and finds out what they need.',
    description: 'Qualifies new WhatsApp enquiries',
    triggerMode: 'new',
    prompt: `You are the first point of contact for [your business name] on WhatsApp. New enquiries come from our ads and website.

Your job is to understand what the person needs before our team calls them. Over a few friendly messages, find out:
1. Their name
2. What they are looking for: [your products or services]
3. Their timeline and budget, if they are comfortable sharing

How to reply:
- One question at a time. Keep every message short and warm.
- Answer simple questions about [what you sell], but never promise discounts or dates.
- Once you have the answers, thank them and say someone from the team will reach out shortly.`,
  },
  {
    key: 'booking', title: 'Book appointments', icon: CalendarCheck,
    blurb: 'Collects a preferred day and time for a call, visit or demo.',
    description: 'Books calls and visits over WhatsApp',
    triggerMode: 'any',
    prompt: `You help customers of [your business name] book a [call / visit / demo] over WhatsApp.

Available slots: [days and times you take bookings]

How to book:
- Ask for their name, preferred day and preferred time, one question at a time.
- Repeat the booking back to them to confirm.
- If they ask for a time outside the slots above, suggest the nearest available one.
- Never confirm a slot you were not told about. If unsure, say the team will confirm shortly.`,
  },
  {
    key: 'support', title: 'Customer support', icon: LifeBuoy,
    blurb: 'Helps existing customers with problems and common requests.',
    description: 'Handles customer support on WhatsApp',
    triggerMode: 'any',
    prompt: `You are the support assistant for [your business name] on WhatsApp, helping existing customers.

Common requests and what to say:
- [request 1]: [answer]
- [request 2]: [answer]
- Refunds or cancellations: [your policy]

How to reply:
- Be calm and kind, even if the customer is upset. Apologise once, then help.
- Ask for the details you need (order id, registered number) before answering.
- If the problem is not covered above, tell them a team member will follow up. Never guess.`,
  },
];

/** True when the instructions are still the untouched default or a starter with blanks. */
export function instructionsState(prompt) {
  const p = String(prompt || '').trim();
  if (!p || p === DEFAULT_PROMPT) return 'empty';
  if (BLANK_RE.test(p)) return 'blanks';
  if (p.length < 40) return 'short';
  return 'ok';
}

const TRIGGER_TEXT = {
  any: 'Replies to every message on its number',
  new: 'Replies to new conversations only',
};

/**
 * Everything the operator should do before the agent goes live, in the order
 * they meet it. `blocking` items are the ones the SERVER refuses an active
 * agent without (agentService: name, a model, a keyword in keyword mode) —
 * the rest are advice, flagged but never enforced, so no agent that could go
 * live today is stopped by this.
 */
export function agentReadiness({ form, hasModel, isCreate, tested, waAccounts = [] }) {
  const mode = form.triggerMode || 'any';
  const wa = waAccounts.find(w => String(w.id) === String(form.waAccountId));
  const inst = instructionsState(form.systemPrompt);
  return [
    {
      key: 'name', tab: 'setup', blocking: true,
      label: 'Name it',
      done: !!String(form.name || '').trim(),
      hint: 'A label for you — customers never see it.',
    },
    {
      key: 'number', tab: 'setup', blocking: false,
      label: 'Pick its WhatsApp number',
      done: !!form.waAccountId,
      doneText: wa ? wa.displayName : null,
      hint: 'The number it answers on. Without one it never replies to anyone.',
    },
    {
      key: 'instructions', tab: 'ai', blocking: false,
      label: 'Tell it what to do',
      done: inst === 'ok',
      hint: inst === 'blanks'
        ? 'Fill in the [bracketed] parts of the instructions with your own details.'
        : inst === 'short'
          ? 'Add a little more — what you sell, how to talk, and what it must never say.'
          : 'Start from a template on the AI tab, or write a short brief like you would for a new hire.',
    },
    {
      key: 'model', tab: 'ai', blocking: true,
      label: 'Choose an AI model',
      done: !!hasModel,
      hint: 'Which AI writes the replies. Keys are added once under Integrations → AI Models.',
    },
    {
      key: 'trigger', tab: 'setup', blocking: mode === 'keyword',
      label: mode === 'keyword' ? 'Set its keyword' : 'Decide when it replies',
      done: mode !== 'keyword' || !!String(form.triggerKeyword || '').trim(),
      doneText: mode === 'keyword' ? `Keyword "${String(form.triggerKeyword || '').trim()}"` : TRIGGER_TEXT[mode],
      hint: 'A keyword-only agent needs the word customers will send.',
    },
    {
      key: 'test', tab: null, blocking: false,
      label: 'Try it out',
      done: !!tested || !!form.isActive,
      hint: isCreate
        ? 'Create the agent, then chat with it in the test phone on the right.'
        : 'Send it a message in the test phone on the right — nothing goes to WhatsApp.',
    },
  ];
}

/** Per-tab mark for the tab strip: 'todo' when a check owned by it is open. */
export function tabMarks(checks) {
  const marks = {};
  for (const c of checks) {
    if (!c.tab) continue;
    if (!c.done) marks[c.tab] = 'todo';
    else if (!marks[c.tab]) marks[c.tab] = 'done';
  }
  return marks;
}

/**
 * "Getting it live" — the checklist across the top of the editor. Each step is
 * a button that opens the tab where it is fixed; the first open step is spelled
 * out with its reason. Once everything is done and the agent is live it folds
 * to one line, because a finished checklist on every visit is noise.
 */
export function ReadinessPanel({ checks, isActive, isCreate, onJump, onTest }) {
  const doneCount = checks.filter(c => c.done).length;
  const allDone = doneCount === checks.length;
  const next = checks.find(c => !c.done);
  const [open, setOpen] = useState(!(allDone && isActive));
  const pct = Math.round((doneCount / checks.length) * 100);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} data-testid="readiness-collapsed"
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', marginBottom: 16,
          padding: '10px 14px', borderRadius: 10, border: 'none', cursor: 'pointer',
          background: C.successBgSoft, color: C.successText, fontFamily: FONT,
          fontSize: T.body, fontWeight: W.medium, textAlign: 'left',
        }}>
        <Check size={15} /> All set — every step is done.
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: T.meta }}>
          Show checklist <ChevronDown size={14} />
        </span>
      </button>
    );
  }

  return (
    <div data-testid="readiness" style={{
      marginBottom: 18, padding: '14px 16px', borderRadius: 12,
      background: C.cardBg, border: `1px solid ${C.border}`, fontFamily: FONT,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{ fontSize: T.bodyLg, fontWeight: W.bold, color: C.text }}>
          {isCreate ? 'Set up your agent' : (isActive ? 'Live checklist' : 'Getting it live')}
        </div>
        <div style={{ fontSize: T.meta, color: C.textMuted, fontWeight: W.medium }}>
          {doneCount} of {checks.length} done
        </div>
        <div style={{ flex: 1, minWidth: 40, height: 6, borderRadius: 99, background: C.surfaceMuted, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', borderRadius: 99, background: allDone ? C.successBright : C.primary, transition: 'width .25s ease' }} />
        </div>
        {allDone && isActive && (
          <button type="button" onClick={() => setOpen(false)} title="Fold the checklist"
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted, fontFamily: FONT, fontSize: T.meta, fontWeight: W.medium }}>
            Hide
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {checks.map((c, i) => (
          <button key={c.key} type="button" data-step={c.key} data-done={c.done ? '1' : '0'}
            onClick={() => (c.tab ? onJump(c.tab) : onTest?.())}
            title={c.done ? (c.doneText || 'Done') : c.hint}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '6px 11px 6px 6px', borderRadius: 99, cursor: 'pointer', fontFamily: FONT,
              border: `1px solid ${c === next ? C.primary : C.border}`,
              background: c.done ? C.surfaceInner : C.cardBg,
              color: c.done ? C.textSecondary : C.text, fontSize: T.meta, fontWeight: W.medium,
            }}>
            <span style={{
              width: 20, height: 20, borderRadius: 99, flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: c.done ? C.successBright : (c === next ? C.primary : C.surfaceMuted),
              color: c.done || c === next ? '#fff' : C.textSecondary, fontSize: T.micro, fontWeight: W.bold,
            }}>
              {c.done ? <Check size={12} strokeWidth={3} /> : i + 1}
            </span>
            {c.label}
            {!c.done && c.blocking && (
              <span style={{ fontSize: T.micro, fontWeight: W.bold, color: C.primary }}>required</span>
            )}
          </button>
        ))}
      </div>

      {next && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, padding: '9px 12px',
          borderRadius: 9, background: C.surfaceInner, fontSize: T.body, lineHeight: LH.snug,
        }}>
          <span style={{ color: C.textSecondary }}>
            <strong style={{ color: C.text, fontWeight: W.bold }}>Next: {next.label.toLowerCase()}.</strong> {next.hint}
          </span>
          {(next.tab || onTest) && (
            <button type="button" data-testid="readiness-next"
              onClick={() => (next.tab ? onJump(next.tab) : onTest?.())}
              style={{
                marginLeft: 'auto', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '6px 11px', borderRadius: 8, border: 'none', cursor: 'pointer',
                background: C.primary, color: '#fff', fontFamily: FONT, fontSize: T.meta, fontWeight: W.bold,
              }}>
              {next.tab ? 'Open' : 'Show me'} <ChevronRight size={13} />
            </button>
          )}
        </div>
      )}
      {!next && !isActive && !isCreate && (
        <div style={{ marginTop: 10, fontSize: T.body, color: C.successText, fontWeight: W.medium }}>
          Ready. Press <strong>Go Live</strong> at the top when you want it answering customers.
        </div>
      )}
    </div>
  );
}

/**
 * "Start from a template" — fills the Instructions box. Replacing a prompt the
 * operator has written asks first (the caller passes `confirmReplace`), since
 * one click here would otherwise wipe an afternoon's wording.
 */
export function StarterPicker({ prompt, onPick, confirmReplace }) {
  const pick = async (s) => {
    const cur = String(prompt || '').trim();
    const untouched = !cur || cur === DEFAULT_PROMPT || STARTERS.some(x => x.prompt === cur);
    if (!untouched) {
      const ok = await confirmReplace(s);
      if (!ok) return;
    }
    onPick(s);
  };
  const current = STARTERS.find(s => s.prompt === String(prompt || '').trim());
  return (
    <div data-testid="starters" style={{ marginBottom: 14 }}>
      <div style={{ fontSize: T.meta, fontWeight: W.bold, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>
        Start from a template
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
        {STARTERS.map(s => {
          const Icon = s.icon;
          const on = current?.key === s.key;
          return (
            <button key={s.key} type="button" data-starter={s.key} onClick={() => pick(s)}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, textAlign: 'left',
                padding: '10px 12px', borderRadius: 10, cursor: 'pointer', fontFamily: FONT,
                border: `1.5px solid ${on ? C.primary : C.border}`,
                background: on ? C.dangerBgSoft : C.cardBg,
              }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: T.body, fontWeight: W.bold, color: on ? C.primary : C.text }}>
                <Icon size={15} /> {s.title}
              </span>
              <span style={{ fontSize: T.meta, color: C.textSecondary, lineHeight: LH.snug }}>{s.blurb}</span>
            </button>
          );
        })}
        <button type="button" data-starter="blank" onClick={() => pick({ key: 'blank', prompt: '', description: '', triggerMode: null })}
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, textAlign: 'left',
            padding: '10px 12px', borderRadius: 10, cursor: 'pointer', fontFamily: FONT,
            border: `1.5px dashed ${C.border}`, background: 'transparent',
          }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: T.body, fontWeight: W.bold, color: C.text }}>
            <FilePlus2 size={15} /> Write my own
          </span>
          <span style={{ fontSize: T.meta, color: C.textSecondary, lineHeight: LH.snug }}>Clear the box and start from scratch.</span>
        </button>
      </div>
    </div>
  );
}

/** One-line writing tips under the Instructions box. */
export function InstructionTips({ prompt }) {
  const inst = instructionsState(prompt);
  const words = String(prompt || '').trim().split(/\s+/).filter(Boolean).length;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 8, fontSize: T.meta, color: C.textMuted, lineHeight: LH.normal }}>
      <Sparkles size={13} style={{ flexShrink: 0, marginTop: 3 }} />
      <span style={{ flex: 1 }}>
        {inst === 'blanks'
          ? <span style={{ color: C.warnText, fontWeight: W.medium }}>Replace every [bracketed] part with your own details before going live.</span>
          : 'Write it like a brief for a new team member: who you are, what you sell, how to talk, and what it must never say or promise.'}
      </span>
      <span style={{ flexShrink: 0 }}>{words} words</span>
    </div>
  );
}
