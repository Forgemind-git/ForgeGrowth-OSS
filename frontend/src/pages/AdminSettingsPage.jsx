import { useState, useEffect, useMemo } from 'react';
import { notify, showError, showSuccess } from '../lib/feedback.js';
import {
  Settings, Users, Tag, FolderOpen, LayoutList,
  LogOut, Trash2,
  ArrowLeft, Plus, X, ChevronLeft, Eye, EyeOff, Phone, Mail, MapPin, BadgeCheck, User,
  Loader2, MessageSquare, Star, Key, Webhook, RefreshCw, Search, Play, AlertCircle, CheckCircle2,
  Bot, Copy, Check, Plug, Calendar as CalendarIcon, FileSpreadsheet, Link2, Unplug,
  ChevronRight, ExternalLink, Sheet, Table2, Inbox, PlugZap, Terminal,
  IndianRupee, CreditCard, Link as LinkIcon, SlidersHorizontal,
  ChevronDown, Wrench, ShieldAlert, Package, Download, Shield, Mic,
  ScrollText as ScrollTextIcon, Shield as ShieldIcon, Pencil,
} from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO, maskPhone } from '../constants.js';
import MaskedNumber from '../components/MaskedNumber.jsx';
import { useTheme } from '../theme.jsx';
import DeleteConfirmModal from '../components/DeleteConfirmModal.jsx';
import RenameNumberModal from '../components/RenameNumberModal.jsx';
import SearchableSelect from '../components/SearchableSelect.jsx';
import PillStrip from '../components/PillStrip.jsx';
import { useTableSelection, SelectAllCheckbox, RowCheckbox, BulkDeleteButton, runBulkDelete } from '../components/TableSelection.jsx';
import { FunnelSettingsContent } from './sales/FunnelSettingsPage.jsx';
import EntityFieldsManager from '../components/EntityFieldsManager.jsx';
import SocialSettingsPart from '../social/SocialSettingsPart.jsx';

// The sidebar groups (in order). A tab's `group` decides which heading it sits
// under; the order of TABS is the order inside each group.
const TAB_GROUPS = [
  { key: 'workspace', label: 'Workspace' },
  { key: 'crm', label: 'Contacts & funnel' },
  { key: 'connections', label: 'Connections' },
  { key: 'social', label: 'Social' },
];
const TABS = [
  { key: 'general', label: 'General', icon: Settings, group: 'workspace' },
  { key: 'users', label: 'Users', icon: User, group: 'workspace' },
  { key: 'tags', label: 'Tags', icon: Tag, group: 'crm' },
  { key: 'category', label: 'Category', icon: FolderOpen, group: 'crm' },
  { key: 'fields', label: 'Fields', icon: LayoutList, group: 'crm' },
  { key: 'funnel', label: 'Funnel', icon: SlidersHorizontal, group: 'crm' },
  { key: 'whatsapp-accounts', label: 'WhatsApp Accounts', icon: MessageSquare, group: 'connections' },
  { key: 'ai-models', label: 'AI Models', icon: Bot, group: 'connections' },
  { key: 'integrations', label: 'Integrations', icon: Plug, group: 'connections' },
  { key: 'webhooks', label: 'Webhooks', icon: Webhook, group: 'connections' },
  { key: 'mcp', label: 'MCP Tools', icon: PlugZap, group: 'connections' },
  // Social-only tabs (were under Social → Settings). No "Sales & Chats" half.
  { key: 'activity', label: 'Activity log', icon: ScrollTextIcon, socialOnly: true, group: 'social' },
  { key: 'privacy', label: 'Privacy policy', icon: ShieldIcon, socialOnly: true, group: 'social' },
];

// Main tabs that also hold a Social half (social/SocialSettingsPart.jsx), shown
// behind a "Sales & Chats | Social" switch at the top of the tab. The value says
// who may open that Social half: 'social' = anyone with the Social page,
// 'admin' = admins only (it was admin-only under Social → Settings too).
const SOCIAL_PARTS = {
  general: 'social', integrations: 'social', privacy: 'social',
  'ai-models': 'admin', tags: 'admin', category: 'admin', fields: 'admin', mcp: 'admin', activity: 'admin',
};


const TIMEZONES = [
  'Asia/Calcutta',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
  'Pacific/Auckland',
];

const COLOR_PRESETS = [
  '#dc2626', '#ea580c', '#d97706', '#16a34a',
  '#0891b2', '#2563eb', '#7c3aed', '#db2777',
  '#4b5563', '#000000',
];

/* ------------------------------------------------------------------ */
/*  Placeholder                                                        */
/* ------------------------------------------------------------------ */
function PlaceholderTab({ label }) {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: C.textMuted, fontSize: 15, fontFamily: FONT,
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🚧</div>
        <div style={{ fontWeight: 600, color: C.text, marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: 15 }}>This section is coming soon.</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  General                                                            */
/* ------------------------------------------------------------------ */
function GeneralTab({ onLogout, user }) {
  const { theme, setTheme } = useTheme();
  const [timezone, setTimezone] = useState('Asia/Calcutta');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [showDeleteInput, setShowDeleteInput] = useState(false);

  const handleDeleteClick = () => {
    if (!showDeleteInput) { setShowDeleteInput(true); return; }
    if (deleteConfirm.trim().toLowerCase() === 'delete') {
      notify('Account deletion request submitted.');
      setShowDeleteInput(false);
      setDeleteConfirm('');
    } else {
      notify('Please type "delete" to confirm account deletion.');
    }
  };

  return (
    <div style={{ flex: 1, padding: '16px 28px 28px', overflowY: 'auto', fontFamily: FONT }}>
      <div style={{ maxWidth: '100%' }}>
        <div style={{ marginBottom: 28 }}>
          <p style={{ fontSize: 14, color: C.textMuted, margin: '4px 0 0', fontFamily: FONT }}>Manage your account preferences and settings</p>
        </div>

        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
            Appearance
          </div>
          {/* Saved per device, like the switch in the header — the two are one setting. */}
          <PillStrip value={theme} onChange={setTheme}
            items={[{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }]} />
        </div>

        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
            Timezone
          </div>
          <SearchableSelect
            value={timezone}
            onChange={v => setTimezone(v)}
            options={TIMEZONES.map(tz => ({ value: tz, label: tz }))}
            searchPlaceholder="Search timezones…"
            style={{ width: '100%', maxWidth: 360 }}
            triggerStyle={{ padding: '10px 32px 10px 12px', fontSize: 15 }}
          />
        </div>

        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
            Account
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button onClick={onLogout} style={{
              width: 'fit-content', display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 18px', borderRadius: 8, border: `1px solid ${C.border}`,
              background: 'var(--c-cardBg)', cursor: 'pointer', fontFamily: FONT, fontSize: 15,
              fontWeight: 600, color: C.text,
            }}>
              <LogOut size={14} /> Sign out
            </button>

            {user?.role === 'admin' && (
            <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 16, marginTop: 6 }}>
              <button onClick={handleDeleteClick} style={{
                width: 'fit-content', display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 18px', borderRadius: 8, border: '1.5px solid transparent',
                background: 'var(--c-dangerBgSoft, #fef2f2)', cursor: 'pointer', fontFamily: FONT, fontSize: 15,
                fontWeight: 600, color: C.primary,
              }}>
                <Trash2 size={14} /> Delete account
              </button>
              {showDeleteInput && (
                <div style={{ marginTop: 12, maxWidth: 360 }}>
                  <div style={{ fontSize: 14, color: C.textSecondary, marginBottom: 8 }}>
                    Type <strong>"delete"</strong> below to confirm permanent account deletion.
                  </div>
                  <input autoFocus value={deleteConfirm} onChange={e => setDeleteConfirm(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleDeleteClick()}
                    placeholder="Type delete..." style={{
                      width: '100%', padding: '10px 12px', borderRadius: 8,
                      border: `1px solid ${C.border}`, fontSize: 15, fontFamily: FONT,
                      color: C.text, outline: 'none', boxSizing: 'border-box',
                    }} />
                </div>
              )}
            </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  (Team Members removed 2026-08-12 — a number is named in its own tab)  */
/* ------------------------------------------------------------------ */
function FieldsTab() {
  // Which TABLE's columns are being managed. The contact_field_definitions CRUD
  // that used to live here is gone with the rest of contacts-as-a-CRM-record.
  const [section, setSection] = useState('lead:leads');

  // One section per TABLE. "Contacts (Chats)" is gone: a contact is no longer a
  // record you manage — it is the row a WhatsApp thread hangs off — and the
  // lead is the source of truth for everything about a person.
  //
  // The Sales Log section (its own `show_in_sales` switch over the same
  // `entity='lead'` rows) was removed 2026-10-21 with the Sales Log page.
  // The Transactions section was removed 2026-08-12: an installment's columns
  // are fixed by what a payment IS, so there was nothing useful to configure.
  // The `entity='transaction'` registry rows still exist and still drive the
  // transactions table — they are simply no longer editable here.
  const FIELD_SECTIONS = [
    { key: 'lead', surface: 'leads', label: 'Leads' },
  ];
  const sectionId = (s) => (s.surface ? `${s.key}:${s.surface}` : s.key);
  const activeSection = FIELD_SECTIONS.find(s => sectionId(s) === section) || FIELD_SECTIONS[0];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {FIELD_SECTIONS.length > 1 && (
        <div style={{
          padding: '20px 32px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: `1px solid ${C.border}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <PillStrip value={sectionId(activeSection)} onChange={setSection}
              items={FIELD_SECTIONS.map(s => ({ id: sectionId(s), label: s.label }))} />
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 28px 28px' }}>
        <EntityFieldsManager entity={activeSection.key} surface={activeSection.surface} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tags                                                               */
/* ------------------------------------------------------------------ */
function TagsTab({ categories, tags, onRefresh }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editingTag, setEditingTag] = useState(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#dc2626');
  const [categoryId, setCategoryId] = useState('');
  const [deleteModal, setDeleteModal] = useState({ open: false, id: null });
  const [filterCategoryId, setFilterCategoryId] = useState('');

  // Category filter — selection/bulk-delete operate on the visible (filtered) set.
  const filteredTags = filterCategoryId
    ? tags.filter(t => String(t.category_id) === String(filterCategoryId))
    : tags;

  const sel = useTableSelection(filteredTags);
  const handleBulkDelete = async (ids) => {
    await runBulkDelete(ids, (id) => api.tags.delete(id), {
      label: 'tag',
      onSuccess: () => onRefresh(),
    });
  };

  const openAdd = () => {
    setEditingTag(null);
    setName('');
    setColor('#dc2626');
    setCategoryId('');
    setShowAdd(true);
  };

  const openEdit = (tag) => {
    setEditingTag(tag);
    setName(tag.name);
    setColor(tag.color);
    setCategoryId(tag.category_id);
    setShowAdd(true);
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) { notify('Tag name is required'); return; }
    if (!categoryId) { notify('Please select a category'); return; }
    try {
      if (editingTag) {
        await api.tags.update(editingTag.id, { name: trimmed, color, categoryId });
      } else {
        await api.tags.create({ name: trimmed, color, categoryId });
      }
      onRefresh();
      setShowAdd(false);
      setEditingTag(null);
      setName('');
      setColor('#dc2626');
      setCategoryId('');
    } catch (err) {
      notify('Failed to save tag: ' + err.message);
    }
  };

  const handleDeleteClick = (id) => {
    setDeleteModal({ open: true, id });
  };

  const handleDeleteConfirm = async () => {
    try {
      await api.tags.delete(deleteModal.id);
      onRefresh();
      setDeleteModal({ open: false, id: null });
    } catch (err) {
      notify('Failed to delete tag: ' + err.message);
    }
  };

  const getCategoryName = (cid) => categories.find(c => c.id === cid)?.name || '-';

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        padding: '16px 28px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: `1px solid ${C.border}`,
      }}>
        <div />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <SearchableSelect
            value={filterCategoryId}
            onChange={v => setFilterCategoryId(v)}
            options={[{ value: '', label: 'All categories' }, ...categories.map(c => ({ value: String(c.id), label: c.name }))]}
            placeholder="All categories"
            searchPlaceholder="Search categories…"
            style={{ maxWidth: 220 }}
            triggerStyle={{ padding: '8px 32px 8px 12px' }}
          />
          <BulkDeleteButton sel={sel} label="tag" onConfirm={handleBulkDelete} />
          <button onClick={openAdd} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 14px', borderRadius: 8, border: 'none',
            background: C.primary, color: '#fff', cursor: 'pointer',
            fontFamily: FONT, fontSize: 15, fontWeight: 600,
          }}>
            <Plus size={14} /> Add tag
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 28px 28px' }}>
        {tags.length === 0 ? (
          <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 15, marginTop: 60 }}>
            No tags yet. Click "Add tag" to create one.
          </div>
        ) : filteredTags.length === 0 ? (
          <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 15, marginTop: 60 }}>
            No tags in <strong>{getCategoryName(filterCategoryId)}</strong>.
          </div>
        ) : (
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 15 }}>
              <thead>
                <tr style={{ background: 'var(--c-hover)' }}>
                  <th style={{ padding: '12px 16px', width: 40, borderBottom: `1px solid ${C.border}` }}><SelectAllCheckbox sel={sel} /></th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Tag</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Category</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Created</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredTags.map(tag => (
                  <tr key={tag.id} style={{ background: sel.isSelected(tag.id) ? 'var(--c-xfdf6f6, #FDF6F6)' : 'var(--c-cardBg)', borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: '12px 16px', width: 40 }}><RowCheckbox sel={sel} id={tag.id} label={tag.name} /></td>
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{
                          width: 14, height: 14, borderRadius: 4,
                          background: tag.color, display: 'inline-block',
                          border: '1px solid rgba(0,0,0,0.1)',
                        }} />
                        <span style={{ fontWeight: 600, color: C.text }}>{tag.name}</span>
                      </div>
                    </td>
                    <td style={{ padding: '12px 16px', color: C.textSecondary }}>{getCategoryName(tag.category_id)}</td>
                    <td style={{ padding: '12px 16px', color: C.textSecondary }}>{new Date(tag.created_at).toLocaleDateString()}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                      <button onClick={() => openEdit(tag)} style={{
                        border: 'none', background: 'transparent', cursor: 'pointer',
                        color: C.purple, fontSize: 14, fontWeight: 600, marginRight: 12,
                      }}>Edit</button>
                      <button onClick={() => handleDeleteClick(tag.id)} style={{
                        border: 'none', background: 'transparent', cursor: 'pointer',
                        color: C.primary, fontSize: 14, fontWeight: 600,
                      }}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <DeleteConfirmModal
        open={deleteModal.open}
        title="Delete Tag"
        message="Are you sure you want to delete this tag? It will be removed from all contacts."
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteModal({ open: false, id: null })}
      />

      {showAdd && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 200, fontFamily: FONT,
        }}>
          <div style={{
            background: C.cardBg, borderRadius: 14,
            padding: '24px 24px 20px', width: 420, boxShadow: C.shadowLg,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{editingTag ? 'Edit Tag' : 'Add Tag'}</div>
              <button onClick={() => { setShowAdd(false); setEditingTag(null); }} style={{
                border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted,
              }}><X size={18} /></button>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Tag Name</label>
              <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Follow-up"
                onKeyDown={e => e.key === 'Enter' && handleSave()}
                style={{
                  width: '100%', padding: '10px 12px', borderRadius: 8,
                  border: `1px solid ${C.border}`, fontSize: 15, fontFamily: FONT,
                  color: C.text, outline: 'none', boxSizing: 'border-box',
                }} />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Color</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {COLOR_PRESETS.map(c => (
                  <button key={c} onClick={() => setColor(c)} style={{
                    width: 28, height: 28, borderRadius: 6,
                    background: c,
                    border: color === c ? '2px solid #111' : '2px solid transparent',
                    cursor: 'pointer',
                    boxShadow: color === c ? '0 0 0 2px #fff inset' : 'none',
                  }} />
                ))}
                <label style={{
                  width: 28, height: 28, borderRadius: 6,
                  border: `2px dashed ${C.border}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', color: C.textMuted,
                }}>
                  <Plus size={14} />
                  <input type="color" value={color} onChange={e => setColor(e.target.value)} style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
                </label>
              </div>
              <div style={{ marginTop: 6, fontSize: 14, color: C.textMuted }}>Selected: {color}</div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Category</label>
              <SearchableSelect
                value={categoryId}
                onChange={v => setCategoryId(v)}
                options={categories.map(c => ({ value: String(c.id), label: c.name }))}
                placeholder="Select category…"
                searchPlaceholder="Search categories…"
                style={{ width: '100%' }}
                triggerStyle={{ padding: '10px 32px 10px 12px', fontSize: 15 }}
              />
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowAdd(false); setEditingTag(null); }} style={{
                padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.border}`,
                background: 'transparent', cursor: 'pointer', fontSize: 15,
                fontWeight: 600, color: C.textSecondary, fontFamily: FONT,
              }}>Cancel</button>
              <button onClick={handleSave} style={{
                padding: '8px 16px', borderRadius: 8, border: 'none',
                background: C.primary, color: '#fff', cursor: 'pointer',
                fontSize: 15, fontWeight: 600, fontFamily: FONT,
              }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Category Detail                                                    */
/* ------------------------------------------------------------------ */
function CategoryDetail({ category, tags, onBack, onDeleteTag, onRefresh }) {
  const categoryTags = tags.filter(t => t.category_id === category.id);
  const [deleteModal, setDeleteModal] = useState({ open: false, id: null });

  const handleDeleteClick = (tid) => {
    setDeleteModal({ open: true, id: tid });
  };

  const handleDeleteConfirm = async () => {
    try {
      await api.tags.delete(deleteModal.id);
      onRefresh();
      setDeleteModal({ open: false, id: null });
    } catch (err) {
      notify('Failed to delete tag: ' + err.message);
    }
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '16px 28px', borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onBack} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          border: 'none', background: 'transparent', cursor: 'pointer',
          color: C.textSecondary, fontFamily: FONT, fontSize: 15,
          fontWeight: 600, marginBottom: 12,
        }}>
          <ChevronLeft size={16} /> Back to categories
        </button>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-.02em', fontFamily: FONT }}>
          {category.name}
        </h1>
        <div style={{ fontSize: 15, color: C.textSecondary, marginTop: 4, fontFamily: FONT }}>
          {category.description || 'No description'}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 28px 28px' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: C.textSecondary, marginBottom: 12, fontFamily: FONT }}>
          Tags under this category ({categoryTags.length})
        </div>
        {categoryTags.length === 0 ? (
          <div style={{ color: C.textMuted, fontSize: 15 }}>No tags assigned to this category yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {categoryTags.map(tag => (
              <div key={tag.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 16px', background: 'var(--c-cardBg)', borderRadius: 8,
                border: `1px solid ${C.border}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{
                    width: 14, height: 14, borderRadius: 4,
                    background: tag.color, display: 'inline-block',
                    border: '1px solid rgba(0,0,0,0.1)',
                  }} />
                  <span style={{ fontWeight: 600, color: C.text, fontSize: 15 }}>{tag.name}</span>
                </div>
                <button onClick={() => handleDeleteClick(tag.id)} style={{
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  color: C.primary, fontSize: 14, fontWeight: 600,
                }}>Delete</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <DeleteConfirmModal
        open={deleteModal.open}
        title="Delete Tag"
        message="Are you sure you want to delete this tag? It will be removed from all contacts."
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteModal({ open: false, id: null })}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Category Tab                                                       */
/* ------------------------------------------------------------------ */
function CategoryTab({ categories, tags, onRefresh, detailId, onViewDetail, onBack, showAddForm, onAddFormShown }) {
  const [showAdd, setShowAdd] = useState(showAddForm);
  const [editingCategory, setEditingCategory] = useState(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [deleteModal, setDeleteModal] = useState({ open: false, id: null });

  useEffect(() => {
    setShowAdd(showAddForm);
  }, [showAddForm]);

  const openAdd = () => {
    setEditingCategory(null);
    setName('');
    setDescription('');
    setShowAdd(true);
    onAddFormShown();
  };

  const openEdit = (cat) => {
    setEditingCategory(cat);
    setName(cat.name);
    setDescription(cat.description || '');
    setShowAdd(true);
    onAddFormShown();
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) { notify('Category name is required'); return; }
    try {
      if (editingCategory) {
        await api.categories.update(editingCategory.id, { name: trimmed, description: description.trim() });
      } else {
        await api.categories.create({ name: trimmed, description: description.trim() });
      }
      onRefresh();
      setShowAdd(false);
      setEditingCategory(null);
      onAddFormShown();
      setName('');
      setDescription('');
    } catch (err) {
      notify('Failed to save category: ' + err.message);
    }
  };

  const handleDeleteClick = (id) => {
    setDeleteModal({ open: true, id });
  };

  const handleDeleteConfirm = async () => {
    try {
      await api.categories.delete(deleteModal.id);
      onRefresh();
      setDeleteModal({ open: false, id: null });
    } catch (err) {
      notify('Failed to delete category: ' + err.message);
    }
  };

  const sel = useTableSelection(categories);
  const handleBulkDelete = async (ids) => {
    await runBulkDelete(ids, (id) => api.categories.delete(id), {
      label: 'category',
      onSuccess: () => onRefresh(),
    });
  };

  if (detailId) {
    const cat = categories.find(c => c.id === detailId);
    if (!cat) { onBack(); return null; }
    return (
      <CategoryDetail
        category={cat}
        tags={tags}
        onBack={onBack}
        onRefresh={onRefresh}
      />
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        padding: '16px 28px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: `1px solid ${C.border}`,
      }}>
        <div />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <BulkDeleteButton sel={sel} label="category" onConfirm={handleBulkDelete} />
          <button onClick={openAdd} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 14px', borderRadius: 8, border: 'none',
            background: C.primary, color: '#fff', cursor: 'pointer',
            fontFamily: FONT, fontSize: 15, fontWeight: 600,
          }}>
            <Plus size={14} /> Add category
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 28px 28px' }}>
        {categories.length === 0 ? (
          <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 15, marginTop: 60 }}>
            No categories yet. Click "Add category" to create one.
          </div>
        ) : (
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 15 }}>
              <thead>
                <tr style={{ background: 'var(--c-hover)' }}>
                  <th style={{ padding: '12px 16px', width: 40, borderBottom: `1px solid ${C.border}` }}><SelectAllCheckbox sel={sel} /></th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Name</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Description</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Tags</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {categories.map(cat => {
                  const tagCount = tags.filter(t => t.category_id === cat.id).length;
                  return (
                    <tr key={cat.id} style={{ background: sel.isSelected(cat.id) ? 'var(--c-xfdf6f6, #FDF6F6)' : 'var(--c-cardBg)', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}
                      onClick={() => onViewDetail(cat.id)}
                      onMouseEnter={e => { if (!sel.isSelected(cat.id)) e.currentTarget.style.background = 'var(--c-xf9fafb, #f9fafb)'; }}
                      onMouseLeave={e => { if (!sel.isSelected(cat.id)) e.currentTarget.style.background = 'var(--c-cardBg)'; }}
                    >
                      <td style={{ padding: '12px 16px', width: 40 }} onClick={(e) => e.stopPropagation()}><RowCheckbox sel={sel} id={cat.id} label={cat.name} /></td>
                      <td style={{ padding: '12px 16px', fontWeight: 600, color: C.text }}>{cat.name}</td>
                      <td style={{ padding: '12px 16px', color: C.textSecondary, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cat.description || '-'}</td>
                      <td style={{ padding: '12px 16px', color: C.textSecondary }}>{tagCount}</td>
                      <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                        <button onClick={(e) => { e.stopPropagation(); onViewDetail(cat.id); }} style={{
                          border: 'none', background: 'transparent', cursor: 'pointer',
                          color: C.purple, fontSize: 14, fontWeight: 600, marginRight: 12,
                        }}><Eye size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />View</button>
                        <button onClick={(e) => { e.stopPropagation(); openEdit(cat); }} style={{
                          border: 'none', background: 'transparent', cursor: 'pointer',
                          color: 'var(--c-infoBright, #2563eb)', fontSize: 14, fontWeight: 600, marginRight: 12,
                        }}>Edit</button>
                        <button onClick={(e) => { e.stopPropagation(); handleDeleteClick(cat.id); }} style={{
                          border: 'none', background: 'transparent', cursor: 'pointer',
                          color: C.primary, fontSize: 14, fontWeight: 600,
                        }}>Delete</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <DeleteConfirmModal
        open={deleteModal.open}
        title="Delete Category"
        message="Are you sure you want to delete this category? All tags under it will be deleted too."
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteModal({ open: false, id: null })}
      />

      {showAdd && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 200, fontFamily: FONT,
        }}>
          <div style={{
            background: C.cardBg, borderRadius: 14,
            padding: '24px 24px 20px', width: 420, boxShadow: C.shadowLg,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{editingCategory ? 'Edit Category' : 'Add Category'}</div>
              <button onClick={() => { setShowAdd(false); setEditingCategory(null); onAddFormShown(); }} style={{
                border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted,
              }}><X size={18} /></button>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Category Name</label>
              <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Admission"
                onKeyDown={e => e.key === 'Enter' && handleSave()}
                style={{
                  width: '100%', padding: '10px 12px', borderRadius: 8,
                  border: `1px solid ${C.border}`, fontSize: 15, fontFamily: FONT,
                  color: C.text, outline: 'none', boxSizing: 'border-box',
                }} />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Description</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Short description..."
                rows={3}
                style={{
                  width: '100%', padding: '10px 12px', borderRadius: 8,
                  border: `1px solid ${C.border}`, fontSize: 15, fontFamily: FONT,
                  color: C.text, outline: 'none', boxSizing: 'border-box', resize: 'vertical',
                }} />
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowAdd(false); setEditingCategory(null); onAddFormShown(); }} style={{
                padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.border}`,
                background: 'transparent', cursor: 'pointer', fontSize: 15,
                fontWeight: 600, color: C.textSecondary, fontFamily: FONT,
              }}>Cancel</button>
              <button onClick={handleSave} style={{
                padding: '8px 16px', borderRadius: 8, border: 'none',
                background: C.primary, color: '#fff', cursor: 'pointer',
                fontSize: 15, fontWeight: 600, fontFamily: FONT,
              }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/*  WhatsApp Accounts Tab                                              */
/* ------------------------------------------------------------------ */
function WhatsappAccountsTab() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({
    displayName: '', label: '', displayPhoneNumber: '', phoneNumberId: '', wabaId: '', metaAppId: '',
    accessToken: '', verifyToken: '', isDefault: false, isActive: true,
  });
  const [renaming, setRenaming] = useState(null);
  const [showToken, setShowToken] = useState(false);
  const [revealedToken, setRevealedToken] = useState(null); // decrypted existing token, fetched on demand
  const [revealingToken, setRevealingToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [copied, setCopied] = useState(false);

  // The callback URL to register in the Meta App Dashboard — always the live origin.
  const webhookUrl = `${window.location.origin}/api/webhook/whatsapp`;
  const copyWebhookUrl = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await api.whatsappAccounts.list();
      setAccounts(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const startCreate = () => {
    setEditing(null);
    setForm({ displayName: '', label: '', displayPhoneNumber: '', phoneNumberId: '', wabaId: '', metaAppId: '', accessToken: '', verifyToken: '', isDefault: accounts.length === 0, isActive: true });
    setShowToken(false);
    setRevealedToken(null);
    setShowForm(true);
  };
  const startEdit = async (acc) => {
    setEditing(acc);
    setForm({
      // displayName = the stored account name; the label is edited separately
      // (acc.displayName from the API is the SHOWN name, i.e. the label when set).
      displayName: acc.accountName ?? acc.displayName, label: acc.label || '', displayPhoneNumber: acc.displayPhoneNumber,
      phoneNumberId: acc.phoneNumberId, wabaId: acc.wabaId, metaAppId: acc.metaAppId || '',
      accessToken: '', verifyToken: acc.verifyToken || '', isDefault: acc.isDefault, isActive: acc.isActive,
    });
    setShowToken(false);
    setRevealedToken(null);
    setShowForm(true);
  };

  // Eye toggle. When revealing an existing account whose token field is still
  // blank, fetch the decrypted token (admin-only ?reveal=1) so it's actually visible.
  const toggleShowToken = async () => {
    if (!showToken && editing && !form.accessToken) {
      setRevealingToken(true);
      try {
        const full = await api.whatsappAccounts.get(editing.id, true);
        if (full.accessToken) {
          setForm(f => ({ ...f, accessToken: full.accessToken }));
          setRevealedToken(full.accessToken);
        }
      } catch (err) {
        notify(err.message || 'Failed to reveal access token');
        setRevealingToken(false);
        return;
      }
      setRevealingToken(false);
    }
    setShowToken(s => !s);
  };

  const save = async () => {
    if (!form.displayName.trim() || !form.displayPhoneNumber.trim() || !form.phoneNumberId.trim() || !form.wabaId.trim()) {
      notify('Account name, phone, phone number ID, and WABA ID are required');
      return;
    }
    if (!editing && !form.accessToken.trim()) {
      notify('Access token is required for new accounts');
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const payload = { ...form };
        // Drop an unchanged token (blank, or the one we just revealed) so save
        // doesn't needlessly re-encrypt it and reset the account's health.
        if (!payload.accessToken || payload.accessToken === revealedToken) delete payload.accessToken;
        await api.whatsappAccounts.update(editing.id, payload);
      } else {
        const { label, ...createBody } = form;
        const created = await api.whatsappAccounts.create(createBody);
        if (label && label.trim() && created?.id) await api.whatsappAccounts.setLabel(created.id, label.trim());
      }
      setShowForm(false);
      await refresh();
    } catch (err) {
      notify(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.whatsappAccounts.delete(deleteTarget.id);
      setDeleteTarget(null);
      await refresh();
    } catch (err) {
      notify(err.message || 'Delete failed');
    }
  };

  const inpStyle = { width: '100%', padding: '8px 12px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 15, fontFamily: FONT, outline: 'none', background: 'var(--c-cardBg)', color: C.text };
  const labelStyle = { display: 'block', fontSize: 13, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, fontFamily: FONT };

  return (
    <div style={{ flex: 1, padding: '16px 28px 28px', overflow: 'auto', fontFamily: FONT }}>
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}.spin{animation:spin 1s linear infinite}`}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <div>
          <p style={{ fontSize: 14, color: C.textMuted, margin: '4px 0 0' }}>
            Business accounts (WABAs) used to send templates, broadcasts and automation messages.
          </p>
        </div>
        <button onClick={startCreate} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 14px', background: C.primary, color: '#fff', border: 'none',
          borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
        }}>
          <Plus size={15} /> Add account
        </button>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: C.textMuted }}>Loading…</div>
      ) : accounts.length === 0 ? (
        <div style={{
          padding: '48px 32px', textAlign: 'center', background: C.cardBg,
          border: `1px dashed ${C.border}`, borderRadius: 12, color: C.textMuted, fontSize: 15,
        }}>
          <MessageSquare size={36} style={{ opacity: 0.5, marginBottom: 12 }} />
          <div style={{ marginBottom: 6, color: C.textSecondary, fontWeight: 600 }}>No WhatsApp accounts yet</div>
          <div>Add your first account to start creating templates and broadcasts.</div>
        </div>
      ) : (
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--c-hover)', borderBottom: `1px solid ${C.border}` }}>
                <th style={thStyle}>Name shown in the app</th>
                <th style={thStyle}>Phone number</th>
                <th style={thStyle}>Phone number ID</th>
                <th style={thStyle}>WABA ID</th>
                <th style={thStyle}>Access token</th>
                <th style={thStyle}>Health</th>
                <th style={thStyle}>Status</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(acc => (
                <tr key={acc.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontWeight: 600 }}>{acc.displayName}</span>
                      <button onClick={() => setRenaming(acc)} style={{ ...iconBtnStyle, width: 26, height: 26 }} title="Rename this number (display label only)" aria-label={`Rename ${acc.displayName}`}>
                        <Pencil size={13} />
                      </button>
                      {acc.isDefault && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, padding: '2px 7px', background: 'var(--c-orangeBg, #FFF3E0)', color: 'var(--c-orangeText, #E65100)', borderRadius: 99, fontWeight: 700 }}>
                          <Star size={9} fill="currentColor" /> DEFAULT
                        </span>
                      )}
                    </div>
                  </td>
                  <td style={tdStyle}><MaskedNumber number={acc.displayPhoneNumber} /></td>
                  <td style={{ ...tdStyle, fontFamily: 'DM Mono, monospace', fontSize: 13 }}>{acc.phoneNumberId}</td>
                  <td style={{ ...tdStyle, fontFamily: 'DM Mono, monospace', fontSize: 13 }}>{acc.wabaId}</td>
                  <td style={{ ...tdStyle, fontFamily: 'DM Mono, monospace', fontSize: 13, color: C.textMuted }}>{acc.accessTokenMasked}</td>
                  <td style={tdStyle}>
                    {(() => {
                      const h = acc.healthStatus || 'unknown';
                      const styles = {
                        healthy: { bg: 'var(--c-successBg, #E1F5EE)', fg: 'var(--c-successText, #0F6E56)', label: 'Healthy' },
                        invalid_token: { bg: 'var(--c-dangerBg, #FCEBEB)', fg: 'var(--c-dangerText, #A32D2D)', label: 'Token expired' },
                        rate_limited: { bg: 'var(--c-orangeBg, #FFF3E0)', fg: 'var(--c-orangeText, #E65100)', label: 'Rate limited' },
                        unknown_error: { bg: 'var(--c-dangerBg, #FCEBEB)', fg: 'var(--c-dangerText, #A32D2D)', label: 'Error' },
                        unknown: { bg: 'var(--c-surfaceSubtle, #EEEDE8)', fg: C.textMuted, label: 'Not checked' },
                      };
                      const s = styles[h] || styles.unknown;
                      return (
                        <span title={acc.lastErrorMessage || ''} style={{ fontSize: 13, padding: '3px 8px', borderRadius: 99, fontWeight: 600, background: s.bg, color: s.fg }}>
                          {s.label}
                        </span>
                      );
                    })()}
                  </td>
                  <td style={tdStyle}>
                    <span style={{
                      fontSize: 13, padding: '3px 8px', borderRadius: 99, fontWeight: 600,
                      background: acc.isActive ? 'var(--c-successBg, #E1F5EE)' : 'var(--c-surfaceSubtle, #EEEDE8)',
                      color: acc.isActive ? 'var(--c-successText, #0F6E56)' : C.textMuted,
                    }}>
                      {acc.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    <button onClick={() => startEdit(acc)} style={iconBtnStyle} title="Edit">
                      <Eye size={14} />
                    </button>
                    <button onClick={() => setDeleteTarget(acc)} style={{ ...iconBtnStyle, color: 'var(--c-dangerText, #A32D2D)' }} title="Delete">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Form modal */}
      {showForm && (
        <div onClick={() => setShowForm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, width: 520, maxHeight: 'calc(90vh / var(--fg-zoom, 1))', overflow: 'auto', boxShadow: C.shadowLg, padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <h3 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: 0 }}>
                {editing ? 'Edit WhatsApp account' : 'New WhatsApp account'}
              </h3>
              <button onClick={() => setShowForm(false)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted }}><X size={20} /></button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={labelStyle}>Account name</label>
                <input style={inpStyle} value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} placeholder="e.g. Acme Main" autoFocus autoComplete="off" name="wa-display-name" />
              </div>
              <div>
                <label style={labelStyle}>Label (optional)</label>
                <input style={inpStyle} value={form.label} maxLength={60} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="e.g. Acme – Sales desk" autoComplete="off" name="wa-label" />
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>
                  A short name shown everywhere you pick or see this number. It does not change the number or the name customers see on WhatsApp. Leave blank to show the account name.
                </div>
              </div>
              <div>
                <label style={labelStyle}>WhatsApp phone number</label>
                <input style={inpStyle} value={form.displayPhoneNumber} onChange={e => setForm({ ...form, displayPhoneNumber: e.target.value })} placeholder="919876543210" autoComplete="off" name="wa-display-phone" inputMode="numeric" />
              </div>
              <div>
                <label style={labelStyle}>Phone number ID (from Meta)</label>
                <input style={{ ...inpStyle, fontFamily: 'DM Mono, monospace' }} value={form.phoneNumberId} onChange={e => setForm({ ...form, phoneNumberId: e.target.value })} placeholder="123456789012345" autoComplete="off" name="wa-phone-number-id" inputMode="numeric" />
              </div>
              <div>
                <label style={labelStyle}>WhatsApp Business Account ID (WABA)</label>
                <input style={{ ...inpStyle, fontFamily: 'DM Mono, monospace' }} value={form.wabaId} onChange={e => setForm({ ...form, wabaId: e.target.value })} placeholder="234567890123456" autoComplete="off" name="wa-waba-id" inputMode="numeric" />
              </div>
              <div>
                <label style={labelStyle}>Meta App ID <span style={{ color: C.textMuted, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(only required for media-header templates)</span></label>
                <input style={{ ...inpStyle, fontFamily: 'DM Mono, monospace' }} value={form.metaAppId} onChange={e => setForm({ ...form, metaAppId: e.target.value })} placeholder="e.g. 345678901234567 (15–16 digits)" autoComplete="off" name="meta-app-id" inputMode="numeric" />
              </div>
              <div>
                <label style={labelStyle}>
                  System User access token {editing && <span style={{ color: C.textMuted, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(leave blank to keep existing)</span>}
                </label>
                <div style={{ position: 'relative' }}>
                  <input
                    style={{ ...inpStyle, paddingRight: 38, fontFamily: 'DM Mono, monospace', fontSize: 13 }}
                    type={showToken ? 'text' : 'password'}
                    value={form.accessToken}
                    onChange={e => setForm({ ...form, accessToken: e.target.value })}
                    placeholder={editing ? '••••••••' : 'EAAQ7…'}
                    autoComplete="new-password"
                    name="wa-system-user-token"
                  />
                  <button type="button" onClick={toggleShowToken} disabled={revealingToken} title={showToken ? 'Hide token' : 'Show token'} style={{ position: 'absolute', right: 8, top: 8, background: 'none', border: 'none', cursor: revealingToken ? 'default' : 'pointer', color: C.textMuted, padding: 4 }}>
                    {revealingToken ? <Loader2 size={14} className="spin" /> : showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Key size={10} /> Encrypted at rest with AES-256-GCM.
                </div>
              </div>
              <div>
                <label style={labelStyle}>Webhook verify token <span style={{ color: C.textMuted, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
                <input style={inpStyle} value={form.verifyToken} onChange={e => setForm({ ...form, verifyToken: e.target.value })} placeholder="Create a custom verify token" autoComplete="off" name="wa-verify-token" />
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>
                  A custom string you choose. Must match the <strong>Verify token</strong> you enter in Meta → App → WhatsApp → Configuration. Leave blank to use the server's default token.
                </div>
              </div>

              {/* Webhook Configuration */}
              <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
                <h4 style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: '0 0 2px' }}>Webhook configuration</h4>
                <p style={{ fontSize: 14, color: C.textMuted, margin: '0 0 10px' }}>Use this URL as the <strong>Callback URL</strong> in the Meta App Dashboard, with the verify token above.</p>
                <label style={labelStyle}>Webhook callback URL</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    readOnly
                    value={webhookUrl}
                    onFocus={e => e.target.select()}
                    style={{ ...inpStyle, fontFamily: 'DM Mono, monospace', fontSize: 14, background: 'var(--c-hover)', color: C.textSecondary }}
                  />
                  <button type="button" onClick={copyWebhookUrl} title={copied ? 'Copied!' : 'Copy URL'} style={{ flexShrink: 0, width: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, borderRadius: 8, cursor: 'pointer', color: copied ? C.green : C.textSecondary }}>
                    {copied ? <Check size={15} /> : <Copy size={15} />}
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 15, color: C.text, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.isDefault} onChange={e => setForm({ ...form, isDefault: e.target.checked })} /> Default account
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 15, color: C.text, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.isActive} onChange={e => setForm({ ...form, isActive: e.target.checked })} /> Active
                </label>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
              <button onClick={() => setShowForm(false)} disabled={saving} style={{ padding: '8px 16px', background: 'var(--c-cardBg)', color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ padding: '8px 16px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: saving ? 'wait' : 'pointer', fontFamily: FONT, display: 'flex', alignItems: 'center', gap: 6 }}>
                {saving && <Loader2 size={14} className="spin" />}
                {editing ? 'Save changes' : 'Create account'}
              </button>
            </div>
          </div>
        </div>
      )}

      <DeleteConfirmModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={doDelete}
        itemName={deleteTarget?.displayName || ''}
        itemType="WhatsApp account"
      />
      {renaming && (
        <RenameNumberModal
          accountId={renaming.id}
          phone={renaming.displayPhoneNumber}
          currentLabel={renaming.label}
          accountName={renaming.accountName}
          onClose={() => setRenaming(null)}
          onSaved={() => refresh()}
        />
      )}
    </div>
  );
}

const thStyle = { textAlign: 'left', padding: '12px 16px', fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.04em' };
const tdStyle = { padding: '14px 16px', fontSize: 15, color: C.text, verticalAlign: 'middle' };
const iconBtnStyle = { background: 'transparent', border: 'none', cursor: 'pointer', padding: 6, marginLeft: 4, color: C.textSecondary };

/*  Main Page                                                          */
/* ------------------------------------------------------------------ */
export default function AdminSettingsPage({ onLogout, onNavigate, subParts = [], navigate, user }) {
  // DERIVED from TABS, never restated. A hand-maintained copy silently drifts:
  // a tab missing from this list still RENDERS its button, and clicking it
  // falls through to visibleTabs[0] — so the tab appears to exist and does
  // nothing. That is exactly how the Message Costs tab shipped broken.
  const VALID_TABS = TABS.map(t => t.key);
  // Filter tabs to those this user is allowed to see. Admin sees everything;
  // non-admins must have 'admin-settings:<tab>' in their pages array.
  const isAdmin = user?.role === 'admin';
  const userPages = new Set(user?.pages || []);
  const hasSocial = isAdmin || userPages.has('social');
  const mainAllowed = (t) => !t.socialOnly && (isAdmin || userPages.has(`admin-settings:${t.key}`));
  const socialAllowed = (t) => !!SOCIAL_PARTS[t.key] && hasSocial && (SOCIAL_PARTS[t.key] === 'social' || isAdmin);
  const visibleTabs = TABS.filter(t => mainAllowed(t) || socialAllowed(t));
  const allowedTabKeys = new Set(visibleTabs.map(t => t.key));
  const activeTab = VALID_TABS.includes(subParts[0]) && allowedTabKeys.has(subParts[0])
    ? subParts[0]
    : (visibleTabs[0]?.key || 'general');
  const activeDef = TABS.find(t => t.key === activeTab) || TABS[0];
  const canMain = mainAllowed(activeDef);
  const canSocial = socialAllowed(activeDef);
  // Which half of the tab is open: #/admin-settings/<tab>/social[/<platform>].
  const side = !canMain ? 'social' : (canSocial && subParts[1] === 'social' ? 'social' : 'main');
  const socialPlatform = side === 'social' ? (subParts[2] || null) : null;
  const setActiveTab = (t) => navigate ? navigate('admin-settings', t) : null;
  const setSide = (v) => navigate ? (v === 'social' ? navigate('admin-settings', activeTab, 'social') : navigate('admin-settings', activeTab)) : null;
  const [categories, setCategories] = useState([]);
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [categoryDetailId, setCategoryDetailId] = useState(null);
  const [showCategoryAddForm, setShowCategoryAddForm] = useState(false);

  const refresh = async () => {
    try {
      const [catRes, tagRes] = await Promise.all([
        api.categories.list(),
        api.tags.list(),
      ]);
      setCategories(catRes);
      setTags(tagRes);
    } catch (err) {
      console.error('Failed to load settings data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleTabChange = (key) => {
    setActiveTab(key);
    setCategoryDetailId(null);
  };

  const handleRequestAddCategory = () => {
    setShowCategoryAddForm(true);
    setActiveTab('category');
  };

  // Every tab opens with the same header: its title, and — when the tab has a
  // Social half — the "Sales & Chats | Social" switch beside it, so the switch
  // reads as part of this tab rather than as a page of its own.
  const renderTab = () => {
    const header = (
      <div style={{ padding: '24px 28px 4px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 780, letterSpacing: '-0.02em', color: C.text, fontFamily: FONT }}>{activeDef.label}</h1>
        {canMain && canSocial && (
          <PillStrip size="sm" value={side} onChange={setSide}
            items={[{ id: 'main', label: 'Sales & Chats' }, { id: 'social', label: 'Social' }]} />
        )}
      </div>
    );
    if (side === 'social') {
      return (
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
          {header}
          <div style={{ padding: '0 28px 28px' }}>
            <SocialSettingsPart part={activeTab} platform={socialPlatform} user={user} />
          </div>
        </div>
      );
    }
    return (
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {header}
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>{renderMainTab()}</div>
      </div>
    );
  };

  const renderMainTab = () => {
    if (loading) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.textMuted, fontSize: 15 }}>
          Loading…
        </div>
      );
    }
    switch (activeTab) {
      case 'general': return <GeneralTab onLogout={onLogout} user={user} />;
      case 'tags': return (
        <TagsTab
          categories={categories}
          tags={tags}
          onRefresh={refresh}
        />
      );
      case 'category': return (
        <CategoryTab
          categories={categories}
          tags={tags}
          onRefresh={refresh}
          detailId={categoryDetailId}
          onViewDetail={setCategoryDetailId}
          onBack={() => setCategoryDetailId(null)}
          showAddForm={showCategoryAddForm}
          onAddFormShown={() => setShowCategoryAddForm(false)}
        />
      );
      case 'fields': return <FieldsTab />;
      case 'funnel': return <FunnelSettingsTab navigate={navigate} />;
      case 'whatsapp-accounts': return <WhatsappAccountsTab />;
      case 'ai-models': return <AIModelsTab navigate={navigate} />;
      case 'integrations': return <IntegrationsTab />;
      case 'mcp': return <McpToolsTab />;
      case 'users': return <UsersTab />;
      case 'webhooks': return <WebhooksTab />;
      default: return <GeneralTab onLogout={onLogout} user={user} />;
    }
  };

  return (
    <div style={{ display: 'flex', flex: 1, height: '100%', overflow: 'hidden', background: C.pageBg }}>
      <div style={{
        width: 248, minWidth: 248, background: 'transparent',
        display: 'flex', flexDirection: 'column', flexShrink: 0,
        padding: 12,
      }}>
        <button
          onClick={() => onNavigate('home')}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '12px 14px', marginBottom: 10, borderRadius: 999,
            border: 'none', background: 'transparent', cursor: 'pointer',
            fontFamily: FONT, fontSize: 16, fontWeight: 550,
            color: C.textSecondary, textAlign: 'left',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--fc-surface)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
        >
          <ArrowLeft size={16} /> Back to home
        </button>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {TAB_GROUPS.map(g => ({ ...g, tabs: visibleTabs.filter(t => t.group === g.key) })).filter(g => g.tabs.length).map(g => (
          <div key={g.key} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 650, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '6px 0 6px', paddingLeft: 14 }}>
              {g.label}
            </div>
        {g.tabs.map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => handleTabChange(tab.key)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                padding: '9px 14px', borderRadius: 999, border: 'none',
                background: isActive ? C.primary : 'transparent',
                cursor: 'pointer', fontFamily: FONT, fontSize: 15,
                fontWeight: isActive ? 780 : 550,
                color: isActive ? '#fff' : C.textSecondary,
                textAlign: 'left', marginBottom: 2, transition: 'background .15s',
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--fc-surface)'; }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
            >
              <Icon size={17} strokeWidth={isActive ? 2.4 : 2} />
              {tab.label}
            </button>
          );
        })}
          </div>
        ))}
        </div>
      </div>

      {renderTab()}
    </div>
  );
}

// ─── Funnel Tab ───────────────────────────────────────────────────────────────
// Configure funnel stages (ordered, drag-to-reorder), lead sources, and products.
// Content lives in pages/sales/FunnelSettingsPage.jsx (also usable standalone).
function FunnelSettingsTab({ navigate }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '16px 28px 28px', overflow: 'auto', fontFamily: FONT }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 15, color: C.textSecondary }}>
          Configure your funnel stages, lead sources, and products. These drive the Sales → Funnel chart and sales entry.
        </div>
      </div>
      <FunnelSettingsContent navigate={navigate} />
    </div>
  );
}

// ─── Webhooks Tab ─────────────────────────────────────────────────────────────
// Lists every inbound Meta/n8n webhook payload, with filters + detail drawer +
// replay button. Used to debug parser issues, trigger evaluation, and to
// reproduce production payloads against local code.

const WEBHOOK_KIND_COLORS = {
  messages:                  { bg: 'var(--c-successBgSoft, #E4F3EE)', color: 'var(--c-successText, #0F6E56)', label: 'messages' },
  message_echoes:            { bg: 'var(--c-sdcedc8, #DCEDC8)', color: 'var(--c-x33691e, #33691E)', label: 'message_echoes' },
  smb_message_echoes:        { bg: 'var(--c-sc8e6c9, #C8E6C9)', color: 'var(--c-x1b5e20, #1B5E20)', label: 'smb_echoes' },
  statuses:                  { bg: 'var(--c-infoBg, #E3F2FD)', color: 'var(--c-infoText, #1565C0)', label: 'statuses' },
  template_status_update:    { bg: 'var(--c-orangeBg, #FFF3E0)', color: 'var(--c-orangeText, #E65100)', label: 'template_status_update' },
  account_update:            { bg: 'var(--c-purpleBg, #F3E5F5)', color: 'var(--c-x6a1b9a, #6A1B9A)', label: 'account_update' },
  verify:                    { bg: 'var(--c-surfaceSubtle, #EEEDE8)', color: 'var(--c-t4, #666)',    label: 'verify' },
  unknown:                   { bg: 'var(--c-surfaceSubtle, #EEEDE8)', color: 'var(--c-t4, #666)',    label: 'unknown' },
};
const WEBHOOK_STATUS_COLORS = {
  processed: { bg: 'var(--c-successBgSoft, #E4F3EE)', color: 'var(--c-successText, #0F6E56)' },
  partial:   { bg: 'var(--c-warnBgSoft, #FFF8E1)', color: 'var(--c-s7a5500, #7A5500)' },
  error:     { bg: 'var(--c-dangerBg, #FCEBEB)', color: 'var(--c-dangerText, #A32D2D)' },
  received:  { bg: 'var(--c-surfaceSubtle, #EEEDE8)', color: 'var(--c-t4, #666)' },
  verified:  { bg: 'var(--c-infoBg, #E3F2FD)', color: 'var(--c-infoText, #1565C0)' },
};

// Pretty-print JSON with simple syntax highlighting (string=green, number=blue,
// bool/null=purple, key=brown). Avoids dragging in a heavy JSON viewer lib.
function syntaxHighlight(json) {
  if (typeof json !== 'string') json = JSON.stringify(json, null, 2);
  // Escape HTML first
  json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = '#1565C0'; // number
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? '#7A5500' : '#0F6E56'; // key vs string
      } else if (/true|false/.test(match)) cls = '#6A1B9A';
      else if (/null/.test(match)) cls = '#A32D2D';
      return `<span style="color:${cls}">${match}</span>`;
    }
  );
}

function WebhookDetailDrawer({ id, onClose, onChanged }) {
  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showHeaders, setShowHeaders] = useState(false);
  const [copied, setCopied] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [replayResult, setReplayResult] = useState(null);

  useEffect(() => {
    setLoading(true);
    api.webhookEvents.get(id).then(e => { setEvent(e); setLoading(false); }).catch(err => { notify(err.message); setLoading(false); });
  }, [id]);

  const copyJson = async () => {
    await navigator.clipboard.writeText(JSON.stringify(event?.payload, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const replay = async () => {
    if (!confirm('Replay this payload through the webhook handler? This will re-insert chat_history rows and re-fire automation triggers.')) return;
    try {
      setReplaying(true);
      setReplayResult(null);
      const r = await api.webhookEvents.replay(id);
      setReplayResult({ ok: r.ok, msg: `Status ${r.status} · ${JSON.stringify(r.response).slice(0, 200)}` });
      onChanged?.();
    } catch (err) {
      setReplayResult({ ok: false, msg: err.message });
    } finally {
      setReplaying(false);
    }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 250, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 720, maxWidth: 'calc(94vw / var(--fg-zoom, 1))', height: '100%', background: 'var(--c-cardBg)', boxShadow: C.shadowLg, display: 'flex', flexDirection: 'column', fontFamily: FONT, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--c-borderSubtle, #EEEDE8)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-text)' }}>Webhook Event #{id}</div>
            {event && <div style={{ fontSize: 13, color: 'var(--c-t6, #888)', marginTop: 2 }}>{new Date(event.received_at).toLocaleString('en-IN')} · {event.source || 'meta'} · {event.remote_ip || '—'}</div>}
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--c-t4, #666)' }}><X size={20} /></button>
        </div>

        {loading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--c-t6, #888)' }}><Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /></div>}

        {!loading && event && (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {/* Processing summary */}
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--c-borderSubtle, #EEEDE8)', background: 'var(--c-hover)', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, fontSize: 13 }}>
              <div><div style={{ color: 'var(--c-t6, #888)', textTransform: 'uppercase', fontSize: 12, letterSpacing: '.05em', marginBottom: 2 }}>Status</div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 99, ...(WEBHOOK_STATUS_COLORS[event.processing_status] || WEBHOOK_STATUS_COLORS.received), fontSize: 13, fontWeight: 700 }}>
                  {event.processing_status === 'error' ? <AlertCircle size={11} /> : event.processing_status === 'processed' || event.processing_status === 'verified' ? <CheckCircle2 size={11} /> : null}
                  {event.processing_status}
                </span>
              </div>
              <div><div style={{ color: 'var(--c-t6, #888)', textTransform: 'uppercase', fontSize: 12, letterSpacing: '.05em', marginBottom: 2 }}>Records extracted</div>
                <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 15, fontWeight: 700, color: 'var(--c-text)' }}>{event.records_extracted ?? 0}</div>
              </div>
              <div><div style={{ color: 'var(--c-t6, #888)', textTransform: 'uppercase', fontSize: 12, letterSpacing: '.05em', marginBottom: 2 }}>Processing time</div>
                <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 15, fontWeight: 700, color: 'var(--c-text)' }}>{event.processing_ms != null ? `${event.processing_ms}ms` : '—'}</div>
              </div>
            </div>

            {event.processing_error && (
              <div style={{ margin: '12px 20px', padding: '10px 12px', background: 'var(--c-primaryLight)', color: 'var(--c-dangerText, #A32D2D)', borderRadius: 8, fontSize: 14, fontFamily: 'DM Mono, monospace' }}>
                <strong>Error:</strong> {event.processing_error}
              </div>
            )}

            {/* Actions row */}
            <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--c-borderSubtle, #EEEDE8)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={copyJson} style={btnSecondary}>
                {copied ? <CheckCircle2 size={12} /> : null} {copied ? 'Copied' : 'Copy payload'}
              </button>
              <button onClick={replay} disabled={replaying} style={{ ...btnSecondary, color: 'var(--c-primary, #dc2626)', borderColor: '#FCC' }}>
                {replaying ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={12} />} Replay
              </button>
              <button onClick={() => setShowHeaders(!showHeaders)} style={btnSecondary}>
                {showHeaders ? 'Hide' : 'Show'} headers
              </button>
            </div>

            {replayResult && (
              <div style={{ margin: '0 20px 12px', padding: '10px 12px', borderRadius: 8, fontSize: 14, background: replayResult.ok ? 'var(--c-successBgSoft, #E4F3EE)' : 'var(--c-primaryLight)', color: replayResult.ok ? 'var(--c-successText, #0F6E56)' : 'var(--c-dangerText, #A32D2D)' }}>
                {replayResult.ok ? '✓ ' : '⚠ '} {replayResult.msg}
              </div>
            )}

            {/* Headers (collapsed by default) */}
            {showHeaders && event.request_headers && (
              <div style={{ padding: '0 20px 12px' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-t4, #666)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.05em' }}>Request headers</div>
                <pre style={{ background: 'var(--c-hover)', border: '1px solid var(--c-borderSubtle, #EEEDE8)', borderRadius: 8, padding: 12, fontSize: 13, fontFamily: 'DM Mono, monospace', overflowX: 'auto', margin: 0 }}>{JSON.stringify(event.request_headers, null, 2)}</pre>
              </div>
            )}

            {/* Payload — pretty-printed with syntax highlighting */}
            <div style={{ padding: '0 20px 20px' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-t4, #666)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.05em', display: 'flex', justifyContent: 'space-between' }}>
                <span>Payload ({event.payload_kind || 'unknown'})</span>
                <span style={{ fontFamily: 'DM Mono, monospace', color: 'var(--c-t6, #888)', textTransform: 'none', letterSpacing: 0 }}>{JSON.stringify(event.payload).length.toLocaleString()} bytes</span>
              </div>
              <pre
                style={{ background: 'var(--c-hover)', border: '1px solid var(--c-borderSubtle, #EEEDE8)', borderRadius: 8, padding: 14, fontSize: 14, fontFamily: 'DM Mono, monospace', lineHeight: 1.5, overflowX: 'auto', margin: 0, color: 'var(--c-s333333, #333)' }}
                dangerouslySetInnerHTML={{ __html: syntaxHighlight(JSON.stringify(event.payload, null, 2)) }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const btnSecondary = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', border: '1px solid var(--c-borderStrong, #D5D5D0)', borderRadius: 6, background: 'var(--c-cardBg)', color: 'var(--c-s333333, #333)', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: FONT };

/* ------------------------------------------------------------------ */
/*  AI Models                                                          */
/* ------------------------------------------------------------------ */
const AI_PROVIDER_OPTIONS = [
  { value: 'openai',    label: 'OpenAI',          accent: '#10A37F' },
  { value: 'anthropic', label: 'Anthropic Claude', accent: '#C99B7A' },
  { value: 'kimi',      label: 'Moonshot / Kimi', accent: 'var(--c-x7e58c6, #7E58C6)' },
  { value: 'gemini',    label: 'Google Gemini',   accent: '#4285F4' },
  { value: 'openrouter', label: 'OpenRouter',     accent: '#6467F2' },
];
const providerOpt = (v) => AI_PROVIDER_OPTIONS.find(o => o.value === v) || { label: v, accent: C.textMuted };

function AIModelsTab({ navigate }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ provider: 'openai', label: '', apiKey: '', baseUrl: '' });
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [revealedKeys, setRevealedKeys] = useState({}); // id -> plaintext key
  const [syncingId, setSyncingId] = useState(null);
  const [expandedModelsId, setExpandedModelsId] = useState(null);
  const [usageRow, setUsageRow] = useState(null);      // the credential we opened
  const [usageData, setUsageData] = useState(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState('');
  const [activityItems, setActivityItems] = useState([]);
  const [activityTotal, setActivityTotal] = useState(0);
  const [activityLoadingMore, setActivityLoadingMore] = useState(false);
  const [activityFiltering, setActivityFiltering] = useState(false);
  const [activityFilters, setActivityFilters] = useState({ status: 'all', model: '', from: '', to: '' });
  const ACTIVITY_PAGE = 20;
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [error, setError] = useState('');

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await api.aiModels.list();
      setItems(data);
    } catch (err) {
      console.error('[ai-models]', err);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); }, []);

  const openAdd = () => {
    setForm({ provider: 'openai', label: '', apiKey: '', baseUrl: '' });
    setError('');
    setShowKey(false);
    setShowForm(true);
  };

  const save = async () => {
    setError('');
    if (!form.provider) { setError('Pick a provider'); return; }
    if (!form.apiKey.trim()) { setError('API key is required'); return; }
    setSaving(true);
    try {
      await api.aiModels.create({
        provider: form.provider,
        label: form.label.trim() || null,
        apiKey: form.apiKey.trim(),
        baseUrl: form.baseUrl.trim() || null,
      });
      setShowForm(false);
      await refresh();
    } catch (err) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const toggleReveal = async (row) => {
    if (revealedKeys[row.id]) {
      setRevealedKeys(prev => { const c = { ...prev }; delete c[row.id]; return c; });
      return;
    }
    try {
      const r = await api.aiModels.get(row.id, true);
      setRevealedKeys(prev => ({ ...prev, [row.id]: r.apiKey }));
    } catch (err) {
      notify(err.message || 'Failed to reveal key');
    }
  };

  const toggleModelEnabled = async (row, modelId) => {
    const available = (row.availableModels || []).map(m => m.id);
    const currentEnabled = Array.isArray(row.enabledModels)
      ? row.enabledModels.filter(id => available.includes(id))
      : available.slice(); // null/undefined means all enabled
    const isOn = currentEnabled.includes(modelId);
    const next = isOn
      ? currentEnabled.filter(id => id !== modelId)
      : [...currentEnabled, modelId];
    // Optimistic update
    setItems(prev => prev.map(it => it.id === row.id ? { ...it, enabledModels: next } : it));
    try {
      await api.aiModels.update(row.id, { enabledModels: next });
    } catch (err) {
      notify(err.message || 'Failed to update selection');
      await refresh();
    }
  };

  const openUsage = async (row) => {
    setUsageRow(row);
    setUsageData(null);
    setUsageError('');
    setActivityItems([]);
    setActivityTotal(0);
    setActivityFilters({ status: 'all', model: '', from: '', to: '' });
    setUsageLoading(true);
    try {
      const data = await api.aiModels.usage(row.id);
      setUsageData(data);
      setActivityItems(data.recentCalls || []);
      setActivityTotal(data.activity?.total ?? (data.recentCalls?.length || 0));
    } catch (err) {
      setUsageError(err.message || 'Failed to load usage');
    } finally {
      setUsageLoading(false);
    }
  };
  const loadMoreActivity = async () => {
    if (!usageRow || activityLoadingMore || activityItems.length >= activityTotal) return;
    setActivityLoadingMore(true);
    try {
      const page = await api.aiModels.activity(usageRow.id, { limit: ACTIVITY_PAGE, offset: activityItems.length, ...activityFilters });
      setActivityItems(prev => [...prev, ...(page.items || [])]);
      setActivityTotal(page.total);
    } catch (err) {
      notify(err.message || 'Failed to load more activity');
    } finally {
      setActivityLoadingMore(false);
    }
  };

  // Called whenever a filter changes — refetches page 1 with the new filters
  const applyActivityFilters = async (nextFilters) => {
    if (!usageRow) return;
    setActivityFilters(nextFilters);
    setActivityFiltering(true);
    try {
      const page = await api.aiModels.activity(usageRow.id, { limit: ACTIVITY_PAGE, offset: 0, ...nextFilters });
      setActivityItems(page.items || []);
      setActivityTotal(page.total);
    } catch (err) {
      notify(err.message || 'Failed to filter activity');
    } finally {
      setActivityFiltering(false);
    }
  };
  const closeUsage = () => {
    setUsageRow(null);
    setUsageData(null);
    setUsageError('');
    setActivityItems([]);
    setActivityTotal(0);
  };

  const syncOne = async (row) => {
    setSyncingId(row.id);
    try {
      await api.aiModels.sync(row.id);
      await refresh();
    } catch (err) {
      notify(err.message || 'Sync failed');
    } finally {
      setSyncingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleteConfirmText.trim().toLowerCase() !== 'delete') return;
    try {
      await api.aiModels.delete(deleteTarget.id);
      setDeleteTarget(null);
      setDeleteConfirmText('');
      await refresh();
    } catch (err) {
      notify(err.message || 'Delete failed');
    }
  };

  const fmtDate = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  const inpStyle = { width: '100%', padding: '8px 12px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 15, fontFamily: FONT, outline: 'none', background: 'var(--c-cardBg)', color: C.text };
  const labelStyle = { display: 'block', fontSize: 13, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, fontFamily: FONT };

  return (
    <div style={{ flex: 1, padding: '16px 28px 28px', overflow: 'auto', fontFamily: FONT }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <div>
          <p style={{ fontSize: 14, color: C.textMuted, margin: '4px 0 0' }}>
            Connect AI provider API keys. Available models are discovered automatically on save.
          </p>
        </div>
        <button onClick={openAdd} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 14px', background: C.primary, color: '#fff', border: 'none',
          borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
        }}>
          <Plus size={15} /> Add AI Model
        </button>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: C.textMuted, fontSize: 15 }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, borderRadius: 10, color: C.textMuted, fontSize: 15 }}>
          No AI models connected yet. Click "Add AI Model" to connect your first provider.
        </div>
      ) : (
        <div style={{ background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15, tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '18%' }}/>
              <col style={{ width: '22%' }}/>
              <col style={{ width: '30%' }}/>
              <col style={{ width: '12%' }}/>
              <col style={{ width: '18%', minWidth: 210 }}/>
            </colgroup>
            <thead>
              <tr style={{ background: C.pageBg, borderBottom: `1px solid ${C.border}` }}>
                <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Provider</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>API Key</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Available Models</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Created</th>
                <th style={{ textAlign: 'right', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em', width: 130 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map(row => {
                const prov = providerOpt(row.provider);
                const models = Array.isArray(row.availableModels) ? row.availableModels : [];
                const revealed = revealedKeys[row.id];
                return (
                  <tr key={row.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td onClick={() => openUsage(row)} title="Click to open usage dashboard" style={{ padding: '12px 16px', verticalAlign: 'top', cursor: 'pointer' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: prov.accent, flexShrink: 0 }}/>
                        <div>
                          <div style={{ fontWeight: 600, color: C.text, textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}>{prov.label}</div>
                          {row.label && <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>{row.label}</div>}
                          {row.provider === 'openrouter' && (
                            <div data-testid="openrouter-stt-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 6, padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600, background: 'var(--c-infoBg, #EEF2FF)', color: C.text, whiteSpace: 'nowrap' }} title="Transcribes WhatsApp voice notes with Microsoft MAI-Transcribe 2">
                              <Mic size={12}/> Voice transcription
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '12px 16px', verticalAlign: 'top', fontFamily: 'DM Mono, monospace', fontSize: 14 }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, minWidth: 0 }}>
                        <span style={{
                          color: revealed ? C.text : C.textSecondary,
                          flex: 1,
                          minWidth: 0,
                          wordBreak: 'break-all',
                          overflowWrap: 'anywhere',
                        }}>
                          {revealed || row.apiKeyMasked || '••••••'}
                        </span>
                        <button onClick={() => toggleReveal(row)} title={revealed ? 'Hide' : 'Reveal'} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: C.textMuted, display: 'inline-flex', padding: 2, flexShrink: 0 }}>
                          {revealed ? <EyeOff size={14}/> : <Eye size={14}/>}
                        </button>
                      </div>
                    </td>
                    <td style={{ padding: '12px 16px', verticalAlign: 'top' }}>
                      {models.length === 0 ? (
                        <span style={{ color: C.textMuted, fontSize: 14, fontStyle: 'italic' }}>none cached</span>
                      ) : (() => {
                        const isExpanded = expandedModelsId === row.id;
                        const enabledList = Array.isArray(row.enabledModels)
                          ? row.enabledModels
                          : models.map(m => m.id); // null = all enabled
                        const enabledSet = new Set(enabledList);
                        const enabledModels = models.filter(m => enabledSet.has(m.id));
                        const disabledModels = models.filter(m => !enabledSet.has(m.id));
                        const visibleEnabled = isExpanded ? enabledModels : enabledModels.slice(0, 6);
                        return (
                          <>
                            {/* Enabled chips (collapsed view shows these) */}
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                              {visibleEnabled.length === 0 && !isExpanded && (
                                <span style={{ fontSize: 13, color: C.textMuted, fontStyle: 'italic' }}>No models enabled</span>
                              )}
                              {visibleEnabled.map((m, i) => (
                                <button
                                  key={'on'+i}
                                  type="button"
                                  onClick={() => toggleModelEnabled(row, m.id)}
                                  title={`Click to disable. ${m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id}`}
                                  style={{
                                    fontSize: 13, fontFamily: 'DM Mono, monospace', padding: '2px 8px',
                                    background: 'var(--c-successBgSoft, #E5F2EE)', color: 'var(--c-successText, #0F6E56)', borderRadius: 999,
                                    border: '1px solid var(--c-successBorder, #B8DCCF)', cursor: 'pointer',
                                  }}>
                                  {m.id}
                                </button>
                              ))}
                              {!isExpanded && enabledModels.length > 6 && (
                                <span style={{ fontSize: 13, color: C.textMuted, alignSelf: 'center' }}>+{enabledModels.length - 6} more</span>
                              )}
                            </div>

                            {/* Expanded: show disabled chips and a counter */}
                            {isExpanded && disabledModels.length > 0 && (
                              <>
                                <div style={{ fontSize: 12, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginTop: 8, marginBottom: 4 }}>Disabled — click to enable</div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                  {disabledModels.map((m, i) => (
                                    <button
                                      key={'off'+i}
                                      type="button"
                                      onClick={() => toggleModelEnabled(row, m.id)}
                                      title={`Click to enable. ${m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id}`}
                                      style={{
                                        fontSize: 13, fontFamily: 'DM Mono, monospace', padding: '2px 8px',
                                        background: 'var(--c-surfaceInner, #F8F8F4)', color: C.textMuted, borderRadius: 999,
                                        border: `1px dashed ${C.border}`, cursor: 'pointer',
                                        textDecoration: 'line-through',
                                      }}>
                                      {m.id}
                                    </button>
                                  ))}
                                </div>
                              </>
                            )}

                            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 10 }}>
                              <button
                                type="button"
                                onClick={() => setExpandedModelsId(isExpanded ? null : row.id)}
                                style={{ background: 'transparent', border: 'none', color: C.primary, fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: FONT }}>
                                {isExpanded ? 'Done' : `Manage (${enabledModels.length}/${models.length} enabled)`}
                              </button>
                            </div>
                          </>
                        );
                      })()}
                      {row.lastSyncError && (
                        <div style={{ marginTop: 6, fontSize: 13, color: 'var(--c-dangerText, #A32D2D)' }}>Last sync error: {row.lastSyncError}</div>
                      )}
                    </td>
                    <td style={{ padding: '12px 16px', verticalAlign: 'top', color: C.textSecondary, fontSize: 14 }}>{fmtDate(row.createdAt)}</td>
                    <td style={{ padding: '12px 16px', verticalAlign: 'top' }}>
                      <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap', gap: 6, justifyContent: 'flex-end' }}>
                        <button onClick={() => syncOne(row)} disabled={syncingId === row.id} title="Refresh available models" style={{ ...btnSecondary, opacity: syncingId === row.id ? 0.6 : 1, whiteSpace: 'nowrap' }}>
                          {syncingId === row.id ? <Loader2 size={12} className="spin"/> : <RefreshCw size={12}/>}
                          {syncingId === row.id ? 'Syncing' : 'Sync'}
                        </button>
                        <button onClick={() => { setDeleteTarget(row); setDeleteConfirmText(''); }} title="Delete" style={{ ...btnSecondary, color: 'var(--c-dangerText, #A32D2D)', whiteSpace: 'nowrap' }}>
                          <Trash2 size={12}/> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add modal */}
      {showForm && (
        <div onClick={() => !saving && setShowForm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, boxShadow: C.shadowLg, width: 460, padding: 24, fontFamily: FONT }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>Add AI Model</h3>
            <p style={{ margin: '4px 0 18px', fontSize: 14, color: C.textMuted }}>
              Your key will be encrypted at rest. We'll call the provider's models endpoint to verify it works.
            </p>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Provider</label>
              <SearchableSelect
                value={form.provider}
                onChange={v => setForm(f => ({ ...f, provider: v, baseUrl: '' }))}
                options={AI_PROVIDER_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
                searchPlaceholder="Search providers…"
                style={{ width: '100%' }}
                triggerStyle={{ padding: '8px 32px 8px 12px' }}
              />
            </div>

            {form.provider === 'openrouter' && (
              <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 10, background: 'var(--c-infoBg, #EEF2FF)', fontSize: 13, color: C.text, lineHeight: 1.45 }}>
                This key transcribes every WhatsApp voice note — for AI agents and the
                Transcribe button on voice notes in Chats — with <strong>Microsoft MAI-Transcribe 2</strong> (multilingual).
                Each note is transcribed once and reused. OpenRouter's chat models start switched off; enable any under Manage to use them elsewhere.
              </div>
            )}

            {form.provider === 'kimi' && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Custom Base URL (optional)</label>
                <input
                  value={form.baseUrl}
                  onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))}
                  placeholder="e.g. https://api.moonshot.ai/v1"
                  style={{ ...inpStyle, fontFamily: 'DM Mono, monospace', fontSize: 14 }}
                />
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4, lineHeight: 1.4 }}>
                  Leave blank for Moonshot's own platforms (<code>api.moonshot.ai</code> / <code>api.moonshot.cn</code>).
                  For Kimi Code (<code>sk-kimi-…</code> keys), OpenRouter, or another gateway, paste the API root from that service's docs. We append <code>/models</code> automatically.
                </div>
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Label (optional)</label>
              <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="e.g. Marketing OpenAI account" style={inpStyle}/>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>API Key</label>
              <div style={{ position: 'relative' }}>
                <input type={showKey ? 'text' : 'password'} value={form.apiKey} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))} placeholder="sk-…" style={{ ...inpStyle, paddingRight: 36, fontFamily: 'DM Mono, monospace' }}/>
                <button type="button" onClick={() => setShowKey(s => !s)} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', cursor: 'pointer', color: C.textMuted, padding: 4 }}>
                  {showKey ? <EyeOff size={14}/> : <Eye size={14}/>}
                </button>
              </div>
            </div>

            {error && (
              <div style={{ padding: '8px 12px', background: 'var(--c-primaryLight)', color: 'var(--c-dangerText, #A32D2D)', borderRadius: 8, fontSize: 14, marginBottom: 14 }}>{error}</div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowForm(false)} disabled={saving} style={{ ...btnSecondary, padding: '8px 14px', fontSize: 15 }}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ padding: '8px 14px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: saving ? 'wait' : 'pointer', fontFamily: FONT, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {saving && <Loader2 size={13} className="spin"/>}
                {saving ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Type-to-confirm delete modal */}
      {deleteTarget && (
        <div onClick={() => setDeleteTarget(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, boxShadow: C.shadowLg, width: 420, padding: 24, fontFamily: FONT }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>Delete AI Model</h3>
            <p style={{ margin: '8px 0 14px', fontSize: 15, color: C.textSecondary }}>
              This will remove the connection to <strong>{providerOpt(deleteTarget.provider).label}</strong>
              {deleteTarget.label ? <> ({deleteTarget.label})</> : null}. The encrypted API key will be deleted from the database.
            </p>
            <label style={labelStyle}>Type "delete" to confirm</label>
            <input value={deleteConfirmText} onChange={e => setDeleteConfirmText(e.target.value)} autoFocus style={inpStyle}/>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={() => { setDeleteTarget(null); setDeleteConfirmText(''); }} style={{ ...btnSecondary, padding: '8px 14px', fontSize: 15 }}>Cancel</button>
              <button
                onClick={confirmDelete}
                disabled={deleteConfirmText.trim().toLowerCase() !== 'delete'}
                style={{
                  padding: '8px 14px', background: deleteConfirmText.trim().toLowerCase() === 'delete' ? '#A32D2D' : 'var(--c-fillMuted, #d5d5d0)',
                  color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600,
                  cursor: deleteConfirmText.trim().toLowerCase() === 'delete' ? 'pointer' : 'not-allowed', fontFamily: FONT,
                }}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Usage dashboard modal */}
      {usageRow && (
        <div onClick={closeUsage} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, boxShadow: C.shadowLg, width: 560, maxHeight: 'calc(calc(100vh / var(--fg-zoom, 1)) - 32px)', overflow: 'auto', fontFamily: FONT }}>
            {/* Header */}
            <div style={{ padding: '20px 24px 14px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: providerOpt(usageRow.provider).accent }}/>
                <div>
                  <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>{providerOpt(usageRow.provider).label}</h3>
                  <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>{usageRow.label || 'Usage dashboard'}</div>
                </div>
              </div>
              <button onClick={closeUsage} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: C.textMuted, padding: 4 }}><X size={18}/></button>
            </div>

            {/* Body */}
            <div style={{ padding: '18px 24px 22px' }}>
              {usageLoading ? (
                <div style={{ padding: 40, textAlign: 'center', color: C.textMuted, fontSize: 15 }}>
                  <Loader2 size={18} className="spin" style={{ verticalAlign: 'middle', marginRight: 8 }}/>
                  Probing live connection and aggregating usage…
                </div>
              ) : usageError ? (
                <div style={{ padding: '12px 14px', background: 'var(--c-primaryLight)', color: 'var(--c-dangerText, #A32D2D)', borderRadius: 8, fontSize: 15 }}>{usageError}</div>
              ) : usageData ? (() => {
                const c = usageData.connection || {};
                const u = usageData.usage || {};
                const successRate = u.totalCalls > 0 ? Math.round((u.successfulCalls / u.totalCalls) * 100) : null;
                const tile = (label, value, sub) => (
                  <div key={label} style={{ background: C.pageBg, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 6 }}>{label}</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: C.text, fontFamily: 'DM Mono, monospace', lineHeight: 1 }}>{value}</div>
                    {sub && <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>{sub}</div>}
                  </div>
                );
                const fmtNum = (n) => Number(n || 0).toLocaleString();
                const fmtTime = (iso) => {
                  if (!iso) return '—';
                  try { return new Date(iso).toLocaleString(); } catch { return iso; }
                };
                const statusColors = {
                  healthy: { bg: 'var(--c-successBgSoft, #E5F2EE)', fg: 'var(--c-successText, #0F6E56)', dot: 'var(--c-successText, #0F6E56)', label: 'Healthy' },
                  error:   { bg: 'var(--c-dangerBg, #FCEBEB)', fg: 'var(--c-dangerText, #A32D2D)', dot: 'var(--c-dangerText, #A32D2D)', label: 'Error' },
                  unknown: { bg: 'var(--c-surfaceMuted, #F4F4EE)', fg: 'var(--c-t4, #666)',    dot: 'var(--c-t7, #999)',    label: 'Unknown' },
                };
                const sc = statusColors[c.status] || statusColors.unknown;
                return (
                  <>
                    {/* Connection status banner */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: sc.bg, color: sc.fg, borderRadius: 8, fontSize: 14, marginBottom: 16 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: sc.dot, flexShrink: 0 }}/>
                      <div style={{ flex: 1 }}>
                        <strong>{sc.label}</strong> — {c.status === 'healthy' ? `Live ping to ${usageRow.provider === 'kimi' ? (usageData.credential.baseUrl || 'Moonshot') : providerOpt(usageRow.provider).label}'s /models endpoint succeeded.` : (c.error || 'No live status available.')}
                      </div>
                      <span style={{ fontSize: 12, color: sc.fg, opacity: .7 }}>checked {fmtTime(c.checkedAt)}</span>
                    </div>

                    {/* Metric tiles */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 14 }}>
                      {tile('AI calls',     fmtNum(u.totalCalls),     successRate != null ? `${successRate}% success · ${u.failedCalls} failed` : 'No calls yet')}
                      {tile('Total tokens', fmtNum(u.totalTokens),    u.totalCalls > 0 ? `~${Math.round((u.totalTokens || 0) / u.totalCalls)} avg/call` : '—')}
                      {tile('Prompt tokens',     fmtNum(u.promptTokens),      'input to the model')}
                      {tile('Completion tokens', fmtNum(u.completionTokens),  'response from the model')}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
                      {tile('Last used',  fmtTime(u.lastUsedAt),  u.firstUsedAt ? `since ${fmtTime(u.firstUsedAt)}` : 'never')}
                      {tile('Last synced (model list)', fmtTime(usageData.credential.lastSyncedAt), usageData.credential.lastSyncError ? `Sync error: ${usageData.credential.lastSyncError}` : 'OK')}
                    </div>

                    {/* Recent activity log (filterable, paginated, click-through) */}
                    {(activityItems.length > 0 || activityFilters.status !== 'all' || activityFilters.model || activityFilters.from || activityFilters.to) && (() => {
                      const fmtRel = (iso) => {
                        if (!iso) return '—';
                        const d = new Date(iso);
                        const ms = Date.now() - d.getTime();
                        const m = Math.floor(ms / 60000);
                        if (m < 1) return 'just now';
                        if (m < 60) return `${m}m ago`;
                        const h = Math.floor(m / 60);
                        if (h < 24) return `${h}h ago`;
                        const days = Math.floor(h / 24);
                        return `${days}d ago`;
                      };
                      const excerpt = (v, max = 70) => {
                        if (v == null) return '';
                        const s = typeof v === 'string' ? v : JSON.stringify(v);
                        return s.length > max ? s.slice(0, max) + '…' : s;
                      };
                      const remaining = Math.max(0, activityTotal - activityItems.length);
                      const modelOptions = (usageData.usage?.byModel || []).map(m => m.modelId).filter(Boolean);
                      const f = activityFilters;
                      const filterInputStyle = { padding: '5px 9px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, fontFamily: FONT, background: 'var(--c-cardBg)', color: C.text, outline: 'none' };
                      const setF = (patch) => applyActivityFilters({ ...f, ...patch });
                      const filterActive = f.status !== 'all' || f.model || f.from || f.to;
                      return (
                        <>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, marginTop: 14 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '.04em' }}>Recent activity</div>
                            <div style={{ fontSize: 13, color: C.textMuted, fontFamily: 'DM Mono, monospace' }}>
                              {activityFiltering ? 'filtering…' : `showing ${activityItems.length} of ${activityTotal}`}
                            </div>
                          </div>

                          {/* Filter row */}
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
                            <SearchableSelect
                              value={f.status}
                              onChange={v => setF({ status: v })}
                              options={[
                                { value: 'all', label: 'All statuses' },
                                { value: 'success', label: 'Success' },
                                { value: 'error', label: 'Error' },
                              ]}
                              style={{ minWidth: 130 }}
                              triggerStyle={{ padding: '5px 28px 5px 9px', fontSize: 13, borderWidth: 1, borderRadius: 6 }}
                            />
                            <SearchableSelect
                              value={f.model}
                              onChange={v => setF({ model: v })}
                              options={[{ value: '', label: 'All models' }, ...modelOptions.map(m => ({ value: m, label: m }))]}
                              placeholder="All models"
                              searchPlaceholder="Search models…"
                              style={{ minWidth: 150 }}
                              triggerStyle={{ padding: '5px 28px 5px 9px', fontSize: 13, borderWidth: 1, borderRadius: 6 }}
                            />
                            <input type="date" value={f.from} onChange={e => setF({ from: e.target.value })} title="From date" style={filterInputStyle}/>
                            <input type="date" value={f.to}   onChange={e => setF({ to:   e.target.value })} title="To date"   style={filterInputStyle}/>
                            {filterActive && (
                              <button type="button" onClick={() => applyActivityFilters({ status: 'all', model: '', from: '', to: '' })}
                                style={{ padding: '5px 10px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, fontWeight: 600, color: C.textSecondary, cursor: 'pointer', fontFamily: FONT }}>
                                Clear filters
                              </button>
                            )}
                          </div>

                          {activityItems.length === 0 ? (
                            <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: 24, textAlign: 'center', fontSize: 14, color: C.textMuted }}>
                              No calls match the current filters.
                            </div>
                          ) : (
                          <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
                            {activityItems.map((call) => (
                              <div
                                key={call.stepId}
                                onClick={() => {
                                  if (!call.automationId || !call.executionId) return;
                                  closeUsage();
                                  if (navigate) navigate('chatbot-builder', call.automationId, 'executions', call.executionId);
                                }}
                                title={call.automationId ? `Click to open execution #${call.executionId} in ${call.automationName || 'automation'}` : ''}
                                style={{
                                  padding: '10px 12px', borderTop: `1px solid ${C.border}`,
                                  fontSize: 14, lineHeight: 1.45,
                                  cursor: call.automationId ? 'pointer' : 'default',
                                  transition: 'background .12s',
                                }}
                                onMouseEnter={e => { if (call.automationId) e.currentTarget.style.background = 'var(--c-xfafaf7, #FAFAF7)'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = ''; }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                  <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: call.status === 'success' ? '#0F6E56' : call.status === 'error' ? '#A32D2D' : '#999' }}/>
                                  <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 13, color: C.text }}>{call.modelId || '(unknown)'}</span>
                                  {call.automationName && (
                                    <>
                                      <span style={{ color: C.textMuted, fontSize: 13 }}>·</span>
                                      <span style={{ color: C.textSecondary, fontSize: 13 }}>{call.automationName}</span>
                                    </>
                                  )}
                                  <span style={{ color: C.textMuted, fontSize: 13 }}>·</span>
                                  <span style={{ color: C.textMuted, fontSize: 13 }} title={call.startedAt}>{fmtRel(call.startedAt)}</span>
                                  <span style={{ flex: 1 }}/>
                                  {call.totalTokens != null && (
                                    <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 13, color: C.textSecondary }} title={`${call.promptTokens || 0} prompt + ${call.completionTokens || 0} completion`}>
                                      {call.totalTokens.toLocaleString()} tok
                                    </span>
                                  )}
                                  {call.elapsedMs != null && (
                                    <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 13, color: C.textMuted }}>{call.elapsedMs}ms</span>
                                  )}
                                </div>
                                {call.userMessage && (
                                  <div style={{ marginLeft: 15, color: C.textSecondary, fontSize: 13 }}>
                                    <span style={{ color: C.textMuted }}>in: </span>{excerpt(call.userMessage)}
                                  </div>
                                )}
                                {call.status === 'error' ? (
                                  <div style={{ marginLeft: 15, color: 'var(--c-dangerText, #A32D2D)', fontSize: 13 }}>
                                    <span style={{ color: 'var(--c-dangerText, #A32D2D)', opacity: .7 }}>error: </span>{excerpt(call.errorMessage, 120)}
                                  </div>
                                ) : call.aiResponse ? (
                                  <div style={{ marginLeft: 15, color: C.text, fontSize: 13, fontFamily: 'DM Mono, monospace' }}>
                                    <span style={{ color: C.textMuted, fontFamily: 'DM Sans, sans-serif' }}>out: </span>{excerpt(call.aiResponse, 100)}
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                          )}
                          {activityItems.length > 0 && remaining > 0 && (
                            <button
                              type="button"
                              onClick={loadMoreActivity}
                              disabled={activityLoadingMore}
                              style={{
                                marginTop: 10, width: '100%',
                                padding: '8px 12px', background: 'var(--c-cardBg)',
                                border: `1px solid ${C.border}`, borderRadius: 8,
                                fontSize: 14, fontWeight: 600, fontFamily: FONT,
                                color: C.text, cursor: activityLoadingMore ? 'wait' : 'pointer',
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                              }}>
                              {activityLoadingMore && <Loader2 size={12} className="spin"/>}
                              {activityLoadingMore ? 'Loading…' : `Load more (${remaining} remaining)`}
                            </button>
                          )}
                        </>
                      );
                    })()}

                    {/* Per-model breakdown */}
                    {u.byModel && u.byModel.length > 0 && (
                      <>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>Usage by model</div>
                        <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
                          {u.byModel.map((m, i) => (
                            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderTop: i === 0 ? 'none' : `1px solid ${C.border}`, fontSize: 14 }}>
                              <span style={{ fontFamily: 'DM Mono, monospace', color: C.text }}>{m.modelId || '(unknown)'}</span>
                              <span style={{ color: C.textSecondary }}>
                                <span style={{ fontFamily: 'DM Mono, monospace' }}>{fmtNum(m.calls)}</span> calls · <span style={{ fontFamily: 'DM Mono, monospace' }}>{fmtNum(m.tokens)}</span> tok
                              </span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                );
              })() : null}
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}.spin{animation:spin 1s linear infinite}`}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Users                                                              */
/* ------------------------------------------------------------------ */
// ⚠ Roles are DATA, loaded from /roles. A hardcoded list here would not show a
// role someone added in this very screen — the drift that makes a control look
// broken. Admin keeps a distinct colour because it is the one role with
// unconditional access.
function RoleBadge({ role, roles = [] }) {
  const meta = roles.find(r => r.key === role);
  const styles = role === 'admin'
    ? { bg: 'var(--c-successBgSoft, #E5F2EE)', fg: 'var(--c-successText, #0F6E56)' }
    : { bg: 'var(--c-orangeBg, #FFF3E0)', fg: 'var(--c-sb04e0e, #B04E0E)' };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 8px', borderRadius: 999, background: styles.bg, color: styles.fg, fontSize: 13, fontWeight: 700 }}>
      {meta?.label || role}
    </span>
  );
}

/**
 * Role management, in the same screen as the users who hold the roles.
 *
 * ⚠ Admin is rendered read-only apart from its name. It is not a UI nicety —
 * the backend refuses the same edits. This screen is admin-gated, so a role
 * change that removed admin access would lock everyone out of the only place
 * that could put it back.
 */
function RolesPanel({ roles, allPages, users, onRefresh }) {
  const [editing, setEditing] = useState(null);   // role key, or '__new__'
  const [form, setForm] = useState({ key: '', label: '', description: '', pages: [] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const countFor = (key) => users.filter(u => u.role === key).length;

  const openNew = () => {
    setErr(''); setEditing('__new__');
    setForm({ key: '', label: '', description: '', pages: [] });
  };
  const openEdit = (r) => {
    setErr(''); setEditing(r.key);
    setForm({ key: r.key, label: r.label, description: r.description || '', pages: [...(r.pages || [])] });
  };

  const togglePage = (p) => setForm(f => ({
    ...f,
    pages: f.pages.includes(p) ? f.pages.filter(x => x !== p) : [...f.pages, p],
  }));

  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (editing === '__new__') {
        await api.roles.create({ key: form.key, label: form.label, description: form.description, pages: form.pages });
      } else {
        const isAdminRole = editing === 'admin';
        await api.roles.update(editing, isAdminRole
          ? { label: form.label, description: form.description }
          : { label: form.label, description: form.description, pages: form.pages });
      }
      setEditing(null);
      await onRefresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const remove = async (r) => {
    setBusy(true); setErr('');
    try { await api.roles.delete(r.key); await onRefresh(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const inp = { width: '100%', padding: '8px 12px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 15, fontFamily: FONT, outline: 'none', background: 'var(--c-cardBg)', color: C.text };
  const lbl = { display: 'block', fontSize: 13, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 };

  return (
    <div style={{ background: 'var(--c-surfaceAlt)', border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Roles</div>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>
            A role is a named set of pages. Give it to a user above.
          </div>
        </div>
        <button onClick={openNew} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'var(--c-cardBg)', color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
          <Plus size={14} /> Add role
        </button>
      </div>

      {err && <div style={{ background: 'var(--c-dangerBg)', color: 'var(--c-dangerText)', padding: '8px 12px', borderRadius: 8, fontSize: 14, marginBottom: 10 }}>{err}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {roles.map(r => (
          <div key={r.key} style={{ background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <RoleBadge role={r.key} roles={roles} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, color: C.textSecondary }}>{r.description || '—'}</div>
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2, fontFamily: MONO }}>
                  {r.key} · {r.isSystem ? 'all pages' : `${(r.pages || []).length} pages`} · {countFor(r.key)} user{countFor(r.key) === 1 ? '' : 's'}
                </div>
              </div>
              <button onClick={() => openEdit(r)} style={{ padding: '5px 10px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 14, cursor: 'pointer', color: C.text, fontFamily: FONT }}>Edit</button>
              {!r.isSystem && (
                <button onClick={() => remove(r)} disabled={busy} style={{ padding: '5px 10px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 14, cursor: 'pointer', color: 'var(--c-dangerText)', fontFamily: FONT }}>Delete</button>
              )}
            </div>

            {editing === r.key && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
                <label style={lbl}>Name</label>
                <input style={inp} value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} />
                <label style={{ ...lbl, marginTop: 10 }}>Description</label>
                <input style={inp} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
                {r.isSystem ? (
                  <div style={{ fontSize: 13, color: C.textMuted, marginTop: 10 }}>
                    Admin always has every page. It cannot be switched off or narrowed — otherwise nobody could reach these settings to change it back.
                  </div>
                ) : (
                  <>
                    <label style={{ ...lbl, marginTop: 12 }}>Pages ({form.pages.length})</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 220, overflow: 'auto' }}>
                      {allPages.map(p => (
                        <button key={p} onClick={() => togglePage(p)}
                          style={{
                            padding: '4px 9px', borderRadius: 999, fontSize: 13, fontFamily: MONO, cursor: 'pointer',
                            border: `1px solid ${form.pages.includes(p) ? 'var(--c-successText)' : C.border}`,
                            background: form.pages.includes(p) ? 'var(--c-successBg)' : 'transparent',
                            color: form.pages.includes(p) ? 'var(--c-successText)' : C.textSecondary,
                          }}>{p}</button>
                      ))}
                    </div>
                  </>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button onClick={save} disabled={busy} style={{ padding: '7px 14px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>Save</button>
                  <button onClick={() => setEditing(null)} style={{ padding: '7px 14px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, cursor: 'pointer', color: C.text, fontFamily: FONT }}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        ))}

        {editing === '__new__' && (
          <div style={{ background: 'var(--c-cardBg)', border: `1px dashed ${C.border}`, borderRadius: 8, padding: 12 }}>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Name</label>
                <input style={inp} autoFocus value={form.label}
                  onChange={e => setForm({
                    ...form, label: e.target.value,
                    // The id is derived while it is untouched, then left alone —
                    // it is IMMUTABLE once saved, because users store it.
                    key: form.key || '',
                  })}
                  onBlur={() => setForm(f => ({
                    ...f,
                    key: f.key || f.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30),
                  }))}
                  placeholder="e.g. Support" />
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Id (permanent)</label>
                <input style={{ ...inp, fontFamily: MONO }} value={form.key}
                  onChange={e => setForm({ ...form, key: e.target.value.toLowerCase() })} placeholder="support" />
              </div>
            </div>
            <label style={{ ...lbl, marginTop: 10 }}>Description</label>
            <input style={inp} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
            <label style={{ ...lbl, marginTop: 12 }}>Pages ({form.pages.length})</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 220, overflow: 'auto' }}>
              {allPages.map(p => (
                <button key={p} onClick={() => togglePage(p)}
                  style={{
                    padding: '4px 9px', borderRadius: 999, fontSize: 13, fontFamily: MONO, cursor: 'pointer',
                    border: `1px solid ${form.pages.includes(p) ? 'var(--c-successText)' : C.border}`,
                    background: form.pages.includes(p) ? 'var(--c-successBg)' : 'transparent',
                    color: form.pages.includes(p) ? 'var(--c-successText)' : C.textSecondary,
                  }}>{p}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={save} disabled={busy || !form.label.trim()} style={{ padding: '7px 14px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>Create role</button>
              <button onClick={() => setEditing(null)} style={{ padding: '7px 14px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, cursor: 'pointer', color: C.text, fontFamily: FONT }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function UsersTab() {
  const [users, setUsers] = useState([]);
  const [waAccounts, setWaAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ username: '', email: '', displayName: '', password: '', role: 'sales', isActive: true, assignedWaNumbers: [] });
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [credentials, setCredentials] = useState(null);   // { email, password, action } shown one-time
  const [resetting, setResetting] = useState(null);
  const [resetPwInput, setResetPwInput] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteText, setDeleteText] = useState('');
  const [roles, setRoles] = useState([]);
  const [allPages, setAllPages] = useState([]);
  const [manageRoles, setManageRoles] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const [u, w, r] = await Promise.all([api.users.list(), api.whatsappAccounts.list(), api.roles.list()]);
      setUsers(u);
      setWaAccounts(w);
      setRoles(r.roles || []);
      setAllPages(r.pages || []);
    } catch (err) {
      console.error('[users]', err);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); }, []);

  const inpStyle = { width: '100%', padding: '8px 12px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 15, fontFamily: FONT, outline: 'none', background: 'var(--c-cardBg)', color: C.text };
  const labelStyle = { display: 'block', fontSize: 13, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, fontFamily: FONT };

  const openCreate = () => {
    setEditing(null);
    setForm({ username: '', email: '', displayName: '', password: '', role: 'sales', isActive: true, assignedWaNumbers: [] });
    setShowPw(false);
    setError('');
    setShowForm(true);
  };
  const openEdit = (user) => {
    setEditing(user);
    setForm({
      username: user.username,
      email: user.email,
      displayName: user.displayName || '',
      password: '',
      role: user.role,
      isActive: user.isActive !== false,
      assignedWaNumbers: user.assignedWaNumbers || [],
    });
    setShowPw(false);
    setError('');
    setShowForm(true);
  };

  const save = async () => {
    setError('');
    if (!form.email.trim() || !form.displayName.trim()) { setError('Email and display name are required'); return; }
    if (!editing && !form.username.trim()) { setError('Username is required'); return; }
    setSaving(true);
    try {
      if (editing) {
        await api.users.update(editing.id, {
          displayName: form.displayName.trim(),
          email: form.email.trim(),
          role: form.role,
          isActive: form.isActive,
          assignedWaNumbers: form.role !== 'admin' ? form.assignedWaNumbers : [],
        });
        setShowForm(false);
        await refresh();
      } else {
        const result = await api.users.create({
          username: form.username.trim(),
          email: form.email.trim(),
          displayName: form.displayName.trim(),
          password: form.password.trim() || undefined,
          role: form.role,
          assignedWaNumbers: form.role !== 'admin' ? form.assignedWaNumbers : [],
        });
        setShowForm(false);
        await refresh();
        setCredentials({ email: result.email, password: result.password, action: 'created' });
      }
    } catch (err) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const doResetPassword = async () => {
    if (!resetting) return;
    try {
      const result = await api.users.resetPassword(resetting.id, resetPwInput.trim() || undefined);
      setResetting(null);
      setResetPwInput('');
      setCredentials({ email: resetting.email, password: result.password, action: 'reset' });
    } catch (err) {
      notify(err.message || 'Reset failed');
    }
  };

  const doDelete = async () => {
    if (!deleteTarget || deleteText.trim().toLowerCase() !== 'delete') return;
    try {
      await api.users.delete(deleteTarget.id);
      setDeleteTarget(null);
      setDeleteText('');
      await refresh();
    } catch (err) {
      notify(err.message || 'Delete failed');
    }
  };

  const fmtTime = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  const toggleAssignedWa = (wa) => {
    setForm(prev => {
      const list = new Set(prev.assignedWaNumbers || []);
      if (list.has(wa)) list.delete(wa); else list.add(wa);
      return { ...prev, assignedWaNumbers: Array.from(list) };
    });
  };

  return (
    <div style={{ flex: 1, padding: '16px 28px 28px', overflow: 'auto', fontFamily: FONT }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <div>
          <p style={{ fontSize: 14, color: C.textMuted, margin: '4px 0 0' }}>
            The people who sign in. A non-admin only sees chats and contacts on their assigned WhatsApp numbers.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setManageRoles(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: 'var(--c-cardBg)', color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
            <Shield size={15} /> {manageRoles ? 'Hide roles' : 'Manage roles'}
          </button>
          <button onClick={openCreate} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
            <Plus size={15} /> Add user
          </button>
        </div>
      </div>

      {manageRoles && <RolesPanel roles={roles} allPages={allPages} users={users} onRefresh={refresh} />}

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: C.textMuted, fontSize: 15 }}>Loading…</div>
      ) : users.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, borderRadius: 10, color: C.textMuted, fontSize: 15 }}>
          No users yet. Click "Add user" to create one.
        </div>
      ) : (
        <div style={{ background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15 }}>
            <thead>
              <tr style={{ background: C.pageBg, borderBottom: `1px solid ${C.border}` }}>
                <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>User</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Role</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Assigned WA</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Status</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Last login</th>
                <th style={{ textAlign: 'right', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: '12px 16px', verticalAlign: 'top' }}>
                    <div style={{ fontWeight: 600, color: C.text }}>{u.displayName}</div>
                    <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2, fontFamily: 'DM Mono, monospace' }}>{u.email}</div>
                  </td>
                  <td style={{ padding: '12px 16px', verticalAlign: 'top' }}><RoleBadge role={u.role} roles={roles}/></td>
                  <td style={{ padding: '12px 16px', verticalAlign: 'top', fontSize: 14, fontFamily: 'DM Mono, monospace' }}>
                    {u.role === 'admin'
                      ? <span style={{ color: C.textMuted, fontStyle: 'italic' }}>all numbers</span>
                      : (u.assignedWaNumbers && u.assignedWaNumbers.length > 0
                          ? u.assignedWaNumbers.map(w => <div key={w}>{w}</div>)
                          : <span style={{ color: 'var(--c-dangerText, #A32D2D)', fontStyle: 'italic' }}>none — won't see any chats</span>)}
                  </td>
                  <td style={{ padding: '12px 16px', verticalAlign: 'top' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: u.isActive ? 'var(--c-successText, #0F6E56)' : 'var(--c-dangerText, #A32D2D)' }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: u.isActive ? '#0F6E56' : '#A32D2D' }}/>
                      {u.isActive ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px', verticalAlign: 'top', fontSize: 14, color: C.textSecondary }}>{fmtTime(u.lastLoginAt)}</td>
                  <td style={{ padding: '12px 16px', verticalAlign: 'top', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button onClick={() => openEdit(u)} style={{ ...btnSecondary, marginRight: 4 }}>Edit</button>
                    <button onClick={() => { setResetting(u); setResetPwInput(''); }} style={{ ...btnSecondary, marginRight: 4 }} title="Reset password"><Key size={12}/></button>
                    <button onClick={() => { setDeleteTarget(u); setDeleteText(''); }} style={{ ...btnSecondary, color: 'var(--c-dangerText, #A32D2D)' }} title="Delete"><Trash2 size={12}/></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create / edit modal */}
      {showForm && (
        <div onClick={() => !saving && setShowForm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, boxShadow: C.shadowLg, width: 500, maxHeight: 'calc(calc(100vh / var(--fg-zoom, 1)) - 32px)', overflow: 'auto', padding: 24, fontFamily: FONT }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>{editing ? 'Edit user' : 'Add user'}</h3>

            <div style={{ marginTop: 16, marginBottom: 14 }}>
              <label style={labelStyle}>Display name *</label>
              <input value={form.displayName} onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))} style={inpStyle}/>
            </div>
            <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Username *</label>
                <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} disabled={!!editing} style={{ ...inpStyle, opacity: editing ? 0.6 : 1 }}/>
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Email *</label>
                <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} style={inpStyle}/>
              </div>
            </div>
            {!editing && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Password (leave blank to auto-generate)</label>
                <div style={{ position: 'relative' }}>
                  <input type={showPw ? 'text' : 'password'} value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="12+ chars recommended" style={{ ...inpStyle, paddingRight: 36, fontFamily: 'DM Mono, monospace' }}/>
                  <button type="button" onClick={() => setShowPw(s => !s)} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', cursor: 'pointer', color: C.textMuted, padding: 4 }}>
                    {showPw ? <EyeOff size={14}/> : <Eye size={14}/>}
                  </button>
                </div>
              </div>
            )}
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Role</label>
              <SearchableSelect
                value={form.role}
                onChange={v => setForm(f => ({ ...f, role: v }))}
                options={roles.filter(r => r.active !== false).map(r => ({ value: r.key, label: r.label }))}
                style={{ width: '100%' }}
                triggerStyle={{ padding: '8px 32px 8px 12px' }}
              />
              <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>{roles.find(r => r.key === form.role)?.description}</div>
            </div>
            {form.role !== 'admin' && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Assigned WhatsApp numbers</label>
                {waAccounts.length === 0 ? (
                  <div style={{ fontSize: 14, color: C.textMuted, fontStyle: 'italic' }}>No WhatsApp accounts connected yet. Add some in the WhatsApp Accounts tab first.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflow: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, padding: 8 }}>
                    {waAccounts.map(a => {
                      const wa = String(a.displayPhoneNumber || '').replace(/\D/g, '');
                      const checked = form.assignedWaNumbers.includes(wa);
                      return (
                        <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: C.text, cursor: 'pointer', padding: '4px 6px', borderRadius: 6 }}
                          onMouseEnter={e => e.currentTarget.style.background = C.pageBg}
                          onMouseLeave={e => e.currentTarget.style.background = ''}>
                          <input type="checkbox" checked={checked} onChange={() => toggleAssignedWa(wa)}/>
                          <span style={{ fontWeight: 600 }}>{a.displayName}</span>
                          <span style={{ fontFamily: 'DM Mono, monospace', color: C.textSecondary }}>{maskPhone(a.displayPhoneNumber)}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>
                  BDA Sales users only see chats and contacts on the numbers they're assigned.
                </div>
              </div>
            )}
            {editing && (
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: C.text, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))}/>
                  <span>Account is active <span style={{ color: C.textMuted, fontWeight: 400 }}>(disabling blocks login but keeps the row)</span></span>
                </label>
              </div>
            )}
            {error && <div style={{ padding: '8px 12px', background: 'var(--c-primaryLight)', color: 'var(--c-dangerText, #A32D2D)', borderRadius: 8, fontSize: 14, marginBottom: 14 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowForm(false)} disabled={saving} style={{ ...btnSecondary, padding: '8px 14px', fontSize: 15 }}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ padding: '8px 14px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: saving ? 'wait' : 'pointer', fontFamily: FONT, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {saving && <Loader2 size={13} className="spin"/>}
                {saving ? 'Saving…' : (editing ? 'Save changes' : 'Create user')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Credentials modal (shows generated password once) */}
      {credentials && (
        <div onClick={() => setCredentials(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 210, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, boxShadow: C.shadowLg, width: 460, padding: 24, fontFamily: FONT }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>
              {credentials.action === 'created' ? 'User created' : 'Password reset'}
            </h3>
            <div style={{ padding: 12, background: 'var(--c-warnBgSoft, #FFF8E1)', border: `1px solid #FFE082`, borderRadius: 8, color: 'var(--c-s7a5c00, #7A5C00)', fontSize: 14, marginTop: 14 }}>
              ⚠️ This is the only time the password will be shown. Save it now and share with the user out-of-band (e.g. via WhatsApp).
            </div>
            <div style={{ marginTop: 14 }}>
              <div style={labelStyle}>Email</div>
              <div style={{ ...inpStyle, fontFamily: 'DM Mono, monospace', userSelect: 'all' }}>{credentials.email}</div>
            </div>
            <div style={{ marginTop: 10 }}>
              <div style={labelStyle}>Password</div>
              <div style={{ ...inpStyle, fontFamily: 'DM Mono, monospace', userSelect: 'all', fontWeight: 600 }}>{credentials.password}</div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
              <button onClick={() => { navigator.clipboard.writeText(`Email: ${credentials.email}\nPassword: ${credentials.password}`); }} style={{ ...btnSecondary, padding: '8px 14px', fontSize: 15 }}>Copy both</button>
              <button onClick={() => setCredentials(null)} style={{ padding: '8px 14px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>Got it</button>
            </div>
          </div>
        </div>
      )}

      {/* Reset password input modal */}
      {resetting && (
        <div onClick={() => setResetting(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, boxShadow: C.shadowLg, width: 420, padding: 24, fontFamily: FONT }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>Reset password</h3>
            <p style={{ margin: '8px 0 14px', fontSize: 15, color: C.textSecondary }}>Reset password for <strong>{resetting.displayName}</strong> ({resetting.email})?</p>
            <label style={labelStyle}>New password (leave blank to auto-generate)</label>
            <input type="text" value={resetPwInput} onChange={e => setResetPwInput(e.target.value)} placeholder="Auto-generate if blank" style={{ ...inpStyle, fontFamily: 'DM Mono, monospace' }}/>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={() => setResetting(null)} style={{ ...btnSecondary, padding: '8px 14px', fontSize: 15 }}>Cancel</button>
              <button onClick={doResetPassword} style={{ padding: '8px 14px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>Reset password</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      {deleteTarget && (
        <div onClick={() => setDeleteTarget(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, boxShadow: C.shadowLg, width: 420, padding: 24, fontFamily: FONT }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>Delete user</h3>
            <p style={{ margin: '8px 0 14px', fontSize: 15, color: C.textSecondary }}>This will permanently remove <strong>{deleteTarget.displayName}</strong> ({deleteTarget.email}) and their WhatsApp number assignments. The chat history they touched is not affected.</p>
            <label style={labelStyle}>Type "delete" to confirm</label>
            <input value={deleteText} onChange={e => setDeleteText(e.target.value)} autoFocus style={inpStyle}/>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={() => setDeleteTarget(null)} style={{ ...btnSecondary, padding: '8px 14px', fontSize: 15 }}>Cancel</button>
              <button onClick={doDelete} disabled={deleteText.trim().toLowerCase() !== 'delete'} style={{ padding: '8px 14px', background: deleteText.trim().toLowerCase() === 'delete' ? '#A32D2D' : 'var(--c-fillMuted, #d5d5d0)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: deleteText.trim().toLowerCase() === 'delete' ? 'pointer' : 'not-allowed', fontFamily: FONT }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Integrations Tab                                                   */
/*  Google Sheets / Google Calendar / Gmail OAuth integrations.         */
/* ------------------------------------------------------------------ */

const PROVIDERS = [
  {
    key: 'google_sheets',
    label: 'Google Sheets',
    icon: FileSpreadsheet,
    blurb: 'Append rows to a spreadsheet from automation Actions.',
    color: 'var(--c-x0f9d58, #0F9D58)',
  },
  {
    key: 'google_calendar',
    label: 'Google Calendar',
    icon: CalendarIcon,
    blurb: 'Create calendar events from automation Actions.',
    color: '#4285F4',
  },
  {
    key: 'gmail',
    label: 'Gmail',
    icon: Mail,
    blurb: 'Send emails from the connected Gmail account.',
    color: '#EA4335',
  },
];

// Top-level "apps" (collections of providers). Designed so future apps —
// Slack, Notion, HubSpot — can be added with the same drill-in pattern.
const INTEGRATION_APPS = [
  {
    key: 'google',
    label: 'Google',
    blurb: 'Sheets, Calendar, Gmail — connect once, use across automations.',
    providers: ['google_sheets', 'google_calendar', 'gmail'],
    color: '#4285F4',
    logo: (size = 28) => (
      // The 4-color G — inline SVG so we don't add an asset
      <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M21.6 12.227c0-.704-.063-1.38-.18-2.027H12v3.832h5.39a4.612 4.612 0 0 1-2 3.028v2.514h3.236c1.894-1.745 2.974-4.314 2.974-7.347Z" fill="#4285F4"/>
        <path d="M12 22c2.7 0 4.964-.895 6.618-2.426l-3.236-2.514c-.896.6-2.04.955-3.382.955-2.605 0-4.81-1.76-5.595-4.122H3.064v2.59A9.996 9.996 0 0 0 12 22Z" fill="#34A853"/>
        <path d="M6.405 13.893A6 6 0 0 1 6.09 12c0-.659.114-1.295.314-1.893V7.518H3.064A9.996 9.996 0 0 0 2 12c0 1.614.386 3.14 1.064 4.482l3.341-2.59Z" fill="#FBBC05"/>
        <path d="M12 5.985c1.469 0 2.787.505 3.823 1.495l2.868-2.868C16.96 3.024 14.695 2 12 2A9.996 9.996 0 0 0 3.064 7.518l3.341 2.59C7.19 7.745 9.395 5.985 12 5.985Z" fill="#EA4335"/>
      </svg>
    ),
  },
];

// Shared app-card used for every Integrations tile (Google, …)
// so they stay pixel-identical. `logo` is a rendered node; `badge` is a pill node.
function AppCard({ color, logo, label, blurb, badge, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left', cursor: 'pointer',
        background: C.cardBg, border: `1px solid ${C.border}`,
        borderRadius: 12, padding: 18, display: 'flex', alignItems: 'center', gap: 14,
        fontFamily: FONT, color: C.text,
        transition: 'box-shadow .12s, border-color .12s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = color; e.currentTarget.style.boxShadow = C.shadowMd; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.boxShadow = 'none'; }}
    >
      <div style={{ width: 48, height: 48, borderRadius: 12, background: 'var(--c-surface, #fff)', border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {logo}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>{label}</div>
        <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 2 }}>{blurb}</div>
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>{badge}</div>
      </div>
      <ChevronRight size={18} color={C.textMuted} />
    </button>
  );
}

/* ============================ MCP Tools tab ============================ */

// Everything on this screen — areas, categories, tools, what each tool does,
// and the API-area switches — is served by the backend from
// services/mcpCatalog.js. This file keeps NO list of its own: a hand-kept
// frontend copy once carried an `area_bda` switch no backend path ever read.

// Tier -> pill styling for a CATEGORY. Advisory only; the switch is the gate.
const MCP_TIER_STYLE = {
  read:        { bg: 'var(--c-successBg, #E1F5EE)', fg: 'var(--c-successText, #0F6E56)' },
  build:       { bg: 'var(--c-purpleBg, #EDEBF7)', fg: 'var(--c-purple, #534AB7)' },
  spend:       { bg: 'var(--c-warnBg, #FBF0E4)', fg: 'var(--c-warnText, #8A5A1B)' },
  send:        { bg: 'var(--c-dangerBg, #FCEBEB)', fg: 'var(--c-dangerText, #A32D2D)' },
  destructive: { bg: 'var(--c-dangerSolid, #A32D2D)', fg: '#FFFFFF' },
  advanced:    { bg: 'var(--c-warnBg, #FBF0E4)', fg: 'var(--c-warnText, #8A5A1B)' },
};

// Kind -> pill styling for ONE tool ("Reads", "Changes setup", "Reaches people"…).
const MCP_KIND_STYLE = {
  read:     MCP_TIER_STYLE.read,
  change:   MCP_TIER_STYLE.build,
  spend:    MCP_TIER_STYLE.spend,
  send:     MCP_TIER_STYLE.send,
  delete:   MCP_TIER_STYLE.destructive,
  advanced: MCP_TIER_STYLE.advanced,
};
const MCP_KIND_ORDER = ['read', 'change', 'spend', 'send', 'delete', 'advanced'];

function TierPill({ tier, label, kind }) {
  const s = (kind ? MCP_KIND_STYLE[kind] : MCP_TIER_STYLE[tier]) || MCP_TIER_STYLE.read;
  return (
    <span style={{
      background: s.bg, color: s.fg, fontSize: 12, fontWeight: 700,
      padding: '3px 8px', borderRadius: 999, whiteSpace: 'nowrap', flexShrink: 0,
    }}>{label}</span>
  );
}


// One category = one switch. Expanding it lists every tool the switch
// controls, each in plain words with what it does (reads / changes / reaches
// people / costs money / deletes), so the blast radius is visible BEFORE the
// switch is flipped.
function McpCategoryCard({ cat, kinds, disabled, saving, onToggle }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  const kindSummary = MCP_KIND_ORDER
    .filter(k => cat.kindCounts?.[k])
    .map(k => ({ k, n: cat.kindCounts[k], label: kinds?.[k]?.label || k }));
  return (
    <div data-mcp-category={cat.key} style={{
      border: `1px solid ${C.border}`, borderRadius: 12, marginBottom: 10,
      background: cat.enabled ? 'var(--c-cardBg)' : 'var(--c-surfaceSubtle, transparent)',
      opacity: disabled ? 0.55 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '14px 16px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{cat.label}</span>
            <TierPill tier={cat.tier} label={cat.tierLabel} />
          </div>
          <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 5, lineHeight: 1.55 }}>
            {cat.description}
          </div>
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-expanded={open}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 10, flexWrap: 'wrap',
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              fontFamily: FONT, fontSize: 13, fontWeight: 600, color: C.text,
            }}
          >
            <Chevron size={14} strokeWidth={2.5} />
            {open ? 'Hide' : 'Show'} the {cat.toolCount} {cat.toolCount === 1 ? 'tool' : 'tools'}
            {kindSummary.length > 0 && (
              <span style={{ fontWeight: 500, color: C.textSecondary }}>
                {' · '}{kindSummary.map(x => `${x.n} ${x.label.toLowerCase()}`).join(' · ')}
              </span>
            )}
          </button>
        </div>
        <Toggle checked={cat.enabled} disabled={disabled || saving} onChange={onToggle} label={`${cat.label}: ${cat.enabled ? 'on' : 'off'}`} />
      </div>

      {open && (
        <div style={{ borderTop: `1px solid ${C.border}`, padding: '6px 16px 10px' }}>
          {cat.tools.map((t, i) => (
            <div key={t.name} style={{
              display: 'flex', gap: 12, padding: '9px 0', alignItems: 'flex-start',
              borderTop: i === 0 ? 'none' : `1px solid ${C.border}`,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, color: C.text, lineHeight: 1.45 }}>{t.summary}</div>
                {/* The real tool name, small — what Claude's log shows. */}
                <div style={{ fontFamily: MONO, fontSize: 12, color: C.textMuted, marginTop: 2, wordBreak: 'break-all' }}>{t.name}</div>
              </div>
              <TierPill kind={t.kind} label={t.kindLabel || kinds?.[t.kind]?.label || t.kind} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Small inline pill toggle — consistent with the settings look, no extra deps.
function Toggle({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 38, height: 22, borderRadius: 999, border: 'none', padding: 0,
        position: 'relative', flexShrink: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        background: checked ? C.green : 'var(--c-fillMuted, #d5d5d0)',
        transition: 'background .15s',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2,
        width: 18, height: 18, borderRadius: '50%', background: 'var(--c-surface, #fff)',
        boxShadow: '0 1px 2px rgba(0,0,0,.25)', transition: 'left .15s',
      }} />
    </button>
  );
}

function McpToolsTab() {
  const [settings, setSettings] = useState(null);   // { masterEnabled, capabilities }
  const [keys, setKeys] = useState([]);
  const [install, setInstall] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savingCap, setSavingCap] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [freshKey, setFreshKey] = useState(null);   // { ...key, key } shown once
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [copied, setCopied] = useState('');
  const [oauthClients, setOauthClients] = useState([]);
  const [oauthName, setOauthName] = useState('');
  const [creatingOauth, setCreatingOauth] = useState(false);
  const [freshClient, setFreshClient] = useState(null);   // secret shown once
  const [oauthDeleteTarget, setOauthDeleteTarget] = useState(null);
  const [mcpArea, setMcpArea] = useState('social');
  // Tab is remembered per browser so returning to this screen lands where you were.
  const [mcpTab, setMcpTabState] = useState(() => {
    try { return localStorage.getItem('forgegrowth.mcpTab') || 'connect'; } catch { return 'connect'; }
  });
  const setMcpTab = (t) => { setMcpTabState(t); try { localStorage.setItem('forgegrowth.mcpTab', t); } catch { /* private mode */ } };
  const [connectApp, setConnectApp] = useState('claude');
  const [showAutoClients, setShowAutoClients] = useState(false);

  const load = async () => {
    try {
      const [s, k, inst, oc] = await Promise.all([
        api.mcp.getSettings(),
        api.mcp.listKeys(),
        api.mcp.install().catch(() => null),
        api.mcp.oauthClients().catch(() => ({ clients: [] })),
      ]);
      setSettings(s);
      setKeys(k);
      setInstall(inst);
      setOauthClients(oc?.clients || []);
    } catch (err) {
      notify(err.message || 'Failed to load MCP settings');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const copy = async (text, tag) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(''), 1500);
    } catch { /* */ }
  };

  const saveSettings = async (patch) => {
    setSavingCap(true);
    const prev = settings;
    setSettings(s => {
      const categories = { ...s.categories, ...(patch.categories || {}) };
      return {                                // optimistic
        ...s,
        ...(patch.masterEnabled !== undefined ? { masterEnabled: patch.masterEnabled } : {}),
        capabilities: { ...s.capabilities, ...(patch.capabilities || {}) },
        categories,
        // Re-project the catalog's per-category `enabled` flags too, otherwise
        // the optimistic update writes state the cards do not read and the
        // switch visibly snaps back until the server responds.
        catalog: s.catalog && {
          ...s.catalog,
          categories: s.catalog.categories.map(c => ({ ...c, enabled: categories[c.key] === true })),
        },
      };
    });
    try {
      const updated = await api.mcp.updateSettings(patch);
      setSettings(updated);
    } catch (err) {
      setSettings(prev);                      // revert
      notify(err.message || 'Failed to update MCP settings');
    } finally {
      setSavingCap(false);
    }
  };

  const createKey = async () => {
    const label = newLabel.trim();
    if (!label) { notify('Give the key a label first'); return; }
    setCreating(true);
    try {
      const k = await api.mcp.createKey(label);
      setFreshKey(k);
      setNewLabel('');
      await load();
    } catch (err) {
      notify(err.message || 'Failed to create key');
    } finally {
      setCreating(false);
    }
  };

  const toggleKey = async (k) => {
    const prev = keys;
    setKeys(ks => ks.map(x => x.id === k.id ? { ...x, isEnabled: !x.isEnabled } : x));
    try {
      await api.mcp.updateKey(k.id, { isEnabled: !k.isEnabled });
    } catch (err) {
      setKeys(prev);
      notify(err.message || 'Failed to update key');
    }
  };

  const revokeKey = async () => {
    const k = revokeTarget;
    setRevokeTarget(null);
    try {
      await api.mcp.deleteKey(k.id);
      setKeys(ks => ks.filter(x => x.id !== k.id));
    } catch (err) {
      notify(err.message || 'Failed to revoke key');
    }
  };

  if (loading || !settings) {
    return <div style={{ flex: 1, padding: 40, textAlign: 'center', color: C.textMuted, fontFamily: FONT }}>Loading…</div>;
  }

  const master = settings.masterEnabled;
  const card = { background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, marginBottom: 18 };
  const h2 = { fontSize: 16, fontWeight: 700, color: C.text, margin: '0 0 4px' };
  const sub = { fontSize: 14, color: C.textSecondary, margin: '0 0 16px', lineHeight: 1.5 };

  // The category list, tool counts and per-tool summaries all come from the
  // backend catalog (services/mcpCatalog.js) — this screen deliberately keeps
  // NO copy of its own. A hand-maintained frontend mirror of a backend list is
  // how a Settings tab once rendered a button that silently did nothing.
  const cats = settings.catalog?.categories || [];
  const totalTools = settings.catalog?.totalTools || 0;
  const enabledCats = cats.filter(c => c.enabled);
  const enabledTools = enabledCats.reduce((n, c) => n + c.toolCount, 0);
  const directApiOn = cats.some(c => c.key === 'direct_api' && c.enabled);
  const codeBox = {
    background: '#0F0F10', color: '#E5E5E2', fontFamily: MONO, fontSize: 14,
    borderRadius: 8, padding: 14, overflowX: 'auto', whiteSpace: 'pre', lineHeight: 1.5,
  };

  const snippet = install ? JSON.stringify(install.configSnippet, null, 2) : '';
  // Prefer the fields the API now returns outright. The fallbacks cover a
  // backend older than this bundle, which sent only the legacy url — deriving
  // the OAuth one from the page origin rather than by string-surgery on it,
  // because that surgery is what let the legacy form reach the OAuth box.
  const oauthUrl = install?.oauthUrl || (install ? `${window.location.origin}/api/mcp` : '');
  const legacyUrl = install?.legacyUrl || install?.remoteUrl || '';

  // Everything an admin needs on one screen, split into the order they need
  // it: connect Claude, choose what it may do, manage who has access, and the
  // rarely-needed advanced bits last.
  const areas = settings.catalog?.areas || [];
  const areaOn = (a) => a.categories.reduce((n, k) => { const c = cats.find(x => x.key === k); return n + (c && c.enabled ? c.toolCount : 0); }, 0);
  const areaAll = (a) => a.categories.reduce((n, k) => n + (cats.find(x => x.key === k)?.toolCount || 0), 0);
  const manualClients = oauthClients.filter(c => !c.dynamic);
  const autoClients = oauthClients.filter(c => c.dynamic);
  const shownClients = showAutoClients ? oauthClients : manualClients;
  const DAY = 86400000;
  const connected = [
    ...oauthClients.filter(c => (c.activeTokens || 0) > 0).map(c => ({ id: 'o' + c.id, name: c.dynamic ? (c.name || 'Claude') : c.name, how: 'Signed in with OAuth', detail: `${c.activeTokens} active ${c.activeTokens === 1 ? 'session' : 'sessions'}` })),
    ...keys.filter(k => k.isEnabled && k.lastUsedAt && Date.now() - new Date(k.lastUsedAt).getTime() < 30 * DAY).map(k => ({ id: 'k' + k.id, name: k.label, how: 'API key', detail: 'Last used ' + new Date(k.lastUsedAt).toLocaleString() })),
  ];
  const claudeCodeCmd = oauthUrl ? `claude mcp add --transport http forge-growth ${oauthUrl}` : '';
  const goPermissions = (areaKey) => { if (areaKey) setMcpArea(areaKey); setMcpTab('permissions'); };
  const btnGhost = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', fontSize: 14, fontWeight: 600, cursor: 'pointer', color: C.text, fontFamily: FONT };
  const CopyRow = ({ value, tag, muted }) => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
      <code style={{ flex: 1, minWidth: 0, ...codeBox, whiteSpace: 'nowrap', overflowX: 'auto', padding: '11px 13px', color: muted ? '#B9B9B4' : codeBox.color }}>{value}</code>
      <button type="button" onClick={() => copy(value, tag)} aria-label="Copy"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: C.primary, color: '#fff', border: 'none', borderRadius: 8, padding: '0 14px', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: FONT, flexShrink: 0 }}>
        {copied === tag ? <Check size={14} /> : <Copy size={14} />}{copied === tag ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
  const Step = ({ n, title, done, children }) => (
    <div style={{ display: 'flex', gap: 14, padding: '18px 0', borderTop: n === 1 ? 'none' : `1px solid ${C.border}` }}>
      <div style={{
        width: 30, height: 30, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: done ? 'var(--c-successBg, #E1F5EE)' : 'var(--c-surfaceSubtle, #EEEDE8)',
        color: done ? 'var(--c-successText, #0F6E56)' : C.text, fontWeight: 700, fontSize: 14,
      }}>{done ? <Check size={15} strokeWidth={3} /> : n}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>{title}</div>
        {children}
      </div>
    </div>
  );
  const TABS_MCP = [
    { id: 'connect', label: 'Connect Claude' },
    { id: 'permissions', label: `What Claude can do · ${enabledTools}/${totalTools}` },
    { id: 'access', label: 'Access & keys' },
    { id: 'advanced', label: 'Advanced' },
  ];

  return (
    <div style={{ flex: 1, padding: '16px 28px 28px', overflow: 'auto', fontFamily: FONT, maxWidth: 1180 }}>
      {/* Status — answers "is Claude connected, and how much can it do?" before anything else. */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: master ? 'var(--c-successBg, #E1F5EE)' : 'var(--c-surfaceSubtle, #EEEDE8)',
          color: master ? 'var(--c-successText, #0F6E56)' : C.textMuted,
        }}><PlugZap size={22} /></div>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>
            {master ? 'Claude can connect to Forge Growth' : 'Claude access is switched off'}
          </div>
          <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 3, lineHeight: 1.5 }}>
            {master
              ? <><b style={{ color: C.text }}>{enabledTools}</b> of {totalTools} tools on · <b style={{ color: C.text }}>{connected.length}</b> {connected.length === 1 ? 'app' : 'apps'} connected</>
              : 'Every request from Claude or any other app is refused until you turn this on.'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: C.textSecondary }}>Allow access</span>
          <Toggle checked={master} disabled={savingCap} label="Allow Claude access" onChange={(v) => saveSettings({ masterEnabled: v })} />
        </div>
      </div>

      <div style={{ overflowX: 'auto', marginBottom: 18 }}>
        <PillStrip value={mcpTab} onChange={setMcpTab} items={TABS_MCP} />
      </div>

      {mcpTab === 'connect' && (
        <>
          <div style={card}>
            <h2 style={h2}>Connect Claude in three steps</h2>
            <p style={{ ...sub, marginBottom: 4 }}>Works with Claude on the web, the desktop app, mobile, and Claude Code. Signing in uses your Forge Growth login — no password or key is pasted anywhere.</p>

            <Step n={1} title="Turn access on" done={master}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, color: C.textSecondary }}>{master ? 'Access is on.' : 'Use the switch at the top of this page, or here.'}</span>
                {!master && <button type="button" style={{ ...btnGhost, background: C.primary, color: '#fff', border: 'none' }} disabled={savingCap} onClick={() => saveSettings({ masterEnabled: true })}>Turn on access</button>}
              </div>
            </Step>

            <Step n={2} title="Choose what Claude can do" done={enabledTools > 0}>
              <div style={{ fontSize: 14, color: C.textSecondary, marginBottom: 10 }}>Nothing is on until you switch it on. Pick an area to choose its tools.</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }}>
                {areas.map(a => {
                  const on = areaOn(a), all = areaAll(a);
                  return (
                    <button key={a.key} type="button" data-area={a.key} onClick={() => goPermissions(a.key)}
                      style={{ textAlign: 'left', padding: '12px 14px', borderRadius: 12, border: `1px solid ${C.border}`, background: 'var(--c-cardBg)', cursor: 'pointer', fontFamily: FONT }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{a.label}</span>
                        <ChevronRight size={15} color={C.textMuted} />
                      </div>
                      <div style={{ fontSize: 13, color: on ? 'var(--c-successText, #0F6E56)' : C.textMuted, marginTop: 4, fontWeight: 600 }}>
                        {on ? `${on} of ${all} tools on` : `Off · ${all} tools`}
                      </div>
                    </button>
                  );
                })}
              </div>
            </Step>

            <Step n={3} title="Add Forge Growth to Claude" done={connected.length > 0}>
              <div style={{ marginBottom: 12, overflowX: 'auto' }}>
                <PillStrip size="sm" value={connectApp} onChange={setConnectApp} items={[
                  { id: 'claude', label: 'Claude (web, desktop, mobile)' },
                  { id: 'code', label: 'Claude Code' },
                  { id: 'other', label: 'Other MCP apps' },
                ]} />
              </div>

              {connectApp === 'claude' && (
                <>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>Server URL</div>
                  {oauthUrl && <CopyRow value={oauthUrl} tag="oauthurl" />}
                  <ol style={{ fontSize: 15, color: C.text, lineHeight: 1.8, paddingLeft: 20, margin: '12px 0 0' }}>
                    <li>In Claude, open <b>Settings → Connectors</b> and choose <b>Add custom connector</b>.</li>
                    <li>Name it <b>Forge Growth</b> and paste the server URL above. Leave the OAuth fields empty.</li>
                    <li>Press <b>Add</b>, then <b>Connect</b>. A Forge Growth window opens — sign in if asked and press <b>Allow</b>.</li>
                    <li>Start a chat and ask, for example, <i>“How did our Instagram do this week?”</i></li>
                  </ol>
                  <div style={{ fontSize: 13, color: C.textSecondary, marginTop: 10, lineHeight: 1.55 }}>
                    Your Claude workspace asks for a Client ID and Secret? Create one under{' '}
                    <button type="button" onClick={() => setMcpTab('access')} style={{ background: 'none', border: 'none', padding: 0, color: C.primary, cursor: 'pointer', fontFamily: FONT, fontSize: 13, fontWeight: 600 }}>Access &amp; keys</button>
                    {' '}and paste both into the connector’s <b>Advanced settings</b>.
                  </div>
                </>
              )}

              {connectApp === 'code' && (
                <>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>Run in your terminal</div>
                  {claudeCodeCmd && <CopyRow value={claudeCodeCmd} tag="cccmd" />}
                  <ol style={{ fontSize: 15, color: C.text, lineHeight: 1.8, paddingLeft: 20, margin: '12px 0 0' }}>
                    <li>Run the command above.</li>
                    <li>In Claude Code, type <code style={{ fontFamily: MONO, fontSize: 14 }}>/mcp</code>, pick <b>forge-growth</b> and sign in.</li>
                  </ol>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 14, padding: '12px 14px', borderRadius: 12, background: 'var(--c-surfaceSubtle, #EEEDE8)' }}>
                    <Package size={18} color={C.text} />
                    <div style={{ flex: '1 1 240px', fontSize: 14, color: C.textSecondary, lineHeight: 1.5 }}>
                      <b style={{ color: C.text }}>Optional: the Forge Growth plugin</b> adds the connector plus skills that teach Claude how this app works (Social, funnel, templates, automations, agents, ads, revenue). Unzip it and add the folder as a plugin.
                    </div>
                    <a href={api.mcp.pluginZipUrl()} download="forge-growth-plugin.zip" style={{ ...btnGhost, textDecoration: 'none' }}>
                      <Download size={15} /> Download plugin
                    </a>
                  </div>
                </>
              )}

              {connectApp === 'other' && (
                <>
                  <div style={{ fontSize: 14, color: C.textSecondary, lineHeight: 1.6, marginBottom: 10 }}>
                    Apps that support OAuth use the same server URL as Claude. Apps that only take a plain URL need an
                    {' '}<b>API key</b> in the address — create one under{' '}
                    <button type="button" onClick={() => setMcpTab('access')} style={{ background: 'none', border: 'none', padding: 0, color: C.primary, cursor: 'pointer', fontFamily: FONT, fontSize: 14, fontWeight: 600 }}>Access &amp; keys</button>
                    {' '}and put it in place of <code style={{ fontFamily: MONO, fontSize: 13 }}>&lt;YOUR_KEY&gt;</code>. Treat that whole URL like a password.
                  </div>
                  {oauthUrl && <><div style={{ fontSize: 13, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.04em', margin: '0 0 6px' }}>With OAuth</div><CopyRow value={oauthUrl} tag="oauthurl2" /></>}
                  {legacyUrl && <><div style={{ fontSize: 13, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.04em', margin: '12px 0 6px' }}>With an API key</div><CopyRow value={legacyUrl} tag="legacyurl" muted /></>}
                </>
              )}
            </Step>
          </div>

          <div style={card}>
            <h2 style={h2}>Connected apps</h2>
            {connected.length === 0 ? (
              <p style={{ ...sub, margin: 0 }}>Nothing connected yet. Finish step 3 above and it will show here.</p>
            ) : (
              <>
                <p style={sub}>Apps currently able to use Forge Growth. Remove one under Access &amp; keys to cut it off.</p>
                {connected.map((c, i) => (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: i === 0 ? 'none' : `1px solid ${C.border}` }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--c-successText, #0F6E56)', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{c.name}</div>
                      <div style={{ fontSize: 13, color: C.textSecondary }}>{c.how} · {c.detail}</div>
                    </div>
                  </div>
                ))}
              </>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 14, fontSize: 13, color: C.textSecondary, lineHeight: 1.5 }}>
              <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>Changing what Claude can do applies <b>immediately</b>, even to apps already connected.</span>
            </div>
          </div>
        </>
      )}

      {mcpTab === 'permissions' && (
        <>
      {/* What Claude can do — grouped by the part of the app it touches. */}
      <div style={{ ...card, opacity: master ? 1 : 0.6 }}>
        <h2 style={h2}>What Claude can do</h2>
        <p style={sub}>
          Pick a part of the app, then switch on what Claude may do there. Each switch covers a
          group of tools — open it to see every tool in plain words and whether it only
          reads, changes your setup, reaches real people, costs money or deletes.
        </p>

        {/* Summary strip — "how much is Claude allowed to do right now?" */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          background: 'var(--c-surfaceSubtle, ' + C.pageBg + ')', borderRadius: 10,
          padding: '11px 14px', marginBottom: 14,
        }}>
          <Wrench size={15} strokeWidth={2} color={C.textSecondary} />
          <span style={{ fontSize: 14, color: C.text, fontWeight: 600 }}>
            <span style={{ fontFamily: MONO }}>{enabledTools}</span>
            {' of '}
            <span style={{ fontFamily: MONO }}>{totalTools}</span>
            {' tools switched on'}
          </span>
        </div>

        {cats.length === 0 ? (
          <div style={{ fontSize: 14, color: C.textSecondary }}>
            No tool list was returned by the server. Rebuild the backend to pick it up.
          </div>
        ) : (() => {
          const areas = settings.catalog?.areas?.length
            ? settings.catalog.areas
            : [{ key: 'all', label: 'All tools', description: '', categories: cats.map(c => c.key) }];
          const area = areas.find(a => a.key === mcpArea) || areas[0];
          const areaCats = area.categories.map(k => cats.find(c => c.key === k)).filter(Boolean);
          const onIn = (a) => a.categories.reduce((n, k) => {
            const c = cats.find(x => x.key === k); return n + (c && c.enabled ? c.toolCount : 0);
          }, 0);
          const allIn = (a) => a.categories.reduce((n, k) => n + (cats.find(x => x.key === k)?.toolCount || 0), 0);
          const kinds = settings.catalog?.kinds || {};
          const anyOff = areaCats.some(c => !c.enabled);
          return (
            <>
              <div style={{ overflowX: 'auto', marginBottom: 12 }}>
                <PillStrip
                  value={area.key}
                  onChange={setMcpArea}
                  items={areas.map(a => ({ id: a.key, label: `${a.label} · ${onIn(a)}/${allIn(a)}` }))}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                <div style={{ fontSize: 14, color: C.textSecondary, lineHeight: 1.5, flex: '1 1 260px' }}>{area.description}</div>
                {areaCats.length > 1 && (
                  <button
                    type="button"
                    disabled={!master || savingCap}
                    onClick={() => saveSettings({ categories: Object.fromEntries(areaCats.map(c => [c.key, anyOff])) })}
                    style={{
                      padding: '7px 12px', borderRadius: 8, border: `1px solid ${C.border}`, background: 'transparent',
                      color: C.text, fontSize: 13, fontWeight: 600, fontFamily: FONT,
                      cursor: !master || savingCap ? 'not-allowed' : 'pointer', opacity: !master ? 0.5 : 1,
                    }}
                  >
                    {anyOff ? `Turn on all of ${area.label}` : `Turn off all of ${area.label}`}
                  </button>
                )}
              </div>
              {areaCats.map(c => (
                <McpCategoryCard
                  key={c.key}
                  cat={c}
                  kinds={kinds}
                  disabled={!master}
                  saving={savingCap}
                  onToggle={(v) => saveSettings({ categories: { [c.key]: v } })}
                />
              ))}
              {/* Legend — the words used on every tool, explained once. */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 14px', marginTop: 12 }}>
                {MCP_KIND_ORDER.filter(k => kinds[k]).map(k => (
                  <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: C.textSecondary }}>
                    <TierPill kind={k} label={kinds[k].label} /> {kinds[k].description}
                  </span>
                ))}
              </div>
            </>
          );
        })()}
      </div>

        </>
      )}

      {mcpTab === 'access' && (
        <>
      {/* OAuth clients — what Claude's connector dialog actually asks for. */}
      <div style={card}>
        <h2 style={h2}>OAuth clients <span style={{ fontWeight: 500, color: C.textMuted, fontSize: 14 }}>· optional</span></h2>
        <p style={{ fontSize: 14, color: C.textSecondary, margin: '0 0 14px', lineHeight: 1.6 }}>
          Claude connects with a <strong>Client ID + Client Secret</strong> and signs you in through a browser
          window — nothing secret ends up in the URL. Create one per connector, paste both values into Claude&apos;s
          <em> Advanced settings</em>, and revoke here to cut it off instantly.
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <input
            value={oauthName}
            onChange={e => setOauthName(e.target.value)}
            placeholder="Connector name (e.g. Claude — Sam)"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            disabled={creatingOauth || !oauthName.trim()}
            onClick={async () => {
              try {
                setCreatingOauth(true);
                const c = await api.mcp.createOauthClient({ name: oauthName.trim() });
                setFreshClient(c);          // secret is returned once and never again
                setOauthName('');
                await load();
              } catch (err) { notify(err.message || 'Could not create the OAuth client'); }
              finally { setCreatingOauth(false); }
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, background: C.primary, color: '#fff',
              border: 'none', borderRadius: 8, padding: '0 16px', fontSize: 15, fontWeight: 600,
              cursor: creatingOauth || !oauthName.trim() ? 'not-allowed' : 'pointer',
              opacity: creatingOauth || !oauthName.trim() ? 0.55 : 1, fontFamily: FONT,
            }}>
            <Plus size={14} /> Create client
          </button>
        </div>

        {shownClients.length === 0 ? (
          <div style={{ fontSize: 15, color: C.textMuted, padding: '10px 0' }}>
            {autoClients.length ? 'No clients created by hand.' : 'No OAuth clients yet — you only need one if your Claude workspace asks for a Client ID.'}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT }}>
            <thead>
              <tr>
                {['Name', 'Client ID', 'Connections', 'Enabled', ''].map((h, i) => (
                  <th key={i} style={{ textAlign: i > 1 && i < 4 ? 'center' : 'left', padding: '8px 10px',
                    fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
                    color: C.textMuted, borderBottom: `1px solid ${C.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shownClients.map(c => (
                <tr key={c.id}>
                  <td style={{ padding: '10px', fontSize: 15, borderBottom: `1px solid ${C.border}` }}>
                    {c.name}
                    {c.dynamic && (
                      <span style={{ marginLeft: 7, fontSize: 12, color: C.textMuted,
                        border: `1px solid ${C.border}`, borderRadius: 5, padding: '1px 5px' }}>AUTO</span>
                    )}
                  </td>
                  <td style={{ padding: '10px', fontSize: 14, fontFamily: MONO, color: C.textSecondary,
                    borderBottom: `1px solid ${C.border}` }}>{c.clientId}</td>
                  <td style={{ padding: '10px', fontSize: 14, textAlign: 'center', color: C.textSecondary,
                    borderBottom: `1px solid ${C.border}` }}>{c.activeTokens || 0}</td>
                  <td style={{ padding: '10px', textAlign: 'center', borderBottom: `1px solid ${C.border}` }}>
                    <Toggle
                      checked={c.isEnabled}
                      onChange={async (v) => {
                        try { await api.mcp.updateOauthClient(c.id, { isEnabled: v }); await load(); }
                        catch (err) { notify(err.message || 'Could not update the client'); }
                      }}
                    />
                  </td>
                  <td style={{ padding: '10px', textAlign: 'right', borderBottom: `1px solid ${C.border}` }}>
                    <button onClick={() => setOauthDeleteTarget(c)} title="Remove this client"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.primary, padding: 4 }}>
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      {autoClients.length > 0 && (
          <button type="button" onClick={() => setShowAutoClients(v => !v)}
            style={{ marginTop: 12, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: FONT, fontSize: 14, fontWeight: 600, color: C.textSecondary, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <ChevronRight size={14} style={{ transform: showAutoClients ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
            {showAutoClients ? 'Hide' : 'Show'} {autoClients.length} added automatically when Claude connected
          </button>
        )}
      </div>

      {/* API keys */}
      <div style={card}>
        <h2 style={h2}>API keys <span style={{ fontWeight: 500, color: C.textMuted, fontSize: 14 }}>· older apps only</span></h2>
        <p style={sub}>For MCP apps that cannot sign in with OAuth: the key goes inside the server URL. Claude does not need one. The full key is shown once.</p>

        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          <input
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') createKey(); }}
            placeholder="Key label (e.g. My MacBook — Claude Desktop)"
            style={{
              flex: 1, padding: '9px 12px', borderRadius: 8, border: `1px solid ${C.border}`,
              fontSize: 15, fontFamily: FONT, background: C.cardBg, color: C.text,
            }}
          />
          <button
            onClick={createKey}
            disabled={creating}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px',
              background: C.primary, color: '#fff', border: 'none', borderRadius: 8,
              fontSize: 15, fontWeight: 600, cursor: creating ? 'wait' : 'pointer', fontFamily: FONT,
            }}
          >
            <Plus size={15} /> Generate key
          </button>
        </div>

        {keys.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: C.textMuted, fontSize: 15, border: `1px dashed ${C.border}`, borderRadius: 8 }}>
            No API keys yet.
          </div>
        ) : (
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15 }}>
              <thead>
                <tr style={{ background: 'var(--c-hover, #f7f7f3)', textAlign: 'left' }}>
                  <th style={{ padding: '10px 14px', fontWeight: 600, color: C.textSecondary }}>Label</th>
                  <th style={{ padding: '10px 14px', fontWeight: 600, color: C.textSecondary }}>Key</th>
                  <th style={{ padding: '10px 14px', fontWeight: 600, color: C.textSecondary }}>Last used</th>
                  <th style={{ padding: '10px 14px', fontWeight: 600, color: C.textSecondary }}>Enabled</th>
                  <th style={{ padding: '10px 14px' }}></th>
                </tr>
              </thead>
              <tbody>
                {keys.map(k => (
                  <tr key={k.id} style={{ borderTop: `1px solid ${C.border}` }}>
                    <td style={{ padding: '10px 14px', color: C.text }}>{k.label}</td>
                    <td style={{ padding: '10px 14px', color: C.textSecondary, fontFamily: MONO, fontSize: 14 }}>
                      {k.keyPrefix}…{k.keyLast4}
                    </td>
                    <td style={{ padding: '10px 14px', color: C.textSecondary }}>
                      {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'Never'}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <Toggle checked={k.isEnabled} onChange={() => toggleKey(k)} />
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                      <button
                        onClick={() => setRevokeTarget(k)}
                        title="Revoke"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.primary, padding: 4 }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

        </>
      )}

      {mcpTab === 'advanced' && (
        <>
      {/* API areas — scope for the Direct API access tool only. */}
      <div style={{ ...card, opacity: master && directApiOn ? 1 : 0.6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <h2 style={{ ...h2, margin: 0 }}>API areas</h2>
          <TierPill tier="advanced" label="Full API access" />
        </div>
        <p style={sub}>
          These scope the <code style={{ fontFamily: MONO, fontSize: 13 }}>forgechat_request</code> tool
          in <strong>Direct API access</strong> — which internal endpoints it may call.
          {' '}
          {directApiOn
            ? 'Anything not covered by an area below is refused.'
            : 'Direct API access is switched off, so none of these apply right now.'}
        </p>
        {(settings.catalog?.apiAreas || []).map((a, i) => (
          <div key={a.key} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16,
            padding: '12px 0', borderTop: i === 0 ? 'none' : `1px solid ${C.border}`,
          }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {a.sensitive && <ShieldAlert size={13} strokeWidth={2.5} color={C.primary} />}
                <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{a.label}</span>
              </div>
              <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 2, lineHeight: 1.45 }}>{a.description}</div>
            </div>
            <Toggle
              label={`${a.label}: ${settings.capabilities[a.key] ? 'on' : 'off'}`}
              checked={!!settings.capabilities[a.key]}
              disabled={!master || savingCap}
              onChange={(v) => saveSettings({ capabilities: { [a.key]: v } })}
            />
          </div>
        ))}
      </div>


          {/* Local stdio — for developers running the MCP server from source. */}
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Terminal size={16} color={C.textSecondary} />
              <h2 style={{ ...h2, margin: 0 }}>Local server (developers only)</h2>
            </div>
            <p style={sub}>
              Only needed when running the MCP server from this repository on your own machine. Everyone else should use{' '}
              <button type="button" onClick={() => setMcpTab('connect')} style={{ background: 'none', border: 'none', padding: 0, color: C.primary, cursor: 'pointer', fontFamily: FONT, fontSize: 14, fontWeight: 600 }}>Connect Claude</button>.
            </p>
            <ol style={{ fontSize: 14, color: C.textSecondary, lineHeight: 1.8, paddingLeft: 18, margin: '0 0 14px' }}>
              <li><code style={{ fontFamily: MONO, fontSize: 13 }}>cd {install?.serverPath?.replace('/src/index.js', '') || '/root/ForgeGrowth/mcp-server'} && npm install</code></li>
              <li>Claude Desktop → <b>Settings → Developer → Edit Config</b>, add the block below with an API key, then restart Claude.</li>
            </ol>
            {install && (
              <>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                  <button type="button" onClick={() => copy(snippet, 'snippet')} style={btnGhost}>
                    {copied === 'snippet' ? <Check size={13} /> : <Copy size={13} />}{copied === 'snippet' ? 'Copied' : 'Copy config'}
                  </button>
                </div>
                <div style={codeBox}>{snippet}</div>
              </>
            )}
          </div>
        </>
      )}


      {/* One-time OAuth secret. Shown once because only its hash is stored —
          there is no way to recover it later, and saying so up front avoids
          someone closing this and assuming they can look it up. */}
      {freshClient && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, fontFamily: FONT }}>
          <div style={{ background: C.cardBg, borderRadius: 14, padding: 24, width: 520, boxShadow: C.shadowLg }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <Key size={18} color={C.green} />
              <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>OAuth client created</div>
            </div>
            <div style={{ fontSize: 15, color: C.textSecondary, marginBottom: 14, lineHeight: 1.6 }}>
              Paste both values into Claude → <b>Settings → Connectors → Add custom connector → Advanced settings</b>.
              The secret is shown <b>once</b> — only a hash is stored, so it cannot be shown again.
            </div>

            {[['Client ID', freshClient.clientId, 'cid'], ['Client Secret', freshClient.clientSecret, 'csec']].map(([label, val, k]) => (
              <div key={k} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 5 }}>{label}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <code style={{ flex: 1, ...codeBox, whiteSpace: 'nowrap', overflowX: 'auto', padding: '11px 13px' }}>{val}</code>
                  <button onClick={() => copy(val, k)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, background: C.primary, color: '#fff', border: 'none', borderRadius: 8, padding: '0 14px', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
                    {copied === k ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
              </div>
            ))}

            <div style={{ marginTop: 6, marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 5 }}>Remote MCP server URL</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <code style={{ flex: 1, ...codeBox, whiteSpace: 'nowrap', overflowX: 'auto', padding: '11px 13px' }}>
                  {`${window.location.origin}/api/mcp`}
                </code>
                <button onClick={() => copy(`${window.location.origin}/api/mcp`, 'curl')}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, padding: '0 14px', fontSize: 15, cursor: 'pointer', color: C.text, fontFamily: FONT }}>
                  {copied === 'curl' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => setFreshClient(null)}
                style={{ background: C.text, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {oauthDeleteTarget && (
        <DeleteConfirmModal
          open
          title="Remove this OAuth client?"
          message={`“${oauthDeleteTarget.name}” will stop working immediately, and any Claude connector using it will need to be reconnected with new credentials.`}
          confirmText="Remove client"
          onCancel={() => setOauthDeleteTarget(null)}
          onConfirm={async () => {
            try { await api.mcp.deleteOauthClient(oauthDeleteTarget.id); setOauthDeleteTarget(null); await load(); }
            catch (err) { notify(err.message || 'Could not remove the client'); }
          }}
        />
      )}

      {/* One-time fresh-key modal */}
      {freshKey && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, fontFamily: FONT }}>
          <div style={{ background: C.cardBg, borderRadius: 14, padding: 24, width: 480, boxShadow: C.shadowLg }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <Key size={18} color={C.green} />
              <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>API key created</div>
            </div>
            <div style={{ fontSize: 15, color: C.textSecondary, marginBottom: 12, lineHeight: 1.6 }}>
              Copy this key now — it won’t be shown again.
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <code style={{ flex: 1, ...codeBox, whiteSpace: 'nowrap', overflowX: 'auto', padding: '12px 14px' }}>{freshKey.key}</code>
              <button
                onClick={() => copy(freshKey.key, 'fresh')}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: C.primary, color: '#fff', border: 'none', borderRadius: 8, padding: '0 14px', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}
              >
                {copied === 'fresh' ? <Check size={14} /> : <Copy size={14} />}
                {copied === 'fresh' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '9px 12px', marginBottom: 14,
              background: 'var(--c-xf1f6ff, #F1F6FF)', border: '1px solid #C8DAF5', borderRadius: 8, fontSize: 14, color: 'var(--c-x254c87, #254C87)' }}>
              <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>
                Connecting <b>Claude.ai</b>? You do not need this key. Use the server URL
                {' '}<code style={{ fontFamily: MONO, fontSize: 13 }}>{oauthUrl}</code>{' '}
                with an <b>OAuth client</b> instead. Pasting the key URL below into Claude’s connector dialog
                will connect and then immediately fail.
              </span>
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.textSecondary, margin: '0 0 6px' }}>
              Legacy connector URL <span style={{ fontWeight: 400 }}>— for MCP clients that take a plain URL and no OAuth</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
              <code style={{ flex: 1, ...codeBox, whiteSpace: 'nowrap', overflowX: 'auto', padding: '12px 14px', color: C.textSecondary }}>
                {`${window.location.origin}/api/mcp/http/${freshKey.key}`}
              </code>
              <button
                onClick={() => copy(`${window.location.origin}/api/mcp/http/${freshKey.key}`, 'freshurl')}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, padding: '0 14px', fontSize: 15, fontWeight: 600, cursor: 'pointer', color: C.textSecondary, fontFamily: FONT }}
              >
                {copied === 'freshurl' ? <Check size={14} /> : <Copy size={14} />}
                {copied === 'freshurl' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div style={{ textAlign: 'right' }}>
              <button
                onClick={() => setFreshKey(null)}
                style={{ background: C.text, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      <DeleteConfirmModal
        open={!!revokeTarget}
        title="Revoke API key"
        message={`Revoke “${revokeTarget?.label}”? Any MCP client using it will immediately lose access.`}
        confirmText="Revoke"
        onConfirm={revokeKey}
        onCancel={() => setRevokeTarget(null)}
      />
    </div>
  );
}

function IntegrationsTab() {
  // view: 'apps' | 'google' | 'service:<provider-key>'
  const [view, setView] = useState('apps');
  const [credentials, setCredentials] = useState(null);
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCredForm, setShowCredForm] = useState(false);
  const [credForm, setCredForm] = useState({ clientId: '', clientSecret: '', redirectUri: '' });
  const [savingCreds, setSavingCreds] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [busyProvider, setBusyProvider] = useState(null);
  const [toast, setToast] = useState('');

  const defaultRedirect = `${window.location.origin}/api/integrations/oauth/callback`;

  const load = async () => {
    try {
      setError('');
      const [creds, list] = await Promise.all([
        api.integrations.listCredentials(),
        api.integrations.list(),
      ]);
      setCredentials(creds);
      setConnections(list);
      setCredForm({
        clientId: creds.configured ? (creds.clientId || '') : '',
        clientSecret: '',  // never returned; blank = keep existing
        redirectUri: (creds.configured && creds.redirectUri) || defaultRedirect,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // Receive postMessage from the OAuth callback popup so we can refresh the
  // list the moment Google sends the user back. Same-origin only — the popup
  // posts to window.opener within the same origin.
  useEffect(() => {
    const handler = (e) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data || {};
      if (d.type === 'forgechat:integration:connected') {
        setToast(`Connected ${(d.provider || '').replace('_', ' ')}${d.email ? ` as ${d.email}` : ''}`);
        load();
        // If the user initiated the connect from inside the Google detail
        // view, jump them straight to the service browser so they can
        // immediately see what's now available.
        if (d.provider) setView(`service:${d.provider}`);
      } else if (d.type === 'forgechat:integration:error') {
        setToast(`Connection failed: ${d.error}`);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const saveCreds = async () => {
    if (!credForm.clientId.trim()) { setError('Client ID is required'); return; }
    if (!credForm.redirectUri.trim()) { setError('Redirect URI is required'); return; }
    if (!credentials?.configured && !credForm.clientSecret.trim()) {
      setError('Client Secret is required when configuring for the first time'); return;
    }
    try {
      setSavingCreds(true);
      setError('');
      await api.integrations.saveCredentials({
        clientId: credForm.clientId.trim(),
        clientSecret: credForm.clientSecret.trim(),
        redirectUri: credForm.redirectUri.trim(),
      });
      setToast('Credentials saved');
      setShowCredForm(false);
      setShowSecret(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingCreds(false);
    }
  };

  const handleConnect = (provider) => {
    if (!credentials?.configured) {
      setError('Save your Google OAuth credentials first.');
      setShowCredForm(true);
      return;
    }
    setBusyProvider(provider);
    const url = api.integrations.connectUrl(provider);
    const w = 560, h = 720;
    const left = (window.screen.width - w) / 2;
    const top = (window.screen.height - h) / 2;
    const popup = window.open(url, 'forgechat-google-oauth',
      `width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) {
      setError('Pop-up blocked — allow pop-ups for this site, then click Connect again.');
      setBusyProvider(null);
      return;
    }
    // Clear the busy flag once the popup closes (regardless of outcome) so the
    // user can retry if Google didn't issue a postMessage.
    const t = setInterval(() => {
      if (popup.closed) { clearInterval(t); setBusyProvider(null); }
    }, 700);
  };

  const handleDisconnect = async (conn) => {
    if (!confirm(`Disconnect ${conn.providerLabel}? You'll need to re-authorize to reconnect.`)) return;
    try {
      await api.integrations.disconnect(conn.id);
      setToast(`Disconnected ${conn.providerLabel}`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleTest = async (conn) => {
    try {
      setBusyProvider(conn.provider);
      const r = await api.integrations.test(conn.id);
      setToast(`✓ ${conn.providerLabel} is healthy${r.email ? ` (${r.email})` : ''}`);
      await load();
    } catch (err) {
      setError(`Test failed: ${err.message}`);
      await load();
    } finally {
      setBusyProvider(null);
    }
  };

  const copyRedirect = async () => {
    try { await navigator.clipboard.writeText(defaultRedirect); setToast('Redirect URI copied'); } catch {/* */}
  };

  const findConn = (key) => connections.find(c => c.provider === key);

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.textMuted, fontSize: 15, fontFamily: FONT }}>
        <Loader2 size={16} style={{ marginRight: 8, animation: 'spin 1s linear infinite' }} /> Loading…
      </div>
    );
  }

  const googleApp = INTEGRATION_APPS[0];
  const googleConnCount = googleApp.providers.filter(p => connections.find(c => c.provider === p)?.status === 'connected').length;

  // ─── Sub-views ────────────────────────────────────────────────────

  const renderAppsView = () => (
    <div>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 15, color: C.textSecondary, marginTop: 4 }}>
          Connect third-party apps so your automations can read and write data outside of WhatsApp.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        <AppCard
          color={googleApp.color}
          logo={googleApp.logo(28)}
          label={googleApp.label}
          blurb={googleApp.blurb}
          onClick={() => setView('google')}
          badge={googleConnCount > 0 ? (
            <span style={{ fontSize: 13, padding: '2px 8px', background: 'var(--c-sdcfce7, #dcfce7)', color: 'var(--c-s15803d, #15803d)', borderRadius: 6, fontWeight: 600 }}>
              {googleConnCount} of {googleApp.providers.length} connected
            </span>
          ) : credentials?.configured ? (
            <span style={{ fontSize: 13, padding: '2px 8px', background: 'var(--c-sfef9c3, #fef9c3)', color: 'var(--c-warnText, #854d0e)', borderRadius: 6, fontWeight: 600 }}>Credentials saved · not connected</span>
          ) : (
            <span style={{ fontSize: 13, padding: '2px 8px', background: C.sidebarBg, color: C.textMuted, borderRadius: 6, fontWeight: 600 }}>Not configured</span>
          )}
        />
      </div>

      <div style={{ marginTop: 24, padding: 14, background: C.sidebarBg, border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 14, color: C.textSecondary, lineHeight: 1.7 }}>
        <div style={{ fontWeight: 600, color: C.text, marginBottom: 4 }}>How automations use these</div>
        Once an app is connected, your automation Actions can call into it:
        <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
          <li><b>Send Email</b> — via Gmail.</li>
          <li><b>Append to Google Sheet</b> — pick a sheet + tab.</li>
          <li><b>Create Calendar Event</b> — on the connected calendar.</li>
        </ul>
      </div>
    </div>
  );

  const renderCredentialsCard = () => (
    <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Key size={16} color={C.primary} />
          <div style={{ fontWeight: 600, fontSize: 15, color: C.text }}>Google API credentials</div>
          {credentials?.configured && !showCredForm && (
            <span style={{ fontSize: 13, padding: '2px 8px', background: '#16a34a22', color: 'var(--c-s15803d, #15803d)', borderRadius: 6, fontWeight: 600 }}>SAVED</span>
          )}
          {!credentials?.configured && !showCredForm && (
            <span style={{ fontSize: 13, padding: '2px 8px', background: 'var(--c-sfef9c3, #fef9c3)', color: 'var(--c-warnText, #854d0e)', borderRadius: 6, fontWeight: 600 }}>REQUIRED</span>
          )}
        </div>
        {!showCredForm && (
          <button onClick={() => setShowCredForm(true)} style={credentials?.configured ? igBtnSecondary() : igBtnPrimary()}>
            <Settings size={13} /> {credentials?.configured ? 'Edit credentials' : 'Configure credentials'}
          </button>
        )}
      </div>

      <div style={{ fontSize: 14, color: C.textSecondary, marginBottom: 14, lineHeight: 1.6 }}>
        Create an OAuth 2.0 Client ID at <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" style={{ color: C.primary }}>console.cloud.google.com/apis/credentials</a>{' '}
        → choose <b>Web application</b> → add the redirect URI below to <b>Authorized redirect URIs</b> → enable the <b>Sheets</b>, <b>Drive</b>, <b>Calendar</b>, and <b>Gmail</b> APIs in the same project.
      </div>

      <div style={{ marginBottom: showCredForm ? 14 : 0 }}>
        <div style={igLabelStyle()}>Authorized redirect URI (use this in Google Cloud)</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={defaultRedirect} readOnly style={{ ...igInputStyle(), background: C.sidebarBg, fontFamily: "'DM Mono', monospace", fontSize: 14 }} />
          <button onClick={copyRedirect} style={igBtnSecondary()}><Copy size={13} /> Copy</button>
        </div>
      </div>

      {showCredForm && (
        <div>
          <div style={{ marginBottom: 12 }}>
            <div style={igLabelStyle()}>Client ID</div>
            <input value={credForm.clientId} onChange={e => setCredForm({ ...credForm, clientId: e.target.value })}
              placeholder="e.g. 123456789-abc.apps.googleusercontent.com"
              style={igInputStyle()} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={igLabelStyle()}>
              Client Secret {credentials?.configured && <span style={{ fontWeight: 400, color: C.textMuted, textTransform: 'none', letterSpacing: 0 }}>— leave blank to keep existing</span>}
            </div>
            <div style={{ position: 'relative' }}>
              <input
                type={showSecret ? 'text' : 'password'}
                value={credForm.clientSecret}
                onChange={e => setCredForm({ ...credForm, clientSecret: e.target.value })}
                placeholder={credentials?.configured ? '••••••••' : 'GOCSPX-...'}
                style={{ ...igInputStyle(), paddingRight: 38 }} />
              <button type="button" onClick={() => setShowSecret(s => !s)}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 0, cursor: 'pointer', color: C.textMuted }}>
                {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
          <div style={{ marginBottom: 14 }}>
            <div style={igLabelStyle()}>Redirect URI (must match Google Cloud exactly)</div>
            <input value={credForm.redirectUri} onChange={e => setCredForm({ ...credForm, redirectUri: e.target.value })}
              style={{ ...igInputStyle(), fontFamily: "'DM Mono', monospace", fontSize: 14 }} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={saveCreds} disabled={savingCreds} style={igBtnPrimary(savingCreds)}>
              {savingCreds ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Saving…</> : <><Check size={13} /> Save credentials</>}
            </button>
            <button onClick={() => { setShowCredForm(false); setShowSecret(false); }} style={igBtnSecondary()}>Cancel</button>
          </div>
        </div>
      )}

      {!showCredForm && credentials?.configured && (
        <div style={{ marginTop: 14, fontSize: 14, color: C.textMuted, fontFamily: "'DM Mono', monospace" }}>
          Client ID: {credentials.clientId ? `${credentials.clientId.slice(0, 40)}${credentials.clientId.length > 40 ? '…' : ''}` : '—'}
        </div>
      )}
    </div>
  );

  const renderGoogleView = () => (
    <div>
      {/* Breadcrumb */}
      <button onClick={() => setView('apps')} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 0, cursor: 'pointer',
        color: C.textSecondary, fontSize: 15, fontFamily: FONT, padding: '4px 0', marginBottom: 16,
      }}>
        <ChevronLeft size={14} /> Apps
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
        <div style={{ width: 56, height: 56, borderRadius: 14, background: 'var(--c-surface, #fff)', border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {googleApp.logo(34)}
        </div>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: 0 }}>Google</h2>
          <div style={{ fontSize: 15, color: C.textSecondary, marginTop: 2 }}>{googleApp.blurb}</div>
        </div>
      </div>

      {renderCredentialsCard()}

      <div style={{ fontSize: 13, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
        Google services
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {PROVIDERS.map(p => {
          const conn = findConn(p.key);
          const isConnected = conn && conn.status === 'connected';
          const isError = conn && conn.status === 'error';
          const Icon = p.icon;
          const busy = busyProvider === p.key;
          return (
            <div key={p.key} style={{
              background: C.cardBg, border: `1px solid ${isConnected ? '#bbf7d0' : isError ? '#fecaca' : C.border}`,
              borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 38, height: 38, borderRadius: 10, background: `${p.color}22`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon size={20} color={p.color} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, color: C.text }}>{p.label}</div>
                  <div style={{ fontSize: 13, color: C.textSecondary }}>{p.blurb}</div>
                </div>
                {isConnected && <CheckCircle2 size={16} color="#16a34a" />}
                {isError && <AlertCircle size={16} color="var(--c-primary, #dc2626)" />}
              </div>

              {conn ? (
                <div style={{ fontSize: 14, color: C.textSecondary, padding: '8px 10px', background: C.sidebarBg, borderRadius: 8, border: `1px solid ${C.border}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <User size={12} />
                    <span style={{ color: C.text, fontWeight: 500 }}>{conn.accountEmail || '(unknown)'}</span>
                  </div>
                  {conn.accountName && (
                    <div style={{ marginTop: 2, fontSize: 13 }}>{conn.accountName}</div>
                  )}
                  {conn.lastUsedAt && (
                    <div style={{ marginTop: 4, fontSize: 13, color: C.textMuted }}>
                      Last used {new Date(conn.lastUsedAt).toLocaleString()}
                    </div>
                  )}
                  {isError && conn.lastError && (
                    <div style={{ marginTop: 6, fontSize: 13, color: 'var(--c-dangerText, #A32D2D)' }}>
                      {conn.lastError}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 14, color: C.textMuted, fontStyle: 'italic' }}>Not connected</div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 'auto', flexWrap: 'wrap' }}>
                {isConnected ? (
                  <>
                    <button onClick={() => setView(`service:${p.key}`)} style={igBtnPrimary()}>
                      <ChevronRight size={13} /> Open
                    </button>
                    <button onClick={() => handleConnect(p.key)} disabled={busy} style={igBtnSecondary(busy)} title="Reconnect to refresh tokens">
                      {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={13} />}
                    </button>
                    <button onClick={() => handleTest(conn)} disabled={busy} style={igBtnSecondary(busy)} title="Run a live health check">
                      <Play size={12} />
                    </button>
                    <button onClick={() => handleDisconnect(conn)} style={igBtnDanger()} title="Disconnect">
                      <Unplug size={13} />
                    </button>
                  </>
                ) : (
                  <button onClick={() => handleConnect(p.key)} disabled={busy || !credentials?.configured} style={igBtnPrimary(busy || !credentials?.configured)}>
                    {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Link2 size={13} />}
                    Connect
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  // ─── Master render ─────────────────────────────────────────────────

  return (
    <div style={{ flex: 1, padding: '16px 28px 28px', fontFamily: FONT, overflowY: 'auto' }}>
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>

      {error && (
        <div style={{ padding: '10px 14px', background: 'var(--c-dangerBg, #FCEBEB)', color: 'var(--c-dangerText, #A32D2D)', border: '1px solid #f5c2c2', borderRadius: 8, marginBottom: 16, fontSize: 15, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <span>{error}</span>
          <button onClick={() => setError('')} style={{ background: 'transparent', border: 0, cursor: 'pointer', color: 'var(--c-dangerText, #A32D2D)' }}><X size={14} /></button>
        </div>
      )}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, padding: '10px 14px', background: C.text, color: '#fff', borderRadius: 8, fontSize: 15, boxShadow: C.shadowLg, zIndex: 200 }}>{toast}</div>
      )}

      {view === 'apps' && renderAppsView()}
      {view === 'google' && renderGoogleView()}
      {view.startsWith('service:') && (
        <ServiceBrowser
          provider={view.slice('service:'.length)}
          connections={connections}
          onBack={() => setView('google')}
          onError={setError}
        />
      )}
    </div>
  );
}

// ─── Service browser (Sheets / Calendar / Gmail discovery) ────────────────

function ServiceBrowser({ provider, connections, onBack, onError }) {
  const conn = connections.find(c => c.provider === provider);
  if (!conn || conn.status !== 'connected') {
    return (
      <div>
        <button onClick={onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 0, cursor: 'pointer', color: C.textSecondary, fontSize: 15, fontFamily: FONT, padding: '4px 0', marginBottom: 16 }}>
          <ChevronLeft size={14} /> Google
        </button>
        <div style={{ padding: 24, background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, color: C.textMuted, textAlign: 'center' }}>
          This service isn't connected yet. Go back and click <b>Connect</b>.
        </div>
      </div>
    );
  }

  return (
    <div>
      <button onClick={onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 0, cursor: 'pointer', color: C.textSecondary, fontSize: 15, fontFamily: FONT, padding: '4px 0', marginBottom: 16 }}>
        <ChevronLeft size={14} /> <span>Apps</span> <ChevronRight size={12} /> <span>Google</span>
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
        <div style={{ width: 48, height: 48, borderRadius: 12, background: `${PROVIDERS.find(p => p.key === provider)?.color || C.primary}22`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {(() => {
            const p = PROVIDERS.find(x => x.key === provider);
            const Icon = p?.icon || Plug;
            return <Icon size={26} color={p?.color || C.primary} />;
          })()}
        </div>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: 0 }}>{PROVIDERS.find(p => p.key === provider)?.label || provider}</h2>
          <div style={{ fontSize: 15, color: C.textSecondary, marginTop: 2 }}>
            Connected as <b>{conn.accountEmail}</b>
          </div>
        </div>
      </div>

      {provider === 'google_sheets' && <SheetsBrowser onError={onError} />}
      {provider === 'google_calendar' && <CalendarBrowser onError={onError} />}
      {provider === 'gmail' && <GmailBrowser onError={onError} />}
    </div>
  );
}

// ─── Sheets browser: list spreadsheets → drill into tabs → preview headers ──

function SheetsBrowser({ onError }) {
  const [spreadsheets, setSpreadsheets] = useState(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [selectedSheet, setSelectedSheet] = useState(null);
  const [selectedTab, setSelectedTab] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);

  // Debounce the spreadsheet search so each keystroke doesn't hit Drive
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);
    api.integrations.sheets.listSpreadsheets(debouncedSearch)
      .then(r => { if (!cancelled) setSpreadsheets(r.spreadsheets || []); })
      .catch(err => { if (!cancelled) { onError(err.message); setSpreadsheets([]); } })
      .finally(() => { if (!cancelled) setLoadingList(false); });
    return () => { cancelled = true; };
  }, [debouncedSearch, onError]);

  const openSpreadsheet = async (s) => {
    setSelectedId(s.id);
    setSelectedSheet(null);
    setSelectedTab(null);
    setPreview(null);
    setLoadingDetail(true);
    try {
      const detail = await api.integrations.sheets.getSpreadsheet(s.id);
      setSelectedSheet(detail);
      if (detail.tabs?.length) {
        openTab(s.id, detail.tabs[0].title);
      }
    } catch (err) {
      onError(err.message);
    } finally {
      setLoadingDetail(false);
    }
  };

  const openTab = async (id, tabTitle) => {
    setSelectedTab(tabTitle);
    setPreview(null);
    setLoadingPreview(true);
    try {
      const p = await api.integrations.sheets.previewTab(id, tabTitle, 5);
      setPreview(p);
    } catch (err) {
      onError(err.message);
    } finally {
      setLoadingPreview(false);
    }
  };

  return (
    <div>
      <div style={{ marginBottom: 14, position: 'relative' }}>
        <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: C.textMuted, pointerEvents: 'none' }} />
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search your spreadsheets…"
          style={{ ...igInputStyle(), paddingLeft: 34 }}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: selectedId ? '1fr 1.6fr' : '1fr', gap: 16 }}>
        {/* Left: spreadsheet list */}
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, maxHeight: 520, overflowY: 'auto' }}>
          {loadingList && (
            <div style={{ padding: 18, textAlign: 'center', color: C.textMuted, fontSize: 15 }}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', marginRight: 6 }} /> Loading…
            </div>
          )}
          {!loadingList && spreadsheets && spreadsheets.length === 0 && (
            <div style={{ padding: 18, textAlign: 'center', color: C.textMuted, fontSize: 15 }}>
              No spreadsheets found.
            </div>
          )}
          {!loadingList && spreadsheets && spreadsheets.map(s => (
            <button
              key={s.id}
              onClick={() => openSpreadsheet(s)}
              style={{
                width: '100%', textAlign: 'left', cursor: 'pointer',
                background: selectedId === s.id ? C.sidebarBg : 'transparent',
                border: 0, borderBottom: `1px solid ${C.border}`,
                padding: '12px 14px', fontFamily: FONT,
                display: 'flex', alignItems: 'center', gap: 10,
              }}
            >
              <FileSpreadsheet size={16} color="var(--c-x0f9d58, #0F9D58)" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 500, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                <div style={{ fontSize: 13, color: C.textMuted }}>
                  Edited {s.modifiedTime ? new Date(s.modifiedTime).toLocaleDateString() : '—'}
                  {s.ownerEmail && ` · ${s.ownerEmail}`}
                </div>
              </div>
              <ChevronRight size={14} color={C.textMuted} />
            </button>
          ))}
        </div>

        {/* Right: spreadsheet detail */}
        {selectedId && (
          <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 14, maxHeight: 520, overflowY: 'auto' }}>
            {loadingDetail && (
              <div style={{ color: C.textMuted, fontSize: 15, textAlign: 'center', padding: 14 }}>
                <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', marginRight: 6 }} /> Loading spreadsheet…
              </div>
            )}
            {!loadingDetail && selectedSheet && (
              <>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <div style={{ fontWeight: 600, fontSize: 16, color: C.text }}>{selectedSheet.title}</div>
                    <a
                      href={`https://docs.google.com/spreadsheets/d/${selectedSheet.id}`}
                      target="_blank" rel="noreferrer"
                      style={{ color: C.textMuted, display: 'inline-flex', alignItems: 'center' }}
                      title="Open in Google Sheets"
                    >
                      <ExternalLink size={13} />
                    </a>
                  </div>
                  <div style={{ fontSize: 13, color: C.textMuted, fontFamily: "'DM Mono', monospace" }}>
                    ID: {selectedSheet.id}
                  </div>
                </div>

                <div>
                  <div style={igLabelStyle()}>Tabs ({selectedSheet.tabs.length})</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {selectedSheet.tabs.map(t => (
                      <button
                        key={t.sheetId}
                        onClick={() => openTab(selectedSheet.id, t.title)}
                        style={{
                          cursor: 'pointer', fontFamily: FONT,
                          padding: '5px 10px', borderRadius: 6, fontSize: 14,
                          background: selectedTab === t.title ? C.primary : C.cardBg,
                          color: selectedTab === t.title ? '#fff' : C.text,
                          border: `1px solid ${selectedTab === t.title ? C.primary : C.border}`,
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                        }}
                      >
                        <Table2 size={11} /> {t.title}
                        <span style={{ opacity: 0.7, fontSize: 12 }}>· {t.rowCount}×{t.columnCount}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {selectedTab && (
                  <div>
                    <div style={igLabelStyle()}>Preview · {selectedTab}</div>
                    {loadingPreview && (
                      <div style={{ color: C.textMuted, fontSize: 14, padding: 10 }}>
                        <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', marginRight: 6 }} /> Loading…
                      </div>
                    )}
                    {!loadingPreview && preview && (
                      <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 8 }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, fontFamily: FONT }}>
                          <thead>
                            <tr style={{ background: C.sidebarBg }}>
                              {(preview.headers.length ? preview.headers : ['(empty)']).map((h, i) => (
                                <th key={i} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: C.text, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h || `Col ${i + 1}`}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {preview.rows.length === 0 && (
                              <tr>
                                <td colSpan={preview.headers.length || 1} style={{ padding: '14px 10px', color: C.textMuted, fontStyle: 'italic', textAlign: 'center' }}>
                                  No data rows in this tab yet.
                                </td>
                              </tr>
                            )}
                            {preview.rows.map((row, ri) => (
                              <tr key={ri}>
                                {row.map((cell, ci) => (
                                  <td key={ci} style={{ padding: '6px 10px', borderBottom: ri === preview.rows.length - 1 ? 0 : `1px solid ${C.border}`, color: C.text, whiteSpace: 'nowrap', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {String(cell)}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div style={{ marginTop: 8, fontSize: 13, color: C.textMuted, fontFamily: "'DM Mono', monospace" }}>
                      Use in automation: <code>{selectedSheet.id} | {selectedTab}!A:Z | val1, val2, …</code>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Calendar browser: list calendars ──────────────────────────────────────

function CalendarBrowser({ onError }) {
  const [calendars, setCalendars] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.integrations.calendar.listCalendars()
      .then(r => { if (!cancelled) setCalendars(r.calendars || []); })
      .catch(err => { if (!cancelled) { onError(err.message); setCalendars([]); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [onError]);

  if (loading) return <div style={{ color: C.textMuted, fontSize: 15, padding: 20, textAlign: 'center' }}><Loader2 size={14} style={{ animation: 'spin 1s linear infinite', marginRight: 6 }} /> Loading calendars…</div>;

  return (
    <div>
      <div style={igLabelStyle()}>Your calendars ({calendars.length})</div>
      <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15, fontFamily: FONT }}>
          <thead>
            <tr style={{ background: C.sidebarBg }}>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: C.text, borderBottom: `1px solid ${C.border}` }}>Name</th>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: C.text, borderBottom: `1px solid ${C.border}` }}>ID</th>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: C.text, borderBottom: `1px solid ${C.border}` }}>Access</th>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: C.text, borderBottom: `1px solid ${C.border}` }}>Timezone</th>
            </tr>
          </thead>
          <tbody>
            {calendars.length === 0 && (
              <tr><td colSpan={4} style={{ padding: 16, textAlign: 'center', color: C.textMuted }}>No calendars found.</td></tr>
            )}
            {calendars.map(c => (
              <tr key={c.id}>
                <td style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, color: C.text }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 12, height: 12, borderRadius: 3, background: c.color || '#4285F4', display: 'inline-block' }} />
                    <span style={{ fontWeight: 500 }}>{c.summary}</span>
                    {c.primary && <span style={{ fontSize: 12, padding: '1px 6px', background: 'var(--c-sdbeafe, #dbeafe)', color: 'var(--c-s1d4ed8, #1d4ed8)', borderRadius: 4, fontWeight: 600 }}>PRIMARY</span>}
                  </div>
                  {c.description && <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>{c.description}</div>}
                </td>
                <td style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, color: C.textMuted, fontFamily: "'DM Mono', monospace", fontSize: 13 }}>{c.id}</td>
                <td style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, color: C.text, fontSize: 14 }}>{c.accessRole}</td>
                <td style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, color: C.text, fontSize: 14 }}>{c.timeZone}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 12, fontSize: 13, color: C.textMuted, fontFamily: "'DM Mono', monospace" }}>
        Use in automation: <code>&lt;calendarId&gt; | Title | startISO | endISO | description</code>
      </div>
    </div>
  );
}

// ─── Gmail browser: profile + labels ──────────────────────────────────────

function GmailBrowser({ onError }) {
  const [profile, setProfile] = useState(null);
  const [labels, setLabels] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.integrations.gmail.profile(), api.integrations.gmail.labels()])
      .then(([p, l]) => { if (!cancelled) { setProfile(p); setLabels(l.labels || []); } })
      .catch(err => { if (!cancelled) onError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [onError]);

  if (loading) return <div style={{ color: C.textMuted, fontSize: 15, padding: 20, textAlign: 'center' }}><Loader2 size={14} style={{ animation: 'spin 1s linear infinite', marginRight: 6 }} /> Loading Gmail…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <KpiCard label="Address" value={profile?.emailAddress || '—'} />
        <KpiCard label="Total messages" value={profile?.messagesTotal?.toLocaleString() || '—'} />
        <KpiCard label="Total threads" value={profile?.threadsTotal?.toLocaleString() || '—'} />
      </div>

      <div>
        <div style={igLabelStyle()}>Labels ({labels?.length || 0})</div>
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
          {labels && labels.map(l => (
            <span key={l.id} style={{
              fontSize: 14, padding: '4px 10px', borderRadius: 6,
              background: l.type === 'system' ? C.sidebarBg : 'var(--c-sfef3c7, #fef3c7)',
              color: l.type === 'system' ? C.text : 'var(--c-warnText, #854d0e)',
              border: `1px solid ${l.type === 'system' ? C.border : '#fde68a'}`,
              display: 'inline-flex', alignItems: 'center', gap: 5,
            }}>
              <Inbox size={11} /> {l.name}
            </span>
          ))}
          {labels && labels.length === 0 && <span style={{ color: C.textMuted, fontSize: 14, fontStyle: 'italic' }}>No labels.</span>}
        </div>
      </div>

      <div style={{ fontSize: 13, color: C.textMuted, fontFamily: "'DM Mono', monospace" }}>
        Use in automation: <code>to@example.com | Subject | Body</code>
      </div>
    </div>
  );
}

function KpiCard({ label, value }) {
  return (
    <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 13, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: C.text, fontFamily: "'DM Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  );
}

function igLabelStyle() {
  return {
    display: 'block', fontSize: 13, fontWeight: 600,
    color: C.textSecondary, textTransform: 'uppercase',
    letterSpacing: '0.04em', marginBottom: 6,
  };
}
function igInputStyle() {
  return {
    width: '100%', padding: '9px 11px',
    border: `1px solid ${C.border}`, borderRadius: 8,
    fontSize: 15, fontFamily: FONT, color: C.text, background: C.cardBg,
    outline: 'none', boxSizing: 'border-box',
  };
}
function igBtnPrimary(disabled) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 14px', background: disabled ? '#999' : C.primary,
    color: '#fff', border: 0, borderRadius: 8, fontSize: 15, fontWeight: 600,
    fontFamily: FONT, cursor: disabled ? 'not-allowed' : 'pointer',
  };
}
function igBtnSecondary(disabled) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 12px', background: C.cardBg, color: C.text,
    border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 15, fontWeight: 500,
    fontFamily: FONT, cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}
function igBtnDanger() {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 12px', background: 'var(--c-surface, #fff)', color: C.primary,
    border: `1px solid #fecaca`, borderRadius: 8, fontSize: 15, fontWeight: 500,
    fontFamily: FONT, cursor: 'pointer',
  };
}

// The Webhooks tab lists one CARD per webhook provider (WhatsApp).
// Clicking a card opens that provider's DETAIL view: config fields on top, a
// 10-per-page event-history table below. Each provider is a self-contained panel
// rendered in mode="card" (just the tile) or mode="detail" (the full page).
function WebhooksTab() {
  const [open, setOpen] = useState(null);   // null | 'whatsapp'
  if (open === 'whatsapp') return <WhatsAppWebhookPanel mode="detail" onBack={() => setOpen(null)} />;
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '16px 28px 28px', overflow: 'auto', fontFamily: FONT }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 4 }}>
          Inbound webhook endpoints. Open a provider to edit its configuration and view recent activity.
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14 }}>
        <WhatsAppWebhookPanel mode="card" onOpen={() => setOpen('whatsapp')} />
      </div>
    </div>
  );
}

// ── WhatsApp Cloud API webhook panel ─────────────────────────────────────────
// Verify token is editable and binds to the DEFAULT WhatsApp account — the only
// API-editable verify token the Meta handshake validates (the env
// META_WEBHOOK_VERIFY_TOKEN fallback is not settable from the app).
function WhatsAppWebhookPanel({ mode, onOpen, onBack }) {
  const [view] = useState(mode);        // 'card' | 'detail' (fixed per mount)

  // Config (from whatsapp_accounts — the default account holds the editable token)
  const [accounts, setAccounts] = useState([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const defaultAccount = accounts.find(a => a.isDefault) || accounts[0] || null;
  const [verifyToken, setVerifyToken] = useState('');
  const [tokenDirty, setTokenDirty] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [savingToken, setSavingToken] = useState(false);

  // Card summary
  const [summary, setSummary] = useState({ total: 0, lastReceivedAt: null });

  // History (recent 10, paged)
  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [testOpen, setTestOpen] = useState(false);
  const PAGE_SIZE = 10;

  const webhookUrl = `${window.location.origin}/api/webhook/whatsapp`;
  const [copied, setCopied] = useState(false);
  const copyUrl = async () => {
    try { await navigator.clipboard.writeText(webhookUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard blocked */ }
  };

  // Load the default account's verify token for editing.
  const loadAccounts = async () => {
    try {
      const data = await api.whatsappAccounts.list();
      setAccounts(data || []);
      const def = (data || []).find(a => a.isDefault) || (data || [])[0] || null;
      setVerifyToken(def?.verifyToken || '');
      setTokenDirty(false);
    } catch { /* config is optional — history still works */ }
    finally { setAccountsLoaded(true); }
  };

  // Card summary: total events + most-recent received_at (list is DESC).
  const loadSummary = async () => {
    try {
      const res = await api.webhookEvents.list({ limit: 1, offset: 0 });
      setSummary({ total: res.total || 0, lastReceivedAt: res.events?.[0]?.received_at || null });
    } catch { /* ignore */ }
  };

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.webhookEvents.list({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, q });
      setEvents(res.events || []);
      setTotal(res.total || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAccounts(); loadSummary(); }, []);
  // Fetch history when the detail view is open (and on page change).
  useEffect(() => { if (view === 'detail') load(); /* eslint-disable-next-line */ }, [view, page]);
  // Debounce payload search (detail view only).
  useEffect(() => {
    if (view !== 'detail') return;
    const id = setTimeout(() => { setPage(0); load(); }, 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line
  }, [q]);

  const saveToken = async () => {
    if (!defaultAccount) { notify('Add a WhatsApp account first to set a verify token.'); return; }
    setSavingToken(true);
    try {
      await api.whatsappAccounts.update(defaultAccount.id, { verifyToken: verifyToken.trim() });
      setTokenDirty(false);
      notify('Verify token saved.');
      await loadAccounts();
    } catch (err) {
      notify(err.message || 'Failed to save verify token');
    } finally {
      setSavingToken(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const tokenSet = !!(defaultAccount && (defaultAccount.verifyToken || '').trim());

  const labelStyle = { display: 'block', fontSize: 13, fontWeight: 700, color: 'var(--c-t4, #666)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6, fontFamily: FONT };
  const roStyle = { ...inputStyle, background: 'var(--c-hover)', color: 'var(--c-s555555, #555)', fontFamily: 'DM Mono, monospace' };

  // ── Header (shared by both views) ────────────────────────────────────────────
  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
      <div>
        <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 4 }}>
          {view === 'card'
            ? 'Your WhatsApp Cloud API webhook endpoint. Open it to edit the config and view recent activity.'
            : 'Callback URL + verify token, and the most recent inbound payloads. Retention: 30 days.'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => setTestOpen(true)} style={{ ...btnSecondary, color: 'var(--c-primary, #dc2626)', borderColor: '#FCC', fontWeight: 700 }}>
          <Play size={12} /> Send Test Webhook
        </button>
        <button onClick={() => { loadSummary(); if (view === 'detail') load(); }} style={btnSecondary}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
    </div>
  );

  // ── Card ─────────────────────────────────────────────────────────────────────
  if (view === 'card') {
    return (
          <button
            onClick={onOpen}
            style={{ textAlign: 'left', background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, cursor: 'pointer', fontFamily: FONT, display: 'flex', flexDirection: 'column', gap: 14 }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = C.primary; e.currentTarget.style.boxShadow = C.shadowMd; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.boxShadow = 'none'; }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 42, height: 42, borderRadius: 10, background: 'var(--c-primaryLight)', color: 'var(--c-primary, #dc2626)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Webhook size={20} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>WhatsApp Cloud API Webhook</div>
                <div style={{ fontSize: 13, color: C.textMuted, fontFamily: 'DM Mono, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{webhookUrl}</div>
              </div>
              <ChevronRight size={18} style={{ color: 'var(--c-t7, #999)', flexShrink: 0 }} />
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 99, fontSize: 13, fontWeight: 700, ...(tokenSet ? { background: 'var(--c-successBgSoft, #E4F3EE)', color: 'var(--c-successText, #0F6E56)' } : { background: 'var(--c-surfaceSubtle, #EEEDE8)', color: 'var(--c-t4, #666)' }) }}>
                {tokenSet ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                {tokenSet ? 'Verify token set' : 'Using env fallback'}
              </span>
              {defaultAccount && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 99, fontSize: 13, fontWeight: 700, background: 'var(--c-hover)', color: 'var(--c-s555555, #555)' }}>
                  <Phone size={11} /> {maskPhone(String(defaultAccount.displayPhoneNumber || '').replace(/\D/g, ''))}
                </span>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-t6, #888)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Total events</div>
                <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 22, fontWeight: 700, color: C.text, marginTop: 2 }}>{(summary.total || 0).toLocaleString()}</div>
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-t6, #888)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Last received</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginTop: 4 }}>
                  {summary.lastReceivedAt ? new Date(summary.lastReceivedAt).toLocaleString('en-IN', { hour12: false }) : <span style={{ color: C.textMuted, fontWeight: 400 }}>No events yet</span>}
                </div>
              </div>
            </div>
          </button>
    );
  }

  // ── Detail view ──────────────────────────────────────────────────────────────
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 28, overflow: 'auto', fontFamily: FONT }}>
      <button onClick={onBack} style={{ ...btnSecondary, alignSelf: 'flex-start', marginBottom: 14 }}>
        <ArrowLeft size={13} /> Webhooks
      </button>

      {header}

      {/* Configuration panel */}
      <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, marginBottom: 18 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: '0 0 14px' }}>Configuration</h3>

        {/* Callback URL */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Callback URL</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={webhookUrl} readOnly style={roStyle} />
            <button type="button" onClick={copyUrl} title={copied ? 'Copied!' : 'Copy URL'} style={{ flexShrink: 0, width: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', color: copied ? C.green : C.textSecondary }}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 5 }}>Register this in Meta App Dashboard → WhatsApp → Configuration.</div>
        </div>

        {/* Verify token — editable, saved to the default account */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Verify token</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <input
                type={showToken ? 'text' : 'password'}
                value={verifyToken}
                onChange={e => { setVerifyToken(e.target.value); setTokenDirty(true); }}
                placeholder={defaultAccount ? 'Enter a verify token…' : 'Add a WhatsApp account first'}
                disabled={!defaultAccount}
                style={{ ...inputStyle, paddingRight: 34, fontFamily: 'DM Mono, monospace' }}
              />
              <button type="button" onClick={() => setShowToken(s => !s)} style={{ position: 'absolute', right: 6, top: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: C.textSecondary, padding: 2 }}>
                {showToken ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <button
              type="button"
              onClick={saveToken}
              disabled={!defaultAccount || !tokenDirty || savingToken}
              style={{ ...btnSecondary, opacity: (!defaultAccount || !tokenDirty || savingToken) ? 0.5 : 1, cursor: (!defaultAccount || !tokenDirty || savingToken) ? 'default' : 'pointer', fontWeight: 700 }}
            >
              {savingToken ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={12} />} Save
            </button>
          </div>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 5 }}>
            {defaultAccount
              ? <>Meta echoes this during the webhook handshake. Saved to the default number ({defaultAccount.displayName}). Leave blank to fall back to the server env token.</>
              : <>No WhatsApp account configured yet — add one under WhatsApp Accounts, then set the verify token here.</>}
          </div>
        </div>

        {/* Read-only context */}
        {defaultAccount && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
            <div>
              <div style={labelStyle}>Default number</div>
              <MaskedNumber number={String(defaultAccount.displayPhoneNumber || '').replace(/\D/g, '')} prefix="+" style={{ fontSize: 15, color: C.text, fontFamily: 'DM Mono, monospace' }} />
            </div>
            <div>
              <div style={labelStyle}>Phone number ID</div>
              <div style={{ fontSize: 15, color: C.text, fontFamily: 'DM Mono, monospace', wordBreak: 'break-all' }}>{defaultAccount.phoneNumberId || '—'}</div>
            </div>
            <div>
              <div style={labelStyle}>WABA ID</div>
              <div style={{ fontSize: 15, color: C.text, fontFamily: 'DM Mono, monospace', wordBreak: 'break-all' }}>{defaultAccount.wabaId || '—'}</div>
            </div>
          </div>
        )}
      </div>

      {/* Recent webhook history */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: 0 }}>Recent webhook events</h3>
        <div style={{ position: 'relative', width: 260, maxWidth: '100%' }}>
          <Search size={12} style={{ position: 'absolute', left: 8, top: 9, color: 'var(--c-textMuted)' }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search payload…" style={{ ...inputStyle, paddingLeft: 26 }} />
        </div>
      </div>

      {error && <div style={{ background: 'var(--c-primaryLight)', color: 'var(--c-dangerText, #A32D2D)', padding: '10px 12px', borderRadius: 8, fontSize: 14, marginBottom: 14 }}>{error}</div>}

      <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ background: 'var(--c-hover)', textAlign: 'left', borderBottom: `1px solid ${C.border}` }}>
              <th style={th}>Received</th>
              <th style={th}>Kind</th>
              <th style={th}>Type</th>
              <th style={{ ...th, minWidth: 220 }}>Content</th>
              <th style={th}>API #</th>
              <th style={th}>Contact #</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: 'var(--c-t6, #888)' }}><Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /></td></tr>
            )}
            {!loading && events.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: 'var(--c-t6, #888)' }}>No webhook events yet.</td></tr>
            )}
            {!loading && events.map(e => {
              const kc = WEBHOOK_KIND_COLORS[e.payload_kind] || WEBHOOK_KIND_COLORS.unknown;
              const preview = e.payload_preview || '';
              const previewShort = preview.length > 80 ? preview.slice(0, 80) + '…' : preview;
              return (
                <tr key={e.id} onClick={() => setDetailId(e.id)} style={{ borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}
                    onMouseEnter={ev => ev.currentTarget.style.background = 'var(--c-xfdf6f6, #FDF6F6)'}
                    onMouseLeave={ev => ev.currentTarget.style.background = 'transparent'}>
                  <td style={td}>{new Date(e.received_at).toLocaleString('en-IN', { hour12: false })}</td>
                  <td style={td}><span style={{ ...pillStyle, background: kc.bg, color: kc.color }}>{kc.label}</span></td>
                  <td style={td}>{e.payload_subtype
                    ? <span style={{ ...pillStyle, background: 'var(--c-cardBg)', border: '1px solid var(--c-borderStrong, #D5D5D0)', color: 'var(--c-s333333, #333)' }}>{e.payload_subtype}</span>
                    : <span style={{ color: 'var(--c-textMuted)' }}>—</span>}
                  </td>
                  <td style={{ ...td, color: 'var(--c-s333333, #333)', maxWidth: 360 }} title={preview}>
                    {preview ? previewShort : <span style={{ color: 'var(--c-textMuted)' }}>—</span>}
                  </td>
                  <td style={{ ...td, fontFamily: 'DM Mono, monospace', color: 'var(--c-t4, #666)' }} title={e.phone_number_id ? `phone_number_id: ${e.phone_number_id}` : ''}>
                    {e.display_phone_number
                      ? <MaskedNumber number={String(e.display_phone_number).replace(/\D/g, '')} />
                      : (e.phone_number_id ? <span style={{ color: 'var(--c-textMuted)' }}>id:{String(e.phone_number_id).slice(-6)}</span> : '—')}
                  </td>
                  <td style={{ ...td, fontFamily: 'DM Mono, monospace', color: 'var(--c-t4, #666)' }}>
                    {e.contact_phone ? <MaskedNumber number={String(e.contact_phone).replace(/\D/g, '')} /> : <span style={{ color: 'var(--c-textMuted)' }}>—</span>}
                  </td>
                  <td style={td}><Eye size={14} style={{ color: 'var(--c-t4, #666)' }} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination — recent 10 per page */}
      {total > PAGE_SIZE && (
        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, fontSize: 14, color: 'var(--c-t4, #666)' }}>
          <span>Page {page + 1} of {totalPages} ({total.toLocaleString()} total)</span>
          <button disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))} style={{ ...btnSecondary, opacity: page === 0 ? 0.5 : 1 }}><ChevronLeft size={12} /> Prev</button>
          <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)} style={{ ...btnSecondary, opacity: page >= totalPages - 1 ? 0.5 : 1 }}>Next <ChevronRight size={12} /></button>
        </div>
      )}

      {detailId && (
        <WebhookDetailDrawer id={detailId} onClose={() => setDetailId(null)} onChanged={() => { load(); loadSummary(); }} />
      )}
      {testOpen && (
        <TestWebhookModal onClose={() => setTestOpen(false)} onSent={() => { setTestOpen(false); load(); loadSummary(); }} />
      )}
    </div>
  );
}

// ─── Test Webhook Modal ───────────────────────────────────────────────────────
// Generates synthetic Meta payloads of every common shape and POSTs them through
// the live /api/webhook/whatsapp endpoint. Lets you populate the audit log,
// exercise the parser, and fire automation triggers without waiting for real
// WhatsApp traffic.

const TEST_TEMPLATES = [
  { key: 'msg_text',         label: 'Incoming text message',      kind: 'messages',  subtype: 'text' },
  { key: 'msg_image',        label: 'Incoming image',             kind: 'messages',  subtype: 'image' },
  { key: 'msg_video',        label: 'Incoming video',             kind: 'messages',  subtype: 'video' },
  { key: 'msg_voice',        label: 'Incoming voice note',        kind: 'messages',  subtype: 'voice' },
  { key: 'msg_document',     label: 'Incoming document',          kind: 'messages',  subtype: 'document' },
  { key: 'msg_location',     label: 'Incoming location',          kind: 'messages',  subtype: 'location' },
  { key: 'msg_interactive',  label: 'Interactive button reply',   kind: 'messages',  subtype: 'interactive' },
  { key: 'msg_reaction',     label: 'Reaction (emoji)',           kind: 'messages',  subtype: 'reaction' },
  { key: 'echo_text',        label: 'SMB echo: outbound text',    kind: 'smb_message_echoes', subtype: 'text' },
  { key: 'echo_image',       label: 'SMB echo: outbound image',   kind: 'smb_message_echoes', subtype: 'image' },
  { key: 'status_sent',      label: 'Status: sent',               kind: 'statuses',  subtype: 'sent' },
  { key: 'status_delivered', label: 'Status: delivered',          kind: 'statuses',  subtype: 'delivered' },
  { key: 'status_read',      label: 'Status: read',               kind: 'statuses',  subtype: 'read' },
  { key: 'status_failed',    label: 'Status: failed',             kind: 'statuses',  subtype: 'failed' },
  { key: 'tpl_approved',     label: 'Template status: APPROVED',  kind: 'template_status_update', subtype: 'APPROVED' },
  { key: 'tpl_rejected',     label: 'Template status: REJECTED',  kind: 'template_status_update', subtype: 'REJECTED' },
  { key: 'broken',           label: 'Broken payload (parser error test)', kind: 'unknown', subtype: null },
];

function buildTestPayload(key, opts) {
  const ts = Math.floor(Date.now() / 1000);
  const wamid = `wamid.TEST_${ts}_${Math.random().toString(36).slice(2, 8)}`;
  const phoneNumberId = opts.phoneNumberId || '123456789012345';
  // Stored display numbers are digits-only across the dashboard
  const displayPhone = (opts.displayPhone || '919876543210').replace(/\D/g, '');
  const from = opts.from || '919999999999';
  const profileName = opts.profileName || 'Test User';
  const text = opts.text || 'Hello from test webhook';

  const wrap = (changes) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA-TEST', changes }],
  });
  const msgEnvelope = (msg, contacts = true) => wrap([{
    field: 'messages',
    value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: displayPhone, phone_number_id: phoneNumberId },
      ...(contacts ? { contacts: [{ profile: { name: profileName }, wa_id: from }] } : {}),
      messages: [msg],
    },
  }]);
  const statusEnvelope = (status) => wrap([{
    field: 'messages',
    value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: displayPhone, phone_number_id: phoneNumberId },
      statuses: [status],
    },
  }]);

  switch (key) {
    case 'msg_text':
      return msgEnvelope({ from, id: wamid, timestamp: String(ts), type: 'text', text: { body: text } });
    case 'msg_image':
      return msgEnvelope({ from, id: wamid, timestamp: String(ts), type: 'image',
        image: { id: 'MEDIA_TEST_IMG', mime_type: 'image/jpeg', sha256: 'test', caption: text } });
    case 'msg_video':
      return msgEnvelope({ from, id: wamid, timestamp: String(ts), type: 'video',
        video: { id: 'MEDIA_TEST_VID', mime_type: 'video/mp4', sha256: 'test', caption: text } });
    case 'msg_voice':
      return msgEnvelope({ from, id: wamid, timestamp: String(ts), type: 'voice',
        voice: { id: 'MEDIA_TEST_VOICE', mime_type: 'audio/ogg; codecs=opus', sha256: 'test' } });
    case 'msg_document':
      return msgEnvelope({ from, id: wamid, timestamp: String(ts), type: 'document',
        document: { id: 'MEDIA_TEST_DOC', mime_type: 'application/pdf', filename: 'invoice.pdf', sha256: 'test' } });
    case 'msg_location':
      return msgEnvelope({ from, id: wamid, timestamp: String(ts), type: 'location',
        location: { latitude: 12.9716, longitude: 77.5946, name: 'Bangalore', address: 'KA, India' } });
    case 'msg_interactive':
      return msgEnvelope({ from, id: wamid, timestamp: String(ts), type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'btn_yes', title: text || 'Yes' } } });
    case 'msg_reaction':
      return msgEnvelope({ from, id: wamid, timestamp: String(ts), type: 'reaction',
        reaction: { message_id: `wamid.REPLY_TO_${ts}`, emoji: text || '👍' } });
    case 'echo_text':
    case 'echo_image': {
      // SMB echo: business sent a message from the WhatsApp Business app, Meta
      // echoes it back so the CRM can mirror it. Field=smb_message_echoes;
      // value.message_echoes array; `to` is the customer, business number lives
      // in metadata.display_phone_number.
      const echoMsg = key === 'echo_text'
        ? { id: wamid, timestamp: String(ts), to: from, type: 'text', text: { body: text || 'Outbound message from WA Business app' } }
        : { id: wamid, timestamp: String(ts), to: from, type: 'image',
            image: { id: 'MEDIA_TEST_ECHO_IMG', mime_type: 'image/jpeg', sha256: 'test', caption: text || 'Caption' } };
      return wrap([{
        field: 'smb_message_echoes',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: displayPhone, phone_number_id: phoneNumberId },
          message_echoes: [echoMsg],
        },
      }]);
    }
    case 'status_sent':
    case 'status_delivered':
    case 'status_read':
      return statusEnvelope({ id: wamid, status: key.replace('status_', ''), timestamp: String(ts), recipient_id: from,
        conversation: { id: `conv_${ts}`, origin: { type: 'utility' } },
        pricing: { billable: true, pricing_model: 'CBP', category: 'utility' } });
    case 'status_failed':
      return statusEnvelope({ id: wamid, status: 'failed', timestamp: String(ts), recipient_id: from,
        errors: [{ code: 131026, title: 'Message undeliverable', message: text || 'Recipient not reachable' }] });
    case 'tpl_approved':
    case 'tpl_rejected':
      return wrap([{
        field: 'message_template_status_update',
        value: {
          event: key === 'tpl_approved' ? 'APPROVED' : 'REJECTED',
          message_template_id: 1234567890,
          message_template_name: opts.templateName || 'welcome_message',
          message_template_language: 'en',
          reason: key === 'tpl_rejected' ? (text || 'ABUSIVE_CONTENT') : 'NONE',
        },
      }]);
    case 'broken':
      return { object: 'something_weird', entry: [], note: text || 'malformed payload' };
    default:
      return msgEnvelope({ from, id: wamid, timestamp: String(ts), type: 'text', text: { body: text } });
  }
}

function TestWebhookModal({ onClose, onSent }) {
  const [tplKey, setTplKey] = useState('msg_text');
  const [phoneNumberId, setPhoneNumberId] = useState('123456789012345');
  const [from, setFrom] = useState('919999999999');
  const [text, setText] = useState('Hello from test webhook');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [showPreview, setShowPreview] = useState(false);

  const payload = useMemo(() => buildTestPayload(tplKey, { phoneNumberId, from, text }), [tplKey, phoneNumberId, from, text]);
  const selectedTpl = TEST_TEMPLATES.find(t => t.key === tplKey);

  const send = async () => {
    try {
      setSending(true);
      setResult(null);
      const res = await fetch('/api/webhook/whatsapp', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.text();
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }
      setResult({ ok: res.ok, status: res.status, response: parsed });
      if (res.ok) {
        setTimeout(() => { onSent?.(); }, 800);
      }
    } catch (err) {
      setResult({ ok: false, status: 0, response: { error: err.message } });
    } finally {
      setSending(false);
    }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 260, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, width: 620, maxWidth: 'calc(94vw / var(--fg-zoom, 1))', maxHeight: 'calc(90vh / var(--fg-zoom, 1))', overflowY: 'auto', padding: 22, boxShadow: C.shadowLg, fontFamily: FONT }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--c-text)' }}>Send Test Webhook</div>
            <div style={{ fontSize: 13, color: 'var(--c-t6, #888)', marginTop: 2 }}>Posts a synthetic Meta payload through the live <code style={{ fontFamily: 'DM Mono, monospace' }}>/api/webhook/whatsapp</code> handler</div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--c-t4, #666)' }}><X size={18} /></button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
          <FilterField label="Payload type">
            <SearchableSelect
              value={tplKey}
              onChange={v => setTplKey(v)}
              options={TEST_TEMPLATES.map(t => ({ value: t.key, label: t.label }))}
              searchPlaceholder="Search payload types…"
              style={{ width: '100%' }}
              triggerStyle={{ padding: '7px 28px 7px 10px', fontSize: 14, borderWidth: 1, borderRadius: 6 }}
            />
          </FilterField>
          <FilterField label="Phone Number ID (your WABA)">
            <input value={phoneNumberId} onChange={e => setPhoneNumberId(e.target.value)} style={inputStyle} placeholder="123456789012345" />
          </FilterField>
          {selectedTpl?.kind !== 'template_status_update' && selectedTpl?.kind !== 'unknown' && (
            <FilterField label={selectedTpl?.kind === 'statuses' ? 'Recipient phone (wa_id)' : 'From phone (wa_id)'}>
              <input value={from} onChange={e => setFrom(e.target.value)} style={inputStyle} placeholder="919999999999" />
            </FilterField>
          )}
          <FilterField label={
            selectedTpl?.key === 'msg_reaction' ? 'Emoji' :
            selectedTpl?.kind === 'statuses' && tplKey === 'status_failed' ? 'Error message' :
            selectedTpl?.kind === 'template_status_update' ? (tplKey === 'tpl_rejected' ? 'Rejection reason' : 'Template name') :
            'Text / caption'
          }>
            <input value={text} onChange={e => setText(e.target.value)} style={inputStyle} />
          </FilterField>
        </div>

        <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--c-hover)', border: '1px solid var(--c-borderSubtle, #EEEDE8)', borderRadius: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div style={{ fontSize: 13, color: 'var(--c-t4, #666)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
              Payload preview <span style={{ marginLeft: 6, fontFamily: 'DM Mono, monospace', color: 'var(--c-textMuted)', textTransform: 'none', letterSpacing: 0 }}>· kind={selectedTpl?.kind} · subtype={selectedTpl?.subtype || '—'}</span>
            </div>
            <button onClick={() => setShowPreview(!showPreview)} style={btnSecondary}>
              {showPreview ? 'Hide' : 'Show'}
            </button>
          </div>
          {showPreview && (
            <pre
              style={{ background: 'var(--c-cardBg)', border: '1px solid var(--c-borderSubtle, #EEEDE8)', borderRadius: 6, padding: 10, fontSize: 13, fontFamily: 'DM Mono, monospace', overflow: 'auto', maxHeight: 240, margin: 0 }}
              dangerouslySetInnerHTML={{ __html: syntaxHighlight(JSON.stringify(payload, null, 2)) }}
            />
          )}
        </div>

        {result && (
          <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 14, background: result.ok ? 'var(--c-successBgSoft, #E4F3EE)' : 'var(--c-primaryLight)', color: result.ok ? 'var(--c-successText, #0F6E56)' : 'var(--c-dangerText, #A32D2D)' }}>
            {result.ok ? '✓ Sent' : '⚠ Failed'} · HTTP {result.status} · {JSON.stringify(result.response).slice(0, 200)}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={send} disabled={sending} style={{ ...btnSecondary, color: '#fff', background: '#dc2626', borderColor: '#dc2626', fontWeight: 700 }}>
            {sending ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={12} />} Send Webhook
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle = { width: '100%', padding: '7px 10px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 14, fontFamily: FONT, outline: 'none', background: 'var(--c-cardBg)', boxSizing: 'border-box' };
const pillStyle = { display: 'inline-block', padding: '2px 8px', borderRadius: 99, fontSize: 12, fontWeight: 700, fontFamily: 'DM Mono, monospace', textTransform: 'uppercase' };
const th = { padding: '10px 14px', fontSize: 12, fontWeight: 700, color: 'var(--c-t4, #666)', textTransform: 'uppercase', letterSpacing: '.05em' };
const td = { padding: '10px 14px', color: 'var(--c-s333333, #333)', verticalAlign: 'middle' };

function FilterField({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-t4, #666)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
