const pool = require('../db');
const { decrypt } = require('../util/crypto');
const bus = require('../events');
const { sheetsAppendRow, calendarInsertEvent, gmailSend } = require('../integrations/googleClient');
const { PROVIDER_DEFAULT_BASE, runChatCompletion, pickDefaultModel } = require('../llm/chatCompletion');

/* ══════════════════════════════════════════════════════════════════════
   Minimal Automation Execution Engine
   Evaluates keyword triggers and walks the automation graph,
   logging every step to automation_executions / automation_execution_steps.
   ══════════════════════════════════════════════════════════════════════ */

// ─── Helpers ─────────────────────────────────────────────────────────

function normalizeText(text) {
  return (text || '').toLowerCase().trim();
}

function matchesKeyword(messageBody, keyword, matchType, caseSensitive) {
  if (!messageBody || !keyword) return false;
  const msg = caseSensitive ? messageBody.trim() : normalizeText(messageBody);
  const kw = caseSensitive ? keyword.trim() : normalizeText(keyword);
  if (!kw) return false;
  switch (matchType) {
    case 'contains': return msg.includes(kw);
    case 'starts': return msg.startsWith(kw);
    case 'exact':
    default:
      return msg === kw;
  }
}

// Stringify any value for {{var}} interpolation. Primitives become their plain
// string form; objects/arrays go through JSON.stringify so the user at least
// sees readable JSON instead of `[object Object]`.
function _stringifyForInterpolation(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Normalize a ForgeCRM field name into a {{variable}} token key.
// MUST stay identical to fieldVarKey() in the frontend AutomationBuilderView.jsx
// so the token the picker inserts is the token we resolve here.
// "Date of Birth" -> "date_of_birth", "city" -> "city".
function fieldVarKey(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function resolveVariables(text, context) {
  if (!text) return text;
  const contact = context.contact || {};
  // Lower-case the lookup map so `{{Name}}`, `{{NAME}}`, `{{name}}` all resolve.
  // Custom-field keys keep their original case at storage time but match
  // case-insensitively against the template tokens.
  // {{name}} prefers the captured name but falls back to the WhatsApp profile
  // name so greetings still render for contacts we haven't formally captured.
  // (Conditions use the RAW captured name via getFieldValue — see below.)
  const displayName = contact.name || contact.profile_name || '';
  const lookup = {
    name: displayName,
    first_name: displayName.split(' ')[0] || '',
    contact_number: contact.contact_number || context.contact_number || '',
    phone: contact.contact_number || context.contact_number || '',
  };
  // Map field id -> name so DB-loaded custom_fields (keyed by id, e.g. cf-city)
  // can be referenced by their normalized field name (e.g. {{city}}).
  const nameById = {};
  for (const fd of (context.field_defs || [])) { if (fd && fd.id) nameById[fd.id] = fd.name; }
  Object.entries(contact.custom_fields || {}).forEach(([k, v]) => {
    const sval = _stringifyForInterpolation(v);
    const lk = String(k).toLowerCase();
    // Built-ins win over custom fields with the same key, so AI extractions
    // can't clobber the canonical contact data.
    if (lookup[lk] === undefined || lookup[lk] === '') {
      lookup[lk] = sval;
    }
    // Also register under the field's normalized name when the key is a field id.
    const fname = nameById[k];
    if (fname) {
      const nk = fieldVarKey(fname);
      if (nk && (lookup[nk] === undefined || lookup[nk] === '')) lookup[nk] = sval;
    }
  });
  return String(text).replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => {
    const lk = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(lookup, lk) ? lookup[lk] : match;
  });
}

function resolveTemplateVariables(templateBody, bindings, context) {
  if (!templateBody) return templateBody;
  let result = templateBody;
  // Handle {{1}}, {{2}} etc. via bindings
  if (bindings) {
    Object.entries(bindings).forEach(([key, val]) => {
      const varNum = key.replace('var', '');
      const resolved = resolveVariables(val, context);
      result = result.replace(new RegExp(`\\{\\{${varNum}\\}\\}`, 'g'), resolved);
    });
  }
  return result;
}

// ─── Condition Evaluation ────────────────────────────────────────────

// Current weekday + hour in IST (the workspace timezone), for time conditions.
function istNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', weekday: 'long', hour: 'numeric', hour12: false,
  }).formatToParts(new Date());
  const weekday = (parts.find(p => p.type === 'weekday')?.value || '').toLowerCase();
  let hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  if (hour === 24) hour = 0;
  return { weekday, hour };
}

function getFieldValue(source, field, context) {
  const contact = context.contact || {};
  const cf = contact.custom_fields || {};
  // custom_fields are stored either by raw name (ai_summary, last_intent) OR by
  // field-definition id (Set Custom Field). Resolve a NAME to whichever holds it.
  const fromCustomFields = (name) => {
    if (cf[name] !== undefined) return cf[name];
    const def = (context.field_defs || []).find(d => String(d.name).toLowerCase() === String(name).toLowerCase());
    if (def && cf[def.id] !== undefined) return cf[def.id];
    return undefined;
  };

  if (source === 'custom' || source === 'system') {
    if (field === 'name') return contact.name || '';
    if (field === 'contact_number' || field === 'phone') return contact.contact_number || context.contact_number || '';
    if (/^(last[_ ]?message|message)$/i.test(field)) return context.message_body || '';
    return fromCustomFields(field) ?? '';
  }
  if (source === 'tags') {
    const tags = (contact.tags || []).map(t => (typeof t === 'string' ? t : (t && t.name) || ''));
    return tags.some(t => String(t).toLowerCase() === String(field).toLowerCase()) ? field : '';
  }
  if (source === 'time') {
    const { weekday, hour } = istNow();
    if (/hour/i.test(field)) return hour;
    if (/day/i.test(field)) return weekday;
    // "Current time" / business hours: Mon–Sat 09:00–18:00 IST
    return (weekday !== 'sunday' && hour >= 9 && hour < 18) ? 'business' : 'after-hours';
  }
  if (source === 'bot') {
    if (/intent/i.test(field)) return fromCustomFields('last_intent') ?? fromCustomFields('intent') ?? '';
    if (/state/i.test(field)) return fromCustomFields('bot_state') ?? '';
    if (/count/i.test(field)) return context.conversation_count ?? '';
    return fromCustomFields(field) ?? '';
  }
  return '';
}

function evaluateRule(rule, context) {
  const { source, field, op, value } = rule;
  const fieldValue = getFieldValue(source, field, context);
  const compareValue = value !== undefined ? value : '';
  const strField = String(fieldValue ?? '').toLowerCase();
  const strCompare = String(compareValue).toLowerCase();

  switch (op) {
    case 'equals': return strField === strCompare;
    case 'not equals': return strField !== strCompare;
    case 'contains': return strField.includes(strCompare);
    case 'not contains': return !strField.includes(strCompare);
    case 'starts with': return strField.startsWith(strCompare);
    case 'ends with': return strField.endsWith(strCompare);
    case 'is empty': return strField === '';
    case 'is not empty': return strField !== '';
    case 'greater than': return Number(fieldValue) > Number(compareValue);
    case 'less than': return Number(fieldValue) < Number(compareValue);
    case 'has tag': return strField !== '';
    case 'not has tag': return strField === '';
    case 'is true': return String(fieldValue).toLowerCase() === 'true' || fieldValue === true;
    case 'is false': return String(fieldValue).toLowerCase() === 'false' || fieldValue === false;
    default: return false;
  }
}

function evaluateConditions(node, context) {
  const matchMode = node.matchMode || 'all';
  // Random Split (A/B): ignore rules, send ~50% down each branch.
  if (matchMode === 'random') return Math.random() < 0.5;
  const rules = node.rules || [];
  if (rules.length === 0) return true;
  const results = rules.map(r => evaluateRule(r, context));
  if (matchMode === 'any') return results.some(Boolean);
  return results.every(Boolean);
}

// ─── Step Logger ─────────────────────────────────────────────────────

async function logStep(client, executionId, node, input, output, status, errorMessage, waMessageId, waMessageStatus) {
  const { rows } = await client.query(
    `INSERT INTO coexistence.automation_execution_steps
     (execution_id, node_id, node_type, node_name, input_data, output_data, status, completed_at, error_message, wa_message_id, wa_message_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      executionId,
      node.id,
      node.type,
      node.title || node.name || `${node.type} node`,
      JSON.stringify(input || {}),
      JSON.stringify(output || {}),
      status,
      status === 'running' ? null : new Date().toISOString(),
      errorMessage || null,
      waMessageId || output?.whatsapp?.message_id || output?.waMessageId || null,
      waMessageStatus || output?.whatsapp?.status || output?.deliveryStatus || null,
    ]
  );
  return rows[0];
}

async function updateExecutionStatus(client, executionId, status, errorMessage) {
  await client.query(
    `UPDATE coexistence.automation_executions
     SET status = $1, completed_at = $2, error_message = $3
     WHERE id = $4`,
    [status, new Date().toISOString(), errorMessage || null, executionId]
  );
}

// ─── Node Handlers ───────────────────────────────────────────────────

async function executeTriggerNode(client, executionId, node, context) {
  const td = context.trigger_data || {};
  const isStatusTrigger = context.message_type === 'status' || td.status === 'read' || td.status === 'delivered' || td.status === 'sent';

  const output = {
    triggerKind: node.triggerKind,
    keyword: node.keyword,
    matchType: node.matchType,
    whatsapp: {
      direction: isStatusTrigger ? 'status_update' : 'incoming',
      message_id: td.message_id,
      from: context.contact_number,
      to: td.wa_number,
      message_type: context.message_type,
      message_body: context.message_body,
      timestamp: td.timestamp,
      wa_number: td.wa_number,
      phone_number_id: td.phone_number_id,
      contact_name: context.contact?.name,
      media_url: td.media_url,
      media_mime_type: td.media_mime_type,
      status: td.status || 'received',
      // Full raw webhook data for complete API visibility
      raw: {
        message_id: td.message_id,
        phone_number_id: td.phone_number_id,
        wa_number: td.wa_number,
        contact_number: context.contact_number,
        status: td.status,
        timestamp: td.timestamp,
        message_type: context.message_type,
        message_body: context.message_body,
        media_url: td.media_url,
        media_mime_type: td.media_mime_type,
        conversation: td.conversation || null,
        pricing: td.pricing || null,
        errors: td.errors || null,
      },
    },
    contact: context.contact || { contact_number: context.contact_number },
  };

  return logStep(client, executionId, node, { triggerKind: node.triggerKind }, output, 'success', null, td.message_id, td.status || 'received');
}

async function executeMessageNode(client, executionId, node, context) {
  const mode = node.messageMode || 'template';
  let output = {};

  if (mode === 'template') {
    const { rows: tplRows } = await client.query(
      'SELECT id, name, body, category, language, buttons, header_type, header_text, footer, template_type, carousel_cards, whatsapp_account_id FROM coexistence.message_templates WHERE id = $1',
      [node.templateId]
    ).catch(() => ({ rows: [] }));
    const template = tplRows[0] || null;
    const resolvedBody = template ? resolveTemplateVariables(template.body, node.bindings, context) : null;

    // Real Meta send via the shared outbound queue. We resolve the account
    // by the wa_number that received the trigger (the BDA's WhatsApp number).
    const { resolveAccount, insertPendingRow } = require('../services/messageSender');
    const { enqueueSend } = require('../queue/sendQueue');
    const fromPhone = context.trigger_data?.wa_number;
    const { account, error: accErr } = await resolveAccount({
      accountId: node.whatsappAccountId,
      fromPhoneNumber: fromPhone,
    });
    if (accErr || !account) {
      throw new Error(`automation message: ${accErr || 'no account for ' + (node.whatsappAccountId || fromPhone)}`);
    }
    // WABA guard: a WhatsApp template only exists on the account (WABA) it was
    // approved under. Sending it from a different number makes Meta reject it
    // with #132001. Catch the mismatch here with a clear message instead of a
    // silent downstream send failure (and a false account-health "Error").
    if (template && template.whatsapp_account_id != null && String(template.whatsapp_account_id) !== String(account.id)) {
      const acctPhone = account.displayPhoneNumber || fromPhone || `account ${account.id}`;
      const msg = `Template "${template.name}" is approved on a different WhatsApp number and can't be sent from ${acctPhone}. Choose a template approved on this number, or change the message node's "Send from" account.`;
      await logStep(client, executionId, node, { templateId: node.templateId, sendingAccountId: account.id, templateAccountId: template.whatsapp_account_id }, { error: msg, code: 132001 }, 'error', msg);
      throw new Error(msg);
    }
    const localId = await insertPendingRow({
      account, toNumber: context.contact_number, messageType: 'template',
      messageBody: resolvedBody || template?.body || `Template: ${template?.name}`,
      templateMeta: template ? {
        header_type: template.header_type || 'NONE',
        header_text: template.header_text || null,
        footer: template.footer || null,
        buttons: Array.isArray(template.buttons) ? template.buttons : (template.buttons || []),
      } : null,
    });
    // Build body parameters from node.bindings, RESOLVING variables so a binding
    // like {"1":"{{name}}"} sends the contact's actual name (not the literal
    // token). Meta rejects empty params, so fall back to a single space.
    const bindings = node.bindings || {};
    const keys = Object.keys(bindings).sort((a, b) => +a - +b);
    const components = keys.length > 0
      ? [{ type: 'body', parameters: keys.map(k => ({ type: 'text', text: resolveVariables(String(bindings[k] || ''), context) || ' ' })) }]
      : [];
    // Dynamic URL button → a {{n}} in the button URL needs a button component or
    // Meta rejects the send (#131008). If it points at a lead form, mint a
    // per-recipient token so the recipient is auto-identified (silent phone
    // capture) — same as broadcasts. Otherwise fall back to the sample's tail.
    {
      const { mintTokenForButtonUrl } = require('../routes/leadForms');
      const btns = Array.isArray(template?.buttons) ? template.buttons : [];
      for (let bi = 0; bi < btns.length; bi++) {
        const b = btns[bi];
        if (b.type === 'URL' && /\{\{\s*\d+\s*\}\}/.test(b.value || '')) {
          let text = await mintTokenForButtonUrl(b.value, context.contact_number, { waAccountId: account.id });
          if (!text) { const s = String(b.urlSample || '').trim(); text = s.split('/').filter(Boolean).pop() || 'x'; }
          components.push({ type: 'button', sub_type: 'url', index: bi, parameters: [{ type: 'text', text }] });
        }
      }
    }
    // CAROUSEL templates: append the carousel send component (each card's header
    // media resolved to this account's media id + per-card quick-reply payloads).
    if (template && String(template.template_type || '').toUpperCase() === 'CAROUSEL') {
      const { buildCarouselComponent } = require('../routes/mediaLibrary');
      const carousel = await buildCarouselComponent(template, account.id);
      if (carousel) components.push(carousel);
    }
    // Consume any pending delay set by an upstream Delay node (BullMQ holds the job).
    const tplDelayMs = context.__pendingSendDelayMs || 0;
    await enqueueSend({
      kind: 'template',
      accountId: account.id,
      to: String(context.contact_number).replace(/\D/g, ''),
      localMessageId: localId,
      payload: { name: template?.name, languageCode: template?.language || 'en', components },
    }, { delayMs: tplDelayMs });
    context.__pendingSendDelayMs = 0;

    output = {
      mode: 'template',
      templateId: node.templateId,
      templateName: template?.name,
      templateCategory: template?.category,
      templateLanguage: template?.language,
      bindings,
      resolvedBody,
      to: context.contact_number,
      contactName: context.contact?.name,
      deliveryStatus: 'queued',
      note: 'Enqueued to sendQueue',
      whatsapp: {
        message_id: localId,
        from: fromPhone,
        to: context.contact_number,
        message_type: 'template',
        status: 'sending',
        timestamp: new Date().toISOString(),
      },
    };
  } else {
    const dd = node.directData || {};
    const resolvedBody = resolveVariables(dd.body, context);
    const directType = node.directType || 'text';

    // Dynamic API: not a WhatsApp message — perform a raw HTTP call to a
    // third-party endpoint and log the response on the execution step.
    // No chat_history row is created and the send queue is not involved.
    if (directType === 'dynamic_api') {
      const endpoint = resolveVariables(dd.endpoint, context);
      if (!endpoint || !/^https?:\/\//i.test(endpoint)) {
        throw new Error('automation dynamic_api: endpoint URL must start with http:// or https://');
      }
      const method = String(dd.method || 'POST').toUpperCase();
      const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
      if (!allowedMethods.has(method)) {
        throw new Error(`automation dynamic_api: unsupported method ${method}`);
      }

      let parsedHeaders = {};
      if (dd.headers && String(dd.headers).trim()) {
        try {
          parsedHeaders = JSON.parse(resolveVariables(dd.headers, context));
          if (!parsedHeaders || typeof parsedHeaders !== 'object' || Array.isArray(parsedHeaders)) {
            throw new Error('headers JSON must be an object');
          }
        } catch (err) {
          throw new Error(`automation dynamic_api: invalid headers JSON — ${err.message}`);
        }
      }

      const resolvedBodyTemplate = resolveVariables(dd.body, context);
      let requestBody;
      if (method !== 'GET' && resolvedBodyTemplate) {
        const looksJson = parsedHeaders['Content-Type']?.toLowerCase().includes('json')
          || parsedHeaders['content-type']?.toLowerCase().includes('json')
          || resolvedBodyTemplate.trim().startsWith('{')
          || resolvedBodyTemplate.trim().startsWith('[');
        if (looksJson) {
          // Validate JSON shape so the user finds out at design time, not from
          // a remote 400. Re-stringify to normalize whitespace.
          try {
            requestBody = JSON.stringify(JSON.parse(resolvedBodyTemplate));
          } catch (err) {
            throw new Error(`automation dynamic_api: body template is not valid JSON — ${err.message}`);
          }
          if (!parsedHeaders['Content-Type'] && !parsedHeaders['content-type']) {
            parsedHeaders['Content-Type'] = 'application/json';
          }
        } else {
          requestBody = resolvedBodyTemplate;
        }
      }

      const startedAt = Date.now();
      const controller = new AbortController();
      const timeoutMs = 15000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let httpStatus = null;
      let respText = '';
      let respJson = null;
      let httpErr = null;
      try {
        const res = await fetch(endpoint, {
          method,
          headers: parsedHeaders,
          body: requestBody,
          signal: controller.signal,
        });
        httpStatus = res.status;
        respText = await res.text();
        if (respText.length > 4096) respText = respText.slice(0, 4096) + '…(truncated)';
        try { respJson = JSON.parse(respText); } catch { /* not JSON, leave null */ }
      } catch (err) {
        httpErr = err.name === 'AbortError'
          ? `request timed out after ${timeoutMs}ms`
          : (err.message || String(err));
      } finally {
        clearTimeout(timer);
      }
      const elapsedMs = Date.now() - startedAt;

      const apiOutput = {
        mode: 'direct',
        directType: 'dynamic_api',
        request: { method, url: endpoint, headers: parsedHeaders, body: requestBody || null },
        response: { status: httpStatus, body: respJson || respText || null },
        elapsedMs,
        error: httpErr,
        note: httpErr ? 'HTTP request failed' : (httpStatus >= 200 && httpStatus < 300 ? 'HTTP request succeeded' : 'HTTP returned non-2xx'),
      };

      const ok = !httpErr && httpStatus >= 200 && httpStatus < 300;
      const onError = String(dd.onError || 'continue').toLowerCase();
      if (!ok && onError === 'fail') {
        return logStep(client, executionId, node, { directType: 'dynamic_api' }, apiOutput, 'error', httpErr || `HTTP ${httpStatus}`);
      }
      return logStep(client, executionId, node, { directType: 'dynamic_api' }, apiOutput, 'success');
    }

    // Direct (free-form) message — only allowed inside 24h window. We don't
    // enforce the window in the engine because triggers usually fire on
    // recent inbound messages (the customer just messaged, so the window is
    // open). If Meta rejects it, the sendQueue marks the row failed.
    const { resolveAccount, insertPendingRow } = require('../services/messageSender');
    const { enqueueSend } = require('../queue/sendQueue');
    const fromPhone = context.trigger_data?.wa_number;
    const { account, error: accErr } = await resolveAccount({
      accountId: node.whatsappAccountId,
      fromPhoneNumber: fromPhone,
    });
    if (accErr || !account) {
      throw new Error(`automation direct message: ${accErr || 'no account for ' + (node.whatsappAccountId || fromPhone)}`);
    }
    const STORED_TYPE_MAP = { quick_reply: 'interactive', list: 'interactive', product: 'interactive', catalog: 'interactive', contact: 'contacts' };
    const storedMessageType = STORED_TYPE_MAP[directType] || directType;
    const localId = await insertPendingRow({
      account, toNumber: context.contact_number, messageType: storedMessageType, messageBody: resolvedBody,
    });
    let kind = 'text';
    // Any text body containing a URL gets a WhatsApp link-preview card (same as
    // the dedicated 'link' type), so links typed into a plain text node preview too.
    let payload = { body: resolvedBody, previewUrl: /https?:\/\/\S+/i.test(resolvedBody || '') };
    if (directType === 'quick_reply') {
      const rawButtons = Array.isArray(dd.buttons) ? dd.buttons : [];
      const buttons = rawButtons
        .map((b, i) => {
          const title = String(b?.title || b?.text || '').trim();
          if (!title) return null;
          const id = String(b?.id || `btn_${i}`).slice(0, 256);
          return { type: 'reply', reply: { id, title: title.slice(0, 20) } };
        })
        .filter(Boolean)
        .slice(0, 3);
      if (buttons.length === 0) {
        throw new Error('automation quick_reply: at least one button title required');
      }
      kind = 'interactive';
      const headerText = resolveVariables(dd.header, context);
      const interactive = {
        type: 'button',
        body: { text: resolvedBody || '' },
        action: { buttons },
      };
      if (headerText && headerText.trim()) {
        interactive.header = { type: 'text', text: String(headerText).slice(0, 60) };
      }
      payload = { interactive };
    } else if (directType === 'list') {
      // Meta interactive list limits:
      //   max 10 rows TOTAL across the entire message (not per section)
      //   max 10 sections
      //   row.id required, unique across message, ≤200 chars
      //   row.title required, ≤24 chars
      //   row.description optional, ≤72 chars
      //   section.title ≤24 chars (required when ≥2 sections)
      //   action.button required, ≤20 chars
      const rawSections = Array.isArray(dd.sections) ? dd.sections : [];
      const seenIds = new Set();
      let rowBudget = 10;
      const sections = [];
      for (let si = 0; si < rawSections.length && rowBudget > 0 && sections.length < 10; si++) {
        const s = rawSections[si] || {};
        const rawRows = Array.isArray(s.rows) ? s.rows : [];
        const rows = [];
        for (let ri = 0; ri < rawRows.length && rowBudget > 0; ri++) {
          const r = rawRows[ri] || {};
          const title = String(r.title || '').trim();
          if (!title) continue;
          let id = String(r.id || '').trim() || `s${si}_r${ri}`;
          id = id.slice(0, 200);
          // Dedupe ID across the whole message (Meta requires uniqueness)
          let unique = id;
          let n = 1;
          while (seenIds.has(unique)) unique = `${id.slice(0, 196)}_${n++}`;
          seenIds.add(unique);
          const row = { id: unique, title: title.slice(0, 24) };
          const desc = r.description ? String(r.description).trim() : '';
          if (desc) row.description = desc.slice(0, 72);
          rows.push(row);
          rowBudget--;
        }
        if (rows.length === 0) continue;
        sections.push({
          title: String(s.title || '').slice(0, 24),
          rows,
        });
      }
      if (sections.length === 0) {
        throw new Error('automation list: at least one section with a non-empty row title is required');
      }
      if (!resolvedBody || !resolvedBody.trim()) {
        throw new Error('automation list: body text is required by Meta');
      }
      // Meta requires section.title when there are 2+ sections
      if (sections.length > 1) {
        sections.forEach((sec, idx) => {
          if (!sec.title) sec.title = `Section ${idx + 1}`;
        });
      } else {
        // Single-section: title is optional, drop empty to avoid "title must not be empty"
        if (!sections[0].title) delete sections[0].title;
      }
      const buttonLabel = String(dd.button_text || dd.buttonLabel || 'Select').trim().slice(0, 20) || 'Select';
      kind = 'interactive';
      const headerText = resolveVariables(dd.header, context);
      const interactive = {
        type: 'list',
        body: { text: resolvedBody || '' },
        action: {
          button: buttonLabel,
          sections,
        },
      };
      if (headerText && headerText.trim()) {
        interactive.header = { type: 'text', text: String(headerText).slice(0, 60) };
      }
      payload = { interactive };
    } else if (directType === 'location') {
      const lat = String(dd.latitude ?? '').trim();
      const lon = String(dd.longitude ?? '').trim();
      if (!lat || !lon || Number.isNaN(Number(lat)) || Number.isNaN(Number(lon))) {
        throw new Error('automation location: latitude and longitude are required and must be numeric');
      }
      kind = 'location';
      payload = {
        latitude: Number(lat),
        longitude: Number(lon),
        name: resolveVariables(dd.name, context) || undefined,
        address: resolveVariables(dd.address, context) || undefined,
      };
    } else if (directType === 'contact' || directType === 'contacts') {
      const fullName = String(resolveVariables(dd.name, context) || '').trim();
      const first = String(resolveVariables(dd.first_name, context) || '').trim();
      const last = String(resolveVariables(dd.last_name, context) || '').trim();
      const formatted = fullName || [first, last].filter(Boolean).join(' ').trim();
      if (!formatted) {
        throw new Error('automation contact: name is required (formatted_name)');
      }
      const phoneRaw = String(resolveVariables(dd.phone, context) || '').trim();
      // wa_id must be digits only (country code + number, no '+', no spaces).
      // If '+' or any separator is included, Meta cannot resolve the contact
      // and the recipient sees "Invite to WhatsApp" instead of "Message".
      const waId = phoneRaw.replace(/\D/g, '');
      // Keep a clean E.164-style display value for the `phone` field.
      const phoneDisplay = phoneRaw.startsWith('+') ? `+${waId}` : (waId ? `+${waId}` : phoneRaw);
      const contactCard = {
        name: {
          formatted_name: formatted,
          ...(first ? { first_name: first } : (fullName ? { first_name: fullName.split(/\s+/)[0] } : {})),
          ...(last ? { last_name: last } : (fullName && fullName.split(/\s+/).length > 1 ? { last_name: fullName.split(/\s+/).slice(1).join(' ') } : {})),
        },
      };
      if (waId) {
        const phoneType = String(dd.phone_type || 'CELL').toUpperCase();
        const allowed = new Set(['CELL', 'HOME', 'WORK', 'MAIN', 'IPHONE']);
        contactCard.phones = [{
          phone: phoneDisplay,
          type: allowed.has(phoneType) ? phoneType : 'CELL',
          wa_id: waId,
        }];
      }
      const email = String(resolveVariables(dd.email, context) || '').trim();
      if (email) contactCard.emails = [{ email, type: 'WORK' }];
      const org = String(resolveVariables(dd.org, context) || '').trim();
      if (org) contactCard.org = { company: org };
      kind = 'contacts';
      payload = { contacts: [contactCard] };
    } else if (directType === 'product') {
      const catalogId = String(resolveVariables(dd.catalog_id, context) || '').trim();
      const productId = String(resolveVariables(dd.product_retailer_id, context) || '').trim();
      if (!catalogId || !productId) {
        throw new Error('automation product: catalog_id and product_retailer_id are required');
      }
      kind = 'interactive';
      const interactive = {
        type: 'product',
        body: resolvedBody ? { text: resolvedBody.slice(0, 1024) } : undefined,
        action: { catalog_id: catalogId, product_retailer_id: productId },
      };
      // Meta tolerates missing body for single-product but it's recommended; drop if empty
      if (!interactive.body) delete interactive.body;
      payload = { interactive };
    } else if (directType === 'catalog') {
      const catalogId = String(resolveVariables(dd.catalog_id, context) || '').trim();
      if (!resolvedBody || !resolvedBody.trim()) {
        throw new Error('automation catalog: body text is required by Meta');
      }
      kind = 'interactive';
      const interactive = {
        type: 'catalog_message',
        body: { text: resolvedBody.slice(0, 1024) },
        action: { name: 'catalog_message' },
      };
      if (catalogId) {
        interactive.action.parameters = { thumbnail_product_retailer_id: catalogId };
      }
      payload = { interactive };
    } else if (directType === 'link') {
      // Link message = text with preview_url enabled. We append the URL to
      // the body if the body doesn't already contain it, so WhatsApp can
      // generate the preview card client-side.
      const linkUrl = resolveVariables(dd.url, context) || '';
      if (!linkUrl) throw new Error('automation link: url is required');
      const bodyWithUrl = resolvedBody && resolvedBody.includes(linkUrl)
        ? resolvedBody
        : (resolvedBody ? `${resolvedBody}\n\n${linkUrl}` : linkUrl);
      kind = 'text';
      payload = { body: bodyWithUrl, previewUrl: true };
    } else if (['image', 'video', 'audio', 'document', 'sticker'].includes(directType)) {
      kind = 'media';
      if (dd.mediaLibraryId) {
        const { syncMediaToAccount } = require('../routes/mediaLibrary');
        const { rows: mRows } = await client.query(
          `SELECT * FROM coexistence.media_library WHERE id = $1 AND deleted_at IS NULL`,
          [dd.mediaLibraryId]
        );
        if (mRows.length) {
          const media = mRows[0];
          const { rows: sRows } = await client.query(
            `SELECT * FROM coexistence.media_meta_sync WHERE media_id = $1 AND account_id = $2`,
            [media.id, account.id]
          );
          let sync = sRows[0];
          const needsSync = !sync || sync.status !== 'synced' || !sync.meta_media_id || (sync.expires_at && new Date(sync.expires_at) <= new Date());
          if (needsSync) {
            sync = await syncMediaToAccount(media.id, account.id);
            sync = {
              meta_media_id: sync.metaMediaId,
              expires_at: sync.expiresAt,
              status: sync.status,
            };
          }
          payload = {
            type: directType,
            mediaId: sync.meta_media_id,
            caption: resolveVariables(dd.caption, context),
            filename: resolveVariables(dd.filename, context),
          };
          // Mirror the library file to local disk so the chat bubble can
          // play/preview it via /api/media/:messageId — otherwise outbound
          // media sticks on "Downloading…" (media_status never becomes 'stored').
          // Best-effort: a failure here must not block the Meta send.
          try {
            const { getObjectBuffer } = require('../util/minioClient');
            const { persistOutboundBuffer } = require('../services/mediaDownloader');
            const buf = await getObjectBuffer(media.minio_object_key);
            const ext = (media.original_name || '').split('.').pop()?.toLowerCase() || (media.mime_type || '').split('/')[1] || 'bin';
            const acctDigits = String(context.trigger_data?.wa_number || '').replace(/\D/g, '');
            const { absPath, size } = persistOutboundBuffer({ accountPhoneDigits: acctDigits, messageId: localId, buffer: buf, ext });
            await client.query(
              `UPDATE coexistence.chat_history
                  SET media_storage_path = $1, media_status = 'stored', media_size_bytes = $2,
                      media_mime_type = COALESCE(media_mime_type, $3), media_filename = $4, media_downloaded_at = NOW()
                WHERE message_id = $5`,
              [absPath, size, media.mime_type, media.original_name, localId]
            );
          } catch (mErr) {
            console.error('[engine] mirror library media to chat failed:', mErr.message);
          }
        } else {
          payload = {
            type: directType,
            link: resolveVariables(dd.url, context),
            caption: resolveVariables(dd.caption, context),
            filename: resolveVariables(dd.filename, context),
          };
        }
      } else {
        payload = {
          type: directType,
          link: resolveVariables(dd.url, context),
          caption: resolveVariables(dd.caption, context),
          filename: resolveVariables(dd.filename, context),
        };
      }
    }
    // Consume any pending delay set by an upstream Delay node (BullMQ holds the job).
    const directDelayMs = context.__pendingSendDelayMs || 0;
    await enqueueSend({
      kind, accountId: account.id,
      to: String(context.contact_number).replace(/\D/g, ''),
      localMessageId: localId, payload,
    }, { delayMs: directDelayMs });
    context.__pendingSendDelayMs = 0;

    output = {
      mode: 'direct',
      directType,
      resolvedBody,
      resolvedUrl: resolveVariables(dd.url, context),
      resolvedCaption: resolveVariables(dd.caption, context),
      resolvedFilename: resolveVariables(dd.filename, context),
      mediaLibraryId: dd.mediaLibraryId || null,
      to: context.contact_number,
      contactName: context.contact?.name,
      deliveryStatus: 'queued',
      note: 'Enqueued to sendQueue',
      whatsapp: {
        message_id: localId,
        from: fromPhone,
        to: context.contact_number,
        message_type: directType,
        status: 'sending',
        timestamp: new Date().toISOString(),
      },
    };
  }

  const waMsgId = output.apiResponse?.message_id || null;
  const waStatus = output.apiResponse?.status || output.deliveryStatus || null;
  const step = await logStep(client, executionId, node, { mode, to: context.contact_number }, output, 'success', null, waMsgId, waStatus);

  // If this message is configured to wait for the customer's reply before
  // continuing, flip the execution to 'paused' and signal the walker to exit.
  // The resume path (in webhook.js → resumeAutomation) will pick up from the
  // children of this node when the customer's next inbound message arrives.
  if (node.waitForReply === true) {
    const hours = Math.max(1, parseInt(node.waitTimeoutHours || 24, 10));
    await client.query(
      `UPDATE coexistence.automation_executions
          SET status='paused',
              awaiting_node_id=$1,
              paused_at=NOW(),
              expires_at=NOW() + ($2 || ' hours')::INTERVAL,
              wa_number=$3
        WHERE id=$4`,
      [node.id, String(hours), context.trigger_data?.wa_number || null, executionId]
    );
    step.__pauseExecution = true;
  }
  return step;
}

async function executeConditionNode(client, executionId, node, context) {
  const matched = evaluateConditions(node, context);
  const output = { matched, matchMode: node.matchMode || 'all', rulesEvaluated: (node.rules || []).length };
  return logStep(client, executionId, node, { rules: node.rules || [] }, output, 'success');
}

const DELAY_UNIT_MS = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 };
const DELAY_MAX_MS = 7 * 86400000; // 7-day cap on a single delay

// Milliseconds from now until an IST datetime. Accepts 'YYYY-MM-DDTHH:MM'
// (datetime-local) or 'YYYY-MM-DD', interpreting bare values as IST.
function msUntilIST(dateLike) {
  if (!dateLike) return 0;
  let s = String(dateLike).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) s += ':00+05:30';
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00+05:30';
  const t = Date.parse(s);
  return isFinite(t) ? t - Date.now() : 0;
}
// Milliseconds until the next occurrence of an IST time-of-day "HH:MM".
function msUntilTimeOfDayIST(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return 0;
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  let target = Date.parse(`${dateStr}T${m[1].padStart(2, '0')}:${m[2]}:00+05:30`);
  if (!isFinite(target)) return 0;
  if (target - Date.now() <= 0) target += 86400000; // already passed today → tomorrow
  return Math.max(0, target - Date.now());
}

async function executeDelayNode(client, executionId, node, context) {
  const delayMode = node.delayMode || 'duration';
  let appliedMs = 0;
  // All modes resolve to a non-blocking delay: we stash the ms on the context
  // and the NEXT message node enqueues its send with this BullMQ delay. Capped
  // at 7 days (Meta's re-engagement window makes longer waits template-only).
  if (delayMode === 'duration') {
    const val = Math.max(0, parseInt(node.waitValue, 10) || 0);
    const unitMs = DELAY_UNIT_MS[node.waitUnit] || DELAY_UNIT_MS.minutes;
    appliedMs = Math.min(val * unitMs, DELAY_MAX_MS);
  } else if (delayMode === 'date') {
    appliedMs = Math.min(Math.max(0, msUntilIST(node.untilDateTime)), DELAY_MAX_MS);
  } else if (delayMode === 'until') {
    appliedMs = Math.min(msUntilTimeOfDayIST(node.untilTime), DELAY_MAX_MS);
  } else if (delayMode === 'field') {
    const v = getFieldValue('custom', node.dateField, context);
    appliedMs = Math.min(Math.max(0, msUntilIST(v)), DELAY_MAX_MS);
  }
  if (appliedMs > 0) context.__pendingSendDelayMs = (context.__pendingSendDelayMs || 0) + appliedMs;

  const output = {
    delayMode,
    waitValue: node.waitValue,
    waitUnit: node.waitUnit,
    untilDateTime: node.untilDateTime,
    untilTime: node.untilTime,
    dateField: node.dateField,
    appliedMs,
    note: appliedMs > 0
      ? `Next message delayed ${Math.round(appliedMs / 1000)}s via the send queue.`
      : 'Resolved to no delay (time already passed, or nothing set).',
  };
  return logStep(client, executionId, node, { delayMode }, output, 'success');
}

// Action kinds that don't have a real side-effect handler in this build.
// We keep them as honest, accurately-labelled log entries rather than faking a
// success — so the execution log tells the operator exactly what did NOT happen.
const ACTION_STUB_NOTES = {
  'Assign to Agent':     'Not applied — superseded by "Assign to BDA"; there is no team-member assignment column. Use Assign to BDA.',
  'Subscribe Contact':   'Not applied — subscription state is not stored in this build.',
  'Unsubscribe Contact': 'Not applied — subscription state is not stored in this build.',
  'Start Sequence':      'Not applied — follow-up sequences feature is not built yet.',
  'Pause Sequence':      'Not applied — follow-up sequences feature is not built yet.',
  'End Sequence':        'Not applied — follow-up sequences feature is not built yet.',
};

async function executeActionNode(client, executionId, node, context) {
  const actions = node.actions || [];
  const waNumber     = context.trigger_data?.wa_number;
  const contactNumber = context.contact_number;
  const results = [];
  let stepStatus = 'success';
  let contactMutated = false; // emit one contact-saved SSE at the end if true

  for (const a of actions) {
    const base = { kind: a.kind, value: a.value };
    try {
      if (a.kind === 'Assign to BDA') {
        // a.value may be a literal user id, or a template like "{{assigned_bda_id}}"
        // when the action is configured in "By variable" mode. Resolve first.
        const rawValue = resolveVariables(String(a.value || ''), context).trim();
        const userId = parseInt(rawValue, 10);
        if (!userId) {
          results.push({ ...base, status: 'error', error: 'no user selected' });
          stepStatus = 'error';
          continue;
        }
        if (!waNumber || !contactNumber) {
          results.push({ ...base, status: 'error', error: 'context missing wa_number or contact_number' });
          stepStatus = 'error';
          continue;
        }
        // Verify the user exists, is active, and is a bda_sales / admin
        const { rows: uRows } = await client.query(
          `SELECT id, display_name, role, is_active FROM coexistence.forgecrm_users WHERE id = $1`,
          [userId]
        );
        if (uRows.length === 0) {
          results.push({ ...base, status: 'error', error: `user ${userId} not found` });
          stepStatus = 'error';
          continue;
        }
        const u = uRows[0];
        if (u.is_active === false) {
          results.push({ ...base, status: 'error', error: `user ${u.display_name} is disabled` });
          stepStatus = 'error';
          continue;
        }

        // UPSERT — creates the contact row if it doesn't exist yet (new chats
        // won't have a row until someone saves). Preserves existing name/tags
        // if the row was already there.
        const { rows: cRows } = await client.query(
          `INSERT INTO coexistence.contacts (wa_number, contact_number, assigned_user_id, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (wa_number, contact_number) DO UPDATE
             SET assigned_user_id = EXCLUDED.assigned_user_id, updated_at = NOW()
           RETURNING wa_number, contact_number, assigned_user_id`,
          [waNumber, contactNumber, userId]
        );
        results.push({
          ...base,
          status: 'applied',
          assignedTo: { id: u.id, displayName: u.display_name, role: u.role },
          contact: cRows[0],
        });
        // Push to any SSE subscribers (typically the assigned BDA's open
        // tab) so their Chats/Contacts views refresh instantly.
        bus.emit('contact-assignment-changed', {
          waNumber, contactNumber, assignedUserId: u.id, assignedUserName: u.display_name,
        });

      } else if (a.kind === 'Add Tag') {
        // a.value holds the tag NAME (from the builder dropdown). Resolve it to
        // the canonical {id,name,color,category_id} object so the contact's
        // tags JSONB matches the shape the rest of the app expects.
        const tagName = String(a.value || '').trim();
        if (!tagName) { results.push({ ...base, status: 'error', error: 'no tag selected' }); stepStatus = 'error'; continue; }
        if (!waNumber || !contactNumber) { results.push({ ...base, status: 'error', error: 'context missing wa_number or contact_number' }); stepStatus = 'error'; continue; }
        const { rows: tagRows } = await client.query(
          `SELECT id, name, color, category_id FROM coexistence.tags WHERE LOWER(name) = LOWER($1) LIMIT 1`,
          [tagName]
        );
        if (tagRows.length === 0) { results.push({ ...base, status: 'error', error: `tag "${tagName}" not found` }); stepStatus = 'error'; continue; }
        const tag = tagRows[0];
        const { rows: cur } = await client.query(
          `SELECT tags FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`,
          [waNumber, contactNumber]
        );
        const existing = (cur[0] && cur[0].tags) || [];
        const already = existing.some(t => t && (t.id === tag.id || String(t.name || '').toLowerCase() === tag.name.toLowerCase()));
        const newTags = already ? existing : [...existing, { id: tag.id, name: tag.name, color: tag.color, category_id: tag.category_id }];
        // INSERT…ON CONFLICT — creates the row for brand-new chats with no
        // saved contact yet; only the tags column is touched so name/fields
        // on an existing row are preserved.
        await client.query(
          `INSERT INTO coexistence.contacts (wa_number, contact_number, tags, updated_at)
           VALUES ($1, $2, $3::jsonb, NOW())
           ON CONFLICT (wa_number, contact_number) DO UPDATE
             SET tags = EXCLUDED.tags, updated_at = NOW()`,
          [waNumber, contactNumber, JSON.stringify(newTags)]
        );
        context.contact = context.contact || {};
        context.contact.tags = newTags;
        if (!already) {
          contactMutated = true;
          // Fire any "Tag Applied (added)" automations watching this tag —
          // detached so it doesn't nest inside the current run's transaction.
          setImmediate(() => fireTagAppliedTriggers({ waNumber, contactNumber, tagName: tag.name, direction: 'added' }).catch(() => {}));
        }
        results.push({ ...base, status: already ? 'skipped' : 'applied', tag: { id: tag.id, name: tag.name }, note: already ? 'Contact already had this tag' : 'Tag added' });

      } else if (a.kind === 'Remove Tag') {
        const tagName = String(a.value || '').trim();
        if (!tagName) { results.push({ ...base, status: 'error', error: 'no tag selected' }); stepStatus = 'error'; continue; }
        if (!waNumber || !contactNumber) { results.push({ ...base, status: 'error', error: 'context missing wa_number or contact_number' }); stepStatus = 'error'; continue; }
        const { rows: cur } = await client.query(
          `SELECT tags FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`,
          [waNumber, contactNumber]
        );
        if (cur.length === 0) { results.push({ ...base, status: 'skipped', note: 'No contact row — nothing to remove' }); continue; }
        const existing = cur[0].tags || [];
        // Match by id where resolvable, and always by name (case-insensitive) so
        // legacy tag entries with a different/missing id still get removed.
        const { rows: tagRows } = await client.query(
          `SELECT id FROM coexistence.tags WHERE LOWER(name) = LOWER($1) LIMIT 1`, [tagName]
        );
        const tagId = tagRows[0] && tagRows[0].id;
        const newTags = existing.filter(t => !(t && (String(t.name || '').toLowerCase() === tagName.toLowerCase() || (tagId && t.id === tagId))));
        const removed = newTags.length !== existing.length;
        await client.query(
          `UPDATE coexistence.contacts SET tags = $3::jsonb, updated_at = NOW() WHERE wa_number = $1 AND contact_number = $2`,
          [waNumber, contactNumber, JSON.stringify(newTags)]
        );
        context.contact = context.contact || {};
        context.contact.tags = newTags;
        if (removed) {
          contactMutated = true;
          setImmediate(() => fireTagAppliedTriggers({ waNumber, contactNumber, tagName, direction: 'removed' }).catch(() => {}));
        }
        results.push({ ...base, status: removed ? 'applied' : 'skipped', note: removed ? 'Tag removed' : 'Contact did not have this tag' });

      } else if (a.kind === 'Set Custom Field') {
        // a.value is "Field Name = value". The contacts.custom_fields JSONB is
        // keyed by the field DEFINITION id (e.g. cf-city), not the name — so we
        // resolve name → id. The value is variable-resolved ({{name}} etc.).
        const raw = String(a.value || '');
        const ix = raw.indexOf('=');
        const fieldName = (ix >= 0 ? raw.slice(0, ix) : raw).trim();
        const rawVal    = ix >= 0 ? raw.slice(ix + 1).trim() : '';
        if (!fieldName) { results.push({ ...base, status: 'error', error: 'no field selected' }); stepStatus = 'error'; continue; }
        if (!waNumber || !contactNumber) { results.push({ ...base, status: 'error', error: 'context missing wa_number or contact_number' }); stepStatus = 'error'; continue; }
        const { rows: fRows } = await client.query(
          `SELECT id, name FROM coexistence.contact_field_definitions WHERE LOWER(name) = LOWER($1) LIMIT 1`,
          [fieldName]
        );
        if (fRows.length === 0) { results.push({ ...base, status: 'error', error: `custom field "${fieldName}" not found` }); stepStatus = 'error'; continue; }
        const fieldId = fRows[0].id;
        const value = resolveVariables(rawVal, context);
        const { rows: cur } = await client.query(
          `SELECT custom_fields FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`,
          [waNumber, contactNumber]
        );
        const cf = { ...((cur[0] && cur[0].custom_fields) || {}) };
        cf[fieldId] = value;
        await client.query(
          `INSERT INTO coexistence.contacts (wa_number, contact_number, custom_fields, updated_at)
           VALUES ($1, $2, $3::jsonb, NOW())
           ON CONFLICT (wa_number, contact_number) DO UPDATE
             SET custom_fields = EXCLUDED.custom_fields, updated_at = NOW()`,
          [waNumber, contactNumber, JSON.stringify(cf)]
        );
        context.contact = context.contact || {};
        context.contact.custom_fields = cf;
        contactMutated = true;
        results.push({ ...base, status: 'applied', field: { id: fieldId, name: fRows[0].name }, value, note: 'Custom field set' });

      } else if (a.kind === 'Clear Custom Field') {
        const fieldName = String(a.value || '').trim();
        if (!fieldName) { results.push({ ...base, status: 'error', error: 'no field selected' }); stepStatus = 'error'; continue; }
        if (!waNumber || !contactNumber) { results.push({ ...base, status: 'error', error: 'context missing wa_number or contact_number' }); stepStatus = 'error'; continue; }
        const { rows: fRows } = await client.query(
          `SELECT id, name FROM coexistence.contact_field_definitions WHERE LOWER(name) = LOWER($1) LIMIT 1`,
          [fieldName]
        );
        if (fRows.length === 0) { results.push({ ...base, status: 'error', error: `custom field "${fieldName}" not found` }); stepStatus = 'error'; continue; }
        const fieldId = fRows[0].id;
        const { rows: cur } = await client.query(
          `SELECT custom_fields FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`,
          [waNumber, contactNumber]
        );
        if (cur.length === 0) { results.push({ ...base, status: 'skipped', note: 'No contact row — nothing to clear' }); continue; }
        const cf = { ...(cur[0].custom_fields || {}) };
        const had = Object.prototype.hasOwnProperty.call(cf, fieldId);
        delete cf[fieldId];
        await client.query(
          `UPDATE coexistence.contacts SET custom_fields = $3::jsonb, updated_at = NOW() WHERE wa_number = $1 AND contact_number = $2`,
          [waNumber, contactNumber, JSON.stringify(cf)]
        );
        context.contact = context.contact || {};
        context.contact.custom_fields = cf;
        if (had) contactMutated = true;
        results.push({ ...base, status: had ? 'applied' : 'skipped', field: { id: fieldId, name: fRows[0].name }, note: had ? 'Custom field cleared' : 'Field was already empty' });

      } else if (a.kind === 'Send Email') {
        // a.value is "to@example.com | Subject | Body" (pipe-separated; Body
        // may itself contain pipes — only the first two are split). All three
        // segments are variable-resolved so {{name}} etc. work end-to-end.
        const raw = resolveVariables(String(a.value || ''), context);
        const firstPipe = raw.indexOf('|');
        const secondPipe = firstPipe >= 0 ? raw.indexOf('|', firstPipe + 1) : -1;
        const to = (firstPipe >= 0 ? raw.slice(0, firstPipe) : raw).trim();
        const subject = (firstPipe >= 0 && secondPipe >= 0)
          ? raw.slice(firstPipe + 1, secondPipe).trim() : '';
        const body = secondPipe >= 0 ? raw.slice(secondPipe + 1).trim() : '';
        if (!to) { results.push({ ...base, status: 'error', error: 'no recipient' }); stepStatus = 'error'; continue; }
        try {
          const sent = await gmailSend({ to, subject, text: body });
          results.push({ ...base, status: 'applied', via: 'gmail', to, subject, gmailMessageId: sent.id, threadId: sent.threadId });
        } catch (err) {
          results.push({ ...base, status: 'error', error: err.message, hint: 'Connect Gmail in Admin Settings → Integrations' });
          stepStatus = 'error';
        }

      } else if (a.kind === 'Append to Google Sheet') {
        // a.value is "spreadsheetId | range | val1, val2, val3"
        //   spreadsheetId = the long ID from the sheet URL
        //   range         = e.g. "Sheet1!A:Z" — Google appends below last row
        //   values        = comma-separated cells (each variable-resolved)
        const raw = resolveVariables(String(a.value || ''), context);
        const parts = raw.split('|').map(s => s.trim());
        const spreadsheetId = parts[0];
        const range = parts[1] || 'Sheet1!A:Z';
        const values = (parts[2] || '').split(',').map(s => s.trim());
        if (!spreadsheetId) { results.push({ ...base, status: 'error', error: 'spreadsheet ID is required' }); stepStatus = 'error'; continue; }
        if (values.length === 0 || values.every(v => !v)) {
          results.push({ ...base, status: 'error', error: 'no values to append' }); stepStatus = 'error'; continue;
        }
        try {
          const out = await sheetsAppendRow({ spreadsheetId, range, values });
          results.push({
            ...base, status: 'applied', via: 'google_sheets',
            spreadsheetId, range,
            updatedRange: out.updates?.updatedRange,
            updatedRows: out.updates?.updatedRows,
          });
        } catch (err) {
          results.push({ ...base, status: 'error', error: err.message, hint: 'Connect Google Sheets in Admin Settings → Integrations' });
          stepStatus = 'error';
        }

      } else if (a.kind === 'Create Calendar Event') {
        // a.value is "calendarId | title | startISO | endISO | description"
        //   calendarId  = "primary" or a specific calendar id
        //   startISO    = RFC 3339, e.g. 2026-05-30T14:00:00+05:30
        //   endISO      = RFC 3339; if omitted, defaults to startISO + 30min
        //   description = optional, may use {{vars}}
        const raw = resolveVariables(String(a.value || ''), context);
        const parts = raw.split('|').map(s => s.trim());
        const calendarId = parts[0] || 'primary';
        const summary    = parts[1] || 'Event';
        const startISO   = parts[2];
        let endISO       = parts[3];
        const description = parts[4] || '';
        if (!startISO) { results.push({ ...base, status: 'error', error: 'start time is required (ISO 8601)' }); stepStatus = 'error'; continue; }
        if (!endISO) {
          const startMs = Date.parse(startISO);
          if (!isFinite(startMs)) { results.push({ ...base, status: 'error', error: 'invalid start time' }); stepStatus = 'error'; continue; }
          endISO = new Date(startMs + 30 * 60 * 1000).toISOString();
        }
        try {
          const out = await calendarInsertEvent({ calendarId, summary, description, startISO, endISO });
          results.push({
            ...base, status: 'applied', via: 'google_calendar',
            calendarId, eventId: out.id, htmlLink: out.htmlLink,
            start: out.start, end: out.end,
          });
        } catch (err) {
          results.push({ ...base, status: 'error', error: err.message, hint: 'Connect Google Calendar in Admin Settings → Integrations' });
          stepStatus = 'error';
        }

      } else if (a.kind === 'Mark Closed') {
        // Closing the conversation = mark it read so it leaves the unread/attention
        // queue. Upserts conversation_reads to now (same as opening the chat does).
        if (!waNumber || !contactNumber) { results.push({ ...base, status: 'error', error: 'context missing wa_number or contact_number' }); stepStatus = 'error'; continue; }
        await client.query(
          `INSERT INTO coexistence.conversation_reads (wa_number, contact_number, last_read_at)
           VALUES ($1,$2,NOW())
           ON CONFLICT (wa_number, contact_number) DO UPDATE SET last_read_at = NOW()`,
          [waNumber, contactNumber]
        ).catch(async () => {
          // table shape fallback: some installs key reads differently — ignore if absent
        });
        bus.emit('conversation-read', { waNumber, contactNumber });
        results.push({ ...base, status: 'applied', note: 'Conversation marked closed (cleared from the unread queue)' });

      } else if (a.kind === 'Send Webhook') {
        // Outbound HTTP POST to an external URL with a JSON contact payload.
        const url = resolveVariables(String(a.value || ''), context).trim();
        if (!/^https?:\/\//i.test(url)) { results.push({ ...base, status: 'error', error: 'Webhook URL must start with http:// or https://' }); stepStatus = 'error'; continue; }
        const payload = {
          event: 'automation.webhook',
          contact: { wa_number: waNumber, contact_number: contactNumber, name: context.contact?.name || null, tags: context.contact?.tags || [], custom_fields: context.contact?.custom_fields || {} },
          message: context.message_body || null,
          sent_at: new Date().toISOString(),
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
          results.push({ ...base, status: res.ok ? 'applied' : 'error', httpStatus: res.status, ...(res.ok ? {} : { error: `webhook returned HTTP ${res.status}` }) });
          if (!res.ok) stepStatus = 'error';
        } catch (err) {
          results.push({ ...base, status: 'error', error: err.name === 'AbortError' ? 'webhook timed out (15s)' : err.message });
          stepStatus = 'error';
        } finally { clearTimeout(timer); }

      } else if (a.kind === 'Send Internal Email') {
        // a.value is "to@example.com | Subject | Body" — notify the team via Gmail.
        const raw = resolveVariables(String(a.value || ''), context);
        const fp = raw.indexOf('|'); const sp = fp >= 0 ? raw.indexOf('|', fp + 1) : -1;
        const to = (fp >= 0 ? raw.slice(0, fp) : raw).trim();
        const subject = (fp >= 0 && sp >= 0) ? raw.slice(fp + 1, sp).trim() : `WhatsApp update: ${context.contact?.name || contactNumber}`;
        const body = sp >= 0 ? raw.slice(sp + 1).trim() : `Contact ${context.contact?.name || contactNumber} (${contactNumber}) triggered an automation.`;
        if (!to) { results.push({ ...base, status: 'error', error: 'no recipient email' }); stepStatus = 'error'; continue; }
        try {
          const sent = await gmailSend({ to, subject, text: body });
          results.push({ ...base, status: 'applied', via: 'gmail', to, gmailMessageId: sent.id });
        } catch (err) {
          results.push({ ...base, status: 'error', error: err.message, hint: 'Connect Gmail in Admin Settings → Integrations' });
          stepStatus = 'error';
        }

      } else {
        // Honest stub — no real side-effect handler for this kind in this build.
        results.push({ ...base, status: 'logged', note: ACTION_STUB_NOTES[a.kind] || 'Action recorded; no side-effect handler in this build.' });
      }
    } catch (err) {
      results.push({ ...base, status: 'error', error: err.message });
      stepStatus = 'error';
    }
  }

  // One SSE nudge so any open Chats/Contacts views refresh after tag/field edits.
  if (contactMutated && waNumber && contactNumber) {
    bus.emit('contact-saved', { waNumber, contactNumber });
  }

  return logStep(client, executionId, node, { actions, contact: { waNumber, contactNumber } }, { results }, stepStatus);
}

// Read a value from a parsed JSON response by a simple dotted/JSONPath-ish path
// like "$.data.id" or "items.0.name". Returns undefined if any hop is missing.
function getByPath(obj, path) {
  if (obj == null || !path) return undefined;
  const parts = String(path).replace(/^\$\.?/, '').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// HUMAN HANDOFF — assigns the conversation to a real user, emits the same SSE
// the Chats/Contacts views listen for, optionally emails the agent, and stops
// the flow (the walker breaks on handoff). `node.assigned` holds forgecrm_users
// ids; round-robin rotates across them.
async function executeHandoffNode(client, executionId, node, context) {
  const waNumber = context.trigger_data?.wa_number;
  const contactNumber = context.contact_number;
  const assigned = Array.isArray(node.assigned) ? node.assigned : [];
  const mode = node.assignMode || 'specific';
  const note = resolveVariables(node.internalNote || '', context);

  let pickedId = null;
  if (assigned.length) {
    if (mode === 'round-robin') {
      const { rows: cnt } = await client.query(
        `SELECT COUNT(*)::int AS c FROM coexistence.automation_execution_steps WHERE node_type='handoff' AND status='success'`
      );
      pickedId = assigned[(cnt[0]?.c || 0) % assigned.length];
    } else {
      pickedId = assigned[0];
    }
  }

  let assignedUser = null;
  if (pickedId && waNumber && contactNumber) {
    const { rows: uRows } = await client.query(
      `SELECT id, display_name, email, role, is_active FROM coexistence.forgecrm_users WHERE id = $1`, [pickedId]
    );
    const u = uRows[0];
    if (u && u.is_active !== false) {
      await client.query(
        `INSERT INTO coexistence.contacts (wa_number, contact_number, assigned_user_id, updated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (wa_number, contact_number) DO UPDATE SET assigned_user_id = EXCLUDED.assigned_user_id, updated_at = NOW()`,
        [waNumber, contactNumber, u.id]
      );
      assignedUser = { id: u.id, displayName: u.display_name, role: u.role };
      bus.emit('contact-assignment-changed', { waNumber, contactNumber, assignedUserId: u.id, assignedUserName: u.display_name });
      if (node.notifyEmail && u.email) {
        try {
          await gmailSend({
            to: u.email,
            subject: `WhatsApp handoff: ${context.contact?.name || contactNumber}`,
            text: `You've been assigned a WhatsApp conversation with ${context.contact?.name || contactNumber} (${contactNumber}).\n\n${note ? `Note: ${note}\n\n` : ''}Open ForgeChat to take over the chat.`,
          });
        } catch { /* email is best-effort; never fail the handoff on it */ }
      }
    }
  }

  const output = {
    assignMode: mode,
    assignedTo: assignedUser,
    priority: node.priority || 'normal',
    internalNote: note || null,
    emailed: !!(node.notifyEmail && assignedUser),
    note: assignedUser
      ? `Conversation handed off to ${assignedUser.displayName}`
      : 'Handoff reached — no team member selected, conversation left for the inbox queue',
  };
  return logStep(client, executionId, node, { assigned, mode }, output, 'success');
}

// LEGACY AI STEP — a single LLM call bound to a business task. Saves the output
// onto the contact (a custom field) and exposes it as
// {{ai_output}} downstream. On failure / no-model it runs the configured
// fallback (approved template, else logs the reason).
async function executeAINode(client, executionId, node, context) {
  const aiTask = node.aiTask || 'custom';
  const goal = resolveVariables(node.aiGoal || '', context);
  const ctxText = resolveVariables(node.aiContext || '', context);
  const saveTo = node.aiSaveTo && node.aiSaveTo !== '__new__' ? node.aiSaveTo : '';
  const fallbackMode = node.aiFallback || 'fallback_message';
  const userMessage = context.message_body || context.trigger_data?.message_body || context.trigger_data?.body || '';

  let cred = null, modelId = null;
  if (node.aiModelRef?.credentialId && node.aiModelRef?.modelId) {
    const { rows } = await client.query(`SELECT * FROM coexistence.ai_models WHERE id=$1`, [node.aiModelRef.credentialId]);
    if (rows[0]) { cred = rows[0]; modelId = node.aiModelRef.modelId; }
  }
  if (!cred) { const p = await pickDefaultModel(client); if (p) { cred = p.cred; modelId = p.modelId; } }

  const runFallback = async (reason) => {
    if (fallbackMode === 'fallback_message' && node.fallbackTemplateId) {
      try {
        const sent = await sendFallbackTemplate(client, node, context, node.fallbackTemplateId);
        return logStep(client, executionId, node, { aiTask, fallback: 'template' }, { reason, fallbackSent: sent }, 'success');
      } catch (e) {
        return logStep(client, executionId, node, { aiTask, fallback: 'template' }, { reason, error: e.message }, 'error', `AI fallback failed: ${e.message}`);
      }
    }
    return logStep(client, executionId, node, { aiTask, fallback: fallbackMode }, { reason }, 'error', reason);
  };

  if (!cred) return runFallback('No AI model connected — add a provider in Admin Settings → AI Models.');

  const system = [
    `You are an AI assistant for a WhatsApp business, performing this task: ${String(aiTask).replace(/_/g, ' ')}.`,
    goal ? `Goal: ${goal}` : '',
    ctxText ? `Business context: ${ctxText}` : '',
    'Answer concisely in plain text suitable to store or send to the contact. No preamble, no markdown.',
  ].filter(Boolean).join('\n');

  let outputText;
  try {
    outputText = (await runChatCompletion(cred, modelId, [
      { role: 'system', content: system },
      { role: 'user', content: userMessage || '(the contact has not sent a message yet)' },
    ], { maxTokens: 500 })).trim();
  } catch (err) {
    return runFallback(err.message);
  }

  let saved = null;
  if (saveTo) saved = await saveAiOutputToField(client, context, saveTo, outputText);
  context.contact = context.contact || {};
  context.contact.custom_fields = { ...(context.contact.custom_fields || {}), ai_output: outputText };

  return logStep(client, executionId, node, { aiTask, goal, model: modelId, userMessage }, { output: outputText, savedTo: saved }, 'success');
}

// EXTERNAL API REQUEST — a real, variable-resolved HTTP call. Optional retry,
// and optional extraction of a response value (dotted path) onto a contact field.
async function executeAPINode(client, executionId, node, context) {
  const method = String(node.method || 'POST').toUpperCase();
  const url = resolveVariables(node.apiUrl || node.url || '', context);
  const onError = node.onError || 'continue';
  if (!/^https?:\/\//i.test(url)) {
    const msg = 'API node: URL must start with http:// or https://';
    if (onError === 'fail') throw new Error(msg);
    return logStep(client, executionId, node, { method, url }, { error: msg }, 'error', msg);
  }

  const headers = {};
  try {
    const raw = node.headers;
    let obj = {};
    if (Array.isArray(raw)) {
      for (const h of raw) { if (h && h.k) obj[h.k] = h.v; }      // UI array form [{k,v}]
    } else if (typeof raw === 'string' && raw.trim()) {
      obj = JSON.parse(resolveVariables(raw, context));            // JSON string form
    } else if (raw && typeof raw === 'object') {
      obj = raw;                                                   // plain object form
    }
    for (const [k, v] of Object.entries(obj || {})) headers[k] = resolveVariables(String(v), context);
  } catch { /* ignore malformed headers */ }

  let body;
  if (method !== 'GET' && node.body && String(node.body).trim()) {
    const resolved = resolveVariables(String(node.body), context);
    const ct = (headers['Content-Type'] || headers['content-type'] || '').toLowerCase();
    const looksJson = ct.includes('json') || resolved.trim().startsWith('{') || resolved.trim().startsWith('[');
    if (looksJson) {
      try { body = JSON.stringify(JSON.parse(resolved)); } catch { body = resolved; }
      if (!ct) headers['Content-Type'] = 'application/json';
    } else body = resolved;
  }

  const doFetch = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      let text = await res.text();
      if (text.length > 4096) text = text.slice(0, 4096) + '…(truncated)';
      let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, ok: res.ok, text, json };
    } finally { clearTimeout(timer); }
  };

  const attempts = onError === 'retry' ? 3 : 1;
  let result = null, lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      result = await doFetch();
      if (result.ok) break;
      lastErr = `HTTP ${result.status}`;
    } catch (e) {
      lastErr = e.name === 'AbortError' ? 'request timed out (15s)' : (e.message || String(e));
    }
  }

  let saved = null;
  if (result && node.saveResponseField && node.saveResponsePath) {
    const val = getByPath(result.json, node.saveResponsePath);
    if (val !== undefined) {
      saved = await saveAiOutputToField(client, context, node.saveResponseField, typeof val === 'object' ? JSON.stringify(val) : String(val));
    }
  }

  const failed = !result || !result.ok;
  if (failed && onError === 'fail') throw new Error(`API node: ${lastErr || 'request failed'}`);
  return logStep(
    client, executionId, node,
    { method, url, headers, body: body || null },
    { status: result?.status ?? null, response: result?.json || result?.text || null, savedTo: saved, error: failed ? lastErr : null },
    failed ? 'error' : 'success', failed ? lastErr : null
  );
}

// SUB-FLOW — runs another automation. `await` runs it inline; `fire` runs it
// detached and continues; `handoff` runs it detached and ends this flow (the
// walker breaks on handoff waitMode). Guards against sub-flow recursion loops.
async function executeSubflowNode(client, executionId, node, context) {
  const targetId = node.flowId || node.subflowId || null;
  const waitMode = node.waitMode || 'await';
  if (!targetId) return logStep(client, executionId, node, { waitMode }, { error: 'No sub-flow selected' }, 'error', 'No sub-flow selected');

  const ancestry = context.__subflowChain || [];
  if (ancestry.includes(String(targetId))) {
    const msg = `Sub-flow loop detected — flow ${targetId} is already running in this chain`;
    return logStep(client, executionId, node, { targetId, waitMode }, { error: msg }, 'error', msg);
  }

  const { rows } = await client.query(`SELECT * FROM coexistence.chatbots WHERE id = $1`, [targetId]);
  const sub = rows[0];
  if (!sub) return logStep(client, executionId, node, { targetId }, { error: `Sub-flow ${targetId} not found` }, 'error', 'Sub-flow not found');

  const childContext = { ...context, __subflowChain: [...ancestry, String(targetId)] };

  if (waitMode === 'fire' || waitMode === 'handoff') {
    setImmediate(() => {
      pool.connect()
        .then(async (c) => {
          try { await executeAutomation(c, sub, childContext); }
          catch (e) { console.error('[engine] subflow fire error:', e.message); }
          finally { c.release(); }
        })
        .catch(() => {});
    });
    return logStep(client, executionId, node, { targetId, waitMode }, { note: `Sub-flow "${sub.name}" started`, subflowId: targetId }, 'success');
  }

  // await: run inline on the same connection, sharing the recursion chain
  const childExec = await executeAutomation(client, sub, childContext);
  return logStep(client, executionId, node, { targetId, waitMode }, { note: `Sub-flow "${sub.name}" completed`, subflowExecutionId: childExec?.id || null }, 'success');
}

// PROVIDER_DEFAULT_BASE / runChatCompletion / pickDefaultModel now live in
// ../llm/chatCompletion so routes and services can make a single completion call
// without requiring this whole engine. Behaviour is unchanged (see the require
// at the top of this file).

async function executeAgentNode(client, executionId, node, context) {
  const { modelRef, systemPrompt, agentContext } = node;
  if (!modelRef || !modelRef.credentialId || !modelRef.modelId) {
    return logStep(client, executionId, node, { modelRef }, {}, 'error', 'AI Agent has no model selected (click the left handle to pick one).');
  }
  const { rows } = await client.query(
    `SELECT * FROM coexistence.ai_models WHERE id = $1`,
    [modelRef.credentialId]
  );
  if (rows.length === 0) {
    return logStep(client, executionId, node, { modelRef }, {}, 'error', `AI credential id=${modelRef.credentialId} not found`);
  }
  const cred = rows[0];
  const apiKey = decrypt(cred.api_key_encrypted);
  if (!apiKey) {
    return logStep(client, executionId, node, { modelRef }, {}, 'error', 'Failed to decrypt stored API key');
  }
  const baseUrl = (cred.base_url || PROVIDER_DEFAULT_BASE[cred.provider] || '').replace(/\/+$/, '');
  if (!baseUrl) {
    return logStep(client, executionId, node, { modelRef }, {}, 'error', `No base URL for provider ${cred.provider}`);
  }
  const chatUrl = `${baseUrl}/chat/completions`;

  // Kimi Code (api.kimi.com/coding/*) gates access by User-Agent — only
  // approved coding-agent clients get HTTP 200; everything else returns
  // 403 `access_terminated_error`. The restriction isn't documented in
  // their FAQ. We send `claude-code/1.0` so the endpoint accepts us;
  // the response model is always `kimi-for-coding` regardless of what
  // model id we request. Other providers don't need a UA override.
  const extraHeaders = {};
  if (cred.provider === 'kimi' && cred.base_url && /kimi\.com/i.test(cred.base_url)) {
    extraHeaders['User-Agent'] = 'claude-code/1.0';
  }

  const userMessage = context.message_body
    || context.trigger_data?.message_body
    || context.trigger_data?.body
    || '';
  if (!userMessage) {
    return logStep(client, executionId, node, { modelRef }, {}, 'error', 'AI Agent: no user message text in context to analyse.');
  }
  const sysPrompt = resolveVariables(systemPrompt, context) || 'You are a helpful assistant.';
  let fullSys = agentContext ? `${sysPrompt}\n\nAdditional context: ${resolveVariables(agentContext, context)}` : sysPrompt;

  // Conversational mode: maxTurns > 1 means the agent can reply, then pause
  // until the customer sends another message — looping up to maxTurns times,
  // OR exiting early when the model returns done:true. maxTurns=1 (default)
  // keeps the original single-shot extraction behavior with zero token impact.
  const maxTurns = Math.max(1, parseInt(node.maxTurns || 1, 10) || 1);
  const conversational = maxTurns > 1;

  // Count prior turns this AI Agent has taken in THIS execution. Each prior
  // run is one row in execution_steps with the same node_id. We rebuild the
  // chat history from those rows so the model has continuity on resume.
  let priorHistory = [];
  let turn = 1;
  if (conversational) {
    const { rows: priorSteps } = await client.query(
      `SELECT input_data, output_data FROM coexistence.automation_execution_steps
        WHERE execution_id = $1 AND node_id = $2 AND status = 'success'
        ORDER BY id`,
      [executionId, node.id]
    );
    turn = priorSteps.length + 1;
    for (const s of priorSteps) {
      const um = s.input_data?.userMessage;
      const reply = s.output_data?.reply;
      if (um) priorHistory.push({ role: 'user', content: um });
      if (reply) priorHistory.push({ role: 'assistant', content: String(reply) });
    }
  }

  const outputVariables = Array.isArray(node.outputVariables) ? node.outputVariables.filter(v => v && v.key) : [];
  const promptAlreadyAsksJson = /\bjson\b/i.test(fullSys);
  // Schema hint: tight one-line form. Skip when the user's own prompt already
  // requests JSON — saves ~60 prompt tokens per call.
  // Conversational mode forces JSON regardless of outputVariables because we
  // need `reply` + `done` keys to drive the loop.
  if ((outputVariables.length || conversational) && !promptAlreadyAsksJson) {
    const userKeys = outputVariables.map(v => v.description ? `${v.key} (${v.description})` : v.key);
    if (conversational) {
      const turnHint = `On turn ${turn} of ${maxTurns}. Set done:true ONLY when you have everything needed to finish; otherwise set done:false and continue the conversation.`;
      const allKeys = ['reply (your message to the user)', 'done (boolean)'].concat(userKeys);
      fullSys += `\n${turnHint}\nReturn ONLY a JSON object with keys: ${allKeys.join(', ')}. Use null for unknowns. Keep replies under 200 characters.`;
    } else {
      fullSys += `\nReturn ONLY a JSON object with keys: ${userKeys.join(', ')}. Use null for unknowns.`;
    }
  }

  const startedAt = Date.now();
  let response;
  let httpStatus = null;
  let respText = '';
  try {
    // Tighten cost on every call:
    // - max_tokens caps completion bloat (extraction never needs > 256 tokens).
    // - response_format:json_object forces strict JSON on OpenAI/compatible APIs
    //   that support it (eliminates prose wrapping + the need for the schema hint).
    // - temperature 0 makes extraction deterministic.
    const payload = {
      model: modelRef.modelId,
      messages: [
        { role: 'system', content: fullSys },
        ...priorHistory,
        { role: 'user', content: userMessage },
      ],
      temperature: 0,
      max_tokens: 256,
    };
    // response_format is OpenAI-specific. Other providers ignore unknown fields
    // OR reject them — only opt in for OpenAI when JSON output is wanted.
    if (cred.provider === 'openai' && (outputVariables.length || conversational)) {
      payload.response_format = { type: 'json_object' };
    }
    const res = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(payload),
    });
    httpStatus = res.status;
    respText = await res.text();
    if (!res.ok) {
      return logStep(client, executionId, node, { credentialId: cred.id, modelRef, userMessage }, { httpStatus, body: respText.slice(0, 1000) }, 'error', `AI HTTP ${httpStatus}: ${respText.slice(0, 200)}`);
    }
    response = JSON.parse(respText);
  } catch (err) {
    return logStep(client, executionId, node, { credentialId: cred.id, modelRef, userMessage }, { httpStatus, body: respText.slice(0, 500) }, 'error', `AI call failed: ${err.message}`);
  }

  const aiContent = response?.choices?.[0]?.message?.content || '';

  // Try to parse JSON output (entity extraction pattern: bot prompted to
  // return strict JSON). Models are inconsistent — some wrap in ```json fences,
  // some prepend "Sure, here's the JSON:", some add a trailing comment. Be
  // tolerant: strip fences anywhere, then extract the first {...} block
  // that parses.
  let parsed = null;
  let parseError = null;
  const tryParse = (s) => { try { return JSON.parse(s); } catch (e) { parseError = e.message; return null; } };
  if (aiContent) {
    // Strategy 1: strip ```json … ``` fences wherever they appear.
    const fenced = aiContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced && fenced[1]) parsed = tryParse(fenced[1].trim());
    // Strategy 2: try the raw response (covers models that returned strict JSON).
    if (!parsed) parsed = tryParse(aiContent.trim());
    // Strategy 3: extract first balanced {...} block — handles leading prose.
    if (!parsed) {
      const start = aiContent.indexOf('{');
      if (start !== -1) {
        let depth = 0;
        for (let i = start; i < aiContent.length; i++) {
          if (aiContent[i] === '{') depth++;
          else if (aiContent[i] === '}') {
            depth--;
            if (depth === 0) { parsed = tryParse(aiContent.slice(start, i + 1)); break; }
          }
        }
      }
    }
  }

  // Propagate parsed fields back onto context so downstream nodes can
  // reference {{name}}, {{first_name}}, etc. via resolveVariables. We also
  // persist name to the contacts table when extracted, so future runs see it.
  if (parsed && typeof parsed === 'object') {
    // Case-insensitive lookup for the 'name' field — users sometimes declare
    // it as `Name`, `NAME`, `full_name`. Treat any of those as the contact name.
    const nameKey = Object.keys(parsed).find(k => /^(name|full_?name)$/i.test(k));
    const nameValue = nameKey && typeof parsed[nameKey] === 'string' ? parsed[nameKey] : null;
    if (nameValue) {
      // Trust the freshly-extracted name over the WhatsApp profile name —
      // the user just answered a "what's your name" prompt explicitly, so the
      // AI's extraction wins for both in-memory rendering and the contacts row.
      context.contact = context.contact || {};
      context.contact.name = nameValue;
      if (context.contact_number && context.trigger_data?.wa_number) {
        try {
          await client.query(
            `INSERT INTO coexistence.contacts (wa_number, contact_number, name)
             VALUES ($1, $2, $3)
             ON CONFLICT (wa_number, contact_number) DO UPDATE
               SET name = EXCLUDED.name`,
            [context.trigger_data.wa_number, context.contact_number, nameValue]
          );
        } catch (e) { /* swallow — non-fatal */ }
      }
    }
    // Merge other parsed fields into custom_fields for {{x}} interpolation
    context.contact = context.contact || {};
    context.contact.custom_fields = { ...(context.contact.custom_fields || {}), ...parsed };

    // Persist extracted values that map to a real ForgeCRM custom field, keyed by
    // the field's id — so they show up on the Contacts page, exactly like `name`.
    // We match parsed keys to field definitions via the shared fieldVarKey()
    // normalization (so "date_of_birth" finds the "Date of Birth" field).
    if (context.contact_number && context.trigger_data?.wa_number) {
      const fieldDefs = context.field_defs || [];
      const updates = {}; // fieldId -> value
      for (const fd of fieldDefs) {
        if (!fd || !fd.id) continue;
        const vk = fieldVarKey(fd.name);
        const matchKey = Object.keys(parsed).find(k => fieldVarKey(k) === vk);
        if (matchKey == null) continue;
        const val = parsed[matchKey];
        if (val === undefined || val === null || val === '') continue;
        updates[fd.id] = typeof val === 'string' ? val : _stringifyForInterpolation(val);
      }
      if (Object.keys(updates).length) {
        try {
          const { rows: curRows } = await client.query(
            `SELECT custom_fields FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`,
            [context.trigger_data.wa_number, context.contact_number]
          );
          const cf = { ...((curRows[0] && curRows[0].custom_fields) || {}), ...updates };
          await client.query(
            `INSERT INTO coexistence.contacts (wa_number, contact_number, custom_fields)
             VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (wa_number, contact_number) DO UPDATE
               SET custom_fields = EXCLUDED.custom_fields`,
            [context.trigger_data.wa_number, context.contact_number, JSON.stringify(cf)]
          );
          context.contact.custom_fields = { ...(context.contact.custom_fields || {}), ...updates };
        } catch (e) { /* non-fatal — extraction still flows downstream in-memory */ }
      }
    }
  }

  // Compare declared schema against what we actually got so the Executions
  // drawer shows {course: "MBA", missing: ["city"]} at a glance.
  const declaredKeys = (outputVariables || []).map(v => v.key);
  const extractedVariables = parsed && typeof parsed === 'object'
    ? Object.fromEntries(declaredKeys.map(k => [k, parsed[k] === undefined ? null : parsed[k]]))
    : Object.fromEntries(declaredKeys.map(k => [k, null]));
  const missingKeys = declaredKeys.filter(k => extractedVariables[k] === null || extractedVariables[k] === undefined || extractedVariables[k] === '');

  // Conversational mode: pull the assistant's reply + done flag out of the
  // parsed JSON, send the reply to the customer, then decide whether to pause
  // for the next turn or fall through to the next node.
  let replyText = null;
  let done = false;
  let pauseAfter = false;
  if (conversational) {
    replyText = parsed && typeof parsed.reply === 'string' ? parsed.reply.trim() : null;
    done = parsed?.done === true || parsed?.done === 'true';
    if (replyText) {
      try {
        const { resolveAccount, insertPendingRow } = require('../services/messageSender');
        const { enqueueSend } = require('../queue/sendQueue');
        const fromPhone = context.trigger_data?.wa_number;
        const { account } = await resolveAccount({ accountId: node.whatsappAccountId, fromPhoneNumber: fromPhone });
        if (account) {
          const localId = await insertPendingRow({
            account, toNumber: context.contact_number, messageType: 'text', messageBody: replyText,
          });
          await enqueueSend({
            account, toNumber: context.contact_number, kind: 'text', payload: { body: replyText }, localMessageId: localId,
          });
        }
      } catch (e) {
        console.error('[engine] AI Agent reply send failed:', e.message);
      }
    }
    // Pause for next turn ONLY when not done AND we still have turns left.
    if (!done && turn < maxTurns) {
      pauseAfter = true;
      const hours = Math.max(1, parseInt(node.waitTimeoutHours || 24, 10));
      await client.query(
        `UPDATE coexistence.automation_executions
            SET status='paused',
                awaiting_node_id=$1,
                paused_at=NOW(),
                expires_at=NOW() + ($2 || ' hours')::INTERVAL,
                wa_number=$3
          WHERE id=$4`,
        [node.id, String(hours), context.trigger_data?.wa_number || null, executionId]
      );
    }
  }

  const step = await logStep(client, executionId, node, {
    credentialId: cred.id, model: modelRef.modelId, provider: cred.provider, userMessage, systemPrompt: fullSys,
    declaredVariables: declaredKeys, turn, maxTurns,
  }, {
    raw: aiContent, parsed, extractedVariables, missingKeys,
    reply: replyText, done, turn, maxTurns,
    exitReason: !conversational ? 'single_shot' : (done ? 'done_flag' : (turn >= maxTurns ? 'max_turns_reached' : 'awaiting_reply')),
    parseStatus: parsed ? 'ok' : (aiContent ? 'failed' : 'empty_response'),
    parseError: parsed ? null : parseError,
    usage: response?.usage, elapsedMs: Date.now() - startedAt,
  }, 'success');
  if (pauseAfter) step.__pauseExecution = true;
  return step;
}

// ─── Shared helpers for the legacy AI node ───────────────────────────

// runChatCompletion + pickDefaultModel moved to ../llm/chatCompletion (required
// at the top of this file) so the Chat Analyser service can reuse them without
// pulling in the engine. Definitions are byte-identical — no behaviour change.

// Persist an AI node's output onto the contact as a custom field (resolved by
// name to its definition id, falling back to the raw key). Also mirrors into
// context so downstream {{vars}} resolve.
async function saveAiOutputToField(client, context, fieldName, value) {
  const waNumber = context.trigger_data?.wa_number;
  const contactNumber = context.contact_number;
  if (!waNumber || !contactNumber || !fieldName) return null;
  const { rows: fRows } = await client.query(
    `SELECT id FROM coexistence.contact_field_definitions WHERE LOWER(name) = LOWER($1) LIMIT 1`, [fieldName]
  );
  const key = fRows[0]?.id || fieldName;
  const { rows: cur } = await client.query(
    `SELECT custom_fields FROM coexistence.contacts WHERE wa_number=$1 AND contact_number=$2`, [waNumber, contactNumber]
  );
  const cf = { ...((cur[0] && cur[0].custom_fields) || {}) };
  cf[key] = value;
  await client.query(
    `INSERT INTO coexistence.contacts (wa_number, contact_number, custom_fields, updated_at)
     VALUES ($1,$2,$3::jsonb,NOW())
     ON CONFLICT (wa_number, contact_number) DO UPDATE SET custom_fields = EXCLUDED.custom_fields, updated_at = NOW()`,
    [waNumber, contactNumber, JSON.stringify(cf)]
  );
  context.contact = context.contact || {};
  context.contact.custom_fields = cf;
  return { field: fieldName, key, value };
}

// Enqueue an approved template to the current contact (used by the AI node's
// outside-window fallback). Enforces the same WABA guard as the Message node.
async function sendFallbackTemplate(client, node, context, templateId) {
  const { rows } = await client.query(
    `SELECT name, body, language, header_type, header_text, footer, buttons, whatsapp_account_id
       FROM coexistence.message_templates WHERE id = $1`, [templateId]
  );
  const tpl = rows[0];
  if (!tpl) throw new Error(`fallback template id=${templateId} not found`);
  const { resolveAccount, insertPendingRow } = require('../services/messageSender');
  const { enqueueSend } = require('../queue/sendQueue');
  const fromPhone = context.trigger_data?.wa_number;
  const { account, error } = await resolveAccount({ accountId: node.whatsappAccountId, fromPhoneNumber: fromPhone });
  if (error || !account) throw new Error(error || 'no account to send fallback template');
  if (tpl.whatsapp_account_id != null && String(tpl.whatsapp_account_id) !== String(account.id)) {
    throw new Error(`Fallback template "${tpl.name}" is approved on a different WhatsApp number than ${account.displayPhoneNumber || fromPhone}.`);
  }
  const localId = await insertPendingRow({
    account, toNumber: context.contact_number, messageType: 'template',
    messageBody: tpl.body || `Template: ${tpl.name}`,
    templateMeta: { header_type: tpl.header_type || 'NONE', header_text: tpl.header_text || null, footer: tpl.footer || null, buttons: Array.isArray(tpl.buttons) ? tpl.buttons : (tpl.buttons || []) },
  });
  await enqueueSend({
    kind: 'template', accountId: account.id, to: String(context.contact_number).replace(/\D/g, ''),
    localMessageId: localId, payload: { name: tpl.name, languageCode: tpl.language || 'en', components: [] },
  });
  return { localId, templateName: tpl.name };
}

const NODE_HANDLERS = {
  trigger: executeTriggerNode,
  message: executeMessageNode,
  condition: executeConditionNode,
  delay: executeDelayNode,
  action: executeActionNode,
  handoff: executeHandoffNode,
  ai: executeAINode,
  ai_agent: executeAgentNode,
  api: executeAPINode,
  subflow: executeSubflowNode,
};

// ─── Graph Walker ────────────────────────────────────────────────────

async function executeAutomation(client, automation, context) {
  const config = automation.config || {};
  const nodes = config.nodes || [];
  const edges = config.edges || [];

  if (nodes.length === 0) {
    console.log(`[engine] Automation ${automation.id} has no nodes`);
    return null;
  }

  // Create execution record
  const { rows } = await client.query(
    `INSERT INTO coexistence.automation_executions
     (automation_id, status, trigger_type, trigger_data, contact_number, started_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [
      automation.id,
      'running',
      context.trigger_type || 'keyword',
      JSON.stringify(context.trigger_data || {}),
      context.contact_number || null,
      new Date().toISOString(),
    ]
  );
  const execution = rows[0];

  try {
    // Find trigger node
    const triggerNode = nodes.find(n => n.type === 'trigger');
    if (!triggerNode) {
      throw new Error('No trigger node found in automation');
    }

    // Execute trigger
    await executeTriggerNode(client, execution.id, triggerNode, context);

    // Walk graph starting from nodes connected to trigger
    const triggerEdges = edges.filter(e => e.from === triggerNode.id);
    const startNodeId = triggerEdges.length > 0 ? triggerEdges[0].to : null;
    const visited = new Set([triggerNode.id]);

    const result = await walkFrom(client, execution.id, nodes, edges, startNodeId, context, visited);

    if (!result.paused) {
      await updateExecutionStatus(client, execution.id, 'success');
    }
    return execution;

  } catch (err) {
    console.error(`[engine] Execution error for automation ${automation.id}:`, err.message);
    await updateExecutionStatus(client, execution.id, 'error', err.message);
    return execution;
  }
}

// Walks the graph DFS from startNodeId. Returns { paused: boolean } —
// paused=true means a node signalled `step.__pauseExecution`, in which case
// the walker exited without finishing and the caller should NOT mark the
// execution as success (the pausing handler already flipped it to 'paused').
async function walkFrom(client, executionId, nodes, edges, startNodeId, context, visited = new Set()) {
  let currentNodeId = startNodeId;
  while (currentNodeId && !visited.has(currentNodeId)) {
    visited.add(currentNodeId);
    const node = nodes.find(n => n.id === currentNodeId);
    if (!node) break;

    const handler = NODE_HANDLERS[node.type];
    if (!handler) {
      await logStep(client, executionId, node, {}, { note: `Unknown node type: ${node.type}` }, 'error', `No handler for node type ${node.type}`);
      break;
    }

    const step = await handler(client, executionId, node, context);

    // A handler can signal a pause (e.g. a Message node with waitForReply).
    // We exit cleanly — the handler is responsible for having flipped the
    // execution row to status='paused' before returning.
    if (step && step.__pauseExecution) {
      return { paused: true };
    }

    // Determine next node based on node type and output
    let nextNodeId = null;
    let fromHandle = 'default';

    if (node.type === 'condition') {
      fromHandle = step.output_data.matched ? 'yes' : 'no';
    } else if (node.type === 'message' && node.messageMode === 'template' && node.buttons && node.buttons.length > 0) {
      // For template buttons, we can't know which button was pressed during execution
      // So we just follow the default edge
      fromHandle = 'default';
    } else if (node.type === 'handoff') {
      // Handoff stops the flow
      break;
    } else if (node.type === 'subflow' && node.waitMode === 'handoff') {
      // "Exit & run flow" — the sub-flow was fired detached; end this flow here.
      break;
    }

    const candidateEdges = edges.filter(e =>
      e.from === currentNodeId &&
      (fromHandle === 'default' ? (!e.fromHandle || e.fromHandle === 'default') : e.fromHandle === fromHandle)
    );

    if (candidateEdges.length > 0) {
      nextNodeId = candidateEdges[0].to;
    }

    currentNodeId = nextNodeId;
  }
  return { paused: false };
}

// Resume a paused execution. Atomically claims the row (status=paused →
// running) so concurrent inbound messages can't double-resume. Walks the
// graph from the children of the node where it paused, using the new
// inbound `record` as context.message_body.
async function resumeAutomation(client, executionId, record) {
  // Atomic claim — only one caller wins
  const { rows: claimed } = await client.query(
    `UPDATE coexistence.automation_executions
        SET status='running'
      WHERE id=$1 AND status='paused' AND expires_at>NOW()
     RETURNING id, automation_id, awaiting_node_id, trigger_data, contact_number`,
    [executionId]
  );
  if (claimed.length === 0) {
    // Already claimed by another worker, or expired
    return null;
  }
  const execRow = claimed[0];

  // Load the latest automation config
  const { rows: botRows } = await client.query(
    `SELECT id, name, config FROM coexistence.chatbots WHERE id = $1`,
    [execRow.automation_id]
  );
  if (botRows.length === 0) {
    await updateExecutionStatus(client, executionId, 'error', 'Automation no longer exists');
    return null;
  }
  const config = botRows[0].config || {};
  const nodes = config.nodes || [];
  const edges = config.edges || [];

  // Build context from the fresh inbound record (mirrors evaluateTriggers)
  const context = {
    contact_number: record.contact_number,
    message_body: record.message_body,
    message_type: record.message_type,
    trigger_type: 'resume',
    trigger_data: {
      message_id: record.message_id,
      wa_number: record.wa_number,
      phone_number_id: record.phone_number_id,
      timestamp: record.timestamp,
      media_url: record.media_url,
      media_mime_type: record.media_mime_type,
      status: record.status,
      conversation: record.conversation || null,
      pricing: record.pricing || null,
      errors: record.errors || null,
    },
  };

  // Re-hydrate contact info same as evaluateTriggers does
  try {
    const { rows: contactRows } = await client.query(
      `SELECT name, profile_name, tags, custom_fields FROM coexistence.contacts
        WHERE wa_number = $1 AND contact_number = $2`,
      [record.wa_number, record.contact_number]
    );
    if (contactRows.length > 0) {
      context.contact = {
        name: contactRows[0].name,
        profile_name: contactRows[0].profile_name,
        contact_number: record.contact_number,
        tags: contactRows[0].tags || [],
        custom_fields: contactRows[0].custom_fields || {},
      };
    }
  } catch (e) { /* non-fatal */ }

  // Field definitions let resolveVariables map custom_fields (id-keyed) back to
  // their {{normalized_name}} tokens, and let executeAgentNode persist extracted
  // values to the right field id.
  try {
    const { rows: fdRows } = await client.query(`SELECT id, name FROM coexistence.contact_field_definitions`);
    context.field_defs = fdRows;
  } catch (e) { context.field_defs = []; }

  // Find the node we paused at. For a Message node with waitForReply we
  // resume at its CHILDREN (the reply continues the flow). For an AI Agent
  // in conversational mode we resume AT THE SAME node — it needs to take the
  // next turn against the customer's new message.
  const pausedNode = nodes.find(n => n.id === execRow.awaiting_node_id);
  if (!pausedNode) {
    await updateExecutionStatus(client, executionId, 'error', `Paused node ${execRow.awaiting_node_id} no longer in automation config`);
    return null;
  }
  let startNodeId;
  if (pausedNode.type === 'ai_agent') {
    startNodeId = pausedNode.id;
  } else {
    const nextEdges = edges.filter(e =>
      e.from === execRow.awaiting_node_id && (!e.fromHandle || e.fromHandle === 'default')
    );
    startNodeId = nextEdges.length > 0 ? nextEdges[0].to : null;
  }
  if (!startNodeId) {
    // Paused with nothing downstream — just close it out
    await client.query(
      `UPDATE coexistence.automation_executions
          SET status='success', awaiting_node_id=NULL, completed_at=NOW()
        WHERE id=$1`,
      [executionId]
    );
    return execRow;
  }

  console.log(`[engine] Resuming execution=${executionId} automation=${execRow.automation_id} from node=${startNodeId}`);

  try {
    // visited Set deliberately empty — the resumed walk treats startNodeId
    // as fresh. Cycle protection still works because walkFrom adds each
    // node as it visits.
    const result = await walkFrom(client, executionId, nodes, edges, startNodeId, context);
    if (!result.paused) {
      await client.query(
        `UPDATE coexistence.automation_executions
            SET status='success', awaiting_node_id=NULL, completed_at=NOW()
          WHERE id=$1`,
        [executionId]
      );
    }
    return execRow;
  } catch (err) {
    console.error(`[engine] Resume error for execution ${executionId}:`, err.message);
    await client.query(
      `UPDATE coexistence.automation_executions
          SET status='error', awaiting_node_id=NULL, error_message=$2, completed_at=NOW()
        WHERE id=$1`,
      [executionId, err.message]
    );
    return execRow;
  }
}

// ─── Trigger Evaluation ──────────────────────────────────────────────

async function evaluateTriggers(messageRecord) {
  const client = await pool.connect();
  const executions = [];

  try {
    // Fetch all active automations
    const { rows: automations } = await client.query(
      `SELECT id, name, status, trigger_type, config
       FROM coexistence.chatbots
       WHERE status = 'active'`
    );

    const context = {
      contact_number: messageRecord.contact_number,
      message_body: messageRecord.message_body,
      message_type: messageRecord.message_type,
      trigger_type: 'keyword',
      trigger_data: {
        message_id: messageRecord.message_id,
        wa_number: messageRecord.wa_number,
        phone_number_id: messageRecord.phone_number_id,
        timestamp: messageRecord.timestamp,
        media_url: messageRecord.media_url,
        media_mime_type: messageRecord.media_mime_type,
        status: messageRecord.status,
        conversation: messageRecord.conversation || null,
        pricing: messageRecord.pricing || null,
        errors: messageRecord.errors || null,
      },
    };

    // Try to load contact data
    try {
      const { rows: contactRows } = await client.query(
        `SELECT name, profile_name, tags, custom_fields
         FROM coexistence.contacts
         WHERE wa_number = $1 AND contact_number = $2
         LIMIT 1`,
        [messageRecord.wa_number, messageRecord.contact_number]
      );
      if (contactRows.length > 0) {
        context.contact = {
          name: contactRows[0].name,
          profile_name: contactRows[0].profile_name,
          contact_number: messageRecord.contact_number,
          tags: contactRows[0].tags || [],
          custom_fields: contactRows[0].custom_fields || {},
        };
      }
    } catch (e) {
      // Contact lookup failed, continue without contact data
    }

    // Field definitions for {{custom_field_name}} resolution + AI persistence.
    try {
      const { rows: fdRows } = await client.query(`SELECT id, name FROM coexistence.contact_field_definitions`);
      context.field_defs = fdRows;
    } catch (e) { context.field_defs = []; }

    for (const automation of automations) {
      const config = automation.config || {};
      const nodes = config.nodes || [];
      const triggerNode = nodes.find(n => n.type === 'trigger');
      if (!triggerNode) continue;

      // WhatsApp-account filter: if the trigger node names specific accounts,
      // only fire when the inbound record arrived on one of them. Empty/missing
      // = listen on every account (backward-compatible with pre-2026-05-19 flows).
      const triggerAccounts = Array.isArray(triggerNode.triggerAccounts) ? triggerNode.triggerAccounts : [];
      if (triggerAccounts.length > 0 && !triggerAccounts.includes(messageRecord.wa_number)) {
        continue;
      }

      const triggerKind = triggerNode.triggerKind || 'keyword';

      // Direction gate (2026-07 outbound-keyword feature). Records now carry a
      // `direction` ('incoming'|'outgoing'). An OUTBOUND record (a message a BD
      // sent) may only fire a keyword trigger that explicitly opts into
      // outbound via `triggerDirection` ('outbound'|'both'); every other
      // trigger kind stays inbound-only, exactly as before. Conversely a
      // keyword trigger set to outbound-only must not fire on inbound records.
      const recordDir = messageRecord.direction === 'outgoing' ? 'outbound' : 'inbound';
      const triggerDir = triggerNode.triggerDirection || 'inbound';
      if (recordDir === 'outbound') {
        if (triggerKind !== 'keyword') continue;
        if (triggerDir !== 'outbound' && triggerDir !== 'both') continue;
      } else if (triggerKind === 'keyword' && triggerDir === 'outbound') {
        continue;
      }

      if (triggerKind === 'keyword') {
        const keyword = triggerNode.keyword || '';
        const matchType = triggerNode.matchType || 'exact';
        const caseSensitive = !!triggerNode.caseSensitive;

        if (matchesKeyword(messageRecord.message_body, keyword, matchType, caseSensitive)) {
          console.log(`[engine] Keyword match: automation=${automation.id} keyword="${keyword}"`);
          const execution = await executeAutomation(client, automation, context);
          if (execution) executions.push(execution);
        }
      } else if (triggerKind === 'anyMessage') {
        // Catch-all trigger
        console.log(`[engine] Any-message match: automation=${automation.id}`);
        const execution = await executeAutomation(client, automation, context);
        if (execution) executions.push(execution);
      } else if (triggerKind === 'newContact') {
        // Check if this is first message from contact
        const { rows: historyRows } = await client.query(
          `SELECT COUNT(*) FROM coexistence.chat_history
           WHERE wa_number = $1 AND contact_number = $2`,
          [messageRecord.wa_number, messageRecord.contact_number]
        );
        const messageCount = parseInt(historyRows[0].count, 10);
        if (messageCount <= 2) { // 1-2 messages means it's new
          console.log(`[engine] New contact match: automation=${automation.id}`);
          const execution = await executeAutomation(client, automation, context);
          if (execution) executions.push(execution);
        }
      } else if (triggerKind === 'messageRead') {
        // Trigger when recipient reads a message
        if (messageRecord.message_type === 'status' && messageRecord.status === 'read') {
          console.log(`[engine] Message read match: automation=${automation.id}`);
          const execution = await executeAutomation(client, automation, context);
          if (execution) executions.push(execution);
        }
      } else if (triggerKind === 'messageDelivered') {
        // Trigger when message is delivered
        if (messageRecord.message_type === 'status' && messageRecord.status === 'delivered') {
          console.log(`[engine] Message delivered match: automation=${automation.id}`);
          const execution = await executeAutomation(client, automation, context);
          if (execution) executions.push(execution);
        }
      } else if (triggerKind === 'messageSent') {
        // Trigger when message is sent
        if (messageRecord.message_type === 'status' && messageRecord.status === 'sent') {
          console.log(`[engine] Message sent match: automation=${automation.id}`);
          const execution = await executeAutomation(client, automation, context);
          if (execution) executions.push(execution);
        }
      } else if (triggerKind === 'link' || triggerKind === 'qr') {
        // Click-to-chat link / QR scan: the wa.me pre-filled text carries a
        // tracking code (link) or label (qr). We fire when the inbound message
        // body contains that code — that's how a BSP attributes the source.
        const code = String((triggerKind === 'link' ? triggerNode.trackingCode : triggerNode.qrLabel) || '').trim();
        const body = messageRecord.message_body || '';
        if (code && messageRecord.message_type !== 'status' && body.toLowerCase().includes(code.toLowerCase())) {
          console.log(`[engine] ${triggerKind} code match "${code}": automation=${automation.id}`);
          const execution = await executeAutomation(client, automation, context);
          if (execution) executions.push(execution);
        }
      }
      // tagApplied fires via fireTagAppliedTriggers (tag mutations); webhook /
      // apiEvent fire via fireWebhookTrigger (the per-automation webhook URL).
    }

  } catch (err) {
    console.error('[engine] evaluateTriggers error:', err.message);
  } finally {
    client.release();
  }

  return executions;
}

// Build a context object for a non-message-driven trigger (tag/webhook) by
// loading the contact + field definitions. Mirrors the shape evaluateTriggers
// builds so every downstream node (variables, conditions, sends) works.
async function buildContext(client, { waNumber, contactNumber, messageBody = '', triggerType, triggerData = {} }) {
  const context = {
    contact_number: contactNumber,
    message_body: messageBody,
    trigger_type: triggerType,
    trigger_data: { wa_number: waNumber, ...triggerData },
  };
  try {
    const { rows } = await client.query(
      `SELECT name, profile_name, tags, custom_fields FROM coexistence.contacts
        WHERE wa_number=$1 AND contact_number=$2 LIMIT 1`,
      [waNumber, contactNumber]
    );
    if (rows.length) {
      context.contact = {
        name: rows[0].name, profile_name: rows[0].profile_name, contact_number: contactNumber,
        tags: rows[0].tags || [], custom_fields: rows[0].custom_fields || {},
      };
    }
  } catch { /* non-fatal */ }
  try {
    const { rows: fd } = await client.query(`SELECT id, name FROM coexistence.contact_field_definitions`);
    context.field_defs = fd;
  } catch { context.field_defs = []; }
  return context;
}

// TAG-APPLIED trigger. Called after a tag is added/removed (Add/Remove Tag
// action, or a contact save). Fires every active automation whose trigger
// watches this tag + direction. `fireOncePerTag` skips contacts that already
// ran this automation for this tag.
async function fireTagAppliedTriggers({ waNumber, contactNumber, tagName, direction = 'added' }) {
  if (!waNumber || !contactNumber || !tagName) return [];
  const client = await pool.connect();
  const executions = [];
  try {
    const { rows: automations } = await client.query(
      `SELECT * FROM coexistence.chatbots WHERE status='active'`
    );
    for (const automation of automations) {
      const nodes = (automation.config || {}).nodes || [];
      const trigger = nodes.find(n => n.type === 'trigger');
      if (!trigger || trigger.triggerKind !== 'tagApplied') continue;
      if (String(trigger.tag || '').toLowerCase() !== String(tagName).toLowerCase()) continue;
      if ((trigger.tagDirection || 'added') !== direction) continue;

      const accts = Array.isArray(trigger.triggerAccounts) ? trigger.triggerAccounts : [];
      if (accts.length > 0 && !accts.includes(waNumber)) continue;

      if (trigger.fireOncePerTag !== false) {
        const { rows: prev } = await client.query(
          `SELECT 1 FROM coexistence.automation_executions
            WHERE automation_id=$1 AND contact_number=$2 AND trigger_type='tagApplied'
              AND (trigger_data->>'tag')=$3 LIMIT 1`,
          [automation.id, contactNumber, tagName]
        );
        if (prev.length) continue;
      }
      const context = await buildContext(client, {
        waNumber, contactNumber, triggerType: 'tagApplied',
        triggerData: { tag: tagName, direction },
      });
      const execution = await executeAutomation(client, automation, context);
      if (execution) executions.push(execution);
    }
  } catch (err) {
    console.error('[engine] fireTagAppliedTriggers error:', err.message);
  } finally {
    client.release();
  }
  return executions;
}

// WEBHOOK / API-EVENT trigger. Called by the per-automation webhook endpoint.
// Maps the POSTed JSON into context (contact_phone → contact, each top-level
// key → a {{var}}), optionally filtering apiEvent by event type.
async function fireWebhookTrigger(automationId, payload = {}) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT * FROM coexistence.chatbots WHERE id=$1 AND status='active'`, [automationId]);
    const automation = rows[0];
    if (!automation) return { ok: false, error: 'Automation not found or inactive' };
    const nodes = (automation.config || {}).nodes || [];
    const trigger = nodes.find(n => n.type === 'trigger');
    if (!trigger || (trigger.triggerKind !== 'webhook' && trigger.triggerKind !== 'apiEvent')) {
      return { ok: false, error: 'This automation is not triggered by a webhook' };
    }
    // apiEvent: optional event-type filter against payload.event
    if (trigger.triggerKind === 'apiEvent' && trigger.eventType) {
      const evt = String(payload.event || payload.type || '');
      if (evt && evt !== trigger.eventType) return { ok: true, skipped: `event ${evt} != ${trigger.eventType}` };
    }
    const contactNumber = String(payload.contact_phone || payload.phone || payload.contact_number || '').replace(/\D/g, '');
    if (!contactNumber) return { ok: false, error: 'payload must include contact_phone' };
    // Pick a wa_number: the trigger's first listened account, else the default account
    let waNumber = (Array.isArray(trigger.triggerAccounts) && trigger.triggerAccounts[0]) || null;
    if (!waNumber) {
      const { rows: acc } = await client.query(
        `SELECT display_phone_number FROM coexistence.whatsapp_accounts WHERE is_active=true ORDER BY is_default DESC, id ASC LIMIT 1`
      );
      waNumber = acc[0]?.display_phone_number || null;
    }
    const context = await buildContext(client, {
      waNumber, contactNumber,
      messageBody: String(payload.message || ''),
      triggerType: trigger.triggerKind,
      triggerData: { ...payload, wa_number: waNumber },
    });
    // expose every top-level payload field as a downstream variable
    context.contact = context.contact || { contact_number: contactNumber, custom_fields: {} };
    context.contact.custom_fields = { ...(context.contact.custom_fields || {}) };
    for (const [k, v] of Object.entries(payload)) {
      if (v != null && typeof v !== 'object') context.contact.custom_fields[k] = v;
    }
    if (payload.contact_name && !context.contact.name) context.contact.name = payload.contact_name;
    const execution = await executeAutomation(client, automation, context);
    return { ok: true, executionId: execution?.id || null };
  } catch (err) {
    console.error('[engine] fireWebhookTrigger error:', err.message);
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

// ── Outbound trigger dedup / loop guard ──────────────────────────────────────
// An outbound message can reach us via TWO paths: (a) the send queue, right
// after WE send it through ForgeGrowth, and (b) a Meta "message echo" webhook,
// which fires for EVERY business-sent message — including ones sent straight
// from the WhatsApp Business app AND ones we sent via the API. Without a guard
// an API-sent message would fire its outbound trigger twice, and an automation's
// own send could echo back and re-trigger it (infinite loop).
//
// We key on the message's wamid (identical across both paths). `markOutboundHandled`
// "claims" a wamid without firing (used by the send queue for automation/agent
// sends — claim so the echo can't re-fire them). `evaluateOutboundTriggers`
// fires exactly once per wamid, skipping any already claimed/handled.
const _handledOutbound = new Map(); // wamid -> expiry ts
const HANDLED_TTL_MS = 10 * 60 * 1000;
function _pruneHandled() {
  const now = Date.now();
  for (const [k, v] of _handledOutbound) if (v <= now) _handledOutbound.delete(k);
}
function markOutboundHandled(messageId) {
  if (!messageId) return;
  _pruneHandled();
  _handledOutbound.set(messageId, Date.now() + HANDLED_TTL_MS);
}
async function evaluateOutboundTriggers(record) {
  const mid = record && record.message_id;
  if (mid) {
    _pruneHandled();
    if (_handledOutbound.has(mid)) return [];       // already fired or deliberately skipped
    _handledOutbound.set(mid, Date.now() + HANDLED_TTL_MS);
  }
  return evaluateTriggers({ ...record, direction: 'outgoing' });
}

module.exports = {
  evaluateTriggers,
  evaluateOutboundTriggers,
  markOutboundHandled,
  executeAutomation,
  resumeAutomation,
  matchesKeyword,
  resolveVariables,
  evaluateConditions,
  fireTagAppliedTriggers,
  fireWebhookTrigger,
};
