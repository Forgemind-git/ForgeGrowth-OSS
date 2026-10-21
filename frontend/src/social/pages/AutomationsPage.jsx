import { useState, useEffect, useCallback, useMemo } from "react";
import { Plus, ArrowLeft, Loader2, Zap, Activity, RefreshCw, Bot, LayoutGrid, List } from "lucide-react";
import { api } from "../api.js";
import { C, FONT, BTN } from "../constants.js";
import { showToast } from "../Toast.jsx";
import { useConfirm } from "../ConfirmDialog.jsx";
import { PageHeader, UnderlineTabs, PillTabs } from "../components/UI.jsx";
import { SearchableSelect } from "../components/Dropdown.jsx";
import RuleEditor from "../components/automations/RuleEditor.jsx";
import AutomationDetail from "../components/automations/AutomationDetail.jsx";
import AutomationTable, { toRows } from "../components/automations/AutomationTable.jsx";
import TemplatesModal from "../components/automations/TemplatesModal.jsx";
import ActivityLog from "../components/automations/ActivityLog.jsx";
import FlowBuilder from "../components/flows/FlowBuilder.jsx";
import { useScope } from "../components/scope/scopeStore.js";
import AutomationsDashboard from "../components/automations/AutomationsDashboard.jsx";
import IgAgentList from "../components/agents/IgAgentList.jsx";
import IgAgentEditor from "../components/agents/IgAgentEditor.jsx";

// Grid / List choice for My Automations, remembered per browser (a viewing preference).
const VIEW_KEY = "forgegrowth.social.automationsView";
const readView = () => { try { return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list"; } catch { return "list"; } };

/**
 * Automations — ManyChat-style Instagram automations.
 *  - Quick Automations (rules, backend services/commentAutomation.js): simple step editor + detail page.
 *  - Flow Builder (node graphs, backend services/flowEngine.js): canvas editor.
 * Dashboard cards on top. Tabs: My Automations (both, one table — Grid or List) · AI Agents (Instagram AI agents,
 * quick editor) · Activity. "New Automation" opens the picker with the one automation preset; "New AI agent"
 * opens it on the AI agent presets. Creation is preset-only.
 * View state is local, like Agent Builder.
 */
export default function AutomationsPage({ user }) {
  const isAdmin = user?.role === "admin";
  const [tab, setTab] = useState("rules");
  const [account, setAccount] = useState("");
  const scope = useScope();
  const [accounts, setAccounts] = useState([]);
  const [meta, setMeta] = useState(null);
  const [rules, setRules] = useState([]);
  const [flows, setFlows] = useState([]);
  const [log, setLog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [picker, setPicker] = useState(false); // false | the Templates filter to open on ("all" | "agent")
  const [agents, setAgents] = useState([]);
  const [layout, setLayoutState] = useState(readView);
  const setLayout = (v) => { setLayoutState(v); try { localStorage.setItem(VIEW_KEY, v); } catch {} };
  const [stateFilter, setStateFilter] = useState("");
  const [ConfirmDialog, confirm] = useConfirm();
  // null = list · { mode: "detail", rule } · { mode: "edit", rule?, seed? } · { mode: "flow", flow?, seed? } · { mode: "agent", template?, agent? }
  const [view, setView] = useState(null);
  const editing = view?.mode === "edit" ? view : null;
  const agentView = view?.mode === "agent" ? view : null;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const acc = account || undefined;
      const [r, f, l, a, m, ag] = await Promise.all([
        api.automations.list(acc), api.automations.flows(acc).catch(() => []),
        api.automations.log({ account_id: acc, limit: 200 }),
        api.automations.accounts().catch(() => []), api.automations.meta().catch(() => null),
        api.agents.list().catch(() => []),
      ]);
      setRules(r); setFlows(f); setLog(l); setAccounts(a); setMeta(m);
      setAgents((ag || []).filter(x => !x.platform || x.platform === "instagram"));
    } catch (e) { showToast(e.message, "error"); }
    finally { setLoading(false); }
  }, [account]);

  useEffect(() => { refresh(); }, [refresh]);
  // Activity ticks over on its own while the tab is open.
  useEffect(() => {
    if (view || tab !== "activity") return;
    const t = setInterval(() => {
      api.automations.log({ account_id: account || undefined, limit: 200 }).then(setLog).catch(() => {});
    }, 15000);
    return () => clearInterval(t);
  }, [tab, view, account]);

  // Back from the quick editor: to the automation's detail page when editing one, else the list.
  function closeEditor() { setView(editing?.rule ? { mode: "detail", rule: editing.rule } : null); }
  async function afterSave(saved) {
    refresh();
    if (!saved) { setView(null); return; }
    const fresh = await api.automations.list(account || undefined).catch(() => null);
    const row = fresh?.find(r => r.id === saved.id);
    if (fresh) setRules(fresh);
    setView({ mode: "detail", rule: row || { ...editing?.rule, ...saved } });
  }

  async function remove(row) {
    const ok = await confirm({ title: `Delete “${row.name}”?`, body: "It stops immediately and can't be undone. Captured leads are kept.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      if (row.kind === "flow") await api.automations.removeFlow(row.raw.id);
      else await api.automations.remove(row.raw.id);
      showToast("Automation deleted", "success");
      refresh();
    } catch (e) { showToast(e.message, "error"); }
  }

  async function removeAgent(a) {
    const ok = await confirm({ title: `Delete “${a.name}”?`, body: "It stops replying immediately and can't be undone.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try { await api.agents.remove(a.id); showToast("Agent deleted", "success"); refresh(); }
    catch (e) { showToast(e.message, "error"); }
  }
  async function toggleAgent(a, on) {
    try {
      // Off keeps status "active" (complete, just not answering) so the row reads OFF, not DRAFT.
      const saved = await api.agents.update(a.id, on ? { status: "active", isActive: true } : { isActive: false });
      setAgents(xs => xs.map(x => x.id === a.id ? { ...x, ...saved } : x));
      showToast(on ? `${a.name} is live` : `${a.name} is off`, "success");
    } catch (e) { showToast(e.message, "error"); }
  }

  // "My accounts" preset (top bar): automations of Instagram accounts outside it are hidden.
  const shownAccounts = accounts.filter(a => scope.hasIg(a.account_id));
  const accountOptions = shownAccounts.map(a => ({ value: a.account_id, label: "@" + a.username }));
  const rows = useMemo(() => toRows(rules.filter(r => scope.hasIg(r.account_id)), flows.filter(f => scope.hasIg(f.account_id))), [rules, flows, scope.tokens.join(",")]);
  const hiddenCount = rules.length + flows.length - rows.length;
  const live = rows.filter(r => r.active).length;
  const shownAgents = agents.filter(a => (!a.accountId || scope.hasIg(a.accountId)) && (!account || a.accountId === account));
  const openRow = (r) => setView(r.kind === "flow" ? { mode: "flow", flow: r.raw } : { mode: "detail", rule: r.raw });
  const defaultAccount = account || shownAccounts[0]?.account_id || accounts[0]?.account_id;

  if (view?.mode === "flow") {
    return (
      <FlowBuilder key={view.flow?.id || view.seed?.key || "new"} flow={view.flow || null} seed={view.seed} accounts={accounts}
        defaultAccount={defaultAccount} meta={meta} isAdmin={isAdmin}
        onBack={() => { setView(null); refresh(); }} onSaved={() => {}} />
    );
  }

  return (
    <div style={{ fontFamily: FONT }}>
      {ConfirmDialog}
      {picker && (
        <TemplatesModal onClose={() => setPicker(false)} initialFilter={picker}
          onAgent={isAdmin ? (t) => { setPicker(false); setTab("agents"); setView({ mode: "agent", template: t }); } : undefined}
          onQuick={(t) => { setPicker(false); setView({ mode: "edit", seed: t }); }} />
      )}
      {view?.mode === "detail" ? (
        <AutomationDetail key={view.rule.id} rule={view.rule} isAdmin={isAdmin}
          onBack={() => { setView(null); refresh(); }}
          onEdit={(r) => setView({ mode: "edit", rule: r })}
          onChanged={(r) => setRules(rs => rs.map(x => x.id === r.id ? { ...x, ...r } : x))} />
      ) : (
        <>
          <PageHeader
            title={editing || agentView ? "Automations" : "My Automations"}
            sub={agentView ? (agentView.agent ? `Editing ${agentView.agent.name}` : `New AI agent · ${agentView.template?.title || ""}`)
              : editing ? (editing.rule ? `Editing ${editing.rule.name}` : editing.seed ? editing.seed.title : "New automation") : `Instagram comments, DMs and stories on autopilot · ${live} live`}
            right={editing || agentView
              ? <button onClick={agentView ? () => { setView(null); refresh(); } : closeEditor} style={BTN.secondary}><ArrowLeft size={15} /> Back</button>
              : <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {shownAccounts.length > 1 && <SearchableSelect value={account} options={accountOptions} onChange={setAccount} allLabel="All accounts" label="Account" />}
                  <button onClick={refresh} style={BTN.icon} title="Refresh" aria-label="Refresh"><RefreshCw size={15} /></button>
                  {isAdmin && (tab === "agents"
                    ? <button onClick={() => setPicker("agent")} style={BTN.primary} data-testid="new-ig-agent"><Bot size={15} /> New AI agent</button>
                    : <button onClick={() => setPicker("all")} style={BTN.primary}><Plus size={15} /> New Automation</button>)}
                </div>}
          />

          {agentView ? (
            <IgAgentEditor key={agentView.agent?.id || agentView.template?.id || "new"} template={agentView.template || null} agent={agentView.agent || null}
              accounts={shownAccounts.length ? shownAccounts : accounts} defaultAccount={defaultAccount} isAdmin={isAdmin}
              onCancel={() => { setView(null); refresh(); }} onDone={() => { setView(null); refresh(); }} />
          ) : editing ? (
            <RuleEditor key={editing.rule?.id || editing.seed?.id || "new"} rule={editing.rule || null} seed={editing.seed?.seed}
              accounts={accounts} defaultAccount={defaultAccount} meta={meta} isAdmin={isAdmin}
              onCancel={closeEditor} onDone={afterSave} />
          ) : (
            <>
              {!loading && (
                <AutomationsDashboard rows={rows} agents={shownAgents} onOpen={openRow}
                  liveFilterOn={tab === "rules" && stateFilter === "live"}
                  onShowLive={() => { setTab("rules"); setStateFilter(f => f === "live" ? "" : "live"); }}
                  onShowAgents={() => setTab("agents")} />
              )}
              <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 18 }}>
                <UnderlineTabs value={tab} onChange={setTab} style={{ flex: 1, minWidth: 0, overflowX: "auto" }} tabs={[
                  { id: "rules", label: "My Automations", Icon: Zap, count: rows.length },
                  { id: "agents", label: "AI Agents", Icon: Bot, count: shownAgents.length },
                  { id: "activity", label: "Activity", Icon: Activity },
                ]} />
                {tab === "rules" && (
                  <div style={{ flexShrink: 0, paddingBottom: 6 }} data-testid="automation-layout">
                    <PillTabs size="sm" value={layout} onChange={setLayout} tabs={[{ id: "grid", label: "Grid", Icon: LayoutGrid }, { id: "list", label: "List", Icon: List }]} />
                  </div>
                )}
              </div>
              {!loading && tab === "rules" && hiddenCount > 0 && (
                <div style={{ fontSize: 13, color: C.textMuted, background: C.raised, borderRadius: 10, padding: "9px 12px", marginBottom: 10 }}>
                  {hiddenCount} automation{hiddenCount === 1 ? " is" : "s are"} on accounts outside <b style={{ color: C.text }}>My accounts</b> (top bar) and hidden here.
                </div>
              )}
              {loading
                ? <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 60, gap: 8, color: C.textMuted, fontSize: 14 }}><Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> Loading…</div>
                : tab === "rules" ? <AutomationTable rows={rows} isAdmin={isAdmin} onDelete={remove} onOpen={openRow} view={layout}
                    stateFilter={stateFilter} onStateFilter={(v) => setStateFilter(v || "")} />
                : tab === "agents" ? <IgAgentList agents={shownAgents} accounts={accounts} isAdmin={isAdmin}
                    onOpen={(a) => setView({ mode: "agent", agent: a })} onToggle={toggleAgent} onDelete={removeAgent} onCreate={() => setPicker("agent")} />
                : <ActivityLog rows={log} isAdmin={isAdmin} />}
              {meta && tab === "rules" && rows.length > 0 && (
                <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 14 }}>
                  Up to {meta.maxPerHour} automated replies per account per hour, to stay inside Meta's limits.
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
