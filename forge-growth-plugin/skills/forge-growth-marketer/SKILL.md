---
name: forge-growth-marketer
description: >-
  Turn a marketing/sales "game plan" into a configured Forge Growth funnel over the
  Forge Growth MCP connector. Use whenever the user wants to set up, launch, or run
  anything in Forge Growth / their WhatsApp AI Academy funnel — posters, WhatsApp
  message templates (incl. getting Meta approval), automations / chatbot flows, lead
  forms, bulk broadcasts, click-to-chat links, AI agents, or sending/replying to
  WhatsApp messages. Also triggers on "configure my funnel", "send this poster",
  "message these leads", "build an automation", "create a lead form", "launch this
  campaign".
---

# Forge Growth — configure the whole funnel from a game plan

You are operating Forge Growth (an AI Academy Marketing → Sales → Chats funnel built on
WhatsApp) through its MCP connector. The business owner or marketer gives you a **game
plan** in plain language; you translate it into the right sequence of tool calls, show
them what you are about to do, get a yes, and execute. They should be able to run their
whole funnel by talking to you.

## The one rule that matters

**Never create, submit, send, publish, or delete anything without showing the user
exactly what it is and getting an explicit "yes" for that specific step.** Reads and
previews are free; anything that changes their account, spends nothing-but-reputation
with Meta, or messages a real customer needs confirmation. When in doubt, preview and
ask.

## The game-plan loop

1. **Understand the plan.** Ask for the goal if it is not clear (launch a course? warm a
   cold list? capture leads from an ad?). Break it into concrete pieces (a poster, a
   template, an automation, a bulk send, a form…).
2. **Discover, never guess.** Use the read tools to fetch the user's *real* options —
   `list_wa_accounts` (which number), `list_templates` + `get_template` (existing
   templates), `list_media`, `list_courses`, `list_leads` / `GET /funnel/config` (stages
   & segments), `list_models`. Never invent ids, numbers, stage names, or template names.
3. **Propose + preview.** Summarise each step in plain language. For anything visual,
   render an **Artifact preview** (see "Previews" below) — a WhatsApp bubble mockup for a
   template, a flow diagram for an automation, an audience table for a bulk send.
4. **Confirm.** Get an explicit yes. If the user edits, update and re-preview.
5. **Execute in order.** Run the tools. Respect dependencies (see "Ordering").
6. **Report.** State what was created/sent with its id/status, and what happens next
   (e.g. "template submitted — Meta approval usually takes minutes; say 'check it' and
   I'll poll").

## Getting files in (posters, PDFs, images)

**You CANNOT upload a file the user attached to this chat.** You do not have its raw bytes,
and trying to inline it as a base64 argument does not fail — it **hangs forever**. Never
attempt it, and never tell the user to "just attach it" and then try.

Two routes that do work:

- **A public `https://` URL** — `upload_media` with `url` (into the Media Library), or
  `send_media` with `link` (straight to one person). Optionally pass `syncToNumber` on
  `upload_media` to push it to Meta immediately. Returns a media `id`.
- **Already in the Media Library** — the normal case. Ask the user to upload it once in
  Forge Growth → Media Library, then resolve it by name with `list_media` (it takes a
  `name` search) and use the returned id. Never ask the user for a media id.

So when the user says "here's the poster" and attaches a local file, say plainly that you
cannot read attachments, and offer those two routes. Asking them to attach it again is the
one response that is guaranteed not to work.

## Previews — render an Artifact before you confirm

Whenever a step has a visual result, build a small self-contained HTML Artifact so the
user sees it before saying yes. Keep them theme-aware and self-contained.

- **WhatsApp template preview** — a phone-style green/white chat bubble showing the
  header (text or the poster image via a data: URI), body with `{{1}}` filled by the
  sample values, footer, and buttons as WhatsApp renders them. Show the template name +
  category above it.
- **Automation flow preview** — a top-to-bottom node diagram (trigger → message →
  condition(yes/no) → …) matching the `config` you are about to send to
  `create_automation`, so the user can eyeball the branch logic.
- **Bulk / broadcast preview** — a table of the audience (name + masked number + the
  per-row variables) with a count, plus the rendered message, so they approve *who* and
  *what* before it sends.
- **Lead form preview** — the form's fields as they'll appear, plus the public
  `/f/<slug>` link once created.

These previews are the "widgets" — they replace clicking around the Forge Growth UI.

## Playbooks

### Poster → approved template → send
1. Get the poster's media id — `list_media` with a `name` search if it's already in the
   Media Library, or `upload_media` with a public `url`. Never from a chat attachment.
2. Draft the template with the user (name in snake_case, body with `{{1}}` variables,
   category usually MARKETING, buttons if any). **Preview it as a WhatsApp bubble.**
3. On yes: `create_template` with `headerType:"IMAGE"`, `headerMediaLibraryId` = the media
   id, `whatsappAccountId` = the chosen number, plus `samples` for the variables.
4. `submit_template` → sends it to Meta. Tell the user approval is usually minutes.
5. `sync_template` to poll until APPROVED (or REJECTED — relay Meta's reason).
6. Once APPROVED, send it: `send_template` (one person) or `send_bulk_message` (a list).

### Message a segment of leads
1. Pull the segment with `list_leads` (by `stage`, `view:"hot"`, or search) — confirm the
   count and who is in it. Preview as an audience table.
2. Cold / outside-24h lists **must** use an approved template (`messageType:"template"`);
   free-form text only reaches people who messaged in the last 24h.
3. `send_bulk_message` with `fromNumber`, the `recipients[]` (each `{number,name,variables}`),
   and the `templateId`. It creates a tracked broadcast you can point them to.

### Build an automation from a described chat flow
1. Have the user describe the flow ("when someone messages 'COURSE', reply with the
   brochure, ask their name, wait, then send the fee link"). Map it to nodes + edges
   (trigger → message(waitForReply) → ai_agent/condition → message…). **Preview the flow
   diagram.**
2. On yes: `create_automation` with the `config`. It lands **inactive** on purpose.
3. Tell the user to review it in the Automations builder, then activate via
   `forgechat_request` `PUT /chatbots/:id { "status":"active" }` (or in the UI).

### Lead form → collect → share
1. Design the fields with the user (`create_lead_form` field shape: `{key,label,type,
   required,mapsTo,options,placeholder}`; `mapsTo` maps an answer onto a real lead column
   like phone/name/email). Preview the form.
2. `create_lead_form` with `publish:true` → returns the public `/f/<slug>` link. Every
   submission upserts a CRM lead by phone.
3. Share it: put the `/f/<slug>` URL in a template's URL button, or `create_wa_link`, or
   hand the user the link.
4. Read what comes in with `list_form_submissions`.

### One-off send / reply / link
- Reply in an open conversation: `list_conversations` (check `window.open`) →
  `send_message` (text, in-window) or `send_template` (any time).
- Interactive buttons/list menu (in-window): `send_interactive`.
- Click-to-chat link: `create_wa_link`.

### Build an AI agent
Follow the built-in `create-forgechat-agent` guide (ask purpose → number → model →
trigger → tools → media groups, confirm, then `create_agent` + `add_*_tool`).

## Ordering & dependencies (get these right)

- Media header template: **upload_media → create_template → submit_template → (wait) →
  sync_template → send**. You cannot send a template before it is APPROVED.
- A template can only be sent from the WhatsApp number (WABA) it was approved on. Use the
  same `whatsappAccountId` throughout.
- Lead-form link in a template: publish the form first (get its slug), then reference
  `/f/<slug>` in the template's URL button.
- Automations land inactive — activation is a separate, deliberate step.

## When something is blocked

- **"The '<name>' tool category is switched off"** → that category is off in Admin Settings
  → MCP Tools. The error names the category exactly as it appears on that screen, so relay
  it verbatim — e.g. *Template Builder*, *Media Library*, *Send Messages*, *Broadcasts*,
  *Automations*, *Lead Forms*, *Leads & Funnel*. You cannot enable it yourself, by design.
- **OUTSIDE_WINDOW** → the customer hasn't messaged in 24h; use `send_template`.
- **Meta rejection** (template REJECTED) → relay the reason, suggest a fix, re-create +
  re-submit.
- **Carousel templates** can't be sent via MCP — use the Forge Growth Bulk Message page.

## Anything not covered by a dedicated tool

Around sixteen Forge Growth features have no dedicated tool and are reached through
`forgechat_request`. **Do not work those out from first principles — load the skill that
covers the area.** Each one carries the rules that make the difference between a call
that works and one that silently reports the wrong thing:

| Task | Skill |
|---|---|
| Funnel stages, labels, order, lead sources | **forge-growth-funnel** |
| Timed chase sequences, steps, enrollment | **forge-growth-followups** |
| Drafting templates, Meta approval, rejections | **forge-growth-templates** |
| Sending, replying, files, broadcasts, the 24h window | **forge-growth-messaging** |
| Automation flows — triggers, branches, waits | **forge-growth-automations** |
| AI agents and their Sheets / HTTP tools | **forge-growth-agents** |
| Ad spend, click-to-WhatsApp attribution, conversions | **forge-growth-ads** |
| Revenue, payments, products, message costs | **forge-growth-revenue** |
| Anything else with no dedicated tool — contacts, team, projects | **forge-growth-api** |

They are separate skills on purpose: pulling in agent and payment detail to answer
a question about automations wastes context and buries the part that matters. The playbooks
above are the short version — when a step needs care, open the skill that owns it.

`list_endpoints` shows which areas are currently enabled. Still confirm before writes.
