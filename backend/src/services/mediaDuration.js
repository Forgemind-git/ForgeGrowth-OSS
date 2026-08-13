// How long is this audio/video file, really?
//
// Used to enforce an agent's "longest voice note" cap BEFORE the file is handed
// to OpenAI Whisper — Whisper bills per minute of audio, so a cap applied after
// transcription would protect nothing.
//
// ⚠ THE DURATION HAS TO BE MEASURED, NOT ESTIMATED. Meta's webhook audio object
// carries { id, mime_type, sha256, voice } and NO duration, so the only other
// signal available before transcription is the file size — and an Opus voice
// note's bitrate varies enough that a byte-based guess would reject legitimate
// short notes and pass long ones. `ffprobe` reads the container's own duration.
//
// ffprobe ships with the `ffmpeg` apk package, which backend/Dockerfile installs
// (for transcoding voice notes to MP3 so Safari can play them). If that line is
// ever removed, this returns null and every note is treated as acceptable — the
// cap silently stops enforcing rather than silently rejecting everything. That
// direction is deliberate: failing open loses a cost guard, failing closed loses
// the customer's message.

const { execFile } = require('child_process');
const fs = require('fs');

const PROBE_TIMEOUT_MS = 10000;

/**
 * Duration of a media file in seconds, or null when it cannot be determined
 * (missing file, no ffprobe, unparseable container, timeout).
 *
 * null means "unknown", NEVER "zero" — a caller comparing an unknown duration
 * against a cap must treat it as acceptable.
 */
function probeDurationSeconds(filePath) {
  return new Promise((resolve) => {
    if (!filePath || !fs.existsSync(filePath)) return resolve(null);
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { timeout: PROBE_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          // ENOENT here means ffprobe itself is missing — worth saying plainly,
          // because the symptom otherwise is a limit that quietly never fires.
          console.warn(`[mediaDuration] ffprobe failed${err.code === 'ENOENT' ? ' (ffprobe not installed)' : ''}: ${err.message}`);
          return resolve(null);
        }
        const secs = parseFloat(String(stdout || '').trim());
        resolve(Number.isFinite(secs) && secs > 0 ? secs : null);
      },
    );
  });
}

/** "3m 12s" / "48s" — for a log line or a note handed to the model. */
function formatDuration(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

module.exports = { probeDurationSeconds, formatDuration };
