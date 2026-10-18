// The Chat Analyzer, wherever it appears.
//
// ONE implementation, mounted in three places: the Chat Analyzer tab's detail
// view, a slide-over inside ChatWindow, and the Communities group view. A second
// copy would drift, and a drifted copy of run controls means the button in one
// place quietly does something different from the same button in another.
//
// ⚠ SIZES COME FROM THE T/W/LH SCALE, NEVER A TYPED NUMBER. The first version of
// this file hand-typed 26 font sizes, 17 of them under 13px, and read as
// unusably small — the exact failure the app-wide type scale exists to prevent
// (a design system only governs the code that ASKS it for a value). If you are
// about to write `fontSize: 12`, use T.label instead.

import { useState, useEffect, useCallback } from 'react';
import {
  ScanSearch, Loader2, Check, AlertTriangle, Mic, Image as ImageIcon,
  FileText, MessageSquare, Calendar, Search, ChevronDown, ChevronRight, Clock, IndianRupee,
  FileAudio, Copy, Check as CheckIcon, Target, StickyNote, CalendarClock, Sparkles,
} from 'lucide-react';
import FollowUpModal from './FollowUpModal.jsx';
import { shortDate, relativeDay, time12, todayIST } from '../lib/followUpDates.js';
import { api } from '../api.js';
import { C, FONT, MONO, T, W, LH } from '../constants.js';
import { showError, showSuccess } from '../lib/feedback.js';
import { useFunnelConfig, funnelStageMeta } from '../hooks/useFunnelConfig.js';

// Icon sizes, paired with the text they sit beside. An icon a step smaller than
// its label reads as an artefact; matching it reads as deliberate.
const IC = { inline: 16, row: 18, section: 20 };

const MODALITIES = [
  { key: 'text', label: 'Text', Icon: MessageSquare, note: 'Free — always worth including' },
  { key: 'audio', label: 'Voice notes', Icon: Mic, note: 'Transcribed once, then reused free' },
  { key: 'image', label: 'Images', Icon: ImageIcon, note: 'Read once, then reused free' },
  { key: 'document', label: 'Documents', Icon: FileText, note: 'PDF text only' },
];

const inputSm = {
  width: '100%', padding: '10px 12px', borderRadius: 9,
  border: `1px solid ${C.border}`, background: 'var(--c-cardBg)',
  color: C.text, fontSize: T.body, fontWeight: W.normal, fontFamily: FONT,
  boxSizing: 'border-box',
};

export default function ChatAnalyzerPanel({ source = 'chat', conversationKey, waNumber = null, compact = false, onAnalysed, onFollowUpSet }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  // Run options fold away once there is an analysis to read — the result, not
  // the form, is what someone opens this to see.
  const [showOptions, setShowOptions] = useState(false);
  const [result, setResult] = useState(null);
  // 'analysis' = what it MEANT. 'transcript' = what was SAID.
  const [view, setView] = useState('analysis');
  const { stages } = useFunnelConfig();

  // Voice notes on by default: a sales chat is mostly voice, and a text-only
  // update cannot see a NEW voice note at all. Transcription is ~₹0.03 a note and
  // happens once per note, ever.
  const [mods, setMods] = useState({ text: true, audio: true, image: false, document: false });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [keyword, setKeyword] = useState('');
  const [incremental, setIncremental] = useState(true);

  const load = useCallback(async () => {
    if (!conversationKey) return;
    setLoading(true);
    try {
      setData(await api.chatAnalyzer.conversation(source, conversationKey));
    } catch (e) {
      showError(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [source, conversationKey]);

  useEffect(() => { load(); }, [load]);

  const scoped = !!(from || to || keyword);
  const chosen = MODALITIES.filter(m => mods[m.key]).map(m => m.key);

  const run = async () => {
    if (!chosen.length) { showError('Pick at least one thing to read — text, voice notes, images or documents.'); return; }
    setRunning(true);
    setResult(null);
    try {
      const r = await api.chatAnalyzer.run({
        source, conversationKey, modalities: chosen,
        from: from || undefined, to: to || undefined, keyword: keyword || undefined,
        incremental: scoped ? false : incremental,
      });
      setResult(r);
      if (r.skipped) showSuccess('Already up to date — there were no new messages to read.');
      else showSuccess(scoped ? 'Filtered analysis ready.' : 'Analysis updated.');
      await load();
      onAnalysed?.(r);
    } catch (e) {
      showError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const [applying, setApplying] = useState(false);

  if (loading && !data) {
    return <div style={{ padding: 24, color: C.textMuted, fontSize: T.body, fontFamily: FONT }}>Loading…</div>;
  }
  if (!data) {
    return <div style={{ padding: 24, color: C.textMuted, fontSize: T.body, fontFamily: FONT }}>This conversation could not be opened.</div>;
  }

  const a = data.analysis;
  const cov = data.coverage || {};
  const isGroup = source === 'community';
  const convo = data.conversation || {};
  const currentStage = convo.stage || null;
  const leadId = a?.leadId || convo.leadId || null;
  const canApply = !isGroup && a?.suggestedStage && leadId
    && a.suggestedStage !== currentStage && a.suggestionState !== 'applied' && a.suggestionState !== 'dismissed';

  const sections = deriveSections(a, isGroup);

  // ⚠ Moving the stage goes through PUT /leads/:id/move (it owns validation,
  // RBAC, the lead_events audit row and the SSE emit); /chat-analysis/applied
  // only records that the suggestion was acted on. Never a second write path.
  const applyStage = async () => {
    setApplying(true);
    try {
      await api.leads.move(leadId, a.suggestedStage);
      await api.chatAnalyzer.applied({ source, conversationKey, stage: a.suggestedStage });
      showSuccess(`Lead moved to ${funnelStageMeta(a.suggestedStage)?.label || a.suggestedStage}.`);
      await load();
    } catch (e) { showError(e.message); } finally { setApplying(false); }
  };
  const dismissStage = async () => {
    setApplying(true);
    try { await api.chatAnalyzer.dismiss({ source, conversationKey }); await load(); }
    catch (e) { showError(e.message); } finally { setApplying(false); }
  };

  const optionsOpen = showOptions || !a;

  const runForm = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <SectionLabel>Read</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr 1fr' : 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
          {MODALITIES.map(({ key, label, Icon, note }) => (
            <label key={key} title={note} style={{
              display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px',
              borderRadius: 10, cursor: 'pointer',
              fontSize: T.body, fontWeight: W.medium,
              border: `1px solid ${mods[key] ? 'var(--c-primary)' : C.border}`,
              background: mods[key] ? 'var(--c-primaryLight)' : 'var(--c-cardBg)',
              color: C.text,
            }}>
              <input type="checkbox" checked={mods[key]}
                onChange={e => setMods(m => ({ ...m, [key]: e.target.checked }))}
                style={{ accentColor: 'var(--c-primary)', width: 17, height: 17 }} />
              <Icon size={IC.inline} /> {label}
            </label>
          ))}
        </div>
        <div style={{ fontSize: T.meta, color: C.textMuted, marginTop: 8, lineHeight: LH.normal }}>
          Voice notes, images and documents are read once and cached — a later run reuses them at no cost.
          Our own Media Library files are read from their description instead.
        </div>
      </div>

      <div>
        <SectionLabel>Only messages from</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr 1fr' : '1fr 1fr 2fr', gap: 10 }}>
          <label style={{ fontSize: T.meta, fontWeight: W.medium, color: C.textSecondary }}>
            <Calendar size={14} style={{ verticalAlign: -2, marginRight: 5 }} />From
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ ...inputSm, marginTop: 5 }} />
          </label>
          <label style={{ fontSize: T.meta, fontWeight: W.medium, color: C.textSecondary }}>
            To
            <input type="date" value={to} onChange={e => setTo(e.target.value)} min={from || undefined}
              style={{ ...inputSm, marginTop: 5 }} />
          </label>
          <label style={{ fontSize: T.meta, fontWeight: W.medium, color: C.textSecondary, gridColumn: compact ? '1 / -1' : undefined }}>
            <Search size={14} style={{ verticalAlign: -2, marginRight: 5 }} />Containing the word
            <input value={keyword} onChange={e => setKeyword(e.target.value)}
              placeholder="e.g. refund" style={{ ...inputSm, marginTop: 5 }} />
          </label>
        </div>
      </div>

      {/* A filtered run is a one-off question, not progress through the
          conversation — saying so here is what stops someone expecting it
          to update the standing summary. */}
      {scoped ? (
        <Note tone="info">
          A filtered run answers a one-off question. It is saved in the run history but does not
          replace this conversation&apos;s standing summary, and does not count as having read the
          messages in between.
        </Note>
      ) : (
        <label style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          fontSize: T.body, color: C.text, cursor: 'pointer', lineHeight: LH.snug,
        }}>
          <input type="checkbox" checked={incremental} onChange={e => setIncremental(e.target.checked)}
            style={{ accentColor: 'var(--c-primary)', width: 17, height: 17, marginTop: 1 }} />
          <span>
            Only read what is new since last time
            <span style={{ display: 'block', fontSize: T.meta, color: C.textMuted }}>
              Uncheck to re-read the whole conversation.
            </span>
          </span>
        </label>
      )}
    </div>
  );

  const runButton = (
    <button data-testid="ca-run" onClick={run} disabled={running || !chosen.length} style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      padding: '10px 16px', borderRadius: 10, border: 'none', whiteSpace: 'nowrap',
      cursor: running ? 'default' : 'pointer',
      background: chosen.length ? 'var(--c-primary)' : 'var(--c-surfaceMuted)',
      color: chosen.length ? '#fff' : C.textMuted,
      fontFamily: FONT, fontSize: T.body, fontWeight: W.bold, opacity: running ? 0.75 : 1,
    }}>
      {running
        ? <><Loader2 size={IC.inline} style={{ animation: 'spin 1s linear infinite' }} /> Reading…</>
        : <><ScanSearch size={IC.inline} /> {scoped ? 'Run filtered analysis' : a ? 'Update analysis' : 'Analyse'}</>}
    </button>
  );

  return (
    <div style={{ fontFamily: FONT, display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Three questions about one conversation: what it MEANS (overview), what
          was actually SAID (transcript), and what was run when (history). */}
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}` }}>
        {[['analysis', 'Overview'], ['transcript', 'Transcript'], ['runs', `Runs${data.runs?.length ? ` (${data.runs.length})` : ''}`]].map(([k, label]) => {
          const on = view === k;
          return (
            <button key={k} data-testid={`ca-tab-${k}`} onClick={() => setView(k)} style={{
              padding: '10px 16px', border: 'none', background: 'transparent', cursor: 'pointer',
              fontFamily: FONT, fontSize: T.body, fontWeight: on ? W.bold : W.medium,
              color: on ? C.text : C.textSecondary,
              borderBottom: `3px solid ${on ? 'var(--c-primary)' : 'transparent'}`, marginBottom: -1,
            }}>{label}</button>
          );
        })}
      </div>

      {view === 'transcript' && (
        <TranscriptView source={source} conversationKey={conversationKey} compact={compact} />
      )}

      {view === 'runs' && <RunList runs={data.runs || []} />}

      {view === 'analysis' && <>
        {/* ── status + run bar ── */}
        <Card pad={14}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: T.body, fontWeight: W.bold, color: C.text }}>
                {a ? 'Analysed' : 'Not analysed yet'}
                {a?.lastRunAt && <span style={{ fontWeight: W.normal, color: C.textSecondary }}> · {timeAgo(a.lastRunAt)}</span>}
              </div>
              {a && data.unread && (
                <div data-testid="ca-unread" style={{ fontSize: T.meta, marginTop: 3, color: data.unread.total ? 'var(--c-warnText, #8a6d1f)' : C.textSecondary }}>
                  {data.unread.total
                    ? <>{data.unread.total} new message{data.unread.total === 1 ? '' : 's'} since this analysis (latest {timeAgo(data.unread.latest)})
                        {data.unread.untranscribed > 0 && <> · {data.unread.untranscribed} voice note{data.unread.untranscribed === 1 ? '' : 's'} not transcribed yet{mods.audio ? ' — Update will transcribe' : ' — tick Voice notes in Options'}</>}
                        {' '}— press Update analysis.</>
                    : <>Up to date — every message up to {data.unread.readUpTo ? new Date(data.unread.readUpTo).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'now'} has been read.</>}
                </div>
              )}
              {/* What has been read, PER MODALITY — one "analysed" badge would be
                  a lie the moment someone enables images. */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 7 }} data-testid="ca-coverage">
                {MODALITIES.map(({ key, label, Icon }) => {
                  const c = cov[key];
                  return (
                    <span key={key} title={c ? `Read up to ${new Date(c.at).toLocaleString('en-IN')} — ${c.count} message(s)` : `${label}: never read in this conversation`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999,
                        fontSize: T.meta, fontWeight: W.medium,
                        background: c ? 'var(--c-successBg)' : 'var(--c-surfaceMuted)',
                        color: c ? 'var(--c-successText)' : C.textMuted,
                      }}>
                      <Icon size={13} />{label}{c ? <Check size={13} /> : null}
                    </span>
                  );
                })}
              </div>
            </div>
            {runButton}
            {a && (
              <button onClick={() => setShowOptions(v => !v)} style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, padding: '10px 12px', borderRadius: 10,
                border: `1px solid ${C.border}`, background: 'transparent', cursor: 'pointer',
                color: C.textSecondary, fontFamily: FONT, fontSize: T.body, fontWeight: W.medium,
              }}>
                Options {showOptions ? <ChevronDown size={IC.inline} /> : <ChevronRight size={IC.inline} />}
              </button>
            )}
          </div>
          {optionsOpen && <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>{runForm}</div>}
        </Card>

        {/* ── what the last run cost + what it skipped ── */}
        {result && !result.skipped && result.read && (
          <div data-testid="ca-read" style={{ fontSize: T.body, color: C.text, lineHeight: LH.snug, padding: '10px 12px', borderRadius: 10, background: TONES.success.bg }}>
            <Check size={14} style={{ verticalAlign: -2, marginRight: 6, color: TONES.success.fg }} />
            {result.read.builtOnPrevious
              ? <>Updated from the previous analysis + <strong>{result.read.newMessages} new message{result.read.newMessages === 1 ? '' : 's'}</strong></>
              : <>Read the whole conversation — <strong>{result.read.newMessages} messages</strong>{result.read.contextChanged ? ' (business context changed, so it started fresh)' : ''}</>}
            {' '}({[result.read.fromUs && `${result.read.fromUs} from us`, result.read.fromThem && `${result.read.fromThem} from them`, result.read.voiceNotes && `${result.read.voiceNotes} voice note${result.read.voiceNotes === 1 ? '' : 's'}`].filter(Boolean).join(', ')})
            {result.read.lastMessageAt && <> · up to {new Date(result.read.lastMessageAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</>}.
          </div>
        )}
        {result && result.skipped && (
          <div style={{ fontSize: T.body, color: C.textSecondary, padding: '0 2px' }}>No new messages since the last analysis — nothing was charged.</div>
        )}
        {result && !result.skipped && (
          <div style={{ fontSize: T.meta, color: C.textSecondary, lineHeight: LH.snug, padding: '0 2px' }}>
            <IndianRupee size={13} style={{ verticalAlign: -2 }} />
            <strong style={{ fontFamily: MONO, color: C.text }}>{result.cost.inr.toFixed(4)}</strong> estimated for this run
            {' · '}{result.messagesAnalysed} message(s)
            {result.cost.reusedArtifacts > 0 && ` · ${result.cost.reusedArtifacts} media reused free`}
            {result.cost.newArtifacts > 0 && ` · ${result.cost.newArtifacts} newly read`}
            {!!result.skippedMedia?.length && (
              <div style={{ marginTop: 6, color: 'var(--c-warnText, #8a6d1f)' }}>
                <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                {result.skippedMedia.length} item(s) could not be read: {result.skippedMedia.slice(0, 3).map(s => s.reason).join('; ')}
              </div>
            )}
          </div>
        )}

        {!a ? (
          <Note tone="muted">
            Nothing has been analysed here yet. Pick what to read above and press Analyse — you will get a
            summary, the suggested next step, what is holding them back and what shows they want to buy.
          </Note>
        ) : (<>
          {/* The analysis in the order a salesperson reads it:
              1 Summary → 2 Problems → 3 Things to note → 4 Recommended actions.
              Analyses made before these lists existed (migration 125) derive
              each section from their older fields, so no conversation reads
              emptier than it did. */}
          {a.contextStale && (
            <Note tone="info">
              <span data-testid="ca-context-stale">
                The business context (products and details) has changed since this analysis. Press
                <strong> Update analysis</strong> to get recommendations and follow-ups that use it.
              </span>
            </Note>
          )}
          {!data.hasBusinessContext && (
            <Note tone="muted">
              Recommendations are generic because the analyzer does not know what you sell yet. Add your products in
              <strong> Chat Analyzer → Business context</strong>.
            </Note>
          )}

          <Section n={1} title="Summary" testid="ca-sec-summary">
            <div style={{ fontSize: T.bodyLg, lineHeight: LH.normal, color: C.text }}>{a.summary || '—'}</div>
          </Section>

          <Section n={2} title="Problems" tone="danger" icon={AlertTriangle} count={sections.problems.length} testid="ca-sec-problems">
            <Bullets items={sections.problems} tone="danger" empty={isGroup ? 'No open problems in this group.' : 'No problems raised so far.'} />
            {(a.replyReview || a.missed?.length > 0) && (
              <div data-testid="ca-our-replies" style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
                <div style={{ fontSize: T.meta, fontWeight: W.bold, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textSecondary, marginBottom: 6 }}>Our replies</div>
                {a.replyReview && <div style={{ fontSize: T.body, lineHeight: LH.normal, color: C.text, marginBottom: a.missed?.length ? 10 : 0 }}>{a.replyReview}</div>}
                {a.missed?.length > 0 && (<>
                  <div style={{ fontSize: T.meta, fontWeight: W.bold, color: TONES.danger.fg, marginBottom: 6 }}>What we missed</div>
                  <Bullets items={a.missed} tone="danger" />
                </>)}
              </div>
            )}
            {a.risk && (
              <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, background: TONES.warn.bg, fontSize: T.body, lineHeight: LH.snug, color: C.text }}>
                <strong style={{ color: TONES.warn.fg }}>Risk if nothing is done: </strong>{a.risk}
              </div>
            )}
          </Section>

          <Section n={3} title="Things to note" icon={StickyNote} count={sections.notes.length} testid="ca-sec-notes">
            {!!a.interestedProducts?.length && (
              <div data-testid="ca-interested" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <span style={{ fontSize: T.meta, fontWeight: W.bold, color: C.textSecondary }}>Interested in:</span>
                {a.interestedProducts.map((p, i) => (
                  <span key={i} style={{ padding: '5px 12px', borderRadius: 999, fontSize: T.body, fontWeight: W.bold, background: TONES.primary.bg, color: TONES.primary.fg }}>{p}</span>
                ))}
              </div>
            )}
            <div data-testid="ca-glance" style={{ display: 'grid', gap: 10, marginBottom: sections.notes.length || a.topics?.length ? 14 : 0, gridTemplateColumns: compact ? '1fr 1fr' : 'repeat(4, minmax(0, 1fr))' }}>
              {!isGroup && (
                <Glance label="Suggested stage">
                  <StageChip stageKey={a.suggestedStage} stages={stages} />
                  {currentStage && currentStage !== a.suggestedStage && (
                    <div style={{ fontSize: T.meta, color: C.textMuted, marginTop: 6 }}>
                      now: {funnelStageMeta(currentStage)?.label || currentStage}
                    </div>
                  )}
                </Glance>
              )}
              {!isGroup && <Glance label="Buying intent"><Meter level={a.intent} /></Glance>}
              <Glance label="Mood"><Mood value={a.sentiment} /></Glance>
              <Glance label="Confidence">
                <div style={{ fontSize: T.h2, fontWeight: W.bold, color: C.text, lineHeight: 1.1 }}>
                  {a.confidence != null ? `${Math.round(a.confidence * 100)}%` : '—'}
                </div>
                <div style={{ fontSize: T.meta, color: C.textMuted, marginTop: 4 }}>{a.analysedMessageCount || 0} messages read</div>
              </Glance>
            </div>
            {sections.notes.length > 0 && <Bullets items={sections.notes} />}
            {!!a.topics?.length && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: sections.notes.length ? 12 : 0 }}>
                {a.topics.map((t, i) => (
                  <span key={i} style={{
                    padding: '5px 11px', borderRadius: 999, fontSize: T.meta, fontWeight: W.medium,
                    background: 'var(--c-surfaceMuted)', color: C.textSecondary, lineHeight: LH.snug,
                  }}>{t}</span>
                ))}
              </div>
            )}
          </Section>

          <Section n={4} title="Recommended solution" tone="primary" icon={Target} count={sections.recommendations.length} testid="ca-sec-recs">
            {!isGroup && (
              <NextFollowUp
                key={`${conversationKey}-${a.lastRunAt || ''}`}
                waNumber={waNumber}
                contactNumber={conversationKey}
                name={a.displayName || conversationKey}
                suggestion={a.nextFollowUp}
                onSet={onFollowUpSet}
              />
            )}
            <Bullets items={sections.recommendations} numbered empty="Nothing to recommend yet." />
            {!!a.followUps?.length && (
              <div data-testid="ca-followups" style={{ marginTop: 16 }}>
                <div style={{ fontSize: T.meta, fontWeight: W.bold, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textSecondary, marginBottom: 8 }}>
                  Follow-up sequence until they convert
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {a.followUps.map((f, i) => <FollowUp key={i} f={f} step={i + 1} />)}
                </div>
              </div>
            )}
            {/* A group has many speakers and no single lead, so it never gets a
                stage suggestion. */}
            {!isGroup && a.suggestedStage && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
                <div style={{ fontSize: T.body, lineHeight: LH.normal, color: C.text }}>
                  <strong>Move to {funnelStageMeta(a.suggestedStage)?.label || a.suggestedStage}:</strong>{' '}
                  <span style={{ color: C.textSecondary }}>{a.stageReason || ''}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
                  {canApply ? (<>
                    <button data-testid="ca-apply-stage" onClick={applyStage} disabled={applying} style={{
                      padding: '8px 14px', borderRadius: 9, border: 'none', cursor: 'pointer',
                      background: 'var(--c-primary)', color: '#fff', fontFamily: FONT, fontSize: T.body, fontWeight: W.bold,
                    }}>Move lead to {funnelStageMeta(a.suggestedStage)?.label || a.suggestedStage}</button>
                    <button onClick={dismissStage} disabled={applying} style={{
                      padding: '8px 12px', borderRadius: 9, border: `1px solid ${C.border}`, background: 'transparent',
                      cursor: 'pointer', color: C.textSecondary, fontFamily: FONT, fontSize: T.body,
                    }}>Dismiss</button>
                  </>) : (
                    <span style={{ fontSize: T.meta, color: C.textMuted }}>
                      {a.suggestionState === 'applied' ? `Applied${a.appliedAt ? ` ${timeAgo(a.appliedAt)}` : ''}.`
                        : a.suggestionState === 'dismissed' ? 'Suggestion dismissed.'
                        : currentStage === a.suggestedStage ? 'The lead is already at this stage.'
                        : !leadId ? 'No lead is linked to this chat.' : ''}
                    </span>
                  )}
                </div>
              </div>
            )}
          </Section>

          {a.transcriptTruncated && (
            <Note tone="muted">
              This conversation was long enough to be trimmed. The opening messages and the most recent
              ones were kept; the middle was summarised out.
            </Note>
          )}

          <div style={{ fontSize: T.meta, color: C.textMuted }}>
            Last analysed {new Date(a.lastRunAt).toLocaleString('en-IN')} · {a.runCount} run{a.runCount === 1 ? '' : 's'}
            {a.modelUsed ? ` · ${a.modelUsed}` : ''} · a suggestion only — nothing changes on the lead until you move it.
          </div>
        </>)}
      </>}
    </div>
  );
}

// ── pieces of the overview ───────────────────────────────────────────────────

/**
 * Problems / things to note / recommendations. New analyses carry them as lists
 * (migration 125); older ones are built from the fields they do have, so a
 * conversation analysed last week does not suddenly read as having nothing.
 */
function deriveSections(a, isGroup) {
  if (!a) return { problems: [], notes: [], recommendations: [] };
  const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
  const hasNew = list(a.problems).length || list(a.notes).length || list(a.recommendations).length;
  if (hasNew) {
    return {
      problems: list(a.problems),
      notes: list(a.notes),
      recommendations: list(a.recommendations).length ? list(a.recommendations) : (a.nextAction ? [a.nextAction] : []),
    };
  }
  return {
    problems: isGroup ? list(a.openQuestions) : list(a.objections),
    notes: isGroup ? list(a.participants).map(p => `Active: ${p}`) : list(a.buyingSignals),
    recommendations: a.nextAction ? [a.nextAction] : [],
  };
}

/**
 * "When should we follow up?" — the analysis's suggested day, with one button to
 * put it on the calendar (Sales → Follow-up). Shows the follow-up already set when
 * there is one, and can ask the AI when an older analysis has no suggestion.
 */
function NextFollowUp({ waNumber, contactNumber, name, suggestion: initial, onSet }) {
  const [state, setState] = useState(null);           // { followUp, pinned }
  const [suggestion, setSuggestion] = useState(initial || null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(false);
  const load = useCallback(() => {
    api.followUps.chat(waNumber || '', contactNumber).then(setState).catch(() => setState({ followUp: null }));
  }, [waNumber, contactNumber]);
  useEffect(() => { load(); }, [load]);

  const ask = async () => {
    setBusy(true);
    try { setSuggestion(await api.followUps.suggest(waNumber || '', contactNumber)); }
    catch (e) { showError(e.message); }
    finally { setBusy(false); }
  };
  const add = async () => {
    setBusy(true);
    try {
      await api.followUps.set({
        waNumber, contactNumber, dueDate: suggestion.date, dueTime: suggestion.time || null,
        note: suggestion.note || '', source: 'ai', aiReason: suggestion.reason || null,
      });
      showSuccess(`Follow-up set for ${shortDate(suggestion.date)} — it is on the calendar in Follow-up.`);
      load(); onSet?.();
    } catch (e) { showError(e.message); }
    finally { setBusy(false); }
  };

  const fu = state?.followUp;
  const box = {
    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 14px', borderRadius: 12,
    border: `1.5px solid ${fu ? 'var(--c-successBorder, #B8DCCF)' : TONES.primary.fg}`,
    background: fu ? 'var(--c-successBg, #E1F5EE)' : 'var(--c-cardBg)', marginBottom: 14,
  };
  const btn = (primary) => ({
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 999,
    fontSize: T.meta, fontWeight: W.bold, cursor: busy ? 'wait' : 'pointer', fontFamily: FONT, whiteSpace: 'nowrap',
    border: primary ? 'none' : `1.5px solid ${C.border}`,
    background: primary ? C.primary : 'transparent', color: primary ? '#fff' : C.text,
  });

  return (
    <div data-testid="ca-next-followup" style={box}>
      <CalendarClock size={20} color={fu ? 'var(--c-successText, #0F6E56)' : TONES.primary.fg} style={{ flexShrink: 0 }} />
      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
        <div style={{ fontSize: T.label, fontWeight: W.bold, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textSecondary }}>
          {fu ? 'Next follow-up (on the calendar)' : 'Next follow-up'}
        </div>
        {fu ? (
          <div style={{ fontSize: T.bodyLg, fontWeight: W.bold, color: C.text, marginTop: 2 }}>
            {relativeDay(fu.dueDate)} · {shortDate(fu.dueDate)}{fu.dueTime ? `, ${time12(fu.dueTime)}` : ''}
            {fu.note && <div style={{ fontSize: T.body, fontWeight: W.normal, color: C.textSecondary, marginTop: 2 }}>{fu.note}</div>}
          </div>
        ) : suggestion ? (
          <div style={{ marginTop: 2 }}>
            <div style={{ fontSize: T.bodyLg, fontWeight: W.bold, color: C.text }}>
              <Sparkles size={13} color={C.purple} style={{ marginRight: 5, verticalAlign: '-1px' }} />
              AI suggests {relativeDay(suggestion.date, todayIST()).toLowerCase()} — {shortDate(suggestion.date)}{suggestion.time ? `, ${time12(suggestion.time)}` : ''}
            </div>
            {suggestion.reason && <div style={{ fontSize: T.body, color: C.textSecondary, lineHeight: LH.snug, marginTop: 2 }}>{suggestion.reason}</div>}
          </div>
        ) : (
          <div style={{ fontSize: T.body, color: C.textSecondary, marginTop: 2 }}>No date yet — let the AI pick the best day from this chat.</div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {fu ? (
          <button type="button" onClick={() => setModal(true)} style={btn(false)}>Change</button>
        ) : suggestion ? (
          <>
            <button type="button" data-testid="ca-followup-add" onClick={add} disabled={busy} style={btn(true)}>
              {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <CalendarClock size={13} />} Add to calendar
            </button>
            <button type="button" onClick={() => setModal(true)} style={btn(false)}>Pick another day</button>
          </>
        ) : (
          <button type="button" data-testid="ca-followup-suggest" onClick={ask} disabled={busy} style={btn(true)}>
            {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Sparkles size={13} />} {busy ? 'Reading the chat…' : 'Suggest a date'}
          </button>
        )}
      </div>
      {modal && (
        <FollowUpModal
          waNumber={waNumber || ''}
          contactNumber={contactNumber}
          name={name}
          existing={fu || null}
          suggestion={fu ? null : suggestion}
          onClose={() => setModal(false)}
          onSaved={() => { load(); onSet?.(); }}
        />
      )}
    </div>
  );
}

/** A drafted WhatsApp follow-up, with when to send it and a Copy button. */
function FollowUp({ f, step }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(f.message);
      else {
        // Fallback for a non-secure context, where navigator.clipboard is absent.
        const ta = document.createElement('textarea');
        ta.value = f.message; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy'); ta.remove();
        if (!ok) throw new Error('copy failed');
      }
      setCopied(true); setTimeout(() => setCopied(false), 1600);
    } catch { showError('Could not copy — select the text and copy it instead.'); }
  };
  return (
    <div style={{ borderRadius: 10, border: `1px solid ${C.border}`, background: 'var(--c-cardBg)', padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        {step && <span style={{ minWidth: 20, height: 20, borderRadius: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: T.label, fontWeight: W.bold, background: TONES.primary.bg, color: TONES.primary.fg }}>{step}</span>}
        {f.when && <span style={{ fontSize: T.label, fontWeight: W.bold, textTransform: 'uppercase', letterSpacing: '.04em', color: TONES.primary.fg }}>{f.when}</span>}
        <div style={{ flex: 1 }} />
        <button type="button" onClick={copy} data-testid="ca-followup-copy" style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 8,
          border: `1px solid ${C.border}`, background: 'transparent', cursor: 'pointer',
          color: copied ? 'var(--c-successText)' : C.textSecondary, fontFamily: FONT, fontSize: T.meta, fontWeight: W.medium,
        }}>
          {copied ? <CheckIcon size={13} /> : <Copy size={13} />}{copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div style={{ fontSize: T.body, lineHeight: LH.normal, color: C.text, whiteSpace: 'pre-wrap' }}>{f.message}</div>
    </div>
  );
}

function Section({ n, title, tone, icon: Icon, count, testid, children }) {
  const t = tone ? TONES[tone] : null;
  return (
    <section data-testid={testid} style={{
      borderRadius: 12, padding: 16, border: `1px solid ${C.border}`, background: 'var(--c-surfaceSection)',
      borderLeft: `4px solid ${t ? t.fg : C.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{
          width: 22, height: 22, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: T.label, fontWeight: W.bold, background: t ? t.bg : 'var(--c-surfaceMuted)', color: t ? t.fg : C.textSecondary,
        }}>{n}</span>
        {Icon && <Icon size={16} color={t ? t.fg : C.textSecondary} />}
        <span style={{ fontSize: T.body, fontWeight: W.bold, color: C.text }}>{title}</span>
        {count > 0 && <span style={{ fontSize: T.meta, color: C.textMuted }}>· {count}</span>}
      </div>
      {children}
    </section>
  );
}

function Bullets({ items, tone, numbered, empty }) {
  const t = tone ? TONES[tone] : null;
  if (!items?.length) return empty ? <div style={{ fontSize: T.body, color: C.textMuted }}>{empty}</div> : null;
  return (
    <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((x, i) => (
        <li key={i} style={{ display: 'flex', gap: 10, fontSize: T.body, lineHeight: LH.snug, color: C.text }}>
          {numbered
            ? <span style={{ minWidth: 20, height: 20, borderRadius: 6, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: T.label, fontWeight: W.bold, background: TONES.primary.bg, color: TONES.primary.fg }}>{i + 1}</span>
            : <span style={{ width: 6, height: 6, borderRadius: 999, marginTop: 8, flexShrink: 0, background: t ? t.fg : C.textMuted }} />}
          <span>{x}</span>
        </li>
      ))}
    </ol>
  );
}

function timeAgo(ts) {
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString('en-IN');
}

const TONES = {
  primary: { bg: 'var(--c-primaryLight)', fg: 'var(--c-primary)' },
  warn: { bg: 'var(--c-warnBg, #FFF8E1)', fg: 'var(--c-warnText, #8a6d1f)' },
  danger: { bg: 'var(--c-dangerBg)', fg: 'var(--c-dangerText)' },
  success: { bg: 'var(--c-successBg)', fg: 'var(--c-successText)' },
};

function Card({ children, tone, icon: Icon, title, pad = 16 }) {
  const t = tone ? TONES[tone] : null;
  return (
    <div style={{
      borderRadius: 12, padding: pad, border: `1px solid ${C.border}`,
      background: t ? t.bg : 'var(--c-surfaceSection)',
    }}>
      {title && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8,
          fontSize: T.meta, fontWeight: W.bold, textTransform: 'uppercase', letterSpacing: '.05em',
          color: t ? t.fg : C.textSecondary,
        }}>
          {Icon && <Icon size={15} />}{title}
        </div>
      )}
      {children}
    </div>
  );
}

function Glance({ label, children }) {
  return (
    <div style={{ borderRadius: 12, padding: '12px 14px', border: `1px solid ${C.border}`, background: 'var(--c-surfaceSection)', minWidth: 0 }}>
      <div style={{ fontSize: T.meta, fontWeight: W.bold, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textMuted, marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
}

// Buying intent as a 4-step meter, so "medium" reads as a position on a scale
// rather than a word to interpret.
const INTENT_LEVELS = ['none', 'low', 'medium', 'high'];
function Meter({ level }) {
  const i = INTENT_LEVELS.indexOf(level);
  const color = i >= 3 ? 'var(--c-successText)' : i === 2 ? 'var(--c-warnText, #b8860b)' : 'var(--c-dangerText)';
  return (
    <div>
      <div style={{ fontSize: T.bodyLg, fontWeight: W.bold, color: i < 0 ? C.textMuted : color, textTransform: 'capitalize' }}>{level || '—'}</div>
      <div style={{ display: 'flex', gap: 4, marginTop: 7 }}>
        {[1, 2, 3].map(n => (
          <span key={n} style={{ flex: 1, height: 6, borderRadius: 3, background: i >= n ? color : 'var(--c-surfaceMuted)' }} />
        ))}
      </div>
    </div>
  );
}

function Mood({ value }) {
  const tone = value === 'positive' ? TONES.success : value === 'negative' ? TONES.danger : TONES.warn;
  return (
    <span style={{
      display: 'inline-block', padding: '5px 12px', borderRadius: 999, background: value ? tone.bg : 'var(--c-surfaceMuted)',
      color: value ? tone.fg : C.textMuted, fontSize: T.body, fontWeight: W.bold, textTransform: 'capitalize',
    }}>{value || '—'}</span>
  );
}

function RunList({ runs }) {
  if (!runs.length) return <Note tone="muted">No runs yet.</Note>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {runs.map(r => (
        <div key={r.id} style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          fontSize: T.meta, color: C.textSecondary, padding: '10px 13px', borderRadius: 9,
          background: 'var(--c-surfaceInner)',
        }}>
          <Clock size={14} />
          <span style={{ fontFamily: MONO }}>{new Date(r.startedAt).toLocaleString('en-IN')}</span>
          <StatusDot status={r.status} />
          <span>{r.status === 'skipped' ? 'nothing new' : `${r.messagesAnalysed || 0} msg`}</span>
          {r.scoped && <Tag>filtered</Tag>}
          {r.incremental && <Tag>incremental</Tag>}
          {(r.modalities || []).filter(m => m !== 'text').map(m => <Tag key={m}>{m}</Tag>)}
          <span style={{ marginLeft: 'auto', fontFamily: MONO, fontWeight: W.medium, color: C.text }}>
            ₹{Number(r.costInr || 0).toFixed(4)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── the transcript ────────────────────────────────────────────────────────────
//
// Derived on read: the audio→text conversion is cached permanently, but the
// assembled conversation is rebuilt each time so it always includes the newest
// messages.

function TranscriptView({ source, conversationKey, compact }) {
  const [t, setT] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    setT(null);
    try {
      setT(await api.chatAnalyzer.transcript({ source, key: conversationKey, from: from || undefined, to: to || undefined }));
    } catch (e) { showError(e.message); setT(null); }
  }, [source, conversationKey, from, to]);

  useEffect(() => { load(); }, [load]);

  const transcribe = async () => {
    setBusy(true);
    try {
      const r = await api.chatAnalyzer.transcribe({ source, conversationKey, from: from || undefined, to: to || undefined });
      showSuccess(r.transcribed
        ? `Transcribed ${r.transcribed} voice note${r.transcribed === 1 ? '' : 's'} for ₹${r.costInr.toFixed(4)}.`
        : 'Nothing left to transcribe.');
      await load();
    } catch (e) { showError(e.message); } finally { setBusy(false); }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(t.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { showError('Could not copy — your browser blocked clipboard access.'); }
  };

  if (!t) return <div style={{ padding: 20, color: C.textMuted, fontSize: T.body }}>Loading the transcript…</div>;

  const c = t.counts;
  const est = t.estimate || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: T.meta, color: C.textSecondary }}>
          <strong style={{ color: C.text }}>{c.messages}</strong> messages
          {c.audioTranscribed > 0 && ` · ${c.audioTranscribed} voice note${c.audioTranscribed === 1 ? '' : 's'} transcribed`}
          {c.images > 0 && ` · ${c.images} image${c.images === 1 ? '' : 's'}`}
          {c.documents > 0 && ` · ${c.documents} document${c.documents === 1 ? '' : 's'}`}
        </span>
        <button onClick={copy} title="Copy the whole transcript" style={{
          marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '7px 12px', borderRadius: 8, cursor: 'pointer',
          border: `1px solid ${C.border}`, background: 'var(--c-cardBg)', color: C.text,
          fontFamily: FONT, fontSize: T.meta, fontWeight: W.medium,
        }}>
          {copied ? <CheckIcon size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={{ fontSize: T.meta, fontWeight: W.medium, color: C.textSecondary }}>
          From
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ ...inputSm, marginTop: 5 }} />
        </label>
        <label style={{ fontSize: T.meta, fontWeight: W.medium, color: C.textSecondary }}>
          To
          <input type="date" value={to} onChange={e => setTo(e.target.value)} min={from || undefined} style={{ ...inputSm, marginTop: 5 }} />
        </label>
      </div>

      {/* Nothing is spent until this is pressed, and the figure is on the
          button rather than behind a confirm nobody reads. */}
      {est.pending > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: '13px 15px', borderRadius: 10,
          background: 'var(--c-warnBg, #FFF8E1)', color: 'var(--c-warnText, #8a6d1f)',
          fontSize: T.body, lineHeight: LH.normal,
        }}>
          <FileAudio size={IC.section} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 200 }}>
            {est.pending} voice note{est.pending === 1 ? '' : 's'} in this range {est.pending === 1 ? 'has' : 'have'} not been
            transcribed yet, so {est.pending === 1 ? 'it is' : 'they are'} shown as gaps below.
          </span>
          <button onClick={transcribe} disabled={busy} style={{
            padding: '10px 15px', borderRadius: 9, border: 'none',
            cursor: busy ? 'default' : 'pointer', background: 'var(--c-primary)', color: '#fff',
            fontFamily: FONT, fontSize: T.body, fontWeight: W.bold, opacity: busy ? 0.7 : 1,
            display: 'inline-flex', alignItems: 'center', gap: 8,
          }}>
            {busy
              ? <><Loader2 size={IC.inline} style={{ animation: 'spin 1s linear infinite' }} /> Transcribing…</>
              : <>Transcribe {est.pending} (~₹{est.inr.toFixed(2)})</>}
          </button>
        </div>
      )}

      {t.truncated && (
        <Note tone="info">
          This conversation is longer than the transcript view shows. The most recent {c.messages} messages
          are listed.
        </Note>
      )}

      {!t.entries.length ? (
        <Note tone="muted">No messages in this range.</Note>
      ) : (
        <div style={{
          border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden',
          background: 'var(--c-cardBg)',
        }}>
          {t.entries.map((e, i) => <TranscriptRow key={e.messageId || i} e={e} compact={compact} />)}
        </div>
      )}

      {/* Stated once, plainly: transcribing is reading, not analysing. */}
      <div style={{ fontSize: T.meta, color: C.textMuted, lineHeight: LH.normal }}>
        Transcribing here fills the permanent cache and costs nothing to read again — but it does not
        update the Analysis summary. Run an analysis with voice notes ticked for that.
      </div>
    </div>
  );
}

function TranscriptRow({ e, compact }) {
  const out = e.direction === 'out';
  const stamp = new Date(e.at).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return (
    <div style={{
      display: 'flex', gap: 12, padding: '12px 14px',
      borderBottom: `1px solid ${C.border}`,
      background: out ? 'var(--c-surfaceInner)' : 'transparent',
      alignItems: 'flex-start',
    }}>
      <span style={{
        fontFamily: MONO, fontSize: T.meta, color: C.textMuted,
        whiteSpace: 'nowrap', flexShrink: 0, minWidth: compact ? 0 : 92, paddingTop: 1,
      }}>{stamp}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3, flexWrap: 'wrap' }}>
          <span style={{ fontSize: T.meta, fontWeight: W.bold, color: out ? C.textSecondary : 'var(--c-primary)' }}>
            {e.speaker}
          </span>
          {e.isTranscript && <Tag>voice note</Tag>}
          {e.type === 'image' && <Tag>image</Tag>}
          {e.type === 'document' && <Tag>document</Tag>}
          {e.library && <Tag>Media Library</Tag>}
        </div>
        {e.library && (
          <div data-testid="library-context" style={{ fontSize: T.body, lineHeight: LH.normal, color: C.text, marginBottom: e.text && e.isTranscript ? 4 : 0 }}>
            <strong>{e.library.name}</strong>
            {e.library.description
              ? <span style={{ color: C.textSecondary }}> — {e.library.description}</span>
              : <span style={{ color: C.textMuted, fontStyle: 'italic' }}> — no description yet (add one in Media Library)</span>}
          </div>
        )}
        {e.library && !e.isTranscript ? null : e.text ? (
          <div style={{ fontSize: T.body, lineHeight: LH.normal, color: C.text, whiteSpace: 'pre-wrap' }}>{e.text}</div>
        ) : (
          <div style={{ fontSize: T.body, lineHeight: LH.normal, color: C.textMuted, fontStyle: 'italic' }}>
            {e.pending ? 'Voice note — not transcribed yet'
              : e.unreadable ? `Voice note — ${e.note}`
              : e.type === 'image' ? (e.caption ? `Image — ${e.caption}` : 'Image')
              : e.type === 'document' ? (e.filename ? `Document — ${e.filename}` : 'Document')
              : 'No text'}
          </div>
        )}
      </div>
    </div>
  );
}

// ── small pieces ──────────────────────────────────────────────────────────────

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: T.meta, fontWeight: W.bold, textTransform: 'uppercase', letterSpacing: '.05em',
      color: C.textSecondary, marginBottom: 9,
    }}>{children}</div>
  );
}

function StageChip({ stageKey, stages }) {
  // Reads the LIVE funnel config, so a renamed or recoloured stage shows its
  // current label rather than the key the model returned.
  const meta = funnelStageMeta(stageKey) || (stages || []).find(s => s.stageKey === stageKey);
  return (
    <span style={{
      padding: '7px 14px', borderRadius: 999, fontSize: T.body, fontWeight: W.bold,
      background: 'var(--c-surfaceMuted)', color: C.text, border: `1px solid ${C.border}`,
    }}>{meta?.label || stageKey}</span>
  );
}

function StatusDot({ status }) {
  const color = status === 'ok' ? 'var(--c-successText)' : status === 'error' ? 'var(--c-dangerText)' : C.textMuted;
  return <span title={status} style={{ width: 9, height: 9, borderRadius: 999, background: color, display: 'inline-block' }} />;
}

function Tag({ children }) {
  return (
    <span style={{
      padding: '3px 8px', borderRadius: 6, fontSize: T.micro, fontWeight: W.bold,
      textTransform: 'uppercase', letterSpacing: '.03em',
      background: 'var(--c-surfaceMuted)', color: C.textSecondary,
    }}>{children}</span>
  );
}

function Note({ tone, children }) {
  const bg = tone === 'info' ? 'var(--c-infoBg, #EAF2FB)' : 'var(--c-surfaceInner)';
  const fg = tone === 'info' ? 'var(--c-infoText, #1D4E79)' : C.textSecondary;
  return (
    <div style={{ fontSize: T.body, lineHeight: LH.normal, padding: '13px 15px', borderRadius: 10, background: bg, color: fg }}>
      {children}
    </div>
  );
}
