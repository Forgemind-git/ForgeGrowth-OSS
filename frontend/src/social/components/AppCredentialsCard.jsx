// App credentials — the Meta / Threads / Google / LinkedIn app keys the
// Connect buttons and webhooks need, entered here instead of on the server.
// Admin only. Secrets are write-only: the server says whether one is set and
// shows its last 4 characters, never the value.
import { useState, useEffect } from 'react';
import { KeyRound, Copy, Check, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO, BTN, INPUT, LABEL } from '../constants.js';
import { Card, SectionHead } from './UI.jsx';
import { showToast } from '../Toast.jsx';

const GROUPS = [
  { id: 'meta', title: 'Meta app — Instagram & Facebook',
    sub: 'Needed for Connect Instagram / Connect Facebook, and for DMs and comments to arrive.',
    urls: [['Instagram OAuth redirect', 'instagramRedirect'], ['Facebook Login redirect', 'facebookRedirect'],
           ['Webhook callback URL', 'instagramWebhook'], ['Privacy policy URL', 'privacyPolicy']] },
  { id: 'threads', title: 'Threads', sub: 'Only if Threads is used.',
    urls: [['Threads redirect', 'threadsRedirect']] },
  { id: 'google', title: 'Google — YouTube', sub: 'Only if YouTube is used.',
    urls: [['Authorised redirect URI', 'youtubeRedirect']] },
  { id: 'linkedin', title: 'LinkedIn', sub: 'Only if LinkedIn is used.',
    urls: [['Redirect URL', 'linkedinRedirect']] },
];

function SourceChip({ c }) {
  const map = {
    app: { text: 'Saved here', bg: C.greenSoft || 'var(--fc-green-soft)', color: C.green },
    server: { text: 'From server', bg: C.surface2, color: C.textSecondary },
    none: { text: 'Not set', bg: C.errBg, color: C.errText },
  };
  const m = map[c.source || 'none'];
  return <span style={{ fontSize: 11.5, fontWeight: 650, padding: '3px 8px', borderRadius: 8, background: m.bg, color: m.color, whiteSpace: 'nowrap' }}>{m.text}</span>;
}

function CopyRow({ label, value }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }
    catch { showToast('Could not copy — select the text instead', 'error'); }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
      <div style={{ width: 190, flexShrink: 0, fontSize: 12.5, color: C.textMuted, fontWeight: 600 }}>{label}</div>
      <code style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 12.5, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</code>
      <button onClick={copy} title="Copy" aria-label={`Copy ${label}`} style={{ ...BTN.icon, width: 30, height: 30 }}>
        {done ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

function Group({ group, items, urls, canSaveSecrets, onSaved, initiallyOpen }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const setCount = items.filter(c => c.set).length;
  const changed = Object.keys(draft).filter(k => draft[k] !== undefined);

  const save = async (values) => {
    setSaving(true);
    try {
      const res = await api.saveCredentials(values);
      setDraft({});
      onSaved(res);
      showToast('Saved', 'success');
    } catch (e) { showToast(e.message, 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ borderRadius: 12, background: C.raised, marginBottom: 10 }}>
      <button onClick={() => setOpen(o => !o)} className="fc-row"
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: FONT, textAlign: 'left', color: C.text }}>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{group.title}</div>
          <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2 }}>{group.sub}</div>
        </div>
        <span style={{ fontSize: 12.5, color: setCount === items.length ? C.green : C.textMuted, fontWeight: 650 }}>{setCount} of {items.length} set</span>
      </button>
      {open && (
        <div style={{ padding: '0 16px 16px' }}>
          {items.map(c => {
            const v = draft[c.key];
            const placeholder = c.secret
              ? (c.set ? `Set · ends in ${c.last4 || '••••'} — type to replace` : 'Paste the secret')
              : (c.value || 'Paste the ID');
            const shown = c.key === 'INSTAGRAM_WEBHOOK_VERIFY_TOKEN' && !c.set ? 'Type any text, then use the same text in Meta' : placeholder;
            return (
              <div key={c.key} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <label htmlFor={`cred-${c.key}`} style={{ ...LABEL, marginBottom: 0 }}>{c.label}</label>
                  <SourceChip c={c} />
                  {c.source === 'app' && (
                    <button onClick={() => save({ [c.key]: null })} disabled={saving}
                      style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: C.textMuted, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
                      Remove saved value
                    </button>
                  )}
                </div>
                {/* Not a login form: "new-password" / "off" plus non-login names stop the
                    browser filling a saved username + password into these fields. */}
                <input id={`cred-${c.key}`} name={`social-cred-${c.key.toLowerCase()}`} type={c.secret ? 'password' : 'text'}
                  autoComplete={c.secret ? 'new-password' : 'off'} data-lpignore="true" data-1p-ignore="true" spellCheck={false}
                  value={v ?? ''} placeholder={shown}
                  onChange={e => setDraft(d => ({ ...d, [c.key]: e.target.value }))}
                  style={{ ...INPUT, width: '100%', boxSizing: 'border-box', fontFamily: MONO }} />
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>{c.help}</div>
              </div>
            );
          })}
          {!canSaveSecrets && items.some(c => c.secret) && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8, background: C.errBg, color: C.errText, fontSize: 12.5, marginBottom: 12 }}>
              <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>Secrets cannot be saved until the server has an encryption key (SOCIAL_ENCRYPTION_KEY).</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {changed.length > 0 && <button onClick={() => setDraft({})} disabled={saving} style={{ ...BTN.secondary }}>Cancel</button>}
            <button onClick={() => save(Object.fromEntries(changed.filter(k => (draft[k] || '').trim()).map(k => [k, draft[k]])))}
              disabled={saving || !changed.some(k => (draft[k] || '').trim())}
              style={{ ...BTN.primary, opacity: saving || !changed.some(k => (draft[k] || '').trim()) ? .5 : 1 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          <div style={{ marginTop: 14 }}>
            <div style={{ ...LABEL, marginBottom: 4 }}>Paste these into the app's settings</div>
            {group.urls.map(([label, k]) => urls?.[k] ? <CopyRow key={k} label={label} value={urls[k]} /> : null)}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AppCredentialsCard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.getCredentials().then(setData).catch(e => setError(e.message)); }, []);

  return (
    <Card style={{ marginBottom: 22 }}>
      <SectionHead right={<KeyRound size={16} color={C.textMuted} />}>App credentials</SectionHead>
      <div style={{ fontSize: 13, color: C.textSecondary, margin: '-4px 0 14px' }}>
        The keys of your own Meta, Google and LinkedIn apps. A value saved here takes effect immediately and is used instead of any value set on the server.
      </div>
      {error && <div style={{ fontSize: 13, color: C.errText }}>{error}</div>}
      {!data && !error && <div style={{ fontSize: 13, color: C.textMuted }}>Loading…</div>}
      {data && GROUPS.map((g, i) => (
        <Group key={g.id} group={g} urls={data.urls} canSaveSecrets={data.canSaveSecrets}
          items={data.credentials.filter(c => c.group === g.id)}
          initiallyOpen={i === 0 && data.credentials.filter(c => c.group === 'meta').some(c => !c.set)}
          onSaved={setData} />
      ))}
    </Card>
  );
}
