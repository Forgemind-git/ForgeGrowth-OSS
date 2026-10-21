import { useState, useEffect, useMemo, useRef } from 'react';
import { notify, showError } from '../lib/feedback.js';
import { Plus, Pencil, Trash2, Loader2, Search, Bot, X, Copy, Upload } from 'lucide-react';
import DeleteConfirmModal from '../components/DeleteConfirmModal.jsx';
import AutomationBuilderView from '../components/AutomationBuilderView.jsx';
import AutomationExecutions from '../components/AutomationExecutions.jsx';
import { useTableSelection, SelectAllCheckbox, RowCheckbox, BulkDeleteButton, runBulkDelete } from '../components/TableSelection.jsx';
import SortControl from '../components/SortControl.jsx';
import { sortList, DEFAULT_SORT } from '../lib/listSort.js';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';

// ─── Design Tokens ────────────────────────────────────────────────────────────
// Themed tokens, not hardcoded light hex — see TemplateBuilderPage for why.
const B = {
  bg: C.pageBg,
  card: C.cardBg,
  cardBorder: C.border,
  innerBg: C.surfaceInner,
  innerBorder: C.borderSubtle,
  rowSep: C.rowSep,
  t1: C.t1,
  t2: C.t2,
  t3: C.t3,
  t4: C.t4,
  t5: C.t5,
  t6: C.t6,
  t7: C.t7,
  accent: C.primary,
  accentBg: C.primaryLight,
  accentDark: C.primaryHover,
  green: C.successText,
  greenBright: C.successBright,
  greenBg: C.successBg,
  red: C.dangerText,
  redBg: C.dangerBg,
  orange: C.orangeText,
  orangeBg: C.orangeBg,
};

const STATUS_STYLES = {
  active:   { color: B.green, bg: B.greenBg, dot: B.greenBright, label: 'Active' },
  inactive: { color: B.t6, bg: 'var(--c-surfaceSubtle, #EEEDE8)', dot: '#aaa', label: 'Inactive' },
  draft:    { color: B.orange, bg: B.orangeBg, dot: B.orange, label: 'Draft' },
};

function StatusBadge({ status }) {
  const st = STATUS_STYLES[status] || STATUS_STYLES.draft;
  return (
    <span style={{ padding: '4px 10px', borderRadius: 99, fontSize: 13, fontWeight: 700, background: st.bg, color: st.color, display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: FONT, whiteSpace: 'nowrap' }}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: st.dot, display: 'inline-block' }} />
      {st.label}
    </span>
  );
}

const iconBtnStyle = { width: 28, height: 28, borderRadius: 6, border: '1.5px solid var(--c-borderStrong, #D5D5D0)', background: 'var(--c-cardBg)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: B.t4, flexShrink: 0 };

const primaryBtnStyle = { padding: '10px 18px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: FONT, display: 'flex', alignItems: 'center', gap: 6, transition: 'background .15s' };

// ─── New Automation modal ───────────────────────────────────────────────────
function NewAutomationModal({ open, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open) { setName(''); setDescription(''); setCreating(false); }
  }, [open]);

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
      });
      onCreate(data);
    } catch (err) {
      notify(err.message || 'Create failed');
    } finally {
      setCreating(false);
    }
  };

  const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' };
  const modalStyle = { background: 'var(--c-cardBg)', borderRadius: 14, padding: '24px 28px', width: 440, maxWidth: 'calc(90vw / var(--fg-zoom, 1))', boxShadow: '0 20px 60px rgba(0,0,0,0.18)' };
  const inpStyle = { border: '1.5px solid var(--c-borderStrong, #D5D5D0)', borderRadius: 10, padding: '9px 14px', fontSize: 15, fontFamily: FONT, width: '100%', background: 'var(--c-cardBg)', color: 'var(--c-text)', outline: 'none' };
  const btnPriStyle = { padding: '10px 22px', background: B.accent, color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: FONT };
  const btnGhostStyle = { padding: '10px 22px', background: 'var(--c-cardBg)', border: '1.5px solid var(--c-borderStrong, #D5D5D0)', borderRadius: 10, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT, color: 'var(--c-t3, #444)' };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: B.t1, margin: 0, fontFamily: FONT }}>New Automation</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: B.t5 }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 14, color: B.t5, marginBottom: 16, fontFamily: FONT }}>
          Name your automation and add a short description.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 14, fontWeight: 600, color: B.t3, display: 'block', marginBottom: 5, fontFamily: FONT }}>Name <span style={{ color: B.red }}>*</span></label>
            <input style={inpStyle} placeholder="e.g. Welcome Bot" value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <label style={{ fontSize: 14, fontWeight: 600, color: B.t3, display: 'block', marginBottom: 5, fontFamily: FONT }}>Description</label>
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

const TH = ['Name', 'Description', 'Status', 'Trigger', 'Created', 'Actions'];

// Automations come back as raw Postgres rows, so these are snake_case. The table's date column is `created_at`, which is what the
// default sort orders by — the list used to arrive in `updated_at DESC` order
// from the API, which made the visible Created dates look shuffled.
const AUTO_FIELDS = { created: c => c.created_at, updated: c => c.updated_at, name: c => c.name };

// ─── Browser ────────────────────────────────────────────────────────────────
function AutomationsBrowser({
  chatbots, loading,
  onAdd, onEdit, onDelete, onDuplicate, onBulkDelete, onImport,
}) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState(DEFAULT_SORT);
  const importRef = useRef(null);
  const [deleteModal, setDeleteModal] = useState({ open: false, chatbot: null });

  const q = search.trim().toLowerCase();
  const matchesAuto = (c) => !q
    || c.name.toLowerCase().includes(q)
    || (c.description || '').toLowerCase().includes(q)
    || c.status.toLowerCase().includes(q);

  const filteredAutos = useMemo(
    () => sortList(chatbots.filter(matchesAuto), sort, AUTO_FIELDS),
    [chatbots, q, sort]
  );
  const sel = useTableSelection(filteredAutos);

  // ── Automation row ──
  const renderAutoRow = (c) => {
    return (
      <tr
        key={c.id}
        style={{ borderBottom: `1px solid ${B.rowSep}`, background: sel.isSelected(c.id) ? 'var(--c-dangerBgSoft, #FDF6F6)' : 'transparent' }}
      >
        <td style={{ padding: '12px 14px', width: 36 }}><RowCheckbox sel={sel} id={c.id} label={c.name} /></td>
        <td style={{ padding: '12px 14px', fontSize: 15, fontWeight: 600, color: B.t2, fontFamily: FONT }}>
          {c.name}
        </td>
        <td style={{ padding: '12px 14px', fontSize: 14, color: B.t4, fontFamily: FONT, maxWidth: 300 }}>
          <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.description || '—'}</span>
        </td>
        <td style={{ padding: '12px 14px' }}><StatusBadge status={c.status} /></td>
        <td style={{ padding: '12px 14px', fontSize: 14, color: B.t4, fontFamily: FONT, textTransform: 'capitalize' }}>{c.trigger_type}</td>
        <td style={{ padding: '12px 14px', fontSize: 13, color: B.t6, fontFamily: FONT, whiteSpace: 'nowrap' }}>{new Date(c.created_at).toLocaleDateString()}</td>
        <td style={{ padding: '12px 14px' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => onEdit(c)} title="Edit" style={iconBtnStyle}><Pencil size={13} /></button>
            <button onClick={() => onDuplicate(c)} title="Duplicate (creates a disabled copy)" style={iconBtnStyle}><Copy size={13} /></button>
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
              <th key={h} style={{ padding: '10px 14px', fontSize: 13, fontWeight: 700, color: B.t4, textAlign: 'left', textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );

  const totalRows = filteredAutos.length;

  return (
    <div style={{ padding: 24, fontFamily: FONT }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <p style={{ fontSize: 14, color: B.t5, margin: '4px 0 0' }}>Build and manage automated conversation flows.</p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {onImport && (
            <>
              <input ref={importRef} type="file" accept="application/json,.json"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onImport(f); }}
                style={{ display: 'none' }} />
              <button
                onClick={() => importRef.current?.click()}
                title="Import an automation from a .json export file"
                style={{ padding: '10px 16px', background: 'var(--c-cardBg)', color: B.t2, border: '1.5px solid var(--c-borderStrong, #D5D5D0)', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: FONT, display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <Upload size={16} /> Import
              </button>
            </>
          )}
          <button
            onClick={() => onAdd()}
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
            style={{ flex: 1, border: '1.5px solid var(--c-borderStrong, #D5D5D0)', borderRadius: 8, padding: '8px 12px', fontSize: 15, fontFamily: FONT, background: 'var(--c-cardBg)', color: 'var(--c-text)', outline: 'none' }}
            placeholder="Search automations..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <SortControl value={sort} onChange={setSort} />
        {filteredAutos.length > 0 && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14, color: B.t4, fontFamily: FONT, cursor: 'pointer', userSelect: 'none' }}>
            <SelectAllCheckbox sel={sel} /> Select all
          </label>
        )}
        <BulkDeleteButton sel={sel} label="automation" onConfirm={(ids) => onBulkDelete(ids)} />
      </div>

      {/* Content */}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 60, gap: 8 }}>
          <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> <span style={{ fontSize: 15, color: B.t5, fontFamily: FONT }}>Loading...</span>
        </div>
      ) : totalRows === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12 }}>
          <Bot size={40} color="var(--c-t8, #ccc)" style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 16, fontWeight: 600, color: B.t3, marginBottom: 4, fontFamily: FONT }}>
            {q ? 'No matches' : 'No automations yet'}
          </div>
          <div style={{ fontSize: 14, color: B.t6, marginBottom: 16, fontFamily: FONT }}>
            {q ? 'Try a different search term.' : 'Create your first automation.'}
          </div>
          {!q && (
            <button onClick={() => onAdd()} style={{ ...primaryBtnStyle, display: 'inline-flex' }}>
              <Plus size={16} /> New Automation
            </button>
          )}
        </div>
      ) : (
        tableShell(<>{filteredAutos.map(renderAutoRow)}</>)
      )}

      <DeleteConfirmModal
        open={deleteModal.open}
        title="Delete Automation"
        message={`Are you sure you want to delete "${deleteModal.chatbot?.name}"? This cannot be undone.`}
        onConfirm={() => { onDelete(deleteModal.chatbot?.id); setDeleteModal({ open: false, chatbot: null }); }}
        onCancel={() => setDeleteModal({ open: false, chatbot: null })}
      />

    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function ChatbotBuilderPage({ subParts = [], navigate }) {
  const [chatbots, setChatbots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingChatbot, setEditingChatbot] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [builderTab, setBuilderTab] = useState('editor'); // 'editor' | 'executions'

  // Routing: #/chatbot-builder            → list
  //          #/chatbot-builder/ID         → builder (chatbot id)
  //          #/chatbot-builder/ID/executions/EXEC → builder, executions deep-link
  // (The old #/chatbot-builder/folder/ID project view was removed with
  // Projects; such a link now lands on the list.)
  const isFolderRoute = subParts[0] === 'folder';
  const routeId = !isFolderRoute ? (subParts[0] || null) : null;
  const routeTab = subParts[1] === 'executions' ? 'executions' : null;
  const routeExecutionId = routeTab === 'executions' ? (subParts[2] || null) : null;
  const view = routeId ? 'builder' : 'list';

  const loadData = async () => {
    setLoading(true);
    try {
      setChatbots(await api.chatbots.list());
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

  const handleAdd = () => setShowModal(true);

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
      setChatbots(prev => [copy, ...prev]); // disabled copy
    } catch (err) {
      notify(err.message || 'Duplicate failed');
    }
  };

  // Import an automation from a .json export file. Lands disabled;
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

  const handleBack = () => {
    setEditingChatbot(null);
    setBuilderTab('editor');
    if (navigate) navigate('chatbot-builder');
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
      // The activation gate returns the exact list of what is wrong. Showing
      // only "cannot go live" would leave the operator hunting a canvas that
      // looks finished — the findings ARE the fix instructions.
      const blocking = err.body && Array.isArray(err.body.blocking) ? err.body.blocking : null;
      if (blocking && blocking.length) {
        const lines = blocking.slice(0, 6).map(b => `• ${b.message}${b.fix ? `\n   ${b.fix}` : ''}`);
        if (blocking.length > 6) lines.push(`• …and ${blocking.length - 6} more`);
        showError(`${err.message}\n\n${lines.join('\n')}`, 'This flow is not ready to go live');
      } else {
        notify(err.message || 'Failed to update status');
      }
    }
  };

  if (view === 'builder') {
    if (!editingChatbot) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.textMuted, fontSize: 15, fontFamily: FONT }}>
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
        loading={loading}
        onAdd={handleAdd}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onDuplicate={handleDuplicate}
        onBulkDelete={handleBulkDelete}
        onImport={handleImport}
      />
      <NewAutomationModal
        open={showModal}
        onClose={() => setShowModal(false)}
        onCreate={handleModalCreate}
      />
    </>
  );
}
