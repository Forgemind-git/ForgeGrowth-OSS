import { useMemo, useState } from 'react';
import { Bot, MessageSquare, Edit3, Plus, FolderKanban } from 'lucide-react';
import { C, FONT, MONO } from '../../constants.js';
import { PROVIDER_LABELS } from './modelCatalog.js';
import SortControl from '../SortControl.jsx';
import { sortList, DEFAULT_SORT } from '../../lib/listSort.js';

// The agents endpoint returns camelCase, unlike the raw rows the Automations
// and Templates lists get — hence explicit accessors rather than a shared key.
const AGENT_FIELDS = { created: a => a.createdAt, updated: a => a.updatedAt, name: a => a.name };

/**
 * Read-only agent list. Each row: name + description + provider/model + bound
 * WA account + active status. Edit jumps into AgentEditor.
 *
 * Sort state lives here rather than on the page because the control belongs to
 * the list view only — the page also renders the editor.
 */
export default function AgentList({ agents, waAccounts, onEdit, onCreate }) {
  const [sort, setSort] = useState(DEFAULT_SORT);
  const sorted = useMemo(() => sortList(agents, sort, AGENT_FIELDS), [agents, sort]);

  if (agents.length === 0) {
    return <EmptyState onCreate={onCreate} />;
  }
  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <SortControl value={sort} onChange={setSort} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {sorted.map(a => (
          <Row key={a.id} agent={a} waAccounts={waAccounts} onEdit={() => onEdit(a.id)} />
        ))}
      </div>
    </div>
  );
}

function Row({ agent, waAccounts, onEdit }) {
  const wa = waAccounts.find(w => String(w.id) === String(agent.waAccountId));
  const isDraft = agent.status === 'draft';
  const providerLabel = agent.aiProvider
    ? `${PROVIDER_LABELS[agent.aiProvider] || agent.aiProvider}${agent.llmModel ? ` · ${agent.llmModel}` : ''}`
    : 'No model connected';
  return (
    <div
      onClick={onEdit}
      style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '14px 18px', background: C.cardBg, borderRadius: 12,
        border: `1px solid ${C.border}`, cursor: 'pointer',
        transition: 'box-shadow .15s, border-color .15s',
        fontFamily: FONT,
      }}
      onMouseEnter={e => {
        e.currentTarget.style.boxShadow = C.shadowMd;
        e.currentTarget.style.borderColor = '#D6D6CE';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.boxShadow = 'none';
        e.currentTarget.style.borderColor = C.border;
      }}
    >
      <div style={{
        width: 36, height: 36, borderRadius: 10,
        background: agent.isActive ? 'var(--c-dangerBgSoft, #FEF1F1)' : 'var(--c-xf2f2ec, #F2F2EC)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Bot size={18} color={agent.isActive ? C.primary : C.textMuted} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{agent.name}</div>
          <StatusPill status={agent.status} active={agent.isActive} />
        </div>
        {agent.description && (
          <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {agent.description}
          </div>
        )}
        <div style={{ display: 'flex', gap: 14, marginTop: 6, fontSize: 13, color: C.textMuted, fontFamily: MONO }}>
          <span style={{ color: isDraft && !agent.aiProvider ? 'var(--c-sb45309, #B45309)' : C.textMuted }}>{providerLabel}</span>
          <span>· {agent.toolCount || 0} tool{(agent.toolCount || 0) === 1 ? '' : 's'}</span>
          {wa && <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <MessageSquare size={11} /> {wa.displayName}
          </span>}
          {/* Which campaign this agent belongs to. Filing happens on the
              Projects page — shown here so the grouping is visible where
              people browse agents. */}
          {agent.projectName && <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <FolderKanban size={11} /> {agent.projectName}
          </span>}
          {agent.lastRunAt && <span>· last run {formatRelative(agent.lastRunAt)}</span>}
          {/* Shown because the list sorts by it — a sort key the reader cannot
              see makes the ordering look arbitrary. */}
          {agent.createdAt && <span>· created {formatDate(agent.createdAt)}</span>}
        </div>
      </div>

      <button
        onClick={(e) => { e.stopPropagation(); onEdit(); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '7px 12px', borderRadius: 8,
          border: `1px solid ${C.border}`, background: C.cardBg,
          color: C.text, fontSize: 14, fontFamily: FONT, fontWeight: 600,
          cursor: 'pointer', flexShrink: 0,
        }}
      >
        <Edit3 size={12} /> Edit
      </button>
    </div>
  );
}

function StatusPill({ status, active }) {
  // Draft takes precedence: a draft is incomplete and never handles traffic,
  // regardless of the (forced-false) is_active flag.
  const variant = status === 'draft'
    ? { bg: 'var(--c-sfef3c7, #FEF3C7)', color: 'var(--c-s92400e, #92400E)', label: 'Draft' }
    : active
      ? { bg: 'var(--c-successBgSoft, #ECFDF5)', color: 'var(--c-s065f46, #065F46)', label: 'Active' }
      : { bg: 'var(--c-xf2f2ec, #F2F2EC)', color: C.textSecondary, label: 'Paused' };
  return (
    <span style={{
      fontSize: 12, fontWeight: 700, letterSpacing: '.04em',
      textTransform: 'uppercase',
      padding: '3px 8px', borderRadius: 999,
      background: variant.bg, color: variant.color,
    }}>
      {variant.label}
    </span>
  );
}

function EmptyState({ onCreate }) {
  return (
    <div style={{
      maxWidth: 560, margin: '64px auto', padding: 40,
      borderRadius: 16, background: C.cardBg, border: `1px solid ${C.border}`,
      textAlign: 'center', fontFamily: FONT,
    }}>
      <div style={{
        width: 56, height: 56, borderRadius: 14, margin: '0 auto 16px',
        background: 'var(--c-dangerBgSoft, #FEF1F1)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Bot size={28} color={C.primary} />
      </div>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: '0 0 8px' }}>
        No agents yet
      </h2>
      <p style={{ fontSize: 15, color: C.textSecondary, margin: '0 0 22px', lineHeight: 1.55 }}>
        Create an AI agent to auto-reply to inbound WhatsApp messages.
        Attach a Google Sheet so the agent can look up bookings, save leads, or update orders.
      </p>
      <button
        onClick={onCreate}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '10px 18px', borderRadius: 8, border: 'none',
          background: C.primary, color: '#fff', cursor: 'pointer',
          fontSize: 15, fontFamily: FONT, fontWeight: 700,
        }}
      >
        <Plus size={14} /> Create your first agent
      </button>
    </div>
  );
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}
