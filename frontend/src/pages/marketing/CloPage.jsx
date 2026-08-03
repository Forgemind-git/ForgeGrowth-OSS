// Conversion Leads Optimisation — Meta optimises delivery toward leads that
// become customers, using down-funnel stage data we send from this CRM.
//
// ⚠ Lead Ads (Instant Forms) ONLY. It does not work with Click-to-WhatsApp,
// which is what the Conversion API tab handles. The two are separate
// integrations with different datasets and different payloads.
//
// Two sub-views for now: Setup and Funnel Stages. Readiness and Event Log land
// in the next step.
import { useState, useEffect, useCallback } from 'react';
import {
  Settings, ListOrdered, Zap, Send, RefreshCw, AlertTriangle, CheckCircle2,
  Plus, Trash2, GripVertical, Target, Info, Loader2, ClipboardCheck, ScrollText, Radio,
} from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import { showError, showSuccess } from '../../lib/feedback.js';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import { PageShell, Button, Badge, EmptyState, Field, inputStyle } from '../academy/shared.jsx';
import { Card, Shimmer } from '../../components/charts.jsx';
import { ReadinessView, EventLogView } from '../../components/CloDiagnostics.jsx';

const SUB_TABS = [
  { id: 'setup', label: 'Setup', Icon: Settings, blurb: 'Connect the CRM dataset and choose test or live' },
  { id: 'stages', label: 'Funnel Stages', Icon: ListOrdered, blurb: 'Map your lead statuses onto the ladder Meta optimises against' },
  { id: 'readiness', label: 'Readiness', Icon: ClipboardCheck, blurb: "Whether this meets Meta's published criteria, measured on your live data" },
  { id: 'log', label: 'Event Log', Icon: ScrollText, blurb: 'Every attempt, and why anything that did not send was skipped' },
];

function Toggle({ on, onChange, disabled }) {
  return (
    <button onClick={() => !disabled && onChange(!on)} disabled={disabled}
      style={{
        width: 42, height: 24, borderRadius: 99, border: 'none', padding: 3,
        cursor: disabled ? 'not-allowed' : 'pointer', background: on ? '#0F6E56' : C.border,
        display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start', alignItems: 'center',
        opacity: disabled ? 0.5 : 1, flexShrink: 0, transition: 'background .15s',
      }}>
      <span style={{ width: 18, height: 18, borderRadius: 99, background: '#fff', boxShadow: C.shadowSm }} />
    </button>
  );
}

export default function CloPage({ subParts, navigate }) {
  const tab = SUB_TABS.some(t => t.id === subParts?.[0]) ? subParts[0] : 'setup';
  const goTab = (id) => (navigate ? navigate('clo', id === 'setup' ? undefined : id) : undefined);

  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  // Stage list is loaded here rather than inside the log view: the log's stage
  // filter needs it, and fetching it there would refetch on every filter change.
  const [allStages, setAllStages] = useState([]);

  const loadConfig = useCallback(async () => {
    try { setCfg(await api.clo.settings()); }
    catch (e) { showError(e.message); }
  }, []);
  useEffect(() => { loadConfig(); }, [loadConfig]);
  useEffect(() => { api.clo.stages().then(d => setAllStages(d.stages)).catch(() => setAllStages([])); }, []);

  async function patch(body) {
    setSaving(true);
    try {
      const d = await api.clo.updateSettings(body);
      setCfg(c => ({ ...c, settings: d.settings }));
      return d.settings;
    } catch (e) { showError(e.message); }
    finally { setSaving(false); }
  }

  const s = cfg?.settings;

  return (
    <PageShell
      title="Conversion Leads Optimisation"
      subtitle="Send down-funnel stage data back to Meta so it optimises toward leads that actually become customers, not just leads that fill a form."
      actions={<Button icon={RefreshCw} onClick={loadConfig} disabled={saving}>Refresh</Button>}
    >
      {/* The single most important thing to know before configuring anything. */}
      <div style={{
        display: 'flex', gap: 9, padding: '11px 13px', marginBottom: 16,
        background: '#FFF8E6', border: '1px solid #F0DCA8', borderRadius: 10, fontFamily: FONT,
      }}>
        <Info size={15} color="#B7791F" style={{ flexShrink: 0, marginTop: 1 }} />
        <span style={{ fontSize: 12.5, color: '#6B5312', lineHeight: 1.55 }}>
          This works with <strong>Facebook and Instagram Lead Ads (Instant Forms) only</strong>. It does not apply to
          click-to-WhatsApp traffic, which the Conversion API tab handles separately. Both halves are required:
          sending this data without switching the goal to Conversion Leads in Ads Manager changes reporting but not
          delivery.
        </span>
      </div>

      <div style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: `1px solid ${C.border}` }}>
          {SUB_TABS.map(t => {
            const on = t.id === tab;
            return (
              <button key={t.id} onClick={() => goTab(t.id)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 14px', border: 'none',
                  borderBottom: `2px solid ${on ? C.primary : 'transparent'}`, background: 'transparent',
                  cursor: 'pointer', fontFamily: FONT, fontSize: 13.5, fontWeight: on ? 700 : 500,
                  color: on ? C.text : C.textSecondary, marginBottom: -1,
                }}>
                <t.Icon size={15} />{t.label}
                {t.id === 'setup' && s && (
                  <span title={s.enabled ? 'On' : 'Off'} style={{
                    width: 7, height: 7, borderRadius: 99, marginLeft: 2,
                    background: s.enabled ? (s.dryRun ? '#E8A317' : '#0F6E56') : C.textMuted,
                  }} />
                )}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: 12.5, color: C.textMuted, fontFamily: FONT, marginTop: 9 }}>
          {SUB_TABS.find(t => t.id === tab)?.blurb}
        </div>
      </div>

      {!cfg ? <Shimmer height={160} radius={12} /> : (
        <>
          {tab === 'setup' && <SetupView cfg={cfg} saving={saving} onPatch={patch} confirm={confirm} />}
          {tab === 'stages' && <StagesView cfg={cfg} confirm={confirm} onSettingsChanged={loadConfig} />}
          {tab === 'readiness' && <ReadinessView />}
          {tab === 'log' && <EventLogView stages={allStages} />}
        </>
      )}
      {confirmEl}
    </PageShell>
  );
}

// ── Setup ───────────────────────────────────────────────────────────────────
function SetupView({ cfg, saving, onPatch, confirm }) {
  const s = cfg.settings;
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [token, setToken] = useState('');

  const ready = !!s.datasetId && s.tokenConfigured;

  async function toggleMaster(next) {
    if (next && !s.dryRun) {
      const ok = await confirm({
        title: 'Start sending live conversion data?',
        body: 'Real lead-stage events will be sent to Meta. It will use them to decide who sees your Lead Ads. '
            + 'Meta needs two to four weeks of steady data before delivery meaningfully changes.',
        confirmLabel: 'Yes, go live', danger: true,
      });
      if (!ok) return;
    }
    await onPatch({ enabled: next });
  }

  async function leaveDryRun(next) {
    if (!next) {
      const ok = await confirm({
        title: 'Turn off dry run?',
        body: 'Events are currently built and stored but never transmitted. Turning dry run off means the next '
            + 'dispatch sends them to Meta for real.',
        confirmLabel: 'Turn off dry run', danger: true,
      });
      if (!ok) return;
    }
    await onPatch({ dryRun: next });
  }

  async function sendTest() {
    setTesting(true); setTestResult(null);
    try { setTestResult(await api.clo.testEvent()); }
    catch (e) { setTestResult({ ok: false, error: e.message }); }
    finally { setTesting(false); }
  }

  return (
    <>
      {/* master switch */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', background: C.cardBg,
        border: `1px solid ${s.enabled ? '#B6DFCE' : C.border}`, borderRadius: 12,
        padding: '16px 18px', marginBottom: 14, boxShadow: C.shadowSm,
      }}>
        <div style={{
          width: 42, height: 42, borderRadius: 11, flexShrink: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center', background: s.enabled ? '#E1F5EE' : C.hover,
        }}>
          <Zap size={20} color={s.enabled ? '#0F6E56' : C.textMuted} />
        </div>
        <div style={{ minWidth: 200, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, display: 'flex', alignItems: 'center', gap: 8 }}>
            {s.enabled ? 'Collecting lead-stage events' : 'Conversion Leads Optimisation is off'}
            <Badge label={s.dryRun ? 'DRY RUN' : 'LIVE'}
              color={s.dryRun ? '#854F0B' : '#dc2626'} bg={s.dryRun ? '#FAEEDA' : '#FCEBEB'} />
          </div>
          <div style={{ fontSize: 12.5, color: C.textSecondary, marginTop: 3 }}>
            {!s.enabled ? 'Nothing is recorded and nothing is sent.'
              : s.dryRun ? 'Events are built and stored so you can inspect them. Nothing reaches Meta.'
              : 'Events are transmitted to Meta on every dispatch.'}
          </div>
        </div>
        {!ready && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#854F0B', fontFamily: FONT }}>
            <AlertTriangle size={15} /> Add a dataset and token first
          </span>
        )}
        <Toggle on={s.enabled} onChange={toggleMaster} disabled={saving} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 14 }}>
        <Card title="Where events are sent">
          <div style={{ fontSize: 12.5, color: C.textSecondary, marginBottom: 12, lineHeight: 1.55 }}>
            CRM events need their <strong>own dataset</strong>, separate from any web or messaging dataset. Mixing
            them corrupts both funnels, so create a dedicated one in Events Manager.
          </div>
          <Field label="Dataset ID" hint="The numeric ID from Events Manager — not the dataset name.">
            <input style={inputStyle} defaultValue={s.datasetId} placeholder="1234567890123456"
              onBlur={e => e.target.value !== s.datasetId && onPatch({ datasetId: e.target.value })} />
          </Field>

          <Field label="System-user access token"
            hint={s.tokenConfigured ? 'A token is stored. Paste a new one to replace it.' : 'Needs the ads_management and leads_retrieval scopes.'}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              {s.tokenConfigured
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: C.green, fontFamily: FONT, fontWeight: 600 }}>
                    <CheckCircle2 size={14} /> Token stored
                  </span>
                : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: C.textMuted, fontFamily: FONT }}>
                    <AlertTriangle size={14} /> Not configured
                  </span>}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={{ ...inputStyle, fontFamily: MONO, fontSize: 12 }} type="password"
                value={token} onChange={e => setToken(e.target.value)} placeholder="Paste the token" />
              <Button disabled={saving || !token.trim()}
                onClick={async () => { await onPatch({ accessToken: token.trim() }); setToken(''); showSuccess('Token stored.'); }}>
                Save
              </Button>
            </div>
            {/* Stated plainly, because a token pasted into a form that might echo
                it back is a reasonable thing to be nervous about. */}
            <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 6 }}>
              Stored encrypted. It is never shown again and never leaves this server except in the call to Meta.
            </div>
          </Field>
        </Card>

        <Card title="How events are sent">
          <Field label="Dry run"
            hint="On by default. Events are built and stored exactly as they would be sent, but nothing is transmitted.">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Toggle on={s.dryRun} onChange={leaveDryRun} disabled={saving} />
              <span style={{ fontSize: 13, color: C.text, fontFamily: FONT }}>
                {s.dryRun ? 'Nothing is transmitted' : 'Events are transmitted'}
              </span>
            </div>
          </Field>

          <Field label="Lead event source" hint="Names this CRM to Meta. Required on every event.">
            <input style={inputStyle} defaultValue={s.leadEventSource}
              onBlur={e => e.target.value !== s.leadEventSource && onPatch({ leadEventSource: e.target.value })} />
          </Field>

          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <Field label="Graph API version">
                <input style={inputStyle} defaultValue={s.graphApiVersion}
                  onBlur={e => e.target.value !== s.graphApiVersion && onPatch({ graphApiVersion: e.target.value })} />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label="Test event code" hint="From Events Manager → Test Events.">
                <input style={inputStyle} defaultValue={s.testEventCode} placeholder="TEST12345"
                  onBlur={e => e.target.value !== s.testEventCode && onPatch({ testEventCode: e.target.value })} />
              </Field>
            </div>
          </div>

          <Button icon={testing ? Loader2 : Send} onClick={sendTest} disabled={testing || !ready}
            style={{ width: '100%', marginTop: 4 }}>
            {testing ? 'Sending…' : 'Send test event'}
          </Button>

          {testResult && (
            <div style={{
              marginTop: 12, padding: '11px 13px', borderRadius: 10, fontFamily: FONT, fontSize: 12.5,
              background: testResult.ok ? '#F5FBF8' : '#FCEBEB',
              border: `1px solid ${testResult.ok ? '#CDE9DE' : '#F3C6C6'}`,
              color: testResult.ok ? '#215D4C' : '#8A1F1F',
            }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {testResult.ok ? `Meta accepted the event (${testResult.eventsReceived} received)` : 'Meta rejected the event'}
              </div>
              {testResult.error && <div style={{ marginBottom: 4 }}>{testResult.error}</div>}
              {testResult.fbtraceId && (
                <div style={{ fontFamily: MONO, fontSize: 11.5 }}>fbtrace_id: {testResult.fbtraceId}</div>
              )}
              {testResult.ok && (
                <div style={{ marginTop: 4 }}>Check Events Manager → Test Events to confirm it arrived.</div>
              )}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

// ── Funnel Stages ───────────────────────────────────────────────────────────
function StagesView({ cfg, confirm, onSettingsChanged }) {
  const [stages, setStages] = useState(null);
  const [stats, setStats] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([api.clo.stages(), api.clo.stageStats()]);
      setStages(a.stages); setStats(b);
    } catch (e) { showError(e.message); setStages([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const statById = {};
  for (const st of stats?.stats || []) statById[st.stageId] = st;

  async function addStage() {
    setBusy(true);
    try {
      const n = (stages?.length || 0) + 1;
      await api.clo.createStage({
        stageKey: `stage_${n}`, eventName: 'QualifiedLead', displayName: `Stage ${n}`, crmStatusValues: [],
      });
      await load();
    } catch (e) { showError(e.message); }
    finally { setBusy(false); }
  }

  async function saveStage(stage, patch) {
    setBusy(true);
    try {
      await api.clo.updateStage(stage.id, { ...stage, ...patch });
      await load();
      if (patch.isOptimisationTarget) onSettingsChanged();
    } catch (e) {
      // A rename that would split the Meta history comes back as a 409 asking
      // for confirmation rather than silently going through.
      if (/already sent/i.test(e.message)) {
        const ok = await confirm({ title: 'Rename a stage Meta already knows?', body: e.message, confirmLabel: 'Rename anyway', danger: true });
        if (ok) {
          try { await api.clo.updateStage(stage.id, { ...stage, ...patch, confirmKeyChange: true }); await load(); }
          catch (e2) { showError(e2.message); }
        }
      } else showError(e.message);
    } finally { setBusy(false); }
  }

  async function removeStage(stage) {
    const ok = await confirm({
      title: `Delete “${stage.displayName}”?`, body: 'It will no longer be sent to Meta.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try { await api.clo.deleteStage(stage.id); await load(); }
    catch (e) { showError(e.message); }
  }

  async function onDrop(targetId) {
    if (!dragId || dragId === targetId) return setDragId(null);
    const ids = stages.map(s => s.id);
    const from = ids.indexOf(dragId), to = ids.indexOf(targetId);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setStages(ids.map(id => stages.find(s => s.id === id)));  // optimistic
    setDragId(null);
    try { await api.clo.reorderStages(ids); await load(); }
    catch (e) { showError(e.message); load(); }
  }

  if (!stages) return <Shimmer height={240} radius={12} />;

  return (
    <>
      <Card
        title="The ladder Meta optimises against"
        right={<Button variant="primary" icon={Plus} onClick={addStage} disabled={busy}>Add stage</Button>}
        style={{ marginBottom: 16 }}
      >
        <div style={{ fontSize: 12.5, color: C.textSecondary, marginBottom: 14, lineHeight: 1.55 }}>
          Order these from earliest to deepest. Meta learns from the one you mark as the optimisation target, so it
          should be the stage that genuinely separates a good lead from a bad one — and it has to be reached often
          enough for Meta to have something to learn from.
          {stats && (
            <> Rates below are measured over the <strong>{stats.cohortLeads} leads created in the last {stats.cohortDays} days</strong>.</>
          )}
        </div>

        {stages.length === 0 ? (
          <EmptyState Icon={ListOrdered} title="No stages yet"
            hint="Add the rungs of your funnel and map each one to the lead statuses that mean it was reached." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {stages.map(stage => (
              <StageRow
                key={stage.id} stage={stage} stat={statById[stage.id]} bands={stats?.bands}
                windowDays={stats?.windowDays} statusOptions={cfg.crmStatusOptions || []}
                busy={busy} dragging={dragId === stage.id}
                onDragStart={() => setDragId(stage.id)} onDragEnd={() => setDragId(null)}
                onDrop={() => onDrop(stage.id)}
                onSave={(patch) => saveStage(stage, patch)} onDelete={() => removeStage(stage)}
              />
            ))}
          </div>
        )}
      </Card>

      <CtwaRoutePanel navigate={navigate} />

      {stats && stats.leadsPerMonth < stats.bands.minLeadsPerMonth && (
        <div style={{
          display: 'flex', gap: 9, padding: '11px 13px', background: '#FFF8E6',
          border: '1px solid #F0DCA8', borderRadius: 10, fontFamily: FONT,
        }}>
          <AlertTriangle size={15} color="#B7791F" style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ fontSize: 12.5, color: '#6B5312', lineHeight: 1.55 }}>
            You are averaging about <strong>{stats.leadsPerMonth} leads a month</strong>. Meta asks for at least
            {' '}{stats.bands.minLeadsPerMonth} before Conversion Leads Optimisation can work well — below that it
            never gathers enough signal to leave the learning phase.
          </span>
        </div>
      )}
    </>
  );
}

// ── The CTWA route ──────────────────────────────────────────────────────────
//
// CLO itself is Instant-Forms-only — Meta restricts the "Conversion Leads"
// performance goal to them. The equivalent outcome for click-to-WhatsApp is a
// CUSTOM CONVERSION sent on business_messaging and selected as the ad set's
// conversion event, which this app already implements on the Conversion API tab.
//
// This panel exists so that route is discoverable from here rather than being
// something you have to already know about, and it shows the one number that
// decides whether it can work at all: how long from ad click to the stage.
function CtwaRoutePanel({ navigate }) {
  const [timing, setTiming] = useState(null);
  useEffect(() => { api.capi.timing().then(setTiming).catch(() => setTiming(false)); }, []);

  const blocked = timing && timing !== false && !timing.movedBeyondEntry;

  return (
    <Card title="Running click-to-WhatsApp ads instead?" style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12.5, color: C.textSecondary, lineHeight: 1.6, marginBottom: 12, fontFamily: FONT }}>
        Everything above applies to Instant Forms. For click-to-WhatsApp, Meta does not offer the Conversion Leads
        goal at all — the equivalent is a <strong>custom conversion</strong> sent on <span style={{ fontFamily: MONO, fontSize: 12 }}>business_messaging</span>,
        which you configure on the <strong>Conversion API</strong> tab. Map your qualifying stage to a custom event
        such as <span style={{ fontFamily: MONO, fontSize: 12 }}>Qualified</span>, then set that event as the ad
        set&apos;s conversion event in Ads Manager.
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
        <Diff label="Attribution window" clo="28 days" ctwa="7 days" />
        <Diff label="Identifier" clo="Meta Lead ID" ctwa="Click ID (ctwa_clid)" />
        <Diff label="Performance goal" clo="Conversion Leads" ctwa="Custom conversion" />
        <Diff label="Personal data sent" clo="Hashed, optional" ctwa="None needed" />
      </div>

      {/* The decisive number, surfaced here rather than only on the other tab. */}
      {timing && timing !== false && (
        <div style={{
          display: 'flex', gap: 9, padding: '11px 13px', borderRadius: 10, fontFamily: FONT,
          background: blocked ? '#FFF8E6' : C.surfaceAlt,
          border: `1px solid ${blocked ? '#F0DCA8' : C.border}`,
        }}>
          {blocked
            ? <AlertTriangle size={15} color="#B7791F" style={{ flexShrink: 0, marginTop: 1 }} />
            : <Info size={15} color={C.textMuted} style={{ flexShrink: 0, marginTop: 1 }} />}
          <span style={{ fontSize: 12.5, color: blocked ? '#6B5312' : C.textSecondary, lineHeight: 1.55 }}>
            {timing.diagnosis || `Measured against Meta's ${timing.windowDays}-day window on the Conversion API tab.`}
          </span>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <Button icon={Radio} onClick={() => navigate && navigate('conversion-api')}>Open Conversion API</Button>
      </div>
    </Card>
  );
}

function Diff({ label, clo, ctwa }) {
  return (
    <div style={{ minWidth: 150 }}>
      <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 12, color: C.textSecondary, fontFamily: FONT }}>
        <span style={{ color: C.textMuted }}>Forms:</span> {clo}
      </div>
      <div style={{ fontSize: 12, color: C.text, fontFamily: FONT, fontWeight: 600 }}>
        <span style={{ color: C.textMuted, fontWeight: 400 }}>CTWA:</span> {ctwa}
      </div>
    </div>
  );
}

function StageRow({
  stage, stat, bands, windowDays, statusOptions, busy, dragging,
  onDragStart, onDragEnd, onDrop, onSave, onDelete,
}) {
  const [draft, setDraft] = useState({
    displayName: stage.displayName, eventName: stage.eventName,
    stageKey: stage.stageKey, crmStatusValues: stage.crmStatusValues,
  });
  useEffect(() => {
    setDraft({
      displayName: stage.displayName, eventName: stage.eventName,
      stageKey: stage.stageKey, crmStatusValues: stage.crmStatusValues,
    });
  }, [stage]);

  const dirty = draft.displayName !== stage.displayName
    || draft.eventName !== stage.eventName
    || JSON.stringify([...draft.crmStatusValues].sort()) !== JSON.stringify([...stage.crmStatusValues].sort());

  const warnings = stageWarnings(stat, bands, windowDays);

  function toggleStatus(v) {
    setDraft(d => ({
      ...d,
      crmStatusValues: d.crmStatusValues.includes(v)
        ? d.crmStatusValues.filter(x => x !== v)
        : [...d.crmStatusValues, v],
    }));
  }

  return (
    <div
      draggable onDragStart={onDragStart} onDragEnd={onDragEnd}
      onDragOver={e => e.preventDefault()} onDrop={onDrop}
      style={{
        border: `1px solid ${stage.isOptimisationTarget ? C.primary : C.border}`, borderRadius: 12,
        background: C.cardBg, opacity: dragging ? 0.5 : 1,
        boxShadow: stage.isOptimisationTarget ? `0 0 0 1px ${C.primary}22` : 'none',
      }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '13px 14px' }}>
        <GripVertical size={16} color={C.textMuted} style={{ marginTop: 8, cursor: 'grab', flexShrink: 0 }} />

        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 9 }}>
            <div style={{ flex: '1 1 190px' }}>
              <label style={lbl}>Display name</label>
              <input style={inputStyle} value={draft.displayName}
                onChange={e => setDraft(d => ({ ...d, displayName: e.target.value }))} />
            </div>
            <div style={{ flex: '1 1 190px' }}>
              <label style={lbl}>Meta event name</label>
              <input style={{ ...inputStyle, fontFamily: MONO }} value={draft.eventName}
                onChange={e => setDraft(d => ({ ...d, eventName: e.target.value }))} />
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>
                Must match the stage name in your Meta funnel exactly.
              </div>
            </div>
          </div>

          <label style={lbl}>Lead statuses that mean this stage was reached</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5, marginBottom: 4 }}>
            {statusOptions.length === 0 && (
              <span style={{ fontSize: 12, color: C.textMuted }}>No lead statuses configured.</span>
            )}
            {statusOptions.map(o => {
              const on = draft.crmStatusValues.includes(o.value);
              return (
                <button key={o.value} onClick={() => toggleStatus(o.value)}
                  style={{
                    padding: '5px 11px', borderRadius: 99, cursor: 'pointer', fontFamily: FONT,
                    fontSize: 12, fontWeight: on ? 700 : 500,
                    border: `1.5px solid ${on ? C.primary : C.border}`,
                    background: on ? C.primaryLight : C.cardBg, color: on ? C.primary : C.textSecondary,
                  }}>
                  {o.label}
                </button>
              );
            })}
          </div>
          {draft.crmStatusValues.length === 0 && (
            <div style={{ fontSize: 11.5, color: '#854F0B', marginTop: 4 }}>
              Nothing mapped — this stage can never fire.
            </div>
          )}
        </div>

        {/* live stats */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 130, flexShrink: 0 }}>
          <Stat label="Reached by" value={stat?.conversionRate == null ? '—' : `${stat.conversionRate.toFixed(1)}%`} />
          <Stat label="Median days" value={stat?.medianDaysToReach == null ? '—' : stat.medianDaysToReach.toFixed(1)} />
          <Stat label="30-day volume" value={stat?.volume30d ?? '—'} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end', flexShrink: 0 }}>
          <label title="Meta learns from this stage"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, fontFamily: FONT, color: stage.isOptimisationTarget ? C.primary : C.textSecondary, fontWeight: stage.isOptimisationTarget ? 700 : 500 }}>
            <input type="radio" name="clo-target" checked={!!stage.isOptimisationTarget}
              onChange={() => onSave({ isOptimisationTarget: true })} disabled={busy} />
            <Target size={13} /> Target
          </label>
          <button onClick={onDelete} title="Delete stage"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted, padding: 4 }}>
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {warnings.length > 0 && (
        <div style={{ borderTop: `1px solid ${C.border}`, padding: '9px 14px', display: 'flex', flexDirection: 'column', gap: 5 }}>
          {warnings.map((w, i) => (
            <div key={i} style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 12, fontFamily: FONT, color: w.good ? '#215D4C' : '#6B5312' }}>
              {w.good ? <CheckCircle2 size={13} color="#0F6E56" style={{ flexShrink: 0, marginTop: 1 }} />
                      : <AlertTriangle size={13} color="#B7791F" style={{ flexShrink: 0, marginTop: 1 }} />}
              <span style={{ lineHeight: 1.5 }}>{w.text}</span>
            </div>
          ))}
        </div>
      )}

      {dirty && (
        <div style={{ borderTop: `1px solid ${C.border}`, padding: '9px 14px', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={() => setDraft({
            displayName: stage.displayName, eventName: stage.eventName,
            stageKey: stage.stageKey, crmStatusValues: stage.crmStatusValues,
          })}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => onSave(draft)}>Save changes</Button>
        </div>
      )}
    </div>
  );
}

// Meta's own guidance conflicts slightly: the stage must convert between 1% and
// 40%, but is "ideally" reached by a third to a half of leads. Those overlap
// only between 33% and 40%, so that intersection is what gets the positive
// highlight, and anything above 40% still warns.
function stageWarnings(stat, bands, windowDays) {
  if (!stat || !bands || stat.conversionRate == null) return [];
  const out = [];
  const r = stat.conversionRate;

  if (stat.unmapped) return out;
  if (r < bands.minRate) {
    out.push({ text: `Only ${r.toFixed(1)}% of leads reach this stage. Too rare — Meta cannot learn from it.` });
  } else if (r > bands.maxRate) {
    out.push({ text: `${r.toFixed(1)}% of leads reach this stage. Too common — it carries little signal about quality.` });
  } else if (r >= bands.sweetLow && r <= bands.maxRate) {
    out.push({ good: true, text: `${r.toFixed(1)}% of leads reach this stage — right in the range Meta optimises best against.` });
  }

  if (stat.medianDaysToReach != null && stat.medianDaysToReach > windowDays) {
    out.push({ text: `Typically reached after ${stat.medianDaysToReach.toFixed(0)} days, past Meta's ${windowDays}-day window. Most events would be dropped.` });
  }
  return out;
}

const lbl = {
  display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: '.04em',
  textTransform: 'uppercase', color: C.textSecondary, marginBottom: 4,
};

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.textMuted }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, fontFamily: MONO, color: C.text }}>{value}</div>
    </div>
  );
}
