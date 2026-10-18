// Approvals: every change a workflow agent has proposed, across all agents, for the
// people allowed to decide. Nothing executes without a decision here.

import { PageShell } from '../academy/shared.jsx';
import ActionList from './ActionList.jsx';

export default function ApprovalsPage({ navigate }) {
  return (
    <PageShell subtitle="Tags, stage moves, tasks and messages that workflow agents want to make. Each one waits here until an approver says yes, and expires if nobody does.">
      <ActionList navigate={navigate} />
    </PageShell>
  );
}
