// The login cookie's signing key and its flags, defined once.
//
// Both used to live at each call site, and both were wrong in the same way —
// a value that looked right locally and silently degraded on a real install:
//
//   * the key was read as JWT_SECRET, but every installer writes
//     FORGECRM_JWT_SECRET (scripts/generate-secrets.sh, install.sh, .env.example,
//     and the header of docker-compose.images.yml all agree on that name). The
//     `||` fallback then signed real sessions with the development key printed
//     below — which is published in this repository. Meanwhile routes/mcpOAuth.js
//     verified with the *correct* name, so the two halves never agreed.
//
//   * `secure` was derived from NODE_ENV, which both compose files pin to
//     "production" even when the site is served over plain HTTP. A `Secure`
//     cookie sent to an http:// origin is discarded by the browser with no error
//     anywhere: login returns 200 and the SPA renders from the response body,
//     then the next request arrives with no cookie and gets 401. It presents as
//     "logged out on refresh", not as a cookie problem.
//
// Anything that signs, verifies or sets a session token imports from here.

const DEV_SECRET = 'forgecrm-dev-secret-change-me';

const JWT_SECRET =
  process.env.FORGECRM_JWT_SECRET || process.env.JWT_SECRET || DEV_SECRET;

if (JWT_SECRET === DEV_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error(
      '[auth] FORGECRM_JWT_SECRET is not set.\n' +
      '       Refusing to start: the fallback signing key ships in this public\n' +
      '       repository, so anyone could mint themselves an admin session.\n' +
      '       Generate one and restart:\n' +
      "         echo \"FORGECRM_JWT_SECRET=$(openssl rand -base64 48 | tr -d '\\n=+/')\" >> .env"
    );
    process.exit(1);
  }
  console.warn('[auth] FORGECRM_JWT_SECRET unset — signing with the development key.');
}

// Whether the browser reaches this install over HTTPS. Decided from the address
// the browser actually uses, never from NODE_ENV.
//
// COOKIE_SECURE overrides for the case this container cannot observe: TLS
// terminated by a reverse proxy the install does not manage, where CORS_ORIGIN
// may still read http://. Getting it wrong in the false direction only loses the
// "never send this over plaintext" hardening; getting it wrong in the true
// direction logs everybody out, so an unknown answer resolves to false.
function cookieSecure() {
  const override = String(process.env.COOKIE_SECURE || '').trim().toLowerCase();
  if (override) return override === '1' || override === 'true' || override === 'yes';
  if (String(process.env.TLS_DOMAIN || '').trim()) return true;   // install.sh --domain
  return /^https:\/\//i.test(String(process.env.CORS_ORIGIN || '').trim());
}

// sameSite is 'lax', not 'strict'. Under 'strict' the cookie is withheld on every
// inbound top-level navigation, so a user arriving from a WhatsApp link, an email
// or a bookmark in another tab lands on the login screen while still holding a
// valid session. 'lax' still withholds it from cross-site POST/PUT/DELETE, which
// is the CSRF case that matters.
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(),
    path: '/',
  };
}

module.exports = { JWT_SECRET, cookieOptions, cookieSecure };
