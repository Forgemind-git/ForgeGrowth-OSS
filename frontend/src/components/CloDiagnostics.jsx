// CLO readiness checklist + event log.
//
// These two views answer different questions and are kept apart on purpose:
// readiness is "can this work at all", the event log is "what actually
// happened, and why is volume lower than I expected".
import { useState, useEffect, useCallback } from 'react';
import {
  CheckCircle2, AlertTriangle, XCircle, RefreshCw, Search, RotateCw, Send, ClipboardList,
} from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO } from '../constants.js';
import { showError, showSuccess } from '../lib/feedback.js';
import { useConfirm } from './ConfirmDialog.jsx';
import { Table, Td, Badge, EmptyState, Button, inputStyle, fmtDate } from '../pages/academy/shared.jsx';
import { Card, Shimmer } from './charts.jsx';
import SearchableSelect from './SearchableSelect.jsx';

const num = (n) => Number(n || 0).toLocaleString('en-IN');

const CHECK_STYLE = {
  pass: { Icon: CheckCircle2, color: '#0F6E56', bg: '#E1F5EE', label: 'Pass' },
  warn: { Icon: AlertTriangle, color: '#854F0B', bg: '#FAEEDA', label: 'Warn' },
  fail: { Icon: XCircle, color: '#dc2626', bg: '#FCEBEB', label: 'Fail' },
};

// ── Readiness ───────────────────────────────────────────────────────────────
export function ReadinessView() {
  const [data, setData] = useState(null);
  const load = useCallback(async () => {
    setData(null);
    try { setData(await api.clo.readiness()); }
    catch (e) { showError(e.message); setData(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (data === false) return null;

  return (
    <Card
      title="Can Meta actually optimise on this?"
      right={<Button icon={RefreshCw} onClick={load}>Re-check</Button>}
    >
      {!data ? <Shimmer height={280} radius={10} /> : (
        <>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 14, padding: '13px 15px', marginBottom: 16,
            borderRadius: 11, fontFamily: FONT,
            background: data.ready ? '#F5FBF8' : data.failed > 2 ? '#FCEBEB' : '#FFF8E6',
            border: `1px solid ${data.ready ? '#CDE9DE' : data.failed > 2 ? '#F3C6C6' : '#F0DCA8'}`,
          }}>
            <div style={{ fontSize: 22, fontWeight: 700, fontFamily: MONO, color: C.text }}>
              {data.passed}/{data.total}
            </div>
            <div style={{ minWidth: 0, flex: 1, fontSize: 12.5, lineHeight: 1.55, color: C.textSecondary }}>
              {data.ready
                ? 'Every criterion Meta publishes is met. Switch dry run off when you are ready to send for real.'
                : `${data.failed} criteria not met${data.warned ? `, ${data.warned} worth watching` : ''}. `
                  + 'Each one below shows the actual number and what to do about it. Nothing here blocks you from '
                  + 'switching the feature on — but Meta will not optimise well until they are met.'}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {data.checks.map(c => {
              const st = CHECK_STYLE[c.status] || CHECK_STYLE.warn;
              return (
                <div key={c.key} style={{
                  display: 'flex', gap: 11, padding: '12px 14px', borderRadius: 11,
                  border: `1px solid ${C.border}`, background: C.cardBg,
                }}>
                  <st.Icon size={17} color={st.color} style={{ flexShrink: 0, marginTop: 1 }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13.5, fontWeight: 600, color: C.text }}>{c.label}</span>
                      <Badge label={c.value} color={st.color} bg={st.bg} />
                    </div>
                    {c.remedy && (
                      <div style={{ fontSize: 12.5, color: C.textSecondary, lineHeight: 1.55, marginTop: 4 }}>
                        {c.remedy}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ fontSize: 11.5, color: C.textMuted, fontFamily: FONT, marginTop: 14 }}>
            Rates and volumes are measured over the last {data.cohortDays} days.
          </div>
        </>
      )}
    </Card>
  );
}

// ── Event log ───────────────────────────────────────────────────────────────
const STATUS_META = {
  sent: { label: 'Sent', color: '#0F6E56', bg: '#E1F5EE' },
  pending: { label: 'Pending', color: '#2563eb', bg: '#E7F0FE' },
  dry_run: { label: 'Dry run', color: '#854F0B', bg: '#FAEEDA' },
  failed: { label: 'Failed', color: '#dc2626', bg: '#FCEBEB' },
  skipped_duplicate: { label: 'Already sent', color: '#6B7280', bg: '#F1F1EE' },
  skipped_out_of_window: { label: 'Past 28 days', color: '#6B7280', bg: '#F1F1EE' },
  skipped_no_identifier: { label: 'No identifier', color: '#6B7280', bg: '#F1F1EE' },
};

// Plain-English reasons for the summary strip — the whole point of that strip is
// to explain a lower-than-expected volume without needing the docs open.
const SKIP_EXPLAIN = {
  skipped_duplicate: 'already reported for that stage',
  skipped_out_of_window: 'the lead was older than Meta\'s 28-day window',
  skipped_no_identifier: 'no Meta Lead ID and no usable phone or email',
  dry_run: 'built and stored, but dry run is on',
};

export function EventLogView({ stages = [] }) {
  const [filters, setFilters] = useState({ status: '', stageId: '', days: '30', search: '', page: 1 });
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  const load = useCallback(async () => {
    setData(null);
    try { setData(await api.clo.events({ ...filters, limit: 50 })); }
    catch (e) { showError(e.message); setData({ events: [], total: 0, summary: {} }); }
  }, [filters]);
  useEffect(() => { load(); }, [load]);

  async function retryOne(ev) {
    try { await api.clo.retryEvent(ev.id); showSuccess('Queued for the next dispatch.'); load(); }
    catch (e) { showError(e.message); }
  }

  async function retryAll() {
    const n = data?.summary?.failed || 0;
    const ok = await confirm({
      title: `Retry ${n} failed event${n === 1 ? '' : 's'}?`,
      body: 'They go back into the queue and are attempted on the next dispatch. Events that failed because Meta '
          + 'rejected them will most likely fail again unless the underlying problem is fixed.',
      confirmLabel: 'Retry them',
    });
    if (!ok) return;
    setBusy(true);
    try { const r = await api.clo.retryBulk({ ...filters, status: 'failed' }); showSuccess(`${r.requeued} queued.`); load(); }
    catch (e) { showError(e.message); }
    finally { setBusy(false); }
  }

  async function sendNow() {
    setBusy(true);
    try {
      const r = await api.clo.flush();
      if (r.reason === 'disabled') showError('Switch the feature on first.');
      else if (r.reason === 'dry_run') showError('Dry run is on, so nothing is transmitted. Turn it off on the Setup tab.');
      else if (r.reason === 'no_dataset' || r.reason === 'no_token') showError('Add a dataset ID and access token on the Setup tab.');
      else showSuccess(`${r.sent || 0} sent, ${r.failed || 0} failed.`);
      load();
    } catch (e) { showError(e.message); }
    finally { setBusy(false); }
  }

  const summary = data?.summary || {};
  const skipKeys = Object.keys(SKIP_EXPLAIN).filter(k => summary[k]);

  return (
    <>
      <Card
        title="Every attempt, and what became of it"
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button icon={Send} onClick={sendNow} disabled={busy}>Send now</Button>
            {summary.failed > 0 && (
              <Button icon={RotateCw} onClick={retryAll} disabled={busy}>Retry {summary.failed} failed</Button>
            )}
          </div>
        }
        style={{ marginBottom: 16 }}
      >
        {/* Summary strip — the panel that explains a low volume. */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          {['sent', 'pending', 'dry_run', 'failed'].map(k => {
            const m = STATUS_META[k];
            return (
              <div key={k} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: '9px 13px', minWidth: 96 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.textMuted }}>{m.label}</div>
                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: MONO, color: summary[k] ? m.color : C.textMuted }}>
                  {num(summary[k])}
                </div>
              </div>
            );
          })}
        </div>

        {skipKeys.length > 0 && (
          <div style={{
            padding: '11px 13px', marginBottom: 14, background: C.surfaceAlt,
            border: `1px solid ${C.border}`, borderRadius: 10, fontFamily: FONT,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 6 }}>
              Why events were not sent (last {data?.summaryDays || 30} days)
            </div>
            {skipKeys.map(k => (
              <div key={k} style={{ fontSize: 12.5, color: C.textSecondary, lineHeight: 1.6 }}>
                <strong style={{ fontFamily: MONO, color: C.text }}>{num(summary[k])}</strong> — {SKIP_EXPLAIN[k]}
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
          <div style={{ position: 'relative' }}>
            <Search size={14} color={C.textMuted} style={{ position: 'absolute', left: 10, top: 10 }} />
            <input placeholder="Lead name, number or Meta Lead ID"
              style={{ ...inputStyle, width: 260, paddingLeft: 30 }}
              onKeyDown={e => e.key === 'Enter' && setFilters(f => ({ ...f, search: e.target.value, page: 1 }))}
              onBlur={e => setFilters(f => (f.search === e.target.value ? f : { ...f, search: e.target.value, page: 1 }))} />
          </div>
          <SearchableSelect value={filters.status} onChange={v => setFilters(f => ({ ...f, status: v, page: 1 }))}
            options={[{ value: '', label: 'All outcomes' }, ...Object.entries(STATUS_META).map(([k, m]) => ({ value: k, label: m.label }))]}
            style={{ width: 170 }} />
          <SearchableSelect value={filters.stageId} onChange={v => setFilters(f => ({ ...f, stageId: v, page: 1 }))}
            options={[{ value: '', label: 'All stages' }, ...stages.map(s => ({ value: String(s.id), label: s.displayName }))]}
            style={{ width: 170 }} />
          <SearchableSelect value={filters.days} onChange={v => setFilters(f => ({ ...f, days: v, page: 1 }))}
            options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '', label: 'All time' }]}
            style={{ width: 130 }} />
        </div>

        {!data ? <Shimmer height={220} radius={10} /> : (
          <>
            <Table
              columns={[{ label: 'When' }, { label: 'Lead' }, { label: 'Stage' }, { label: 'Event' },
                { label: 'Attempts', align: 'right' }, { label: 'Outcome' }, { label: '', align: 'right' }]}
              rows={data.events} keyOf={e => e.id}
              empty={<EmptyState Icon={ClipboardList} title="Nothing recorded yet"
                hint="Once the feature is on and a lead reaches a mapped stage, every attempt appears here." />}
              renderRow={(e) => {
                const m = STATUS_META[e.status] || STATUS_META.pending;
                return (
                  <>
                    <Td color={C.textSecondary}>{fmtDate(e.createdAt)}</Td>
                    <Td>
                      <div style={{ fontWeight: 600 }}>{e.leadName || 'Unnamed'}</div>
                      <div style={{ fontSize: 11.5, fontFamily: MONO, color: C.textMuted }}>
                        {e.metaLeadId ? `lead ${e.metaLeadId}` : (e.contactNumber || '—')}
                      </div>
                    </Td>
                    <Td color={C.textSecondary}>{e.stageName || '—'}</Td>
                    <Td mono>{e.eventName}</Td>
                    <Td mono align="right" color={e.attempts > 1 ? '#854F0B' : C.textSecondary}>{e.attempts}</Td>
                    <Td style={{ whiteSpace: 'normal', maxWidth: 260 }}>
                      <Badge label={m.label} color={m.color} bg={m.bg} />
                      {e.lastError && (
                        <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 3 }}>{e.lastError}</div>
                      )}
                      {e.fbtraceId && (
                        <div style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO, marginTop: 2 }}>{e.fbtraceId}</div>
                      )}
                    </Td>
                    <Td align="right">
                      {e.status === 'failed' && (
                        <button title="Retry this event" onClick={() => retryOne(e)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted, padding: 5 }}>
                          <RotateCw size={15} />
                        </button>
                      )}
                    </Td>
                  </>
                );
              }}
            />
            {data.total > (data.limit || 50) && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, fontFamily: FONT, fontSize: 12.5, color: C.textSecondary }}>
                <span>{num(data.total)} events</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button disabled={filters.page <= 1} onClick={() => setFilters(f => ({ ...f, page: f.page - 1 }))}>Previous</Button>
                  <Button disabled={filters.page * (data.limit || 50) >= data.total} onClick={() => setFilters(f => ({ ...f, page: f.page + 1 }))}>Next</Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
      {confirmEl}
    </>
  );
}
