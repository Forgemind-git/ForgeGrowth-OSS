// Centralised role → page-access map. Extend by adding new roles here
// (and updating the CHECK constraint on forgecrm_users.role).
//
// Page keys are stable strings used in three places:
//   - this map
//   - the frontend Sidebar conditional render
//   - server-side requirePermission(page) middleware
//
// "admin-settings:<tab>" entries gate individual tabs within Admin Settings.
// Use 'admin-settings:*' to grant access to the whole settings page.

const PAGES = [
  'home', 'chats', 'contacts', 'bulk-message', 'template-builder',
  'chatbot-builder', 'media-library', 'wa-links', 'pipelines', 'ai-agent-builder',
  'follow-up-sequence',
  // Chats — additive AI Academy surfaces
  'team-members', 'lead-forms',
  // Marketing section — Lead Sources folded into mkt-overview; Content Library,
  // Webinars and Organic/Social removed along with the ForgeSocial integration.
  'mkt-overview', 'campaigns', 'ctwa-ads', 'conversion-api', 'clo',
  // Sales section
  // 'products' was 'courses' until the rename — no user had a stored override
  // for the old key, so nothing needed migrating.
  'sales-pipeline', 'leads', 'bda-performance', 'onboarding', 'products',
  'sales-funnel', 'sales-log',
  // Payments — create + track Razorpay links raised from ForgeGrowth.
  'payments',
  'admin-settings:general', 'admin-settings:team', 'admin-settings:tags',
  'admin-settings:category', 'admin-settings:fields',
  'admin-settings:whatsapp-accounts', 'admin-settings:ai-models',
  'admin-settings:users', 'admin-settings:webhooks',
  'admin-settings:integrations', 'admin-settings:mcp',
  'admin-settings:funnel',
];

const ROLE_PAGE_DEFAULTS = {
  admin: PAGES.slice(),           // everything
  bda_sales: [
    'home', 'chats', 'contacts', 'pipelines',
    // Sales working surfaces (scoped to their own leads server-side)
    'sales-pipeline', 'leads', 'onboarding', 'products',
    'sales-funnel', 'sales-log',  // BDAs view the funnel + log their own sales; funnel config lives in Admin Settings → Funnel (admin-only)
    'payments',                   // raise a link for their own lead; the list is scoped server-side
    'admin-settings:general',     // only the General tab in user settings
  ],
  viewer: ['home', 'pipelines', 'mkt-overview', 'ctwa-ads', 'sales-pipeline', 'leads', 'sales-funnel'],  // read-only dashboards
};

// Returns the set of pages a user can access given their role plus any
// per-user grant/revoke overrides stored in users.permissions JSONB.
//   permissions = { grant: ["templates","media-library"], revoke: ["admin-settings:general"] }
function effectivePages(user) {
  const base = ROLE_PAGE_DEFAULTS[user.role] || [];
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
  ROLE_PAGE_DEFAULTS,
  effectivePages,
  hasPermission,
  isAdmin,
};
