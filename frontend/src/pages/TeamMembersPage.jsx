import { useState, useEffect, useCallback } from 'react';
import { Plus, UserCog, Pencil, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO } from '../constants.js';
import { showError, showSuccess } from '../lib/feedback.js';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import MaskedNumber from '../components/MaskedNumber.jsx';
import { PageShell, Button, Table, Td, Badge, EmptyState, Modal, Field, inputStyle } from './academy/shared.jsx';
import { Shimmer } from '../components/charts.jsx';

export default function TeamMembersPage({ user }) {
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null);
  const [confirmEl, confirm] = useConfirm();

  const load = useCallback(async () => {
    try { setRows(await api.teamMembers.list()); }
    catch (e) { showError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function del(m) {
    if (m.is_chat_bda) return showError('Chat-derived members are virtual — add them as a manual member first.');
    if (!(await confirm({ title: 'Remove team member?', body: `“${m.name}” will be removed from the roster.`, confirmLabel: 'Remove', danger: true }))) return;
    try { await api.teamMembers.delete(m.id); showSuccess('Removed.'); load(); }
    catch (e) { showError(e.message); }
  }

  return (
    <PageShell
      title="Team Members"
      subtitle="The BDA roster. Every assignment, leaderboard, and response-time metric keys off this list."
      actions={<Button variant="primary" icon={Plus} onClick={() => setEdit({})}>Add Member</Button>}
    >
      {!rows ? <Shimmer height={240} radius={12} /> : (
        <Table
          columns={[{ label: 'Name' }, { label: 'Role' }, { label: 'WhatsApp Agent ID' }, { label: 'Phone' }, { label: 'Status' }, { label: '', align: 'right' }]}
          rows={rows} keyOf={m => m.id}
          empty={<EmptyState Icon={UserCog} title="No team members found" hint="Add BDAs so leads can be assigned and tracked." />}
          renderRow={(m) => (
            <>
              <Td bold>{m.name}</Td>
              <Td color={C.textSecondary}>{m.role || '—'}</Td>
              <Td mono color={C.textSecondary}>{m.whatsapp_agent_id || '—'}</Td>
              <Td>{m.phone_number ? <MaskedNumber number={m.phone_number} /> : '—'}</Td>
              <Td>
                {m.is_chat_bda ? <Badge label="From chat" color={C.purple} bg="#EEEDFE" />
                  : m.active ? <Badge label="Active" color={C.green} bg="#E1F5EE" />
                  : <Badge label="Inactive" color={C.textSecondary} bg={C.hover} />}
              </Td>
              <Td align="right">
                {!m.is_chat_bda && (
                  <span style={{ display: 'inline-flex', gap: 4 }}>
                    <button onClick={() => setEdit(m)} style={iconBtn}><Pencil size={14} /></button>
                    <button onClick={() => del(m)} style={iconBtn}><Trash2 size={14} /></button>
                  </span>
                )}
              </Td>
            </>
          )}
        />
      )}

      {edit && <MemberModal member={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
      {confirmEl}
    </PageShell>
  );
}

const iconBtn = { background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted, padding: 5, borderRadius: 6 };

function MemberModal({ member, onClose, onSaved }) {
  const isNew = !member.id;
  const [f, setF] = useState({
    name: member.name || '', role: member.role || '', whatsapp_agent_id: member.whatsapp_agent_id || '',
    phone_number: member.phone_number || '', email: member.email || '', active: member.active !== false,
  });
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));
  async function save() {
    if (!f.name.trim()) return showError('Name is required');
    setSaving(true);
    try {
      if (isNew) await api.teamMembers.create(f); else await api.teamMembers.update(member.id, f);
      showSuccess(isNew ? 'Member added.' : 'Member updated.'); onSaved();
    } catch (e) { showError(e.message); setSaving(false); }
  }
  return (
    <Modal title={isNew ? 'Add Team Member' : 'Edit Team Member'} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button></>}>
      <Field label="Name *"><input style={inputStyle} value={f.name} onChange={set('name')} autoFocus /></Field>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Role"><input style={inputStyle} value={f.role} onChange={set('role')} placeholder="e.g. Senior BDA" /></Field></div>
        <div style={{ flex: 1 }}><Field label="WhatsApp Agent ID"><input style={inputStyle} value={f.whatsapp_agent_id} onChange={set('whatsapp_agent_id')} /></Field></div>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Phone"><input style={inputStyle} value={f.phone_number} onChange={set('phone_number')} /></Field></div>
        <div style={{ flex: 1 }}><Field label="Email"><input style={inputStyle} value={f.email} onChange={set('email')} /></Field></div>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', marginTop: 4 }}>
        <input type="checkbox" checked={f.active} onChange={e => setF(s => ({ ...s, active: e.target.checked }))} style={{ width: 16, height: 16, accentColor: C.primary }} />
        <span style={{ fontSize: 13, color: C.text, fontFamily: FONT }}>Active</span>
      </label>
    </Modal>
  );
}
