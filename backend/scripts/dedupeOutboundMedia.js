#!/usr/bin/env node
// One-time (re-runnable) disk reclaim: identical OUTBOUND media files — the same
// Media Library video or brochure sent to hundreds of chats, each written as its
// own full copy — are collapsed into ONE stored copy under _store/, and every
// message's path becomes a hard link to it. Same layout new sends now use (see
// services/mediaDownloader.js persistOutboundBuffer), so no reader changes and
// no database row changes: every media_storage_path still points at a file.
//
// Only outbound files (name starts with "local-") are touched. Inbound files are
// re-written by downloadOne and are not where the duplication is.
//
//   node scripts/dedupeOutboundMedia.js            # dry run: report only
//   node scripts/dedupeOutboundMedia.js --apply    # do it
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MEDIA_DIR = process.env.MEDIA_DIR || '/app/media';
const STORE_DIR = path.join(MEDIA_DIR, '_store');
const apply = process.argv.includes('--apply');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (full !== STORE_DIR) walk(full, out); }
    else if (e.isFile() && e.name.startsWith('local-') && !/\.(tmp|lnk)-/.test(e.name)) out.push(full);
  }
  return out;
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(1 << 20);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
}

const files = walk(MEDIA_DIR, []);
// Only a size seen more than once can be a duplicate — skip hashing the rest.
const bySize = new Map();
for (const f of files) {
  const st = fs.statSync(f);
  if (st.size === 0) continue;
  if (!bySize.has(st.size)) bySize.set(st.size, []);
  bySize.get(st.size).push({ f, st });
}

let groups = 0, linked = 0, freed = 0, failed = 0;
for (const [size, list] of bySize) {
  if (list.length < 2) continue;
  const byHash = new Map();
  for (const it of list) {
    const h = sha256File(it.f);
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(it);
  }
  for (const [sha, items] of byHash) {
    const inodes = new Set(items.map(i => i.st.ino));
    if (items.length < 2 || inodes.size < 2) continue;
    groups++;
    const ext = path.extname(items[0].f).slice(1) || 'bin';
    const storePath = path.join(STORE_DIR, sha.slice(0, 2), `${sha}.${ext}`);
    const keepIno = fs.existsSync(storePath) ? fs.statSync(storePath).ino : items[0].st.ino;
    const toLink = items.filter(i => i.st.ino !== keepIno);
    // Bytes actually returned: each distinct inode other than the kept one.
    const reclaim = new Set(toLink.map(i => i.st.ino)).size * size;
    console.log(`${(size / 1e6).toFixed(1).padStart(7)} MB x ${String(items.length).padStart(4)} files  sha ${sha.slice(0, 12)}  ${path.basename(items[0].f)}  -> frees ${(reclaim / 1e9).toFixed(2)} GB`);
    if (!apply) { freed += reclaim; linked += toLink.length; continue; }
    if (!fs.existsSync(storePath)) {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.linkSync(items[0].f, storePath);          // promote an existing copy, no extra bytes
    }
    for (const it of toLink) {
      // Re-verify right before swapping: never replace a file whose bytes changed.
      if (sha256File(it.f) !== sha) { failed++; console.error(`  changed since scan, skipped: ${it.f}`); continue; }
      const tmp = `${it.f}.lnk-${process.pid}`;
      try {
        fs.linkSync(storePath, tmp);
        fs.renameSync(tmp, it.f);                        // atomic: path always resolves to a file
        linked++;
      } catch (err) {
        failed++; try { fs.unlinkSync(tmp); } catch {}
        console.error(`  link failed for ${it.f}: ${err.message}`);
      }
    }
    freed += reclaim;
  }
}
console.log(`\n${apply ? '' : '[DRY RUN] '}outbound files scanned=${files.length} duplicate groups=${groups} files ${apply ? 'linked' : 'to link'}=${linked} failed=${failed} space ${apply ? 'freed' : 'to free'}≈${(freed / 1e9).toFixed(2)} GB`);
