// The contact profile pop-up — Sales' version of Social → Contacts' profile
// (social/components/ContactModal.jsx), same shape: identity on the left, the
// data on the right in tabs, and the WhatsApp chat in a side drawer that opens
// INSIDE the pop-up.
//
//   Overview     — at-a-glance tiles, the details that are actually filled in,
//                  the chats, the latest automations and the stage history
//   Fields       — every system field and every custom field, empty ones too;
//                  custom fields edit inline, system fields through Edit details
//   Automations  — every automation run and AI-agent run for this person
//
// Data: GET /leads/:id/profile (services/leadProfile.js). The chat drawer is the
// real ChatWindow, so replying, templates and media all work from here.
//
// ⚠ Empty fields are hidden on the Overview on purpose — most contacts have
// data in a handful of the ~25 fields, and a wall of dashes is what made the
// old lead view unreadable. The Fields tab still lists all of them.
import { useState, useEffect, useCallback } from 'react';
import {
  X, MessageSquare, Pencil, Loader2, Workflow, Bot, Check, ExternalLink, ArrowRight, History, Plus,
} from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO, T, W, relativeTime } from '../../constants.js';
import { showError } from '../../lib/feedback.js';
import MaskedNumber from '../../components/MaskedNumber.jsx';
import ChatWindow from '../../components/ChatWindow.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import PaymentStatusBadge from '../../components/PaymentStatusBadge.jsx';
import { StageBadge, fmtINR } from '../academy/shared.jsx';
import LeadEditModal from './LeadEditModal.jsx';

const PALETTE = [
  [C.pinkBg, C.pink], [C.infoBg, C.infoText], [C.successBg, C.successText],
  [C.warnBg, C.warnText], [C.purpleBg, C.purple], [C.tealBg, C.teal],
];
function avatarColor(seed) {
  const s = String(seed || '?'); let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const initials = (s) => {
  const p = String(s || '?').trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase() || '?';
};
export function ContactAvatar({ label, seed, size = 40 }) {
  const [bg, color] = avatarColor(seed ?? label);
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, background: bg, color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: Math.round(size * 0.36), fontWeight: W.bold, fontFamily: FONT }}>
      {initials(label)}
    </div>
  );
}
// A name that is really a message ("Hi there! I'm interested…") — WhatsApp
// profile names are whatever the person typed — is shortened rather than left to
// stretch a column across the screen.
export const contactName = (l) => {
  const n = String(l?.name || '').trim();
  return n || 'Unnamed contact';
};
const fmtWhen = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : null);

const btn = {
  primary: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '10px 14px', borderRadius: 10, border: 'none', background: C.primary, color: '#fff', fontFamily: FONT, fontSize: T.body, fontWeight: W.bold, cursor: 'pointer' },
  secondary: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '9px 14px', borderRadius: 10, border: `1.5px solid ${C.border}`, background: C.cardBg, color: C.text, fontFamily: FONT, fontSize: T.body, fontWeight: W.medium, cursor: 'pointer' },
  icon: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 10, border: `1.5px solid ${C.border}`, background: C.cardBg, color: C.textSecondary, cursor: 'pointer', flexShrink: 0 },
  link: { background: 'none', border: 'none', padding: '2px 4px', cursor: 'pointer', color: C.primary, fontFamily: FONT, fontSize: T.meta, fontWeight: W.medium, display: 'inline-flex', alignItems: 'center', gap: 4 },
};

export default function ContactProfileModal({ leadId, lead: lead0, user, navigate, onClose, onChanged, initialChat = false }) {
  const id = leadId ?? lead0?.id;
  const [p, setP] = useState(null);
  const [tab, setTab] = useState('overview');
  const [chatOpen, setChatOpen] = useState(!!initialChat);
  const [thread, setThread] = useState(null); // `${wa}|${contact}`
  const [editing, setEditing] = useState(false);
  const isAdmin = user?.role === 'admin';

  const load = useCallback(() => api.leads.profile(id).then(setP).catch(e => { showError(e.message); onClose?.(); }), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape' && !editing) (chatOpen ? setChatOpen(false) : onClose?.()); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onClose, chatOpen, editing]);
  // Default chat = the most recent thread.
  useEffect(() => { if (p?.threads?.length && !thread) setThread(`${p.threads[0].waNumber}|${p.threads[0].contactNumber}`); }, [p]); // eslint-disable-line react-hooks/exhaustive-deps

  const l = p?.lead || lead0 || {};
  const label = contactName(l);
  const threads = p?.threads || [];
  const [selWa, selContact] = (thread || '').split('|');
  const filledCustom = (p?.custom || []).filter(f => f.value != null);
  const changed = () => { load(); onChanged?.(); };

  const openChat = (t) => {
    if (t) setThread(`${t.waNumber}|${t.contactNumber}`);
    setChatOpen(true);
  };

  return (
    <>
      <div onMouseDown={e => e.target === e.currentTarget && onClose?.()}
        style={{ position: 'fixed', inset: 0, zIndex: 180, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: FONT }}>
        <div role="dialog" aria-label={`Contact ${label}`} data-testid="contact-profile"
          style={{ position: 'relative', width: 'min(1120px, 100%)', height: 'min(760px, 100%)', background: C.cardBg, borderRadius: 18, boxShadow: C.shadowLg, display: 'flex', overflow: 'hidden' }}>
          {/* ── left: identity ── */}
          <div style={{ width: 300, flex: '0 0 300px', background: C.surfaceSection, padding: 22, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', overflowY: 'auto', borderRight: `1px solid ${C.borderSubtle}` }}>
            <ContactAvatar label={label} seed={l.whatsappNumber} size={88} />
            <div style={{ marginTop: 14, fontSize: T.h3, fontWeight: W.heavy, color: C.text, lineHeight: 1.25, wordBreak: 'break-word', maxWidth: '100%', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }} title={label}>{label}</div>
            {l.whatsappNumber && <div style={{ marginTop: 4, fontFamily: MONO, fontSize: T.meta, color: C.textSecondary }}><MaskedNumber number={l.whatsappNumber} prefix="+" /></div>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginTop: 12 }}>
              {l.stage && <StageBadge stage={l.stage} />}
              {l.source && <Chip>{l.source}</Chip>}
              {threads.some(t => t.windowOpen) && <Chip tone="green">24h window open</Chip>}
            </div>
            <div style={{ width: '100%', marginTop: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button onClick={() => openChat()} disabled={!threads.length} data-testid="open-chat"
                style={{ ...btn.primary, opacity: threads.length ? 1 : 0.55, cursor: threads.length ? 'pointer' : 'not-allowed' }}
                title={threads.length ? 'Open the WhatsApp chat here' : 'This contact has not messaged us yet'}>
                <MessageSquare size={15} /> {threads.length ? 'Open chat' : 'No chat yet'}
              </button>
              <button onClick={() => setEditing(true)} style={btn.secondary} disabled={!p}><Pencil size={14} /> Edit details</button>
            </div>
            <div style={{ width: '100%', marginTop: 20, textAlign: 'left' }}>
              <Mini label="Owner" value={l.assignedUserName || l.assignedBda || 'Unassigned'} muted={!l.assignedUserName && !l.assignedBda} />
              <Mini label="Arrived" value={l.createdAt ? fmtWhen(l.createdAt) : '—'} />
              <Mini label="Last activity" value={l.lastActivityAt ? relativeTime(l.lastActivityAt) : '—'} />
              <Mini label="Chats" value={threads.length ? `${threads.length} · ${threads.reduce((a, t) => a + t.messageCount, 0)} messages` : 'None yet'} />
              <Mini label="Contact ID" value={String(l.id || '—')} mono />
            </div>
          </div>

          {/* ── right: data ── */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px 0 22px', gap: 8, borderBottom: `1px solid ${C.border}` }}>
              <div role="tablist" style={{ display: 'flex', gap: 2, flex: 1 }}>
                {[
                  { id: 'overview', label: 'Overview' },
                  { id: 'fields', label: 'Fields', count: p ? filledCustom.length + p.system.filter(s => s.value != null).length : undefined },
                  { id: 'activity', label: 'Automations', count: p?.activity?.length },
                ].map(t => (
                  <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '10px 12px', marginBottom: -1, fontFamily: FONT, fontSize: T.bodyLg, fontWeight: tab === t.id ? W.bold : W.medium, color: tab === t.id ? C.text : C.textSecondary, borderBottom: `2px solid ${tab === t.id ? C.primary : 'transparent'}`, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {t.label}
                    {t.count != null && <span style={{ fontSize: T.micro, fontWeight: W.bold, padding: '1px 7px', borderRadius: 99, background: C.surfaceMuted, color: C.textSecondary }}>{t.count}</span>}
                  </button>
                ))}
              </div>
              <button onClick={onClose} style={{ ...btn.icon, border: 'none', background: 'transparent' }} aria-label="Close"><X size={17} /></button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px 26px' }}>
              {!p ? <div style={{ display: 'flex', justifyContent: 'center', padding: 60, color: C.textMuted }}><Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /></div>
                : tab === 'overview' ? <Overview p={p} openChat={openChat} goTab={setTab} />
                : tab === 'fields' ? <Fields p={p} onSaved={changed} />
                : <Activity rows={p.activity} navigate={navigate} />}
            </div>
          </div>

          {/* ── chat drawer, inside the pop-up ── */}
          {chatOpen && threads.length > 0 && (
            <div data-testid="chat-drawer"
              style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 'min(560px, 100%)', background: C.cardBg, borderLeft: `1px solid ${C.border}`, boxShadow: '-12px 0 32px rgba(0,0,0,.18)', display: 'flex', flexDirection: 'column', zIndex: 5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
                <MessageSquare size={16} color={C.textSecondary} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  {threads.length > 1 ? (
                    <SearchableSelect value={thread || ''} onChange={setThread}
                      options={threads.map(t => ({ value: `${t.waNumber}|${t.contactNumber}`, label: `On ${t.businessName || t.waNumber}`, sublabel: `${t.messageCount} messages${t.lastMessageAt ? ' · ' + relativeTime(t.lastMessageAt) : ''}` }))}
                      triggerStyle={{ padding: '7px 30px 7px 10px' }} />
                  ) : (
                    <div style={{ fontSize: T.body, fontWeight: W.bold, color: C.text }}>Chat on {threads[0].businessName || threads[0].waNumber}</div>
                  )}
                </div>
                {navigate && <button onClick={() => navigate('chats', selWa, selContact)} style={btn.link} title="Open in Chats">Open in Chats <ExternalLink size={12} /></button>}
                <button onClick={() => setChatOpen(false)} style={btn.icon} aria-label="Close chat"><X size={15} /></button>
              </div>
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                {selWa && selContact && <ChatWindow key={thread} waNumber={selWa} contactNumber={selContact} user={user} onListChange={changed} />}
              </div>
            </div>
          )}
        </div>
      </div>
      {editing && p && (
        <LeadEditModal lead={p.lead} isAdmin={isAdmin} onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); changed(); }} />
      )}
    </>
  );
}

function Chip({ tone, children }) {
  const t = tone === 'green' ? [C.successBg, C.successText] : [C.surfaceMuted, C.textSecondary];
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 99, background: t[0], color: t[1], fontSize: T.label, fontWeight: W.bold }}>{children}</span>;
}
function Mini({ label, value, mono, muted }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '8px 0', borderBottom: `1px solid ${C.borderSubtle}`, fontSize: T.meta }}>
      <span style={{ color: C.textMuted, flexShrink: 0 }}>{label}</span>
      <span style={{ color: muted ? C.textMuted : C.text, fontWeight: W.medium, fontFamily: mono ? MONO : FONT, textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={typeof value === 'string' ? value : undefined}>{value}</span>
    </div>
  );
}
const H = ({ children, right }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 10px' }}>
    <span style={{ fontSize: T.label, fontWeight: W.bold, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textSecondary, flex: 1 }}>{children}</span>{right}
  </div>
);
const Card = ({ children, style }) => <div style={{ background: C.surfaceSection, border: `1px solid ${C.borderSubtle}`, borderRadius: 14, padding: 14, marginBottom: 18, ...style }}>{children}</div>;

function Tile({ label, children }) {
  return (
    <div style={{ background: C.surfaceSection, border: `1px solid ${C.borderSubtle}`, borderRadius: 12, padding: '11px 13px', minWidth: 0 }}>
      <div style={{ fontSize: T.label, color: C.textMuted }}>{label}</div>
      <div style={{ fontSize: T.body, fontWeight: W.bold, color: C.text, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{children}</div>
    </div>
  );
}

const DETAIL_KEYS = ['email', 'city', 'profession', 'age', 'pincode'];

function Overview({ p, openChat, goTab }) {
  const l = p.lead;
  const sys = Object.fromEntries(p.system.map(s => [s.key, s]));
  const details = DETAIL_KEYS.map(k => sys[k]).filter(s => s && s.value != null);
  const custom = p.custom.filter(f => f.value != null);
  const emptyCount = DETAIL_KEYS.length - details.length + p.custom.filter(f => f.value == null && f.registered).length;
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(136px, 100%), 1fr))', gap: 10, marginBottom: 18 }}>
        <Tile label="Stage">{l.stage ? <StageBadge stage={l.stage} /> : '—'}</Tile>
        <Tile label="Source">{l.source || '—'}</Tile>
        <Tile label="Product">{l.paidCourse || '—'}</Tile>
        <Tile label="Paid">{l.paidAmount != null ? fmtINR(l.paidAmount) : '—'}</Tile>
        <Tile label="Payment">{l.paymentStatus ? <PaymentStatusBadge status={l.paymentStatus} source={l.paymentStatusSource} outstandingAmount={l.outstandingAmount} /> : '—'}</Tile>
      </div>

      <H right={<button onClick={() => goTab('fields')} style={btn.link}>All fields <ArrowRight size={12} /></button>}>Details</H>
      <Card style={{ padding: '4px 14px' }}>
        {details.length === 0 && custom.length === 0
          ? <div style={{ fontSize: T.meta, color: C.textMuted, padding: '10px 0' }}>Nothing filled in yet beyond the name and number.</div>
          : (
            <>
              {details.map(s => <Mini key={s.key} label={s.label} value={s.value} />)}
              {custom.map(f => <Mini key={f.key} label={f.label} value={f.value} />)}
            </>
          )}
        {emptyCount > 0 && (
          <div style={{ fontSize: T.label, color: C.textMuted, padding: '9px 0 6px' }}>
            {emptyCount} empty field{emptyCount === 1 ? '' : 's'} hidden — <button onClick={() => goTab('fields')} style={{ ...btn.link, padding: 0, fontSize: T.label }}>fill them in</button>
          </div>
        )}
      </Card>

      <H>Chats</H>
      <Card style={{ padding: '4px 14px' }}>
        {p.threads.length === 0
          ? <div style={{ fontSize: T.meta, color: C.textMuted, padding: '10px 0' }}>They haven't messaged us on WhatsApp yet.</div>
          : p.threads.map(t => (
            <div key={`${t.waNumber}|${t.contactNumber}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: `1px solid ${C.borderSubtle}` }}>
              <MessageSquare size={16} color={C.textSecondary} style={{ flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: T.body, fontWeight: W.medium, color: C.text }}>On {t.businessName || t.waNumber} <span style={{ color: C.textMuted, fontWeight: W.normal }}>· {t.messageCount} messages{t.lastMessageAt ? ` · ${relativeTime(t.lastMessageAt)}` : ''}</span></div>
                {t.lastText && <div style={{ fontSize: T.meta, color: C.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{t.lastText}</div>}
              </div>
              <button onClick={() => openChat(t)} style={{ ...btn.secondary, padding: '6px 11px', fontSize: T.meta }}>Open chat</button>
            </div>
          ))}
      </Card>

      <H right={p.activity.length > 3 && <button onClick={() => goTab('activity')} style={btn.link}>All {p.activity.length} <ArrowRight size={12} /></button>}>Automations</H>
      <Card>
        {p.activity.length === 0
          ? <div style={{ fontSize: T.meta, color: C.textMuted }}>No automations or AI agents have run for this contact yet.</div>
          : <Activity rows={p.activity.slice(0, 3)} compact />}
      </Card>

      {p.stages.length > 0 && (
        <>
          <H>Stage history</H>
          <Card style={{ padding: '4px 14px' }}>
            {p.stages.map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: `1px solid ${C.borderSubtle}`, fontSize: T.meta }}>
                <History size={14} color={C.textMuted} />
                <span style={{ flex: 1, color: C.text }}>{s.from ? <>{s.from} → <b>{s.to}</b></> : <>Started at <b>{s.to}</b></>}</span>
                <span style={{ color: C.textMuted }} title={fmtWhen(s.at) || ''}>{relativeTime(s.at)}</span>
              </div>
            ))}
          </Card>
        </>
      )}
    </>
  );
}

function Fields({ p, onSaved }) {
  const [busy, setBusy] = useState('');
  async function setField(key, value) {
    setBusy(key);
    try {
      await api.leads.update(p.lead.id, value == null || value === ''
        ? { customFieldsRemove: [key] } : { customFieldsMerge: { [key]: value } });
      onSaved?.();
    } catch (e) { showError(e.message); }
    finally { setBusy(''); }
  }
  const custom = p.custom;
  return (
    <>
      <H>System fields</H>
      <Card style={{ padding: '4px 14px' }}>
        {p.system.map(s => (
          <Mini key={s.key} label={s.label} mono={s.mono}
            value={s.value == null ? '—' : s.type === 'date' ? fmtWhen(s.value) : s.type === 'phone' ? <MaskedNumber number={s.value} prefix="+" /> : s.value}
            muted={s.value == null} />
        ))}
      </Card>
      <div style={{ fontSize: T.label, color: C.textMuted, margin: '-8px 0 18px' }}>Change these with <b>Edit details</b>. Labels and which fields exist are set in Admin Settings → Fields.</div>

      <H>Custom fields</H>
      <Card style={{ padding: '4px 14px' }}>
        {custom.length === 0 && <div style={{ fontSize: T.meta, color: C.textMuted, padding: '10px 0' }}>No custom fields yet. Create them in Admin Settings → Fields.</div>}
        {custom.map(f => <FieldRow key={f.key} f={f} busy={busy === f.key} onSave={(v) => setField(f.key, v)} />)}
      </Card>
    </>
  );
}

function FieldRow({ f, busy, onSave }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(f.value ?? '');
  useEffect(() => setV(f.value ?? ''), [f.value]);
  const choice = (f.type === 'dropdown' || f.type === 'radio') && f.options?.length;
  const canEdit = f.registered;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid ${C.borderSubtle}`, fontSize: T.body, minHeight: 42 }}>
      <span style={{ width: 170, flexShrink: 0, color: C.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.key}>{f.label}</span>
      {edit ? (
        <form onSubmit={e => { e.preventDefault(); onSave(v === '' ? null : v); setEdit(false); }} style={{ display: 'flex', gap: 6, flex: 1, minWidth: 0 }}>
          {choice ? (
            <div style={{ flex: 1 }}><SearchableSelect value={v} onChange={setV} options={[{ value: '', label: '— Empty —' }, ...f.options.map(o => ({ value: o, label: o }))]} /></div>
          ) : (
            <input autoFocus type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} value={v} onChange={e => setV(e.target.value)}
              style={{ flex: 1, minWidth: 0, padding: '7px 10px', borderRadius: 8, border: `1.5px solid ${C.border}`, background: C.cardBg, color: C.text, fontFamily: FONT, fontSize: T.body, outline: 'none' }} />
          )}
          <button type="submit" style={{ ...btn.icon, width: 32, height: 32 }} aria-label="Save"><Check size={14} /></button>
          <button type="button" onClick={() => { setEdit(false); setV(f.value ?? ''); }} style={{ ...btn.icon, width: 32, height: 32 }} aria-label="Cancel"><X size={14} /></button>
        </form>
      ) : (
        <>
          <span onClick={() => canEdit && setEdit(true)} title={canEdit ? 'Click to edit' : 'Saved by an import or the landing page — not a registered field'}
            style={{ flex: 1, minWidth: 0, color: f.value != null ? C.text : C.textMuted, fontWeight: f.value != null ? W.medium : W.normal, cursor: canEdit ? 'text' : 'default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : f.value ?? (canEdit ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Plus size={12} /> Add</span> : 'Empty')}
          </span>
          {f.value != null && canEdit && <button onClick={() => onSave(null)} title="Clear" aria-label={`Clear ${f.label}`} style={{ ...btn.icon, width: 26, height: 26, border: 'none', background: 'transparent' }}><X size={13} /></button>}
        </>
      )}
    </div>
  );
}

const STATUS_TONE = {
  success: [C.successBg, C.successText, 'Done'], sent: [C.successBg, C.successText, 'Done'],
  error: [C.dangerBg, C.dangerText, 'Failed'], failed: [C.dangerBg, C.dangerText, 'Failed'],
  running: [C.infoBg, C.infoText, 'Running'], queued: [C.infoBg, C.infoText, 'Queued'],
  paused: [C.warnBg, C.warnText, 'Waiting for reply'], limited: [C.surfaceMuted, C.textSecondary, 'Not answered'],
  cancelled: [C.surfaceMuted, C.textSecondary, 'Cancelled'], skipped: [C.surfaceMuted, C.textSecondary, 'Skipped'],
};
function StatusPill({ status }) {
  const [bg, color, label] = STATUS_TONE[status] || [C.surfaceMuted, C.textSecondary, status || '—'];
  return <span style={{ fontSize: T.micro, fontWeight: W.bold, padding: '2px 8px', borderRadius: 99, background: bg, color }}>{label}</span>;
}

function Activity({ rows, navigate, compact }) {
  if (!rows.length) return <div style={{ fontSize: T.body, color: C.textMuted, padding: '30px 0', textAlign: 'center' }}>No automations or AI agents have run for this contact yet.</div>;
  return (
    <div data-testid="contact-activity">
      {rows.map((r, i) => {
        const canOpen = navigate && r.kind === 'automation' && r.automationId && r.executionId;
        return (
          <div key={r.id} style={{ display: 'flex', gap: 12, paddingBottom: i < rows.length - 1 ? 14 : 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span style={{ width: 30, height: 30, borderRadius: '50%', background: r.kind === 'agent' ? C.purpleBg : C.primaryLight, color: r.kind === 'agent' ? C.purple : C.primary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {r.kind === 'agent' ? <Bot size={14} /> : <Workflow size={14} />}
              </span>
              {i < rows.length - 1 && <span style={{ width: 2, flex: 1, background: C.borderSubtle, marginTop: 4 }} />}
            </div>
            <div style={{ flex: 1, minWidth: 0, paddingTop: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <b style={{ fontSize: T.body, color: C.text }}>{r.name}</b>
                <StatusPill status={r.status} />
                <span style={{ fontSize: T.label, color: C.textMuted, marginLeft: 'auto' }} title={fmtWhen(r.at) || ''}>{relativeTime(r.at)}</span>
              </div>
              <div style={{ fontSize: T.meta, color: C.textMuted, marginTop: 3 }}>
                {r.kind === 'agent' ? 'AI agent' : 'Automation'}{r.trigger ? ` · ${String(r.trigger).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}` : ''}{r.steps ? ` · ${r.steps} step${r.steps === 1 ? '' : 's'}` : ''}
                {canOpen && !compact && <> · <button onClick={() => navigate('chatbot-builder', String(r.automationId), 'executions', String(r.executionId))} style={{ ...btn.link, padding: 0 }}>View run</button></>}
              </div>
              {r.error && <div style={{ fontSize: T.label, color: r.status === 'error' || r.status === 'failed' ? C.dangerText : C.textMuted, marginTop: 3 }}>{r.error}</div>}
              {!compact && r.reply && <div style={{ fontSize: T.label, color: C.textSecondary, marginTop: 3, fontStyle: 'italic' }}>“{r.reply}”</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
