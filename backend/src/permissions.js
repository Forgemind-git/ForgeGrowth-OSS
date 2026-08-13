// The page catalog, and the role → page resolution built on it.
//
// ⚠ ROLES ARE ROWS, NOT CODE (2026-08-12). They live in coexistence.user_roles
// and are edited in Admin Settings → Users; services/roleConfig.js owns the
// cache. Adding a role is an insert, not an edit here plus a migration.
// `admin` remains the one hardcoded role — isAdmin() short-circuits every
// check — so it can be relabelled but never deleted or narrowed.
//
// Page keys are stable strings used in three places:
//   - this map
//   - the frontend Sidebar conditional render
//   - server-side requirePermission(page) middleware
//
// "admin-settings:<tab>" entries gate individual tabs within Admin Settings.
// Use 'admin-settings:*' to grant access to the whole settings page.

const PAGES = [
  'home', 'chats', 'bulk-message', 'template-builder',
  'chatbot-builder', 'media-library', 'wa-links', 'pipelines', 'ai-agent-builder',
  // Chats — additive AI Academy surfaces.
  // 'wa-links' is the route key for what the UI now calls Message Formats. The
  // key is deliberately unchanged: renaming a page key silently drops any
  // stored per-user override that granted it.
  // 'follow-up-sequence' and 'team-members' removed 2026-08-12 with their pages.
  // Both were safe to drop: 0 users had a stored override.
  'lead-forms', 'projects',
  // Marketing section — Lead Sources folded into mkt-overview; Content Library,
  // Webinars and Organic/Social removed along with the ForgeSocial integration.
  'mkt-overview', 'campaigns', 'ctwa-ads', 'conversion-api',
  // Sales section
  // 'products' was removed 2026-08-12 — the editor moved into Admin Settings →
  // Funnel → Products. Safe to drop: 0 users had a stored override.
  // 'bda-performance' removed 2026-08-11 with its page. 'contacts' removed the
  // same day: the Contacts PAGE is gone (Leads is the one people-table) while the
  // contacts TABLE stays — it is the chat thread, the RBAC scope and the funnel
  // tag mirror. Both keys were safe to drop: 0 users had a stored override.
  'sales-pipeline', 'leads', 'onboarding',
  'sales-funnel', 'sales-log',
  // Payments — create + track Razorpay links raised from ForgeGrowth.
  'payments',
  // Message costs — billing data. Lives in the Chats section; admin-only by
  // default (deliberately absent from every other role's defaults below).
  'message-costs',
  // 'admin-settings:team' removed 2026-08-12 with the Team members tab: a
  // WhatsApp account is named in its own tab, and the only people in the system
  // are users.
  'admin-settings:general', 'admin-settings:tags',
  'admin-settings:category', 'admin-settings:fields',
  'admin-settings:whatsapp-accounts', 'admin-settings:ai-models',
  'admin-settings:users', 'admin-settings:webhooks',
  'admin-settings:integrations', 'admin-settings:mcp',
  'admin-settings:funnel',
];

// The role's page list now comes from the user_roles table via roleConfig.
// Required lazily: roleConfig requires this module back for PAGES, and a
// top-level require either direction is a cycle.
function rolePages(roleKey) {
  if (roleKey === 'admin') return PAGES;
  try { return require('./services/roleConfig').pagesForRole(roleKey); }
  catch { return []; }
}

// Returns the set of pages a user can access given their role plus any
// per-user grant/revoke overrides stored in users.permissions JSONB.
//   permissions = { grant: ["templates","media-library"], revoke: ["admin-settings:general"] }
function effectivePages(user) {
  const base = rolePages(user.role) || [];
  const overrides = user.permissions || {};
  const grant = Array.isArray(overrides.grant) ? overrides.grant : [];
  const revoke = new Set(Array.isArray(overrides.revoke) ? overrides.revoke : []);
  const out = new Set(base);
  grant.forEach(p => out.add(p));
  revoke.forEach(p => out.delete(p));
  return out;
}

function hasPermission(user, page) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return effectivePages(user).has(page);
}

function isAdmin(user) {
  return user?.role === 'admin';
}

module.exports = {
  PAGES,
  rolePages,
  effectivePages,
  hasPermission,
  isAdmin,
};
