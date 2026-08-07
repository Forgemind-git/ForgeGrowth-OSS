---
name: forge-growth-ads
description: >-
  Read Forge Growth ad performance — Meta campaign spend and results, and click-to-WhatsApp
  attribution (which ad produced which lead, CPL and ROAS). Use when the user asks what
  their ads produced, which ad works, or what a lead costs.
---

# Ads and click-to-WhatsApp

Two layers, and they sit at **different trust tiers**:

| Layer | Reached by | Needs |
|---|---|---|
| Campaign performance | `get_campaign_performance` tool | Marketing Analytics category |
| Click-to-WhatsApp (CTWA) | `forgechat_request` → `/ctwa/*` | Direct API access + **Marketing** area |

## Click-to-WhatsApp

```
GET /ctwa/overview          KPIs, per-ad rows, creatives, placements, clicks over time
GET /ctwa/ads/:sourceId     one ad — its creatives, and the leads it produced
```

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

