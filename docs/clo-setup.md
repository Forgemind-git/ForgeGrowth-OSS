# Conversion Leads Optimisation (CLO)

Forge Growth → **Marketing → Lead Optimisation**

CLO lets Meta optimise ad delivery toward leads that actually become customers,
rather than leads that merely fill in a form. It works by sending your CRM's
down-funnel stage data back to Meta.

---

## Read this before anything else

**CLO only works with Facebook and Instagram Lead Ads (Instant Forms).** It does
not work with click-to-WhatsApp traffic. If your ads open a WhatsApp
conversation, this feature does not apply to them — that is the separate
**Conversion API** tab, which uses a different dataset, a different identifier
and a different attribution window.

**Two halves are required, and each is useless alone:**

| | What it does |
|---|---|
| Conversions API | The transport. Carries stage data to Meta. |
| Conversion Leads goal | The setting in Ads Manager that *consumes* that data. |

Sending data without switching the goal changes your reporting but **not your
delivery**. Switching the goal without sending data gives Meta nothing to learn
from. Do both.

**Expect a 2–4 week training period.** Meta needs a sustained volume of events
before delivery meaningfully changes. Judging it after a few days will mislead
you in both directions.

---

## Meta's eligibility criteria

The **Readiness** tab measures every one of these against your live data and
tells you the actual number. You do not need to check them by hand.

| Criterion | Requirement |
|---|---|
| Ad type | Lead Ads (Instant Forms) |
| Lead volume | 200+ per month |
| Upload cadence | At least once daily |
| Optimisation stage timing | Reached within **28 days** of lead creation |
| Optimisation stage rate | Between **1% and 40%** |
| Identifier | 15–17 digit Meta Lead ID stored per lead |

On the rate: Meta also says the stage is "ideally" reached by a third to a half
of leads. That overlaps the 1–40% rule only between **33% and 40%**, so the app
highlights that intersection as ideal and warns above 40%. The inconsistency is
Meta's, not the app's.

---

## Setup

### 1. Create a CRM dataset in Events Manager

Events Manager → **Data sources** → **Add** → choose a **CRM** dataset.

> Use a **separate dataset** from any web or messaging one. Meta treats them as
> different event sources, and mixing CRM events into a web dataset corrupts
> both funnels. The app cannot detect this for you.

Copy the numeric dataset ID.

### 2. Generate a system-user token

Business Settings → **Users → System Users** → add or select one → **Generate
new token**.

Required scopes: `ads_management`, `leads_retrieval`.

Use a **System User** token, not a personal user token — personal tokens expire
and the dispatch silently stops.

### 3. Configure Forge Growth

Marketing → Lead Optimisation → **Setup**:

- Paste the **Dataset ID** (numeric — the app rejects a name)
- Paste the **access token** and press Save. It is encrypted at rest, never
  returned by any endpoint, and never written into a stored payload.
- Leave **Dry run ON** for now
- Add a **Test event code** from Events Manager → Test Events
- Press **Send test event** and confirm it appears in Test Events

The `fbtrace_id` shown next to the result is what Meta support will ask for if
anything is rejected.

### 4. Configure the funnel in Meta

In Ads Manager, set up your sales funnel stages so their names match exactly the
**event names** you configure in the next step. Meta matches these by string.
A trailing space or different capitalisation means the event is silently ignored
— it looks identical to nothing being sent.

### 5. Map your stages

Marketing → Lead Optimisation → **Funnel Stages**:

- Add a stage per rung of your funnel, ordered earliest to deepest (drag to
  reorder)
- **Display name** is yours; **Meta event name** must match your Meta funnel
- Tick the Forge Growth lead statuses that mean the stage was reached — a stage
  with nothing mapped can never fire, and the app says so
- Mark exactly one stage as the **optimisation target**

Each row shows live numbers from your own data: what fraction of leads reach it,
the median days to get there, and 30-day volume. Warnings appear inline when a
stage is too rare, too common, or typically reached outside the 28-day window.

### 6. Go live

1. Check the **Readiness** tab — fix anything marked Fail
2. Turn **Dry run OFF**
3. Turn the **master switch ON**
4. In Ads Manager, set the ad set's performance goal to **Conversion Leads** and
   pick your optimisation stage

Optionally run a **backfill** first (see below) so Meta starts with recent
history rather than nothing.

---

## How data reaches Meta

Nothing is sent from the request that changes a lead's stage. Instead:

1. A lead changes stage anywhere in the app, which writes a `lead_events` row
2. Every 15 minutes a sweep reads new rows, checks eligibility, and queues events
3. The same cycle sends queued events in batches of up to 1000

Fifteen minutes gives comfortable margin over Meta's "at least once daily"
requirement. **Send now** on the Event Log tab runs the cycle immediately.

Because the sweep reads `lead_events` rather than hooking individual code paths,
any future feature that moves a lead is covered automatically.

---

## Backfill

`POST /api/marketing/clo/backfill` with an optional `{ "days": 28 }`.

Replays stage transitions already recorded, through **exactly the same gates** as
the live path — the 28-day window, duplicate suppression, identifier checks. It
cannot introduce an event the live path would have refused.

The window is capped at 28 days because Meta rejects anything older; reaching
further back only manufactures skipped rows.

Pass `{ "dryRunOnly": true }` to build the payloads without sending, to see what
a backfill would produce.

---

## Reading the diagnostics

**Event Log** shows every attempt and its outcome. The summary strip deliberately
ignores your status filter — it exists to explain why the filtered view is
smaller than you expected, so it always describes the whole period.

| Status | What it means | What to do |
|---|---|---|
| `sent` | Meta accepted it | Nothing |
| `pending` | Queued, not yet dispatched | Wait, or Send now |
| `dry_run` | Built and stored; nothing transmitted | Turn dry run off |
| `failed` | Meta rejected it, or the network failed | Read the error; Retry |
| `skipped_duplicate` | Already reported for that stage | Nothing — working as intended |
| `skipped_out_of_window` | Lead older than 28 days at stage time | Choose an earlier optimisation stage |
| `skipped_no_identifier` | No Meta Lead ID and no usable phone or email | See below |

**Retry only applies to `failed` rows.** A skipped row was declined for a reason
that re-running would hit again, so retrying it would appear to work and do
nothing. Use the backfill instead once the underlying cause is fixed.

Transient failures (5xx, rate limits) retry automatically on a widening delay and
stop after 6 attempts. Validation failures (4xx) are terminal — Meta has given
its answer, and retrying only burns quota.

---

## Identifiers, and why match rate drops without them

The best identifier is the **Meta Lead ID** — the 15–17 digit id Meta assigns to
an Instant Form submission. Store it on the lead as `meta_lead_id` when ingesting
Lead Ads leads.

Without it the app falls back to SHA-256 hashed phone and email. Meta accepts
this, but matches at a **much lower rate**, and every such event writes a warning
to the backend log.

If the Readiness tab reports 0% Meta Lead ID coverage, that is the single
highest-value thing to fix — everything else works and simply matches poorly.

---

## Privacy

- Personal values (phone, email) are **SHA-256 hashed after normalisation**
  before transmission. Meta receives fingerprints, never plaintext.
- Phone numbers are normalised to digits with country code; emails are trimmed
  and lowercased. Both spellings of the same phone must hash identically — this
  is asserted in the test suite, because a wrong normalisation still returns
  `200 OK` from Meta and matches nobody.
- The Meta Lead ID is sent raw: it is Meta's own identifier, not personal data.
- The access token is encrypted at rest, never returned by any endpoint, and
  never stored inside an event payload. The test suite asserts this.

---

## Running the tests

```bash
cd backend && npm test
```

Unit tests need nothing. Integration tests need a reachable database and skip
cleanly without one. They stub `fetch` for the whole file, so no test can reach
Meta even if the dry-run logic were wrong.

---

## Troubleshooting

**Everything is `skipped_no_identifier`** — no lead carries a Meta Lead ID. Check
your Lead Ads ingestion is populating `meta_lead_id`.

**Everything is `dry_run`** — dry run is still on. Setup tab.

**Nothing appears at all** — the master switch is off, or no lead status is
mapped to a stage. Both are reported on the Readiness tab.

**Meta accepts events but delivery does not change** — the Ads Manager goal is
probably still Leads rather than Conversion Leads, or you are inside the 2–4 week
training period.

**`failed` with an "Invalid parameter" error** — usually the event name does not
match the Meta funnel exactly, or the dataset is a web dataset rather than a CRM
one.
