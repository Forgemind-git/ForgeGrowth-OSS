// Set / reschedule / finish ONE follow-up for a chat.
//
// One component for every place a follow-up is set — the chat header, the My
// list lead pane, the calendar and the Chat Analyzer's "add to calendar" — so
// the rules (one open follow-up per person, quick picks, AI suggestion) look and
// behave the same everywhere.
import { useState, useEffect } from 'react';
import { X, Sparkles, Loader2, Check, Trash2, CalendarClock, Clock } from 'lucide-react';
import { C, FONT, T, W, LH } from '../constants.js';
import { api } from '../api.js';
import { showError } from '../lib/feedback.js';
import { todayIST, quickPicks, shortDate, relativeDay, time12 } from '../lib/followUpDates.js';
import DateGrid from './DateGrid.jsx';

export default function FollowUpModal({
  waNumber, contactNumber, name, existing = null, suggestion = null, onClose, onSaved,
}) {
  const today = todayIST();
  const [date, setDate] = useState(existing?.dueDate || suggestion?.date || '');
  const [time, setTime] = useState(existing?.dueTime || suggestion?.time || '');
  const [note, setNote] = useState(existing?.note || suggestion?.note || '');
  const [reason, setReason] = useState(existing ? null : (suggestion?.reason || null));
  const [fromAi, setFromAi] = useState(!existing && !!suggestion);
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const askAi = async () => {
    setSuggesting(true);
    try {
      const s = await api.followUps.suggest(waNumber, contactNumber);
      setDate(s.date); setTime(s.time || '');
      if (s.note && !note.trim()) setNote(s.note);
      setReason(s.reason || null); setFromAi(true);
    } catch (e) { showError(e.message); }
    finally { setSuggesting(false); }
  };

  const save = async () => {
    if (!date) return;
    setSaving(true);
    try {
      const saved = existing
        ? await api.followUps.update(existing.id, { dueDate: date, dueTime: time || null, note })
        : await api.followUps.set({
          waNumber, contactNumber, dueDate: date, dueTime: time || null, note,
          source: fromAi ? 'ai' : 'manual', aiReason: fromAi ? reason : null,
        });
      onSaved?.(saved);
      onClose?.();
    } catch (e) { showError(e.message); }
    finally { setSaving(false); }
  };

  const finish = async (status) => {
    setSaving(true);
    try {
      const saved = status === 'delete'
        ? (await api.followUps.remove(existing.id), null)
        : await api.followUps.update(existing.id, { status });
      onSaved?.(saved);
      onClose?.();
    } catch (e) { showError(e.message); }
    finally { setSaving(false); }
  };

  const past = date && date < today;
  const label = { fontSize: T.label, fontWeight: W.bold, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 7 };
  const input = {
    width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10,
    border: `1.5px solid ${C.border}`, background: 'var(--c-cardBg)', color: C.text,
    fontSize: T.bodyLg, fontFamily: FONT, outline: 'none',
  };

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--fc-scrim, rgba(0,0,0,.35))', backdropFilter: 'blur(3px)', zIndex: 500 }} />
      <div role="dialog" aria-label="Follow-up" style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
        width: 'min(640px, calc(calc(100vw / var(--fg-zoom, 1)) - 24px))', maxHeight: 'calc(calc(100vh / var(--fg-zoom, 1)) - 32px)', overflowY: 'auto',
        background: 'var(--fc-card, var(--c-cardBg))', borderRadius: 16, boxShadow: C.shadowLg,
        zIndex: 501, fontFamily: FONT, color: C.text,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '18px 20px 12px' }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: C.primaryLight, color: C.primary, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <CalendarClock size={19} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: T.h3, fontWeight: W.heavy, lineHeight: LH.tight }}>
              {existing ? 'Follow-up' : 'Set a follow-up'}
            </div>
            <div style={{ fontSize: T.body, color: C.textSecondary, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              with {name || contactNumber}
            </div>
          </div>
          <button onClick={onClose} title="Close" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted, padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ padding: '4px 20px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* AI suggestion */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12,
            background: 'var(--c-surfaceSection, #F8F7F2)', border: `1px solid ${C.borderSubtle}`,
          }}>
            <Sparkles size={16} color={C.purple} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0, fontSize: T.body, lineHeight: LH.snug, color: reason ? C.text : C.textSecondary }}>
              {reason
                ? <><b>AI suggests {shortDate(date)}{time ? `, ${time12(time)}` : ''}</b> — {reason}</>
                : 'Let the AI read this chat and pick the best day.'}
            </div>
            <button onClick={askAi} disabled={suggesting} style={{
              border: `1.5px solid ${C.purple}`, background: 'transparent', color: C.purple, borderRadius: 999,
              padding: '6px 12px', fontSize: T.meta, fontWeight: W.bold, cursor: suggesting ? 'wait' : 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', fontFamily: FONT,
            }}>
              {suggesting ? <Loader2 size={13} className="spin" style={{ animation: 'spin 1s linear infinite' }} /> : <Sparkles size={13} />}
              {suggesting ? 'Reading…' : reason ? 'Ask again' : 'Suggest'}
            </button>
          </div>

          {/* Date — a real month grid (the native date box was too small to hit). */}
          <div>
            <div style={label}>When</div>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ padding: '10px 6px 8px', borderRadius: 14, border: `1px solid ${C.border}`, background: 'var(--c-surfaceInner)' }}>
                <DateGrid value={date} min={today} onChange={(d) => { setDate(d); setFromAi(false); }} />
              </div>
              <div style={{ flex: '1 1 150px', minWidth: 150, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <div style={{ ...label, marginBottom: 6 }}>Quick pick</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {quickPicks(today).map(q => {
                      const on = date === q.date;
                      return (
                        <button key={q.label} type="button" onClick={() => { setDate(q.date); setFromAi(false); setReason(null); }} style={chip(on)}>{q.label}</button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <div style={{ ...label, marginBottom: 6 }}>Time <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: W.normal }}>(optional)</span></div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                    {[['Any time', ''], ['10 AM', '10:00'], ['12 PM', '12:00'], ['3 PM', '15:00'], ['6 PM', '18:00'], ['8 PM', '20:00']].map(([l, v]) => (
                      <button key={l} type="button" onClick={() => setTime(v)} style={chip(time === v)}>{l}</button>
                    ))}
                  </div>
                  <input type="time" value={time} onChange={e => setTime(e.target.value)} style={{ ...input, padding: '8px 10px' }} aria-label="Exact time (optional)" />
                </div>
              </div>
            </div>
            <div data-testid="followup-when" style={{ fontSize: T.body, fontWeight: W.medium, color: past ? C.dangerText : C.text, marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Clock size={14} color={C.textSecondary} />
              {date ? `${relativeDay(date, today)} · ${shortDate(date)}${time ? ` at ${time12(time)}` : ' · any time that day'}` : 'Pick a day on the calendar'}
            </div>
          </div>

          {/* Note */}
          <div>
            <div style={label}>Note <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: W.normal }}>(optional)</span></div>
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
              placeholder="What to say or check — e.g. send the payment link, confirm the 12 Oct batch"
              style={{ ...input, resize: 'vertical', lineHeight: LH.normal }} />
          </div>

          {!existing && (
            <div style={{ fontSize: T.meta, color: C.textSecondary, lineHeight: LH.snug }}>
              The chat is also pinned in <b>Follow-up</b>, and the date shows on its calendar.
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 20px', borderTop: `1px solid ${C.border}` }}>
          {existing && (
            <>
              <button onClick={() => finish('done')} disabled={saving} style={btn('success')}><Check size={15} /> Done</button>
              <button onClick={() => finish('delete')} disabled={saving} title="Delete this follow-up" style={btn('ghost')}><Trash2 size={15} /></button>
            </>
          )}
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={btn('secondary')}>Cancel</button>
          <button onClick={save} disabled={!date || saving} style={{ ...btn('primary'), opacity: !date || saving ? 0.55 : 1 }}>
            {saving ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <CalendarClock size={15} />}
            {existing ? 'Save' : 'Set follow-up'}
          </button>
        </div>
      </div>
    </>
  );
}

function chip(on) {
  return {
    padding: '6px 11px', borderRadius: 999, fontSize: T.meta, fontWeight: W.medium, cursor: 'pointer', fontFamily: FONT,
    border: `1.5px solid ${on ? C.primary : C.border}`,
    background: on ? C.primaryLight : 'transparent', color: on ? C.primary : C.text,
  };
}

function btn(kind) {
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 10,
    fontSize: T.body, fontWeight: W.bold, cursor: 'pointer', fontFamily: FONT, whiteSpace: 'nowrap',
  };
  if (kind === 'primary') return { ...base, background: C.primary, color: '#fff', border: 'none' };
  if (kind === 'success') return { ...base, background: 'var(--c-successBg, #E1F5EE)', color: 'var(--c-successText, #0F6E56)', border: '1.5px solid var(--c-successBorder, #B8DCCF)' };
  if (kind === 'ghost') return { ...base, background: 'transparent', color: C.textMuted, border: `1.5px solid ${C.border}`, padding: '9px 10px' };
  return { ...base, background: 'transparent', color: C.text, border: `1.5px solid ${C.border}` };
}
