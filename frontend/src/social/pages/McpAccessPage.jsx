import { useState, useEffect } from "react";
import { PlugZap, Plus, Copy, Check, Trash2, Key, Terminal, ChevronRight, X, Lock } from "lucide-react";
import { api } from "../api.js";
import { C, T, BTN, INPUT, FONT, MONO } from "../constants.js";
import { Card, Toggle, Badge, PageHeader, EmptyState, PlatformBadge } from "../components/UI.jsx";
import { useConfirm } from "../ConfirmDialog.jsx";
import { showToast } from "../Toast.jsx";

const MCP_CAPABILITIES = [
  { key: "analytics",      label: "Analytics & stats",    desc: "Overview KPIs, per-platform stats, followers trend, audience demographics, connected accounts and token health." },
  { key: "insights",       label: "Insights & decisions", desc: "Cross-platform executive scorecard, content-theme ROI, and trends/anomaly alerts for managerial decisions." },
  { key: "content",        label: "Content",              desc: "Content library posts with per-post metrics and scores, plus the media library." },
  { key: "reports",        label: "Reports & forecast",   desc: "Generate per-platform performance reports for any date range, plus a forward-looking forecast of what to post next week." },
  { key: "inbox",          label: "Inbox",                desc: "Instagram DMs and comments." },
  { key: "contacts",       label: "Contacts & tags",      desc: "CRM contacts built from DM history, notes, and the tag taxonomy." },
  { key: "engage",         label: "Reply & DM (write)",   desc: "Reply to comments and send Instagram DMs — posts on the REAL platform.", write: true },
];

const ALL_SCOPE = { scopePlatform: null, scopeAccountId: null };
const sameScope = (a, b) =>
  (a?.scopePlatform || null) === (b?.scopePlatform || null) &&
  String(a?.scopeAccountId ?? "") === String(b?.scopeAccountId ?? "");

const accountName = (a) => (a.username ? "@" + a.username : a.label);

// Account scope picker. Trigger uses the input recipe (fill, no border); open
// state is an inset accent ring, never an outline. Options live on a raised
// popover and carry no fill of their own until selected.
function ScopeSelect({ value, options, onChange, size = "md", disabled }) {
  const [open, setOpen] = useState(false);
  const sm = size === "sm";
  const locked = !!value?.scopeAccountId;
  const hit = locked && options.find(a => a.platform === value.scopePlatform && String(a.accountId) === String(value.scopeAccountId));
  const text = !locked ? "All accounts" : (hit ? accountName(hit) : "Unknown account");

  const choose = (scope) => { setOpen(false); if (!sameScope(scope, value)) onChange(scope); };

  return (
    <div style={{ position: "relative", minWidth: 0 }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        title={locked ? `Locked to ${text}` : "This key can read every connected account"}
        style={{
          ...INPUT,
          display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between",
          padding: sm ? "7px 10px" : "10px 12px",
          fontSize: sm ? 13 : 14, fontWeight: 650, textAlign: "left",
          fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
          background: locked ? C.primarySoft : C.surface,
          color: locked ? C.primary : C.text,
          boxShadow: open ? `inset 0 0 0 1.5px ${C.primary}` : "none",
        }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          {locked && <Lock size={sm ? 12 : 13} style={{ flexShrink: 0 }} />}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
        </span>
        <span style={{ fontSize: 9, opacity: 0.6, flexShrink: 0 }}>▾</span>
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 50 }} />
          <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, minWidth: "100%", width: "max-content", maxWidth: 320, background: C.raised, borderRadius: 16, boxShadow: C.shadowLg, padding: 6, zIndex: 51, maxHeight: 320, overflowY: "auto" }}>
            {[null, ...options].map(a => {
              const scope = a ? { scopePlatform: a.platform, scopeAccountId: String(a.accountId) } : ALL_SCOPE;
              const on = sameScope(scope, value);
              return (
                <div key={a ? `${a.platform}:${a.accountId}` : "__all"}
                  onClick={() => choose(scope)}
                  onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = C.surface; }}
                  onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = "transparent"; }}
                  style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 12px", borderRadius: 12, cursor: "pointer", background: on ? C.primarySoft : "transparent", fontFamily: FONT }}>
                  {a ? <PlatformBadge platform={a.platform} size="sm" /> : <Key size={14} color={C.textMuted} style={{ flexShrink: 0 }} />}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: on ? 700 : 550, color: C.text, whiteSpace: "nowrap" }}>
                      {a ? accountName(a) : "All accounts"}
                    </div>
                    <div style={{ ...T.small, fontSize: 12, color: C.textMuted, whiteSpace: "nowrap" }}>
                      {a ? a.label : "No restriction — reads every platform"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// Setting row: h3 title + small hint left, toggle right; rows separate by spacing, not hairlines.
function SettingRow({ title, hint, badge, right, style }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, padding: "15px 17px", borderRadius: 12, ...style }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ ...T.h3, color: C.text, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {title}
          {badge}
        </div>
        {hint && <div style={{ ...T.small, color: C.textSecondary, marginTop: 3 }}>{hint}</div>}
      </div>
      {right}
    </div>
  );
}

// A mono block for a key / URL: surface fill, radius 12, scrolls sideways.
const CODE = { display: "block", background: C.surface, color: C.text, fontFamily: MONO, fontSize: 12.5, borderRadius: 12, padding: "11px 14px", overflowX: "auto", whiteSpace: "nowrap", lineHeight: 1.5, minWidth: 0 };

function CopyButton({ text, tag, copied, onCopy, primary }) {
  const on = copied === tag;
  return (
    <button onClick={() => onCopy(text, tag)} style={{ ...(primary ? BTN.primary : BTN.secondary), flexShrink: 0 }}>
      {on ? <Check size={14} /> : <Copy size={14} />}
      {on ? "Copied" : "Copy"}
    </button>
  );
}

export default function McpAccessTab() {
  const [settings, setSettings] = useState(null);   // { masterEnabled, capabilities }
  const [keys, setKeys] = useState([]);
  const [install, setInstall] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newScope, setNewScope] = useState(ALL_SCOPE);
  const [accounts, setAccounts] = useState([]);
  const [creating, setCreating] = useState(false);
  const [freshKey, setFreshKey] = useState(null);   // { ...key, key } shown once
  const [copied, setCopied] = useState("");
  const [showInstall, setShowInstall] = useState(true);
  const [ConfirmDialog, confirm] = useConfirm();

  const load = async () => {
    try {
      const [s, k, inst, acc] = await Promise.all([
        api.getMcpSettings(),
        api.getMcpKeys(),
        api.getMcpInstall().catch(() => null),
        api.getMcpAccounts().catch(() => ({ accounts: [] })),
      ]);
      setSettings(s); setKeys(k); setInstall(inst);
      setAccounts(acc?.accounts || []); setLoadErr("");
    } catch (err) {
      setLoadErr(err.message || "Failed to load MCP settings");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const copy = async (text, tag) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(""), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const saveSettings = async (patch) => {
    setSaving(true);
    const prev = settings;
    setSettings(s => ({                       // optimistic
      ...s,
      ...(patch.masterEnabled !== undefined ? { masterEnabled: patch.masterEnabled } : {}),
      capabilities: { ...s.capabilities, ...(patch.capabilities || {}) },
    }));
    try {
      setSettings(await api.updateMcpSettings(patch));
    } catch (err) {
      setSettings(prev);                      // revert
      showToast(err.message || "Failed to update MCP settings", "error");
    } finally {
      setSaving(false);
    }
  };

  const createKey = async () => {
    const label = newLabel.trim();
    if (!label) { showToast("Give the key a label first", "error"); return; }
    setCreating(true);
    try {
      const k = await api.createMcpKey(label, newScope);
      setFreshKey(k);
      setNewLabel("");
      setNewScope(ALL_SCOPE);
      await load();
    } catch (err) {
      showToast(err.message || "Failed to create key", "error");
    } finally {
      setCreating(false);
    }
  };

  const toggleKey = async (k) => {
    const prev = keys;
    setKeys(ks => ks.map(x => x.id === k.id ? { ...x, isEnabled: !x.isEnabled } : x));
    try {
      await api.updateMcpKey(k.id, { isEnabled: !k.isEnabled });
    } catch (err) {
      setKeys(prev);
      showToast(err.message || "Failed to update key", "error");
    }
  };

  const setKeyScope = async (k, scope) => {
    const prev = keys;
    setKeys(ks => ks.map(x => x.id === k.id ? { ...x, ...scope } : x));
    try {
      const updated = await api.updateMcpKey(k.id, scope);
      setKeys(ks => ks.map(x => x.id === k.id ? updated : x));
      showToast(scope.scopeAccountId ? "Key locked to that account" : "Key can now read all accounts", "success");
    } catch (err) {
      setKeys(prev);
      showToast(err.message || "Failed to change the key's scope", "error");
    }
  };

  const revokeKey = async (k) => {
    const ok = await confirm({
      title: "Revoke API key",
      body: `Revoke "${k.label}"? Any MCP client using it will immediately lose access.`,
      confirmLabel: "Revoke",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteMcpKey(k.id);
      setKeys(ks => ks.filter(x => x.id !== k.id));
      showToast("Key revoked", "success");
    } catch (err) {
      showToast(err.message || "Failed to revoke key", "error");
    }
  };

  if (loading) {
    return <div style={{ padding: 40, textAlign: "center", color: C.textMuted, fontFamily: FONT, ...T.small }}>Loading…</div>;
  }
  if (loadErr || !settings) {
    return <div style={{ background: C.errBg, color: C.errText, padding: "12px 14px", borderRadius: 12, fontSize: 13, fontFamily: FONT }}>{loadErr || "Failed to load MCP settings"}</div>;
  }

  const master = settings.masterEnabled;
  const cardTitle = { ...T.h3, color: C.text, margin: "0 0 4px" };
  const cardSub = { ...T.small, color: C.textSecondary, margin: "0 0 14px" };
  // Rule: only ever show the DIRECT host. window.location.origin is the
  // CDN-fronted dashboard domain, and a connector added on that host completes
  // the OAuth handshake and then fails its first real call.
  const connectorBase = (install?.remoteUrl || "").replace(/\/api\/mcp\/http\/.*$/, "") || window.location.origin;
  const connectorUrl = freshKey ? `${connectorBase}/api/mcp/http/${freshKey.key}` : "";

  return (
    <div style={{ fontFamily: FONT }}>
      {ConfirmDialog}
      <PageHeader cycle="Settings" title="MCP Access"
        sub="Let an external AI client (Claude on web, desktop or mobile) read your ForgeGrowth data over a secure API key. All data tools read from the synced database only — they never spend the platforms' API rate budgets. Toggles apply instantly to every connected client." />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 420px", minWidth: 0, display: "flex", flexDirection: "column", gap: 18 }}>

          {/* Master switch */}
          <Card padding={4}>
            <SettingRow title={<span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><PlugZap size={17} color={C.primary} /> MCP access</span>}
              hint="Master switch. When off, every MCP request is rejected regardless of key or capability."
              right={<Toggle on={master} disabled={saving} onChange={(v) => saveSettings({ masterEnabled: v })} />} />
            {!master && (
              <div style={{ margin: "0 13px 13px", padding: "10px 12px", borderRadius: 12, background: C.errBg, color: C.errText, fontSize: 13, fontWeight: 550 }}>
                MCP access is currently disabled.
              </div>
            )}
          </Card>

          {/* Capabilities */}
          <Card padding={4} style={{ opacity: master ? 1 : 0.6, transition: "opacity .15s" }}>
            <div style={{ padding: "13px 17px 4px" }}>
              <h2 style={cardTitle}>Capabilities</h2>
              <p style={{ ...cardSub, margin: 0 }}>Fine-grained control over what an MCP client may access.</p>
            </div>
            {MCP_CAPABILITIES.map((c) => (
              <SettingRow key={c.key} title={c.label} hint={c.desc}
                badge={c.write ? <Badge label="Write" bg={C.amberSoft} color={C.amber} /> : null}
                right={<Toggle on={!!settings.capabilities[c.key]} disabled={!master || saving} onChange={(v) => saveSettings({ capabilities: { [c.key]: v } })} />} />
            ))}
          </Card>

        </div>{/* /left column */}
        <div style={{ flex: "1 1 420px", minWidth: 0, display: "flex", flexDirection: "column", gap: 18 }}>

          {/* API keys */}
          <Card>
            <h2 style={cardTitle}>API keys</h2>
            <p style={cardSub}>Bearer keys MCP clients use to authenticate. The full key is shown only once at creation.</p>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
              <input
                value={newLabel}
                onChange={e => setNewLabel(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") createKey(); }}
                placeholder="Key label (e.g. My laptop — Claude)"
                style={{ ...INPUT, flex: "1 1 200px", width: "auto" }}
              />
              <div style={{ flex: "1 1 190px", minWidth: 0 }}>
                <ScopeSelect value={newScope} options={accounts} onChange={setNewScope} />
              </div>
              <button onClick={createKey} disabled={creating} style={{ ...BTN.primary, opacity: creating ? .5 : 1, cursor: creating ? "wait" : "pointer" }}>
                <Plus size={15} /> Generate key
              </button>
            </div>
            <p style={{ ...T.small, color: C.textSecondary, margin: "0 0 16px" }}>
              {newScope.scopeAccountId
                ? "Locked to one account: every tool on this key returns only that account's data — no other account and no other platform is reachable."
                : "All accounts: this key reads every connected account. Pick one account to hand out a key that sees nothing else."}
            </p>

            {keys.length === 0 ? (
              <EmptyState Icon={Key} title="No API keys yet" body="Generate one to connect an MCP client." style={{ padding: "24px 16px" }} />
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", fontSize: 14, fontFamily: FONT, tableLayout: "auto" }}>
                  <thead>
                    <tr style={{ textAlign: "left" }}>
                      <th style={{ padding: "9px 12px" }}>Label</th>
                      <th style={{ padding: "9px 12px" }}>Key</th>
                      <th style={{ padding: "9px 12px", minWidth: 170 }}>Account scope</th>
                      <th style={{ padding: "9px 12px" }}>Last used</th>
                      <th style={{ padding: "9px 12px" }}>On</th>
                      <th style={{ padding: "9px 12px", width: 42 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map(k => (
                      <tr key={k.id}>
                        <td style={{ padding: "12px 12px", color: C.text, fontWeight: 650, lineHeight: 1.35 }}>{k.label}</td>
                        <td style={{ padding: "12px 12px", color: C.textSecondary, fontFamily: MONO, fontSize: 12.5, whiteSpace: "nowrap" }}>
                          {k.keyPrefix}…{k.keyLast4}
                        </td>
                        <td style={{ padding: "12px 12px" }}>
                          <ScopeSelect size="sm" options={accounts}
                            value={{ scopePlatform: k.scopePlatform, scopeAccountId: k.scopeAccountId }}
                            onChange={(scope) => setKeyScope(k, scope)} />
                        </td>
                        <td style={{ padding: "12px 12px", color: C.textSecondary, fontFamily: MONO, fontSize: 12.5, lineHeight: 1.4 }}>
                          {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Never"}
                        </td>
                        <td style={{ padding: "12px 12px" }}>
                          <Toggle size="sm" on={k.isEnabled} onChange={() => toggleKey(k)} />
                        </td>
                        <td style={{ padding: "12px 12px", textAlign: "right" }}>
                          <button onClick={() => revokeKey(k)} title="Revoke" aria-label="Revoke" style={{ ...BTN.icon, width: 30, height: 30, background: C.errBg, color: C.errText }}>
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Connect instructions */}
          <Card>
            <button onClick={() => setShowInstall(s => !s)} aria-expanded={showInstall}
              style={{ ...BTN.ghost, padding: "4px 0", color: C.text, gap: 8 }}>
              <Terminal size={16} color={C.textSecondary} />
              <span style={{ ...T.h3, color: C.text }}>Connect in Claude</span>
              <ChevronRight size={16} color={C.textMuted} style={{ transform: showInstall ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
            </button>

            {showInstall && (
              <div style={{ marginTop: 12 }}>
                <ol style={{ ...T.body, fontSize: 14, color: C.text, lineHeight: 1.7, paddingLeft: 18, margin: "0 0 12px" }}>
                  <li>Enable the master switch and the capabilities you want, then <b>Generate a key</b> (the popup shows a ready-to-paste URL).</li>
                  <li>Set the key's <b>Account scope</b> to lock it to a single account — a scoped connector can only ever read that one account, on that one platform. Leave it on <b>All accounts</b> for your own full-workspace key. You can re-point or unlock a key any time; it applies on the connector's next request.</li>
                  <li>In Claude (web / desktop / mobile) go to <b>Settings → Connectors → Add custom connector</b> and paste the URL below with your key in place of <span style={{ fontFamily: MONO, fontSize: 12.5 }}>&lt;YOUR_KEY&gt;</span>.</li>
                  <li>Ask Claude anything about your ForgeGrowth data — overview, top posts, comments, contacts.</li>
                </ol>
                {install?.remoteUrl && (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <code style={{ flex: 1, ...CODE }}>{install.remoteUrl}</code>
                      <CopyButton text={install.remoteUrl} tag="remoteurl" copied={copied} onCopy={copy} />
                    </div>
                    {install.note && (
                      <div style={{ ...T.small, color: C.amber, background: C.amberSoft, borderRadius: 12, padding: "10px 12px", marginTop: 10 }}>
                        Use <b>{install.directHost}</b> for connectors — not the address in your browser bar.{" "}
                        {install.proxiedHost ? <>The dashboard domain (<b>{install.proxiedHost}</b>) sits behind a CDN that drops the request Claude makes right after you authorize, so a connector added there fails with "couldn't connect".</> : null}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </Card>

        </div>{/* /right column */}
      </div>{/* /two-column wrapper */}

      {/* One-time fresh-key modal */}
      {freshKey && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.42)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300, fontFamily: FONT }}>
          <div style={{ background: C.card, borderRadius: 24, padding: 24, width: 560, maxWidth: "calc(92vw / var(--fg-zoom, 1))", boxShadow: C.shadowLg, position: "relative", animation: "fc-pop-in .2s ease-out both" }}>
            <button onClick={() => setFreshKey(null)} title="Close" aria-label="Close" style={{ ...BTN.icon, width: 32, height: 32, position: "absolute", top: 16, right: 16 }}><X size={15} /></button>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, paddingRight: 40 }}>
              <span style={{ width: 34, height: 34, borderRadius: "50%", background: C.greenSoft, color: C.green, display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Key size={16} /></span>
              <div style={{ ...T.h2, fontSize: 22, color: C.text }}>API key created</div>
            </div>
            <div style={{ ...T.small, color: C.textSecondary, marginBottom: 12 }}>
              Copy this key now — it won't be shown again.
            </div>
            {(() => {
              const a = freshKey.scopeAccountId && accounts.find(x => x.platform === freshKey.scopePlatform && String(x.accountId) === String(freshKey.scopeAccountId));
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 12px", borderRadius: 12, marginBottom: 16, background: freshKey.scopeAccountId ? C.primarySoft : C.surface }}>
                  {freshKey.scopeAccountId ? <Lock size={14} color={C.primary} style={{ flexShrink: 0 }} /> : <Key size={14} color={C.textMuted} style={{ flexShrink: 0 }} />}
                  <div style={{ ...T.small, color: freshKey.scopeAccountId ? C.primary : C.textSecondary, fontWeight: 600 }}>
                    {freshKey.scopeAccountId
                      ? `Locked to ${a ? accountName(a) : freshKey.scopeAccountId} — this key reads only that ${freshKey.scopePlatform} account.`
                      : "All accounts — this key reads every connected account on every platform."}
                  </div>
                </div>
              );
            })()}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18 }}>
              <code style={{ flex: 1, ...CODE }}>{freshKey.key}</code>
              <CopyButton text={freshKey.key} tag="fresh" copied={copied} onCopy={copy} primary />
            </div>
            <div style={{ ...T.h3, color: C.text, marginBottom: 4 }}>Connector URL</div>
            <div style={{ ...T.small, color: C.textSecondary, marginBottom: 8 }}>Paste into Claude → Settings → Connectors → Add custom connector</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 22 }}>
              <code style={{ flex: 1, ...CODE }}>{connectorUrl}</code>
              <CopyButton text={connectorUrl} tag="freshurl" copied={copied} onCopy={copy} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => setFreshKey(null)} style={BTN.primary}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
