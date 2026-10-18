// Instructions: the agent's own playbook (Markdown), with a variables helper and the
// version history. Compare shows what changed against the unsaved draft; Restore
// saves an old version as a NEW version, so restoring is itself reversible.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, GitCompare } from 'lucide-react';
import { api } from '../../../api.js';
import { C, FONT, MONO, T, W, LH } from '../../../constants.js';
import { Button, Modal } from '../../academy/shared.jsx';
import { useConfirm } from '../../../components/ConfirmDialog.jsx';
import { showError, showSuccess } from '../../../lib/feedback.js';
import { Panel, Notice, when, stableStringify, useNarrow } from '../wfShared.jsx';

const MAX = 60000;
const SECTION_LABEL = {
  output_schema: 'Output schema', tool_config: 'Tools', data_scope: 'Data access', triggers: 'Triggers',
  destinations: 'Destinations', approval_rules: 'Approval rules', runtime: 'Batching',
};

/** Line diff via LCS. Returns null when the texts are too large to diff in the browser. */
function lineDiff(a, b) {
  const A = String(a || '').split('\n');
  const B = String(b || '').split('\n');
  const n = A.length; const m = B.length;
  if (n * m > 4000000) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: ' ', s: A[i] }); i += 1; j += 1; } else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', s: A[i] }); i += 1; } else { out.push({ t: '+', s: B[j] }); j += 1; }
  }
  while (i < n) out.push({ t: '-', s: A[i++] });
  while (j < m) out.push({ t: '+', s: B[j++] });
  return out;
}

function DiffView({ diff }) {
  if (!diff.some(d => d.t !== ' ')) return <div style={{ fontSize: T.body, color: C.textMuted }}>The instructions are identical.</div>;
  // Show every changed line with two lines of context; fold the rest.
  const keep = new Array(diff.length).fill(false);
  diff.forEach((d, i) => { if (d.t !== ' ') for (let k = Math.max(0, i - 2); k <= Math.min(diff.length - 1, i + 2); k += 1) keep[k] = true; });
  const rows = [];
  let hidden = 0;
  const fold = () => { if (hidden) { rows.push({ t: '…', s: `${hidden} unchanged line${hidden === 1 ? '' : 's'}` }); hidden = 0; } };
  diff.forEach((d, i) => { if (keep[i]) { fold(); rows.push(d); } else hidden += 1; });
  fold();
  return (
    <pre style={{ margin: 0, fontFamily: MONO, fontSize: T.meta, lineHeight: LH.snug, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'auto', maxHeight: 'calc(55vh / var(--fg-zoom, 1))' }}>
      {rows.map((r, i) => (
        <div key={i} style={{
          padding: '1px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          background: r.t === '+' ? C.successBg : r.t === '-' ? C.dangerBg : 'transparent',
          color: r.t === '+' ? C.successText : r.t === '-' ? C.dangerText : r.t === '…' ? C.textMuted : C.t3,
          fontStyle: r.t === '…' ? 'italic' : 'normal',
        }}>
          {r.t === '…' ? `  ⋯ ${r.s}` : `${r.t} ${r.s}`}
        </div>
      ))}
    </pre>
  );
}

export default function InstructionsTab({ agentId, version, draft, patchDraft, lookups, isAdmin, reload, dirty, currentConfig }) {
  const ref = useRef(null);
  const narrow = useNarrow(1100);
  const [versions, setVersions] = useState(null);
  const [compare, setCompare] = useState(null);
  const [confirmEl, confirm] = useConfirm();

  const loadVersions = useCallback(() => api.workflowAgents.versions(agentId).then(r => setVersions(r.versions)).catch(e => showError(e.message)), [agentId]);
  useEffect(() => { loadVersions(); }, [loadVersions, version?.id]);

  const insert = (key) => {
    const token = `{{${key}}}`;
    const el = ref.current;
    const text = draft.instructions || '';
    const start = el ? el.selectionStart : text.length;
    const end = el ? el.selectionEnd : text.length;
    patchDraft('instructions', text.slice(0, start) + token + text.slice(end));
    requestAnimationFrame(() => { if (el) { el.focus(); el.selectionStart = el.selectionEnd = start + token.length; } });
  };

  const openCompare = async (v) => {
    try { setCompare({ version: await api.workflowAgents.version(agentId, v.id) }); } catch (e) { showError(e.message); }
  };

  const restore = async (v) => {
    const ok = await confirm({
      title: `Restore version ${v.version}?`,
      body: `It is saved as a new version, so you can undo this later.${dirty ? ' Your unsaved changes will be lost.' : ''}`,
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    try { await api.workflowAgents.restore(agentId, v.id); showSuccess(`Version ${v.version} restored as a new version.`); setCompare(null); await reload(); loadVersions(); } catch (e) { showError(e.message); }
  };

  const otherChanges = useMemo(() => {
    if (!compare) return [];
    const cur = currentConfig();
    return Object.keys(SECTION_LABEL).filter(k => stableStringify(cur?.[k]) !== stableStringify(compare.version[k]));
  }, [compare, currentConfig]);

  const length = (draft.instructions || '').length;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'minmax(0, 1fr) 340px', gap: 16, alignItems: 'start', fontFamily: FONT }}>
      {confirmEl}
      <Panel
        title="Instructions"
        hint="What the agent should do and how, in plain language or Markdown. Platform rules are added before these on every run."
        right={<span style={{ fontFamily: MONO, fontSize: T.meta, color: length > MAX ? C.dangerText : C.textMuted }}>{length.toLocaleString('en-IN')} / {MAX.toLocaleString('en-IN')}</span>}
      >
        {lookups.catalog?.variables?.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: T.meta, color: C.textMuted, marginRight: 4 }}>Insert:</span>
            {lookups.catalog.variables.map(v => (
              <button key={v.key} type="button" title={v.description} onClick={() => insert(v.key)}
                style={{ fontFamily: MONO, fontSize: T.meta, padding: '4px 8px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.surfaceInner, color: C.t2, cursor: 'pointer' }}>
                {`{{${v.key}}}`}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={ref} value={draft.instructions || ''} spellCheck
          onChange={e => patchDraft('instructions', e.target.value)}
          style={{ width: '100%', minHeight: 520, boxSizing: 'border-box', padding: 14, borderRadius: 10, border: `1.5px solid ${length > MAX ? C.primary : C.border}`, background: C.cardBg, color: C.text, fontFamily: MONO, fontSize: T.body, lineHeight: LH.normal, resize: 'vertical', outline: 'none' }}
        />
        {length > MAX && <Notice tone="danger" style={{ marginTop: 10 }}>Instructions are limited to {MAX.toLocaleString('en-IN')} characters.</Notice>}
      </Panel>

      <Panel title="Version history" hint="Every save is kept. Compare against your current draft, or restore an older one.">
        {!versions ? <div style={{ fontSize: T.body, color: C.textMuted }}>Loading…</div> : (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {versions.map(v => {
              const current = String(v.id) === String(version?.id);
              return (
                <li key={v.id} style={{ border: `1px solid ${current ? C.primary : C.border}`, borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ fontWeight: W.bold, color: C.text, fontSize: T.body }}>v{v.version}</span>
                    {current && <span style={{ fontSize: T.label, color: C.primary, fontWeight: W.medium }}>CURRENT</span>}
                    <span style={{ marginLeft: 'auto', fontSize: T.meta, color: C.textMuted }}>{when(v.created_at)}</span>
                  </div>
                  <div style={{ fontSize: T.meta, color: C.textSecondary, marginTop: 3, lineHeight: LH.normal }}>{v.change_note || 'No note'}{v.created_by_name ? ` · ${v.created_by_name}` : ''}</div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <Button variant="ghost" icon={GitCompare} onClick={() => openCompare(v)} style={{ padding: '5px 9px', fontSize: T.meta }}>Compare</Button>
                    {isAdmin && !current && <Button variant="ghost" icon={RotateCcw} onClick={() => restore(v)} style={{ padding: '5px 9px', fontSize: T.meta }}>Restore</Button>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Panel>

      {compare && (
        <Modal title={`Version ${compare.version.version} → your current draft`} onClose={() => setCompare(null)} width={860}
          footer={<>{isAdmin && String(compare.version.id) !== String(version?.id) && <Button icon={RotateCcw} onClick={() => restore(compare.version)}>Restore v{compare.version.version}</Button>}<Button variant="primary" onClick={() => setCompare(null)}>Close</Button></>}>
          <div style={{ fontSize: T.meta, color: C.textSecondary, marginBottom: 10 }}>
            <span style={{ color: C.dangerText }}>− only in v{compare.version.version}</span> · <span style={{ color: C.successText }}>+ only in your draft</span>
          </div>
          {(() => {
            const d = lineDiff(compare.version.instructions, draft.instructions);
            return d ? <DiffView diff={d} /> : <Notice tone="warn">These instructions are too long to compare line by line here.</Notice>;
          })()}
          <div style={{ marginTop: 14, fontSize: T.body, color: C.t3 }}>
            {otherChanges.length ? <>Also different: <b>{otherChanges.map(k => SECTION_LABEL[k]).join(', ')}</b>.</> : 'No other settings differ.'}
          </div>
        </Modal>
      )}
    </div>
  );
}
