// services/outboundAudio.js against the real ffmpeg. An OGG/Opus file sent as a
// plain audio message is delivered and then cannot be played on iPhone, so what
// matters is: browser recordings come out as a mono OGG/Opus voice note under
// 512 KB, a recording too long for that comes out as MP3, and formats WhatsApp
// already plays as a file pass through untouched.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { prepareOutboundAudio, VOICE_NOTE_MAX_BYTES } = require('../src/services/outboundAudio');

let hasFfmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { hasFfmpeg = false; }

// A stereo webm/opus clip, like Chrome's MediaRecorder produces.
function recording(seconds) {
  return execFileSync('ffmpeg', [
    '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
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

describe('prepareOutboundAudio', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, () => {
  test('a browser recording becomes a mono OGG/Opus voice note', async () => {
    const out = await prepareOutboundAudio(recording(5), 'audio/webm;codecs=opus');
    assert.strictEqual(out.voice, true);
    assert.strictEqual(out.mime, 'audio/ogg');
    assert.strictEqual(out.ext, 'ogg');
    assert.ok(out.buffer.length <= VOICE_NOTE_MAX_BYTES);
    const p = probe(out.buffer);
    assert.match(p, /codec_name=opus/);
    assert.match(p, /channels=1/);
  });

  test('a recording too long for a voice note goes out as MP3, not as a voice note', async () => {
    const out = await prepareOutboundAudio(recording(200), 'audio/webm');
    assert.strictEqual(out.voice, false);
    assert.strictEqual(out.mime, 'audio/mpeg');
    assert.match(probe(out.buffer), /codec_name=mp3/);
  });

  test('MP3, AAC, MP4 and AMR are sent as they are', async () => {
    const buf = Buffer.from('not decoded');
    for (const [mime, ext] of [['audio/mpeg', 'mp3'], ['audio/aac', 'aac'], ['audio/mp4', 'm4a'], ['audio/amr', 'amr']]) {
      const out = await prepareOutboundAudio(buf, mime);
      assert.deepStrictEqual(out, { buffer: buf, mime, ext, voice: false });
    }
  });
});
