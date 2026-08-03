import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Flame, RefreshCw, X } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import { useServerEvents } from '../../hooks/useServerEvents.js';
import { showError } from '../../lib/feedback.js';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import { useFunnelConfig } from '../../hooks/useFunnelConfig.js';
import {
  PageShell, Button, StageBadge, STAGE_META, STAGE_ORDER,
  Field, inputStyle, Modal, Segmented, daysSince,
} from '../academy/shared.jsx';
import { Shimmer } from '../../components/charts.jsx';

const FUNNEL = ['new', 'contacted', 'engaged', 'hot', 'enrolled'];

export default function PipelinePage({ user, navigate }) {
  const { sources } = useFunnelConfig();
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filterBda, setFilterBda] = useState('');
  const [filterSource, setFilterSource] = useState('');
  const [drag, setDrag] = useState(null);
  const [detail, setDetail] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [confirmEl] = useConfirm();
  const selectedRef = useRef(null);

  const load = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    try { setBoard(await api.leads.board()); }
    catch (e) { showError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  const onEvent = useCallback(({ type }) => { if (type === 'lead-changed') load(true); }, [load]);
  useServerEvents(onEvent);

  const coldAfter = board?.coldAfterFollowUps ?? 3;
  const conv = {};
  (board?.conversions || []).forEach(c => { conv[c.to] = c.pct; });

  const filterLead = (l) =>
    (!filterBda || l.assignedBda === filterBda) &&
    (!filterSource || l.source === filterSource);

  const bdaOptions = (() => {
    const set = new Map();
    Object.values(board?.columns || {}).flat().forEach(l => { if (l.assignedBda) set.set(l.assignedBda, l.assignedUserName || l.assignedBda); });
    return [{ value: '', label: 'All BDAs' }, ...[...set].map(([v, label]) => ({ value: v, label: label || v }))];
  })();

  async function moveLead(lead, stage) {
    if (lead.stage === stage) return;
    // optimistic
    setBoard(b => {
      if (!b) return b;
      const cols = { ...b.columns };
      cols[lead.stage] = (cols[lead.stage] || []).filter(x => x.id !== lead.id);
      cols[stage] = [{ ...lead, stage }, ...(cols[stage] || [])];
      return { ...b, columns: cols };
    });
    try { await api.leads.move(lead.id, stage); load(true); }
    catch (e) { showError(e.message); load(true); }
  }

  return (
    <PageShell
      title="Pipeline"
      subtitle="Every active lead by stage. Drag a card to move it — Cold / Lost branches off any stage."
      actions={
        <>
          <div style={{ width: 150 }}>
            <SearchableSelect value={filterBda} onChange={setFilterBda} options={bdaOptions} placeholder="All BDAs" triggerStyle={{ padding: '8px 30px 8px 11px' }} />
          </div>
          <div style={{ width: 150 }}>
            <SearchableSelect value={filterSource} onChange={setFilterSource}
              options={[{ value: '', label: 'All sources' }, ...sources.map(s => ({ value: s, label: s }))]}
              placeholder="All sources" triggerStyle={{ padding: '8px 30px 8px 11px' }} />
          </div>
          <Button variant="ghost" icon={RefreshCw} onClick={() => load()} />
          <Button variant="primary" icon={Plus} onClick={() => setShowAdd(true)}>New Lead</Button>
        </>
      }
    >
      {loading ? (
        <div style={{ display: 'flex', gap: 12 }}>
          {FUNNEL.map(s => <div key={s} style={{ flex: 1 }}><Shimmer height={340} radius={12} /></div>)}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', overflowX: 'auto', paddingBottom: 8 }}>
          {FUNNEL.map((stage, i) => {
            const items = (board.columns[stage] || []).filter(filterLead);
            const m = STAGE_META[stage];
            return (
              <div key={stage} style={{ flex: '1 0 220px', minWidth: 220 }}>
                <Column
                  stage={stage} meta={m} items={items} convPct={conv[stage]}
                  coldAfter={coldAfter} onDrop={moveLead} drag={drag} setDrag={setDrag}
                  onCard={(l) => { selectedRef.current = l.id; setDetail(l); }}
                />
              </div>
            );
          })}
          {/* Cold / Lost side lane */}
          <div style={{ flex: '0 0 220px', minWidth: 220 }}>
            <Column
              stage="cold_lost" meta={STAGE_META.cold_lost} dashed
              items={(board.columns.cold_lost || []).filter(filterLead)}
              coldAfter={coldAfter} onDrop={moveLead} drag={drag} setDrag={setDrag}
              onCard={(l) => { selectedRef.current = l.id; setDetail(l); }}
            />
          </div>
        </div>
      )}

      {detail && <LeadDrawer lead={detail} onClose={() => setDetail(null)} navigate={navigate} onChanged={() => load(true)} isAdmin={user?.role === 'admin'} />}
      {showAdd && <AddLeadModal onClose={() => setShowAdd(false)} onCreated={() => { setShowAdd(false); load(true); }} />}
      {confirmEl}
    </PageShell>
  );
}

function Column({ stage, meta, items, convPct, coldAfter, onDrop, drag, setDrag, onCard, dashed }) {
  const [over, setOver] = useState(false);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, padding: '0 2px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ width: 9, height: 9, borderRadius: 99, background: meta.color }} />
          <span style={{ fontFamily: FONT, fontSize: 13, fontWeight: 700, color: C.text }}>{meta.label}</span>
          <span style={{ fontFamily: MONO, fontSize: 12, color: C.textMuted }}>{items.length}</span>
        </div>
        {convPct != null && (
          <span title="Conversion from previous stage" style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color: meta.color, background: meta.bg, padding: '2px 7px', borderRadius: 99 }}>
            {convPct}%
          </span>
        )}
      </div>
      <div
        onDragOver={e => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={() => { setOver(false); if (drag) onDrop(drag, stage); setDrag(null); }}
        style={{
          background: over ? meta.bg : C.surfaceAlt,
          border: dashed ? `1.5px dashed ${C.borderDark}` : `1px solid ${C.border}`,
          borderRadius: 12, padding: 8, minHeight: 320, display: 'flex', flexDirection: 'column', gap: 8,
          boxShadow: over ? `inset 0 0 0 2px ${meta.color}` : 'none', transition: 'background .12s',
        }}
      >
        {items.length === 0 && <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 12, fontFamily: FONT, padding: '24px 0' }}>No leads</div>}
        {items.map(l => (
          <LeadCard key={l.id} lead={l} coldAfter={coldAfter}
            onDragStart={() => setDrag(l)} onDragEnd={() => setDrag(null)} onClick={() => onCard(l)} />
        ))}
      </div>
    </div>
  );
}

function LeadCard({ lead, coldAfter, onDragStart, onDragEnd, onClick }) {
  const days = daysSince(lead.stageChangedAt);
  const flagged = lead.followUpCount >= coldAfter;
  return (
    <div draggable onDragStart={onDragStart} onDragEnd={onDragEnd} onClick={onClick}
      style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 11, cursor: 'grab', boxShadow: C.shadowSm }}>
      <div style={{ fontFamily: FONT, fontSize: 13.5, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {lead.name || lead.whatsappNumber}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7, flexWrap: 'wrap' }}>
        {lead.source && <span style={{ fontSize: 10.5, fontWeight: 600, color: C.textSecondary, background: C.hover, padding: '2px 7px', borderRadius: 99 }}>{lead.source}</span>}
        {days != null && <span style={{ fontSize: 10.5, color: C.textMuted, fontFamily: MONO }}>{days}d in stage</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: C.textSecondary }}>
          <Avatar name={lead.assignedUserName || lead.assignedBda} />
          {lead.assignedUserName || lead.assignedBda || 'Unassigned'}
        </span>
        <span title={`${lead.followUpCount} consecutive follow-ups`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontFamily: MONO, fontWeight: 600, color: flagged ? C.primary : C.textMuted }}>
          <Flame size={12} />{lead.followUpCount}
        </span>
      </div>
    </div>
  );
}

function Avatar({ name }) {
  const initials = (name || '?').split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
  return (
    <span style={{ width: 18, height: 18, borderRadius: 99, background: 'linear-gradient(135deg,#534AB7,#7B72E0)', color: '#fff', fontSize: 9, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
      {initials}
    </span>
  );
}

function LeadDrawer({ lead, onClose, navigate, onChanged, isAdmin }) {
  const [timeline, setTimeline] = useState(null);
  useEffect(() => { api.leads.timeline(lead.id).then(setTimeline).catch(() => setTimeline({ events: [], activity: [] })); }, [lead.id]);
  const row = (k, v) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
      <span style={{ color: C.textMuted }}>{k}</span>
      <span style={{ color: C.text, fontWeight: 500, textAlign: 'right' }}>{v || '—'}</span>
    </div>
  );
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 200, display: 'flex', justifyContent: 'flex-end', fontFamily: FONT }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 420, maxWidth: '100%', background: C.cardBg, height: '100%', overflowY: 'auto', boxShadow: C.shadowLg }}>
        <div style={{ padding: '18px 22px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>{lead.name || lead.whatsappNumber}</div>
            <div style={{ marginTop: 5 }}><StageBadge stage={lead.stage} /></div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted }}><X size={20} /></button>
        </div>
        <div style={{ padding: 22 }}>
          {row('WhatsApp', lead.whatsappNumber)}
          {row('Source', lead.source)}
          {row('City', lead.city)}
          {row('Role', lead.role)}
          {row('Goal', lead.goal)}
          {row('Assigned BDA', lead.assignedUserName || lead.assignedBda)}
          {row('Follow-ups', lead.followUpCount)}
          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={() => navigate && navigate('leads')}>Open in Leads</Button>
            {lead.hasWhatsappThread && <Button variant="secondary" onClick={() => navigate && navigate('chats')}>Open chat</Button>}
          </div>
          <div style={{ marginTop: 22, fontSize: 12, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 8 }}>Activity timeline</div>
          {!timeline ? <Shimmer height={80} /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[...(timeline.events || [])].slice(0, 20).map((e, i) => (
                <div key={i} style={{ display: 'flex', gap: 9, fontSize: 12.5 }}>
                  <span style={{ width: 7, height: 7, borderRadius: 99, background: C.primary, marginTop: 5, flexShrink: 0 }} />
                  <div>
                    <span style={{ color: C.text }}>{labelEvent(e)}</span>
                    <span style={{ color: C.textMuted, marginLeft: 6, fontFamily: MONO, fontSize: 11 }}>{new Date(e.ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
                  </div>
                </div>
              ))}
              {(!timeline.events || !timeline.events.length) && <div style={{ color: C.textMuted, fontSize: 12.5 }}>No events yet.</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function labelEvent(e) {
  if (e.eventType === 'stage_changed') return `Stage → ${STAGE_META[e.toValue]?.label || e.toValue}`;
  if (e.eventType === 'message_sent') return 'Message sent';
  if (e.eventType === 'resource_opened') return 'Resource opened';
  if (e.eventType === 'trigger_fired') return 'Trigger fired';
  return e.eventType;
}

function AddLeadModal({ onClose, onCreated }) {
  const { sources } = useFunnelConfig();
  const [form, setForm] = useState({ name: '', whatsappNumber: '', email: '', city: '', source: '', goal: '', stage: 'new' });
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target?.value ?? e }));
  async function save() {
    if (!form.whatsappNumber.trim()) return showError('WhatsApp number is required');
    setSaving(true);
    try { await api.leads.create(form); onCreated(); }
    catch (e) { showError(e.message); setSaving(false); }
  }
  return (
    <Modal title="New Lead" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Create lead'}</Button></>}>
      <Field label="Name"><input style={inputStyle} value={form.name} onChange={set('name')} autoFocus /></Field>
      <Field label="WhatsApp number *"><input style={inputStyle} value={form.whatsappNumber} onChange={set('whatsappNumber')} placeholder="9198…" /></Field>
      <Field label="Email"><input style={inputStyle} value={form.email} onChange={set('email')} /></Field>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="City"><input style={inputStyle} value={form.city} onChange={set('city')} /></Field></div>
        <div style={{ flex: 1 }}><Field label="Source">
          <SearchableSelect value={form.source} onChange={v => setForm(f => ({ ...f, source: v }))} options={sources.map(s => ({ value: s, label: s }))} placeholder="Source" />
        </Field></div>
      </div>
      <Field label="Goal"><input style={inputStyle} value={form.goal} onChange={set('goal')} /></Field>
      <Field label="Stage">
        <SearchableSelect value={form.stage} onChange={v => setForm(f => ({ ...f, stage: v }))} options={STAGE_ORDER.map(s => ({ value: s, label: STAGE_META[s].label }))} />
      </Field>
    </Modal>
  );
}
