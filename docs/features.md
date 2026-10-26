# What's in it

The full catalogue, with the reasoning behind the decisions that look arbitrary. For the short
version with screenshots, see [`README.md`](../README.md).

- [Instagram](#instagram)
- [WhatsApp](#whatsapp)
- [Sales](#sales)
- [Claude & MCP](#claude--mcp)
- [Google](#google)
- [Settings and administration](#settings-and-administration)

The header has two sections: **Social** (Instagram) and **Sales** (WhatsApp conversations, contacts
and everything that sells). Settings is the gear beside the bell.

---

## Instagram

Off until `SOCIAL_ENCRYPTION_KEY` is set; connecting an account is in
[`social-section.md`](./social-section.md).

### DM automations

Rules that answer people on your behalf. A rule has one trigger — **a comment** (on one post or any
post, optionally only when it contains certain words), **a DM keyword**, **a story reply**, **a story
mention** or **a button tap** — and then any of:

- a public **reply under the comment**, one of several wordings picked at random so it does not read
  as a bot;
- an **opening message** ("tap below and I'll send it") and an optional **follow gate**;
- **the DM** — text, a link card with buttons, a card, or quick replies;
- **questions** that collect name, email, phone or free text, saved under Leads and optionally to a
  Google Sheet;
- **one follow-up** if they don't tap the link, at a delay you pick inside Instagram's 24-hour window.

Each rule is edited step by step beside a phone that previews the post, the comment, the reply and
the DM, and **Test it** walks a fake commenter through the whole thing. New automations start from
the **Auto-DM links from comments** preset.

> Links in a DM are tracked through a short redirect on this install, so each rule reports sends,
> clicks, CTR and leads. The redirect is public by design — the person tapping is not logged in.

### Flows

Multi-step DM conversations on a canvas, for when one rule is not enough, with a step-by-step
simulator. Like rules, a flow is created switched off.

### AI agents

An agent that answers DMs and/or comments for one account, from a prompt and an OpenRouter model,
with an optional hand-off to a person, auto-tags and a test chat. Rules, flows and agents share one
Automations page with their results and an activity log.

### Overview, content library, inbox and contacts

- **Overview** — followers, reach, engagement rate and top posts over 7, 30 or 90 days.
- **Content library** — every synced post and reel with views, engagement, rate and a content score;
  a Media tab for the account's images and video.
- **Inbox** — DMs and comments in one place.
- **Contacts** — the people behind them, with their own tags and fields.

> All of it reads the **synced database**, never the Graph API on page load, so browsing never spends
> the account's rate budget. Every number says when it was last synced.

---

## WhatsApp

On Meta's WhatsApp Cloud API, one or more numbers per install. Connecting a number is in
[`whatsapp.md`](./whatsapp.md).

### Automation flow builder

A left-to-right visual editor with drag-to-connect wiring. Triggers: **keyword**, **new contact**,
**any message** and **tag applied**. Steps: messages (text, media, buttons, lists, call-to-action
links, approved templates), conditions, actions (funnel stage, tags, fields, owner) and delays.

> Every branch a step can take is a labelled row on the card with its own connector, so a reply
> button, a list option and a timeout are each visibly wired rather than sharing one anonymous handle.

A flow is checked before it can go live: an unwired button, an empty keyword or a step that asks
something without waiting for the answer is refused with a reason. **Preview & test** runs it as a
fake contact.

### AI agents

A no-code LLM agent per WhatsApp number: system prompt, model choice, triggers, multi-turn memory, a
tool-use loop and a full run trace. Tools cover Google Sheets, HTTP requests, media sends and CRM
write-back.

- **Human handoff** by keyword or agent decision, with round-robin assignment, idle-conversation
  summaries, voice-note transcription and vision.
- **Usage limits** cap what an agent may spend on one person — a rolling per-person allowance that
  refills on a clock rather than a lifetime cap. **Test numbers are exempt from the pause**, so a
  limit can never lock the operator out of their own rehearsal.
- **Created from presets** (answer questions, get leads, sell & book, support) filled in from a short
  form, then tuned in the editor beside a live test chat.

> Agent runs execute on a queue outside the webhook path, so Meta's 20-second timeout is never hit.

### Workflow agents

Agents that work across the whole workspace rather than one chat: run on a schedule or on a trigger
(a new lead, a stage change), read leads, conversations and sales within a data scope you set, and
produce drafts, worklist items or actions. Anything that would message a customer or change a record
waits in an **approvals queue** unless you allow it outright, and every run keeps its evidence.

### Message templates

The full Meta lifecycle in a five-step builder with a phone preview: submit, sync, edit, delete — with
PAUSED / DISABLED / REJECTED handling, quality score, COPY_CODE buttons, carousels and library clone.

Editing an approved template snapshots the previous version, enforces Meta's **2-edits-per-24h** limit,
and offers restore from a history drawer. Cached daily analytics include a per-button click breakdown.

### Chats

A 3-pane WhatsApp client:

- per-agent filtering, with numbers masked by default;
- media — image, video, audio, document;
- 24-hour customer-service-window enforcement;
- optimistic-UI sends and mic recording in the composer;
- voice notes transcribed to text (OpenRouter, multilingual).

> **Voice notes.** A recording, a forwarded voice note and Media-library audio go out as a real
> WhatsApp voice note — profile picture, mic icon — in WhatsApp's own file layout: 48 kHz mono Opus in
> 120 ms packets, the audio on one Ogg page, vendor "WhatsApp". ffmpeg's default OGG is delivered and
> then "This audio is no longer available" on iPhone. Audio over the 512 KB voice-note limit goes out
> as an ordinary M4A audio message.

### Broadcasts

7 message types, a per-recipient queue, live SENDING / SENT / PARTIAL / FAILED rollup, and
per-broadcast variable mapping. The composer asks for the **send mode first** — send now, schedule
once, or repeat on a schedule — because every later choice depends on it. Recipients can be filtered
by funnel stage, tag and date range, and a scheduled broadcast stays editable until it fires.

### Media library

Upload once to MinIO, sync per-account to Meta on demand. Each account gets its own 28-day media id,
with an optional daily cron that refreshes ids before they expire.

### Message costs

What the messaging above actually owes Meta, per template and per message type. Meta puts a `pricing`
object on every status webhook; this app gives it a permanent home.

The money amount is **derived from the WABA's own pricing analytics** (cost ÷ volume) rather than a
hand-maintained rate card.

> Rates differ enormously by country. Measured on a real account, India utility billed 0.1150 against
> Germany's 4.0322 for the same category — one hardcoded rate would have under-reported by ~97%.

Every send is stamped with its template and originating surface — broadcast, automation, agent,
manual or MCP — **at send time**, because working out "which template was this?" afterwards
silently misses.

---

## Sales

### Home

The funnel for the period in one row — came in, reached out, got a reply, won, paid — with open
conversations, active automations, where leads came from and how many sit in each stage.

### Contacts

One hub over one `leads` model — Funnel and All Contacts (table or board) are **views of the same
records** rather than separate pages. Tags, a configurable field registry, and CSV/XLSX import with
alias-matched headers, drag-drop, Ctrl+V paste and idempotent upsert.

> Stage labels, colours, order and won-flag are all editable. The underlying `stage_key` is
> **immutable**, so renaming a stage never rewrites existing rows or breaks conversion maths.

#### Configurable columns

Rename "Profession", hide "Pincode", edit a dropdown's options, or add a custom field — **with no
schema change**. Built-in columns are relabelled rather than replaced; `field_key` is immutable once
minted; deleting a custom field is a **soft** delete and the key stays reserved forever.

> That last rule is not tidiness. A new field re-using an old key would silently inherit orphaned
> values still sitting in existing JSONB blobs.

### Follow-up calendar

Pin a lead's chat and give it a follow-up date and time — or let the AI suggest one from the chat's
timing and recent messages. The **calendar** shows the month with each day's follow-ups, a side panel
of what is overdue and due today with **Open chat** and **Reschedule**, and drag-to-reschedule; the
**Chats** view lists pinned leads beside their conversation. With Google connected, each follow-up is
mirrored as a calendar event that links back to the chat.

### Sales and products

A sale is a lead in a won stage. Payments and refunds against it are recorded by hand
(`POST /students/:id/installments`) — nothing arrives from a payment gateway. Products are the
sellable catalogue, with optional default prices.

---

## Claude & MCP

The app is itself an MCP server, so an assistant like Claude can operate it as a custom connector.
**Tools are grouped into categories, every category defaulting to off.**

A tool belongs to exactly one category, and **the category is the gate**. Categories are named after
the job someone is doing ("Template Builder", "Instagram automations & flows") rather than the
internal route they call, and each is tagged with what it can do:

| Tier | Meaning |
|---|---|
| **Reads only** | Cannot change anything or reach a customer |
| **Builds & configures** | Creates or edits setup — templates, agents, flows, funnel stages |
| **Costs money per use** | Bills your AI provider per call |
| **Reaches customers** | Sends real messages to real people. Meta charges apply |
| **Cannot be undone** | Permanently removes something |
| **Full API access** | Unrestricted internal API calls, scoped separately by area |

**Capabilities are global, not per-token.** Turning one off applies immediately to every
already-connected client.

**What Claude builds is a draft.** `create_automation` (WhatsApp flows), `social_create_automation`,
`social_create_comment_dm_draft` (the comment-to-DM preset in one call) and `social_create_flow` all
save switched off; a separate call switches them on once you have looked.

### Connecting

- **OAuth 2.1** at `https://<your-domain>/api/mcp` — the recommended transport. In
  **Settings → Claude & MCP**, paste the server URL into Claude's custom connector and sign in with
  your Forge Growth login. Workspaces that require a client ID and secret create one under
  **Access & keys**.
- **The Claude plugin**, downloaded from the same page. The `.zip` is built per request with this
  install's own address already written into `.mcp.json`, so there is nothing to edit.
- A legacy key-in-URL transport at `/api/mcp/http/<key>`, and a local stdio server
  ([`mcp-server/`](../mcp-server/README.md)).

**The address is worked out per request**, so the same build works on any domain. Behind a proxy that
rewrites the Host header or hides https, set `PUBLIC_URL=https://<your-domain>` in `.env` and restart;
Settings → Claude & MCP shows which address is in use and where it came from. Use the address you
**sign in at**: the token is issued for the host the request arrived on.

#### Three requirements that fail silently

Check these first when a connector will not finish authorising:

1. **HTTPS with a valid certificate.** OAuth discovery is refused over plain HTTP.
2. **`/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` must reach
   the backend.** The bundled nginx config already proxies them; a custom reverse proxy forwarding only
   `/api` will serve the SPA's HTML for these paths instead, and discovery fails with no useful error.
3. **PKCE `S256`.** A missing or `plain` challenge is refused rather than downgraded.

---

## Google

OAuth connect for **Sheets, Calendar and Gmail**, with built-in discovery browsers — spreadsheet
picker with tab preview, calendar list, Gmail labels — and an automation action for each.

---

## Settings and administration

Settings is grouped by what you are setting up, and each page lists its sections as pills:

| Group | Pages |
|---|---|
| **Workspace** | General (preferences, Instagram notifications) · Team · Activity log |
| **Contacts** | Tags (WhatsApp and Instagram tags and categories) · Fields · Funnel |
| **Connections** | WhatsApp (accounts, webhook) · Instagram (connection, privacy policy) · AI models · Google · Claude & MCP |

### Users and RBAC

Roles are **rows, not an enum**. `admin` is fixed; the rest are managed under **Settings → Team**,
each owning its own page list — so adding a role never needs a migration. Plus per-user number
assignments, per-contact assignment overrides, and an append-only audit log.

### Webhook history

Under **Settings → WhatsApp → Webhook**: every inbound payload audited with its parser outcome, a
synthetic payload generator for testing, and a **replay button** that re-runs any historical payload
through the handler.
