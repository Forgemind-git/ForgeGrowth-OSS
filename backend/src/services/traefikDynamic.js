// Automatic routing for installs that do NOT own ports 80/443.
//
// Traefik can watch a directory for route files in addition to the container
// labels it already reads. Given that directory, this install can publish its
// own routes — so a domain added in Admin Settings → Domain works with no shell
// at all, matching what a server that owns the ports already does.
//
// ⚠ THE SAFETY PROPERTY, and the reason this is written the way it is.
//
// Anything written here is honoured by a Traefik that also serves other people's
// sites. So the question is not "does this work" but "what is the worst this can
// do". Three things bound it, and each is a mechanism rather than an intention:
//
//   1. Only hostnames an admin added. Routes are generated from
//      coexistence.custom_domains and nothing else. There is no path from a
//      request, a header or a webhook to a route file.
//
//   2. priority: 1 — the lowest Traefik accepts. A router's default priority is
//      the length of its rule, around 30 for a typical Host(). So ANY existing
//      router for a hostname beats this one. The route takes effect when nothing
//      else claims that name and loses when something does, which is exactly
//      "it takes the domain I entered" without "it can take somebody else's".
//
//   3. Files are namespaced per install and only ever removed if they carry this
//      install's own prefix. Two installs sharing one directory cannot delete
//      each other's routes, and neither can delete a file a human put there.
//
// Off unless BOTH env vars are set. Deliberately not inferred: a directory
// guessed wrongly is either useless or writes routes into somebody else's
// Traefik, and neither failure announces itself.

const fs = require('fs/promises');
const path = require('path');
const pool = require('../db');

const DIR = String(process.env.TRAEFIK_DYNAMIC_DIR || '').trim();
// How Traefik reaches this install over the shared network — a container name,
// because a compose service alias is not unique once two installs share a
// network and `web` would then resolve to whichever container answered first.
const UPSTREAM = String(process.env.PROXY_UPSTREAM || '').trim();

function enabled() {
  return Boolean(DIR && UPSTREAM);
}

// A stable, filesystem-safe identifier for THIS install, derived from the
// upstream it publishes. Two installs on one server have different containers,
// so they get different prefixes and cannot touch each other's files.
function instanceSlug() {
  return UPSTREAM
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'forgegrowth';
}

const FILE_PREFIX = () => `fg-${instanceSlug()}--`;

function hostSlug(hostname) {
  return String(hostname).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function fileNameFor(hostname) {
  return `${FILE_PREFIX()}${hostSlug(hostname)}.yml`;
}

// Pure. One router, one service, per file — so a bad entry can only ever affect
// its own hostname, and removing a domain is removing one file.
//
// No certresolver, ever, on this path. A file-provider route cannot know whether
// a CDN fronts the name, and a resolver on a CDN-fronted host fails its ACME
// challenge forever while consuming a per-ACCOUNT rate limit that unrelated
// domains on the same server depend on. TLS terminates here with whatever
// default certificate Traefik holds; a CDN in front supplies the real one, and a
// direct hostname that wants its own should use the generated compose overlay,
// where the decision is made with the CDN actually detected.
function buildRouteFile({ hostname, upstream, routerName }) {
  const name = routerName || `${FILE_PREFIX()}${hostSlug(hostname)}`;
  return [
    `# ${hostname} -> ${upstream}`,
    '#',
    '# Written by Forge Growth (Admin Settings -> Domain). Managed automatically:',
    '# edits are overwritten, and the file is deleted when the domain is removed.',
    '#',
    '# priority 1 is the lowest Traefik accepts, on purpose. A router\'s default',
    '# priority is its rule length (~30), so ANY existing router for this hostname',
    '# wins over this one. This route applies only where nothing else claims the',
    '# name -- it cannot take traffic away from another site on this Traefik.',
    'http:',
    '  routers:',
    `    ${name}:`,
    `      rule: "Host(\`${hostname}\`)"`,
    '      entryPoints: [web, websecure]',
    `      service: ${name}`,
    '      priority: 1',
    '      tls: {}',
    '  services:',
    `    ${name}:`,
    '      loadBalancer:',
    '        servers:',
    `          - url: "${upstream}"`,
    '',
  ].join('\n');
}

// Make the directory match the active domain list: write what should exist,
// remove what this install previously wrote and no longer needs, and touch
// nothing else. Traefik picks changes up by watching the directory, so there is
// no restart and no signal to send.
async function reconcile() {
  if (!enabled()) return { enabled: false };
  let wrote = 0; let removed = 0;
  try {
    const { rows } = await pool.query(
      'SELECT hostname FROM coexistence.custom_domains WHERE is_active'
    );
    const desired = new Map(rows.map((r) => [fileNameFor(r.hostname), r.hostname]));

    await fs.mkdir(DIR, { recursive: true });

    for (const [file, hostname] of desired) {
      const body = buildRouteFile({ hostname, upstream: UPSTREAM });
      const full = path.join(DIR, file);
      let current = null;
      try { current = await fs.readFile(full, 'utf8'); } catch { /* absent */ }
      if (current !== body) {
        // Written via a temp file in the same directory and renamed, so Traefik
        // — which is watching — never reads a half-written route.
        const tmp = `${full}.tmp`;
        await fs.writeFile(tmp, body, { mode: 0o644 });
        await fs.rename(tmp, full);
        wrote += 1;
      }
    }

    const prefix = FILE_PREFIX();
    for (const file of await fs.readdir(DIR)) {
      // ⚠ The ownership test. Anything without THIS install's prefix belongs to
      //   another install or to a person, and is never removed.
      if (!file.startsWith(prefix) || !file.endsWith('.yml')) continue;
      if (desired.has(file)) continue;
      await fs.unlink(path.join(DIR, file)).catch(() => {});
      removed += 1;
    }
  } catch (err) {
    // Routing is best-effort around the request that triggered it. A directory
    // that is read-only or unmounted must not turn "add a domain" into a 500 —
    // the domain is still added, and the screen still explains the manual path.
    console.error('[traefik] could not reconcile route files:', err.message);
    return { enabled: true, error: err.message };
  }
  if (wrote || removed) console.log(`[traefik] routes: ${wrote} written, ${removed} removed`);
  return { enabled: true, wrote, removed };
}

module.exports = { enabled, reconcile, buildRouteFile, fileNameFor, instanceSlug };
