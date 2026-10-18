---
name: forge-growth-automations
description: >-
  Build Forge Growth automation flows — the trigger/message/condition/action graphs
  that run when a customer messages in. Use when the user describes a chat flow, wants
  a keyword to trigger a reply, a branching conversation with buttons or a menu, a
  delay, or asks why an automation did not fire.
---

# Automation flows

Tools: `list_automations`, `validate_automation`, `create_automation`, `update_automation`,
`get_automation_runs`. Category: **Automations**.

A flow is **nodes** plus **edges**. It starts at a trigger and walks edges until it
ends, pauses for a reply, or reaches a step with nothing wired.

## The one rule that decides whether a flow works

**Always call `validate_automation` on the graph before you create it.**

Not a formality. Two whole classes of mistake are invisible any other way:

- An edge whose `fromHandle` names an output the step does not have. It is **not** an
  error anywhere — the walker looks for an edge matching a handle, finds none, and the
  run simply ends. On the canvas the connector is parked in a corner. It looks exactly
  like a flow that was meant to stop there.
- A step that offers choices with the reply-wait off. The buttons render, the customer
  taps one, and nothing happens, because the flow already walked past.

`validate_automation` returns `blocking[]` (would be broken at runtime),
`warnings[]` (unfinished but harmless) and `danglingConnections[]` (the first case
above, with the step's real handle names). `create_automation` runs the same check and
**refuses** rather than saving something broken.

## Handles — the exact names

The `fromHandle` on an edge says which output it leaves from. Get these wrong and the
branch silently never fires. `create_automation`'s own description carries the current
list, generated from the validator — trust that over anything written here.

| Step | Handles |
|---|---|
| Anything that does not ask (message, action, delay, trigger) | `default` |
| Condition | `yes`, `no` |
| Ask a question (free text, no choices) | `replied`, `timeout` |
| Ask with buttons | `btn:0`, `btn:1`, … then `nomatch`, `timeout` |
| Ask with a list | `row:<section>:<row>` — e.g. `row:0:0`, `row:0:1` — then `nomatch`, `timeout` |

**A list handle addresses one ROW, not one section.** `row:0` is the old spelling and
is now refused; the commonest list is a single section of several rows, which under the
old form could not branch at all.

`nomatch` = they typed something instead of tapping. `replied` = the answer to a
free-text question — a question offering no choices has no *wrong* answer, which is why
it gets `replied` and not `nomatch`. `timeout` = no reply before the wait expires
(default 24h).

**A link, call or copy-code button has no handle at all.** WhatsApp never tells us it
was tapped, so a branch there could not fire. Continue from `default` instead.

## Designing from a described conversation

1. What starts it? A keyword is the commonest trigger — and a keyword trigger with no
   keyword can never fire, so ask for the actual word.
2. What does the bot say first?
3. Does it need an answer before continuing? Then that step needs **`waitForReply: true`**.
4. Where does it branch, and what happens on each path?
5. How does it end?

**Draw the flow back to the user before creating it.** A branch drawn wrong is far
cheaper to fix in a sketch than in a live automation that has already replied to someone.

Do not send `x`/`y` — positions are assigned automatically, left to right.

## Things that behave differently than expected

**A flow is created as a draft, always.** `create_automation` will not activate one even
if asked, because the activation check lives on the update path — going live means
replying to real customers. Use `update_automation { id, active: true }`, which runs that
check and refuses a flow that would be broken.

**A step that waits pauses the whole execution.** The customer's next message resumes it
rather than starting anything new. A flow that waits and never gets an answer stops
there and is marked expired after the timeout.

**Only an approved template can be sent from a message step**, and only from the number
it was approved on — same rule as everywhere else (see **forge-growth-templates**).
Free-form (`messageMode: "direct"`) content only reaches someone inside the 24-hour
window.

**There is no time-based trigger.** Every trigger kind fires in response to an inbound
message. "Every Monday at 9am" is not an automation — it is a repeating broadcast, see
**forge-growth-messaging**.

## Blocks that no longer exist

Do not offer these; they were removed from the builder:

- **Payment step** — a flow can no longer raise a Razorpay link unattended. Payment
  links are raised from Sales → Payments (**forge-growth-revenue**).
- **AI Agent / AI step inside a flow** — agents are built in their own section
  (**forge-growth-agents**).
- **External API call**, **sub-flow**, **human handoff**, **follow-up sequences**.

A flow imported from elsewhere may still contain one and will still run. You just
cannot add a new one.

## When a flow "did not work"

Read `get_automation_runs` before theorising. Every run records each step it visited
with its input, output and any error, so it usually names the step and the reason
outright. The four answers it most often gives:

- The trigger never matched (wrong keyword, or the customer's message was a button tap).
- The step was reached but the send failed (unapproved template, wrong number, window
  closed).
- The walk ended at a step whose branches were never wired.
- The execution is still `paused`, waiting for a reply that has not come.

## Deleting a flow

`delete_automation` removes a WhatsApp flow for good and lives under **Admin → Delete &
remove**, a separate switch. Pausing (`update_automation {active:false}`) is almost always
what the user means — offer that first. Instagram automations and flows are a different
system: see **forge-growth-social**.
