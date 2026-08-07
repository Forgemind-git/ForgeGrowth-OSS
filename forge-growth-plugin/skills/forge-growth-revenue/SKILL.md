---
name: forge-growth-revenue
description: >-
  Read and report Forge Growth money — products and their prices, the Razorpay payment
  ledger, the sales log of who bought what, and what Meta charged for messages. Use
  when the user asks about revenue, sales, who paid, refunds, payment links, product
  pricing, or WhatsApp messaging costs. Carries the rounding and double-count traps
  that silently produce wrong totals.
---

# Revenue, payments and costs

Tools: `list_products`, `get_product_revenue`, `list_payments`. Everything else goes
through `forgechat_request` (see **forge-growth-api**).

| What | Path | Area |
|---|---|---|
| Products and prices | `/products` (`/courses` still answers) | Products |
| Payment ledger + summary | `/razorpay/payments`, `/razorpay/payments/summary` | Payments |
| Sales log / students | `/students`, `/sales-log` | Payments |
| Message costs | `/message-costs/*` | Dashboard & logs |
| **Minting a payment link** | `/payment-requests` | **Admin** |

Creating a payment link is admin-tier because it produces something a customer can
really pay. Reading the ledger does not grant it.

## Two traps that silently produce wrong totals

**Razorpay writes SEVERAL rows with `status='captured'` for ONE payment.** A card
payment produces `payment.captured` *and* `order.paid`; a payment-link payment produces
a third. Summing captured rows double- or triple-counts revenue.

Always prefer the endpoints that already dedupe — `/razorpay/payments/summary`,
`/students`, `get_product_revenue` — over adding up raw rows yourself. If you must
aggregate, dedupe by `payment_id`.

**Money is stored in paise.** A field ending `_paise` is an integer of paise; a field
named `amount` or `total` is usually already rupees. Read the field name before doing
arithmetic — reporting paise as rupees overstates by 100×, and it looks plausible.

## What counts as a sale

A **sale is an enrolled lead** — a person who reached the won funnel stage. A
**transaction** is one payment against them: a captured Razorpay payment matched to
their lead, or a manually logged one. One sale can have many transactions
(instalments), so "number of sales" and "number of payments" are different numbers and
should be labelled as such.

Payments that arrived before their lead existed may show as unmatched. That is history,
not breakage — the match is re-evaluated as leads appear.

## Products

A product's `defaultPrice` is its headline price and is optional. It is **not** the
same as a payment link's amount: a link matches a real payment by its exact amount
(full price, early bird, a discount), while the default price is just what you would
normally charge. Do not substitute one for the other.

Picking a product may pre-fill an amount, but a typed amount always wins — never
overwrite a figure the user entered.

## Message costs

`/message-costs/overview`, `/templates`, `/breakdown`, `/trend` report what Meta
charged, per template and per message type.

**The unit rate is read from Meta, never assumed.** The same template category can cost
very different amounts by destination country — on this account a UTILITY message is
about ₹0.12 to India and over ₹4 to Germany. Any "cost per message" you quote must come
from the data, not a rate you remember.

Billing happens on **delivery**, not on send, and GST is reported as a separate line so
the figures stay comparable with Meta's own reporting. Meta's total can legitimately
exceed what Forge Growth attributes — usually numbers billed on a WhatsApp account that
is not connected to this app. The overview says when that applies; relay it rather than
calling the difference an error.
