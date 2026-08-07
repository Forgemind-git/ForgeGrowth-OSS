import {
  Home, Zap, LayoutTemplate, MessageCircle, Users,
  Megaphone, Image as ImageIcon, Link, Kanban, Bot, ListChecks,
  ChevronLeft, ChevronRight, UserCog,
  LayoutDashboard,
  KanbanSquare, Trophy, ClipboardCheck, Package,
  Receipt, FormInput, MousePointerClick, Radio, CreditCard,
  FolderKanban, IndianRupee,
} from 'lucide-react';
import { C, FONT } from '../constants.js';

const NAV_ITEMS = [
  { id: 'home', label: 'Home', Icon: Home },
  // Projects group templates + automations + agents for one campaign, so it
  // sits above the three lists it organises.
  { id: 'projects', label: 'Projects', Icon: FolderKanban },
  { id: 'chatbot-builder', label: 'Automations', Icon: Zap },
  { id: 'ai-agent-builder', label: 'AI Agents', Icon: Bot },
  // Route key stays `follow-up-sequence` — the permission key has existed
  // since migration 031 and renaming a page key silently drops stored
  // per-user permission overrides.
  { id: 'follow-up-sequence', label: 'Follow-ups', Icon: ListChecks },
  { id: 'template-builder', label: 'Template Builder', Icon: LayoutTemplate },
  { id: 'media-library', label: 'Media', Icon: ImageIcon },
  // Route key stays `wa-links` — renaming a page key would drop stored
  // per-user permission overrides. Only the label changed.
  { id: 'wa-links', label: 'Message Formats', Icon: Link },
  { id: 'lead-forms', label: 'Forms', Icon: FormInput },
  { id: 'chats', label: 'Chats', Icon: MessageCircle },
  { id: 'contacts', label: 'Contacts', Icon: Users },
  { id: 'bulk-message', label: 'Bulk Message', Icon: Megaphone },
  // What the messaging above actually costs. Sits with Chats rather than in
  // Admin Settings: it is a dashboard people read, not a setting they configure.
  { id: 'message-costs', label: 'Message Costs', Icon: IndianRupee },
  { id: 'team-members', label: 'Team Members', Icon: UserCog },
];

const MARKETING_NAV = [
  { id: 'mkt-overview', label: 'Overview', Icon: LayoutDashboard },
  { id: 'campaigns', label: 'Campaigns', Icon: Megaphone },
  { id: 'ctwa-ads', label: 'Click-to-WhatsApp', Icon: MousePointerClick },
  { id: 'conversion-api', label: 'Conversion API', Icon: Radio },
];

const SALES_NAV = [
  // One tab for the whole leads model — Pipeline / Funnel / All Leads are
  // internal views of LeadsHubPage.
  { id: 'leads', label: 'Leads', Icon: KanbanSquare },
  { id: 'bda-performance', label: 'BDA Performance', Icon: Trophy },
  { id: 'products', label: 'Products', Icon: Package },
  { id: 'payments', label: 'Payments', Icon: CreditCard },
  { id: 'onboarding', label: 'Sales Log', Icon: Receipt },
];

// Per-section nav — the header tab (Marketing / Sales / Chats) picks which
// list the sidebar shows.
const SECTION_NAV = {
  chats: NAV_ITEMS,
  marketing: MARKETING_NAV,
  sales: SALES_NAV,
};

const SECTION_EMPTY_ICON = { marketing: Megaphone, sales: Kanban };

export default function Sidebar({ activePage, onPageChange, collapsed, setCollapsed, user, section = 'chats' }) {
  const sectionItems = SECTION_NAV[section] || NAV_ITEMS;
  // Filter nav by user.pages (admin sees everything). Home is always visible.
  const allowed = (user?.role === 'admin' || !user?.pages)
    ? null
    : new Set(user.pages);
  const visibleItems = allowed
    ? sectionItems.filter(item => item.id === 'home' || allowed.has(item.id))
    : sectionItems;
  const EmptyIcon = SECTION_EMPTY_ICON[section] || Megaphone;
  return (
    <div style={{
      width: collapsed ? 68 : 224,
      minHeight: '100%',
      background: C.sidebarBg,
      borderRight: `1px solid ${C.sidebarBorder}`,
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      transition: 'width .25s ease',
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* Nav items */}
      <div style={{ padding: collapsed ? '10px 8px' : '14px 10px', flex: 1 }}>
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
              fontSize: 12,
              fontWeight: 500,
              color: C.textMuted,
              fontFamily: FONT,
              lineHeight: 1.5,
            }}>
              Nothing here yet
            </span>
          </div>
        )}
        {visibleItems.map(item => {
          const active = activePage === item.id;
          return (
            <div
              key={item.id}
              onClick={() => onPageChange(item.id)}
              title={collapsed ? item.label : ''}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: collapsed ? 0 : 11,
                padding: collapsed ? '11px 0' : '10px 12px',
                borderRadius: 10,
                cursor: 'pointer',
                transition: 'all .15s',
                marginBottom: 2,
                background: active ? C.primary : 'transparent',
                color: active ? '#fff' : '#666',
                justifyContent: collapsed ? 'center' : 'flex-start',
                fontFamily: FONT,
                fontSize: 13,
                fontWeight: active ? 700 : 500,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                userSelect: 'none',
              }}
              onMouseEnter={e => {
                if (!active) {
                  e.currentTarget.style.background = '#EFEEE6';
                  e.currentTarget.style.color = '#111';
                }
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = active ? C.primary : 'transparent';
                e.currentTarget.style.color = active ? '#fff' : '#666';
              }}
            >
              <span style={{
                width: 20,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                opacity: active ? 1 : 0.75,
              }}>
                <item.Icon size={16} />
              </span>
              {!collapsed && <span style={{ letterSpacing: '-.01em' }}>{item.label}</span>}
            </div>
          );
        })}
      </div>

      {/* Collapse button + watermark */}
      <div style={{ borderTop: `1px solid #F0F0EA` }}>
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
          onMouseEnter={e => e.currentTarget.style.background = '#EFEEE6'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <span style={{ display: 'flex', alignItems: 'center', color: '#888', lineHeight: 1 }}>
            {collapsed ? <ChevronRight size={22} strokeWidth={2.5} /> : <ChevronLeft size={22} strokeWidth={2.5} />}
          </span>
          {!collapsed && (
            <span style={{ fontSize: 15, fontWeight: 600, color: '#888', fontFamily: FONT, lineHeight: 1 }}>
              Collapse
            </span>
          )}
        </div>
        {!collapsed && (
          <div style={{ padding: '0 14px 10px' }}>
            <span style={{
              fontSize: 9,
              fontWeight: 600,
              color: '#ccc',
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
              fontSize: 7,
              fontWeight: 600,
              color: '#ddd',
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
