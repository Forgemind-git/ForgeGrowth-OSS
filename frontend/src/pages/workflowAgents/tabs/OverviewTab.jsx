// Overview: name, model, limits and budget. These live on the agent row and are
// saved in place (not versioned), because changing the model or a budget is an
// operational decision, not a change to what the agent does.

import { Trash2 } from 'lucide-react';
import { C, FONT, MONO, T, W, LH } from '../../../constants.js';
import { Button, inputStyle, Segmented } from '../../academy/shared.jsx';
import SearchableSelect from '../../../components/SearchableSelect.jsx';
import Toggle from '../../../components/Toggle.jsx';
import { Panel, Notice, NumberInput, Collapsible, textareaStyle, when, rupees, Field } from '../wfShared.jsx';

const EFFORT_HINT = {
  low: 'Fastest and cheapest. Fine for simple, repetitive checks.',
  medium: 'A balance of speed and care.',
  high: 'Careful reasoning. The default for most agents.',
  xhigh: 'More thorough on long, multi-step work.',
  max: 'Most thorough and most expensive.',
};

export default function OverviewTab({ agent, version, settings, patchSettings, lookups, isAdmin, navigate, triggerSummary, onDelete }) {
  const models = lookups.settings?.models || [];
  const model = models.find(m => m.id === settings.model);
  const creds = lookups.settings?.anthropic_credentials || [];
  const noKey = lookups.settings && !creds.length && !lookups.settings.anthropic_env_key;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start', fontFamily: FONT }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <Panel title="About this agent">
          <Field label="Name"><input value={settings.name || ''} maxLength={120} onChange={e => patchSettings('name', e.target.value)} style={inputStyle} /></Field>
          <Field label="Description" hint="Shown on the agents list.">
            <textarea rows={3} value={settings.description || ''} maxLength={1000} onChange={e => patchSettings('description', e.target.value)} style={textareaStyle} />
          </Field>
        </Panel>

        <Panel title="Model" hint="Workflow agents run on Claude. Test runs and live runs use the same model.">
          {noKey && (
            <Notice tone="danger" style={{ marginBottom: 14 }}>
              No Anthropic API key is set up, so every run will fail with that message.{' '}
              {isAdmin && <button type="button" onClick={() => navigate('admin-settings', 'ai-models')} style={{ background: 'none', border: 'none', padding: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}>Add one in Admin Settings → AI Models</button>}
            </Notice>
          )}
          <Field label="Claude model">
            {models.length ? (
              <SearchableSelect
                value={settings.model}
                onChange={(v) => {
                  patchSettings('model', v);
                  const next = models.find(m => m.id === v);
                  if (next && next.effort_levels.length && !next.effort_levels.includes(settings.effort)) patchSettings('effort', 'high');
                }}
                options={models.map(m => ({ value: m.id, label: m.label, sublabel: `$${m.input_usd_per_mtok} in · $${m.output_usd_per_mtok} out per million tokens` }))}
              />
            ) : <div style={{ fontSize: T.body, color: C.t2, fontFamily: MONO }}>{agent.model_label || settings.model}</div>}
          </Field>
          {model && model.effort_levels.length > 0 && (
            <Field label="Effort" hint={EFFORT_HINT[settings.effort]}>
              <Segmented value={settings.effort} onChange={(v) => patchSettings('effort', v)} options={model.effort_levels.map(e => ({ value: e, label: e === 'xhigh' ? 'X-high' : e[0].toUpperCase() + e.slice(1) }))} />
            </Field>
          )}
          {model && (model.supports_temperature ? (
            <Field label="Temperature" hint="0 is the most consistent; 1 is the most varied.">
              <NumberInput value={settings.temperature} min={0} max={1} step={0.1} onChange={(v) => patchSettings('temperature', v == null ? 0.2 : v)} style={{ maxWidth: 140 }} />
            </Field>
          ) : (
            <div style={{ fontSize: T.meta, color: C.textMuted, marginBottom: 12, lineHeight: LH.normal }}>{model.label} sets its own sampling, so temperature is not sent.</div>
          ))}
          {isAdmin && (
            <Field label="API key">
              <SearchableSelect
                value={settings.credential_id == null ? '' : String(settings.credential_id)}
                onChange={(v) => patchSettings('credential_id', v === '' ? null : Number(v))}
                options={[
                  { value: '', label: lookups.settings?.anthropic_env_key && !creds.length ? 'Default (server environment key)' : 'Default (first Anthropic key)' },
                  ...creds.map(c => ({ value: String(c.id), label: c.label })),
                ]}
              />
            </Field>
          )}
        </Panel>

        <Panel title="Limits and budget" hint="A run that reaches a limit stops, keeps what it found so far, and is marked “Stopped at budget”.">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <Field label="Tool calls per run"><NumberInput value={settings.max_tool_calls} min={1} max={500} onChange={(v) => patchSettings('max_tool_calls', v)} /></Field>
            <Field label="Tokens per run"><NumberInput value={settings.max_tokens_per_run} min={1000} max={5000000} step={1000} onChange={(v) => patchSettings('max_tokens_per_run', v)} /></Field>
            <Field label="Output tokens per turn"><NumberInput value={settings.max_output_tokens} min={1000} max={128000} step={1000} onChange={(v) => patchSettings('max_output_tokens', v)} /></Field>
            <Field label="Monthly budget (₹)" hint="Empty = no limit. You are warned at 80%.">
              <NumberInput value={settings.monthly_budget_inr} min={1} step={100} placeholder="No limit" onChange={(v) => patchSettings('monthly_budget_inr', v)} />
            </Field>
          </div>
        </Panel>

        <Panel title="Memory">
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <Toggle checked={!!settings.auto_accept_memory} onChange={(v) => patchSettings('auto_accept_memory', v)} disabled={!isAdmin} />
            <div>
              <div style={{ fontSize: T.bodyLg, fontWeight: W.medium, color: C.text }}>Let the agent add memory without review</div>
              <div style={{ fontSize: T.meta, color: C.textSecondary, lineHeight: LH.normal, marginTop: 2 }}>
                Off: what the agent learns waits in the Memory tab for an admin. On: it is used from the next run straight away.
              </div>
            </div>
          </div>
        </Panel>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <Panel title="Current setup">
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '8px 16px', margin: 0, fontSize: T.body }}>
            <dt style={{ color: C.textMuted }}>Version</dt><dd style={{ margin: 0, color: C.text }}>v{version?.version ?? '—'}{version?.change_note ? ` · ${version.change_note}` : ''}</dd>
            <dt style={{ color: C.textMuted }}>Saved</dt><dd style={{ margin: 0, color: C.text }}>{when(version?.created_at)}</dd>
            <dt style={{ color: C.textMuted }}>Runs when</dt><dd style={{ margin: 0, color: C.text }}>{triggerSummary?.length ? triggerSummary.join(' · ') : 'Only when run by hand'}</dd>
            <dt style={{ color: C.textMuted }}>Started from</dt><dd style={{ margin: 0, color: C.text }}>{agent.preset_key ? agent.preset_key.replace(/_/g, ' ') : 'Blank agent'}</dd>
            <dt style={{ color: C.textMuted }}>Created</dt><dd style={{ margin: 0, color: C.text }}>{when(agent.created_at)}</dd>
            {settings.monthly_budget_inr != null && <><dt style={{ color: C.textMuted }}>Budget</dt><dd style={{ margin: 0, color: C.text }}>{rupees(settings.monthly_budget_inr)} a month</dd></>}
          </dl>
        </Panel>

        {lookups.catalog?.guardrails && (
          <Collapsible title="Platform rules added to every run (not editable)">
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: MONO, fontSize: T.meta, color: C.t3, lineHeight: LH.normal }}>{lookups.catalog.guardrails}</pre>
          </Collapsible>
        )}

        {isAdmin && (
          <Panel title="Delete agent" hint="Removes the agent with its versions, memory, run history and pending approvals.">
            <Button variant="danger" icon={Trash2} onClick={onDelete}>Delete this agent</Button>
          </Panel>
        )}
      </div>
    </div>
  );
}
