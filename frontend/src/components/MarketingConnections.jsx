// Shared ad connection panel — used on the Marketing → Campaigns page
// AND in Admin Settings → Integrations. Each panel is self-contained (owns its
// status fetch, connect modal, sync + disconnect), so it can be dropped in any
// admin-only surface without prop threading.
import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Link2, CheckCircle2, AlertTriangle, Plug } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO } from '../constants.js';
import { showError, showSuccess } from '../lib/feedback.js';
import { useConfirm } from './ConfirmDialog.jsx';
import { Button, Modal, Field, inputStyle, fmtDate } from '../pages/academy/shared.jsx';
import { Shimmer } from './charts.jsx';

// ── Meta Ads connection panel (admin-only) ──────────────────────────────────────
export function MetaAdsPanel({ onSynced }) {
  const [st, setSt] = useState(null);           // status shape from api
  const [loading, setLoading] = useState(true);
  const [connect, setConnect] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  const load = useCallback(async () => {
    try { setSt(await api.marketing.metaAds.status()); }
    catch (e) { showError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function sync() {
    setSyncing(true);
    try {
      const r = await api.marketing.metaAds.sync();
      showSuccess(`Synced ${r.campaigns} campaign(s) from ${r.accounts} ad account(s).`);
      await load(); onSynced && onSynced();
    } catch (e) { showError(e.message); }
    finally { setSyncing(false); }
  }

  async function toggleAccount(id) {
    const cur = st.adAccountIds || [];
    const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
    setSt(s => ({ ...s, adAccountIds: next }));
    try { await api.marketing.metaAds.setAccounts(next); }
    catch (e) { showError(e.message); load(); }
  }

  async function disconnect() {
    if (!(await confirm({ title: 'Disconnect Meta Ads?', body: 'The stored token and all Meta-synced campaigns will be removed. Manual campaigns are kept.', confirmLabel: 'Disconnect', danger: true }))) return;
    try { await api.marketing.metaAds.disconnect(); showSuccess('Meta Ads disconnected.'); await load(); onSynced && onSynced(); }
    catch (e) { showError(e.message); }
  }

  if (loading) return <div style={{ marginBottom: 16 }}><Shimmer height={80} radius={12} /></div>;

  const connected = st?.connected;
  const err = st?.status === 'error';
  const meta = st?.tokenMeta || {};
  const accounts = st?.availableAccounts || [];
  const chosen = st?.adAccountIds || [];
  const dataExpires = meta.dataAccessExpiresAt ? new Date(meta.dataAccessExpiresAt * 1000) : null;

  return (
    <div style={{
      marginBottom: 16, border: `1px solid ${connected ? '#CFE3FB' : err ? '#F3C9C9' : C.border}`,
      background: connected ? '#F5F9FF' : err ? '#FDF3F3' : C.cardBg, borderRadius: 12, padding: '16px 18px', boxShadow: C.shadowSm,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ width: 34, height: 34, borderRadius: 8, background: connected ? '#E7F0FE' : C.hover, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {connected ? <CheckCircle2 size={18} color="#1877F2" /> : err ? <AlertTriangle size={18} color={C.primary} /> : <Plug size={18} color={C.textSecondary} />}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, fontFamily: FONT }}>
            Meta Ads Manager {connected && <span style={{ fontSize: 11, color: '#1877F2', fontWeight: 600 }}>· Connected</span>}
          </div>
          <div style={{ fontSize: 12, color: C.textSecondary, fontFamily: MONO, marginTop: 2 }}>
            {connected
              ? <>{meta.appName || 'App'} · {st.tokenType} token{st.lastSyncedAt ? ` · synced ${fmtDate(st.lastSyncedAt)}` : ' · not synced yet'}</>
              : err ? <span style={{ color: C.primary }}>{st.lastError || 'Connection error'}</span>
              : 'Pull live campaign spend & results from your ad accounts.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {connected ? (
            <>
              <Button variant="primary" icon={RefreshCw} onClick={sync} disabled={syncing || !chosen.length}>{syncing ? 'Syncing…' : 'Sync now'}</Button>
              <Button variant="ghost" onClick={disconnect}>Disconnect</Button>
            </>
          ) : (
            <Button variant="primary" icon={Link2} onClick={() => setConnect(true)}>{err ? 'Reconnect' : 'Connect Meta Ads'}</Button>
          )}
        </div>
      </div>

      {connected && dataExpires && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: C.textMuted, fontFamily: MONO }}>
          Token data-access expires {fmtDate(dataExpires)} — regenerate a System User token before then for uninterrupted sync.
        </div>
      )}

      {connected && accounts.length > 0 && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 8 }}>Ad accounts to sync</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {accounts.map(a => {
              const on = chosen.includes(a.id);
              return (
                <button key={a.id} onClick={() => toggleAccount(a.id)} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 11px', borderRadius: 8, cursor: 'pointer',
                  border: `1px solid ${on ? '#1877F2' : C.border}`, background: on ? '#E7F0FE' : C.cardBg, fontFamily: FONT, fontSize: 12.5,
                  color: on ? '#1877F2' : C.textSecondary, fontWeight: on ? 600 : 500,
                }}>
                  <span style={{ width: 14, height: 14, borderRadius: 4, border: `1.5px solid ${on ? '#1877F2' : C.borderDark}`, background: on ? '#1877F2' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {on && <CheckCircle2 size={10} color="#fff" />}
                  </span>
                  {a.name} <span style={{ fontFamily: MONO, color: C.textMuted, fontSize: 11 }}>{a.currency} {a.amountSpent.toLocaleString('en-IN')}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {connect && <MetaConnectModal onClose={() => setConnect(false)} onConnected={async () => { setConnect(false); await load(); await sync(); }} />}
      {confirmEl}
    </div>
  );
}

function MetaConnectModal({ onClose, onConnected }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!token.trim()) return showError('Paste an access token first.');
    setBusy(true);
    try {
      const r = await api.marketing.metaAds.connect(token.trim());
      showSuccess(`Connected — ${r.availableAccounts?.length || 0} ad account(s) found. Running first sync…`);
      onConnected();
    } catch (e) { showError(e.message); setBusy(false); }
  }
  return (
    <Modal title="Connect Meta Ads Manager" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</Button></>}>
      <div style={{ fontSize: 13, color: C.textSecondary, lineHeight: 1.55, marginBottom: 14, fontFamily: FONT }}>
        Paste a Meta access token with the <b>ads_read</b> permission. Generate one from your app’s
        Marketing API → Tools, or (recommended for production) a <b>System User</b> token in Business Settings.
        The token is stored encrypted and used only to read campaign spend & results.
      </div>
      <Field label="Access token">
        <textarea style={{ ...inputStyle, minHeight: 92, resize: 'vertical', fontFamily: MONO, fontSize: 12 }}
          value={token} onChange={e => setToken(e.target.value)} placeholder="EAAG…" autoFocus />
      </Field>
    </Modal>
  );
}
