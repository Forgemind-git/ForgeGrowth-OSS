import { useState } from "react";
import { Bookmark, BookmarkCheck, Loader2, Layers } from "lucide-react";
import { C, BTN } from "../../constants.js";
import { showToast } from "../../Toast.jsx";
import { useScope, saveScope } from "./scopeStore.js";

// In-page shortcut to the "My accounts" preset (same one as the top-bar button):
// shows "Default view" when the page's current accounts match the saved preset,
// otherwise offers to save them as the default for every page.
export default function DefaultViewButton({ tokens }) {
  const scope = useScope();
  const [busy, setBusy] = useState(false);
  if (!scope.loaded) return null;
  const same = [...tokens].sort().join(",") === [...scope.tokens].sort().join(",");

  async function save() {
    setBusy(true);
    try { await saveScope(tokens); showToast(tokens.length ? "Saved as your default accounts — every page opens with them" : "Default cleared — pages show all accounts", "success"); }
    catch (e) { showToast(e.message, "error"); }
    finally { setBusy(false); }
  }

  const openPicker = () => window.dispatchEvent(new Event("fs:open-scope"));
  if (same && scope.active) {
    return (
      <span title="Every page opens with these accounts" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, fontWeight: 650, color: C.green, padding: "0 4px", whiteSpace: "nowrap" }}>
        <BookmarkCheck size={14} /> Default view
        <button onClick={openPicker} style={{ ...BTN.ghost, padding: "4px 8px", fontSize: 12.5 }}>Change</button>
      </span>
    );
  }
  // Nothing picked and no preset yet: offer to set one (opens the My accounts picker).
  if (same) {
    return (
      <button onClick={openPicker} title="Choose the accounts every page opens with"
        style={{ ...BTN.ghost, padding: "7px 10px", fontSize: 13, color: C.primary, whiteSpace: "nowrap" }}>
        <Layers size={14} /> Set default accounts
      </button>
    );
  }
  return (
    <button onClick={save} disabled={busy} title="Open every page with these accounts (same as My accounts in the top bar)"
      style={{ ...BTN.ghost, padding: "7px 10px", fontSize: 13, color: C.primary, whiteSpace: "nowrap" }}>
      {busy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Bookmark size={14} />} {tokens.length ? "Save as default" : "Clear default"}
    </button>
  );
}
