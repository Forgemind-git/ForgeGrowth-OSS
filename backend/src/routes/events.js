// Server-Sent Events stream for push notifications. The frontend opens one
// connection per tab via `new EventSource('/api/events')`; the cookie is
// sent automatically and `authMiddleware` upstream verifies the JWT before
// we get here.
//
// Events currently emitted:
//   - 'contact-assignment-changed': { waNumber, contactNumber, assignedUserId, assignedUserName }
//   - 'contact-saved'             : { waNumber, contactNumber, name }
//
// Each client subscribes to ALL events; filtering is done client-side
// (they're cheap and the volume is small for this app's scale).

const { Router } = require('express');
const bus = require('../events');

const router = Router();

router.get('/events', (req, res) => {
  // SSE headers — must NOT be Gzipped or Buffered, hence X-Accel-Buffering.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // Initial handshake — also helps proxies that wait for first byte before
  // flushing headers (e.g. nginx with proxy_buffering on, but we disable it
  // in nginx.conf for /api).
  res.write(`event: hello\ndata: {"ts":${Date.now()},"userId":${req.user?.id ?? null}}\n\n`);

  const writeEvent = (event, data) => {
    if (res.writableEnded) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      // Connection may have died mid-write; ignore.
    }
  };

  const handlers = {
    'contact-assignment-changed': (payload) => writeEvent('contact-assignment-changed', payload),
    'contact-saved': (payload) => writeEvent('contact-saved', payload),
    'conversation-read': (payload) => writeEvent('conversation-read', payload),
    'pipeline-changed': (payload) => writeEvent('pipeline-changed', payload),
    'message-status': (payload) => writeEvent('message-status', payload),
    'lead-changed': (payload) => writeEvent('lead-changed', payload),
  };
  for (const [event, handler] of Object.entries(handlers)) {
    bus.on(event, handler);
  }

  // Keepalive every 25s — most proxies idle-close at 30-60s.
  const keepalive = setInterval(() => {
    if (res.writableEnded) return;
    try { res.write(': ka\n\n'); } catch { /* connection died */ }
  }, 25000);

  const cleanup = () => {
    clearInterval(keepalive);
    for (const [event, handler] of Object.entries(handlers)) {
      bus.off(event, handler);
    }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
});

module.exports = { router };
