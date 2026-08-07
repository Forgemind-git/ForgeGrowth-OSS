---
name: forge-growth-messaging
description: >-
  Send WhatsApp messages from Forge Growth — replying to one person, sending an
  approved template, sending a file or buttons, or broadcasting to a list. Use when
  the user wants to message, reply to, chase or blast anyone. Covers the 24-hour
  window that decides whether free text is even possible, and what a broadcast really
  costs.
---

# Sending

Tools: `send_message` (free text), `send_template`, `send_media`, `send_interactive`,
`send_bulk_message`. Categories: **Send Messages** and **Broadcasts**.

Every send needs a **`fromNumber`** — the business number to send *as*. Never guess it.
Use `list_conversations` (each row carries the number the conversation is on) or
`list_wa_accounts`, and if there is more than one, **ask the user which**.

## The 24-hour window decides everything

WhatsApp only allows free-form text within **24 hours of the customer's last inbound
message**. Outside it, Meta refuses free text and only an **approved template** arrives.

`list_conversations` and `read_messages` both return a `window` with `open` and
`secondsRemaining` — check it before choosing. If the window is closed, `send_message`
returns `OUTSIDE_WINDOW`; that is not a failure to retry, it is a signal to switch to
`send_template`.

A closed window is also why a "quick follow-up" to someone who went quiet days ago
needs a template, and why that template must already be approved on that number.

## Sending files

`send_media` takes a Media Library id or a public https URL. **It cannot take a file
the user attached to this chat** — those bytes are not available to you and the call
hangs rather than failing. Ask them to upload it once in the Media Library, or give a
URL.

## Broadcasts — this is the one that costs money

`send_bulk_message` messages an entire uploaded list at once and **Meta charges per
message**. Before sending:

1. Show the audience — count, and a sample of who is on it.
2. Show the exact message that will go out, with variables filled for a real row.
3. Get an explicit yes. Never infer approval from "sounds good".

Text mode only reaches people **inside** their 24-hour window, so a cold list silently
reaches almost nobody — a cold list must use a template. Per-recipient template
variables come from the sheet's own columns.

A broadcast appears in the Bulk Message page with real delivery stats, so after sending
you can report what actually landed rather than what was queued.

## Reading before writing

`list_conversations` (recent threads, unread counts, window status) and `read_messages`
(one thread's history) are in the **Conversations** category and are read-only. Use
them to ground a reply in what was actually said — quoting the customer's own words
back is usually what the user wants, and guessing the context is how a send goes wrong.

## Never

Do not send anything the user has not seen. Do not retry an `OUTSIDE_WINDOW` failure
unchanged. Do not switch to a different number to get around a template that is not
approved on the requested one — say so instead.
