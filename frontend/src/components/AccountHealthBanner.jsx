// AccountHealthBanner — warns when a WhatsApp Business account can't actually
// deliver messages, BEFORE a send fails. Meta accepts a template send (returns
// a wamid) even when the WABA is blocked for billing/quality reasons; that only
// surfaces as an async "failed" webhook (e.g. 131042/141006 "no payment
// method"). This banner asks Meta's own health_status up front so the user sees
// the real reason instead of a generic "Broadcast failed."
//
// Props:
//   accountId — narrow the check to one account (else all active accounts)
//   phone     — narrow by sending phone number (digits or +form)
//   style     — optional wrapper style overrides
import { useState, useEffect } from 'react';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';

// AVAILABLE = fine (no banner). BLOCKED = can't send at all. LIMITED = degraded.
// UNKNOWN = we couldn't reach Meta / no token — worth a soft heads-up.
const SEVERITY = {
  BLOCKED: { level: 'error', label: "Can't send messages" },
  LIMITED: { level: 'warn', label: 'Sending is limited' },
  UNKNOWN: { level: 'warn', label: 'Delivery status unavailable' },
};

// Meta's billing-hub is where payment-method errors (the most common blocker)
// get fixed. A generic link is safer than guessing per-account deep links.
const BILLING_HUB = 'https://business.facebook.com/billing_hub/accounts';

export default function AccountHealthBanner({ accountId, phone, style }) {
  const [problems, setProblems] = useState(null); // null=loading, []=all healthy

  useEffect(() => {
    let alive = true;
    api.whatsappAccounts.health({ accountId, phone })
      .then(res => {
        if (!alive) return;
        const bad = (res.accounts || []).filter(a => a.canSend && a.canSend !== 'AVAILABLE');
        setProblems(bad);
      })
      .catch(() => { if (alive) setProblems([]); }); // never block the page on a health check
    return () => { alive = false; };
  }, [accountId, phone]);

  if (!problems || problems.length === 0) return null;

  // Worst severity drives the banner color: any BLOCKED → error red.
  const anyBlocked = problems.some(p => p.canSend === 'BLOCKED');
  const level = anyBlocked ? 'error' : 'warn';
  // ⚠ Use the semantic PAIR, never one half. The background and border here
  // were hardcoded literals while the foreground was a token, so in dark mode
  // the amber text (#F0BC4A) sat on a pale cream (#FEF9E7) at 1.66:1 —
  // unreadable. A half-tokenised pair is worse than tokenising neither.
  const bg = level === 'error' ? C.dangerBg : C.warnBg;
  const fg = level === 'error' ? C.dangerText : C.warnText;
  const bd = level === 'error' ? C.dangerBorder : C.warnBorder;

  return (
    <div style={{
      background: bg, border: `1px solid ${bd}`, borderRadius: 10, padding: '12px 14px',
      display: 'flex', gap: 11, alignItems: 'flex-start', fontFamily: FONT, marginBottom: 16, ...style,
    }}>
      <AlertTriangle size={18} color={fg} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {problems.map((p, i) => {
          const sev = SEVERITY[p.canSend] || SEVERITY.UNKNOWN;
          return (
            <div key={p.id} style={{ marginTop: i ? 8 : 0 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: fg }}>
                {sev.label}
                {p.displayName ? ` — ${p.displayName}` : ''}
                {p.displayPhoneNumber ? ` (${p.displayPhoneNumber})` : ''}
              </div>
              <div style={{ fontSize: 14, color: fg, opacity: 0.9, marginTop: 2, lineHeight: 1.45 }}>
                {p.reason || 'Meta reports this account cannot currently send business-initiated messages.'}
                {p.solution ? ` ${p.solution}` : ''}
              </div>
            </div>
          );
        })}
        <a href={BILLING_HUB} target="_blank" rel="noopener noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 8, fontSize: 14, fontWeight: 700, color: fg, textDecoration: 'none' }}>
          Open Meta billing settings <ExternalLink size={13} />
        </a>
      </div>
    </div>
  );
}
