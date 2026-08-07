// The priced-message view, and the rule for what counts as billed.
//
// Kept in a module with NO database or queue import so it can be reasoned about
// (and unit-tested) on its own: services/messageCosts.js and
// routes/messageCosts.js both build on this exact fragment, which is what stops
// the per-template total and the per-category total ever disagreeing about what
// one message cost.

// Meta bills on DELIVERY. A message that only ever reached 'sent' has not been
// charged for, and counting it would overstate the bill.
const BILLED_STATUSES = new Set(['delivered', 'read', 'played']);

// Rate precedence, most to least trustworthy:
//   free         — Meta itself said the message is not billable
//   meta_exact   — Meta's cost/volume for this exact day + country + category + type
//   meta_blended — Meta's cost/volume for the day + category + type, all countries
//   fallback     — the editable rate card (today's traffic, before the next sync)
//
// rate_source travels with every row so the dashboard can state how much of a
// figure is Meta-confirmed rather than implying it is all invoice-accurate.
//
// ⚠ The unit rate is DERIVED (cost / volume), never stored. Measured on this
// account, the same UTILITY category bills at Rs 0.1150 for India and Rs 4.0322
// for Germany — a single hardcoded rate would under-report by ~97% the moment
// one international message goes out, and would go stale silently every time
// Meta reprices or a volume tier kicks in.
const PRICED_CTE = `
  WITH rates_exact AS (
    SELECT waba_id, day, country, pricing_category AS category, pricing_type AS ptype,
           CASE WHEN SUM(volume) > 0 THEN SUM(cost) / SUM(volume) ELSE NULL END AS unit
      FROM coexistence.waba_pricing_daily
     GROUP BY 1,2,3,4,5
  ),
  rates_blended AS (
    SELECT waba_id, day, pricing_category AS category, pricing_type AS ptype,
           CASE WHEN SUM(volume) > 0 THEN SUM(cost) / SUM(volume) ELSE NULL END AS unit
      FROM coexistence.waba_pricing_daily
     GROUP BY 1,2,3,4
  ),
  priced AS (
    SELECT b.*,
           CASE
             WHEN NOT b.billable THEN 0
             ELSE COALESCE(re.unit, rb.unit, f.rate, 0)
           END AS unit_cost,
           CASE
             WHEN NOT b.billable            THEN 'free'
             WHEN re.unit IS NOT NULL       THEN 'meta_exact'
             WHEN rb.unit IS NOT NULL       THEN 'meta_blended'
             WHEN f.rate  IS NOT NULL       THEN 'fallback'
             ELSE 'unknown'
           END AS rate_source
      FROM coexistence.message_billing_events b
      LEFT JOIN rates_exact re
             ON re.waba_id = b.waba_id AND re.day = b.day
            AND re.country = b.country_code AND re.category = b.category AND re.ptype = b.pricing_type
      LEFT JOIN rates_blended rb
             ON rb.waba_id = b.waba_id AND rb.day = b.day
            AND rb.category = b.category AND rb.ptype = b.pricing_type
      LEFT JOIN coexistence.whatsapp_rate_fallback f
             ON f.country = COALESCE(b.country_code, 'IN') AND f.category = b.category
  )
`;

module.exports = { PRICED_CTE, BILLED_STATUSES };
