// Funnel Settings (spec §3.2, §4.2, §8, §9) — the mandatory config screens:
//   • Stages   — ordered, drag-to-reorder, add / rename / recolor / mark won / delete
//   • Sources  — flat list, add / rename / delete
//   • Products — reuses the Products registry (link out)
// Admin-only (gated by the `funnel-settings` page permission + nav).
import { useState, useEffect } from 'react';
import { Plus, Trash2, GripVertical, Check, Trophy, Package } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import { showError, showSuccess } from '../../lib/feedback.js';
import { Button, Segmented, inputStyle, EmptyState, Badge } from '../academy/shared.jsx';
import { Card, Shimmer } from '../../components/charts.jsx';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import { refreshFunnelConfig } from '../../hooks/useFunnelConfig.js';

const STAGE_SWATCHES = ['#64748b', '#3b82f6', '#8b5cf6', '#0891b2', '#f59e0b', '#22c55e', '#dc2626', '#0F6E56', '#db2777'];

// Embeddable content (no page shell) — rendered inside Admin Settings → Funnel.
export function FunnelSettingsContent({ navigate }) {
  const [tab, setTab] = useState('stages');
  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <Segmented value={tab} onChange={setTab}
          options={[{ value: 'stages', label: 'Stages' }, { value: 'sources', label: 'Sources' }, { value: 'products', label: 'Products' }]} />
      </div>
      {tab === 'stages' && <StagesTab />}
      {tab === 'sources' && <SourcesTab />}
      {tab === 'products' && <ProductsTab />}
    </>
  );
}

// ── Stages ────────────────────────────────────────────────────────────────────
function StagesTab() {
  const [stages, setStages] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [confirmEl, confirm] = useConfirm();

  async function load() {
    try { const r = await api.funnel.config(); setStages(r.stages || []); }
    catch (e) { showError(e.message); setStages([]); }
  }
  useEffect(() => { load(); }, []);

  async function persist() { await refreshFunnelConfig(); }

  async function addStage() {
    if (!newLabel.trim()) return;
    try { await api.funnel.createStage({ label: newLabel.trim(), isFunnel: true }); setNewLabel(''); setAdding(false); await load(); persist(); }
    catch (e) { showError(e.message); }
  }
  async function patch(id, data) {
    try { await api.funnel.updateStage(id, data); await load(); persist(); }
    catch (e) { showError(e.message); load(); }
  }
  async function removeStage(s) {
    if (!(await confirm({ title: 'Delete stage', body: `Delete the “${s.label}” stage?`, confirmLabel: 'Delete', danger: true }))) return;
    try { await api.funnel.deleteStage(s.id); await load(); persist(); }
    catch (e) { showError(e.message); }
  }
  async function onDrop(targetId) {
    if (dragId == null || dragId === targetId) return setDragId(null);
    const ids = stages.map(s => s.id);
    const from = ids.indexOf(dragId), to = ids.indexOf(targetId);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setStages(ids.map(id => stages.find(s => s.id === id))); // optimistic
    setDragId(null);
    try { await api.funnel.reorderStages(ids); persist(); }
    catch (e) { showError(e.message); load(); }
  }

  if (stages == null) return <Card title="Funnel stages"><div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{[0, 1, 2, 3].map(i => <Shimmer key={i} height={44} />)}</div></Card>;

  return (
    <Card title="Funnel stages" right={<span style={{ fontFamily: FONT, fontSize: 14, color: C.textMuted }}>Drag to reorder — this order drives the Funnel chart</span>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {stages.map(s => (
          <div key={s.id} draggable onDragStart={() => setDragId(s.id)} onDragOver={e => e.preventDefault()} onDrop={() => onDrop(s.id)}
            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', border: `1.5px solid ${dragId === s.id ? C.primary : C.border}`, borderRadius: 10, background: C.cardBg, opacity: dragId === s.id ? 0.6 : 1 }}>
            <GripVertical size={16} color={C.textMuted} style={{ cursor: 'grab', flexShrink: 0 }} />
            {/* color swatch picker */}
            <ColorDot color={s.color} onPick={c => patch(s.id, { color: c })} />
            {/* editable label */}
            <input defaultValue={s.label} onBlur={e => { const v = e.target.value.trim(); if (v && v !== s.label) patch(s.id, { label: v }); }}
              style={{ ...inputStyle, flex: 1, padding: '7px 10px' }} />
            {/* funnel / branch toggle */}
            <button onClick={() => patch(s.id, { isFunnel: !s.isFunnel })} title={s.isFunnel ? 'Counts in the funnel progression' : 'Branches off the funnel (e.g. Cold / Lost)'}
              style={{ ...pillBtn, color: s.isFunnel ? C.green : C.textMuted, borderColor: s.isFunnel ? '#BFE3D5' : C.border }}>
              {s.isFunnel ? 'In funnel' : 'Branch'}
            </button>
            {/* won toggle */}
            <button onClick={() => patch(s.id, { isWon: !s.isWon })} title="Mark this as the terminal 'won/paid' stage"
              style={{ ...pillBtn, color: s.isWon ? 'var(--c-sb45309, #B45309)' : C.textMuted, borderColor: s.isWon ? '#F5D9A8' : C.border, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Trophy size={13} />{s.isWon ? 'Won' : 'Mark won'}
            </button>
            <span style={{ fontFamily: MONO, fontSize: 13, color: C.textMuted, width: 90, textAlign: 'right' }} title="Internal key (immutable)">{s.stageKey}</span>
            <button title="Delete" onClick={() => removeStage(s)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.primary, flexShrink: 0 }}><Trash2 size={15} /></button>
          </div>
        ))}
      </div>
      {adding ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input autoFocus value={newLabel} onChange={e => setNewLabel(e.target.value)} onKeyDown={e => e.key === 'Enter' && addStage()}
            placeholder="New stage name" style={{ ...inputStyle, flex: 1 }} />
          <Button variant="primary" onClick={addStage}>Add</Button>
          <Button onClick={() => { setAdding(false); setNewLabel(''); }}>Cancel</Button>
        </div>
      ) : (
        <div style={{ marginTop: 12 }}><Button icon={Plus} onClick={() => setAdding(true)}>Add stage</Button></div>
      )}
      {confirmEl}
    </Card>
  );
}

function ColorDot({ color, onPick }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button onClick={() => setOpen(o => !o)} title="Change color"
        style={{ width: 22, height: 22, borderRadius: 99, background: color, border: `2px solid ${C.border}`, cursor: 'pointer' }} />
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: 28, left: 0, zIndex: 50, background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 8, boxShadow: C.shadowMd, display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, width: 150 }}>
            {STAGE_SWATCHES.map(c => (
              <button key={c} onClick={() => { onPick(c); setOpen(false); }} style={{ width: 22, height: 22, borderRadius: 99, background: c, border: color === c ? `2px solid ${C.text}` : '2px solid transparent', cursor: 'pointer' }} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Sources ───────────────────────────────────────────────────────────────────
function SourcesTab() {
  const [sources, setSources] = useState(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [confirmEl, confirm] = useConfirm();

  async function load() {
    try { const r = await api.funnel.sources(); setSources(r.sources || []); }
    catch (e) { showError(e.message); setSources([]); }
  }
  useEffect(() => { load(); }, []);

  async function add() {
    if (!label.trim()) return;
    try { await api.funnel.createSource(label.trim()); setLabel(''); setAdding(false); await load(); refreshFunnelConfig(); }
    catch (e) { showError(e.message); }
  }
  async function rename(s, v) {
    if (!v.trim() || v === s.label) return;
    try { await api.funnel.updateSource(s.id, { label: v.trim() }); await load(); refreshFunnelConfig(); }
    catch (e) { showError(e.message); load(); }
  }
  async function remove(s) {
    const msg = s.leadCount > 0
      ? `“${s.label}” is used by ${s.leadCount} lead(s). It will be hidden from new pickers but existing leads keep the label. Continue?`
      : `Delete the “${s.label}” source?`;
    if (!(await confirm({ title: 'Remove source', body: msg, confirmLabel: 'Remove', danger: true }))) return;
    try { await api.funnel.deleteSource(s.id); await load(); refreshFunnelConfig(); }
    catch (e) { showError(e.message); }
  }

  if (sources == null) return <Card title="Lead sources"><div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{[0, 1, 2].map(i => <Shimmer key={i} height={40} />)}</div></Card>;

  return (
    <Card title="Lead sources" right={<span style={{ fontFamily: FONT, fontSize: 14, color: C.textMuted }}>Where leads come from — a flat list</span>}>
      {sources.length === 0 && !adding ? (
        <EmptyState Icon={Plus} title="No sources yet" hint="Add your first lead source (e.g. Website, Ads, Referral, WhatsApp)." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sources.map(s => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px', border: `1.5px solid ${C.border}`, borderRadius: 10 }}>
              <input defaultValue={s.label} onBlur={e => rename(s, e.target.value)} style={{ ...inputStyle, flex: 1, padding: '7px 10px' }} />
              {s.leadCount > 0 && <Badge label={`${s.leadCount} lead${s.leadCount > 1 ? 's' : ''}`} color={C.textSecondary} bg={C.hover} />}
              {!s.active && <Badge label="hidden" color={C.textMuted} bg={C.hover} />}
              <button title="Remove" onClick={() => remove(s)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.primary }}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      )}
      {adding ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input autoFocus value={label} onChange={e => setLabel(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} placeholder="New source name" style={{ ...inputStyle, flex: 1 }} />
          <Button variant="primary" onClick={add}>Add</Button>
          <Button onClick={() => { setAdding(false); setLabel(''); }}>Cancel</Button>
        </div>
      ) : (
        <div style={{ marginTop: 12 }}><Button icon={Plus} onClick={() => setAdding(true)}>Add source</Button></div>
      )}
      {confirmEl}
    </Card>
  );
}

// ── Products ─────────────────────────────────────────────────────────────────
// The Sales section's Products page was removed 2026-08-12 and folded in here:
// a product is a thing you configure once, like a stage or a source, not a
// place you visit. The `courses` table behind it is unchanged — its id is the
// FK the Razorpay money-attribution path uses.
//
// Every product also owns a TAG (managed, auto-applied when a sale records it)
// so a customer's purchases are filterable in Chats. The tag is created and
// renamed by the backend; there is nothing to manage here.
function ProductsTab() {
  const [products, setProducts] = useState(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', price: '' });
  const [confirmEl, confirm] = useConfirm();

  // ⚠ GET /products returns RAW pg rows (`default_price_paise`), NOT the
  // camelCase shape the rest of api.js uses. Reading `p.defaultPrice` straight
  // off them yields undefined, so every price box renders EMPTY and saving one
  // would look like the price had never been set. Normalised once, here.
  async function load() {
    try {
      const r = await api.products.list();
      setProducts((r.products || []).map(p => ({
        id: p.id,
        name: p.name,
        active: p.active !== false,
        defaultPrice: p.default_price_paise != null ? Number(p.default_price_paise) / 100 : null,
      })));
    } catch (e) { showError(e.message); setProducts([]); }
  }
  useEffect(() => { load(); }, []);

  // ⚠ '' clears the price, a missing key LEAVES it. Collapsing the two would
  // make a rename silently wipe the price.
  const priceArg = (v) => (String(v).trim() === '' ? null : Number(v));

  async function add() {
    if (!draft.name.trim()) return;
    try {
      await api.products.create({ name: draft.name.trim(), defaultPrice: priceArg(draft.price) });
      setDraft({ name: '', price: '' }); setAdding(false); await load();
    } catch (e) { showError(e.message); }
  }
  async function save(p, patch) {
    try { await api.products.update(p.id, patch); await load(); }
    catch (e) { showError(e.message); load(); }
  }
  async function remove(p) {
    if (!(await confirm({
      title: 'Remove product',
      body: `Delete “${p.name}”? Sales already recorded against it keep the name, and its tag is removed from contacts.`,
      confirmLabel: 'Remove', danger: true,
    }))) return;
    try { await api.products.delete(p.id); await load(); }
    catch (e) { showError(e.message); }
  }

  if (products == null) {
    return <Card title="Products"><div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{[0, 1, 2].map(i => <Shimmer key={i} height={40} />)}</div></Card>;
  }

  return (
    <Card title="Products" right={<span style={{ fontFamily: FONT, fontSize: 14, color: C.textMuted }}>What you sell — name, price, and its own tag</span>}>
      <div style={{ fontFamily: FONT, fontSize: 15, color: C.textSecondary, marginBottom: 14 }}>
        These drive the Sales Log product dropdown and payment attribution. Each one gets a matching tag,
        applied to the customer automatically when a sale records that product.
      </div>
      {products.length === 0 && !adding ? (
        <EmptyState Icon={Package} title="No products yet" hint="Add what you sell — it appears in the Sales Log straight away." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {products.map(p => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', border: `1.5px solid ${C.border}`, borderRadius: 10 }}>
              <Package size={15} color={C.purple} style={{ flexShrink: 0 }} />
              <input defaultValue={p.name} onBlur={e => e.target.value.trim() && e.target.value !== p.name && save(p, { name: e.target.value.trim() })}
                style={{ ...inputStyle, flex: 1, padding: '7px 10px' }} />
              <input defaultValue={p.defaultPrice ?? ''} placeholder="Price ₹"
                onBlur={e => String(e.target.value) !== String(p.defaultPrice ?? '') && save(p, { defaultPrice: priceArg(e.target.value) })}
                style={{ ...inputStyle, width: 110, padding: '7px 10px', fontFamily: MONO }} />
              {!p.active && <Badge label="inactive" color={C.textMuted} bg={C.hover} />}
              <button title="Remove" onClick={() => remove(p)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.primary }}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      )}
      {adding ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input autoFocus value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}
            onKeyDown={e => e.key === 'Enter' && add()} placeholder="Product name" style={{ ...inputStyle, flex: 1 }} />
          <input value={draft.price} onChange={e => setDraft({ ...draft, price: e.target.value })}
            onKeyDown={e => e.key === 'Enter' && add()} placeholder="Price ₹" style={{ ...inputStyle, width: 110, fontFamily: MONO }} />
          <Button variant="primary" onClick={add}>Add</Button>
          <Button onClick={() => { setAdding(false); setDraft({ name: '', price: '' }); }}>Cancel</Button>
        </div>
      ) : (
        <div style={{ marginTop: 12 }}><Button icon={Plus} onClick={() => setAdding(true)}>Add product</Button></div>
      )}
      {confirmEl}
    </Card>
  );
}

const pillBtn = { background: 'none', border: `1.5px solid ${C.border}`, borderRadius: 99, padding: '5px 11px', cursor: 'pointer', fontFamily: FONT, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' };
