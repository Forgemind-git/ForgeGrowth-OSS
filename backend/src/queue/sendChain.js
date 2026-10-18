// Keeping one automation run's messages in the order the flow sends them.
//
// ⚠ The send queue runs several jobs at once with no per-contact ordering, so
// "video, then voice note, then poster" enqueued back to back can reach the
// customer as poster, video, voice note — whichever upload Meta finished first.
// A Delay step does not fix it: each send's delay is counted from its own
// enqueue time, so two delayed sends still race each other.
//
// So sends from one walk carry a chain key and an increasing sequence number,
// and the worker holds a job until the previous one in its chain has been
// accepted by Meta. Kept as pure functions so the rules are testable without
// Redis.
//
// Pause between messages: a chain can also ask for a gap, counted from the
// moment the previous message was accepted — not from enqueue time, which is
// what would let a slow upload swallow the pause.
//
// Give-up: a chain must never stall a conversation for ever because one message
// failed. Each job carries the moment after which it sends anyway.

const CHAIN_KEY_PREFIX = 'fg:sendchain:';
const CHAIN_RECHECK_MS = 1000;    // how soon a held job looks again
const CHAIN_GRACE_MS = 60 * 1000; // how long past its own due time a job will wait for its predecessor
const CHAIN_TTL_SECONDS = 3600;

/**
 * @returns {'send'|'wait'|'send_late'}
 */
function chainDecision({ seq, lastAccepted, now, giveUpAt }) {
  const s = Number(seq) || 0;
  if (s <= 1) return 'send';
  if (Number(lastAccepted || 0) >= s - 1) return 'send';
  if (giveUpAt && now >= Number(giveUpAt)) return 'send_late';
  return 'wait';
}

// Redis holds "<seq>:<acceptedAtMs>". A bare "<seq>" (written before the pause
// existed) still reads, with no acceptance time — so it never adds a pause.
function parseChainState(raw) {
  const [seqPart, atPart] = String(raw == null ? '' : raw).split(':');
  return { seq: Number(seqPart) || 0, at: Number(atPart) || 0 };
}

function formatChainState(seq, at) {
  return `${Number(seq) || 0}:${Number(at) || 0}`;
}

/**
 * When the pause after the previous message ends, or 0 when there is nothing to
 * wait for. Only applies once the predecessor is accepted; waiting FOR the
 * predecessor is chainDecision's job.
 */
function gapWaitUntil({ gapMs, lastAcceptedAt, now }) {
  const gap = Number(gapMs) || 0;
  const at = Number(lastAcceptedAt) || 0;
  if (gap <= 0 || at <= 0) return 0;
  const until = at + gap;
  return now < until ? until : 0;
}

module.exports = {
  chainDecision, parseChainState, formatChainState, gapWaitUntil,
  CHAIN_KEY_PREFIX, CHAIN_RECHECK_MS, CHAIN_GRACE_MS, CHAIN_TTL_SECONDS,
};
