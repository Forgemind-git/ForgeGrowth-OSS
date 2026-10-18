// Tools: which data the agent may read and what it may propose. A tool's schema is
// fixed by the platform (read-only here); an admin can switch it on, narrow its
// limits, rewrite the description the model reads, and preview it on live data.

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Play, RotateCcw } from 'lucide-react';
import { api } from '../../../api.js';
import { C, FONT, MONO, T, W, LH } from '../../../constants.js';
import { Button, Modal, Segmented } from '../../academy/shared.jsx';
import Toggle from '../../../components/Toggle.jsx';
import { showError } from '../../../lib/feedback.js';
import { Panel, Notice, JsonBlock, NumberInput, textareaStyle, Pill, duration, Field } from '../wfShared.jsx';

const KIND_META = {
  read: { label: 'Reads data', color: C.infoText, bg: C.infoBg },
  draft: { label: 'Drafts only', color: C.purple, bg: C.purpleBg },
  write: { label: 'Needs approval', color: C.warnText, bg: C.warnBg },
};

function exampleInput(schema) {
  const out = {};
  for (const k of schema?.required || []) {
    const p = schema.properties?.[k] || {};
    out[k] = p.enum ? p.enum[0] : p.type === 'number' || p.type === 'integer' ? 1 : p.type === 'array' ? [] : p.type === 'boolean' ? false : '';
  }
  return out;
}

function PreviewModal({ tool, entry, scope, agentId, onClose }) {
  const [input, setInput] = useState(() => JSON.stringify(exampleInput(tool.input_schema), null, 2));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const runIt = async () => {
    let parsed;
    try { parsed = JSON.parse(input || '{}'); } catch (e) { showError(`The input is not valid JSON: ${e.message}`); return; }
    setBusy(true); setResult(null);
    try {
      setResult(await api.workflowAgents.previewTool(tool.key, { input: parsed, data_scope: scope, agent_id: agentId, permission: entry?.permission, params_override: entry?.params_override || {} }));
    } catch (e) { showError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Preview · ${tool.title}`} onClose={onClose} width={820}
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" icon={Play} disabled={busy} onClick={runIt}>{busy ? 'Running…' : 'Run tool'}</Button></>}>
      <Notice tone="info" style={{ marginBottom: 12 }}>
        Runs on live data with this agent's current data access, including unsaved changes. {tool.kind === 'write' ? 'Nothing is proposed or changed: write tools are simulated here.' : 'It only reads.'} No model is called, so it costs nothing.
      </Notice>
      <Field label="Input (JSON)">
        <textarea rows={6} value={input} onChange={e => setInput(e.target.value)} spellCheck={false} style={{ ...textareaStyle, fontFamily: MONO, fontSize: T.meta }} />
      </Field>
      <details style={{ marginBottom: 12 }}>
        <summary style={{ cursor: 'pointer', fontSize: T.meta, color: C.textSecondary }}>Input schema</summary>
        <div style={{ marginTop: 8 }}><JsonBlock value={tool.input_schema} /></div>
      </details>
      {result && (
        <>
          <div style={{ fontSize: T.meta, color: C.textMuted, marginBottom: 6 }}>Returned in {duration(result.duration_ms)} · {JSON.stringify(result.result).length.toLocaleString('en-IN')} characters</div>
          {result.result?.error && <Notice tone={result.result.error === 'out_of_scope' ? 'warn' : 'danger'} style={{ marginBottom: 8 }}>{result.result.error}: {result.result.message}</Notice>}
          <JsonBlock value={result.result} maxChars={12000} />
        </>
      )}
    </Modal>
  );
}

export default function ToolsTab({ agentId, draft, patchDraft, lookups, isAdmin }) {
  const tools = lookups.catalog?.tools || [];
  const [open, setOpen] = useState(() => new Set());
  const [preview, setPreview] = useState(null);

  const byKey = useMemo(() => new Map((draft.tool_config || []).map(e => [e.tool_key, e])), [draft.tool_config]);
  const groups = useMemo(() => {
    const g = new Map();
    for (const t of tools) { if (!g.has(t.category)) g.set(t.category, []); g.get(t.category).push(t); }
    return [...g.entries()];
  }, [tools]);

  const upsert = (tool, patch) => patchDraft('tool_config', (list) => {
    const current = (list || []).find(e => e.tool_key === tool.key) || { tool_key: tool.key, enabled: false, permission: tool.default_permission, params_override: {}, description: null };
    const next = { ...current, ...patch };
    return (list || []).some(e => e.tool_key === tool.key) ? list.map(e => (e.tool_key === tool.key ? next : e)) : [...(list || []), next];
  });

  const enabledCount = tools.filter(t => byKey.get(t.key)?.enabled).length;
  const toggleOpen = (key) => setOpen(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  if (!tools.length) return <div style={{ fontSize: T.body, color: C.textMuted, fontFamily: FONT }}>Loading tools…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontFamily: FONT }}>
      <Panel
        title={`${enabledCount} of ${tools.length} tools on`}
        hint="Every tool is limited to the agent's data access on the server. Write tools never change anything directly: they file a proposal that waits in Results & approvals."
        right={isAdmin && <Button onClick={() => tools.filter(t => t.kind === 'read').forEach(t => upsert(t, { enabled: true }))}>Turn on every read tool</Button>}
      />
      {groups.map(([category, list]) => (
        <Panel key={category} title={category} bodyStyle={{ padding: 0 }}>
          {list.map((t, i) => {
            const e = byKey.get(t.key);
            const on = !!e?.enabled;
            const expanded = open.has(t.key);
            return (
              <div key={t.key} style={{ borderTop: i ? `1px solid ${C.borderSubtle}` : 'none', padding: '12px 18px' }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <Toggle checked={on} onChange={(v) => upsert(t, { enabled: v })} />
                  <button type="button" onClick={() => toggleOpen(t.key)} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3, background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', fontFamily: FONT }}>
                    <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      {expanded ? <ChevronDown size={15} color={C.t4} /> : <ChevronRight size={15} color={C.t4} />}
                      <span style={{ fontSize: T.bodyLg, fontWeight: W.medium, color: on ? C.text : C.t3 }}>{t.title}</span>
                      <span style={{ fontFamily: MONO, fontSize: T.meta, color: C.textMuted }}>{t.key}</span>
                      <Pill meta={t.kind === 'write' && e?.permission === 'draft' ? KIND_META.draft : KIND_META[t.kind]} />
                      {e?.description && <span style={{ fontSize: T.meta, color: C.warnText }}>custom description</span>}
                    </span>
                    <span style={{ fontSize: T.meta, color: C.textSecondary, lineHeight: LH.normal, display: '-webkit-box', WebkitLineClamp: expanded ? 'unset' : 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', paddingLeft: 23 }}>
                      {e?.description || t.description}
                    </span>
                  </button>
                  {isAdmin && <Button variant="ghost" icon={Play} onClick={() => setPreview(t)} style={{ padding: '6px 10px', fontSize: T.meta }}>Preview</Button>}
                </div>
                {expanded && (
                  <div style={{ marginTop: 12, paddingLeft: 58, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {t.kind === 'write' && (
                      <Field label="What happens when the agent uses it">
                        <Segmented value={e?.permission || 'write'} onChange={(v) => upsert(t, { permission: v })}
                          options={[{ value: 'write', label: 'Propose for approval' }, { value: 'draft', label: 'Draft only (just record it)' }]} />
                      </Field>
                    )}
                    {t.overridable.length > 0 && (
                      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                        {t.overridable.map(o => (
                          <Field key={o.key} label={o.label || o.key} hint={o.mode === 'cap' ? 'A ceiling: the agent can ask for less, never more.' : null}>
                            {o.type === 'boolean'
                              ? <Toggle checked={e?.params_override?.[o.key] === true} onChange={(v) => upsert(t, { params_override: { ...(e?.params_override || {}), [o.key]: v } })} />
                              : <NumberInput value={e?.params_override?.[o.key] ?? null} min={1} placeholder="Default" onChange={(v) => upsert(t, { params_override: { ...(e?.params_override || {}), [o.key]: v } })} style={{ maxWidth: 160 }} />}
                          </Field>
                        ))}
                      </div>
                    )}
                    <Field label="Description the model reads" hint="Rewrite it to steer when the agent reaches for this tool. Leave empty to use the default.">
                      <textarea rows={3} value={e?.description || ''} maxLength={2000} placeholder={t.description} onChange={(ev) => upsert(t, { description: ev.target.value || null })} style={{ ...textareaStyle, fontSize: T.meta }} />
                      {e?.description && <Button variant="ghost" icon={RotateCcw} onClick={() => upsert(t, { description: null })} style={{ padding: '4px 8px', fontSize: T.meta, marginTop: 4 }}>Use the default</Button>}
                    </Field>
                    <details>
                      <summary style={{ cursor: 'pointer', fontSize: T.meta, color: C.textSecondary }}>Input schema (fixed)</summary>
                      <div style={{ marginTop: 8 }}><JsonBlock value={t.input_schema} /></div>
                    </details>
                  </div>
                )}
              </div>
            );
          })}
        </Panel>
      ))}
      {preview && <PreviewModal tool={preview} entry={byKey.get(preview.key)} scope={draft.data_scope} agentId={agentId} onClose={() => setPreview(null)} />}
    </div>
  );
}
