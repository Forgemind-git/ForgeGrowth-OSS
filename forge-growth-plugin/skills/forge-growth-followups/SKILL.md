---
name: forge-growth-followups
description: >-
  Build and manage Forge Growth follow-up sequences — timed chase messages that fire
  automatically when a lead enters a funnel stage. Use when the user wants to chase
  leads, set up a nurture or drip sequence, add/reorder/remove sequence steps, change
  when a chase stops, or enrol and un-enrol leads. Carries the template rule that
  makes a sequence fail at Meta days later if it is ignored.
---

# Follow-up sequences

A **sequence** is an ordered list of **steps**. Each step waits a while, then sends
one message. A lead is enrolled automatically when it *enters* a chosen funnel stage,
or manually.

No dedicated tools yet — use `forgechat_request` (see **forge-growth-api**). Needs the
**Automations** area.

## The template rule — read this before choosing any template

A step can only use a template whose variables live **in the body**. These are
rejected, and the app tells you which:

| Rejected | Why it matters |
|---|---|
| not `APPROVED` | still a draft or was refused by Meta |
| carousel | multi-card templates cannot be filled per lead here |
| media header (image / video / document) | header media must be resolved per send |
| `{{n}}` in a **text header** | only body variables are filled |
| `COPY_CODE` button | button variables are not filled |
| **URL button containing `{{n}}`** | see below |

That last one silently disqualifies the templates a strategist reaches for first —
**payment links (`/pay/{{1}}`) and lead forms (`/f/…/{{1}}`)**. They look ideal for a
chase and cannot be used as a step.

This matters because a naive check ("is it approved?") passes, and the send then fails
**at Meta, on every attempt, days later**, while the sequence log says it was sent. So:
list templates, filter to body-variables-only, and offer the user only those. If they
ask for a payment or form template specifically, say plainly that it cannot be a step
and offer a text step containing the link instead.

## Building one

```
GET  /follow-up-sequences                       list
POST /follow-up-sequences                       { name, description?, triggerStageKey?,
                                                  stopOnReply?, stopOnStageChange?, projectId? }
POST /follow-up-sequences/:id/steps             { delayMinutes, messageKind,
                                                  templateId?, templateVariables?, body? }
PUT  /follow-up-sequences/:id                   { name?, triggerStageKey?, stopOnReply?,
                                                  stopOnStageChange?, active?, projectId? }
PUT  /follow-up-sequences/:id/steps/reorder     { order: [stepId, ...] }
DELETE /follow-up-steps/:id
```

Order of operations — **activation is last and it is checked**:

1. create the sequence (it starts inactive)
2. add every step
3. `PUT { active: true }`

Activating with no steps is a **400**: *add at least one step first*.

**Booleans must be real booleans.** `"false"` as a string is rejected with a 400 — this
is deliberate, because a truthy string would have switched a live sender ON.

`triggerStageKey` is a funnel **stage key**, not a label — read `/funnel/config` to get
it (see **forge-growth-funnel**).

## Stop rules

Both default on, and both are usually what the user means by "stop chasing them":

- **stopOnReply** — the lead answers, the chase ends.
- **stopOnStageChange** — the lead leaves the stage that enrolled them.

## Things that behave differently than expected

**Activating is never retroactive.** Enrollment reads forward from the moment of
activation, so switching a sequence on does not chase everyone already sitting in that
stage. If the user wants those people, enrol them explicitly:

```
POST /follow-up-sequences/:id/enroll
POST /follow-up-enrollments/:id/stop
```

**Steps cannot be deleted or reordered while runs are live** (409). Enrollments store a
*position*, so reshaping steps underneath a mid-run lead would skip or repeat messages.
Appending a step is always allowed. To restructure, stop the live enrollments first —
and tell the user that is what you are about to do.

**A text step only reaches someone inside the 24-hour window.** Outside it, WhatsApp
refuses free text and only an approved template arrives. A sequence that chases after
several days of silence must use template steps or it will quietly skip.

**Unanswered chases move the lead.** After the configured number of consecutive
follow-ups with no reply, the lead is dropped to the cold stage. That is intended, but
mention it when a user asks for many steps — a five-step chase may re-label the lead
before it finishes.

## Checking what happened

```
GET /follow-up-sequences/:id/enrollments     who is in it, and where
GET /follow-up-sequences/:id/log             what was actually sent, and what was skipped
```

The log records skips with a reason (window closed, template blocked, gave up after 3
attempts). When a user says "it did not send", read the log before theorising.
