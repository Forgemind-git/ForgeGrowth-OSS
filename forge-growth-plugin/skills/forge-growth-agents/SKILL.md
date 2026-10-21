---
name: forge-growth-agents
description: >-
  Create and configure Forge Growth AI agents — the assistants that reply to customers
  on WhatsApp. Covers persona and system prompt, picking a model and a number, the
  trigger, usage limits and the per-person allowance, test numbers, and attaching
  Google Sheets, HTTP or form tools. Use when the user wants an AI agent built, edited,
  limited, tested, or asks why an agent will not go live or has gone quiet.
---

# AI agents

Tools: `list_agents`, `get_agent`, `create_agent`, `update_agent`, `add_tool`,
`add_google_sheets_tool`, `add_http_tool`, `update_tool`.
Category: **AI Agents**. Deleting is a separate category — **Delete & remove** — and is
usually off.

An agent is a persona plus a model plus a WhatsApp number plus optional tools. It
replies automatically to inbound messages on its number.

## Gather before you create, not after

Never invent ids. Fetch the real options and let the user choose:

1. **Purpose** — what it is for, in the user's words. This becomes the system prompt.
2. **Number** — `list_wa_accounts`.
3. **Model** — `list_models` returns each credential's `aiModelId` plus selectable
   `models[]`. You need **both** `aiModelId` and `llmModel`.
4. **Trigger** — when it should engage.
5. **Limits** — see below. Ask; do not assume.
6. **Tools** — optional.
7. **Summarise the whole configuration and get an explicit yes**, then create.

## Two rules that decide whether it can go live

**An agent saves as a draft unless it has both `aiModelId` and `llmModel`.** Create one
without a model and it will look created and simply never run. Say so rather than
reporting success.

**Only one agent can be active per WhatsApp number.** Activating a second on the same
number is refused. A replacement is a deliberate swap — confirm which one is standing down.

## Limits — every one is off by default

**An agent with no limits set will answer one person forever.** Ask what ceiling the
user wants; do not quietly leave it unbounded. Every field below is optional; omitting
one on an update leaves it alone, and `null` or `0` clears it (there is no way to say
"may send zero replies").

Four ceilings, because each is blind to what the others catch:

| Field | Catches |
|---|---|
| `maxRepliesPerConversation` | one person talking all day. Refills the moment they go quiet |
| `quotaReplies` + `quotaWindowValue`/`quotaWindowUnit` | the same person coming back tomorrow — this one refills on a **clock**, not on silence |
| `maxRepliesPerMinute` | a burst. Sends nothing and records nothing; the skipped message still reaches the model as context next turn |
| `maxRunsPerDay` | a broadcast backfire — hundreds of people replying at once, each conversation individually normal |

`quotaConversations` limits how many separate sittings one person may start in the
window, and only ever refuses a *new* one — it never cuts someone off mid-conversation.

When a per-conversation limit stops the agent, `limitHandoff` (**on** by default) pauses
the bot and leaves the chat for a person: someone who asked that many questions is
usually interested. `quotaHandoff` is **off** by default for the opposite reason — "come
back tomorrow" is not a reason to push everyone into the inbox. `limitReachedMessage`
is the one closing line; leaving it empty genuinely sends nothing.

## Test numbers

`testNumbers` do three things, and only the first is obvious:

1. They can talk to the agent while it is still a **draft**.
2. They are **exempt from every limit** — you cannot test a 3-a-day agent four times.
3. Their runs are **excluded from the counts**, so a day of testing does not eat the
   real budget.

Triggers and funnel gating still apply to a test number, so a tester who does not match
the trigger will get no reply and the agent is not broken.

If a real customer's chat has gone quiet, check whether the agent hit a limit and
handed the conversation to a person — a paused chat looks identical to an agent that is
not working.

## Voice and images

`transcribeAudio` lets it understand voice notes; `acceptImages` lets it see images
(needs a vision-capable model). Both off by default — ask, since both change what it
costs to run. `maxVoiceSeconds` caps how long a note it will transcribe, and
`maxImagesPerConversation` how many images it will look at. An over-long note is not
silently ignored: the agent asks for a shorter one rather than guessing at what was said.

`maxImagesPerConversation` is per **conversation**, not per message — WhatsApp delivers
each photo as its own message, so a per-message cap could only ever be 1.

## Tools an agent can use

- **Google Sheets** (`add_google_sheets_tool`) — resolve the real spreadsheet with
  `search_spreadsheets`, its tabs with `list_sheet_tabs`, then read the header row with
  `read_sheet_values` (range `A1:Z1`) so the columns you map are the real ones. For
  logging a person's details prefer **upsert** over append — one evolving row per
  customer instead of a new row per message.
- **HTTP request** (`add_http_tool`) — calls an external API or device. Static headers
  hold auth and the model never sees or changes them; `params` are what the model fills
  at call time. Every `{placeholder}` in the URL needs a matching path param.

A tool's **description is how the model decides when to use it**. Vague descriptions
produce agents that call tools at the wrong moment; make each one specific.

## Media groups

A media group is a bundle the agent sends at a particular moment. Its `description`
answers *"when should this be sent?"* — that is what triggers it, so write it as a
condition ("when the customer asks for pricing"), not a label ("pricing stuff").

If the user names a file, resolve it with `list_media`. If they name a template,
`get_template` and show them its real content before using its id.

## What an agent can no longer do

Removed from agents entirely — do not offer them, and correct the user if they expect
them: **taking payments**, **writing to the CRM**, **handing over to a human by
keyword**, and **summarising a chat when it ends**. Sending media is unaffected.

The **funnel gate** — restricting an agent to leads at certain stages or with certain
tags — exists, but can only be set in the web app. It decides who gets answered by a
machine and who is left for a person, so it is an admin-only decision and is ignored if
sent over MCP. Point the user at the agent's editor rather than appearing to set it.

Payment ability and CRM writes were also never included when an agent is **exported**.

## Reading what an agent did, and removing one

`get_agent_runs {id}` lists recent runs — who it answered, its reply, tools used, and why
a message was not answered (limits, a person took over). Read it before guessing why an
agent went quiet. `delete_agent` / `delete_tool` sit under **Admin → Delete & remove**.
Agents that answer Instagram are a separate system: see **forge-growth-social**.
