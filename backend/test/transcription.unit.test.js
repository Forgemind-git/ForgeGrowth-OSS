// services/transcription.js — OpenRouter speech-to-text (microsoft/mai-transcribe-2).
// Global fetch is stubbed for the whole file, so no test can reach OpenRouter.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const stt = require('../src/services/transcription');

let calls = [];
let reply = null;
const realFetch = global.fetch;
before(() => {
  global.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return reply();
  };
});
after(() => { global.fetch = realFetch; });

function jsonReply(status, obj) {
  return () => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) });
}
function tmpFile(ext, bytes = 'x') {
  const p = path.join(os.tmpdir(), `stt-test-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(p, bytes);
  return p;
}
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe('directFormat — what can go to OpenRouter unconverted', () => {
  test('WhatsApp ogg/opus, mp3 and wav go as-is', () => {
    assert.equal(stt.directFormat('/x/a.ogg', 'audio/ogg; codecs=opus'), 'ogg');
    assert.equal(stt.directFormat('/x/a.bin', 'audio/mpeg'), 'mp3');
    assert.equal(stt.directFormat('/x/a.wav', ''), 'wav');
    assert.equal(stt.directFormat('/x/a.opus', ''), 'ogg');
  });
  test('webm and m4a are refused by the endpoint, so they need converting', () => {
    assert.equal(stt.directFormat('/x/a.webm', 'audio/webm'), null);
    assert.equal(stt.directFormat('/x/a.m4a', 'audio/mp4'), null);
  });
});

describe('transcribeAudio', () => {
  test('sends the model + base64 + format, returns text and the REAL cost', async () => {
    calls = [];
    reply = jsonReply(200, { text: '  வணக்கம் hello  ', usage: { seconds: 15, cost: 0.000417 } });
    const f = tmpFile('ogg', 'OggS-bytes');
    const r = await stt.transcribeAudio({ filePath: f, apiKey: 'sk-or-test', mime: 'audio/ogg' });
    fs.unlinkSync(f);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/audio/transcriptions');
    assert.equal(calls[0].headers.Authorization, 'Bearer sk-or-test');
    assert.equal(calls[0].body.model, 'microsoft/mai-transcribe-2');
    assert.equal(calls[0].body.input_audio.format, 'ogg');
    assert.equal(Buffer.from(calls[0].body.input_audio.data, 'base64').toString(), 'OggS-bytes');
    assert.equal(r.text, 'வணக்கம் hello');
    assert.equal(r.seconds, 15);
    assert.equal(r.costUsd, 0.000417);
    assert.equal(r.provider, 'openrouter');
  });

  test('an API error THROWS with OpenRouter\'s reason (so the cache records it as failed and retries)', async () => {
    reply = jsonReply(402, { error: { code: 402, message: 'Insufficient credits' } });
    const f = tmpFile('mp3');
    await assert.rejects(stt.transcribeAudio({ filePath: f, apiKey: 'k' }), /402.*Insufficient credits/);
    fs.unlinkSync(f);
  });

  test('no key is an error, never a silent empty transcript', async () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const f = tmpFile('ogg');
    await assert.rejects(stt.transcribeAudio({ filePath: f }), /No OpenRouter key is connected/);
    fs.unlinkSync(f);
    if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
  });

  test('transcribeAudioFile swallows errors to "" (the agent must not lose its turn)', async () => {
    reply = jsonReply(502, { error: { code: 502, message: 'upstream' } });
    const f = tmpFile('ogg');
    assert.equal(await stt.transcribeAudioFile({ filePath: f, apiKey: 'k' }), '');
    fs.unlinkSync(f);
  });

  test('a webm recording is converted to mp3 before sending', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not installed here');
    const webm = path.join(os.tmpdir(), `stt-test-${Date.now()}.webm`);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', webm]);
    calls = [];
    reply = jsonReply(200, { text: 'tone', usage: { seconds: 1, cost: 0.00003 } });
    const r = await stt.transcribeAudio({ filePath: webm, apiKey: 'k', mime: 'audio/webm' });
    fs.unlinkSync(webm);
    assert.equal(calls[0].body.input_audio.format, 'mp3');
    const head = Buffer.from(calls[0].body.input_audio.data, 'base64').subarray(0, 3);
    assert.ok(head.toString() === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0), 'payload is an mp3');
    assert.equal(r.text, 'tone');
  });
});

describe('voiceNotes.secondsFromBytes — estimate when the file is not on disk yet', () => {
  const { secondsFromBytes } = require('../src/services/voiceNotes');
  test('opus voice notes ~16 kbps, mp3 ~64 kbps, nothing known → null', () => {
    assert.equal(secondsFromBytes(64000, 'audio/ogg; codecs=opus'), 32);
    assert.equal(secondsFromBytes(160000, 'audio/mpeg'), 20);
    assert.equal(secondsFromBytes(0, 'audio/ogg'), null);
  });
});

describe('isLegacyTranscript — which transcripts may be redone', () => {
  const { isLegacyTranscript } = require('../src/services/mediaExtract');
  const conf = { transcribe_model: 'microsoft/mai-transcribe-2' };
  test('a Whisper transcript (ok or empty) is legacy; the current model, a failure or none is not', () => {
    assert.equal(isLegacyTranscript({ status: 'ok', model: 'whisper-1' }, conf), true);
    assert.equal(isLegacyTranscript({ status: 'empty', model: 'whisper-1' }, conf), true);
    assert.equal(isLegacyTranscript({ status: 'ok', model: 'microsoft/mai-transcribe-2' }, conf), false);
    assert.equal(isLegacyTranscript({ status: 'failed', model: 'whisper-1' }, conf), false);
    assert.equal(isLegacyTranscript({ status: 'skipped', model: null }, conf), false);
    assert.equal(isLegacyTranscript(null, conf), false);
  });
});

describe('libraryLabel — how one of our Media Library files is described', () => {
  const { libraryLabel } = require('../src/services/libraryMedia');
  test('with and without a description, per media type', () => {
    assert.equal(libraryLabel({ name: 'Brochure', description: 'fees and syllabus' }, 'document'),
      '[document from our Media Library: "Brochure" — fees and syllabus]');
    assert.equal(libraryLabel({ name: 'Invite', description: null }, 'voice'), '[voice note from our Media Library: "Invite"]');
    assert.equal(libraryLabel({ name: 'Promo', description: 'x' }, 'video'), '[video from our Media Library: "Promo" — x]');
  });
});
