// Sales → Leads — TWO tabs over one leads model:
//
//   funnel  — the funnel-shaped chart with stage drill-down   (the default)
//   list    — the leads themselves, rendered either as a table or as a board
//
// Pipeline is deliberately NOT a third tab. It was one, and that made the same
// leads look like two different features sitting side by side; it is a way of
// LOOKING at All Leads, not a separate place, so it is a view toggle inside the
// list tab. The funnel leads because it answers "how is the pipeline doing?",
// which is the question you open Sales with — the individual leads are the
// drill-down from it.
//
// The active view is a routed sub-part, not local state, so a refresh keeps it
// and the hash stays the single source of truth:
//   #/leads              funnel
//   #/leads/list         All Leads, table
//   #/leads/list/board   All Leads, board
// Legacy `#/leads/funnel` and `#/leads/pipeline` still resolve.
//
// Each view keeps its own PageShell (title/subtitle/actions differ) and renders
// the shared tab strip as its first child — the shape PaymentsPage uses.
import { C, FONT } from '../../constants.js';
import PipelinePage from './PipelinePage.jsx';
import FunnelViewerPage from './FunnelViewerPage.jsx';
import LeadsPage from './LeadsPage.jsx';

const TABS = [
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
            fontSize: 15, fontWeight: tab === t.key ? 700 : 500, color: tab === t.key ? C.text : C.textSecondary,
          }}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export default function LeadsHubPage({ user, navigate, subParts = [] }) {
  const first = subParts[0];
  // 'pipeline' is a legacy hash from when the board was its own tab; it now
  // opens All Leads on the board rather than 404ing into the default.
  const isBoard = first === 'pipeline' || (first === 'list' && subParts[1] === 'board');
  const tab = (first === 'list' || first === 'pipeline') ? 'list' : 'funnel';

  const setTab = (t) => navigate && (t === 'funnel' ? navigate('leads') : navigate('leads', 'list'));
  // The board/table choice is routed too, so a refresh — or a link someone
  // pastes to a colleague — keeps the view they were looking at.
  const setView = (v) => navigate && (v === 'board' ? navigate('leads', 'list', 'board') : navigate('leads', 'list'));
  const tabs = <LeadsTabs tab={tab} setTab={setTab} />;

  if (tab === 'list') {
    // Both renderings are the SAME tab, so both get the same tab strip and the
    // same view toggle — switching between them must not feel like navigating.
    return isBoard
      ? <PipelinePage user={user} navigate={navigate} tabs={tabs} view="board" onChangeView={setView} />
      : <LeadsPage user={user} navigate={navigate} tabs={tabs} view="list" onChangeView={setView} />;
  }
  return <FunnelViewerPage user={user} tabs={tabs} />;
}
