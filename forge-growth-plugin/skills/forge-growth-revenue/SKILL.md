---
name: forge-growth-revenue
description: >-
  Read and report Forge Growth money — products and their prices, sales (who bought
  what), manual payments and refunds, and what Meta charged for messages. Use when the
  user asks about revenue, sales, who paid, refunds, product pricing, or WhatsApp
  messaging costs.
---

# Products, sales and costs

Tools (Products & Sales switch, read-only): `list_sales` (who bought, total paid,
payment status), `get_sale_transactions` (one customer's payments), `list_products` and
`get_product_revenue`. Everything else goes through `forgechat_request` (see
**forge-growth-api**).

| What | Path | Area |
|---|---|---|
| Products and prices | `/products` (`/courses` still answers) | Products |
| Product revenue | `/products/revenue` | Products |
| Sales (won-stage leads) | `/students` | Sales |
| A sale's payments | `/students/:id/installments` | Sales |
| A sale's refunds | `/students/:id/refunds` | Sales |
| Message costs | `/message-costs/*` | Dashboard & logs |

## What counts as a sale

A **sale is an enrolled lead** — a person who reached the won funnel stage. A
**transaction** is one payment recorded against them. Payments are manual: they are
recorded with `POST /students/:id/installments`, nothing arrives from a payment gateway.
One sale can have many transactions (instalments), so "number of sales" and "number of
payments" are different numbers and should be labelled as such. Refunds live under
`/students/:id/refunds`; net them off rather than ignoring them.

Recording a payment or refund changes the books — preview it and get a yes first.

## Revenue

`/products/revenue` returns revenue per product plus an `unattributed` bucket for
payments with no product. Report `unattributed` alongside the products rather than
dropping it, or the total will not add up. Amounts are whatever was recorded by hand, so
do not assume they include or exclude GST — say what you do not know.

**Money may be stored in paise.** A field ending `_paise` is an integer of paise; a
field named `amount` or `total` is usually already rupees. Read the field name before
doing arithmetic — reporting paise as rupees overstates by 100×, and it looks plausible.

## Products

A product's `defaultPrice` is its headline price and is optional. Picking a product may
pre-fill an amount, but a typed amount always wins — never overwrite a figure the user
entered.

## Message costs

`/message-costs/overview`, `/templates`, `/breakdown`, `/trend` report what Meta
charged, per template and per message type. Costs are synced using each WhatsApp
account's own token.

**The unit rate is read from Meta, never assumed.** The same template category can cost
very different amounts by destination country — a UTILITY message can be about ₹0.12 to
India and over ₹4 to Germany. Any "cost per message" you quote must come from the data,
not a rate you remember.

Billing happens on **delivery**, not on send, and GST is reported as a separate line so
the figures stay comparable with Meta's own reporting. Meta's total can legitimately
exceed what Forge Growth attributes — usually numbers billed on a WhatsApp account that
is not connected to this app. The overview says when that applies; relay it rather than
calling the difference an error.
