import { createContext, useContext, memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { Plus, Link2, Image as ImageIcon, AlertTriangle, Clock } from "lucide-react";
import { C, FONT } from "../../constants.js";
import { NODE_TYPES, TRIGGER_KINDS, triggerText } from "./flowDefs.js";

// Shared with FlowBuilder: which handles are connected, per-node stats, the
// "+ next step" menu opener and which node is the first private reply.
export const FlowCtx = createContext({ connected: new Set(), stats: {}, openMenu: () => {}, privateReplyNode: null, activeNode: null, setNodeData: null });

const W = 280;
const soft = (ink) => C[ink === "primary" ? "primarySoft" : `${ink}Soft`] || C.surface2;

function Shell({ id, type, selected, children, warn }) {
  const def = NODE_TYPES[type];
  const { stats, activeNode } = useContext(FlowCtx);
  const st = stats[id];
  const running = activeNode === id;   // the Preview / Test it simulator is on this step
  return (
    <div className="fs-node" style={{ width: W, background: "var(--fs-node-bg)", borderRadius: 16, boxShadow: running ? `0 0 0 3px ${C.green}, 0 0 0 8px ${C.greenSoft}, var(--fs-node-shadow)` : selected ? `0 0 0 2px ${C.primary}, var(--fs-node-shadow)` : "0 0 0 1px var(--fs-node-ring), var(--fs-node-shadow)", fontFamily: FONT, position: "relative", transition: "box-shadow .2s" }}>
      {running && <span style={{ position: "absolute", top: -11, left: 14, fontSize: 10.5, fontWeight: 750, letterSpacing: ".04em", padding: "2px 8px", borderRadius: 6, background: C.green, color: "#fff" }}>TESTING HERE</span>}
      {type !== "trigger" && <Handle type="target" position={Position.Left} style={handleStyle(def.ink, true)} />}
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 14px 10px" }}>
        <span style={{ width: 28, height: 28, borderRadius: 9, background: soft(def.ink), color: C[def.ink], display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><def.Icon size={15} /></span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 10.5, color: C.textMuted, fontWeight: 650, letterSpacing: ".03em", textTransform: "uppercase" }}>{type === "trigger" ? "Trigger" : type === "message" || type === "collect" || type === "follow" ? "Instagram" : "Step"}</div>
          <div style={{ fontSize: 14, fontWeight: 750, color: C.text, letterSpacing: "-0.01em" }}>{def.label}</div>
        </div>
        {st && (st.sent > 0 || st.tap > 0) && (
          <span title="Messages sent · taps" style={{ fontSize: 11, fontWeight: 700, color: C.textSecondary, background: C.surface2, borderRadius: 999, padding: "3px 8px", whiteSpace: "nowrap" }}>
            {st.sent || 0} sent{st.tap ? ` · ${st.tap} taps` : ""}
          </span>
        )}
      </div>
      {warn && <div style={{ margin: "0 14px 8px", fontSize: 11.5, color: C.amber, display: "flex", gap: 5, alignItems: "flex-start", lineHeight: 1.35 }}><AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />{warn}</div>}
      <div style={{ padding: "0 14px 12px" }}>{children}</div>
    </div>
  );
}

function handleStyle(ink, target) {
  return { width: 12, height: 12, background: "var(--fs-node-bg)", border: `2.5px solid ${C[ink] || C.textMuted}`, ...(target ? { left: -7 } : {}) };
}

// A row that ends in an outgoing connector (button, branch, "Next step"…).
function Out({ nodeId, handle, ink, children, muted }) {
  const { connected, openMenu } = useContext(FlowCtx);
  const isOn = connected.has(`${nodeId}|${handle}`);
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", marginTop: 6, borderRadius: 10, background: muted ? "transparent" : C.surface, fontSize: 12.5, fontWeight: 650, color: muted ? C.textMuted : C.text, minHeight: 18 }}>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{children}</span>
      {!isOn && (
        <button type="button" className="nodrag" title="Add the next step" onClick={(e) => { e.stopPropagation(); openMenu(nodeId, handle, { x: e.clientX, y: e.clientY }); }}
          style={{ border: "none", background: soft(ink), color: C[ink], width: 20, height: 20, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0, flexShrink: 0, marginRight: 4 }}>
          <Plus size={12} strokeWidth={3} />
        </button>
      )}
      <Handle type="source" id={handle} position={Position.Right} style={{ ...handleStyle(ink), right: -21 }} />
    </div>
  );
}

const Bubble = ({ children }) => (
  <div style={{ background: C.surface, borderRadius: 12, padding: "8px 10px", fontSize: 12.5, color: C.text, lineHeight: 1.4, marginTop: 6, whiteSpace: "pre-wrap", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflowWrap: "anywhere" }}>{children}</div>
);
const Empty = ({ children }) => <div style={{ fontSize: 12.5, color: C.textMuted, padding: "6px 0" }}>{children}</div>;

export const TriggerNode = memo(({ id, data, selected }) => {
  const ts = data.triggers || [];
  return (
    <Shell id={id} type="trigger" selected={selected}>
      {ts.length === 0 && <Empty>Click to add a trigger: comments, DMs, story replies…</Empty>}
      {ts.map(t => {
        const k = TRIGGER_KINDS.find(x => x.id === t.kind);
        return (
          <div key={t.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", background: C.surface, borderRadius: 10, padding: "8px 10px", marginTop: 6 }}>
            {k && <k.Icon size={14} color={C.green} style={{ marginTop: 2, flexShrink: 0 }} />}
            <span style={{ fontSize: 12.5, color: C.text, lineHeight: 1.4 }}>{triggerText(t)}</span>
          </div>
        );
      })}
      <Out nodeId={id} handle="next" ink="green" muted>Then</Out>
    </Shell>
  );
});

export const MessageNode = memo(({ id, data, selected }) => {
  const { privateReplyNode, setNodeData } = useContext(FlowCtx);
  const blocks = data.blocks || [];
  const isPrivate = privateReplyNode === id;
  const warn = isPrivate && (blocks.length > 1 || (data.quickReplies || []).length > 0 && blocks.length > 1) ? "First DM after a comment is a private reply: only the first block is sent." : null;
  return (
    <Shell id={id} type="message" selected={selected} warn={warn}>
      {isPrivate && <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 2, lineHeight: 1.35 }}>Sent as a private reply to the comment. Instagram needs them to tap a button or reply before the next step.</div>}
      {blocks.length === 0 && <Empty>Empty message. Click to write it.</Empty>}
      {blocks.map(b => (
        <div key={b.id}>
          {b.type === "text" && (b.text ? <Bubble>{b.text}</Bubble> : <Empty>Write your message…</Empty>)}
          {b.type === "image" && (b.url
            ? <img src={b.url} alt="" style={{ width: "100%", height: 110, objectFit: "cover", borderRadius: 12, marginTop: 6, display: "block" }} onError={e => { e.currentTarget.style.display = "none"; }} />
            : <div style={{ height: 70, borderRadius: 12, marginTop: 6, background: C.surface, display: "flex", alignItems: "center", justifyContent: "center", color: C.textMuted }}><ImageIcon size={18} /></div>)}
          {b.type === "card" && (
            <div style={{ background: C.surface, borderRadius: 12, marginTop: 6, overflow: "hidden" }}>
              {b.image_url ? <img src={b.image_url} alt="" style={{ width: "100%", height: 90, objectFit: "cover", display: "block" }} onError={e => { e.currentTarget.style.display = "none"; }} /> : null}
              <div style={{ padding: "8px 10px", fontSize: 12.5 }}><b style={{ color: C.text }}>{b.title || "Card title"}</b>{b.subtitle && <div style={{ color: C.textMuted }}>{b.subtitle}</div>}</div>
            </div>
          )}
          {(b.buttons || []).map(btn => btn.kind === "url"
            ? <div key={btn.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", marginTop: 6, borderRadius: 10, background: C.surface, fontSize: 12.5, fontWeight: 650, color: C.text }}><Link2 size={12} color={C.blue} />{btn.title || "Link button"}</div>
            : <Out key={btn.id} nodeId={id} handle={`btn:${btn.id}`} ink="blue">{btn.title || "Button"}</Out>)}
        </div>
      ))}
      {(data.quickReplies || []).length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10.5, color: C.textMuted, fontWeight: 650, textTransform: "uppercase", letterSpacing: ".03em" }}>Quick replies</div>
          {data.quickReplies.map(q => <Out key={q.id} nodeId={id} handle={`qr:${q.id}`} ink="blue">{q.title || "Quick reply"}</Out>)}
        </div>
      )}
      <Out nodeId={id} handle="next" ink="blue" muted>Next step</Out>
      {!data.noReply?.enabled && setNodeData && !isPrivate && (
        <button type="button" className="nodrag" onClick={(e) => { e.stopPropagation(); setNodeData(id, { noReply: { enabled: true, amount: 4, unit: "hours" } }); }}
          title="Adds a “No response” output: what happens if they don't tap or reply in time"
          style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", marginTop: 6, padding: "7px 10px", borderRadius: 10, border: `1px dashed ${C.surface2}`, background: "transparent", color: C.textMuted, fontSize: 12, fontWeight: 650, cursor: "pointer", fontFamily: FONT }}>
          <Clock size={12} /> Follow up if they don't respond
        </button>
      )}
      {data.noReply?.enabled && (
        <Out nodeId={id} handle="noreply" ink="amber">
          <Clock size={12} color={C.amber} style={{ verticalAlign: -2, marginRight: 5 }} />No response in {data.noReply.amount || 1} {data.noReply.unit === "hours" ? (Number(data.noReply.amount) === 1 ? "hour" : "hours") : "min"}
        </Out>
      )}
    </Shell>
  );
});

const KIND_LABEL = { text: "Any text", email: "Email", phone: "Phone number", number: "Number", url: "Link", name: "Name" };
export const CollectNode = memo(({ id, data, selected }) => (
  <Shell id={id} type="collect" selected={selected}>
    <Bubble>{data.prompt || "Your question…"}</Bubble>
    <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6 }}>Expects: <b style={{ color: C.textSecondary }}>{KIND_LABEL[data.kind] || "Any text"}</b>{data.field ? <> · saves to <b style={{ color: C.textSecondary }}>{data.field}</b></> : null}</div>
    <Out nodeId={id} handle="next" ink="purple" muted>After they answer</Out>
  </Shell>
));

export const AiNode = memo(({ id, data, selected }) => (
  <Shell id={id} type="ai" selected={selected}>
    <Bubble>{data.instructions || "Instructions for the AI…"}</Bubble>
    <div style={{ fontSize: 12, color: data.modelId ? C.textMuted : C.amber, marginTop: 6 }}>{data.modelId ? `Model: ${data.model || "default"}` : "Pick an AI model"}</div>
    <Out nodeId={id} handle="next" ink="pink" muted>Next step</Out>
  </Shell>
));

const ACTION_LABEL = { add_tag: "Add tag", remove_tag: "Remove tag", set_field: "Set field", clear_field: "Clear field", notify: "Notify the team", http: "Webhook / HTTP request", sheet: "Add a Google Sheet row", stop_ai: "Keep the AI agent quiet" };
export const ActionNode = memo(({ id, data, selected }) => (
  <Shell id={id} type="action" selected={selected}>
    {(data.actions || []).length === 0 && <Empty>No actions yet.</Empty>}
    {(data.actions || []).map(a => (
      <div key={a.id} style={{ background: C.surface, borderRadius: 10, padding: "7px 10px", marginTop: 6, fontSize: 12.5, color: C.text }}>
        {ACTION_LABEL[a.kind] || a.kind}
        <span style={{ color: C.textMuted }}>{a.kind === "set_field" && a.key ? ` · ${a.key}` : a.kind === "add_tag" || a.kind === "remove_tag" ? ` · ${(a.tags || []).length} tag${(a.tags || []).length === 1 ? "" : "s"}` : a.kind === "http" && a.url ? ` · ${a.method || "POST"}` : ""}</span>
      </div>
    ))}
    <Out nodeId={id} handle="next" ink="amber" muted>Next step</Out>
  </Shell>
));

const RULE_LABEL = (r) => {
  if (r.subject === "tag") return `${r.op === "not" ? "Doesn't have" : "Has"} tag ${r.key || "…"}`;
  if (r.subject === "field") return `${r.key || "field"} ${{ eq: "is", neq: "is not", contains: "contains", set: "is set", unset: "is empty", gt: ">", lt: "<" }[r.op] || r.op} ${["set", "unset"].includes(r.op) ? "" : r.value || "…"}`;
  if (r.subject === "follows") return r.op === "not" ? "Doesn't follow you" : "Follows you";
  if (r.subject === "last_text") return `Last message ${r.op === "not" ? "doesn't contain" : "contains"} ${r.value || "…"}`;
  if (r.subject === "time") return `${r.op === "not" ? "Outside" : "Between"} ${r.from ?? 9}:00–${r.to ?? 18}:00 IST`;
  return r.subject;
};
export const ConditionNode = memo(({ id, data, selected }) => (
  <Shell id={id} type="condition" selected={selected}>
    {(data.rules || []).map((r, i) => (
      <div key={r.id} style={{ fontSize: 12.5, color: C.text, marginTop: 6 }}>
        {i > 0 && <div style={{ fontSize: 10.5, color: C.textMuted, fontWeight: 700, margin: "2px 0" }}>{data.match === "any" ? "OR" : "AND"}</div>}
        <div style={{ background: C.surface, borderRadius: 10, padding: "7px 10px" }}>{RULE_LABEL(r)}</div>
      </div>
    ))}
    <Out nodeId={id} handle="yes" ink="green">Matches</Out>
    <Out nodeId={id} handle="no" ink="primary">Otherwise</Out>
  </Shell>
));

export const RandomizerNode = memo(({ id, data, selected }) => {
  const vs = data.variants || [];
  const total = vs.reduce((a, v) => a + (Number(v.weight) || 0), 0) || 1;
  return (
    <Shell id={id} type="randomizer" selected={selected}>
      {vs.map(v => <Out key={v.id} nodeId={id} handle={`v:${v.id}`} ink="purple">{v.label || "Path"} · {Math.round(((Number(v.weight) || 0) / total) * 100)}%</Out>)}
    </Shell>
  );
});

export const DelayNode = memo(({ id, data, selected }) => {
  const long = (data.unit === "days") || (data.unit === "hours" && Number(data.amount) >= 24);
  return (
    <Shell id={id} type="delay" selected={selected} warn={long ? "Over 24 h: Instagram only allows messages within 24 h of their last message." : null}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: C.text, marginTop: 2 }}>Wait {data.amount || 1} {data.unit || "hours"}</div>
      <Out nodeId={id} handle="next" ink="primary" muted>Then</Out>
    </Shell>
  );
});

export const GotoNode = memo(({ id, data, selected }) => (
  <Shell id={id} type="goto" selected={selected}>
    <div style={{ fontSize: 13, color: data.flowName ? C.text : C.textMuted }}>{data.flowName || "Pick an automation"}</div>
  </Shell>
));

export const FollowNode = memo(({ id, data, selected }) => {
  const max = Math.min(5, Math.max(1, Number(data.maxAsks) || 2));
  return (
    <Shell id={id} type="follow" selected={selected}>
      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2, lineHeight: 1.35 }}>Checks if they follow you. If not, sends:</div>
      <Bubble>{data.askText || "Please follow us first, then tap the button below."}</Bubble>
      <div style={{ padding: "7px 10px", marginTop: 6, borderRadius: 10, background: C.surface, fontSize: 12.5, fontWeight: 650, color: C.textSecondary, textAlign: "center" }}>{data.button || "I've followed"} · checks again</div>
      <Out nodeId={id} handle="yes" ink="green">Follows</Out>
      <Out nodeId={id} handle="no" ink="primary">Still not following after {max} ask{max > 1 ? "s" : ""}</Out>
    </Shell>
  );
});

export const nodeTypes = {
  trigger: TriggerNode, message: MessageNode, collect: CollectNode, ai: AiNode, action: ActionNode,
  condition: ConditionNode, randomizer: RandomizerNode, delay: DelayNode, goto: GotoNode, follow: FollowNode,
};
