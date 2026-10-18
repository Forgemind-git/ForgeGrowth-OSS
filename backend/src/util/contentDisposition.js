// Build a Content-Disposition header value that survives any file name.
//
// ⚠ Node's res.setHeader THROWS (ERR_INVALID_CHAR) on a character outside
// Latin-1. A Media Library item named "Live Lab Sesh 02 — agenda card" (an em
// dash) therefore turned every download of it into a 500: its thumbnail, its
// preview and its Download link were all broken, while WhatsApp sends kept
// working because they read the file from MinIO directly — which is why it went
// unnoticed. RFC 6266: an ASCII `filename` fallback for old clients, plus the
// exact name in `filename*` (RFC 5987) for everything current.
function contentDisposition(name, type = 'inline') {
  const raw = String(name || '').trim() || 'file';
  // Printable ASCII only, and no quote/backslash that could end the quoted
  // string. This also removes CR/LF, so a name can never inject a header.
  const ascii = raw.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(raw)
    .replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

module.exports = { contentDisposition };
