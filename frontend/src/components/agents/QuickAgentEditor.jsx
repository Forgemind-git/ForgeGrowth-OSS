import { useState, useEffect, useMemo, useRef } from 'react';
import { Zap, Loader2, Save, ChevronDown, Settings2, RotateCcw, AlertCircle, ExternalLink, CheckCircle2 } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO, T, W, LH, maskPhone } from '../../constants.js';
import SearchableSelect from '../SearchableSelect.jsx';
import PillStrip from '../PillStrip.jsx';
import Toggle from '../Toggle.jsx';
import AgentLivePreview from './AgentLivePreview.jsx';
import { BLANK, buildAgentPayload } from './AgentEditor.jsx';
import { modelsForProvider, providerDisplay, isAgentProvider, defaultModelFor } from './modelCatalog.js';
import { TONES, LANGUAGES, initialAnswers, missingAnswers } from './quickAgents.js';

const TRIGGERS = [
  { value: 'any', label: 'Every message on this number' },
  { value: 'new', label: 'New conversations only' },
  { value: 'keyword', label: 'Only when they send a keyword' },
];

/**
 * Quick AI Agent — one screen, like Social's Quick Automation editor.
 *
 * Left: name, number, when it replies, a few plain questions about the
 * business, tone and language. Right: the real test chat. Footer: Live switch
 * and Save. The answers compose the instructions (`template.build`); the
 * composed text is shown under "Instructions it will follow" and, once edited
 * by hand, stays the operator's own (`customPrompt`).
 *
 * It saves an ordinary agent through the SAME `buildAgentPayload` as the full
 * editor, so everything else (tools, limits, test numbers, media) is still one
 * click away under "All settings" and nothing about a quick agent is special.
 */
export default function QuickAgentEditor({ template, waAccounts, user, navigate, onDone, onOpenFull }) {
  const isAdmin = user?.role === 'admin';
  const [liveId, setLiveId] = useState(null);
  const [name, setName] = useState(template.name);
  const [waAccountId, setWaAccountId] = useState(waAccounts.length === 1 ? String(waAccounts[0].id) : '');
  const [triggerMode, setTriggerMode] = useState(template.triggerMode || 'any');
  const [keyword, setKeyword] = useState(template.keyword || '');
  const [answers, setAnswers] = useState(() => initialAnswers(template));
  const [tone, setTone] = useState('friendly');
  const [language, setLanguage] = useState('match');
  const [customPrompt, setCustomPrompt] = useState(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [aiModels, setAiModels] = useState(null);
  const [aiModelId, setAiModelId] = useState('');
  const [llmModel, setLlmModel] = useState('');
  const [goLive, setGoLive] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedNote, setSavedNote] = useState('');
  const firstField = useRef(null);

  useEffect(() => {
    api.aiModels.list().catch(() => []).then(list => {
      const usable = (list || []).filter(m => isAgentProvider(m.provider));
      setAiModels(usable);
      if (usable[0]) { setAiModelId(String(usable[0].id)); setLlmModel(defaultModelFor(usable[0].provider)); }
    });
    firstField.current?.focus();
  }, []);

  const composed = useMemo(() => template.build(answers, { tone, language }), [template, answers, tone, language]);
  const systemPrompt = customPrompt ?? composed;
  const modelRow = (aiModels || []).find(m => String(m.id) === String(aiModelId));

  // What still stands between this agent and answering customers. The same
  // three the server enforces (name, model, keyword) plus the two that make it
  // useless if missing (a number, the business answers).
  const missing = [
    ...(!name.trim() ? ['a name'] : []),
    ...(!waAccountId ? ['a WhatsApp number'] : []),
    ...(triggerMode === 'keyword' && !keyword.trim() ? ['the keyword'] : []),
    ...(customPrompt == null ? missingAnswers(template, answers).map(l => l.toLowerCase()) : []),
    ...(!aiModelId || !llmModel ? ['an AI model'] : []),
  ];
  const canGoLive = missing.length === 0;

  const save = async (wantLive) => {
    setSaving(true); setError(''); setSavedNote('');
    try {
      const form = {
        ...BLANK,
        name: name.trim() || template.name,
        description: template.body,
        systemPrompt,
        aiModelId, llmModel,
        waAccountId,
        isActive: wantLive,
        triggerMode,
        triggerKeyword: triggerMode === 'keyword' ? keyword.trim() : '',
      };
      const payload = buildAgentPayload(form, isAdmin);
      let id = liveId;
      if (id == null) {
        const created = await api.agents.create(payload);
        id = created.id;
        setLiveId(id);
      } else {
        await api.agents.update(id, payload);
      }
      setIsActive(!!(wantLive && payload.status === 'active'));
      setSavedNote(wantLive ? 'Saved and live — it is answering WhatsApp messages now.' : 'Saved as a draft. Try it in the phone on the right.');
      return id;
    } catch (e) {
      setError(e.message || 'Could not save the agent.');
      return null;
    } finally {
      setSaving(false);
    }
  };

  const openFull = async () => {
    const id = liveId ?? await save(false);
    if (id != null) onOpenFull(id);
  };

  const set = (k) => (v) => setAnswers(a => ({ ...a, [k]: v }));
  const single = template.fields.filter(f => !f.multiline);
  const multi = template.fields.filter(f => f.multiline);

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, width: '100%', fontFamily: FONT }}>
      <div style={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div data-testid="quick-form" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 24px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Title row */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: T.label, fontWeight: W.bold, letterSpacing: '.06em', textTransform: 'uppercase', color: C.textMuted }}>
              <Zap size={12} /> Quick AI Agent · {template.title}
            </div>
            <input ref={firstField} value={name} onChange={e => setName(e.target.value)} placeholder="Name your agent" aria-label="Agent name" data-testid="quick-name"
              style={{ marginTop: 4, width: '100%', border: 'none', outline: 'none', background: 'transparent', fontFamily: FONT, fontSize: T.h2, fontWeight: W.heavy, color: C.text, padding: 0 }} />
          </div>

          {error && <Banner tone="danger">{error}</Banner>}
          {savedNote && <Banner tone="success" testId="quick-saved">{savedNote}</Banner>}

          {/* Where and when */}
          <Card>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
              <Q label="Answers on">
                <SearchableSelect value={waAccountId} onChange={setWaAccountId} placeholder="Pick a WhatsApp number"
                  options={waAccounts.map(w => ({ value: String(w.id), label: w.displayName || maskPhone(w.displayPhoneNumber), sublabel: w.displayPhoneNumber ? maskPhone(w.displayPhoneNumber) : undefined }))} />
              </Q>
              <Q label="Replies to">
                <SearchableSelect value={triggerMode} onChange={setTriggerMode} options={TRIGGERS} />
              </Q>
              {triggerMode === 'keyword' && (
                <Q label="Keyword">
                  <input value={keyword} onChange={e => setKeyword(e.target.value.slice(0, 200))} placeholder="e.g. PRICE" data-testid="quick-keyword" style={inputStyle} />
                </Q>
              )}
            </div>
          </Card>

          {/* About the business — the only thing a first-timer really has to type. */}
          <Card title="About your business" note={customPrompt != null ? 'You edited the instructions by hand, so these answers no longer change them.' : 'Your answers become the agent’s instructions.'}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
              {single.map(f => (
                <Q key={f.key} label={f.label} required={f.required}>
                  <input value={answers[f.key]} onChange={e => set(f.key)(e.target.value)} placeholder={f.placeholder} data-answer={f.key} style={inputStyle} disabled={customPrompt != null} />
                </Q>
              ))}
            </div>
            {multi.map(f => (
              <div key={f.key} style={{ marginTop: 12 }}>
                <Q label={f.label} required={f.required}>
                  <textarea value={answers[f.key]} onChange={e => set(f.key)(e.target.value)} placeholder={f.placeholder} rows={2} data-answer={f.key}
                    style={{ ...inputStyle, resize: 'vertical', lineHeight: LH.normal }} disabled={customPrompt != null} />
                </Q>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 14 }}>
              <Q label="Tone"><PillStrip size="sm" value={tone} onChange={setTone} items={TONES.map(t => ({ id: t.id, label: t.label }))} /></Q>
              <Q label="Language"><PillStrip size="sm" value={language} onChange={setLanguage} items={LANGUAGES.map(l => ({ id: l.id, label: l.label }))} /></Q>
            </div>
          </Card>

          {/* The composed prompt, for anyone who wants to read or tweak it. */}
          <Card>
            <button type="button" onClick={() => setShowPrompt(o => !o)} data-testid="quick-show-prompt"
              style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: FONT, fontSize: T.body, fontWeight: W.bold, color: C.text }}>
              <ChevronDown size={15} style={{ transform: showPrompt ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
              Instructions it will follow
              <span style={{ fontWeight: W.normal, color: C.textMuted, fontSize: T.meta }}>{customPrompt != null ? '· edited by you' : '· written from your answers'}</span>
              {customPrompt != null && (
                <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); setCustomPrompt(null); }}
                  style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, color: C.primary, fontSize: T.meta, fontWeight: W.bold }}>
                  <RotateCcw size={12} /> Use my answers again
                </span>
              )}
            </button>
            {showPrompt && (
              <textarea value={systemPrompt} onChange={e => setCustomPrompt(e.target.value)} rows={9} data-testid="quick-prompt"
                style={{ ...inputStyle, marginTop: 10, fontFamily: MONO, fontSize: T.meta, lineHeight: LH.normal, resize: 'vertical' }} />
            )}
          </Card>

          {/* The model — pre-picked; only shown as a problem when there is none. */}
          {aiModels && aiModels.length === 0 ? (
            <Banner tone="warn">
              <AlertCircle size={14} style={{ verticalAlign: 'text-bottom' }} /> No AI model is connected yet, so this agent can be saved but not go live.{' '}
              {navigate && <a href="#/admin-settings/ai-models" style={{ color: 'inherit', fontWeight: W.bold }}>Connect one in AI Models <ExternalLink size={11} /></a>}
            </Banner>
          ) : aiModels && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: T.meta, color: C.textSecondary }}>
              <span>AI model</span>
              <div style={{ width: 230 }}>
                <SearchableSelect value={aiModelId} triggerStyle={{ padding: '6px 10px', fontSize: T.meta }}
                  onChange={(v) => { setAiModelId(v); const r = aiModels.find(m => String(m.id) === String(v)); setLlmModel(defaultModelFor(r?.provider)); }}
                  options={aiModels.map(m => ({ value: String(m.id), label: providerDisplay(m.provider, m.label) }))} />
              </div>
              <div style={{ width: 230 }}>
                <SearchableSelect value={llmModel} onChange={setLlmModel} triggerStyle={{ padding: '6px 10px', fontSize: T.meta }}
                  options={modelsForProvider(modelRow?.provider).map(m => ({ value: m.value, label: m.label, sublabel: m.recommended ? 'Recommended' : undefined }))} />
              </div>
            </div>
          )}
        </div>

        {/* Footer — like Social's: what is missing, Live, Save. */}
        <div style={{ flexShrink: 0, padding: '10px 24px 12px', borderTop: `1px solid ${C.border}`, background: C.pageBg }}>
          <div data-testid="quick-missing" style={{ fontSize: T.meta, lineHeight: LH.snug, marginBottom: 8, color: canGoLive ? C.successText : C.textMuted }}>
            {canGoLive
              ? <><CheckCircle2 size={13} style={{ verticalAlign: 'text-bottom' }} /> Ready to go live</>
              : <>To go live: add {missing.join(', ')}.</>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={openFull} disabled={saving} data-testid="quick-all-settings"
              title="Tools, files to send, limits, test numbers and more — saves this agent first"
              style={{ ...ghostBtn }}>
              <Settings2 size={14} /> All settings
            </button>
            <div style={{ flex: 1 }} />
            <label title={canGoLive ? 'Answer WhatsApp messages as soon as you save' : `Still needed: ${missing.join(', ')}`}
              style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: T.body, fontWeight: W.bold, color: goLive && canGoLive ? C.successText : C.textSecondary, cursor: canGoLive ? 'pointer' : 'not-allowed' }}>
              Live <Toggle checked={goLive && canGoLive} disabled={!canGoLive} onChange={setGoLive} />
            </label>
            <button type="button" onClick={onDone} style={ghostBtn}>{liveId ? 'Done' : 'Cancel'}</button>
            <button type="button" data-testid="quick-save" onClick={() => save(goLive && canGoLive)} disabled={saving}
              style={{ flexShrink: 0, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 18px', borderRadius: 10, border: 'none', background: C.primary, color: '#fff', fontFamily: FONT, fontSize: T.bodyLg, fontWeight: W.bold, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1 }}>
              {saving ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={14} />}
              {goLive && canGoLive ? 'Save & go live' : (liveId ? 'Save' : 'Save draft')}
            </button>
          </div>
        </div>
      </div>

      {/* Right — the real test chat, pinned. Works once the agent is saved. */}
      <aside style={{ flex: '0 0 356px', height: '100%', minHeight: 0, borderLeft: `1px solid ${C.border}`, background: C.sidebarBg, display: 'flex', justifyContent: 'center', padding: '14px 12px 16px', boxSizing: 'border-box', overflow: 'hidden' }}>
        <AgentLivePreview
          agentId={liveId}
          headerTitle={name || template.name}
          canTest={liveId != null}
          fill
          hint={liveId != null
            ? (isActive ? 'Live on WhatsApp. This test chat runs the same agent — nothing is sent from here.' : 'Chat with your agent here. Nothing is sent to WhatsApp.')
            : 'Press Save draft, then chat with your agent here. Nothing is sent to WhatsApp.'}
        />
      </aside>
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 8, border: `1px solid ${C.border}`, fontSize: T.body,
  fontFamily: FONT, color: C.text, background: C.cardBg, outline: 'none', boxSizing: 'border-box',
};
const ghostBtn = {
  flexShrink: 0, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 10,
  border: `1px solid ${C.border}`, background: C.cardBg, color: C.text, fontFamily: FONT,
  fontSize: T.body, fontWeight: W.medium, cursor: 'pointer',
};

function Card({ title, note, children }) {
  return (
    <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: '14px 16px' }}>
      {title && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: T.bodyLg, fontWeight: W.bold, color: C.text }}>{title}</div>
          {note && <div style={{ fontSize: T.meta, color: C.textMuted, marginTop: 2 }}>{note}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

function Q({ label, required, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: T.label, fontWeight: W.bold, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
        {label}{required && <span style={{ color: C.primary }}> *</span>}
      </div>
      {children}
    </div>
  );
}

function Banner({ tone, children, testId }) {
  const map = {
    danger: [C.dangerBg, C.dangerText], success: [C.successBgSoft, C.successText], warn: [C.warnBg, C.warnText],
  }[tone];
  return (
    <div data-testid={testId} style={{ padding: '10px 14px', borderRadius: 10, background: map[0], color: map[1], fontSize: T.body, fontWeight: W.medium, lineHeight: LH.snug }}>
      {children}
    </div>
  );
}
