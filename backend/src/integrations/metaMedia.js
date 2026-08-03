// Minimal Meta WhatsApp Cloud API client for media retrieval.
// Two-step protocol: GET /<media_id> → {url, mime_type, sha256, file_size},
// then GET <url> with bearer token to fetch the bytes.

const META_API_VERSION = process.env.META_API_VERSION || 'v21.0';

// Media is fetched with the access token of the WhatsApp account that owns the
// message (see services/mediaDownloader.js). The env var is only a fallback for
// single-account deployments that predate multi-WABA support.
function resolveToken(token) {
  const t = token || process.env.META_ACCESS_TOKEN || '';
  if (!t) {
    throw new Error('No WhatsApp access token available for this number (add it in Admin Settings → WhatsApp Accounts)');
  }
  return t;
}

/**
 * Fetch metadata for a media object.
 * Returns { url, mime_type, sha256, file_size, id, messaging_product }
 * The `url` is short-lived (~5 min).
 */
async function getMediaInfo(mediaId, token) {
  const accessToken = resolveToken(token);
  const res = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(mediaId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Meta getMediaInfo ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Stream the binary at a Meta media URL.
 * Returns { buffer: Buffer, contentType: string, contentLength: number }
 */
async function downloadMediaBinary(url, token) {
  const accessToken = resolveToken(token);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': process.env.META_USER_AGENT || 'ForgeChat/1.0',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Meta downloadMediaBinary ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const arrayBuf = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuf),
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    contentLength: Number(res.headers.get('content-length')) || arrayBuf.byteLength,
  };
}

module.exports = { getMediaInfo, downloadMediaBinary };
