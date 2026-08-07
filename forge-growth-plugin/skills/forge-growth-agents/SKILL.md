---
name: forge-growth-agents
description: >-
  Create and configure Forge Growth AI agents — the assistants that reply to customers
  on WhatsApp. Covers persona and system prompt, picking a model and a number, the
  trigger, and attaching Google Sheets or HTTP tools. Use when the user wants an AI
  agent built, edited, given a tool, or asks why an agent will not go live.
---

# AI agents

Tools: `list_agents`, `get_agent`, `create_agent`, `update_agent`, `add_tool`,
`add_google_sheets_tool`, `add_http_tool`, `update_tool`. Category: **AI Agents**.
Deleting is a separate category — **Delete & remove** — and is usually off.

An agent is a persona plus a model plus a WhatsApp number plus optional tools. It
replies automatically to inbound messages on its number.

## Gather before you create, not after

Never invent ids. Fetch the real options and let the user choose:

1. **Purpose** — what it is for, in the user's words. This becomes the system prompt.
2. **Number** — `list_wa_accounts`.
3. **Model** — `list_models` returns each credential's `aiModelId` plus selectable
   `models[]`. You need **both** `aiModelId` and `llmModel`.
4. **Trigger** — when it should engage.
5. **Tools** — optional, see below.
6. **Summarise the whole configuration and get an explicit yes**, then create.

## Two rules that decide whether it can go live

**An agent saves as a draft unless it has both `aiModelId` and `llmModel`.** If you
create one without a model it will look created and simply never run. Say so rather
than reporting success.

**Only one agent can be active per WhatsApp number.** Activating a second one on the
same number is refused. If the user wants a replacement, that is a deliberate swap —
confirm which one is being stood down.

`create_agent` always produces a draft. Going live is a separate, explicit step.

## Tools an agent can use

- **Google Sheets** (`add_google_sheets_tool`) — resolve the real spreadsheet with
  `search_spreadsheets`, then its tabs with `list_sheet_tabs`, then read the header row
  with `read_sheet_values` (range `A1:Z1`) so the columns you map are the real ones.
  For logging a person's details prefer the **upsert** operation over append — upsert
  keeps one evolving row per customer instead of a new row per message.
- **HTTP request** (`add_http_tool`) — calls an external API or device. Static headers
  hold auth and the model never sees or changes them; `params` are what the model fills
  at call time. Every `{placeholder}` in the URL needs a matching path param.

A tool's **description is how the model decides when to use it**. Vague descriptions
produce agents that call tools at the wrong moment; make each one specific and
action-oriented.

## Media groups

A media group is a bundle the agent sends at a particular moment. Its `description`
answers *"when should this be sent?"* — that is what triggers it, so write it as a
condition ("when the customer asks for pricing"), not a label ("pricing stuff").

If the user names a file, resolve it with `list_media` by name. If they name a
template, `get_template` and show them its real content before using its id.

## Voice and images

`transcribeAudio` lets the agent understand voice notes; `acceptImages` lets it see
images (use a vision-capable model). Both are off by default — ask, rather than
assuming, since both change what the agent costs to run.

## Not exported, on purpose

Payment ability, CRM writes and handoff are **not** included when an
agent is exported. An imported agent must never arrive already able to charge money on
whatever gateway the receiving workspace has connected.
