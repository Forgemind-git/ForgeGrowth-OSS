// ============================================================
// api.js — ForgeGrowth API Wrapper
// ============================================================

const base = '/api/social';

async function req(path, opts = {}) {
  const res = await fetch(base + path, {
    credentials: 'include',
    headers: opts.body instanceof FormData
      ? undefined
      : { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let msg = res.statusText || `Request failed (${res.status})`;
    try {
      const text = await res.text();
      if (text) {
        try { const j = JSON.parse(text); msg = j.error || j.message || text; }
        catch { msg = text; }
      }
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function qs(params = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '' && v !== 'All') p.set(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const api = {
  me:     () => req('/auth/me'),
  login:  (username, password) =>
            req('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => req('/auth/logout', { method: 'POST' }),

  getSettings: () => req('/settings'),

  // App credentials (admin) — Settings → Integrations → App credentials
  getCredentials:  () => req('/credentials'),
  saveCredentials: (values) => req('/credentials', { method: 'PUT', body: JSON.stringify({ values }) }),

  // ForgeGrowth specific
  getPlatforms:    () => req('/platforms'),
  getIntegrations: () => req('/integrations'),
  getTokenHealth:  () => req('/token-health'),
  runTokenRefresh: () => req('/token-health/refresh', { method: 'POST' }),
  getIntegrationAccounts: (platform) => req('/integrations/' + platform + '/accounts'),
  syncPlatformAll:        (platform) => req('/integrations/' + platform + '/sync', { method: 'POST' }),
  removeIntegrationAccount: (platform, id) => req('/integrations/' + platform + '/accounts/' + encodeURIComponent(id), { method: 'DELETE' }),
  setPrimaryAccount:        (platform, id) => req('/integrations/' + platform + '/accounts/' + encodeURIComponent(id) + '/primary', { method: 'POST' }),
  getPosts:        () => req('/posts'),

  getOverview:        (period) => req('/overview' + qs({ period })),
  getPlatformStats:   (key, period, account) => req(`/platforms/${key}/stats` + qs({ period, account })),
  getPlatformAudience:(key, account) => req(`/platforms/${key}/audience` + qs({ account })),
  getFollowersTrend:  (key, account, unit, range) => req(`/platforms/${key}/followers-trend` + qs({ account, unit, range })),
  getPostMetricsTrend: (id, platform, days) => req(`/posts/${id}/metrics-trend` + qs({ platform, days })),
  getDailyMetrics:    (key, account, days) => req(`/platforms/${key}/daily-metrics` + qs({ account, days })),
  getContentLibrary:  (filters = {}) => req('/content-library' + qs(filters)),
  getInsights:        (period) => req('/insights' + qs({ period })),
  getInsightThemes:   (period, platform) => req('/insights/themes' + qs({ period, platform })),
  getInsightAnomalies:(period) => req('/insights/anomalies' + qs({ period })),
  getInsightTrajectory:(platform, days) => req('/insights/trajectory' + qs({ platform, days })),
  recategorize:       (force) => req('/insights/recategorize', { method: 'POST', body: JSON.stringify({ force: !!force }) }),

  // Notifications
  getNotifications:     (limit) => req('/notifications' + qs({ limit })),
  markNotificationsRead:(payload) => req('/notifications/read', { method: 'POST', body: JSON.stringify(payload || {}) }),
  getNotificationPrefs: () => req('/notification-prefs'),
  updateNotificationPrefs:(patch) => req('/notification-prefs', { method: 'PUT', body: JSON.stringify(patch || {}) }),

  // Team / users
  getUsers:    () => req('/users'),
  createUser:  (body) => req('/users', { method: 'POST', body: JSON.stringify(body) }),
  updateUser:  (id, patch) => req('/users/' + id, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteUser:  (id) => req('/users/' + id, { method: 'DELETE' }),

  // Saved replies + inbox item meta (assignment / status / note)
  getCannedReplies:    () => req('/canned-replies'),
  createCannedReply:   (body) => req('/canned-replies', { method: 'POST', body: JSON.stringify(body) }),
  deleteCannedReply:   (id) => req('/canned-replies/' + id, { method: 'DELETE' }),
  getInboxMeta:        () => req('/inbox/meta'),
  setInboxMeta:        (body) => req('/inbox/meta', { method: 'POST', body: JSON.stringify(body) }),


  // Instagram
  getInstagramStatus:      () => req('/instagram/status'),
  getInstagramOAuthUrl:    (mode) => req('/instagram/oauth/init' + (mode === 'add' ? '?mode=add' : '')),
  disconnectInstagram:     (accountId) => req('/instagram/disconnect', { method: 'POST', body: JSON.stringify({ accountId }) }),
  getInstagramInbox:       (limit, account) => req('/instagram/inbox' + qs({ limit, account })),
  replyInstagram:          (body) => req('/instagram/reply', { method: 'POST', body: JSON.stringify(body) }),
  replyInstagramComment:   (id, body) => req('/instagram/comments/' + id + '/reply', { method: 'POST', body: JSON.stringify(body) }),
  deleteInstagramComment:  (id) => req('/instagram/comments/' + id, { method: 'DELETE' }),
  markInstagramRead:       (body) => req('/instagram/conversations/read', { method: 'POST', body: JSON.stringify(body) }),
  renameInstagramAccount:  (id, name) => req('/instagram/accounts/' + id, { method: 'POST', body: JSON.stringify({ name }) }),
  saveInstagramCredentials: (body) => req('/instagram/credentials', { method: 'POST', body: JSON.stringify(body) }),
  refreshInstagramToken:    () => req('/instagram/refresh-token', { method: 'POST' }),

  // Contacts (CRM-style list auto-built from IG DMs)
  getContacts:    (filters = {}) => req('/contacts' + qs(filters)),
  getContact:     (id) => req('/contacts/' + id),
  updateContact:  (id, body) => req('/contacts/' + id, { method: 'POST', body: JSON.stringify(body) }),
  deleteContact:  (id) => req('/contacts/' + id, { method: 'DELETE' }),
  setContactTags: (id, tags) => req('/contacts/' + id + '/tags', { method: 'POST', body: JSON.stringify({ tags }) }),

  // Categories + Tags (admin-managed; reads are user-allowed for the picker)
  getCategories:   () => req('/categories'),
  createCategory:  (body) => req('/categories', { method: 'POST', body: JSON.stringify(body) }),
  updateCategory:  (id, body) => req('/categories/' + id, { method: 'PUT', body: JSON.stringify(body) }),
  deleteCategory:  (id) => req('/categories/' + id, { method: 'DELETE' }),
  getTags:    () => req('/tags'),
  createTag:  (body) => req('/tags', { method: 'POST', body: JSON.stringify(body) }),
  updateTag:  (id, body) => req('/tags/' + id, { method: 'PUT', body: JSON.stringify(body) }),
  deleteTag:  (id) => req('/tags/' + id, { method: 'DELETE' }),

  // Media library
  getMedia:    () => req('/media'),
  uploadMedia: (formData) => req('/media', { method: 'POST', body: formData }),
  deleteMedia: (id) => req('/media/' + id, { method: 'DELETE' }),
  setMediaAccounts: (id, accounts) => req('/media/' + id + '/accounts', { method: 'PUT', body: JSON.stringify({ accounts }) }),

  // Sync
  syncAll:      () => req('/sync', { method: 'POST' }),
  syncPlatform: (key, opts = {}) => req(`/sync/${key}`, { method: 'POST', body: JSON.stringify({ fullSync: opts.fullSync }) }),
  getSyncStatus: () => req('/sync/status'),

  // Connected accounts (also feeds the "My accounts" scope picker)
  getPublishAccounts: () => req('/publish/accounts'),
  // "My accounts" preset (per user) — backend userScope.js
  getScope:  () => req('/me/scope'),
  saveScope: (tokens) => req('/me/scope', { method: 'PUT', body: JSON.stringify({ tokens }) }),
  getActivity:        (limit) => req('/activity' + qs({ limit })),

  // Goals / KPI targets + shareable reports (P5)
  getGoals:    () => req('/goals'),
  createGoal:  (body) => req('/goals', { method: 'POST', body: JSON.stringify(body) }),
  deleteGoal:  (id) => req('/goals/' + id, { method: 'DELETE' }),
  createReportShare: (body) => req('/reports/share', { method: 'POST', body: JSON.stringify(body) }),
  getPublicReport:   (token) => req('/public/report/' + token),
  // Composer helpers — caption templates + hashtag groups
  getContentTemplates:  () => req('/content-templates'),
  createContentTemplate:(body) => req('/content-templates', { method: 'POST', body: JSON.stringify(body) }),
  deleteContentTemplate:(id) => req('/content-templates/' + id, { method: 'DELETE' }),
  getHashtagGroups:     () => req('/hashtag-groups'),
  createHashtagGroup:   (body) => req('/hashtag-groups', { method: 'POST', body: JSON.stringify(body) }),
  deleteHashtagGroup:   (id) => req('/hashtag-groups/' + id, { method: 'DELETE' }),

  // ManyChat-style contacts (backend contactsCrm.js)
  crm: {
    contacts:     (account) => req('/crm/contacts' + qs({ account })),
    profile:      (id) => req('/crm/contacts/' + id + '/profile'),
    messages:     (id) => req('/crm/contacts/' + id + '/messages'),
    refresh:      (id) => req('/crm/contacts/' + id + '/refresh', { method: 'POST' }),
    setField:     (id, key, value) => req('/crm/contacts/' + id + '/fields', { method: 'PUT', body: JSON.stringify({ key, value }) }),
    bulk:         (body) => req('/crm/contacts/bulk', { method: 'POST', body: JSON.stringify(body) }),
    fields:       () => req('/crm/fields'),
    createField:  (body) => req('/crm/fields', { method: 'POST', body: JSON.stringify(body) }),
    updateField:  (key, body) => req('/crm/fields/' + key, { method: 'PUT', body: JSON.stringify(body) }),
    deleteField:  (key) => req('/crm/fields/' + key, { method: 'DELETE' }),
    segments:     () => req('/crm/segments'),
    saveSegment:  (body) => req('/crm/segments', { method: 'POST', body: JSON.stringify(body) }),
    deleteSegment:(id) => req('/crm/segments/' + id, { method: 'DELETE' }),
    createTag:    (name, color) => req('/crm/tags', { method: 'POST', body: JSON.stringify({ name, color }) }),
    updateTag:    (id, body) => req('/crm/tags/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(body) }),
    deleteTag:    (id) => req('/crm/tags/' + encodeURIComponent(id), { method: 'DELETE' }),
  },
  // OpenRouter key + spend (admin) — Settings → OpenRouter
  openRouter: {
    status:    () => req('/openrouter'),
    spend:     () => req('/openrouter/spend'),
    saveKey:   (key) => req('/openrouter/key', { method: 'POST', body: JSON.stringify({ key }) }),
    removeKey: () => req('/openrouter/key', { method: 'DELETE' }),
    setRate:   (rate) => req('/openrouter/rate', { method: 'PUT', body: JSON.stringify({ rate }) }),
  },
  // Automations tab (ManyChat-style IG rules) — backend commentAutomationRoutes.js
  // Instagram AI agents (backend services/agentService.js). Quick agents run on
  // the Settings → OpenRouter key, so they carry an OpenRouter model id in llmModel.
  agents: {
    list:   () => req('/agents'),
    get:    (id) => req('/agents/' + id),
    create: (body) => req('/agents', { method: 'POST', body: JSON.stringify(body) }),
    update: (id, body) => req('/agents/' + id, { method: 'PUT', body: JSON.stringify(body) }),
    remove: (id) => req('/agents/' + id, { method: 'DELETE' }),
    test:   (id, messages) => req('/agents/' + id + '/test', { method: 'POST', body: JSON.stringify({ messages }) }),
    runs:   (id, limit = 50) => req('/agents/' + id + '/runs' + qs({ limit })),
  },
  automations: {
    list:     (accountId) => req('/ig-automations' + qs({ account_id: accountId })),
    create:   (body) => req('/ig-automations', { method: 'POST', body: JSON.stringify(body) }),
    update:   (id, body) => req('/ig-automations/' + id, { method: 'PUT', body: JSON.stringify(body) }),
    remove:   (id) => req('/ig-automations/' + id, { method: 'DELETE' }),
    log:      (params = {}) => req('/ig-automations/log' + qs(params)),
    leads:    (params = {}) => req('/ig-automations/leads' + qs(params)),
    accounts: () => req('/ig-automations/accounts'),
    posts:    (accountId) => req('/ig-automations/posts' + qs({ account_id: accountId })),
    meta:     () => req('/ig-automations/meta'),
    insights: (id, days) => req('/ig-automations/' + id + '/insights' + qs({ days })),
    // Flow Builder
    flows:        (accountId) => req('/ig-automations/flows' + qs({ account_id: accountId })),
    flow:         (id) => req('/ig-automations/flows/' + id),
    createFlow:   (body) => req('/ig-automations/flows', { method: 'POST', body: JSON.stringify(body) }),
    updateFlow:   (id, body) => req('/ig-automations/flows/' + id, { method: 'PUT', body: JSON.stringify(body) }),
    removeFlow:   (id) => req('/ig-automations/flows/' + id, { method: 'DELETE' }),
    flowInsights: (id) => req('/ig-automations/flows/' + id + '/insights'),
    flowAiModels: () => req('/ig-automations/flows/ai-models'),
    flowAiTest:   (body) => req('/ig-automations/flows/ai-test', { method: 'POST', body: JSON.stringify(body) }),
  },
};
