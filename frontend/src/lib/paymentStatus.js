// Payment status of a sale — display side of backend/src/services/paymentStatus.js.
// Values are fixed KEYS; the registry row only renames/hides the column.
export const PAYMENT_STATUS = {
  paid:    { label: 'Fully paid',     color: 'var(--c-successText, #0F6E56)', bg: 'var(--c-successBg, #E1F5EE)' },
  partial: { label: 'Partially paid', color: 'var(--c-warnText, #8A5A00)',    bg: 'var(--c-warnBg, #FDF1D6)' },
  unpaid:  { label: 'Unpaid',         color: 'var(--c-dangerText, #A32D2D)',  bg: 'var(--c-dangerBg, #FCEBEB)' },
  // Derived only — everything paid was refunded (sale_refunds, migration 132).
  refunded:{ label: 'Refunded',       color: 'var(--c-purple, #534AB7)',      bg: 'var(--c-purpleBg, #EEEDFA)' },
};

export const PAYMENT_STATUS_OPTIONS = [
  { value: '', label: 'Automatic (from payments vs product price)' },
  { value: 'paid', label: 'Fully paid' },
  { value: 'partial', label: 'Partially paid' },
  { value: 'unpaid', label: 'Unpaid' },
];

export function paymentStatusLabel(status) {
  return PAYMENT_STATUS[status]?.label || null;
}
