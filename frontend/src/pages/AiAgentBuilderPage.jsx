import { useState, useEffect, useCallback, useRef } from 'react';
import { Bot, Plus, Loader2, Upload } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO } from '../constants.js';
import { showError, showSuccess } from '../lib/feedback.js';
import AgentEditor from '../components/agents/AgentEditor.jsx';
import AgentList from '../components/agents/AgentList.jsx';
import QuickAgentTemplates from '../components/agents/QuickAgentTemplates.jsx';
import QuickAgentEditor from '../components/agents/QuickAgentEditor.jsx';
import LiveLinksPanel from '../components/LiveLinksPanel.jsx';
import { useHubEditing } from '../components/AutomationHub.jsx';

/**
 * AI Agents top-level page.
 *
 * Two views, toggled by local state:
 *   - list view: table of all agents with an "Edit" button per row + "New agent" CTA
 *   - editor view: full agent CRUD (settings, tools, runs)
 *
 * No nested routing — keeping it intentionally simple. The editor view writes
 * back to the same agents list on save, so users get an instant refresh.
 */
export default function AiAgentBuilderPage({ user, navigate }) {
  const [agents, setAgents] = useState([]);
  const [waAccounts, setWaAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState(null); // null = list view, 'new' = create, <number> = edit
  // "New agent" opens the template picker (like Social's Quick Automations);
  // picking one opens the one-page Quick AI Agent editor, "Start from scratch"
  // the full five-tab editor.
  const [picker, setPicker] = useState(false);
  const [quick, setQuick] = useState(null); // a QUICK_AGENTS template while the quick editor is open
  const editing = editingId !== null || quick !== null;
  useHubEditing(editing); // an editor owns the whole pane
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [a, w] = await Promise.all([
        api.agents.list(),
        api.whatsappAccounts.list().catch(() => []),
      ]);
      setAgents(a);
      setWaAccounts(w);
    } catch (e) {
      setError(prettyError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-importing the same file
    if (!file) return;
    setImporting(true);
    try {
      const payload = JSON.parse(await file.text());
      const { agent, warnings } = await api.agents.import(payload);
      await refresh();
      setEditingId(agent.id); // open the imported draft for review
      showSuccess(
        (warnings && warnings.length)
          ? `Imported as a draft. ${warnings.join(' ')}`
          : 'Agent imported as a draft — review it and Go Live when ready.',
        'Agent imported',
      );
    } catch (err) {
      const msg = err instanceof SyntaxError ? 'That file is not valid JSON.' : prettyError(err);
      showError(msg, 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', background: C.pageBg, fontFamily: FONT, overflow: 'hidden' }}>
      <input ref={fileRef} type="file" accept="application/json,.json" onChange={handleImportFile} style={{ display: 'none' }} />
      <Header
        editing={editing}
        onBack={() => { setEditingId(null); setQuick(null); refresh(); }}
        onNew={() => setPicker(true)}
        onImport={() => fileRef.current?.click()}
        importing={importing}
        agentCount={agents.length}
      />

      {error && (
        <div style={{ padding: '10px 16px', margin: '12px 24px 0', borderRadius: 8,
          background: 'var(--c-dangerBg, #FCEBEB)', color: 'var(--c-dangerText, #A32D2D)', border: '1px solid var(--c-dangerBorder, #FBC8C8)',
          fontSize: 15 }}>
          {error}
        </div>
      )}

      {/* While editing, the EDITOR owns its own scrolling (a scrolling form
          column beside a pinned preview), so this wrapper must not scroll too
          — and needs minHeight:0 or a flex child cannot shrink enough to let
          its own child scroll. */}
      <div style={{
        flex: 1, minHeight: 0,
        overflow: editing ? 'hidden' : 'auto',
        display: editing ? 'flex' : 'block',
      }}>
        {!editing && (
          loading
            ? <Loading />
            : <>
                <LiveLinksPanel />
                <AgentList
                  agents={agents}
                  waAccounts={waAccounts}
                  onEdit={(id) => setEditingId(id)}
                  onCreate={() => setPicker(true)}
                />
              </>
        )}
        {quick && (
          <QuickAgentEditor
            key={quick.id}
            template={quick}
            waAccounts={waAccounts}
            user={user}
            navigate={navigate}
            onDone={() => { setQuick(null); refresh(); }}
            onOpenFull={(id) => { setQuick(null); setEditingId(id); }}
          />
        )}
        {editingId !== null && (
          <AgentEditor
            agentId={editingId === 'new' ? null : editingId}
            waAccounts={waAccounts}
            user={user}
            navigate={navigate}
            onDone={() => { setEditingId(null); refresh(); }}
            // Refresh on the way out too: "Create agent" now keeps the editor
            // open, so a cancel after creating must still show the new row.
            onCancel={() => { setEditingId(null); refresh(); }}
          />
        )}
      </div>

      {picker && (
        <QuickAgentTemplates
          onClose={() => setPicker(false)}
          onQuick={(t) => { setPicker(false); setEditingId(null); setQuick(t); }}
          onScratch={() => { setPicker(false); setQuick(null); setEditingId('new'); }}
        />
      )}
    </div>
  );
}

function Header({ editing, onBack, onNew, onImport, importing, agentCount }) {
  return (
    // Slimmer while editing: the subtitle is list context, and every pixel of
    // page chrome is height the preview pane below does not get.
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: editing ? '9px 20px' : '16px 24px', background: C.cardBg,
      borderBottom: `1px solid ${C.border}`,
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Bot size={editing ? 16 : 18} color={C.primary} />
        <div>
          {editing && (
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, letterSpacing: '-.01em' }}>AI Agents</div>
          )}
          {!editing && (
            <div style={{ fontSize: 14, color: C.textMuted }}>
              LLM-driven WhatsApp assistants · {agentCount} configured
            </div>
          )}
        </div>
      </div>
      {!editing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={onImport}
            disabled={importing}
            title="Import an agent from a .json export file"
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '9px 14px', borderRadius: 8,
              border: `1px solid ${C.border}`, background: C.cardBg,
              color: C.text, cursor: importing ? 'wait' : 'pointer',
              fontSize: 15, fontFamily: FONT, fontWeight: 600, opacity: importing ? 0.6 : 1,
            }}
          >
            {importing ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Upload size={14} />} Import
          </button>
          <button
            onClick={onNew}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '9px 14px', borderRadius: 8, border: 'none',
              background: C.primary, color: '#fff', cursor: 'pointer',
              fontSize: 15, fontFamily: FONT, fontWeight: 700,
            }}
          >
            <Plus size={14} /> New agent
          </button>
        </div>
      )}
      {editing && (
        <button
          onClick={onBack}
          style={{
            padding: '9px 14px', borderRadius: 8,
            border: `1px solid ${C.border}`, background: C.cardBg,
            color: C.text, cursor: 'pointer',
            fontSize: 15, fontFamily: FONT, fontWeight: 600,
          }}
        >
          Back to agents
        </button>
      )}
    </div>
  );
}

function Loading() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 60, gap: 8, color: C.textMuted, fontSize: 15 }}>
      <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading agents…
    </div>
  );
}

function prettyError(e) {
  if (!e) return 'Unknown error';
  const msg = e.message || String(e);
  try {
    const m = msg.match(/^\d+\s+(.+)$/);
    if (m) {
      const body = JSON.parse(m[1]);
      if (body && body.error) return body.error;
    }
  } catch { /* fall through */ }
  return msg;
}
