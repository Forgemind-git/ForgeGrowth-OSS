import { useState, useEffect, useCallback } from 'react';
import { Link2, Plus, Pencil, Trash2, Check, X, ExternalLink, Radio } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO } from '../constants.js';
import { showError, showSuccess } from '../lib/feedback.js';
import { useConfirm } from './ConfirmDialog.jsx';
import SearchableSelect from './SearchableSelect.jsx';

const TYPES = ['Calendar', 'Payment', 'Community', 'Link'];

/**
 * Live Links — the 3-4 operational fields that change every batch (current webinar
 * link + date, current payment link, current batch group link). CRUDs `resources`
 * where is_dynamic = true. Edited in exactly one place; every trigger + bot reply
 * reads from here live. Shown at the top of the AI Agents page.
 */
export default function LiveLinksPanel() {
  const [links, setLinks] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState(null);
  const [confirmEl, confirm] = useConfirm();

  const load = useCallback(async () => {
    try { const d = await api.resources.list(true); setLinks(d.resources); }
    catch (e) { showError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function del(l) {
    if (!(await confirm({ title: 'Delete live link?', body: `“${l.title}” will be removed.`, confirmLabel: 'Delete', danger: true }))) return;
    try { await api.resources.delete(l.id); showSuccess('Deleted.'); load(); }
    catch (e) { showError(e.message); }
  }

  return (
    <div style={{ margin: '16px 24px 0', background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: C.shadowSm, fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ width: 30, height: 30, borderRadius: 8, background: C.primaryLight, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Radio size={16} color={C.primary} />
          </span>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Live Links</div>
            <div style={{ fontSize: 14, color: C.textMuted, marginTop: 1 }}>Batch-specific links — edited once, read live by every trigger & bot reply.</div>
          </div>
        </div>
        <button onClick={() => setAdding(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 13px', borderRadius: 8, border: 'none', background: C.primary, color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600, fontFamily: FONT }}>
          <Plus size={14} /> Add link
        </button>
      </div>

      <div style={{ padding: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        {links == null && <div style={{ color: C.textMuted, fontSize: 15, padding: 8 }}>Loading…</div>}
        {links && links.length === 0 && !adding && (
          <div style={{ color: C.textMuted, fontSize: 15, padding: 8 }}>No live links yet — add your current webinar, payment, and batch-group links.</div>
        )}
        {adding && <LinkEditor onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
        {(links || []).map(l => (
          editId === l.id
            ? <LinkEditor key={l.id} link={l} onCancel={() => setEditId(null)} onSaved={() => { setEditId(null); load(); }} />
            : <LinkCard key={l.id} link={l} onEdit={() => setEditId(l.id)} onDelete={() => del(l)} />
        ))}
      </div>
      {confirmEl}
    </div>
  );
}

function LinkCard({ link, onEdit, onDelete }) {
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 13, background: C.surfaceAlt }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <Link2 size={14} color={C.primary} style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 15, fontWeight: 600, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{link.title}</span>
        </div>
        <span style={{ display: 'inline-flex', gap: 3, flexShrink: 0 }}>
          <button onClick={onEdit} style={iconBtn}><Pencil size={13} /></button>
          <button onClick={onDelete} style={iconBtn}><Trash2 size={13} /></button>
        </span>
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.textMuted, marginTop: 8 }}>{link.type}</div>
      {link.fileUrl && (
        <a href={link.fileUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 4, fontSize: 14, color: C.primary, fontFamily: MONO, textDecoration: 'none', wordBreak: 'break-all' }}>
          {link.fileUrl.length > 40 ? link.fileUrl.slice(0, 40) + '…' : link.fileUrl} <ExternalLink size={11} />
        </a>
      )}
      {(link.triggerPhrases || []).length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {link.triggerPhrases.map((p, i) => (
            <span key={i} style={{ fontSize: 12, color: C.textSecondary, background: C.hover, padding: '2px 7px', borderRadius: 99, fontFamily: MONO }}>{p}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function LinkEditor({ link, onCancel, onSaved }) {
  const isNew = !link;
  const [f, setF] = useState({
    title: link?.title || '', type: link?.type || 'Calendar', fileUrl: link?.fileUrl || '',
    triggerPhrases: (link?.triggerPhrases || []).join(', '),
  });
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!f.title.trim()) return showError('Title is required');
    setSaving(true);
    const payload = {
      title: f.title, type: f.type, fileUrl: f.fileUrl, isDynamic: true,
      triggerPhrases: f.triggerPhrases.split(',').map(s => s.trim()).filter(Boolean),
    };
    try {
      if (isNew) await api.resources.create(payload); else await api.resources.update(link.id, payload);
      showSuccess(isNew ? 'Live link added.' : 'Live link updated.'); onSaved();
    } catch (e) { showError(e.message); setSaving(false); }
  }
  const inp = { width: '100%', padding: '7px 9px', borderRadius: 7, border: `1.5px solid ${C.border}`, fontSize: 14, fontFamily: FONT, color: C.text, outline: 'none', boxSizing: 'border-box', background: C.cardBg, marginBottom: 7 };
  return (
    <div style={{ border: `1.5px solid ${C.primary}`, borderRadius: 10, padding: 13, background: C.cardBg }}>
      <input style={inp} placeholder="Title (e.g. Current Payment Link)" value={f.title} onChange={e => setF(s => ({ ...s, title: e.target.value }))} autoFocus />
      <div style={{ marginBottom: 7 }}>
        <SearchableSelect value={f.type} onChange={v => setF(s => ({ ...s, type: v }))} options={TYPES.map(t => ({ value: t, label: t }))} triggerStyle={{ padding: '7px 28px 7px 9px', fontSize: 14 }} />
      </div>
      <input style={inp} placeholder="URL" value={f.fileUrl} onChange={e => setF(s => ({ ...s, fileUrl: e.target.value }))} />
      <input style={inp} placeholder="Trigger phrases (comma-separated)" value={f.triggerPhrases} onChange={e => setF(s => ({ ...s, triggerPhrases: e.target.value }))} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 2 }}>
        <button onClick={onCancel} style={{ ...iconBtn, padding: '6px 10px', fontSize: 14, color: C.textSecondary }}><X size={13} /> Cancel</button>
        <button onClick={save} disabled={saving} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7, border: 'none', background: C.primary, color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600, fontFamily: FONT }}>
          <Check size={13} /> {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

const iconBtn = { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted, padding: 4, borderRadius: 6, fontFamily: FONT };
