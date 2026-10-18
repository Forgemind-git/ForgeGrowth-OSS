// Marketing → Conversion API → Quick setup: the whole feature in three plain
// steps, for someone who has never opened Events Manager.
//
//   1  Connect   — each WhatsApp number needs a Meta "dataset"; one button
//                  finds an existing one or creates it.
//   2  Stages    — for every funnel stage, one choice: don't send, or which
//                  event Meta should learn from. "Paid" sends the amount paid.
//   3  Turn on   — test first (test code + a test event), then go live.
//
// It uses exactly the same API calls as the advanced tabs (datasets, mappings,
// config), so the two can never disagree; anything this screen cannot express
// (several events per stage, fixed values, customer details, history) is still
// in Advanced.
import { useState } from 'react';
import { CheckCircle2, Circle, Database, Send, AlertTriangle, Loader2, ArrowRight } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO, T, W } from '../constants.js';
import { showError, showSuccess } from '../lib/feedback.js';
import SearchableSelect from './SearchableSelect.jsx';
import { useFunnelConfig } from '../hooks/useFunnelConfig.js';
import { StageBadge } from '../pages/academy/shared.jsx';

// Plain-language choices, each a standard Meta event. Purchase carries the
// amount the customer actually paid (value mode sale_total).
export const QUICK_EVENTS = [
  { value: '', label: "Don't send" },
  { value: 'Lead', label: 'New enquiry', sublabel: 'Meta event: Lead' },
  { value: 'Contact', label: 'Started talking to us', sublabel: 'Meta event: Contact' },
  { value: 'CompleteRegistration', label: 'Registered / qualified', sublabel: 'Meta event: CompleteRegistration' },
  { value: 'Schedule', label: 'Booked a call or demo', sublabel: 'Meta event: Schedule' },
  { value: 'InitiateCheckout', label: 'Ready to pay', sublabel: 'Meta event: InitiateCheckout' },
  { value: 'Purchase', label: 'Paid — sends the amount', sublabel: 'Meta event: Purchase' },
];
const valueModeFor = (event) => (event === 'Purchase' ? 'sale_total' : 'none');

function Step({ n, done, title, hint, children }) {
  return (
    <div style={{ display: 'flex', gap: 14, padding: '18px 20px', background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14, marginBottom: 12 }}>
      <div style={{ flexShrink: 0, marginTop: 1 }}>
        {done ? <CheckCircle2 size={26} color={C.green} /> : (
          <span style={{ width: 26, height: 26, borderRadius: 99, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: C.primaryLight, color: C.primary, fontSize: T.body, fontWeight: W.heavy }}>{n}</span>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: T.lead, fontWeight: W.bold, color: C.text }}>{title}</div>
        {hint && <div style={{ fontSize: T.body, color: C.textSecondary, marginTop: 3, lineHeight: 1.5 }}>{hint}</div>}
        <div style={{ marginTop: 12 }}>{children}</div>
      </div>
    </div>
  );
}

export default function CapiQuickSetup({ cfg, saving, patchConfig, loadConfig, confirm, sendTest, toggleMaster, onAdvanced }) {
  const { stages } = useFunnelConfig();
  const [busy, setBusy] = useState('');
  const config = cfg.config;
  const accounts = [...(cfg.datasets || []), ...(cfg.unlinkedAccounts || []).map(a => ({ ...a, datasetId: null }))];
  const ready = !!cfg.metaConnected && accounts.some(a => a.datasetId);
  const mappings = cfg.mappings || [];
  const byStage = (key) => mappings.filter(m => m.stageKey === key);
  const mappedCount = mappings.filter(m => m.active).length;
  const funnel = (stages || []).filter(s => s.isFunnel !== false || s.isWon);

  async function setUp(acc) {
    setBusy('ds:' + acc.wabaId);
    try {
      // Look first — creating a second dataset when one already exists is the
      // mistake this avoids.
      const d = await api.capi.discoverDatasets();
      const found = (d.datasets || []).find(x => x.wabaId === acc.wabaId && x.datasetId);
      if (found) { showSuccess(`${acc.label || acc.wabaId} is connected.`); return; }
      const ok = await confirm({
        title: 'Create a conversions dataset in Meta?',
        body: `“${acc.label || acc.wabaId}” has no dataset yet. ForgeGrowth will create one in your Meta business account so conversions have somewhere to go. This is a permanent change in Meta.`,
        confirmLabel: 'Create it',
      });
      if (!ok) return;
      await api.capi.createDataset(acc.wabaId);
      showSuccess(`${acc.label || acc.wabaId} is connected.`);
    } catch (e) { showError(e.message); }
    finally { setBusy(''); loadConfig(); }
  }

  async function setStageEvent(stageKey, eventName) {
    setBusy('st:' + stageKey);
    try {
      const existing = byStage(stageKey);
      if (!eventName) {
        for (const m of existing) await api.capi.deleteMapping(m.id);
      } else if (existing[0]) {
        await api.capi.updateMapping(existing[0].id, { stageKey, eventName, valueMode: valueModeFor(eventName), active: true });
      } else {
        await api.capi.createMapping({ stageKey, eventName, valueMode: valueModeFor(eventName), active: true });
      }
    } catch (e) { showError(e.message); }
    finally { setBusy(''); loadConfig(); }
  }

  const testCodeOk = config.mode !== 'test' || !!String(config.testEventCode || '').trim();

  return (
    <div data-testid="capi-quick" style={{ fontFamily: FONT, maxWidth: 920 }}>
      <Step n={1} done={ready}
        title="Connect your WhatsApp numbers to Meta"
        hint="Meta needs a place to receive conversions for each WhatsApp number that runs ads.">
        {!cfg.metaConnected ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: C.warnText, fontSize: T.body }}>
            <AlertTriangle size={16} /> First connect Meta Ads in <b>Marketing → Campaigns</b> (the same login is used here).
          </div>
        ) : accounts.length === 0 ? (
          <div style={{ fontSize: T.body, color: C.textMuted }}>No WhatsApp numbers found.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {accounts.map(a => (
              <div key={a.wabaId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: C.surfaceSection, border: `1px solid ${C.borderSubtle}` }}>
                <Database size={16} color={a.datasetId ? C.green : C.textMuted} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: T.body, fontWeight: W.medium, color: C.text }}>{a.label || a.wabaId}</span>
                  <span style={{ display: 'block', fontSize: T.label, color: a.datasetId ? C.textMuted : (a.clicks > 0 ? C.dangerText : C.textMuted) }}>
                    {a.datasetId ? 'Connected' : a.clicks > 0 ? `Not connected — ${a.clicks} ad clicks can't be reported yet` : 'Not connected'}
                  </span>
                </span>
                {a.datasetId
                  ? <CheckCircle2 size={18} color={C.green} />
                  : (
                    <button onClick={() => setUp(a)} disabled={!!busy || saving}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 9, border: 'none', background: C.primary, color: '#fff', fontFamily: FONT, fontSize: T.meta, fontWeight: W.bold, cursor: 'pointer' }}>
                      {busy === 'ds:' + a.wabaId ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : null} Set it up
                    </button>
                  )}
              </div>
            ))}
          </div>
        )}
      </Step>

      <Step n={2} done={mappedCount > 0}
        title="Choose which stages count as a conversion"
        hint="When a contact who came from an ad reaches a stage, Meta is told so it can find more people like them. Pick the stages that matter — usually the paid stage, and maybe one before it.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {funnel.map(s => {
            const m = byStage(s.stageKey);
            const current = m[0]?.eventName || '';
            const extra = m.length > 1 ? m.length - 1 : 0;
            const opts = QUICK_EVENTS.some(o => o.value === current) ? QUICK_EVENTS : [...QUICK_EVENTS, { value: current, label: current, sublabel: 'set in Advanced' }];
            return (
              <div key={s.stageKey} data-testid={`capi-stage-${s.stageKey}`} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '8px 4px', borderBottom: `1px solid ${C.borderSubtle}` }}>
                <span style={{ width: 170, flexShrink: 0 }}><StageBadge stage={s.stageKey} /></span>
                <ArrowRight size={14} color={C.textMuted} />
                <div style={{ width: 280 }}>
                  <SearchableSelect value={current} onChange={v => setStageEvent(s.stageKey, v)} options={opts} placeholder="Don't send" disabled={!!busy} />
                </div>
                {busy === 'st:' + s.stageKey && <Loader2 size={14} color={C.textMuted} style={{ animation: 'spin 1s linear infinite' }} />}
                {extra > 0 && <span style={{ fontSize: T.label, color: C.textMuted }}>+{extra} more in Advanced</span>}
              </div>
            );
          })}
        </div>
      </Step>

      <Step n={3} done={!!config.enabled && config.mode === 'live'}
        title="Turn it on"
        hint="Start with a test: events show up only in Meta's Events Manager → Test events and don't change your ads. When the test arrives, switch to Live.">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {[{ id: 'test', label: 'Test first', sub: 'nothing changes in your ads' }, { id: 'live', label: 'Live', sub: 'Meta optimises your ads with it' }].map(o => {
            const on = config.mode === o.id;
            return (
              <button key={o.id} onClick={() => !on && patchConfig({ mode: o.id })} disabled={saving} aria-pressed={on}
                style={{ textAlign: 'left', padding: '10px 14px', borderRadius: 11, cursor: 'pointer', fontFamily: FONT, border: `2px solid ${on ? C.primary : C.border}`, background: on ? C.primaryLight : C.cardBg, minWidth: 210 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: T.body, fontWeight: W.bold, color: C.text }}>
                  {on ? <CheckCircle2 size={15} color={C.primary} /> : <Circle size={15} color={C.textMuted} />}{o.label}
                </span>
                <span style={{ display: 'block', fontSize: T.label, color: C.textMuted, marginTop: 2, paddingLeft: 22 }}>{o.sub}</span>
              </button>
            );
          })}
        </div>
        {config.mode === 'test' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <input defaultValue={config.testEventCode} placeholder="Test code from Events Manager, e.g. TEST12345"
              onBlur={e => e.target.value !== config.testEventCode && patchConfig({ testEventCode: e.target.value.trim() })}
              style={{ flex: '1 1 260px', maxWidth: 360, padding: '9px 12px', borderRadius: 9, border: `1.5px solid ${C.border}`, background: C.cardBg, color: C.text, fontFamily: MONO, fontSize: T.body }} />
            <button onClick={sendTest} disabled={saving || !ready || !testCodeOk}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 9, border: `1.5px solid ${C.border}`, background: C.cardBg, color: C.text, fontFamily: FONT, fontSize: T.body, fontWeight: W.medium, cursor: 'pointer', opacity: !ready || !testCodeOk ? 0.5 : 1 }}>
              <Send size={14} /> Send a test event
            </button>
            <span style={{ fontSize: T.label, color: C.textMuted, flexBasis: '100%' }}>Events Manager → your dataset → Test events shows the code.</span>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 11, background: config.enabled ? C.successBg : C.surfaceSection }}>
          <span style={{ flex: 1, fontSize: T.body, fontWeight: W.bold, color: config.enabled ? C.successText : C.text }}>
            {config.enabled ? (config.mode === 'live' ? 'On — sending live conversions to Meta' : 'On — sending test conversions') : 'Off — nothing is sent to Meta'}
          </span>
          {!ready && <span style={{ fontSize: T.label, color: C.warnText }}>Finish step 1 first</span>}
          {ready && mappedCount === 0 && <span style={{ fontSize: T.label, color: C.warnText }}>Pick at least one stage</span>}
          {ready && mappedCount > 0 && !testCodeOk && <span style={{ fontSize: T.label, color: C.warnText }}>Add the test code</span>}
          <button role="switch" aria-checked={!!config.enabled} onClick={() => toggleMaster(!config.enabled)}
            disabled={saving || !ready || (!config.enabled && (mappedCount === 0 || !testCodeOk))}
            style={{ width: 46, height: 26, borderRadius: 99, border: 'none', padding: 3, cursor: 'pointer', background: config.enabled ? C.green : C.fillMuted, display: 'flex', justifyContent: config.enabled ? 'flex-end' : 'flex-start', opacity: saving || !ready ? 0.5 : 1 }}>
            <span style={{ width: 20, height: 20, borderRadius: 99, background: '#fff', boxShadow: C.shadowSm }} />
          </button>
        </div>
      </Step>

      <button onClick={onAdvanced} style={{ background: 'none', border: 'none', padding: '4px 2px', color: C.textSecondary, fontFamily: FONT, fontSize: T.meta, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 }}>
        Advanced settings — customer details, click IDs, history and performance
      </button>
    </div>
  );
}
