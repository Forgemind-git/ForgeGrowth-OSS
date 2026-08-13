/**
 * Validate an automation before it is allowed to go live.
 *
 * WHY IT LIVES IN THE BACKEND
 * ---------------------------
 * `POST /chatbots/import` and the MCP `create_automation` tool both write
 * `JSON.stringify(config)` with no checking at all, so a client-only validator
 * is a rail an LLM client walks straight past. One implementation, called from
 * the route, is the only version that actually holds.
 *
 * WHAT IT REFUSES
 * ---------------
 * Only ACTIVATION. Saving must never lose work — a draft is allowed to be
 * broken, and blocking Save would train people to avoid saving.
 *
 * ⚠ THE LINE: A MISSING WIRE WARNS. A WIRE THAT CAN NEVER FIRE BLOCKS.
 *
 * An incomplete flow is a legitimate thing to run. Half-built is how every
 * flow starts, and a branch nobody has wired yet simply ends the conversation
 * there — the customer is not harmed and nothing lies. Refusing to activate
 * over it made Enable unreachable on any flow still being built, which is what
 * this split fixes.
 *
 * What still blocks is narrower and all of one kind: the flow would be BROKEN
 * at runtime while appearing to work.
 *   • Meta rejects the send outright (no body on an interactive message, a
 *     limit exceeded, a template that is missing or unapproved) — the step can
 *     never deliver, so the customer gets nothing and the log says success.
 *   • A wire exists that can never carry anything (a branch off a link button
 *     WhatsApp never reports; branches on a step whose wait is off). The
 *     author has said "go this way" and it silently will not.
 *   • The flow cannot start (no trigger, no keyword) or cannot stop (a
 *     nomatch pointing at its own source loops forever, burning the 24h
 *     window).
 *
 * Everything else — an unwired branch, no fallback, no timeout, an
 * unreachable step — is a WARNING: shown, never enforced.
 */

const { isQuickReply } = require('./replyRouting');

/** Meta's own caps. Mirrored from the engine's slices so both agree. */
const CAPS = {
  buttons: 3,
  buttonTitle: 20,
  listRows: 10,
  listSections: 10,
  listTitle: 24,
  listDescription: 72,
  interactiveBody: 1024,
  text: 4096,
  headerText: 60,
  footer: 60,
};

const asArray = (v) => (Array.isArray(v) ? v : []);
const txt = (v) => String(v == null ? '' : v).trim();

/**
 * The handles a node is EXPECTED to have.
 *
 * ⚠ This mirrors frontend/src/components/builder/nodeLayout.js `nodeRows`.
 * The two ship as separate Docker images so they cannot import each other, but
 * if they drift the canvas draws a handle the engine cannot resolve — the exact
 * class of bug this whole change exists to remove. `test/flowValidator.unit.test.js`
 * asserts both produce identical handle arrays for a shared fixture.
 */
function expectedHandles(n) {
  if (!n) return [];
  if (n.type === 'ai_agent') return ['default', 'model', 'tool'];
  if (n.type === 'condition') return ['yes', 'no'];
  if (n.type === 'handoff') return [];

  if (n.type === 'message') {
    const out = [];
    const dd = n.directData || {};
    const waiting = n.waitForReply === true;

    if (n.messageMode === 'direct') {
      if (n.directType === 'quick_reply') {
        asArray(dd.buttons).forEach((_, i) => out.push(`btn:${i}`));
      } else if (n.directType === 'list') {
        asArray(dd.sections).forEach((s, si) =>
          asArray(s && s.rows).forEach((_, ri) => out.push(`row:${si}:${ri}`)));
      } else if (n.directType === 'location_request' && waiting) {
        return ['shared', 'nomatch', 'timeout'];
      }
    } else {
      asArray(n.buttons).forEach((b, i) => { if (isQuickReply(b)) out.push(`btn:${i}`); });
    }

    if (waiting) {
      // No choices offered means no wrong answer: the branch is `replied`.
      const hasChoices = out.some(h => h.startsWith('btn:') || h.startsWith('row:'));
      out.push(hasChoices ? 'nomatch' : 'replied', 'timeout');
      return out;
    }
    out.push('default');
    return out;
  }

  return ['default'];
}

const F = (nodeId, code, message, fix, handle) => ({ nodeId, code, message, fix, handle });

function validateFlow(config, ctx = {}) {
  const nodes = asArray(config && config.nodes);
  const edges = asArray(config && config.edges);
  const blocking = [];
  const warnings = [];

  const wired = new Set();
  edges.forEach(e => { if (e && e.to) wired.add(`${e.from}::${e.fromHandle || 'default'}`); });
  const isWired = (nodeId, handle) => wired.has(`${nodeId}::${handle}`);

  // ── Triggers ──────────────────────────────────────────────────────────
  const triggers = nodes.filter(n => n.type === 'trigger');
  if (triggers.length === 0) {
    blocking.push(F(null, 'NO_TRIGGER', 'This flow has no trigger, so nothing can ever start it.',
      'Add a trigger step.'));
  }
  if (triggers.length > 1) {
    // Silently ignoring the rest is the worst of the three options, and it is
    // what the engine does today — evaluateTriggers only ever reads the first.
    blocking.push(F(triggers[1].id, 'MULTI_TRIGGER',
      `This flow has ${triggers.length} triggers, but only the first one ever fires.`,
      'Delete the extra triggers, or move them into their own flow.'));
  }
  triggers.slice(0, 1).forEach(t => {
    // Each of these is a trigger the engine WILL evaluate and which can never
    // match, so they block for the same reason an empty keyword does: the flow
    // would go live looking configured and never fire once. Everything here is
    // a field the settings panel can now actually set — before it existed,
    // `trackingCode` had no editor at all, so a wa.me-link trigger was dead on
    // arrival by construction.
    const kind = t.triggerKind || 'keyword';
    if (kind === 'keyword' && !txt(t.keyword)) {
      blocking.push(F(t.id, 'TRIGGER_INCOMPLETE', 'The trigger has no keyword, so it can never match.',
        'Type the word customers will send.'));
    }
    if (kind === 'link' && !txt(t.trackingCode)) {
      blocking.push(F(t.id, 'TRIGGER_INCOMPLETE', 'The link trigger has no tracking code, so it can never match.',
        'Set the code carried in the link’s pre-filled message.'));
    }
    if (kind === 'tagApplied' && !txt(t.tag)) {
      blocking.push(F(t.id, 'TRIGGER_INCOMPLETE', 'The trigger does not say which tag to watch, so it can never fire.',
        'Choose a tag.'));
    }
  });

  // ── Per node ──────────────────────────────────────────────────────────
  const templatesById = ctx.templatesById || {};
  nodes.forEach(n => {
    const dd = n.directData || {};
    const handles = expectedHandles(n);
    const branchHandles = handles.filter(h => h === 'yes' || h === 'no' || h === 'shared'
      || h.startsWith('btn:') || h.startsWith('row:'));

    // A branch nobody wired ends the conversation there. Worth saying, but it
    // is INCOMPLETE, not broken — the flow runs correctly up to that point.
    branchHandles.forEach(h => {
      if (!isWired(n.id, h)) {
        warnings.push(F(n.id, 'UNWIRED_BRANCH',
          `Nothing happens when the customer picks "${labelForHandle(n, h)}".`,
          'Click that row on the step and choose what happens next.', h));
      }
    });

    if (n.type === 'message') {
      // Buttons with the wait off. This BLOCKS only when a branch is actually
      // wired: then a connection exists that can never carry anything, which
      // is the "it silently will not do what the canvas says" case. Offering
      // buttons and wiring none of them is merely unfinished, so it warns.
      if (branchHandles.length > 0 && n.waitForReply !== true && n.directType !== 'location_request') {
        const anyWired = branchHandles.some(h => isWired(n.id, h));
        (anyWired ? blocking : warnings).push(F(n.id, 'NO_WAIT_ON_BRANCHING',
          anyWired
            ? 'This step offers choices and something is wired to them, but it does not wait for the reply — so none of those branches can ever run.'
            : 'This step offers choices but does not wait for the reply, so it cannot branch on what the customer taps.',
          'Turn on "Wait for the customer\'s reply".'));
      }

      if (n.waitForReply === true) {
        const answerHandle = handles.includes('replied') ? 'replied' : 'nomatch';
        if (!isWired(n.id, answerHandle)) {
          warnings.push(F(n.id, 'NO_FALLBACK',
            answerHandle === 'replied'
              ? 'Nothing happens after the customer answers this question.'
              : 'Nothing happens if the customer types something instead of tapping.',
            `Wire the "${answerHandle === 'replied' ? 'They reply' : 'Any other reply'}" row.`, answerHandle));
        }
        if (!isWired(n.id, 'timeout')) {
          warnings.push(F(n.id, 'NO_TIMEOUT',
            'Nothing happens if the customer never replies — the commonest outcome.',
            'Wire the "No reply in 24h" row.', 'timeout'));
        }
        // A nomatch pointing back at its own source re-asks forever and burns
        // the 24h window doing it.
        const selfLoop = edges.find(e => e.from === n.id && e.fromHandle === 'nomatch' && e.to === n.id);
        if (selfLoop) {
          blocking.push(F(n.id, 'SELF_LOOP',
            'The "Any other reply" branch points back at this same step, which loops forever.',
            'Point it at a step that re-asks differently, or at a human handoff.'));
        }
      }

      if (n.messageMode === 'template') {
        const tpl = templatesById[String(n.templateId)];
        if (!n.templateId) {
          blocking.push(F(n.id, 'TEMPLATE_MISSING', 'This step has no template selected.', 'Pick a template.'));
        } else if (ctx.templatesById && !tpl) {
          blocking.push(F(n.id, 'TEMPLATE_UNAVAILABLE',
            'The template this step sends no longer exists.', 'Pick another template.'));
        } else if (tpl && String(tpl.status).toUpperCase() !== 'APPROVED') {
          blocking.push(F(n.id, 'TEMPLATE_NOT_APPROVED',
            `Template "${tpl.name}" is ${String(tpl.status).toLowerCase()}, so Meta will refuse it.`,
            'Wait for approval, or choose an approved template.'));
        }
        // A branch drawn off a link/call button can never fire — Meta sends no
        // inbound message for those taps.
        asArray(n.buttons).forEach((b, i) => {
          if (!isQuickReply(b) && isWired(n.id, `btn:${i}`)) {
            blocking.push(F(n.id, 'URL_BUTTON_BRANCH',
              `"${txt(b.text) || `Button ${i + 1}`}" is a link or call button. WhatsApp never tells us when it is tapped, so this branch can never run.`,
              'Delete that connection and continue from "Next step" instead.', `btn:${i}`));
          }
        });
      }

      if (n.messageMode === 'direct') {
        const dt = n.directType || 'text';
        const body = txt(dd.body);

        if (dt === 'quick_reply') {
          const btns = asArray(dd.buttons);
          if (!body) blocking.push(F(n.id, 'META_BODY_REQUIRED', 'Meta requires body text on a button message.', 'Write the question.'));
          if (btns.filter(b => txt(b && (b.title || b.text))).length === 0) {
            blocking.push(F(n.id, 'META_BUTTON_REQUIRED', 'At least one button needs a label.', 'Type a label on each button.'));
          }
          if (btns.length > CAPS.buttons) {
            blocking.push(F(n.id, 'META_LIMIT_BUTTONS',
              `WhatsApp allows ${CAPS.buttons} buttons and this step has ${btns.length}.`,
              'Remove the extras, or switch to a list, which allows 10.'));
          }
          const seen = new Set();
          btns.forEach((b, i) => {
            const t = txt(b && (b.title || b.text));
            if (t.length > CAPS.buttonTitle) {
              blocking.push(F(n.id, 'META_LIMIT_BUTTON_TITLE',
                `Button ${i + 1} is ${t.length} characters; WhatsApp allows ${CAPS.buttonTitle}.`, 'Shorten it.'));
            }
            const k = t.toLowerCase();
            if (k && seen.has(k)) {
              blocking.push(F(n.id, 'META_DUPLICATE_BUTTON',
                `Two buttons are both labelled "${t}". WhatsApp requires them to be different, and the flow could not tell them apart either.`,
                'Rename one of them.'));
            }
            seen.add(k);
          });
        }

        if (dt === 'list') {
          const sections = asArray(dd.sections);
          const rows = sections.flatMap(s => asArray(s && s.rows));
          if (!body) blocking.push(F(n.id, 'META_BODY_REQUIRED', 'Meta requires body text on a list message.', 'Write the question.'));
          if (rows.filter(r => txt(r && r.title)).length === 0) {
            blocking.push(F(n.id, 'META_ROW_REQUIRED', 'The list has no options with a label.', 'Add at least one option.'));
          }
          // ⚠ 10 rows TOTAL across the whole message, not per section — the cap
          // people most often get wrong because it reads like a per-section one.
          if (rows.length > CAPS.listRows) {
            blocking.push(F(n.id, 'META_LIMIT_LIST_ROWS',
              `This list has ${rows.length} options across all sections; WhatsApp allows ${CAPS.listRows} in total.`,
              'Remove some, or split the menu across two steps.'));
          }
          if (sections.length > CAPS.listSections) {
            blocking.push(F(n.id, 'META_LIMIT_LIST_SECTIONS',
              `This list has ${sections.length} sections; WhatsApp allows ${CAPS.listSections}.`, 'Merge some sections.'));
          }
          rows.forEach((r, i) => {
            if (txt(r && r.title).length > CAPS.listTitle) {
              blocking.push(F(n.id, 'META_LIMIT_ROW_TITLE',
                `Option ${i + 1} is longer than ${CAPS.listTitle} characters.`, 'Shorten it.'));
            }
            if (txt(r && r.description).length > CAPS.listDescription) {
              blocking.push(F(n.id, 'META_LIMIT_ROW_DESC',
                `Option ${i + 1}'s description is longer than ${CAPS.listDescription} characters.`, 'Shorten it.'));
            }
          });
        }

        if (dt === 'cta_url') {
          if (!body) blocking.push(F(n.id, 'META_BODY_REQUIRED', 'Meta requires body text on a call-to-action.', 'Write the message.'));
          const u = txt(dd.url);
          if (!u) blocking.push(F(n.id, 'CTA_URL_REQUIRED', 'The call-to-action has no link.', 'Paste the link.'));
          else if (!/^https?:\/\//i.test(u)) {
            blocking.push(F(n.id, 'CTA_URL_INVALID', 'The link must start with http:// or https://.', 'Fix the link.'));
          }
        }

        if (dt === 'location_request' && !body) {
          blocking.push(F(n.id, 'META_BODY_REQUIRED', 'Meta requires body text when asking for a location.', 'Write what you are asking for.'));
        }

        if (dt === 'location') {
          const lat = txt(dd.latitude), lon = txt(dd.longitude);
          if (!lat || !lon || Number.isNaN(Number(lat)) || Number.isNaN(Number(lon))) {
            blocking.push(F(n.id, 'LOCATION_INVALID', 'The location needs a numeric latitude and longitude.', 'Fill both in.'));
          }
        }

        if (dt === 'contact' && !txt(dd.name) && !txt(dd.first_name)) {
          blocking.push(F(n.id, 'CONTACT_NAME_REQUIRED', 'A contact card needs a name.', 'Add the name.'));
        }

        if (['image', 'video', 'audio', 'document', 'sticker'].includes(dt) && !dd.mediaLibraryId && !txt(dd.url)) {
          blocking.push(F(n.id, 'MEDIA_REQUIRED', `This ${dt} step has no file selected.`, 'Pick one from the Media Library.'));
        }

        if (dt === 'text' && !body) {
          blocking.push(F(n.id, 'TEXT_REQUIRED', 'This step has no message text.', 'Write the message.'));
        }

        if (body.length > (dt === 'text' || dt === 'link' ? CAPS.text : CAPS.interactiveBody)) {
          blocking.push(F(n.id, 'META_LIMIT_BODY',
            `The message is ${body.length} characters; WhatsApp allows ${dt === 'text' || dt === 'link' ? CAPS.text : CAPS.interactiveBody}.`,
            'Shorten it.'));
        }
        if (txt(dd.header).length > CAPS.headerText) {
          blocking.push(F(n.id, 'META_LIMIT_HEADER', `The header is longer than ${CAPS.headerText} characters.`, 'Shorten it.'));
        }
        if (txt(dd.footer).length > CAPS.footer) {
          blocking.push(F(n.id, 'META_LIMIT_FOOTER', `The footer is longer than ${CAPS.footer} characters.`, 'Shorten it.'));
        }
      }
    }

    // Two edges on one handle: the engine follows candidateEdges[0] and drops
    // the rest with nothing on the canvas saying so.
    handles.forEach(h => {
      const same = edges.filter(e => e.from === n.id && (e.fromHandle || 'default') === h && e.to);
      if (same.length > 1) {
        warnings.push(F(n.id, 'FANOUT_TRUNCATED',
          `"${labelForHandle(n, h)}" is connected to ${same.length} steps, but only the first will ever run.`,
          'Remove the extra connections.', h));
      }
    });
  });

  // ── Reachability + escalation ─────────────────────────────────────────
  if (triggers.length > 0) {
    const reachable = new Set();
    const stack = [triggers[0].id];
    while (stack.length) {
      const id = stack.pop();
      if (!id || reachable.has(id)) continue;
      reachable.add(id);
      edges.filter(e => e.from === id && e.to).forEach(e => stack.push(e.to));
    }
    nodes.forEach(n => {
      if (n.type === 'trigger') return;
      if (!reachable.has(n.id)) {
        warnings.push(F(n.id, 'UNREACHABLE_NODE',
          'Nothing leads to this step, so it will never run.',
          'Connect it, or delete it.'));
      }
    });
  }

  return { ok: blocking.length === 0, blocking, warnings };
}

/** Human label for a handle, so a finding reads like the canvas. */
function labelForHandle(n, h) {
  if (h === 'yes') return 'Matched';
  if (h === 'no') return 'Not matched';
  if (h === 'paid') return 'Paid';
  if (h === 'unpaid') return 'Not paid';
  if (h === 'shared') return 'Location shared';
  if (h === 'nomatch') return 'Any other reply';
  if (h === 'timeout') return 'No reply';
  if (h === 'default') return 'Next step';
  const dd = n.directData || {};
  let m = /^btn:(\d+)$/.exec(h);
  if (m) {
    const i = Number(m[1]);
    const b = n.messageMode === 'direct' ? asArray(dd.buttons)[i] : asArray(n.buttons)[i];
    return txt(b && (b.title || b.text)) || `Button ${i + 1}`;
  }
  m = /^row:(\d+):(\d+)$/.exec(h);
  if (m) {
    const r = asArray(asArray(dd.sections)[Number(m[1])] && asArray(dd.sections)[Number(m[1])].rows)[Number(m[2])];
    return txt(r && r.title) || `Option ${Number(m[2]) + 1}`;
  }
  return h;
}

module.exports = { validateFlow, expectedHandles, labelForHandle, CAPS };
