// The domains this install answers to.
//
// Implemented once here because two very different callers need the same answer
// and must never disagree: the CORS origin check (every browser request) and
// Caddy's on-demand-TLS `ask` endpoint (every first TLS handshake for a new
// hostname). If those two drifted apart you would get a site that holds a valid
// certificate and then refuses its own API calls with a generic 500 — which
// reads as "the app is broken", not as a configuration mismatch.
//
// See routes/domains.js for the HTTP surface and supabase/migrations/109 for why
// this lives in the database rather than in .env.

const pool = require('../db');

/* ------------------------------------------------------------------ table */

async function ensureDomainTables() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS coexistence.custom_domains (
        id            BIGSERIAL PRIMARY KEY,
        hostname      TEXT NOT NULL UNIQUE,
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        added_by      BIGINT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_asked_at TIMESTAMPTZ,
        last_seen_at  TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS custom_domains_active_idx
        ON coexistence.custom_domains (hostname) WHERE is_active
    `);
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------- normalise */

// One spelling reaches storage and lookup, or the Host header will not match
// what an admin typed. Strips scheme, port, path, trailing dot and case — all of
// which describe the same host and none of which appear in a Host header the way
// a person types them.
function normalizeHostname(raw) {
  let h = String(raw || '').trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // scheme
  h = h.split('/')[0];                            // path
  h = h.split('@').pop();                         // stray credentials
  if (h.startsWith('[')) {                        // bracketed IPv6 keeps its brackets
    const close = h.indexOf(']');
    if (close > 0) h = h.slice(0, close + 1);
  } else {
    h = h.split(':')[0];                          // port
  }
  h = h.replace(/\.$/, '');                       // fully-qualified trailing dot
  return h;
}

// Deliberately strict, because every accepted value becomes something Caddy will
// try to obtain a public certificate for. A wildcard or a bare label cannot get
// one, so refusing here turns a silent ACME failure into an immediate message.
function validateHostname(host) {
  if (!host) return 'Enter a domain, for example crm.example.com';
  if (host.length > 253) return 'That domain is too long';
  if (host === 'localhost') return 'localhost does not need to be added — it always works';
  if (!/^[a-z0-9.-]+$/.test(host)) return 'A domain can only contain letters, numbers, dots and hyphens';
  if (host.includes('..') || host.startsWith('-') || host.startsWith('.') || host.endsWith('-')) {
    return 'That does not look like a valid domain';
  }
  if (!host.includes('.')) return 'Use the full domain, for example crm.example.com';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return 'A certificate cannot be issued for an IP address — use a domain name';
  }
  if (host.startsWith('*')) return 'Wildcard domains are not supported';
  return null;
}

/* ----------------------------------------------------------------- lookup */

// CORS consults this on every browser request, so it cannot be a query each
// time. A short TTL rather than explicit invalidation because the cost of being
// ten seconds stale is that a just-added domain waits ten seconds, while the
// cost of a missed invalidation is a domain that never works until a restart.
let cache = { at: 0, hosts: new Set() };
const CACHE_MS = 10_000;

async function activeHostnames() {
  if (Date.now() - cache.at < CACHE_MS) return cache.hosts;
  try {
    const { rows } = await pool.query(
      'SELECT hostname FROM coexistence.custom_domains WHERE is_active'
    );
    cache = { at: Date.now(), hosts: new Set(rows.map((r) => r.hostname)) };
  } catch (err) {
    // A database blip must not lock every browser out of the app. Serve the last
    // known set and try again on the next request.
    console.error('[domains] could not refresh the domain list:', err.message);
    cache.at = Date.now();
  }
  return cache.hosts;
}

function invalidateCache() {
  cache = { at: 0, hosts: cache.hosts };
}

async function isApproved(hostname) {
  const h = normalizeHostname(hostname);
  if (!h) return false;
  return (await activeHostnames()).has(h);
}

// The origins CORS should accept, derived from the same list. Both schemes are
// returned: the app cannot know from here whether a proxy in front terminates
// TLS, and offering only https would break a plain-HTTP install the moment an
// admin added its domain.
async function allowedOriginsFromDb() {
  const out = [];
  for (const h of await activeHostnames()) {
    out.push(`https://${h}`, `http://${h}`);
  }
  return out;
}

/* ------------------------------------------------------- reachability check */

// Everything above answers "what is configured". None of it answers the only
// question an admin actually has, which is "does this address reach this
// install". Those are different, and the gap between them is silent: DNS can be
// perfect, the certificate valid, every container healthy, and the hostname
// still land on a reverse proxy that routes it somewhere else entirely. It
// presents as a 404 with nothing wrong anywhere.
//
// So this checks the outcome rather than the steps: fetch this install's own
// `ask` endpoint from the outside, over the public address, and see what comes
// back. A 200 is proof of the whole chain at once — DNS resolved, the proxy
// routed it, the container answered, and it was THIS install's database that
// approved the hostname. Nothing else can return 200 for that hostname.
//
// ⚠ This is a server-side fetch to an admin-supplied host, so it is worth being
//   exact about the exposure. The host has already passed validateHostname (no
//   IP literals, no localhost, must be a dotted name), the path and method are
//   fixed, and only the numeric status code is returned to the caller — never a
//   body, a header or a redirect target. What an admin can learn from it is
//   "does that name answer, and with what status", which they can learn from any
//   browser. It is not a general-purpose fetcher and must not grow into one.

const PROBE_TIMEOUT_MS = 8000;

function probeErrorCode(err) {
  if (err && err.name === 'AbortError') return 'ETIMEDOUT';
  return (err && (err.cause?.code || err.code)) || 'EUNKNOWN';
}

// Pure, so the whole decision table is testable without a network or a database.
// Kept as one function rather than scattered through the route because these
// messages are the entire value of the feature: an admin who reads "404" learns
// nothing, and an admin who reads "something answered, but it is not routed to
// this install" knows exactly which of their three moving parts to look at.
function interpretReachability({ scheme, status, errorCode, isActive = true }) {
  if (errorCode) {
    switch (errorCode) {
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
        return {
          level: 'error',
          title: 'That domain does not resolve',
          detail: 'DNS has no address for it yet. Add an A record pointing at this '
                + 'server, then try again — new records can take a few minutes.',
        };
      case 'ECONNREFUSED':
        return {
          level: 'error',
          title: 'The domain resolves, but nothing answered',
          detail: 'It points at a machine that is refusing the connection. Either it '
                + 'is the wrong address, or nothing is listening on that port there.',
        };
      case 'ETIMEDOUT':
      case 'UND_ERR_CONNECT_TIMEOUT':
      case 'UND_ERR_HEADERS_TIMEOUT':
        return {
          level: 'warn',
          title: 'No answer within a few seconds',
          detail: 'A firewall may be blocking it. This can also be a false alarm: some '
                + 'networks stop a server from reaching its own public address, in which '
                + 'case visitors are fine. Open the domain from another device to be sure.',
        };
      case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      case 'SELF_SIGNED_CERT_IN_CHAIN':
      case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      case 'CERT_HAS_EXPIRED':
      case 'ERR_TLS_CERT_ALTNAME_INVALID':
        return {
          level: 'error',
          title: 'The HTTPS certificate is not valid for this domain',
          detail: 'It was reached, but the certificate would make a browser refuse the '
                + 'page. Whatever terminates HTTPS in front of this install needs a '
                + 'certificate covering this exact name.',
        };
      default:
        return {
          level: 'error',
          title: 'Could not reach this domain',
          detail: `The connection failed (${errorCode}). Check that its DNS points at `
                + 'this server and that nothing is blocking the port.',
        };
    }
  }

  if (status === 200) {
    // http-only is deliberately NOT 'ok'. It resolves, it routes and it answers,
    // so every step passed — and the install still cannot receive a Meta webhook
    // or serve a public form link, both of which require https. Grading it green
    // because the request succeeded would be reporting the step instead of the
    // outcome, which is the mistake this whole check exists to stop making.
    return {
      level: scheme === 'https' ? 'ok' : 'warn',
      title: scheme === 'https'
        ? 'Working — this domain reaches this install over HTTPS'
        : 'Reachable, but only over plain HTTP',
      detail: scheme === 'https'
        ? 'DNS, the certificate and the routing are all correct, and the request '
        + 'arrived at this install rather than another one.'
        : 'It reaches this install, but not over https://. Meta refuses a webhook '
        + 'address that is not https, and public form links are built as https. '
        + 'Give whatever sits in front of this install a certificate for this name.',
    };
  }

  // The subtle one, and the reason the check is worth having at all. A 403 means
  // something running this same software answered — and said it does not know
  // this hostname. Since this install plainly does know it, the answer came from
  // a DIFFERENT install. Two checkouts on one machine is exactly how that
  // happens, and no other symptom distinguishes it from a routing mistake.
  if (status === 403) {
    if (!isActive) {
      return {
        level: 'warn',
        title: 'Reached this install, and the domain is switched off',
        detail: 'That is the expected answer while it is inactive. Turn it back on to '
              + 'start accepting it again.',
      };
    }
    return {
      level: 'error',
      title: 'Another install answered',
      detail: 'The request reached a different copy of this software, which does not '
            + 'know this domain. If more than one install runs on that server, the '
            + 'domain is pointed at the wrong one.',
    };
  }

  if (status === 503) {
    return {
      level: 'error',
      title: 'Reached the app, but it could not check its database',
      detail: 'The request arrived here, so DNS and routing are right. The database '
            + 'is the problem — see the backend logs.',
    };
  }

  if (status === 404) {
    return {
      level: 'error',
      title: 'Something answered, but it is not this install',
      detail: 'Usually a reverse proxy that has no route for this domain and served '
            + 'its catch-all instead. Point it at this install, then check again.',
    };
  }

  // 401 is what the check meets most often in practice, and it is not a
  // mysterious edge case: it is any app whose login sits in front of this path.
  // A different product entirely, or an older copy of this one from before the
  // check existed — either way the domain is not pointed at this install.
  if (status === 401) {
    return {
      level: 'error',
      title: 'A different application answered',
      detail: 'Something is running on this domain, but it is not this install — it '
            + 'asked for a login where this install answers publicly. It may also be '
            + 'an older copy of this software. Point the domain here, or upgrade that '
            + 'install if it is the one you meant.',
    };
  }

  // Never followed, and this is the reason. An app that redirects to its own
  // login page would end up at a 200, and a check that reports "working" for
  // somebody else's login screen is worse than no check at all — it is a green
  // light for the exact mistake it exists to catch.
  if (status >= 300 && status < 400) {
    return {
      level: 'error',
      title: 'The domain redirects somewhere else',
      detail: 'Something answered and sent the request on elsewhere instead of serving '
            + 'this install. Check what the domain is routed to.',
    };
  }

  return {
    level: 'error',
    title: `Something answered with HTTP ${status}`,
    detail: 'Whatever replied is not this install. Check that the domain is routed '
          + 'here and not to another site on the same server.',
  };
}

// https first, because that is the address that has to work. Falling back to
// http is not a courtesy — an install behind a proxy that has not been given a
// certificate yet is reachable but not usable, and "reachable over http only" is
// a completely different instruction from "not reachable".
async function checkReachability(hostname, isActive = true) {
  const host = normalizeHostname(hostname);
  const path = `/api/public/tls-check?domain=${encodeURIComponent(host)}`;
  let firstError = null;

  for (const scheme of ['https', 'http']) {
    try {
      const res = await fetch(`${scheme}://${host}${path}`, {
        method: 'GET',
        // Manual, deliberately — see the 3xx branch in interpretReachability.
        // Following a redirect can turn another app's login page into a 200 and
        // report a domain as working when it points somewhere else entirely.
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return { scheme, status: res.status, ...interpretReachability({ scheme, status: res.status, isActive }) };
    } catch (err) {
      const errorCode = probeErrorCode(err);
      // Keep the https failure: it is the more informative one to report if the
      // http attempt fails too, and a certificate error names the real problem
      // where a plain connection error would not.
      if (!firstError) firstError = errorCode;
    }
  }

  return { scheme: 'https', status: null, ...interpretReachability({ scheme: 'https', errorCode: firstError, isActive }) };
}

async function checkDomainById(id) {
  const { rows } = await pool.query(
    'SELECT id, hostname, is_active AS "isActive" FROM coexistence.custom_domains WHERE id = $1',
    [id]
  );
  if (!rows[0]) return null;
  const result = await checkReachability(rows[0].hostname, rows[0].isActive);
  return { hostname: rows[0].hostname, ...result };
}

/* --------------------------------------------- reverse-proxy configuration */

// On a server where this install owns ports 80 and 443, a domain added in the UI
// needs nothing else: the bundled Caddy obtains its certificate on the first
// visit. On a server that already runs something on those ports, it cannot —
// the app has no access to the configuration of a program it does not run.
//
// What it CAN do is write out the exact file that program needs, filled in, so
// the remaining step is copy-and-paste rather than reading a document and
// adapting an example. Everything below is about removing the two mistakes that
// example reliably produces: a service declared per router, and a certresolver
// on a hostname whose ACME challenge can never succeed.

// A Traefik router name. Derived from the first label so it reads like the site,
// and stripped to what Traefik accepts.
function routerNameFor(hostname) {
  const first = String(hostname || '').split('.')[0].replace(/[^a-z0-9-]/g, '');
  return first || 'forgegrowth';
}

// Is this hostname served through a CDN that terminates TLS itself?
//
// This is the one decision in the generated file that cannot be guessed, and
// getting it wrong is not cosmetic: a certresolver on a CDN-fronted host issues
// an ACME challenge that can NEVER succeed, retries forever, and those failures
// are rate-limited per ACME account — enough of them stop unrelated domains on
// the same server from renewing.
//
// Detected rather than asked, because the signal is unambiguous: every response
// through Cloudflare carries a cf-ray header, and other CDNs identify themselves
// in `server` just as plainly. A null answer means "could not tell" and the
// caller says so rather than picking a side.
async function detectCdn(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return { behindCdn: null, name: null };
  try {
    const res = await fetch(`https://${host}/`, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const server = String(res.headers.get('server') || '').toLowerCase();
    if (res.headers.get('cf-ray') || server.includes('cloudflare')) {
      return { behindCdn: true, name: 'Cloudflare' };
    }
    for (const [needle, label] of [
      ['akamai', 'Akamai'], ['fastly', 'Fastly'], ['cloudfront', 'CloudFront'], ['sucuri', 'Sucuri'],
    ]) {
      if (server.includes(needle)) return { behindCdn: true, name: label };
    }
    return { behindCdn: false, name: null };
  } catch {
    // Unreachable tells us nothing about a CDN, and inventing an answer here is
    // how the wrong certresolver decision gets baked into a file someone pastes.
    return { behindCdn: null, name: null };
  }
}

const NETWORK_PLACEHOLDER = 'REPLACE_WITH_YOUR_PROXY_NETWORK';

// Pure: same inputs, same file. Kept separate from detectCdn so the whole
// decision table is testable without a network.
function buildTraefikOverlay({ hostname, behindCdn, cdnName, network, certResolver }) {
  const host = normalizeHostname(hostname);
  const name = routerNameFor(host);
  const net = network || NETWORK_PLACEHOLDER;
  const resolver = certResolver || 'YOUR_CERT_RESOLVER';

  // Three states, because "could not tell" must not silently become "no CDN".
  const certLines = behindCdn === true
    ? [
      '      # No certresolver, deliberately.',
      `      # ${cdnName || 'A CDN'} terminates TLS at its edge, so a TLS-ALPN-01 challenge`,
      '      # can never reach Traefik. It would fail on every attempt forever, and those',
      '      # failures are rate-limited per ACME ACCOUNT — enough of them stop unrelated',
      '      # domains on this server from renewing. Traefik serves its self-signed default',
      `      # to ${cdnName || 'the CDN'}, which accepts it and gives the browser a valid certificate.`,
    ]
    : behindCdn === false
      ? [
        `      - traefik.http.routers.${name}.tls.certresolver=${resolver}`,
        '      # ⚠ Replace the resolver name with the one your Traefik defines. It is NOT',
        '      #   always "letsencrypt" — a name that does not exist yields no certificate',
        '      #   and no error. Check with:',
        "      #     docker inspect <traefik> --format '{{join .Config.Cmd \"\\n\"}}' | grep certificatesresolvers",
      ]
      : [
        `      # - traefik.http.routers.${name}.tls.certresolver=${resolver}`,
        '      # ⚠ Could not reach this hostname, so whether a CDN fronts it is unknown.',
        '      #   If DNS points straight at this server, uncomment the line above and set',
        '      #   your resolver name. If a CDN (Cloudflare and the like) terminates TLS,',
        '      #   leave it commented — its challenge could never succeed, and the failures',
        '      #   are rate-limited per ACME account.',
      ];

  return [
    `# Traefik routing for ${host} -> this Forge Growth install.`,
    '#',
    '# Generated by Admin Settings -> Domain. Save it OUTSIDE the install directory:',
    '# install.sh re-downloads and overwrites docker-compose.yml on every upgrade, so',
    '# labels added there survive until the next upgrade and then vanish, months later,',
    '# with nothing connecting cause to effect.',
    '',
    'services:',
    '  web:',
    `    networks: [default, ${net}]`,
    '    labels:',
    '      - traefik.enable=true',
    `      - traefik.docker.network=${net}`,
    '',
    '      # ⚠ ONE service, named explicitly on the router below.',
    '      #   Traefik links a router to a service automatically only when the container',
    '      #   declares exactly one. Declare two — the obvious way to write two routers —',
    '      #   and it discards EVERY router on this container, answering 404 from its',
    '      #   catch-all, with one line in its log and nothing else.',
    `      - traefik.http.services.${name}.loadbalancer.server.port=80`,
    '',
    `      - "traefik.http.routers.${name}.rule=Host(\`${host}\`)"`,
    `      - traefik.http.routers.${name}.entrypoints=web,websecure`,
    `      - traefik.http.routers.${name}.tls=true`,
    `      - traefik.http.routers.${name}.priority=10`,
    `      - traefik.http.routers.${name}.service=${name}`,
    ...certLines,
    '',
    'networks:',
    `  ${net}:`,
    '    external: true',
    '',
  ].join('\n');
}

// The steps around the file. Assembled here rather than in the UI so the file
// and the commands that apply it cannot drift apart.
function overlayInstructions({ hostname, network }) {
  const host = normalizeHostname(hostname);
  const path = `/opt/forgegrowth-${host}.yml`;
  const needsNetwork = !network;
  return {
    path,
    commands: [
      ...(needsNetwork
        ? [{
          label: 'Find the network your reverse proxy is on, and put its name in the file',
          cmd: "docker inspect <your-traefik-container> \\\n"
             + "  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{\"\\n\"}}{{end}}'",
        }]
        : []),
      {
        label: 'Save the file above, then point this install at it',
        cmd: `echo 'COMPOSE_FILE=docker-compose.yml:${path}' >> .env`,
      },
      {
        label: 'Apply it — only the web container is recreated, Traefik is not restarted',
        cmd: 'docker compose up -d web',
      },
    ],
    notes: [
      'COMPOSE_FILE belongs in .env, never exported in a shell. Exported it is eventually '
      + 'forgotten, and the next `docker compose up -d` brings the stack up healthy with no '
      + 'domain attached — every container green, the site a 404.',
      'Traefik reads these labels from the Docker socket, so it is never restarted and no '
      + 'other site on the server is affected.',
      'After applying, press Check on this domain. It fetches the address from outside and '
      + 'says which part of the chain is still broken, if any.',
    ],
  };
}

async function buildOverlayFor(hostname, network) {
  const host = normalizeHostname(hostname);
  const cdn = await detectCdn(host);
  return {
    hostname: host,
    routerName: routerNameFor(host),
    behindCdn: cdn.behindCdn,
    cdnName: cdn.name,
    networkPlaceholder: network ? null : NETWORK_PLACEHOLDER,
    // `cdnName`, not a spread of `cdn`: detectCdn returns { behindCdn, name },
    // and spreading it drops the name silently — the file then says "A CDN"
    // where it should name the one actually in front of this host.
    yaml: buildTraefikOverlay({
      hostname: host, behindCdn: cdn.behindCdn, cdnName: cdn.name, network,
    }),
    ...overlayInstructions({ hostname: host, network }),
  };
}

/* ------------------------------------------------------------------ writes */

async function listDomains() {
  const { rows } = await pool.query(`
    SELECT id,
           hostname,
           is_active     AS "isActive",
           created_at    AS "createdAt",
           last_asked_at AS "lastAskedAt",
           last_seen_at  AS "lastSeenAt"
      FROM coexistence.custom_domains
     ORDER BY hostname
  `);
  return rows;
}

async function addDomain(rawHost, userId) {
  const hostname = normalizeHostname(rawHost);
  const problem = validateHostname(hostname);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });

  const { rows } = await pool.query(
    `INSERT INTO coexistence.custom_domains (hostname, added_by)
          VALUES ($1, $2)
     ON CONFLICT (hostname)
     DO UPDATE SET is_active = TRUE, updated_at = NOW()
       RETURNING id, hostname, is_active AS "isActive", created_at AS "createdAt"`,
    [hostname, userId || null]
  );
  invalidateCache();
  return rows[0];
}

async function setActive(id, isActive) {
  const { rows } = await pool.query(
    `UPDATE coexistence.custom_domains
        SET is_active = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id, hostname, is_active AS "isActive"`,
    [id, !!isActive]
  );
  invalidateCache();
  return rows[0] || null;
}

async function removeDomain(id) {
  const { rowCount } = await pool.query(
    'DELETE FROM coexistence.custom_domains WHERE id = $1',
    [id]
  );
  invalidateCache();
  return rowCount > 0;
}

// Best-effort stamps. Never awaited by the caller and never allowed to throw:
// these are diagnostics, and a failed UPDATE must not turn into a refused
// certificate or a rejected request.
function stampAsked(hostname) {
  pool.query(
    'UPDATE coexistence.custom_domains SET last_asked_at = NOW() WHERE hostname = $1',
    [hostname]
  ).catch(() => {});
}

function stampSeen(hostname) {
  pool.query(
    'UPDATE coexistence.custom_domains SET last_seen_at = NOW() WHERE hostname = $1 AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL \'5 minutes\')',
    [hostname]
  ).catch(() => {});
}

module.exports = {
  ensureDomainTables,
  normalizeHostname,
  validateHostname,
  interpretReachability,
  checkReachability,
  checkDomainById,
  routerNameFor,
  buildTraefikOverlay,
  buildOverlayFor,
  detectCdn,
  isApproved,
  allowedOriginsFromDb,
  activeHostnames,
  invalidateCache,
  listDomains,
  addDomain,
  setActive,
  removeDomain,
  stampAsked,
  stampSeen,
};
