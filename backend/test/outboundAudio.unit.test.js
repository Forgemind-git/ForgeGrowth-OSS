// services/outboundAudio.js against the real ffmpeg. OGG/Opus sent through the
// Cloud API is delivered and then cannot be played on iPhone ("This audio is no
// longer available"), so what matters is: browser recordings and anything else
// come out as mono AAC in M4A, and formats WhatsApp already plays as a file
// pass through untouched.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { prepareOutboundAudio } = require('../src/services/outboundAudio');

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
  test('a browser recording becomes mono AAC in M4A', async () => {
    const out = await prepareOutboundAudio(recording(5), 'audio/webm;codecs=opus');
    assert.strictEqual(out.mime, 'audio/mp4');
    assert.strictEqual(out.ext, 'm4a');
    assert.strictEqual(out.voice, undefined);
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
      assert.deepStrictEqual(out, { buffer: buf, mime: sent, ext });
    }
  });
});
