import { useState, useRef, useEffect, useCallback } from 'react';
import { Bell, LogOut, Settings, AlertTriangle, MessageSquare, CheckCheck, Sun, Moon, AtSign, TrendingUp, Sparkles } from 'lucide-react';
import { C, FONT, MONO, relativeTime, maskPhone } from '../constants.js';
import { api } from '../api.js';
import { showError } from '../lib/feedback.js';
import { useTheme } from '../theme.jsx';
import logoUrl from '../assets/forgemind-logo.gif';
import { HeaderSegmented } from './PillStrip.jsx';
import { useIsPhone } from '../lib/useIsPhone.js';
import { ContactDialog } from './ContactForgemind.jsx';

// Two modes, one switch. The icon shows the mode you are IN; clicking flips it.

// The workspaces: Social and Sales. Chats used to be its own tab, which split one job
// across two places: the funnel and the conversation are the same people seen
// from opposite ends, and moving between them meant changing workspace. The
// inbox, automations and agents now live inside Sales.
const SECTIONS = [
  { id: 'social', label: 'Social', Icon: AtSign },
  { id: 'sales', label: 'Sales', Icon: TrendingUp },
];

// The bar is BLACK — constant chrome, the way the reference dashboards do it —
// and darker than the near-black page behind it, so its own controls cannot
// read the page palette. They use a translucent white fill and white text, and
// the active one is a solid accent pill. Nothing here carries an outline.
const ON_BLACK = 'rgba(255,255,255,.08)';

// 34px round icon button — the one shape every control on the right rail takes.
function IconButton({ title, onClick, children, innerRef, style }) {
  return (
    <button
      ref={innerRef}
      onClick={onClick}
      title={title}
      style={{
        width: 34, height: 34, borderRadius: 999, border: 'none', padding: 0,
        background: ON_BLACK, color: '#fff', cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, transition: 'background .15s', ...style,
      }}
      // Hover moves the FILL only. A handler that changes a colour has to
      // restore the same token the resting style uses, and the two drift the
      // first time one of them is edited — so there is no colour to restore.
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,.16)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = style?.background || ON_BLACK; }}
    >
      {children}
    </button>
  );
}

export default function Topbar({ user, onLogout, onNavigate, navigate, section, onSectionChange, hideSections }) {
  const { theme, setTheme } = useTheme();
  const ThemeIcon = theme === 'light' ? Sun : Moon;
  // Phones: the mark without the wordmark, the Social/Sales switch in the flow
  // (not centred over the brand), and the theme switch and Settings inside the
  // avatar menu — the bar fits a 390px screen with all four controls tappable.
  const phone = useIsPhone();
  const [userOpen, setUserOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [unhealthyAccounts, setUnhealthyAccounts] = useState([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifs, setNotifs] = useState([]);
  const [markingAll, setMarkingAll] = useState(false);
  const ref = useRef(null);
  const notifRef = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setUserOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    const handleClick = (e) => {
      if (notifRef.current && !notifRef.current.contains(e.target)) setNotifOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Unread conversations across every number this user can see. 30s is the
  // cadence the rest of the app polls at; the SSE stream carries contact and
  // lead events, not inbound messages, so there is nothing to subscribe to yet.
  const loadNotifs = useCallback(() => api.notifications(20)
    .then(r => setNotifs(r.notifications || []))
    .catch(() => {}), []);
  useEffect(() => {
    loadNotifs();
    const t = setInterval(loadNotifs, 30000);
    return () => clearInterval(t);
  }, [loadNotifs]);

  // "Mark all read": clear the list optimistically so the badge goes at once,
  // then stamp every unread conversation server-side. A failure puts the list
  // back by refetching — the badge must never claim "read" for something the
  // server still counts as unread.
  const markAllRead = async () => {
    if (markingAll || !notifs.length) return;
    setMarkingAll(true);
    setNotifs([]);
    try { await api.markAllRead(); }
    catch (e) { showError(e.message); }
    finally { setMarkingAll(false); loadNotifs(); }
  };

  // ⚠ `onNavigate` is a SINGLE-ARG wrapper in App.jsx (`p => setPage(p)`), so
  // extra arguments are silently dropped — a bell that opened the Chats page on
  // whatever conversation happened to be selected, never the one clicked. The
  // multi-arg `navigate` is passed in separately for exactly this.
  const openChat = (n) => {
    setNotifOpen(false);
    if (navigate) navigate('chats', n.waNumber, n.contactNumber);
    else onNavigate('chats');
  };

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
          background: C.dangerBg, color: C.dangerText, padding: '10px 18px',
          borderRadius: 'var(--fc-r-md)', flexShrink: 0,
          fontSize: 14, fontFamily: FONT, display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 8, cursor: 'pointer', fontWeight: 650,
        }}
      >
        <AlertTriangle size={15} />
        <span>
          Access token expired for {unhealthyAccounts.map(a => a.displayName).join(', ')} — click to update in Settings → WhatsApp Accounts
        </span>
      </div>
    )}

    {/* The floating black bar. Height, fill, radius and the gutter all come from
        `.fc-header` in styles/forge.css so the header, the two panes and the
        gap between them cannot disagree. */}
    <div className="fc-header">
      {/* Brand: mark + FORGE + the product chip in the accent. */}
      <button
        onClick={() => onNavigate('home')}
        style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 9,
          background: 'transparent', border: 'none', padding: 0,
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <img
          src={logoUrl}
          alt="ForgeMind"
          style={{ height: 30, width: 30, objectFit: 'contain', flexShrink: 0 }}
          onError={e => { e.currentTarget.style.display = 'none'; }}
        />
        {!phone && <span style={{
          fontSize: 15, fontWeight: 780, color: '#fff', fontFamily: FONT,
          letterSpacing: '-.01em', textTransform: 'uppercase', lineHeight: 1,
          display: 'inline-flex', alignItems: 'center', gap: 7,
        }}>
          FORGE
          <span style={{
            background: C.primary, color: '#fff', padding: '2px 8px',
            borderRadius: 8, lineHeight: 1.25, display: 'inline-block',
          }}>GROWTH</span>
        </span>}
      </button>

      {/* The primary mode switch, ABSOLUTELY centred on the bar rather than
          centred in the space left over. Flex-centring it made the group drift
          left or right with the width of the brand and of the right rail, so it
          was never actually on the bar's centre line. */}
      {!hideSections && (
        <div style={phone
          ? { marginLeft: 10, minWidth: 0 }
          : { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}>
          {/* ONE accent pill that SLIDES between Social and Sales — never a
              per-item background, which is what makes the selection pop. */}
          <HeaderSegmented items={SECTIONS} value={section} onChange={onSectionChange} />
        </div>
      )}

      {/* Right rail — discs, all 34px, all the same fill. */}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        {!phone && (
          <IconButton
            title={`${theme === 'light' ? 'Light' : 'Dark'} mode — click to switch`}
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          >
            <ThemeIcon size={16} strokeWidth={2} />
          </IconButton>
        )}

        {/* One Settings for the whole app — Sales, Chats and Social. */}
        {!phone && (
          <IconButton title="Settings" onClick={() => onNavigate('admin-settings')}>
            <Settings size={16} strokeWidth={2} />
          </IconButton>
        )}

        <div ref={notifRef} style={{ position: 'relative' }}>
          <IconButton
            title={notifs.length ? `${notifs.length} unread conversation${notifs.length === 1 ? '' : 's'}` : 'No unread messages'}
            onClick={() => setNotifOpen(o => !o)}
          >
            <Bell size={16} strokeWidth={2} />
            {notifs.length > 0 && (
              <span style={{
                position: 'absolute', top: -2, right: -2, minWidth: 17, height: 17, padding: '0 4px',
                borderRadius: 999, background: 'var(--fc-primary-hover)', color: '#fff', fontSize: 11, fontWeight: 700,
                lineHeight: '17px', textAlign: 'center', fontFamily: FONT, pointerEvents: 'none',
              }}>{notifs.length > 9 ? '9+' : notifs.length}</span>
            )}
          </IconButton>

          {notifOpen && (
            <div style={{
              position: phone ? 'fixed' : 'absolute', top: phone ? 'calc(var(--fc-header-h) + var(--fc-gutter) * 2)' : 42,
              right: phone ? 'var(--fc-gutter)' : 0, left: phone ? 'var(--fc-gutter)' : undefined,
              width: phone ? 'auto' : 340, maxHeight: phone ? '70dvh' : 420, overflowY: 'auto',
              background: 'var(--fc-raised)', borderRadius: 'var(--fc-r-md)',
              boxShadow: 'var(--fc-shadow-lg)', padding: 6, zIndex: 200,
              animation: 'fc-pop-in .2s ease', fontFamily: FONT,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px 6px', gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 650, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                  Unread messages
                </span>
                {notifs.length > 0 && (
                  <button
                    type="button"
                    onClick={markAllRead}
                    disabled={markingAll}
                    title="Mark every unread conversation as read"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none',
                      padding: '3px 6px', borderRadius: 8, cursor: markingAll ? 'default' : 'pointer',
                      fontFamily: FONT, fontSize: 12.5, fontWeight: 650, color: C.primary, opacity: markingAll ? 0.6 : 1,
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--fc-surface)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <CheckCheck size={14} /> Mark all read
                  </button>
                )}
              </div>

              {notifs.length === 0 ? (
                <div style={{ padding: '18px 12px 22px', textAlign: 'center', color: C.textMuted, fontSize: 14 }}>
                  Nothing waiting — every conversation is read.
                </div>
              ) : notifs.map(n => (
                <button
                  key={`${n.waNumber}-${n.contactNumber}`}
                  className="fc-menu-row"
                  onClick={() => openChat(n)}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%',
                    padding: '10px 12px', border: 'none', borderRadius: 12, background: 'transparent',
                    cursor: 'pointer', textAlign: 'left', fontFamily: FONT, marginBottom: 2,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--fc-surface)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{
                    width: 32, height: 32, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                    background: 'var(--fc-surface-2)', color: C.textSecondary,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}><MessageSquare size={14} /></span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{
                        flex: 1, minWidth: 0, fontSize: 14, fontWeight: 650, color: C.text,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>{n.name || maskPhone(n.contactNumber)}</span>
                      <span style={{ fontSize: 12, color: C.textMuted, fontFamily: MONO, flexShrink: 0 }}>
                        {relativeTime(n.at)}
                      </span>
                    </span>
                    <span style={{
                      display: 'block', fontSize: 13, color: C.textSecondary, marginTop: 2,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{n.snippet || '—'}</span>
                    {/* WHICH business number it arrived on — with several WABAs
                        the name alone does not say where to reply from. */}
                    {n.accountName && (
                      <span style={{ display: 'block', fontSize: 11.5, color: C.textMuted, marginTop: 2 }}>
                        {n.accountName}{n.unreadCount > 1 ? ` · ${n.unreadCount} messages` : ''}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Contact Forgemind for customisation — the same card as the one above
            the sidebar's Collapse, and the only way to it on a phone. */}
        <IconButton title="Customise Forge Growth — contact Forgemind" onClick={() => setContactOpen(true)}>
          <Sparkles size={16} strokeWidth={2} />
        </IconButton>
        {contactOpen && <ContactDialog onClose={() => setContactOpen(false)} />}

        <div ref={ref} style={{ position: 'relative' }}>
          {/* The avatar is the accent disc — the one saturated thing on the bar
              besides the active tab and the product chip. */}
          <IconButton
            onClick={() => setUserOpen(p => !p)}
            title={user.displayName || user.username}
            style={{ background: C.primary, fontSize: 14, fontWeight: 780, fontFamily: FONT }}
          >
            {(user.displayName || user.username).charAt(0).toUpperCase()}
          </IconButton>

          {userOpen && (
            <div style={{
              position: 'absolute', top: 42, right: 0,
              background: 'var(--fc-raised)', borderRadius: 'var(--fc-r-md)',
              boxShadow: 'var(--fc-shadow-lg)', padding: 6, minWidth: 200,
              zIndex: 200, animation: 'fc-pop-in .2s ease',
            }}>
              <div style={{ padding: '10px 12px 12px' }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text, fontFamily: FONT }}>
                  {user.displayName || user.username}
                </div>
                <div style={{
                  fontSize: 12, color: C.textMuted, marginTop: 3, fontFamily: FONT,
                  fontWeight: 650, letterSpacing: '.04em', textTransform: 'uppercase',
                }}>
                  {user.role}
                </div>
              </div>
              {[
                { Icon: Settings, label: user?.role === 'admin' ? 'Admin Settings' : 'Settings', color: C.text, act: () => onNavigate('admin-settings') },
                ...(phone ? [{ Icon: ThemeIcon, label: theme === 'light' ? 'Dark mode' : 'Light mode', color: C.text, act: () => setTheme(theme === 'light' ? 'dark' : 'light') }] : []),
                { Icon: LogOut, label: 'Sign out', color: C.primary, act: onLogout },
              ].map(row => (
                <button
                  key={row.label}
                  onClick={() => { setUserOpen(false); row.act(); }}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 9,
                    padding: '9px 12px', borderRadius: 10, background: 'transparent',
                    border: 'none', cursor: 'pointer', color: row.color,
                    fontSize: 14, fontWeight: 650, fontFamily: FONT, textAlign: 'left',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--fc-surface)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <row.Icon size={15} strokeWidth={2} />
                  {row.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
