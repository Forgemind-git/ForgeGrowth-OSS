import { useState, useEffect } from 'react';
import { Trash2 } from 'lucide-react';
import { useSettings } from '../hooks/useSettings.js';
import { api } from '../api.js';
import { showToast } from '../Toast.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';
import { C, FONT, MONO, T, BTN, INPUT } from '../constants.js';
import { Card, SectionHead, PageHeader, Badge, Toggle } from '../components/UI.jsx';
import { SearchableSelect } from '../components/Dropdown.jsx';

// The real notification types emit() records — mapped to friendly labels.
const NOTIF_ROWS = [
  ["dm",                "New Instagram DMs"],
  ["comment",           "New comments"],
  ["publish_published", "Publish succeeded"],
  ["publish_failed",    "Publish failed"],
  ["token",             "Token expiry / reconnect"],
  ["anomaly",           "Insight alerts (spikes & drops)"],
  ["email_digest",      "Daily email digest"],
];

// A list row carries no fill of its own — hover moves the FILL only.
const ROW = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderRadius: 12, transition: "background .14s ease" };
const hoverOn  = (e) => { e.currentTarget.style.background = C.surface; };
const hoverOff = (e) => { e.currentTarget.style.background = "transparent"; };

export default function SettingsPage({ user, notificationsOnly = false }) {
  const { data: settings, loading } = useSettings();
  const isAdmin = user?.role === "admin";
  const [prefs, setPrefs] = useState(null);

  useEffect(() => { api.getNotificationPrefs().then(setPrefs).catch(() => {}); }, []);

  const toggle = (key) => {
    if (!isAdmin) { showToast("Only admins can change notification settings.", "error"); return; }
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next); // optimistic
    api.updateNotificationPrefs({ [key]: next[key] }).catch(() => {
      setPrefs(prefs); // revert on failure
      showToast("Couldn't save preference.", "error");
    });
  };

  // Inside the main Settings (General tab) only the Notifications card is shown:
  // the Workspace card held placeholder values and the Team card listed the same
  // people as Settings → Users, so both would be duplicates there.
  if (notificationsOnly) return <NotificationsCard isAdmin={isAdmin} prefs={prefs} toggle={toggle} />;

  if (loading || !settings) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: C.textMuted, ...T.small }}>
        Loading settings…
      </div>
    );
  }

  const workspace = settings.workspace || {};

  return (
    <div>
      <PageHeader cycle="Workspace" title="General Settings" />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Card>
          <SectionHead>Workspace</SectionHead>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {[
              ["Workspace name",   workspace.name || "My Workspace", false],
              ["Workspace handle", workspace.handle || "—", true],
              ["Time zone",        workspace.timezone || "Asia/Kolkata (IST · UTC+5:30)", true],
            ].map(([k, v, mono]) => (
              <div key={k} style={ROW}>
                <span style={{ ...T.small, color: C.textSecondary }}>{k}</span>
                {/* Only id-like values (handle, time-zone id) stay in the mono face; names read in the sans. */}
                <span style={mono
                  ? { fontSize: 13.5, fontWeight: 500, color: C.text, fontFamily: MONO, textAlign: "right" }
                  : { fontSize: 15, fontWeight: 650, color: C.text, fontFamily: FONT, textAlign: "right" }}>{v}</span>
              </div>
            ))}
          </div>
        </Card>

        <NotificationsCard isAdmin={isAdmin} prefs={prefs} toggle={toggle} />

        <TeamCard isAdmin={isAdmin} currentUserId={user?.id} />
      </div>
    </div>
  );
}

function NotificationsCard({ isAdmin, prefs, toggle }) {
  return (
    <Card>
      <SectionHead right={!isAdmin ? <span style={{ ...T.label, color: C.textMuted }}>admin only</span> : null}>Notifications</SectionHead>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {NOTIF_ROWS.map(([k, label]) => {
          const v = !!(prefs && prefs[k]);
          return (
            <div key={k} style={ROW} onMouseEnter={hoverOn} onMouseLeave={hoverOff}
              title={k === "email_digest" ? "Sends a once-daily summary email" : ""}>
              <span style={{ fontSize: 14, fontWeight: 550, color: C.text }}>{label}</span>
              <Toggle size="sm" on={v} disabled={!prefs} onChange={() => prefs && toggle(k)} />
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── Team management (real users CRUD) ─────────────────────────
const AV = [C.primary, C.blue, C.green, C.pink, C.amber, C.textSecondary];
const ROLE_OPTIONS = [{ value: "admin", label: "admin" }, { value: "member", label: "member" }];
const INVITE_ROLE_OPTIONS = [
  { value: "member", label: "Member", sublabel: "Read-only analytics + inbox" },
  { value: "admin",  label: "Admin",  sublabel: "Full access" },
];

function TeamCard({ currentUserId }) {
  // People are ForgeGrowth users: the list is everyone with access to Social,
  // and it is managed in ForgeGrowth (Admin Settings → Users), not here.
  const isAdmin = false;
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inviting, setInviting] = useState(false);
  const [form, setForm] = useState({ displayName: "", email: "", password: "", role: "member" });
  const [ConfirmDialog, confirm] = useConfirm();

  const load = () => api.getUsers().then(u => { setUsers(u); setLoading(false); }).catch(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const invite = async () => {
    if (!form.email.includes("@")) { showToast("Enter a valid email.", "error"); return; }
    if (form.password.length < 8) { showToast("Password must be at least 8 characters.", "error"); return; }
    try {
      await api.createUser(form);
      showToast("Teammate added", "success");
      setForm({ displayName: "", email: "", password: "", role: "member" }); setInviting(false); load();
    } catch (e) { showToast(e.message, "error"); }
  };
  const setRole = async (u, role) => { try { await api.updateUser(u.id, { role }); load(); } catch (e) { showToast(e.message, "error"); } };
  const remove = async (u) => {
    const ok = await confirm({ title: `Remove ${u.displayName}?`, body: "They'll lose access to ForgeGrowth. Their past activity is kept.", confirmLabel: "Remove", danger: true });
    if (!ok) return;
    try { await api.deleteUser(u.id); showToast("Teammate removed", "success"); load(); } catch (e) { showToast(e.message, "error"); }
  };

  return (
    <Card>
      {ConfirmDialog}
      <SectionHead right={isAdmin && !inviting ? <button onClick={() => setInviting(true)} style={{ ...BTN.secondary, padding: "7px 14px", fontSize: 13 }}>+ Invite</button> : null}>Team</SectionHead>
      {loading ? <div style={{ ...T.small, color: C.textMuted, padding: "8px 12px" }}>Loading…</div> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {users.map((m, i) => (
            <div key={m.id} style={{ ...ROW, justifyContent: "flex-start", gap: 10 }} onMouseEnter={hoverOn} onMouseLeave={hoverOff}>
              <div style={{ width: 34, height: 34, borderRadius: "50%", background: AV[i % AV.length], color: C.onAccent, fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, flexShrink: 0 }}>{(m.displayName || m.email).charAt(0).toUpperCase()}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ ...T.h3, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.displayName}{m.id === currentUserId && <span style={{ color: C.textMuted, fontWeight: 500 }}> · you</span>}</div>
                <div style={{ fontSize: 13, fontWeight: 450, color: C.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 1 }}>{m.email}</div>
              </div>
              {isAdmin && m.id !== currentUserId ? (
                <>
                  <SearchableSelect value={m.role} onChange={(role) => role && setRole(m, role)} options={ROLE_OPTIONS} minWidth={118} />
                  <button onClick={() => remove(m)} title="Remove" style={{ ...BTN.icon, width: 32, height: 32, background: "transparent", color: C.textMuted, transition: "background .14s" }}
                    onMouseEnter={e => e.currentTarget.style.background = C.surface2} onMouseLeave={e => e.currentTarget.style.background = "transparent"}><Trash2 size={15} /></button>
                </>
              ) : <Badge label={m.role} bg={m.role === "admin" ? C.errBg : C.surface2} color={m.role === "admin" ? C.errText : C.textMuted} />}
            </div>
          ))}
        </div>
      )}
      {/* Inputs already carry the surface fill, so the invite form itself stays unfilled (a surface box would swallow them). */}
      {inviting && (
        <div style={{ marginTop: 12, padding: "12px 12px 0", display: "grid", gap: 8 }}>
          <input style={INPUT} placeholder="Full name" value={form.displayName} onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))} />
          <input style={INPUT} placeholder="Email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
          <input style={INPUT} placeholder="Temporary password (8+ chars)" type="text" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
          <SearchableSelect fullWidth value={form.role} onChange={(role) => role && setForm(f => ({ ...f, role }))} options={INVITE_ROLE_OPTIONS} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button onClick={() => setInviting(false)} style={{ ...BTN.secondary, padding: "8px 16px", fontSize: 13 }}>Cancel</button>
            <button onClick={invite} style={{ ...BTN.primary, padding: "8px 16px", fontSize: 13 }}>Add teammate</button>
          </div>
        </div>
      )}
      <div style={{ fontSize: 12.5, fontWeight: 450, color: C.textMuted, marginTop: 10, padding: "0 12px" }}>Everyone with access to Social. Add people or change access in Admin Settings → Users.</div>
    </Card>
  );
}
