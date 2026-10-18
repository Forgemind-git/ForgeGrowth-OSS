// Social section navigation — kept apart from SocialSection.jsx so the sidebar
// can read the nav list without importing every Social page.
import {
  LayoutDashboard, MessageCircle, Users, BookOpen, Zap,
} from 'lucide-react';

// Sidebar items for the Social header tab. Every id is a full route
// ('social/<view>'), so the sidebar's active highlight and App's navigate()
// both work on it unchanged. One permission key — 'social' — covers them all.
export const SOCIAL_NAV = [
  // In the order the work happens (2026-10-16): see how it is going, make and
  // publish content, answer people, know who they are, automate the repeats.
  // Inbox opens a tabbed hub (components/AutomationHub.jsx HUBS);
  // Settings lives in the one app Settings (gear beside the bell).
  { id: 'social', label: 'Overview', Icon: LayoutDashboard },
  { id: 'social/library', label: 'Content Library', Icon: BookOpen },
  { id: 'social/inbox', label: 'Inbox', Icon: MessageCircle },          // + Messenger, Comment Analyzer
  { id: 'social/contacts', label: 'Contacts', Icon: Users },
  { id: 'social/automations', label: 'Automations', Icon: Zap },
];
export const SOCIAL_PAGE_ALIASES = Object.fromEntries(SOCIAL_NAV.map(i => [i.id, ['social']]));

const VIEWS = new Set(['inbox', 'messenger', 'contacts', 'automations', 'comment-analyzer']);
const LIBRARY_TABS = new Set(['library', 'publish', 'media']);
const SETTINGS_TABS = new Set(['general', 'privacy', 'tags', 'fields', 'category', 'openrouter', 'mcp', 'activity']);

// subParts (everything after 'social') → which Social view is open.
export function socialRoute(subParts = []) {
  const [a, b] = subParts.map(s => String(s || '').toLowerCase());
  if (a === 'integrations') return { view: 'settings', settingsTab: 'integrations', platform: b || null };
  if (a === 'settings') {
    // AI Models / AI Usage were folded into OpenRouter in ForgeGrowth; old links land there.
    const tab = b === 'ai-models' || b === 'ai-usage' ? 'openrouter' : (SETTINGS_TABS.has(b) ? b : 'general');
    return { view: 'settings', settingsTab: tab, platform: null };
  }
  if (LIBRARY_TABS.has(a)) return { view: 'library', libraryTab: a };
  if (VIEWS.has(a)) return { view: a };
  return { view: 'overview' };
}

// Which sidebar item to highlight for the current Social route.
export function socialNavId(subParts = []) {
  const r = socialRoute(subParts);
  if (r.view === 'overview') return 'social';
  return 'social/' + r.view;
}

