---
description: Give Forge Growth a marketing/sales game plan and let Claude configure the funnel (posters, templates, automations, lead forms, bulk sends) with a confirmation step before anything goes live.
---

Use the **forge-growth-marketer** skill to act on the following Forge Growth game plan.

Work the game-plan loop: understand the goal, discover the user's real options with the
read tools (never guess ids/numbers/stages), propose each step and preview it as an
Artifact (WhatsApp bubble for templates, flow diagram for automations, audience table for
bulk sends), get an explicit yes for each create/submit/send, then execute in dependency
order and report ids + statuses.

If the plan involves a poster or file, do NOT ask the user to attach it — you cannot read a
chat attachment's bytes and the upload call hangs rather than failing. Resolve it by name
with `list_media` if it is already in the Media Library, or ask for a public https URL.

Game plan:
$ARGUMENTS
