---
name: forge-growth-ads
description: >-
  Read Forge Growth ad performance — Meta campaign spend and results, click-to-WhatsApp
  attribution (which ad produced which lead, CPL and ROAS), and the Meta Conversions
  API that sends conversions back to optimise delivery. Use when the user asks what
  their ads produced, which ad works, what a lead costs, or about conversion sending.
---

# Ads, click-to-WhatsApp and conversions

Three layers, and they sit at **different trust tiers**:

| Layer | Read with (Marketing Analytics switch) | Changing it |
|---|---|---|
| Overview | `get_marketing_overview` | — |
| Campaigns → ad sets → ads | `get_campaign_performance`, `list_campaign_ads` | in Meta Ads Manager |
| Which ad produced chats and buyers | `get_ad_conversions` | — |
| Click-to-WhatsApp (CTWA) | `get_click_to_whatsapp` | — |
| Conversions API (CAPI) | `get_conversion_api_status`, `list_conversion_events` | `forgechat_request` → `/capi/*`, **Admin** area only |

Every Marketing tool only reads. CAPI writes are admin-tier deliberately: **sending
conversions moves real ad spend**. Reading the CAPI set-up does not grant the ability
to fire conversions, and you should not suggest enabling Admin casually to get it.

Date ranges: `days` (e.g. "30" or "all") or `from`/`to` (IST days, inclusive). With a
range, spend comes from per-day Meta rows — if `spendCoverage.partial` is true, say that
spend before the oldest synced day is missing.

## Click-to-WhatsApp

`get_click_to_whatsapp` returns KPIs, per-ad rows, placements and clicks over time.
One ad's creatives and leads: `forgechat_request GET /ctwa/ads/:sourceId`.

`sourceId` is the **Meta ad id**, which is how a click joins to ad spend.

Three things about this data will produce wrong answers if ignored:

**Spend is LIFETIME per ad, not windowed.** Clicks, leads and revenue respect a date
range; spend does not. The response says so with `spendIsLifetime: true`. Comparing a
7-day lead count against lifetime spend understates ROAS badly — state the mismatch
rather than quoting a blended figure as if both sides matched.

**`allPlatforms` is the full placement list; `platforms` is the filtered one.** If you
are showing the user what they *could* filter by, use `allPlatforms` — the other one
shrinks to whatever is already selected.

**Not every lead is attributable.** Roughly half of WhatsApp arrivals carry no Meta
click id at all (a bio link, a saved number, a pasted link are indistinguishable to
Meta). Those are genuinely "Direct" — a low attribution rate is a property of the
channel, not a bug to chase. Quote CPL against *attributable* leads and say so.

## Campaigns

`get_campaign_performance` returns spend, impressions, clicks and results per campaign,
synced from Meta every few hours. A campaign "Lead" here means **a WhatsApp
conversation started** — that is Meta's attributed number and it is deliberately not
the same as the count of CRM leads in the funnel. When both appear in one answer, label
which is which; they will not match and the difference is expected.

## Conversions API

CAPI sends a signal back to Meta when a lead reaches a chosen funnel stage, so Meta
optimises toward people who actually convert rather than people who merely message.

`get_conversion_api_status` (state, datasets, stage→event mappings) and
`list_conversion_events` (history, including what was skipped and why). Whether ad sets
have enough events for Meta to learn: `forgechat_request GET /capi/learning` (Admin area).

**Sending is off by default and turning it on is the user's decision, not yours.** If
asked to enable it, explain what will start flowing and to which ad account first.

Two behaviours worth relaying accurately when a user asks why something did not send:

- Conversions **older than Meta's 7-day window are skipped, not back-dated**. Back-dating
  would report months-old sales as this week's and inflate the ROAS of a spend window
  that did not earn them.
- A sale marked won with **no payment recorded yet is skipped**, rather than sending a
  ₹0 purchase, so the real amount can still be reported later.

`list_conversion_events` records every skip with its reason. Read it before speculating.
