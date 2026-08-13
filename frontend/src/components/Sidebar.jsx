import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Home, Zap, LayoutTemplate, MessageCircle,
  Megaphone, Image as ImageIcon, Link, Kanban, Bot,
  ChevronLeft, ChevronRight,
  LayoutDashboard,
  KanbanSquare, Package,
  Receipt, FormInput, MousePointerClick, Radio, Target, CreditCard,
  FolderKanban,
  IndianRupee,
} from 'lucide-react';
import { C, FONT } from '../constants.js';

// Home is pinned above the groups — it is the one destination that belongs to
// no category, and burying it would cost a click on every session.
const HOME_ITEM = { id: 'home', label: 'Home', Icon: Home };

// Chats and Sales were two header tabs looking at the same people from two
// ends — the funnel and the conversation — so they are ONE section now, named
// Sales. That leaves ~17 destinations, far too many as a flat list, so they stay
// grouped by what the user is trying to DO, with the sales surfaces first
// because that is what the section is called.
//
// Route keys are untouched throughout: renaming a page key silently drops any
// stored per-user permission override that granted it.
const SALES_GROUPS = [
  {
    id: 'sales', label: 'Sales', Icon: KanbanSquare,
    items: [
      // One destination for the whole leads model — Funnel and All Leads (which
      // itself switches between list and board) are internal views of
      // LeadsHubPage, not separate nav entries.
      { id: 'leads', label: 'Leads', Icon: KanbanSquare },
      { id: 'onboarding', label: 'Sales Log', Icon: Receipt },
      { id: 'payments', label: 'Payments', Icon: CreditCard },
    ],
  },
  {
    id: 'inbox', label: 'Inbox', Icon: MessageCircle,
    items: [
      { id: 'chats', label: 'Chats', Icon: MessageCircle },
    ],
  },
  {
    id: 'automation', label: 'Automation', Icon: Zap,
    items: [
      { id: 'chatbot-builder', label: 'Automations', Icon: Zap },
      { id: 'ai-agent-builder', label: 'AI Agents', Icon: Bot },
    ],
  },
  {
    id: 'content', label: 'Content', Icon: LayoutTemplate,
    items: [
      { id: 'template-builder', label: 'Template Builder', Icon: LayoutTemplate },
      { id: 'lead-forms', label: 'Forms', Icon: FormInput },
      // Route key stays `wa-links`; only the label changed.
      { id: 'wa-links', label: 'Message Formats', Icon: Link },
      { id: 'media-library', label: 'Media', Icon: ImageIcon },
    ],
  },
  {
    id: 'outreach', label: 'Outreach', Icon: Megaphone,
    items: [
      { id: 'bulk-message', label: 'Bulk Message', Icon: Megaphone },
      // What the messaging above actually costs — a dashboard people read,
      // not a setting they configure, so it sits here and not in Admin.
      { id: 'message-costs', label: 'Message Costs', Icon: IndianRupee },
    ],
  },
  {
    id: 'workspace', label: 'Workspace', Icon: FolderKanban,
    items: [
      // Projects group templates + automations + agents + forms for one
      // campaign.
      { id: 'projects', label: 'Projects', Icon: FolderKanban },
    ],
  },
];

// DERIVED, never maintained alongside the groups. The collapsed rail and the
// permission filter both read this; a hand-kept second copy is exactly the
// drift that makes a nav item render but resolve to nothing.
const NAV_ITEMS = [HOME_ITEM, ...SALES_GROUPS.flatMap(g => g.items)];

const MARKETING_NAV = [
  { id: 'mkt-overview', label: 'Overview', Icon: LayoutDashboard },
  { id: 'campaigns', label: 'Campaigns', Icon: Megaphone },
  { id: 'ctwa-ads', label: 'Click-to-WhatsApp', Icon: MousePointerClick },
  { id: 'conversion-api', label: 'Conversion API', Icon: Radio },
];

// Per-section nav — the header tab (Marketing / Sales) picks which list the
// sidebar shows. Sales is the grouped one; Marketing is short enough to stay flat.
const SECTION_NAV = {
  marketing: MARKETING_NAV,
  sales: NAV_ITEMS,
};

const SECTION_EMPTY_ICON = { marketing: Megaphone, sales: Kanban };

// One group in the 68px rail: an icon that flies its items out to the side.
// The rail therefore stays 6 icons tall whatever the nav contains, which is
// what stops the collapse control being pushed off a short screen.
function RailGroup({ group, activePage, onPageChange }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const closeTimer = useRef(null);
  const holdsActive = group.items.some(i => i.id === activePage);

  const show = () => {
    clearTimeout(closeTimer.current);
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // position:fixed — an absolutely-positioned panel would be clipped by the
    // rail's own overflow, which is the whole reason this bug existed.
    // Clamp upward so a group near the bottom still shows all of its items.
    const height = 12 + group.items.length * 36;
    setPos({ left: r.right + 6, top: Math.max(8, Math.min(r.top, window.innerHeight - height - 8)) });
    setOpen(true);
  };
  const hide = () => { closeTimer.current = setTimeout(() => setOpen(false), 140); };
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  return (
    <>
      <div
        ref={btnRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onClick={() => (open ? setOpen(false) : show())}
        title={group.label}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '11px 0', borderRadius: 10, cursor: 'pointer', marginBottom: 2,
          background: holdsActive ? C.primary : 'transparent',
          color: holdsActive ? '#fff' : C.t2,
          transition: 'all .15s', userSelect: 'none',
        }}
      >
        <group.Icon size={20} strokeWidth={2} />
      </div>
      {open && pos && (
        <div
          onMouseEnter={() => clearTimeout(closeTimer.current)}
          onMouseLeave={hide}
          style={{
            position: 'fixed', left: pos.left, top: pos.top, zIndex: 300,
            minWidth: 186, padding: '6px', borderRadius: 12,
            background: C.cardBg, border: `1px solid ${C.border}`, boxShadow: C.shadowLg,
            fontFamily: FONT,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: C.t6, padding: '6px 10px 4px' }}>
            {group.label}
          </div>
          {group.items.map(item => {
            const active = activePage === item.id;
            return (
              <div
                key={item.id}
                onClick={() => { onPageChange(item.id); setOpen(false); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '11px 12px', borderRadius: 8, cursor: 'pointer',
                  background: active ? C.primary : 'transparent',
                  color: active ? '#fff' : C.t2,
                  fontSize: 15, fontWeight: active ? 700 : 600, whiteSpace: 'nowrap',
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = C.hover; }}
                onMouseLeave={e => { e.currentTarget.style.background = active ? C.primary : 'transparent'; }}
              >
                <item.Icon size={19} strokeWidth={2} style={{ flexShrink: 0 }} />
                {item.label}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ONE row implementation for both the grouped and the flat renderings, so the
// two cannot drift apart. `indented` only shifts it under a group header.
function NavRow({ item, active, collapsed, indented, onClick }) {
  return (
    <div
      onClick={onClick}
      title={collapsed ? item.label : ''}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: collapsed ? 0 : 11,
        padding: collapsed ? '13px 0' : (indented ? '11px 14px 11px 26px' : '12px 14px'),
        borderRadius: 10,
        cursor: 'pointer',
        transition: 'all .15s',
        marginBottom: 2,
        background: active ? C.primary : 'transparent',
        // ⚠ NOT C.t4 (#666). A nav label is a PRIMARY destination, not
        // secondary text, and mid-grey at weight 500 was the single biggest
        // contributor to "everything is too thin and invisible" — it measured
        // 13px/500/#666 against the reference's 15px/600/near-black. C.t2 is
        // #222 in light and a bright #E4E4E4 in dark.
        color: active ? '#fff' : C.t2,
        justifyContent: collapsed ? 'center' : 'flex-start',
        fontFamily: FONT,
        fontSize: 15,
        fontWeight: active ? 700 : 600,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        userSelect: 'none',
      }}
      // ⚠ HOVER CHANGES THE BACKGROUND ONLY — never the text colour.
      // This used to lighten the label on enter and restore C.t4 (#666) on
      // leave, while the resting style said C.t2 (#222). A handler that
      // restores a DIFFERENT token from the resting style leaves the element
      // permanently wrong after the first hover, which is what "it fades to
      // grey and stays there" was. Keeping one colour makes the mismatch
      // unrepresentable rather than merely fixed. (Anti-pattern #47.)
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = C.hover; }}
      onMouseLeave={e => { e.currentTarget.style.background = active ? C.primary : 'transparent'; }}
    >
      <span style={{
        width: 22,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}>
        <item.Icon size={19} strokeWidth={2} />
      </span>
      {!collapsed && <span style={{ letterSpacing: '-.01em' }}>{item.label}</span>}
    </div>
  );
}

export default function Sidebar({ activePage, onPageChange, collapsed, setCollapsed, user, section = 'sales' }) {
  const sectionItems = SECTION_NAV[section] || NAV_ITEMS;
  // Filter nav by user.pages (admin sees everything). Home is always visible.
  const allowed = (user?.role === 'admin' || !user?.pages)
    ? null
    : new Set(user.pages);
  const visibleItems = allowed
    ? sectionItems.filter(item => item.id === 'home' || allowed.has(item.id))
    : sectionItems;
  const EmptyIcon = SECTION_EMPTY_ICON[section] || Megaphone;

  // Groups, permission-filtered. A group whose every item is hidden must not
  // render at all — a heading over nothing reads as a broken menu.
  const groups = useMemo(() => SALES_GROUPS
    .map(g => ({ ...g, items: allowed ? g.items.filter(i => allowed.has(i.id)) : g.items }))
    .filter(g => g.items.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.role, user?.pages && user.pages.join(',')]);

  const isGrouped = section === 'sales' && groups.length > 0;
  const useGroups = isGrouped && !collapsed;
  // The rail groups too. Rendering all 15 destinations flat made the column
  // taller than a short viewport, and the sidebar clips rather than scrolls,
  // so the collapse control ended up off-screen and UNREACHABLE — you could
  // collapse the sidebar and never get it back.
  const useRail = isGrouped && collapsed;
  return (
    <div style={{
      width: collapsed ? 68 : 248,
      height: '100%',
      minHeight: 0,
      background: C.sidebarBg,
      borderRight: `1px solid ${C.sidebarBorder}`,
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      transition: 'width .25s ease',
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* Nav items. This is the ONLY part that may scroll — the collapse
          control below is flexShrink:0, so however many items exist and
          however short the window is, the toggle stays on screen. It used to
          be pushed out and then CLIPPED by the root's overflow:hidden. */}
      <div style={{ padding: collapsed ? '10px 8px' : '14px 10px', flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
        {visibleItems.length === 0 && !collapsed && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 10,
            padding: '48px 12px',
            textAlign: 'center',
          }}>
            <EmptyIcon size={34} strokeWidth={1.5} color={C.textMuted} style={{ opacity: 0.5 }} />
            <span style={{
              fontSize: 14,
              fontWeight: 500,
              color: C.textMuted,
              fontFamily: FONT,
              lineHeight: 1.5,
            }}>
              Nothing here yet
            </span>
          </div>
        )}
        {/* Grouped (Chats, expanded) vs flat (Marketing / Sales, or the rail) */}
        {useGroups ? (
          <>
            <NavRow item={HOME_ITEM} active={activePage === HOME_ITEM.id}
              collapsed={false} onClick={() => onPageChange(HOME_ITEM.id)} />
            <div style={{ height: 8 }} />
            {/* One flat list, every destination visible. Not an accordion:
                with one group open at a time you had to remember which category
                a page lived under before you could reach it, which is the
                opposite of what a sidebar is for — so nothing here is clickable
                except the destinations themselves.

                The nav list is the only scrolling region (see the wrapper
                above), so showing everything cannot push the collapse control
                off-screen the way it once did. */}
            {/* The group HEADINGS were removed 2026-08-12 — every destination is
                already named by its own row, so a second uppercase label above
                each cluster was pure repetition and cost a line of height per
                group. The grouping itself is kept: it still orders the list and
                still drives the collapsed rail's fly-outs. A hairline separates
                one cluster from the next, which is all the structure the
                expanded list needs. */}
            {groups.map((g, gi) => (
              <div key={g.id} style={{
                paddingTop: gi === 0 ? 0 : 8,
                marginTop: gi === 0 ? 0 : 8,
                borderTop: gi === 0 ? 'none' : `1px solid ${C.divider}`,
              }}>
                {g.items.map(item => (
                  <NavRow key={item.id} item={item} active={activePage === item.id}
                    collapsed={false} onClick={() => onPageChange(item.id)} />
                ))}
              </div>
            ))}
          </>
        ) : useRail ? (
          // The rail mirrors the expanded structure: Home + one icon per
          // group, each flying its items out to the side. Six icons instead
          // of fifteen, so it cannot outgrow a short window.
          <>
            <NavRow item={HOME_ITEM} active={activePage === HOME_ITEM.id}
              collapsed onClick={() => onPageChange(HOME_ITEM.id)} />
            <div style={{ height: 6 }} />
            {groups.map(g => (
              <RailGroup key={g.id} group={g} activePage={activePage} onPageChange={onPageChange} />
            ))}
          </>
        ) : (
          visibleItems.map(item => (
            <NavRow key={item.id} item={item} active={activePage === item.id}
              collapsed={collapsed} onClick={() => onPageChange(item.id)} />
          ))
        )}
      </div>

      {/* Collapse button + watermark — flexShrink:0 so it is never the thing
          that gets pushed out when the nav is long or the window is short. */}
      <div style={{ borderTop: `1px solid ${C.divider}`, flexShrink: 0 }}>
        <div
          onClick={() => setCollapsed(p => !p)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: collapsed ? '12px 0' : '11px 14px',
            cursor: 'pointer',
            justifyContent: collapsed ? 'center' : 'flex-start',
            transition: 'background .15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = C.hover}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <span style={{ display: 'flex', alignItems: 'center', color: C.t6, lineHeight: 1 }}>
            {collapsed ? <ChevronRight size={22} strokeWidth={2.5} /> : <ChevronLeft size={22} strokeWidth={2.5} />}
          </span>
          {!collapsed && (
            <span style={{ fontSize: 16, fontWeight: 600, color: C.t6, fontFamily: FONT, lineHeight: 1 }}>
              Collapse
            </span>
          )}
        </div>
        {!collapsed && (
          <div style={{ padding: '0 14px 10px' }}>
            <span style={{
              fontSize: 11,
              fontWeight: 600,
              color: C.t7,
              fontFamily: FONT,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
            }}>
              Powered by FMOS
            </span>
          </div>
        )}
        {collapsed && (
          <div style={{ padding: '0 0 8px', textAlign: 'center' }}>
            <span style={{
              // 7px was below the readable floor even for a watermark.
              fontSize: 12,
              fontWeight: 600,
              color: C.watermark,
              fontFamily: FONT,
              letterSpacing: '.04em',
              textTransform: 'uppercase',
            }}>
              FMOS
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
