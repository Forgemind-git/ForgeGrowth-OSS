# What's in it

The full catalogue, with the reasoning behind the decisions that look arbitrary. For the short
version, see [`README.md`](../README.md#whats-in-it).

- [Leads and sales](#leads-and-sales)
- [Conversations](#conversations)
- [Messaging at scale](#messaging-at-scale)
- [Automation and AI](#automation-and-ai)
- [Integrations](#integrations)
- [Administration](#administration)

---

## Leads and sales

### Leads

One hub over one `leads` model — Pipeline, Funnel and All-Leads are **views of the same records**
rather than three separate pages. Tags, a configurable field registry, and CSV/XLSX import with
alias-matched headers, drag-drop, Ctrl+V paste and idempotent upsert.

A contact is the conversation; the lead is the record. There is no separate Contacts CRM page holding
a second copy of the person.

> Stage labels, colours, order and won-flag are all editable. The underlying `stage_key` is
> **immutable**, so renaming a stage never rewrites existing rows or breaks conversion maths.

### Configurable columns

A field registry makes the Leads table and per-instalment transactions configurable:
rename "Profession", hide "Pincode", edit a dropdown's options, or add a
custom field — **with no schema change**.

- Built-in columns are relabelled rather than replaced. System fields cannot be deleted or re-typed.
- `field_key` is immutable once minted.
- Deleting a custom field is a **soft** delete and the key stays reserved forever.

> That last rule is not tidiness. A new field re-using an old key would silently inherit orphaned
> values still sitting in existing JSONB blobs.

### Sales

A sale is a lead in a won stage. Payments and refunds against it are recorded by hand
(`POST /students/:id/installments`) — nothing arrives from a payment gateway.

### Products

The sellable catalogue, with optional default prices.

### Follow-ups

Pin a lead's chat and give it a follow-up date — or let the AI suggest one from the chat's timing and
recent messages; the calendar view lists who is due today and who is overdue. With Google connected, each follow-up is mirrored as a calendar event that links straight
back to the chat.

---

## Conversations

### Inbox

A 3-pane WhatsApp-style client:

- per-agent filtering
- media rendering — image, video, audio, document, with an ffmpeg Ogg→MP3 fallback so voice notes play
  in Safari
- 24-hour customer-service-window enforcement
- optimistic-UI sends and mic recording in the composer
- voice notes transcribed to text (OpenRouter, multilingual)

---

## Messaging at scale

### Message Templates

The full Meta lifecycle: submit, sync, edit, delete — with PAUSED / DISABLED / REJECTED handling,
quality score, COPY_CODE buttons, carousels and library clone.

Editing an approved template snapshots the previous version, enforces Meta's **2-edits-per-24h** limit,
and offers restore from a history drawer.

### Template Analytics

Cached daily Meta analytics with a per-button click breakdown.

### Bulk Broadcasts

7 message types, a per-recipient queue, live SENDING / SENT / PARTIAL / FAILED rollup, and
per-broadcast variable mapping.

The two-step composer asks for the **send mode first** — send now, schedule once, or repeat on a
schedule — because every later choice depends on it. Recipients can be filtered by funnel stage, tag
and date range, and a scheduled broadcast stays editable until it fires.

### Message Costs

What the messaging above actually owes Meta, per template and per message type. Meta puts a `pricing`
object on every status webhook; this app used to discard it and now gives it a permanent home.

The money amount is **derived from the WABA's own pricing analytics** (cost ÷ volume) rather than a
hand-maintained rate card.

> Rates differ enormously by country. Measured on a real account, India utility billed 0.1150 against
> Germany's 4.0322 for the same category — one hardcoded rate would have under-reported by ~97%.

Every send is stamped with its template and originating surface — broadcast, automation, agent,
manual or MCP — **at send time**, because working out "which template was this?" afterwards
silently misses.

### Media Library

Upload once to MinIO, sync per-account to Meta on demand. Each account gets its own 28-day media id,
with an optional daily cron that refreshes ids before they expire.

---

## Automation and AI

### Automation Builder

A left-to-right visual flow editor with **20 block types** and drag-to-connect wiring.

> Every branch a step can take is a labelled row on the card with its own connector, so a reply
> button, a list option and a timeout are each visibly wired rather than sharing one anonymous handle.

The engine evaluates keyword / any-message / new-contact / read / delivered / sent triggers
synchronously on each webhook.

### Workflow Agents

Agents that work across the whole workspace rather than one chat: run on a schedule or on a trigger
(a new lead, a stage change), read leads, conversations and sales within a data scope you set, and
produce drafts, worklist items or actions. Anything that would message a customer or change a record
waits in an **approvals queue** unless you allow it outright, and every run keeps its evidence.

### AI Agents

A no-code LLM agent per WhatsApp number: system prompt, model choice, triggers, multi-turn memory, a
tool-use loop and a full run trace. Tools cover Google Sheets, HTTP requests, media sends and CRM
write-back.

- **Human handoff** by keyword or agent decision, with round-robin assignment, idle-conversation
  summaries, optional audio transcription and vision.
- **Usage limits** cap what an agent may spend on one person — a rolling per-person allowance that
  refills on a clock rather than a lifetime cap. **Test numbers are exempt from the pause**, so a
  limit can never lock the operator out of their own rehearsal.
- **Quick-start templates** for common agents (answer questions, get leads, sell & book, support), filled in from a short
  form. New agents are created from a preset; the editor remains for tuning existing ones.

> Agent runs execute on a queue outside the webhook path, so Meta's 20-second timeout is never hit.

---

## Integrations

### Google

OAuth connect for **Sheets, Calendar and Gmail**, with built-in discovery browsers — spreadsheet
picker with tab preview, calendar list, Gmail labels — and an automation action for each.

### MCP — drive the app from an assistant

The app is itself an MCP server, so an assistant like Claude can operate it as a custom connector.
**Tools are grouped into categories, every category defaulting to off.**

A tool belongs to exactly one category, and **the category is the gate**.

> This replaced an earlier model where one capability gated ten unrelated tools — an admin who wanted
> Claude to build a WhatsApp template had no choice but to hand over Google Drive search as well.

Categories are named after the job someone is doing ("Template Builder", "Send Messages") rather than
the internal route they call, and each is tagged with what it can do, so the risk is legible before
you switch it on:

| Tier | Meaning |
|---|---|
| **Reads only** | Cannot change anything or reach a customer |
| **Builds & configures** | Creates or edits setup — templates, agents, flows, forms, funnel stages |
| **Reaches customers** | Sends real WhatsApp messages to real people. Meta charges apply |
| **Cannot be undone** | Permanently removes something. There is no undo |
| **Full API access** | Unrestricted internal API calls, scoped separately by area |

**Capabilities are global, not per-token.** Turning one off applies immediately to every
already-connected client.

#### Connecting

- **The Claude plugin**, downloaded from **Admin Settings → MCP Tools**. The `.zip` is built per
  request with this instance's own address already written into `.mcp.json`, so there is nothing to
  edit — including on a plain-HTTP install, where the URL is `http://`.
- **OAuth 2.1** at `https://<your-domain>/api/mcp` — the recommended transport. Create a client in
  **Admin Settings → MCP Tools**, paste the Client ID and Secret into the connector's advanced
  settings, and approve the consent screen. Use the address you **sign in at**: where one install
  answers on two domains, the token is issued for the host the request arrived on, and a connector
  pointed at the other one fails as though the credentials were wrong.
- A legacy key-in-URL transport at `/api/mcp/http/<key>` is still supported.

#### Three requirements that fail silently

Check these first when a connector will not finish authorising:

1. **HTTPS with a valid certificate.** OAuth discovery is refused over plain HTTP.
2. **`/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` must reach
   the backend.** The bundled nginx config already proxies them; a custom reverse proxy forwarding only
   `/api` will serve the SPA's HTML for these paths instead, and discovery fails with no useful error.
3. **PKCE `S256`.** A missing or `plain` challenge is refused rather than downgraded.

---

## Social

A third header section for Instagram: analytics and insights, one inbox for DMs and comments,
comment-to-DM automations and a content library of synced posts and media. Off until `SOCIAL_ENCRYPTION_KEY` is set; setup in
[`social-section.md`](./social-section.md).

---

## Administration

### Users and RBAC

Roles are **rows, not an enum**. `admin` is fixed; the rest are managed from Admin Settings, each
owning its own page list — so adding a role never needs a migration.

Plus per-user number assignments, per-contact assignment overrides, and an append-only audit log.

### Webhook History

Every inbound payload audited with its parser outcome, a synthetic payload generator for testing, and
a **replay button** that re-runs any historical payload through the handler.
