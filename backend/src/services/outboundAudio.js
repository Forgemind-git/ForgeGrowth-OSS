// Audio a person sends from Chats (recorded, attached or forwarded), made into
// something every WhatsApp client can play.
//
// OGG/Opus does NOT work for this, with or without `voice: true`: Meta accepts
// it, the message is delivered and read, and then WhatsApp on iPhone says
// "This audio is no longer available" (Android and WhatsApp Web play it). Both
// variants were tried on the live install; the same failure, and AAC/M4A
// playing where OGG does not, is reported independently in
// evolution-foundation/evo-crm-community#190.
//
// So anything that is not already a format WhatsApp plays as an ordinary audio
// file (AAC, MP4/M4A, MP3, AMR) becomes AAC-LC in an M4A container — mono,
// 48 kHz, 64 kbps — and goes out as an ordinary audio message, never as a
// voice note.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const pexecFile = promisify(execFile);

// Sent as they are; the value is the file extension to store them under.
const PLAYABLE_AS_FILE = {
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
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
 * @returns {Promise<{ buffer: Buffer, mime: string, ext: string }>}
 */
async function prepareOutboundAudio(srcBuffer, srcMime) {
  const base = String(srcMime || '').split(';')[0].trim().toLowerCase();
  if (PLAYABLE_AS_FILE[base]) {
    // audio/x-m4a is what some browsers call it; Meta only knows audio/mp4.
    return { buffer: srcBuffer, mime: base === 'audio/x-m4a' ? 'audio/mp4' : base, ext: PLAYABLE_AS_FILE[base] };
  }
  const m4a = await transcode(srcBuffer, 'm4a', ['-ac', '1', '-ar', '48000', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart']);
  return { buffer: m4a, mime: 'audio/mp4', ext: 'm4a' };
}

module.exports = { prepareOutboundAudio };
