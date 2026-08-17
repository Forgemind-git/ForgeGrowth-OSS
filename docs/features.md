# What's in it

The full catalogue, with the reasoning behind the decisions that look arbitrary. For the short
version, see [`README.md`](../README.md#whats-in-it).

- [Marketing](#marketing)
- [Leads and sales](#leads-and-sales)
- [Conversations](#conversations)
- [Messaging at scale](#messaging-at-scale)
- [Automation and AI](#automation-and-ai)
- [Integrations](#integrations)
- [Administration](#administration)

---

## Marketing

### Campaigns

Real spend and results from the Meta Marketing API, arranged the way Meta structures them:
**Campaign → Ad Set → Ad**.

> Ad-set spend is *fetched* at `level=adset`, never summed from its ads. Meta attributes part of the
> cost at that tier, so summing under-reports.

### Click-to-WhatsApp

Every conversation that began with an ad tap. Meta's `referral` block is promoted out of the raw
webhook payload into its own table, which gives you:

- per-ad **CPL and ROAS**
- a **placement** breakdown
- a drill-in showing the exact creative each person saw, plus a link straight into their chat thread

### Conversion API

**Not shipped in this release.** The tab is present and marked Coming Soon.

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

A field registry makes the Leads table, the Sales Log and per-instalment transactions configurable the
way Forms already were: rename "Profession", hide "Pincode", edit a dropdown's options, or add a
custom field — **with no schema change**.

- Built-in columns are relabelled rather than replaced. System fields cannot be deleted or re-typed.
- `field_key` is immutable once minted.
- Deleting a custom field is a **soft** delete and the key stays reserved forever.

> That last rule is not tidiness. A new field re-using an old key would silently inherit orphaned
> values still sitting in existing JSONB blobs.

### Payments

Mint Razorpay payment links — fixed, part payment or open amount — **stamped with the lead id**, so a
payment attributes itself instead of being guessed from its amount. Reconciliation runs off the
Razorpay webhook and resolves a payment back to the exact lead through the ids carried in the link's
`notes`: a fact rather than an amount-matching guess.

A second tab shows the pulled ledger — every payment the gateway holds, including ones taken before
the webhook existed.

### Payment templates

For reaching a customer who has gone quiet. WhatsApp refuses free-form text more than 24 hours after
the customer's last message, so a link can only get through as an approved template.

> The template's URL button points at a base **this app** owns (`/pay/{{1}}`), not at the gateway's
> short-link domain. Meta bakes a button's base in at approval time, so pointing it at Razorpay would
> mean every approved template breaks the day Razorpay changes its link format.

### Sales Log

Enrolled leads and their transactions: gateway payments deduped by `payment_id`, unioned with manually
logged sales.

### Forms

Shareable lead-capture forms at `/f/<slug>`, optionally prefilled from a WhatsApp send token. Field
types include star **ratings** and **section** headings.

- Responses without a phone number are kept as anonymous submissions rather than dropped.
- A section is layout, so it is skipped when answers are collected rather than stored as an empty
  answer.

### Products

The sellable catalogue, with optional default prices.

---

## Conversations

### Inbox

A 3-pane WhatsApp-style client:

- per-agent filtering
- media rendering — image, video, audio, document, with an ffmpeg Ogg→MP3 fallback so voice notes play
  in Safari
- 24-hour customer-service-window enforcement
- optimistic-UI sends and mic recording in the composer

### Projects

One folder for a campaign's whole toolkit. "Run the Applied AI launch" means a broadcast template, an
AI agent to answer the people who reply, an automation behind it, and a form — four things that
otherwise live in four unrelated lists with no way to see them as one campaign.

A project can hold all four kinds. The link is a nullable `project_id`, so nothing is forced into a
project.

### Message Formats

A labelled, pre-filled WhatsApp opener you put on an Instagram reel or a web page. Tapping it opens
WhatsApp with that exact text, and **the conversation that follows is attributable to the label** — a
brand-new lead takes the format's label as its funnel Source.

- One format can serve many numbers. Each gets its own slug, since each is a different `wa.me`
  destination.
- Optional **rotate mode** hands the numbers out in turn, spreading leads across agents.
- The shared URL is the tracked redirect, so taps are counted.

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
manual, MCP or payment — **at send time**, because working out "which template was this?" afterwards
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

### AI Agents

A no-code LLM agent per WhatsApp number: system prompt, model choice, triggers, multi-turn memory, a
tool-use loop and a full run trace. Tools cover Google Sheets, HTTP requests, media sends and CRM
write-back.

- **Human handoff** by keyword or agent decision, with round-robin assignment, idle-conversation
  summaries, optional audio transcription and vision.
- **Usage limits** cap what an agent may spend on one person — a rolling per-person allowance that
  refills on a clock rather than a lifetime cap. **Test numbers are exempt from the pause**, so a
  limit can never lock the operator out of their own rehearsal.
- **Form filling by conversation** — a form's fields become the tool schema, so the same answers a
  public form collects can be gathered in chat and land in the same table.

> Agent runs execute on a queue outside the webhook path, so Meta's 20-second timeout is never hit.

---

## Integrations

### Google

OAuth connect for **Sheets, Calendar and Gmail**, with built-in discovery browsers — spreadsheet
picker with tab preview, calendar list, Gmail labels — and an automation action for each.

### MCP — drive the app from an assistant

The app is itself an MCP server, so an assistant like Claude can operate it as a custom connector.
**46 tools in 17 categories, every category defaulting to off.**

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

- **OAuth 2.1** at `https://<your-domain>/api/mcp` — the recommended transport. Create a client in
  **Admin Settings → MCP Tools**, paste the Client ID and Secret into the connector's advanced
  settings, and approve the consent screen.
- A legacy key-in-URL transport at `/api/mcp/http/<key>` is still supported.

#### Three requirements that fail silently

Check these first when a connector will not finish authorising:

1. **HTTPS with a valid certificate.** OAuth discovery is refused over plain HTTP.
2. **`/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` must reach
   the backend.** The bundled nginx config already proxies them; a custom reverse proxy forwarding only
   `/api` will serve the SPA's HTML for these paths instead, and discovery fails with no useful error.
3. **PKCE `S256`.** A missing or `plain` challenge is refused rather than downgraded.

---

## Administration

### Users and RBAC

Roles are **rows, not an enum**. `admin` is fixed; the rest are managed from Admin Settings, each
owning its own page list — so adding a role never needs a migration.

Plus per-user number assignments, per-contact assignment overrides, and an append-only audit log.

### Webhook History

Every inbound payload audited with its parser outcome, a synthetic payload generator for testing, and
a **replay button** that re-runs any historical payload through the handler.
