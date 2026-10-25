---
name: forge-growth-api
description: >-
  How to reach Forge Growth features that have no dedicated MCP tool, using the
  forgechat_request proxy — contacts, team members, follow-ups, funnel config,
  sales, message costs, repeating broadcasts and the product list. Use when a Forge Growth task has no matching tool, when
  forgechat_request returns 403, or when reading money/revenue figures out of Forge
  Growth. Carries the invariants that make those numbers wrong if ignored.
---

# Reaching Forge Growth beyond the dedicated tools

Most of Forge Growth has a purpose-built tool — check for one first (Social, Sales,
products, funnel and leads all have them). The rest is
reached with **`forgechat_request`**. It calls the app's own internal API
as an admin, so all the normal validation, permissions and side effects still apply.

```
forgechat_request({ method: "GET", path: "/leads", query: { stage: "hot" } })
forgechat_request({ method: "POST", path: "/funnel/stages", body: { label: "Warm" } })
```

`path` is relative to the API root — write `/leads`, never `/api/leads`.
Returns `{ status, ok, body }`. A non-2xx `status` is the app refusing, and its
`body.error` is written for a human — relay it rather than paraphrasing.

## Two switches must both be on

`forgechat_request` needs the **Direct API access** category enabled *and* the
**API area** covering that path. Both live in Admin Settings → MCP Tools.

Anything matching no area is refused — the gate is default-deny, so a 403 usually
means the area is off, not that the path is wrong.

| Area | Covers |
|---|---|
| Contacts & tags | `/contacts` `/tags` `/categories` `/numbers` |
| Messages & conversations | `/messages` `/agent-conversation` (pause or resume the bot on one chat) |
| Broadcasts & content | `/broadcasts` `/broadcast-series` `/templates` `/media-library` |
| Automations | `/chatbots` `/executions` — but prefer the dedicated tools: `list_automations`, `validate_automation`, `create_automation`, `update_automation`, `get_automation_runs` |
| Leads & funnel | `/leads` `/funnel` `/lead-sources` `/entity-fields` |
| Products | `/products` `/courses` |
| Sales | `/students` |
| Dashboard & logs | `/dashboard` `/webhook-history` `/message-costs` |
| Social | `/social/*` — but prefer the `social_*` tools (see **forge-growth-social**) |
| **Admin (sensitive)** | `/users` `/whatsapp-accounts` `/integrations` `/ai-models` `/social/credentials` `/social/settings` `/social/integrations` `/social/users` |

**Admin is deliberately the highest tier.** It holds user management, WhatsApp account
credentials, integrations and AI model keys. Never treat a task as blocked-by-a-toggle and
suggest enabling Admin casually — say what it would grant.

## Invariants that silently corrupt numbers

**Money may be stored in paise, converted at the API boundary — but not everywhere.**
Field names ending `_paise` are integer paise; a field named `amount` or `total` is
usually already rupees. Read the field name before doing arithmetic. Reporting paise
as rupees overstates by 100×.

**Keys are immutable, labels are not.** `stage_key`, `field_key` and a tag's id are
permanent; their labels can be renamed freely. Never key logic off a label, and never
report a key to the user as if it were a name.

**A filter's option list must come from an unfiltered query.** Endpoints that return
both rows and a breakdown return the breakdown *filtered*. Do not present it as the
full set of available options.

## When it refuses

- **403 "tool category is switched off"** — Direct API access is off. Name the switch.
- **403 with no area** — that area is off, or the path genuinely isn't covered.
- **409** — a guard fired (something still references what you tried to delete). The
  message says what; relay it and offer the fix it names.
- **400** — validation. The message is human-readable; act on it rather than retrying
  the same body.

Never retry a refusal unchanged, and never work around a refusal by finding another
path to the same effect. A disabled area is a decision, not an obstacle.
