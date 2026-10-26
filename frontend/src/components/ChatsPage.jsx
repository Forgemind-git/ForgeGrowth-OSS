import { toLayout } from '../lib/uiZoom.js';
import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import NumberSidebar from './NumberSidebar.jsx';
import ContactList from './ContactList.jsx';
import ChatWindow from './ChatWindow.jsx';
import { C } from '../constants.js';
import { useIsPhone } from '../lib/useIsPhone.js';

const MIN_CONTACT_W = 280;
const MAX_CONTACT_W = 620;
const DEFAULT_CONTACT_W = 380;
const LS_WIDTH = 'forgecrm.chats.contactWidth';
const LS_COLLAPSED = 'forgecrm.chats.navCollapsed';
// Below this much room (layout px) the three panes cannot all sit at a usable
// width — numbers 320 + contacts 380 + a chat the composer fits in — so with a
// chat open the numbers pane folds to its rail. Not saved: a wider window
// brings it back.
const TIGHT_W = 1100;

export default function ChatsPage({ subParts = [], navigate, user }) {
  const selectedNumber = subParts[0] || null;
  const selectedContact = subParts[1] || null;
  const [contactRefreshKey, setContactRefreshKey] = useState(0);

  // Persisted UI prefs — read once on mount, written back on change.
  const [navCollapsed, setNavCollapsed] = useState(
    () => localStorage.getItem(LS_COLLAPSED) === '1'
  );
  const [contactWidth, setContactWidth] = useState(() => {
    const v = parseInt(localStorage.getItem(LS_WIDTH), 10);
    return Number.isFinite(v) ? Math.min(MAX_CONTACT_W, Math.max(MIN_CONTACT_W, v)) : DEFAULT_CONTACT_W;
  });

  useEffect(() => { localStorage.setItem(LS_COLLAPSED, navCollapsed ? '1' : '0'); }, [navCollapsed]);

  const rootRef = useRef(null);
  const [tight, setTight] = useState(false);
  // Opened from the rail while tight: stays open until the next chat is chosen.
  const [peekNumbers, setPeekNumbers] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setTight(toLayout(el.getBoundingClientRect().width) < TIGHT_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const numbersFolded = navCollapsed || (tight && !!selectedContact && !peekNumbers);
  useEffect(() => { localStorage.setItem(LS_WIDTH, String(contactWidth)); }, [contactWidth]);

  const selectNumber = (n) => navigate('chats', n);
  const selectContact = (c) => { setPeekNumbers(false); navigate('chats', selectedNumber, c); };

  // Drag the divider to resize the contacts list; the chat window (flex:1) takes the rest.
  const startResize = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = contactWidth;
    const onMove = (ev) => {
      const next = Math.min(MAX_CONTACT_W, Math.max(MIN_CONTACT_W, startW + toLayout(ev.clientX - startX)));
      setContactWidth(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [contactWidth]);

  // Phones: one pane at a time, like WhatsApp — numbers, then that number's
  // contacts, then the chat, each with a way back.
  const phone = useIsPhone();
  if (phone) {
    return (
      <div style={{ display: 'flex', flex: 1, height: '100%', overflow: 'hidden', background: C.pageBg }}>
        {selectedContact ? (
          <ChatWindow
            key={`${selectedNumber}-${selectedContact}`}
            waNumber={selectedNumber}
            contactNumber={selectedContact}
            user={user}
            onContactSaved={() => setContactRefreshKey(k => k + 1)}
            onBack={() => navigate('chats', selectedNumber)}
          />
        ) : selectedNumber ? (
          <ContactList
            key={selectedNumber}
            waNumber={selectedNumber}
            fill
            selectedContact={null}
            onSelectContact={selectContact}
            refreshKey={contactRefreshKey}
            user={user}
            onBack={() => navigate('chats')}
          />
        ) : (
          <NumberSidebar
            fill
            selectedNumber={null}
            onSelectNumber={selectNumber}
            canRename={user?.role === 'admin'}
          />
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} style={{ display: 'flex', flex: 1, height: '100%', overflow: 'hidden', background: C.pageBg }}>
      {numbersFolded ? (
        <div style={{
          width: 48, minWidth: 48, flexShrink: 0,
          background: 'var(--c-cardBg)', borderRight: `1px solid ${C.borderDark}`,
          display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 14,
        }}>
          <button
            onClick={() => { setNavCollapsed(false); setPeekNumbers(true); }}
            title="Show WhatsApp numbers"
            style={{
              width: 34, height: 34, borderRadius: 8, border: 'none',
              background: 'var(--c-chatPanel)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--c-hover)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--c-chatPanel)'; }}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      ) : (
        <NumberSidebar
          selectedNumber={selectedNumber}
          onSelectNumber={selectNumber}
          canRename={user?.role === 'admin'}
          onCollapse={() => { setNavCollapsed(true); setPeekNumbers(false); }}
        />
      )}

      {selectedNumber && (
        <>
          <ContactList
            key={selectedNumber}
            waNumber={selectedNumber}
            width={contactWidth}
            selectedContact={selectedContact}
            onSelectContact={selectContact}
            refreshKey={contactRefreshKey}
            user={user}
          />
          {/* Drag handle: resize contacts list ⇄ chat window */}
          <div
            onMouseDown={startResize}
            title="Drag to resize"
            style={{
              width: 6, minWidth: 6, flexShrink: 0, cursor: 'col-resize',
              background: 'transparent', zIndex: 5, alignSelf: 'stretch',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = C.primary + '33'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          />
        </>
      )}

      {selectedContact ? (
        <ChatWindow
          key={`${selectedNumber}-${selectedContact}`}
          waNumber={selectedNumber}
          contactNumber={selectedContact}
          user={user}
          onContactSaved={() => setContactRefreshKey(k => k + 1)}
        />
      ) : (
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: C.textMuted,
          fontSize: 15,
          background: 'var(--c-chatPanel)',
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>💬</div>
            <div>Select a contact to view chat</div>
          </div>
        </div>
      )}
    </div>
  );
}
