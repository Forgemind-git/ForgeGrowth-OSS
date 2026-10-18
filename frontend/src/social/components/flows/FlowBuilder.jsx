import { UNZOOM_STYLE } from '../../../lib/uiZoom.js';
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, useNodesState, useEdgesState, useReactFlow, addEdge, MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowLeft, Save, Loader2, ZoomIn, ZoomOut, Maximize2, Plus, Play, Square, MousePointerClick, X, Smartphone } from "lucide-react";
import { api } from "../../api.js";
import { C, FONT, MONO, BTN, INPUT } from "../../constants.js";
import { showToast } from "../../Toast.jsx";
import { useConfirm } from "../../ConfirmDialog.jsx";
import { SearchableSelect } from "../Dropdown.jsx";
import { useCrm, tagOptions, fieldOptions } from "../contacts/crmStore.js";
import { nodeTypes, FlowCtx } from "./FlowNodes.jsx";
import NodePanel from "./NodePanel.jsx";
import FlowSimPanel from "./FlowSimPanel.jsx";
import { NODE_TYPES, NEXT_STEP_MENU, defaultData, rid, triggerText } from "./flowDefs.js";

// ManyChat-style node-to-node automation builder (backend: services/flowEngine.js).
export default function FlowBuilder(props) {
  return <ReactFlowProvider><Builder {...props} /></ReactFlowProvider>;
}

const EDGE_STYLE = { stroke: "var(--fc-text-muted)", strokeWidth: 2 };
const edgeDefaults = { type: "smoothstep", style: EDGE_STYLE, markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "var(--fc-text-muted)" } };
const decorate = (es) => es.map(e => ({ ...edgeDefaults, ...e, id: e.id || `${e.source}-${e.sourceHandle || "next"}-${e.target}` }));
const asNodes = (ns) => ns.map(n => ({ ...n, deletable: n.type !== "trigger" }));

function Builder({ flow: initial, seed, accounts, defaultAccount, meta, isAdmin, onBack, onSaved }) {
  const rf = useReactFlow();
  const wrapRef = useRef(null);
  const [flowId, setFlowId] = useState(initial?.id || null);
  const [name, setName] = useState(initial?.name || seed?.name || "Untitled automation");
  const [accountId, setAccountId] = useState(initial?.account_id || defaultAccount || accounts[0]?.account_id || "");
  const [active, setActive] = useState(!!initial?.active);
  const startGraph = initial?.graph || seed?.graph || { nodes: [], edges: [] };
  const [nodes, setNodes, onNodesChange] = useNodesState(asNodes(startGraph.nodes));
  const [edges, setEdges, onEdgesChange] = useEdgesState(decorate(startGraph.edges));
  const [selectedId, setSelectedId] = useState(null);
  const [menu, setMenu] = useState(null);   // { x, y, source, handle, flowPos, existing? }
  const [saving, setSaving] = useState(false);
  const [savedSig, setSavedSig] = useState(() => (initial ? sig(initial.name, initial.account_id, startGraph.nodes, startGraph.edges) : null));
  const [insights, setInsights] = useState(null);
  const [testing, setTesting] = useState(false);       // Preview / Test it panel
  const [activeNode, setActiveNode] = useState(null);  // step the simulator is on (highlighted)
  const [posts, setPosts] = useState([]);
  const [aiModels, setAiModels] = useState({ connected: false, models: [] });
  const [flows, setFlows] = useState([]);
  const crm = useCrm();
  const [ConfirmDialog, confirm] = useConfirm();
  const ro = !isAdmin;
  const pendingConnect = useRef(null);

  useEffect(() => { api.automations.flowAiModels().then(setAiModels).catch(() => {}); }, []);
  useEffect(() => { api.automations.flows(accountId || undefined).then(fs => setFlows(fs.filter(f => f.id !== flowId))).catch(() => {}); }, [accountId, flowId]);
  useEffect(() => {
    if (!accountId) return;
    api.automations.posts(accountId).then(setPosts).catch(() => setPosts([]));
  }, [accountId]);
  useEffect(() => { if (flowId) api.automations.flowInsights(flowId).then(setInsights).catch(() => {}); }, [flowId]);
  // Open on the whole flow; if that would be too small to read, zoom to 80% with the trigger on the left.
  useEffect(() => {
    const t = setTimeout(async () => {
      await rf.fitView({ padding: 0.2, maxZoom: 1 });
      const vp = rf.getViewport();
      const tn = rf.getNodes().find(n => n.type === "trigger");
      const h = wrapRef.current?.clientHeight || 600;
      if (vp.zoom < 0.8 && tn) rf.setViewport({ zoom: 0.8, x: 40 - tn.position.x * 0.8, y: h / 2 - (tn.position.y + 90) * 0.8 });
    }, 60);
    return () => clearTimeout(t);
  }, [rf]);

  // While testing, keep the running step in view (left of the phone panel).
  useEffect(() => {
    if (!testing || !activeNode) return;
    const n = rf.getNode(activeNode);
    if (!n) return;
    const z = rf.getViewport().zoom;
    rf.setCenter(n.position.x + 140 + 190 / z, n.position.y + 90, { zoom: z, duration: 400 });
  }, [activeNode, testing]);

  const dirty = sig(name, accountId, nodes, edges) !== savedSig;
  const connected = useMemo(() => new Set(edges.map(e => `${e.source}|${e.sourceHandle || "next"}`)), [edges]);
  const stats = useMemo(() => {
    const s = {};
    for (const r of insights?.perNode || []) { (s[r.node_id] ||= {})[r.kind] = r.n; }
    return s;
  }, [insights]);
  const trigger = nodes.find(n => n.type === "trigger");
  const privateReplyNode = useMemo(() => {
    if (!(trigger?.data?.triggers || []).some(t => t.kind === "comment")) return null;
    return edges.find(e => e.source === trigger.id && (e.sourceHandle || "next") === "next")?.target || null;
  }, [edges, trigger]);

  const openMenu = useCallback((source, handle, client) => {
    const flowPos = rf.screenToFlowPosition(client);
    const box = wrapRef.current?.getBoundingClientRect();
    setMenu({ source, handle, flowPos, x: client.x - (box?.left || 0), y: client.y - (box?.top || 0) });
  }, [rf]);

  function addStep(type) {
    if (!menu) return;
    const id = `${type}_${rid()}`;
    const src = nodes.find(n => n.id === menu.source);
    const position = menu.dropped ? menu.flowPos : src ? { x: src.position.x + 360, y: src.position.y + (Math.random() * 40 - 20) } : menu.flowPos;
    setNodes(ns => [...ns, { id, type, position, data: defaultData(type), deletable: true }]);
    if (menu.source) setEdges(es => decorate([...es.filter(e => !(e.source === menu.source && (e.sourceHandle || "next") === menu.handle)), { source: menu.source, sourceHandle: menu.handle, target: id }]));
    setMenu(null);
    setSelectedId(id);
  }
  function linkExisting(targetId) {
    setEdges(es => decorate([...es.filter(e => !(e.source === menu.source && (e.sourceHandle || "next") === menu.handle)), { source: menu.source, sourceHandle: menu.handle, target: targetId }]));
    setMenu(null);
  }

  const onConnect = useCallback((c) => {
    pendingConnect.current = null;
    // One connection per outgoing handle: a new link replaces the old one.
    setEdges(es => decorate(addEdge({ ...c, sourceHandle: c.sourceHandle || "next" }, es.filter(e => !(e.source === c.source && (e.sourceHandle || "next") === (c.sourceHandle || "next"))))));
  }, [setEdges]);
  const onConnectStart = useCallback((_, p) => { pendingConnect.current = p?.handleType === "source" ? p : null; }, []);
  const onConnectEnd = useCallback((e, state) => {
    const p = pendingConnect.current;
    pendingConnect.current = null;
    if (!p || state?.isValid || ro) return;
    if (!e.target?.classList?.contains("react-flow__pane")) return;
    const pt = "changedTouches" in e ? e.changedTouches[0] : e;
    openMenu(p.nodeId, p.handleId || "next", { x: pt.clientX, y: pt.clientY });
    setMenu(m => m && { ...m, dropped: true });
  }, [openMenu, ro]);

  const selected = nodes.find(n => n.id === selectedId) || null;
  const updateData = (data) => setNodes(ns => ns.map(n => n.id === selectedId ? { ...n, data } : n));
  // Lets a node card change its own settings (e.g. the "Follow up if they don't respond" shortcut).
  const setNodeData = useCallback((id, patch) => setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)), []);
  function deleteSelected() {
    if (!selected || selected.type === "trigger") return;
    setNodes(ns => ns.filter(n => n.id !== selected.id));
    setEdges(es => es.filter(e => e.source !== selected.id && e.target !== selected.id));
    setSelectedId(null);
  }
  function duplicateSelected() {
    if (!selected || selected.type === "trigger") return;
    const id = `${selected.type}_${rid()}`;
    setNodes(ns => [...ns, { ...selected, id, selected: false, position: { x: selected.position.x + 40, y: selected.position.y + 220 }, data: JSON.parse(JSON.stringify(selected.data)) }]);
    setSelectedId(id);
  }

  function validate() {
    const ts = trigger?.data?.triggers || [];
    if (!name.trim()) return "Give the automation a name.";
    if (!accountId) return "Pick the Instagram account.";
    if (!ts.length) return "Add a trigger: click the “When…” step.";
    for (const t of ts) {
      if (t.kind === "comment" && t.postMode === "one" && !t.mediaId) return "Pick the post for the comment trigger.";
      if (t.kind === "dm" && !(t.keywords || []).length) return "Add keywords to the DM trigger, so it doesn't answer every DM.";
      // "called" (Started by another automation) needs nothing: no Instagram event fires it.
      if ((t.kind === "comment" || t.kind === "story_reply") && !t.anyWord && !(t.keywords || []).length) return `Add keywords to the ${t.kind === "comment" ? "comment" : "story reply"} trigger, or choose “Any word”.`;
    }
    if (!edges.some(e => e.source === trigger.id)) return "Connect the trigger to a first step.";
    for (const n of nodes) {
      if (n.type === "message" && !(n.data.blocks || []).some(b => (b.type === "text" && b.text?.trim()) || (b.type === "image" && b.url) || (b.type === "card" && b.title))) return "A Send Message step is empty.";
      if (n.type === "message" && (n.data.blocks || []).some(b => (b.buttons || []).some(x => x.kind === "url" && x.title && !/^https?:\/\/.+\..+/.test(x.url || "")))) return "A link button needs a full https:// link.";
      if (n.type === "goto" && !n.data.flowId) return "A “Start another Automation” step has no automation picked.";
      if (n.type === "goto") {
        const tf = flows.find(f => String(f.id) === String(n.data.flowId));
        if (!tf) return "A “Start another Automation” step points to an automation that no longer exists. Pick another.";
        if (!tf.active) return `“${tf.name}” is off, so the “Start another Automation” step would do nothing. Set it live first.`;
      }
      if (n.type === "collect" && !n.data.prompt?.trim()) return "An Ask a Question step has no question.";
      if (n.type === "follow" && !edges.some(e => e.source === n.id && e.sourceHandle === "yes")) return "Connect the Follow Check's “Follows” output to what followers get.";
    }
    return null;
  }

  async function save(nextActive = active) {
    if (nextActive) { const err = validate(); if (err) { showToast(err, "error"); return false; } }
    setSaving(true);
    const graph = { nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data })), edges: edges
      // a "No response" connection only exists while that message has the setting on
      .filter(e => e.sourceHandle !== "noreply" || nodes.find(n => n.id === e.source)?.data?.noReply?.enabled)
      .map(({ id, source, sourceHandle, target }) => ({ id, source, sourceHandle: sourceHandle || "next", target })) };
    const body = { name: name.trim() || "Untitled automation", account_id: accountId, active: nextActive, graph, template: seed?.template || undefined };
    try {
      const f = flowId ? await api.automations.updateFlow(flowId, body) : await api.automations.createFlow(body);
      setFlowId(f.id); setActive(!!f.active);
      setSavedSig(sig(body.name, accountId, nodes, edges));
      showToast(f.active ? (active ? "Saved" : "Automation is live") : (active ? "Automation stopped" : "Saved as draft"), "success");
      onSaved?.(f);
      return true;
    } catch (e) { showToast(e.message, "error"); return false; }
    finally { setSaving(false); }
  }

  async function back() {
    if (dirty && isAdmin) {
      const ok = await confirm({ title: "Leave without saving?", body: "Your changes to this automation will be lost.", confirmLabel: "Leave", danger: true });
      if (!ok) return;
    }
    onBack();
  }

  const accountOptions = accounts.map(a => ({ value: a.account_id, label: "@" + a.username }));
  const ctx = { posts, tags: tagOptions(crm.tags), fields: fieldOptions(crm.fields), aiModels, flows, meta, flowId };
  const firstTrigger = trigger?.data?.triggers?.[0];

  return (
    // Rendered 1:1 inside the 110%-zoomed app so React Flow's pointer maths is
    // not 10% off (lib/uiZoom.js). 100vh is therefore real viewport px here.
    <div style={{ ...UNZOOM_STYLE, fontFamily: FONT, display: "flex", flexDirection: "column", height: "calc(100vh - 165px)", minHeight: 560 }}>
      {ConfirmDialog}
      {/* top bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <button onClick={back} style={BTN.icon} title="Back to automations" aria-label="Back"><ArrowLeft size={16} /></button>
        <input value={name} disabled={ro} onChange={e => setName(e.target.value)} aria-label="Automation name"
          style={{ ...INPUT, background: "transparent", fontSize: 18, fontWeight: 750, padding: "4px 6px", width: "auto", flex: "1 1 220px", minWidth: 160 }} />
        <span style={{ padding: "3px 8px", borderRadius: 6, fontSize: 11, fontWeight: 750, letterSpacing: ".04em", background: active ? C.primary : C.surface2, color: active ? C.onAccent : C.textMuted }}>{active ? "LIVE" : insights?.runs ? "OFF" : "DRAFT"}</span>
        {insights && (
          <span style={{ fontSize: 12.5, color: C.textMuted }} title="Runs · CTR on link buttons">
            <b style={{ color: C.text, fontFamily: MONO }}>{insights.runs}</b> runs · <b style={{ color: C.text, fontFamily: MONO }}>{insights.ctr == null ? "–" : insights.ctr + "%"}</b> CTR
          </span>
        )}
        <SearchableSelect value={accountId} options={accountOptions} onChange={setAccountId} disabled={ro} placeholder="Account" />
        <button onClick={() => setTesting(t => !t)} style={testing ? { ...BTN.secondary, background: C.primarySoft, color: C.primary } : BTN.secondary} title="See how it works and try it with a test follower">
          <Smartphone size={14} /> Preview & test
        </button>
        {isAdmin && (
          <>
            <button onClick={() => save(active)} disabled={saving || (!dirty && !!flowId)} style={{ ...BTN.secondary, opacity: !dirty && flowId ? 0.6 : 1 }}>
              {saving ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Save size={14} />} {dirty || !flowId ? "Save" : "Saved"}
            </button>
            <button onClick={() => save(!active)} disabled={saving} style={active ? BTN.danger : BTN.primary}>
              {active ? <><Square size={13} /> Stop</> : <><Play size={14} /> Set live</>}
            </button>
          </>
        )}
      </div>

      {/* canvas */}
      <div ref={wrapRef} className="fs-flow" style={{ position: "relative", flex: 1, borderRadius: 16, overflow: "hidden", background: "var(--fs-canvas)" }}>
        <style>{FLOW_CSS}</style>
        <FlowCtx.Provider value={{ connected, stats, openMenu: ro ? () => {} : openMenu, privateReplyNode, activeNode: testing ? activeNode : null, setNodeData: ro ? null : setNodeData }}>
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={ro ? undefined : onNodesChange} onEdgesChange={ro ? undefined : onEdgesChange}
            onConnect={onConnect} onConnectStart={onConnectStart} onConnectEnd={onConnectEnd}
            onNodeClick={(_, n) => { setSelectedId(n.id); setMenu(null); }}
            onPaneClick={() => { setSelectedId(null); setMenu(null); }}
            nodesDraggable={!ro} nodesConnectable={!ro} elementsSelectable
            deleteKeyCode={ro ? null : ["Backspace", "Delete"]}
            onNodesDelete={(ns) => { if (ns.some(n => n.id === selectedId)) setSelectedId(null); }}
            defaultEdgeOptions={edgeDefaults} minZoom={0.2} maxZoom={1.6} proOptions={{ hideAttribution: true }}
          >
            <Background gap={22} size={1.6} />
          </ReactFlow>
        </FlowCtx.Provider>

        {/* zoom */}
        <div style={{ position: "absolute", left: 12, bottom: 12, display: "flex", flexDirection: "column", gap: 6, zIndex: 5 }}>
          {[[ZoomIn, () => rf.zoomIn(), "Zoom in"], [ZoomOut, () => rf.zoomOut(), "Zoom out"], [Maximize2, () => rf.fitView({ padding: 0.2, maxZoom: 1 }), "Fit to screen"]].map(([I, fn, t]) => (
            <button key={t} type="button" onClick={fn} title={t} aria-label={t} style={{ ...BTN.icon, background: "var(--fs-node-bg)", boxShadow: "0 0 0 1px var(--fs-node-ring), var(--fs-node-shadow)" }}><I size={15} /></button>
          ))}
        </div>

        {/* hint */}
        {!ro && nodes.length <= 1 && !edges.length && (
          <div style={{ position: "absolute", left: "50%", top: 16, transform: "translateX(-50%)", zIndex: 5, background: "var(--fs-node-bg)", boxShadow: "0 0 0 1px var(--fs-node-ring)", borderRadius: 999, padding: "8px 14px", fontSize: 12.5, color: C.textSecondary, display: "flex", alignItems: "center", gap: 6, maxWidth: "90%" }}>
            <MousePointerClick size={14} /> Click the trigger to set it up, then press <b>+</b> to add the next step.
          </div>
        )}
        {firstTrigger && !selected && (
          <div style={{ position: "absolute", left: 64, bottom: 14, zIndex: 4, fontSize: 12, color: C.textMuted, maxWidth: "50%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Starts when someone {triggerText(firstTrigger).replace(/^./, c => c.toLowerCase())}</div>
        )}

        {/* choose next step */}
        {menu && (
          <div style={{ position: "absolute", zIndex: 20, left: Math.min(menu.x + 8, (wrapRef.current?.clientWidth || 800) - 270), top: Math.max(8, Math.min(menu.y - 20, (wrapRef.current?.clientHeight || 600) - 470)), width: 260, background: "var(--fs-node-bg)", borderRadius: 16, boxShadow: `0 0 0 1px var(--fs-node-ring), ${C.shadowLg}`, padding: 8 }}>
            <div style={{ display: "flex", alignItems: "center", padding: "6px 8px 8px" }}>
              <b style={{ flex: 1, fontSize: 14, color: C.text }}>{menu.existing ? "Select existing step" : "Choose next step"}</b>
              <button type="button" onClick={() => setMenu(null)} style={{ ...BTN.icon, width: 26, height: 26 }} aria-label="Close"><X size={13} /></button>
            </div>
            <div style={{ maxHeight: 400, overflowY: "auto" }}>
              {!menu.existing ? (
                <>
                  {NEXT_STEP_MENU.map(t => {
                    const d = NODE_TYPES[t];
                    return (
                      <button key={t} type="button" onClick={() => addStep(t)} className="fc-row fs-menu-row"
                        style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 10px", border: "none", background: "transparent", cursor: "pointer", fontFamily: FONT, textAlign: "left", borderRadius: 10 }}>
                        <span style={{ width: 30, height: 30, borderRadius: 9, background: C[t === "delay" ? "primarySoft" : `${d.ink}Soft`], color: C[d.ink], display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><d.Icon size={15} /></span>
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: "block", fontSize: 13.5, fontWeight: 650, color: C.text }}>{d.label}</span>
                          <span style={{ display: "block", fontSize: 11.5, color: C.textMuted, lineHeight: 1.3 }}>{d.hint}</span>
                        </span>
                      </button>
                    );
                  })}
                  {nodes.filter(n => n.type !== "trigger" && n.id !== menu.source).length > 0 && (
                    <button type="button" onClick={() => setMenu(m => ({ ...m, existing: true }))} className="fc-row fs-menu-row"
                      style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 10px", border: "none", background: "transparent", cursor: "pointer", fontFamily: FONT, borderRadius: 10, fontSize: 13.5, fontWeight: 650, color: C.text }}>
                      <span style={{ width: 30, height: 30, borderRadius: 9, background: C.surface2, color: C.textSecondary, display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Plus size={15} /></span>
                      Select existing step
                    </button>
                  )}
                </>
              ) : nodes.filter(n => n.type !== "trigger" && n.id !== menu.source).map(n => (
                <button key={n.id} type="button" onClick={() => linkExisting(n.id)} className="fc-row fs-menu-row"
                  style={{ display: "block", width: "100%", padding: "9px 10px", border: "none", background: "transparent", cursor: "pointer", fontFamily: FONT, textAlign: "left", borderRadius: 10 }}>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 650, color: C.text }}>{NODE_TYPES[n.type].label}</span>
                  <span style={{ display: "block", fontSize: 11.5, color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview(n)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* step editor + preview / test */}
        {(selected || testing) && (
          <div style={{ position: "absolute", top: 10, right: 10, bottom: 10, zIndex: 10, display: "flex", gap: 10 }}>
            {selected && <NodePanel node={selected} onChange={updateData} onClose={() => setSelectedId(null)} onDelete={deleteSelected} onDuplicate={duplicateSelected} ctx={ctx} readOnly={ro} />}
            {testing && (
              <FlowSimPanel graph={{ nodes, edges }} account={accounts.find(a => a.account_id === accountId)?.username || ""} posts={posts}
                tagName={(id) => crm.tags.find(t => t.id === id)?.name || id} flowName={(id) => flows.find(f => String(f.id) === String(id))?.name || `automation #${id}`} flows={flows}
                onNode={setActiveNode} onClose={() => { setTesting(false); setActiveNode(null); }} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function preview(n) {
  const d = n.data || {};
  if (n.type === "message") return (d.blocks || []).find(b => b.text)?.text || "Message";
  if (n.type === "collect") return d.prompt;
  if (n.type === "delay") return `Wait ${d.amount} ${d.unit}`;
  if (n.type === "condition") return `${(d.rules || []).length} rule(s)`;
  if (n.type === "action") return `${(d.actions || []).length} action(s)`;
  return NODE_TYPES[n.type]?.hint || "";
}

function sig(name, account, nodes, edges) {
  return JSON.stringify([name, account, nodes.map(n => [n.id, n.type, Math.round(n.position.x), Math.round(n.position.y), n.data]), edges.map(e => [e.source, e.sourceHandle || "next", e.target])]);
}

const FLOW_CSS = `
/* Canvas vs. step cards: cards sit on the brightest surface with a hairline ring + lift, the canvas is a step darker with a visible dot grid. */
.fs-flow { --fs-canvas: var(--fc-page); --fs-node-bg: var(--fc-card); --fs-node-ring: rgba(0,0,0,.08); --fs-node-shadow: 0 2px 4px rgba(0,0,0,.05), 0 10px 24px rgba(0,0,0,.07); --fs-dot: rgba(0,0,0,.18); }
[data-theme="dark"] .fs-flow { --fs-canvas: var(--fc-page); --fs-node-bg: #1e1e1e; --fs-node-ring: rgba(255,255,255,.10); --fs-node-shadow: 0 2px 4px rgba(0,0,0,.5), 0 10px 24px rgba(0,0,0,.45); --fs-dot: rgba(255,255,255,.14); }
.fs-flow .react-flow { background: transparent; --xy-background-pattern-dots-color-default: var(--fs-dot); }
.fs-flow .react-flow__edge.selected .react-flow__edge-path { stroke: var(--fc-primary) !important; stroke-width: 2.5; }
.fs-flow .react-flow__node { cursor: pointer; }
.fs-flow .react-flow__handle { transition: transform .12s; }
.fs-flow .react-flow__handle:hover { transform: translate(50%, -50%) scale(1.25); }
.fs-flow .react-flow__handle-left:hover { transform: translate(-50%, -50%) scale(1.25); }
.fs-flow .react-flow__node.selected, .fs-flow .react-flow__node:focus { outline: none; }
.fs-menu-row:hover { background: var(--fc-surface) !important; }
`;
