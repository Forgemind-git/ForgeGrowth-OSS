// Meta's `wamid.<base64>` ids are not stable across webhook types. The base64
// payload is a TLV blob holding (a) a participant identity and (b) the message
// hash. Meta is migrating identities from raw phone numbers to opaque user ids,
// so the SAME message arrives as one wamid on a `message_echoes` / `messages`
// event and a DIFFERENT wamid on its `statuses` receipts:
//
//   echo   → …\x0c 919876543210        …\x18\x14 2AB9A0F8DDBFF3B06C52
//   status → …\x13 IN.1402240581713773 …\x18\x14 2AB9A0F8DDBFF3B06C52
//
// The trailing uppercase-hex message hash is identical. It is the only reliable
// key for correlating a receipt back to the message row it refers to.

const WAMID_PREFIX = 'wamid.';
const HASH_RE = /[0-9A-F]{16,}/g;

/**
 * Extract the stable message hash from a wamid.
 * Returns null for local ids, malformed base64, or any id with no hash segment.
 */
function wamidHash(messageId) {
  if (typeof messageId !== 'string' || !messageId.startsWith(WAMID_PREFIX)) return null;
  let decoded;
  try {
    decoded = Buffer.from(messageId.slice(WAMID_PREFIX.length), 'base64').toString('latin1');
  } catch {
    return null;
  }
  const matches = decoded.match(HASH_RE);
  if (!matches || matches.length === 0) return null;
  // The identity segment can itself be numeric, so take the LAST hex run — the
  // hash is always the final field in the blob.
  return matches[matches.length - 1];
}

/**
 * Given a status receipt's wamid and a list of candidate message ids, return
 * the candidate referring to the same message, or null.
 */
function matchByHash(messageId, candidateIds) {
  const target = wamidHash(messageId);
  if (!target) return null;
  for (const candidate of candidateIds) {
    if (wamidHash(candidate) === target) return candidate;
  }
  return null;
}

module.exports = { wamidHash, matchByHash };
