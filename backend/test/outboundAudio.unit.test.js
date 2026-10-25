// services/outboundAudio.js against the real ffmpeg.
//
// Voice notes: iPhone plays an API voice note only in WhatsApp's own layout
// (48 kHz mono Opus, 120 ms packets, audio on one Ogg page, vendor "WhatsApp");
// ffmpeg's default OGG is delivered and then "no longer available". So the
// assertions are about exactly those properties, plus valid page checksums —
// a rewritten page with a wrong CRC is a file no client will read.
//
// Other audio: anything not already playable as a file becomes AAC/M4A.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { prepareOutboundAudio, prepareVoiceNote, VOICE_NOTE_MAX_BYTES, _oggCrc } = require('../src/services/outboundAudio');

let hasFfmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { hasFfmpeg = false; }

// A stereo webm/opus clip, like Chrome's MediaRecorder produces. Noise, not a
// tone: a tone compresses so well that no length overflows a voice note.
function recording(seconds) {
  return execFileSync('ffmpeg', [
    '-loglevel', 'error', '-f', 'lavfi', '-i', `anoisesrc=d=${seconds}:a=0.3`,
    '-ac', '2', '-c:a', 'libopus', '-b:a', '128k', '-f', 'webm', 'pipe:1',
  ], { maxBuffer: 64 * 1024 * 1024 });
}

// Through a file: ffprobe stops reading stdin early on a long MP3 (EPIPE).
function probe(buffer) {
  const f = path.join(os.tmpdir(), `probe-${process.pid}-${Date.now()}`);
  fs.writeFileSync(f, buffer);
  try {
    return execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,channels', '-of', 'default=nw=1', f]).toString();
  } finally { fs.unlinkSync(f); }
}

function oggPages(buf) {
  const pages = [];
  for (let o = 0; o < buf.length;) {
    assert.strictEqual(buf.toString('latin1', o, o + 4), 'OggS');
    const nseg = buf[o + 26];
    let len = 0;
    for (let i = 0; i < nseg; i++) len += buf[o + 27 + i];
    pages.push(buf.subarray(o, o + 27 + nseg + len));
    o += 27 + nseg + len;
  }
  return pages;
}

function packetDurations(buffer) {
  const f = path.join(os.tmpdir(), `pk-${process.pid}-${Date.now()}.ogg`);
  fs.writeFileSync(f, buffer);
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_packets', '-show_entries', 'packet=duration', '-of', 'csv=p=0', f]).toString();
    return out.split('\n').filter(Boolean).map(l => Number(l.split(',')[0]));
  } finally { fs.unlinkSync(f); }
}

describe('prepareVoiceNote', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, () => {
  test('a recording becomes a voice note in WhatsApp\'s own layout', async () => {
    const out = await prepareVoiceNote(recording(5), 'audio/webm;codecs=opus');
    assert.strictEqual(out.voice, true);
    assert.strictEqual(out.mime, 'audio/ogg');
    assert.ok(out.buffer.length <= VOICE_NOTE_MAX_BYTES);

    const head = out.buffer.indexOf('OpusHead');
    assert.strictEqual(out.buffer[head + 9], 1, 'mono');
    assert.strictEqual(out.buffer.readUInt32LE(head + 12), 48000, '48 kHz');
    const tags = out.buffer.indexOf('OpusTags');
    const vlen = out.buffer.readUInt32LE(tags + 8);
    assert.strictEqual(out.buffer.toString('latin1', tags + 12, tags + 12 + vlen), 'WhatsApp');
    assert.strictEqual(out.buffer.readUInt32LE(tags + 12 + vlen), 0, 'no comments');

    const pages = oggPages(out.buffer);
    assert.strictEqual(pages.length, 3, 'OpusHead, OpusTags, one audio page');
    for (const p of pages) {
      const stored = p.readUInt32LE(22);
      const zeroed = Buffer.from(p); zeroed.writeUInt32LE(0, 22);
      assert.strictEqual(_oggCrc(zeroed), stored, 'page checksum');
    }
    const d = packetDurations(out.buffer);
    assert.ok(d.slice(0, -1).every(x => x === 5760), '120 ms packets');
  });

  test('a recording too long for a voice note goes out as ordinary M4A audio', async () => {
    const out = await prepareVoiceNote(recording(240), 'audio/webm');
    assert.strictEqual(out.voice, false);
    assert.strictEqual(out.mime, 'audio/mp4');
  });
});

describe('prepareOutboundAudio', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, () => {
  test('a browser recording becomes mono AAC in M4A', async () => {
    const out = await prepareOutboundAudio(recording(5), 'audio/webm;codecs=opus');
    assert.strictEqual(out.mime, 'audio/mp4');
    assert.strictEqual(out.ext, 'm4a');
    assert.strictEqual(out.voice, false);
    const p = probe(out.buffer);
    assert.match(p, /codec_name=aac/);
    assert.match(p, /channels=1/);
  });

  test('an OGG/Opus voice note (e.g. forwarded) is converted too', async () => {
    const ogg = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-c:a', 'libopus', '-ac', '1', '-f', 'ogg', 'pipe:1'], { input: recording(3) });
    const out = await prepareOutboundAudio(ogg, 'audio/ogg');
    assert.strictEqual(out.mime, 'audio/mp4');
    assert.match(probe(out.buffer), /codec_name=aac/);
  });

  test('MP3, AAC, MP4/M4A and AMR are sent as they are', async () => {
    const buf = Buffer.from('not decoded');
    for (const [mime, sent, ext] of [['audio/mpeg', 'audio/mpeg', 'mp3'], ['audio/aac', 'audio/aac', 'aac'], ['audio/mp4', 'audio/mp4', 'm4a'], ['audio/x-m4a', 'audio/mp4', 'm4a'], ['audio/amr', 'audio/amr', 'amr']]) {
      const out = await prepareOutboundAudio(buf, mime);
      assert.deepStrictEqual(out, { buffer: buf, mime: sent, ext, voice: false });
    }
  });
});
