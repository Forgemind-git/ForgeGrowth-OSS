// Conversion API — send funnel outcomes back to Meta so its optimiser learns
// which click-to-WhatsApp clicks actually turn into students.
//
// The whole loop in one screen: which dataset we POST to, which funnel stage
// maps to which Meta standard event, the master on/off switch, and an
// append-only history of every transmission (including the ones we chose not
// to send, and why).
import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Pencil, Trash2, RefreshCw, Send, Zap, AlertTriangle,
  Database, RotateCw, Search, CheckCircle2, XCircle, MinusCircle, BookOpen, HelpCircle,
  Settings, Fingerprint, History, LineChart,
} from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import { showError, showSuccess } from '../../lib/feedback.js';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import { MetaEventSelect, MetaEventGuide } from '../../components/MetaEventPicker.jsx';
import { NoteChip, NoteBanner, NotesModal } from '../../components/CapiNotes.jsx';
import CapiCustomerInfo from '../../components/CapiCustomerInfo.jsx';
import { ClickIdInspector, LearningPhasePanel, PerformancePanel, TimingPanel } from '../../components/CapiPanels.jsx';
import {
  PageShell, Button, Table, Td, Badge, EmptyState, Modal, Field, inputStyle,
  StageBadge, fmtINR, fmtDate,
} from '../academy/shared.jsx';
import { Card, KpiCard, Shimmer } from '../../components/charts.jsx';

const STATUS_META = {
  sent: { label: 'Sent', color: '#0F6E56', bg: '#E1F5EE', Icon: CheckCircle2 },
  failed: { label: 'Failed', color: '#dc2626', bg: '#FCEBEB', Icon: XCircle },
  skipped: { label: 'Skipped', color: '#6B7280', bg: '#F1F1EE', Icon: MinusCircle },
};

// Why a conversion never left the building, in plain English.
const SKIP_TEXT = {
  no_ctwa_click: 'This lead never clicked a click-to-WhatsApp ad, so there is no click ID to attribute.',
  no_dataset: 'No Meta dataset is linked for the WhatsApp account this click landed on.',
  meta_not_connected: 'Meta Ads is not connected — connect it in Admin Settings → Integrations.',
  test_mode_needs_code: 'Test mode is on but no test event code is set, so nothing was sent.',
  already_sent: 'This lead already had this event sent.',
  stage_not_mapped: 'That stage is not mapped to a Meta event.',
  mapping_inactive: 'The mapping for that stage is switched off.',
};
// One event's catalog entry, by name. Tolerates an older backend that hasn't
// started serving eventCatalog yet — the UI degrades to bare names, not a crash.
function eventMeta(cfg, name) {
  return (cfg?.eventCatalog || []).find(e => e.name === name) || null;
}

function skipText(reason) {
  if (!reason) return null;
  if (SKIP_TEXT[reason]) return SKIP_TEXT[reason];
  const m = /^click_older_than_(\d+)d$/.exec(reason);
  if (m) return `The ad click is older than ${m[1]} days, past your attribution window.`;
  return reason;
}

function Toggle({ on, onChange, disabled }) {
  return (
    <button onClick={() => !disabled && onChange(!on)} disabled={disabled}
      style={{
        width: 42, height: 24, borderRadius: 99, border: 'none', padding: 3, cursor: disabled ? 'not-allowed' : 'pointer',
        background: on ? '#0F6E56' : C.border, transition: 'background .15s', display: 'flex',
        justifyContent: on ? 'flex-end' : 'flex-start', alignItems: 'center', opacity: disabled ? 0.5 : 1, flexShrink: 0,
      }}>
      <span style={{ width: 18, height: 18, borderRadius: 99, background: '#fff', boxShadow: C.shadowSm, transition: 'all .15s' }} />
    </button>
  );
}

// The page is five jobs, not one list: get it working, decide what goes out,
// verify the click IDs, read the log, judge the effect. Each is its own section
// so nothing requires scrolling past three unrelated things to reach it.
const SUB_TABS = [
  { id: 'setup', label: 'Setup', Icon: Settings, blurb: 'Switch it on, pick test or live, link a dataset' },
  { id: 'data', label: 'What gets sent', Icon: Send, blurb: 'Which stage sends which event, and what customer details go with it' },
  { id: 'clicks', label: 'Click IDs', Icon: Fingerprint, blurb: 'Every ad click and whether Meta recognised it' },
  { id: 'activity', label: 'Activity', Icon: History, blurb: 'Every transmission attempt' },
  { id: 'performance', label: 'Performance', Icon: LineChart, blurb: 'Learning phase and before/after' },
];

function SubTabBar({ tabs, active, onChange, status }) {
  const current = tabs.find(t => t.id === active);
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: `1px solid ${C.border}`, paddingBottom: 0 }}>
        {tabs.map(t => {
          const on = t.id === active;
          return (
            <button key={t.id} onClick={() => onChange(t.id)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 14px',
                border: 'none', borderBottom: `2px solid ${on ? C.primary : 'transparent'}`,
                background: 'transparent', cursor: 'pointer', fontFamily: FONT, fontSize: 13.5,
                fontWeight: on ? 700 : 500, color: on ? C.text : C.textSecondary, marginBottom: -1,
              }}
              onMouseEnter={e => { if (!on) e.currentTarget.style.color = C.text; }}
              onMouseLeave={e => { if (!on) e.currentTarget.style.color = C.textSecondary; }}>
              <t.Icon size={15} />{t.label}
              {t.id === 'setup' && status && (
                <span title={status.enabled ? 'Sending' : 'Off'}
                  style={{ width: 7, height: 7, borderRadius: 99, marginLeft: 2,
                    background: status.enabled ? (status.mode === 'live' ? '#0F6E56' : '#E8A317') : C.textMuted }} />
              )}
            </button>
          );
        })}
      </div>
      {current?.blurb && (
        <div style={{ fontSize: 12.5, color: C.textMuted, fontFamily: FONT, marginTop: 9 }}>{current.blurb}</div>
      )}
    </div>
  );
}

export default function ConversionApiPage({ subParts, navigate }) {
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [editMap, setEditMap] = useState(null);
  const [linkDs, setLinkDs] = useState(null);
  const [detail, setDetail] = useState(null);
  const [guide, setGuide] = useState(false);
  const [notes, setNotes] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  // history
  const [filters, setFilters] = useState({ status: '', days: '30', search: '', page: 1 });
  const [history, setHistory] = useState(null);

  const loadConfig = useCallback(async () => {
    try { setCfg(await api.capi.config()); }
    catch (e) { showError(e.message); }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistory(h => (h ? { ...h, loading: true } : null));
    try { setHistory(await api.capi.events({ ...filters, limit: 25 })); }
    catch (e) { showError(e.message); setHistory({ events: [], total: 0 }); }
  }, [filters]);

  useEffect(() => { loadConfig(); }, [loadConfig]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const config = cfg?.config;
  const datasets = cfg?.datasets || [];
  const linked = datasets.filter(d => d.datasetId);
  const ready = !!cfg?.metaConnected && linked.length > 0;

  async function patchConfig(patch) {
    setSaving(true);
    try {
      const d = await api.capi.updateConfig(patch);
      setCfg(c => ({ ...c, config: d.config }));
    } catch (e) { showError(e.message); }
    finally { setSaving(false); }
  }

  async function toggleMaster(next) {
    if (next) {
      const live = config.mode === 'live';
      const ok = await confirm({
        title: live ? 'Start sending live conversions?' : 'Turn on conversion sending?',
        body: live
          ? 'Real conversion events will be sent to Meta from now on. Meta uses them to optimise delivery and spend on your click-to-WhatsApp campaigns. Only stage changes from this moment forward are sent — past ones are not replayed.'
          : 'Events will be sent with your test event code, so they appear in Events Manager → Test Events and do NOT affect ad delivery. Only stage changes from this moment forward are sent.',
        confirmLabel: live ? 'Yes, go live' : 'Turn on',
        danger: live,
      });
      if (!ok) return;
    }
    await patchConfig({ enabled: next });
    loadConfig();
  }

  async function discover() {
    setSaving(true);
    try {
      const d = await api.capi.discoverDatasets();
      const found = d.datasets.filter(x => x.datasetId).length;
      showSuccess(found ? `Found ${found} dataset${found !== 1 ? 's' : ''}.` : 'No datasets exist yet — create one below.');
      loadConfig();
    } catch (e) { showError(e.message); }
    finally { setSaving(false); }
  }

  async function createDataset(d) {
    const ok = await confirm({
      title: 'Create a dataset in Meta?',
      body: `This creates a conversions dataset on “${d.label || d.wabaId}” inside your Meta business account. It is a real, permanent change there.`,
      confirmLabel: 'Create dataset',
    });
    if (!ok) return;
    setSaving(true);
    try { await api.capi.createDataset(d.wabaId); showSuccess('Dataset created.'); loadConfig(); }
    catch (e) { showError(e.message); }
    finally { setSaving(false); }
  }

  async function sendTest() {
    setSaving(true);
    try {
      const r = await api.capi.test('Lead');
      if (r.ok) showSuccess(`Meta accepted the test event (${r.eventsReceived} received). Check Events Manager → Test Events.`);
      else showError(r.error || 'Meta rejected the test event.');
      loadHistory();
    } catch (e) { showError(e.message); }
    finally { setSaving(false); }
  }

  async function backfill() {
    const n = cfg?.stats?.eligible || 0;
    const ok = await confirm({
      title: `Send ${n} eligible conversion${n !== 1 ? 's' : ''}?`,
      body: 'These are leads already sitting in a mapped stage that have an ad click and have never been transmitted. Meta only accepts events up to 7 days old, so anything older is logged as skipped rather than back-dated.',
      confirmLabel: 'Send now',
      danger: config?.mode === 'live',
    });
    if (!ok) return;
    setSaving(true);
    try {
      const r = await api.capi.backfill(200);
      showSuccess(`${r.sent} sent · ${r.failed} failed · ${r.skipped} skipped (of ${r.considered}).`);
      loadConfig(); loadHistory();
    } catch (e) { showError(e.message); }
    finally { setSaving(false); }
  }

  async function delMapping(m) {
    if (!(await confirm({ title: 'Remove mapping?', body: `${m.stageKey} → ${m.eventName} will no longer be sent.`, confirmLabel: 'Remove', danger: true }))) return;
    try { await api.capi.deleteMapping(m.id); loadConfig(); } catch (e) { showError(e.message); }
  }

  const s = cfg?.stats || {};


  // Sub-tab lives in the hash, so a refresh (or a shared link) lands on the same
  // section instead of dumping everyone back at the top of a long page.
  const tab = SUB_TABS.some(t => t.id === subParts?.[0]) ? subParts[0] : 'setup';
  const goTab = (id) => (navigate ? navigate('conversion-api', id === 'setup' ? undefined : id) : undefined);

  return (
    <PageShell
      title="Conversion API"
      subtitle="Tell Meta which ad clicks became real customers. When a lead reaches a mapped stage, its click-to-WhatsApp click ID is sent back to Meta as a standard conversion event."
      actions={
        <>
          <Button icon={HelpCircle} onClick={() => setNotes(true)}>How this works</Button>
          <Button icon={Send} onClick={sendTest} disabled={saving || !ready}>Send test event</Button>
          <Button icon={RefreshCw} onClick={() => { loadConfig(); loadHistory(); }} disabled={saving}>Refresh</Button>
        </>
      }
    >
      <SubTabBar tabs={SUB_TABS} active={tab} onChange={goTab} status={cfg ? { enabled: config?.enabled, mode: config?.mode, ready } : null} />

      {!cfg ? <Shimmer height={140} radius={12} /> : (
        <>
          {tab === 'setup' && (
            <>

          {/* ── master switch ─────────────────────────────────────────────── */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
            background: C.cardBg, border: `1px solid ${config.enabled ? '#B6DFCE' : C.border}`,
            borderRadius: 12, padding: '16px 18px', marginBottom: 14, boxShadow: C.shadowSm,
          }}>
            <div style={{
              width: 42, height: 42, borderRadius: 11, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: config.enabled ? '#E1F5EE' : C.hover,
            }}>
              <Zap size={20} color={config.enabled ? '#0F6E56' : C.textMuted} />
            </div>
            <div style={{ minWidth: 200, flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.text, display: 'flex', alignItems: 'center', gap: 8 }}>
                {config.enabled ? 'Sending conversions to Meta' : 'Conversion sending is off'}
                <Badge
                  label={config.mode === 'live' ? 'LIVE' : 'TEST'}
                  color={config.mode === 'live' ? '#dc2626' : '#854F0B'}
                  bg={config.mode === 'live' ? '#FCEBEB' : '#FAEEDA'}
                />
              </div>
              <div style={{ fontSize: 12.5, color: C.textSecondary, marginTop: 3 }}>
                {config.enabled
                  ? (config.mode === 'live'
                    ? 'Events count toward ad delivery and optimisation.'
                    : 'Events go to Events Manager → Test Events only; ad delivery is unaffected.')
                  : 'Stage changes are recorded but nothing is sent to Meta.'}
              </div>
              <div style={{ marginTop: 6 }}><NoteChip note={cfg.notes?.master_switch} /></div>
            </div>
            {!ready && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#854F0B', fontFamily: FONT }}>
                <AlertTriangle size={15} /> {cfg.metaConnected ? 'Link a dataset first' : 'Connect Meta Ads first'}
              </span>
            )}
            <Toggle on={config.enabled} onChange={toggleMaster} disabled={saving || !ready} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 16 }}>
            <KpiCard label="Sent" value={Number(s.sent || 0).toLocaleString('en-IN')} accent="#0F6E56"
              sub={s.sent_7d ? `${s.sent_7d} in the last 7 days` : undefined} />
            <KpiCard label="Failed" value={Number(s.failed || 0).toLocaleString('en-IN')} accent={s.failed ? '#dc2626' : C.text} />
            <KpiCard label="Skipped" value={Number(s.skipped || 0).toLocaleString('en-IN')}
              info="Recorded but not transmitted — most often because the lead never came from an ad, so there is no click ID." />
            <KpiCard label="Waiting to send" value={Number(s.eligible || 0).toLocaleString('en-IN')}
              info="Leads already in a mapped stage that have an ad click but have never been transmitted."
              sub={s.eligible ? 'use “Send eligible now”' : 'all caught up'} />
            <KpiCard label="Last sent" value={config.lastSentAt ? fmtDate(config.lastSentAt) : '—'} />
          </div>

          {/* ── connection ─────────────────────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 14, marginBottom: 16 }}>
            <Card title="Where events are sent"
              right={<Button icon={RefreshCw} onClick={discover} disabled={saving || !cfg.metaConnected}>Look up</Button>}>
              {!cfg.metaConnected && (
                <div style={{ display: 'flex', gap: 8, padding: '10px 12px', marginBottom: 12, background: '#FAEEDA', border: '1px solid #F0DCA8', borderRadius: 9, fontSize: 12.5, color: '#6B5312', fontFamily: FONT }}>
                  <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>Meta Ads isn&apos;t connected. Connect it in <strong>Admin Settings → Integrations</strong> — the same token is used here.</span>
                </div>
              )}
              <div style={{ fontSize: 12.5, color: C.textSecondary, marginBottom: 8 }}>
                Meta receives conversions into a <strong>dataset</strong> owned by each WhatsApp Business Account.
                A click can only be sent to the dataset of the account it landed on.
              </div>
              <div style={{ marginBottom: 12 }}><NoteChip note={cfg.notes?.dataset} /></div>
              {cfg.unreachableClicks > 0 && (
                <div style={{ display: 'flex', gap: 8, padding: '10px 12px', marginBottom: 12, background: '#FCEBEB', border: '1px solid #F3C6C6', borderRadius: 9, fontSize: 12.5, color: '#8A1F1F', fontFamily: FONT }}>
                  <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    <strong>{cfg.unreachableClicks.toLocaleString('en-IN')} ad clicks</strong> landed on an account with no dataset —
                    conversions for them will be skipped until you create one below.
                  </span>
                </div>
              )}
              {datasets.length === 0 && (cfg.unlinkedAccounts || []).length === 0 ? (
                <EmptyState Icon={Database} title="No WhatsApp accounts found" />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {[...datasets, ...(cfg.unlinkedAccounts || []).map(a => ({ ...a, status: 'missing' }))].map(d => (
                    <div key={d.wabaId} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 12px', border: `1px solid ${C.border}`, borderRadius: 10, background: C.surfaceAlt }}>
                      <Database size={16} color={d.datasetId ? '#0F6E56' : C.textMuted} style={{ flexShrink: 0 }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {d.label || d.wabaId}
                        </div>
                        <div style={{ fontSize: 11.5, fontFamily: MONO, color: !d.datasetId && d.clicks > 0 ? '#dc2626' : C.textMuted }}>
                          {d.datasetId ? `dataset ${d.datasetId}` : 'no dataset yet'}
                          {d.clicks > 0 && ` · ${d.clicks} ad clicks`}
                        </div>
                        {d.lastError && <div style={{ fontSize: 11.5, color: '#dc2626', marginTop: 2 }}>{d.lastError}</div>}
                      </div>
                      {d.datasetId
                        ? <Badge label="LINKED" color="#0F6E56" bg="#E1F5EE" />
                        : <Button onClick={() => createDataset(d)} disabled={saving || !cfg.metaConnected}>Create</Button>}
                      <button title="Enter a dataset ID by hand" onClick={() => setLinkDs(d)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted, padding: 5 }}>
                        <Pencil size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="How events are sent">
              <div style={{ marginBottom: 12 }}><NoteChip note={cfg.notes?.mode} label="Test vs live — what's the difference?" /></div>
              <Field label="Mode" hint="Test mode routes everything through your test event code — visible in Events Manager, invisible to the optimiser.">
                <div style={{ display: 'flex', gap: 8 }}>
                  {[{ v: 'test', l: 'Test' }, { v: 'live', l: 'Live' }].map(o => (
                    <button key={o.v} onClick={() => patchConfig({ mode: o.v })} disabled={saving}
                      style={{
                        flex: 1, padding: '9px 12px', borderRadius: 9, cursor: 'pointer', fontFamily: FONT, fontSize: 13, fontWeight: 600,
                        border: `1.5px solid ${config.mode === o.v ? (o.v === 'live' ? C.primary : '#E8A317') : C.border}`,
                        background: config.mode === o.v ? (o.v === 'live' ? C.primaryLight : '#FAEEDA') : C.cardBg,
                        color: config.mode === o.v ? (o.v === 'live' ? C.primary : '#854F0B') : C.textSecondary,
                      }}>
                      {o.l}
                    </button>
                  ))}
                </div>
              </Field>
              {config.mode === 'test' && (
                <Field label="Test event code" hint="Events Manager → your dataset → Test Events. Without it, test mode sends nothing.">
                  <input style={inputStyle} defaultValue={config.testEventCode} placeholder="TEST12345"
                    onBlur={e => e.target.value !== config.testEventCode && patchConfig({ testEventCode: e.target.value })} />
                </Field>
              )}
              <Field label="Facebook Page ID (optional)"
                hint="The Page behind your WhatsApp number. Sent alongside the WhatsApp account ID, never instead of it.">
                <input style={inputStyle} defaultValue={config.pageId} placeholder="1234567890"
                  onBlur={e => e.target.value !== config.pageId && patchConfig({ pageId: e.target.value })} />
              </Field>
              <Field label="Attribution window (days)" hint="Never credit an ad click older than this for a conversion.">
                <input style={inputStyle} type="number" min={1} max={365} defaultValue={config.maxClickAgeDays}
                  onBlur={e => Number(e.target.value) !== config.maxClickAgeDays && patchConfig({ maxClickAgeDays: e.target.value })} />
              </Field>
              <div style={{ marginBottom: 12 }}><NoteChip note={cfg.notes?.attribution_window} /></div>
              {s.eligible > 0 && (
                <Button variant="primary" icon={Send} onClick={backfill} disabled={saving || !ready} style={{ width: '100%', marginTop: 4 }}>
                  Send {s.eligible} eligible conversion{s.eligible !== 1 ? 's' : ''} now
                </Button>
              )}
            </Card>
          </div>
            </>
          )}

          {tab === 'data' && (
            <>

          {/* ── mappings ───────────────────────────────────────────────────── */}
          <Card
            title="Funnel stage → Meta event"
            right={
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Button icon={BookOpen} onClick={() => setGuide(true)}>What do these mean?</Button>
                <Button variant="primary" icon={Plus} onClick={() => setEditMap({})}>Add mapping</Button>
              </div>
            }
            style={{ marginBottom: 16 }}
          >
            <div style={{ fontSize: 12.5, color: C.textSecondary, marginBottom: 12 }}>
              When a lead lands in one of these stages, the matching event is sent with its click ID. Mappings follow the
              stage&apos;s permanent key, so renaming a stage in Funnel Settings never breaks them.
            </div>
            <Table
              columns={[{ label: 'When a lead reaches' }, { label: 'Send to Meta' }, { label: 'Value' }, { label: 'Active', align: 'center' }, { label: '', align: 'right' }]}
              rows={cfg.mappings}
              keyOf={m => m.id}
              empty={<EmptyState Icon={Zap} title="No stages mapped" hint="Add a mapping so conversions can be sent." />}
              renderRow={(m) => (
                <>
                  <Td><StageBadge stage={m.stageKey} /></Td>
                  <Td style={{ whiteSpace: 'normal', maxWidth: 340 }}>
                    <div style={{ fontWeight: 600 }}>{m.eventName}</div>
                    {/* The row says what the event is for, so the table is readable
                        without opening the edit modal or the guide. */}
                    <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 1 }}>
                      {m.isCustom
                        ? 'Custom Conversion — defined by you in Events Manager'
                        : (eventMeta(cfg, m.eventName)?.meaning || '—')}
                    </div>
                  </Td>
                  <Td color={C.textSecondary}>
                    {m.valueMode === 'sale_total' ? 'Amount actually paid'
                      : m.valueMode === 'fixed' ? `${fmtINR(m.fixedValue)} (fixed)` : 'No value'}
                  </Td>
                  <Td align="center">
                    <div style={{ display: 'inline-flex' }}>
                      <Toggle on={m.active} disabled={saving}
                        onChange={async (v) => { try { await api.capi.updateMapping(m.id, { active: v }); loadConfig(); } catch (e) { showError(e.message); } }} />
                    </div>
                  </Td>
                  <Td align="right">
                    <button onClick={() => setEditMap(m)} style={iconBtn}><Pencil size={15} /></button>
                    <button onClick={() => delMapping(m)} style={iconBtn}><Trash2 size={15} /></button>
                  </Td>
                </>
              )}
            />
          </Card>
          {/* ── who converted, not just which ad ──────────────────────────── */}
          <Card title="Customer information sent with conversions" style={{ marginBottom: 16 }}>
            <CapiCustomerInfo
              config={config}
              catalog={cfg.matchKeyCatalog || []}
              coverage={cfg.customerFieldCoverage || {}}
              nonMatching={cfg.nonMatchingProperties || []}
              note={cfg.notes?.customer_info}
              leadFields={cfg.leadFields || []}
              mappableKeys={cfg.mappableKeys || []}
              saving={saving}
              onPatch={patchConfig}
            />
          </Card>
            </>
          )}

          {tab === 'clicks' && <ClickIdInspector note={cfg.notes?.click_id} />}

          {tab === 'performance' && (
            <>
              <TimingPanel />
              <LearningPhasePanel />
              <PerformancePanel />
            </>
          )}
        </>
      )}

      {tab === 'activity' && (
        <>

      {/* ── history ────────────────────────────────────────────────────────── */}
      <Card
        title="Conversion history"
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative' }}>
              <Search size={14} color={C.textMuted} style={{ position: 'absolute', left: 10, top: 10 }} />
              <input placeholder="Name, number or click ID"
                style={{ ...inputStyle, width: 220, paddingLeft: 30 }}
                onKeyDown={e => e.key === 'Enter' && setFilters(f => ({ ...f, search: e.target.value, page: 1 }))}
                onBlur={e => setFilters(f => (f.search === e.target.value ? f : { ...f, search: e.target.value, page: 1 }))} />
            </div>
            <SearchableSelect value={filters.status} onChange={v => setFilters(f => ({ ...f, status: v, page: 1 }))}
              options={[
                { value: '', label: 'All outcomes' }, { value: 'sent', label: 'Sent' },
                { value: 'failed', label: 'Failed' }, { value: 'skipped', label: 'Skipped' },
              ]} style={{ width: 150 }} />
            <SearchableSelect value={filters.days} onChange={v => setFilters(f => ({ ...f, days: v, page: 1 }))}
              options={[
                { value: '7', label: '7 days' }, { value: '30', label: '30 days' },
                { value: '90', label: '90 days' }, { value: '', label: 'All time' },
              ]} style={{ width: 130 }} />
          </div>
        }
      >
        {!history ? <Shimmer height={200} radius={10} /> : (
          <>
            <Table
              columns={[{ label: 'When' }, { label: 'Lead' }, { label: 'Event' }, { label: 'Value', align: 'right' },
                { label: 'Mode' }, { label: 'Trigger' }, { label: 'Outcome' }, { label: '', align: 'right' }]}
              rows={history.events} keyOf={e => e.id}
              onRowClick={e => setDetail(e)}
              empty={<EmptyState Icon={Send} title="Nothing transmitted yet"
                hint="Once a lead with an ad click reaches a mapped stage, every attempt is logged here." />}
              renderRow={(e) => {
                const sm = STATUS_META[e.status] || STATUS_META.skipped;
                return (
                  <>
                    <Td color={C.textSecondary}>{fmtDate(e.createdAt)}</Td>
                    <Td>
                      <div style={{ fontWeight: 600 }}>{e.leadName || 'Unnamed'}</div>
                      <div style={{ fontSize: 11.5, fontFamily: MONO, color: C.textMuted }}>{e.contactNumber || '—'}</div>
                    </Td>
                    <Td bold>{e.eventName}</Td>
                    <Td mono align="right">{e.value != null ? fmtINR(e.value) : '—'}</Td>
                    <Td>
                      <Badge label={e.mode === 'live' ? 'LIVE' : 'TEST'}
                        color={e.mode === 'live' ? '#dc2626' : '#854F0B'}
                        bg={e.mode === 'live' ? '#FCEBEB' : '#FAEEDA'} />
                    </Td>
                    <Td color={C.textSecondary}>{e.triggeredBy.replace('_', ' ')}</Td>
                    <Td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Badge label={sm.label} color={sm.color} bg={sm.bg} />
                        {e.status !== 'sent' && (
                          <span style={{ fontSize: 11.5, color: C.textMuted, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {e.status === 'skipped' ? skipText(e.skipReason) : e.error}
                          </span>
                        )}
                      </span>
                    </Td>
                    <Td align="right">
                      <button title="Send again" style={iconBtn}
                        onClick={async (ev) => {
                          ev.stopPropagation();
                          try {
                            const r = await api.capi.resend(e.id);
                            r.ok ? showSuccess('Sent to Meta.') : showError(r.error || skipText(r.reason) || 'Not sent.');
                            loadHistory(); loadConfig();
                          } catch (err) { showError(err.message); }
                        }}>
                        <RotateCw size={15} />
                      </button>
                    </Td>
                  </>
                );
              }}
            />
            {history.total > (history.limit || 25) && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, fontFamily: FONT, fontSize: 12.5, color: C.textSecondary }}>
                <span>{history.total.toLocaleString('en-IN')} transmissions</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button disabled={filters.page <= 1} onClick={() => setFilters(f => ({ ...f, page: f.page - 1 }))}>Previous</Button>
                  <Button disabled={filters.page * (history.limit || 25) >= history.total} onClick={() => setFilters(f => ({ ...f, page: f.page + 1 }))}>Next</Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
        </>
      )}

      {editMap && (
        <MappingModal
          mapping={editMap}
          stages={cfg?.stages || []}
          catalog={cfg?.eventCatalog || []}
          groups={cfg?.eventGroups || []}
          valueEvents={cfg?.valueEvents || []}
          onClose={() => setEditMap(null)}
          onSaved={() => { setEditMap(null); loadConfig(); }}
        />
      )}
      {guide && (
        <Modal title="Meta conversion events" onClose={() => setGuide(false)} width={720}
          footer={<Button onClick={() => setGuide(false)}>Close</Button>}>
          <MetaEventGuide catalog={cfg?.eventCatalog || []} groups={cfg?.eventGroups || []} />
        </Modal>
      )}
      {linkDs && (
        <LinkDatasetModal dataset={linkDs} onClose={() => setLinkDs(null)} onSaved={() => { setLinkDs(null); loadConfig(); }} />
      )}
      {detail && <EventDetailModal event={detail} onClose={() => setDetail(null)} />}
      {notes && (
        <NotesModal
          notes={cfg?.notes || {}}
          order={['master_switch', 'mode', 'attribution_window', 'dataset', 'customer_info', 'click_id', 'performance']}
          onClose={() => setNotes(false)}
        />
      )}
      {confirmEl}
    </PageShell>
  );
}

const iconBtn = { background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted, padding: 5, borderRadius: 6 };

// ── add / edit a stage → event mapping ───────────────────────────────────────
// Two views in one modal: the form, and the full event reference behind the
// "What does each event mean?" link. Picking an event in the reference drops you
// back on the form with it selected, so reading and choosing are one motion.
function MappingModal({ mapping, stages, catalog, groups, valueEvents, onClose, onSaved }) {
  const [form, setForm] = useState({
    stageKey: mapping.stageKey || '',
    eventName: mapping.eventName || 'Lead',
    valueMode: mapping.valueMode || 'none',
    fixedValue: mapping.fixedValue ?? '',
    currency: mapping.currency || 'INR',
    active: mapping.active !== false,
    isCustom: mapping.isCustom === true,
  });
  const [busy, setBusy] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const wantsValue = valueEvents.includes(form.eventName);
  const picked = catalog.find(e => e.name === form.eventName);

  async function save() {
    setBusy(true);
    try {
      if (mapping.id) await api.capi.updateMapping(mapping.id, form);
      else await api.capi.createMapping(form);
      showSuccess('Mapping saved.');
      onSaved();
    } catch (e) { showError(e.message); }
    finally { setBusy(false); }
  }

  if (showGuide) {
    return (
      <Modal title="Which event should I send?" onClose={() => setShowGuide(false)} width={720}
        footer={<Button onClick={() => setShowGuide(false)}>Back to mapping</Button>}>
        <MetaEventGuide catalog={catalog} groups={groups} selectedName={form.eventName}
          onPick={(name) => { set('eventName', name); setShowGuide(false); }} />
      </Modal>
    );
  }

  return (
    <Modal title={mapping.id ? 'Edit mapping' : 'Add mapping'} onClose={onClose} width={560}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={busy || !form.stageKey}>Save</Button>
      </>}>
      <Field label="When a lead reaches this stage">
        <SearchableSelect value={form.stageKey} onChange={v => set('stageKey', v)}
          options={stages.map(s => ({ value: s.stageKey, label: s.label, sublabel: s.stageKey }))}
          placeholder="Choose a stage…" searchPlaceholder="Search stages…" />
      </Field>

      {/* Standard event, or a Custom Conversion defined in Events Manager.
          "Qualified" only exists inside our own chat flow, so there is no
          standard event for it — but a non-standard name is otherwise
          indistinguishable from a typo, which Meta drops silently. Ticking this
          is what tells the backend the name is deliberate. */}
      <Field label="Send this Meta event">
        {form.isCustom ? (
          <>
            <input style={{ ...inputStyle, fontFamily: MONO }} value={form.eventName}
              onChange={e => set('eventName', e.target.value)} placeholder="Qualified" autoFocus />
            <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 5 }}>
              Must match the Custom Conversion name in Events Manager exactly. Meta ignores an event it does not
              recognise, and an ignored event looks identical to one that was never sent.
            </div>
          </>
        ) : (
          <MetaEventSelect value={form.eventName} onChange={v => set('eventName', v)} catalog={catalog} groups={groups} />
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, fontSize: 12.5, color: C.textSecondary, fontFamily: FONT, cursor: 'pointer' }}>
          <input type="checkbox" checked={form.isCustom}
            onChange={e => {
              const on = e.target.checked;
              // Swapping mode keeps a sensible default rather than carrying a
              // standard name into custom mode, where it would be rejected.
              setForm(f => ({ ...f, isCustom: on, eventName: on ? (catalog.some(c => c.name === f.eventName) ? 'Qualified' : f.eventName) : 'Lead' }));
            }} />
          This is a Custom Conversion I created in Events Manager
        </label>
      </Field>

      {/* What the chosen event actually does, inline — the question people ask
          at exactly this moment, answered without leaving the form. */}
      {form.isCustom && (
        <div style={{ padding: '11px 13px', marginTop: -4, marginBottom: 13, background: C.surfaceAlt,
          border: `1px solid ${C.border}`, borderRadius: 10, fontFamily: FONT }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 3 }}>
            How Meta treats a custom conversion
          </div>
          <div style={{ fontSize: 12.5, color: C.textSecondary, lineHeight: 1.5 }}>
            Exactly like a standard event — it can be selected as a campaign&apos;s performance goal and optimised
            toward. A conversion is whatever you name it; there is no requirement that it be a purchase.
          </div>
          <div style={{ fontSize: 12.5, color: C.textMuted, lineHeight: 1.5, marginTop: 6, fontStyle: 'italic' }}>
            Sending it changes reporting only. Delivery changes when you set it as the conversion event on the
            ad set in Ads Manager.
          </div>
        </div>
      )}
      {!form.isCustom && picked && (
        <div style={{ padding: '11px 13px', marginTop: -4, marginBottom: 13, background: C.surfaceAlt,
          border: `1px solid ${C.border}`, borderRadius: 10, fontFamily: FONT }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 3 }}>
            How Meta treats {picked.name}
          </div>
          <div style={{ fontSize: 12.5, color: C.textSecondary, lineHeight: 1.5 }}>{picked.metaBehaviour}</div>
          {picked.messaging && (
            <div style={{ fontSize: 12.5, color: C.textMuted, lineHeight: 1.5, marginTop: 6, fontStyle: 'italic' }}>
              {picked.messaging}
            </div>
          )}
          <button onClick={() => setShowGuide(true)}
            style={{ marginTop: 9, background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              color: C.primary, fontFamily: FONT, fontSize: 12.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <BookOpen size={13} /> What does each event mean?
          </button>
        </div>
      )}

      <Field label="Conversion value"
        hint={wantsValue && form.valueMode === 'none' ? `Meta expects a value with ${form.eventName} — without one it can't optimise for revenue.` : undefined}>
        <SearchableSelect value={form.valueMode} onChange={v => set('valueMode', v)}
          options={[
            { value: 'none', label: "Don't send a value", sublabel: 'Counts the conversion only' },
            { value: 'sale_total', label: 'The amount this lead actually paid', sublabel: 'Real revenue — best for Purchase' },
            { value: 'fixed', label: 'A fixed amount', sublabel: 'Same value for every conversion' },
          ]} />
      </Field>
      {form.valueMode === 'fixed' && (
        <Field label="Fixed value (₹)">
          <input style={inputStyle} type="number" min={1} value={form.fixedValue} onChange={e => set('fixedValue', e.target.value)} />
        </Field>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, color: C.text, fontFamily: FONT, marginTop: 4 }}>
        <Toggle on={form.active} onChange={v => set('active', v)} />
        Active
      </label>
    </Modal>
  );
}

// ── paste a dataset id by hand ───────────────────────────────────────────────
function LinkDatasetModal({ dataset, onClose, onSaved }) {
  const [value, setValue] = useState(dataset.datasetId || '');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Dataset for ${dataset.label || dataset.wabaId}`} onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={async () => {
          setBusy(true);
          try { await api.capi.linkDataset(dataset.wabaId, value.trim()); showSuccess('Saved.'); onSaved(); }
          catch (e) { showError(e.message); } finally { setBusy(false); }
        }}>Save</Button>
      </>}>
      <Field label="Dataset ID" hint="Events Manager → Data sources. Leave blank to unlink.">
        <input style={inputStyle} value={value} onChange={e => setValue(e.target.value)} placeholder="1654235072202866" />
      </Field>
      <div style={{ fontSize: 12, color: C.textMuted, fontFamily: FONT }}>
        WhatsApp Business Account <span style={{ fontFamily: MONO }}>{dataset.wabaId}</span>
      </div>
    </Modal>
  );
}

// ── one transmission, in full ────────────────────────────────────────────────
function EventDetailModal({ event, onClose }) {
  const sm = STATUS_META[event.status] || STATUS_META.skipped;
  const pre = { background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 9, padding: 12, fontFamily: MONO, fontSize: 11.5, color: C.text, overflowX: 'auto', margin: 0, maxHeight: 240 };
  return (
    <Modal title="Conversion detail" onClose={onClose} width={620}
      footer={<Button onClick={onClose}>Close</Button>}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <sm.Icon size={20} color={sm.color} />
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{event.eventName} · {sm.label}</div>
          <div style={{ fontSize: 12, color: C.textSecondary, fontFamily: MONO }}>
            {fmtDate(event.createdAt)} · {event.mode.toUpperCase()} · {event.triggeredBy.replace('_', ' ')}
          </div>
        </div>
      </div>

      {event.status === 'skipped' && (
        <div style={{ padding: '10px 12px', background: C.hover, borderRadius: 9, fontSize: 12.5, color: C.textSecondary, marginBottom: 14, fontFamily: FONT }}>
          {skipText(event.skipReason)}
        </div>
      )}
      {event.error && (
        <div style={{ padding: '10px 12px', background: '#FCEBEB', border: '1px solid #F3C6C6', borderRadius: 9, fontSize: 12.5, color: '#8A1F1F', marginBottom: 14, fontFamily: FONT }}>
          {event.error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 16 }}>
        {[
          ['Lead', event.leadName || '—'],
          ['WhatsApp', event.contactNumber || '—'],
          ['Value', event.value != null ? `${fmtINR(event.value)} ${event.currency || ''}` : '—'],
          ['Dataset', event.datasetId || '—'],
          ['Event ID', event.eventId],
          ['Click ID', event.ctwaClid ? `${event.ctwaClid.slice(0, 22)}…` : '—'],
          ['Customer details sent', (event.matchKeys || []).length ? event.matchKeys.join(', ') : 'none'],
          ['Events received', event.eventsReceived ?? '—'],
          ['Meta trace', event.fbtraceId || '—'],
        ].map(([k, v]) => (
          <div key={k}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.textMuted, fontFamily: FONT }}>{k}</div>
            <div style={{ fontSize: 12.5, color: C.text, fontFamily: MONO, wordBreak: 'break-all' }}>{v}</div>
          </div>
        ))}
      </div>

      {event.requestPayload && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 6, fontFamily: FONT }}>Sent to Meta</div>
          <pre style={{ ...pre, marginBottom: 14 }}>{JSON.stringify(event.requestPayload, null, 2)}</pre>
        </>
      )}
      {event.response && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 6, fontFamily: FONT }}>Meta&apos;s reply</div>
          <pre style={pre}>{JSON.stringify(event.response, null, 2)}</pre>
        </>
      )}
    </Modal>
  );
}
