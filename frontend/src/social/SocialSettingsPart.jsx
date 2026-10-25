// Social's settings, shown INSIDE ForgeGrowth's one Settings page (2026-10-16).
//
// There used to be a second Settings screen under Social. Its pieces are now
// the Instagram sections of the matching Settings pages (PAGES in
// pages/AdminSettingsPage.jsx): General → Instagram notifications, Tags and
// Fields → the Instagram lists, Instagram → Connection and Privacy policy,
// AI models → OpenRouter, Claude & MCP → Instagram API keys, Activity log.
//
// The data stores stay separate (Social contacts and WhatsApp contacts are
// different tables), so the lists are not merged — only the place you set them.
import Toast from './Toast.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import IntegrationsPage from './pages/IntegrationsPage.jsx';
import PrivacyPolicyPage from './pages/PrivacyPolicyPage.jsx';
import { CategoryTab, TagsTab } from './pages/TagsAndCategoriesPage.jsx';
import { FieldsTab } from './pages/ContactFieldsPage.jsx';
import McpAccessTab from './pages/McpAccessPage.jsx';
import ActivityLogTab from './pages/ActivityLogPage.jsx';
import OpenRouterTab from './pages/OpenRouterPage.jsx';

export default function SocialSettingsPart({ part, platform = null, user }) {
  const socialUser = user ? { ...user, role: user.role === 'admin' ? 'admin' : 'member' } : user;
  const isAdmin = socialUser?.role === 'admin';
  const body =
    part === 'general' ? <SettingsPage user={socialUser} notificationsOnly />
    : part === 'integrations' ? <IntegrationsPage platform={platform} isAdmin={isAdmin} />
    : part === 'ai-models' ? <OpenRouterTab />
    : part === 'tags' ? <TagsTab />
    : part === 'category' ? <CategoryTab />
    : part === 'fields' ? <FieldsTab />
    : part === 'mcp' ? <McpAccessTab />
    : part === 'activity' ? <ActivityLogTab />
    : part === 'privacy' ? <PrivacyPolicyPage />
    : null;
  return (
    <>
      <div className="social-root social-root--settings" style={{ flex: 1, minWidth: 0 }}>{body}</div>
      <Toast />
    </>
  );
}

// Old Social settings URLs → the main Settings tab that now holds them.
export const SOCIAL_TAB_TO_MAIN = {
  general: 'general', integrations: 'integrations', openrouter: 'ai-models',
  category: 'category', tags: 'tags', fields: 'fields', mcp: 'mcp',
  activity: 'activity', privacy: 'privacy',
};
