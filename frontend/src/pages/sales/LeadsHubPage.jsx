// Sales → Leads — ONE tab for the three views of the same leads model:
//   pipeline — the Kanban working surface (drag a card to move stages)
//   funnel   — the funnel-shaped chart with stage drill-down
//   list     — the filterable master table + CSV export
//
// The active view is a routed sub-part (#/leads, #/leads/funnel, #/leads/list)
// rather than local state, so a refresh keeps the view and the hash stays the
// single source of truth — same pattern as the Sales Log detail route. Each
// view keeps its own PageShell (title/subtitle/actions differ), and renders
// the shared tab strip as its first child — the exact shape PaymentsPage uses
// for its "Links raised here / All payments" tabs.
import { C, FONT } from '../../constants.js';
import PipelinePage from './PipelinePage.jsx';
import FunnelViewerPage from './FunnelViewerPage.jsx';
import LeadsPage from './LeadsPage.jsx';

const TABS = [
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'funnel', label: 'Funnel' },
  { key: 'list', label: 'All Leads' },
];

export function LeadsTabs({ tab, setTab }) {
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 16 }}>
      {TABS.map(t => (
        <button key={t.key} onClick={() => setTab(t.key)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '8px 14px', marginBottom: -1,
            borderBottom: `2px solid ${tab === t.key ? C.primary : 'transparent'}`, fontFamily: FONT,
            fontSize: 13.5, fontWeight: tab === t.key ? 700 : 500, color: tab === t.key ? C.text : C.textSecondary,
          }}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export default function LeadsHubPage({ user, navigate, subParts = [] }) {
  const tab = subParts[0] === 'funnel' ? 'funnel' : subParts[0] === 'list' ? 'list' : 'pipeline';
  const setTab = (t) => navigate && (t === 'pipeline' ? navigate('leads') : navigate('leads', t));
  const tabs = <LeadsTabs tab={tab} setTab={setTab} />;

  if (tab === 'funnel') return <FunnelViewerPage user={user} tabs={tabs} />;
  if (tab === 'list') {
    return <LeadsPage user={user} navigate={navigate} tabs={tabs} onOpenPipeline={() => setTab('pipeline')} />;
  }
  return <PipelinePage user={user} navigate={navigate} tabs={tabs} onOpenLeads={() => setTab('list')} />;
}
