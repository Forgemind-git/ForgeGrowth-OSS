import { Plus, Trash2, Link2, MousePointerClick } from "lucide-react";
import { C, FONT, INPUT, BTN } from "../../constants.js";
import { PillTabs } from "../UI.jsx";
import { DM_KINDS, Field } from "./shared.jsx";

// DM editor (text / buttons / card / quick replies) + a compact chat preview.
// Meta limits: button titles 20 chars, max 3 buttons, max 13 quick replies,
// button-template text 640 chars.

const MAX_BUTTONS = 3, MAX_QUICK = 13;

export default function MessageBuilder({ dm, onChange, disabled }) {
  const set = (patch) => onChange({ ...dm, ...patch });
  const setBtn = (i, patch) => set({ buttons: dm.buttons.map((b, j) => j === i ? { ...b, ...patch } : b) });
  const setQuick = (i, patch) => set({ quick: dm.quick.map((q, j) => j === i ? { ...q, ...patch } : q) });

  return (
    <div>
      <div style={{ overflowX: "auto", marginBottom: 14 }}>
        <PillTabs tabs={DM_KINDS} value={dm.kind} size="sm" onChange={(k) => !disabled && set({ kind: k,
          // Picking "Text + link" with no buttons yet starts one link button.
          buttons: k === "buttons" && !dm.buttons.length ? [{ type: "web_url", title: "", url: "", payload: "" }] : dm.buttons })} />
      </div>

      {dm.kind !== "card" && (
        <Field>
          <textarea value={dm.text} disabled={disabled} rows={6} maxLength={dm.kind === "buttons" ? 640 : 1000}
            onChange={e => set({ text: e.target.value })} placeholder="Hi! Here are the details you asked for…"
            style={{ ...INPUT, resize: "vertical", lineHeight: 1.45 }} />
          <div style={{ textAlign: "right", fontSize: 11.5, color: C.textMuted, marginTop: 3, fontVariantNumeric: "tabular-nums" }}>{(dm.text || "").length} / {dm.kind === "buttons" ? 640 : 1000}</div>
        </Field>
      )}

      {dm.kind === "card" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))", gap: "0 12px" }}>
          <Field label="Title"><input value={dm.card.title} disabled={disabled} maxLength={80} onChange={e => set({ card: { ...dm.card, title: e.target.value } })} style={INPUT} placeholder="Acme 3D Printing" /></Field>
          <Field label="Subtitle"><input value={dm.card.subtitle} disabled={disabled} maxLength={80} onChange={e => set({ card: { ...dm.card, subtitle: e.target.value } })} style={INPUT} placeholder="Custom prints, models, prototypes" /></Field>
          <Field label="Image URL" hint="A public https image, ideally 1.91:1."><input value={dm.card.image_url} disabled={disabled} onChange={e => set({ card: { ...dm.card, image_url: e.target.value } })} style={INPUT} placeholder="https://…" /></Field>
          <Field label="Opens when tapped"><input value={dm.card.url} disabled={disabled} onChange={e => set({ card: { ...dm.card, url: e.target.value } })} style={INPUT} placeholder="https://…" /></Field>
        </div>
      )}

      {(dm.kind === "buttons" || dm.kind === "card") && (
        <Field label="Buttons">
          {dm.buttons.map((b, i) => (
            <div key={i} style={{ background: C.surface, borderRadius: 12, padding: 10, marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <input value={b.title} disabled={disabled} maxLength={20} onChange={e => setBtn(i, { title: e.target.value })} placeholder="Button text, e.g. Claude course" style={{ ...INPUT, background: C.raised, flex: 1, width: "auto", fontWeight: 600 }} />
                {!disabled && <button type="button" onClick={() => set({ buttons: dm.buttons.filter((_, j) => j !== i) })} style={BTN.icon} aria-label="Remove button"><Trash2 size={14} /></button>}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <PillTabs size="sm" value={b.type} onChange={(t) => !disabled && setBtn(i, { type: t })}
                  tabs={[{ id: "web_url", label: "Link", Icon: Link2 }, { id: "postback", label: "Reply", Icon: MousePointerClick }]} />
                {b.type === "web_url"
                  ? <input value={b.url} disabled={disabled} onChange={e => setBtn(i, { url: e.target.value.trim() })} placeholder="https://…" style={{ ...INPUT, background: C.raised, flex: "1 1 180px", width: "auto" }} />
                  : <input value={b.payload} disabled={disabled} onChange={e => setBtn(i, { payload: e.target.value.toUpperCase().replace(/\s+/g, "_") })} placeholder="CODE e.g. QUOTE" style={{ ...INPUT, background: C.raised, flex: "1 1 180px", width: "auto", fontFamily: "monospace" }} />}
              </div>
            </div>
          ))}
          {!disabled && dm.buttons.length < MAX_BUTTONS && (
            <button type="button" onClick={() => set({ buttons: [...dm.buttons, { type: "web_url", title: "", url: "", payload: "" }] })} style={BTN.secondary}><Plus size={14} /> Add a button</button>
          )}
        </Field>
      )}

      {dm.kind === "quick" && (
        <Field label={`Quick replies (max ${MAX_QUICK})`} hint="Tappable chips under the message. Each sends its code back for a “Button tap” automation.">
          {dm.quick.map((q, i) => (
            <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
              <input value={q.title} disabled={disabled} maxLength={20} onChange={e => setQuick(i, { title: e.target.value })} placeholder="Chip text" style={{ ...INPUT, flex: "1 1 130px", width: "auto" }} />
              <input value={q.payload} disabled={disabled} onChange={e => setQuick(i, { payload: e.target.value.toUpperCase().replace(/\s+/g, "_") })} placeholder="CODE" style={{ ...INPUT, flex: "1 1 130px", width: "auto", fontFamily: "monospace" }} />
              {!disabled && <button type="button" onClick={() => set({ quick: dm.quick.filter((_, j) => j !== i) })} style={BTN.icon} aria-label="Remove quick reply"><Trash2 size={14} /></button>}
            </div>
          ))}
          {!disabled && dm.quick.length < MAX_QUICK && (
            <button type="button" onClick={() => set({ quick: [...dm.quick, { title: "", payload: "" }] })} style={BTN.secondary}><Plus size={14} /> Add quick reply</button>
          )}
        </Field>
      )}
    </div>
  );
}

// Instagram-style chat preview of what the person receives.
export function DmPreview({ account, steps }) {
  return (
    <div style={{ background: C.surface, borderRadius: 20, padding: 14, fontFamily: FONT }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 12 }}>
        <span style={{ width: 28, height: 28, borderRadius: "50%", background: C.primary, color: C.onAccent, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 750 }}>
          {(account || "?").slice(0, 1).toUpperCase()}
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>{account ? "@" + account : "Your account"}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {steps.length === 0 && <div style={{ fontSize: 13, color: C.textMuted, padding: "16px 4px" }}>Nothing will be sent yet. Add a message below.</div>}
        {steps.map((s, i) => s.from === "them"
          ? <div key={i} style={{ alignSelf: "flex-end", maxWidth: "80%", background: C.primary, color: C.onAccent, borderRadius: 18, padding: "8px 12px", fontSize: 13.5, lineHeight: 1.4 }}>{s.text}</div>
          : s.note
            ? <div key={i} style={{ alignSelf: "center", fontSize: 11.5, color: C.textMuted, textAlign: "center", padding: "2px 8px" }}>{s.note}</div>
            : <Bubble key={i} m={s.message} />)}
      </div>
    </div>
  );
}

function Bubble({ m }) {
  if (!m) return null;
  const p = m.attachment?.payload;
  const bubble = { alignSelf: "flex-start", maxWidth: "85%", background: C.raised, color: C.text, borderRadius: 18, overflow: "hidden", fontSize: 13.5, lineHeight: 1.4 };
  const btnRow = (b, i) => <div key={i} style={{ padding: "9px 12px", textAlign: "center", fontWeight: 650, color: C.blue, background: C.surface2, marginTop: 2 }}>{b.title || "Button"}</div>;
  if (p?.template_type === "button") return <div style={bubble}><div style={{ padding: "9px 12px", whiteSpace: "pre-wrap" }}>{p.text}</div>{p.buttons.map(btnRow)}</div>;
  if (p?.template_type === "generic") {
    const e = p.elements[0] || {};
    return (
      <div style={{ ...bubble, width: 230 }}>
        {e.image_url ? <img src={e.image_url} alt="" style={{ width: "100%", height: 120, objectFit: "cover", display: "block" }} onError={ev => { ev.currentTarget.style.display = "none"; }} />
          : <div style={{ height: 90, background: C.surface2 }} />}
        <div style={{ padding: "9px 12px" }}><div style={{ fontWeight: 700 }}>{e.title}</div>{e.subtitle && <div style={{ color: C.textMuted, fontSize: 12.5 }}>{e.subtitle}</div>}</div>
        {(e.buttons || []).map(btnRow)}
      </div>
    );
  }
  return (
    <div style={{ alignSelf: "flex-start", maxWidth: "85%" }}>
      <div style={{ ...bubble, maxWidth: "100%", padding: "9px 12px", whiteSpace: "pre-wrap" }}>{m.text}</div>
      {m.quick_replies?.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {m.quick_replies.map((q, i) => <span key={i} style={{ padding: "6px 12px", borderRadius: 999, background: C.raised, color: C.blue, fontSize: 12.5, fontWeight: 650 }}>{q.title}</span>)}
        </div>
      )}
    </div>
  );
}
