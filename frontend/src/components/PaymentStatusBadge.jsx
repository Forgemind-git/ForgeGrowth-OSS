// The Sales Log's payment-status pill. Says "Not set" — never a confident
// status — when something was paid but the product has no price to compare
// against and nobody has set it by hand.
import { C } from '../constants.js';
import { Badge } from '../pages/academy/shared.jsx';
import { PAYMENT_STATUS } from '../lib/paymentStatus.js';

export default function PaymentStatusBadge({ status, source, outstandingAmount }) {
  const m = PAYMENT_STATUS[status];
  if (!m) {
    return <Badge label="Not set" color={C.textMuted} bg="var(--c-surfaceMuted, #F1F1EE)" style={{ fontWeight: 500 }} />;
  }
  const title = source === 'manual'
    ? 'Set by hand'
    : outstandingAmount > 0
      ? `Derived from payments · ₹${Math.round(outstandingAmount).toLocaleString('en-IN')} outstanding`
      : 'Derived from payments vs the product price';
  return <span title={title}><Badge label={m.label} color={m.color} bg={m.bg} /></span>;
}
