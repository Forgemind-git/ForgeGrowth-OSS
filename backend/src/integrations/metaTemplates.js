// Meta WhatsApp Cloud API — Template Management
// Submits a template definition for review. Meta returns the template's status
// immediately (often PENDING; sometimes auto-APPROVED or auto-REJECTED).

const META_API_VERSION = process.env.META_API_VERSION || 'v21.0';

/**
 * Submit a template for review.
 * @param {string} wabaId
 * @param {string} accessToken
 * @param {object} payload — { name, language, category, components, allow_category_change? }
 * @returns Meta response { id, status, category }
 */
async function submitTemplate(wabaId, accessToken, payload) {
  const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(wabaId)}/message_templates`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  if (!res.ok) {
    const err = new Error(`Meta submit ${res.status}: ${parsed?.error?.message || text.slice(0, 300)}`);
    err.status = res.status;
    err.metaError = parsed?.error || null;
    throw err;
  }
  return parsed; // { id, status, category }
}

/**
 * Delete a template (only DRAFT/REJECTED locally — Meta supports delete on its side too).
 */
async function deleteTemplate(wabaId, accessToken, name) {
  const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(wabaId)}/message_templates?name=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Meta delete ${res.status}: ${text.slice(0, 200)}`);
  }
  return true;
}

/**
 * List all templates on a WABA with their current Meta-side status, quality,
 * rejection reason, and category-change history. Used by /templates/sync.
 */
async function listTemplates(wabaId, accessToken, { fields, limit = 100 } = {}) {
  const f = fields || 'name,language,status,category,previous_category,quality_score,rejected_reason,id';
  const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(wabaId)}/message_templates`
    + `?fields=${encodeURIComponent(f)}&limit=${limit}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  if (!res.ok) {
    const err = new Error(`Meta listTemplates ${res.status}: ${parsed?.error?.message || text.slice(0, 200)}`);
    err.status = res.status;
    err.metaError = parsed?.error || null;
    throw err;
  }
  return parsed?.data || [];
}

/**
 * Library templates — Meta's curated list of pre-built templates that
 * businesses can clone with one click.
 */
async function listLibraryTemplates(accessToken, { topic, limit = 100 } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (topic) params.set('topic', topic);
  const url = `https://graph.facebook.com/${META_API_VERSION}/message_template_library?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  if (!res.ok) {
    const err = new Error(`Meta library ${res.status}: ${parsed?.error?.message || text.slice(0, 200)}`);
    err.status = res.status;
    err.metaError = parsed?.error || null;
    throw err;
  }
  return parsed?.data || [];
}

/**
 * Edit an APPROVED template. Meta accepts a partial payload — only the
 * components you want to change, plus optionally `category` (only for
 * MARKETING<->UTILITY swaps; AUTHENTICATION cannot be re-categorized).
 * Note: `name` and `language` cannot be edited.
 *
 * Meta enforces 10 edits/hour and 10 edits/day per template.
 *
 * @param {string} metaTemplateId — Meta's template id (we store this as meta_template_id)
 * @param {string} accessToken
 * @param {object} payload — { components, category? }
 * @returns {object} { success: true }
 */
async function editTemplate(metaTemplateId, accessToken, payload) {
  const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(metaTemplateId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  if (!res.ok) {
    const err = new Error(`Meta edit ${res.status}: ${parsed?.error?.message || text.slice(0, 300)}`);
    err.status = res.status;
    err.metaError = parsed?.error || null;
    throw err;
  }
  return parsed || { success: true };
}

/**
 * Fetch per-day analytics for one or more templates from Meta.
 *
 * @param {string} wabaId
 * @param {string} accessToken
 * @param {object} opts
 * @param {string[]} opts.templateIds — Meta template IDs (numeric strings)
 * @param {Date|number} opts.start — start of window (will be coerced to Unix seconds)
 * @param {Date|number} opts.end — end of window
 * @param {'DAILY'|'HOURLY'} [opts.granularity='DAILY']
 * @param {string[]} [opts.metricTypes=['SENT','DELIVERED','READ','CLICKED']]
 *
 * Meta caps the window at 90 days; longer windows return an error.
 * Response shape: { data: [{ template_id, granularity, data_points: [{ start, end, sent, delivered, read, clicked: [{type, button_content, count}] }] }] }
 */
async function fetchAnalytics(wabaId, accessToken, { templateIds, start, end, granularity = 'DAILY', metricTypes = ['SENT', 'DELIVERED', 'READ', 'CLICKED'] }) {
  const toUnix = (d) => Math.floor((d instanceof Date ? d.getTime() : d) / 1000);
  const params = new URLSearchParams({
    fields: 'template_analytics',
    start: String(toUnix(start)),
    end: String(toUnix(end)),
    granularity,
    metric_types: JSON.stringify(metricTypes),
    template_ids: JSON.stringify(templateIds.map(String)),
  });
  const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(wabaId)}/template_analytics?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  if (!res.ok) {
    // Meta's user-friendly message (error_user_msg / error_data) is much more
    // actionable than the generic "An unknown error occurred". Prefer it.
    const friendly = parsed?.error?.error_user_msg
      || parsed?.error?.error_data
      || parsed?.error?.message
      || text.slice(0, 300);
    const err = new Error(`Meta analytics ${res.status}: ${friendly}`);
    err.status = res.status;
    err.metaError = parsed?.error || null;
    // Flag the specific "insights not enabled" case so callers can show a
    // setup hint instead of a generic failure
    err.insightsDisabled = parsed?.error?.error_subcode === 4182004;
    throw err;
  }
  return parsed?.data || [];
}

module.exports = { submitTemplate, editTemplate, deleteTemplate, listTemplates, listLibraryTemplates, fetchAnalytics };
