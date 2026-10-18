import { useState, useEffect, useCallback, useRef } from 'react';

// useApi(fetchFn, deps, { pollMs })
// pollMs (optional): silently re-fetch on an interval — no loading flicker,
// keeps the last good data on a failed poll. Used for near-realtime pages.
export function useApi(fetchFn, deps = [], { pollMs } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Only the newest request may write state: when deps change quickly (e.g. a
  // default filter applied right after mount) an older, slower response must
  // not overwrite the newer one.
  const seq = useRef(0);
  const refetch = useCallback(async (silent = false) => {
    const id = ++seq.current;
    if (!silent) { setLoading(true); setError(null); }
    try {
      const result = await fetchFn();
      if (id !== seq.current) return;
      setData(result);
      if (silent) setError(null);
    } catch (err) {
      if (id !== seq.current) return;
      if (!silent) setError(err.message || 'Failed to load data');
      // On a silent poll failure, keep showing the last good data.
    } finally {
      if (!silent && id === seq.current) setLoading(false);
    }
  }, deps);

  useEffect(() => {
    refetch();
    if (pollMs) {
      const id = setInterval(() => refetch(true), pollMs);
      return () => clearInterval(id);
    }
  }, [refetch, pollMs]);

  return { data, loading, error, refetch };
}
