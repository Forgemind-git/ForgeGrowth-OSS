// The address the outside world reaches this install on, defined once.
//
// Four call sites used to work this out independently — the OAuth issuer, the
// Streamable HTTP transport's WWW-Authenticate challenge, the /mcp/install
// panel and the plugin .zip — and they did not agree:
//
//   * three of them split `x-forwarded-host` on commas and one did not, so an
//     install behind two proxy hops wrote `https://a.example.com, b.example.com`
//     into the plugin's .mcp.json — a URL that can never resolve.
//   * the plugin pinned `https://` textually while /mcp/install read the
//     forwarded scheme, so a plain-HTTP install showed one URL on screen and
//     shipped a different one in the download.
//   * the env fallbacks were spelled differently in each place
//     (FORGEGROWTH_DOMAIN vs FORGECRM_DOMAIN), so only some of them had one.
//
// The failure that produces is the worst kind for a connector: the URL looks
// right, the page it is copied from looks right, and the client reports a
// credentials error for what is actually a wrong address. Whatever the plugin
// ships MUST be byte-identical to what the OAuth metadata advertises, which is
// only guaranteed if both come from here.

// First value of a possibly comma-joined proxy header. Each hop appends, so the
// left-most entry is the one the browser actually typed.
function firstHeader(value) {
  return String(value || '').split(',')[0].trim();
}

// A host with no public DNS — an http:// origin is legitimate here, and Claude
// accepts loopback over plain HTTP.
function isLoopback(host) {
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name === '::1' || /^127\./.test(name);
}

// Host[:port]. The request wins over configuration: it is how the browser
// reached us, and a stale FORGECRM_DOMAIN must not override a working address.
function publicHost(req) {
  const forwarded = firstHeader(req?.headers?.['x-forwarded-host']);
  if (forwarded) return forwarded;
  const host = firstHeader(req?.headers?.host);
  if (host) return host;
  const tls = String(process.env.TLS_DOMAIN || '').trim();
  if (tls) return tls;
  const cors = firstHeader(process.env.CORS_ORIGIN).replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (cors) return cors;
  return String(process.env.FORGECRM_DOMAIN || '').trim();
}

// http or https.
//
// `trust proxy` is off in this app, so req.protocol reports http even on a TLS
// request — the forwarded header is the only truthful source behind a proxy.
// When it says http for a PUBLIC host we still answer https: an http issuer is
// rejected outright by MCP clients, and every deployment that reaches a public
// hostname terminates TLS somewhere. Loopback is the exception where http is
// both true and accepted, so it is the one case allowed through.
function publicScheme(req, host = publicHost(req)) {
  const forwarded = firstHeader(req?.headers?.['x-forwarded-proto']).toLowerCase();
  if (forwarded === 'https') return 'https';
  if (isLoopback(host)) {
    if (forwarded === 'http') return 'http';
    return /^https:/i.test(firstHeader(process.env.CORS_ORIGIN)) ? 'https' : 'http';
  }
  return 'https';
}

// scheme://host[:port], with no trailing slash. Empty string when the host
// cannot be worked out at all — callers decide whether that is fatal.
function publicOrigin(req) {
  const host = publicHost(req);
  if (!host) return '';
  return `${publicScheme(req, host)}://${host}`;
}

// The connector address: what goes in .mcp.json, what the admin pastes into
// Claude, and what the OAuth layer calls the protected resource.
function mcpUrl(req) {
  const origin = publicOrigin(req);
  return origin ? `${origin}/api/mcp` : '';
}

module.exports = { publicHost, publicScheme, publicOrigin, mcpUrl, isLoopback };
