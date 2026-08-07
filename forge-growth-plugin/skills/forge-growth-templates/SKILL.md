---
name: forge-growth-templates
description: >-
  Build WhatsApp message templates in Forge Growth and get them approved by Meta —
  drafting body/header/footer/buttons, variable samples, submitting, and polling for
  approval. Use when the user wants a new template, a template edited or resubmitted,
  or asks why a template was rejected or cannot be sent. Covers the WABA rule that
  makes an approved template fail on a different number.
---

# Templates and Meta approval

Tools: `list_templates`, `get_template`, `create_template`, `submit_template`,
`sync_template`. Category: **Template Builder**.

Lifecycle is `DRAFT → SUBMITTED → APPROVED` (or `REJECTED`). Only an **APPROVED**
template can be sent, and Meta approval takes minutes to hours. Meta does not push the
result — `sync_template` re-reads it.

## The rule that surprises people most

**A template exists only on the WhatsApp number it was approved under.** Sending it
from a different number fails with Meta error #132001 ("template does not exist"), even
though the template is plainly visible in the list.

So always pair a template with its number. When the user says "send template X from
number Y", check X was approved on Y before promising anything.

## Drafting

Confirm the content with the user **before** submitting — a rejected template costs a
re-submit and another wait.

- **Variables** are `{{1}}`, `{{2}}` … in the body, numbered from 1 with no gaps. Every
  variable needs a **sample value** or Meta rejects the template outright.
- **Header** is text or one media item. A media header needs a Media Library id
  (`headerMediaLibraryId`), not a URL — see the **forge-growth-api** skill if you need
  to look one up, or `list_media` with a `name` search.
- **Footer** takes no variables.
- **Buttons**: max 2 URL, 1 phone. A URL button containing `{{1}}` is a *dynamic* URL
  and also needs a sample.
- **Category** is usually MARKETING; UTILITY is for transactional messages and is
  cheaper, but Meta rejects marketing content submitted as utility.

Always `get_template` and show the user the real body, header, buttons and samples
before using a template id you did not just create. Names are not unique enough to
identify one confidently.

## Payment and form templates

A template whose URL button points at a payment link or a lead form uses a base URL
**owned by Forge Growth** (`/pay/{{1}}`, `/f/<slug>/{{1}}`), never the gateway's own
short link. Meta bakes the button's base into the template **at approval**, so pointing
it at an external domain would mean the template dies whenever that domain's link
format changes, and re-approval takes days.

Those templates are created from their own screens (Payments, Forms) so the button is
attached correctly. If a user asks you to hand-build one, point them there instead.

**A dynamic-URL template cannot be used as a follow-up step** — see
**forge-growth-followups** for why.

## When Meta rejects

Relay Meta's reason verbatim; it is usually specific (promotional content in a UTILITY
template, a missing sample, a variable at the very start or end of the body). Fix and
create a **new** version rather than arguing with the existing one — a rejected
template can be edited and resubmitted, but the reason must actually be addressed or
it will be rejected again the same way.
