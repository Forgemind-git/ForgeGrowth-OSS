import { useState, useEffect, useMemo, useRef } from 'react';
import { notify } from '../lib/feedback.js';
import { Plus, Pencil, Trash2, Loader2, Search, Bot, X, Copy, Folder, FolderPlus, FolderInput, ChevronRight, ArrowLeft, Check, GripVertical, Upload } from 'lucide-react';
import DeleteConfirmModal from '../components/DeleteConfirmModal.jsx';
import AutomationBuilderView from '../components/AutomationBuilderView.jsx';
import AutomationExecutions from '../components/AutomationExecutions.jsx';
import { useTableSelection, SelectAllCheckbox, RowCheckbox, BulkDeleteButton, runBulkDelete } from '../components/TableSelection.jsx';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';

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
  red: '#A32D2D',
  redBg: '#FCEBEB',
  orange: '#E65100',
  orangeBg: '#FFF3E0',
};

const STATUS_STYLES = {
  active:   { color: B.green, bg: B.greenBg, dot: B.greenBright, label: 'Active' },
  inactive: { color: B.t6, bg: '#EEEDE8', dot: '#aaa', label: 'Inactive' },
  draft:    { color: B.orange, bg: B.orangeBg, dot: B.orange, label: 'Draft' },
};

function StatusBadge({ status }) {
  const st = STATUS_STYLES[status] || STATUS_STYLES.draft;
  return (
    <span style={{ padding: '4px 10px', borderRadius: 99, fontSize: 11, fontWeight: 700, background: st.bg, color: st.color, display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: FONT, whiteSpace: 'nowrap' }}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: st.dot, display: 'inline-block' }} />
      {st.label}
    </span>
  );
}

const iconBtnStyle = { width: 28, height: 28, borderRadius: 6, border: '1.5px solid #D5D5D0', background: 'var(--c-cardBg)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: B.t4, flexShrink: 0 };

const primaryBtnStyle = { padding: '10px 18px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: FONT, display: 'flex', alignItems: 'center', gap: 6, transition: 'background .15s' };

// ─── New Automation modal ───────────────────────────────────────────────────
function NewAutomationModal({ open, onClose, onCreate, folderId, folderName }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open) { setName(''); setDescription(''); setCreating(false); }
  }, [open, folderId]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (!name.trim()) { notify('Name is required'); return; }
    setCreating(true);
    try {
      const data = await api.chatbots.create({
        name: name.trim(),
        description: description || null,
        status: 'draft',
        trigger_type: 'keyword',
        config: { nodes: [], edges: [] },
        folder_id: folderId || null,
      });
      onCreate(data);
    } catch (err) {
      notify(err.message || 'Create failed');
    } finally {
      setCreating(false);
    }
  };

  const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' };
  const modalStyle = { background: 'var(--c-cardBg)', borderRadius: 14, padding: '24px 28px', width: 440, maxWidth: '90vw', boxShadow: '0 20px 60px rgba(0,0,0,0.18)' };
  const inpStyle = { border: '1.5px solid #D5D5D0', borderRadius: 10, padding: '9px 14px', fontSize: 13, fontFamily: FONT, width: '100%', background: 'var(--c-cardBg)', color: 'var(--c-text)', outline: 'none' };
  const btnPriStyle = { padding: '10px 22px', background: B.accent, color: '#fff', border: 'none', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: FONT };
  const btnGhostStyle = { padding: '10px 22px', background: 'var(--c-cardBg)', border: '1.5px solid #D5D5D0', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FONT, color: '#444' };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: B.t1, margin: 0, fontFamily: FONT }}>New Automation</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: B.t5 }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: B.t5, marginBottom: 16, fontFamily: FONT }}>
          Name your automation and add a short description.
          {folderName && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 6, color: B.accentDark, fontWeight: 700 }}>
              <Folder size={12} /> in “{folderName}”
            </span>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: B.t3, display: 'block', marginBottom: 5, fontFamily: FONT }}>Name <span style={{ color: B.red }}>*</span></label>
            <input style={inpStyle} placeholder="e.g. Welcome Bot" value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: B.t3, display: 'block', marginBottom: 5, fontFamily: FONT }}>Description</label>
            <textarea style={{ ...inpStyle, resize: 'vertical', lineHeight: 1.5 }} rows={3} placeholder="What does this automation do?" value={description} onChange={e => setDescription(e.target.value)} />
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button onClick={onClose} style={btnGhostStyle}>Cancel</button>
          <button onClick={handleSubmit} disabled={creating} style={btnPriStyle}>
            {creating ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : 'Next →'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Folder create / rename modal ───────────────────────────────────────────
function FolderModal({ open, mode, initialName, onClose, onSubmit }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) { setName(initialName || ''); setBusy(false); }
  }, [open, initialName]);

  if (!open) return null;

  const submit = async () => {
    if (!name.trim()) { notify('Folder name is required'); return; }
    setBusy(true);
    try {
      await onSubmit(name.trim());
    } catch (err) {
      notify(err.message || 'Failed'); setBusy(false); return;
    }
    setBusy(false);
  };

  const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' };
  const modalStyle = { background: 'var(--c-cardBg)', borderRadius: 14, padding: '24px 28px', width: 400, maxWidth: '90vw', boxShadow: '0 20px 60px rgba(0,0,0,0.18)' };
  const inpStyle = { border: '1.5px solid #D5D5D0', borderRadius: 10, padding: '9px 14px', fontSize: 13, fontFamily: FONT, width: '100%', background: 'var(--c-cardBg)', color: 'var(--c-text)', outline: 'none' };
  const btnPriStyle = { padding: '10px 22px', background: B.accent, color: '#fff', border: 'none', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: FONT };
  const btnGhostStyle = { padding: '10px 22px', background: 'var(--c-cardBg)', border: '1.5px solid #D5D5D0', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FONT, color: '#444' };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: B.t1, margin: 0, fontFamily: FONT }}>{mode === 'rename' ? 'Rename Folder' : 'New Folder'}</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: B.t5 }}><X size={18} /></button>
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: B.t3, display: 'block', marginBottom: 5, fontFamily: FONT }}>Folder name <span style={{ color: B.red }}>*</span></label>
          <input style={inpStyle} placeholder="e.g. Onboarding flows" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }} autoFocus />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button onClick={onClose} style={btnGhostStyle}>Cancel</button>
          <button onClick={submit} disabled={busy} style={btnPriStyle}>
            {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : (mode === 'rename' ? 'Save' : 'Create')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Move-to-folder dropdown (per automation row) ───────────────────────────
// position:fixed so it escapes the table wrapper's overflow:hidden (which would
// otherwise clip it on the last rows); flips upward near the viewport bottom.
function MoveMenu({ folders, currentFolderId, onPick }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);

  const toggle = (e) => {
    e.stopPropagation();
    if (open) { setOpen(false); return; }
    const r = btnRef.current.getBoundingClientRect();
    const menuW = 210;
    const estH = Math.min(308, 56 + (folders.length + 1) * 34);
    const spaceBelow = window.innerHeight - r.bottom;
    const top = spaceBelow < estH + 14 ? Math.max(8, r.top - estH - 6) : r.bottom + 6;
    const left = Math.max(8, Math.min(r.right - menuW, window.innerWidth - menuW - 8));
    setPos({ top, left, width: menuW, maxHeight: estH });
    setOpen(true);
  };

  const itemStyle = (active) => ({
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
    padding: '7px 9px', border: 'none', borderRadius: 7, background: 'transparent',
    cursor: active ? 'default' : 'pointer', fontSize: 12.5, fontFamily: FONT,
    color: active ? B.t6 : B.t2, fontWeight: active ? 700 : 500,
  });

  return (
    <div style={{ display: 'inline-block' }}>
      <button ref={btnRef} title="Move to folder" onClick={toggle} style={iconBtnStyle}>
        <FolderInput size={13} />
      </button>
      {open && pos && (
        <>
          <div onClick={(e) => { e.stopPropagation(); setOpen(false); }} style={{ position: 'fixed', inset: 0, zIndex: 250 }} />
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 251, background: 'var(--c-cardBg)', border: `1px solid ${B.cardBorder}`, borderRadius: 10, boxShadow: C.shadowLg, padding: 6, maxHeight: pos.maxHeight, overflowY: 'auto' }}
          >
            <div style={{ fontSize: 10, fontWeight: 700, color: B.t6, textTransform: 'uppercase', letterSpacing: '.06em', padding: '6px 9px' }}>Move to</div>
            <button
              style={itemStyle(currentFolderId == null)}
              disabled={currentFolderId == null}
              onClick={() => { onPick(null); setOpen(false); }}
              onMouseEnter={e => { if (currentFolderId != null) e.currentTarget.style.background = B.innerBg; }}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <X size={13} color={B.t5} /> <span style={{ flex: 1 }}>No folder (root)</span>
              {currentFolderId == null && <Check size={13} color={B.accent} />}
            </button>
            {folders.map(f => {
              const active = String(f.id) === String(currentFolderId);
              return (
                <button
                  key={f.id}
                  style={itemStyle(active)}
                  disabled={active}
                  onClick={() => { onPick(f.id); setOpen(false); }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.background = B.innerBg; }}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <Folder size={13} color={B.t5} /> <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  {active && <Check size={13} color={B.accent} />}
                </button>
              );
            })}
            {folders.length === 0 && <div style={{ fontSize: 11, color: B.t6, padding: '6px 9px' }}>No folders yet</div>}
          </div>
        </>
      )}
    </div>
  );
}

const TH = ['Name', 'Description', 'Status', 'Trigger', 'Created', 'Actions'];

// ─── Browser (root list + inside-a-folder view) ─────────────────────────────
function AutomationsBrowser({
  chatbots, folders, loading, currentFolderId,
  onAdd, onEdit, onDelete, onDuplicate, onBulkDelete, onMove,
  onCreateFolder, onRenameFolder, onDeleteFolder, onOpenFolder, onExitFolder, onImport,
}) {
  const [search, setSearch] = useState('');
  const importRef = useRef(null);
  const [deleteModal, setDeleteModal] = useState({ open: false, chatbot: null });
  const [folderModal, setFolderModal] = useState({ open: false, mode: 'create', folder: null });
  const [dragId, setDragId] = useState(null);
  const [dropKey, setDropKey] = useState(null); // folder id (string) being hovered as a drop target

  const inFolder = currentFolderId != null;
  const currentFolder = inFolder ? folders.find(f => String(f.id) === String(currentFolderId)) : null;

  // Reset search when entering/leaving a folder.
  useEffect(() => { setSearch(''); }, [currentFolderId]);

  const q = search.trim().toLowerCase();
  const matchesAuto = (c) => !q
    || c.name.toLowerCase().includes(q)
    || (c.description || '').toLowerCase().includes(q)
    || c.status.toLowerCase().includes(q);

  // Automations in scope: inside a folder → that folder's; at root → ungrouped only.
  const scopeAutos = useMemo(() => (
    inFolder
      ? chatbots.filter(c => String(c.folder_id ?? '') === String(currentFolderId))
      : chatbots.filter(c => c.folder_id == null)
  ), [chatbots, inFolder, currentFolderId]);

  const filteredAutos = useMemo(() => scopeAutos.filter(matchesAuto), [scopeAutos, q]);
  const sel = useTableSelection(filteredAutos);

  // Folder rows only appear at root, and live in the same table as automations.
  const folderRows = inFolder ? [] : folders.filter(f => !q || f.name.toLowerCase().includes(q));
  const folderTotal = (fid) => chatbots.filter(c => String(c.folder_id ?? '') === String(fid)).length;

  const handleDeleteFolderClick = (folder) => {
    const n = folderTotal(folder.id);
    if (n > 0) {
      notify(`“${folder.name}” still has ${n} automation${n === 1 ? '' : 's'}. Move or delete ${n === 1 ? 'it' : 'them'} first.`);
      return;
    }
    onDeleteFolder(folder);
  };

  // ── Folder row (root only) — clickable to enter, drop target for moves ──
  const renderFolderRow = (f) => {
    const hot = dropKey === String(f.id) && dragId != null;
    const n = folderTotal(f.id);
    return (
      <tr
        key={`f-${f.id}`}
        onClick={() => onOpenFolder(f.id)}
        onDragOver={(e) => { if (dragId != null) { e.preventDefault(); setDropKey(String(f.id)); } }}
        onDrop={(e) => { e.preventDefault(); if (dragId != null) onMove(dragId, f.id); setDropKey(null); setDragId(null); }}
        style={{ borderBottom: `1px solid ${B.rowSep}`, cursor: 'pointer', background: hot ? B.accentBg : 'transparent', boxShadow: hot ? `inset 0 0 0 2px ${B.accent}` : 'none' }}
        onMouseEnter={(e) => { if (!hot) e.currentTarget.style.background = B.innerBg; }}
        onMouseLeave={(e) => { if (!hot) e.currentTarget.style.background = 'transparent'; }}
      >
        <td style={{ padding: '12px 14px', width: 36 }} />
        <td style={{ padding: '12px 14px', fontSize: 13, fontWeight: 700, color: B.t1, fontFamily: FONT }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
            <Folder size={17} color={B.accent} style={{ flexShrink: 0 }} />
            {f.name}
          </span>
        </td>
        <td style={{ padding: '12px 14px', fontSize: 12, color: B.t5, fontFamily: FONT }}>{n} automation{n === 1 ? '' : 's'}</td>
        <td style={{ padding: '12px 14px', fontSize: 11, color: B.t6, fontFamily: FONT }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: B.t5, background: B.innerBg, border: `1px solid ${B.innerBorder}`, borderRadius: 99, padding: '3px 9px', textTransform: 'uppercase', letterSpacing: '.05em' }}>Folder</span>
        </td>
        <td style={{ padding: '12px 14px', fontSize: 12, color: B.t6, fontFamily: FONT }}>—</td>
        <td style={{ padding: '12px 14px', fontSize: 11, color: B.t6, fontFamily: FONT, whiteSpace: 'nowrap' }}>{new Date(f.created_at).toLocaleDateString()}</td>
        <td style={{ padding: '12px 14px' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button onClick={(e) => { e.stopPropagation(); setFolderModal({ open: true, mode: 'rename', folder: f }); }} title="Rename folder" style={iconBtnStyle}><Pencil size={13} /></button>
            <button onClick={(e) => { e.stopPropagation(); handleDeleteFolderClick(f); }} title="Delete folder" style={{ ...iconBtnStyle, color: B.red }}><Trash2 size={13} /></button>
            <ChevronRight size={16} color={B.t7} />
          </div>
        </td>
      </tr>
    );
  };

  // ── Automation row ──
  const renderAutoRow = (c) => {
    // Rows are draggable only at root (where folder rows exist as drop targets).
    const dragProps = !inFolder && folders.length > 0 ? {
      draggable: true,
      onDragStart: (e) => {
        setDragId(c.id);
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(c.id)); } catch (_) {}
        try {
          const ghost = document.createElement('div');
          ghost.textContent = c.name;
          ghost.style.cssText = `position:fixed;top:-1000px;left:-1000px;padding:8px 14px;background:${C.primary};color:#fff;font:600 13px ${FONT};border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.22);white-space:nowrap;pointer-events:none;`;
          document.body.appendChild(ghost);
          e.dataTransfer.setDragImage(ghost, 14, 18);
          setTimeout(() => { try { document.body.removeChild(ghost); } catch (_) {} }, 0);
        } catch (_) {}
      },
      onDragEnd: () => { setDragId(null); setDropKey(null); },
    } : {};

    const canDrag = !inFolder && folders.length > 0;
    return (
      <tr
        key={c.id}
        {...dragProps}
        style={{ borderBottom: `1px solid ${B.rowSep}`, background: sel.isSelected(c.id) ? '#FDF6F6' : 'transparent', opacity: dragId === c.id ? 0.4 : 1, cursor: canDrag ? 'grab' : 'default' }}
      >
        <td style={{ padding: '12px 14px', width: 36 }}><RowCheckbox sel={sel} id={c.id} label={c.name} /></td>
        <td style={{ padding: '12px 14px', fontSize: 13, fontWeight: 600, color: B.t2, fontFamily: FONT }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            {canDrag && <GripVertical size={13} color="#C8C8C0" style={{ flexShrink: 0 }} />}
            {c.name}
          </span>
        </td>
        <td style={{ padding: '12px 14px', fontSize: 12, color: B.t4, fontFamily: FONT, maxWidth: 300 }}>
          <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.description || '—'}</span>
        </td>
        <td style={{ padding: '12px 14px' }}><StatusBadge status={c.status} /></td>
        <td style={{ padding: '12px 14px', fontSize: 12, color: B.t4, fontFamily: FONT, textTransform: 'capitalize' }}>{c.trigger_type}</td>
        <td style={{ padding: '12px 14px', fontSize: 11, color: B.t6, fontFamily: FONT, whiteSpace: 'nowrap' }}>{new Date(c.created_at).toLocaleDateString()}</td>
        <td style={{ padding: '12px 14px' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => onEdit(c)} title="Edit" style={iconBtnStyle}><Pencil size={13} /></button>
            <button onClick={() => onDuplicate(c)} title="Duplicate (creates a disabled copy)" style={iconBtnStyle}><Copy size={13} /></button>
            <MoveMenu folders={folders} currentFolderId={c.folder_id ?? null} onPick={(fid) => onMove(c.id, fid)} />
            <button onClick={() => setDeleteModal({ open: true, chatbot: c })} title="Delete" style={{ ...iconBtnStyle, color: B.red }}><Trash2 size={13} /></button>
          </div>
        </td>
      </tr>
    );
  };

  const tableShell = (children) => (
    <div style={{ background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT }}>
        <thead>
          <tr style={{ background: B.innerBg, borderBottom: `1px solid ${B.cardBorder}` }}>
            <th style={{ padding: '10px 14px', width: 36 }} />
            {TH.map(h => (
              <th key={h} style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: B.t4, textAlign: 'left', textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );

  const totalRows = folderRows.length + filteredAutos.length;

  return (
    <div style={{ padding: 24, fontFamily: FONT }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          {inFolder ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={onExitFolder} title="Back to Automations" style={{ ...iconBtnStyle, width: 30, height: 30 }}><ArrowLeft size={16} /></button>
                <div style={{ fontSize: 12.5, color: B.t5, fontFamily: FONT, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button onClick={onExitFolder} style={{ background: 'none', border: 'none', padding: 0, color: B.t5, cursor: 'pointer', fontFamily: FONT, fontSize: 12.5, fontWeight: 600 }}>Automations</button>
                  <ChevronRight size={13} />
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: B.accentDark, fontWeight: 700 }}><Folder size={13} /> {currentFolder?.name || 'Folder'}</span>
                </div>
              </div>
              <h1 style={{ fontSize: 22, fontWeight: 700, color: B.t1, margin: '8px 0 0', letterSpacing: '-.02em' }}>{currentFolder?.name || 'Folder'}</h1>
            </>
          ) : (
            <>
              <h1 style={{ fontSize: 22, fontWeight: 700, color: B.t1, margin: 0, letterSpacing: '-.02em' }}>Automations</h1>
              <p style={{ fontSize: 12, color: B.t5, margin: '4px 0 0' }}>Build, organize, and manage automated conversation flows.</p>
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {!inFolder && onImport && (
            <>
              <input ref={importRef} type="file" accept="application/json,.json"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onImport(f); }}
                style={{ display: 'none' }} />
              <button
                onClick={() => importRef.current?.click()}
                title="Import an automation from a .json export file"
                style={{ padding: '10px 16px', background: 'var(--c-cardBg)', color: B.t2, border: '1.5px solid #D5D5D0', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: FONT, display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <Upload size={16} /> Import
              </button>
            </>
          )}
          {!inFolder && (
            <button
              onClick={() => setFolderModal({ open: true, mode: 'create', folder: null })}
              style={{ padding: '10px 16px', background: 'var(--c-cardBg)', color: B.t2, border: '1.5px solid #D5D5D0', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: FONT, display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <FolderPlus size={16} /> New Folder
            </button>
          )}
          <button
            onClick={() => onAdd(currentFolderId)}
            style={primaryBtnStyle}
            onMouseEnter={e => e.currentTarget.style.background = C.primaryHover}
            onMouseLeave={e => e.currentTarget.style.background = C.primary}
          >
            <Plus size={16} /> New Automation
          </button>
        </div>
      </div>

      {/* Search + selection + bulk-delete */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 1 360px', minWidth: 220 }}>
          <Search size={16} color={B.t6} />
          <input
            style={{ flex: 1, border: '1.5px solid #D5D5D0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: FONT, background: 'var(--c-cardBg)', color: 'var(--c-text)', outline: 'none' }}
            placeholder={inFolder ? 'Search in this folder...' : 'Search automations...'}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        {filteredAutos.length > 0 && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: B.t4, fontFamily: FONT, cursor: 'pointer', userSelect: 'none' }}>
            <SelectAllCheckbox sel={sel} /> Select all
          </label>
        )}
        <BulkDeleteButton sel={sel} label="automation" onConfirm={(ids) => onBulkDelete(ids)} />
      </div>

      {/* Content */}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 60, gap: 8 }}>
          <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> <span style={{ fontSize: 13, color: B.t5, fontFamily: FONT }}>Loading...</span>
        </div>
      ) : inFolder && !currentFolder ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12 }}>
          <Folder size={40} color="#ccc" style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 15, fontWeight: 600, color: B.t3, marginBottom: 12, fontFamily: FONT }}>This folder no longer exists</div>
          <button onClick={onExitFolder} style={primaryBtnStyle}><ArrowLeft size={15} /> Back to Automations</button>
        </div>
      ) : totalRows === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12 }}>
          <Bot size={40} color="#ccc" style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 15, fontWeight: 600, color: B.t3, marginBottom: 4, fontFamily: FONT }}>
            {q ? 'No matches' : (inFolder ? 'No automations in this folder yet' : 'No automations yet')}
          </div>
          <div style={{ fontSize: 12, color: B.t6, marginBottom: 16, fontFamily: FONT }}>
            {q ? 'Try a different search term.' : (inFolder ? 'Create one here, or move existing automations into this folder.' : 'Create your first automation, or a folder to organize them.')}
          </div>
          {!q && (
            <button onClick={() => onAdd(currentFolderId)} style={{ ...primaryBtnStyle, display: 'inline-flex' }}>
              <Plus size={16} /> New Automation
            </button>
          )}
        </div>
      ) : (
        tableShell(
          <>
            {folderRows.map(renderFolderRow)}
            {filteredAutos.map(renderAutoRow)}
          </>
        )
      )}

      <DeleteConfirmModal
        open={deleteModal.open}
        title="Delete Automation"
        message={`Are you sure you want to delete "${deleteModal.chatbot?.name}"? This cannot be undone.`}
        onConfirm={() => { onDelete(deleteModal.chatbot?.id); setDeleteModal({ open: false, chatbot: null }); }}
        onCancel={() => setDeleteModal({ open: false, chatbot: null })}
      />

      <FolderModal
        open={folderModal.open}
        mode={folderModal.mode}
        initialName={folderModal.folder?.name || ''}
        onClose={() => setFolderModal({ open: false, mode: 'create', folder: null })}
        onSubmit={async (name) => {
          if (folderModal.mode === 'rename') await onRenameFolder(folderModal.folder.id, name);
          else await onCreateFolder(name);
          setFolderModal({ open: false, mode: 'create', folder: null });
        }}
      />
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function ChatbotBuilderPage({ subParts = [], navigate }) {
  const [chatbots, setChatbots] = useState([]);
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingChatbot, setEditingChatbot] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [addTarget, setAddTarget] = useState({ folderId: null, folderName: null });
  const [builderTab, setBuilderTab] = useState('editor'); // 'editor' | 'executions'

  // Routing: #/chatbot-builder            → list
  //          #/chatbot-builder/folder/ID  → inside a folder
  //          #/chatbot-builder/ID         → builder (chatbot id)
  //          #/chatbot-builder/ID/executions/EXEC → builder, executions deep-link
  const isFolderRoute = subParts[0] === 'folder';
  const routeFolderId = isFolderRoute ? (subParts[1] || null) : null;
  const routeId = !isFolderRoute ? (subParts[0] || null) : null;
  const routeTab = subParts[1] === 'executions' ? 'executions' : null;
  const routeExecutionId = routeTab === 'executions' ? (subParts[2] || null) : null;
  const view = isFolderRoute ? 'folder' : (routeId ? 'builder' : 'list');

  const loadData = async () => {
    setLoading(true);
    try {
      const [bots, fols] = await Promise.all([
        api.chatbots.list(),
        api.automationFolders.list().catch(() => []),
      ]);
      setChatbots(bots);
      setFolders(fols);
    } catch (err) {
      console.error('Failed to load automations:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Honour deep-link to executions tab from elsewhere in the app.
  useEffect(() => {
    if (routeTab === 'executions') setBuilderTab('executions');
  }, [routeTab, routeId]);

  // Hydrate editingChatbot from hash on direct reload
  useEffect(() => {
    if (view !== 'builder') {
      setEditingChatbot(null);
      return;
    }
    if (editingChatbot?.id === routeId) return;
    const found = chatbots.find(c => String(c.id) === String(routeId));
    if (found) {
      setEditingChatbot(found);
    } else if (chatbots.length > 0) {
      api.chatbots.get(routeId)
        .then(data => setEditingChatbot(data))
        .catch(() => navigate && navigate('chatbot-builder'));
    }
  }, [routeId, view, chatbots]);

  const handleAdd = (folderId = null) => {
    const folder = folderId != null ? folders.find(f => String(f.id) === String(folderId)) : null;
    setAddTarget({ folderId: folderId ?? null, folderName: folder?.name || null });
    setShowModal(true);
  };

  const handleModalCreate = (newAutomation) => {
    setShowModal(false);
    setChatbots(prev => [newAutomation, ...prev]);
    setEditingChatbot(newAutomation);
    navigate && navigate('chatbot-builder', newAutomation.id);
  };

  const handleEdit = (chatbot) => {
    setEditingChatbot(chatbot);
    setBuilderTab('editor');
    navigate && navigate('chatbot-builder', chatbot.id);
  };

  const handleDelete = async (id) => {
    try {
      await api.chatbots.delete(id);
      setChatbots(prev => prev.filter(c => c.id !== id));
    } catch (err) {
      notify(err.message || 'Delete failed');
    }
  };

  const handleDuplicate = async (chatbot) => {
    try {
      const copy = await api.chatbots.duplicate(chatbot.id);
      setChatbots(prev => [copy, ...prev]); // disabled copy, lands in the same folder
    } catch (err) {
      notify(err.message || 'Duplicate failed');
    }
  };

  // Import an automation from a .json export file. Lands disabled at the root;
  // opens it in the builder so the user can review references and enable it.
  const handleImport = async (file) => {
    try {
      const payload = JSON.parse(await file.text());
      const created = await api.chatbots.import(payload);
      setChatbots(prev => [created, ...prev]);
      notify('Automation imported (disabled) — review it, then enable.');
      if (navigate) navigate('chatbot-builder', created.id);
    } catch (err) {
      notify(err instanceof SyntaxError ? 'That file is not valid JSON.' : (err.message || 'Import failed'));
    }
  };

  const handleBulkDelete = async (ids) => {
    await runBulkDelete(ids, (id) => api.chatbots.delete(id), {
      label: 'automation',
      onSuccess: (deletedIds) => {
        const set = new Set(deletedIds);
        setChatbots(prev => prev.filter(c => !set.has(c.id)));
      },
    });
  };

  // Move an automation to a folder (or null = root). Optimistic with revert.
  const handleMove = async (id, folderId) => {
    const target = folderId == null ? null : String(folderId);
    let prevFolderId;
    setChatbots(prev => prev.map(c => {
      if (String(c.id) === String(id)) { prevFolderId = c.folder_id ?? null; return { ...c, folder_id: target }; }
      return c;
    }));
    if (prevFolderId === target) return; // no-op
    try {
      await api.chatbots.move(id, target);
    } catch (err) {
      setChatbots(prev => prev.map(c => String(c.id) === String(id) ? { ...c, folder_id: prevFolderId } : c));
      notify(err.message || 'Failed to move automation');
    }
  };

  const handleCreateFolder = async (name) => {
    const folder = await api.automationFolders.create(name);
    setFolders(prev => [...prev, folder].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())));
  };

  const handleRenameFolder = async (id, name) => {
    const updated = await api.automationFolders.update(id, name);
    setFolders(prev => prev.map(f => String(f.id) === String(id) ? { ...f, name: updated.name } : f)
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())));
  };

  const handleDeleteFolder = async (folder) => {
    try {
      await api.automationFolders.delete(folder.id);
      setFolders(prev => prev.filter(f => String(f.id) !== String(folder.id)));
    } catch (err) {
      notify(err.message || 'Failed to delete folder');
    }
  };

  const handleOpenFolder = (folderId) => navigate && navigate('chatbot-builder', 'folder', String(folderId));
  const handleExitFolder = () => navigate && navigate('chatbot-builder');

  const handleBack = () => {
    const fid = editingChatbot?.folder_id;
    setEditingChatbot(null);
    setBuilderTab('editor');
    if (navigate) {
      if (fid != null) navigate('chatbot-builder', 'folder', String(fid));
      else navigate('chatbot-builder');
    }
    loadData();
  };

  const handleSaveBuilder = async ({ config }) => {
    if (!editingChatbot?.id) return;
    await api.chatbots.update(editingChatbot.id, { config });
  };

  const handleToggleStatus = async (nextStatus) => {
    if (!editingChatbot?.id) return;
    try {
      const updated = await api.chatbots.update(editingChatbot.id, { status: nextStatus });
      setEditingChatbot(prev => prev ? { ...prev, status: updated?.status || nextStatus } : prev);
      setChatbots(list => list.map(c => c.id === editingChatbot.id ? { ...c, status: updated?.status || nextStatus } : c));
    } catch (err) {
      notify(err.message || 'Failed to update status');
    }
  };

  if (view === 'builder') {
    if (!editingChatbot) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.textMuted, fontSize: 13, fontFamily: FONT }}>
          Loading automation…
        </div>
      );
    }
    return (
      <AutomationBuilderView
        automation={editingChatbot}
        onBack={handleBack}
        onSave={handleSaveBuilder}
        onToggleStatus={handleToggleStatus}
        activeTab={builderTab}
        onTabChange={setBuilderTab}
        initialExecutionId={routeExecutionId}
        onNavigate={navigate}
      />
    );
  }

  return (
    <>
      <AutomationsBrowser
        chatbots={chatbots}
        folders={folders}
        loading={loading}
        currentFolderId={view === 'folder' ? routeFolderId : null}
        onAdd={handleAdd}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onDuplicate={handleDuplicate}
        onBulkDelete={handleBulkDelete}
        onMove={handleMove}
        onCreateFolder={handleCreateFolder}
        onRenameFolder={handleRenameFolder}
        onDeleteFolder={handleDeleteFolder}
        onOpenFolder={handleOpenFolder}
        onExitFolder={handleExitFolder}
        onImport={handleImport}
      />
      <NewAutomationModal
        open={showModal}
        folderId={addTarget.folderId}
        folderName={addTarget.folderName}
        onClose={() => setShowModal(false)}
        onCreate={handleModalCreate}
      />
    </>
  );
}
