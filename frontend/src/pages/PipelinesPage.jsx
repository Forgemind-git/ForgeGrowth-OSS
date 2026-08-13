import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus, ChevronDown, MoreVertical, Pencil, Trash2, X, Search, Phone,
  Info, BarChart3, IndianRupee, Target, TrendingUp, Trophy, XCircle,
  Kanban, User, Check, Tag,
} from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO, maskPhone } from '../constants.js';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import { useServerEvents } from '../hooks/useServerEvents.js';
import SearchableSelect from '../components/SearchableSelect.jsx';

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtMoney(n) {
  const v = Number(n) || 0;
  if (v >= 1e7) return '₹' + trim(v / 1e7) + 'Cr';
  if (v >= 1e5) return '₹' + trim(v / 1e5) + 'L';
  if (v >= 1e3) return '₹' + trim(v / 1e3) + 'K';
  return '₹' + v.toLocaleString('en-IN');
}
function trim(x) {
  return Number(x.toFixed(x < 10 ? 2 : 1)).toString();
}
function fullMoney(n) {
  return '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
function initials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase();
}
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

const STAGE_COLORS = [
  '#3b82f6', '#eab308', '#f97316', '#8b5cf6', '#22c55e', '#ef4444',
  '#06b6d4', '#ec4899', '#14b8a6', '#f59e0b', '#6366f1', '#64748b',
];

const KPI_DEFS = [
  { key: 'totalDeals',    label: 'Total Deals',     Icon: BarChart3,   money: false, tip: 'Open deals in this pipeline (excludes Won and Lost).' },
  { key: 'pipelineValue', label: 'Pipeline Value',  Icon: IndianRupee, money: true,  tip: 'Total value of all open deals.' },
  { key: 'avgDealSize',   label: 'Avg Deal Size',   Icon: Target,      money: true,  tip: 'Pipeline value divided by the number of open deals.' },
  { key: 'weightedValue', label: 'Weighted Value',  Icon: TrendingUp,  money: true,  tip: 'Each open deal value multiplied by its stage win-probability, summed.' },
  { key: 'wonThisMonth',  label: 'Won This Month',  Icon: Trophy,      money: false, tip: 'Deals moved to a Won stage since the 1st of this month (IST).' },
  { key: 'lostThisMonth', label: 'Lost This Month', Icon: XCircle,     money: false, tip: 'Deals moved to a Lost stage since the 1st of this month (IST).' },
];

// ── page ──────────────────────────────────────────────────────────────────────

export default function PipelinesPage({ user }) {
  const isAdmin = user?.role === 'admin';
  const [ConfirmEl, confirm] = useConfirm();
  const [pipelines, setPipelines] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pipelineModal, setPipelineModal] = useState(null);   // { mode:'create'|'rename', name }
  const [dealModal, setDealModal] = useState(null);           // { mode, stageId, deal }
  const [stageModal, setStageModal] = useState(null);         // { mode:'create'|'edit', stage }
  const [dragDealId, setDragDealId] = useState(null);
  const [dragOverStage, setDragOverStage] = useState(null);

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // Initial: load pipeline list, pick default/first.
  useEffect(() => {
    let alive = true;
    api.pipelines.list()
      .then(({ pipelines }) => {
        if (!alive) return;
        setPipelines(pipelines);
        setSelectedId(prev => prev || (pipelines[0]?.id ?? null));
        if (!pipelines.length) setLoading(false);
      })
      .catch(() => { if (alive) { setError('Could not load pipelines.'); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  const loadBoard = useCallback((id, silent = false) => {
    if (!id) return;
    if (!silent) setLoading(true);
    return api.pipelines.board(id)
      .then(b => { setBoard(b); setError(null); })
      .catch(() => setError('Could not load this pipeline.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (selectedId) loadBoard(selectedId);
  }, [selectedId, loadBoard]);

  const refreshPipelines = useCallback(() =>
    api.pipelines.list().then(({ pipelines }) => setPipelines(pipelines)).catch(() => {}), []);

  // Live updates: any board change on the server (deal/stage/pipeline mutation,
  // including a delete from another user's session) pushes `pipeline-changed`.
  // We refetch the affected board silently so every open tab stays in sync.
  // selectedId is read through a ref so the handler stays stable across renders.
  const selectedIdRef = useRef(selectedId);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  const onServerEvent = useCallback((ev) => {
    if (ev.type !== 'pipeline-changed') return;
    const { pipelineId, listChanged } = ev.data || {};
    if (listChanged) refreshPipelines();
    if (pipelineId == null || pipelineId === selectedIdRef.current) {
      if (selectedIdRef.current) loadBoard(selectedIdRef.current, true);
    }
  }, [refreshPipelines, loadBoard]);
  useServerEvents(onServerEvent);

  // ── pipeline actions ──
  const createPipeline = async (name) => {
    try {
      const { pipeline } = await api.pipelines.create(name);
      await refreshPipelines();
      setSelectedId(pipeline.id);
      setPipelineModal(null);
      showToast('Pipeline created');
    } catch (e) { showToast(humanErr(e), 'error'); }
  };
  const renamePipeline = async (name) => {
    try {
      await api.pipelines.rename(selectedId, name);
      await refreshPipelines();
      setBoard(b => b ? { ...b, pipeline: { ...b.pipeline, name } } : b);
      setPipelineModal(null);
      showToast('Pipeline renamed');
    } catch (e) { showToast(humanErr(e), 'error'); }
  };
  const deletePipeline = async () => {
    const ok = await confirm({
      title: 'Delete pipeline?',
      body: `“${board?.pipeline?.name}” and all its stages and deals will be permanently removed.`,
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      await api.pipelines.delete(selectedId);
      const remaining = pipelines.filter(p => p.id !== selectedId);
      setPipelines(remaining);
      setSelectedId(remaining[0]?.id ?? null);
      if (!remaining.length) { setBoard(null); setLoading(false); }
      showToast('Pipeline deleted');
    } catch (e) { showToast(humanErr(e), 'error'); }
  };

  // ── deal actions ──
  const saveDeal = async (form, mode, deal) => {
    try {
      if (mode === 'create') {
        await api.pipelines.addDeal(selectedId, form);
      } else {
        const { stageId, ...fields } = form;
        await api.pipelines.updateDeal(deal.id, fields);
        if (stageId && stageId !== deal.stageId) await api.pipelines.moveDeal(deal.id, stageId);
      }
      setDealModal(null);
      await loadBoard(selectedId, true);
      showToast(mode === 'create' ? 'Deal added' : 'Deal updated');
    } catch (e) { showToast(humanErr(e), 'error'); }
  };
  const deleteDeal = async (deal) => {
    const ok = await confirm({
      title: 'Delete deal?',
      body: `“${deal.title}” will be permanently removed.`,
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      await api.pipelines.deleteDeal(deal.id);
      setDealModal(null);
      await loadBoard(selectedId, true);
      showToast('Deal deleted');
    } catch (e) { showToast(humanErr(e), 'error'); }
  };

  // ── drag and drop ──
  const handleDrop = async (stageId) => {
    const dealId = dragDealId;
    setDragDealId(null);
    setDragOverStage(null);
    if (!dealId) return;
    const deal = board.deals.find(d => d.id === dealId);
    if (!deal || deal.stageId === stageId) return;
    // optimistic
    setBoard(b => ({ ...b, deals: b.deals.map(d => d.id === dealId ? { ...d, stageId } : d) }));
    try {
      await api.pipelines.moveDeal(dealId, stageId);
      await loadBoard(selectedId, true);   // reconcile KPIs + status
    } catch (e) {
      showToast(humanErr(e), 'error');
      loadBoard(selectedId, true);         // revert from server truth
    }
  };

  // ── stage actions ──
  const saveStage = async (form, mode, stage) => {
    try {
      if (mode === 'create') await api.pipelines.addStage(selectedId, form);
      else await api.pipelines.updateStage(stage.id, form);
      setStageModal(null);
      await loadBoard(selectedId, true);
      showToast(mode === 'create' ? 'Stage added' : 'Stage updated');
    } catch (e) { showToast(humanErr(e), 'error'); }
  };
  const deleteStage = async (stage) => {
    const ok = await confirm({
      title: 'Delete stage?',
      body: `“${stage.name}” will be removed. Deals must be moved out first.`,
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      await api.pipelines.deleteStage(stage.id);
      await loadBoard(selectedId, true);
      showToast('Stage deleted');
    } catch (e) { showToast(humanErr(e), 'error'); }
  };

  // ── render ──
  const hasPipelines = pipelines.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: FONT, color: C.text }}>
      {ConfirmEl}
      {toast && <Toast toast={toast} />}

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '18px 24px', borderBottom: `1px solid ${C.border}`, background: C.cardBg,
      }}>
        <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.02em', marginRight: 4 }}>Pipelines</div>

        {hasPipelines && (
          <PipelinePicker
            pipelines={pipelines}
            selectedId={selectedId}
            open={pickerOpen}
            setOpen={setPickerOpen}
            onSelect={(id) => { setSelectedId(id); setPickerOpen(false); }}
          />
        )}

        <div style={{ flex: 1 }} />

        {isAdmin && (
          <button onClick={() => setPipelineModal({ mode: 'create', name: '' })} style={btnGhost}>
            <Plus size={15} /> Add Pipeline
          </button>
        )}
        {hasPipelines && board && (
          <>
            <button
              onClick={() => setDealModal({ mode: 'create', stageId: board.stages[0]?.id, deal: null })}
              style={btnPrimary}
              disabled={!board.stages.length}
            >
              <Plus size={15} /> Add Deal
            </button>
            {isAdmin && (
              <PipelineMenu
                onRename={() => setPipelineModal({ mode: 'rename', name: board.pipeline.name })}
                onDelete={deletePipeline}
              />
            )}
          </>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: C.pageBg }}>
        {!hasPipelines && !loading ? (
          <EmptyPipelines isAdmin={isAdmin} onCreate={() => setPipelineModal({ mode: 'create', name: '' })} />
        ) : loading ? (
          <BoardSkeleton />
        ) : error ? (
          <div style={{ padding: 40, textAlign: 'center', color: C.primary, fontSize: 15 }}>{error}</div>
        ) : board ? (
          <>
            <KpiRow kpis={board.kpis} />
            <Board
              board={board}
              isAdmin={isAdmin}
              dragDealId={dragDealId}
              dragOverStage={dragOverStage}
              setDragDealId={setDragDealId}
              setDragOverStage={setDragOverStage}
              onDrop={handleDrop}
              onAddDeal={(stageId) => setDealModal({ mode: 'create', stageId, deal: null })}
              onOpenDeal={(deal) => setDealModal({ mode: 'edit', stageId: deal.stageId, deal })}
              onEditStage={(stage) => setStageModal({ mode: 'edit', stage })}
              onDeleteStage={deleteStage}
              onAddStage={() => setStageModal({ mode: 'create', stage: null })}
            />
          </>
        ) : null}
      </div>

      {pipelineModal && (
        <PipelineModal
          mode={pipelineModal.mode}
          initialName={pipelineModal.name}
          onClose={() => setPipelineModal(null)}
          onSave={(name) => pipelineModal.mode === 'create' ? createPipeline(name) : renamePipeline(name)}
        />
      )}
      {dealModal && (
        <DealModal
          mode={dealModal.mode}
          isAdmin={isAdmin}
          stages={board.stages}
          stageId={dealModal.stageId}
          deal={dealModal.deal}
          onClose={() => setDealModal(null)}
          onSave={(form) => saveDeal(form, dealModal.mode, dealModal.deal)}
          onDelete={(dealModal.deal && isAdmin) ? () => deleteDeal(dealModal.deal) : null}
        />
      )}
      {stageModal && (
        <StageModal
          mode={stageModal.mode}
          stage={stageModal.stage}
          onClose={() => setStageModal(null)}
          onSave={(form) => saveStage(form, stageModal.mode, stageModal.stage)}
        />
      )}
    </div>
  );
}

function humanErr(e) {
  const m = String(e?.message || '');
  // api.js throws `Error("<status> <body>")` where body may be JSON {error}
  const jsonStart = m.indexOf('{');
  if (jsonStart >= 0) {
    try { const j = JSON.parse(m.slice(jsonStart)); if (j.error) return j.error; } catch {}
  }
  return 'Something went wrong. Please try again.';
}

// ── pipeline picker ─────────────────────────────────────────────────────────

function PipelinePicker({ pipelines, selectedId, open, setOpen, onSelect }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, setOpen]);
  const current = pipelines.find(p => p.id === selectedId);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
        borderRadius: 10, border: `1px solid ${C.border}`, background: C.pageBg,
        cursor: 'pointer', fontFamily: FONT, fontSize: 15, fontWeight: 700, color: C.text,
      }}>
        <Kanban size={15} color={C.primary} />
        {current?.name || 'Select pipeline'}
        <ChevronDown size={15} color={C.textMuted} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, minWidth: 220, zIndex: 50,
          background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12,
          boxShadow: C.shadowMd, padding: 6, maxHeight: 320, overflowY: 'auto',
        }}>
          {pipelines.map(p => {
            const active = p.id === selectedId;
            return (
              <div key={p.id} onClick={() => onSelect(p.id)} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px',
                borderRadius: 8, cursor: 'pointer', fontSize: 15, fontWeight: active ? 700 : 500,
                color: active ? C.primary : C.text, background: active ? C.primaryLight : 'transparent',
              }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = C.hover; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
                <Kanban size={14} /> {p.name}
                {p.isDefault && <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.05em' }}>Default</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PipelineMenu({ onRename, onDelete }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} style={{
        ...iconBtn, width: 38, height: 38,
      }} title="Pipeline options"><MoreVertical size={16} /></button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', right: 0, minWidth: 170, zIndex: 50,
          background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: C.shadowMd, padding: 6,
        }}>
          <MenuItem icon={<Pencil size={14} />} label="Rename pipeline" onClick={() => { setOpen(false); onRename(); }} />
          <MenuItem icon={<Trash2 size={14} />} label="Delete pipeline" danger onClick={() => { setOpen(false); onDelete(); }} />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', borderRadius: 8,
      cursor: 'pointer', fontSize: 15, fontWeight: 600, color: danger ? C.primary : C.text,
    }}
      onMouseEnter={e => e.currentTarget.style.background = danger ? C.primaryLight : C.hover}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
      {icon} {label}
    </div>
  );
}

// ── KPI row ───────────────────────────────────────────────────────────────────

function KpiRow({ kpis }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '16px 24px 4px', overflowX: 'auto', flexShrink: 0 }}>
      {KPI_DEFS.map(def => {
        const raw = kpis[def.key] || 0;
        const display = def.money ? fmtMoney(raw) : String(raw);
        return (
          <div key={def.key} title={def.tip} style={{
            flex: '1 1 0', minWidth: 150, background: C.cardBg, border: `1px solid ${C.border}`,
            borderRadius: 12, padding: '13px 15px', boxShadow: C.shadowSm,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <def.Icon size={14} color={C.textMuted} />
              <span style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '.05em' }}>{def.label}</span>
              <Info size={12} color={C.textMuted} style={{ marginLeft: 'auto', opacity: .6 }} />
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, fontFamily: MONO, letterSpacing: '-.02em', color: C.text }}>{display}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── board ─────────────────────────────────────────────────────────────────────

function Board({
  board, isAdmin, dragDealId, dragOverStage, setDragDealId, setDragOverStage,
  onDrop, onAddDeal, onOpenDeal, onEditStage, onDeleteStage, onAddStage,
}) {
  const dealsByStage = (stageId) => board.deals.filter(d => d.stageId === stageId);
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '12px 24px 24px' }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', minHeight: '100%' }}>
        {board.stages.map(stage => {
          const deals = dealsByStage(stage.id);
          const total = deals.reduce((s, d) => s + (Number(d.value) || 0), 0);
          const over = dragOverStage === stage.id;
          return (
            <div key={stage.id} style={{ width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
              {/* column header */}
              <div style={{
                background: C.cardBg, border: `1px solid ${C.border}`, borderTop: `3px solid ${stage.color}`,
                borderRadius: '12px 12px 0 0', padding: '12px 14px 10px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: C.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {stage.name}
                  </span>
                  <span style={{
                    fontSize: 13, fontWeight: 700, color: C.textSecondary, background: C.pageBg,
                    borderRadius: 20, padding: '2px 8px', minWidth: 22, textAlign: 'center',
                  }}>{deals.length}</span>
                  {isAdmin && <StageMenu stage={stage} onEdit={() => onEditStage(stage)} onDelete={() => onDeleteStage(stage)} />}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: C.textMuted, fontFamily: MONO }} title={fullMoney(total)}>
                    {fmtMoney(total)}
                  </span>
                  {(stage.isWon || stage.isLost) && (
                    <span style={{
                      fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em',
                      color: stage.isWon ? C.green : C.primary,
                      background: stage.isWon ? 'rgba(34,197,94,.12)' : C.primaryLight,
                      borderRadius: 4, padding: '1px 5px',
                    }}>{stage.isWon ? 'Won' : 'Lost'}</span>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: C.textMuted, fontWeight: 600 }}>{stage.probability}%</span>
                </div>
              </div>

              {/* column body / drop zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); if (dragOverStage !== stage.id) setDragOverStage(stage.id); }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOverStage(s => s === stage.id ? null : s); }}
                onDrop={() => onDrop(stage.id)}
                style={{
                  flex: 1, background: over ? C.primaryLight : C.surfaceAlt,
                  border: `1px solid ${C.border}`, borderTop: 'none', borderRadius: '0 0 12px 12px',
                  padding: 10, display: 'flex', flexDirection: 'column', gap: 9, minHeight: 140,
                  boxShadow: over ? `inset 0 0 0 2px ${C.primary}` : 'none',
                  transition: 'background .12s',
                }}>
                {deals.length === 0 ? (
                  <div style={{
                    flex: 1, minHeight: 90, border: `1.5px dashed ${over ? C.primary : C.border}`,
                    borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 14, color: C.textMuted, fontWeight: 500,
                  }}>Drop a deal here</div>
                ) : (
                  deals.map(deal => (
                    <DealCard
                      key={deal.id}
                      deal={deal}
                      dragging={dragDealId === deal.id}
                      onDragStart={() => setDragDealId(deal.id)}
                      onDragEnd={() => { setDragDealId(null); setDragOverStage(null); }}
                      onClick={() => onOpenDeal(deal)}
                    />
                  ))
                )}

                <button onClick={() => onAddDeal(stage.id)} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  padding: '8px', borderRadius: 8, border: `1px solid transparent`, background: 'transparent',
                  cursor: 'pointer', fontFamily: FONT, fontSize: 14, fontWeight: 600, color: C.textSecondary,
                }}
                  onMouseEnter={e => { e.currentTarget.style.background = C.cardBg; e.currentTarget.style.borderColor = C.border; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; }}>
                  <Plus size={14} /> Add Deal
                </button>
              </div>
            </div>
          );
        })}

        {/* add stage column */}
        {isAdmin && <button onClick={onAddStage} style={{
          width: 160, flexShrink: 0, marginTop: 0, padding: '14px', borderRadius: 12,
          border: `1.5px dashed ${C.border}`, background: 'transparent', cursor: 'pointer',
          color: C.textSecondary, fontFamily: FONT, fontSize: 14, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = C.primary; e.currentTarget.style.color = C.primary; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.textSecondary; }}>
          <Plus size={15} /> Add Stage
        </button>}
      </div>
    </div>
  );
}

function StageMenu({ stage, onEdit, onDelete }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} style={{
        border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted,
        display: 'flex', alignItems: 'center', padding: 2, borderRadius: 6,
      }} title="Stage options"><MoreVertical size={15} /></button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', right: 0, minWidth: 150, zIndex: 60,
          background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: C.shadowMd, padding: 5,
        }}>
          <MenuItem icon={<Pencil size={13} />} label="Edit stage" onClick={() => { setOpen(false); onEdit(); }} />
          <MenuItem icon={<Trash2 size={13} />} label="Delete stage" danger onClick={() => { setOpen(false); onDelete(); }} />
        </div>
      )}
    </div>
  );
}

function DealCard({ deal, dragging, onDragStart, onDragEnd, onClick }) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      style={{
        background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 11px',
        cursor: 'grab', boxShadow: C.shadowSm, opacity: dragging ? 0.4 : 1,
        display: 'flex', flexDirection: 'column', gap: 7,
      }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = C.shadowMd}
      onMouseLeave={e => e.currentTarget.style.boxShadow = C.shadowSm}>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, lineHeight: 1.3 }}>{deal.title}</div>
      {Number(deal.value) > 0 && (
        <div style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO, color: C.green }} title={fullMoney(deal.value)}>
          {fmtMoney(deal.value)}
        </div>
      )}
      {(deal.contactName || deal.contactNumber) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, color: C.textSecondary, fontWeight: 500 }}>
          <Phone size={11} color={C.textMuted} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {deal.contactName || maskPhone(deal.contactNumber)}
          </span>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 1 }}>
        {deal.expectedCloseDate && (
          <span style={{ fontSize: 12, color: C.textMuted, fontWeight: 600 }}>{fmtDate(deal.expectedCloseDate)}</span>
        )}
        {deal.assignedUserName && (
          <span title={deal.assignedUserName} style={{
            marginLeft: 'auto', width: 22, height: 22, borderRadius: '50%', background: C.purple,
            color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>{initials(deal.assignedUserName)}</span>
        )}
      </div>
    </div>
  );
}

// ── deal modal ──────────────────────────────────────────────────────────────

function DealModal({ mode, isAdmin, stages, stageId, deal, onClose, onSave, onDelete }) {
  const [title, setTitle] = useState(deal?.title || '');
  const [value, setValue] = useState(deal?.value ? String(deal.value) : '');
  const [stage, setStage] = useState(deal?.stageId || stageId || stages[0]?.id);
  const [contact, setContact] = useState(deal ? {
    name: deal.contactName, contactNumber: deal.contactNumber, waNumber: deal.contactWaNumber,
  } : null);
  const [assigneeId, setAssigneeId] = useState(deal?.assignedUserId || '');
  const [closeDate, setCloseDate] = useState(deal?.expectedCloseDate ? String(deal.expectedCloseDate).slice(0, 10) : '');
  const [notes, setNotes] = useState(deal?.notes || '');
  const [assignees, setAssignees] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;   // non-admins can only own their own deals
    api.pipelines.assignees().then(({ users }) => setAssignees(users)).catch(() => {});
  }, [isAdmin]);

  const submit = async () => {
    if (!title.trim()) return;
    setSaving(true);
    const form = {
      stageId: stage,
      title: title.trim(),
      value: value === '' ? 0 : Number(value),
      contactName: contact?.name || null,
      contactNumber: contact?.contactNumber || null,
      contactWaNumber: contact?.waNumber || null,
      assignedUserId: assigneeId || null,
      expectedCloseDate: closeDate || null,
      notes: notes.trim() || null,
    };
    await onSave(form);
    setSaving(false);
  };

  return (
    <ModalShell title={mode === 'create' ? 'Add Deal' : 'Edit Deal'} onClose={onClose} width={460}>
      <Field label="Deal title">
        <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Website redesign — Acme Co" style={inp} />
      </Field>

      <div style={{ display: 'flex', gap: 12 }}>
        <Field label="Value (₹)" style={{ flex: 1 }}>
          <input value={value} onChange={e => setValue(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" placeholder="0" style={{ ...inp, fontFamily: MONO }} />
        </Field>
        <Field label="Stage" style={{ flex: 1 }}>
          <SearchableSelect
            value={stage}
            onChange={v => setStage(Number(v))}
            options={stages.map(s => ({ value: s.id, label: s.name }))}
            placeholder="Select stage…"
            triggerStyle={{ padding: '9px 32px 9px 11px', borderRadius: 9, fontSize: 15 }}
          />
        </Field>
      </div>

      <Field label="Contact">
        <ContactPicker contact={contact} onChange={setContact} />
      </Field>

      <div style={{ display: 'flex', gap: 12 }}>
        {isAdmin && (
          <Field label="Assign to" style={{ flex: 1 }}>
            <SearchableSelect
              value={assigneeId}
              onChange={v => setAssigneeId(v)}
              options={[{ value: '', label: 'Unassigned' }, ...assignees.map(u => ({ value: String(u.id), label: u.name }))]}
              placeholder="Unassigned"
              triggerStyle={{ padding: '9px 32px 9px 11px', borderRadius: 9, fontSize: 15 }}
            />
          </Field>
        )}
        <Field label="Expected close" style={{ flex: 1 }}>
          <input type="date" value={closeDate} onChange={e => setCloseDate(e.target.value)} style={inp} />
        </Field>
      </div>

      <Field label="Notes">
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Optional context for this deal…" style={{ ...inp, resize: 'vertical', minHeight: 64 }} />
      </Field>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        {onDelete && (
          <button onClick={onDelete} style={{ ...btnGhost, color: C.primary, borderColor: C.border }}>
            <Trash2 size={14} /> Delete
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={btnGhost}>Cancel</button>
        <button onClick={submit} disabled={!title.trim() || saving} style={{ ...btnPrimary, opacity: (!title.trim() || saving) ? .6 : 1 }}>
          {saving ? 'Saving…' : mode === 'create' ? 'Add Deal' : 'Save'}
        </button>
      </div>
    </ModalShell>
  );
}

function ContactPicker({ contact, onChange }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [allTags, setAllTags] = useState([]);
  const [selectedTagIds, setSelectedTagIds] = useState([]);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const ref = useRef(null);
  const tagRef = useRef(null);

  useEffect(() => {
    api.tags.list().then(t => setAllTags(Array.isArray(t) ? t : (t.tags || []))).catch(() => {});
  }, []);

  useEffect(() => {
    const onDoc = (e) => {
      if (tagRef.current && !tagRef.current.contains(e.target)) setTagMenuOpen(false);
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      api.pipelines.searchContacts(q, selectedTagIds)
        .then(({ contacts }) => setResults(contacts)).catch(() => setResults([]));
    }, 220);
    return () => clearTimeout(t);
  }, [q, open, selectedTagIds]);

  const toggleTag = (id) =>
    setSelectedTagIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  if (contact && (contact.name || contact.contactNumber)) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 11px', border: `1px solid ${C.border}`, borderRadius: 9, background: C.surfaceAlt }}>
        <span style={{ width: 26, height: 26, borderRadius: '50%', background: C.primary, color: '#fff', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {initials(contact.name || contact.contactNumber)}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contact.name || 'Unnamed'}</div>
          {contact.contactNumber && <div style={{ fontSize: 13, color: C.textMuted, fontFamily: MONO }}>{maskPhone(contact.contactNumber)}</div>}
        </div>
        <button onClick={() => onChange(null)} style={{ ...iconBtn, width: 28, height: 28 }} title="Remove contact"><X size={14} /></button>
      </div>
    );
  }

  const selectedTags = allTags.filter(t => selectedTagIds.includes(t.id));

  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 6px 0 11px', border: `1px solid ${C.border}`, borderRadius: 9, background: C.cardBg }}>
        <Search size={14} color={C.textMuted} />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder="Search saved contacts (optional)"
          style={{ ...inp, border: 'none', padding: '9px 0', background: 'transparent' }}
        />
        {/* tag filter */}
        <div ref={tagRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => { setTagMenuOpen(o => !o); setOpen(true); }}
            title="Filter by tags"
            style={{
              display: 'flex', alignItems: 'center', gap: 5, padding: '5px 9px', borderRadius: 7, cursor: 'pointer',
              fontFamily: FONT, fontSize: 14, fontWeight: 700,
              border: `1px solid ${selectedTagIds.length ? C.primary : C.border}`,
              background: selectedTagIds.length ? C.primaryLight : C.cardBg,
              color: selectedTagIds.length ? C.primary : C.textSecondary,
            }}>
            <Tag size={13} /> Tags{selectedTagIds.length ? ` (${selectedTagIds.length})` : ''}
          </button>
          {tagMenuOpen && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 70, width: 220,
              background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: C.shadowMd,
              padding: 6, maxHeight: 240, overflowY: 'auto',
            }}>
              {allTags.length === 0 ? (
                <div style={{ padding: '10px', fontSize: 14, color: C.textMuted }}>No tags defined</div>
              ) : (
                <>
                  {allTags.map(t => {
                    const on = selectedTagIds.includes(t.id);
                    return (
                      <div key={t.id} onClick={() => toggleTag(t.id)} style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 7, cursor: 'pointer',
                      }}
                        onMouseEnter={e => e.currentTarget.style.background = C.hover}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                        <span style={{
                          width: 15, height: 15, borderRadius: 4, flexShrink: 0,
                          border: `1.5px solid ${on ? C.primary : C.border}`,
                          background: on ? C.primary : 'transparent',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>{on && <Check size={11} color="#fff" />}</span>
                        <span style={{ width: 9, height: 9, borderRadius: '50%', background: t.color || C.textMuted, flexShrink: 0 }} />
                        <span style={{ fontSize: 14, fontWeight: 500, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                      </div>
                    );
                  })}
                  {selectedTagIds.length > 0 && (
                    <div onClick={() => setSelectedTagIds([])} style={{
                      marginTop: 4, padding: '7px 8px', borderTop: `1px solid ${C.border}`,
                      fontSize: 13, fontWeight: 700, color: C.primary, cursor: 'pointer', textAlign: 'center',
                    }}>Clear tags</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* selected tag chips */}
      {selectedTags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {selectedTags.map(t => (
            <span key={t.id} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 7px', borderRadius: 20,
              background: C.surfaceAlt, border: `1px solid ${C.border}`, fontSize: 13, fontWeight: 600, color: C.text,
            }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.color || C.textMuted }} />
              {t.name}
              <X size={11} color={C.textMuted} style={{ cursor: 'pointer' }} onClick={() => toggleTag(t.id)} />
            </span>
          ))}
        </div>
      )}

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 60,
          background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: C.shadowMd,
          maxHeight: 240, overflowY: 'auto', padding: 5,
        }}>
          {results.length === 0 ? (
            <div style={{ padding: '12px 10px', fontSize: 14, color: C.textMuted }}>
              {selectedTagIds.length ? 'No contacts match these tags' : 'No matching contacts'}
            </div>
          ) : results.map((c, i) => (
            <div key={i} onClick={() => { onChange(c); setOpen(false); setQ(''); }} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px', borderRadius: 8, cursor: 'pointer',
            }}
              onMouseEnter={e => e.currentTarget.style.background = C.hover}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <span style={{ width: 24, height: 24, borderRadius: '50%', background: C.purple, color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {initials(c.name || c.contactNumber)}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || 'Unnamed'}</div>
                <div style={{ fontSize: 13, color: C.textMuted, fontFamily: MONO }}>{maskPhone(c.contactNumber)}</div>
              </div>
              {Array.isArray(c.tags) && c.tags.length > 0 && (
                <div style={{ display: 'flex', gap: 3, flexShrink: 0, maxWidth: 110, overflow: 'hidden' }}>
                  {c.tags.slice(0, 3).map((t, j) => (
                    <span key={j} title={t.name} style={{ width: 9, height: 9, borderRadius: '50%', background: t.color || C.textMuted }} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── pipeline modal ──────────────────────────────────────────────────────────

function PipelineModal({ mode, initialName, onClose, onSave }) {
  const [name, setName] = useState(initialName || '');
  const [saving, setSaving] = useState(false);
  const submit = async () => { if (!name.trim()) return; setSaving(true); await onSave(name.trim()); setSaving(false); };
  return (
    <ModalShell title={mode === 'create' ? 'New Pipeline' : 'Rename Pipeline'} onClose={onClose} width={380}>
      <Field label="Pipeline name">
        <input autoFocus value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          placeholder="e.g. Sales Pipeline" style={inp} />
      </Field>
      {mode === 'create' && (
        <div style={{ fontSize: 13, color: C.textMuted, marginTop: -4, marginBottom: 4 }}>
          Starts with default stages: New Lead, Qualified, Proposal Sent, Negotiation, Won, Lost. You can edit them anytime.
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
        <button onClick={onClose} style={btnGhost}>Cancel</button>
        <button onClick={submit} disabled={!name.trim() || saving} style={{ ...btnPrimary, opacity: (!name.trim() || saving) ? .6 : 1 }}>
          {saving ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
        </button>
      </div>
    </ModalShell>
  );
}

// ── stage modal ───────────────────────────────────────────────────────────────

function StageModal({ mode, stage, onClose, onSave }) {
  const [name, setName] = useState(stage?.name || '');
  const [color, setColor] = useState(stage?.color || STAGE_COLORS[0]);
  const [probability, setProbability] = useState(stage ? stage.probability : 50);
  const [outcome, setOutcome] = useState(stage?.isWon ? 'won' : stage?.isLost ? 'lost' : 'open');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    await onSave({
      name: name.trim(), color, probability: Number(probability),
      isWon: outcome === 'won', isLost: outcome === 'lost',
    });
    setSaving(false);
  };

  return (
    <ModalShell title={mode === 'create' ? 'Add Stage' : 'Edit Stage'} onClose={onClose} width={400}>
      <Field label="Stage name">
        <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Demo Booked" style={inp} />
      </Field>
      <Field label="Color">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {STAGE_COLORS.map(c => (
            <button key={c} onClick={() => setColor(c)} style={{
              width: 28, height: 28, borderRadius: 8, background: c, cursor: 'pointer',
              border: color === c ? `2px solid ${C.text}` : `2px solid transparent`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{color === c && <Check size={14} color="#fff" />}</button>
          ))}
        </div>
      </Field>
      <Field label={`Win probability — ${probability}%`}>
        <input type="range" min={0} max={100} step={5} value={probability}
          onChange={e => setProbability(e.target.value)} style={{ width: '100%', accentColor: C.primary }} />
        <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>Used to compute the Weighted Value KPI.</div>
      </Field>
      <Field label="Outcome">
        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { k: 'open', label: 'In progress' },
            { k: 'won', label: 'Won' },
            { k: 'lost', label: 'Lost' },
          ].map(o => (
            <button key={o.k} onClick={() => setOutcome(o.k)} style={{
              flex: 1, padding: '8px', borderRadius: 8, cursor: 'pointer', fontFamily: FONT, fontSize: 14, fontWeight: 700,
              border: `1px solid ${outcome === o.k ? C.primary : C.border}`,
              background: outcome === o.k ? C.primaryLight : C.cardBg,
              color: outcome === o.k ? C.primary : C.textSecondary,
            }}>{o.label}</button>
          ))}
        </div>
        <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>
          Deals landing in a Won/Lost stage are marked accordingly and feed the monthly KPIs.
        </div>
      </Field>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
        <button onClick={onClose} style={btnGhost}>Cancel</button>
        <button onClick={submit} disabled={!name.trim() || saving} style={{ ...btnPrimary, opacity: (!name.trim() || saving) ? .6 : 1 }}>
          {saving ? 'Saving…' : mode === 'create' ? 'Add Stage' : 'Save'}
        </button>
      </div>
    </ModalShell>
  );
}

// ── shared bits ────────────────────────────────────────────────────────────────

function ModalShell({ title, onClose, width = 420, children }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, fontFamily: FONT, padding: 16 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: C.cardBg, borderRadius: 16, width, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: C.shadowLg }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '16px 20px', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.text }}>{title}</div>
          <button onClick={onClose} style={{ ...iconBtn, marginLeft: 'auto', width: 32, height: 32 }}><X size={16} /></button>
        </div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children, style }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...style }}>
      <label style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</label>
      {children}
    </div>
  );
}

function EmptyPipelines({ isAdmin, onCreate }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, color: C.textMuted }}>
      <Kanban size={52} color={C.border} strokeWidth={1.5} />
      <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>No pipelines yet</div>
      <div style={{ fontSize: 15, maxWidth: 320, textAlign: 'center', lineHeight: 1.5 }}>
        {isAdmin
          ? 'Create your first pipeline to start tracking deals across stages.'
          : 'No pipelines have been set up yet. Ask an admin to create one.'}
      </div>
      {isAdmin && <button onClick={onCreate} style={{ ...btnPrimary, marginTop: 4 }}><Plus size={15} /> Add Pipeline</button>}
    </div>
  );
}

function BoardSkeleton() {
  const shimmer = { background: 'linear-gradient(90deg,var(--c-divider, #f0f0ea) 25%,var(--c-xe8e8e2, #e8e8e2) 50%,var(--c-divider, #f0f0ea) 75%)', backgroundSize: '200% 100%', animation: 'pl-shimmer 1.3s linear infinite', borderRadius: 8 };
  return (
    <div style={{ padding: 24 }}>
      <style>{`@keyframes pl-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
      <div style={{ display: 'flex', gap: 12, marginBottom: 18 }}>
        {Array.from({ length: 6 }).map((_, i) => <div key={i} style={{ ...shimmer, flex: 1, height: 74 }} />)}
      </div>
      <div style={{ display: 'flex', gap: 14 }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} style={{ width: 280 }}>
            <div style={{ ...shimmer, height: 56, marginBottom: 8, borderRadius: '12px 12px 0 0' }} />
            <div style={{ ...shimmer, height: 200, borderRadius: '0 0 12px 12px' }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Toast({ toast }) {
  const bg = toast.type === 'error' ? C.primary : C.green;
  return (
    <div style={{
      position: 'fixed', bottom: 22, right: 22, zIndex: 400, background: bg, color: '#fff',
      padding: '11px 16px', borderRadius: 10, fontFamily: FONT, fontSize: 15, fontWeight: 600,
      boxShadow: C.shadowLg, maxWidth: 320,
    }}>{toast.msg}</div>
  );
}

// ── style atoms ─────────────────────────────────────────────────────────────

const inp = {
  width: '100%', padding: '9px 11px', borderRadius: 9, border: `1px solid ${C.border}`,
  fontFamily: FONT, fontSize: 15, color: C.text, background: C.cardBg, outline: 'none',
};
const btnPrimary = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 15px', borderRadius: 10,
  border: 'none', background: C.primary, color: '#fff', cursor: 'pointer',
  fontFamily: FONT, fontSize: 15, fontWeight: 700,
};
const btnGhost = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 10,
  border: `1px solid ${C.border}`, background: C.cardBg, color: C.text, cursor: 'pointer',
  fontFamily: FONT, fontSize: 15, fontWeight: 600,
};
const iconBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9,
  border: `1px solid ${C.border}`, background: C.cardBg, color: C.textSecondary, cursor: 'pointer',
};
