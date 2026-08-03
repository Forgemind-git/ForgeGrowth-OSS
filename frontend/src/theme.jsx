import { createContext, useContext, useState, useEffect, useCallback } from 'react';

// Theme manager: 'light' | 'dark' | 'system'. Persisted per-device in
// localStorage (the standard for dark mode). 'system' follows the OS setting
// live via matchMedia. The effective theme is applied as data-theme on <html>,
// which swaps the CSS-variable palette defined in index.css.
const ThemeCtx = createContext(null);
const KEY = 'forgecrm.theme';

function systemDark() {
  return typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function resolve(pref) {
  return pref === 'system' ? (systemDark() ? 'dark' : 'light') : pref;
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; }
  });
  const [effective, setEffective] = useState(() => resolve(theme));

  const apply = useCallback((pref) => {
    const eff = resolve(pref);
    document.documentElement.dataset.theme = eff;
    document.documentElement.style.colorScheme = eff;
    setEffective(eff);
  }, []);

  const setTheme = useCallback((pref) => {
    try { localStorage.setItem(KEY, pref); } catch { /* ignore */ }
    setThemeState(pref);
    apply(pref);
  }, [apply]);

  // Apply on mount.
  useEffect(() => { apply(theme); /* eslint-disable-next-line */ }, []);

  // When following the system, re-apply whenever the OS theme flips.
  useEffect(() => {
    if (theme !== 'system' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
    return () => { mq.removeEventListener ? mq.removeEventListener('change', onChange) : mq.removeListener(onChange); };
  }, [theme, apply]);

  return (
    <ThemeCtx.Provider value={{ theme, setTheme, effective }}>
      {children}
    </ThemeCtx.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeCtx) || { theme: 'light', setTheme: () => {}, effective: 'light' };
}
