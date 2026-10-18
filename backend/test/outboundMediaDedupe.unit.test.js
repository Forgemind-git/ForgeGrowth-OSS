// Outbound media is stored once per distinct file (content-addressed _store/)
// with each message's path a hard link to it. These run on a temp MEDIA_DIR.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function tmpMedia() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fg-media-')); }

// Run in a child so MEDIA_DIR is read fresh and no module state leaks.
function persistInChild(mediaDir, calls) {
  // Calls go over stdin: a 200 KB argv string exceeds Linux's per-argument limit.
  const code = `
    const m = require(${JSON.stringify(path.join(ROOT, 'src/services/mediaDownloader'))});
    const calls = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const out = calls.map(c => m.persistOutboundBuffer({
      accountPhoneDigits: c.wa, messageId: c.id, buffer: Buffer.from(c.data), ext: c.ext }));
    process.stdout.write(JSON.stringify(out)); process.exit(0);`;
  const r = spawnSync(process.execPath, ['-e', code], {
    input: JSON.stringify(calls), env: { ...process.env, MEDIA_DIR: mediaDir }, timeout: 20000, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr || String(r.error));
  return JSON.parse(r.stdout);
}

function storeFiles(dir) {
  const s = path.join(dir, '_store'); const out = [];
  if (!fs.existsSync(s)) return out;
  for (const d of fs.readdirSync(s)) for (const f of fs.readdirSync(path.join(s, d))) out.push(path.join(s, d, f));
  return out;
}

test('the same file sent twice is stored once; each message keeps its own path', () => {
  const dir = tmpMedia();
  const video = 'x'.repeat(50000);
  const [a, b, c] = persistInChild(dir, [
    { wa: '911', id: 'local-1-a', data: video, ext: 'mp4' },
    { wa: '922', id: 'local-2-b', data: video, ext: 'mp4' },
    { wa: '911', id: 'local-3-c', data: 'a different brochure', ext: 'pdf' },
  ]);
  assert.notStrictEqual(a.absPath, b.absPath);
  const sa = fs.statSync(a.absPath), sb = fs.statSync(b.absPath), sc = fs.statSync(c.absPath);
  assert.strictEqual(sa.ino, sb.ino, 'identical sends must share one inode');
  assert.notStrictEqual(sa.ino, sc.ino);
  assert.strictEqual(sa.nlink, 3, 'store copy + two messages');
  assert.strictEqual(storeFiles(dir).length, 2);
  assert.strictEqual(fs.readFileSync(b.absPath, 'utf8'), video);
  assert.strictEqual(a.size, 50000);
});

test('deleting one chat\'s file never removes another chat\'s media', () => {
  const dir = tmpMedia();
  const [a, b] = persistInChild(dir, [
    { wa: '911', id: 'local-1', data: 'same-bytes', ext: 'mp4' },
    { wa: '911', id: 'local-2', data: 'same-bytes', ext: 'mp4' },
  ]);
  fs.unlinkSync(a.absPath);
  assert.strictEqual(fs.readFileSync(b.absPath, 'utf8'), 'same-bytes');
});

function seedDuplicates(dir) {
  const big = 'V'.repeat(200000);
  const put = (rel, data) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
  return {
    big,
    outs: [put('911/202609/local-1.mp4', big), put('911/202610/local-2.mp4', big), put('922/202610/local-3.mp4', big)],
    inbound: [put('911/202610/wamid.AAA.mp4', big), put('911/202610/wamid.BBB.mp4', big)],
    unique: put('911/202610/local-9.pdf', 'only one of these'),
  };
}
function runDedupe(dir, args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/dedupeOutboundMedia.js'), ...args],
    { env: { ...process.env, MEDIA_DIR: dir }, timeout: 20000, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}

test('dedupe script: dry run changes nothing; apply links identical outbound files only', () => {
  const dir = tmpMedia();
  const s = seedDuplicates(dir);
  const before = s.outs.map(p => fs.statSync(p).ino);

  const dry = runDedupe(dir, []);
  assert.match(dry, /DRY RUN/);
  assert.deepStrictEqual(s.outs.map(p => fs.statSync(p).ino), before, 'dry run must not touch files');
  assert.strictEqual(storeFiles(dir).length, 0);

  runDedupe(dir, ['--apply']);
  const inos = new Set(s.outs.map(p => fs.statSync(p).ino));
  assert.strictEqual(inos.size, 1, 'all identical outbound copies now one inode');
  for (const p of s.outs) assert.strictEqual(fs.readFileSync(p, 'utf8'), s.big, 'content unchanged');
  assert.strictEqual(storeFiles(dir).length, 1);
  assert.notStrictEqual(fs.statSync(s.inbound[0]).ino, fs.statSync(s.inbound[1]).ino, 'inbound files left alone');
  assert.strictEqual(fs.statSync(s.unique).nlink, 1);

  const again = runDedupe(dir, ['--apply']);
  assert.match(again, /duplicate groups=0/, 'second run is a no-op');
});

test('a new send after the dedupe joins the same stored copy', () => {
  const dir = tmpMedia();
  const s = seedDuplicates(dir);
  runDedupe(dir, ['--apply']);
  const [n] = persistInChild(dir, [{ wa: '933', id: 'local-new', data: s.big, ext: 'mp4' }]);
  assert.strictEqual(fs.statSync(n.absPath).ino, fs.statSync(s.outs[0]).ino);
  assert.strictEqual(storeFiles(dir).length, 1);
});

test('retention cleanup skips shared files (links share the FIRST send\'s age)', () => {
  const dir = tmpMedia();
  const s = seedDuplicates(dir);
  runDedupe(dir, ['--apply']);
  const old = new Date(Date.now() - 400 * 86400e3);
  for (const p of [...s.outs, s.unique]) fs.utimesSync(p, old, old);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/cleanupMedia.js'), '--days', '180', '--dry-run'],
    { env: { ...process.env, MEDIA_DIR: dir }, timeout: 20000, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  // Only the unshared old file qualifies; the shared video (and inbound, which is new) do not.
  assert.match(r.stdout, /deleted=1 files/);
});
