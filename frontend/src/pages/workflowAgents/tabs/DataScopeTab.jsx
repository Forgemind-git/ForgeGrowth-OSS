// Data access: the hard limits on what this agent's tools can see. The server
// applies them in SQL on every tool call, so a prompt can never widen them.

import { useEffect, useState } from 'react';
import { api } from '../../../api.js';
import { C, FONT, MONO, T, W, LH, maskPhone } from '../../../constants.js';
import { Segmented } from '../../academy/shared.jsx';
import Toggle from '../../../components/Toggle.jsx';
import { useFunnelConfig } from '../../../hooks/useFunnelConfig.js';
import { Panel, Notice, Label, MultiPick, ChipInput, NumberInput, CHAT_TYPE_INFO } from '../wfShared.jsx';

const WON_OPTIONS = [
  { value: 'include', label: 'Include', hint: 'Customers who already bought are treated like any other lead.' },
  { value: 'exclude', label: 'Leave out', hint: 'Anyone at a won stage is invisible to this agent.' },
  { value: 'exclude_unless_outstanding', label: 'Only if they still owe', hint: 'Won leads are left out unless a balance is still due on their product.' },
];

function Row({ label, hint, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '8px 24px', padding: '14px 0', borderTop: `1px solid ${C.borderSubtle}` }}>
      <Label hint={hint}>{label}</Label>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

function ToggleRow({ checked, onChange, title, hint }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 0' }}>
      <Toggle checked={checked} onChange={onChange} />
      <div>
        <div style={{ fontSize: T.bodyLg, fontWeight: W.medium, color: C.text }}>{title}</div>
        <div style={{ fontSize: T.meta, color: C.textSecondary, lineHeight: LH.normal, marginTop: 2 }}>{hint}</div>
      </div>
    </div>
  );
}

export default function DataScopeTab({ draft, patchDraft, lookups }) {
  const scope = draft.data_scope || {};
  const set = (key, value) => patchDraft('data_scope', (s) => ({ ...(s || {}), [key]: value }));
  const { stages, sources } = useFunnelConfig();
  const [tags, setTags] = useState([]);
  useEffect(() => { api.tags.list().then(r => setTags(Array.isArray(r) ? r : r?.tags || [])).catch(() => setTags([])); }, []);

  const team = lookups.team;
  const listOr = (v) => (Array.isArray(v) && v.length ? v : ['all']);
  const chatTypes = Array.isArray(scope.chat_types) ? scope.chat_types : Object.keys(CHAT_TYPE_INFO);
  const exclude = Array.isArray(scope.exclude_tags) ? scope.exclude_tags : ['do_not_contact', 'test'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontFamily: FONT }}>
      <Notice tone="info">
        These limits are applied by the server on every tool call. If the agent asks about a lead outside them, it is told the lead is out of scope and never sees what it contains.
      </Notice>

      <Panel title="Whose leads" hint="Leave a list on “All” to not filter by it.">
        <Row label="Business numbers" hint="Leads who have a chat on any of these numbers.">
          {team ? (
            <MultiPick allLabel="All numbers" value={listOr(scope.business_numbers)} onChange={(v) => set('business_numbers', v)}
              options={team.numbers.map(n => ({ value: String(n.number || '').replace(/\D/g, ''), label: n.label || maskPhone(n.number), sublabel: maskPhone(n.number) }))} />
          ) : <span style={{ fontFamily: MONO, fontSize: T.body }}>{listOr(scope.business_numbers).map(v => (v === 'all' ? 'All' : maskPhone(v))).join(', ')}</span>}
        </Row>
        <Row label="Teams" hint="Leads owned by a rep in these teams.">
          {team ? (
            <MultiPick allLabel="All teams" value={listOr(scope.teams)} onChange={(v) => set('teams', v)} emptyText="No teams yet: add them in Team & settings."
              options={team.teams.map(t => ({ value: t.id, label: t.name }))} />
          ) : <span style={{ fontSize: T.body }}>{listOr(scope.teams).join(', ')}</span>}
        </Row>
        <Row label="Reps" hint="Owner is worked out from the lead, then the chat, then who held the number when the lead last wrote.">
          {team ? (
            <MultiPick allLabel="All reps" value={listOr(scope.rep_user_ids)} onChange={(v) => set('rep_user_ids', v)}
              options={[{ value: 'unassigned', label: 'Unassigned leads' }, ...team.reps.filter(r => r.active).map(r => ({ value: r.id, label: r.name, sublabel: r.role }))]} />
          ) : <span style={{ fontSize: T.body }}>{listOr(scope.rep_user_ids).join(', ')}</span>}
        </Row>
        <Row label="Funnel stages">
          <MultiPick allLabel="All stages" value={listOr(scope.funnel_stages)} onChange={(v) => set('funnel_stages', v)}
            options={stages.map(s => ({ value: s.stageKey, label: s.label }))} />
        </Row>
        <Row label="Lead sources">
          <MultiPick allLabel="All sources" value={listOr(scope.sources)} onChange={(v) => set('sources', v)}
            options={sources.map(s => { const name = typeof s === 'string' ? s : s.name || s.label; return { value: name, label: name }; })} />
        </Row>
        <Row label="Customers who already bought">
          <Segmented value={scope.won_stages || 'include'} onChange={(v) => set('won_stages', v)} options={WON_OPTIONS.map(o => ({ value: o.value, label: o.label }))} />
          <div style={{ fontSize: T.meta, color: C.textSecondary, marginTop: 6 }}>{WON_OPTIONS.find(o => o.value === (scope.won_stages || 'include'))?.hint}</div>
        </Row>
        <Row label="Leave out contacts tagged" hint="Matched on the tag name, ignoring case and spaces.">
          <ChipInput value={exclude} onChange={(v) => set('exclude_tags', v)} placeholder="Type a tag and press Enter"
            normalize={(s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')} />
          {tags.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {tags.filter(t => !exclude.includes(String(t.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''))).slice(0, 12).map(t => (
                <button key={t.id} type="button" onClick={() => set('exclude_tags', [...exclude, String(t.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')])}
                  style={{ fontSize: T.meta, padding: '3px 8px', borderRadius: 999, border: `1px dashed ${C.borderStrong}`, background: 'transparent', color: C.t3, cursor: 'pointer', fontFamily: FONT }}>
                  + {t.name}
                </button>
              ))}
            </div>
          )}
        </Row>
      </Panel>

      <Panel title="Which messages" hint="Message types outside this list are never returned by any tool.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
          {Object.entries(CHAT_TYPE_INFO).map(([key, info]) => {
            const on = chatTypes.includes(key);
            return (
              <label key={key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: 10, borderRadius: 10, border: `1.5px solid ${on ? C.primary : C.border}`, background: on ? C.selectedTint : C.cardBg, cursor: 'pointer' }}>
                <input type="checkbox" checked={on} onChange={() => set('chat_types', on ? chatTypes.filter(k => k !== key) : [...chatTypes, key])} style={{ marginTop: 3 }} />
                <span>
                  <span style={{ display: 'block', fontSize: T.body, fontWeight: W.medium, color: C.text }}>{info.label}</span>
                  <span style={{ display: 'block', fontSize: T.meta, color: C.textSecondary, lineHeight: LH.normal }}>{info.hint}</span>
                </span>
              </label>
            );
          })}
        </div>
        <Row label="How far back" hint="The longest window any tool may look at, in days (1–365).">
          <NumberInput value={scope.lookback_days ?? 14} min={1} max={365} onChange={(v) => set('lookback_days', v == null ? 14 : v)} style={{ maxWidth: 140 }} />
        </Row>
      </Panel>

      <Panel title="Privacy">
        <ToggleRow checked={scope.mask_pii !== false} onChange={(v) => set('mask_pii', v)} title="Mask phone numbers and names"
          hint="Numbers reach the model as +91 98xxxxx210 and names as “Priya S.”. Turn off only if the agent needs full details and your role allows it." />
        <ToggleRow checked={scope.exclude_opted_out !== false} onChange={(v) => set('exclude_opted_out', v)} title="Leave out leads who opted out"
          hint="Recommended. The send tools refuse opted-out leads either way." />
      </Panel>
    </div>
  );
}
