// Audio sent from Forge Growth, made into something every WhatsApp client plays.
//
// Two shapes:
//
//   * prepareVoiceNote — a recorded or forwarded voice note, sent with
//     `voice: true` so it shows as a voice note (profile picture, mic icon).
//     WhatsApp on iPhone is strict about the file: ffmpeg's default OGG/Opus
//     (20 ms packets, a page per second) is delivered and then "This audio is no
//     longer available", at 16 or 48 kHz, with ffmpeg's vendor tag or with
//     "WhatsApp". Tested on the live install against an iPhone, 2026-10-25: what
//     plays is WhatsApp's own layout, copied from a voice note recorded on that
//     iPhone — 48 kHz mono Opus in 120 ms packets, the audio on a single Ogg
//     page, vendor "WhatsApp", no comments.
//
//   * prepareOutboundAudio — any other audio, sent as an ordinary audio message.
//     AAC, MP4/M4A, MP3 and AMR go as they are; anything else becomes AAC/M4A,
//     because an OGG/Opus file sent WITHOUT `voice: true` cannot be played on
//     iPhone either.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const pexecFile = promisify(execFile);

// Meta shows a voice note's play button only for a file of 512 KB or less.
const VOICE_NOTE_MAX_BYTES = 512 * 1024;

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

/* ---------------------------- Ogg page helpers ---------------------------- */

// Ogg's CRC-32: polynomial 0x04c11db7, not reflected, initial value 0.
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let r = i << 24;
  for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
  CRC_TABLE[i] = r >>> 0;
}
function oggCrc(buf) {
  let c = 0;
  for (const b of buf) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ b) & 0xff]) >>> 0;
  return c >>> 0;
}

function splitPages(buf) {
  const pages = [];
  let o = 0;
  while (o < buf.length) {
    if (buf.toString('latin1', o, o + 4) !== 'OggS') throw new Error('not an Ogg stream');
    const nseg = buf[o + 26];
    let len = 0;
    for (let i = 0; i < nseg; i++) len += buf[o + 27 + i];
    const end = o + 27 + nseg + len;
    pages.push(buf.subarray(o, end));
    o = end;
  }
  return pages;
}

// Replace the OpusTags packet (alone on the second page, as ffmpeg writes it)
// with vendor "WhatsApp" and no comments, and re-checksum that page.
function withWhatsAppTags(buf) {
  const pages = splitPages(buf);
  const p = pages[1];
  const nseg = p && p[26];
  if (!p || p.toString('latin1', 27 + nseg, 27 + nseg + 8) !== 'OpusTags') throw new Error('unexpected OpusTags page');
  const vendor = Buffer.from('WhatsApp');
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const body = Buffer.concat([Buffer.from('OpusTags'), u32(vendor.length), vendor, u32(0)]);
  const segs = [];
  for (let left = body.length; ; left -= 255) { segs.push(Math.min(left, 255)); if (left < 255) break; }
  const header = Buffer.from(p.subarray(0, 27));
  header[26] = segs.length;
  header.writeUInt32LE(0, 22);
  const page = Buffer.concat([header, Buffer.from(segs), body]);
  page.writeUInt32LE(oggCrc(page), 22);
  pages[1] = page;
  return Buffer.concat(pages);
}

/* --------------------------------- shapes --------------------------------- */

/**
 * Any audio → an ordinary audio message every phone plays.
 * @returns {Promise<{ buffer: Buffer, mime: string, ext: string, voice: false }>}
 */
async function prepareOutboundAudio(srcBuffer, srcMime) {
  const base = String(srcMime || '').split(';')[0].trim().toLowerCase();
  if (PLAYABLE_AS_FILE[base]) {
    // audio/x-m4a is what some browsers call it; Meta only knows audio/mp4.
    return { buffer: srcBuffer, mime: base === 'audio/x-m4a' ? 'audio/mp4' : base, ext: PLAYABLE_AS_FILE[base], voice: false };
  }
  const m4a = await transcode(srcBuffer, 'm4a', ['-ac', '1', '-ar', '48000', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart']);
  return { buffer: m4a, mime: 'audio/mp4', ext: 'm4a', voice: false };
}

/**
 * Any audio → a voice note in WhatsApp's own layout (send with voice: true).
 * Too long for the 512 KB limit → an ordinary M4A audio message instead.
 * @returns {Promise<{ buffer: Buffer, mime: string, ext: string, voice: boolean }>}
 */
async function prepareVoiceNote(srcBuffer, srcMime) {
  const ogg = await transcode(srcBuffer, 'ogg', [
    '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
    '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip',
    '-frame_duration', '120', '-page_duration', '600000000',
  ]);
  if (ogg.length <= VOICE_NOTE_MAX_BYTES) {
    try {
      return { buffer: withWhatsAppTags(ogg), mime: 'audio/ogg', ext: 'ogg', voice: true };
    } catch (err) {
      console.warn('[outboundAudio] could not set voice-note tags, sending as audio:', err.message);
    }
  }
  return prepareOutboundAudio(srcBuffer, srcMime);
}

module.exports = { prepareOutboundAudio, prepareVoiceNote, VOICE_NOTE_MAX_BYTES, _withWhatsAppTags: withWhatsAppTags, _oggCrc: oggCrc };
