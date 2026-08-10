// Public Lead Form filler — no auth, no Topbar/Sidebar. Reached via
// /f/<slug> (generic share) or /f/<slug>/<token> (a per-recipient WhatsApp
// link, whose token silently carries the phone number so the visitor is
// never asked for it). Real paths, not #hash URLs — Meta rejects template URL
// buttons containing '#'; nginx serves /f/* as the SPA and App.jsx reads the
// slug+token from the pathname (legacy #/f/... links still resolve too).
// Renders whatever fields the admin configured in the builder — no preset forms.
import { useState, useEffect } from 'react';
import { Check, Loader2, AlertTriangle, Star } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, maskPhone } from '../constants.js';
import { isEmptyAnswer, emptyAnswerFor, isDisplayOnly, normalizeRating, DEFAULT_FEEDBACK_LABEL } from '../lib/formAnswers.js';

const inputStyle = {
  width: '100%', padding: '11px 13px', borderRadius: 10, border: `1.5px solid ${C.border}`,
  fontFamily: FONT, fontSize: 14.5, boxSizing: 'border-box', outline: 'none', background: C.cardBg, color: C.text,
};

export default function PublicLeadFormPage({ slug, token }) {
  const [state, setState] = useState('loading'); // loading | ready | notfound | error | submitting | done
  const [form, setForm] = useState(null);
  const [prefillPhone, setPrefillPhone] = useState(null);
  const [answers, setAnswers] = useState({});
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  useEffect(() => {
    api.publicLeadForms.get(slug, token)
      .then(res => {
        setForm(res.form);
        setPrefillPhone(res.prefillPhone || null);
        const init = {};
        // Seeded per type — a rating needs its { rating, feedback } shape from
        // the start, or the feedback box mounts uncontrolled and React warns
        // (and moves the cursor) on the first keystroke.
        for (const f of res.form.fields) {
          if (!isDisplayOnly(f.type)) init[f.key] = emptyAnswerFor(f);
        }
        setAnswers(init);
        setState('ready');
      })
      .catch(() => setState('notfound'));
  }, [slug, token]);

  function setAnswer(key, value) {
    setAnswers(a => ({ ...a, [key]: value }));
    setFieldErrors(e => ({ ...e, [key]: null }));
  }

  // A field the builder mapped to phone IS the voluntary phone section — it is
  // already rendered below like any other field, so there is never a second
  // prompt. A link form with no such field is a perfectly valid anonymous
  // form; the Phone column simply stays empty.

  async function submit() {
    const errs = {};
    for (const f of form.fields) {
      // Same rule the server enforces (lib/formAnswers.js). If these two ever
      // disagree the respondent gets a 400 for a field that looked filled in.
      if (f.required && isEmptyAnswer(f, answers[f.key])) errs[f.key] = 'Required';
    }
    if (Object.keys(errs).length) { setFieldErrors(errs); return; }

    setState('submitting');
    setSubmitError('');
    try {
      const res = await api.publicLeadForms.submit(slug, answers, token);
      setSuccessMessage(res.successMessage || 'Thanks — your response has been recorded.');
      setState('done');
    } catch (e) {
      setSubmitError(e.message || 'Something went wrong. Please try again.');
      setState('ready');
    }
  }

  if (state === 'loading') {
    return (
      <Shell>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '60px 0', color: C.textMuted }}>
          <Loader2 size={22} className="spin" />
          <span style={{ fontFamily: FONT, fontSize: 13 }}>Loading form…</span>
        </div>
        <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } } .spin { animation: spin 1s linear infinite; }`}</style>
      </Shell>
    );
  }

  if (state === 'notfound') {
    return (
      <Shell>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '60px 20px', textAlign: 'center' }}>
          <AlertTriangle size={30} color={C.textMuted} />
          <div style={{ fontFamily: FONT, fontSize: 15, fontWeight: 700, color: C.text }}>This form isn't available</div>
          <div style={{ fontFamily: FONT, fontSize: 13, color: C.textMuted }}>It may have been closed, or the link is incorrect.</div>
        </div>
      </Shell>
    );
  }

  if (state === 'done') {
    return (
      <Shell form={form}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '50px 20px', textAlign: 'center' }}>
          <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#E1F5EE', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Check size={24} color="#0F6E56" />
          </div>
          <div style={{ fontFamily: FONT, fontSize: 15, fontWeight: 700, color: C.text }}>{successMessage}</div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell form={form}>
      <div style={{ padding: '22px 22px 26px' }}>
        <div style={{ fontFamily: FONT, fontSize: 20, fontWeight: 800, color: C.text, marginBottom: form.description ? 6 : 18 }}>{form.name}</div>
        {form.description && <div style={{ fontFamily: FONT, fontSize: 13.5, color: C.textSecondary, marginBottom: 20, lineHeight: 1.5 }}>{form.description}</div>}

        {/* The old build warned the RESPONDENT that the form "isn't set up to
            know who's responding" — an admin-facing complaint shown to the
            wrong audience, and no longer even true: an anonymous response is a
            supported outcome. The builder's own Phone-mapping note covers it.
            What a respondent does deserve is confirmation of what a WhatsApp
            link already knows about them. */}
        {prefillPhone && (
          <div style={{ background: '#E1F5EE', color: '#0F6E56', borderRadius: 8, padding: '9px 12px', fontFamily: FONT, fontSize: 12.5, marginBottom: 16 }}>
            Responding as {maskPhone(prefillPhone)}
          </div>
        )}

        {form.fields.map(f => (
          // A section is a heading, not a question — rendering it through
          // FieldWrap would give it a question label and, if it were ever
          // marked required, a red asterisk against a field nobody can answer.
          isDisplayOnly(f.type) ? (
            <SectionBlock key={f.key} field={f} />
          ) : (
            <FieldWrap key={f.key} label={f.label} required={f.required} error={fieldErrors[f.key]}>
              <FieldInput field={f} value={answers[f.key]} onChange={v => setAnswer(f.key, v)} />
            </FieldWrap>
          )
        ))}

        {submitError && (
          <div style={{ background: '#FEF2F2', color: '#991B1B', borderRadius: 8, padding: '9px 12px', fontFamily: FONT, fontSize: 13, marginBottom: 14 }}>{submitError}</div>
        )}

        <button onClick={submit} disabled={state === 'submitting'} style={{
          width: '100%', padding: '13px 16px', borderRadius: 10, border: 'none',
          background: C.primary, color: '#fff', fontFamily: FONT, fontSize: 15, fontWeight: 700,
          cursor: state === 'submitting' ? 'not-allowed' : 'pointer', opacity: state === 'submitting' ? 0.7 : 1,
        }}>
          {state === 'submitting' ? 'Submitting…' : 'Submit'}
        </button>
      </div>
    </Shell>
  );
}

function Shell({ form, children }) {
  return (
    <div style={{ minHeight: '100vh', background: C.pageBg, display: 'flex', justifyContent: 'center', padding: '0 0 40px' }}>
      <div style={{ width: '100%', maxWidth: 560 }}>
        {form?.hasBanner && (
          <img src={api.publicLeadForms.assetUrl(form.slug, 'banner')} alt=""
            style={{ width: '100%', height: 180, objectFit: 'cover', display: 'block' }} />
        )}
        <div style={{ background: C.cardBg, margin: form?.hasBanner ? '0 14px' : '24px 14px 0', borderRadius: 14,
          boxShadow: C.shadowMd, position: 'relative', top: form?.hasBanner ? -28 : 0 }}>
          {form?.hasLogo && (
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 18 }}>
              <img src={api.publicLeadForms.assetUrl(form.slug, 'logo')} alt=""
                style={{ width: 56, height: 56, borderRadius: 12, objectFit: 'cover', border: `2px solid ${C.cardBg}`, boxShadow: C.shadowSm }} />
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}

function FieldWrap({ label, required, error, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontFamily: FONT, fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>
        {label}{required && <span style={{ color: C.primary }}> *</span>}
      </label>
      {children}
      {error && <div style={{ fontFamily: FONT, fontSize: 12, color: C.primary, marginTop: 4 }}>{error}</div>}
    </div>
  );
}

// A heading between questions. Collects nothing, so it takes no key in
// `answers` and is skipped by every validation loop.
function SectionBlock({ field }) {
  return (
    <div style={{ margin: '22px 0 14px', paddingTop: 4, borderTop: `1px solid ${C.border}` }}>
      <div style={{ fontFamily: FONT, fontSize: 15.5, fontWeight: 700, color: C.text, marginTop: 14 }}>{field.label}</div>
      {field.description && (
        <div style={{ fontFamily: FONT, fontSize: 13, color: C.textSecondary, lineHeight: 1.5, marginTop: 5, whiteSpace: 'pre-wrap' }}>
          {field.description}
        </div>
      )}
    </div>
  );
}

// Star picker + an optional feedback box beneath it.
//
// Two behaviours worth keeping: the whole control is a radiogroup of real
// <button>s so it is keyboard- and screen-reader-reachable (a row of <svg>s
// with onClick is neither), and clicking the star you already picked CLEARS
// the rating — otherwise a misclick on an optional question is permanent, with
// no way back to "no answer".
function RatingInput({ field, value, onChange }) {
  const { rating, feedback, max } = normalizeRating(field, value);
  const [hover, setHover] = useState(0);
  const shown = hover || rating || 0;
  const set = (n) => onChange({ rating: n === rating ? null : n, feedback });

  return (
    <div>
      <div role="radiogroup" aria-label={field.label} onMouseLeave={() => setHover(0)}
        style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {Array.from({ length: max }, (_, i) => i + 1).map(n => {
          const on = n <= shown;
          return (
            <button key={n} type="button" role="radio" aria-checked={rating === n}
              aria-label={`${n} of ${max}`}
              onClick={() => set(n)} onMouseEnter={() => setHover(n)} onFocus={() => setHover(n)} onBlur={() => setHover(0)}
              style={{
                background: 'none', border: 'none', padding: 2, cursor: 'pointer', lineHeight: 0,
                borderRadius: 6, transition: 'transform .12s',
                transform: on && hover === n ? 'scale(1.12)' : 'none',
              }}>
              <Star size={max > 5 ? 24 : 30} strokeWidth={1.75}
                color={on ? '#F59E0B' : C.border} fill={on ? '#F59E0B' : 'none'} />
            </button>
          );
        })}
        <span style={{ fontFamily: FONT, fontSize: 13, color: C.textSecondary, alignSelf: 'center', marginLeft: 8 }}>
          {rating ? `${rating} of ${max}` : ''}
        </span>
      </div>

      {field.feedback && (
        <div style={{ marginTop: 12 }}>
          <label style={{ display: 'block', fontFamily: FONT, fontSize: 12.5, color: C.textSecondary, marginBottom: 5 }}>
            {field.feedbackLabel || DEFAULT_FEEDBACK_LABEL}
          </label>
          {/* Always optional, even when the rating itself is required — the
              star is the question, the comment is a bonus. */}
          <textarea value={feedback} rows={3} maxLength={2000}
            onChange={e => onChange({ rating, feedback: e.target.value })}
            style={{ ...inputStyle, resize: 'vertical' }} />
        </div>
      )}
    </div>
  );
}

function FieldInput({ field, value, onChange }) {
  switch (field.type) {
    case 'rating':
      return <RatingInput field={field} value={value} onChange={onChange} />;
    case 'textarea':
      return <textarea value={value} onChange={e => onChange(e.target.value)} rows={4} placeholder={field.placeholder} style={{ ...inputStyle, resize: 'vertical' }} />;
    case 'number':
      return <input type="number" value={value} onChange={e => onChange(e.target.value)} placeholder={field.placeholder} style={inputStyle} />;
    case 'date':
      return <input type="date" value={value} onChange={e => onChange(e.target.value)} style={inputStyle} />;
    case 'email':
      return <input type="email" value={value} onChange={e => onChange(e.target.value)} placeholder={field.placeholder || 'name@example.com'} style={inputStyle} />;
    case 'phone':
      return <input value={value} onChange={e => onChange(e.target.value)} placeholder={field.placeholder || '91XXXXXXXXXX'} style={inputStyle} />;
    case 'dropdown':
      return (
        <select value={value} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, appearance: 'auto' }}>
          <option value="">Select…</option>
          {(field.options || []).map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case 'radio':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(field.options || []).map(o => (
            <label key={o} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: FONT, fontSize: 14, color: C.text, cursor: 'pointer' }}>
              <input type="radio" name={field.key} checked={value === o} onChange={() => onChange(o)} /> {o}
            </label>
          ))}
        </div>
      );
    case 'checkbox':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(field.options || []).map(o => {
            const checked = Array.isArray(value) && value.includes(o);
            return (
              <label key={o} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: FONT, fontSize: 14, color: C.text, cursor: 'pointer' }}>
                <input type="checkbox" checked={checked} onChange={() => {
                  const arr = Array.isArray(value) ? value : [];
                  onChange(checked ? arr.filter(v => v !== o) : [...arr, o]);
                }} /> {o}
              </label>
            );
          })}
        </div>
      );
    case 'boolean':
      return (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: FONT, fontSize: 14, color: C.text, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} /> {field.placeholder || 'Yes'}
        </label>
      );
    default:
      return <input value={value} onChange={e => onChange(e.target.value)} placeholder={field.placeholder} style={inputStyle} />;
  }
}
