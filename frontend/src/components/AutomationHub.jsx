// Sales → Automations (and, by the same pattern, Chats): ONE sidebar
// destination for everything that builds or
// sends automated messaging — flows, AI agents, broadcasts, the templates and
// media they send, and what that messaging costs. Modelled on Social's
// Automations page (one nav item, tabs along the top).
//
// Each tab is still its own page with its own route key (chatbot-builder,
// ai-agent-builder, …). Renaming page keys would silently drop stored per-user
// permission grants and break old links, so the hub is a tab strip drawn ABOVE
// whichever of those pages is open — not a new page.
//
// The strip is hidden while a page is in its full-screen editor (the flow
// canvas, the agent editor, the template builder, a broadcast's detail): those
// own the whole pane, exactly as Social hides its tabs inside an automation.
import { useEffect, useState } from 'react';
import {
  Zap, Bot, Megaphone, LayoutTemplate, Image as ImageIcon, IndianRupee, MessageCircle, Users2,
} from 'lucide-react';
import { C, FONT } from '../constants.js';

export const HUB_TABS = [
  { key: 'chatbot-builder', label: 'Flows', Icon: Zap },
  { key: 'ai-agent-builder', label: 'AI Agents', Icon: Bot },
  { key: 'bulk-message', label: 'Broadcasts', Icon: Megaphone },
  { key: 'template-builder', label: 'Templates', Icon: LayoutTemplate },
  { key: 'media-library', label: 'Media', Icon: ImageIcon },
  { key: 'message-costs', label: 'Message Costs', Icon: IndianRupee },
];
export const HUB_PAGES = new Set(HUB_TABS.map(t => t.key));

// The same tabs-above-the-page shape, used for Chats. Its second tab, the Chat
// Analyzer, was removed on 2026-10-21; with one tab the strip is not drawn,
// but Chats keeps rendering inside the hub's flex frame, which its scrolling
// panes are laid out against.
export const CHAT_TABS = [
  { key: 'chats', label: 'Chats', Icon: MessageCircle },
];

// Every hub, keyed by the sidebar item that opens it (= its first tab).
export const HUBS = [
  { id: 'chatbot-builder', label: 'Automations', tabs: HUB_TABS },
  { id: 'chats', label: 'Chats', tabs: CHAT_TABS },
];
export const hubOf = (page) => HUBS.find(h => h.tabs.some(t => t.key === page)) || null;

// Which tabs this user may open (admin, or a session without a page list, sees all).
export function allowedTabs(user, tabs) {
  if (!user || user.role === 'admin' || !Array.isArray(user.pages)) return tabs;
  const pages = new Set(user.pages);
  return tabs.filter(t => pages.has(t.perm || t.key));
}
export const allowedHubTabs = (user) => allowedTabs(user, HUB_TABS);

// ── "a page is in its editor" — module state, so a page can say so in one line ──
let editing = false;
const listeners = new Set();
function setEditing(v) {
  if (editing === v) return;
  editing = v;
  listeners.forEach(fn => fn(v));
}
// Called by a hub page with "am I showing a full-screen editor right now?".
export function useHubEditing(flag) {
  useEffect(() => { setEditing(!!flag); }, [flag]);
  useEffect(() => () => setEditing(false), []);
}
function useEditingState() {
  const [v, setV] = useState(editing);
  useEffect(() => { listeners.add(setV); setV(editing); return () => listeners.delete(setV); }, []);
  return v;
}

export default function AutomationHub({ page, user, navigate, hidden = false, children }) {
  const hub = hubOf(page) || HUBS[0];
  const inEditor = useEditingState();
  const tabs = allowedTabs(user, hub.tabs);
  const showStrip = !hidden && !inEditor && tabs.length > 1;
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {showStrip && (
        <div role="tablist" aria-label={hub.label} data-testid={hub.id === 'chatbot-builder' ? 'automation-hub-tabs' : `hub-tabs-${hub.id}`}
          style={{ flexShrink: 0, display: 'flex', gap: 4, padding: '14px 24px 0', borderBottom: `1px solid ${C.border}`, overflowX: 'auto' }}>
          {tabs.map(({ key, label, Icon }) => {
            const on = key === page;
            return (
              <button key={key} role="tab" aria-selected={on} onClick={() => { if (!on) navigate(...key.split('/')); }}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap',
                  background: 'none', border: 'none', cursor: 'pointer', padding: '9px 14px', marginBottom: -1,
                  borderBottom: `2px solid ${on ? C.primary : 'transparent'}`, fontFamily: FONT,
                  fontSize: 15, fontWeight: on ? 700 : 550, color: on ? C.text : C.textSecondary,
                }}>
                <Icon size={16} strokeWidth={on ? 2.4 : 2} />
                {label}
              </button>
            );
          })}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
        {children}
      </div>
    </div>
  );
}
