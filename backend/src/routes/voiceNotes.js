// One voice note, from the Chats window. Mounted under /api with authMiddleware.
//
//   GET  /voice-notes/:messageId               its transcript, or what making one would cost
//   POST /voice-notes/:messageId/transcribe    transcribe it (once, ever — see services/voiceNotes.js)
//   POST /voice-notes/:messageId/retranscribe  replace an older model's (Whisper) transcript
//
// These lived under /chat-analysis/voice-notes until the Chat Analyzer was
// removed (2026-10-21); transcription itself never belonged to that feature.
//
// ⚠ Gated by CONVERSATION access, not a page permission: anyone who can open
// the chat can read or transcribe its voice notes (a BDA sees only their
// assigned contacts, exactly as in Chats).

const { Router } = require('express');
const pool = require('../db');
const { assertContactAccess } = require('../middleware/access');
const voiceNotes = require('../services/voiceNotes');

const router = Router();

function sendErr(res, err, fallback) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  if (status >= 500) console.error('[voice-notes]', err.message);
  res.status(status).json({ error: err?.message || fallback });
}

async function noteAccess(req, res) {
  const { rows } = await pool.query(
    `SELECT wa_number, contact_number FROM coexistence.chat_history WHERE message_id = $1`,
    [req.params.messageId]
  );
  if (!rows[0]) { res.status(404).json({ error: 'That message no longer exists' }); return false; }
  return assertContactAccess(req, res, rows[0].wa_number, rows[0].contact_number);
}

router.get('/voice-notes/:messageId', async (req, res) => {
  try {
    if (!(await noteAccess(req, res))) return;
    res.json(await voiceNotes.voiceNoteInfo(req.params.messageId));
  } catch (err) { sendErr(res, err, 'Could not read that voice note'); }
});

router.post('/voice-notes/:messageId/transcribe', async (req, res) => {
  try {
    if (!(await noteAccess(req, res))) return;
    res.json(await voiceNotes.transcribeVoiceNote(req.params.messageId));
  } catch (err) { sendErr(res, err, 'Could not transcribe that voice note'); }
});

router.post('/voice-notes/:messageId/retranscribe', async (req, res) => {
  try {
    if (!(await noteAccess(req, res))) return;
    res.json(await voiceNotes.retranscribeVoiceNote(req.params.messageId));
  } catch (err) { sendErr(res, err, 'Could not re-transcribe that voice note'); }
});

module.exports = { router };
