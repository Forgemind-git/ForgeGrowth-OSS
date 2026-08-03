import { useEffect, useMemo, useState } from 'react';
import {
  Plus, Copy, Check, Trash2, Pencil, ArrowLeft, Link as LinkIcon,
  Loader2, X, ExternalLink,
} from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, maskPhone } from '../constants.js';
import DeleteConfirmModal from '../components/DeleteConfirmModal.jsx';
import SearchableSelect from '../components/SearchableSelect.jsx';

// ─── Design Tokens ────────────────────────────────────────────────────────────
const B = {
  bg: '#F7F7F3',
  card: '#FFFFFF',
  cardBorder: '#E5E5E0',
  innerBg: '#FAFAF7',
  innerBorder: '#EEEEE8',
  rowSep: '#F5F5F0',
  t1: '#111111',
  t2: '#222222',
  t3: '#444444',
  t4: '#666666',
  t5: '#777777',
  t6: '#888888',
  t7: '#999999',
  accent: C.primary,
  accentBg: C.primaryLight,
  accentDark: C.primaryHover,
  green: '#0F6E56',
  greenBright: '#1D9E75',
  greenBg: '#E1F5EE',
};

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function WaLinksPage({ subParts = [], navigate }) {
  const [links, setLinks] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteModal, setDeleteModal] = useState({ open: false, item: null });
  const [toast, setToast] = useState(null);

  const selectedId = subParts[0] || null;
  const selectedLink = useMemo(() => links.find(l => String(l.id) === selectedId), [links, selectedId]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const load = async () => {
    setLoading(true);
    try {
      const [lRes, aRes] = await Promise.all([
        api.waLinks.list(),
        api.whatsappAccounts.list(),
      ]);
      setLinks(lRes.links || []);
      setAccounts(aRes.accounts || aRes || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (id) => {
    try {
      await api.waLinks.delete(id);
      showToast('Link deleted');
      if (selectedId === String(id) && navigate) navigate('wa-links');
      await load();
    } catch (err) { showToast(err.message); }
    setDeleteModal({ open: false, item: null });
  };

  const accountDisplay = (phone) => {
    const acc = accounts.find(a => normalizePhone(a.display_phone_number || a.displayPhoneNumber) === normalizePhone(phone));
    return maskPhone(acc ? (acc.display_phone_number || acc.displayPhoneNumber) : phone);
  };

  // Detail view
  if (selectedLink) {
    return (
      <DetailView
        link={selectedLink}
        accounts={accounts}
        accountDisplay={accountDisplay}
        onBack={() => navigate && navigate('wa-links')}
        onDelete={() => setDeleteModal({ open: true, item: selectedLink })}
        onUpdate={async (id, data) => {
          try {
            await api.waLinks.update(id, data);
            showToast('Link updated');
            await load();
          } catch (err) { showToast(err.message); }
        }}
      />
    );
  }

  return (
    <div style={{ padding: '22px 26px', fontFamily: FONT, flex: 1, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0, letterSpacing: '-0.02em', color: B.t1 }}>Generate Link</h1>
          <p style={{ fontSize: 12, color: B.t5, margin: '4px 0 0' }}>
            Create shareable WhatsApp click-to-chat links with pre-filled messages.
          </p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '9px 16px', background: C.primary, color: '#fff',
            border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700,
            cursor: 'pointer', fontFamily: FONT,
          }}
          onMouseEnter={e => e.currentTarget.style.background = C.primaryHover}
          onMouseLeave={e => e.currentTarget.style.background = C.primary}
        >
          <Plus size={16} /> New Link
        </button>
      </div>

      {error && (
        <div style={{ padding: 10, background: '#FEF2F2', color: '#991B1B', borderRadius: 8, marginBottom: 14, fontSize: 13 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: B.t6 }}>
          <Loader2 size={20} className="spin" /> Loading…
        </div>
      ) : links.length === 0 ? (
        <EmptyState onCreate={() => setCreateOpen(true)} />
      ) : (
        <div style={{ background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT }}>
            <thead>
              <tr style={{ background: B.innerBg, borderBottom: `1px solid ${B.cardBorder}` }}>
                <th style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: B.t4, textAlign: 'left', textTransform: 'uppercase', letterSpacing: '.06em' }}>Name</th>
                <th style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: B.t4, textAlign: 'left', textTransform: 'uppercase', letterSpacing: '.06em' }}>Phone</th>
                <th style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: B.t4, textAlign: 'left', textTransform: 'uppercase', letterSpacing: '.06em' }}>Message</th>
                <th style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: B.t4, textAlign: 'left', textTransform: 'uppercase', letterSpacing: '.06em' }}>Created</th>
                <th style={{ padding: '10px 14px', width: 80 }} />
              </tr>
            </thead>
            <tbody>
              {links.map(link => (
                <tr
                  key={link.id}
                  onClick={() => navigate && navigate('wa-links', link.id)}
                  style={{
                    borderBottom: `1px solid ${B.rowSep}`,
                    cursor: 'pointer',
                    transition: 'background .1s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = '#FAFAF7'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <td style={{ padding: '12px 14px', fontSize: 13, fontWeight: 600, color: B.t2 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <LinkIcon size={14} color={C.primary} />
                      {link.name}
                    </div>
                  </td>
                  <td style={{ padding: '12px 14px', fontSize: 12, color: B.t3, fontFamily: 'DM Mono, monospace' }}>
                    {accountDisplay(link.phoneNumber)}
                  </td>
                  <td style={{ padding: '12px 14px', fontSize: 12, color: B.t4, maxWidth: 300 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {link.message || '—'}
                    </div>
                  </td>
                  <td style={{ padding: '12px 14px', fontSize: 12, color: B.t5 }}>{fmtDate(link.createdAt)}</td>
                  <td style={{ padding: '12px 14px' }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeleteModal({ open: true, item: link }); }}
                      style={{
                        padding: 6, borderRadius: 6, background: 'transparent',
                        border: 'none', cursor: 'pointer', color: '#991B1B',
                      }}
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
      )}

      {createOpen && (
        <CreateModal
          accounts={accounts}
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            setCreateOpen(false);
            showToast('Link created');
            await load();
          }}
          onError={(msg) => showToast(msg)}
        />
      )}

      <DeleteConfirmModal
        open={deleteModal.open}
        title="Delete Link"
        message={`Are you sure you want to delete "${deleteModal.item?.name}"? The link will stop working.`}
        onConfirm={() => handleDelete(deleteModal.item?.id)}
        onCancel={() => setDeleteModal({ open: false, item: null })}
      />

      {toast && (
        <div style={{
          position: 'fixed', bottom: 20, right: 20,
          padding: '10px 16px', background: '#111', color: '#fff',
          borderRadius: 8, fontSize: 13, fontWeight: 600,
          boxShadow: C.shadowLg, zIndex: 1000,
        }}>{toast}</div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } } .spin { animation: spin 1s linear infinite; }`}</style>
    </div>
  );
}

function EmptyState({ onCreate }) {
  return (
    <div style={{
      background: B.card, border: `1px dashed ${B.cardBorder}`, borderRadius: 12,
      padding: 60, textAlign: 'center', marginTop: 20,
    }}>
      <LinkIcon size={36} style={{ color: B.t7, marginBottom: 12 }} />
      <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6, color: B.t2 }}>No links yet</div>
      <div style={{ fontSize: 13, color: B.t5, marginBottom: 18 }}>
        Create a WhatsApp click-to-chat link with a pre-filled message.
      </div>
      <button
        onClick={onCreate}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '10px 18px', background: C.primary, color: '#fff',
          border: 'none', borderRadius: 8, fontFamily: FONT, fontWeight: 700,
          fontSize: 13, cursor: 'pointer',
        }}
      >
        <Plus size={15} /> Create your first link
      </button>
    </div>
  );
}

function CreateModal({ accounts, onClose, onCreated, onError }) {
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);

  const canSubmit = name.trim() && accountId && message.trim();
  const waUrl = result ? buildWaMeUrl(result.phoneNumber, result.message) : '';

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setCreating(true);
    try {
      const res = await api.waLinks.create({ name: name.trim(), accountId: Number(accountId), message: message.trim() });
      setResult(res.link);
    } catch (err) {
      onError(err.message);
      setCreating(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(waUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--c-cardBg)', borderRadius: 14, padding: '24px 28px',
          width: 480, maxWidth: '90vw', boxShadow: C.shadowLg,
        }}
      >
        {!result ? (
          <>
            <h2 style={{ margin: '0 0 18px', fontSize: 18, fontWeight: 700, color: B.t1 }}>New Link</h2>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: B.t4, marginBottom: 5 }}>Name *</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Summer Sale Campaign"
                style={{
                  width: '100%', padding: '9px 12px', borderRadius: 10,
                  border: `1.5px solid ${B.cardBorder}`, fontFamily: FONT, fontSize: 13,
                  boxSizing: 'border-box', outline: 'none',
                }}
                onFocus={e => e.currentTarget.style.borderColor = C.primary}
                onBlur={e => e.currentTarget.style.borderColor = B.cardBorder}
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: B.t4, marginBottom: 5 }}>WhatsApp Account *</label>
              <SearchableSelect
                value={accountId}
                onChange={v => setAccountId(v)}
                options={accounts.map(acc => {
                  const phone = acc.displayPhoneNumber || acc.display_phone_number;
                  const name = acc.displayName || acc.display_name || 'Unnamed Account';
                  return {
                    value: String(acc.id),
                    label: phone ? `${name} (${maskPhone(phone)})` : name,
                  };
                })}
                placeholder="Select an account"
                searchPlaceholder="Search accounts…"
                triggerStyle={{ padding: '9px 32px 9px 12px', borderRadius: 10, fontSize: 13 }}
              />
            </div>

            <div style={{ marginBottom: 18 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: B.t4, marginBottom: 5 }}>Predefined Message *</label>
              <textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="Hi, I'm interested in your summer sale!"
                rows={4}
                style={{
                  width: '100%', padding: '9px 12px', borderRadius: 10,
                  border: `1.5px solid ${B.cardBorder}`, fontFamily: FONT, fontSize: 13,
                  boxSizing: 'border-box', outline: 'none', resize: 'vertical',
                }}
                onFocus={e => e.currentTarget.style.borderColor = C.primary}
                onBlur={e => e.currentTarget.style.borderColor = B.cardBorder}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={onClose} style={{
                padding: '9px 16px', borderRadius: 8, border: `1px solid ${B.cardBorder}`,
                background: 'transparent', cursor: 'pointer', fontSize: 13,
                fontWeight: 600, color: B.t3, fontFamily: FONT,
              }}>Cancel</button>
              <button
                onClick={handleSubmit}
                disabled={!canSubmit || creating}
                style={{
                  padding: '9px 18px', borderRadius: 8, border: 'none',
                  background: !canSubmit || creating ? 'var(--c-hover)' : C.primary,
                  color: '#fff', cursor: !canSubmit || creating ? 'not-allowed' : 'pointer',
                  fontSize: 13, fontWeight: 700, fontFamily: FONT,
                }}
              >
                {creating ? 'Generating…' : 'Generate Link'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{
                width: 36, height: 36, borderRadius: '50%', background: B.greenBg,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Check size={18} color={B.green} />
              </div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: B.t1 }}>Link generated!</div>
                <div style={{ fontSize: 12, color: B.t5 }}>Share this link anywhere.</div>
              </div>
            </div>

            <div style={{
              background: B.innerBg, border: `1px solid ${B.innerBorder}`,
              borderRadius: 10, padding: 12, marginBottom: 16,
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: B.t5, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.05em' }}>Your Link</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  readOnly
                  value={waUrl}
                  style={{
                    flex: 1, padding: '8px 10px', borderRadius: 8,
                    border: `1px solid ${B.cardBorder}`, fontFamily: 'DM Mono, monospace',
                    fontSize: 12, background: 'var(--c-cardBg)', color: B.t2,
                  }}
                />
                <button
                  onClick={handleCopy}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '8px 14px', borderRadius: 8, border: 'none',
                    background: copied ? B.green : C.primary,
                    color: '#fff', cursor: 'pointer', fontSize: 13,
                    fontWeight: 600, fontFamily: FONT, whiteSpace: 'nowrap',
                  }}
                >
                  {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={onClose} style={{
                padding: '9px 16px', borderRadius: 8, border: `1px solid ${B.cardBorder}`,
                background: 'transparent', cursor: 'pointer', fontSize: 13,
                fontWeight: 600, color: B.t3, fontFamily: FONT,
              }}>Close</button>
              <button
                onClick={() => { setResult(null); setName(''); setAccountId(''); setMessage(''); setCreating(false); }}
                style={{
                  padding: '9px 16px', borderRadius: 8, border: 'none',
                  background: C.primary, color: '#fff', cursor: 'pointer',
                  fontSize: 13, fontWeight: 700, fontFamily: FONT,
                }}
              >
                Create Another
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DetailView({ link, accounts, accountDisplay, onBack, onDelete, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(link.name);
  const [editMessage, setEditMessage] = useState(link.message || '');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const waUrl = buildWaMeUrl(link.phoneNumber, link.message);
  const redirectUrl = `${window.location.origin}/l/${link.slug}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(waUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSave = async () => {
    setSaving(true);
    await onUpdate(link.id, { name: editName, message: editMessage });
    setSaving(false);
    setEditing(false);
  };

  return (
    <div style={{ padding: '22px 26px', fontFamily: FONT, flex: 1 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <button
          onClick={onBack}
          style={{
            padding: '6px 10px', borderRadius: 8, border: `1px solid ${B.cardBorder}`,
            background: 'var(--c-cardBg)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 13, fontWeight: 600, color: B.t3, fontFamily: FONT,
          }}
        >
          <ArrowLeft size={14} /> Back
        </button>
        <h1 style={{ fontSize: 18, fontWeight: 800, margin: 0, color: B.t1 }}>{link.name}</h1>
      </div>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        {/* Main card */}
        <div style={{ flex: 1, minWidth: 320, maxWidth: 600 }}>
          <div style={{ background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12, padding: 20 }}>
            {/* Link URL */}
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: B.t5, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.06em' }}>Public Link</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  readOnly
                  value={waUrl}
                  style={{
                    flex: 1, padding: '10px 12px', borderRadius: 10,
                    border: `1.5px solid ${B.cardBorder}`, fontFamily: 'DM Mono, monospace',
                    fontSize: 13, background: B.innerBg, color: B.t2,
                  }}
                />
                <button
                  onClick={handleCopy}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '9px 14px', borderRadius: 8, border: 'none',
                    background: copied ? B.green : C.primary,
                    color: '#fff', cursor: 'pointer', fontSize: 13,
                    fontWeight: 600, fontFamily: FONT, whiteSpace: 'nowrap',
                  }}
                >
                  {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
                </button>
                <a
                  href={waUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    padding: '9px 10px', borderRadius: 8, border: `1px solid ${B.cardBorder}`,
                    background: 'var(--c-cardBg)', color: B.t3, display: 'flex', alignItems: 'center',
                    cursor: 'pointer',
                  }}
                  title="Open link"
                >
                  <ExternalLink size={14} />
                </a>
              </div>
            </div>

            {/* Details */}
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: B.t5, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.06em' }}>Details</div>

              {!editing ? (
                <>
                  <DetailRow label="Name" value={link.name} />
                  <DetailRow label="WhatsApp Number" value={accountDisplay(link.phoneNumber)} />
                  <DetailRow label="Message" value={link.message || '—'} />
                  <DetailRow label="Created" value={fmtDate(link.createdAt)} />
                </>
              ) : (
                <>
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: B.t4, marginBottom: 5 }}>Name</label>
                    <input
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      style={{
                        width: '100%', padding: '9px 12px', borderRadius: 10,
                        border: `1.5px solid ${B.cardBorder}`, fontFamily: FONT, fontSize: 13,
                        boxSizing: 'border-box',
                      }}
                    />
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: B.t4, marginBottom: 5 }}>Predefined Message</label>
                    <textarea
                      value={editMessage}
                      onChange={e => setEditMessage(e.target.value)}
                      rows={4}
                      style={{
                        width: '100%', padding: '9px 12px', borderRadius: 10,
                        border: `1.5px solid ${B.cardBorder}`, fontFamily: FONT, fontSize: 13,
                        boxSizing: 'border-box', resize: 'vertical',
                      }}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={() => { setEditing(false); setEditName(link.name); setEditMessage(link.message || ''); }} style={{
                      padding: '8px 14px', borderRadius: 8, border: `1px solid ${B.cardBorder}`,
                      background: 'transparent', cursor: 'pointer', fontSize: 13,
                      fontWeight: 600, color: B.t3, fontFamily: FONT,
                    }}>Cancel</button>
                    <button
                      onClick={handleSave}
                      disabled={saving || !editName.trim()}
                      style={{
                        padding: '8px 16px', borderRadius: 8, border: 'none',
                        background: saving || !editName.trim() ? 'var(--c-hover)' : C.primary,
                        color: '#fff', cursor: saving || !editName.trim() ? 'not-allowed' : 'pointer',
                        fontSize: 13, fontWeight: 700, fontFamily: FONT,
                      }}
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </>
              )}
            </div>

            {!editing && (
              <div style={{ display: 'flex', gap: 10, borderTop: `1px solid ${B.rowSep}`, paddingTop: 14 }}>
                <button
                  onClick={() => setEditing(true)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '8px 14px', borderRadius: 8, border: `1px solid ${B.cardBorder}`,
                    background: 'var(--c-cardBg)', cursor: 'pointer', fontSize: 13,
                    fontWeight: 600, color: B.t2, fontFamily: FONT,
                  }}
                >
                  <Pencil size={14} /> Edit
                </button>
                <button
                  onClick={onDelete}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '8px 14px', borderRadius: 8, border: '1px solid #FECACA',
                    background: '#FEF2F2', cursor: 'pointer', fontSize: 13,
                    fontWeight: 600, color: '#991B1B', fontFamily: FONT,
                  }}
                >
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Info card */}
        <div style={{ width: 280 }}>
          <div style={{ background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: B.t2, marginBottom: 8 }}>How it works</div>
            <div style={{ fontSize: 12, color: B.t5, lineHeight: 1.6 }}>
              When someone clicks this link, WhatsApp opens with your pre-filled message ready to send.
              The message can contain keywords that trigger automations.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div style={{ display: 'flex', padding: '8px 0', borderBottom: `1px solid ${B.rowSep}` }}>
      <div style={{ width: 140, fontSize: 12, fontWeight: 600, color: B.t5, flexShrink: 0 }}>{label}</div>
      <div style={{ fontSize: 13, color: B.t2, flex: 1, wordBreak: 'break-word' }}>{value}</div>
    </div>
  );
}

function normalizePhone(str) {
  return (str || '').replace(/\D/g, '');
}

function buildWaMeUrl(phone, message) {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) return '';
  const base = `https://wa.me/${cleanPhone}`;
  const text = message ? encodeURIComponent(message.trim()) : '';
  return text ? `${base}?text=${text}` : base;
}
