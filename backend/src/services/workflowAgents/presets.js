// Ready-made workflow agents. Creating an agent COPIES a preset's config into a new
// agent + version 1; editing the agent never changes the preset. Rows are upserted
// into workflow_agent_presets at boot so the API serves the same thing the UI shows.

const pool = require('../../db');

const READ_TOOLS = ['get_workspace_context', 'list_leads', 'get_lead_profile', 'get_conversation', 'search_messages', 'get_active_conversations', 'get_engagement_metrics', 'get_funnel_summary', 'get_stage_history', 'get_sales', 'get_outstanding_balances', 'get_ad_performance', 'get_flow_runs', 'get_broadcast_results', 'get_rep_directory', 'get_previous_outputs', 'get_feedback', 'read_memory'];
const DRAFT_TOOLS = ['draft_whatsapp_reply', 'propose_memory'];
const WRITE_TOOLS = ['tag_contact', 'set_funnel_stage', 'assign_owner', 'add_internal_note', 'create_follow_up_task', 'send_whatsapp_message', 'trigger_automation', 'notify_rep'];
const ALL_TOOLS = [...READ_TOOLS, ...DRAFT_TOOLS, ...WRITE_TOOLS];

/** Every tool listed; `on` are enabled, the rest present but off (so the UI shows them). */
function toolConfig(on, extra = {}) {
  return ALL_TOOLS.map(key => ({
    tool_key: key,
    enabled: on.includes(key),
    permission: WRITE_TOOLS.includes(key) ? 'write' : DRAFT_TOOLS.includes(key) ? 'draft' : 'read',
    params_override: extra[key]?.params_override || {},
    description: extra[key]?.description || null,
  }));
}

const BLOCKERS = ['none', 'price', 'product', 'brand_trust', 'timing', 'competitor', 'not_decision_maker', 'no_response', 'wrong_lead'];

// ── Lead Signal Agent (brief §9) ─────────────────────────────────────────────

const LEAD_SIGNAL_INSTRUCTIONS = `# Goal
Every morning, find the leads most likely to buy in the next 72 hours, so each rep knows exactly who to contact first, why, and what to say. Also flag leads that are slipping away.

# How to work
1. Call get_workspace_context and read_memory.
2. Call get_active_conversations for the last 14 days and get_engagement_metrics for those leads. Include leads with no activity for 2–7 days who reached an advanced stage (they are "slipping").
3. Shortlist up to 60 leads using the metrics. Then read get_conversation for each shortlisted lead (voice-note transcripts included) and get_lead_profile when stage/payment context matters.
4. Score each lead with the rubric below. Use get_previous_outputs so you don't repeat a lead with no new activity since yesterday unless it is still hot.
5. For every lead in the final list, call draft_whatsapp_reply to suggest the next message in the lead's language.
6. Propose tag_contact ("hot_signal" / "slipping") and create_follow_up_task for hot leads. Do not send messages.
7. If you notice a durable pattern (e.g. "leads asking about weekend batch convert well"), call propose_memory.

# Signals (evidence you must look for)
Positive buying signals:
- Asks price, fees, EMI, discount, payment link, UPI, "how to pay", batch start date, timings, "can I join today".
- Sends a voice note (higher intent than text); multiple voice notes = stronger.
- Replies quickly (lead median reply time < 10 min) and frequently (≥ 3 inbound messages in 48h).
- Returns after silence on their own.
- Reached stage level test completed / offer sent / fees details, or tapped "Yes / Interested / Pay now".
- Mentions a concrete need or deadline (job interview, exam, travel, "next week").
- Shares screenshots of payment or asks for confirmation.
- Came from an ad and engaged beyond the first auto-message.

Negative signals and reasons they don't buy (classify the reason):
- price: "too costly", asks only for discount and goes quiet.
- product: doubts about course content, level, schedule, language, format.
- brand/trust: "is this genuine", refund worries, bad review mention.
- timing: "later", "next month", "after exam".
- competitor: mentions another institute or free option.
- not_decision_maker: "ask my father/husband".
- no_response: stopped replying after the offer.
- wrong_lead: not interested / wrong number / child enquiry for adult course, etc.

Rep-side risk signals:
- Lead's last message unanswered for > 2 working hours.
- Rep first response > 30 min on a hot message.
- Promised callback not done.

# Scoring rubric (0–100)
- Intent language (price/payment/start date/join): up to 30
- Engagement (frequency, voice notes, reply speed, returning): up to 25
- Funnel stage progress: up to 20
- Recency (activity in last 24h = full, 72h = half): up to 15
- Fit (product label matches, need/deadline stated): up to 10
- Subtract up to 30 for strong negative reasons (wrong_lead −30, competitor chosen −20, timing far −15, price objection unresolved −10).
Labels: hot ≥ 70, warm 45–69, watch < 45 but slipping from an advanced stage.
Adjust weights using pinned memory and rep feedback (leads marked "wrong" teach you what to down-weight).

# Output rules
- Max 10 leads per rep, ranked. Plus up to 5 "slipping" leads per rep.
- Each lead: one-sentence reason in plain words, 1–3 exact evidence quotes with message_id, top buy signal, main blocker (reason category) if any, best time to contact (from their past reply times), and the suggested message.
- A team summary: counts by label, top 3 reasons they don't buy this week with counts and example quotes, reps with unanswered hot leads.
- Put anything you could not check in data_gaps.`;

const LEAD_SIGNAL_SCHEMA = {
  type: 'object',
  required: ['run_date', 'reps', 'team_summary', 'data_gaps'],
  properties: {
    run_date: { type: 'string' },
    reps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['rep_id', 'rep_name', 'leads'],
        properties: {
          rep_id: { type: 'string' },
          rep_name: { type: 'string' },
          leads: {
            type: 'array',
            items: {
              type: 'object',
              required: ['contact_id', 'name_masked', 'stage', 'score', 'label', 'reason', 'evidence', 'suggested_message'],
              properties: {
                contact_id: { type: 'string' },
                name_masked: { type: 'string' },
                stage: { type: 'string' },
                product: { type: 'string' },
                score: { type: 'integer', minimum: 0, maximum: 100 },
                label: { enum: ['hot', 'warm', 'watch', 'slipping'] },
                reason: { type: 'string' },
                top_signal: { type: 'string' },
                blocker: { enum: BLOCKERS },
                evidence: {
                  type: 'array', maxItems: 3,
                  items: {
                    type: 'object', required: ['message_id', 'quote', 'at'],
                    properties: { message_id: { type: 'string' }, quote: { type: 'string' }, at: { type: 'string' }, type: { enum: ['text', 'voice_note', 'button_reply', 'media_caption'] } },
                  },
                },
                best_contact_time: { type: 'string' },
                window_open: { type: 'boolean' },
                suggested_message: { type: 'string' },
                suggested_template: { type: ['string', 'null'] },
                unanswered_minutes: { type: ['integer', 'null'] },
              },
            },
          },
        },
      },
    },
    team_summary: {
      type: 'object',
      properties: {
        hot: { type: 'integer' }, warm: { type: 'integer' }, watch: { type: 'integer' }, slipping: { type: 'integer' },
        top_reasons_not_buying: { type: 'array', items: { type: 'object', properties: { reason: { type: 'string' }, count: { type: 'integer' }, example_quote: { type: 'string' } } } },
        reps_with_unanswered_hot_leads: { type: 'array', items: { type: 'string' } },
      },
    },
    data_gaps: { type: 'array', items: { type: 'string' } },
  },
};

const LEAD_SIGNAL = {
  preset_key: 'lead_signal',
  name: 'Lead Signal Agent',
  description: 'Every morning, hands each rep a ranked list of the leads most likely to buy today, with the reason, the evidence and a suggested next message.',
  icon: 'radar',
  sort_order: 1,
  config: {
    agent: { model: 'claude-opus-5', effort: 'high', temperature: 0.2, max_tool_calls: 120, max_tokens_per_run: 1500000, max_output_tokens: 32000, monthly_budget_inr: null, auto_accept_memory: false },
    instructions: LEAD_SIGNAL_INSTRUCTIONS,
    output_schema: LEAD_SIGNAL_SCHEMA,
    tool_config: toolConfig([
      'get_workspace_context', 'get_active_conversations', 'get_engagement_metrics', 'get_conversation', 'get_lead_profile', 'get_stage_history', 'get_rep_directory', 'get_previous_outputs', 'get_feedback', 'read_memory',
      'draft_whatsapp_reply', 'propose_memory',
      'tag_contact', 'create_follow_up_task', 'notify_rep',
    ]),
    data_scope: {
      business_numbers: ['all'], teams: ['all'], rep_user_ids: ['all'], funnel_stages: ['all'], sources: ['all'],
      chat_types: ['lead_bot', 'lead_rep', 'voice_note', 'broadcast', 'ad_referral', 'internal_note'],
      lookback_days: 14, mask_pii: true, exclude_opted_out: true, exclude_tags: ['do_not_contact', 'test'],
      won_stages: 'exclude_unless_outstanding',
    },
    triggers: [
      { type: 'schedule', cron: '0 8 * * *', timezone: 'Asia/Kolkata', enabled: true },
      { type: 'event', event: 'message.inbound', filters: { message_type: ['voice_note', 'text'], stage_not_won: true }, debounce_minutes: 15, enabled: true },
      { type: 'manual', enabled: true },
    ],
    destinations: [
      { type: 'results_inbox' },
      { type: 'rep_worklist', split_by: 'owner_rep' },
      { type: 'whatsapp_template', to: 'rep', template: 'daily_lead_list', send_at: '08:05', enabled: true },
      { type: 'telegram', chat_id: '', format: 'summary', enabled: false },
    ],
    approval_rules: { approvers: ['admin', 'team_lead'], expire_hours: 24, rep_can_send_suggested: false },
    runtime: { batching: { enabled: false, batch_size: 25, max_candidates: 150 } },
    memory: [
      { kind: 'pinned', title: 'Products and pricing', content: 'Our products: [fill from product labels]. Typical price range: [₹__]. EMI available: [yes/no].' },
      { kind: 'pinned', title: 'Voice notes signal intent', content: 'Leads who send a voice note in their first 24 hours convert much more often; weight voice notes higher.' },
      { kind: 'pinned', title: 'Weekend and evening batches', content: 'Weekend and evening batch questions are strong intent for working professionals.' },
      { kind: 'pinned', title: 'Discount policy', content: 'Do not suggest discounts above [__]%; suggest EMI or a free demo instead.' },
      { kind: 'pinned', title: 'Message style', content: 'Reply in the language the lead last used. Keep suggested messages under 60 words, friendly, no pressure.' },
    ],
  },
};

// ── Follow-on presets (brief §10): same framework, config only ────────────────

const REASON_FINDER = {
  preset_key: 'reason_finder',
  name: 'Reason Finder',
  description: 'Weekly: why leads did not buy — price, product, trust, timing, competitor — with counts, the trend versus last week and real quotes.',
  icon: 'search-check',
  sort_order: 2,
  config: {
    agent: { model: 'claude-opus-5', effort: 'high', temperature: 0.2, max_tool_calls: 80, max_tokens_per_run: 1000000, max_output_tokens: 16000, monthly_budget_inr: null, auto_accept_memory: false },
    instructions: `# Goal
Explain why leads did not buy in the last 7 days, so sales material and ad creative can answer the real objections.

# How to work
1. Call get_workspace_context, read_memory and get_previous_outputs (n=1) for last week's counts.
2. Use search_messages for objection language (price, costly, discount, later, next month, genuine, refund, other institute, free, ask my father/husband) and list_leads for leads that went quiet or moved to cold/lost this week.
3. Read get_conversation for the leads you classify. Classify each lead's main reason: price, product, brand_trust, timing, competitor, not_decision_maker, no_response, wrong_lead.
4. Count each reason, compare with last week's counts, and pick 2–3 exact quotes per reason with message_id.
5. Suggest one sales-material answer and one ad-creative angle per top reason.

# Rules
- A lead counts once, under its strongest reason.
- Do not infer a reason without a quote; use no_response only when the lead stopped replying after an offer.`,
    output_schema: {
      type: 'object',
      required: ['week_ending', 'reasons', 'data_gaps'],
      properties: {
        week_ending: { type: 'string' },
        leads_classified: { type: 'integer' },
        reasons: {
          type: 'array',
          items: {
            type: 'object', required: ['reason', 'count', 'quotes'],
            properties: {
              reason: { enum: BLOCKERS.filter(b => b !== 'none') },
              count: { type: 'integer' },
              change_vs_last_week: { type: ['integer', 'null'] },
              quotes: { type: 'array', maxItems: 3, items: { type: 'object', required: ['message_id', 'quote', 'contact_id'], properties: { message_id: { type: 'string' }, quote: { type: 'string' }, contact_id: { type: 'string' } } } },
              sales_material_answer: { type: 'string' },
              ad_creative_angle: { type: 'string' },
            },
          },
        },
        data_gaps: { type: 'array', items: { type: 'string' } },
      },
    },
    tool_config: toolConfig(['get_workspace_context', 'read_memory', 'get_previous_outputs', 'search_messages', 'list_leads', 'get_conversation', 'get_lead_profile', 'get_stage_history', 'get_funnel_summary', 'propose_memory']),
    data_scope: { chat_types: ['lead_bot', 'lead_rep', 'voice_note', 'ad_referral'], lookback_days: 14, mask_pii: true, exclude_opted_out: true, exclude_tags: ['test'], won_stages: 'exclude' },
    triggers: [{ type: 'schedule', cron: '0 9 * * 1', timezone: 'Asia/Kolkata', enabled: true }, { type: 'manual', enabled: true }],
    destinations: [{ type: 'results_inbox' }, { type: 'telegram', chat_id: '', format: 'summary', enabled: false }],
    approval_rules: { approvers: ['admin'], expire_hours: 24 },
    runtime: { batching: { enabled: false, batch_size: 25, max_candidates: 150 } },
    memory: [],
  },
};

const FOLLOW_UP_DRAFTER = {
  preset_key: 'follow_up_drafter',
  name: 'Follow-up Drafter',
  description: 'When a lead at an advanced stage goes quiet for 48 hours, drafts a re-engagement message or template for approval.',
  icon: 'message-square-reply',
  sort_order: 3,
  config: {
    agent: { model: 'claude-opus-5', effort: 'medium', temperature: 0.2, max_tool_calls: 20, max_tokens_per_run: 300000, max_output_tokens: 8000, monthly_budget_inr: null, auto_accept_memory: false },
    instructions: `# Goal
The lead in the trigger has gone quiet at an advanced stage. Draft one re-engagement message a rep can approve.

# How to work
1. Call get_lead_profile and get_conversation for the lead in the trigger payload.
2. Find the last open question or objection. If they already said no, return action "none" with the reason.
3. Call draft_whatsapp_reply with a message under 60 words in the lead's language that answers that point. If the 24-hour window is closed, pick an approved template from the draft result and fill its variables.
4. Propose send_whatsapp_message with that text or template. It will wait for approval.`,
    output_schema: {
      type: 'object',
      required: ['contact_id', 'action', 'reason', 'data_gaps'],
      properties: {
        contact_id: { type: 'string' },
        action: { enum: ['message_proposed', 'template_proposed', 'none'] },
        reason: { type: 'string' },
        last_open_point: { type: 'string' },
        evidence: { type: 'array', maxItems: 3, items: { type: 'object', required: ['message_id', 'quote'], properties: { message_id: { type: 'string' }, quote: { type: 'string' } } } },
        suggested_message: { type: ['string', 'null'] },
        suggested_template: { type: ['string', 'null'] },
        data_gaps: { type: 'array', items: { type: 'string' } },
      },
    },
    tool_config: toolConfig(['get_workspace_context', 'get_lead_profile', 'get_conversation', 'read_memory', 'draft_whatsapp_reply', 'send_whatsapp_message']),
    data_scope: { chat_types: ['lead_bot', 'lead_rep', 'voice_note', 'broadcast'], lookback_days: 30, mask_pii: true, exclude_opted_out: true, exclude_tags: ['do_not_contact', 'test'], won_stages: 'exclude', funnel_stages: ['engaged', 'hot'] },
    triggers: [{ type: 'event', event: 'lead.quiet', filters: { hours_since_last_inbound: 48, stage_in: ['engaged', 'hot'] }, debounce_minutes: 0, enabled: true }, { type: 'manual', enabled: true }],
    destinations: [{ type: 'results_inbox' }],
    approval_rules: { approvers: ['admin', 'team_lead', 'owner_rep'], expire_hours: 24 },
    runtime: {},
    memory: [],
  },
};

const RESPONSE_TIME_WATCHER = {
  preset_key: 'response_time_watcher',
  name: 'Response-Time Watcher',
  description: 'Every 2 hours in working hours: flags unanswered hot messages per rep and notifies the team lead.',
  icon: 'timer',
  sort_order: 4,
  config: {
    agent: { model: 'claude-opus-5', effort: 'low', temperature: 0.2, max_tool_calls: 20, max_tokens_per_run: 300000, max_output_tokens: 8000, monthly_budget_inr: null, auto_accept_memory: false },
    instructions: `# Goal
Find customer messages that are still waiting for a reply, and tell each rep's team lead which ones matter.

# How to work
1. Call get_active_conversations for the last 24 hours and get_rep_directory.
2. For leads with unanswered_inbound > 0 for more than 30 working minutes, read the unanswered messages with get_conversation.
3. Mark a lead urgent when the unanswered message shows buying intent (fees, payment, joining, timings) or the lead is at an advanced stage.
4. For each rep with urgent leads, propose notify_rep to their team lead with the lead names and how long they have waited.`,
    output_schema: {
      type: 'object',
      required: ['checked_at', 'reps', 'data_gaps'],
      properties: {
        checked_at: { type: 'string' },
        reps: { type: 'array', items: { type: 'object', required: ['rep_id', 'rep_name', 'unanswered'], properties: { rep_id: { type: 'string' }, rep_name: { type: 'string' }, unanswered: { type: 'array', items: { type: 'object', required: ['contact_id', 'waiting_minutes', 'urgent'], properties: { contact_id: { type: 'string' }, name_masked: { type: 'string' }, waiting_minutes: { type: 'integer' }, urgent: { type: 'boolean' }, message_id: { type: 'string' }, quote: { type: 'string' } } } } } } },
        data_gaps: { type: 'array', items: { type: 'string' } },
      },
    },
    tool_config: toolConfig(['get_workspace_context', 'get_active_conversations', 'get_rep_directory', 'get_conversation', 'get_engagement_metrics', 'notify_rep']),
    data_scope: { chat_types: ['lead_bot', 'lead_rep', 'voice_note'], lookback_days: 2, mask_pii: true, exclude_opted_out: true, exclude_tags: ['test'], won_stages: 'include' },
    triggers: [{ type: 'schedule', cron: '0 10-18/2 * * 1-6', timezone: 'Asia/Kolkata', enabled: true }, { type: 'manual', enabled: true }],
    destinations: [{ type: 'results_inbox' }],
    approval_rules: { approvers: ['admin', 'team_lead'], expire_hours: 4 },
    runtime: {},
    memory: [],
  },
};

const AD_TO_CHAT_QUALITY = {
  preset_key: 'ad_to_chat_quality',
  name: 'Ad-to-Chat Quality',
  description: 'Weekly, per ad: the quality of conversations it starts — intent share, wrong-lead share, common questions — beside its spend including GST.',
  icon: 'megaphone',
  sort_order: 5,
  config: {
    agent: { model: 'claude-opus-5', effort: 'high', temperature: 0.2, max_tool_calls: 80, max_tokens_per_run: 1000000, max_output_tokens: 16000, monthly_budget_inr: null, auto_accept_memory: false },
    instructions: `# Goal
For each ad that started conversations in the last 7 days, judge the quality of those conversations, beside what the ad cost.

# How to work
1. Call get_ad_performance for the last 7 days.
2. For each ad with attributed leads, read up to 10 of those leads' conversations (get_conversation; the lead profile shows which ad brought them).
3. Per ad: share of leads showing buying intent, share of wrong leads, the 3 most common questions (with quotes), and cost per attributed lead including GST.
4. Never state revenue per ad: it is not attributable here.`,
    output_schema: {
      type: 'object',
      required: ['week_ending', 'ads', 'data_gaps'],
      properties: {
        week_ending: { type: 'string' },
        ads: { type: 'array', items: { type: 'object', required: ['ad_id', 'leads_read', 'intent_share_pct', 'wrong_lead_share_pct'], properties: { ad_id: { type: 'string' }, ad_name: { type: ['string', 'null'] }, spend_incl_gst: { type: ['number', 'null'] }, leads_attributed: { type: 'integer' }, leads_read: { type: 'integer' }, intent_share_pct: { type: 'number' }, wrong_lead_share_pct: { type: 'number' }, common_questions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, count: { type: 'integer' }, message_id: { type: 'string' }, quote: { type: 'string' } } } }, verdict: { type: 'string' } } } },
        data_gaps: { type: 'array', items: { type: 'string' } },
      },
    },
    tool_config: toolConfig(['get_workspace_context', 'get_ad_performance', 'list_leads', 'get_lead_profile', 'get_conversation', 'search_messages']),
    data_scope: { chat_types: ['lead_bot', 'lead_rep', 'voice_note', 'ad_referral'], lookback_days: 7, mask_pii: true, exclude_opted_out: false, exclude_tags: ['test'], won_stages: 'include' },
    triggers: [{ type: 'schedule', cron: '0 10 * * 1', timezone: 'Asia/Kolkata', enabled: true }, { type: 'manual', enabled: true }],
    destinations: [{ type: 'results_inbox' }],
    approval_rules: { approvers: ['admin'], expire_hours: 24 },
    runtime: {},
    memory: [],
  },
};

const PAYMENT_CHASER = {
  preset_key: 'payment_chaser',
  name: 'Payment Chaser',
  description: 'Daily: customers with an outstanding balance, each with a polite reminder draft for approval.',
  icon: 'wallet',
  sort_order: 6,
  config: {
    agent: { model: 'claude-opus-5', effort: 'medium', temperature: 0.2, max_tool_calls: 60, max_tokens_per_run: 600000, max_output_tokens: 16000, monthly_budget_inr: null, auto_accept_memory: false },
    instructions: `# Goal
Help reps collect balances politely.

# How to work
1. Call get_outstanding_balances.
2. For each customer, read get_conversation to see whether they already promised a date or asked for time.
3. Call draft_whatsapp_reply with a short, polite reminder in their language (or pick an approved template when the window is closed).
4. Skip anyone who promised a date that has not passed yet, and say so.
5. Propose send_whatsapp_message for the reminders; each waits for approval.`,
    output_schema: {
      type: 'object',
      required: ['run_date', 'customers', 'data_gaps'],
      properties: {
        run_date: { type: 'string' },
        total_outstanding_display: { type: 'string' },
        customers: { type: 'array', items: { type: 'object', required: ['contact_id', 'outstanding_display', 'action'], properties: { contact_id: { type: 'string' }, name_masked: { type: 'string' }, product: { type: ['string', 'null'] }, outstanding_display: { type: 'string' }, action: { enum: ['reminder_proposed', 'skipped_promised_date', 'skipped_other'] }, note: { type: 'string' }, suggested_message: { type: ['string', 'null'] }, suggested_template: { type: ['string', 'null'] } } } },
        data_gaps: { type: 'array', items: { type: 'string' } },
      },
    },
    tool_config: toolConfig(['get_workspace_context', 'get_outstanding_balances', 'get_lead_profile', 'get_conversation', 'draft_whatsapp_reply', 'send_whatsapp_message']),
    data_scope: { chat_types: ['lead_bot', 'lead_rep', 'voice_note', 'internal_note'], lookback_days: 30, mask_pii: true, exclude_opted_out: true, exclude_tags: ['do_not_contact', 'test'], won_stages: 'include' },
    triggers: [{ type: 'schedule', cron: '30 10 * * 1-6', timezone: 'Asia/Kolkata', enabled: true }, { type: 'manual', enabled: true }],
    destinations: [{ type: 'results_inbox' }],
    approval_rules: { approvers: ['admin', 'team_lead'], expire_hours: 24 },
    runtime: {},
    memory: [],
  },
};

const PRESETS = [LEAD_SIGNAL, REASON_FINDER, FOLLOW_UP_DRAFTER, RESPONSE_TIME_WATCHER, AD_TO_CHAT_QUALITY, PAYMENT_CHASER];

async function syncPresets() {
  for (const p of PRESETS) {
    await pool.query(
      `INSERT INTO coexistence.workflow_agent_presets (preset_key, name, description, icon, sort_order, config, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (preset_key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, icon = EXCLUDED.icon,
         sort_order = EXCLUDED.sort_order, config = EXCLUDED.config, updated_at = NOW()`,
      [p.preset_key, p.name, p.description, p.icon, p.sort_order, JSON.stringify(p.config)]);
  }
}

/** A blank agent's starting config. */
function blankConfig() {
  return {
    agent: { model: 'claude-opus-5', effort: 'high', temperature: 0.2, max_tool_calls: 40, max_tokens_per_run: 200000, max_output_tokens: 16000, monthly_budget_inr: null, auto_accept_memory: false },
    instructions: '# Goal\n\n# How to work\n1. Call get_workspace_context.\n\n# Output rules\n- Put anything you could not check in data_gaps.',
    output_schema: { type: 'object', required: ['summary', 'data_gaps'], properties: { summary: { type: 'string' }, data_gaps: { type: 'array', items: { type: 'string' } } } },
    tool_config: toolConfig(['get_workspace_context', 'read_memory']),
    data_scope: {},
    triggers: [{ type: 'manual', enabled: true }],
    destinations: [{ type: 'results_inbox' }],
    approval_rules: { approvers: ['admin'], expire_hours: 24 },
    runtime: {},
    memory: [],
  };
}

module.exports = { PRESETS, syncPresets, blankConfig, toolConfig, LEAD_SIGNAL_SCHEMA, LEAD_SIGNAL_INSTRUCTIONS, ALL_TOOLS, BLOCKERS };
