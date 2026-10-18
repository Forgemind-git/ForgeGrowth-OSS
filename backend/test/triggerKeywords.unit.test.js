'use strict';
// Start words on a keyword trigger. Two rules that fail SILENTLY if wrong: a
// short extra word matching loosely starts the flow on ordinary greetings, and
// an ad phrase matching only exactly misses every lead who adds a word to it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { keywordTriggerHit, resetReplyText } = require('../src/engine/automationEngine');

const AD = 'Hi, I want to know more about the Live Lab – Sesh 02';
const trig = { type: 'trigger', triggerKind: 'keyword', keyword: 'LIVELAB', matchType: 'contains', caseSensitive: false, extraKeywords: ['Hiii', AD] };

test('main keyword keeps its own match type', () => {
  assert.equal(keywordTriggerHit(trig, 'LIVELAB-IG'), 'LIVELAB');
  assert.equal(keywordTriggerHit(trig, 'hey livelab'), 'LIVELAB');
});

test('a short extra word must be the whole message', () => {
  assert.equal(keywordTriggerHit(trig, 'Hiii'), 'Hiii');
  assert.equal(keywordTriggerHit(trig, '  hiii '), 'Hiii');
  assert.equal(keywordTriggerHit(trig, 'Hiii there'), null);
  assert.equal(keywordTriggerHit({ ...trig, extraKeywords: ['hi there'] }, 'oh hi there friend'), null);
});

test('the ad phrase matches every variant real leads sent', () => {
  for (const body of [
    'Hi, I want to know more about the Live Lab – Sesh 02 event in Coimbatore.',
    'Hi, I want to know more about the Live Lab – Sesh 02 event in Coimbatore!',
    'Hi, I want to know more about the Live Lab – Sesh 02 event in Coimbatore!!',
    'Hi, I want to know more about the Live Lab – Sesh 02',
  ]) assert.equal(keywordTriggerHit(trig, body), AD, body);
});

test('dash form, spacing, newlines and case do not matter for a phrase', () => {
  assert.equal(keywordTriggerHit(trig, 'hi, i want to know more about the live lab - sesh 02'), AD);
  assert.equal(keywordTriggerHit(trig, 'Hi,  I want to know more\nabout the Live Lab — Sesh 02'), AD);
});

test('part of the phrase or an unrelated message does not start the flow', () => {
  assert.equal(keywordTriggerHit(trig, 'Hi'), null);
  assert.equal(keywordTriggerHit(trig, 'Hi, I want to know more'), null);
  assert.equal(keywordTriggerHit(trig, 'Tell me about the Live Lab'), null);
});

test('RESET reply names the phrase whole, never split at its comma', () => {
  assert.equal(resetReplyText({ config: { nodes: [trig] } }),
    `Your chat has been reset. Send *LIVELAB*, *Hiii* or *${AD}* to start again.`);
});

const withContains = { ...trig, containsKeywords: ['Live Lab'] };

test('a contains word matches anywhere, in any capitals or spacing', () => {
  for (const body of ['Live Lab', 'live lab details pls', 'Tell me about the LIVE LAB', 'what is  live\nlab?'])
    assert.equal(keywordTriggerHit(withContains, body), 'Live Lab', body);
});

test('a contains word does not loosen the other start words', () => {
  assert.equal(keywordTriggerHit(withContains, 'Hiii there'), null);
  assert.equal(keywordTriggerHit(withContains, 'Hi'), null);
  assert.equal(keywordTriggerHit(withContains, 'Lab live'), null);
  assert.equal(keywordTriggerHit({ ...trig, containsKeywords: ['', '  '] }, 'anything'), null);
});

test('RESET reply also names the contains words', () => {
  assert.equal(resetReplyText({ config: { nodes: [{ ...withContains, extraKeywords: ['Hiii'] }] } }),
    'Your chat has been reset. Send *LIVELAB*, *Hiii* or *Live Lab* to start again.');
});
