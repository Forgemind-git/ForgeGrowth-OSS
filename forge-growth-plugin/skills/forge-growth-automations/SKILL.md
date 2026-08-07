---
name: forge-growth-automations
description: >-
  Build Forge Growth automation flows — the trigger/message/condition/action graphs
  that run when a customer messages in. Use when the user describes a chat flow, wants
  a keyword to trigger a reply, a branching conversation, a delay, or a payment step
  inside a chat. Not for timed chases after a stage change — that is
  forge-growth-followups.
---

# Automation flows

Tool: `create_automation`. Category: **Automations**. Reading, editing and activating
existing flows goes through `forgechat_request` on `/chatbots` (see
**forge-growth-api**), which needs the same Automations area.

A flow is **nodes** plus **edges**. It starts at a trigger and walks edges until it
ends, pauses, or hands off.

## Node types

| Type | Does |
|---|---|
| `trigger` | starts the flow — keyword, any message, new contact, link/QR, webhook |
| `message` | sends something; can also **wait for the customer's reply** |
| `condition` | branches on `yes` / `no` |
| `action` | tags, custom fields, assign to a BDA, webhook, email, Sheets row |
| `delay` | waits a duration, or until a time or date |
| `payment` | raises a real payment link and can branch on paid / unpaid |
| `handoff` | assigns a human and ends the flow |
| `api` | calls an external endpoint mid-flow |
| `ai_agent` | hands the turn to an AI agent |

## Designing from a described conversation

Ask for the conversation as the customer would experience it, then map it:

1. What starts it? (a keyword is the most common trigger)
2. What does the bot say first?
3. Does it need an answer before continuing? → that message node sets **wait for
   reply**, which pauses the flow until the customer writes back.
4. Where does it branch? → a condition node with the two paths named.
5. How does it end — a link, a handoff, a payment?

**Draw the flow back to the user before creating it.** A branch drawn wrong is much
cheaper to fix in a sketch than in a live automation that has already replied to
someone.

## Things that behave differently than expected

**A flow is created inactive.** Activating is a separate step, and it should be — an
active flow replies to real customers immediately.

**A message node that waits for a reply pauses the whole execution.** The customer's
next message resumes it rather than starting anything new. That is why a flow which
waits and never gets an answer simply stops; there is a timeout (default 24h) after
which it is marked expired.

**A payment node mints a real, payable Razorpay link.** It is guarded so the same node
in the same run can never create two links, but it is still real money. Never add one
without saying plainly that it will charge the customer.

**Only an approved template can be sent from a message node**, and only from the number
it was approved on — same rule as everywhere else (see **forge-growth-templates**).

## Checking what happened

Executions are visible per automation through `/chatbots/:id/executions` and
`/executions/:id`, which record every node visited with its input and output. When a
user says a flow "did not work", read an execution before theorising — it usually names
the node and the reason.
