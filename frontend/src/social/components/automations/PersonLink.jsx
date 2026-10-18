import { useState } from "react";
import { C } from "../../constants.js";
import { useConfirm } from "../../ConfirmDialog.jsx";
import ContactModal from "../ContactModal.jsx";

// The person behind an automation event. Click → the full contact profile (same
// pop-up as Contacts / Inbox); without a contact record it opens their Instagram.
export function personLabel(row) {
  if (row.username) return "@" + row.username;
  if (row.name) return row.name;
  return row.user_id ? `Instagram user ·${String(row.user_id).slice(-4)}` : "Someone";
}

export default function PersonLink({ row, isAdmin, style }) {
  const [open, setOpen] = useState(false);
  const [ConfirmDialog, confirm] = useConfirm();
  const label = personLabel(row);
  const igUrl = row.username ? `https://www.instagram.com/${row.username}/` : null;
  const clickable = !!(row.contact_id || igUrl);

  function onClick(e) {
    e.preventDefault();
    if (row.contact_id) setOpen(true);
    else if (igUrl) window.open(igUrl, "_blank", "noopener");
  }

  return (
    <>
      <button type="button" onClick={onClick} disabled={!clickable}
        title={row.contact_id ? "Open contact details" : igUrl ? "Open Instagram profile" : row.user_id ? `Instagram user id ${row.user_id}` : undefined}
        style={{ background: "none", border: 0, padding: 0, font: "inherit", fontWeight: 650, color: row.username || row.name ? C.text : C.textSecondary,
          cursor: clickable ? "pointer" : "default", textDecoration: "none", ...style }}
        onMouseEnter={e => { if (clickable) e.currentTarget.style.textDecoration = "underline"; }}
        onMouseLeave={e => { e.currentTarget.style.textDecoration = "none"; }}>
        {label}
      </button>
      {open && (
        <ContactModal
          contact={{ id: row.contact_id, accountId: row.account_id, peerId: row.user_id, username: row.username, name: row.name, profilePic: row.profile_pic, tags: [] }}
          onClose={() => setOpen(false)} onDeleted={() => setOpen(false)} isAdmin={isAdmin} confirm={confirm}
          onOpenChat={(c) => {
            try { sessionStorage.setItem("forgesocial.openIgChat", JSON.stringify({ accountId: c.accountId, peerId: c.peerId })); } catch (_) {}
            window.location.hash = "#/social/inbox";
          }} />
      )}
      {ConfirmDialog}
    </>
  );
}
