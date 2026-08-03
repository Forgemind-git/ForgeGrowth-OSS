// Funnel Settings (spec §3.2, §4.2, §8, §9) — the mandatory config screens:
//   • Stages   — ordered, drag-to-reorder, add / rename / recolor / mark won / delete
//   • Sources  — flat list, add / rename / delete
//   • Products — reuses the Products registry (link out)
// Admin-only (gated by the `funnel-settings` page permission + nav).
import { useState, useEffect } from 'react';
import { Plus, Trash2, GripVertical, Check, Trophy, Package, ArrowRight } from 'lucide-react';
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
      {tab === 'products' && <ProductsTab navigate={navigate} />}
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
    <Card title="Funnel stages" right={<span style={{ fontFamily: FONT, fontSize: 12, color: C.textMuted }}>Drag to reorder — this order drives the Funnel chart</span>}>
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
              style={{ ...pillBtn, color: s.isWon ? '#B45309' : C.textMuted, borderColor: s.isWon ? '#F5D9A8' : C.border, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Trophy size={13} />{s.isWon ? 'Won' : 'Mark won'}
            </button>
            <span style={{ fontFamily: MONO, fontSize: 11, color: C.textMuted, width: 90, textAlign: 'right' }} title="Internal key (immutable)">{s.stageKey}</span>
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
    <Card title="Lead sources" right={<span style={{ fontFamily: FONT, fontSize: 12, color: C.textMuted }}>Where leads come from — a flat list</span>}>
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

// ── Products (the same registry the Products page manages) ───────────────────
function ProductsTab({ navigate }) {
  const [products, setProducts] = useState(null);
  useEffect(() => { api.products.list().then(r => setProducts(r.products || [])).catch(e => { showError(e.message); setProducts([]); }); }, []);
  return (
    <Card title="Products" right={<Button icon={ArrowRight} onClick={() => navigate && navigate('products')}>Manage products</Button>}>
      <div style={{ fontFamily: FONT, fontSize: 13, color: C.textSecondary, marginBottom: 14 }}>
        The same list powers payment attribution and the Sales Log product dropdown. Add or edit them on the Products page.
      </div>
      {products == null ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{[0, 1, 2].map(i => <Shimmer key={i} height={38} />)}</div>
      ) : products.length === 0 ? (
        <EmptyState Icon={Package} title="No products yet" hint="Add a product on the Products page — it’ll appear in the Sales Log." />
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {products.map(c => (
            <div key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: 10, fontFamily: FONT, fontSize: 13, color: C.text }}>
              <Package size={14} color={C.purple} />{c.name}{!c.active && <Badge label="inactive" color={C.textMuted} bg={C.hover} />}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

const pillBtn = { background: 'none', border: `1.5px solid ${C.border}`, borderRadius: 99, padding: '5px 11px', cursor: 'pointer', fontFamily: FONT, fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap' };
