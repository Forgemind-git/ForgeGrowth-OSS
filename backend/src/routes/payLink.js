// ─── Public payment-link redirect:  GET /pay/:token  ────────────────────────
//
// The destination of a payment template's URL button. It exists so an approved
// Meta template never has to name Razorpay's domain.
//
// ⚠ WHY THE INDIRECTION IS THE WHOLE POINT
// Meta bakes a URL button's base into the template AT APPROVAL. If the button
// pointed at Razorpay, the day Razorpay changes its short-link format (this
// account issues https://rzp.io/rzp/… ; older accounts issue https://rzp.io/i/…)
// every approved template would break and re-approval takes days. Our own base
// is permanent and the token resolves to whatever the gateway issues today.
//
// It also means a link can be REGENERATED without reprinting the template, and
// that a cancelled or expired link shows the customer a real explanation instead
// of dumping them on a dead gateway page.
//
// PUBLIC BY NECESSITY — the customer opens it from WhatsApp, with no session.
// The token is the credential: 9 random bytes, unguessable, and it reveals
// nothing but a payment page the recipient was already sent.

const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db');

const publicRouter = Router();

// Its own bucket, deliberately NOT shared with anything else. A customer
// re-tapping a link they were sent must never be refused because some other
// public endpoint was busy — a payment link they cannot open is a sale lost.
//
// ⚠ KEYED ON THE TOKEN, NOT THE IP. This app runs with `trust proxy` off
// (deliberately — see the MCP OAuth notes), so behind Traefik + nginx `req.ip`
// is the PROXY's address and every customer in the world would share one
// bucket: a few hundred taps a minute across all of them and real payers start
// getting refused. express-rate-limit says as much on boot
// (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR).
//
// A per-token limit is the precise thing anyway — one token is one payment link
// for one person, so this bounds hammering a single link without any customer
// being able to affect another. Enumeration is not what this defends against:
// the token is 9 random bytes (72 bits) and the hex shape-check below rejects
// junk before it ever reaches the database.
const payLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `pay:${req.params.token || 'none'}`,
  validate: { xForwardedForHeader: false },   // we do not key on the IP at all
  handler: (req, res) => res.status(429).type('html').send(page(
    'Just a moment',
    'That link was opened a lot in the last minute. Wait a few seconds and tap it again.'
  )),
});

// A tiny self-contained page. No external assets (the CSP blocks them anyway)
// and no branding claims we cannot back up.
function page(title, message, link) {
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#F7F7F3;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#111;padding:24px}
 .c{background:#fff;border:1px solid #E5E5E0;border-radius:14px;padding:28px 26px;max-width:420px;width:100%;
    box-shadow:0 8px 24px rgba(0,0,0,.06);text-align:center}
 h1{font-size:18px;margin:0 0 10px}
 p{font-size:14px;line-height:1.6;color:#4B5563;margin:0}
 a.btn{display:inline-block;margin-top:18px;background:#0F6E56;color:#fff;text-decoration:none;
       padding:11px 20px;border-radius:9px;font-size:14px;font-weight:600}
</style></head><body><div class="c"><h1>${esc(title)}</h1><p>${esc(message)}</p>
${link ? `<a class="btn" href="${esc(link)}">Continue to payment</a>` : ''}</div></body></html>`;
}

publicRouter.get('/pay/:token', payLimiter, async (req, res) => {
  const token = String(req.params.token || '').trim();
  // Shape check before touching the database — the token is always hex.
  if (!/^[a-f0-9]{8,64}$/i.test(token)) {
    return res.status(404).type('html').send(page('Link not found', 'This payment link is not valid. Please ask for a new one.'));
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, short_url, status, amount_paise, amount_paid_paise, kind, expire_by, razorpay_link_id
         FROM coexistence.payment_requests WHERE public_token = $1`, [token]);
    const r = rows[0];
    if (!r) {
      return res.status(404).type('html').send(page('Link not found', 'This payment link is not valid. Please ask for a new one.'));
    }

    // Record the tap. Never allowed to block the redirect — a stats write must
    // not stand between a paying customer and the payment page.
    pool.query(
      `UPDATE coexistence.payment_requests
          SET click_count = click_count + 1,
              first_clicked_at = COALESCE(first_clicked_at, NOW()),
              last_clicked_at = NOW()
        WHERE id = $1`, [r.id]
    ).catch(err => console.error('[pay] click stamp:', err.message));

    // A settled link is a better message than a gateway error page. A PART
    // payment that is only partially paid is still payable, so it falls through.
    const fullyPaid = r.status === 'paid';
    if (fullyPaid) {
      return res.status(200).type('html').send(page('Already paid', 'This payment has already been completed. Thank you! If you think this is wrong, reply on WhatsApp and we will check.'));
    }
    if (r.status === 'cancelled') {
      return res.status(200).type('html').send(page('Link cancelled', 'This payment link was cancelled. Reply on WhatsApp and we will send you a new one.'));
    }
    if (r.status === 'expired' || (r.expire_by && new Date(r.expire_by) <= new Date())) {
      return res.status(200).type('html').send(page('Link expired', 'This payment link has expired. Reply on WhatsApp and we will send you a fresh one.'));
    }
    if (!r.short_url) {
      return res.status(200).type('html').send(page('Not ready yet', 'This payment link is still being set up. Try again in a minute, or reply on WhatsApp.'));
    }

    // 302, not 301: a permanent redirect would be cached by the customer's
    // browser and would keep sending them to a link we may later cancel or
    // replace. This destination is genuinely temporary.
    res.redirect(302, r.short_url);
  } catch (err) {
    console.error('[pay] redirect error:', err.message);
    res.status(500).type('html').send(page('Something went wrong', 'We could not open your payment link just now. Please reply on WhatsApp and we will help.'));
  }
});

module.exports = { publicRouter };
