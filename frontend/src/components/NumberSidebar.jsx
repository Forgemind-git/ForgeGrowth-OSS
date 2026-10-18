import { useState, useCallback } from 'react';
import { Search, ChevronLeft, Pencil } from 'lucide-react';
import RenameNumberModal from './RenameNumberModal.jsx';
import { usePolling } from '../hooks/usePolling.js';
import { useServerEvents } from '../hooks/useServerEvents.js';
import { api } from '../api.js';
import { C, FONT, maskPhone } from '../constants.js';

export default function NumberSidebar({ selectedNumber, onSelectNumber, onCollapse, canRename = false }) {
  const [search, setSearch] = useState('');
  const [renaming, setRenaming] = useState(null);
  // 30s polling as a fallback; SSE pushes most updates within ~100ms.
  const { data: numbers, loading, refetch } = usePolling(() => api.numbers(), 30000);
  useServerEvents(useCallback((ev) => {
    if (ev.type === 'contact-assignment-changed' || ev.type === 'conversation-read' || ev.type === 'numbers-changed') refetch();
  }, [refetch]));

  const filtered = (numbers || []).filter(n =>
    !search || n.wa_number.includes(search)
      || (n.display_name && n.display_name.toLowerCase().includes(search.toLowerCase()))
      || (n.account_name && n.account_name.toLowerCase().includes(search.toLowerCase()))
  );

  const getInitials = (name) => {
    if (!name) return '';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  };

  return (
    <aside style={{
      width: 320,
      minWidth: 320,
      background: 'var(--c-cardBg)',
      borderRight: `1px solid ${C.borderDark}`,
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      height: '100%',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        background: 'var(--c-chatPanel)',
        borderBottom: `1px solid ${C.borderDark}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: C.text, fontFamily: FONT, letterSpacing: '-0.01em' }}>
          WhatsApp Numbers
        </span>
        <button
          onClick={onCollapse}
          title="Hide WhatsApp numbers"
          style={{
            width: 32, height: 32, borderRadius: 8, border: 'none',
            background: 'transparent', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: C.textMuted,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--c-hover)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
        >
          <ChevronLeft size={18} />
        </button>
      </div>

      {/* Search */}
      <div style={{ padding: '8px 12px', background: 'var(--c-cardBg)', borderBottom: `1px solid ${C.borderDark}` }}>
        <div className="fc-searchfield">
          <Search size={16} color={C.textMuted} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search numbers..."
            style={{
              flex: 1, border: 'none', background: 'transparent',
              fontSize: 15, fontFamily: FONT, outline: 'none', color: C.text,
            }}
          />
        </div>
      </div>

      {/* Numbers list */}
      <div style={{ flex: 1, overflowY: 'auto', background: 'var(--c-cardBg)' }}>
        {loading && !numbers && (
          <div style={{ padding: 30, textAlign: 'center', color: C.textMuted, fontSize: 15 }}>
            Loading numbers...
          </div>
        )}

        {filtered.map(n => {
          const isActive = selectedNumber === n.wa_number;
          const displayName = n.display_name || maskPhone(n.wa_number);
          const hasPicture = n.profile_picture_url;
          const unread = Number(n.unread_chats) || 0;

          return (
            <div
              key={n.wa_number}
              role="button"
              tabIndex={0}
              className="fc-number-row"
              onClick={() => onSelectNumber(n.wa_number)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectNumber(n.wa_number); } }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 12px',
                margin: '0 8px 4px',
                width: 'calc(100% - 16px)',
                boxSizing: 'border-box',
                border: 'none',
                borderRadius: 14,
                cursor: 'pointer',
                background: isActive ? 'var(--c-rowActive)' : 'transparent',
                fontFamily: FONT,
                textAlign: 'left',
                transition: 'background .1s',
                position: 'relative',
              }}
              // Restore the TOKEN on leave, never a literal — see ContactList.
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--c-rowHover)'; }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
            >
              {/* Avatar */}
              <div style={{
                width: 44, height: 44, borderRadius: '50%',
                background: hasPicture ? 'transparent' : (isActive ? C.primary : C.avatarBg),
                color: isActive ? '#fff' : C.avatarText,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 15, fontWeight: 700, flexShrink: 0,
                overflow: 'hidden',
                position: 'relative',
              }}>
                {hasPicture ? (
                  <img
                    src={n.profile_picture_url}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={e => { e.target.style.display = 'none'; e.target.parentElement.style.background = isActive ? C.primary : C.avatarBg; }}
                  />
                ) : (
                  <span>{getInitials(displayName)}</span>
                )}
              </div>

              {/* Info — show the saved name only; fall back to the (masked) number
                  when there is no saved name. No separate number line. */}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{
                    fontSize: 16, fontWeight: 600, color: C.text,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {displayName}
                  </span>
                </div>
              </div>

              {/* Unread chats badge */}
              {unread > 0 && (
                <span
                  title={`${unread} unread chat${unread === 1 ? '' : 's'}`}
                  style={{
                    flexShrink: 0,
                    background: C.waGreen, color: '#fff',
                    borderRadius: 11, minWidth: 22, height: 22, padding: '0 7px',
                    fontSize: 14, fontWeight: 700,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  {unread > 99 ? '99+' : unread}
                </span>
              )}

              {/* Rename (admin, registered accounts only) — a display label;
                  the real number and Meta's verified name never change. */}
              {canRename && n.account_id && (
                <button
                  type="button"
                  className="fc-number-rename"
                  title="Rename this number"
                  aria-label={`Rename ${displayName}`}
                  onClick={e => { e.stopPropagation(); setRenaming(n); }}
                  style={{
                    flexShrink: 0, width: 30, height: 30, borderRadius: 8, border: 'none',
                    background: 'transparent', color: C.textMuted, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--c-hover)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <Pencil size={15} />
                </button>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && !loading && (
          <div style={{ padding: 40, textAlign: 'center', color: C.textMuted, fontSize: 15 }}>
            No numbers found
          </div>
        )}
      </div>
      {renaming && (
        <RenameNumberModal
          accountId={renaming.account_id}
          phone={renaming.wa_number}
          currentLabel={renaming.label}
          accountName={renaming.account_name}
          onClose={() => setRenaming(null)}
          onSaved={() => refetch()}
        />
      )}
    </aside>
  );
}
