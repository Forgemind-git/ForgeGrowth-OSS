// Shared pieces for the Workflow Agents pages: status vocabularies, formatting,
// and the small form controls the builder repeats (multi-pick, chip input, JSON
// block). Everything reads the C / T / W tokens so both themes work unchanged.

import { useEffect, useState } from 'react';
import {
  X, ChevronDown, ChevronRight, Copy, Check, Bot, Radar, SearchCheck, MessageSquareReply,
  Timer, Megaphone, Wallet, AlertTriangle, Info,
} from 'lucide-react';
import { C, FONT, MONO, T, W, LH } from '../../constants.js';
import { Badge, inputStyle } from '../academy/shared.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';

// ── vocabularies ──────────────────────────────────────────────────────────────

export const AGENT_STATUS = {
  draft: { label: 'Draft', color: C.t3, bg: C.surfaceMuted },
  active: { label: 'Active', color: C.successText, bg: C.successBg },
  paused: { label: 'Paused', color: C.warnText, bg: C.warnBg },
};

export const RUN_STATUS = {
  queued: { label: 'Queued', color: C.infoText, bg: C.infoBg },
  running: { label: 'Running', color: C.infoText, bg: C.infoBg },
  succeeded: { label: 'Succeeded', color: C.successText, bg: C.successBg },
  failed: { label: 'Failed', color: C.dangerText, bg: C.dangerBg },
  cancelled: { label: 'Cancelled', color: C.t3, bg: C.surfaceMuted },
  budget_stopped: { label: 'Stopped at budget', color: C.warnText, bg: C.warnBg },
};

export const ACTION_STATUS = {
  pending: { label: 'Waiting for approval', color: C.warnText, bg: C.warnBg },
  approved: { label: 'Approved', color: C.infoText, bg: C.infoBg },
  executed: { label: 'Done', color: C.successText, bg: C.successBg },
  failed: { label: 'Failed', color: C.dangerText, bg: C.dangerBg },
  rejected: { label: 'Rejected', color: C.t3, bg: C.surfaceMuted },
  expired: { label: 'Expired', color: C.t3, bg: C.surfaceMuted },
};

export const LEAD_LABEL = {
  hot: { label: 'Hot', color: C.dangerText, bg: C.dangerBg },
  warm: { label: 'Warm', color: C.orangeText, bg: C.orangeBg },
  watch: { label: 'Watch', color: C.infoText, bg: C.infoBg },
  slipping: { label: 'Slipping', color: C.purple, bg: C.purpleBg },
};

export const TRIGGER_LABEL = { schedule: 'Schedule', event: 'Event', manual: 'Manual', test: 'Test run' };

export const ACTION_TYPE_LABEL = {
  tag_contact: 'Tag contact',
  set_stage: 'Move funnel stage',
  assign_rep: 'Assign owner',
  create_task: 'Create follow-up task',
  send_whatsapp: 'Send WhatsApp message',
  add_note: 'Add internal note',
  trigger_automation: 'Run automation',
  notify_rep: 'Notify rep',
};

export const EVENT_LABEL = {
  'message.inbound': 'A lead sends a message',
  'lead.stage_changed': 'A lead changes funnel stage',
  'lead.quiet': 'A lead goes quiet',
  'payment.created': 'A payment arrives',
};

export const CHAT_TYPE_INFO = {
  lead_bot: { label: 'Lead ↔ bot', hint: 'Conversations with automations and AI agents.' },
  lead_rep: { label: 'Lead ↔ rep', hint: 'Messages a person typed to the lead.' },
  broadcast: { label: 'Broadcasts', hint: 'Bulk and scheduled campaign messages.' },
  voice_note: { label: 'Voice notes', hint: 'Audio from leads, with transcripts where available.' },
  media: { label: 'Images & files', hint: 'Photos, documents and video (never the bytes).' },
  ad_referral: { label: 'Ad clicks', hint: 'Click-to-WhatsApp ad referrals.' },
  internal_note: { label: 'Internal notes', hint: 'Notes on the lead that the customer never saw.' },
};

export const MEMORY_KIND = {
  pinned: { label: 'Pinned', color: C.primary, bg: C.primaryLight, hint: 'Rules and facts the agent always reads.' },
  learned: { label: 'Learned', color: C.infoText, bg: C.infoBg, hint: 'Patterns found in past runs.' },
  contact: { label: 'Contact', color: C.teal, bg: C.tealBg, hint: 'A note about one lead.' },
  glossary: { label: 'Glossary', color: C.purple, bg: C.purpleBg, hint: 'What your terms mean.' },
};

const ICONS = { radar: Radar, 'search-check': SearchCheck, 'message-square-reply': MessageSquareReply, timer: Timer, megaphone: Megaphone, wallet: Wallet };
export const agentIcon = (name) => ICONS[name] || Bot;

export function Pill({ meta, fallback }) {
  const m = meta || { label: fallback || '—', color: C.t3, bg: C.surfaceMuted };
  return <Badge label={m.label} color={m.color} bg={m.bg} />;
}

// ── formatting (every server timestamp already carries +05:30) ────────────────

export function rupees(n) {
  const v = Number(n || 0);
  const digits = v !== 0 && Math.abs(v) < 100 ? 2 : 0;
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function when(iso, { date = true, time = true } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const opts = { timeZone: 'Asia/Kolkata' };
  if (date) Object.assign(opts, { day: 'numeric', month: 'short' });
  if (time) Object.assign(opts, { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toLocaleString('en-IN', opts);
}

export function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) {
    const f = -s;
    if (f < 3600) return `in ${Math.max(1, Math.round(f / 60))} min`;
    if (f < 86400) return `in ${Math.round(f / 3600)} h`;
    return `in ${Math.round(f / 86400)} d`;
  }
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function duration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function compact(n) {
  const v = Number(n || 0);
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${Math.round(v / 1e3)}k`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

/** Key-order-independent JSON, so a dirty check does not fire on a reordered object. */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

export function useNarrow(px = 760) {
  const q = `(max-width: ${px}px)`;
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return narrow;
}

// ── layout pieces ─────────────────────────────────────────────────────────────

export function Panel({ title, hint, right, children, style, bodyStyle }) {
  return (
    <section style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: C.shadowSm, fontFamily: FONT, minWidth: 0, ...style }}>
      {(title || right) && (
        <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '14px 18px', borderBottom: children != null && children !== false ? `1px solid ${C.border}` : 'none', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: T.lead, fontWeight: W.bold, color: C.text }}>{title}</div>
            {hint && <div style={{ fontSize: T.meta, color: C.textSecondary, marginTop: 3, lineHeight: LH.normal }}>{hint}</div>}
          </div>
          {right && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{right}</div>}
        </header>
      )}
      {children != null && children !== false && <div style={{ padding: 18, ...bodyStyle }}>{children}</div>}
    </section>
  );
}

export function Notice({ tone = 'info', children, style }) {
  const tones = {
    info: { color: C.infoText, bg: C.infoBg, border: C.infoBorder, Icon: Info },
    warn: { color: C.warnText, bg: C.warnBg, border: C.warnBorder, Icon: AlertTriangle },
    danger: { color: C.dangerText, bg: C.dangerBg, border: C.dangerBorder, Icon: AlertTriangle },
    success: { color: C.successText, bg: C.successBg, border: C.successBorder, Icon: Check },
  };
  const t = tones[tone] || tones.info;
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 14px', borderRadius: 10, background: t.bg, border: `1px solid ${t.border}`, color: t.color, fontSize: T.body, lineHeight: LH.normal, fontFamily: FONT, ...style }}>
      <t.Icon size={17} style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

export function Collapsible({ title, right, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.cardBg }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px' }}>
        <button type="button" onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: C.text, fontFamily: FONT, fontSize: T.body, fontWeight: W.medium, textAlign: 'left' }}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        </button>
        {right}
      </div>
      {open && <div style={{ padding: '0 12px 12px' }}>{children}</div>}
    </div>
  );
}

export function JsonBlock({ value, maxChars = 6000, style }) {
  const [all, setAll] = useState(false);
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const long = text && text.length > maxChars;
  return (
    <div>
      <pre style={{ margin: 0, padding: 12, borderRadius: 8, background: C.surfaceInner, border: `1px solid ${C.borderSubtle}`, color: C.t2, fontFamily: MONO, fontSize: T.meta, lineHeight: LH.snug, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: all ? 'none' : 420, overflow: 'auto', ...style }}>
        {long && !all ? `${text.slice(0, maxChars)}\n…` : text}
      </pre>
      {long && (
        <button type="button" onClick={() => setAll(a => !a)} style={{ marginTop: 6, background: 'none', border: 'none', color: C.primary, cursor: 'pointer', fontFamily: FONT, fontSize: T.meta, fontWeight: W.medium, padding: 0 }}>
          {all ? 'Show less' : `Show all ${compact(text.length)} characters`}
        </button>
      )}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text || ''); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked: nothing to do */ }
  };
  return (
    <button type="button" onClick={copy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 8, border: `1.5px solid ${C.border}`, background: C.cardBg, color: C.text, cursor: 'pointer', fontFamily: FONT, fontSize: T.body, fontWeight: W.medium }}>
      {done ? <Check size={15} /> : <Copy size={15} />}{done ? 'Copied' : label}
    </button>
  );
}

/**
 * A labelled form group. A <div>, not academy's <label>: most controls here are
 * buttons (day pickers, segmented pills, toggles), and a <label> forwards a click
 * on its caption to the first button inside it, which would flip that button.
 */
export function Field({ label, hint, children, style }) {
  return (
    <div style={{ marginBottom: 13, minWidth: 0, ...style }}>
      <div style={{ fontSize: T.label, fontWeight: W.medium, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textSecondary, marginBottom: 6 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: T.meta, color: C.textMuted, marginTop: 4, lineHeight: LH.normal }}>{hint}</div>}
    </div>
  );
}

export function Label({ children, hint }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: T.label, fontWeight: W.medium, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textSecondary }}>{children}</div>
      {hint && <div style={{ fontSize: T.meta, color: C.textMuted, marginTop: 2, lineHeight: LH.normal }}>{hint}</div>}
    </div>
  );
}

export function NumberInput({ value, onChange, min, max, step = 1, placeholder, style, disabled }) {
  return (
    <input
      type="number" inputMode="decimal" value={value ?? ''} min={min} max={max} step={step} placeholder={placeholder} disabled={disabled}
      onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))}
      style={{ ...inputStyle, fontFamily: MONO, ...style }}
    />
  );
}

export const textareaStyle = { ...inputStyle, fontFamily: FONT, lineHeight: LH.normal, resize: 'vertical' };

/** Chips for the chosen values plus a searchable picker for the rest. `allLabel` adds an explicit "All" state. */
export function MultiPick({ options, value, onChange, placeholder = 'Add…', allLabel = null, emptyText }) {
  const all = allLabel && (!value || value.length === 0 || value.includes('all'));
  const chosen = all ? [] : (value || []);
  const byValue = new Map(options.map(o => [String(o.value), o]));
  const remaining = options.filter(o => !chosen.includes(String(o.value)));
  const setChosen = (next) => onChange(allLabel && next.length === 0 ? ['all'] : next);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {allLabel && (
          <button type="button" onClick={() => onChange(['all'])} style={chipStyle(all)}>
            {allLabel}
          </button>
        )}
        {chosen.map(v => (
          <span key={v} style={{ ...chipStyle(true), cursor: 'default' }}>
            {byValue.get(String(v))?.label || v}
            <button type="button" aria-label="Remove" onClick={() => setChosen(chosen.filter(x => x !== v))} style={{ display: 'inline-flex', background: 'none', border: 'none', padding: 0, marginLeft: 2, cursor: 'pointer', color: 'inherit' }}>
              <X size={13} />
            </button>
          </span>
        ))}
      </div>
      {remaining.length > 0 && (
        <SearchableSelect
          value="" placeholder={placeholder} emptyText={emptyText}
          options={remaining.map(o => ({ value: String(o.value), label: o.label, sublabel: o.sublabel }))}
          onChange={(v) => setChosen([...chosen, String(v)])}
        />
      )}
    </div>
  );
}

function chipStyle(on) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 999, cursor: 'pointer',
    border: `1.5px solid ${on ? C.primary : C.border}`, background: on ? C.primaryLight : C.cardBg,
    color: on ? C.dangerText : C.t3, fontFamily: FONT, fontSize: T.meta, fontWeight: W.medium,
  };
}

/** Free-text chips (tags, emails, numbers). Enter or comma adds. */
export function ChipInput({ value, onChange, placeholder, normalize = (s) => s.trim(), validate = () => null }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(null);
  const list = value || [];
  const add = () => {
    const v = normalize(draft);
    if (!v) return;
    const problem = validate(v);
    if (problem) { setError(problem); return; }
    if (!list.includes(v)) onChange([...list, v]);
    setDraft(''); setError(null);
  };
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: list.length ? 8 : 0 }}>
        {list.map(v => (
          <span key={v} style={{ ...chipStyle(true), cursor: 'default' }}>
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(list.filter(x => x !== v))} style={{ display: 'inline-flex', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit' }}><X size={13} /></button>
          </span>
        ))}
      </div>
      <input
        value={draft} placeholder={placeholder} style={inputStyle}
        onChange={e => { setDraft(e.target.value); setError(null); }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
        onBlur={add}
      />
      {error && <div style={{ fontSize: T.meta, color: C.dangerText, marginTop: 4 }}>{error}</div>}
    </div>
  );
}

export function Stat({ label, value, sub }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: T.label, fontWeight: W.medium, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textMuted }}>{label}</div>
      <div style={{ fontSize: T.lead, fontWeight: W.bold, color: C.text, fontFamily: MONO, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: T.meta, color: C.textSecondary, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// ── markdown (rendered as elements, never as HTML) ────────────────────────────

function inline(text, keyBase) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0; let m; let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={`${keyBase}-${i++}`} style={{ fontWeight: W.bold, color: C.text }}>{tok.slice(2, -2)}</strong>);
    else out.push(<code key={`${keyBase}-${i++}`} style={{ fontFamily: MONO, fontSize: '0.92em', background: C.surfaceMuted, padding: '1px 5px', borderRadius: 4 }}>{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MiniMarkdown({ text }) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let table = null;
  const flushTable = () => {
    if (!table) return;
    const rows = table.filter(r => !/^\|\s*-/.test(r)).map(r => r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|')));
    const [head, ...body] = rows;
    blocks.push(
      <div key={`t${blocks.length}`} style={{ overflowX: 'auto', margin: '8px 0' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: T.meta, fontFamily: FONT }}>
          <thead><tr>{head.map((h, i) => <th key={i} style={{ textAlign: 'left', padding: '6px 10px', borderBottom: `1px solid ${C.border}`, color: C.textMuted, fontWeight: W.bold }}>{h}</th>)}</tr></thead>
          <tbody>{body.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} style={{ padding: '6px 10px', borderBottom: `1px solid ${C.borderSubtle}`, color: C.t2 }}>{c}</td>)}</tr>)}</tbody>
        </table>
      </div>,
    );
    table = null;
  };
  lines.forEach((raw, idx) => {
    const line = raw.replace(/\s+$/, '');
    if (/^\|/.test(line)) { (table ||= []).push(line); return; }
    flushTable();
    const k = `l${idx}`;
    if (!line.trim()) { blocks.push(<div key={k} style={{ height: 8 }} />); return; }
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      const size = [T.h3, T.lead, T.bodyLg][m[1].length - 1];
      blocks.push(<div key={k} style={{ fontSize: size, fontWeight: W.bold, color: C.text, margin: '10px 0 4px' }}>{inline(m[2], k)}</div>);
      return;
    }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      blocks.push(<div key={k} style={{ borderLeft: `3px solid ${C.borderStrong}`, padding: '2px 10px', margin: '3px 0 3px 18px', color: C.t3, fontStyle: 'italic' }}>{inline(m[1], k)}</div>);
      return;
    }
    if ((m = /^(\s*)(?:[-*]|\d+\.)\s+(.*)$/.exec(line))) {
      const num = /^\s*(\d+)\./.exec(line);
      blocks.push(
        <div key={k} style={{ display: 'flex', gap: 8, paddingLeft: Math.min(3, Math.floor(m[1].length / 2)) * 16, margin: '2px 0' }}>
          <span style={{ color: C.textMuted, fontFamily: num ? MONO : FONT, minWidth: num ? 20 : 8 }}>{num ? `${num[1]}.` : '•'}</span>
          <span style={{ minWidth: 0 }}>{inline(m[2], k)}</span>
        </div>,
      );
      return;
    }
    const indent = /^(\s+)/.exec(line);
    blocks.push(<div key={k} style={{ margin: '2px 0', paddingLeft: indent ? 28 : 0 }}>{inline(line.trim(), k)}</div>);
  });
  flushTable();
  return <div style={{ fontFamily: FONT, fontSize: T.body, color: C.t2, lineHeight: LH.normal, wordBreak: 'break-word' }}>{blocks}</div>;
}
