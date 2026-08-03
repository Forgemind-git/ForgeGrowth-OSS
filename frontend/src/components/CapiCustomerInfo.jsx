// "Send customer information" — the panel where an admin decides which details
// travel with a conversion.
//
// The whole point of this screen is that the keys are NOT equal. Meta matches
// hard on phone and email; a PIN code cannot identify anyone by itself. So each
// toggle carries its tier, its coverage in THIS data, and Meta's reasoning —
// all from the backend catalog, so the guidance can never drift from the code
// that actually builds the payload.
import { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, ChevronDown, Lock, Database, ArrowRight, Eye, EyeOff } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO } from '../constants.js';
import { NoteBanner } from './CapiNotes.jsx';
import SearchableSelect from './SearchableSelect.jsx';

const TIER_STYLE = {
  high:   { label: 'Strong match key',    color: '#0F6E56', bg: '#E1F5EE' },
  medium: { label: 'Combination booster', color: '#854F0B', bg: '#FAEEDA' },
  low:    { label: 'Weak on its own',     color: '#6B7280', bg: '#F1F1EE' },
};
const TIER_RANK = { high: 0, medium: 1, low: 2 };

function Toggle({ on, onChange, disabled }) {
  return (
    <button onClick={() => !disabled && onChange(!on)} disabled={disabled}
      style={{
        width: 38, height: 22, borderRadius: 99, border: 'none', padding: 3, cursor: disabled ? 'not-allowed' : 'pointer',
        background: on ? '#0F6E56' : C.border, transition: 'background .15s', display: 'flex',
        justifyContent: on ? 'flex-end' : 'flex-start', alignItems: 'center', opacity: disabled ? 0.45 : 1, flexShrink: 0,
      }}>
      <span style={{ width: 16, height: 16, borderRadius: 99, background: '#fff', boxShadow: C.shadowSm }} />
    </button>
  );
}

export default function CapiCustomerInfo({
  config, catalog = [], coverage = {}, nonMatching = [], note, saving, onPatch,
  leadFields = [], mappableKeys = [],
}) {
  const [expanded, setExpanded] = useState(null);
  const [preview, setPreview] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const fields = config?.customerFields || {};
  const sources = config?.customerFieldSources || {};
  const on = !!config?.sendCustomerInfo;
  const total = Number(coverage.total || 0);

  // Re-read the preview whenever the mapping changes, so the sample values on
  // screen always describe the mapping currently saved — a stale preview would
  // be worse than none, since the whole point is to be able to trust it.
  const loadPreview = useCallback(() => {
    api.capi.fieldPreview().then(setPreview).catch(() => setPreview(false));
  }, []);
  useEffect(() => { loadPreview(); }, [loadPreview, JSON.stringify(sources), JSON.stringify(fields)]);

  const previewByKey = {};
  for (const f of preview?.fields || []) previewByKey[f.key] = f;

  const sourceOptions = leadFields.map(f => ({
    value: f.column,
    label: f.label,
    sublabel: `${f.column} · ${f.filled} of ${f.total} filled`,
  }));

  // Strongest keys first — the order itself is guidance.
  const sorted = [...catalog].sort((a, b) => (TIER_RANK[a.tier] ?? 3) - (TIER_RANK[b.tier] ?? 3));
  const enabledCount = sorted.filter(k => fields[k.key] === true).length;

  function setField(key, val) {
    onPatch({ customerFields: { ...fields, [key]: val } });
  }

  return (
    <div>
      <NoteBanner note={note} style={{ marginBottom: 14 }} />

      {/* master toggle for the whole feature */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 13, padding: '14px 16px', marginBottom: 14,
        background: C.cardBg, border: `1px solid ${on ? '#B6DFCE' : C.border}`, borderRadius: 12,
      }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: on ? '#E1F5EE' : C.hover,
        }}>
          <ShieldCheck size={19} color={on ? '#0F6E56' : C.textMuted} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
            {on ? `Sending ${enabledCount} customer detail${enabledCount === 1 ? '' : 's'} with each conversion` : 'Customer information is not being sent'}
          </div>
          <div style={{ fontSize: 12.5, color: C.textSecondary, marginTop: 2 }}>
            {on
              ? 'Each value is hashed before it leaves this server. Meta never receives the plain text.'
              : 'Conversions carry only the click ID, so Meta knows which ad produced the sale but not who bought.'}
          </div>
        </div>
        <Toggle on={on} onChange={v => onPatch({ sendCustomerInfo: v })} disabled={saving} />
      </div>

      {/* privacy statement — earned its own line, not a footnote */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 13px', marginBottom: 14,
        background: '#F5FBF8', border: '1px solid #CDE9DE', borderRadius: 10, fontFamily: FONT,
      }}>
        <Lock size={14} color="#0F6E56" style={{ flexShrink: 0, marginTop: 2 }} />
        <span style={{ fontSize: 12.5, color: '#215D4C', lineHeight: 1.5 }}>
          Every detail below is <strong>SHA-256 hashed</strong> after normalisation. Meta compares fingerprints against
          its own hashes and cannot read the original value. The click ID is the one exception — it is Meta&apos;s own
          token, not personal data, so it is sent as-is.
        </span>
      </div>

      {/* Where the data comes from — asked directly, so answered directly rather
          than left for someone to infer from behaviour. */}
      <div style={{
        display: 'flex', gap: 9, alignItems: 'flex-start', padding: '11px 13px', marginBottom: 14,
        background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, fontFamily: FONT,
      }}>
        <Database size={15} color={C.textMuted} style={{ flexShrink: 0, marginTop: 2 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12.5, color: C.textSecondary, lineHeight: 1.55 }}>
            <strong style={{ color: C.text }}>Yes — this reads your Leads table automatically.</strong>{' '}
            When a lead reaches a mapped stage, its row in <span style={{ fontFamily: MONO }}>coexistence.leads</span> is
            read at that moment and the columns you choose below are hashed and sent. Nothing is copied or
            duplicated, so editing a lead changes what a future conversion carries.
          </div>
          {preview?.hasSample && (
            <button onClick={() => setShowPreview(p => !p)}
              style={{ marginTop: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: C.primary, fontFamily: FONT, fontSize: 12.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              {showPreview ? <EyeOff size={13} /> : <Eye size={13} />}
              {showPreview ? 'Hide' : 'Show'} what a real conversion would send
            </button>
          )}
        </div>
      </div>

      {/* Live proof. A wrong column or a bad normalisation still returns 200 OK
          from Meta, so seeing the actual value transform is the only way to
          check the mapping without transmitting anything. */}
      {showPreview && preview?.hasSample && (
        <div style={{ marginBottom: 14, border: `1px solid ${C.border}`, borderRadius: 11, overflow: 'hidden' }}>
          <div style={{ padding: '10px 13px', background: C.surfaceAlt, borderBottom: `1px solid ${C.border}`, fontSize: 12, color: C.textSecondary, fontFamily: FONT }}>
            Using a real lead — <strong style={{ color: C.text }}>{preview.lead?.name || 'Unnamed'}</strong>.
            {' '}{preview.willSendCount} field{preview.willSendCount === 1 ? '' : 's'} would be sent.
          </div>
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>
            {(preview.fields || []).filter(f => f.enabled).map(f => (
              <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
                <span style={{ fontFamily: MONO, fontWeight: 700, color: C.text, minWidth: 74 }}>{f.key}</span>
                <span style={{ fontFamily: MONO, color: f.raw ? C.textSecondary : C.textMuted, maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.raw || 'empty'}
                </span>
                <ArrowRight size={11} color={C.textMuted} />
                <span style={{ fontFamily: MONO, color: f.normalised ? C.text : C.textMuted }}>{f.normalised || '—'}</span>
                <ArrowRight size={11} color={C.textMuted} />
                <span style={{ fontFamily: MONO, color: f.hashPrefix ? C.green : C.textMuted }}>
                  {f.hashPrefix ? `${f.hashPrefix}…` : 'not sent'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* the keys */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16, opacity: on ? 1 : 0.55 }}>
        {sorted.map(k => {
          const t = TIER_STYLE[k.tier] || TIER_STYLE.low;
          const have = Number(coverage[k.key] || 0);
          const pct = total ? Math.round((have / total) * 100) : 0;
          const isOpen = expanded === k.key;
          const enabled = fields[k.key] === true;
          return (
            <div key={k.key} style={{ border: `1px solid ${C.border}`, borderRadius: 11, background: C.cardBg, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 13px' }}>
                <Toggle on={enabled} onChange={v => setField(k.key, v)} disabled={saving || !on} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: C.text }}>{k.label}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.03em', color: t.color, background: t.bg, padding: '2px 7px', borderRadius: 5 }}>
                      {t.label}
                    </span>
                    <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.textMuted }}>{k.key}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 2 }}>
                    {/* Coverage is the number that decides whether a key is worth
                        enabling at all — a perfect key on 0 leads does nothing. */}
                    {total
                      ? <>On <strong style={{ color: pct >= 50 ? C.green : pct > 0 ? C.text : C.textMuted }}>{have} of {total}</strong> attributable leads ({pct}%) · from {k.source}</>
                      : <>From {k.source}</>}
                  </div>
                </div>
                <button onClick={() => setExpanded(isOpen ? null : k.key)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted, padding: 4, display: 'inline-flex' }}
                  title="Why this matters">
                  <ChevronDown size={16} style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
                </button>
              </div>
              {/* Which column feeds this key. Hardcoding it meant guessing on
                  the admin's behalf — and leads carries both `zip` and
                  `pincode`, so the guess could silently read an empty column. */}
              {mappableKeys.includes(k.key) && (
                <div style={{ padding: '0 13px 11px 62px', display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textMuted, fontFamily: FONT }}>
                    Read from
                  </span>
                  <div style={{ width: 230 }}>
                    <SearchableSelect
                      value={sources[k.key] || ''}
                      onChange={v => onPatch({ customerFieldSources: { ...sources, [k.key]: v || null } })}
                      options={sourceOptions}
                      placeholder="Not mapped"
                      searchPlaceholder="Search lead fields…"
                      disabled={saving || !on}
                      triggerStyle={{ padding: '7px 28px 7px 10px', fontSize: 12.5 }}
                    />
                  </div>
                  {previewByKey[k.key]?.raw && (
                    <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.textMuted }}>
                      e.g. {String(previewByKey[k.key].raw).slice(0, 26)}
                    </span>
                  )}
                </div>
              )}
              {!mappableKeys.includes(k.key) && k.key === 'external_id' && (
                <div style={{ padding: '0 13px 11px 62px', fontSize: 11.5, color: C.textMuted, fontFamily: FONT }}>
                  Derived from the ad click, not a lead field — so it stays the same person to Meta even if the
                  sale is deleted and re-created.
                </div>
              )}
              {isOpen && (
                <div style={{ padding: '0 13px 13px 13px', borderTop: `1px solid ${C.border}`, paddingTop: 11 }}>
                  <Line label="What it is" text={k.what} />
                  <Line label="Why Meta values it this way" text={k.why} />
                  <Line label="How it is normalised before hashing" text={k.normalisation} mono last />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* fields Meta has no matching parameter for */}
      {nonMatching.length > 0 && (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 11, background: C.cardBg, padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 8 }}>
            <Toggle on={!!config?.sendCustomProperties} onChange={v => onPatch({ sendCustomProperties: v })} disabled={saving} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: C.text }}>
                Also send age and profession
                <span style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, background: C.hover, padding: '2px 7px', borderRadius: 5, marginLeft: 7 }}>
                  NOT USED FOR MATCHING
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 2 }}>
                Visible in Events Manager for breakdowns. They do not improve matching or delivery.
              </div>
            </div>
          </div>
          <div style={{ paddingLeft: 49 }}>
            {nonMatching.map(p => (
              <div key={p.key} style={{ fontSize: 12, color: C.textSecondary, lineHeight: 1.5, marginBottom: 4 }}>
                <strong style={{ color: C.text }}>{p.label}:</strong> {p.why}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Line({ label, text, mono, last }) {
  if (!text) return null;
  return (
    <div style={{ marginBottom: last ? 0 : 8 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 12.5, color: C.textSecondary, lineHeight: 1.55, fontFamily: mono ? MONO : FONT }}>{text}</div>
    </div>
  );
}
