import { useState, useRef, useEffect } from 'react';
import { Bell, LogOut, ChevronDown, User, Settings, AlertTriangle, Sun, Moon, Monitor } from 'lucide-react';
import { C, FONT } from '../constants.js';
import { api } from '../api.js';
import { useTheme } from '../theme.jsx';
import logoUrl from '../assets/forgemind-logo.gif';

const THEME_CYCLE = { light: 'dark', dark: 'system', system: 'light' };
const THEME_ICON = { light: Sun, dark: Moon, system: Monitor };

const SECTIONS = [
  { id: 'marketing', label: 'Marketing' },
  { id: 'sales', label: 'Sales' },
  { id: 'chats', label: 'Chats' },
];

export default function Topbar({ user, onLogout, onNavigate, section, onSectionChange, hideSections }) {
  const { theme, setTheme } = useTheme();
  const ThemeIcon = THEME_ICON[theme] || Sun;
  const [userOpen, setUserOpen] = useState(false);
  const [unhealthyAccounts, setUnhealthyAccounts] = useState([]);
  const ref = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setUserOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Poll account health every 60s so the banner appears within a minute
  // of Meta rejecting a token. Cleared instantly when token is updated.
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      api.whatsappAccounts.list()
        .then(accs => { if (!cancelled) setUnhealthyAccounts(accs.filter(a => a.healthStatus === 'invalid_token')); })
        .catch(() => {});
    };
    check();
    const t = setInterval(check, 60000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <>
    {user?.role === 'admin' && unhealthyAccounts.length > 0 && (
      <div
        onClick={() => onNavigate('admin-settings')}
        style={{
          background: '#A32D2D', color: '#fff', padding: '8px 16px',
          fontSize: 12, fontFamily: FONT, display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 8, cursor: 'pointer', fontWeight: 500,
        }}
      >
        <AlertTriangle size={14} />
        <span>
          Access token expired for {unhealthyAccounts.map(a => a.displayName).join(', ')} — click to update in Settings → WhatsApp Accounts
        </span>
      </div>
    )}
    <div style={{
      height: 56,
      background: C.headerBg,
      display: 'flex',
      alignItems: 'center',
      paddingLeft: 13,
      paddingRight: 20,
      borderBottom: `1px solid ${C.headerBorder}`,
      flexShrink: 0,
      zIndex: 100,
      position: 'relative',
    }}>
      {/* Logo area — flush-left logo + wordmark (matches ForgeSocial) */}
      <button
        onClick={() => onNavigate('chats')}
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <img
          src={logoUrl}
          alt="ForgeMind"
          style={{ height: 36, width: 36, objectFit: 'contain', flexShrink: 0 }}
          onError={e => { e.currentTarget.style.display = 'none'; }}
        />
        <div style={{ lineHeight: 1.1 }}>
          <div style={{
            fontSize: 16,
            fontWeight: 900,
            color: C.headerText,
            fontFamily: FONT,
            letterSpacing: '-0.01em',
            textTransform: 'uppercase',
            lineHeight: 1,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}>
            FORGE
            <span style={{
              background: C.primary,
              color: '#fff',
              padding: '2px 7px',
              borderRadius: 6,
              lineHeight: 1.2,
              display: 'inline-block',
            }}>GROWTH</span>
          </div>
        </div>
      </button>

      {/* Section tabs — Marketing / Sales / Chats. Each section drives its own
          sidebar nav (see Sidebar SECTION_NAV); section is UI state in App.jsx. */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
        {!hideSections && (
        <div style={{
          display: 'flex',
          gap: 4,
          background: C.headerSurface,
          border: `1.5px solid ${C.headerBorder}`,
          borderRadius: 11,
          padding: 3,
        }}>
          {SECTIONS.map(s => {
            const active = section === s.id;
            return (
              <button
                key={s.id}
                onClick={() => onSectionChange(s.id)}
                style={{
                  padding: '7px 18px',
                  borderRadius: 8,
                  border: 'none',
                  cursor: 'pointer',
                  background: active ? C.primary : 'transparent',
                  color: active ? '#fff' : C.headerText,
                  opacity: active ? 1 : 0.7,
                  fontFamily: FONT,
                  fontSize: 13,
                  fontWeight: active ? 700 : 500,
                  letterSpacing: '-.01em',
                  transition: 'all .15s',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.opacity = 1; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.opacity = 0.7; }}
              >
                {s.label}
              </button>
            );
          })}
        </div>
        )}
      </div>

      {/* Right controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Theme toggle (Light → Dark → System) */}
        <button
          onClick={() => setTheme(THEME_CYCLE[theme] || 'light')}
          title={`Theme: ${theme} (click to switch)`}
          style={{
            width: 36, height: 36, borderRadius: 9,
            background: C.headerSurface, border: `1.5px solid ${C.headerBorder}`,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
          <ThemeIcon size={16} color={C.headerText} />
        </button>

        {/* Bell */}
        <button style={{
          width: 36,
          height: 36,
          borderRadius: 9,
          background: C.headerSurface,
          border: `1.5px solid ${C.headerBorder}`,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <Bell size={16} color={C.headerText} />
        </button>

        {/* User avatar */}
        <div ref={ref} style={{ position: 'relative' }}>
          <button
            onClick={() => setUserOpen(p => !p)}
            style={{
              width: 36,
              height: 36,
              borderRadius: 9,
              background: 'linear-gradient(135deg, #534AB7, #7B72E0)',
              border: userOpen ? '2px solid #fff' : `1.5px solid ${C.headerBorder}`,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 15,
              fontWeight: 700,
              color: '#fff',
              fontFamily: FONT,
              transition: 'border .15s',
              padding: 0,
              overflow: 'hidden',
            }}
          >
            {(user.displayName || user.username).charAt(0).toUpperCase()}
          </button>

          {userOpen && (
            <div style={{
              position: 'absolute',
              top: 44,
              right: 0,
              background: C.cardBg,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              boxShadow: C.shadowMd,
              padding: 6,
              minWidth: 180,
              zIndex: 200,
            }}>
              <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, marginBottom: 4 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
                  {user.displayName || user.username}
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                  {user.role}
                </div>
              </div>
              <button
                onClick={() => { setUserOpen(false); onNavigate('admin-settings'); }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 6,
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: C.text,
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: FONT,
                  marginBottom: 4,
                }}
              >
                <Settings size={14} />
                {user?.role === 'admin' ? 'Admin Settings' : 'Settings'}
              </button>
              <button
                onClick={() => { setUserOpen(false); onLogout(); }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 6,
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: C.primary,
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: FONT,
                }}
              >
                <LogOut size={14} />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
