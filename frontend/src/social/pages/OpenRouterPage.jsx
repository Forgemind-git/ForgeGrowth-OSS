import { useState, useEffect } from "react";
import { KeyRound, Loader2, RefreshCw, Trash2, IndianRupee, Wallet, CheckCircle2 } from "lucide-react";
import { api } from "../api.js";
import { C, FONT, MONO, BTN, INPUT, T } from "../constants.js";
import { showToast } from "../Toast.jsx";
import { useConfirm } from "../ConfirmDialog.jsx";
import { PageHeader } from "../components/UI.jsx";

// Settings → OpenRouter (admin): the API key used by OpenRouter-powered features
// (Instagram AI agents, the Automations AI Step), the account balance and key limit read live from
// OpenRouter, and what ForgeGrowth itself spent per feature — all in rupees.
// comment_analyzer: spend logged before the Comment Analyzer was removed.
const FEATURE_LABEL = { comment_analyzer: "Comment Analyzer (removed)", flow_ai_step: "Automations · AI Step", flow_ai_test: "Automations · AI Step tests" };

export default function OpenRouterTab() {
  const [st, setSt] = useState(null);
  const [sp, setSp] = useState(null);
  const [key, setKey] = useState("");
  const [rate, setRate] = useState("");
  const [busy, setBusy] = useState("");
  const [ConfirmDialog, confirm] = useConfirm();

  const load = () => Promise.all([
    api.openRouter.status().then(d => { setSt(d); setRate(d.rateOverride ? String(d.rateOverride) : ""); }),
    api.openRouter.spend().then(setSp),
  ]).catch(e => showToast(e.message, "error"));
  useEffect(() => { load(); }, []);

  async function saveKey(e) {
    e.preventDefault();
    setBusy("key");
    try { setSt(await api.openRouter.saveKey(key.trim())); setKey(""); showToast("OpenRouter connected", "success"); load(); }
    catch (err) { showToast(err.message, "error"); }
    finally { setBusy(""); }
  }
  async function removeKey() {
    if (!await confirm({ title: "Remove the OpenRouter key?", body: "Instagram AI agents and AI Steps in automations stop until a key is added again. Past results and spend history stay.", confirmLabel: "Remove", danger: true })) return;
    await api.openRouter.removeKey().catch(e => showToast(e.message, "error"));
    load();
  }
  async function saveRate() {
    setBusy("rate");
    try { setSt(await api.openRouter.setRate(rate === "" ? null : Number(rate))); showToast(rate ? "Exchange rate fixed" : "Using the live exchange rate", "success"); load(); }
    catch (err) { showToast(err.message, "error"); }
    finally { setBusy(""); }
  }

  const fx = st?.inr?.rate || sp?.inr?.rate || 0;
  const inr = (usd, d) => {
    if (usd == null) return "—";
    const v = Number(usd) * fx;
    const dec = d ?? (v === 0 ? 2 : v < 0.1 ? 4 : v < 10 ? 2 : 0);
    return "₹" + v.toLocaleString("en-IN", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  };
  const totals = (sp?.byFeature || []).reduce((a, r) => ({ calls: a.calls + r.calls, usd: a.usd + r.usd, today: a.today + r.usd_today, month: a.month + r.usd_month }), { calls: 0, usd: 0, today: 0, month: 0 });

  return (
    <div style={{ fontFamily: FONT }}>
      {ConfirmDialog}
      <PageHeader title="OpenRouter" sub="The one AI connection for ForgeGrowth Social — Instagram AI agents and the Automations AI Step. Balance and spend come from OpenRouter, shown in rupees."
        right={<button onClick={load} style={BTN.icon} title="Refresh" aria-label="Refresh"><RefreshCw size={15} /></button>} />

      {/* connection */}
      <div style={{ background: C.raised, borderRadius: 16, padding: 16, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <KeyRound size={18} color={st?.connected ? C.green : C.textMuted} />
          <div style={{ flex: "1 1 200px" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{!st ? "Loading…" : st.connected ? "Connected" : "Not connected"}</div>
            <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2 }}>
              {st?.connected ? <>Key <span style={{ fontFamily: MONO }}>{st.keyMasked}</span> · stored encrypted</> : "Create a key at openrouter.ai/keys and paste it here."}
              {st?.error && <span style={{ color: C.errText }}> · {st.error}</span>}
            </div>
          </div>
          {st?.connected && <button onClick={removeKey} style={{ ...BTN.ghost, color: C.errText }}><Trash2 size={14} /> Remove</button>}
        </div>
        <form onSubmit={saveKey} style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <input type="password" value={key} onChange={e => setKey(e.target.value)} autoComplete="off" placeholder={st?.connected ? "Paste a new key to replace it" : "sk-or-v1-…"} aria-label="OpenRouter API key"
            style={{ ...INPUT, flex: "1 1 280px", width: "auto", fontFamily: MONO, fontSize: 13 }} />
          <button type="submit" disabled={!key.trim() || busy === "key"} style={BTN.primary}>{busy === "key" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <CheckCircle2 size={14} />} {st?.connected ? "Replace key" : "Connect"}</button>
        </form>
      </div>

      {st?.connected && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(190px, 100%), 1fr))", gap: 10, marginBottom: 12 }}>
          <Kpi Icon={Wallet} label="OpenRouter balance" value={st.account ? inr(st.account.balance) : "—"} sub={st.account ? `$${st.account.balance.toFixed(2)} of $${Number(st.account.credits).toFixed(2)} credits` : "needs account access"} />
          <Kpi label="This key · this month" value={inr(st.key?.monthly)} sub={st.key?.limit != null ? `limit ${inr(st.key.limit, 0)} · ${inr(st.key.limitRemaining)} left${st.key.resetsAt ? ` · resets ${new Date(st.key.resetsAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}` : ""}` : "no limit set"} />
          <Kpi label="This key · today" value={inr(st.key?.daily)} sub={`this week ${inr(st.key?.weekly)}`} />
          <Kpi label="This key · all time" value={inr(st.key?.usage)} sub="everything billed to this key" />
        </div>
      )}

      {/* ForgeGrowth spend */}
      <div style={{ background: C.raised, borderRadius: 16, padding: 16, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, flex: 1 }}>Spent by ForgeGrowth</div>
          <span style={{ fontSize: 12.5, color: C.textMuted }}>Today <b style={{ color: C.text, fontFamily: MONO }}>{inr(totals.today)}</b> · This month <b style={{ color: C.text, fontFamily: MONO }}>{inr(totals.month)}</b> · All time <b style={{ color: C.text, fontFamily: MONO }}>{inr(totals.usd)}</b></span>
        </div>
        {!sp ? <Loader2 size={16} color={C.textMuted} style={{ animation: "spin 1s linear infinite" }} /> : sp.byFeature.length === 0
          ? <div style={{ fontSize: 13, color: C.textMuted }}>No AI calls yet.</div>
          : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
                <thead><tr>{["Feature", "Model", "Calls", "Today", "Last 7 days", "This month", "All time"].map((h, i) => <th key={h} style={{ textAlign: i > 1 ? "right" : "left", padding: "8px 10px", fontSize: 12, fontWeight: 650, color: C.textMuted }}>{h}</th>)}</tr></thead>
                <tbody>
                  {sp.byFeature.map(r => (
                    <tr key={r.feature + r.model} style={{ boxShadow: `inset 0 1px 0 ${C.surface2}` }}>
                      <td style={td}><b style={{ color: C.text }}>{FEATURE_LABEL[r.feature] || r.feature}</b></td>
                      <td style={{ ...td, fontFamily: MONO, fontSize: 12, color: C.textSecondary }}>{r.model}</td>
                      <td style={tdR}>{r.calls.toLocaleString("en-IN")}</td>
                      <td style={tdR}>{inr(r.usd_today)}</td>
                      <td style={tdR}>{inr(r.usd_7d)}</td>
                      <td style={tdR}>{inr(r.usd_month)}</td>
                      <td style={{ ...tdR, fontWeight: 700, color: C.text }}>{inr(r.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {totals.calls > 0 && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 8 }}>Average {inr(totals.usd / totals.calls, 4)} per call.</div>}
            </div>
          )}
        {sp?.daily?.length > 1 && <Daily rows={sp.daily} fx={fx} />}
      </div>

      {/* exchange rate */}
      <div style={{ background: C.raised, borderRadius: 16, padding: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <IndianRupee size={18} color={C.textMuted} />
        <div style={{ flex: "1 1 240px" }}>
          <div style={{ fontSize: 14, fontWeight: 650, color: C.text }}>Exchange rate · $1 = ₹{fx ? fx.toFixed(2) : "—"}</div>
          <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2 }}>
            {st?.inr?.source === "manual" ? "Fixed by you." : st?.inr?.source === "live" ? "Live rate, updated twice a day. OpenRouter bills in US dollars." : "Fallback rate (live rate unavailable)."} Leave empty to use the live rate.
          </div>
        </div>
        <input type="number" step="0.01" value={rate} onChange={e => setRate(e.target.value)} placeholder="Live" aria-label="Fixed rupees per dollar" style={{ ...INPUT, width: 110, fontFamily: MONO }} />
        <button onClick={saveRate} disabled={busy === "rate"} style={BTN.secondary}>Save</button>
      </div>
    </div>
  );
}

const td = { padding: "9px 10px", fontSize: 13 };
const tdR = { ...td, textAlign: "right", fontFamily: MONO, color: C.textSecondary };

function Kpi({ Icon, label, value, sub }) {
  return (
    <div style={{ background: C.raised, borderRadius: 16, padding: "14px 16px", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 650, color: C.textMuted }}>{Icon && <Icon size={13} />}{label}</div>
      <div style={{ ...T.metricSm, color: C.text, marginTop: 6 }}>{value}</div>
      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 3 }}>{sub}</div>
    </div>
  );
}
function Daily({ rows, fx }) {
  const max = Math.max(...rows.map(r => r.usd), 1e-9);
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 6 }}>Daily spend · last 30 days</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 70 }}>
        {rows.map(r => <div key={r.day} title={`${r.day}: ₹${(r.usd * fx).toFixed(2)} · ${r.calls} calls`} style={{ flex: 1, minWidth: 4, height: `${Math.max(4, r.usd * 100 / max)}%`, background: C.primary, borderRadius: 3 }} />)}
      </div>
    </div>
  );
}
