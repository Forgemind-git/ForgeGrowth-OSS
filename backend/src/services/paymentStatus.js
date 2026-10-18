// Payment status of a SALE — has this customer paid for the product in full?
//
// The status is DERIVED by default and OVERRIDABLE by a person:
//   • Automatic: total paid (the deduped gateway+manual union) against the
//     product's default price (`courses.default_price_paise`, matched by name —
//     the same rule productSales.js uses to attribute a sale to a product).
//     paid >= price → 'paid' · 0 < paid < price → 'partial' · nothing → 'unpaid'.
//   • Manual: `leads.payment_status` (migration 116). A negotiated fee, a
//     discount or a fee waiver makes the default price the wrong yardstick, so
//     an operator can state the truth and the derivation steps aside.
//
// When something has been paid but the product has no price, nothing can be
// concluded — the status is null ("not set") rather than a guess. A confident
// "Fully paid" over an unknown fee is exactly the wrong thing to show a BDA
// deciding whether to chase someone.

const STATUSES = ['paid', 'partial', 'unpaid'];

const LABELS = {
  paid: 'Fully paid',
  partial: 'Partially paid',
  unpaid: 'Unpaid',
  // DERIVED only (never a manual override): everything paid was given back.
  refunded: 'Refunded',
};

function isPaymentStatus(v) { return STATUSES.includes(v); }

/**
 * @param {object} args
 * @param {string|null} args.override      leads.payment_status (manual)
 * @param {number|string|null} args.totalPaidPaise
 * @param {number|string|null} args.pricePaise  product default price, if any
 * @param {number|string|null} args.refundedPaise  refunds recorded on the sale (migration 132)
 * @returns {{ status: 'paid'|'partial'|'unpaid'|'refunded'|null, source: 'manual'|'auto'|null, outstandingPaise: number|null }}
 *
 * Refunds come off the paid total before anything is compared. When the whole
 * amount paid has been refunded the sale reads 'refunded' — that wins even over
 * a manual "paid", because money given back cannot still be fully paid.
 */
function derivePaymentStatus({ override, totalPaidPaise, pricePaise, refundedPaise } = {}) {
  const gross = Math.max(0, Math.round(Number(totalPaidPaise || 0)));
  const refunded = Math.max(0, Math.round(Number(refundedPaise || 0)));
  if (gross > 0 && refunded >= gross) return { status: 'refunded', source: 'auto', outstandingPaise: 0 };
  const paid = Math.max(0, gross - refunded);
  const price = pricePaise == null || pricePaise === '' ? null : Math.round(Number(pricePaise));
  const priceKnown = Number.isFinite(price) && price > 0;
  const outstandingPaise = priceKnown ? Math.max(0, price - paid) : null;

  if (isPaymentStatus(override)) {
    // A manual "paid" means nothing is owed whatever the price says.
    return { status: override, source: 'manual', outstandingPaise: override === 'paid' ? 0 : outstandingPaise };
  }
  if (priceKnown) {
    const status = paid >= price ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
    return { status, source: 'auto', outstandingPaise };
  }
  if (paid <= 0) return { status: 'unpaid', source: 'auto', outstandingPaise: null };
  return { status: null, source: null, outstandingPaise: null };
}

module.exports = { STATUSES, LABELS, isPaymentStatus, derivePaymentStatus };
