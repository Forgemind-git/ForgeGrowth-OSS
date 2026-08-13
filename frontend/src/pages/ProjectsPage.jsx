// Projects — one folder for a campaign's whole toolkit.
//
// A campaign is a COMBINATION: a broadcast template that goes out, an AI agent
// that answers whoever replies to it, and an automation that follows up. Those
// three live in three unrelated lists; a project is what lets you open them as
// one thing.
//
// The underlying table is the old automation_folders (migration 094), so the
// Automations page's existing folder view is showing the same projects.
import { useEffect, useMemo, useState } from 'react';
import {
  Plus, Trash2, ArrowLeft, Pencil, Loader2, Search, X, Check,
  FolderKanban, LayoutTemplate, Zap, Bot, CornerUpLeft, FormInput,
} from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO } from '../constants.js';
import DeleteConfirmModal from '../components/DeleteConfirmModal.jsx';
import SortControl from '../components/SortControl.jsx';
import { sortList, DEFAULT_SORT } from '../lib/listSort.js';
import { showError, showSuccess } from '../lib/feedback';

// Themed tokens, not hardcoded light hex — see TemplateBuilderPage for why.
const B = {
  card: C.cardBg, cardBorder: C.border, innerBg: C.surfaceInner, innerBorder: C.borderSubtle,
  rowSep: C.rowSep, t1: C.t1, t2: C.t2, t3: C.t3, t4: C.t4,
  t5: C.t5, t6: C.t6, t7: C.t7,
};

// The kinds a project can hold. `kind` here is the exact string the backend's
// KINDS map keys on and `key` the count key it returns — do not localise
// either. Everything on this page (cards, count badges, the add picker) is
// rendered from this list, so a new kind is one entry.
const KINDS = [
  { kind: 'template',   key: 'templates',   label: 'Templates',  singular: 'template',  Icon: LayoutTemplate, page: 'template-builder' },
  { kind: 'automation', key: 'automations', label: 'Automations', singular: 'automation', Icon: Zap,          page: 'chatbot-builder' },
  { kind: 'agent',      key: 'agents',      label: 'AI Agents',  singular: 'AI agent',  Icon: Bot,            page: 'ai-agent-builder' },
  { kind: 'form',       key: 'forms',       label: 'Forms',      singular: 'form',      Icon: FormInput,      page: 'lead-forms' },
];

const PROJECT_FIELDS = { created: p => p.createdAt, updated: p => p.updatedAt, name: p => p.name };

const fmtDate = (ts) => {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

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

export default function ProjectsPage({ subParts = [], navigate, user }) {
  const isAdmin = user?.role === 'admin';
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [sort, setSort] = useState(DEFAULT_SORT);

  const selectedId = subParts[0] || null;

  // Archived projects stay at the bottom whatever the sort — an archived
  // campaign is finished, so a recent one must not lead the grid just because
  // it is new. Sorting the two groups separately keeps that rule explicit
  // rather than hiding it inside a compound comparator.
  const visibleProjects = useMemo(() => [
    ...sortList(projects.filter(p => !p.archived), sort, PROJECT_FIELDS),
    ...sortList(projects.filter(p => p.archived), sort, PROJECT_FIELDS),
  ], [projects, sort]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.projects.list();
      setProjects(res.projects || []);
    } catch (err) { showError(err.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  if (selectedId) {
    return (
      <ProjectDetail
        projectId={selectedId}
        isAdmin={isAdmin}
        navigate={navigate}
        onBack={() => navigate && navigate('projects')}
        onChanged={load}
      />
    );
  }

  return (
    <div style={{ padding: '22px 26px', fontFamily: FONT, flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, letterSpacing: '-0.02em', color: B.t1 }}>Projects</h1>
          <p style={{ fontSize: 14, color: B.t5, margin: '4px 0 0', maxWidth: 720 }}>
            Keep everything one campaign needs in one place — the template that goes out, the AI agent
            that answers the replies, and the automation that follows up.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {projects.length > 0 && <SortControl value={sort} onChange={setSort} />}
          {isAdmin && (
            <button
              onClick={() => setCreateOpen(true)}
              style={{ ...btnPrimary, display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
              onMouseEnter={e => e.currentTarget.style.background = C.primaryHover}
              onMouseLeave={e => e.currentTarget.style.background = C.primary}
            >
              <Plus size={16} /> New Project
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: B.t6, gap: 8 }}>
          <Loader2 size={20} className="spin" /> Loading…
        </div>
      ) : projects.length === 0 ? (
        <div style={{ background: B.card, border: `1px dashed ${B.cardBorder}`, borderRadius: 12, padding: 60, textAlign: 'center', marginTop: 20 }}>
          <FolderKanban size={36} style={{ color: B.t7, marginBottom: 12 }} />
          <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 6, color: B.t2 }}>No projects yet</div>
          <div style={{ fontSize: 15, color: B.t5, marginBottom: 18, maxWidth: 480, margin: '0 auto 18px' }}>
            Create one per campaign or per audience — a Students project for course templates, a
            Marketing project for a launch — then move its templates, automations, agents
            and forms into it.
          </div>
          {isAdmin && (
            <button onClick={() => setCreateOpen(true)} style={{ ...btnPrimary, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 18px' }}>
              <Plus size={15} /> Create your first project
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
          {visibleProjects.map(p => (
            <button
              key={p.id}
              onClick={() => navigate && navigate('projects', p.id)}
              style={{
                textAlign: 'left', background: B.card, border: `1px solid ${B.cardBorder}`,
                borderRadius: 12, padding: 16, cursor: 'pointer', fontFamily: FONT,
                display: 'flex', flexDirection: 'column', gap: 10,
              }}
              onMouseEnter={e => e.currentTarget.style.borderColor = C.primary}
              onMouseLeave={e => e.currentTarget.style.borderColor = B.cardBorder}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <FolderKanban size={17} color={C.primary} />
                <span style={{ fontSize: 16, fontWeight: 700, color: B.t1 }}>{p.name}</span>
                {p.archived && (
                  <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 800, color: B.t5, background: 'var(--c-surfaceMuted, #F1F1EC)', borderRadius: 20, padding: '2px 8px', textTransform: 'uppercase' }}>
                    Archived
                  </span>
                )}
              </div>
              {p.description && (
                <div style={{ fontSize: 14, color: B.t5, lineHeight: 1.5 }}>{p.description}</div>
              )}
              <div style={{ display: 'flex', gap: 14, marginTop: 'auto', paddingTop: 4, alignItems: 'center' }}>
                {KINDS.map(k => (
                  <span key={k.kind} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 14, color: p.counts[k.key] ? B.t3 : B.t7 }}>
                    <k.Icon size={13} />
                    <span style={{ fontFamily: MONO, fontWeight: 700 }}>{p.counts[k.key]}</span>
                  </span>
                ))}
                {/* The grid's default order is by this date — showing it is what
                    makes that order readable rather than arbitrary. */}
                {fmtDate(p.createdAt) && (
                  <span style={{ marginLeft: 'auto', fontSize: 13, color: B.t7, whiteSpace: 'nowrap' }}>
                    {fmtDate(p.createdAt)}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {createOpen && (
        <ProjectModal
          onClose={() => setCreateOpen(false)}
          onSave={async (data) => {
            await api.projects.create(data);
            setCreateOpen(false);
            showSuccess('Project created.');
            await load();
          }}
        />
      )}

      <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } } .spin { animation: spin 1s linear infinite; }`}</style>
    </div>
  );
}

// ── detail ───────────────────────────────────────────────────────────────────
function ProjectDetail({ projectId, isAdmin, navigate, onBack, onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [pickerKind, setPickerKind] = useState(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.projects.get(projectId);
      setData(res);
      setNotFound(false);
    } catch (err) {
      if (/not found/i.test(err.message)) setNotFound(true);
      else showError(err.message);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [projectId]);

  const remove = async (kind, id) => {
    try {
      await api.projects.assign(kind, [id], null);
      showSuccess('Moved out of the project.');
      await load(); await onChanged();
    } catch (err) { showError(err.message); }
  };

  if (notFound) {
    return (
      <div style={{ padding: '22px 26px', fontFamily: FONT }}>
        <button onClick={onBack} style={{ ...btnGhost, marginBottom: 18 }}>
          <ArrowLeft size={14} style={{ verticalAlign: -2 }} /> Projects
        </button>
        <div style={{ background: B.card, border: `1px dashed ${B.cardBorder}`, borderRadius: 12, padding: 50, textAlign: 'center' }}>
          <FolderKanban size={32} style={{ color: B.t7, marginBottom: 10 }} />
          <div style={{ fontWeight: 700, fontSize: 16, color: B.t2 }}>Project not found</div>
          <div style={{ fontSize: 15, color: B.t5, marginTop: 4 }}>It may have been deleted.</div>
        </div>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div style={{ padding: 40, fontFamily: FONT, color: B.t6, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Loader2 size={20} className="spin" /> Loading…
        <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } } .spin { animation: spin 1s linear infinite; }`}</style>
      </div>
    );
  }

  const p = data.project;

  return (
    <div style={{ padding: '22px 26px', fontFamily: FONT, flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
        <button onClick={onBack} style={{ ...btnGhost, display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px' }}>
          <ArrowLeft size={14} /> Projects
        </button>
        <FolderKanban size={18} color={C.primary} />
        <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0, color: B.t1 }}>{p.name}</h1>
        {isAdmin && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={() => setEditOpen(true)} style={{ ...btnGhost, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Pencil size={14} /> Rename
            </button>
            <button
              onClick={() => setDeleteOpen(true)}
              style={{ ...btnGhost, border: '1px solid #FECACA', background: 'var(--c-dangerBgSoft, #FEF2F2)', color: 'var(--c-dangerStrong, #991B1B)', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <Trash2 size={14} /> Delete
            </button>
          </div>
        )}
      </div>
      {p.description && (
        <p style={{ fontSize: 15, color: B.t5, margin: '0 0 18px', maxWidth: 720 }}>{p.description}</p>
      )}
      {!p.description && <div style={{ height: 12 }} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
        {KINDS.map(k => {
          const items = data[k.key] || [];
          return (
            <div key={k.kind} style={{ background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 12, padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <k.Icon size={15} color={C.primary} />
                <span style={{ fontSize: 15, fontWeight: 800, color: B.t2 }}>{k.label}</span>
                <span style={{ fontFamily: MONO, fontSize: 14, color: B.t5 }}>{items.length}</span>
                {isAdmin && (
                  <button
                    onClick={() => setPickerKind(k.kind)}
                    style={{
                      marginLeft: 'auto', padding: '5px 10px', borderRadius: 7,
                      border: `1px solid ${B.cardBorder}`, background: 'transparent',
                      cursor: 'pointer', fontSize: 14, fontWeight: 700, color: B.t3,
                      fontFamily: FONT, display: 'inline-flex', alignItems: 'center', gap: 4,
                    }}
                  >
                    <Plus size={12} /> Add
                  </button>
                )}
              </div>

              {items.length === 0 ? (
                <div style={{ fontSize: 14, color: B.t6, padding: '14px 0', lineHeight: 1.6 }}>
                  No {k.label.toLowerCase()} in this project yet.
                </div>
              ) : (
                <div>
                  {items.map(it => (
                    <div
                      key={it.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '9px 0',
                        borderBottom: `1px solid ${B.rowSep}`,
                      }}
                    >
                      <button
                        onClick={() => navigate && navigate(k.page, it.id)}
                        title={`Open this ${k.singular}`}
                        style={{
                          flex: 1, textAlign: 'left', background: 'transparent', border: 'none',
                          cursor: 'pointer', fontFamily: FONT, padding: 0, minWidth: 0,
                        }}
                      >
                        <div style={{ fontSize: 15, fontWeight: 600, color: B.t2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {it.name}
                        </div>
                        {(it.status || it.category) && (
                          <div style={{ fontSize: 13, color: B.t6, marginTop: 2 }}>
                            {[it.category, it.status].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </button>
                      {isAdmin && (
                        <button
                          onClick={() => remove(k.kind, it.id)}
                          title="Move out of this project"
                          style={{ padding: 5, borderRadius: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: B.t5 }}
                        >
                          <CornerUpLeft size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {pickerKind && (
        <ItemPicker
          kind={pickerKind}
          projectId={p.id}
          projectName={p.name}
          onClose={() => setPickerKind(null)}
          onDone={async () => { setPickerKind(null); await load(); await onChanged(); }}
        />
      )}

      {editOpen && (
        <ProjectModal
          initial={p}
          onClose={() => setEditOpen(false)}
          onSave={async (d) => {
            await api.projects.update(p.id, d);
            setEditOpen(false);
            showSuccess('Project updated.');
            await load(); await onChanged();
          }}
        />
      )}

      <DeleteConfirmModal
        open={deleteOpen}
        title="Delete project"
        message={`Delete "${p.name}"? Everything inside must be moved out first — nothing is deleted with it.`}
        onConfirm={async () => {
          try {
            await api.projects.delete(p.id);
            showSuccess('Project deleted.');
            setDeleteOpen(false);
            await onChanged();
            onBack();
          } catch (err) {
            setDeleteOpen(false);
            showError(err.message);
          }
        }}
        onCancel={() => setDeleteOpen(false)}
      />
    </div>
  );
}

// ── add-items picker ─────────────────────────────────────────────────────────
function ItemPicker({ kind, projectId, projectName, onClose, onDone }) {
  const meta = KINDS.find(k => k.kind === kind);
  const [items, setItems] = useState(null);
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.projects.items(kind)
      .then(res => setItems(res.items || []))
      .catch(err => showError(err.message));
  }, [kind]);

  // Only offer what is not already in THIS project; items in another project are
  // still offered but labelled, because moving one between campaigns is a normal
  // thing to want and silently hiding it would look like the item vanished.
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items || [])
      .filter(i => String(i.projectId ?? '') !== String(projectId))
      .filter(i => !needle || i.name.toLowerCase().includes(needle));
  }, [items, q, projectId]);

  const submit = async () => {
    if (!chosen.length) return;
    setSaving(true);
    try {
      const res = await api.projects.assign(kind, chosen, projectId);
      showSuccess(`${res.moved} ${meta.label.toLowerCase()} added to ${projectName}.`);
      onDone();
    } catch (err) {
      showError(err.message);
      setSaving(false);
    }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, padding: '22px 24px', width: 540, maxWidth: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: C.shadowLg }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <meta.Icon size={16} color={C.primary} />
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: B.t1 }}>Add {meta.label.toLowerCase()}</h2>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', color: B.t5, padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ position: 'relative', marginBottom: 12 }}>
          <Search size={14} style={{ position: 'absolute', left: 11, top: 11, color: B.t6 }} />
          <input
            autoFocus value={q} onChange={e => setQ(e.target.value)}
            placeholder={`Search ${meta.label.toLowerCase()}…`}
            style={{ ...inputStyle, paddingLeft: 32 }}
          />
        </div>

        <div style={{ flex: 1, overflowY: 'auto', border: `1px solid ${B.cardBorder}`, borderRadius: 10, minHeight: 140 }}>
          {items === null ? (
            <div style={{ padding: 20, color: B.t6, fontSize: 15 }}>Loading…</div>
          ) : visible.length === 0 ? (
            <div style={{ padding: 20, color: B.t6, fontSize: 15 }}>
              {q ? 'Nothing matches that search.' : `Every ${meta.singular} is already in this project.`}
            </div>
          ) : visible.map(i => {
            const on = chosen.includes(i.id);
            return (
              <label
                key={i.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                  borderBottom: `1px solid ${B.rowSep}`, cursor: 'pointer',
                  background: on ? 'var(--c-selectedTint, #FFF7F7)' : 'transparent',
                }}
              >
                <input
                  type="checkbox" checked={on} style={{ accentColor: C.primary }}
                  onChange={() => setChosen(on ? chosen.filter(x => x !== i.id) : [...chosen, i.id])}
                />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 15, fontWeight: 600, color: B.t2, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {i.name}
                  </span>
                  {i.projectName && (
                    <span style={{ fontSize: 13, color: B.t6 }}>Currently in {i.projectName} — this will move it</span>
                  )}
                </span>
                {i.status && <span style={{ fontSize: 13, color: B.t6 }}>{i.status}</span>}
              </label>
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 14 }}>
          <span style={{ fontSize: 14, color: B.t5 }}>{chosen.length} selected</span>
          <span style={{ display: 'flex', gap: 10 }}>
            <button onClick={onClose} style={btnGhost}>Cancel</button>
            <button
              onClick={submit}
              disabled={!chosen.length || saving}
              style={{ ...btnPrimary, background: !chosen.length || saving ? 'var(--c-hover)' : C.primary, cursor: !chosen.length || saving ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <Check size={14} /> {saving ? 'Adding…' : 'Add to project'}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

// ── create / rename ──────────────────────────────────────────────────────────
function ProjectModal({ initial, onClose, onSave }) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) { showError('Project name is required.'); return; }
    setSaving(true);
    try {
      await onSave({ name: name.trim(), description: description.trim() || null });
    } catch (err) {
      showError(err.message);
      setSaving(false);
    }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, padding: '24px 28px', width: 460, maxWidth: '100%', boxShadow: C.shadowLg }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 20, fontWeight: 700, color: B.t1 }}>
          {initial ? 'Rename project' : 'New project'}
        </h2>
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: B.t4, marginBottom: 5 }}>Name *</label>
          <input
            autoFocus value={name} onChange={e => setName(e.target.value)}
            placeholder="e.g. Students — enrolled" style={inputStyle}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          />
        </div>
        <div style={{ marginBottom: 18 }}>
          <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: B.t4, marginBottom: 5 }}>Description</label>
          <textarea
            value={description} onChange={e => setDescription(e.target.value)} rows={2}
            placeholder="What this project is for" style={{ ...inputStyle, resize: 'vertical' }}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={btnGhost}>Cancel</button>
          <button
            onClick={submit} disabled={saving}
            style={{ ...btnPrimary, background: saving ? 'var(--c-hover)' : C.primary, cursor: saving ? 'not-allowed' : 'pointer' }}
          >
            {saving ? 'Saving…' : initial ? 'Save' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  );
}
