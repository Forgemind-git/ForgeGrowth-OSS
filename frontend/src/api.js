async function req(path, opts = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      ...opts,
    });
  } catch {
    // Network failure / server unreachable — there's no HTTP status at all.
    const e = new Error("Can't reach the server. Please check your connection and try again.");
    e.network = true;
    throw e;
  }

  if (!res.ok) {
    // Prefer the backend's human-readable { error } message. Never surface the
    // raw HTTP status code to the user — map it to a friendly sentence instead.
    let message = '';
    let body = null;
    try {
      const data = await res.clone().json();
      body = data;
      message = data?.error || data?.message || '';
    } catch {
      try { message = (await res.text()) || ''; } catch { message = ''; }
    }
    if (!message || /^\s*<|^\s*\d{3}\b/.test(message)) {
      // Empty, HTML, or a bare status string → use a status-based fallback.
      if (res.status === 401) message = 'Your session has expired. Please sign in again.';
      else if (res.status === 403) message = "You don't have permission to do that.";
      else if (res.status === 404) message = 'We couldn’t find what you were looking for.';
      else if (res.status === 409) message = 'That conflicts with something that already exists.';
      else if (res.status === 413) message = 'That file is too large to upload.';
      else if (res.status === 429) message = 'You’re doing that a bit too fast — please wait a moment and try again.';
      else if (res.status >= 500) message = 'Something went wrong on our end. Please try again in a moment.';
      else message = 'Something went wrong. Please try again.';
    }
    const e = new Error(message);
    e.status = res.status;
    // Extra machine-readable keys some endpoints return beside `error`
    // (e.g. entity-fields' restorableId on a deleted-key conflict).
    if (body && typeof body === 'object') e.body = body;
    throw e;
  }

  // Tolerate empty success bodies (202/204) without throwing a JSON parse error.
  return res.json().catch(() => ({}));
}

/**
 * Build a query string, dropping empty values.
 *
 * Dropping '' matters: an empty filter must mean "no filter", not
 * `?status=` — which several backend handlers would read as a real value and
 * silently return nothing.
 */
function qs(params = {}) {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') sp.set(k, v);
  });
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const api = {
  auth: {
    me: () => req('/auth/me'),
    login: (email, password) =>
      req('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    logout: () => req('/auth/logout', { method: 'POST' }),
  },
  dashboard: (range = '7d') => req(`/dashboard?range=${encodeURIComponent(range)}`),
  dashboardDetails: (metric, range = '7d') =>
    req(`/dashboard/details?metric=${encodeURIComponent(metric)}&range=${encodeURIComponent(range)}`),
  numbers: () => req('/numbers'),
  // Unread conversations across every number the caller can see — what the
  // header bell shows, and what it navigates to.
  notifications: (limit = 20) => req(`/notifications?limit=${limit}`),
  contacts: (waNumber, timeRange) =>
    req(`/contacts?waNumber=${encodeURIComponent(waNumber)}&timeRange=${timeRange}`),
  messages: (params) => {
    const qs = new URLSearchParams(params);
    return req(`/messages?${qs}`);
  },
  contactNames: (waNumber) =>
    req(`/contact-names?waNumber=${encodeURIComponent(waNumber)}`),
  contact: (waNumber, contactNumber) =>
    req(`/contact?waNumber=${encodeURIComponent(waNumber)}&contactNumber=${encodeURIComponent(contactNumber)}`),
  // Contact custom fields were removed — a person's data lives on their LEAD —
  // so this takes name + tags + assignment only. The backend ignores a
  // customFields key if one is ever sent.
  saveContact: (waNumber, contactNumber, name, tags = [], assignedUserId = undefined) =>
    req('/contacts/save', {
      method: 'POST',
      body: JSON.stringify({
        waNumber, contactNumber, name, tags,
        ...(assignedUserId !== undefined ? { assignedUserId } : {}),
      }),
    }),
  // Change a contact's phone number — migrates the conversation + all history
  // to the new number server-side (transactional). Returns the new number.
  changeContactNumber: (waNumber, oldNumber, newNumber) =>
    req('/contacts/change-number', {
      method: 'POST',
      body: JSON.stringify({ waNumber, oldNumber, newNumber }),
    }),
  savedContacts: (waNumber) =>
    req(`/saved-contacts?waNumber=${encodeURIComponent(waNumber)}`),
  // Every contact across all business numbers (deduped) — for bulk messaging.
  allSavedContacts: () => req('/saved-contacts?all=true'),
  // Bulk contact import. No longer reachable from the UI — the Contacts page was
  // removed and bulk loading people now creates LEADS (api.leads.import). Kept
  // because the backend route is still reachable over MCP (area_contacts) and the
  // contacts table remains the chat's own substrate.
  importContacts: (waNumber, file) => {
    const form = new FormData();
    form.append('waNumber', waNumber);
    form.append('file', file);
    return fetch('/api/contacts/import', {
      method: 'POST',
      credentials: 'include',
      body: form,
    }).then(async res => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let msg = text;
        try { msg = JSON.parse(text).error || text; } catch { /* keep raw */ }
        throw new Error(msg || `${res.status}`);
      }
      return res.json();
    });
  },
  deleteContact: (waNumber, contactNumber) =>
    req(`/contact?waNumber=${encodeURIComponent(waNumber)}&contactNumber=${encodeURIComponent(contactNumber)}`, { method: 'DELETE' }),
  categories: {
    list: () => req('/categories'),
    create: (data) => req('/categories', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/categories/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/categories/${id}`, { method: 'DELETE' }),
  },
  tags: {
    list: () => req('/tags'),
    create: (data) => req('/tags', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/tags/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/tags/${id}`, { method: 'DELETE' }),
  },
  templates: {
    list: ({ accountId, status, q } = {}) => {
      const qs = new URLSearchParams();
      if (accountId) qs.set('accountId', accountId);
      if (status) qs.set('status', status);
      if (q) qs.set('q', q);
      const s = qs.toString();
      return req(`/templates${s ? `?${s}` : ''}`);
    },
    get: (id) => req(`/templates/${id}`),
    create: (data) => req('/templates', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/templates/${id}`, { method: 'DELETE' }),
    submit: (id) => req(`/templates/${id}/submit`, { method: 'POST' }),
    sync: (id) => req(`/templates/${id}/sync`, { method: 'POST' }),
    duplicate: (id) => req(`/templates/${id}/duplicate`, { method: 'POST' }),
    payload: (id) => req(`/templates/${id}/payload`),
    revisions: (id, { limit = 50, offset = 0 } = {}) =>
      req(`/templates/${id}/revisions?limit=${limit}&offset=${offset}`),
    restoreRevision: (id, revId) =>
      req(`/templates/${id}/revisions/${revId}/restore`, { method: 'POST' }),
    analytics: (id, days = 30) => req(`/templates/${id}/analytics?days=${days}`),
    refreshAnalytics: (id, days = 30) =>
      req(`/templates/${id}/analytics/refresh`, { method: 'POST', body: JSON.stringify({ days }) }),
  },
  // Repeating broadcasts. A series never sends directly — each run creates a
  // real broadcast, so its delivery stats live in api.broadcasts like any other.
  broadcastSeries: {
    list: () => req('/broadcast-series'),
    get: (id) => req(`/broadcast-series/${id}`),
    create: (data) => req('/broadcast-series', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/broadcast-series/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    setActive: (id, active) => req(`/broadcast-series/${id}/active`, { method: 'POST', body: JSON.stringify({ active }) }),
    runNow: (id) => req(`/broadcast-series/${id}/run`, { method: 'POST' }),
    preview: (id) => req(`/broadcast-series/${id}/preview`),
    previewRule: (data) => req('/broadcast-series/preview', { method: 'POST', body: JSON.stringify(data) }),
    delete: (id) => req(`/broadcast-series/${id}`, { method: 'DELETE' }),
  },

  broadcasts: {
    list: (status) => req(`/broadcasts${status && status !== 'all' ? `?status=${status}` : ''}`),
    get: (id) => req(`/broadcasts/${id}`),
    create: (data) => req('/broadcasts', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/broadcasts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/broadcasts/${id}`, { method: 'DELETE' }),
    send: (id) => req(`/broadcasts/${id}/send`, { method: 'POST' }),
    test: (id, testNumber) => req(`/broadcasts/${id}/test`, { method: 'POST', body: JSON.stringify({ test_number: testNumber }) }),
  },
  chatbots: {
    list: () => req('/chatbots'),
    get: (id) => req(`/chatbots/${id}`),
    create: (data) => req('/chatbots', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/chatbots/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    validate: (config) => req('/chatbots/validate', { method: 'POST', body: JSON.stringify({ config }) }),
    duplicate: (id) => req(`/chatbots/${id}/duplicate`, { method: 'POST' }),
    delete: (id) => req(`/chatbots/${id}`, { method: 'DELETE' }),
    exportOne: (id) => req(`/chatbots/${id}/export`),
    import: (payload) => req('/chatbots/import', { method: 'POST', body: JSON.stringify(payload) }),
    // Lead fields a "Set Lead Field" action may write. Served by the same
    // function the engine validates against, so the picker cannot offer a
    // target the write would refuse.
    leadFields: () => req('/automation-lead-fields'),
    landingSources: () => req('/automation-landing-sources'),
    // Webhook-trigger URL + signing secret (mints on first read)
    executions: (id, { page = 1, limit = 20, status = 'all', startDate = '', endDate = '', messageStatus = 'all' } = {}) => {
      const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (status && status !== 'all') qs.set('status', status);
      if (startDate) qs.set('startDate', startDate);
      if (endDate) qs.set('endDate', endDate);
      if (messageStatus && messageStatus !== 'all') qs.set('messageStatus', messageStatus);
      return req(`/chatbots/${id}/executions?${qs}`);
    },
  },
  executions: {
    get: (id) => req(`/executions/${id}`),
    cancel: (id) => req(`/executions/${id}/cancel`, { method: 'POST' }),
  },
  whatsappAccounts: {
    list: (activeOnly = false) => req(`/whatsapp-accounts${activeOnly ? '?activeOnly=true' : ''}`),
    get: (id, reveal = false) => req(`/whatsapp-accounts/${id}${reveal ? '?reveal=1' : ''}`),
    create: (data) => req('/whatsapp-accounts', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/whatsapp-accounts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    // Display label only (migration 133); null/'' clears it.
    setLabel: (id, label) => req(`/whatsapp-accounts/${id}/label`, { method: 'PUT', body: JSON.stringify({ label }) }),
    delete: (id) => req(`/whatsapp-accounts/${id}`, { method: 'DELETE' }),
    // Meta send-health (can_send_message + billing/error reason). Optional
    // { accountId } / { phone } narrows to one account, else all active ones.
    health: ({ accountId, phone } = {}) => {
      const qs = new URLSearchParams();
      if (accountId != null) qs.set('accountId', accountId);
      if (phone) qs.set('phone', phone);
      return req(`/whatsapp-accounts/health${qs.toString() ? `?${qs}` : ''}`);
    },
  },
  // Roles are managed alongside the users who hold them — see routes/users.js.
  roles: {
    list: () => req('/roles'),
    create: (data) => req('/roles', { method: 'POST', body: JSON.stringify(data) }),
    update: (key, data) => req(`/roles/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (key) => req(`/roles/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  },
  users: {
    list: () => req('/users'),
    get: (id) => req(`/users/${id}`),
    create: (data) => req('/users', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id) => req(`/users/${id}`, { method: 'DELETE' }),
    resetPassword: (id, password) => req(`/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify(password ? { password } : {}) }),
  },
  auditLog: ({ limit = 50, offset = 0 } = {}) => req(`/audit-log?limit=${limit}&offset=${offset}`),
  aiModels: {
    list: () => req('/ai-models'),
    get: (id, reveal = false) => req(`/ai-models/${id}${reveal ? '?reveal=1' : ''}`),
    create: (data) => req('/ai-models', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/ai-models/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    sync: (id) => req(`/ai-models/${id}/sync`, { method: 'POST' }),
    usage: (id) => req(`/ai-models/${id}/usage`),
    activity: (id, { limit = 20, offset = 0, status, model, from, to } = {}) => {
      const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (status && status !== 'all') qs.set('status', status);
      if (model) qs.set('model', model);
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      return req(`/ai-models/${id}/activity?${qs.toString()}`);
    },
    delete: (id) => req(`/ai-models/${id}`, { method: 'DELETE' }),
  },
  // AI Agents — LLM-driven WhatsApp message handlers. Each agent references
  // an ai_models row by id (so API keys stay in one place) and a single
  // whatsapp_account; tools live in coexistence.agent_tools.
  agents: {
    list: () => req('/agents'),
    get: (id) => req(`/agents/${id}`),
    create: (data) => req('/agents', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/agents/${id}`, { method: 'DELETE' }),
    exportOne: (id) => req(`/agents/${id}/export`),
    import: (payload) => req('/agents/import', { method: 'POST', body: JSON.stringify(payload) }),
    runs: (id, limit = 50) => req(`/agents/${id}/runs?limit=${limit}`),
    // Is a test number's chat paused (and by whom)? A paused chat is why an
    // agent can look configured and still say nothing.
    testNumberStatus: (id) => req(`/agents/${id}/test-numbers/status`),
    run: (id, runId) => req(`/agents/${id}/runs/${runId}`),
    addTool: (id, data) => req(`/agents/${id}/tools`, { method: 'POST', body: JSON.stringify(data) }),
    updateTool: (id, toolId, data) =>
      req(`/agents/${id}/tools/${toolId}`, { method: 'PUT', body: JSON.stringify(data) }),
    removeTool: (id, toolId) => req(`/agents/${id}/tools/${toolId}`, { method: 'DELETE' }),
    test: (id, messages) => req(`/agents/${id}/test`, {
      method: 'POST', body: JSON.stringify({ messages }),
    }),
  },
  // Per-conversation bot control (Chats header 🤖 toggle).
  agentConversation: {
    status: (waNumber, contactNumber) =>
      req(`/agent-conversation?waNumber=${encodeURIComponent(waNumber)}&contactNumber=${encodeURIComponent(contactNumber)}`),
    pause: (waNumber, contactNumber) =>
      req('/agent-conversation/pause', { method: 'POST', body: JSON.stringify({ waNumber, contactNumber }) }),
    resume: (waNumber, contactNumber) =>
      req('/agent-conversation/resume', { method: 'POST', body: JSON.stringify({ waNumber, contactNumber }) }),
  },
  retryMedia: (messageId) => req(`/media/${encodeURIComponent(messageId)}/retry`, { method: 'POST' }),
  mediaUrl: (messageId) => `/api/media/${encodeURIComponent(messageId)}`,
  react: (fromNumber, toNumber, messageId, emoji) =>
    req('/messages/react', { method: 'POST', body: JSON.stringify({ fromNumber, toNumber, messageId, emoji }) }),
  star: (waNumber, contactNumber, messageId, starred) =>
    req('/messages/star', { method: 'POST', body: JSON.stringify({ waNumber, contactNumber, messageId, starred }) }),
  windowStatus: (waNumber, contactNumber) =>
    req(`/messages/window-status?waNumber=${encodeURIComponent(waNumber)}&contactNumber=${encodeURIComponent(contactNumber)}`),
  markRead: (waNumber, contactNumber) =>
    req('/messages/mark-read', { method: 'POST', body: JSON.stringify({ waNumber, contactNumber }) }),
  markAllRead: () => req('/messages/mark-all-read', { method: 'POST', body: '{}' }),
  sendMessage: ({ fromNumber, toNumber, text, contextMessageId }) =>
    req('/messages/send', { method: 'POST', body: JSON.stringify({ fromNumber, toNumber, text, contextMessageId }) }),
  // Forward an existing message (text OR media) to another contact. The backend
  // re-uploads stored media to Meta, so files/audio/video forward for real.
  forwardMessage: ({ fromNumber, toNumber, messageId }) =>
    req('/messages/forward', { method: 'POST', body: JSON.stringify({ fromNumber, toNumber, messageId }) }),
  testTemplate: (id, to, sampleValues = {}) =>
    req(`/templates/${id}/test-send`, { method: 'POST', body: JSON.stringify({ to, sampleValues }) }),
  sendMedia: async ({ fromNumber, toNumber, caption, file, contextMessageId }) => {
    const form = new FormData();
    form.append('fromNumber', fromNumber);
    form.append('toNumber', toNumber);
    if (caption) form.append('caption', caption);
    if (contextMessageId) form.append('contextMessageId', contextMessageId);
    form.append('file', file);
    const res = await fetch('/api/messages/send-media', { method: 'POST', credentials: 'include', body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || `${res.status}`);
    return json;
  },
  sendLibraryMedia: ({ fromNumber, toNumber, mediaLibraryId, caption, contextMessageId }) =>
    req('/messages/send-library-media', {
      method: 'POST',
      body: JSON.stringify({ fromNumber, toNumber, mediaLibraryId, caption, contextMessageId }),
    }),
  resolveAccountByPhone: (phone) =>
    req(`/whatsapp-accounts/by-phone/${encodeURIComponent(phone)}`),
  sendAudio: async ({ fromNumber, toNumber, file, contextMessageId }) => {
    const form = new FormData();
    form.append('fromNumber', fromNumber);
    form.append('toNumber', toNumber);
    if (contextMessageId) form.append('contextMessageId', contextMessageId);
    form.append('file', file);
    const res = await fetch('/api/messages/send-audio', { method: 'POST', credentials: 'include', body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || `${res.status}`);
    return json;
  },
  uploadTemplateMediaHandleFromLibrary: ({ accountId, mediaLibraryId }) =>
    req('/templates/upload-media-handle-from-library', {
      method: 'POST',
      body: JSON.stringify({ accountId, mediaLibraryId }),
    }),
  uploadTemplateMediaHandle: async ({ accountId, file }) => {
    const form = new FormData();
    form.append('accountId', accountId);
    form.append('file', file);
    const res = await fetch('/api/templates/upload-media-handle', { method: 'POST', credentials: 'include', body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || `${res.status}`);
    return json;
  },
  syncTemplate: (id) => req(`/templates/${id}/sync`, { method: 'POST' }),
  syncAllTemplates: () => req('/templates/sync-all', { method: 'POST' }),
  duplicateTemplate: (id) => req(`/templates/${id}/duplicate`, { method: 'POST' }),
  bulkSubmitTemplates: (ids) => req('/templates/bulk-submit', { method: 'POST', body: JSON.stringify({ ids }) }),
  libraryTemplates: (accountId, topic) =>
    req(`/templates/library?accountId=${encodeURIComponent(accountId)}${topic ? `&topic=${encodeURIComponent(topic)}` : ''}`),
  cloneLibraryTemplate: (accountId, libraryTemplate) =>
    req('/templates/library/clone', { method: 'POST', body: JSON.stringify({ accountId, libraryTemplate }) }),
  webhookEvents: {
    list: (filters = {}) => {
      const qs = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') qs.set(k, v);
      });
      const s = qs.toString();
      return req(`/webhook-events${s ? `?${s}` : ''}`);
    },
    get: (id) => req(`/webhook-events/${id}`),
    replay: (id) => req(`/webhook-events/${id}/replay`, { method: 'POST' }),
    delete: (id) => req(`/webhook-events/${id}`, { method: 'DELETE' }),
  },
  razorpay: {
    status: () => req('/razorpay/status'),
    getConfig: () => req('/razorpay/config'),
    saveConfig: (body) => req('/razorpay/config', { method: 'PUT', body: JSON.stringify(body) }),
    events: (filters = {}) => {
      const qs = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
      const s = qs.toString();
      return req(`/razorpay/events${s ? `?${s}` : ''}`);
    },
    event: (id) => req(`/razorpay/events/${id}`),
    // The pulled ledger — what Razorpay actually holds, including everything
    // from before the webhook existed. Distinct from events() above, which is
    // the webhook audit trail.
    payments: (filters = {}) => {
      const qs = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
      const s = qs.toString();
      return req(`/razorpay/payments${s ? `?${s}` : ''}`);
    },
    // KPI summary for the ledger. Accepts the same from/to/method/q slice as
    // payments() so the cards describe the current view (status is table-only —
    // the cards ARE the status breakdown).
    paymentsSummary: (filters = {}) => {
      const qs = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
      const s = qs.toString();
      return req(`/razorpay/payments/summary${s ? `?${s}` : ''}`);
    },
    // Payments dashboard: money per IST day/week/month, split by method /
    // product / status. Same filters as payments().
    paymentsTrend: (filters = {}) => {
      const qs = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
      const s = qs.toString();
      return req(`/razorpay/payments/trend${s ? `?${s}` : ''}`);
    },
    syncPayments: (full = false) =>
      req('/razorpay/payments/sync', { method: 'POST', body: JSON.stringify({ full }) }),
    // Proves the OUTBOUND half works. A connected webhook says nothing about
    // API access — they are separate credentials with separate status.
    testApi: () => req('/razorpay/test-api', { method: 'POST' }),
  },
  // Payments dashboard: the signed-in user's saved filter combinations.
  paymentFilterPresets: {
    list: (scope = 'dashboard') => req(`/payment-filter-presets?scope=${encodeURIComponent(scope)}`),
    create: (body) => req('/payment-filter-presets', { method: 'POST', body: JSON.stringify(body) }),
    update: (id, body) => req(`/payment-filter-presets/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id) => req(`/payment-filter-presets/${id}`, { method: 'DELETE' }),
  },
  // Payment requests — Razorpay links minted by ForgeGrowth, each carrying our
  // lead id so the payment attributes itself instead of being guessed from its
  // amount. Amounts cross this boundary in RUPEES; the backend stores paise.
  paymentRequests: {
    list: (filters = {}) => {
      const qs = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
      const s = qs.toString();
      return req(`/payment-requests${s ? `?${s}` : ''}`);
    },
    summary: (filters = {}) => {
      const qs = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
      const s = qs.toString();
      return req(`/payment-requests/summary${s ? `?${s}` : ''}`);
    },
    get: (id) => req(`/payment-requests/${id}`),
    create: (body) => req('/payment-requests', { method: 'POST', body: JSON.stringify(body) }),
    refresh: (id) => req(`/payment-requests/${id}/refresh`, { method: 'POST' }),
    cancel: (id) => req(`/payment-requests/${id}/cancel`, { method: 'POST' }),
    delete: (id) => req(`/payment-requests/${id}`, { method: 'DELETE' }),
    // Plain <a download> — the auth cookie rides along, same as the contact
    // import template.
    exportUrl: (filters = {}) => {
      const qs = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
      const s = qs.toString();
      return `/api/payment-requests/export${s ? `?${s}` : ''}`;
    },
  },
  // Products — anything you sell (course, consulting, template, webinar).
  // Was `api.courses` hitting /courses; the backend still answers on the old
  // path for external callers, but nothing in the app uses it.
  products: {
    list: () => req('/products'),
    create: (body) => req('/products', { method: 'POST', body: JSON.stringify(body) }),
    update: (id, body) => req(`/products/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id) => req(`/products/${id}`, { method: 'DELETE' }),
    addLink: (productId, body) => req(`/products/${productId}/links`, { method: 'POST', body: JSON.stringify(body) }),
    updateLink: (id, body) => req(`/payment-links/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    deleteLink: (id) => req(`/payment-links/${id}`, { method: 'DELETE' }),
    revenue: () => req('/products/revenue'),
  },
  mediaLibrary: {
    list: () => req('/media-library'),
    upload: (file, name, notes) => {
      const form = new FormData();
      form.append('file', file);
      if (name) form.append('name', name);
      if (notes) form.append('notes', notes);
      return fetch('/api/media-library', {
        method: 'POST',
        credentials: 'include',
        body: form,
      }).then(async res => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`${res.status} ${text}`);
        }
        return res.json();
      });
    },
    update: (id, data) =>
      req(`/media-library/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/media-library/${id}`, { method: 'DELETE' }),
    sync: (id, accountId) =>
      req(`/media-library/${id}/sync/${accountId}`, { method: 'POST' }),
    // Swap the file behind an item, keeping its id so everything using it
    // sends the new file. Returns { media, resync: [{accountId, ok, error?}] }.
    replace: (id, file) => {
      const form = new FormData();
      form.append('file', file);
      return fetch(`/api/media-library/${id}/replace`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      }).then(async res => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const err = new Error(body.error
            || (res.status === 413 ? 'That file is too large.' : 'Could not replace the file. Please try again.'));
          err.status = res.status;
          throw err;
        }
        return body;
      });
    },
    // `version` (the file's sha256) changes the URL when the file is replaced,
    // so an <img> that is already on screen fetches the new picture.
    downloadUrl: (id, version) =>
      `/api/media-library/${id}/download${version ? `?v=${encodeURIComponent(String(version).slice(0, 16))}` : ''}`,
  },
  pipelines: {
    list: () => req('/pipelines'),
    create: (name) => req('/pipelines', { method: 'POST', body: JSON.stringify({ name }) }),
    rename: (id, name) => req(`/pipelines/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
    delete: (id) => req(`/pipelines/${id}`, { method: 'DELETE' }),
    board: (id) => req(`/pipelines/${id}/board`),
    addStage: (id, data) => req(`/pipelines/${id}/stages`, { method: 'POST', body: JSON.stringify(data) }),
    reorderStages: (id, order) => req(`/pipelines/${id}/stages/reorder`, { method: 'PUT', body: JSON.stringify({ order }) }),
    updateStage: (stageId, data) => req(`/stages/${stageId}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteStage: (stageId) => req(`/stages/${stageId}`, { method: 'DELETE' }),
    addDeal: (id, data) => req(`/pipelines/${id}/deals`, { method: 'POST', body: JSON.stringify(data) }),
    updateDeal: (dealId, data) => req(`/deals/${dealId}`, { method: 'PUT', body: JSON.stringify(data) }),
    moveDeal: (dealId, stageId, sortOrder) => req(`/deals/${dealId}/move`, { method: 'PUT', body: JSON.stringify({ stageId, sortOrder }) }),
    deleteDeal: (dealId) => req(`/deals/${dealId}`, { method: 'DELETE' }),
    searchContacts: (q, tagIds = []) => {
      const qs = new URLSearchParams();
      if (q) qs.set('q', q);
      if (tagIds && tagIds.length) qs.set('tags', tagIds.join(','));
      return req(`/deal-contacts?${qs.toString()}`);
    },
    assignees: () => req('/deal-assignees'),
  },
  // Admin Settings -> Domain. The allow-list that both CORS and Caddy's
  // on-demand TLS read, so a domain added here takes effect without a restart.
  domains: {
    list: () => req('/domains'),
    // What the browser actually used vs what this install is configured for.
    // Every address bug on that screen turns out to be those two disagreeing,
    // so they are fetched together rather than shown apart.
    status: () => req('/domains/status'),
    add: (hostname) => req('/domains', { method: 'POST', body: JSON.stringify({ hostname }) }),
    // Fetches this install's own public address from the server side to find out
    // whether the domain reaches it. Takes up to ~16s in the worst case (https
    // then http, eight seconds each), so callers show a spinner rather than
    // assuming it returns promptly.
    check: (id) => req(`/domains/${id}/check`, { method: 'POST' }),
    // The reverse-proxy file this domain needs, already filled in — hostname,
    // router name, and whether a certresolver belongs on it. Only shown on
    // installs that do not own ports 80/443, where the app cannot do it itself.
    overlay: (id) => req(`/domains/${id}/overlay`),
    setActive: (id, isActive) =>
      req(`/domains/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive }) }),
    remove: (id) => req(`/domains/${id}`, { method: 'DELETE' }),
  },
  integrations: {
    listCredentials: () => req('/integrations/credentials'),
    saveCredentials: (data) =>
      req('/integrations/credentials', { method: 'PUT', body: JSON.stringify(data) }),
    deleteCredentials: () =>
      req('/integrations/credentials', { method: 'DELETE' }),
    list: () => req('/integrations'),
    disconnect: (id) => req(`/integrations/${id}`, { method: 'DELETE' }),
    test: (id) => req(`/integrations/${id}/test`, { method: 'POST' }),
    // Caller opens this URL in a popup window — it 302-redirects to Google's
    // consent screen. The popup's callback page posts a message to opener.
    connectUrl: (provider) => `/api/integrations/oauth/start?provider=${encodeURIComponent(provider)}`,
    sheets: {
      listSpreadsheets: (q = '') => {
        const qs = new URLSearchParams();
        if (q) qs.set('q', q);
        return req(`/integrations/google-sheets/spreadsheets${qs.toString() ? `?${qs}` : ''}`);
      },
      getSpreadsheet: (id) => req(`/integrations/google-sheets/spreadsheets/${encodeURIComponent(id)}`),
      previewTab: (id, tab, rows = 5) =>
        req(`/integrations/google-sheets/spreadsheets/${encodeURIComponent(id)}/preview?tab=${encodeURIComponent(tab)}&rows=${rows}`),
    },
    calendar: {
      listCalendars: () => req('/integrations/google-calendar/calendars'),
    },
    gmail: {
      profile: () => req('/integrations/gmail/profile'),
      labels: () => req('/integrations/gmail/labels'),
    },
  },
  mcp: {
    getSettings: () => req('/mcp/settings'),
    updateSettings: (data) => req('/mcp/settings', { method: 'PUT', body: JSON.stringify(data) }),
    listKeys: () => req('/mcp/keys'),
    createKey: (label) => req('/mcp/keys', { method: 'POST', body: JSON.stringify({ label }) }),
    updateKey: (id, data) => req(`/mcp/keys/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteKey: (id) => req(`/mcp/keys/${id}`, { method: 'DELETE' }),
    install: () => req('/mcp/install'),
    // A plain URL, not a fetch: the browser downloads it via <a download> so the
    // auth cookie rides along — same pattern as the contacts import template.
    pluginZipUrl: () => '/api/mcp/plugin.zip',
    // OAuth clients — what Claude's connector dialog wants (Client ID + Secret).
    // Separate from the legacy key-in-URL scheme above, which stays supported.
    oauthClients: () => req('/mcp/oauth/clients'),
    createOauthClient: (data) => req('/mcp/oauth/clients', { method: 'POST', body: JSON.stringify(data) }),
    updateOauthClient: (id, data) => req(`/mcp/oauth/clients/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteOauthClient: (id) => req(`/mcp/oauth/clients/${id}`, { method: 'DELETE' }),
  },
  // Message Formats — labelled pre-filled WhatsApp openers + their tracking.
  // The backend answers on /wa-links too; this group uses the canonical path.
  messageFormats: {
    list: () => req('/message-formats'),
    get: (id) => req(`/message-formats/${id}`),
    create: (data) => req('/message-formats', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/message-formats/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/message-formats/${id}`, { method: 'DELETE' }),
    stats: (id, days = 30) => req(`/message-formats/${id}/stats?days=${days}`),
  },
  // Pre-093 alias. Kept so nothing that still calls api.waLinks breaks.
  waLinks: {
    list: () => req('/wa-links'),
    create: (data) => req('/wa-links', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/wa-links/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/wa-links/${id}`, { method: 'DELETE' }),
  },
  // ── AI Academy Dashboard ──────────────────────────────────────────────────
  leads: {
    list: (params = {}) => {
      const qs = new URLSearchParams(params);
      return req(`/leads${qs.toString() ? `?${qs}` : ''}`);
    },
    board: () => req('/leads/board'),
    onboarding: () => req('/leads/onboarding'),
    sources: (params = {}) => {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
      return req(`/lead-sources${qs.toString() ? `?${qs}` : ''}`);
    },
    get: (id) => req(`/leads/${id}`),
    // Everything known about whoever is on the other end of a chat — the lead,
    // its payments and whether that makes them a customer — matched on the last
    // 10 digits server-side, like every other lead lookup in this app.
    byPhone: (number) => req(`/leads/by-phone/${encodeURIComponent(number)}`),
    timeline: (id) => req(`/leads/${id}/timeline`),
    // The contact pop-up: system + custom fields, chat threads, automation and
    // AI-agent runs, stage history — one round trip.
    profile: (id) => req(`/leads/${id}/profile`),
    create: (data) => req('/leads', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/leads/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    move: (id, stage) => req(`/leads/${id}/move`, { method: 'PUT', body: JSON.stringify({ stage }) }),
    bulkAssign: (leadIds, assignedUserId, assignedBda) =>
      req('/leads/bulk-assign', { method: 'POST', body: JSON.stringify({ leadIds, assignedUserId, assignedBda }) }),
    exportUrl: (params = {}) => {
      const qs = new URLSearchParams(params);
      return `/api/leads/export${qs.toString() ? `?${qs}` : ''}`;
    },
    // Bulk import from a sheet. A plain <a download> for the sample so the auth
    // cookie rides along; the upload is FormData, so it must NOT go through
    // req() (which sets a JSON Content-Type and would break the multipart
    // boundary).
    importTemplateUrl: () => '/api/leads/import/template',
    import: async (file, source) => {
      const form = new FormData();
      form.append('file', file);
      if (source) form.append('source', source);
      const res = await fetch('/api/leads/import', { method: 'POST', credentials: 'include', body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || 'Failed to import the sheet');
      return json;
    },
  },
  marketing: {
    // Accepts a range params object ({ days } or { from, to }, see
    // components/DateRangeControl rangeParams) or the legacy bare `days` number.
    overview: (range = { days: 30 }, source) => {
      const qs = new URLSearchParams();
      const r = typeof range === 'object' && range ? range : { days: range };
      Object.entries(r).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
      if (source) qs.set('source', source);
      return req(`/marketing/overview?${qs}`);
    },
    metaAds: {
      status: () => req('/marketing/meta-ads/status'),
      connect: (token, adAccountIds) => req('/marketing/meta-ads/connect', { method: 'POST', body: JSON.stringify({ token, adAccountIds }) }),
      setAccounts: (adAccountIds) => req('/marketing/meta-ads/accounts', { method: 'PUT', body: JSON.stringify({ adAccountIds }) }),
      sync: () => req('/marketing/meta-ads/sync', { method: 'POST' }),
      disconnect: () => req('/marketing/meta-ads/disconnect', { method: 'POST' }),
    },
  },
  campaigns: {
    // No params = every campaign with lifetime figures; { days } or { from, to }
    // = campaigns that delivered in the range, with per-day Meta figures.
    list: (params = {}) => {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
      return req(`/campaigns${qs.toString() ? `?${qs}` : ''}`);
    },
    get: (id) => req(`/campaigns/${id}`),
    create: (data) => req('/campaigns', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/campaigns/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/campaigns/${id}`, { method: 'DELETE' }),
    ads: (id) => req(`/campaigns/${id}/ads`),
  },
  // Click-to-WhatsApp ad performance, built from the CTWA `referral` blocks the
  // webhook already receives (click id + ad id + creative), joined to spend.
  ctwa: {
    overview: (params = {}) => {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
      return req(`/ctwa/overview${qs.toString() ? `?${qs}` : ''}`);
    },
    ad: (sourceId) => req(`/ctwa/ads/${encodeURIComponent(sourceId)}`),
    backfillDailySpend: (days) => req('/marketing/meta-ads/backfill-daily', { method: 'POST', body: JSON.stringify({ days }) }),
  },


  // Meta Conversions API — send the click id back when a lead converts.
  capi: {
    config: () => req('/capi/config'),
    updateConfig: (data) => req('/capi/config', { method: 'PUT', body: JSON.stringify(data) }),
    discoverDatasets: () => req('/capi/datasets/discover', { method: 'POST' }),
    createDataset: (wabaId) => req(`/capi/datasets/${encodeURIComponent(wabaId)}/create`, { method: 'POST' }),
    linkDataset: (wabaId, datasetId) => req(`/capi/datasets/${encodeURIComponent(wabaId)}`, { method: 'PUT', body: JSON.stringify({ datasetId }) }),
    createMapping: (data) => req('/capi/mappings', { method: 'POST', body: JSON.stringify(data) }),
    updateMapping: (id, data) => req(`/capi/mappings/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteMapping: (id) => req(`/capi/mappings/${id}`, { method: 'DELETE' }),
    events: (params = {}) => {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
      return req(`/capi/events${qs.toString() ? `?${qs}` : ''}`);
    },
    resend: (id) => req(`/capi/events/${id}/resend`, { method: 'POST' }),
    send: (leadId, opts = {}) => req('/capi/send', { method: 'POST', body: JSON.stringify({ leadId, ...opts }) }),
    backfill: (limit) => req('/capi/backfill', { method: 'POST', body: JSON.stringify({ limit }) }),
    test: (eventName) => req('/capi/test', { method: 'POST', body: JSON.stringify({ eventName }) }),
    clickIds: (params = {}) => {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
      return req(`/capi/click-ids${qs.toString() ? `?${qs}` : ''}`);
    },
    learning: () => req('/capi/learning'),
    performance: () => req('/capi/performance'),
    fieldPreview: () => req('/capi/field-preview'),
    timing: () => req('/capi/timing'),
  },

  // Conversion Leads Optimisation — Meta Lead Ads only, separate from capi.*
  clo: {
    settings: () => req('/marketing/clo/settings'),
    updateSettings: (data) => req('/marketing/clo/settings', { method: 'PUT', body: JSON.stringify(data) }),
    stages: () => req('/marketing/clo/stages'),
    createStage: (data) => req('/marketing/clo/stages', { method: 'POST', body: JSON.stringify(data) }),
    updateStage: (id, data) => req(`/marketing/clo/stages/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteStage: (id) => req(`/marketing/clo/stages/${id}`, { method: 'DELETE' }),
    reorderStages: (ids) => req('/marketing/clo/stages/reorder', { method: 'PUT', body: JSON.stringify({ ids }) }),
    stageStats: () => req('/marketing/clo/stage-stats'),
    testEvent: (data = {}) => req('/marketing/clo/test-event', { method: 'POST', body: JSON.stringify(data) }),
    flush: () => req('/marketing/clo/flush', { method: 'POST' }),
    readiness: () => req('/marketing/clo/readiness'),
    events: (params = {}) => {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
      return req(`/marketing/clo/events${qs.toString() ? `?${qs}` : ''}`);
    },
    retryEvent: (id) => req(`/marketing/clo/events/${id}/retry`, { method: 'POST' }),
    retryBulk: (filters) => req('/marketing/clo/events/retry-bulk', { method: 'POST', body: JSON.stringify(filters) }),
    backfill: (opts = {}) => req('/marketing/clo/backfill', { method: 'POST', body: JSON.stringify(opts) }),
  },

  resources: {
    list: (dynamic) => {
      const qs = new URLSearchParams();
      if (dynamic !== undefined) qs.set('dynamic', dynamic);
      return req(`/resources${qs.toString() ? `?${qs}` : ''}`);
    },
    create: (data) => req('/resources', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/resources/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/resources/${id}`, { method: 'DELETE' }),
    retire: (id) => req(`/resources/${id}/retire`, { method: 'POST' }),
    triggerLibrary: () => req('/trigger-library'),
    updateTriggers: (id, data) => req(`/resources/${id}/triggers`, { method: 'PUT', body: JSON.stringify(data) }),
    testTrigger: (phrase) => req('/trigger-test', { method: 'POST', body: JSON.stringify({ phrase }) }),
  },
  webinars: {
    list: () => req('/webinars'),
    funnel: (id) => req(`/webinars/${id}/funnel`),
    create: (data) => req('/webinars', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/webinars/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/webinars/${id}`, { method: 'DELETE' }),
    registrations: (webinarId) => {
      const qs = new URLSearchParams();
      if (webinarId) qs.set('webinarId', webinarId);
      return req(`/webinar-registrations${qs.toString() ? `?${qs}` : ''}`);
    },
    saveRegistration: (data) => req('/webinar-registrations', { method: 'POST', body: JSON.stringify(data) }),
    updateRegistration: (id, data) => req(`/webinar-registrations/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  },
  bda: {
    performance: (period = 'month') => req(`/bda-performance?period=${period}`),
    webinarConversion: () => req('/webinar-conversion'),
  },
  // Chat Analyzer — reads conversations (1:1 and WhatsApp groups) and says what
  // they are about. Every run costs money, so `estimate` exists to be called
  // before `runBulk`, never after.
  // Leads → My list (pinned chats) + the follow-up calendar.
  myList: {
    list: () => req('/my-list'),
    pin: (waNumber, contactNumber) => req('/my-list', { method: 'POST', body: JSON.stringify({ waNumber, contactNumber }) }),
    unpin: (contactNumber) => req(`/my-list${qs({ contactNumber })}`, { method: 'DELETE' }),
  },
  followUps: {
    list: (params = {}) => req(`/follow-ups${qs(params)}`),
    chat: (waNumber, contactNumber) => req(`/follow-ups/chat${qs({ waNumber, contactNumber })}`),
    set: (data) => req('/follow-ups', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/follow-ups/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    remove: (id) => req(`/follow-ups/${id}`, { method: 'DELETE' }),
    suggest: (waNumber, contactNumber) => req('/follow-ups/suggest', { method: 'POST', body: JSON.stringify({ waNumber, contactNumber }) }),
    google: () => req('/follow-ups/google'),
    googleSync: (data = {}) => req('/follow-ups/google/sync', { method: 'POST', body: JSON.stringify(data) }),
  },
  chatAnalyzer: {
    list: (params = {}) => req(`/chat-analysis${qs(params)}`),
    conversation: (source, key) => req(`/chat-analysis/conversation${qs({ source, key })}`),
    // Business context: what we sell, read by every analysis.
    context: {
      get: () => req('/chat-analysis/context'),
      saveBusiness: (business) => req('/chat-analysis/context', { method: 'PUT', body: JSON.stringify({ business }) }),
      addProduct: (p) => req('/chat-analysis/context/products', { method: 'POST', body: JSON.stringify(p) }),
      updateProduct: (id, p) => req(`/chat-analysis/context/products/${id}`, { method: 'PUT', body: JSON.stringify(p) }),
      deleteProduct: (id) => req(`/chat-analysis/context/products/${id}`, { method: 'DELETE' }),
      importProducts: () => req('/chat-analysis/context/import-products', { method: 'POST' }),
    },
    // What was SAID (timestamped, voice notes as their exact transcript), as
    // opposed to `conversation`, which is what it MEANT.
    transcript: (params = {}) => req(`/chat-analysis/transcript${qs(params)}`),
    transcribe: (body) => req('/chat-analysis/transcribe', { method: 'POST', body: JSON.stringify(body) }),
    // One voice note from the Chats window: its transcript, or what making one would cost.
    voiceNote: (messageId) => req(`/chat-analysis/voice-notes/${encodeURIComponent(messageId)}`),
    transcribeVoiceNote: (messageId) => req(`/chat-analysis/voice-notes/${encodeURIComponent(messageId)}/transcribe`, { method: 'POST' }),
    // Replace an older model's (Whisper) transcript with the current model's.
    retranscribeVoiceNote: (messageId) => req(`/chat-analysis/voice-notes/${encodeURIComponent(messageId)}/retranscribe`, { method: 'POST' }),
    legacyTranscripts: () => req('/chat-analysis/retranscribe-legacy'),
    retranscribeLegacyBatch: () => req('/chat-analysis/retranscribe-legacy', { method: 'POST' }),
    run: (body) => req('/chat-analysis/run', { method: 'POST', body: JSON.stringify(body) }),
    estimate: (body) => req('/chat-analysis/estimate', { method: 'POST', body: JSON.stringify(body) }),
    runBulk: (body) => req('/chat-analysis/run-bulk', { method: 'POST', body: JSON.stringify(body) }),
    batch: (batchId) => req(`/chat-analysis/batches/${batchId}`),
    runs: (params = {}) => req(`/chat-analysis/runs${qs(params)}`),
    summary: (params = {}) => req(`/chat-analysis/summary${qs(params)}`),
    applied: (body) => req('/chat-analysis/applied', { method: 'POST', body: JSON.stringify(body) }),
    dismiss: (body) => req('/chat-analysis/dismiss', { method: 'POST', body: JSON.stringify(body) }),
    config: {
      get: () => req('/chat-analysis/config'),
      update: (data) => req('/chat-analysis/config', { method: 'PUT', body: JSON.stringify(data) }),
    },
  },

  funnel: {
    config: () => req('/funnel/config'),
    chart: (params = {}) => {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
      return req(`/funnel/chart${qs.toString() ? `?${qs}` : ''}`);
    },
    // stage config (admin)
    stages: () => req('/funnel/config'),
    createStage: (data) => req('/funnel/stages', { method: 'POST', body: JSON.stringify(data) }),
    updateStage: (id, data) => req(`/funnel/stages/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    reorderStages: (order) => req('/funnel/stages/reorder', { method: 'PUT', body: JSON.stringify({ order }) }),
    deleteStage: (id) => req(`/funnel/stages/${id}`, { method: 'DELETE' }),
    // source config (admin)
    sources: () => req('/funnel/sources'),
    createSource: (label) => req('/funnel/sources', { method: 'POST', body: JSON.stringify({ label }) }),
    updateSource: (id, data) => req(`/funnel/sources/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteSource: (id) => req(`/funnel/sources/${id}`, { method: 'DELETE' }),
  },
  // Entity-field registry — configurable fields for the Leads table, the
  // Sales Log (entity 'lead') and Transactions (entity 'transaction').
  entityFields: {
    list: () => req('/entity-fields'),
    create: (data) => req('/entity-fields', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/entity-fields/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    reorder: (entity, ids) => req('/entity-fields/reorder', { method: 'PUT', body: JSON.stringify({ entity, ids }) }),
    delete: (id) => req(`/entity-fields/${id}`, { method: 'DELETE' }),
    restore: (id) => req(`/entity-fields/${id}/restore`, { method: 'POST' }),
  },
  students: {
    list: () => req('/students'),
    installments: (id) => req(`/students/${id}/installments`),
    addInstallment: (id, data) => req(`/students/${id}/installments`, { method: 'POST', body: JSON.stringify(data) }),
    // Money given back to the customer (amount, date, method, note) — several per sale.
    addRefund: (id, data) => req(`/students/${id}/refunds`, { method: 'POST', body: JSON.stringify(data) }),
    deleteRefund: (id, refundId) => req(`/students/${id}/refunds/${refundId}`, { method: 'DELETE' }),
    addSale: (data) => req('/students', { method: 'POST', body: JSON.stringify(data) }),
    delete: (id) => req(`/students/${id}`, { method: 'DELETE' }),
    exportUrl: (format = 'csv') => `/api/students/export?format=${format}`,
  },
  salesLog: {
    list: (params = {}) => {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
      return req(`/sales-log${qs.toString() ? `?${qs}` : ''}`);
    },
    summary: (params = {}) => {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
      return req(`/sales-log/summary${qs.toString() ? `?${qs}` : ''}`);
    },
    create: (data) => req('/sales-log', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/sales-log/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/sales-log/${id}`, { method: 'DELETE' }),
  },
  upload: (file) => {
    const form = new FormData();
    form.append('file', file);
    return fetch('/api/upload', {
      method: 'POST',
      credentials: 'include',
      body: form,
    }).then(async res => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${text}`);
      }
      return res.json();
    });
  },
  // ── Message costs — what we owe Meta, per template and per message type ──
  messageCosts: {
    overview: (params = {}) => req(`/message-costs/overview${qs(params)}`),
    templates: (params = {}) => req(`/message-costs/templates${qs(params)}`),
    template: (id, params = {}) => req(`/message-costs/templates/${id}${qs(params)}`),
    breakdown: (params = {}) => req(`/message-costs/breakdown${qs(params)}`),
    trend: (params = {}) => req(`/message-costs/trend${qs(params)}`),
    config: () => req('/message-costs/config'),
    saveConfig: (data) => req('/message-costs/config', { method: 'PUT', body: JSON.stringify(data) }),
    saveRate: (id, rate) => req(`/message-costs/rates/${id}`, { method: 'PUT', body: JSON.stringify({ rate }) }),
    addRate: (data) => req('/message-costs/rates', { method: 'POST', body: JSON.stringify(data) }),
    sync: (days) => req('/message-costs/sync', { method: 'POST', body: JSON.stringify({ days }) }),
    backfill: (days) => req('/message-costs/backfill', { method: 'POST', body: JSON.stringify({ days }) }),
  },

  // Workflow Agents (migration 121): Claude-run agents that read the CRM and
  // propose changes for approval. The paths are /workflow-agents because
  // /agents is the customer-facing AI Agents API above.
  workflowAgents: {
    catalog: () => req('/workflow-agents/catalog'),
    presets: () => req('/workflow-agents/presets'),
    preset: (key) => req(`/workflow-agents/presets/${encodeURIComponent(key)}`),
    list: () => req('/workflow-agents'),
    get: (id) => req(`/workflow-agents/${id}`),
    create: (data) => req('/workflow-agents', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, patch) => req(`/workflow-agents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    delete: (id) => req(`/workflow-agents/${id}`, { method: 'DELETE' }),
    saveVersion: (id, config, changeNote) => req(`/workflow-agents/${id}/versions`, { method: 'POST', body: JSON.stringify({ config, change_note: changeNote || null }) }),
    versions: (id) => req(`/workflow-agents/${id}/versions`),
    version: (id, vid) => req(`/workflow-agents/${id}/versions/${vid}`),
    restore: (id, vid) => req(`/workflow-agents/${id}/restore/${vid}`, { method: 'POST' }),
    audit: (id) => req(`/workflow-agents/${id}/audit`),

    memory: (id, params = {}) => req(`/workflow-agents/${id}/memory${qs(params)}`),
    createMemory: (id, data) => req(`/workflow-agents/${id}/memory`, { method: 'POST', body: JSON.stringify(data) }),
    updateMemory: (id, mid, data) => req(`/workflow-agents/${id}/memory/${mid}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteMemory: (id, mid) => req(`/workflow-agents/${id}/memory/${mid}`, { method: 'DELETE' }),
    approveMemory: (id, mid, edits) => req(`/workflow-agents/${id}/memory/${mid}/approve`, { method: 'POST', body: JSON.stringify({ edits: edits || {} }) }),
    rejectMemory: (id, mid) => req(`/workflow-agents/${id}/memory/${mid}/reject`, { method: 'POST' }),

    // dry_run + config_override = the test playground: runs the UNSAVED config.
    run: (id, body = {}) => req(`/workflow-agents/${id}/run`, { method: 'POST', body: JSON.stringify(body) }),
    runs: (id, params = {}) => req(`/workflow-agents/${id}/runs${qs(params)}`),
    results: (id, params = {}) => req(`/workflow-agents/${id}/results${qs(params)}`),
    getRun: (rid) => req(`/workflow-agents/runs/${rid}`),
    runSteps: (rid) => req(`/workflow-agents/runs/${rid}/steps`),
    cancelRun: (rid) => req(`/workflow-agents/runs/${rid}/cancel`, { method: 'POST' }),
    rerun: (rid) => req(`/workflow-agents/runs/${rid}/rerun`, { method: 'POST' }),
    previewTool: (key, body) => req(`/workflow-agents/tools/${encodeURIComponent(key)}/preview`, { method: 'POST', body: JSON.stringify(body) }),

    actions: (params = {}) => req(`/workflow-agents/actions${qs(params)}`),
    decide: (ids, decision) => req('/workflow-agents/actions/decide', { method: 'POST', body: JSON.stringify({ ids, decision }) }),
    approve: (aid, edits) => req(`/workflow-agents/actions/${aid}/approve`, { method: 'POST', body: JSON.stringify({ edits: edits || null }) }),
    reject: (aid) => req(`/workflow-agents/actions/${aid}/reject`, { method: 'POST' }),

    worklist: (params = {}) => req(`/workflow-agents/worklist/me${qs(params)}`),
    sendSuggested: (body) => req('/workflow-agents/worklist/send', { method: 'POST', body: JSON.stringify(body) }),
    feedback: (body) => req('/workflow-agents/feedback', { method: 'POST', body: JSON.stringify(body) }),
    tasks: (status = 'open') => req(`/workflow-agents/tasks${qs({ status })}`),
    updateTask: (tid, status) => req(`/workflow-agents/tasks/${tid}`, { method: 'PUT', body: JSON.stringify({ status }) }),
    notifications: (unreadOnly = false) => req(`/workflow-agents/notifications${unreadOnly ? '?unread=1' : ''}`),
    markNotificationsRead: (ids) => req('/workflow-agents/notifications/read', { method: 'POST', body: JSON.stringify({ ids: ids || [] }) }),

    settings: () => req('/workflow-agents/settings'),
    updateSettings: (patch) => req('/workflow-agents/settings', { method: 'PUT', body: JSON.stringify(patch) }),
    team: () => req('/workflow-agents/team'),
    saveTeam: ({ id, ...data }) => (id
      ? req(`/workflow-agents/team/teams/${id}`, { method: 'PUT', body: JSON.stringify(data) })
      : req('/workflow-agents/team/teams', { method: 'POST', body: JSON.stringify(data) })),
    deleteTeam: (tid) => req(`/workflow-agents/team/teams/${tid}`, { method: 'DELETE' }),
    updateRep: (uid, patch) => req(`/workflow-agents/team/reps/${uid}`, { method: 'PUT', body: JSON.stringify(patch) }),
    assignNumber: (accountId, repUserId, note) => req(`/workflow-agents/team/numbers/${accountId}`, { method: 'PUT', body: JSON.stringify({ rep_user_id: repUserId, note: note || null }) }),
  },
};
