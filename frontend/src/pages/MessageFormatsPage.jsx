// Message Formats (route key still `wa-links`).
//
// A format is a labelled pre-filled WhatsApp opener. Put one link on an
// Instagram reel and another on a landing page, and every conversation each
// produces carries its label — that is the whole point of the tab.
//
// THE SHARED URL IS OUR /l/<slug> REDIRECT, never a bare wa.me link. Before
// migration 093 this page copied the raw wa.me URL, so the redirect was never
// in the path and no click was ever counted. Anything added here must keep the
// copyable URL pointing at /l/.
import { useEffect, useMemo, useState } from 'react';
import {
  Plus, Copy, Check, Trash2, ArrowLeft, Link as LinkIcon, Loader2,
  MessageSquare, MousePointerClick, UserPlus, Shuffle, Users, Save,
} from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO, maskPhone } from '../constants.js';
import DeleteConfirmModal from '../components/DeleteConfirmModal.jsx';
import { showError, showSuccess } from '../lib/feedback';

// Themed tokens, not hardcoded light hex — see TemplateBuilderPage for why.
const B = {
  card: C.cardBg, cardBorder: C.border, innerBg: C.surfaceInner, innerBorder: C.borderSubtle,
  rowSep: C.rowSep, t1: C.t1, t2: C.t2, t3: C.t3, t4: C.t4,
  t5: C.t5, t6: C.t6, t7: C.t7,
  green: C.successText, greenBg: C.successBg, amber: C.warnText, amberBg: C.warnBg,
};

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function trackedUrl(slug) {
  return `${window.location.origin}/l/${slug}`;
}

// ── shared bits ──────────────────────────────────────────────────────────────
const inputStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 10,
  border: `1.5px solid ${B.cardBorder}`, fontFamily: FONT, fontSize: 15,
  boxSizing: 'border-box', outline: 'none',
};
const btnPrimary = {
  padding: '9px 16px', borderRadius: 8, border: 'none', background: C.primary,
  color: '#fff', cursor: 'pointer', fontSize: 15, fontWeight: 700, fontFamily: FONT,
};
const btnGhost = {
  padding: '9px 16px', borderRadius: 8, border: `1px solid ${B.cardBorder}`,
  background: 'transparent', cursor: 'pointer', fontSize: 15, fontWeight: 600,
  color: B.t3, fontFamily: FONT,
};
const thStyle = {
  padding: '10px 14px', fontSize: 13, fontWeight: 700, color: B.t4, textAlign: 'left',
  textTransform: 'uppercase', letterSpacing: '.06em',
};

function Label({ children }) {
  return <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: B.t4, marginBottom: 5 }}>{children}</label>;
}

function CopyRow({ url, hint }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input
        readOnly value={url}
        onFocus={e => e.currentTarget.select()}
        style={{ ...inputStyle, fontFamily: MONO, fontSize: 14, background: B.innerBg }}
        title={hint || url}
      />
      <button
        onClick={() => {
          navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        }}
        style={{
          ...btnPrimary, display: 'inline-flex', alignItems: 'center', gap: 6,
          background: copied ? B.green : C.primary, whiteSpace: 'nowrap',
        }}
      >
        {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
      </button>
    </div>
  );
}

// Multi-number picker. "All numbers" is a real convenience here — the user's
// stated case is publishing one format across every sales number.
function NumberPicker({ accounts, selected, onChange }) {
  const allIds = accounts.map(a => Number(a.id));
  const allOn = allIds.length > 0 && allIds.every(id => selected.includes(id));
  const toggle = (id) => onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
  return (
    <div style={{ border: `1.5px solid ${B.cardBorder}`, borderRadius: 10, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => onChange(allOn ? [] : allIds)}
        style={{
          width: '100%', textAlign: 'left', padding: '9px 12px', background: B.innerBg,
          border: 'none', borderBottom: `1px solid ${B.innerBorder}`, cursor: 'pointer',
          fontFamily: FONT, fontSize: 14, fontWeight: 700, color: B.t3,
          display: 'flex', alignItems: 'center', gap: 8,
        }}
      >
        <Users size={14} color={C.primary} />
        {allOn ? 'Clear all numbers' : 'Use all sales numbers'}
      </button>
      {accounts.map(acc => {
        const id = Number(acc.id);
        const phone = acc.displayPhoneNumber || acc.display_phone_number;
        const name = acc.displayName || acc.display_name || 'Unnamed account';
        const on = selected.includes(id);
        return (
          <label
            key={id}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
              cursor: 'pointer', borderBottom: `1px solid ${B.rowSep}`,
              background: on ? 'var(--c-selectedTint, #FFF7F7)' : 'transparent',
            }}
          >
            <input type="checkbox" checked={on} onChange={() => toggle(id)} style={{ accentColor: C.primary }} />
            <span style={{ fontSize: 15, fontWeight: 600, color: B.t2 }}>{name}</span>
            <span style={{ fontSize: 14, color: B.t5, fontFamily: MONO, marginLeft: 'auto' }}>
              {phone ? maskPhone(phone) : 'no number'}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function Kpi({ icon: Icon, label, value, hint }) {
  return (
    <div
      title={hint}
      style={{
        flex: '1 1 150px', background: B.card, border: `1px solid ${B.cardBorder}`,
        borderRadius: 12, padding: '14px 16px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Icon size={14} color={C.primary} />
        <span style={{ fontSize: 13, fontWeight: 700, color: B.t5, textTransform: 'uppercase', letterSpacing: '.05em' }}>
          {label}
        </span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, color: B.t1, fontFamily: MONO }}>{value}</div>
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
export default function MessageFormatsPage({ subParts = [], navigate }) {
  const [formats, setFormats] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteModal, setDeleteModal] = useState({ open: false, item: null });

  const selectedId = subParts[0] || null;
  const selected = useMemo(
    () => formats.find(f => String(f.id) === String(selectedId)) || null,
    [formats, selectedId]
  );

  const load = async () => {
    setLoading(true);
    try {
      const [fRes, aRes] = await Promise.all([
        api.messageFormats.list(),
        api.whatsappAccounts.list(),
      ]);
      setFormats(fRes.formats || []);
      setAccounts(aRes.accounts || aRes || []);
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const handleDelete = async (id) => {
    try {
      await api.messageFormats.delete(id);
      showSuccess('Message format deleted.');
      if (String(selectedId) === String(id) && navigate) navigate('wa-links');
      await load();
    } catch (err) { showError(err.message); }
    setDeleteModal({ open: false, item: null });
  };

  if (selectedId && !loading && !selected) {
    return (
      <div style={{ padding: '22px 26px', fontFamily: FONT }}>
        <button onClick={() => navigate && navigate('wa-links')} style={{ ...btnGhost, marginBottom: 18 }}>
          <ArrowLeft size={14} style={{ verticalAlign: -2 }} /> Message Formats
        </button>
        <div style={{ background: B.card, border: `1px dashed ${B.cardBorder}`, borderRadius: 12, padding: 50, textAlign: 'center' }}>
          <LinkIcon size={32} style={{ color: B.t7, marginBottom: 10 }} />
          <div style={{ fontWeight: 700, fontSize: 16, color: B.t2 }}>Message format not found</div>
          <div style={{ fontSize: 15, color: B.t5, marginTop: 4 }}>It may have been deleted.</div>
        </div>
      </div>
    );
  }

  if (selected) {
    return (
      <>
        <DetailView
          format={selected}
          accounts={accounts}
          onBack={() => navigate && navigate('wa-links')}
          onDelete={() => setDeleteModal({ open: true, item: selected })}
          onSaved={load}
        />
        <DeleteConfirmModal
          open={deleteModal.open}
          title="Delete message format"
          message={`Delete "${deleteModal.item?.label}"? Every link it generated stops working, and its click and conversation history is removed. Leads already attributed to it keep their source.`}
          onConfirm={() => handleDelete(deleteModal.item?.id)}
          onCancel={() => setDeleteModal({ open: false, item: null })}
        />
      </>
    );
  }

  return (
    <div style={{ padding: '22px 26px', fontFamily: FONT, flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, letterSpacing: '-0.02em', color: B.t1 }}>Message Formats</h1>
          <p style={{ fontSize: 14, color: B.t5, margin: '4px 0 0', maxWidth: 720 }}>
            Give each place you advertise its own pre-filled opener and its own label. When someone taps
            the link and sends that opener, the conversation is tagged with the label — so you can tell
            which reel, which video or which page they came from.
          </p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          style={{ ...btnPrimary, display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
          onMouseEnter={e => e.currentTarget.style.background = C.primaryHover}
          onMouseLeave={e => e.currentTarget.style.background = C.primary}
        >
          <Plus size={16} /> New Format
        </button>
      </div>

      {loading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: B.t6, gap: 8 }}>
          <Loader2 size={20} className="spin" /> Loading…
        </div>
      ) : formats.length === 0 ? (
        <EmptyState onCreate={() => setCreateOpen(true)} />
      ) : (
        <div style={{ background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT }}>
              <thead>
                <tr style={{ background: B.innerBg, borderBottom: `1px solid ${B.cardBorder}` }}>
                  <th style={thStyle}>Label</th>
                  <th style={thStyle}>Numbers</th>
                  <th style={thStyle}>Opener</th>
                  <th style={{ ...thStyle, textAlign: 'right' }} title="Taps on the tracked link">Clicks</th>
                  <th style={{ ...thStyle, textAlign: 'right' }} title="Conversations that began with this opener">Chats</th>
                  <th style={{ ...thStyle, textAlign: 'right' }} title="Leads in the funnel attributed to this label">Leads</th>
                  <th style={thStyle}>Created</th>
                  <th style={{ padding: '10px 14px', width: 50 }} />
                </tr>
              </thead>
              <tbody>
                {formats.map(f => (
                  <tr
                    key={f.id}
                    onClick={() => navigate && navigate('wa-links', f.id)}
                    style={{ borderBottom: `1px solid ${B.rowSep}`, cursor: 'pointer' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--c-xfafaf7, #FAFAF7)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '12px 14px', fontSize: 15, fontWeight: 600, color: B.t2 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <LinkIcon size={14} color={f.active ? C.primary : B.t7} />
                        <span>{f.label}</span>
                        {!f.active && <Pill tone="muted">Off</Pill>}
                        {f.rotateSlug && <Pill tone="info"><Shuffle size={10} style={{ verticalAlign: -1 }} /> Rotating</Pill>}
                        {f.tracking === 'off' && <Pill tone="warn">No tracking</Pill>}
                      </div>
                    </td>
                    <td style={{ padding: '12px 14px', fontSize: 14, color: B.t3, fontFamily: MONO, whiteSpace: 'nowrap' }}>
                      {f.targets.length === 0 ? '—'
                        : f.targets.length === 1 ? maskPhone(f.targets[0].phoneNumber)
                        : `${f.targets.length} numbers`}
                    </td>
                    <td style={{ padding: '12px 14px', fontSize: 14, color: B.t4, maxWidth: 320 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {f.message || '—'}
                      </div>
                    </td>
                    <td style={{ padding: '12px 14px', fontSize: 15, color: B.t2, textAlign: 'right', fontFamily: MONO }}>{f.stats.clicks}</td>
                    <td style={{ padding: '12px 14px', fontSize: 15, color: B.t2, textAlign: 'right', fontFamily: MONO }}>{f.stats.chats}</td>
                    <td style={{ padding: '12px 14px', fontSize: 15, color: B.t2, textAlign: 'right', fontFamily: MONO }}>{f.stats.leads}</td>
                    <td style={{ padding: '12px 14px', fontSize: 14, color: B.t5, whiteSpace: 'nowrap' }}>{fmtDate(f.createdAt)}</td>
                    <td style={{ padding: '12px 14px' }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeleteModal({ open: true, item: f }); }}
                        style={{ padding: 6, borderRadius: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--c-dangerStrong, #991B1B)' }}
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {createOpen && (
        <CreateModal
          accounts={accounts}
          onClose={() => setCreateOpen(false)}
          onCreated={async () => { setCreateOpen(false); showSuccess('Message format created.'); await load(); }}
        />
      )}

      <DeleteConfirmModal
        open={deleteModal.open}
        title="Delete message format"
        message={`Delete "${deleteModal.item?.label}"? Every link it generated stops working, and its click and conversation history is removed. Leads already attributed to it keep their source.`}
        onConfirm={() => handleDelete(deleteModal.item?.id)}
        onCancel={() => setDeleteModal({ open: false, item: null })}
      />

      <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } } .spin { animation: spin 1s linear infinite; }`}</style>
    </div>
  );
}

function Pill({ children, tone = 'muted' }) {
  const tones = {
    muted: { bg: 'var(--c-surfaceMuted, #F1F1EC)', fg: B.t5 },
    info: { bg: 'var(--c-xeaf1fb, #EAF1FB)', fg: 'var(--c-x1e4b8f, #1E4B8F)' },
    warn: { bg: B.amberBg, fg: B.amber },
    good: { bg: B.greenBg, fg: B.green },
  };
  const t = tones[tone] || tones.muted;
  return (
    <span style={{
      background: t.bg, color: t.fg, borderRadius: 20, padding: '2px 8px',
      fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em',
      display: 'inline-flex', alignItems: 'center', gap: 4,
    }}>{children}</span>
  );
}

function EmptyState({ onCreate }) {
  return (
    <div style={{ background: B.card, border: `1px dashed ${B.cardBorder}`, borderRadius: 12, padding: 60, textAlign: 'center', marginTop: 20 }}>
      <LinkIcon size={36} style={{ color: B.t7, marginBottom: 12 }} />
      <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 6, color: B.t2 }}>No message formats yet</div>
      <div style={{ fontSize: 15, color: B.t5, marginBottom: 18, maxWidth: 460, marginLeft: 'auto', marginRight: 'auto' }}>
        Create one per place you advertise — one per reel, one per landing page — and each gets its own
        label so you can tell the traffic apart.
      </div>
      <button onClick={onCreate} style={{ ...btnPrimary, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 18px' }}>
        <Plus size={15} /> Create your first format
      </button>
    </div>
  );
}

// ── create ───────────────────────────────────────────────────────────────────
function CreateModal({ accounts, onClose, onCreated }) {
  const [label, setLabel] = useState('');
  const [message, setMessage] = useState('');
  const [accountIds, setAccountIds] = useState([]);
  const [rotate, setRotate] = useState(false);
  const [saving, setSaving] = useState(false);

  const canSubmit = label.trim() && message.trim() && accountIds.length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await api.messageFormats.create({
        label: label.trim(), message: message.trim(), accountIds,
        rotate: rotate && accountIds.length > 1,
      });
      onCreated();
    } catch (err) {
      showError(err.message);
      setSaving(false);
    }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, padding: '24px 28px', width: 560, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: C.shadowLg }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 700, color: B.t1 }}>New message format</h2>
        <p style={{ margin: '0 0 18px', fontSize: 14, color: B.t5 }}>
          The label is how you will recognise this traffic later. The opener is what WhatsApp pre-fills
          for the customer — it is also what identifies them, so make it distinctive.
        </p>

        <div style={{ marginBottom: 14 }}>
          <Label>Label *</Label>
          <input
            value={label} onChange={e => setLabel(e.target.value)}
            placeholder="e.g. IG Reel — n8n automation"
            style={inputStyle}
            onFocus={e => e.currentTarget.style.borderColor = C.primary}
            onBlur={e => e.currentTarget.style.borderColor = B.cardBorder}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <Label>Pre-filled opener *</Label>
          <textarea
            value={message} onChange={e => setMessage(e.target.value)}
            rows={3}
            placeholder="Hi Forgemind, I saw your reel on n8n automation and want the course details"
            style={{ ...inputStyle, resize: 'vertical' }}
            onFocus={e => e.currentTarget.style.borderColor = C.primary}
            onBlur={e => e.currentTarget.style.borderColor = B.cardBorder}
          />
          <div style={{ fontSize: 13, color: B.t6, marginTop: 5, lineHeight: 1.5 }}>
            Two formats cannot share the same opener — they would be impossible to tell apart. Wording
            unique to this reel or page is what makes the tracking work.
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <Label>WhatsApp numbers *</Label>
          <NumberPicker accounts={accounts} selected={accountIds} onChange={setAccountIds} />
          <div style={{ fontSize: 13, color: B.t6, marginTop: 5 }}>
            Each number gets its own link, all under this one label.
          </div>
        </div>

        {accountIds.length > 1 && (
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 18, cursor: 'pointer', background: B.innerBg, border: `1px solid ${B.innerBorder}`, borderRadius: 10, padding: 12 }}>
            <input type="checkbox" checked={rotate} onChange={e => setRotate(e.target.checked)} style={{ accentColor: C.primary, marginTop: 2 }} />
            <span>
              <span style={{ fontSize: 15, fontWeight: 700, color: B.t2, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Shuffle size={13} /> Also create one rotating link
              </span>
              <span style={{ fontSize: 13, color: B.t5, display: 'block', marginTop: 3, lineHeight: 1.5 }}>
                A single link that sends each person to the next number in turn — use it to spread
                incoming leads evenly across the team.
              </span>
            </span>
          </label>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={btnGhost}>Cancel</button>
          <button
            onClick={submit}
            disabled={!canSubmit || saving}
            style={{ ...btnPrimary, background: !canSubmit || saving ? 'var(--c-hover)' : C.primary, cursor: !canSubmit || saving ? 'not-allowed' : 'pointer' }}
          >
            {saving ? 'Creating…' : 'Create format'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── detail ───────────────────────────────────────────────────────────────────
function DetailView({ format, accounts, onBack, onDelete, onSaved }) {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState(null);
  const [loadingStats, setLoadingStats] = useState(true);

  const [label, setLabel] = useState(format.label);
  const [message, setMessage] = useState(format.message || '');
  const [accountIds, setAccountIds] = useState(format.targets.map(t => t.waAccountId).filter(x => x != null));
  const [rotate, setRotate] = useState(!!format.rotateSlug);
  const [active, setActive] = useState(format.active);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLabel(format.label);
    setMessage(format.message || '');
    setAccountIds(format.targets.map(t => t.waAccountId).filter(x => x != null));
    setRotate(!!format.rotateSlug);
    setActive(format.active);
  }, [format]);

  useEffect(() => {
    let alive = true;
    setLoadingStats(true);
    api.messageFormats.stats(format.id, days)
      .then(d => { if (alive) setStats(d); })
      .catch(err => showError(err.message))
      .finally(() => { if (alive) setLoadingStats(false); });
    return () => { alive = false; };
  }, [format.id, days]);

  const dirty =
    label !== format.label ||
    message !== (format.message || '') ||
    rotate !== !!format.rotateSlug ||
    active !== format.active ||
    accountIds.slice().sort().join(',') !== format.targets.map(t => t.waAccountId).filter(x => x != null).slice().sort().join(',');

  const save = async () => {
    if (!label.trim()) { showError('Label cannot be empty.'); return; }
    if (accountIds.length === 0) { showError('Pick at least one WhatsApp number.'); return; }
    setSaving(true);
    try {
      const res = await api.messageFormats.update(format.id, {
        label: label.trim(), message: message.trim() || null, accountIds,
        rotate: rotate && accountIds.length > 1, active,
      });
      let msg = 'Message format saved.';
      if (res.renamedLeads) msg += ` ${res.renamedLeads} lead${res.renamedLeads === 1 ? '' : 's'} re-labelled.`;
      if (res.removedTargets) msg += ` ${res.removedTargets} link${res.removedTargets === 1 ? '' : 's'} removed.`;
      showSuccess(msg);
      await onSaved();
    } catch (err) {
      showError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const maxBar = Math.max(1, ...(stats?.series || []).map(p => Math.max(p.clicks, p.chats)));

  return (
    <div style={{ padding: '22px 26px', fontFamily: FONT, flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <button onClick={onBack} style={{ ...btnGhost, display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px' }}>
          <ArrowLeft size={14} /> Message Formats
        </button>
        <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0, color: B.t1 }}>{format.label}</h1>
        {!format.active && <Pill tone="muted">Off</Pill>}
        {format.tracking === 'off' && <Pill tone="warn">No tracking — add an opener</Pill>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {RANGES.map(r => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              style={{
                padding: '6px 12px', borderRadius: 8, fontSize: 14, fontWeight: 700, fontFamily: FONT,
                cursor: 'pointer',
                border: `1px solid ${days === r.days ? C.primary : B.cardBorder}`,
                background: days === r.days ? C.primary : 'transparent',
                color: days === r.days ? '#fff' : B.t3,
              }}
            >{r.label}</button>
          ))}
        </div>
      </div>

      {/* Tracking */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Kpi icon={MousePointerClick} label="Clicks" value={loadingStats ? '…' : stats?.totals.clicks ?? 0}
             hint="Taps on this format's tracked link. Counted at our redirect, before WhatsApp opens." />
        <Kpi icon={MessageSquare} label="Chats started" value={loadingStats ? '…' : stats?.totals.chats ?? 0}
             hint="Inbound messages matched to this opener. Lower than clicks is normal — some people tap and never send." />
        <Kpi icon={Users} label="Leads" value={loadingStats ? '…' : stats?.totals.leads ?? 0}
             hint="Funnel leads linked to those conversations." />
        <Kpi icon={UserPlus} label="New leads" value={loadingStats ? '…' : stats?.totals.newLeads ?? 0}
             hint="People who were not already in the funnel. Only these take this label as their Source." />
      </div>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* Left column */}
        <div style={{ flex: '1 1 520px', minWidth: 320, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Links */}
          <Card title="Links to share">
            <p style={{ margin: '0 0 12px', fontSize: 14, color: B.t5, lineHeight: 1.6 }}>
              Share these, not a plain wa.me link — the tap is only counted when it passes through here.
            </p>
            {format.rotateSlug && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <Shuffle size={13} color={C.primary} />
                  <span style={{ fontSize: 13, fontWeight: 800, color: B.t4, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                    Rotating link — spreads across all {format.targets.length} numbers
                  </span>
                </div>
                <CopyRow url={trackedUrl(format.rotateSlug)} />
              </div>
            )}
            {format.targets.map(t => (
              <div key={t.id} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: B.t4, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
                  {t.accountName || 'Account'} · <span style={{ fontFamily: MONO, textTransform: 'none', letterSpacing: 0 }}>{maskPhone(t.phoneNumber)}</span>
                </div>
                <CopyRow url={trackedUrl(t.slug)} />
              </div>
            ))}
            {format.targets.length === 0 && (
              <div style={{ fontSize: 15, color: B.t5 }}>No numbers selected yet.</div>
            )}
          </Card>

          {/* Daily activity */}
          <Card title={`Activity — last ${days} days`}>
            {loadingStats ? (
              <div style={{ color: B.t6, fontSize: 15 }}>Loading…</div>
            ) : !stats?.series?.length ? (
              <div style={{ color: B.t5, fontSize: 15 }}>Nothing yet.</div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 110, overflowX: 'auto', paddingBottom: 4 }}>
                  {stats.series.map(p => (
                    <div
                      key={p.day}
                      title={`${p.day}\n${p.clicks} click${p.clicks === 1 ? '' : 's'}\n${p.chats} chat${p.chats === 1 ? '' : 's'} started`}
                      style={{ flex: '1 0 6px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 1, height: '100%', cursor: 'default' }}
                    >
                      <div style={{ height: `${(p.clicks / maxBar) * 60}%`, background: 'var(--c-xf0b6b6, #F0B6B6)', borderRadius: '2px 2px 0 0', minHeight: p.clicks ? 2 : 0 }} />
                      <div style={{ height: `${(p.chats / maxBar) * 60}%`, background: C.primary, borderRadius: '0 0 2px 2px', minHeight: p.chats ? 2 : 0 }} />
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 13, color: B.t5 }}>
                  <LegendDot color="#F0B6B6" text="Clicks" />
                  <LegendDot color={C.primary} text="Chats started" />
                </div>
              </>
            )}
          </Card>

          {/* Per-number split */}
          {stats?.byNumber?.length > 1 && (
            <Card title="By number">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${B.rowSep}` }}>
                    <th style={{ ...thStyle, padding: '6px 0' }}>Number</th>
                    <th style={{ ...thStyle, padding: '6px 0', textAlign: 'right' }}>Clicks</th>
                    <th style={{ ...thStyle, padding: '6px 0', textAlign: 'right' }}>Chats</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byNumber.map(n => (
                    <tr key={n.targetId} style={{ borderBottom: `1px solid ${B.rowSep}` }}>
                      <td style={{ padding: '9px 0', fontSize: 15, color: B.t2 }}>
                        {n.accountName || '—'}{' '}
                        <span style={{ fontFamily: MONO, fontSize: 14, color: B.t5 }}>{maskPhone(n.phoneNumber)}</span>
                      </td>
                      <td style={{ padding: '9px 0', textAlign: 'right', fontFamily: MONO, fontSize: 15 }}>{n.clicks}</td>
                      <td style={{ padding: '9px 0', textAlign: 'right', fontFamily: MONO, fontSize: 15 }}>{n.chats}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {/* Recent */}
          <Card title="Who came in">
            {loadingStats ? (
              <div style={{ color: B.t6, fontSize: 15 }}>Loading…</div>
            ) : !stats?.recent?.length ? (
              <div style={{ color: B.t5, fontSize: 15 }}>
                No conversations matched to this format yet in the last {days} days.
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${B.rowSep}` }}>
                      <th style={{ ...thStyle, padding: '6px 0' }}>When</th>
                      <th style={{ ...thStyle, padding: '6px 0' }}>Person</th>
                      <th style={{ ...thStyle, padding: '6px 0' }}>Stage</th>
                      <th style={{ ...thStyle, padding: '6px 0' }}>New?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.recent.map((r, i) => (
                      <tr key={i} style={{ borderBottom: `1px solid ${B.rowSep}` }}>
                        <td style={{ padding: '9px 0', fontSize: 14, color: B.t5, whiteSpace: 'nowrap' }}>{fmtDateTime(r.matchedAt)}</td>
                        <td style={{ padding: '9px 0', fontSize: 15, color: B.t2 }}>
                          {r.leadName || <span style={{ fontFamily: MONO, fontSize: 14 }}>{maskPhone(r.contactNumber)}</span>}
                        </td>
                        <td style={{ padding: '9px 0', fontSize: 14, color: B.t4 }}>{r.stage || '—'}</td>
                        <td style={{ padding: '9px 0' }}>{r.isNewLead ? <Pill tone="good">New</Pill> : <Pill tone="muted">Returning</Pill>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* Right column — settings */}
        <div style={{ flex: '0 1 380px', minWidth: 300 }}>
          <Card title="Settings">
            <div style={{ marginBottom: 14 }}>
              <Label>Label</Label>
              <input value={label} onChange={e => setLabel(e.target.value)} style={inputStyle} />
              <div style={{ fontSize: 13, color: B.t6, marginTop: 5, lineHeight: 1.5 }}>
                Renaming also re-labels the leads this format already brought in, so your reports stay
                consistent.
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <Label>Pre-filled opener</Label>
              <textarea value={message} onChange={e => setMessage(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
              <div style={{ fontSize: 13, color: B.t6, marginTop: 5, lineHeight: 1.5 }}>
                Changing this stops older links matching — people who already tapped will send the old
                wording. Prefer a new format for a new campaign.
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <Label>WhatsApp numbers</Label>
              <NumberPicker accounts={accounts} selected={accountIds} onChange={setAccountIds} />
              <div style={{ fontSize: 13, color: B.t6, marginTop: 5, lineHeight: 1.5 }}>
                Removing a number deletes its link for good. Numbers you keep hold on to their existing
                link.
              </div>
            </div>

            {accountIds.length > 1 && (
              <label style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={rotate} onChange={e => setRotate(e.target.checked)} style={{ accentColor: C.primary }} />
                <span style={{ fontSize: 15, color: B.t2, fontWeight: 600 }}>Offer a rotating link</span>
              </label>
            )}

            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 16, cursor: 'pointer' }}>
              <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} style={{ accentColor: C.primary, marginTop: 3 }} />
              <span>
                <span style={{ fontSize: 15, color: B.t2, fontWeight: 600 }}>Active</span>
                <span style={{ fontSize: 13, color: B.t6, display: 'block', marginTop: 2, lineHeight: 1.5 }}>
                  Turning this off stops new conversations being tagged with this label. Links already
                  out in the world keep working — they just stop being attributed.
                </span>
              </span>
            </label>

            <div style={{ display: 'flex', gap: 10, borderTop: `1px solid ${B.rowSep}`, paddingTop: 14 }}>
              <button
                onClick={save}
                disabled={!dirty || saving}
                style={{
                  ...btnPrimary, display: 'inline-flex', alignItems: 'center', gap: 6,
                  background: !dirty || saving ? 'var(--c-hover)' : C.primary,
                  cursor: !dirty || saving ? 'not-allowed' : 'pointer',
                }}
              >
                <Save size={14} /> {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
              </button>
              <button
                onClick={onDelete}
                style={{
                  ...btnGhost, display: 'inline-flex', alignItems: 'center', gap: 6,
                  border: '1px solid #FECACA', background: 'var(--c-dangerBgSoft, #FEF2F2)', color: 'var(--c-dangerStrong, #991B1B)',
                }}
              >
                <Trash2 size={14} /> Delete
              </button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div style={{ background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12, padding: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: B.t4, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 12 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function LegendDot({ color, text }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: color, display: 'inline-block' }} />
      {text}
    </span>
  );
}
