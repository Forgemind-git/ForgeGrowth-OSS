// Sales → Follow-up (replaced "My leads today").
//
// A salesperson's own working set: the chats they pinned (or set a follow-up
// on), and a month calendar of every follow-up.
//
//   #/follow-ups                    Chats view — list · live chat · lead details
//   #/follow-ups/<wa>/<contact>     …with that chat open
//   #/follow-ups/calendar           Calendar view (month grid + day agenda)
//
// The chat pane is the REAL ChatWindow and the details pane the real
// ChatProfilePanel — not copies — so replying, tagging, editing the lead and
// setting a follow-up behave exactly as they do in Chats and Leads.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Search, Pin, PinOff, CalendarDays, MessageSquare, ChevronLeft, ChevronRight, Loader2,
  CalendarClock, Check, RefreshCw, PanelRightClose, PanelRightOpen, ExternalLink, AlertTriangle,
} from 'lucide-react';
import { C, FONT, T, W, LH, relativeTime } from '../../constants.js';
import { api } from '../../api.js';
import { showError, showSuccess } from '../../lib/feedback.js';
import { StageBadge } from '../academy/shared.jsx';
import ChatWindow from '../../components/ChatWindow.jsx';
import { useIsPhone } from '../../lib/useIsPhone.js';
import ChatProfilePanel from '../../components/ChatProfilePanel.jsx';
import FollowUpModal from '../../components/FollowUpModal.jsx';
import {
  todayIST, addDays, monthGrid, MONTH_NAMES, shortDate, relativeDay, time12,
} from '../../lib/followUpDates.js';

const LS_DETAILS = 'forgegrowth.mylist.details';
const LS_SCOPE = 'forgegrowth.mylist.scope';

function lsGet(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

/** overdue | today | upcoming | done — drives every follow-up colour. */
function fuState(f, today) {
  if (f.status && f.status !== 'open') return 'done';
  if (f.dueDate < today) return 'overdue';
  if (f.dueDate === today) return 'today';
  return 'upcoming';
}
const FU_TONE = {
  overdue: { bg: 'var(--c-dangerBg, #FCEBEB)', fg: 'var(--c-dangerText, #A32D2D)', bd: 'var(--c-dangerBorder, #F8C8C8)' },
  today: { bg: 'var(--c-warnBg, #FDF3DC)', fg: 'var(--c-warnText, #854F0B)', bd: 'var(--c-warnBorder, #F2D48A)' },
  upcoming: { bg: 'var(--c-primaryLight, #FCEBEB)', fg: 'var(--c-text, #111)', bd: 'var(--c-border, #E5E5E0)' },
  done: { bg: 'var(--c-surfaceMuted, #F1F1EE)', fg: 'var(--c-textMuted, #667180)', bd: 'var(--c-border, #E5E5E0)' },
};

export default function MyListPage({ user, navigate, subParts = [] }) {
  const view = subParts[0] === 'calendar' ? 'calendar' : 'chats';
  const selWa = view === 'chats' ? subParts[0] || null : null;
  const selContact = view === 'chats' ? subParts[1] || null : null;
  const isAdmin = user?.role === 'admin';

  const [items, setItems] = useState(null);
  const loadList = useCallback(() => {
    api.myList.list().then(r => setItems(r.items || [])).catch(e => { setItems([]); showError(e.message); });
  }, []);
  useEffect(() => { loadList(); }, [loadList]);

  const openChat = (wa, contact) => navigate('follow-ups', wa, contact);
  const setView = (v) => (v === 'calendar' ? navigate('follow-ups', 'calendar') : navigate('follow-ups'));

  // Nothing selected yet: open the first lead on the list, so the page is never
  // an empty middle pane. Not on a phone, where the list IS the page.
  const phone = useIsPhone();
  useEffect(() => {
    if (!phone && view === 'chats' && !selContact && items?.length) {
      navigate('follow-ups', items[0].waNumber, items[0].contactNumber);
    }
  }, [phone, view, selContact, items, navigate]);

  const counts = useMemo(() => {
    const t = todayIST();
    const c = { overdue: 0, today: 0 };
    (items || []).forEach(i => { if (i.nextFollowUp) { const s = fuState(i.nextFollowUp, t); if (s in c) c[s] += 1; } });
    return c;
  }, [items]);

  return (
    <div style={{ flex: 1, minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column', padding: phone ? '12px 12px 10px' : '20px 24px 16px', boxSizing: 'border-box', fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: W.heavy, color: C.text, lineHeight: LH.tight }}>Follow-up</div>
          <div style={{ fontSize: T.body, color: C.textSecondary, marginTop: 2 }}>
            {items == null ? 'Loading…' : (
              <>{items.length} lead{items.length === 1 ? '' : 's'} pinned
                {counts.overdue > 0 && <> · <b style={{ color: FU_TONE.overdue.fg }}>{counts.overdue} overdue</b></>}
                {counts.today > 0 && <> · <b style={{ color: FU_TONE.today.fg }}>{counts.today} due today</b></>}
              </>
            )}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <Segmented
          value={view}
          onChange={setView}
          options={[{ value: 'chats', label: 'Chats', Icon: MessageSquare }, { value: 'calendar', label: 'Calendar', Icon: CalendarDays }]}
        />
      </div>

      {view === 'calendar'
        ? <CalendarView user={user} isAdmin={isAdmin} onOpenChat={openChat} onChanged={loadList} />
        : <ChatsView user={user} items={items} selWa={selWa} selContact={selContact} onOpenChat={openChat} onChanged={loadList} onBack={() => navigate('follow-ups')} />}
    </div>
  );
}

// ── Chats view ────────────────────────────────────────────────────────────────

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'none', label: 'No date' },
];

function ChatsView({ user, items, selWa, selContact, onOpenChat, onChanged, onBack }) {
  // Phones: the list, or the chat with a way back — never both, no details pane.
  const phone = useIsPhone();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [details, setDetails] = useState(() => lsGet(LS_DETAILS, '1') === '1');
  const today = todayIST();

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const d = s.replace(/\D/g, '');
    return (items || []).filter(i => {
      if (s && !(i.name || '').toLowerCase().includes(s) && !(d && i.contactNumber.includes(d))) return false;
      if (filter === 'all') return true;
      if (filter === 'none') return !i.nextFollowUp;
      return i.nextFollowUp && fuState(i.nextFollowUp, today) === filter;
    });
  }, [items, q, filter, today]);

  const unpin = async (i, e) => {
    e.stopPropagation();
    try { await api.myList.unpin(i.contactNumber); onChanged(); }
    catch (err) { showError(err.message); }
  };
  const selected = (items || []).find(i => i.contactNumber === selContact);

  return (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', borderRadius: 14, overflow: 'hidden',
      border: `1px solid ${C.border}`, background: 'var(--c-cardBg)',
    }}>
      {/* Lead list */}
      <aside style={{ width: phone ? 'auto' : 330, flex: phone ? 1 : undefined, minWidth: 0, flexShrink: 0,
        ...(phone && selWa && selContact ? { display: 'none' } : {}), display: 'flex', flexDirection: 'column', borderRight: `1px solid ${C.border}`, minHeight: 0 }}>
        <div style={{ padding: 12, borderBottom: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ position: 'relative' }}>
            <Search size={15} color={C.textMuted} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)' }} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name or number"
              style={{ width: '100%', boxSizing: 'border-box', padding: '9px 10px 9px 32px', borderRadius: 10, border: `1.5px solid ${C.border}`, background: 'var(--c-surfaceInner)', color: C.text, fontSize: T.body, fontFamily: FONT, outline: 'none' }} />
          </div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {FILTERS.map(f => (
              <button key={f.key} onClick={() => setFilter(f.key)} style={{
                padding: '5px 10px', borderRadius: 999, fontSize: T.label, fontWeight: W.bold, cursor: 'pointer', fontFamily: FONT,
                border: `1.5px solid ${filter === f.key ? C.primary : C.border}`,
                background: filter === f.key ? C.primaryLight : 'transparent', color: filter === f.key ? C.primary : C.textSecondary,
              }}>{f.label}</button>
            ))}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }} data-testid="mylist-items">
          {items == null ? (
            <div style={{ padding: 30, display: 'flex', justifyContent: 'center' }}><Loader2 size={20} color={C.textMuted} style={{ animation: 'spin 1s linear infinite' }} /></div>
          ) : !items.length ? (
            <EmptyList />
          ) : !shown.length ? (
            <div style={{ padding: 24, fontSize: T.body, color: C.textSecondary, textAlign: 'center' }}>Nothing matches this filter.</div>
          ) : shown.map(i => (
            <LeadRow key={i.contactKey} i={i} today={today} active={i.contactNumber === selContact}
              onClick={() => onOpenChat(i.waNumber, i.contactNumber)} onUnpin={(e) => unpin(i, e)} />
          ))}
        </div>
      </aside>

      {/* Live chat */}
      <section style={{ flex: 1, minWidth: 0, display: phone && !(selWa && selContact) ? 'none' : 'flex', flexDirection: 'column', position: 'relative' }}>
        {selWa && selContact ? (
          <ChatWindow
            key={`${selWa}-${selContact}`}
            waNumber={selWa}
            contactNumber={selContact}
            user={user}
            onListChange={onChanged}
            onBack={phone ? onBack : undefined}
          />
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.textSecondary, fontSize: T.bodyLg, padding: 30, textAlign: 'center' }}>
            {items?.length ? 'Pick a lead on the left to open the chat.' : 'Your pinned leads’ chats will open here.'}
          </div>
        )}
      </section>

      {/* Lead details */}
      {selWa && selContact && !phone && (
        details ? (
          <aside style={{ width: 360, flexShrink: 0, borderLeft: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '8px 10px 0', justifyContent: 'space-between' }}>
              <span style={{ fontSize: T.label, fontWeight: W.bold, textTransform: 'uppercase', letterSpacing: '.06em', color: C.textSecondary, paddingLeft: 8 }}>Lead details</span>
              <button onClick={() => { setDetails(false); lsSet(LS_DETAILS, '0'); }} title="Hide lead details"
                style={{ border: 'none', background: 'transparent', color: C.textMuted, cursor: 'pointer', padding: 6, display: 'flex' }}><PanelRightClose size={17} /></button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <ChatProfilePanel key={selContact} inline contactNumber={selContact} contactName={selected?.name} user={user} />
            </div>
          </aside>
        ) : (
          <div style={{ width: 40, flexShrink: 0, borderLeft: `1px solid ${C.border}`, display: 'flex', justifyContent: 'center', paddingTop: 10 }}>
            <button onClick={() => { setDetails(true); lsSet(LS_DETAILS, '1'); }} title="Show lead details"
              style={{ border: 'none', background: 'transparent', color: C.textSecondary, cursor: 'pointer', padding: 6, height: 32, display: 'flex' }}><PanelRightOpen size={17} /></button>
          </div>
        )
      )}
    </div>
  );
}

function EmptyList() {
  return (
    <div style={{ padding: '36px 22px', textAlign: 'center', color: C.textSecondary, fontSize: T.body, lineHeight: LH.normal }}>
      <div style={{ width: 46, height: 46, borderRadius: 12, background: C.primaryLight, color: C.primary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
        <Pin size={22} />
      </div>
      <div style={{ fontSize: T.bodyLg, fontWeight: W.bold, color: C.text, marginBottom: 6 }}>No leads pinned yet</div>
      Open a chat in <b>Chats</b> and press the <Pin size={13} style={{ verticalAlign: '-2px' }} /> pin in its header, or set a follow-up with <CalendarClock size={13} style={{ verticalAlign: '-2px' }} />. It lands here.
    </div>
  );
}

function LeadRow({ i, today, active, onClick, onUnpin }) {
  const fu = i.nextFollowUp;
  const st = fu ? fuState(fu, today) : null;
  const tone = st ? FU_TONE[st] : null;
  return (
    <div role="button" tabIndex={0} onClick={onClick} onKeyDown={e => { if (e.key === 'Enter') onClick(); }}
      className="mylist-row"
      style={{
        display: 'flex', gap: 11, padding: '12px 14px', cursor: 'pointer', borderBottom: `1px solid ${C.rowSep}`,
        background: active ? 'var(--c-hover)' : 'transparent', borderLeft: `3px solid ${active ? C.primary : 'transparent'}`,
      }}>
      <div style={{ width: 40, height: 40, borderRadius: '50%', background: C.primary, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: W.bold, fontSize: T.bodyLg, flexShrink: 0 }}>
        {(i.name || '?').trim().charAt(0).toUpperCase()}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: T.bodyLg, fontWeight: W.medium, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{i.name}</span>
          {i.lastMessage && <span style={{ fontSize: T.label, color: C.textMuted, flexShrink: 0 }}>{relativeTime(i.lastMessage.at)}</span>}
        </div>
        <div style={{ fontSize: T.meta, color: C.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
          {i.lastMessage ? `${i.lastMessage.direction === 'outgoing' ? 'You: ' : ''}${i.lastMessage.text || ''}` : 'No messages yet'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          {i.lead?.stage && <StageBadge stage={i.lead.stage} />}
          {fu ? (
            <span title={fu.note || ''} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999, fontSize: T.label, fontWeight: W.bold, background: tone.bg, color: tone.fg, border: `1px solid ${tone.bd}` }}>
              <CalendarClock size={11} /> {relativeDay(fu.dueDate, today)}{fu.dueTime ? ` · ${time12(fu.dueTime)}` : ''}
            </span>
          ) : (
            <span style={{ fontSize: T.label, color: C.textMuted }}>No follow-up set</span>
          )}
          <span style={{ flex: 1 }} />
          <button onClick={onUnpin} title="Remove from My list" className="mylist-unpin"
            style={{ border: 'none', background: 'transparent', color: C.textMuted, cursor: 'pointer', padding: 2, display: 'flex' }}>
            <PinOff size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Calendar view ─────────────────────────────────────────────────────────────

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function CalendarView({ user, isAdmin, onOpenChat, onChanged }) {
  // Phones: month grid on top, the day agenda under it, the whole thing scrolling.
  const phone = useIsPhone();
  const today = todayIST();
  const [month, setMonth] = useState(today.slice(0, 7));                 // 'YYYY-MM'
  const [selDay, setSelDay] = useState(today);
  const [scope, setScope] = useState(() => (isAdmin ? lsGet(LS_SCOPE, 'all') : 'all'));
  const [items, setItems] = useState(null);
  const [overdue, setOverdue] = useState([]);
  const [editing, setEditing] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [dropDay, setDropDay] = useState(null);

  const grid = useMemo(() => monthGrid(`${month}-01`), [month]);
  const load = useCallback(async () => {
    try {
      const [r, o] = await Promise.all([
        api.followUps.list({ from: grid[0], to: grid[41], scope, status: 'open,done' }),
        api.followUps.list({ to: addDays(today, -1), scope, status: 'open' }),
      ]);
      setItems(r.items || []); setOverdue(o.items || []);
    } catch (e) { setItems([]); showError(e.message); }
  }, [grid, scope, today]);
  useEffect(() => { load(); }, [load]);

  const byDay = useMemo(() => {
    const m = {};
    (items || []).forEach(f => { (m[f.dueDate] = m[f.dueDate] || []).push(f); });
    Object.values(m).forEach(arr => arr.sort((a, b) =>
      (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || (a.dueTime || '99').localeCompare(b.dueTime || '99')));
    return m;
  }, [items]);

  const shiftMonth = (n) => {
    const d = new Date(`${month}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n);
    setMonth(d.toISOString().slice(0, 7));
  };
  const refresh = () => { load(); onChanged?.(); };

  const reschedule = async (id, day) => {
    const f = (items || []).find(x => x.id === id);
    if (!f || f.dueDate === day) return;
    setItems(list => list.map(x => (x.id === id ? { ...x, dueDate: day } : x)));    // optimistic
    try { await api.followUps.update(id, { dueDate: day }); refresh(); }
    catch (e) { showError(e.message); load(); }
  };
  const markDone = async (f) => {
    try { await api.followUps.update(f.id, { status: f.status === 'open' ? 'done' : 'open' }); refresh(); }
    catch (e) { showError(e.message); }
  };

  const monthIdx = Number(month.slice(5, 7)) - 1;
  const dayList = byDay[selDay] || [];

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 14, ...(phone ? { flexDirection: 'column', overflowY: 'auto' } : {}) }}>
      {/* Month grid */}
      <div style={{ flex: phone ? 'none' : 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderRadius: 14, border: `1px solid ${C.border}`, background: 'var(--c-cardBg)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: `1px solid ${C.border}`, flexWrap: 'wrap' }}>
          <IconBtn onClick={() => shiftMonth(-1)} title="Previous month"><ChevronLeft size={17} /></IconBtn>
          <IconBtn onClick={() => shiftMonth(1)} title="Next month"><ChevronRight size={17} /></IconBtn>
          <div style={{ fontSize: T.h3, fontWeight: W.heavy, color: C.text, minWidth: 170 }} data-testid="cal-month">
            {MONTH_NAMES[monthIdx]} {month.slice(0, 4)}
          </div>
          <button onClick={() => { setMonth(today.slice(0, 7)); setSelDay(today); }} style={pill(false)}>Today</button>
          <div style={{ flex: 1 }} />
          {isAdmin && (
            <Segmented small value={scope} onChange={(v) => { setScope(v); lsSet(LS_SCOPE, v); }}
              options={[{ value: 'mine', label: 'Mine' }, { value: 'all', label: 'Everyone' }]} />
          )}
          <GoogleSync scope={scope} isAdmin={isAdmin} onSynced={load} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', borderBottom: `1px solid ${C.border}`, background: 'var(--c-surfaceSection)' }}>
          {WEEKDAYS.map(d => (
            <div key={d} style={{ padding: '8px 10px', fontSize: T.label, fontWeight: W.bold, textTransform: 'uppercase', letterSpacing: '.06em', color: C.textSecondary }}>{d}</div>
          ))}
        </div>
        <div data-testid="cal-grid" style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gridTemplateRows: phone ? 'repeat(6, minmax(58px, auto))' : 'repeat(6, minmax(92px, 1fr))', overflowY: 'auto' }}>
          {grid.map((day, idx) => {
            const inMonth = day.slice(0, 7) === month;
            const list = byDay[day] || [];
            const isToday = day === today;
            const isSel = day === selDay;
            const isDrop = dropDay === day;
            return (
              <div key={day} data-day={day}
                onClick={() => setSelDay(day)}
                onDragOver={(e) => { if (dragId) { e.preventDefault(); setDropDay(day); } }}
                onDragLeave={() => setDropDay(d => (d === day ? null : d))}
                onDrop={(e) => { e.preventDefault(); setDropDay(null); if (dragId) reschedule(dragId, day); setDragId(null); }}
                style={{
                  borderRight: (idx % 7) < 6 ? `1px solid ${C.borderSubtle}` : 'none',
                  borderBottom: idx < 35 ? `1px solid ${C.borderSubtle}` : 'none',
                  padding: '6px 6px 4px', cursor: 'pointer', minWidth: 0, overflow: 'hidden',
                  background: isDrop ? C.primaryLight : isSel ? 'var(--c-hover)' : inMonth ? 'transparent' : 'var(--c-surfaceInner)',
                  outline: isSel ? `2px solid ${C.primary}` : 'none', outlineOffset: -2,
                  display: 'flex', flexDirection: 'column', gap: 3,
                }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{
                    width: 26, height: 26, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: T.meta, fontWeight: isToday ? W.heavy : W.medium,
                    background: isToday ? C.primary : 'transparent', color: isToday ? '#fff' : inMonth ? C.text : C.textMuted,
                  }}>{Number(day.slice(8))}</span>
                  {list.length > 0 && <span style={{ fontSize: T.label, color: C.textMuted, fontWeight: W.medium }}>{list.length}</span>}
                </div>
                {list.slice(0, 3).map(f => (
                  <Chip key={f.id} f={f} today={today}
                    onDragStart={() => setDragId(f.id)} onDragEnd={() => { setDragId(null); setDropDay(null); }}
                    onClick={(e) => { e.stopPropagation(); setSelDay(day); setEditing(f); }} />
                ))}
                {list.length > 3 && (
                  <span style={{ fontSize: T.label, fontWeight: W.bold, color: C.textSecondary, paddingLeft: 4 }}>+{list.length - 3} more</span>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ padding: '8px 14px', borderTop: `1px solid ${C.border}`, fontSize: T.meta, color: C.textSecondary, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <Legend tone="overdue" label="Overdue" /><Legend tone="today" label="Today" /><Legend tone="upcoming" label="Upcoming" /><Legend tone="done" label="Done" />
          <span style={{ flex: 1 }} />
          <span>Drag a follow-up to another day to reschedule it.</span>
        </div>
      </div>

      {/* Day agenda */}
      <aside style={{ width: phone ? 'auto' : 340, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflowY: phone ? 'visible' : 'auto' }}>
        {overdue.length > 0 && (
          <AgendaCard title={`Overdue · ${overdue.length}`} tone="overdue" icon={AlertTriangle}>
            {overdue.map(f => <AgendaItem key={f.id} f={f} today={today} onOpenChat={onOpenChat} onDone={markDone} onEdit={() => setEditing(f)} />)}
          </AgendaCard>
        )}
        <AgendaCard title={`${relativeDay(selDay, today) === shortDate(selDay) ? '' : `${relativeDay(selDay, today)} · `}${shortDate(selDay)}`} testid="cal-agenda">
          {items == null ? (
            <div style={{ padding: 14, display: 'flex', justifyContent: 'center' }}><Loader2 size={18} color={C.textMuted} style={{ animation: 'spin 1s linear infinite' }} /></div>
          ) : dayList.length ? (
            dayList.map(f => <AgendaItem key={f.id} f={f} today={today} onOpenChat={onOpenChat} onDone={markDone} onEdit={() => setEditing(f)} />)
          ) : (
            <div style={{ padding: '14px 14px 16px', fontSize: T.body, color: C.textSecondary, lineHeight: LH.normal }}>
              Nothing planned for this day. Set follow-ups from any chat with the <CalendarClock size={13} style={{ verticalAlign: '-2px' }} /> button.
            </div>
          )}
        </AgendaCard>
      </aside>

      {editing && (
        <FollowUpModal
          waNumber={editing.waNumber}
          contactNumber={editing.contactNumber}
          name={editing.name}
          existing={editing.status === 'open' ? editing : { ...editing }}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}

function Chip({ f, today, onClick, onDragStart, onDragEnd }) {
  const st = fuState(f, today);
  const tone = FU_TONE[st];
  return (
    <div draggable={f.status === 'open'} onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }} onDragEnd={onDragEnd}
      onClick={onClick} title={`${f.name}${f.note ? ` — ${f.note}` : ''}`} data-testid="cal-chip"
      style={{
        display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px', borderRadius: 6, minWidth: 0,
        background: tone.bg, color: tone.fg, border: `1px solid ${tone.bd}`, fontSize: T.label, fontWeight: W.medium,
        cursor: f.status === 'open' ? 'grab' : 'pointer', textDecoration: st === 'done' ? 'line-through' : 'none',
      }}>
      {f.dueTime && <span style={{ fontWeight: W.bold, flexShrink: 0 }}>{time12(f.dueTime).replace(':00', '')}</span>}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
    </div>
  );
}

function Legend({ tone, label }) {
  const t = FU_TONE[tone];
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: t.bg, border: `1px solid ${t.bd}` }} />{label}</span>;
}

function AgendaCard({ title, tone, icon: Icon, testid, children }) {
  const t = tone ? FU_TONE[tone] : null;
  return (
    <div data-testid={testid} style={{ borderRadius: 14, border: `1px solid ${t ? t.bd : C.border}`, background: 'var(--c-cardBg)', overflow: 'hidden', flexShrink: 0 }}>
      <div style={{ padding: '11px 14px', borderBottom: `1px solid ${C.border}`, fontSize: T.bodyLg, fontWeight: W.heavy, color: t ? t.fg : C.text, display: 'flex', alignItems: 'center', gap: 7, background: t ? t.bg : 'transparent' }}>
        {Icon && <Icon size={15} />}{title}
      </div>
      <div>{children}</div>
    </div>
  );
}

function AgendaItem({ f, today, onOpenChat, onDone, onEdit }) {
  const st = fuState(f, today);
  return (
    <div data-testid="cal-agenda-item" style={{ padding: '11px 14px', borderBottom: `1px solid ${C.rowSep}`, opacity: st === 'done' ? 0.65 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={() => onDone(f)} title={f.status === 'open' ? 'Mark done' : 'Reopen'} style={{
          width: 22, height: 22, borderRadius: 6, flexShrink: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          border: `1.5px solid ${f.status === 'open' ? C.borderStrong : 'var(--c-successBright, #1D9E75)'}`,
          background: f.status === 'open' ? 'transparent' : 'var(--c-successBright, #1D9E75)', color: '#fff',
        }}>{f.status !== 'open' && <Check size={14} />}</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div onClick={onEdit} style={{ fontSize: T.bodyLg, fontWeight: W.bold, color: C.text, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: st === 'done' ? 'line-through' : 'none' }}>{f.name}</div>
          <div style={{ fontSize: T.meta, color: st === 'overdue' ? FU_TONE.overdue.fg : C.textSecondary, marginTop: 1 }}>
            {st === 'overdue' ? `${relativeDay(f.dueDate, today)} · ${shortDate(f.dueDate)}` : f.dueTime ? time12(f.dueTime) : 'Any time'}
            {f.ownerName ? ` · ${f.ownerName}` : ''}
          </div>
        </div>
        {f.stage && <StageBadge stage={f.stage} />}
      </div>
      {f.note && <div style={{ fontSize: T.body, color: C.text, lineHeight: LH.snug, marginTop: 7, paddingLeft: 30 }}>{f.note}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, paddingLeft: 30 }}>
        {f.waNumber && f.contactNumber && (
          <button onClick={() => onOpenChat(f.waNumber, f.contactNumber)} style={pill(true)}><MessageSquare size={13} /> Open chat</button>
        )}
        <button onClick={onEdit} style={pill(false)}><CalendarClock size={13} /> Reschedule</button>
        {f.google?.synced && <span title="On Google Calendar" style={{ fontSize: T.label, color: C.textMuted, alignSelf: 'center' }}>● Google</span>}
      </div>
    </div>
  );
}

// ── Google Calendar ───────────────────────────────────────────────────────────

function GoogleSync({ scope, isAdmin, onSynced }) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const load = useCallback(() => { api.followUps.google().then(setSt).catch(() => setSt({ connected: false })); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const sync = async (autoSync) => {
    setBusy(true);
    try {
      const r = await api.followUps.googleSync({ scope, ...(autoSync !== undefined ? { autoSync } : {}) });
      setSt(r.status);
      if (autoSync === undefined) {
        const parts = [r.created && `${r.created} added`, r.updated && `${r.updated} updated`, r.removed && `${r.removed} removed`].filter(Boolean);
        if (r.failed) showError(`${r.failed} follow-up${r.failed === 1 ? '' : 's'} could not be synced to Google Calendar. ${parts.join(', ')}`);
        else showSuccess(parts.length ? `Google Calendar synced — ${parts.join(', ')}.` : 'Google Calendar is already up to date.');
      }
      onSynced?.();
    } catch (e) { showError(e.message); }
    finally { setBusy(false); }
  };

  const dot = st?.connected ? 'var(--c-successBright, #1D9E75)' : st?.needsReconnect ? 'var(--c-dangerText, #A32D2D)' : 'var(--c-textMuted)';
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} data-testid="gcal-button" style={{ ...pill(false), padding: '7px 12px' }}>
        <GoogleG /> Google Calendar
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot }} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: 320, zIndex: 50,
          background: 'var(--fc-card, var(--c-cardBg))', border: `1px solid ${C.border}`, borderRadius: 14, boxShadow: C.shadowLg, padding: 16,
        }}>
          {!st ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : !st.connected ? (
            <div style={{ fontSize: T.body, color: C.text, lineHeight: LH.normal }} data-testid="gcal-disconnected">
              <b>{st.needsReconnect ? 'Google Calendar needs reconnecting' : 'Google Calendar is not connected'}</b>
              <div style={{ color: C.textSecondary, marginTop: 6 }}>
                {st.needsReconnect
                  ? <>Google stopped accepting the saved sign-in for <b>{st.account}</b>. {isAdmin ? 'Reconnect it' : 'An admin can reconnect it'} in Settings → Google → Calendar.</>
                  : 'An admin can connect it in Settings → Google → Calendar.'}
              </div>
              {isAdmin && (
                <a href="#/admin-settings/google" style={{ ...pill(true), marginTop: 12, textDecoration: 'none' }}>Open Google settings <ExternalLink size={12} /></a>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div style={{ fontSize: T.bodyLg, fontWeight: W.bold, color: C.text }}>Sync to Google Calendar</div>
                <div style={{ fontSize: T.meta, color: C.textSecondary, marginTop: 3, lineHeight: LH.snug }}>
                  Each open follow-up becomes an event on <b>{st.account}</b>, with the note and a link back to the chat. Rescheduling or finishing one here updates Google.
                </div>
              </div>
              <div style={{ display: 'flex', gap: 14, fontSize: T.meta, color: C.textSecondary }}>
                <span><b style={{ color: C.text }}>{st.synced}</b> on Google</span>
                <span><b style={{ color: st.unsynced ? C.primary : C.text }}>{st.unsynced}</b> not yet</span>
              </div>
              <button onClick={() => sync()} disabled={busy} data-testid="gcal-sync" style={{ ...pill(true), justifyContent: 'center', padding: '9px 12px', fontSize: T.body }}>
                {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={14} />}
                {busy ? 'Syncing…' : `Sync ${scope === 'mine' ? 'my' : 'all'} follow-ups now`}
              </button>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: T.meta, color: isAdmin ? C.text : C.textMuted, cursor: isAdmin ? 'pointer' : 'default', lineHeight: LH.snug }}>
                <input type="checkbox" checked={!!st.autoSync} disabled={!isAdmin || busy} onChange={e => sync(e.target.checked)} style={{ marginTop: 2 }} />
                <span>Add every new follow-up to Google automatically{!isAdmin && ' (admin setting)'}</span>
              </label>
              {st.lastSyncAt && <div style={{ fontSize: T.label, color: C.textMuted }}>Last synced {relativeTime(st.lastSyncAt)}</div>}
              <a href="https://calendar.google.com/calendar/r" target="_blank" rel="noreferrer" style={{ fontSize: T.meta, color: C.primary, display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none', fontWeight: W.bold }}>
                Open Google Calendar <ExternalLink size={12} />
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GoogleG() {
  return (
    <svg width="14" height="14" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

// ── bits ──────────────────────────────────────────────────────────────────────

function pill(primary) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 999,
    fontSize: T.meta, fontWeight: W.bold, cursor: 'pointer', fontFamily: FONT, whiteSpace: 'nowrap',
    border: primary ? 'none' : `1.5px solid ${C.border}`,
    background: primary ? C.primary : 'transparent', color: primary ? '#fff' : C.text,
  };
}

function IconBtn({ children, ...p }) {
  return (
    <button {...p} style={{ width: 34, height: 34, borderRadius: 10, border: `1.5px solid ${C.border}`, background: 'transparent', color: C.text, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </button>
  );
}

function Segmented({ value, onChange, options, small }) {
  return (
    <div role="tablist" style={{ display: 'inline-flex', padding: 3, borderRadius: 999, background: 'var(--c-surfaceMuted)', border: `1px solid ${C.border}` }}>
      {options.map(o => {
        const on = value === o.value;
        return (
          <button key={o.value} role="tab" aria-selected={on} onClick={() => onChange(o.value)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', cursor: 'pointer', fontFamily: FONT,
            padding: small ? '5px 12px' : '7px 16px', borderRadius: 999, fontSize: small ? T.meta : T.body, fontWeight: W.bold,
            background: on ? 'var(--c-cardBg)' : 'transparent', color: on ? C.text : C.textSecondary,
            boxShadow: on ? C.shadowSm : 'none',
          }}>
            {o.Icon && <o.Icon size={15} />}{o.label}
          </button>
        );
      })}
    </div>
  );
}
