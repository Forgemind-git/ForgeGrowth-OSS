import { useState } from "react";
import { MessageSquare, Check, Loader2, KeyRound, ShieldCheck, AlertTriangle, RefreshCw } from "lucide-react";
import { api } from "../api.js";
import { C, FONT, MONO, BTN, INPUT, T, LABEL } from "../constants.js";
import { showToast } from "../Toast.jsx";
import { useApi } from "../hooks/useApi.js";
import { Toggle } from "./UI.jsx";

// Settings → Integrations → Instagram: "Receive Instagram messages".
// Paste a key made for the ForgeGrowth app, then switch each Page on.
// Backend: services/metaPageLink.js
export default function InstagramDmLinkCard() {
  const { data, loading, error, refetch } = useApi(() => api.metaLink.status(), []);
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(null);
  const [replacing, setReplacing] = useState(false);

  async function run(id, fn, okMsg) {
    setBusy(id);
    try { await fn(); if (okMsg) showToast(okMsg, "success"); await refetch(); return true; }
    catch (e) { showToast(e.message, "error"); return false; }
    finally { setBusy(null); }
  }

  const showKeyForm = !data?.hasToken || data?.wrongApp || data?.tokenError || replacing;
  const spin = <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />;

  return (
    <div style={{ background: C.raised, borderRadius: 16, padding: 18, marginTop: 16, fontFamily: FONT }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 14 }}>
        <span style={{ width: 32, height: 32, borderRadius: 10, background: C.primarySoft, color: C.primary, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><MessageSquare size={16} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...T.h3, color: C.text }}>Receive Instagram messages</div>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2, lineHeight: 1.45 }}>
            Needed for ForgeGrowth to see DMs and button taps, and for Automations to reply to them.
          </div>
        </div>
        <button onClick={refetch} style={BTN.icon} title="Check again" aria-label="Check again"><RefreshCw size={14} /></button>
      </div>

      {loading && !data && <div style={{ color: C.textMuted, fontSize: 13.5, display: "flex", gap: 8, alignItems: "center" }}>{spin} Checking…</div>}
      {error && <Note tone="err">{error}</Note>}

      {data && (
        <>
          {/* ── Step 1: the key ── */}
          {data.wrongApp && <Note tone="err">The saved key was made for the “{data.tokenApp?.name}” app. Make a new key with <b>App: ForgeGrowth</b>.</Note>}
          {data.tokenError && <Note tone="err">{data.tokenError}</Note>}

          {showKeyForm ? (
            <div style={{ background: C.surface, borderRadius: 12, padding: 14, marginBottom: 14 }}>
              <div style={{ ...T.label, color: C.textSecondary, display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}><KeyRound size={13} /> Step 1 · Add the ForgeGrowth key</div>
              <ol style={{ margin: "0 0 12px 18px", padding: 0, fontSize: 13.5, color: C.text, lineHeight: 1.65 }}>
                <li>Open <a href="https://business.facebook.com/settings/system-users" target="_blank" rel="noreferrer" style={{ color: C.primary }}>Meta Business Settings → System users</a> and pick your system user.</li>
                <li>Click <b>Generate new token</b>. Set <b>App</b> to <b>the ForgeGrowth Social Meta app</b> and expiry to <b>Never</b>.</li>
                <li>Tick: pages_show_list, pages_manage_metadata, pages_read_engagement, pages_messaging, instagram_basic, instagram_manage_messages, instagram_manage_comments, business_management.</li>
                <li>Copy the key (starts with “EAA”) and paste it below.</li>
              </ol>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input value={key} onChange={e => setKey(e.target.value)} placeholder="Paste the key here" type="password" autoComplete="off"
                  style={{ ...INPUT, flex: "1 1 260px", width: "auto", fontFamily: MONO }} />
                <button disabled={!key.trim() || busy === "key"} style={BTN.primary}
                  onClick={async () => { if (await run("key", () => api.metaLink.saveToken(key.trim()), "Key saved")) { setKey(""); setReplacing(false); } }}>
                  {busy === "key" ? spin : <Check size={15} />} Save key
                </button>
                {replacing && <button style={BTN.ghost} onClick={() => { setReplacing(false); setKey(""); }}>Cancel</button>}
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14, fontSize: 13.5, color: C.textSecondary }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: C.green, fontWeight: 650 }}><Check size={15} /> ForgeGrowth key added</span>
              <span style={{ fontFamily: MONO, fontSize: 12, color: C.textMuted }}>{data.tokenPreview}</span>
              <button style={{ ...BTN.ghost, padding: "6px 10px", fontSize: 13 }} onClick={() => setReplacing(true)}>Replace</button>
            </div>
          )}

          {/* ── Step 2: switch Pages on ── */}
          {data.hasToken && !data.wrongApp && !data.tokenError && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ ...T.label, color: C.textSecondary, marginBottom: 8 }}>Step 2 · Turn on each account</div>
              {data.pages.length === 0 && <Note>No Facebook Pages found for this key. In Business Settings, give the system user access to your Pages, then press the refresh button above.</Note>}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {data.pages.map(p => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 12, background: C.surface }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 650, color: C.text }}>{p.instagram ? "@" + p.instagram.username : p.name}</div>
                      <div style={{ fontSize: 12.5, color: C.textMuted }}>
                        {p.instagram ? `Facebook Page: ${p.name}` : "No Instagram account on this Page"}
                        {p.error ? ` · ${p.error}` : ""}
                      </div>
                    </div>
                    <span style={{ fontSize: 12.5, fontWeight: 650, color: p.linked ? C.green : C.textMuted, whiteSpace: "nowrap" }}>{p.linked ? "Receiving" : "Off"}</span>
                    {busy === p.id ? spin : (
                      <Toggle on={p.linked} disabled={!p.instagram && !p.linked}
                        onChange={on => run(p.id, () => on ? api.metaLink.link(p.id) : api.metaLink.unlink(p.id), on ? `Messages turned on for ${p.instagram ? "@" + p.instagram.username : p.name}` : "Turned off")} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Step 3: app secret ── */}
          <div style={{ background: C.surface, borderRadius: 12, padding: 14 }}>
            <div style={{ ...T.label, color: C.textSecondary, display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}><ShieldCheck size={13} /> Step 3 · Security code</div>
            {data.hasSecret
              ? <div style={{ fontSize: 13.5, color: C.green, fontWeight: 650, display: "flex", alignItems: "center", gap: 6 }}><Check size={15} /> Added</div>
              : <>
                  <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 8, lineHeight: 1.45 }}>
                    So ForgeGrowth can trust messages coming from Meta. Find it in <a href={`https://developers.facebook.com/apps/${data.appId}/settings/basic/`} target="_blank" rel="noreferrer" style={{ color: C.primary }}>ForgeGrowth app → Settings → Basic</a> → <b>App secret</b> → Show.
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <input value={secret} onChange={e => setSecret(e.target.value)} placeholder="App secret" type="password" autoComplete="off"
                      style={{ ...INPUT, flex: "1 1 220px", width: "auto", fontFamily: MONO }} />
                    <button disabled={!secret.trim() || busy === "secret"} style={BTN.secondary}
                      onClick={async () => { if (await run("secret", () => api.metaLink.saveSecret(secret.trim()), "Security code saved")) setSecret(""); }}>
                      {busy === "secret" ? spin : <Check size={15} />} Save
                    </button>
                  </div>
                </>}
          </div>
        </>
      )}
    </div>
  );
}

function Note({ tone, children }) {
  const err = tone === "err";
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: 12, marginBottom: 12, fontSize: 13, lineHeight: 1.45,
      background: err ? C.errBg : C.amberSoft, color: err ? C.errText : C.amber }}>
      <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} /><div>{children}</div>
    </div>
  );
}
