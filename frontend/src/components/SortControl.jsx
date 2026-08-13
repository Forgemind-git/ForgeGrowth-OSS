import { ArrowDownUp } from 'lucide-react';
import SearchableSelect from './SearchableSelect.jsx';
import { C, FONT } from '../constants.js';
import { LIST_SORT_OPTIONS } from '../lib/listSort.js';

/**
 * The Sort dropdown used by every entity list page (Automations, AI Agents,
 * Projects, Follow-ups, Templates, Forms), so the control looks and reads the
 * same everywhere.
 *
 * Built on SearchableSelect rather than a native <select> — project convention
 * (see frontend CLAUDE.md: every dropdown in the app is a SearchableSelect).
 * The option list is short, so SearchableSelect hides its own search box.
 *
 * Props:
 *  - value / onChange: the sort key, from lib/listSort.js
 *  - options:          override the option list (e.g. to drop "Recently
 *                      updated" on a list with no meaningful updated stamp)
 *  - width:            trigger width in px
 */
export default function SortControl({ value, onChange, options = LIST_SORT_OPTIONS, width = 178, style }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, ...style }}>
      <ArrowDownUp size={14} color={C.textMuted} style={{ flexShrink: 0 }} />
      <div style={{ width }}>
        <SearchableSelect
          value={value}
          onChange={onChange}
          options={options}
          placeholder="Sort"
          triggerStyle={{ padding: '8px 28px 8px 11px', fontSize: 14, fontFamily: FONT }}
        />
      </div>
    </div>
  );
}
