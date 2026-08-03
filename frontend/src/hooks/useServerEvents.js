// Subscribe to the backend SSE stream. Call once per page (mount level) and
// pass a stable `onEvent` callback — the hook listens for a fixed set of
// events documented in backend/src/routes/events.js.
//
//   const onEvent = useCallback((ev) => {
//     if (ev.type === 'contact-assignment-changed') refetch();
//   }, [refetch]);
//   useServerEvents(onEvent);
//
// Auto-reconnects via EventSource's built-in retry (default ~3s) on
// transient failures. The browser closes the connection on tab unload.

import { useEffect } from 'react';

const SUBSCRIBED_EVENTS = ['contact-assignment-changed', 'contact-saved', 'conversation-read', 'pipeline-changed', 'message-status', 'lead-changed', 'hello'];

export function useServerEvents(onEvent) {
  useEffect(() => {
    if (!onEvent) return;
    let es;
    try {
      es = new EventSource('/api/events', { withCredentials: true });
    } catch (err) {
      console.warn('[useServerEvents] EventSource unsupported:', err.message);
      return;
    }

    const handlers = {};
    for (const type of SUBSCRIBED_EVENTS) {
      handlers[type] = (e) => {
        let data = {};
        try { data = JSON.parse(e.data); } catch { /* leave empty */ }
        onEvent({ type, data });
      };
      es.addEventListener(type, handlers[type]);
    }

    return () => {
      for (const type of SUBSCRIBED_EVENTS) {
        try { es.removeEventListener(type, handlers[type]); } catch {}
      }
      try { es.close(); } catch {}
    };
  }, [onEvent]);
}
