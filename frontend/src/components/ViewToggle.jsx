import { useState } from 'react';
import { LayoutGrid, List } from 'lucide-react';
import PillStrip from './PillStrip.jsx';

/**
 * Grid / List switch for a list page. The choice is a per-viewer convenience,
 * so it lives in localStorage under its own key — wrapped in try/catch because
 * storage can be blocked (private window) and the page must still render.
 */
export function useViewMode(storageKey, fallback = 'list') {
  const [mode, setMode] = useState(() => {
    try { const v = localStorage.getItem(storageKey); return v === 'grid' || v === 'list' ? v : fallback; }
    catch { return fallback; }
  });
  const set = (v) => {
    setMode(v);
    try { localStorage.setItem(storageKey, v); } catch { /* storage blocked — keep it for this visit */ }
  };
  return [mode, set];
}

export default function ViewToggle({ value, onChange }) {
  return (
    <PillStrip size="sm" value={value} onChange={onChange} title="How to show the list"
      items={[
        { id: 'grid', label: 'Grid', Icon: LayoutGrid, title: 'Cards with a preview of each message' },
        { id: 'list', label: 'List', Icon: List, title: 'A compact table' },
      ]} />
  );
}
