import { useEffect, useRef } from "react";
import { Play, Pause, SkipBack, SkipForward, User, Zap, Flag, Hourglass } from "lucide-react";
import { C, FONT, BTN, MONO } from "../../constants.js";

// Player for the automation simulators (Flow Builder + Quick Automations), driven by useFlowSimulator.
// Back · Play/Pause · Next + speed. Back/Next walk the recorded steps; Next also runs the step waiting to go.
const SPEEDS = [0.5, 1, 2, 4];
export function PlayerBar({ sim, onDemo }) {
  const ib = (on) => ({ ...BTN.icon, width: 32, height: 32, opacity: on ? 1 : .4, cursor: on ? "pointer" : "default" });
  const rewound = sim.cursor < sim.timeline.length - 1 && !sim.playing;
  const status = rewound ? "Rewound · ▶ replays, ⏭ steps forward"
    : sim.waiting === "input" ? "Waiting for their answer"
    : sim.waiting === "reply" ? "Waiting for them to tap or reply"
    : sim.waiting === "follows" ? "Answer: do they follow?"
    : sim.pendingNode && !sim.playing ? "Paused · next step ready"
    : sim.playing && (sim.pendingNode || sim.activeNode) ? "Playing"
    : sim.timeline.length ? "Waiting for the follower" : "Ready";
  return (
    <div style={{ margin: "0 12px 10px", background: C.raised, borderRadius: 12, padding: "8px 10px", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <button type="button" onClick={sim.back} disabled={!sim.canBack} title="Previous step" aria-label="Previous step" style={ib(sim.canBack)}><SkipBack size={14} /></button>
      {sim.playing && sim.timeline.length
        ? <button type="button" onClick={sim.pause} title="Pause" aria-label="Pause" style={{ ...BTN.icon, width: 36, height: 36, background: C.primary, color: C.onAccent }}><Pause size={15} /></button>
        : <button type="button" onClick={() => (!sim.timeline.length && onDemo ? onDemo() : sim.play())} title={!sim.timeline.length && onDemo ? "Play the trigger for me" : "Play"} aria-label="Play" style={{ ...BTN.icon, width: 36, height: 36, background: C.primary, color: C.onAccent }}><Play size={15} /></button>}
      <button type="button" onClick={sim.next} disabled={!sim.canNext} title="Next step" aria-label="Next step" style={ib(sim.canNext)}><SkipForward size={14} /></button>
      <div style={{ display: "flex", gap: 2, marginLeft: 4, background: C.surface, borderRadius: 8, padding: 2 }}>
        {SPEEDS.map(x => (
          <button key={x} type="button" onClick={() => sim.setSpeed(x)} aria-label={`${x}x speed`} title={`${x}× speed`}
            style={{ border: "none", cursor: "pointer", padding: "4px 7px", borderRadius: 6, fontSize: 11.5, fontWeight: 700, fontFamily: MONO, background: sim.speed === x ? C.card : "transparent", color: sim.speed === x ? C.text : C.textMuted }}>{x}×</button>
        ))}
      </div>
      <div style={{ width: "100%", fontSize: 11.5, color: C.textMuted, display: "flex", justifyContent: "space-between", marginTop: 2 }}>
        <span>{status}</span>
        <span style={{ fontFamily: MONO }}>{sim.timeline.length ? `Step ${sim.cursor + 1} / ${sim.timeline.length}` : ""}</span>
      </div>
    </div>
  );
}

// Every executed step and follower action, in order. Click one to go back to that moment.
// `side` = it sits in its own column beside the phone: it fills that column's
// height, scrolls inside itself (never the page), and shows a hint while empty so
// the layout doesn't jump when the first step lands.
export function Timeline({ sim, side = false }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.querySelector('[data-on="1"]')?.scrollIntoView({ block: "nearest" }); }, [sim.cursor]);
  if (!sim.timeline.length && !side) return null;
  const Icon = (k) => k === "you" ? User : k === "end" ? Flag : k === "wait" ? Hourglass : Zap;
  return (
    <div style={side ? { display: "flex", flexDirection: "column", minHeight: 0, flex: 1 } : { marginTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 650, color: C.textMuted, marginBottom: 6, flexShrink: 0 }}>What happened{sim.timeline.length ? " · click a step to go back to it" : ""}</div>
      {side && !sim.timeline.length && (
        <div style={{ background: C.raised, borderRadius: 12, padding: "14px 12px", fontSize: 12.5, color: C.textMuted, lineHeight: 1.45 }}>Each step shows up here as the test runs.</div>
      )}
      {sim.timeline.length > 0 && <div ref={ref} style={{ ...(side ? { flex: 1, minHeight: 0 } : { maxHeight: 220 }), overflowY: "auto", display: "flex", flexDirection: "column", gap: 2, background: C.raised, borderRadius: 12, padding: 6 }}>
        {sim.timeline.map((t, i) => {
          const on = i === sim.cursor, future = i > sim.cursor;
          const I = Icon(t.kind);
          return (
            <button key={i} type="button" data-on={on ? "1" : "0"} onClick={() => sim.jump(i)}
              style={{ display: "flex", alignItems: "flex-start", gap: 7, width: "100%", textAlign: "left", border: "none", cursor: "pointer", padding: "6px 8px", borderRadius: 8, fontFamily: FONT, fontSize: 12, lineHeight: 1.35,
                background: on ? C.primarySoft : "transparent", color: on ? C.primary : future ? C.textMuted : C.text, opacity: future ? .6 : 1 }}>
              <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.textMuted, minWidth: 16, marginTop: 1 }}>{i + 1}</span>
              <I size={12} style={{ flexShrink: 0, marginTop: 2, color: t.kind === "you" ? C.blue : t.kind === "end" ? C.textMuted : C.green }} />
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{t.label}</span>
            </button>
          );
        })}
        {sim.pendingNode && !sim.playing && (
          <div style={{ fontSize: 11.5, color: C.textMuted, padding: "6px 8px" }}>Next step is ready. Press ▶ or ⏭.</div>
        )}
      </div>}
    </div>
  );
}
