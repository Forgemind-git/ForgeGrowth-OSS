// Route key `workflow-agents`:
//   #/workflow-agents                          the agents list
//   #/workflow-agents/new                      guided creation (admin)
//   #/workflow-agents/settings                 team & settings (admin)
//   #/workflow-agents/<id>/<tab>[/<runId>]     the builder, on a tab (runs may carry a run id)

import AgentList from './AgentList.jsx';
import AgentBuilder from './AgentBuilder.jsx';
import SettingsPage from './SettingsPage.jsx';
import CreateAgentWizard from './CreateAgentWizard.jsx';

export default function WorkflowAgentsPage({ user, navigate, subParts = [] }) {
  const [first, tab, runId] = subParts;
  if (first === 'settings') {
    if (user?.role !== 'admin') return <AgentList user={user} navigate={navigate} />;
    return <SettingsPage navigate={navigate} />;
  }
  if (first === 'new') {
    if (user?.role !== 'admin') return <AgentList user={user} navigate={navigate} />;
    return <CreateAgentWizard navigate={navigate} />;
  }
  if (first && /^\d+$/.test(first)) {
    return <AgentBuilder key={first} agentId={first} tab={tab} runId={tab === 'runs' && /^\d+$/.test(runId || '') ? runId : null} user={user} navigate={navigate} />;
  }
  return <AgentList user={user} navigate={navigate} />;
}
