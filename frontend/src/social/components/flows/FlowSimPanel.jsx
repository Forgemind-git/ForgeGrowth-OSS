import { useState, useEffect, useCallback, useRef } from "react";
import { X, RotateCcw, Play, Eye } from "lucide-react";
import { C, FONT, BTN, INPUT } from "../../constants.js";
import { PillTabs } from "../UI.jsx";
import PhonePreview, { PREVIEW_VIEWS } from "../automations/PhonePreview.jsx";
import useFlowSimulator from "./useFlowSimulator.js";
import { PlayerBar, Timeline } from "./SimPlayer.jsx";

// Preview + "Test it" for a Flow Builder automation, in the same Instagram phone
// mock as Quick Automations. Preview plays the trigger for you (with its first
// keyword); Test it lets you act as a follower: comment, DM, tap buttons, answer
// questions. The step running now is highlighted on the canvas. Nothing is sent.
export default function FlowSimPanel({ graph, account, posts, tagName, flowName, flows = [], onNode, onClose }) {
  const trig = (graph.nodes.find(n => n.type === "trigger")?.data?.triggers || [])[0] || null;
  const kind = trig?.kind || null;
  const [mode, setMode] = useState("preview");
  const [view, setView] = useState(kind === "comment" ? "comments" : "dm");
  const [persona, setPersona] = useState("test_user");
  const openDm = useCallback(() => setView("dm"), []);
  const sim = useFlowSimulator(graph, { account, tagName, flowName, onOpenDm: openDm, onNode, flows, persona: { username: persona, name: persona.replace(/[_.]/g, " ") } });

  const post = kind === "comment"
    ? (trig.postMode === "one" ? posts.find(p => p.id === trig.mediaId) || null : { any: true })
    : null;
  const keyword = trig?.anyWord ? "" : (trig?.keywords?.[0] || "");

  // Preview = play the trigger automatically; Test it = a clean slate you drive.
  const autoplay = useRef(null);
  function restart(m = mode) {
    clearTimeout(autoplay.current);
    sim.reset();
    setView(kind === "comment" ? "comments" : "dm");
    if (m !== "preview" || !kind) return;
    autoplay.current = setTimeout(playTrigger, 250);
  }
  // Act out the trigger with its first keyword (Preview, or ▶ on an empty Test it run).
  function playTrigger() {
    if (kind === "comment") sim.comment(keyword || "Interested");
    else if (kind === "story_mention") sim.storyMention();
    else if (kind === "called") sim.startCalled();
    else sim.send(keyword || "Hi");
  }
  useEffect(() => { restart(mode); return () => clearTimeout(autoplay.current); }, [mode, kind]);
  useEffect(() => () => onNode?.(null), []);

  const views = kind === "comment" ? PREVIEW_VIEWS : PREVIEW_VIEWS.filter(v => v.id === "dm");
  const fields = Object.entries(sim.vars || {}).filter(([k, v]) => !k.startsWith("_") && v != null && v !== "");
  const tags = sim.vars?._tags || [];
  // Test it: "What happened" + the test follower go in a column BESIDE the phone
  // (the panel widens) instead of under it, so they never push the phone away.
  const wide = !!kind && mode === "test";
  const follower = (
      <div style={{ marginTop: wide ? 0 : 14, flexShrink: 0, background: C.raised, borderRadius: 12, padding: "10px 12px" }}>
        <div style={{ fontSize: 12, fontWeight: 650, color: C.textMuted, marginBottom: 6 }}>Test follower</div>
        <input value={persona} onChange={e => setPersona(e.target.value.replace(/[^a-z0-9_.]/gi, "").slice(0, 30) || "test_user")} aria-label="Test username"
          style={{ ...INPUT, padding: "6px 10px", fontSize: 13 }} />
        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 8 }}>
          <b style={{ color: C.text }}>Tags:</b> {tags.length ? tags.map(tagName).join(", ") : "none"}
        </div>
        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4, overflowWrap: "anywhere" }}>
          <b style={{ color: C.text }}>Fields:</b> {fields.length ? fields.map(([k, v]) => `{${k}} = ${v}`).join(" · ") : "none yet"}
        </div>
        <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 6, lineHeight: 1.4 }}>Only in this test — the real contact isn't changed.</div>
      </div>
  );

  return (
    <div style={{ width: wide ? 600 : 340, transition: "width .2s", height: "100%", background: "var(--fs-node-bg)", borderRadius: 16, boxShadow: "0 0 0 1px var(--fs-node-ring), var(--fs-node-shadow)", display: "flex", flexDirection: "column", fontFamily: FONT, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 12px 8px" }}>
        <PillTabs size="sm" value={mode} onChange={setMode} tabs={[{ id: "preview", label: "Preview", Icon: Eye }, { id: "test", label: "Test it", Icon: Play }]} />
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => restart()} title="Start over" aria-label="Start over" style={{ ...BTN.icon, width: 30, height: 30 }}><RotateCcw size={14} /></button>
        <button type="button" onClick={onClose} title="Close" aria-label="Close preview" style={{ ...BTN.icon, width: 30, height: 30 }}><X size={14} /></button>
      </div>
      {kind && <PlayerBar sim={sim} onDemo={playTrigger} />}
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 12, padding: "0 12px 14px" }}>
      <div style={{ width: wide ? 316 : "100%", flexShrink: 0, overflowY: "auto", minHeight: 0 }}>
        {!kind ? (
          <div style={{ fontSize: 13, color: C.textMuted, padding: "30px 10px", textAlign: "center", lineHeight: 1.5 }}>Add a trigger first: click the “When…” step.</div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: C.textMuted, textAlign: "center", lineHeight: 1.4, marginBottom: 10 }}>
              {mode === "preview"
                ? `Plays the start for you${keyword ? ` with “${keyword}”` : ""}. Tap the buttons in the DM to follow a path.`
                : kind === "comment" ? "Comment like a follower would, then tap the buttons in the DM."
                  : kind === "story_mention" ? "Tap “Mention in story” to start."
                  : kind === "called" ? "Press ▶ to start it the way another automation would."
                  : "Send a DM like a follower would."}
              {" "}Nothing is sent.
            </div>
            {sim.inFlow && <div style={{ fontSize: 12, fontWeight: 650, color: C.blue, textAlign: "center", marginBottom: 8 }}>Now running “{sim.inFlow}”</div>}
            <PhonePreview view={view} onView={setView} views={views} account={account} post={post}
              keyword={keyword} replyText={trig?.replyTexts?.[0] || ""} steps={sim.dm} sim={{ ...sim, trigger: kind }} />
            {!wide && <Timeline sim={sim} />}
            {!wide && follower}
          </>
        )}
      </div>
      {wide && (
        <div data-testid="sim-side" style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          <Timeline sim={sim} side />
          {follower}
        </div>
      )}
      </div>
    </div>
  );
}

