import { useState, useEffect } from 'react';
import { Star, Users, X, ChevronRight, Plug, KeyRound } from 'lucide-react';
import { useIntegrations } from '../hooks/useIntegrations.js';
import { useApi } from '../hooks/useApi.js';
import { PLATFORMS, platformColor } from '../data/mockData.js';
import { api } from '../api.js';
import { C, FONT, MONO, T, BTN, INPUT, LABEL } from '../constants.js';
import { Card, SectionHead, PageHeader, Badge, TokenBadge, StatusDot, PlatformBadge, EmptyState } from '../components/UI.jsx';
import { showToast } from '../Toast.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';
import InstagramDmLinkCard from "../components/InstagramDmLinkCard.jsx";
import AppCredentialsCard from "../components/AppCredentialsCard.jsx";
import TelegramPage from "./TelegramPage.jsx";

// Format time since a timestamp into human-readable text
function timeSince(isoString) {
  if (!isoString) return null;
  const ms = Date.now() - new Date(isoString).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'Just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day !== 1 ? 's' : ''} ago`;
}

// ── Shared visual recipes (one implementation per idea) ──────
// Small pill buttons for row / panel actions.
const BTN_SM         = { ...BTN.secondary, padding: '7px 14px', fontSize: 13, justifyContent: 'center' };
const BTN_SM_PRIMARY = { ...BTN.primary,   padding: '7px 14px', fontSize: 13, justifyContent: 'center' };
const BTN_SM_DANGER  = { ...BTN.danger,    padding: '7px 14px', fontSize: 13, justifyContent: 'center' };

// Brand chip: 44px rounded square on the surface fill; lit = brand colour at 18% (`${c}2e`), no border.
// Threads' near-black mark lifts on dark via platformColor(), so its lit fill is the neutral surface-2 step.
const BRAND_HEX = { instagram: '#C13584', youtube: '#CC0000', facebook: '#1877F2', linkedin: '#0A66C2' };
function BrandChip({ platform, lit = true, size = 44, label }) {
  const hex = BRAND_HEX[platform];
  const color = lit ? (hex || platformColor(platform)) : C.textMuted;
  const bg = !lit ? C.surface : hex ? `${hex}2e` : C.surface2;
  return (
    <div style={{ width: size, height: size, borderRadius: 12, background: bg, color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: size >= 44 ? 14 : 13, fontFamily: FONT, flexShrink: 0, letterSpacing: '.02em' }}>
      {label || PLATFORMS[platform]?.short || '?'}
    </div>
  );
}

// Tinted status chip (token expiry / health) — a chip, never a bordered box.
const chipTone = (tone) => tone === 'err' ? { background: C.errBg, color: C.errText }
  : tone === 'warn' ? { background: C.amberSoft, color: C.amber }
  : tone === 'ok' ? { background: C.greenSoft, color: C.green }
  : { background: C.surface2, color: C.textMuted };
function Chip({ tone, children, style }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 650, padding: '4px 10px', borderRadius: 999, whiteSpace: 'nowrap', ...chipTone(tone), ...style }}>{children}</span>;
}
const daysTone = (daysLeft) => daysLeft == null ? 'neutral' : daysLeft <= 7 ? 'err' : daysLeft <= 20 ? 'warn' : 'ok';

// Info note on a card: surface fill, radius 12, no border.
function Note({ children, muted, style }) {
  return <div style={{ padding: '12px 14px', borderRadius: 12, background: C.surface, fontSize: muted ? 12.5 : 13, fontWeight: 450, color: muted ? C.textMuted : C.textSecondary, lineHeight: 1.6, ...style }}>{children}</div>;
}
const CodeTag = ({ children }) => <code style={{ background: C.surface2, borderRadius: 12, padding: '1px 6px', fontFamily: MONO, fontSize: 12 }}>{children}</code>;

// Status box at the top of every connect panel: tint carries the state.
function StatusBox({ status, children }) {
  const bg = status.connected ? C.greenSoft : status.hasCredentials ? C.errBg : C.surface;
  return <div style={{ marginBottom: 18, padding: '12px 14px', borderRadius: 12, background: bg }}>{children}</div>;
}
const ConnectedLine = ({ right }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
    <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.green, boxShadow: `0 0 0 3px ${C.greenSoft}` }} />
    <span style={{ fontSize: 13, fontWeight: 700, color: C.green }}>Connected</span>
    {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
  </div>
);
const StatusText = ({ tone, children }) => <div style={{ fontSize: 13.5, fontWeight: tone === 'err' ? 600 : 500, color: tone === 'err' ? C.errText : C.textSecondary }}>{children}</div>;

// Side panel: fixed, inset by the gutter, ~440 wide, card fill, radius 24, over a blurred scrim.
function PanelShell({ platform, title, sub, onClose, footer, children }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.42)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', zIndex: 200 }} />
      <div style={{ position: 'fixed', top: 16, right: 16, bottom: 16, width: 440, maxWidth: 'calc(calc(100vw / var(--fg-zoom, 1)) - 32px)', background: C.card, borderRadius: 24, boxShadow: C.shadowLg, zIndex: 201, display: 'flex', flexDirection: 'column', fontFamily: FONT, animation: 'fc-pop-in .2s ease-out both', overflow: 'hidden' }}>
        <div style={{ padding: '22px 24px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            <BrandChip platform={platform} size={40} />
            <div style={{ minWidth: 0 }}>
              <div style={{ ...T.h3, color: C.text }}>{title}</div>
              <div style={{ fontSize: 12.5, color: C.textMuted, fontWeight: 500, marginTop: 2 }}>{sub}</div>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ ...BTN.icon, width: 32, height: 32 }}><X size={16} /></button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 24px 20px' }}>{children}</div>
        {footer && <div style={{ padding: '14px 24px 20px', display: 'flex', gap: 8 }}>{footer}</div>}
      </div>
    </>
  );
}

const FooterCancel = ({ onClose }) => <button onClick={onClose} style={{ ...BTN.secondary, flex: 1, justifyContent: 'center' }}>Cancel</button>;
const ErrorBox = ({ children }) => <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 12, background: C.errBg, fontSize: 13, color: C.errText, fontWeight: 600 }}>{children}</div>;

// Form field: label style eyebrow, surface input, hint below.
function Field({ label, optional, hint, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ ...LABEL, marginBottom: 0 }}>{label}{optional && <span style={{ color: C.textMuted, fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}> · {optional}</span>}</span>
      {children}
      {hint && <span style={{ fontSize: 12.5, fontWeight: 450, color: C.textMuted, lineHeight: 1.5 }}>{hint}</span>}
    </label>
  );
}
const MONO_INPUT = { ...INPUT, fontFamily: MONO, fontSize: 13 };

// ── Instagram Credentials Modal ──────────────────────────────
function InstagramCredentialsModal({ onClose, onSaved }) {
  const [accountId,   setAccountId]   = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [appId,       setAppId]       = useState('');
  const [saving,      setSaving]      = useState(false);
  const [testing,     setTesting]     = useState(false);
  const [status,      setStatus]      = useState(null); // { connected, profile, error, tokenDaysLeft }
  const [saveError,   setSaveError]   = useState(null);
  const [showToken,   setShowToken]   = useState(false);

  // Load current status on open
  useEffect(() => {
    api.getInstagramStatus().then(setStatus).catch(() => {});
  }, []);

  const handleTest = async () => {
    setTesting(true);
    setSaveError(null);
    try {
      const result = await api.saveInstagramCredentials({ accountId, accessToken, appId });
      setStatus(result);
      if (result.connected) onSaved?.();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setTesting(false);
    }
  };

  const handleRefresh = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api.refreshInstagramToken();
      setStatus(prev => ({ ...prev, tokenDaysLeft: result.daysLeft }));
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const [connecting, setConnecting] = useState(false);
  const handleConnect = async () => {
    setConnecting(true);
    setSaveError(null);
    try {
      const { url } = await api.getInstagramOAuthUrl();
      window.location.href = url;   // full redirect → Instagram Login dialog → callback
    } catch (err) {
      setSaveError(err.message);
      setConnecting(false);
    }
  };

  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisc, setConfirmDisc] = useState(false);
  const handleDisconnect = async () => {
    setDisconnecting(true);
    setSaveError(null);
    try {
      await api.disconnectInstagram();
      setConfirmDisc(false);
      const fresh = await api.getInstagramStatus();
      setStatus(fresh);
      onSaved?.();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setDisconnecting(false);
    }
  };

  const daysLeft = status?.tokenDaysLeft;
  const tone = daysTone(daysLeft);
  const canSubmit = !!accountId && !!accessToken;

  return (
    <PanelShell platform="instagram" title="Instagram" sub="Graph API credentials" onClose={onClose}
      footer={<>
        <FooterCancel onClose={onClose} />
        <button onClick={handleTest} disabled={testing || !canSubmit}
          style={{ ...BTN.primary, flex: 2, justifyContent: 'center', background: canSubmit ? C.primary : C.surface2, color: canSubmit ? C.onAccent : C.textMuted, cursor: canSubmit ? 'pointer' : 'not-allowed', transition: 'background .15s' }}>
          {testing ? 'Testing & Saving…' : 'Test & Save Credentials'}
        </button>
      </>}>
      {/* Current status */}
      {status && (
        <StatusBox status={status}>
          {status.connected ? (
            <>
              <ConnectedLine right={daysLeft != null && <Chip tone={tone}>Token expires in {daysLeft}d</Chip>} />
              <StatusText>@{status.profile?.username} · {(status.profile?.followers || 0).toLocaleString('en-IN')} followers</StatusText>
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {daysLeft != null && daysLeft <= 20 && (
                  <button onClick={handleRefresh} disabled={saving} style={{ ...BTN_SM, ...chipTone(tone) }}>
                    {saving ? 'Refreshing…' : 'Refresh Token Now'}
                  </button>
                )}
                {confirmDisc ? (
                  <>
                    <span style={{ fontSize: 13, color: C.errText, fontWeight: 600 }}>Disconnect this account?</span>
                    <button onClick={handleDisconnect} disabled={disconnecting} style={{ ...BTN_SM_PRIMARY, background: C.errText, cursor: disconnecting ? 'wait' : 'pointer' }}>{disconnecting ? 'Disconnecting…' : 'Yes, disconnect'}</button>
                    <button onClick={() => setConfirmDisc(false)} disabled={disconnecting} style={BTN_SM}>Cancel</button>
                  </>
                ) : (
                  <button onClick={() => setConfirmDisc(true)} style={BTN_SM_DANGER}>Disconnect</button>
                )}
              </div>
            </>
          ) : status.hasCredentials ? (
            <StatusText tone="err">⚠ {status.error}</StatusText>
          ) : (
            <StatusText>No credentials saved yet. Enter your credentials below.</StatusText>
          )}
        </StatusBox>
      )}

      {/* Primary path: Connect with Instagram (OAuth login) */}
      <button onClick={handleConnect} disabled={connecting}
        style={{ ...BTN.primary, width: '100%', justifyContent: 'center', gap: 9, padding: '12px 18px', marginBottom: 12, cursor: connecting ? 'wait' : 'pointer', fontWeight: 700 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
        {connecting ? 'Redirecting to Instagram…' : 'Connect with Instagram'}
      </button>
      <div style={{ fontSize: 12.5, fontWeight: 450, color: C.textMuted, textAlign: 'center', marginBottom: 18, lineHeight: 1.5 }}>
        Recommended — authorize through Instagram to grant messaging &amp; comments access. You'll be returned here once connected.
      </div>

      <div style={{ ...T.label, fontFamily: MONO, color: C.textMuted, textAlign: 'center', marginBottom: 16 }}>or enter a token manually</div>

      {/* Help note */}
      <Note style={{ marginBottom: 18 }}>
        You need a <strong>Meta Business App</strong> with Instagram Graph API enabled and a <strong>long-lived User Access Token</strong> with <CodeTag>instagram_basic</CodeTag> and <CodeTag>instagram_manage_insights</CodeTag> permissions.
      </Note>

      {/* Form fields */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label="Instagram Account ID *" hint="Numeric Business Account ID (not username). Found in Meta Business Suite → Account Info.">
          <input value={accountId} onChange={e => setAccountId(e.target.value)} placeholder="e.g. 17841400000000000" style={MONO_INPUT} />
        </Field>

        <Field label="Long-lived Access Token *" hint={<>Generate in Meta Graph API Explorer with <em>instagram_basic</em> + <em>instagram_manage_insights</em>, then exchange for a long-lived token (valid 60 days).</>}>
          <div style={{ position: 'relative' }}>
            <input value={accessToken} onChange={e => setAccessToken(e.target.value)} type={showToken ? 'text' : 'password'} placeholder="EAAxxxxxx..." style={{ ...MONO_INPUT, paddingRight: 64 }} />
            <button type="button" onClick={() => setShowToken(v => !v)}
              style={{ ...BTN.ghost, position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', padding: '4px 10px', fontSize: 12.5, color: C.textMuted }}>
              {showToken ? 'Hide' : 'Show'}
            </button>
          </div>
        </Field>

        <Field label="App ID" optional="optional — needed for token refresh">
          <input value={appId} onChange={e => setAppId(e.target.value)} placeholder="e.g. 1234567890123456" style={MONO_INPUT} />
        </Field>
      </div>

      {saveError && <ErrorBox>{saveError}</ErrorBox>}
    </PanelShell>
  );
}

// ── YouTube Credentials Modal ────────────────────────────────
function YouTubeCredentialsModal({ onClose, onSaved }) {
  const [status,     setStatus]     = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [saveError,  setSaveError]  = useState(null);

  useEffect(() => {
    api.getYouTubeStatus().then(setStatus).catch(() => {});
  }, []);

  const handleConnect = async () => {
    setConnecting(true);
    setSaveError(null);
    try {
      const { url } = await api.getYouTubeOAuthUrl();
      const popup = window.open(url, 'yt_oauth', 'width=600,height=700,noopener');
      // Poll until popup closes, then recheck status
      const poll = setInterval(async () => {
        if (popup && popup.closed) {
          clearInterval(poll);
          setConnecting(false);
          const s = await api.getYouTubeStatus(true);
          setStatus(s);
          if (s.connected) onSaved?.();
        }
      }, 800);
    } catch (err) {
      setSaveError(err.message);
      setConnecting(false);
    }
  };

  const link = { color: C.primary, fontWeight: 600, textDecoration: 'none' };

  return (
    <PanelShell platform="youtube" title="YouTube" sub="Google OAuth2 · YouTube Analytics API" onClose={onClose}
      footer={<>
        <FooterCancel onClose={onClose} />
        <button onClick={handleConnect} disabled={connecting} style={{ ...BTN.primary, flex: 2, justifyContent: 'center', opacity: connecting ? .7 : 1, cursor: connecting ? 'not-allowed' : 'pointer' }}>
          {connecting ? 'Waiting for Google…' : 'Connect with Google'}
        </button>
      </>}>
      {status && (
        <StatusBox status={status}>
          {status.connected ? (
            <>
              <ConnectedLine />
              <StatusText>{status.profile?.name} · {(status.profile?.subscribers || 0).toLocaleString('en-IN')} subscribers</StatusText>
            </>
          ) : status.hasCredentials ? (
            <StatusText tone="err">⚠ Token expired. Click "Connect with Google" to get a fresh one.</StatusText>
          ) : (
            <StatusText>Not connected. Click the button below to authorise via Google.</StatusText>
          )}
        </StatusBox>
      )}

      <Note>
        Clicking Connect opens a Google sign-in popup. After you approve access, the token is saved automatically. Tokens don't expire unless manually revoked.
      </Note>

      {/* Required YouTube API Services disclosures (YouTube ToS III.A) */}
      <Note muted style={{ marginTop: 10 }}>
        ForgeGrowth uses <strong>YouTube API Services</strong> to access your channel's data. By connecting, you agree to the{' '}
        <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer" style={link}>YouTube Terms of Service</a>. Data handling is governed by the{' '}
        <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" style={link}>Google Privacy Policy</a>. You can revoke ForgeGrowth's access at any time via{' '}
        <a href="https://security.google.com/settings/security/permissions" target="_blank" rel="noopener noreferrer" style={link}>Google security settings</a>{' '}
        or by disconnecting here. Stored YouTube data is refreshed daily and deleted if not re-confirmed within 30 days.
      </Note>

      {saveError && <ErrorBox>{saveError}</ErrorBox>}
    </PanelShell>
  );
}

// ── Facebook Credentials Modal ───────────────────────────────
function FacebookCredentialsModal({ onClose, onSaved }) {
  const [status,     setStatus]     = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [saveError,  setSaveError]  = useState(null);
  const [token,      setToken]      = useState('');
  const [showToken,  setShowToken]  = useState(false);
  const [saving,     setSaving]     = useState(false);

  useEffect(() => {
    api.getFacebookStatus().then(setStatus).catch(() => {});
  }, []);

  // Paste a Business Manager system-user token. Needed because this Meta app is a
  // Business-type app whose login dialog grants scopes but attaches no Page asset.
  const handleSaveToken = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.saveFacebookToken(token.trim());
      const s = await api.getFacebookStatus(true);
      setStatus(s);
      setToken('');
      if (s.connected) onSaved?.();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleConnect = async () => {
    setConnecting(true);
    setSaveError(null);
    try {
      const { url } = await api.getFacebookOAuthUrl();
      const popup = window.open(url, 'fb_oauth', 'width=640,height=700,noopener');
      const poll = setInterval(async () => {
        if (popup && popup.closed) {
          clearInterval(poll);
          setConnecting(false);
          const s = await api.getFacebookStatus(true);
          setStatus(s);
          if (s.connected) onSaved?.();
        }
      }, 800);
    } catch (err) {
      setSaveError(err.message);
      setConnecting(false);
    }
  };

  return (
    <PanelShell platform="facebook" title="Facebook" sub="Facebook Login · Page Insights API" onClose={onClose}
      footer={<>
        <FooterCancel onClose={onClose} />
        <button onClick={handleConnect} disabled={connecting} style={{ ...BTN.primary, flex: 2, justifyContent: 'center', opacity: connecting ? .7 : 1, cursor: connecting ? 'not-allowed' : 'pointer' }}>
          {connecting ? 'Waiting for Facebook…' : 'Connect with Facebook'}
        </button>
      </>}>
      {status && (
        <StatusBox status={status}>
          {status.connected ? (
            <>
              <ConnectedLine />
              <StatusText>{status.profile?.name} · {(status.profile?.fans || 0).toLocaleString('en-IN')} fans</StatusText>
            </>
          ) : status.hasCredentials ? (
            <StatusText tone="err">⚠ {status.error}. Click "Connect with Facebook" to re-authorise.</StatusText>
          ) : (
            <StatusText>Not connected. Click the button below to authorise via Facebook.</StatusText>
          )}
        </StatusBox>
      )}

      <Note>
        Clicking Connect opens a Facebook login popup. Log in as the page admin, approve access, and the page token is saved automatically. Page tokens generated this way never expire.
      </Note>

      {/* Manual token — the reliable path when the OAuth dialog attaches no Page.
          This Meta app is a Business-type app: its login dialog grants the scopes
          but attaches no Page asset, so /me/accounts comes back empty. */}
      <div style={{ marginTop: 18 }}>
        <Field label="Or paste an access token" hint={<>Use this if Connect fails with “no Pages”. Create a <strong>System User</strong> in Meta Business Settings, assign it the Page with full control, then generate a token with <em>pages_show_list</em>, <em>pages_read_engagement</em>, <em>pages_manage_engagement</em>, <em>pages_manage_posts</em> and <em>read_insights</em>. System User tokens never expire and survive password changes.</>}>
          <div style={{ position: 'relative' }}>
            <input value={token} onChange={e => setToken(e.target.value)} type={showToken ? 'text' : 'password'} placeholder="EAAG…" style={{ ...MONO_INPUT, paddingRight: 64 }} />
            <button type="button" onClick={() => setShowToken(v => !v)}
              style={{ ...BTN.ghost, position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', padding: '4px 10px', fontSize: 12.5, color: C.textMuted }}>
              {showToken ? 'Hide' : 'Show'}
            </button>
          </div>
        </Field>
        <button onClick={handleSaveToken} disabled={saving || !token.trim()}
          style={{ ...BTN.secondary, marginTop: 10, width: '100%', justifyContent: 'center', opacity: (saving || !token.trim()) ? .6 : 1, cursor: (saving || !token.trim()) ? 'not-allowed' : 'pointer' }}>
          {saving ? 'Verifying token…' : 'Save token'}
        </button>
      </div>

      {saveError && <ErrorBox>{saveError}</ErrorBox>}
    </PanelShell>
  );
}

// ── Threads Credentials Modal ────────────────────────────────
function ThreadsCredentialsModal({ onClose, onSaved }) {
  const [status,     setStatus]     = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saveError,  setSaveError]  = useState(null);

  useEffect(() => {
    api.getThreadsStatus().then(setStatus).catch(() => {});
  }, []);

  const handleConnect = async () => {
    setConnecting(true);
    setSaveError(null);
    try {
      const { url } = await api.getThreadsOAuthUrl();
      const popup = window.open(url, 'th_oauth', 'width=640,height=700,noopener');
      const poll = setInterval(async () => {
        if (popup && popup.closed) {
          clearInterval(poll);
          setConnecting(false);
          const s = await api.getThreadsStatus(true);
          setStatus(s);
          if (s.connected) onSaved?.();
        }
      }, 800);
    } catch (err) {
      setSaveError(err.message);
      setConnecting(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setSaveError(null);
    try {
      const result = await api.refreshThreadsToken();
      setStatus(prev => ({ ...prev, tokenDaysLeft: result.daysLeft }));
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setRefreshing(false);
    }
  };

  const daysLeft = status?.tokenDaysLeft;
  const tone = daysTone(daysLeft);

  return (
    <PanelShell platform="threads" title="Threads" sub="Threads OAuth · Insights API" onClose={onClose}
      footer={<>
        <FooterCancel onClose={onClose} />
        <button onClick={handleConnect} disabled={connecting} style={{ ...BTN.primary, flex: 2, justifyContent: 'center', opacity: connecting ? .7 : 1, cursor: connecting ? 'not-allowed' : 'pointer' }}>
          {connecting ? 'Waiting for Threads…' : status?.connected ? 'Reconnect with Threads' : 'Connect with Threads'}
        </button>
      </>}>
      {status && (
        <StatusBox status={status}>
          {status.connected ? (
            <>
              <ConnectedLine right={daysLeft != null && <Chip tone={tone}>Token expires in {daysLeft}d</Chip>} />
              <StatusText>@{status.profile?.username} · {(status.profile?.followers || 0).toLocaleString('en-IN')} followers</StatusText>
              {daysLeft != null && daysLeft <= 20 && (
                <button onClick={handleRefresh} disabled={refreshing} style={{ ...BTN_SM, ...chipTone(tone), marginTop: 10 }}>
                  {refreshing ? 'Refreshing…' : 'Refresh Token Now'}
                </button>
              )}
            </>
          ) : status.hasCredentials ? (
            <StatusText tone="err">⚠ {status.error}. Click Connect to re-authorise.</StatusText>
          ) : (
            <StatusText>Not connected. Click the button below to authorise via Threads.</StatusText>
          )}
        </StatusBox>
      )}

      <Note>
        Clicking Connect opens a Threads login popup. Approve access and the token is saved automatically. Tokens are valid for <strong>60 days</strong> and can be refreshed before expiry without re-authorising.
      </Note>

      {saveError && <ErrorBox>{saveError}</ErrorBox>}
    </PanelShell>
  );
}

// ── LinkedIn Credentials Modal ───────────────────────────────
function LinkedInCredentialsModal({ onClose, onSaved }) {
  const [status,     setStatus]     = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saveError,  setSaveError]  = useState(null);

  useEffect(() => {
    api.getLinkedInStatus().then(setStatus).catch(() => {});
  }, []);

  const handleConnect = async () => {
    setConnecting(true);
    setSaveError(null);
    try {
      const { url } = await api.getLinkedInOAuthUrl();
      const popup = window.open(url, 'li_oauth', 'width=640,height=700,noopener');
      const poll = setInterval(async () => {
        if (popup && popup.closed) {
          clearInterval(poll);
          setConnecting(false);
          const s = await api.getLinkedInStatus(true);
          setStatus(s);
          if (s.connected) onSaved?.();
        }
      }, 800);
    } catch (err) {
      setSaveError(err.message);
      setConnecting(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setSaveError(null);
    try {
      const result = await api.refreshLinkedInToken();
      setStatus(prev => ({ ...prev, tokenDaysLeft: result.daysLeft }));
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setRefreshing(false);
    }
  };

  const daysLeft = status?.tokenDaysLeft;
  const tone = daysTone(daysLeft);

  return (
    <PanelShell platform="linkedin" title="LinkedIn" sub="LinkedIn OAuth · Marketing API" onClose={onClose}
      footer={<>
        <FooterCancel onClose={onClose} />
        <button onClick={handleConnect} disabled={connecting} style={{ ...BTN.primary, flex: 2, justifyContent: 'center', opacity: connecting ? .7 : 1, cursor: connecting ? 'not-allowed' : 'pointer' }}>
          {connecting ? 'Waiting for LinkedIn…' : status?.connected ? 'Reconnect with LinkedIn' : 'Connect with LinkedIn'}
        </button>
      </>}>
      {status && (
        <StatusBox status={status}>
          {status.connected ? (
            <>
              <ConnectedLine right={daysLeft != null && <Chip tone={tone}>Token expires in {daysLeft}d</Chip>} />
              <StatusText>
                {status.profile?.name}
                {status.profile?.orgName ? ` · ${status.profile.orgName}` : ''}
              </StatusText>
              {daysLeft != null && daysLeft <= 20 && (
                <button onClick={handleRefresh} disabled={refreshing} style={{ ...BTN_SM, ...chipTone(tone), marginTop: 10 }}>
                  {refreshing ? 'Refreshing…' : 'Refresh Token Now'}
                </button>
              )}
            </>
          ) : status.hasCredentials ? (
            <StatusText tone="err">⚠ {status.error}. Click Connect to re-authorise.</StatusText>
          ) : (
            <StatusText>Not connected. Click the button below to authorise via LinkedIn.</StatusText>
          )}
        </StatusBox>
      )}

      <Note>
        Clicking Connect opens a LinkedIn sign-in popup. Approve access as a <strong>Company Page admin</strong> and the token is saved automatically. Requires a LinkedIn App with <CodeTag>r_organization_social</CodeTag> and <CodeTag>rw_organization_admin</CodeTag> products enabled. Tokens are valid for <strong>60 days</strong> and can be refreshed silently.
      </Note>

      {saveError && <ErrorBox>{saveError}</ErrorBox>}
    </PanelShell>
  );
}

// ── Integration Card ─────────────────────────────────────────
function IntegrationCard({ int, onConfigure, onSync, isSyncing, onOpen }) {
  const disconnected = int.status === 'disconnected';
  const isInstagram  = int.platform === 'instagram';
  const isYouTube    = int.platform === 'youtube';
  const isFacebook   = int.platform === 'facebook';
  const isThreads    = int.platform === 'threads';
  const isLinkedIn   = int.platform === 'linkedin';
  const hasModal     = isInstagram || isYouTube || isFacebook || isThreads || isLinkedIn;

  const lastSyncText = timeSince(int.last_sync_at) || int.last_sync || '—';

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14, opacity: disconnected ? 0.85 : 1 }}>
      <div onClick={onOpen} title="Open accounts" style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: onOpen ? 'pointer' : 'default', margin: '-6px -6px 0', padding: 6, borderRadius: 12, transition: 'background .14s' }}
        onMouseEnter={e => { if (onOpen) e.currentTarget.style.background = C.surface; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
        <BrandChip platform={int.platform} lit={!disconnected} label={int.platform ? undefined : (int.iconKey || '?')} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...T.h3, color: C.text }}>{int.name}</div>
          <div style={{ fontSize: 13, color: C.textMuted, fontWeight: 450, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{int.account}</div>
        </div>
        <StatusDot status={int.status} />
        {onOpen && <ChevronRight size={16} color={C.textMuted} style={{ flexShrink: 0 }} />}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: C.surface, borderRadius: 12 }}>
        <div>
          <div style={{ ...T.label, color: C.textMuted }}>Last sync</div>
          {/* A timestamp — mono is right here. */}
          <div style={{ fontSize: 13, fontFamily: MONO, fontWeight: 500, color: C.text, marginTop: 4 }}>{isSyncing ? 'Syncing…' : lastSyncText}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ ...T.label, color: C.textMuted, marginBottom: 4 }}>Token</div>
          <TokenBadge token={int.token} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {disconnected ? (
          <button onClick={() => hasModal && onConfigure?.()} style={{ ...BTN.primary, flex: 1, justifyContent: 'center' }}>
            {hasModal ? 'Configure' : 'Connect'}
          </button>
        ) : (
          <>
            <button onClick={() => onSync?.()} disabled={isSyncing} style={{ ...BTN.secondary, flex: 1, justifyContent: 'center', opacity: isSyncing ? 0.6 : 1, minWidth: 80 }}>
              {isSyncing ? 'Syncing…' : 'Re-sync'}
            </button>
            {/* Opens the per-platform accounts page (drill-down) which holds the
                credentials editor + "Add account" — same features as the old modal. */}
            <button onClick={() => onOpen?.()} style={{ ...BTN.secondary, flex: 1, justifyContent: 'center', minWidth: 80 }}>
              <Users size={15} strokeWidth={2} /> View accounts
            </button>
          </>
        )}
      </div>
    </Card>
  );
}

// Credentials/connect modal per platform (used for both "Credentials" and "Add account").
const MODAL_BY_PLATFORM = {
  instagram: InstagramCredentialsModal,
  youtube:   YouTubeCredentialsModal,
  facebook:  FacebookCredentialsModal,
  threads:   ThreadsCredentialsModal,
  linkedin:  LinkedInCredentialsModal,
};

// ── Platform detail page (drill-down): list of that platform's accounts ──
function PlatformDetail({ platform }) {
  const meta = PLATFORMS[platform] || {};
  const Modal = MODAL_BY_PLATFORM[platform];
  const [ConfirmDialog, confirm] = useConfirm();
  const { data, loading, error, refetch } = useApi(() => api.getIntegrationAccounts(platform), [platform]);
  const acctList = data?.accounts || [];
  const canAdd = data?.canAdd === true;

  // Per-account token health (auto-refresh runs daily; this surfaces what it couldn't fix)
  const { data: tokenHealth } = useApi(() => api.getTokenHealth(), [platform]);
  const healthIssues = (tokenHealth?.attention || []).filter(h => h.platform === platform);

  const [configuring, setConfiguring] = useState(false);   // edit credentials modal (primary)
  const [syncingAll, setSyncingAll]   = useState(false);
  const [syncingId, setSyncingId]     = useState(null);

  // Surface OAuth callback results (Instagram connect, YouTube add).
  useEffect(() => {
    const q = window.location.hash.includes('?') ? window.location.hash.split('?')[1] : '';
    const p = new URLSearchParams(q);
    const clean = () => window.history.replaceState(null, '', '#/social/integrations/' + platform);
    if (p.get('ig_connected')) { showToast(`Instagram connected: @${p.get('ig_connected')}`, 'success'); refetch(); clean(); }
    else if (p.get('ig_error')) { showToast(`Instagram connection failed: ${p.get('ig_error')}`, 'error'); clean(); }
    else if (p.get('yt_added'))  { showToast(`Channel added: ${p.get('yt_added')}`, 'success'); refetch(); clean(); }
    else if (p.get('yt_connected')) { showToast('YouTube connected', 'success'); refetch(); clean(); }
    else if (p.get('yt_error'))  { showToast(`YouTube failed: ${p.get('yt_error')}`, 'error'); clean(); }
    else if (p.get('fb_added'))  { showToast(`Page(s) added: ${p.get('fb_added')}`, 'success'); refetch(); clean(); }
    else if (p.get('fb_connected')) { showToast('Facebook connected', 'success'); refetch(); clean(); }
    else if (p.get('fb_error'))  { showToast(`Facebook failed: ${p.get('fb_error')}`, 'error'); clean(); }
    else if (p.get('th_added'))  { showToast(`Account added: ${p.get('th_added')}`, 'success'); refetch(); clean(); }
    else if (p.get('th_connected')) { showToast('Threads connected', 'success'); refetch(); clean(); }
    else if (p.get('th_error'))  { showToast(`Threads failed: ${p.get('th_error')}`, 'error'); clean(); }
    else if (p.get('li_added'))  { showToast(`Org(s) added: ${p.get('li_added')}`, 'success'); refetch(); clean(); }
    else if (p.get('li_connected')) { showToast('LinkedIn connected', 'success'); refetch(); clean(); }
    else if (p.get('li_error'))  { showToast(`LinkedIn failed: ${p.get('li_error')}`, 'error'); clean(); }
  }, []);

  const back = () => { window.location.hash = '#/social/integrations'; };

  // "Add account" → OAuth that APPENDS a new account (full-page redirect).
  const addAccount = async () => {
    try {
      let url;
      if (platform === 'instagram')    ({ url } = await api.getInstagramOAuthUrl('add'));
      else if (platform === 'youtube') ({ url } = await api.getYouTubeOAuthUrl('add'));
      else if (platform === 'facebook')({ url } = await api.getFacebookOAuthUrl('add'));
      else if (platform === 'threads') ({ url } = await api.getThreadsOAuthUrl('add'));
      else if (platform === 'linkedin')({ url } = await api.getLinkedInOAuthUrl('add'));
      else { setConfiguring(true); return; }   // platforms without append-support yet → credentials modal
      window.location.href = url;
    } catch (e) { showToast(e.message || 'Could not start the connect flow', 'error'); }
  };

  const removeAccount = async (a) => {
    const ok = await confirm({ title: 'Remove this account?', body: `${a.label} will be disconnected from ForgeGrowth. Already-synced posts stay; you can reconnect later.`, confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try { await api.removeIntegrationAccount(platform, a.accountId); showToast('Account removed', 'success'); refetch(); }
    catch (e) { showToast(e.message || 'Remove failed', 'error'); }
  };

  // Disconnect the managed account (its credential lives in app_settings, so Remove can't reach it).
  const disconnectManaged = async (a) => {
    const ok = await confirm({ title: 'Disconnect this account?', body: `${a.label} will be disconnected from ForgeGrowth and stop syncing. Already-synced posts stay; you can reconnect later via Credentials or + Add account.`, confirmLabel: 'Disconnect', danger: true });
    if (!ok) return;
    try { await api.disconnectManagedAccount(platform); showToast(`${a.label} disconnected`, 'success'); refetch(); }
    catch (e) { showToast(e.message || 'Disconnect failed', 'error'); }
  };

  // Set this account as primary — controls the default account shown on the Overview.
  const makePrimary = async (a) => {
    try { await api.setPrimaryAccount(platform, a.accountId); showToast(`${a.label} set as primary`, 'success'); refetch(); }
    catch (e) { showToast(e.message || 'Could not set primary', 'error'); }
  };

  const syncAll = async () => {
    setSyncingAll(true);
    try { await api.syncPlatformAll(platform); showToast(`${meta.name || platform} synced`, 'success'); }
    catch (e) { showToast(e.message || 'Sync failed', 'error'); }
    finally { setTimeout(() => { setSyncingAll(false); refetch(); }, 1200); }
  };
  const syncOne = async (id) => {
    setSyncingId(id);
    try { await api.syncPlatformAll(platform); }   // per-account sync arrives with the Phase-2 module refactor
    catch (e) { showToast(e.message || 'Sync failed', 'error'); }
    finally { setTimeout(() => { setSyncingId(null); refetch(); }, 1200); }
  };

  const th = { textAlign: 'left', padding: '10px 14px', whiteSpace: 'nowrap' };
  const td = { padding: '12px 14px', verticalAlign: 'middle' };

  return (
    <div>
      {ConfirmDialog}
      <button onClick={back} style={{ ...BTN.secondary, padding: '8px 16px', fontSize: 13, marginBottom: 14 }}>← Back to integrations</button>
      <PageHeader
        cycle="Connected accounts"
        title={`${meta.name || platform}`}
        right={<>
          <button onClick={syncAll} disabled={syncingAll} style={{ ...BTN.secondary, opacity: syncingAll ? .7 : 1 }}>{syncingAll ? 'Syncing…' : 'Sync all'}</button>
          {/* Credential modal stays reachable even on platforms that support OAuth "add" —
              Facebook's dialog can't attach a Page asset, so the token paste is the way in. */}
          {Modal && (
            <button onClick={() => setConfiguring(true)} style={{ ...BTN.secondary, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <KeyRound size={14} strokeWidth={2} /> Credentials
            </button>
          )}
          {canAdd && (
            <button onClick={addAccount} style={BTN.primary}>+ Add account</button>
          )}
        </>}
      />

      {error && <div style={{ background: C.errBg, color: C.errText, padding: '12px 14px', borderRadius: 12, fontSize: 13, marginBottom: 16 }}>{error}</div>}

      {healthIssues.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {healthIssues.map((h, i) => {
            const severe = h.status === 'needs_reconnect';
            return (
              <Chip key={i} tone={severe ? 'err' : 'warn'} style={{ whiteSpace: 'normal', padding: '6px 12px', lineHeight: 1.4 }}>
                {h.account}: {severe
                  ? `needs reconnection — the token can't be renewed automatically${h.error ? ` (${h.error})` : ''}`
                  : h.status === 'refresh_failed'
                    ? `last token refresh failed — retrying automatically${h.error ? ` (${h.error})` : ''}`
                    : `token expires in ${h.daysLeft}d — auto-refresh will keep retrying daily`}
              </Chip>
            );
          })}
        </div>
      )}

      {loading && !data ? (
        <div style={{ padding: 40, textAlign: 'center', color: C.textMuted, ...T.small }}>Loading accounts…</div>
      ) : acctList.length === 0 ? (
        <Card style={{ padding: '24px 20px' }}>
          <EmptyState Icon={Plug} title={`No ${meta.name || platform} accounts connected`} body="Connect an account to start syncing its content."
            action={(canAdd || Modal) && <button onClick={canAdd ? addAccount : () => setConfiguring(true)} style={BTN.primary}>+ Add account</button>} />
        </Card>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          {/* Borderless table on the pane: the raised header strip + row hover come from the bridge. */}
          <table style={{ width: '100%', fontFamily: FONT }}>
            <thead>
              <tr>
                <th style={th}>Account</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {acctList.map((a) => (
                <tr key={a.accountId}>
                  <td style={td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                      <PlatformBadge platform={platform} size="md" />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ ...T.h3, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 8 }}>
                          {a.label}{a.primary && <Badge label="Primary" bg={C.primarySoft} color={C.primary} />}
                        </div>
                        {/* Handle / id — mono */}
                        <div style={{ fontSize: 12.5, color: C.textMuted, fontWeight: 450, marginTop: 2, fontFamily: MONO }}>{a.username ? '@' + a.username : a.accountId}</div>
                      </div>
                    </div>
                  </td>
                  <td style={td}><StatusDot status={a.connected ? 'connected' : 'disconnected'} /></td>
                  <td style={td}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
                      {!a.primary && (
                        <button onClick={() => makePrimary(a)} style={BTN_SM} title="Use as the default account on the Overview">
                          <Star size={13} strokeWidth={2} /> Set primary
                        </button>
                      )}
                      <button onClick={() => syncOne(a.accountId)} disabled={syncingId === a.accountId} style={{ ...BTN_SM, opacity: syncingId === a.accountId ? 0.6 : 1 }}>
                        {syncingId === a.accountId ? 'Syncing…' : 'Re-sync'}
                      </button>
                      {a.managed
                        ? (Modal && <button onClick={() => setConfiguring(true)} style={BTN_SM}>Credentials</button>)
                        : <button onClick={() => removeAccount(a)} style={BTN_SM_DANGER}>Remove</button>}
                      {a.managed && platform !== 'instagram' && (
                        <button onClick={() => disconnectManaged(a)} style={BTN_SM_DANGER}>Disconnect</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {platform === 'instagram' && <InstagramDmLinkCard />}

      {configuring && Modal && (
        <Modal onClose={() => setConfiguring(false)} onSaved={() => { setConfiguring(false); refetch(); }} />
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────
export default function IntegrationsPage({ platform = null, isAdmin = false }) {
  if (platform === 'telegram') return isAdmin ? <TelegramPage /> : <EmptyState title="Admins only" body="Only an admin can manage the Telegram bot." />;
  if (platform && PLATFORMS[platform]) return <PlatformDetail platform={platform} />;
  return <IntegrationsOverview isAdmin={isAdmin} />;
}

function IntegrationsOverview({ isAdmin }) {
  const { data: integrations, loading, refetch } = useIntegrations();
  const [configuringInstagram, setConfiguringInstagram] = useState(false);
  const [configuringYouTube,   setConfiguringYouTube]   = useState(false);
  const [configuringFacebook,  setConfiguringFacebook]  = useState(false);
  const [configuringThreads,   setConfiguringThreads]   = useState(false);
  const [configuringLinkedIn,  setConfiguringLinkedIn]  = useState(false);
  const [syncing, setSyncing] = useState({});
  const [syncAllLoading, setSyncAllLoading] = useState(false);

  // Show result of the Instagram OAuth callback (redirected to #/social/integrations?ig_connected|ig_error)
  useEffect(() => {
    const q = window.location.hash.includes('?') ? window.location.hash.split('?')[1] : '';
    const p = new URLSearchParams(q);
    if (p.get('ig_connected')) {
      showToast(`Instagram connected: @${p.get('ig_connected')}`, 'success');
      window.history.replaceState(null, '', '#/social/integrations');
    } else if (p.get('ig_error')) {
      showToast(`Instagram connection failed: ${p.get('ig_error')}`, 'error');
      window.history.replaceState(null, '', '#/social/integrations');
    }
  }, []);
  const handleSync = async (platform) => {
    setSyncing(prev => ({ ...prev, [platform]: true }));
    try {
      await api.syncPlatform(platform, { fullSync: true });
      await refetch();
    } catch (err) {
      console.error(`Sync failed for ${platform}:`, err);
    } finally {
      setSyncing(prev => ({ ...prev, [platform]: false }));
    }
  };

  const handleSyncAll = async () => {
    setSyncAllLoading(true);
    try {
      await api.syncAll();
      // Poll for completion
      setTimeout(async () => {
        await refetch();
        setSyncAllLoading(false);
      }, 3000);
    } catch (err) {
      console.error('Sync all failed:', err);
      setSyncAllLoading(false);
    }
  };

  if (loading || !integrations) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: C.textMuted, ...T.small }}>
        Loading integrations…
      </div>
    );
  }

  const socialPlatforms = integrations.filter(i => i.platform);
  const connected    = socialPlatforms.filter(i => i.status === 'connected').length;
  const total        = socialPlatforms.length;
  const expiring     = socialPlatforms.filter(i => i.token === 'expiring');
  const disconnected = socialPlatforms.filter(i => i.status === 'disconnected');
  const attentionCount  = expiring.length + disconnected.length;
  const minExpiryDays   = expiring.length ? Math.min(...expiring.map(i => i.tokenExpiryDays ?? 0)) : 0;
  const subtitleParts   = [];
  if (expiring.length)     subtitleParts.push(`${expiring.length} token${expiring.length !== 1 ? 's' : ''} expiring${minExpiryDays ? ` in ${minExpiryDays} days` : ''}`);
  if (attentionCount)      subtitleParts.push(`${attentionCount} source${attentionCount !== 1 ? 's' : ''} need${attentionCount === 1 ? 's' : ''} attention`);

  // Dynamic last refresh from last_sync_at
  const lastSyncTimes = socialPlatforms
    .map(i => i.last_sync_at ? new Date(i.last_sync_at).getTime() : 0)
    .filter(t => t > 0);
  const mostRecentSync = lastSyncTimes.length > 0 ? Math.max(...lastSyncTimes) : null;
  const lastRefreshText = timeSince(mostRecentSync ? new Date(mostRecentSync).toISOString() : null)
    || (socialPlatforms.map(i => i.last_sync).filter(Boolean)[0] || 'Never');
  const nextRefreshText = mostRecentSync
    ? `${Math.max(0, 30 - Math.round((Date.now() - mostRecentSync) / 60000))} min`
    : 'After first sync';

  const footLink = { color: C.textSecondary, fontWeight: 600 };

  return (
    <div>
      <PageHeader
        cycle="Connected sources"
        title="Integrations"
        right={
          <button onClick={handleSyncAll} disabled={syncAllLoading}
            style={{ ...BTN.primary, opacity: syncAllLoading ? .7 : 1, cursor: syncAllLoading ? 'not-allowed' : 'pointer' }}>
            {syncAllLoading ? 'Syncing all…' : 'Sync All Now'}
          </button>
        }
      />

      {isAdmin && <AppCredentialsCard />}

      <SectionHead right={<span style={{ fontSize: 12.5, color: C.textMuted, fontWeight: 500 }}>{socialPlatforms.length} source{socialPlatforms.length !== 1 ? 's' : ''}</span>}>Social Platforms</SectionHead>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 22 }}>
        {integrations.filter(i => i.platform).map(i => (
          <IntegrationCard
            key={i.id}
            int={i}
            isSyncing={syncing[i.platform]}
            onOpen={() => { window.location.hash = '#/social/integrations/' + i.platform; }}
            onSync={() => handleSync(i.platform)}
            onConfigure={
              i.platform === 'instagram' ? () => setConfiguringInstagram(true) :
              i.platform === 'youtube'   ? () => setConfiguringYouTube(true)   :
              i.platform === 'facebook'  ? () => setConfiguringFacebook(true)  :
              i.platform === 'threads'   ? () => setConfiguringThreads(true)   :
              i.platform === 'linkedin'  ? () => setConfiguringLinkedIn(true)  :
              undefined
            }
          />
        ))}
      </div>

      {isAdmin && <TelegramCard />}

      {configuringInstagram && (
        <InstagramCredentialsModal
          onClose={() => setConfiguringInstagram(false)}
          onSaved={() => { setConfiguringInstagram(false); refetch(); }}
        />
      )}
      {configuringYouTube && (
        <YouTubeCredentialsModal
          onClose={() => setConfiguringYouTube(false)}
          onSaved={() => { setConfiguringYouTube(false); refetch(); }}
        />
      )}
      {configuringFacebook && (
        <FacebookCredentialsModal
          onClose={() => setConfiguringFacebook(false)}
          onSaved={() => { setConfiguringFacebook(false); refetch(); }}
        />
      )}
      {configuringThreads && (
        <ThreadsCredentialsModal
          onClose={() => setConfiguringThreads(false)}
          onSaved={() => { setConfiguringThreads(false); refetch(); }}
        />
      )}
      {configuringLinkedIn && (
        <LinkedInCredentialsModal
          onClose={() => setConfiguringLinkedIn(false)}
          onSaved={() => { setConfiguringLinkedIn(false); refetch(); }}
        />
      )}

      {/* Platform compliance disclosures — YouTube ToS requires these to be
          discoverable wherever YouTube API data is used, not only at connect time. */}
      <div style={{ marginTop: 28, fontSize: 12.5, fontWeight: 450, color: C.textMuted, lineHeight: 1.7 }}>
        ForgeGrowth uses <strong>YouTube API Services</strong> (
        <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer" style={footLink}>YouTube Terms of Service</a> ·{' '}
        <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" style={footLink}>Google Privacy Policy</a> ·{' '}
        <a href="https://security.google.com/settings/security/permissions" target="_blank" rel="noopener noreferrer" style={footLink}>revoke access</a>
        ) and the official Meta, Threads, and LinkedIn APIs. Stored platform data is kept current via scheduled syncs; YouTube data not re-confirmed within 30 days is deleted. Users can disconnect any account here at any time, and Meta data-deletion requests are honored automatically.
      </div>
    </div>
  );
}

// Messaging: the Telegram bot that sends alerts (negative comments etc.). Admin only.
function TelegramCard() {
  const [st, setSt] = useState(null);
  useEffect(() => { api.telegram.status().then(setSt).catch(() => setSt({ configured: false })); }, []);
  const ok = st?.configured && st.status === 'connected';
  const open = () => { window.location.hash = '#/social/integrations/telegram'; };
  return (
    <>
      <SectionHead>Messaging</SectionHead>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 22 }}>
        <div role="button" tabIndex={0} onClick={open} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open())}
          style={{ background: C.raised, borderRadius: 16, padding: 16, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: '#229ED92e', color: '#229ED9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 14 }}>TG</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ ...T.h3, color: C.text }}>Telegram</div>
              <div style={{ fontSize: 12.5, color: C.textMuted, fontWeight: 500, marginTop: 2 }}>{st?.bot?.username ? '@' + st.bot.username : 'Instant alerts bot'}</div>
            </div>
            <ChevronRight size={16} color={C.textMuted} />
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {!st ? <Chip>Loading…</Chip>
              : !st.configured ? <Chip>Not connected</Chip>
              : <><Chip tone={ok ? 'ok' : 'err'}>{ok ? 'Connected' : 'Needs attention'}</Chip>
                  <Chip>{st.chats?.approved || 0} approved chat{st.chats?.approved === 1 ? '' : 's'}</Chip>
                  {st.chats?.pending > 0 && <Chip tone="warn">{st.chats.pending} waiting</Chip>}</>}
          </div>
        </div>
      </div>
    </>
  );
}
