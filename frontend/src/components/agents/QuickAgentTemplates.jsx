import { useState, useEffect } from 'react';
import { X, Search, Zap } from 'lucide-react';
import { C, FONT, T, W, LH } from '../../constants.js';
import { QUICK_AGENTS, QUICK_GOALS } from './quickAgents.js';

/**
 * "New agent" → this picker, the WhatsApp twin of Social's Templates modal:
 * ready-made Quick AI Agents filterable by goal. Creation is preset-only — there
 * is no blank start into the full editor, which is for editing an agent once it
 * exists. Same layout so the two sections feel like one app.
 */
export default function QuickAgentTemplates({ onClose, onQuick }) {
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const match = (t) => (filter === 'all' || t.goal === filter)
    && (!q.trim() || `${t.title} ${t.body} ${t.keywords || ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const shown = QUICK_AGENTS.filter(match);
  const recommended = filter === 'all' && !q.trim() ? shown.filter(t => t.popular) : [];
  const rest = recommended.length ? shown.filter(t => !recommended.includes(t)) : shown;

  const side = (id, label) => (
    <button key={id} type="button" onClick={() => setFilter(id)} data-goal={id}
      style={{
        display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 10, border: 'none',
        cursor: 'pointer', fontFamily: FONT, fontSize: T.body,
        background: filter === id ? C.surfaceMuted : 'transparent',
        color: filter === id ? C.text : C.textSecondary, fontWeight: filter === id ? W.bold : W.normal,
      }}>
      {label}
    </button>
  );

  return (
    <div onMouseDown={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: FONT }}>
      <div role="dialog" aria-label="AI agent templates" data-testid="agent-templates"
        style={{ width: 'min(1100px, 100%)', height: 'min(calc(720px / var(--fg-zoom, 1)), 100%)', background: C.cardBg, borderRadius: 18, boxShadow: C.shadowLg, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: T.h3, fontWeight: W.heavy, color: C.text }}>New AI agent</div>
            <div style={{ fontSize: T.meta, color: C.textMuted, marginTop: 2 }}>Pick a ready-made agent, answer a few questions about your business, and it is ready to test.</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ width: 36, height: 36, borderRadius: 10, border: 'none', background: C.surfaceMuted, color: C.textSecondary, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div style={{ width: 200, flexShrink: 0, padding: 14, overflowY: 'auto', borderRight: `1px solid ${C.border}` }}>
            {side('all', 'All templates')}
            <div style={{ fontSize: T.label, fontWeight: W.bold, letterSpacing: '.05em', textTransform: 'uppercase', color: C.textMuted, margin: '16px 10px 6px' }}>By goal</div>
            {QUICK_GOALS.map(g => side(g.id, g.label))}
          </div>
          <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '16px 20px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: C.surfaceMuted, borderRadius: 12, padding: '9px 12px', maxWidth: 340, marginBottom: 18, marginLeft: 'auto' }}>
              <Search size={14} color={C.textMuted} />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search agent templates…" aria-label="Search agent templates"
                style={{ border: 'none', outline: 'none', background: 'transparent', flex: 1, fontFamily: FONT, fontSize: T.body, color: C.text }} />
            </div>
            {recommended.length > 0 && <><Heading>Recommended</Heading><Grid items={recommended} onPick={onQuick} /></>}
            <Heading>{recommended.length ? 'More templates' : `${shown.length} template${shown.length === 1 ? '' : 's'}`}</Heading>
            {rest.length
              ? <Grid items={rest} onPick={onQuick} />
              : <div style={{ color: C.textMuted, fontSize: T.body, padding: 20 }}>No templates match.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

const Heading = ({ children }) => (
  <div style={{ fontSize: T.h3, fontWeight: W.heavy, color: C.text, margin: '4px 0 12px' }}>{children}</div>
);

function Grid({ items, onPick }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(240px, 100%), 1fr))', gap: 12, marginBottom: 24 }}>
      {items.map(t => {
        const Icon = t.Icon;
        return (
          <button key={t.id} type="button" data-quick={t.id} onClick={() => onPick(t)} className="fg-qa-card"
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', textAlign: 'left', minHeight: 160, padding: 16, borderRadius: 16, border: 'none', cursor: 'pointer', fontFamily: FONT, background: C.surfaceMuted }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 30, height: 30, borderRadius: 9, background: C.cardBg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon size={16} color={C.primary} />
              </span>
              <span style={{ fontSize: T.lead, fontWeight: W.heavy, color: C.text, lineHeight: LH.tight }}>{t.title}</span>
            </div>
            <div style={{ fontSize: T.meta, color: C.textSecondary, marginTop: 8, lineHeight: LH.normal, flex: 1 }}>{t.body}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, fontSize: T.label, color: C.textSecondary, fontWeight: W.medium }}>
              <Zap size={13} /> Quick AI Agent
              {t.popular && (
                <span style={{ marginLeft: 'auto', padding: '2px 7px', borderRadius: 5, background: C.primary, color: '#fff', fontSize: T.micro, fontWeight: W.heavy, letterSpacing: '.04em' }}>POPULAR</span>
              )}
            </div>
          </button>
        );
      })}
      <style>{'.fg-qa-card{transition:box-shadow .15s, transform .15s}.fg-qa-card:hover{box-shadow:0 0 0 2px var(--c-primary);transform:translateY(-1px)}'}</style>
    </div>
  );
}
