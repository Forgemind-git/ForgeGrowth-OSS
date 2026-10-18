import { useState, useRef, useEffect, useMemo } from "react";
import { Upload, Trash2, X, Image as ImageIcon } from "lucide-react";
import { api } from "../api.js";
import { useApi } from "../hooks/useApi.js";
import { C, FONT, T, BTN, INPUT, LABEL, relativeTime } from "../constants.js";
import { PageHeader, Card, Badge, EmptyState } from "../components/UI.jsx";
import { useConfirm } from "../ConfirmDialog.jsx";
import { showToast } from "../Toast.jsx";
import { MultiSelect } from "../components/Dropdown.jsx";
import { useScope } from "../components/scope/scopeStore.js";
import DefaultViewButton from "../components/scope/DefaultViewButton.jsx";
import { PLATFORMS, PLATFORM_ORDER } from "../data/mockData.js";

// ── Shared styles ────────────────────────────────────────────
// Header cells sit on a surface strip (the card is already raised, so the
// bridge's raised strip would vanish here); bridge.css rounds the strip's ends.
const th = { textAlign: "left", padding: "10px 14px", background: C.surface, whiteSpace: "nowrap" };
const td = { padding: "10px 14px", verticalAlign: "middle" };
// Counts and sizes are figures — the sans with tabular numerals, not mono.
const tdFig = { ...td, fontSize: 13.5, fontWeight: 600, color: C.textSecondary, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
const ICON_BTN = { width: 30, height: 30, borderRadius: 999, border: "none", background: "transparent", color: C.textSecondary, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0, flexShrink: 0, transition: "background .14s" };

const fmtBytes = (n) => {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + " " + u[i];
};

const FORMAT_STYLE = {
  Video: { bg: C.errBg, color: C.errText },
  Mixed: { bg: C.amberSoft, color: C.amber },
  Image: { bg: C.blueSoft, color: C.blue },
};

// ── Cover thumbnail (image or video first-frame) ─────────────
function Thumb({ item, size = 46 }) {
  const base = { width: size, height: size, borderRadius: 12, objectFit: "cover", background: C.surface2, flexShrink: 0, display: "block" };
  if (item.coverType === "video") return <video src={item.coverUrl} muted playsInline preload="metadata" style={base} />;
  if (item.coverUrl) return <img src={item.coverUrl} alt="" style={base} />;
  return <div style={{ ...base, display: "flex", alignItems: "center", justifyContent: "center", color: C.textMuted }}><ImageIcon size={18} /></div>;
}

// ── Upload modal (file picker + drag/drop + Ctrl+V paste) ────
function UploadModal({ onClose, onUploaded, accounts }) {
  const [files, setFiles] = useState([]);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);

  const addFiles = (list) => {
    const arr = Array.from(list || []).filter(f => /^(image|video)\//.test(f.type));
    if (arr.length) setFiles(prev => [...prev, ...arr]);
  };

  // Ctrl+V paste support (Forge universal pattern for file inputs)
  useEffect(() => {
    const onPaste = (e) => {
      const fl = Array.from(e.clipboardData?.files || []);
      if (fl.length) { addFiles(fl); e.preventDefault(); }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  // Object-URL previews, revoked when the file set changes
  const previews = useMemo(
    () => files.map(f => ({ url: URL.createObjectURL(f), video: f.type.startsWith("video") })),
    [files]
  );
  useEffect(() => () => previews.forEach(p => URL.revokeObjectURL(p.url)), [previews]);

  const removeAt = (i) => setFiles(prev => prev.filter((_, idx) => idx !== i));

  const submit = async () => {
    if (!files.length) { setErr("Add at least one file."); return; }
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      if (title.trim()) fd.append("title", title.trim());
      if (caption.trim()) fd.append("caption", caption.trim());
      if (accounts?.length) fd.append("accounts", JSON.stringify(accounts));
      files.forEach(f => fd.append("files", f));
      await api.uploadMedia(fd);
      showToast("Media uploaded", "success");
      onUploaded();
      onClose();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const disabled = busy || !files.length;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.42)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1500, backdropFilter: "blur(4px)" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.card, borderRadius: 24, padding: 24, width: 560, maxWidth: "94%", maxHeight: "calc(88vh / var(--fg-zoom, 1))", overflowY: "auto", boxShadow: C.shadowLg, fontFamily: FONT, boxSizing: "border-box", animation: "fc-pop-in .2s ease-out both" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div style={{ fontSize: 20, fontWeight: 780, letterSpacing: "-.02em", color: C.text }}>Upload Media</div>
          <button onClick={onClose} aria-label="Close" style={{ ...BTN.icon, width: 32, height: 32 }}><X size={16} strokeWidth={2.4} /></button>
        </div>

        {/* Dropzone: a surface fill (tints up while a file is dragged over it) — no dashed outline. */}
        <div onClick={() => inputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={e => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}
          style={{ borderRadius: 16, padding: "26px 16px", textAlign: "center", cursor: "pointer", background: over ? C.primarySoft : C.surface, marginBottom: 14, transition: "background .15s" }}>
          <div style={{ width: 40, height: 40, borderRadius: 999, background: C.primarySoft, color: C.primary, display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 10 }}>
            <Upload size={18} strokeWidth={2.2} />
          </div>
          <div style={{ fontSize: 14, fontWeight: 650, color: C.text }}>Click to choose, drag &amp; drop, or paste (Ctrl+V)</div>
          <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 4 }}>Images &amp; videos · up to 20MB each · first file is the cover</div>
          <input ref={inputRef} type="file" accept="image/*,video/*" multiple style={{ display: "none" }}
            onChange={e => { addFiles(e.target.files); e.target.value = ""; }} />
        </div>

        {previews.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 14, padding: "4px 4px 0 0" }}>
            {previews.map((p, i) => (
              <div key={i} style={{ position: "relative", width: 72, height: 72 }}>
                {p.video
                  ? <video src={p.url} muted style={{ width: 72, height: 72, borderRadius: 12, objectFit: "cover", background: C.surface2 }} />
                  : <img src={p.url} alt="" style={{ width: 72, height: 72, borderRadius: 12, objectFit: "cover" }} />}
                {i === 0 && <span style={{ position: "absolute", left: 4, top: 4, fontSize: 11.5, fontWeight: 700, letterSpacing: ".04em", background: C.primaryHover, color: C.onAccent, padding: "1px 7px", borderRadius: 999 }}>COVER</span>}
                <button onClick={() => removeAt(i)} aria-label="Remove" style={{ position: "absolute", top: -6, right: -6, width: 22, height: 22, borderRadius: 999, background: C.text, color: C.card, border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: C.shadowSm }}><X size={12} strokeWidth={2.6} /></button>
              </div>
            ))}
          </div>
        )}

        <label style={{ display: "block", marginBottom: 12 }}>
          <div style={LABEL}>Title</div>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Optional — defaults to file name" style={INPUT} />
        </label>
        <label style={{ display: "block", marginBottom: 18 }}>
          <div style={LABEL}>Caption</div>
          <textarea value={caption} onChange={e => setCaption(e.target.value)} rows={3} placeholder="Optional caption / notes" style={{ ...INPUT, resize: "vertical" }} />
        </label>

        {err && <div style={{ background: C.errBg, color: C.errText, padding: "10px 14px", borderRadius: 12, fontSize: 13.5, marginBottom: 12 }}>{err}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={BTN.secondary}>Cancel</button>
          <button onClick={submit} disabled={disabled}
            style={{ ...BTN.primary, opacity: disabled ? 0.55 : 1, cursor: disabled ? "not-allowed" : "pointer" }}>
            {busy ? "Uploading…" : `Upload${files.length ? ` (${files.length})` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// "My accounts" tokens → dropdown options (Instagram per account, other platforms as one).
function accountOptions(scope) {
  const out = [];
  for (const p of PLATFORM_ORDER) {
    const list = scope.accounts.filter(a => a.platform === p);
    if (!list.length) continue;
    if (p === "instagram") for (const a of list) out.push({ value: `instagram|${a.accountId}`, label: a.username ? `@${a.username}` : a.label, group: "Instagram" });
    else out.push({ value: p, label: list[0].label || PLATFORMS[p]?.name, group: PLATFORMS[p]?.name });
  }
  return out;
}

export default function MediaPage() {
  const { data, loading, error, refetch } = useApi(() => api.getMedia(), []);
  const [showUpload, setShowUpload] = useState(false);
  const [ConfirmDialog, confirm] = useConfirm();
  // Accounts filter — starts from the "My accounts" preset. Untagged ("Shared") assets always show.
  const scope = useScope();
  const [acc, setAcc] = useState([]);
  useEffect(() => { if (scope.loaded) setAcc(scope.tokens); }, [scope.loaded, scope.tokens.join(",")]);
  const opts = accountOptions(scope);
  const labelOf = (t) => opts.find(o => o.value === t)?.label || t;
  const tokensOf = (m) => [...new Set([...(m.accounts || []), ...(m.usedBy || [])])];
  const all = data || [];
  const media = acc.length ? all.filter(m => { const t = tokensOf(m); return !t.length || t.some(x => acc.includes(x)); }) : all;
  const hidden = all.length - media.length;
  async function setAccounts(m, list) {
    try { await api.setMediaAccounts(m.id, list); refetch(); }
    catch (e) { showToast(e.message, "error"); }
  }

  const del = async (m) => {
    const ok = await confirm({ title: "Delete media?", body: `"${m.title}" and its ${m.fileCount} file(s) will be permanently removed.`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try { await api.deleteMedia(m.id); showToast("Media deleted", "success"); refetch(); }
    catch (e) { showToast(e.message, "error"); }
  };

  return (
    <div>
      {ConfirmDialog}
      <PageHeader cycle="Asset Library" title="Media"
        right={<div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <DefaultViewButton tokens={acc} />
          <MultiSelect label="Accounts" values={acc} options={opts} onChange={setAcc} placeholder="All" />
          <button onClick={() => setShowUpload(true)} style={BTN.primary}><Upload size={15} strokeWidth={2.2} /> Upload Media</button>
        </div>} />
      {hidden > 0 && <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 10 }}>{hidden} asset{hidden === 1 ? " belongs" : "s belong"} to other accounts and {hidden === 1 ? "is" : "are"} hidden. Shared assets (no account) always show.</div>}

      {error && <div style={{ background: C.errBg, color: C.errText, padding: '12px 14px', borderRadius: 12, fontSize: 13.5, marginBottom: 16 }}>{error}</div>}

      {loading && !data ? (
        <Card><div style={{ color: C.textMuted, fontSize: 14, padding: 20 }}>Loading…</div></Card>
      ) : media.length === 0 ? (
        <Card>
          <EmptyState Icon={ImageIcon} title="No media yet" body="Upload images or videos to build your media library."
            action={<button onClick={() => setShowUpload(true)} style={BTN.primary}><Upload size={15} strokeWidth={2.2} /> Upload Media</button>} />
        </Card>
      ) : (
        <Card padding={8}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", fontFamily: FONT }}>
              <thead>
                <tr>
                  {["Cover", "Title", "Accounts", "Files", "Size", "Format", "Uploaded by", "Added", ""].map((h, i) => (
                    <th key={i} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {media.map(m => {
                  const fs = FORMAT_STYLE[m.format] || FORMAT_STYLE.Image;
                  return (
                    <tr key={m.id} className="table-row">
                      <td style={td}><Thumb item={m} /></td>
                      <td style={{ ...td, maxWidth: 300 }}>
                        <div style={{ fontWeight: 650, color: C.text, fontSize: 14, letterSpacing: "-.01em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 280 }}>{m.title}</div>
                        {m.caption && <div style={{ fontSize: 12.5, color: C.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 280, marginTop: 2 }}>{m.caption}</div>}
                      </td>
                      <td style={{ ...td, minWidth: 170 }}>
                        <MultiSelect values={m.accounts || []} options={opts} onChange={(v) => setAccounts(m, v)} minWidth={150}
                          placeholder={(m.usedBy || []).length ? (m.usedBy || []).map(labelOf).join(", ") : "Shared"} />
                        {(m.usedBy || []).filter(t => !(m.accounts || []).includes(t)).length > 0 && (m.accounts || []).length > 0 && (
                          <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 3 }}>Also posted to {(m.usedBy || []).filter(t => !(m.accounts || []).includes(t)).map(labelOf).join(", ")}</div>
                        )}
                      </td>
                      <td style={tdFig}>{m.fileCount}</td>
                      <td style={tdFig}>{fmtBytes(m.totalSize)}</td>
                      <td style={td}><Badge label={m.format} bg={fs.bg} color={fs.color} /></td>
                      <td style={{ ...td, fontSize: 13.5, color: C.textSecondary, whiteSpace: "nowrap" }}>{m.uploadedBy || "—"}</td>
                      <td style={{ ...td, fontSize: 13, color: C.textMuted, whiteSpace: "nowrap" }}>{relativeTime(m.createdAt)}</td>
                      <td style={{ ...td, textAlign: "right" }}>
                        <button onClick={() => del(m)} title="Delete" aria-label="Delete"
                          style={ICON_BTN}
                          onMouseEnter={e => e.currentTarget.style.background = C.errBg}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {showUpload && <UploadModal accounts={acc} onClose={() => setShowUpload(false)} onUploaded={refetch} />}
    </div>
  );
}
