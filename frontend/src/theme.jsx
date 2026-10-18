import { createContext, useContext, useState, useCallback } from 'react';

// Theme manager: 'light' | 'dark', persisted per device in localStorage. The
// choice is applied as data-theme on <html>, which swaps the palettes in
// index.css and styles/forge.css.
//
// ⚠ DEFAULT IS DARK, not the OS preference. ForgeGrowth ran dark-only from
// 2026-09-02 until light mode came back, so every existing user's eye is on
// dark; following the OS would silently flip half of them to light on their
// next load. index.html applies the same rule before React mounts, so there is
// no flash — keep the two in step.
const ThemeCtx = createContext(null);
const KEY = 'forgecrm.theme';
const THEMES = ['light', 'dark'];

function readStored() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.includes(v) ? v : 'dark';
  } catch { return 'dark'; }
}

function apply(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    const t = readStored();
    apply(t);
    return t;
  });

  const setTheme = useCallback((next) => {
    const t = THEMES.includes(next) ? next : 'dark';
    try { localStorage.setItem(KEY, t); } catch { /* private mode: still switch for this tab */ }
    apply(t);
    setThemeState(t);
  }, []);

  // `effective` is kept for callers that pick a colour per theme (StageBadge).
  return (
    <ThemeCtx.Provider value={{ theme, setTheme, effective: theme }}>
      {children}
    </ThemeCtx.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeCtx) || { theme: 'dark', setTheme: () => {}, effective: 'dark' };
}
