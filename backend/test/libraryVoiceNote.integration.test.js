// Media library voice notes: the send queue adds voice:true for a Meta media id
// exactly when routes/mediaLibrary.js uploaded that copy as a voice note
// (media_meta_sync.is_voice_note). Getting this wrong either way breaks playback
// on iPhone, and the lookup is the only thing tying the two together — so it is
// tested against the real table, per account.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { pool, SEED, probe, skipNoDb } = require('./helpers/db');

const { isVoiceNoteCopy } = require('../src/routes/mediaLibrary');

let accountId, otherAccountId, mediaId;

before(async () => {
  if (!(await probe())) return;
  const acct = (n) => pool.query(
    `INSERT INTO coexistence.whatsapp_accounts
       (display_name, display_phone_number, phone_number_id, waba_id, access_token_encrypted)
     VALUES ($1, $2, $3, $4, 'x') RETURNING id`,
    [SEED, `91987654320${n}`, `pnid-voice-${n}`, `waba-voice-${n}`]);
  accountId = (await acct(1)).rows[0].id;
  otherAccountId = (await acct(2)).rows[0].id;
  const { rows } = await pool.query(
    `INSERT INTO coexistence.media_library
       (filename, original_name, mime_type, size_bytes, media_type, minio_bucket, minio_object_key)
     VALUES ($1, 'greeting.ogg', 'audio/ogg', 1000, 'audio', 'test', $1) RETURNING id`,
    [`${SEED}-voice`]);
  mediaId = rows[0].id;
  await pool.query(
    `INSERT INTO coexistence.media_meta_sync (media_id, account_id, meta_media_id, status, is_voice_note)
     VALUES ($1, $2, 'meta-voice-1', 'synced', true), ($1, $3, 'meta-voice-2', 'synced', false)`,
    [mediaId, accountId, otherAccountId]);
});

// Removes only the rows this file made. The shared cleanup() sweeps leads,
// events and accounts across the schema while other files run concurrently,
// and an extra sweeper there is a deadlock waiting to happen.
after(async () => {
  if (mediaId) {
    await pool.query('DELETE FROM coexistence.media_meta_sync WHERE media_id = $1', [mediaId]).catch(() => {});
    await pool.query('DELETE FROM coexistence.media_library WHERE id = $1', [mediaId]).catch(() => {});
  }
  const ids = [accountId, otherAccountId].filter(Boolean);
  if (ids.length) await pool.query('DELETE FROM coexistence.whatsapp_accounts WHERE id = ANY($1::int[])', [ids]).catch(() => {});
  await pool.end().catch(() => {});
});

describe('isVoiceNoteCopy', () => {
  test('a copy uploaded as a voice note is one', async (t) => {
    if (skipNoDb(t)) return;
    assert.strictEqual(await isVoiceNoteCopy('meta-voice-1', accountId), true);
  });

  test('an ordinary copy, another account, an unknown id or none is not', async (t) => {
    if (skipNoDb(t)) return;
    assert.strictEqual(await isVoiceNoteCopy('meta-voice-2', otherAccountId), false);
    assert.strictEqual(await isVoiceNoteCopy('meta-voice-1', otherAccountId), false);
    assert.strictEqual(await isVoiceNoteCopy('not-a-library-copy', accountId), false);
    assert.strictEqual(await isVoiceNoteCopy(null, accountId), false);
  });
});
