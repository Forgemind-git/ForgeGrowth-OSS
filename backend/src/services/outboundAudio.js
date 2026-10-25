// Audio a person sends from Chats (recorded, attached or forwarded), made into
// something every WhatsApp client can play.
//
// WhatsApp plays OGG/Opus ONLY as a voice note: the message must carry
// `voice: true` and the file must be mono and at most 512 KB. Sent as a plain
// audio message instead, an OGG/Opus file is delivered — ticks go blue — and
// then cannot be played on iPhone and on some Android builds. That is how a
// recorded reply used to arrive.
//
// So: anything that is not already a format WhatsApp plays as an ordinary audio
// file (AAC, MP4, MP3, AMR) becomes a voice note — OGG/Opus, mono, at voice-note
// bitrate. A recording too long to fit in 512 KB even then (over two minutes or
// so) goes out as MP3, which plays everywhere as an audio file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const pexecFile = promisify(execFile);

const VOICE_NOTE_MAX_BYTES = 512 * 1024;

// Sent as they are; the value is the file extension to store them under.
const PLAYABLE_AS_FILE = {
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/amr': 'amr',
};

async function transcode(srcBuffer, outExt, args) {
  const base = path.join(os.tmpdir(), `audio-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  const tmpIn = base;
  const tmpOut = `${base}.${outExt}`;
  fs.writeFileSync(tmpIn, srcBuffer);
  try {
    await pexecFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmpIn, '-vn', ...args, tmpOut], { timeout: 60_000 });
    return fs.readFileSync(tmpOut);
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

/**
 * @returns {Promise<{ buffer: Buffer, mime: string, ext: string, voice: boolean }>}
 *   `voice` is what the send must pass as `voice` — true only for a voice note.
 */
async function prepareOutboundAudio(srcBuffer, srcMime) {
  const base = String(srcMime || '').split(';')[0].trim().toLowerCase();
  if (PLAYABLE_AS_FILE[base]) {
    return { buffer: srcBuffer, mime: base, ext: PLAYABLE_AS_FILE[base], voice: false };
  }
  const ogg = await transcode(srcBuffer, 'ogg', ['-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip']);
  if (ogg.length <= VOICE_NOTE_MAX_BYTES) {
    return { buffer: ogg, mime: 'audio/ogg', ext: 'ogg', voice: true };
  }
  const mp3 = await transcode(srcBuffer, 'mp3', ['-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k']);
  return { buffer: mp3, mime: 'audio/mpeg', ext: 'mp3', voice: false };
}

module.exports = { prepareOutboundAudio, VOICE_NOTE_MAX_BYTES };
