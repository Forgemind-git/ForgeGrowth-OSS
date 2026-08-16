import { useState, useEffect, useMemo } from 'react';
import { notify, showError, showSuccess } from '../lib/feedback.js';
import {
  Settings, Users, Tag, FolderOpen, LayoutList,
  LogOut, Trash2, Moon, Sun, Monitor,
  ArrowLeft, Plus, X, ChevronLeft, Eye, EyeOff, Phone, Mail, MapPin, BadgeCheck, User,
  Loader2, MessageSquare, Star, Key, Webhook, RefreshCw, Search, Play, AlertCircle, CheckCircle2,
  Bot, Copy, Check, Plug, Globe, Calendar as CalendarIcon, FileSpreadsheet, Link2, Unplug,
  ChevronRight, ExternalLink, Sheet, Table2, Inbox, PlugZap, Terminal,
  IndianRupee, CreditCard, Link as LinkIcon, SlidersHorizontal,
  ChevronDown, Wrench, ShieldAlert, Package, Download, Shield,
} from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO, maskPhone } from '../constants.js';
import MaskedNumber from '../components/MaskedNumber.jsx';
import { useTheme } from '../theme.jsx';
import DeleteConfirmModal from '../components/DeleteConfirmModal.jsx';
import SearchableSelect from '../components/SearchableSelect.jsx';
import { useTableSelection, SelectAllCheckbox, RowCheckbox, BulkDeleteButton, runBulkDelete } from '../components/TableSelection.jsx';
import { MetaAdsPanel } from '../components/MarketingConnections.jsx';
import { FunnelSettingsContent } from './sales/FunnelSettingsPage.jsx';
import EntityFieldsManager from '../components/EntityFieldsManager.jsx';

const TABS = [
  { key: 'general', label: 'General', icon: Settings },
  { key: 'tags', label: 'Tags', icon: Tag },
  { key: 'category', label: 'Category', icon: FolderOpen },
  { key: 'fields', label: 'Fields', icon: LayoutList },
  { key: 'funnel', label: 'Funnel', icon: SlidersHorizontal },
  { key: 'whatsapp-accounts', label: 'WhatsApp Accounts', icon: MessageSquare },
  { key: 'ai-models', label: 'AI Models', icon: Bot },
  { key: 'integrations', label: 'Integrations', icon: Plug },
  { key: 'mcp', label: 'MCP Tools', icon: PlugZap },
  { key: 'users', label: 'Users', icon: User },
  { key: 'domains', label: 'Domain', icon: Globe },
  { key: 'webhooks', label: 'Webhooks', icon: Webhook },
];

const THEMES = [
  { key: 'light', label: 'Light', icon: Sun },
  { key: 'dark', label: 'Dark', icon: Moon },
  { key: 'system', label: 'System', icon: Monitor },
];

const TIMEZONES = [
  'Asia/Calcutta',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
  'Pacific/Auckland',
];

const COLOR_PRESETS = [
  '#dc2626', '#ea580c', '#d97706', '#16a34a',
  '#0891b2', '#2563eb', '#7c3aed', '#db2777',
  '#4b5563', '#000000',
];

/* ------------------------------------------------------------------ */
/*  Placeholder                                                        */
/* ------------------------------------------------------------------ */
function PlaceholderTab({ label }) {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: C.textMuted, fontSize: 15, fontFamily: FONT,
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🚧</div>
        <div style={{ fontWeight: 600, color: C.text, marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: 15 }}>This section is coming soon.</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Domain                                                             */
/* ------------------------------------------------------------------ */
// Where an admin points a real domain at this install without touching a server.
//
// The important half of this screen is the diagnosis at the top, not the list
// underneath. Every address problem is the same shape — what the browser used
// disagrees with what the install was configured for — and none of it surfaces
// as an error a user could act on. A Secure cookie over plain HTTP just looks
// like "it logs me out"; an address missing from CORS just looks like a 500.
// The generated reverse-proxy configuration for one domain.
//
// Split out because it is the only part of this screen that exists to be copied
// rather than read, and copyable content has different rules: nothing that would
// break when pasted, every command on its own line, and the one judgement the
// generator made — whether a certificate resolver belongs on this hostname —
// stated in the open rather than buried in a comment inside the file.
function OverlayPanel({ data, copiedKey, onCopy }) {
  if (!data) return null;

  const block = {
    fontFamily: MONO, fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre',
    overflowX: 'auto', background: C.surfaceSubtle, border: `1px solid ${C.border}`,
    borderRadius: 7, padding: '10px 12px', margin: 0, color: C.text,
  };
  const copyBtn = (key, text) => (
    <button onClick={() => onCopy(key, text)} style={{
      display: 'flex', alignItems: 'center', gap: 5, padding: '5px 9px', borderRadius: 6,
      border: `1px solid ${C.border}`, background: C.surface, fontSize: 12,
      fontFamily: FONT, color: C.textSecondary, cursor: 'pointer', flexShrink: 0,
    }}>
      {copiedKey === key ? <Check size={13} color={C.successText} /> : <Copy size={13} />}
      {copiedKey === key ? 'Copied' : 'Copy'}
    </button>
  );

  // Three states, and "could not tell" is deliberately not folded into "no".
  // Putting a certificate resolver on a CDN-fronted hostname produces an ACME
  // challenge that can never succeed, retried forever, and the failures are
  // rate-limited per account — so they take unrelated domains down with them.
  const verdict = data.behindCdn === true
    ? { tone: 'ok', text: `${data.cdnName || 'A CDN'} is in front of this domain, so it supplies the `
        + 'certificate. The file below leaves the resolver out, on purpose.' }
    : data.behindCdn === false
      ? { tone: 'warn', text: 'This domain appears to point straight at this server, so the file '
        + 'includes a certificate resolver — set it to the name your Traefik actually defines.' }
      : { tone: 'warn', text: 'Could not reach this hostname, so whether a CDN sits in front is '
        + 'unknown. The resolver line is commented out with a note on which way to go.' };

  return (
    <div style={{
      marginTop: 10, padding: '12px 14px', borderRadius: 8,
      background: C.surface, border: `1px solid ${C.border}`,
    }}>
      <div style={{ fontWeight: 600, fontSize: 13.5, color: C.text, marginBottom: 6 }}>
        Configuration for the program that owns ports 80 and 443
      </div>
      <div style={{
        fontSize: 12.5, lineHeight: 1.55, marginBottom: 12, padding: '8px 10px', borderRadius: 6,
        color: C.textSecondary,
        background: verdict.tone === 'ok' ? C.successBgSoft : C.warnBgSoft,
        border: `1px solid ${verdict.tone === 'ok' ? C.successBorder : C.warnBorder}`,
      }}>{verdict.text}</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, color: C.textMuted, flex: 1 }}>
          Save as <code style={{ fontFamily: MONO }}>{data.path}</code>
          {' '}— outside the install directory, which is overwritten on every upgrade.
        </span>
        {copyBtn('yaml', data.yaml)}
      </div>
      <pre style={{ ...block, marginBottom: 14 }}>{data.yaml}</pre>

      {(data.commands || []).map((c, i) => (
        <div key={i} style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
            <span style={{ fontSize: 12.5, color: C.textSecondary, flex: 1 }}>
              {i + 1}. {c.label}
            </span>
            {copyBtn(`cmd${i}`, c.cmd)}
          </div>
          <pre style={block}>{c.cmd}</pre>
        </div>
      ))}

      <ul style={{ margin: '4px 0 0 0', paddingLeft: 16 }}>
        {(data.notes || []).map((n, i) => (
          <li key={i} style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.55, marginBottom: 4 }}>{n}</li>
        ))}
      </ul>
    </div>
  );
}

function DomainTab() {
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [hostname, setHostname] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [checking, setChecking] = useState(null);   // id currently being checked
  const [checks, setChecks] = useState({});         // id -> result of the last check
  const [overlay, setOverlay] = useState(null);     // { id, data } — the open setup panel
  const [overlayLoading, setOverlayLoading] = useState(null);
  const [copiedKey, setCopiedKey] = useState('');

  async function load() {
    try {
      const [list, st] = await Promise.all([api.domains.list(), api.domains.status()]);
      setRows(list.domains || []);
      setStatus(st);
    } catch (err) {
      showError(err.message || 'Could not load the domain settings');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault();
    if (!hostname.trim() || saving) return;
    setSaving(true);
    try {
      await api.domains.add(hostname.trim());
      setHostname('');
      showSuccess('Domain added. Point its DNS at this server and open it in a browser.');
      await load();
    } catch (err) {
      showError(err.message || 'Could not add that domain');
    } finally {
      setSaving(false);
    }
  }

  // The only control on this screen that reports reality rather than
  // configuration: the server fetches this install's own public address and says
  // what came back. Deliberately a button and not something the page does on
  // load — it is a real round-trip through whatever sits in front of this
  // install, and it can take several seconds per domain.
  async function check(row) {
    setChecking(row.id);
    try {
      const result = await api.domains.check(row.id);
      setChecks((c) => ({ ...c, [row.id]: result }));
    } catch (err) {
      showError(err.message || 'Could not check that domain');
    } finally {
      setChecking(null);
    }
  }

  // On an install that does not own ports 80/443, the app cannot route a
  // hostname to itself — it has no access to the configuration of whatever does.
  // It can still write out that configuration, filled in, which turns "read the
  // documentation and adapt the example" into three commands.
  async function showOverlay(row) {
    if (overlay?.id === row.id) { setOverlay(null); return; }
    setOverlayLoading(row.id);
    try {
      setOverlay({ id: row.id, data: await api.domains.overlay(row.id) });
    } catch (err) {
      showError(err.message || 'Could not build the configuration file');
    } finally {
      setOverlayLoading(null);
    }
  }

  async function copy(key, text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(''), 1500);
    } catch { /* clipboard blocked — the text is on screen to select by hand */ }
  }

  async function remove(row) {
    try {
      await api.domains.remove(row.id);
      showSuccess(`${row.hostname} removed`);
      await load();
    } catch (err) {
      showError(err.message || 'Could not remove that domain');
    } finally {
      setPendingDelete(null);
    }
  }

  const card = {
    background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10,
    padding: 18, marginBottom: 16,
  };

  if (loading) {
    return (
      <div style={{ padding: 24, fontFamily: FONT }}>
        <div style={{ height: 74, background: C.surfaceSubtle, borderRadius: 10, marginBottom: 16 }} />
        <div style={{ height: 180, background: C.surfaceSubtle, borderRadius: 10 }} />
      </div>
    );
  }

  return (
    <div style={{ padding: 24, fontFamily: FONT, overflowY: 'auto', flex: 1 }}>
      {/* Diagnosis first: this is the part that explains a broken login. */}
      {(status?.warnings || []).map((w, i) => (
        <div key={i} style={{
          ...card, marginBottom: 12, display: 'flex', gap: 12, alignItems: 'flex-start',
          background: w.level === 'error' ? C.dangerBgSoft : C.warnBgSoft,
          border: `1px solid ${w.level === 'error' ? C.dangerBorder : C.warnBorder}`,
        }}>
          <AlertCircle size={18} style={{ flexShrink: 0, marginTop: 1 }}
            color={w.level === 'error' ? C.dangerText : C.warnText} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4,
              color: w.level === 'error' ? C.dangerText : C.warnText }}>{w.title}</div>
            <div style={{ fontSize: 13, color: C.textSecondary, lineHeight: 1.55 }}>{w.detail}</div>
          </div>
        </div>
      ))}

      {status && !(status.warnings || []).length && (
        <div style={{ ...card, marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center',
          background: C.successBgSoft, border: `1px solid ${C.successBorder}` }}>
          <CheckCircle2 size={18} color={C.successText} />
          <div style={{ fontSize: 13.5, color: C.textSecondary }}>
            This address is set up correctly.
          </div>
        </div>
      )}

      <div style={card}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10, color: C.text }}>
          How you are reaching this right now
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 18px', fontSize: 13.5 }}>
          <span style={{ color: C.textMuted }}>Address</span>
          <span style={{ fontFamily: MONO, color: C.text }}>
            {status?.protocol}://{status?.requestHost || '—'}
          </span>
          <span style={{ color: C.textMuted }}>Login cookie</span>
          <span style={{ color: C.text }}>
            {status?.secureCookies ? 'Secure — HTTPS only' : 'Not marked Secure — works over HTTP'}
          </span>
          <span style={{ color: C.textMuted }}>Set at install</span>
          <span style={{ fontFamily: MONO, color: C.textSecondary }}>
            {status?.corsOrigin || 'not set'}
          </span>
        </div>
      </div>

      <div style={card}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4, color: C.text }}>
          Extra domains
        </div>
        {/* The two kinds of server need different instructions, and describing
            both the same way is how someone ends up waiting for a certificate
            that nothing on this machine is able to fetch. */}
        <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 14, lineHeight: 1.55 }}>
          {status?.tlsMode === 'caddy' ? (
            <>Add a domain, point its DNS at this server, then open it in a browser.
            The HTTPS certificate is obtained on that first visit — nothing to restart
            and nothing else to configure.</>
          ) : status?.autoRouting ? (
            // The proxy on this server publishes routes from a directory this
            // install can write to, so the manual step does not exist here.
            <>Add a domain and point its DNS at this server. The route is published to
            this server’s reverse proxy automatically — nothing to restart and no file
            to edit. The certificate comes from that proxy, or from a CDN if one sits
            in front. Press <strong>Check</strong> below once DNS has propagated.</>
          ) : (
            <>Adding a domain here makes this install accept it straight away. Because
            another program on this server owns ports 80 and 443, the certificate has to
            come from that one — point it at this install
            {status?.requestHost ? ' the same way the current address reaches it' : ''}.
            {' '}<code style={{ fontFamily: MONO, fontSize: 12.5 }}>docs/reverse-proxy.md</code>
            {' '}has a Traefik and an nginx example. Then press <strong>Check</strong> on the
            row below: it fetches the domain from the outside and says which part is not
            working yet.</>
          )}
        </div>

        <form onSubmit={add} style={{ display: 'flex', gap: 8, marginBottom: rows.length ? 16 : 0 }}>
          <input
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="crm.example.com"
            style={{
              flex: 1, padding: '9px 12px', borderRadius: 8, fontSize: 14, fontFamily: MONO,
              border: `1px solid ${C.border}`, background: C.surface, color: C.text, outline: 'none',
            }}
          />
          <button type="submit" disabled={saving || !hostname.trim()} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 8,
            border: 'none', fontSize: 14, fontWeight: 600, fontFamily: FONT,
            background: hostname.trim() ? C.primary : C.surfaceMuted,
            color: hostname.trim() ? C.primaryText : C.textMuted,
            cursor: hostname.trim() && !saving ? 'pointer' : 'default',
          }}>
            {saving ? <Loader2 size={15} className="spin" /> : <Plus size={15} />} Add
          </button>
        </form>

        {rows.map((r) => {
          const res = checks[r.id];
          const tone = !res ? null
            : res.level === 'ok' ? { bg: C.successBgSoft, border: C.successBorder, text: C.successText }
            : res.level === 'warn' ? { bg: C.warnBgSoft, border: C.warnBorder, text: C.warnText }
            : { bg: C.dangerBgSoft, border: C.dangerBorder, text: C.dangerText };
          return (
            <div key={r.id} style={{ padding: '11px 0', borderTop: `1px solid ${C.rowSep}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Globe size={16} color={C.textMuted} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: MONO, fontSize: 13.5, color: C.text }}>{r.hostname}</div>
                  <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                    {/* Nothing having asked for a certificate is the usual sign that DNS
                        is not pointing here yet, so it is worth saying rather than
                        leaving the row looking simply idle. */}
                    {r.lastSeenAt ? 'In use'
                      : r.lastAskedAt ? 'Certificate requested — finishing'
                      : 'Waiting for its first visit. Check the DNS points here.'}
                  </div>
                </div>
                {/* Only on installs where something else owns 80/443. Where the
                    bundled caddy owns them, adding the domain really is the whole
                    job and offering a proxy config would invent work. */}
                {status?.tlsMode !== 'caddy' && !status?.autoRouting && (
                  <button onClick={() => showOverlay(r)} disabled={overlayLoading === r.id}
                    title={`Configuration your reverse proxy needs for ${r.hostname}`} style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '7px 11px',
                      borderRadius: 7, border: `1px solid ${C.border}`,
                      background: overlay?.id === r.id ? C.surfaceMuted : 'transparent',
                      fontSize: 13, fontFamily: FONT, color: C.textSecondary,
                      cursor: overlayLoading === r.id ? 'default' : 'pointer',
                    }}>
                    {overlayLoading === r.id
                      ? <Loader2 size={14} className="spin" />
                      : <Terminal size={14} />} Setup file
                  </button>
                )}
                <button onClick={() => check(r)} disabled={checking === r.id}
                  title={`Check whether ${r.hostname} reaches this install`} style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '7px 11px',
                    borderRadius: 7, border: `1px solid ${C.border}`, background: 'transparent',
                    fontSize: 13, fontFamily: FONT, color: C.textSecondary,
                    cursor: checking === r.id ? 'default' : 'pointer',
                  }}>
                  {checking === r.id
                    ? <Loader2 size={14} className="spin" />
                    : <RefreshCw size={14} />} Check
                </button>
                <button onClick={() => setPendingDelete(r)} title={`Remove ${r.hostname}`} style={{
                  display: 'flex', alignItems: 'center', padding: 7, borderRadius: 7,
                  border: `1px solid ${C.border}`, background: 'transparent',
                  color: C.dangerText, cursor: 'pointer',
                }}>
                  <Trash2 size={14} />
                </button>
              </div>

              {res && (
                <div style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 10,
                  padding: '10px 12px', borderRadius: 8,
                  background: tone.bg, border: `1px solid ${tone.border}`,
                }}>
                  {res.level === 'ok'
                    ? <CheckCircle2 size={16} color={tone.text} style={{ flexShrink: 0, marginTop: 1 }} />
                    : <AlertCircle size={16} color={tone.text} style={{ flexShrink: 0, marginTop: 1 }} />}
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: tone.text }}>{res.title}</div>
                    <div style={{ fontSize: 12.5, color: C.textSecondary, lineHeight: 1.55, marginTop: 3 }}>
                      {res.detail}
                    </div>
                  </div>
                </div>
              )}

              {overlay?.id === r.id && (
                <OverlayPanel data={overlay.data} copiedKey={copiedKey} onCopy={copy} />
              )}
            </div>
          );
        })}
      </div>

      {pendingDelete && (
        <DeleteConfirmModal
          open
          title="Remove this domain?"
          message={`${pendingDelete.hostname} will stop being accepted. Anyone using it will `
                 + 'be refused, and its certificate will not be renewed.'}
          onConfirm={() => remove(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  General                                                            */
/* ------------------------------------------------------------------ */
function GeneralTab({ onLogout, user }) {
  const { theme, setTheme } = useTheme();
  const [timezone, setTimezone] = useState('Asia/Calcutta');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [showDeleteInput, setShowDeleteInput] = useState(false);

  const handleDeleteClick = () => {
    if (!showDeleteInput) { setShowDeleteInput(true); return; }
    if (deleteConfirm.trim().toLowerCase() === 'delete') {
      notify('Account deletion request submitted.');
      setShowDeleteInput(false);
      setDeleteConfirm('');
    } else {
      notify('Please type "delete" to confirm account deletion.');
    }
  };

  return (
    <div style={{ flex: 1, padding: '32px 40px', overflowY: 'auto', fontFamily: FONT }}>
      <div style={{ maxWidth: '100%' }}>
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-.02em', fontFamily: FONT }}>General Settings</h1>
          <p style={{ fontSize: 14, color: C.textMuted, margin: '4px 0 0', fontFamily: FONT }}>Manage your account preferences and settings</p>
        </div>

        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
            Appearance
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {THEMES.map(t => {
              const Icon = t.icon;
              const isActive = theme === t.key;
              return (
                <button key={t.key} onClick={() => setTheme(t.key)} style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  padding: '12px 16px', borderRadius: 10,
                  border: `1.5px solid ${isActive ? C.primary : C.border}`,
                  background: isActive ? C.primaryLight : 'var(--c-cardBg)',
                  cursor: 'pointer', fontFamily: FONT, fontSize: 15, fontWeight: 600,
                  color: isActive ? C.primary : C.text, transition: 'all .15s',
                }}>
                  <Icon size={16} /> {t.label}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
            Timezone
          </div>
          <SearchableSelect
            value={timezone}
            onChange={v => setTimezone(v)}
            options={TIMEZONES.map(tz => ({ value: tz, label: tz }))}
            searchPlaceholder="Search timezones…"
            style={{ width: '100%', maxWidth: 360 }}
            triggerStyle={{ padding: '10px 32px 10px 12px', fontSize: 15 }}
          />
        </div>

        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
            Account
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button onClick={onLogout} style={{
              width: 'fit-content', display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 18px', borderRadius: 8, border: `1px solid ${C.border}`,
              background: 'var(--c-cardBg)', cursor: 'pointer', fontFamily: FONT, fontSize: 15,
              fontWeight: 600, color: C.text,
            }}>
              <LogOut size={14} /> Sign out
            </button>

            {user?.role === 'admin' && (
            <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 16, marginTop: 6 }}>
              <button onClick={handleDeleteClick} style={{
                width: 'fit-content', display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 18px', borderRadius: 8, border: '1.5px solid #fca5a5',
                background: 'var(--c-dangerBgSoft, #fef2f2)', cursor: 'pointer', fontFamily: FONT, fontSize: 15,
                fontWeight: 600, color: C.primary,
              }}>
                <Trash2 size={14} /> Delete account
              </button>
              {showDeleteInput && (
                <div style={{ marginTop: 12, maxWidth: 360 }}>
                  <div style={{ fontSize: 14, color: C.textSecondary, marginBottom: 8 }}>
                    Type <strong>"delete"</strong> below to confirm permanent account deletion.
                  </div>
                  <input autoFocus value={deleteConfirm} onChange={e => setDeleteConfirm(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleDeleteClick()}
                    placeholder="Type delete..." style={{
                      width: '100%', padding: '10px 12px', borderRadius: 8,
                      border: `1px solid ${C.border}`, fontSize: 15, fontFamily: FONT,
                      color: C.text, outline: 'none', boxSizing: 'border-box',
                    }} />
                </div>
              )}
            </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  (Team Members removed 2026-08-12 — a number is named in its own tab)  */
/* ------------------------------------------------------------------ */
function FieldsTab() {
  // Which TABLE's columns are being managed. The contact_field_definitions CRUD
  // that used to live here is gone with the rest of contacts-as-a-CRM-record.
  const [section, setSection] = useState('lead:leads');

  // One section per TABLE. "Contacts (Chats)" is gone: a contact is no longer a
  // record you manage — it is the row a WhatsApp thread hangs off — and the
  // lead is the source of truth for everything about a person.
  //
  // Leads and Sales Log read the same `entity='lead'` registry rows but own one
  // visibility flag each, so each gets its own section with its own switch
  // rather than one section with two switch columns per row.
  // The Transactions section was removed 2026-08-12: an installment's columns
  // are fixed by what a payment IS, so there was nothing useful to configure.
  // The `entity='transaction'` registry rows still exist and still drive the
  // transactions table — they are simply no longer editable here.
  const FIELD_SECTIONS = [
    { key: 'lead', surface: 'leads', label: 'Leads' },
    { key: 'lead', surface: 'sales', label: 'Sales Log' },
  ];
  const sectionId = (s) => (s.surface ? `${s.key}:${s.surface}` : s.key);
  const activeSection = FIELD_SECTIONS.find(s => sectionId(s) === section) || FIELD_SECTIONS[0];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        padding: '20px 32px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: `1px solid ${C.border}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-.02em', fontFamily: FONT }}>Fields</h1>
          <div style={{ display: 'inline-flex', background: 'var(--c-hover, #F1F1EE)', borderRadius: 9, padding: 3, gap: 2 }}>
            {FIELD_SECTIONS.map(s => {
              const id = sectionId(s);
              const on = sectionId(activeSection) === id;
              return (
                <button key={id} onClick={() => setSection(id)} style={{
                  padding: '6px 12px', borderRadius: 7, border: 'none', cursor: 'pointer',
                  fontFamily: FONT, fontSize: 14, fontWeight: 600,
                  background: on ? C.cardBg : 'transparent',
                  color: on ? C.text : C.textSecondary,
                  boxShadow: on ? '0 1px 2px rgba(0,0,0,.08)' : 'none',
                }}>{s.label}</button>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 32px' }}>
        <EntityFieldsManager entity={activeSection.key} surface={activeSection.surface} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tags                                                               */
/* ------------------------------------------------------------------ */
function TagsTab({ categories, tags, onRefresh }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editingTag, setEditingTag] = useState(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#dc2626');
  const [categoryId, setCategoryId] = useState('');
  const [deleteModal, setDeleteModal] = useState({ open: false, id: null });
  const [filterCategoryId, setFilterCategoryId] = useState('');

  // Category filter — selection/bulk-delete operate on the visible (filtered) set.
  const filteredTags = filterCategoryId
    ? tags.filter(t => String(t.category_id) === String(filterCategoryId))
    : tags;

  const sel = useTableSelection(filteredTags);
  const handleBulkDelete = async (ids) => {
    await runBulkDelete(ids, (id) => api.tags.delete(id), {
      label: 'tag',
      onSuccess: () => onRefresh(),
    });
  };

  const openAdd = () => {
    setEditingTag(null);
    setName('');
    setColor('#dc2626');
    setCategoryId('');
    setShowAdd(true);
  };

  const openEdit = (tag) => {
    setEditingTag(tag);
    setName(tag.name);
    setColor(tag.color);
    setCategoryId(tag.category_id);
    setShowAdd(true);
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) { notify('Tag name is required'); return; }
    if (!categoryId) { notify('Please select a category'); return; }
    try {
      if (editingTag) {
        await api.tags.update(editingTag.id, { name: trimmed, color, categoryId });
      } else {
        await api.tags.create({ name: trimmed, color, categoryId });
      }
      onRefresh();
      setShowAdd(false);
      setEditingTag(null);
      setName('');
      setColor('#dc2626');
      setCategoryId('');
    } catch (err) {
      notify('Failed to save tag: ' + err.message);
    }
  };

  const handleDeleteClick = (id) => {
    setDeleteModal({ open: true, id });
  };

  const handleDeleteConfirm = async () => {
    try {
      await api.tags.delete(deleteModal.id);
      onRefresh();
      setDeleteModal({ open: false, id: null });
    } catch (err) {
      notify('Failed to delete tag: ' + err.message);
    }
  };

  const getCategoryName = (cid) => categories.find(c => c.id === cid)?.name || '-';

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        padding: '20px 32px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: `1px solid ${C.border}`,
      }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-.02em', fontFamily: FONT }}>Tags</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <SearchableSelect
            value={filterCategoryId}
            onChange={v => setFilterCategoryId(v)}
            options={[{ value: '', label: 'All categories' }, ...categories.map(c => ({ value: String(c.id), label: c.name }))]}
            placeholder="All categories"
            searchPlaceholder="Search categories…"
            style={{ maxWidth: 220 }}
            triggerStyle={{ padding: '8px 32px 8px 12px' }}
          />
          <BulkDeleteButton sel={sel} label="tag" onConfirm={handleBulkDelete} />
          <button onClick={openAdd} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 14px', borderRadius: 8, border: 'none',
            background: C.primary, color: '#fff', cursor: 'pointer',
            fontFamily: FONT, fontSize: 15, fontWeight: 600,
          }}>
            <Plus size={14} /> Add tag
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 32px' }}>
        {tags.length === 0 ? (
          <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 15, marginTop: 60 }}>
            No tags yet. Click "Add tag" to create one.
          </div>
        ) : filteredTags.length === 0 ? (
          <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 15, marginTop: 60 }}>
            No tags in <strong>{getCategoryName(filterCategoryId)}</strong>.
          </div>
        ) : (
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 15 }}>
              <thead>
                <tr style={{ background: 'var(--c-hover)' }}>
                  <th style={{ padding: '12px 16px', width: 40, borderBottom: `1px solid ${C.border}` }}><SelectAllCheckbox sel={sel} /></th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Tag</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Category</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Created</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredTags.map(tag => (
                  <tr key={tag.id} style={{ background: sel.isSelected(tag.id) ? 'var(--c-xfdf6f6, #FDF6F6)' : 'var(--c-cardBg)', borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: '12px 16px', width: 40 }}><RowCheckbox sel={sel} id={tag.id} label={tag.name} /></td>
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{
                          width: 14, height: 14, borderRadius: 4,
                          background: tag.color, display: 'inline-block',
                          border: '1px solid rgba(0,0,0,0.1)',
                        }} />
                        <span style={{ fontWeight: 600, color: C.text }}>{tag.name}</span>
                      </div>
                    </td>
                    <td style={{ padding: '12px 16px', color: C.textSecondary }}>{getCategoryName(tag.category_id)}</td>
                    <td style={{ padding: '12px 16px', color: C.textSecondary }}>{new Date(tag.created_at).toLocaleDateString()}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                      <button onClick={() => openEdit(tag)} style={{
                        border: 'none', background: 'transparent', cursor: 'pointer',
                        color: C.purple, fontSize: 14, fontWeight: 600, marginRight: 12,
                      }}>Edit</button>
                      <button onClick={() => handleDeleteClick(tag.id)} style={{
                        border: 'none', background: 'transparent', cursor: 'pointer',
                        color: C.primary, fontSize: 14, fontWeight: 600,
                      }}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <DeleteConfirmModal
        open={deleteModal.open}
        title="Delete Tag"
        message="Are you sure you want to delete this tag? It will be removed from all contacts."
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteModal({ open: false, id: null })}
      />

      {showAdd && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 200, fontFamily: FONT,
        }}>
          <div style={{
            background: C.cardBg, borderRadius: 14,
            padding: '24px 24px 20px', width: 420, boxShadow: C.shadowLg,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{editingTag ? 'Edit Tag' : 'Add Tag'}</div>
              <button onClick={() => { setShowAdd(false); setEditingTag(null); }} style={{
                border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted,
              }}><X size={18} /></button>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Tag Name</label>
              <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Follow-up"
                onKeyDown={e => e.key === 'Enter' && handleSave()}
                style={{
                  width: '100%', padding: '10px 12px', borderRadius: 8,
                  border: `1px solid ${C.border}`, fontSize: 15, fontFamily: FONT,
                  color: C.text, outline: 'none', boxSizing: 'border-box',
                }} />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Color</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {COLOR_PRESETS.map(c => (
                  <button key={c} onClick={() => setColor(c)} style={{
                    width: 28, height: 28, borderRadius: 6,
                    background: c,
                    border: color === c ? '2px solid #111' : '2px solid transparent',
                    cursor: 'pointer',
                    boxShadow: color === c ? '0 0 0 2px #fff inset' : 'none',
                  }} />
                ))}
                <label style={{
                  width: 28, height: 28, borderRadius: 6,
                  border: `2px dashed ${C.border}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', color: C.textMuted,
                }}>
                  <Plus size={14} />
                  <input type="color" value={color} onChange={e => setColor(e.target.value)} style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
                </label>
              </div>
              <div style={{ marginTop: 6, fontSize: 14, color: C.textMuted }}>Selected: {color}</div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Category</label>
              <SearchableSelect
                value={categoryId}
                onChange={v => setCategoryId(v)}
                options={categories.map(c => ({ value: String(c.id), label: c.name }))}
                placeholder="Select category…"
                searchPlaceholder="Search categories…"
                style={{ width: '100%' }}
                triggerStyle={{ padding: '10px 32px 10px 12px', fontSize: 15 }}
              />
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowAdd(false); setEditingTag(null); }} style={{
                padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.border}`,
                background: 'transparent', cursor: 'pointer', fontSize: 15,
                fontWeight: 600, color: C.textSecondary, fontFamily: FONT,
              }}>Cancel</button>
              <button onClick={handleSave} style={{
                padding: '8px 16px', borderRadius: 8, border: 'none',
                background: C.primary, color: '#fff', cursor: 'pointer',
                fontSize: 15, fontWeight: 600, fontFamily: FONT,
              }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Category Detail                                                    */
/* ------------------------------------------------------------------ */
function CategoryDetail({ category, tags, onBack, onDeleteTag, onRefresh }) {
  const categoryTags = tags.filter(t => t.category_id === category.id);
  const [deleteModal, setDeleteModal] = useState({ open: false, id: null });

  const handleDeleteClick = (tid) => {
    setDeleteModal({ open: true, id: tid });
  };

  const handleDeleteConfirm = async () => {
    try {
      await api.tags.delete(deleteModal.id);
      onRefresh();
      setDeleteModal({ open: false, id: null });
    } catch (err) {
      notify('Failed to delete tag: ' + err.message);
    }
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '20px 32px', borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onBack} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          border: 'none', background: 'transparent', cursor: 'pointer',
          color: C.textSecondary, fontFamily: FONT, fontSize: 15,
          fontWeight: 600, marginBottom: 12,
        }}>
          <ChevronLeft size={16} /> Back to categories
        </button>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-.02em', fontFamily: FONT }}>
          {category.name}
        </h1>
        <div style={{ fontSize: 15, color: C.textSecondary, marginTop: 4, fontFamily: FONT }}>
          {category.description || 'No description'}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 32px' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: C.textSecondary, marginBottom: 12, fontFamily: FONT }}>
          Tags under this category ({categoryTags.length})
        </div>
        {categoryTags.length === 0 ? (
          <div style={{ color: C.textMuted, fontSize: 15 }}>No tags assigned to this category yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {categoryTags.map(tag => (
              <div key={tag.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 16px', background: 'var(--c-cardBg)', borderRadius: 8,
                border: `1px solid ${C.border}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{
                    width: 14, height: 14, borderRadius: 4,
                    background: tag.color, display: 'inline-block',
                    border: '1px solid rgba(0,0,0,0.1)',
                  }} />
                  <span style={{ fontWeight: 600, color: C.text, fontSize: 15 }}>{tag.name}</span>
                </div>
                <button onClick={() => handleDeleteClick(tag.id)} style={{
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  color: C.primary, fontSize: 14, fontWeight: 600,
                }}>Delete</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <DeleteConfirmModal
        open={deleteModal.open}
        title="Delete Tag"
        message="Are you sure you want to delete this tag? It will be removed from all contacts."
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteModal({ open: false, id: null })}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Category Tab                                                       */
/* ------------------------------------------------------------------ */
function CategoryTab({ categories, tags, onRefresh, detailId, onViewDetail, onBack, showAddForm, onAddFormShown }) {
  const [showAdd, setShowAdd] = useState(showAddForm);
  const [editingCategory, setEditingCategory] = useState(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [deleteModal, setDeleteModal] = useState({ open: false, id: null });

  useEffect(() => {
    setShowAdd(showAddForm);
  }, [showAddForm]);

  const openAdd = () => {
    setEditingCategory(null);
    setName('');
    setDescription('');
    setShowAdd(true);
    onAddFormShown();
  };

  const openEdit = (cat) => {
    setEditingCategory(cat);
    setName(cat.name);
    setDescription(cat.description || '');
    setShowAdd(true);
    onAddFormShown();
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) { notify('Category name is required'); return; }
    try {
      if (editingCategory) {
        await api.categories.update(editingCategory.id, { name: trimmed, description: description.trim() });
      } else {
        await api.categories.create({ name: trimmed, description: description.trim() });
      }
      onRefresh();
      setShowAdd(false);
      setEditingCategory(null);
      onAddFormShown();
      setName('');
      setDescription('');
    } catch (err) {
      notify('Failed to save category: ' + err.message);
    }
  };

  const handleDeleteClick = (id) => {
    setDeleteModal({ open: true, id });
  };

  const handleDeleteConfirm = async () => {
    try {
      await api.categories.delete(deleteModal.id);
      onRefresh();
      setDeleteModal({ open: false, id: null });
    } catch (err) {
      notify('Failed to delete category: ' + err.message);
    }
  };

  const sel = useTableSelection(categories);
  const handleBulkDelete = async (ids) => {
    await runBulkDelete(ids, (id) => api.categories.delete(id), {
      label: 'category',
      onSuccess: () => onRefresh(),
    });
  };

  if (detailId) {
    const cat = categories.find(c => c.id === detailId);
    if (!cat) { onBack(); return null; }
    return (
      <CategoryDetail
        category={cat}
        tags={tags}
        onBack={onBack}
        onRefresh={onRefresh}
      />
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        padding: '20px 32px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: `1px solid ${C.border}`,
      }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-.02em', fontFamily: FONT }}>Categories</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <BulkDeleteButton sel={sel} label="category" onConfirm={handleBulkDelete} />
          <button onClick={openAdd} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 14px', borderRadius: 8, border: 'none',
            background: C.primary, color: '#fff', cursor: 'pointer',
            fontFamily: FONT, fontSize: 15, fontWeight: 600,
          }}>
            <Plus size={14} /> Add category
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 32px' }}>
        {categories.length === 0 ? (
          <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 15, marginTop: 60 }}>
            No categories yet. Click "Add category" to create one.
          </div>
        ) : (
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 15 }}>
              <thead>
                <tr style={{ background: 'var(--c-hover)' }}>
                  <th style={{ padding: '12px 16px', width: 40, borderBottom: `1px solid ${C.border}` }}><SelectAllCheckbox sel={sel} /></th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Name</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Description</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Tags</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {categories.map(cat => {
                  const tagCount = tags.filter(t => t.category_id === cat.id).length;
                  return (
                    <tr key={cat.id} style={{ background: sel.isSelected(cat.id) ? 'var(--c-xfdf6f6, #FDF6F6)' : 'var(--c-cardBg)', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}
                      onClick={() => onViewDetail(cat.id)}
                      onMouseEnter={e => { if (!sel.isSelected(cat.id)) e.currentTarget.style.background = 'var(--c-xf9fafb, #f9fafb)'; }}
                      onMouseLeave={e => { if (!sel.isSelected(cat.id)) e.currentTarget.style.background = 'var(--c-cardBg)'; }}
                    >
                      <td style={{ padding: '12px 16px', width: 40 }} onClick={(e) => e.stopPropagation()}><RowCheckbox sel={sel} id={cat.id} label={cat.name} /></td>
                      <td style={{ padding: '12px 16px', fontWeight: 600, color: C.text }}>{cat.name}</td>
                      <td style={{ padding: '12px 16px', color: C.textSecondary, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cat.description || '-'}</td>
                      <td style={{ padding: '12px 16px', color: C.textSecondary }}>{tagCount}</td>
                      <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                        <button onClick={(e) => { e.stopPropagation(); onViewDetail(cat.id); }} style={{
                          border: 'none', background: 'transparent', cursor: 'pointer',
                          color: C.purple, fontSize: 14, fontWeight: 600, marginRight: 12,
                        }}><Eye size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />View</button>
                        <button onClick={(e) => { e.stopPropagation(); openEdit(cat); }} style={{
                          border: 'none', background: 'transparent', cursor: 'pointer',
                          color: 'var(--c-infoBright, #2563eb)', fontSize: 14, fontWeight: 600, marginRight: 12,
                        }}>Edit</button>
                        <button onClick={(e) => { e.stopPropagation(); handleDeleteClick(cat.id); }} style={{
                          border: 'none', background: 'transparent', cursor: 'pointer',
                          color: C.primary, fontSize: 14, fontWeight: 600,
                        }}>Delete</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <DeleteConfirmModal
        open={deleteModal.open}
        title="Delete Category"
        message="Are you sure you want to delete this category? All tags under it will be deleted too."
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteModal({ open: false, id: null })}
      />

      {showAdd && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 200, fontFamily: FONT,
        }}>
          <div style={{
            background: C.cardBg, borderRadius: 14,
            padding: '24px 24px 20px', width: 420, boxShadow: C.shadowLg,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{editingCategory ? 'Edit Category' : 'Add Category'}</div>
              <button onClick={() => { setShowAdd(false); setEditingCategory(null); onAddFormShown(); }} style={{
                border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted,
              }}><X size={18} /></button>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Category Name</label>
              <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Admission"
                onKeyDown={e => e.key === 'Enter' && handleSave()}
                style={{
                  width: '100%', padding: '10px 12px', borderRadius: 8,
                  border: `1px solid ${C.border}`, fontSize: 15, fontFamily: FONT,
                  color: C.text, outline: 'none', boxSizing: 'border-box',
                }} />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Description</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Short description..."
                rows={3}
                style={{
                  width: '100%', padding: '10px 12px', borderRadius: 8,
                  border: `1px solid ${C.border}`, fontSize: 15, fontFamily: FONT,
                  color: C.text, outline: 'none', boxSizing: 'border-box', resize: 'vertical',
                }} />
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowAdd(false); setEditingCategory(null); onAddFormShown(); }} style={{
                padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.border}`,
                background: 'transparent', cursor: 'pointer', fontSize: 15,
                fontWeight: 600, color: C.textSecondary, fontFamily: FONT,
              }}>Cancel</button>
              <button onClick={handleSave} style={{
                padding: '8px 16px', borderRadius: 8, border: 'none',
                background: C.primary, color: '#fff', cursor: 'pointer',
                fontSize: 15, fontWeight: 600, fontFamily: FONT,
              }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/*  WhatsApp Accounts Tab                                              */
/* ------------------------------------------------------------------ */
function WhatsappAccountsTab() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({
    displayName: '', displayPhoneNumber: '', phoneNumberId: '', wabaId: '', metaAppId: '',
    accessToken: '', verifyToken: '', isDefault: false, isActive: true,
  });
  const [showToken, setShowToken] = useState(false);
  const [revealedToken, setRevealedToken] = useState(null); // decrypted existing token, fetched on demand
  const [revealingToken, setRevealingToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [copied, setCopied] = useState(false);

  // The callback URL to register in the Meta App Dashboard — always the live origin.
  const webhookUrl = `${window.location.origin}/api/webhook/whatsapp`;
  const copyWebhookUrl = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await api.whatsappAccounts.list();
      setAccounts(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const startCreate = () => {
    setEditing(null);
    setForm({ displayName: '', displayPhoneNumber: '', phoneNumberId: '', wabaId: '', metaAppId: '', accessToken: '', verifyToken: '', isDefault: accounts.length === 0, isActive: true });
    setShowToken(false);
    setRevealedToken(null);
    setShowForm(true);
  };
  const startEdit = async (acc) => {
    setEditing(acc);
    setForm({
      displayName: acc.displayName, displayPhoneNumber: acc.displayPhoneNumber,
      phoneNumberId: acc.phoneNumberId, wabaId: acc.wabaId, metaAppId: acc.metaAppId || '',
      accessToken: '', verifyToken: acc.verifyToken || '', isDefault: acc.isDefault, isActive: acc.isActive,
    });
    setShowToken(false);
    setRevealedToken(null);
    setShowForm(true);
  };

  // Eye toggle. When revealing an existing account whose token field is still
  // blank, fetch the decrypted token (admin-only ?reveal=1) so it's actually visible.
  const toggleShowToken = async () => {
    if (!showToken && editing && !form.accessToken) {
      setRevealingToken(true);
      try {
        const full = await api.whatsappAccounts.get(editing.id, true);
        if (full.accessToken) {
          setForm(f => ({ ...f, accessToken: full.accessToken }));
          setRevealedToken(full.accessToken);
        }
      } catch (err) {
        notify(err.message || 'Failed to reveal access token');
        setRevealingToken(false);
        return;
      }
      setRevealingToken(false);
    }
    setShowToken(s => !s);
  };

  const save = async () => {
    if (!form.displayName.trim() || !form.displayPhoneNumber.trim() || !form.phoneNumberId.trim() || !form.wabaId.trim()) {
      notify('Display name, phone, phone number ID, and WABA ID are required');
      return;
    }
    if (!editing && !form.accessToken.trim()) {
      notify('Access token is required for new accounts');
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const payload = { ...form };
        // Drop an unchanged token (blank, or the one we just revealed) so save
        // doesn't needlessly re-encrypt it and reset the account's health.
        if (!payload.accessToken || payload.accessToken === revealedToken) delete payload.accessToken;
        await api.whatsappAccounts.update(editing.id, payload);
      } else {
        await api.whatsappAccounts.create(form);
      }
      setShowForm(false);
      await refresh();
    } catch (err) {
      notify(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.whatsappAccounts.delete(deleteTarget.id);
      setDeleteTarget(null);
      await refresh();
    } catch (err) {
      notify(err.message || 'Delete failed');
    }
  };

  const inpStyle = { width: '100%', padding: '8px 12px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 15, fontFamily: FONT, outline: 'none', background: 'var(--c-cardBg)', color: C.text };
  const labelStyle = { display: 'block', fontSize: 13, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, fontFamily: FONT };

  return (
    <div style={{ flex: 1, padding: 24, overflow: 'auto', fontFamily: FONT }}>
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}.spin{animation:spin 1s linear infinite}`}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: 0 }}>WhatsApp Accounts</h2>
          <p style={{ fontSize: 14, color: C.textMuted, margin: '4px 0 0' }}>
            Business accounts (WABAs) used to send templates, broadcasts and automation messages.
          </p>
        </div>
        <button onClick={startCreate} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 14px', background: C.primary, color: '#fff', border: 'none',
          borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
        }}>
          <Plus size={15} /> Add account
        </button>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: C.textMuted }}>Loading…</div>
      ) : accounts.length === 0 ? (
        <div style={{
          padding: '48px 32px', textAlign: 'center', background: C.cardBg,
          border: `1px dashed ${C.border}`, borderRadius: 12, color: C.textMuted, fontSize: 15,
        }}>
          <MessageSquare size={36} style={{ opacity: 0.5, marginBottom: 12 }} />
          <div style={{ marginBottom: 6, color: C.textSecondary, fontWeight: 600 }}>No WhatsApp accounts yet</div>
          <div>Add your first account to start creating templates and broadcasts.</div>
        </div>
      ) : (
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--c-hover)', borderBottom: `1px solid ${C.border}` }}>
                <th style={thStyle}>Display name</th>
                <th style={thStyle}>Phone number</th>
                <th style={thStyle}>Phone number ID</th>
                <th style={thStyle}>WABA ID</th>
                <th style={thStyle}>Access token</th>
                <th style={thStyle}>Health</th>
                <th style={thStyle}>Status</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(acc => (
                <tr key={acc.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontWeight: 600 }}>{acc.displayName}</span>
                      {acc.isDefault && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, padding: '2px 7px', background: 'var(--c-orangeBg, #FFF3E0)', color: 'var(--c-orangeText, #E65100)', borderRadius: 99, fontWeight: 700 }}>
                          <Star size={9} fill="currentColor" /> DEFAULT
                        </span>
                      )}
                    </div>
                  </td>
                  <td style={tdStyle}><MaskedNumber number={acc.displayPhoneNumber} /></td>
                  <td style={{ ...tdStyle, fontFamily: 'DM Mono, monospace', fontSize: 13 }}>{acc.phoneNumberId}</td>
                  <td style={{ ...tdStyle, fontFamily: 'DM Mono, monospace', fontSize: 13 }}>{acc.wabaId}</td>
                  <td style={{ ...tdStyle, fontFamily: 'DM Mono, monospace', fontSize: 13, color: C.textMuted }}>{acc.accessTokenMasked}</td>
                  <td style={tdStyle}>
                    {(() => {
                      const h = acc.healthStatus || 'unknown';
                      const styles = {
                        healthy: { bg: 'var(--c-successBg, #E1F5EE)', fg: 'var(--c-successText, #0F6E56)', label: 'Healthy' },
                        invalid_token: { bg: 'var(--c-dangerBg, #FCEBEB)', fg: 'var(--c-dangerText, #A32D2D)', label: 'Token expired' },
                        rate_limited: { bg: 'var(--c-orangeBg, #FFF3E0)', fg: 'var(--c-orangeText, #E65100)', label: 'Rate limited' },
                        unknown_error: { bg: 'var(--c-dangerBg, #FCEBEB)', fg: 'var(--c-dangerText, #A32D2D)', label: 'Error' },
                        unknown: { bg: 'var(--c-surfaceSubtle, #EEEDE8)', fg: C.textMuted, label: 'Not checked' },
                      };
                      const s = styles[h] || styles.unknown;
                      return (
                        <span title={acc.lastErrorMessage || ''} style={{ fontSize: 13, padding: '3px 8px', borderRadius: 99, fontWeight: 600, background: s.bg, color: s.fg }}>
                          {s.label}
                        </span>
                      );
                    })()}
                  </td>
                  <td style={tdStyle}>
                    <span style={{
                      fontSize: 13, padding: '3px 8px', borderRadius: 99, fontWeight: 600,
                      background: acc.isActive ? 'var(--c-successBg, #E1F5EE)' : 'var(--c-surfaceSubtle, #EEEDE8)',
                      color: acc.isActive ? 'var(--c-successText, #0F6E56)' : C.textMuted,
                    }}>
                      {acc.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    <button onClick={() => startEdit(acc)} style={iconBtnStyle} title="Edit">
                      <Eye size={14} />
                    </button>
                    <button onClick={() => setDeleteTarget(acc)} style={{ ...iconBtnStyle, color: 'var(--c-dangerText, #A32D2D)' }} title="Delete">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Form modal */}
      {showForm && (
        <div onClick={() => setShowForm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, width: 520, maxHeight: '90vh', overflow: 'auto', boxShadow: C.shadowLg, padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <h3 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: 0 }}>
                {editing ? 'Edit WhatsApp account' : 'New WhatsApp account'}
              </h3>
              <button onClick={() => setShowForm(false)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted }}><X size={20} /></button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={labelStyle}>Display name</label>
                <input style={inpStyle} value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} placeholder="e.g. Forgemind Main" autoFocus autoComplete="off" name="wa-display-name" />
              </div>
              <div>
                <label style={labelStyle}>WhatsApp phone number</label>
                <input style={inpStyle} value={form.displayPhoneNumber} onChange={e => setForm({ ...form, displayPhoneNumber: e.target.value })} placeholder="919876543210" autoComplete="off" name="wa-display-phone" inputMode="numeric" />
              </div>
              <div>
                <label style={labelStyle}>Phone number ID (from Meta)</label>
                <input style={{ ...inpStyle, fontFamily: 'DM Mono, monospace' }} value={form.phoneNumberId} onChange={e => setForm({ ...form, phoneNumberId: e.target.value })} placeholder="318766817983611" autoComplete="off" name="wa-phone-number-id" inputMode="numeric" />
              </div>
              <div>
                <label style={labelStyle}>WhatsApp Business Account ID (WABA)</label>
                <input style={{ ...inpStyle, fontFamily: 'DM Mono, monospace' }} value={form.wabaId} onChange={e => setForm({ ...form, wabaId: e.target.value })} placeholder="300804649783110" autoComplete="off" name="wa-waba-id" inputMode="numeric" />
              </div>
              <div>
                <label style={labelStyle}>Meta App ID <span style={{ color: C.textMuted, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(only required for media-header templates)</span></label>
                <input style={{ ...inpStyle, fontFamily: 'DM Mono, monospace' }} value={form.metaAppId} onChange={e => setForm({ ...form, metaAppId: e.target.value })} placeholder="e.g. 1191602295745986 (15–16 digits)" autoComplete="off" name="meta-app-id" inputMode="numeric" />
              </div>
              <div>
                <label style={labelStyle}>
                  System User access token {editing && <span style={{ color: C.textMuted, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(leave blank to keep existing)</span>}
                </label>
                <div style={{ position: 'relative' }}>
                  <input
                    style={{ ...inpStyle, paddingRight: 38, fontFamily: 'DM Mono, monospace', fontSize: 13 }}
                    type={showToken ? 'text' : 'password'}
                    value={form.accessToken}
                    onChange={e => setForm({ ...form, accessToken: e.target.value })}
                    placeholder={editing ? '••••••••' : 'EAAQ7…'}
                    autoComplete="new-password"
                    name="wa-system-user-token"
                  />
                  <button type="button" onClick={toggleShowToken} disabled={revealingToken} title={showToken ? 'Hide token' : 'Show token'} style={{ position: 'absolute', right: 8, top: 8, background: 'none', border: 'none', cursor: revealingToken ? 'default' : 'pointer', color: C.textMuted, padding: 4 }}>
                    {revealingToken ? <Loader2 size={14} className="spin" /> : showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Key size={10} /> Encrypted at rest with AES-256-GCM.
                </div>
              </div>
              <div>
                <label style={labelStyle}>Webhook verify token <span style={{ color: C.textMuted, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
                <input style={inpStyle} value={form.verifyToken} onChange={e => setForm({ ...form, verifyToken: e.target.value })} placeholder="Create a custom verify token" autoComplete="off" name="wa-verify-token" />
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>
                  A custom string you choose. Must match the <strong>Verify token</strong> you enter in Meta → App → WhatsApp → Configuration. Leave blank to use the server's default token.
                </div>
              </div>

              {/* Webhook Configuration */}
              <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
                <h4 style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: '0 0 2px' }}>Webhook configuration</h4>
                <p style={{ fontSize: 14, color: C.textMuted, margin: '0 0 10px' }}>Use this URL as the <strong>Callback URL</strong> in the Meta App Dashboard, with the verify token above.</p>
                <label style={labelStyle}>Webhook callback URL</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    readOnly
                    value={webhookUrl}
                    onFocus={e => e.target.select()}
                    style={{ ...inpStyle, fontFamily: 'DM Mono, monospace', fontSize: 14, background: 'var(--c-hover)', color: C.textSecondary }}
                  />
                  <button type="button" onClick={copyWebhookUrl} title={copied ? 'Copied!' : 'Copy URL'} style={{ flexShrink: 0, width: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, borderRadius: 8, cursor: 'pointer', color: copied ? C.green : C.textSecondary }}>
                    {copied ? <Check size={15} /> : <Copy size={15} />}
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 15, color: C.text, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.isDefault} onChange={e => setForm({ ...form, isDefault: e.target.checked })} /> Default account
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 15, color: C.text, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.isActive} onChange={e => setForm({ ...form, isActive: e.target.checked })} /> Active
                </label>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
              <button onClick={() => setShowForm(false)} disabled={saving} style={{ padding: '8px 16px', background: 'var(--c-cardBg)', color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ padding: '8px 16px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: saving ? 'wait' : 'pointer', fontFamily: FONT, display: 'flex', alignItems: 'center', gap: 6 }}>
                {saving && <Loader2 size={14} className="spin" />}
                {editing ? 'Save changes' : 'Create account'}
              </button>
            </div>
          </div>
        </div>
      )}

      <DeleteConfirmModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={doDelete}
        itemName={deleteTarget?.displayName || ''}
        itemType="WhatsApp account"
      />
    </div>
  );
}

const thStyle = { textAlign: 'left', padding: '12px 16px', fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.04em' };
const tdStyle = { padding: '14px 16px', fontSize: 15, color: C.text, verticalAlign: 'middle' };
const iconBtnStyle = { background: 'transparent', border: 'none', cursor: 'pointer', padding: 6, marginLeft: 4, color: C.textSecondary };

/*  Main Page                                                          */
/* ------------------------------------------------------------------ */
export default function AdminSettingsPage({ onLogout, onNavigate, subParts = [], navigate, user }) {
  // DERIVED from TABS, never restated. A hand-maintained copy silently drifts:
  // a tab missing from this list still RENDERS its button, and clicking it
  // falls through to visibleTabs[0] — so the tab appears to exist and does
  // nothing. That is exactly how the Message Costs tab shipped broken.
  const VALID_TABS = TABS.map(t => t.key);
  // Filter tabs to those this user is allowed to see. Admin sees everything;
  // non-admins must have 'admin-settings:<tab>' in their pages array.
  const isAdmin = user?.role === 'admin';
  const userPages = new Set(user?.pages || []);
  const visibleTabs = isAdmin
    ? TABS
    : TABS.filter(t => userPages.has(`admin-settings:${t.key}`));
  const allowedTabKeys = new Set(visibleTabs.map(t => t.key));
  const activeTab = VALID_TABS.includes(subParts[0]) && allowedTabKeys.has(subParts[0])
    ? subParts[0]
    : (visibleTabs[0]?.key || 'general');
  const setActiveTab = (t) => navigate ? navigate('admin-settings', t) : null;
  const [categories, setCategories] = useState([]);
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [categoryDetailId, setCategoryDetailId] = useState(null);
  const [showCategoryAddForm, setShowCategoryAddForm] = useState(false);

  const refresh = async () => {
    try {
      const [catRes, tagRes] = await Promise.all([
        api.categories.list(),
        api.tags.list(),
      ]);
      setCategories(catRes);
      setTags(tagRes);
    } catch (err) {
      console.error('Failed to load settings data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleTabChange = (key) => {
    setActiveTab(key);
    setCategoryDetailId(null);
  };

  const handleRequestAddCategory = () => {
    setShowCategoryAddForm(true);
    setActiveTab('category');
  };

  const renderTab = () => {
    if (loading) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.textMuted, fontSize: 15 }}>
          Loading…
        </div>
      );
    }
    switch (activeTab) {
      case 'general': return <GeneralTab onLogout={onLogout} user={user} />;
      case 'domains': return <DomainTab />;
      case 'tags': return (
        <TagsTab
          categories={categories}
          tags={tags}
          onRefresh={refresh}
        />
      );
      case 'category': return (
        <CategoryTab
          categories={categories}
          tags={tags}
          onRefresh={refresh}
          detailId={categoryDetailId}
          onViewDetail={setCategoryDetailId}
          onBack={() => setCategoryDetailId(null)}
          showAddForm={showCategoryAddForm}
          onAddFormShown={() => setShowCategoryAddForm(false)}
        />
      );
      case 'fields': return <FieldsTab />;
      case 'funnel': return <FunnelSettingsTab navigate={navigate} />;
      case 'whatsapp-accounts': return <WhatsappAccountsTab />;
      case 'ai-models': return <AIModelsTab navigate={navigate} />;
      case 'integrations': return <IntegrationsTab />;
      case 'mcp': return <McpToolsTab />;
      case 'users': return <UsersTab />;
      case 'webhooks': return <WebhooksTab />;
      default: return <GeneralTab onLogout={onLogout} user={user} />;
    }
  };

  return (
    <div style={{ display: 'flex', flex: 1, height: '100%', overflow: 'hidden', background: C.pageBg }}>
      <div style={{
        width: 240, minWidth: 240, background: 'var(--c-cardBg)',
        borderRight: `1px solid ${C.borderDark}`,
        display: 'flex', flexDirection: 'column', flexShrink: 0,
        padding: '16px 12px',
      }}>
        <button
          onClick={() => onNavigate('chats')}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 10px', marginBottom: 16, borderRadius: 8,
            border: 'none', background: 'transparent', cursor: 'pointer',
            fontFamily: FONT, fontSize: 15, fontWeight: 600,
            color: C.textSecondary, textAlign: 'left',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--c-xf0f2f5, #f0f2f5)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
        >
          <ArrowLeft size={16} /> Back to home
        </button>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12, paddingLeft: 8 }}>
          Settings
        </div>
        {visibleTabs.map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => handleTabChange(tab.key)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                padding: '9px 10px', borderRadius: 8, border: 'none',
                background: isActive ? 'var(--c-chatPanel, #f0f2f5)' : 'transparent',
                cursor: 'pointer', fontFamily: FONT, fontSize: 15,
                fontWeight: isActive ? 700 : 500,
                color: isActive ? C.text : C.textSecondary,
                textAlign: 'left', marginBottom: 2, transition: 'background .1s',
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--c-xf5f6f6, #f5f6f6)'; }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
            >
              <Icon size={16} strokeWidth={isActive ? 2.5 : 2} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {renderTab()}
    </div>
  );
}

// ─── Funnel Tab ───────────────────────────────────────────────────────────────
// Configure funnel stages (ordered, drag-to-reorder), lead sources, and products.
// Content lives in pages/sales/FunnelSettingsPage.jsx (also usable standalone).
function FunnelSettingsTab({ navigate }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 28, overflow: 'auto', fontFamily: FONT }}>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: C.text }}>Funnel</h2>
        <div style={{ fontSize: 15, color: C.textSecondary, marginTop: 4 }}>
          Configure your funnel stages, lead sources, and products. These drive the Sales → Funnel chart and the Sales Log.
        </div>
      </div>
      <FunnelSettingsContent navigate={navigate} />
    </div>
  );
}

// ─── Webhooks Tab ─────────────────────────────────────────────────────────────
// Lists every inbound Meta/n8n webhook payload, with filters + detail drawer +
// replay button. Used to debug parser issues, trigger evaluation, and to
// reproduce production payloads against local code.

const WEBHOOK_KIND_COLORS = {
  messages:                  { bg: 'var(--c-successBgSoft, #E4F3EE)', color: 'var(--c-successText, #0F6E56)', label: 'messages' },
  message_echoes:            { bg: 'var(--c-sdcedc8, #DCEDC8)', color: 'var(--c-x33691e, #33691E)', label: 'message_echoes' },
  smb_message_echoes:        { bg: 'var(--c-sc8e6c9, #C8E6C9)', color: 'var(--c-x1b5e20, #1B5E20)', label: 'smb_echoes' },
  statuses:                  { bg: 'var(--c-infoBg, #E3F2FD)', color: 'var(--c-infoText, #1565C0)', label: 'statuses' },
  template_status_update:    { bg: 'var(--c-orangeBg, #FFF3E0)', color: 'var(--c-orangeText, #E65100)', label: 'template_status_update' },
  account_update:            { bg: 'var(--c-purpleBg, #F3E5F5)', color: 'var(--c-x6a1b9a, #6A1B9A)', label: 'account_update' },
  verify:                    { bg: 'var(--c-surfaceSubtle, #EEEDE8)', color: 'var(--c-t4, #666)',    label: 'verify' },
  unknown:                   { bg: 'var(--c-surfaceSubtle, #EEEDE8)', color: 'var(--c-t4, #666)',    label: 'unknown' },
};
const WEBHOOK_STATUS_COLORS = {
  processed: { bg: 'var(--c-successBgSoft, #E4F3EE)', color: 'var(--c-successText, #0F6E56)' },
  partial:   { bg: 'var(--c-warnBgSoft, #FFF8E1)', color: 'var(--c-s7a5500, #7A5500)' },
  error:     { bg: 'var(--c-dangerBg, #FCEBEB)', color: 'var(--c-dangerText, #A32D2D)' },
  received:  { bg: 'var(--c-surfaceSubtle, #EEEDE8)', color: 'var(--c-t4, #666)' },
  verified:  { bg: 'var(--c-infoBg, #E3F2FD)', color: 'var(--c-infoText, #1565C0)' },
};

// Pretty-print JSON with simple syntax highlighting (string=green, number=blue,
// bool/null=purple, key=brown). Avoids dragging in a heavy JSON viewer lib.
function syntaxHighlight(json) {
  if (typeof json !== 'string') json = JSON.stringify(json, null, 2);
  // Escape HTML first
  json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = '#1565C0'; // number
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? '#7A5500' : '#0F6E56'; // key vs string
      } else if (/true|false/.test(match)) cls = '#6A1B9A';
      else if (/null/.test(match)) cls = '#A32D2D';
      return `<span style="color:${cls}">${match}</span>`;
    }
  );
}

function WebhookDetailDrawer({ id, onClose, onChanged }) {
  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showHeaders, setShowHeaders] = useState(false);
  const [copied, setCopied] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [replayResult, setReplayResult] = useState(null);

  useEffect(() => {
    setLoading(true);
    api.webhookEvents.get(id).then(e => { setEvent(e); setLoading(false); }).catch(err => { notify(err.message); setLoading(false); });
  }, [id]);

  const copyJson = async () => {
    await navigator.clipboard.writeText(JSON.stringify(event?.payload, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const replay = async () => {
    if (!confirm('Replay this payload through the webhook handler? This will re-insert chat_history rows and re-fire automation triggers.')) return;
    try {
      setReplaying(true);
      setReplayResult(null);
      const r = await api.webhookEvents.replay(id);
      setReplayResult({ ok: r.ok, msg: `Status ${r.status} · ${JSON.stringify(r.response).slice(0, 200)}` });
      onChanged?.();
    } catch (err) {
      setReplayResult({ ok: false, msg: err.message });
    } finally {
      setReplaying(false);
    }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 250, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 720, maxWidth: '94vw', height: '100%', background: 'var(--c-cardBg)', boxShadow: C.shadowLg, display: 'flex', flexDirection: 'column', fontFamily: FONT, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--c-borderSubtle, #EEEDE8)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-text)' }}>Webhook Event #{id}</div>
            {event && <div style={{ fontSize: 13, color: 'var(--c-t6, #888)', marginTop: 2 }}>{new Date(event.received_at).toLocaleString('en-IN')} · {event.source || 'meta'} · {event.remote_ip || '—'}</div>}
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--c-t4, #666)' }}><X size={20} /></button>
        </div>

        {loading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--c-t6, #888)' }}><Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /></div>}

        {!loading && event && (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {/* Processing summary */}
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--c-borderSubtle, #EEEDE8)', background: 'var(--c-hover)', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, fontSize: 13 }}>
              <div><div style={{ color: 'var(--c-t6, #888)', textTransform: 'uppercase', fontSize: 12, letterSpacing: '.05em', marginBottom: 2 }}>Status</div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 99, ...(WEBHOOK_STATUS_COLORS[event.processing_status] || WEBHOOK_STATUS_COLORS.received), fontSize: 13, fontWeight: 700 }}>
                  {event.processing_status === 'error' ? <AlertCircle size={11} /> : event.processing_status === 'processed' || event.processing_status === 'verified' ? <CheckCircle2 size={11} /> : null}
                  {event.processing_status}
                </span>
              </div>
              <div><div style={{ color: 'var(--c-t6, #888)', textTransform: 'uppercase', fontSize: 12, letterSpacing: '.05em', marginBottom: 2 }}>Records extracted</div>
                <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 15, fontWeight: 700, color: 'var(--c-text)' }}>{event.records_extracted ?? 0}</div>
              </div>
              <div><div style={{ color: 'var(--c-t6, #888)', textTransform: 'uppercase', fontSize: 12, letterSpacing: '.05em', marginBottom: 2 }}>Processing time</div>
                <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 15, fontWeight: 700, color: 'var(--c-text)' }}>{event.processing_ms != null ? `${event.processing_ms}ms` : '—'}</div>
              </div>
            </div>

            {event.processing_error && (
              <div style={{ margin: '12px 20px', padding: '10px 12px', background: 'var(--c-primaryLight)', color: 'var(--c-dangerText, #A32D2D)', borderRadius: 8, fontSize: 14, fontFamily: 'DM Mono, monospace' }}>
                <strong>Error:</strong> {event.processing_error}
              </div>
            )}

            {/* Actions row */}
            <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--c-borderSubtle, #EEEDE8)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={copyJson} style={btnSecondary}>
                {copied ? <CheckCircle2 size={12} /> : null} {copied ? 'Copied' : 'Copy payload'}
              </button>
              <button onClick={replay} disabled={replaying} style={{ ...btnSecondary, color: 'var(--c-primary, #dc2626)', borderColor: '#FCC' }}>
                {replaying ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={12} />} Replay
              </button>
              <button onClick={() => setShowHeaders(!showHeaders)} style={btnSecondary}>
                {showHeaders ? 'Hide' : 'Show'} headers
              </button>
            </div>

            {replayResult && (
              <div style={{ margin: '0 20px 12px', padding: '10px 12px', borderRadius: 8, fontSize: 14, background: replayResult.ok ? 'var(--c-successBgSoft, #E4F3EE)' : 'var(--c-primaryLight)', color: replayResult.ok ? 'var(--c-successText, #0F6E56)' : 'var(--c-dangerText, #A32D2D)' }}>
                {replayResult.ok ? '✓ ' : '⚠ '} {replayResult.msg}
              </div>
            )}

            {/* Headers (collapsed by default) */}
            {showHeaders && event.request_headers && (
              <div style={{ padding: '0 20px 12px' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-t4, #666)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.05em' }}>Request headers</div>
                <pre style={{ background: 'var(--c-hover)', border: '1px solid var(--c-borderSubtle, #EEEDE8)', borderRadius: 8, padding: 12, fontSize: 13, fontFamily: 'DM Mono, monospace', overflowX: 'auto', margin: 0 }}>{JSON.stringify(event.request_headers, null, 2)}</pre>
              </div>
            )}

            {/* Payload — pretty-printed with syntax highlighting */}
            <div style={{ padding: '0 20px 20px' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-t4, #666)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.05em', display: 'flex', justifyContent: 'space-between' }}>
                <span>Payload ({event.payload_kind || 'unknown'})</span>
                <span style={{ fontFamily: 'DM Mono, monospace', color: 'var(--c-t6, #888)', textTransform: 'none', letterSpacing: 0 }}>{JSON.stringify(event.payload).length.toLocaleString()} bytes</span>
              </div>
              <pre
                style={{ background: 'var(--c-hover)', border: '1px solid var(--c-borderSubtle, #EEEDE8)', borderRadius: 8, padding: 14, fontSize: 14, fontFamily: 'DM Mono, monospace', lineHeight: 1.5, overflowX: 'auto', margin: 0, color: 'var(--c-s333333, #333)' }}
                dangerouslySetInnerHTML={{ __html: syntaxHighlight(JSON.stringify(event.payload, null, 2)) }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const btnSecondary = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', border: '1px solid var(--c-borderStrong, #D5D5D0)', borderRadius: 6, background: 'var(--c-cardBg)', color: 'var(--c-s333333, #333)', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: FONT };

/* ------------------------------------------------------------------ */
/*  AI Models                                                          */
/* ------------------------------------------------------------------ */
const AI_PROVIDER_OPTIONS = [
  { value: 'openai',    label: 'OpenAI',          accent: '#10A37F' },
  { value: 'anthropic', label: 'Anthropic Claude', accent: '#C99B7A' },
  { value: 'kimi',      label: 'Moonshot / Kimi', accent: 'var(--c-x7e58c6, #7E58C6)' },
  { value: 'gemini',    label: 'Google Gemini',   accent: '#4285F4' },
];
const providerOpt = (v) => AI_PROVIDER_OPTIONS.find(o => o.value === v) || { label: v, accent: C.textMuted };

function AIModelsTab({ navigate }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ provider: 'openai', label: '', apiKey: '', baseUrl: '' });
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [revealedKeys, setRevealedKeys] = useState({}); // id -> plaintext key
  const [syncingId, setSyncingId] = useState(null);
  const [expandedModelsId, setExpandedModelsId] = useState(null);
  const [usageRow, setUsageRow] = useState(null);      // the credential we opened
  const [usageData, setUsageData] = useState(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState('');
  const [activityItems, setActivityItems] = useState([]);
  const [activityTotal, setActivityTotal] = useState(0);
  const [activityLoadingMore, setActivityLoadingMore] = useState(false);
  const [activityFiltering, setActivityFiltering] = useState(false);
  const [activityFilters, setActivityFilters] = useState({ status: 'all', model: '', from: '', to: '' });
  const ACTIVITY_PAGE = 20;
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [error, setError] = useState('');

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await api.aiModels.list();
      setItems(data);
    } catch (err) {
      console.error('[ai-models]', err);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); }, []);

  const openAdd = () => {
    setForm({ provider: 'openai', label: '', apiKey: '', baseUrl: '' });
    setError('');
    setShowKey(false);
    setShowForm(true);
  };

  const save = async () => {
    setError('');
    if (!form.provider) { setError('Pick a provider'); return; }
    if (!form.apiKey.trim()) { setError('API key is required'); return; }
    setSaving(true);
    try {
      await api.aiModels.create({
        provider: form.provider,
        label: form.label.trim() || null,
        apiKey: form.apiKey.trim(),
        baseUrl: form.baseUrl.trim() || null,
      });
      setShowForm(false);
      await refresh();
    } catch (err) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const toggleReveal = async (row) => {
    if (revealedKeys[row.id]) {
      setRevealedKeys(prev => { const c = { ...prev }; delete c[row.id]; return c; });
      return;
    }
    try {
      const r = await api.aiModels.get(row.id, true);
      setRevealedKeys(prev => ({ ...prev, [row.id]: r.apiKey }));
    } catch (err) {
      notify(err.message || 'Failed to reveal key');
    }
  };

  const toggleModelEnabled = async (row, modelId) => {
    const available = (row.availableModels || []).map(m => m.id);
    const currentEnabled = Array.isArray(row.enabledModels)
      ? row.enabledModels.filter(id => available.includes(id))
      : available.slice(); // null/undefined means all enabled
    const isOn = currentEnabled.includes(modelId);
    const next = isOn
      ? currentEnabled.filter(id => id !== modelId)
      : [...currentEnabled, modelId];
    // Optimistic update
    setItems(prev => prev.map(it => it.id === row.id ? { ...it, enabledModels: next } : it));
    try {
      await api.aiModels.update(row.id, { enabledModels: next });
    } catch (err) {
      notify(err.message || 'Failed to update selection');
      await refresh();
    }
  };

  const openUsage = async (row) => {
    setUsageRow(row);
    setUsageData(null);
    setUsageError('');
    setActivityItems([]);
    setActivityTotal(0);
    setActivityFilters({ status: 'all', model: '', from: '', to: '' });
    setUsageLoading(true);
    try {
      const data = await api.aiModels.usage(row.id);
      setUsageData(data);
      setActivityItems(data.recentCalls || []);
      setActivityTotal(data.activity?.total ?? (data.recentCalls?.length || 0));
    } catch (err) {
      setUsageError(err.message || 'Failed to load usage');
    } finally {
      setUsageLoading(false);
    }
  };
  const loadMoreActivity = async () => {
    if (!usageRow || activityLoadingMore || activityItems.length >= activityTotal) return;
    setActivityLoadingMore(true);
    try {
      const page = await api.aiModels.activity(usageRow.id, { limit: ACTIVITY_PAGE, offset: activityItems.length, ...activityFilters });
      setActivityItems(prev => [...prev, ...(page.items || [])]);
      setActivityTotal(page.total);
    } catch (err) {
      notify(err.message || 'Failed to load more activity');
    } finally {
      setActivityLoadingMore(false);
    }
  };

  // Called whenever a filter changes — refetches page 1 with the new filters
  const applyActivityFilters = async (nextFilters) => {
    if (!usageRow) return;
    setActivityFilters(nextFilters);
    setActivityFiltering(true);
    try {
      const page = await api.aiModels.activity(usageRow.id, { limit: ACTIVITY_PAGE, offset: 0, ...nextFilters });
      setActivityItems(page.items || []);
      setActivityTotal(page.total);
    } catch (err) {
      notify(err.message || 'Failed to filter activity');
    } finally {
      setActivityFiltering(false);
    }
  };
  const closeUsage = () => {
    setUsageRow(null);
    setUsageData(null);
    setUsageError('');
    setActivityItems([]);
    setActivityTotal(0);
  };

  const syncOne = async (row) => {
    setSyncingId(row.id);
    try {
      await api.aiModels.sync(row.id);
      await refresh();
    } catch (err) {
      notify(err.message || 'Sync failed');
    } finally {
      setSyncingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleteConfirmText.trim().toLowerCase() !== 'delete') return;
    try {
      await api.aiModels.delete(deleteTarget.id);
      setDeleteTarget(null);
      setDeleteConfirmText('');
      await refresh();
    } catch (err) {
      notify(err.message || 'Delete failed');
    }
  };

  const fmtDate = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  const inpStyle = { width: '100%', padding: '8px 12px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 15, fontFamily: FONT, outline: 'none', background: 'var(--c-cardBg)', color: C.text };
  const labelStyle = { display: 'block', fontSize: 13, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, fontFamily: FONT };

  return (
    <div style={{ flex: 1, padding: 24, overflow: 'auto', fontFamily: FONT }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: 0 }}>AI Models</h2>
          <p style={{ fontSize: 14, color: C.textMuted, margin: '4px 0 0' }}>
            Connect AI provider API keys. Available models are discovered automatically on save.
          </p>
        </div>
        <button onClick={openAdd} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 14px', background: C.primary, color: '#fff', border: 'none',
          borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
        }}>
          <Plus size={15} /> Add AI Model
        </button>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: C.textMuted, fontSize: 15 }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, borderRadius: 10, color: C.textMuted, fontSize: 15 }}>
          No AI models connected yet. Click "Add AI Model" to connect your first provider.
        </div>
      ) : (
        <div style={{ background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15, tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '18%' }}/>
              <col style={{ width: '22%' }}/>
              <col style={{ width: '30%' }}/>
              <col style={{ width: '12%' }}/>
              <col style={{ width: '18%', minWidth: 210 }}/>
            </colgroup>
            <thead>
              <tr style={{ background: C.pageBg, borderBottom: `1px solid ${C.border}` }}>
                <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Provider</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>API Key</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Available Models</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Created</th>
                <th style={{ textAlign: 'right', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em', width: 130 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map(row => {
                const prov = providerOpt(row.provider);
                const models = Array.isArray(row.availableModels) ? row.availableModels : [];
                const revealed = revealedKeys[row.id];
                return (
                  <tr key={row.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td onClick={() => openUsage(row)} title="Click to open usage dashboard" style={{ padding: '12px 16px', verticalAlign: 'top', cursor: 'pointer' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: prov.accent, flexShrink: 0 }}/>
                        <div>
                          <div style={{ fontWeight: 600, color: C.text, textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}>{prov.label}</div>
                          {row.label && <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>{row.label}</div>}
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '12px 16px', verticalAlign: 'top', fontFamily: 'DM Mono, monospace', fontSize: 14 }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, minWidth: 0 }}>
                        <span style={{
                          color: revealed ? C.text : C.textSecondary,
                          flex: 1,
                          minWidth: 0,
                          wordBreak: 'break-all',
                          overflowWrap: 'anywhere',
                        }}>
                          {revealed || row.apiKeyMasked || '••••••'}
                        </span>
                        <button onClick={() => toggleReveal(row)} title={revealed ? 'Hide' : 'Reveal'} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: C.textMuted, display: 'inline-flex', padding: 2, flexShrink: 0 }}>
                          {revealed ? <EyeOff size={14}/> : <Eye size={14}/>}
                        </button>
                      </div>
                    </td>
                    <td style={{ padding: '12px 16px', verticalAlign: 'top' }}>
                      {models.length === 0 ? (
                        <span style={{ color: C.textMuted, fontSize: 14, fontStyle: 'italic' }}>none cached</span>
                      ) : (() => {
                        const isExpanded = expandedModelsId === row.id;
                        const enabledList = Array.isArray(row.enabledModels)
                          ? row.enabledModels
                          : models.map(m => m.id); // null = all enabled
                        const enabledSet = new Set(enabledList);
                        const enabledModels = models.filter(m => enabledSet.has(m.id));
                        const disabledModels = models.filter(m => !enabledSet.has(m.id));
                        const visibleEnabled = isExpanded ? enabledModels : enabledModels.slice(0, 6);
                        return (
                          <>
                            {/* Enabled chips (collapsed view shows these) */}
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                              {visibleEnabled.length === 0 && !isExpanded && (
                                <span style={{ fontSize: 13, color: C.textMuted, fontStyle: 'italic' }}>No models enabled</span>
                              )}
                              {visibleEnabled.map((m, i) => (
                                <button
                                  key={'on'+i}
                                  type="button"
                                  onClick={() => toggleModelEnabled(row, m.id)}
                                  title={`Click to disable. ${m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id}`}
                                  style={{
                                    fontSize: 13, fontFamily: 'DM Mono, monospace', padding: '2px 8px',
                                    background: 'var(--c-successBgSoft, #E5F2EE)', color: 'var(--c-successText, #0F6E56)', borderRadius: 999,
                                    border: '1px solid var(--c-successBorder, #B8DCCF)', cursor: 'pointer',
                                  }}>
                                  {m.id}
                                </button>
                              ))}
                              {!isExpanded && enabledModels.length > 6 && (
                                <span style={{ fontSize: 13, color: C.textMuted, alignSelf: 'center' }}>+{enabledModels.length - 6} more</span>
                              )}
                            </div>

                            {/* Expanded: show disabled chips and a counter */}
                            {isExpanded && disabledModels.length > 0 && (
                              <>
                                <div style={{ fontSize: 12, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginTop: 8, marginBottom: 4 }}>Disabled — click to enable</div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                  {disabledModels.map((m, i) => (
                                    <button
                                      key={'off'+i}
                                      type="button"
                                      onClick={() => toggleModelEnabled(row, m.id)}
                                      title={`Click to enable. ${m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id}`}
                                      style={{
                                        fontSize: 13, fontFamily: 'DM Mono, monospace', padding: '2px 8px',
                                        background: 'var(--c-surfaceInner, #F8F8F4)', color: C.textMuted, borderRadius: 999,
                                        border: `1px dashed ${C.border}`, cursor: 'pointer',
                                        textDecoration: 'line-through',
                                      }}>
                                      {m.id}
                                    </button>
                                  ))}
                                </div>
                              </>
                            )}

                            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 10 }}>
                              <button
                                type="button"
                                onClick={() => setExpandedModelsId(isExpanded ? null : row.id)}
                                style={{ background: 'transparent', border: 'none', color: C.primary, fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: FONT }}>
                                {isExpanded ? 'Done' : `Manage (${enabledModels.length}/${models.length} enabled)`}
                              </button>
                            </div>
                          </>
                        );
                      })()}
                      {row.lastSyncError && (
                        <div style={{ marginTop: 6, fontSize: 13, color: 'var(--c-dangerText, #A32D2D)' }}>Last sync error: {row.lastSyncError}</div>
                      )}
                    </td>
                    <td style={{ padding: '12px 16px', verticalAlign: 'top', color: C.textSecondary, fontSize: 14 }}>{fmtDate(row.createdAt)}</td>
                    <td style={{ padding: '12px 16px', verticalAlign: 'top' }}>
                      <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap', gap: 6, justifyContent: 'flex-end' }}>
                        <button onClick={() => syncOne(row)} disabled={syncingId === row.id} title="Refresh available models" style={{ ...btnSecondary, opacity: syncingId === row.id ? 0.6 : 1, whiteSpace: 'nowrap' }}>
                          {syncingId === row.id ? <Loader2 size={12} className="spin"/> : <RefreshCw size={12}/>}
                          {syncingId === row.id ? 'Syncing' : 'Sync'}
                        </button>
                        <button onClick={() => { setDeleteTarget(row); setDeleteConfirmText(''); }} title="Delete" style={{ ...btnSecondary, color: 'var(--c-dangerText, #A32D2D)', borderColor: '#F3D4D4', whiteSpace: 'nowrap' }}>
                          <Trash2 size={12}/> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add modal */}
      {showForm && (
        <div onClick={() => !saving && setShowForm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, boxShadow: C.shadowLg, width: 460, padding: 24, fontFamily: FONT }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>Add AI Model</h3>
            <p style={{ margin: '4px 0 18px', fontSize: 14, color: C.textMuted }}>
              Your key will be encrypted at rest. We'll call the provider's models endpoint to verify it works.
            </p>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Provider</label>
              <SearchableSelect
                value={form.provider}
                onChange={v => setForm(f => ({ ...f, provider: v, baseUrl: '' }))}
                options={AI_PROVIDER_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
                searchPlaceholder="Search providers…"
                style={{ width: '100%' }}
                triggerStyle={{ padding: '8px 32px 8px 12px' }}
              />
            </div>

            {form.provider === 'kimi' && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Custom Base URL (optional)</label>
                <input
                  value={form.baseUrl}
                  onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))}
                  placeholder="e.g. https://api.moonshot.ai/v1"
                  style={{ ...inpStyle, fontFamily: 'DM Mono, monospace', fontSize: 14 }}
                />
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4, lineHeight: 1.4 }}>
                  Leave blank for Moonshot's own platforms (<code>api.moonshot.ai</code> / <code>api.moonshot.cn</code>).
                  For Kimi Code (<code>sk-kimi-…</code> keys), OpenRouter, or another gateway, paste the API root from that service's docs. We append <code>/models</code> automatically.
                </div>
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Label (optional)</label>
              <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="e.g. Marketing OpenAI account" style={inpStyle}/>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>API Key</label>
              <div style={{ position: 'relative' }}>
                <input type={showKey ? 'text' : 'password'} value={form.apiKey} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))} placeholder="sk-…" style={{ ...inpStyle, paddingRight: 36, fontFamily: 'DM Mono, monospace' }}/>
                <button type="button" onClick={() => setShowKey(s => !s)} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', cursor: 'pointer', color: C.textMuted, padding: 4 }}>
                  {showKey ? <EyeOff size={14}/> : <Eye size={14}/>}
                </button>
              </div>
            </div>

            {error && (
              <div style={{ padding: '8px 12px', background: 'var(--c-primaryLight)', color: 'var(--c-dangerText, #A32D2D)', borderRadius: 8, fontSize: 14, marginBottom: 14 }}>{error}</div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowForm(false)} disabled={saving} style={{ ...btnSecondary, padding: '8px 14px', fontSize: 15 }}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ padding: '8px 14px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: saving ? 'wait' : 'pointer', fontFamily: FONT, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {saving && <Loader2 size={13} className="spin"/>}
                {saving ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Type-to-confirm delete modal */}
      {deleteTarget && (
        <div onClick={() => setDeleteTarget(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, boxShadow: C.shadowLg, width: 420, padding: 24, fontFamily: FONT }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>Delete AI Model</h3>
            <p style={{ margin: '8px 0 14px', fontSize: 15, color: C.textSecondary }}>
              This will remove the connection to <strong>{providerOpt(deleteTarget.provider).label}</strong>
              {deleteTarget.label ? <> ({deleteTarget.label})</> : null}. The encrypted API key will be deleted from the database.
            </p>
            <label style={labelStyle}>Type "delete" to confirm</label>
            <input value={deleteConfirmText} onChange={e => setDeleteConfirmText(e.target.value)} autoFocus style={inpStyle}/>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={() => { setDeleteTarget(null); setDeleteConfirmText(''); }} style={{ ...btnSecondary, padding: '8px 14px', fontSize: 15 }}>Cancel</button>
              <button
                onClick={confirmDelete}
                disabled={deleteConfirmText.trim().toLowerCase() !== 'delete'}
                style={{
                  padding: '8px 14px', background: deleteConfirmText.trim().toLowerCase() === 'delete' ? '#A32D2D' : 'var(--c-borderStrong, #D5D5D0)',
                  color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600,
                  cursor: deleteConfirmText.trim().toLowerCase() === 'delete' ? 'pointer' : 'not-allowed', fontFamily: FONT,
                }}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Usage dashboard modal */}
      {usageRow && (
        <div onClick={closeUsage} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, boxShadow: C.shadowLg, width: 560, maxHeight: 'calc(100vh - 32px)', overflow: 'auto', fontFamily: FONT }}>
            {/* Header */}
            <div style={{ padding: '20px 24px 14px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: providerOpt(usageRow.provider).accent }}/>
                <div>
                  <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>{providerOpt(usageRow.provider).label}</h3>
                  <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>{usageRow.label || 'Usage dashboard'}</div>
                </div>
              </div>
              <button onClick={closeUsage} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: C.textMuted, padding: 4 }}><X size={18}/></button>
            </div>

            {/* Body */}
            <div style={{ padding: '18px 24px 22px' }}>
              {usageLoading ? (
                <div style={{ padding: 40, textAlign: 'center', color: C.textMuted, fontSize: 15 }}>
                  <Loader2 size={18} className="spin" style={{ verticalAlign: 'middle', marginRight: 8 }}/>
                  Probing live connection and aggregating usage…
                </div>
              ) : usageError ? (
                <div style={{ padding: '12px 14px', background: 'var(--c-primaryLight)', color: 'var(--c-dangerText, #A32D2D)', borderRadius: 8, fontSize: 15 }}>{usageError}</div>
              ) : usageData ? (() => {
                const c = usageData.connection || {};
                const u = usageData.usage || {};
                const successRate = u.totalCalls > 0 ? Math.round((u.successfulCalls / u.totalCalls) * 100) : null;
                const tile = (label, value, sub) => (
                  <div key={label} style={{ background: C.pageBg, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 6 }}>{label}</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: C.text, fontFamily: 'DM Mono, monospace', lineHeight: 1 }}>{value}</div>
                    {sub && <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>{sub}</div>}
                  </div>
                );
                const fmtNum = (n) => Number(n || 0).toLocaleString();
                const fmtTime = (iso) => {
                  if (!iso) return '—';
                  try { return new Date(iso).toLocaleString(); } catch { return iso; }
                };
                const statusColors = {
                  healthy: { bg: 'var(--c-successBgSoft, #E5F2EE)', fg: 'var(--c-successText, #0F6E56)', dot: 'var(--c-successText, #0F6E56)', label: 'Healthy' },
                  error:   { bg: 'var(--c-dangerBg, #FCEBEB)', fg: 'var(--c-dangerText, #A32D2D)', dot: 'var(--c-dangerText, #A32D2D)', label: 'Error' },
                  unknown: { bg: 'var(--c-surfaceMuted, #F4F4EE)', fg: 'var(--c-t4, #666)',    dot: 'var(--c-t7, #999)',    label: 'Unknown' },
                };
                const sc = statusColors[c.status] || statusColors.unknown;
                return (
                  <>
                    {/* Connection status banner */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: sc.bg, color: sc.fg, borderRadius: 8, fontSize: 14, marginBottom: 16 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: sc.dot, flexShrink: 0 }}/>
                      <div style={{ flex: 1 }}>
                        <strong>{sc.label}</strong> — {c.status === 'healthy' ? `Live ping to ${usageRow.provider === 'kimi' ? (usageData.credential.baseUrl || 'Moonshot') : providerOpt(usageRow.provider).label}'s /models endpoint succeeded.` : (c.error || 'No live status available.')}
                      </div>
                      <span style={{ fontSize: 12, color: sc.fg, opacity: .7 }}>checked {fmtTime(c.checkedAt)}</span>
                    </div>

                    {/* Metric tiles */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 14 }}>
                      {tile('AI calls',     fmtNum(u.totalCalls),     successRate != null ? `${successRate}% success · ${u.failedCalls} failed` : 'No calls yet')}
                      {tile('Total tokens', fmtNum(u.totalTokens),    u.totalCalls > 0 ? `~${Math.round((u.totalTokens || 0) / u.totalCalls)} avg/call` : '—')}
                      {tile('Prompt tokens',     fmtNum(u.promptTokens),      'input to the model')}
                      {tile('Completion tokens', fmtNum(u.completionTokens),  'response from the model')}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
                      {tile('Last used',  fmtTime(u.lastUsedAt),  u.firstUsedAt ? `since ${fmtTime(u.firstUsedAt)}` : 'never')}
                      {tile('Last synced (model list)', fmtTime(usageData.credential.lastSyncedAt), usageData.credential.lastSyncError ? `Sync error: ${usageData.credential.lastSyncError}` : 'OK')}
                    </div>

                    {/* Recent activity log (filterable, paginated, click-through) */}
                    {(activityItems.length > 0 || activityFilters.status !== 'all' || activityFilters.model || activityFilters.from || activityFilters.to) && (() => {
                      const fmtRel = (iso) => {
                        if (!iso) return '—';
                        const d = new Date(iso);
                        const ms = Date.now() - d.getTime();
                        const m = Math.floor(ms / 60000);
                        if (m < 1) return 'just now';
                        if (m < 60) return `${m}m ago`;
                        const h = Math.floor(m / 60);
                        if (h < 24) return `${h}h ago`;
                        const days = Math.floor(h / 24);
                        return `${days}d ago`;
                      };
                      const excerpt = (v, max = 70) => {
                        if (v == null) return '';
                        const s = typeof v === 'string' ? v : JSON.stringify(v);
                        return s.length > max ? s.slice(0, max) + '…' : s;
                      };
                      const remaining = Math.max(0, activityTotal - activityItems.length);
                      const modelOptions = (usageData.usage?.byModel || []).map(m => m.modelId).filter(Boolean);
                      const f = activityFilters;
                      const filterInputStyle = { padding: '5px 9px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, fontFamily: FONT, background: 'var(--c-cardBg)', color: C.text, outline: 'none' };
                      const setF = (patch) => applyActivityFilters({ ...f, ...patch });
                      const filterActive = f.status !== 'all' || f.model || f.from || f.to;
                      return (
                        <>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, marginTop: 14 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '.04em' }}>Recent activity</div>
                            <div style={{ fontSize: 13, color: C.textMuted, fontFamily: 'DM Mono, monospace' }}>
                              {activityFiltering ? 'filtering…' : `showing ${activityItems.length} of ${activityTotal}`}
                            </div>
                          </div>

                          {/* Filter row */}
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
                            <SearchableSelect
                              value={f.status}
                              onChange={v => setF({ status: v })}
                              options={[
                                { value: 'all', label: 'All statuses' },
                                { value: 'success', label: 'Success' },
                                { value: 'error', label: 'Error' },
                              ]}
                              style={{ minWidth: 130 }}
                              triggerStyle={{ padding: '5px 28px 5px 9px', fontSize: 13, borderWidth: 1, borderRadius: 6 }}
                            />
                            <SearchableSelect
                              value={f.model}
                              onChange={v => setF({ model: v })}
                              options={[{ value: '', label: 'All models' }, ...modelOptions.map(m => ({ value: m, label: m }))]}
                              placeholder="All models"
                              searchPlaceholder="Search models…"
                              style={{ minWidth: 150 }}
                              triggerStyle={{ padding: '5px 28px 5px 9px', fontSize: 13, borderWidth: 1, borderRadius: 6 }}
                            />
                            <input type="date" value={f.from} onChange={e => setF({ from: e.target.value })} title="From date" style={filterInputStyle}/>
                            <input type="date" value={f.to}   onChange={e => setF({ to:   e.target.value })} title="To date"   style={filterInputStyle}/>
                            {filterActive && (
                              <button type="button" onClick={() => applyActivityFilters({ status: 'all', model: '', from: '', to: '' })}
                                style={{ padding: '5px 10px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, fontWeight: 600, color: C.textSecondary, cursor: 'pointer', fontFamily: FONT }}>
                                Clear filters
                              </button>
                            )}
                          </div>

                          {activityItems.length === 0 ? (
                            <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: 24, textAlign: 'center', fontSize: 14, color: C.textMuted }}>
                              No calls match the current filters.
                            </div>
                          ) : (
                          <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
                            {activityItems.map((call) => (
                              <div
                                key={call.stepId}
                                onClick={() => {
                                  if (!call.automationId || !call.executionId) return;
                                  closeUsage();
                                  if (navigate) navigate('chatbot-builder', call.automationId, 'executions', call.executionId);
                                }}
                                title={call.automationId ? `Click to open execution #${call.executionId} in ${call.automationName || 'automation'}` : ''}
                                style={{
                                  padding: '10px 12px', borderTop: `1px solid ${C.border}`,
                                  fontSize: 14, lineHeight: 1.45,
                                  cursor: call.automationId ? 'pointer' : 'default',
                                  transition: 'background .12s',
                                }}
                                onMouseEnter={e => { if (call.automationId) e.currentTarget.style.background = 'var(--c-xfafaf7, #FAFAF7)'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = ''; }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                  <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: call.status === 'success' ? '#0F6E56' : call.status === 'error' ? '#A32D2D' : '#999' }}/>
                                  <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 13, color: C.text }}>{call.modelId || '(unknown)'}</span>
                                  {call.automationName && (
                                    <>
                                      <span style={{ color: C.textMuted, fontSize: 13 }}>·</span>
                                      <span style={{ color: C.textSecondary, fontSize: 13 }}>{call.automationName}</span>
                                    </>
                                  )}
                                  <span style={{ color: C.textMuted, fontSize: 13 }}>·</span>
                                  <span style={{ color: C.textMuted, fontSize: 13 }} title={call.startedAt}>{fmtRel(call.startedAt)}</span>
                                  <span style={{ flex: 1 }}/>
                                  {call.totalTokens != null && (
                                    <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 13, color: C.textSecondary }} title={`${call.promptTokens || 0} prompt + ${call.completionTokens || 0} completion`}>
                                      {call.totalTokens.toLocaleString()} tok
                                    </span>
                                  )}
                                  {call.elapsedMs != null && (
                                    <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 13, color: C.textMuted }}>{call.elapsedMs}ms</span>
                                  )}
                                </div>
                                {call.userMessage && (
                                  <div style={{ marginLeft: 15, color: C.textSecondary, fontSize: 13 }}>
                                    <span style={{ color: C.textMuted }}>in: </span>{excerpt(call.userMessage)}
                                  </div>
                                )}
                                {call.status === 'error' ? (
                                  <div style={{ marginLeft: 15, color: 'var(--c-dangerText, #A32D2D)', fontSize: 13 }}>
                                    <span style={{ color: 'var(--c-dangerText, #A32D2D)', opacity: .7 }}>error: </span>{excerpt(call.errorMessage, 120)}
                                  </div>
                                ) : call.aiResponse ? (
                                  <div style={{ marginLeft: 15, color: C.text, fontSize: 13, fontFamily: 'DM Mono, monospace' }}>
                                    <span style={{ color: C.textMuted, fontFamily: 'DM Sans, sans-serif' }}>out: </span>{excerpt(call.aiResponse, 100)}
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                          )}
                          {activityItems.length > 0 && remaining > 0 && (
                            <button
                              type="button"
                              onClick={loadMoreActivity}
                              disabled={activityLoadingMore}
                              style={{
                                marginTop: 10, width: '100%',
                                padding: '8px 12px', background: 'var(--c-cardBg)',
                                border: `1px solid ${C.border}`, borderRadius: 8,
                                fontSize: 14, fontWeight: 600, fontFamily: FONT,
                                color: C.text, cursor: activityLoadingMore ? 'wait' : 'pointer',
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                              }}>
                              {activityLoadingMore && <Loader2 size={12} className="spin"/>}
                              {activityLoadingMore ? 'Loading…' : `Load more (${remaining} remaining)`}
                            </button>
                          )}
                        </>
                      );
                    })()}

                    {/* Per-model breakdown */}
                    {u.byModel && u.byModel.length > 0 && (
                      <>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>Usage by model</div>
                        <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
                          {u.byModel.map((m, i) => (
                            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderTop: i === 0 ? 'none' : `1px solid ${C.border}`, fontSize: 14 }}>
                              <span style={{ fontFamily: 'DM Mono, monospace', color: C.text }}>{m.modelId || '(unknown)'}</span>
                              <span style={{ color: C.textSecondary }}>
                                <span style={{ fontFamily: 'DM Mono, monospace' }}>{fmtNum(m.calls)}</span> calls · <span style={{ fontFamily: 'DM Mono, monospace' }}>{fmtNum(m.tokens)}</span> tok
                              </span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                );
              })() : null}
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}.spin{animation:spin 1s linear infinite}`}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Users                                                              */
/* ------------------------------------------------------------------ */
// ⚠ Roles are DATA, loaded from /roles. A hardcoded list here would not show a
// role someone added in this very screen — the drift that makes a control look
// broken. Admin keeps a distinct colour because it is the one role with
// unconditional access.
function RoleBadge({ role, roles = [] }) {
  const meta = roles.find(r => r.key === role);
  const styles = role === 'admin'
    ? { bg: 'var(--c-successBgSoft, #E5F2EE)', fg: 'var(--c-successText, #0F6E56)' }
    : { bg: 'var(--c-orangeBg, #FFF3E0)', fg: 'var(--c-sb04e0e, #B04E0E)' };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 8px', borderRadius: 999, background: styles.bg, color: styles.fg, fontSize: 13, fontWeight: 700 }}>
      {meta?.label || role}
    </span>
  );
}

/**
 * Role management, in the same screen as the users who hold the roles.
 *
 * ⚠ Admin is rendered read-only apart from its name. It is not a UI nicety —
 * the backend refuses the same edits. This screen is admin-gated, so a role
 * change that removed admin access would lock everyone out of the only place
 * that could put it back.
 */
function RolesPanel({ roles, allPages, users, onRefresh }) {
  const [editing, setEditing] = useState(null);   // role key, or '__new__'
  const [form, setForm] = useState({ key: '', label: '', description: '', pages: [] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const countFor = (key) => users.filter(u => u.role === key).length;

  const openNew = () => {
    setErr(''); setEditing('__new__');
    setForm({ key: '', label: '', description: '', pages: [] });
  };
  const openEdit = (r) => {
    setErr(''); setEditing(r.key);
    setForm({ key: r.key, label: r.label, description: r.description || '', pages: [...(r.pages || [])] });
  };

  const togglePage = (p) => setForm(f => ({
    ...f,
    pages: f.pages.includes(p) ? f.pages.filter(x => x !== p) : [...f.pages, p],
  }));

  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (editing === '__new__') {
        await api.roles.create({ key: form.key, label: form.label, description: form.description, pages: form.pages });
      } else {
        const isAdminRole = editing === 'admin';
        await api.roles.update(editing, isAdminRole
          ? { label: form.label, description: form.description }
          : { label: form.label, description: form.description, pages: form.pages });
      }
      setEditing(null);
      await onRefresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const remove = async (r) => {
    setBusy(true); setErr('');
    try { await api.roles.delete(r.key); await onRefresh(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const inp = { width: '100%', padding: '8px 12px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 15, fontFamily: FONT, outline: 'none', background: 'var(--c-cardBg)', color: C.text };
  const lbl = { display: 'block', fontSize: 13, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 };

  return (
    <div style={{ background: 'var(--c-surfaceAlt)', border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Roles</div>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>
            A role is a named set of pages. Give it to a user above.
          </div>
        </div>
        <button onClick={openNew} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'var(--c-cardBg)', color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
          <Plus size={14} /> Add role
        </button>
      </div>

      {err && <div style={{ background: 'var(--c-dangerBg)', color: 'var(--c-dangerText)', padding: '8px 12px', borderRadius: 8, fontSize: 14, marginBottom: 10 }}>{err}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {roles.map(r => (
          <div key={r.key} style={{ background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <RoleBadge role={r.key} roles={roles} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, color: C.textSecondary }}>{r.description || '—'}</div>
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2, fontFamily: MONO }}>
                  {r.key} · {r.isSystem ? 'all pages' : `${(r.pages || []).length} pages`} · {countFor(r.key)} user{countFor(r.key) === 1 ? '' : 's'}
                </div>
              </div>
              <button onClick={() => openEdit(r)} style={{ padding: '5px 10px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 14, cursor: 'pointer', color: C.text, fontFamily: FONT }}>Edit</button>
              {!r.isSystem && (
                <button onClick={() => remove(r)} disabled={busy} style={{ padding: '5px 10px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 14, cursor: 'pointer', color: 'var(--c-dangerText)', fontFamily: FONT }}>Delete</button>
              )}
            </div>

            {editing === r.key && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
                <label style={lbl}>Name</label>
                <input style={inp} value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} />
                <label style={{ ...lbl, marginTop: 10 }}>Description</label>
                <input style={inp} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
                {r.isSystem ? (
                  <div style={{ fontSize: 13, color: C.textMuted, marginTop: 10 }}>
                    Admin always has every page. It cannot be switched off or narrowed — otherwise nobody could reach these settings to change it back.
                  </div>
                ) : (
                  <>
                    <label style={{ ...lbl, marginTop: 12 }}>Pages ({form.pages.length})</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 220, overflow: 'auto' }}>
                      {allPages.map(p => (
                        <button key={p} onClick={() => togglePage(p)}
                          style={{
                            padding: '4px 9px', borderRadius: 999, fontSize: 13, fontFamily: MONO, cursor: 'pointer',
                            border: `1px solid ${form.pages.includes(p) ? 'var(--c-successText)' : C.border}`,
                            background: form.pages.includes(p) ? 'var(--c-successBg)' : 'transparent',
                            color: form.pages.includes(p) ? 'var(--c-successText)' : C.textSecondary,
                          }}>{p}</button>
                      ))}
                    </div>
                  </>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button onClick={save} disabled={busy} style={{ padding: '7px 14px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>Save</button>
                  <button onClick={() => setEditing(null)} style={{ padding: '7px 14px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, cursor: 'pointer', color: C.text, fontFamily: FONT }}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        ))}

        {editing === '__new__' && (
          <div style={{ background: 'var(--c-cardBg)', border: `1px dashed ${C.border}`, borderRadius: 8, padding: 12 }}>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Name</label>
                <input style={inp} autoFocus value={form.label}
                  onChange={e => setForm({
                    ...form, label: e.target.value,
                    // The id is derived while it is untouched, then left alone —
                    // it is IMMUTABLE once saved, because users store it.
                    key: form.key || '',
                  })}
                  onBlur={() => setForm(f => ({
                    ...f,
                    key: f.key || f.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30),
                  }))}
                  placeholder="e.g. Support" />
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Id (permanent)</label>
                <input style={{ ...inp, fontFamily: MONO }} value={form.key}
                  onChange={e => setForm({ ...form, key: e.target.value.toLowerCase() })} placeholder="support" />
              </div>
            </div>
            <label style={{ ...lbl, marginTop: 10 }}>Description</label>
            <input style={inp} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
            <label style={{ ...lbl, marginTop: 12 }}>Pages ({form.pages.length})</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 220, overflow: 'auto' }}>
              {allPages.map(p => (
                <button key={p} onClick={() => togglePage(p)}
                  style={{
                    padding: '4px 9px', borderRadius: 999, fontSize: 13, fontFamily: MONO, cursor: 'pointer',
                    border: `1px solid ${form.pages.includes(p) ? 'var(--c-successText)' : C.border}`,
                    background: form.pages.includes(p) ? 'var(--c-successBg)' : 'transparent',
                    color: form.pages.includes(p) ? 'var(--c-successText)' : C.textSecondary,
                  }}>{p}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={save} disabled={busy || !form.label.trim()} style={{ padding: '7px 14px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>Create role</button>
              <button onClick={() => setEditing(null)} style={{ padding: '7px 14px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, cursor: 'pointer', color: C.text, fontFamily: FONT }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function UsersTab() {
  const [users, setUsers] = useState([]);
  const [waAccounts, setWaAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ username: '', email: '', displayName: '', password: '', role: 'sales', isActive: true, assignedWaNumbers: [] });
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [credentials, setCredentials] = useState(null);   // { email, password, action } shown one-time
  const [resetting, setResetting] = useState(null);
  const [resetPwInput, setResetPwInput] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteText, setDeleteText] = useState('');
  const [roles, setRoles] = useState([]);
  const [allPages, setAllPages] = useState([]);
  const [manageRoles, setManageRoles] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const [u, w, r] = await Promise.all([api.users.list(), api.whatsappAccounts.list(), api.roles.list()]);
      setUsers(u);
      setWaAccounts(w);
      setRoles(r.roles || []);
      setAllPages(r.pages || []);
    } catch (err) {
      console.error('[users]', err);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); }, []);

  const inpStyle = { width: '100%', padding: '8px 12px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 15, fontFamily: FONT, outline: 'none', background: 'var(--c-cardBg)', color: C.text };
  const labelStyle = { display: 'block', fontSize: 13, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, fontFamily: FONT };

  const openCreate = () => {
    setEditing(null);
    setForm({ username: '', email: '', displayName: '', password: '', role: 'sales', isActive: true, assignedWaNumbers: [] });
    setShowPw(false);
    setError('');
    setShowForm(true);
  };
  const openEdit = (user) => {
    setEditing(user);
    setForm({
      username: user.username,
      email: user.email,
      displayName: user.displayName || '',
      password: '',
      role: user.role,
      isActive: user.isActive !== false,
      assignedWaNumbers: user.assignedWaNumbers || [],
    });
    setShowPw(false);
    setError('');
    setShowForm(true);
  };

  const save = async () => {
    setError('');
    if (!form.email.trim() || !form.displayName.trim()) { setError('Email and display name are required'); return; }
    if (!editing && !form.username.trim()) { setError('Username is required'); return; }
    setSaving(true);
    try {
      if (editing) {
        await api.users.update(editing.id, {
          displayName: form.displayName.trim(),
          email: form.email.trim(),
          role: form.role,
          isActive: form.isActive,
          assignedWaNumbers: form.role !== 'admin' ? form.assignedWaNumbers : [],
        });
        setShowForm(false);
        await refresh();
      } else {
        const result = await api.users.create({
          username: form.username.trim(),
          email: form.email.trim(),
          displayName: form.displayName.trim(),
          password: form.password.trim() || undefined,
          role: form.role,
          assignedWaNumbers: form.role !== 'admin' ? form.assignedWaNumbers : [],
        });
        setShowForm(false);
        await refresh();
        setCredentials({ email: result.email, password: result.password, action: 'created' });
      }
    } catch (err) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const doResetPassword = async () => {
    if (!resetting) return;
    try {
      const result = await api.users.resetPassword(resetting.id, resetPwInput.trim() || undefined);
      setResetting(null);
      setResetPwInput('');
      setCredentials({ email: resetting.email, password: result.password, action: 'reset' });
    } catch (err) {
      notify(err.message || 'Reset failed');
    }
  };

  const doDelete = async () => {
    if (!deleteTarget || deleteText.trim().toLowerCase() !== 'delete') return;
    try {
      await api.users.delete(deleteTarget.id);
      setDeleteTarget(null);
      setDeleteText('');
      await refresh();
    } catch (err) {
      notify(err.message || 'Delete failed');
    }
  };

  const fmtTime = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  const toggleAssignedWa = (wa) => {
    setForm(prev => {
      const list = new Set(prev.assignedWaNumbers || []);
      if (list.has(wa)) list.delete(wa); else list.add(wa);
      return { ...prev, assignedWaNumbers: Array.from(list) };
    });
  };

  return (
    <div style={{ flex: 1, padding: 24, overflow: 'auto', fontFamily: FONT }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: 0 }}>Users</h2>
          <p style={{ fontSize: 14, color: C.textMuted, margin: '4px 0 0' }}>
            The people who sign in. A non-admin only sees chats and contacts on their assigned WhatsApp numbers.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setManageRoles(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: 'var(--c-cardBg)', color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
            <Shield size={15} /> {manageRoles ? 'Hide roles' : 'Manage roles'}
          </button>
          <button onClick={openCreate} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
            <Plus size={15} /> Add user
          </button>
        </div>
      </div>

      {manageRoles && <RolesPanel roles={roles} allPages={allPages} users={users} onRefresh={refresh} />}

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: C.textMuted, fontSize: 15 }}>Loading…</div>
      ) : users.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, borderRadius: 10, color: C.textMuted, fontSize: 15 }}>
          No users yet. Click "Add user" to create one.
        </div>
      ) : (
        <div style={{ background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15 }}>
            <thead>
              <tr style={{ background: C.pageBg, borderBottom: `1px solid ${C.border}` }}>
                <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>User</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Role</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Assigned WA</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Status</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Last login</th>
                <th style={{ textAlign: 'right', padding: '12px 16px', fontWeight: 600, color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: '12px 16px', verticalAlign: 'top' }}>
                    <div style={{ fontWeight: 600, color: C.text }}>{u.displayName}</div>
                    <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2, fontFamily: 'DM Mono, monospace' }}>{u.email}</div>
                  </td>
                  <td style={{ padding: '12px 16px', verticalAlign: 'top' }}><RoleBadge role={u.role} roles={roles}/></td>
                  <td style={{ padding: '12px 16px', verticalAlign: 'top', fontSize: 14, fontFamily: 'DM Mono, monospace' }}>
                    {u.role === 'admin'
                      ? <span style={{ color: C.textMuted, fontStyle: 'italic' }}>all numbers</span>
                      : (u.assignedWaNumbers && u.assignedWaNumbers.length > 0
                          ? u.assignedWaNumbers.map(w => <div key={w}>{w}</div>)
                          : <span style={{ color: 'var(--c-dangerText, #A32D2D)', fontStyle: 'italic' }}>none — won't see any chats</span>)}
                  </td>
                  <td style={{ padding: '12px 16px', verticalAlign: 'top' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: u.isActive ? 'var(--c-successText, #0F6E56)' : 'var(--c-dangerText, #A32D2D)' }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: u.isActive ? '#0F6E56' : '#A32D2D' }}/>
                      {u.isActive ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px', verticalAlign: 'top', fontSize: 14, color: C.textSecondary }}>{fmtTime(u.lastLoginAt)}</td>
                  <td style={{ padding: '12px 16px', verticalAlign: 'top', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button onClick={() => openEdit(u)} style={{ ...btnSecondary, marginRight: 4 }}>Edit</button>
                    <button onClick={() => { setResetting(u); setResetPwInput(''); }} style={{ ...btnSecondary, marginRight: 4 }} title="Reset password"><Key size={12}/></button>
                    <button onClick={() => { setDeleteTarget(u); setDeleteText(''); }} style={{ ...btnSecondary, color: 'var(--c-dangerText, #A32D2D)', borderColor: '#F3D4D4' }} title="Delete"><Trash2 size={12}/></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create / edit modal */}
      {showForm && (
        <div onClick={() => !saving && setShowForm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, boxShadow: C.shadowLg, width: 500, maxHeight: 'calc(100vh - 32px)', overflow: 'auto', padding: 24, fontFamily: FONT }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>{editing ? 'Edit user' : 'Add user'}</h3>

            <div style={{ marginTop: 16, marginBottom: 14 }}>
              <label style={labelStyle}>Display name *</label>
              <input value={form.displayName} onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))} style={inpStyle}/>
            </div>
            <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Username *</label>
                <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} disabled={!!editing} style={{ ...inpStyle, opacity: editing ? 0.6 : 1 }}/>
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Email *</label>
                <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} style={inpStyle}/>
              </div>
            </div>
            {!editing && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Password (leave blank to auto-generate)</label>
                <div style={{ position: 'relative' }}>
                  <input type={showPw ? 'text' : 'password'} value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="12+ chars recommended" style={{ ...inpStyle, paddingRight: 36, fontFamily: 'DM Mono, monospace' }}/>
                  <button type="button" onClick={() => setShowPw(s => !s)} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', cursor: 'pointer', color: C.textMuted, padding: 4 }}>
                    {showPw ? <EyeOff size={14}/> : <Eye size={14}/>}
                  </button>
                </div>
              </div>
            )}
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Role</label>
              <SearchableSelect
                value={form.role}
                onChange={v => setForm(f => ({ ...f, role: v }))}
                options={roles.filter(r => r.active !== false).map(r => ({ value: r.key, label: r.label }))}
                style={{ width: '100%' }}
                triggerStyle={{ padding: '8px 32px 8px 12px' }}
              />
              <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>{roles.find(r => r.key === form.role)?.description}</div>
            </div>
            {form.role !== 'admin' && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Assigned WhatsApp numbers</label>
                {waAccounts.length === 0 ? (
                  <div style={{ fontSize: 14, color: C.textMuted, fontStyle: 'italic' }}>No WhatsApp accounts connected yet. Add some in the WhatsApp Accounts tab first.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflow: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, padding: 8 }}>
                    {waAccounts.map(a => {
                      const wa = String(a.displayPhoneNumber || '').replace(/\D/g, '');
                      const checked = form.assignedWaNumbers.includes(wa);
                      return (
                        <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: C.text, cursor: 'pointer', padding: '4px 6px', borderRadius: 6 }}
                          onMouseEnter={e => e.currentTarget.style.background = C.pageBg}
                          onMouseLeave={e => e.currentTarget.style.background = ''}>
                          <input type="checkbox" checked={checked} onChange={() => toggleAssignedWa(wa)}/>
                          <span style={{ fontWeight: 600 }}>{a.displayName}</span>
                          <span style={{ fontFamily: 'DM Mono, monospace', color: C.textSecondary }}>{maskPhone(a.displayPhoneNumber)}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>
                  BDA Sales users only see chats and contacts on the numbers they're assigned.
                </div>
              </div>
            )}
            {editing && (
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: C.text, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))}/>
                  <span>Account is active <span style={{ color: C.textMuted, fontWeight: 400 }}>(disabling blocks login but keeps the row)</span></span>
                </label>
              </div>
            )}
            {error && <div style={{ padding: '8px 12px', background: 'var(--c-primaryLight)', color: 'var(--c-dangerText, #A32D2D)', borderRadius: 8, fontSize: 14, marginBottom: 14 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowForm(false)} disabled={saving} style={{ ...btnSecondary, padding: '8px 14px', fontSize: 15 }}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ padding: '8px 14px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: saving ? 'wait' : 'pointer', fontFamily: FONT, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {saving && <Loader2 size={13} className="spin"/>}
                {saving ? 'Saving…' : (editing ? 'Save changes' : 'Create user')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Credentials modal (shows generated password once) */}
      {credentials && (
        <div onClick={() => setCredentials(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 210, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, boxShadow: C.shadowLg, width: 460, padding: 24, fontFamily: FONT }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>
              {credentials.action === 'created' ? 'User created' : 'Password reset'}
            </h3>
            <div style={{ padding: 12, background: 'var(--c-warnBgSoft, #FFF8E1)', border: `1px solid #FFE082`, borderRadius: 8, color: 'var(--c-s7a5c00, #7A5C00)', fontSize: 14, marginTop: 14 }}>
              ⚠️ This is the only time the password will be shown. Save it now and share with the user out-of-band (e.g. via WhatsApp).
            </div>
            <div style={{ marginTop: 14 }}>
              <div style={labelStyle}>Email</div>
              <div style={{ ...inpStyle, fontFamily: 'DM Mono, monospace', userSelect: 'all' }}>{credentials.email}</div>
            </div>
            <div style={{ marginTop: 10 }}>
              <div style={labelStyle}>Password</div>
              <div style={{ ...inpStyle, fontFamily: 'DM Mono, monospace', userSelect: 'all', fontWeight: 600 }}>{credentials.password}</div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
              <button onClick={() => { navigator.clipboard.writeText(`Email: ${credentials.email}\nPassword: ${credentials.password}`); }} style={{ ...btnSecondary, padding: '8px 14px', fontSize: 15 }}>Copy both</button>
              <button onClick={() => setCredentials(null)} style={{ padding: '8px 14px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>Got it</button>
            </div>
          </div>
        </div>
      )}

      {/* Reset password input modal */}
      {resetting && (
        <div onClick={() => setResetting(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, boxShadow: C.shadowLg, width: 420, padding: 24, fontFamily: FONT }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>Reset password</h3>
            <p style={{ margin: '8px 0 14px', fontSize: 15, color: C.textSecondary }}>Reset password for <strong>{resetting.displayName}</strong> ({resetting.email})?</p>
            <label style={labelStyle}>New password (leave blank to auto-generate)</label>
            <input type="text" value={resetPwInput} onChange={e => setResetPwInput(e.target.value)} placeholder="Auto-generate if blank" style={{ ...inpStyle, fontFamily: 'DM Mono, monospace' }}/>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={() => setResetting(null)} style={{ ...btnSecondary, padding: '8px 14px', fontSize: 15 }}>Cancel</button>
              <button onClick={doResetPassword} style={{ padding: '8px 14px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>Reset password</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      {deleteTarget && (
        <div onClick={() => setDeleteTarget(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, boxShadow: C.shadowLg, width: 420, padding: 24, fontFamily: FONT }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>Delete user</h3>
            <p style={{ margin: '8px 0 14px', fontSize: 15, color: C.textSecondary }}>This will permanently remove <strong>{deleteTarget.displayName}</strong> ({deleteTarget.email}) and their WhatsApp number assignments. The chat history they touched is not affected.</p>
            <label style={labelStyle}>Type "delete" to confirm</label>
            <input value={deleteText} onChange={e => setDeleteText(e.target.value)} autoFocus style={inpStyle}/>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={() => setDeleteTarget(null)} style={{ ...btnSecondary, padding: '8px 14px', fontSize: 15 }}>Cancel</button>
              <button onClick={doDelete} disabled={deleteText.trim().toLowerCase() !== 'delete'} style={{ padding: '8px 14px', background: deleteText.trim().toLowerCase() === 'delete' ? '#A32D2D' : 'var(--c-borderStrong, #D5D5D0)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: deleteText.trim().toLowerCase() === 'delete' ? 'pointer' : 'not-allowed', fontFamily: FONT }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Integrations Tab                                                   */
/*  Google Sheets / Google Calendar / Gmail OAuth integrations.         */
/* ------------------------------------------------------------------ */

const PROVIDERS = [
  {
    key: 'google_sheets',
    label: 'Google Sheets',
    icon: FileSpreadsheet,
    blurb: 'Append rows to a spreadsheet from automation Actions.',
    color: 'var(--c-x0f9d58, #0F9D58)',
  },
  {
    key: 'google_calendar',
    label: 'Google Calendar',
    icon: CalendarIcon,
    blurb: 'Create calendar events from automation Actions.',
    color: '#4285F4',
  },
  {
    key: 'gmail',
    label: 'Gmail',
    icon: Mail,
    blurb: 'Send emails from the connected Gmail account.',
    color: '#EA4335',
  },
];

// Top-level "apps" (collections of providers). Designed so future apps —
// Slack, Notion, HubSpot — can be added with the same drill-in pattern.
const INTEGRATION_APPS = [
  {
    key: 'google',
    label: 'Google',
    blurb: 'Sheets, Calendar, Gmail — connect once, use across automations.',
    providers: ['google_sheets', 'google_calendar', 'gmail'],
    color: '#4285F4',
    logo: (size = 28) => (
      // The 4-color G — inline SVG so we don't add an asset
      <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M21.6 12.227c0-.704-.063-1.38-.18-2.027H12v3.832h5.39a4.612 4.612 0 0 1-2 3.028v2.514h3.236c1.894-1.745 2.974-4.314 2.974-7.347Z" fill="#4285F4"/>
        <path d="M12 22c2.7 0 4.964-.895 6.618-2.426l-3.236-2.514c-.896.6-2.04.955-3.382.955-2.605 0-4.81-1.76-5.595-4.122H3.064v2.59A9.996 9.996 0 0 0 12 22Z" fill="#34A853"/>
        <path d="M6.405 13.893A6 6 0 0 1 6.09 12c0-.659.114-1.295.314-1.893V7.518H3.064A9.996 9.996 0 0 0 2 12c0 1.614.386 3.14 1.064 4.482l3.341-2.59Z" fill="#FBBC05"/>
        <path d="M12 5.985c1.469 0 2.787.505 3.823 1.495l2.868-2.868C16.96 3.024 14.695 2 12 2A9.996 9.996 0 0 0 3.064 7.518l3.341 2.59C7.19 7.745 9.395 5.985 12 5.985Z" fill="#EA4335"/>
      </svg>
    ),
  },
];

// Meta logo (single-colour infinity mark) — inline SVG so we don't add an asset.
const MetaLogo = (size = 28) => (
  <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path fill="var(--c-x0866ff, #0866FF)" d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.3-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.518-2.602zm-10.201.088c1.055 0 2.006.535 2.844 1.377.784.788 1.463 1.783 2.288 3.13l-.916 1.409c-.83 1.279-1.395 2.099-1.89 2.7-.895 1.09-1.585 1.39-2.288 1.39-.646 0-1.032-.278-1.264-.699-.155-.279-.267-.633-.34-1.043a6.354 6.354 0 0 1-.11-1.184c0-1.831.578-3.786 1.28-4.86.542-.827 1.19-1.22 1.626-1.22.09 0 .18.008.27.024z"/>
  </svg>
);

// Connection-status pill for the Meta Ads / ForgeSocial app cards.
function connBadge(st) {
  if (st?.connected) return <span style={{ fontSize: 13, padding: '2px 8px', background: 'var(--c-sdcfce7, #dcfce7)', color: 'var(--c-s15803d, #15803d)', borderRadius: 6, fontWeight: 600 }}>Connected</span>;
  if (st?.status === 'error') return <span style={{ fontSize: 13, padding: '2px 8px', background: 'var(--c-dangerBg, #fee2e2)', color: 'var(--c-primaryHover, #b91c1c)', borderRadius: 6, fontWeight: 600 }}>Connection error</span>;
  return <span style={{ fontSize: 13, padding: '2px 8px', background: C.sidebarBg, color: C.textMuted, borderRadius: 6, fontWeight: 600 }}>Not connected</span>;
}

// Shared app-card used for every Integrations tile (Google, Meta Ads, ForgeSocial)
// so they stay pixel-identical. `logo` is a rendered node; `badge` is a pill node.
function AppCard({ color, logo, label, blurb, badge, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left', cursor: 'pointer',
        background: C.cardBg, border: `1px solid ${C.border}`,
        borderRadius: 12, padding: 18, display: 'flex', alignItems: 'center', gap: 14,
        fontFamily: FONT, color: C.text,
        transition: 'box-shadow .12s, border-color .12s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = color; e.currentTarget.style.boxShadow = C.shadowMd; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.boxShadow = 'none'; }}
    >
      <div style={{ width: 48, height: 48, borderRadius: 12, background: 'var(--c-surface, #fff)', border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {logo}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>{label}</div>
        <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 2 }}>{blurb}</div>
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>{badge}</div>
      </div>
      <ChevronRight size={18} color={C.textMuted} />
    </button>
  );
}

/* ============================ MCP Tools tab ============================ */

// Human labels for the per-capability toggles. Keys match backend
// mcp_settings.capabilities / routes/mcp.js CAPABILITY_KEYS.
// API areas for the generic `forgechat_request` proxy ONLY.
//
// These used to gate named tools as well, which is what made the old screen
// unreadable — a single key like `discovery` controlled ten unrelated tools
// across templates, media, agents and Google Drive. Named tools are now gated
// by CATEGORY (served by the backend from services/mcpCatalog.js), and these
// area switches do only the job they were designed for: scoping which internal
// API paths the Direct API access tool may reach.
const MCP_API_AREAS = [
  { key: 'area_contacts', label: 'Contacts & tags', desc: 'Contacts, saved contacts, tags and categories.' },
  { key: 'area_messaging', label: 'Messages', desc: 'Chat messages, reactions and mark-read.' },
  { key: 'area_broadcasts', label: 'Broadcasts & content', desc: 'Broadcasts, templates, media library and click-to-chat links.' },
  { key: 'area_automations', label: 'Automations', desc: 'Automation flows, projects, executions and follow-up sequences.' },
  { key: 'area_admin', label: 'Admin (users, accounts, payments)', desc: 'SENSITIVE — users/RBAC, WhatsApp accounts, AI models, integrations, the Razorpay gateway secret, conversion sending and live payment links.', sensitive: true },
  { key: 'area_insights', label: 'Dashboard & logs', desc: 'Dashboard analytics, webhook history and message costs.' },
  { key: 'area_leads', label: 'Leads & funnel', desc: 'The lead funnel, lead sources, funnel config and the field registry.' },
  { key: 'area_leadforms', label: 'Lead forms', desc: 'Lead-capture forms and their submissions.' },
  { key: 'area_marketing', label: 'Marketing', desc: 'Campaigns (incl. Meta Ads sync), webinars, registrations and click-to-WhatsApp analytics.' },
  { key: 'area_resources', label: 'Resources', desc: 'Content library, live links and the trigger library.' },
  { key: 'area_bda', label: 'BDA activity', desc: 'BDA leaderboard, activity log and webinar conversion.' },
  { key: 'area_courses', label: 'Products', desc: 'Product catalogue, payment links and per-product revenue.' },
  { key: 'area_payments', label: 'Payments', desc: 'Razorpay ledger, sales log and students. The gateway secret stays under Admin.' },
];

// Tier -> pill styling. The tier is advisory signalling for the admin reading
// the screen; the category toggle is the only real gate. Red is reserved for
// the two things that cost money or reach a real customer, so the eye lands on
// them first.
const MCP_TIER_STYLE = {
  read:        { bg: 'var(--c-successBgSoft, #E8F3EF)', fg: C.green },
  build:       { bg: 'var(--c-xedebf7, #EDEBF7)', fg: C.purple },
  send:        { bg: 'var(--c-dangerBg, #FCEBEB)', fg: 'var(--c-dangerText, #A32D2D)' },
  destructive: { bg: '#4A1414', fg: '#FFE8E8' },
  advanced:    { bg: 'var(--c-xfbf0e4, #FBF0E4)', fg: 'var(--c-x8a5a1b, #8A5A1B)' },
};

function TierPill({ tier, label }) {
  const s = MCP_TIER_STYLE[tier] || MCP_TIER_STYLE.read;
  return (
    <span style={{
      background: s.bg, color: s.fg, fontSize: 12, fontWeight: 700,
      letterSpacing: '.04em', textTransform: 'uppercase',
      padding: '3px 8px', borderRadius: 999, whiteSpace: 'nowrap', flexShrink: 0,
    }}>{label}</span>
  );
}

// One category = one switch = one thing a person actually does ("Template
// Builder"). Expanding it lists the exact tools that switch controls, so the
// blast radius of turning it off is visible before you turn it off — the old
// flat list gave no way to know that `discovery` also owned Google Drive.
function McpCategoryCard({ cat, disabled, saving, onToggle }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div style={{
      border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 10,
      background: cat.enabled ? C.cardBg : 'transparent',
      opacity: disabled ? 0.55 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '13px 14px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{cat.label}</span>
            <TierPill tier={cat.tier} label={cat.tierLabel} />
          </div>
          <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 4, lineHeight: 1.5 }}>
            {cat.description}
          </div>
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 8,
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              fontFamily: FONT, fontSize: 13, fontWeight: 600, color: C.textSecondary,
            }}
          >
            <Chevron size={13} strokeWidth={2.5} />
            <span style={{ fontFamily: MONO }}>{cat.toolCount}</span>
            {cat.toolCount === 1 ? ' tool' : ' tools'}
          </button>
        </div>
        <Toggle checked={cat.enabled} disabled={disabled || saving} onChange={onToggle} />
      </div>

      {open && (
        <div style={{ borderTop: `1px solid ${C.border}`, padding: '10px 14px 12px' }}>
          {cat.tools.map(t => (
            <div key={t.name} style={{ display: 'flex', gap: 10, padding: '5px 0', alignItems: 'baseline' }}>
              <code style={{
                fontFamily: MONO, fontSize: 13, color: cat.enabled ? C.text : C.textMuted,
                whiteSpace: 'nowrap',
              }}>{t.name}</code>
              <span style={{ fontSize: 13, color: C.textSecondary, lineHeight: 1.45 }}>{t.summary}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Small inline pill toggle — consistent with the settings look, no extra deps.
function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 38, height: 22, borderRadius: 999, border: 'none', padding: 0,
        position: 'relative', flexShrink: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        background: checked ? C.green : 'var(--c-borderStrong, #cfcfca)',
        transition: 'background .15s',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2,
        width: 18, height: 18, borderRadius: '50%', background: 'var(--c-surface, #fff)',
        boxShadow: '0 1px 2px rgba(0,0,0,.25)', transition: 'left .15s',
      }} />
    </button>
  );
}

function McpToolsTab() {
  const [settings, setSettings] = useState(null);   // { masterEnabled, capabilities }
  const [keys, setKeys] = useState([]);
  const [install, setInstall] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savingCap, setSavingCap] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [freshKey, setFreshKey] = useState(null);   // { ...key, key } shown once
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [copied, setCopied] = useState('');
  const [showInstall, setShowInstall] = useState(false);
  const [oauthClients, setOauthClients] = useState([]);
  const [oauthName, setOauthName] = useState('');
  const [creatingOauth, setCreatingOauth] = useState(false);
  const [freshClient, setFreshClient] = useState(null);   // secret shown once
  const [oauthDeleteTarget, setOauthDeleteTarget] = useState(null);

  const load = async () => {
    try {
      const [s, k, inst, oc] = await Promise.all([
        api.mcp.getSettings(),
        api.mcp.listKeys(),
        api.mcp.install().catch(() => null),
        api.mcp.oauthClients().catch(() => ({ clients: [] })),
      ]);
      setSettings(s);
      setKeys(k);
      setInstall(inst);
      setOauthClients(oc?.clients || []);
    } catch (err) {
      notify(err.message || 'Failed to load MCP settings');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const copy = async (text, tag) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(''), 1500);
    } catch { /* */ }
  };

  const saveSettings = async (patch) => {
    setSavingCap(true);
    const prev = settings;
    setSettings(s => {
      const categories = { ...s.categories, ...(patch.categories || {}) };
      return {                                // optimistic
        ...s,
        ...(patch.masterEnabled !== undefined ? { masterEnabled: patch.masterEnabled } : {}),
        capabilities: { ...s.capabilities, ...(patch.capabilities || {}) },
        categories,
        // Re-project the catalog's per-category `enabled` flags too, otherwise
        // the optimistic update writes state the cards do not read and the
        // switch visibly snaps back until the server responds.
        catalog: s.catalog && {
          ...s.catalog,
          categories: s.catalog.categories.map(c => ({ ...c, enabled: categories[c.key] === true })),
        },
      };
    });
    try {
      const updated = await api.mcp.updateSettings(patch);
      setSettings(updated);
    } catch (err) {
      setSettings(prev);                      // revert
      notify(err.message || 'Failed to update MCP settings');
    } finally {
      setSavingCap(false);
    }
  };

  const createKey = async () => {
    const label = newLabel.trim();
    if (!label) { notify('Give the key a label first'); return; }
    setCreating(true);
    try {
      const k = await api.mcp.createKey(label);
      setFreshKey(k);
      setNewLabel('');
      await load();
    } catch (err) {
      notify(err.message || 'Failed to create key');
    } finally {
      setCreating(false);
    }
  };

  const toggleKey = async (k) => {
    const prev = keys;
    setKeys(ks => ks.map(x => x.id === k.id ? { ...x, isEnabled: !x.isEnabled } : x));
    try {
      await api.mcp.updateKey(k.id, { isEnabled: !k.isEnabled });
    } catch (err) {
      setKeys(prev);
      notify(err.message || 'Failed to update key');
    }
  };

  const revokeKey = async () => {
    const k = revokeTarget;
    setRevokeTarget(null);
    try {
      await api.mcp.deleteKey(k.id);
      setKeys(ks => ks.filter(x => x.id !== k.id));
    } catch (err) {
      notify(err.message || 'Failed to revoke key');
    }
  };

  if (loading || !settings) {
    return <div style={{ flex: 1, padding: 40, textAlign: 'center', color: C.textMuted, fontFamily: FONT }}>Loading…</div>;
  }

  const master = settings.masterEnabled;
  const card = { background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, marginBottom: 18 };
  const h2 = { fontSize: 16, fontWeight: 700, color: C.text, margin: '0 0 4px' };
  const sub = { fontSize: 14, color: C.textSecondary, margin: '0 0 16px', lineHeight: 1.5 };

  // The category list, tool counts and per-tool summaries all come from the
  // backend catalog (services/mcpCatalog.js) — this screen deliberately keeps
  // NO copy of its own. A hand-maintained frontend mirror of a backend list is
  // how a Settings tab once rendered a button that silently did nothing.
  const cats = settings.catalog?.categories || [];
  const totalTools = settings.catalog?.totalTools || 0;
  const enabledCats = cats.filter(c => c.enabled);
  const enabledTools = enabledCats.reduce((n, c) => n + c.toolCount, 0);
  const directApiOn = cats.some(c => c.key === 'direct_api' && c.enabled);
  const codeBox = {
    background: '#0F0F10', color: '#E5E5E2', fontFamily: MONO, fontSize: 14,
    borderRadius: 8, padding: 14, overflowX: 'auto', whiteSpace: 'pre', lineHeight: 1.5,
  };

  const snippet = install ? JSON.stringify(install.configSnippet, null, 2) : '';

  return (
    <div style={{ flex: 1, padding: 24, overflow: 'auto', fontFamily: FONT, maxWidth: 1320 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <PlugZap size={20} color={C.primary} />
        <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: 0 }}>MCP Tools</h1>
      </div>
      <p style={{ fontSize: 15, color: C.textSecondary, margin: '0 0 22px', lineHeight: 1.6, maxWidth: 720 }}>
        Connect Claude.ai to Forge Growth as a custom connector, so it can read and act on your leads, campaigns,
        payments and BDA activity — and build or manage WhatsApp AI agents — over a secure API key.
        Turn capabilities on or off here; changes apply instantly to every connected client.
      </p>

      {/* Two-column layout: access + capabilities on the left, keys + install on the right.
          flex-wrap with a 420px basis collapses to one column on narrow windows. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 420px', minWidth: 0 }}>

      {/* Claude plugin — first thing on the page: it is how you START using any of this. */}
      <div style={{
        ...card,
        background: C.headerBg, border: 'none', color: C.headerText,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Package size={17} strokeWidth={2} color={C.headerText} />
              <h2 style={{ ...h2, color: C.headerText, margin: 0 }}>Claude plugin</h2>
            </div>
            <p style={{ fontSize: 14, color: '#B9B9B4', margin: '8px 0 0', lineHeight: 1.55 }}>
              Everything Claude needs to run Forge Growth: the connector plus a set of skills
              covering the funnel, follow-ups, templates, messaging, automations, agents, ads
              and revenue. The download is already pointed at <strong style={{ color: C.headerText }}>this</strong> instance,
              so there is nothing to edit.
            </p>
            <p style={{ fontSize: 13, color: '#8E8E89', margin: '10px 0 0', lineHeight: 1.5 }}>
              Unzip it, then add the folder to Claude Code as a plugin — or paste the connector
              URL into Claude&nbsp;&rarr;&nbsp;Settings&nbsp;&rarr;&nbsp;Connectors. Signing in
              uses OAuth, so no key is stored in the file.
            </p>
          </div>
          <a
            href={api.mcp.pluginZipUrl()}
            download="forge-growth-plugin.zip"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, padding: '11px 18px',
              background: C.primary, color: '#fff', borderRadius: 10, textDecoration: 'none',
              fontSize: 15, fontWeight: 700, fontFamily: FONT, flexShrink: 0,
            }}
          >
            <Download size={16} strokeWidth={2.5} /> Download plugin
          </a>
        </div>
      </div>

      {/* Access (master switch) */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div>
            <h2 style={h2}>MCP access</h2>
            <p style={{ ...sub, margin: 0 }}>
              Master switch for all MCP access. When off, every MCP request is rejected regardless of key or capability.
            </p>
          </div>
          <Toggle checked={master} disabled={savingCap} onChange={(v) => saveSettings({ masterEnabled: v })} />
        </div>
        {!master && (
          <div style={{
            marginTop: 14, padding: '10px 12px', borderRadius: 8,
            background: 'var(--c-dangerBg, #FCEBEB)', color: 'var(--c-dangerText, #A32D2D)', fontSize: 14, fontWeight: 500,
          }}>
            MCP access is currently disabled.
          </div>
        )}
      </div>

      {/* Tool categories */}
      <div style={{ ...card, opacity: master ? 1 : 0.6 }}>
        <h2 style={h2}>Tool categories</h2>
        <p style={sub}>
          Every MCP tool belongs to one category. Switch a category on to give Claude
          that whole process — expand it to see exactly which tools it controls.
        </p>

        {/* Summary strip — answers "how much is Claude allowed to do right now?"
            at a glance, which the old flat toggle list could not. */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          background: C.pageBg, border: `1px solid ${C.border}`, borderRadius: 10,
          padding: '11px 14px', marginBottom: 16,
        }}>
          <Wrench size={15} strokeWidth={2} color={C.textSecondary} />
          <span style={{ fontSize: 14, color: C.text, fontWeight: 600 }}>
            <span style={{ fontFamily: MONO }}>{enabledTools}</span>
            {' of '}
            <span style={{ fontFamily: MONO }}>{totalTools}</span>
            {' tools available to Claude'}
          </span>
          <span style={{ fontSize: 14, color: C.textSecondary }}>
            · <span style={{ fontFamily: MONO }}>{enabledCats.length}</span>
            {' of '}
            <span style={{ fontFamily: MONO }}>{cats.length}</span>
            {' categories on'}
          </span>
        </div>

        {cats.length === 0 ? (
          <div style={{ fontSize: 14, color: C.textSecondary }}>
            No tool catalog was returned by the server. Rebuild the backend to pick up the
            category catalog.
          </div>
        ) : cats.map(c => (
          <McpCategoryCard
            key={c.key}
            cat={c}
            disabled={!master}
            saving={savingCap}
            onToggle={(v) => saveSettings({ categories: { [c.key]: v } })}
          />
        ))}
      </div>

      {/* API areas — scope for the Direct API access tool only. */}
      <div style={{ ...card, opacity: master && directApiOn ? 1 : 0.6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <h2 style={{ ...h2, margin: 0 }}>API areas</h2>
          <TierPill tier="advanced" label="Full API access" />
        </div>
        <p style={sub}>
          These scope the <code style={{ fontFamily: MONO, fontSize: 13 }}>forgechat_request</code> tool
          in <strong>Direct API access</strong> — which internal endpoints it may call.
          {' '}
          {directApiOn
            ? 'Anything not covered by an area below is refused.'
            : 'Direct API access is switched off, so none of these apply right now.'}
        </p>
        {MCP_API_AREAS.map((a, i) => (
          <div key={a.key} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16,
            padding: '12px 0', borderTop: i === 0 ? 'none' : `1px solid ${C.border}`,
          }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {a.sensitive && <ShieldAlert size={13} strokeWidth={2.5} color={C.primary} />}
                <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{a.label}</span>
              </div>
              <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 2, lineHeight: 1.45 }}>{a.desc}</div>
            </div>
            <Toggle
              checked={!!settings.capabilities[a.key]}
              disabled={!master || savingCap}
              onChange={(v) => saveSettings({ capabilities: { [a.key]: v } })}
            />
          </div>
        ))}
      </div>

      </div>{/* /left column */}
      <div style={{ flex: '1 1 420px', minWidth: 0 }}>

      {/* API keys */}
      <div style={card}>
        <h2 style={h2}>API keys</h2>
        <p style={sub}>Bearer keys MCP clients use to authenticate. The full key is shown only once at creation.</p>

        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          <input
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') createKey(); }}
            placeholder="Key label (e.g. My MacBook — Claude Desktop)"
            style={{
              flex: 1, padding: '9px 12px', borderRadius: 8, border: `1px solid ${C.border}`,
              fontSize: 15, fontFamily: FONT, background: C.cardBg, color: C.text,
            }}
          />
          <button
            onClick={createKey}
            disabled={creating}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px',
              background: C.primary, color: '#fff', border: 'none', borderRadius: 8,
              fontSize: 15, fontWeight: 600, cursor: creating ? 'wait' : 'pointer', fontFamily: FONT,
            }}
          >
            <Plus size={15} /> Generate key
          </button>
        </div>

        {keys.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: C.textMuted, fontSize: 15, border: `1px dashed ${C.border}`, borderRadius: 8 }}>
            No API keys yet.
          </div>
        ) : (
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15 }}>
              <thead>
                <tr style={{ background: 'var(--c-hover, #f7f7f3)', textAlign: 'left' }}>
                  <th style={{ padding: '10px 14px', fontWeight: 600, color: C.textSecondary }}>Label</th>
                  <th style={{ padding: '10px 14px', fontWeight: 600, color: C.textSecondary }}>Key</th>
                  <th style={{ padding: '10px 14px', fontWeight: 600, color: C.textSecondary }}>Last used</th>
                  <th style={{ padding: '10px 14px', fontWeight: 600, color: C.textSecondary }}>Enabled</th>
                  <th style={{ padding: '10px 14px' }}></th>
                </tr>
              </thead>
              <tbody>
                {keys.map(k => (
                  <tr key={k.id} style={{ borderTop: `1px solid ${C.border}` }}>
                    <td style={{ padding: '10px 14px', color: C.text }}>{k.label}</td>
                    <td style={{ padding: '10px 14px', color: C.textSecondary, fontFamily: MONO, fontSize: 14 }}>
                      {k.keyPrefix}…{k.keyLast4}
                    </td>
                    <td style={{ padding: '10px 14px', color: C.textSecondary }}>
                      {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'Never'}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <Toggle checked={k.isEnabled} onChange={() => toggleKey(k)} />
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                      <button
                        onClick={() => setRevokeTarget(k)}
                        title="Revoke"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.primary, padding: 4 }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* OAuth clients — what Claude's connector dialog actually asks for. */}
      <div style={card}>
        <h2 style={h2}>OAuth clients</h2>
        <p style={{ fontSize: 14, color: C.textSecondary, margin: '0 0 14px', lineHeight: 1.6 }}>
          Claude connects with a <strong>Client ID + Client Secret</strong> and signs you in through a browser
          window — nothing secret ends up in the URL. Create one per connector, paste both values into Claude&apos;s
          <em> Advanced settings</em>, and revoke here to cut it off instantly.
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <input
            value={oauthName}
            onChange={e => setOauthName(e.target.value)}
            placeholder="Connector name (e.g. Claude — Anand)"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            disabled={creatingOauth || !oauthName.trim()}
            onClick={async () => {
              try {
                setCreatingOauth(true);
                const c = await api.mcp.createOauthClient({ name: oauthName.trim() });
                setFreshClient(c);          // secret is returned once and never again
                setOauthName('');
                await load();
              } catch (err) { notify(err.message || 'Could not create the OAuth client'); }
              finally { setCreatingOauth(false); }
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, background: C.primary, color: '#fff',
              border: 'none', borderRadius: 8, padding: '0 16px', fontSize: 15, fontWeight: 600,
              cursor: creatingOauth || !oauthName.trim() ? 'not-allowed' : 'pointer',
              opacity: creatingOauth || !oauthName.trim() ? 0.55 : 1, fontFamily: FONT,
            }}>
            <Plus size={14} /> Create client
          </button>
        </div>

        {oauthClients.length === 0 ? (
          <div style={{ fontSize: 15, color: C.textMuted, padding: '10px 0' }}>
            No OAuth clients yet.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT }}>
            <thead>
              <tr>
                {['Name', 'Client ID', 'Connections', 'Enabled', ''].map((h, i) => (
                  <th key={i} style={{ textAlign: i > 1 && i < 4 ? 'center' : 'left', padding: '8px 10px',
                    fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
                    color: C.textMuted, borderBottom: `1px solid ${C.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {oauthClients.map(c => (
                <tr key={c.id}>
                  <td style={{ padding: '10px', fontSize: 15, borderBottom: `1px solid ${C.border}` }}>
                    {c.name}
                    {c.dynamic && (
                      <span style={{ marginLeft: 7, fontSize: 12, color: C.textMuted,
                        border: `1px solid ${C.border}`, borderRadius: 5, padding: '1px 5px' }}>AUTO</span>
                    )}
                  </td>
                  <td style={{ padding: '10px', fontSize: 14, fontFamily: MONO, color: C.textSecondary,
                    borderBottom: `1px solid ${C.border}` }}>{c.clientId}</td>
                  <td style={{ padding: '10px', fontSize: 14, textAlign: 'center', color: C.textSecondary,
                    borderBottom: `1px solid ${C.border}` }}>{c.activeTokens || 0}</td>
                  <td style={{ padding: '10px', textAlign: 'center', borderBottom: `1px solid ${C.border}` }}>
                    <Toggle
                      checked={c.isEnabled}
                      onChange={async (v) => {
                        try { await api.mcp.updateOauthClient(c.id, { isEnabled: v }); await load(); }
                        catch (err) { notify(err.message || 'Could not update the client'); }
                      }}
                    />
                  </td>
                  <td style={{ padding: '10px', textAlign: 'right', borderBottom: `1px solid ${C.border}` }}>
                    <button onClick={() => setOauthDeleteTarget(c)} title="Remove this client"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.primary, padding: 4 }}>
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Install instructions */}
      <div style={card}>
        <button
          onClick={() => setShowInstall(s => !s)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: FONT }}
        >
          <Terminal size={16} color={C.textSecondary} />
          <span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Install in Claude.ai — Custom Connectors</span>
          <ChevronRight size={16} color={C.textMuted} style={{ transform: showInstall ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
        </button>

        {showInstall && (
          <div style={{ marginTop: 16 }}>
            {/* Claude.ai custom connector — the ONLY path most people need.
                Forge Growth's MCP is hosted here and speaks Streamable HTTP, so
                there is nothing to install on the user's machine: it is one URL
                pasted into Claude's own Connectors settings. */}
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: '0 0 6px' }}>
              Recommended — OAuth (works on web, desktop and mobile)
            </div>
            <ol style={{ fontSize: 15, color: C.text, lineHeight: 1.8, paddingLeft: 18, margin: '0 0 10px' }}>
              <li>Turn on the master switch and the capabilities you want above.</li>
              <li>Create an <b>OAuth client</b> in the panel above and copy the Client ID + Client Secret (the secret is shown once).</li>
              <li>In Claude, open <b>Settings → Connectors → Add custom connector</b>.</li>
              <li>Paste the server URL below into <b>Remote MCP server URL</b>, then open <b>Advanced settings</b> and paste the <b>OAuth Client ID</b> and <b>OAuth Client Secret</b>.</li>
              <li>Press <b>Add</b>, then <b>Connect</b> — a Forge Growth window opens asking you to allow access. You must already be signed in to Forge Growth in that browser.</li>
            </ol>
            {install?.remoteUrl && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8 }}>
                <code style={{ flex: 1, ...codeBox, whiteSpace: 'nowrap', overflowX: 'auto', padding: '10px 12px' }}>
                  {install.remoteUrl.replace(/\/http\/<YOUR_KEY>$/, '')}
                </code>
                <button
                  onClick={() => copy(install.remoteUrl.replace(/\/http\/<YOUR_KEY>$/, ''), 'oauthurl')}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: `1px solid ${C.border}`, borderRadius: 7, padding: '8px 10px', fontSize: 14, cursor: 'pointer', color: C.text, fontFamily: FONT }}
                >
                  {copied === 'oauthurl' ? <Check size={13} /> : <Copy size={13} />}
                  {copied === 'oauthurl' ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '9px 12px', marginBottom: 16,
              background: 'var(--c-xf1f6ff, #F1F6FF)', border: '1px solid #C8DAF5', borderRadius: 8, fontSize: 14, color: 'var(--c-x254c87, #254C87)' }}>
              <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>
                Turning a capability off above applies <b>immediately</b>, even to a connector that is already
                connected — access is checked on every request, not frozen at connection time.
              </span>
            </div>
            {install?.remoteUrl && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, gap: 8 }}>
                <code style={{ flex: 1, ...codeBox, whiteSpace: 'nowrap', overflowX: 'auto', padding: '10px 12px' }}>{install.remoteUrl}</code>
                <button
                  onClick={() => copy(install.remoteUrl, 'remoteurl')}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: `1px solid ${C.border}`, borderRadius: 7, padding: '8px 10px', fontSize: 14, cursor: 'pointer', color: C.text, fontFamily: FONT }}
                >
                  {copied === 'remoteurl' ? <Check size={13} /> : <Copy size={13} />}
                  {copied === 'remoteurl' ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}

            {/* Legacy key-in-URL. Kept because existing connectors use it, but
                demoted below OAuth: it puts a long-lived credential in a URL. */}
            <div style={{ fontSize: 15, fontWeight: 700, color: C.textSecondary, margin: '18px 0 6px' }}>
              Legacy — key in the URL (no OAuth)
            </div>
            <p style={{ fontSize: 14, color: C.textSecondary, lineHeight: 1.7, margin: '0 0 12px' }}>
              Still supported so already-installed connectors keep working. Generate an API key above and paste
              <code style={{ fontFamily: MONO, fontSize: 14 }}> {install?.remoteUrl || '…/api/mcp/http/<key>'}</code> as
              the server URL with no OAuth fields. Prefer OAuth for anything new — here the whole URL is the password,
              so it ends up in browser history and logs.
            </p>

            {/* Local stdio — kept, but demoted. It needs this repo checked out
                on the user's own machine, so it is for development only, not
                the normal way anyone connects. */}
            <div style={{ fontSize: 15, fontWeight: 700, color: C.textSecondary, margin: '18px 0 6px' }}>
              Advanced — local stdio server (development only)
            </div>
            <ol style={{ fontSize: 14, color: C.textSecondary, lineHeight: 1.8, paddingLeft: 18, margin: '0 0 16px' }}>
              <li>Only needed if you are running the MCP server from source. Requires this repo checked out locally: <code style={{ fontFamily: MONO, fontSize: 14 }}>cd {install?.serverPath?.replace('/src/index.js', '') || '/root/ForgeGrowth/mcp-server'} && npm install</code></li>
              <li>Claude Desktop → <b>Settings → Developer → Edit Config</b>, add the block below, then fully quit and reopen.</li>
            </ol>

            {install && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 14, color: C.textSecondary }}>MCP API URL: <code style={{ fontFamily: MONO }}>{install.apiUrl}</code></span>
                  <button
                    onClick={() => copy(snippet, 'snippet')}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: `1px solid ${C.border}`, borderRadius: 7, padding: '5px 10px', fontSize: 14, cursor: 'pointer', color: C.text, fontFamily: FONT }}
                  >
                    {copied === 'snippet' ? <Check size={13} /> : <Copy size={13} />}
                    {copied === 'snippet' ? 'Copied' : 'Copy config'}
                  </button>
                </div>
                <div style={codeBox}>{snippet}</div>
              </>
            )}
          </div>
        )}
      </div>

      </div>{/* /right column */}
      </div>{/* /two-column wrapper */}

      {/* One-time OAuth secret. Shown once because only its hash is stored —
          there is no way to recover it later, and saying so up front avoids
          someone closing this and assuming they can look it up. */}
      {freshClient && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, fontFamily: FONT }}>
          <div style={{ background: C.cardBg, borderRadius: 14, padding: 24, width: 520, boxShadow: C.shadowLg }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <Key size={18} color={C.green} />
              <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>OAuth client created</div>
            </div>
            <div style={{ fontSize: 15, color: C.textSecondary, marginBottom: 14, lineHeight: 1.6 }}>
              Paste both values into Claude → <b>Settings → Connectors → Add custom connector → Advanced settings</b>.
              The secret is shown <b>once</b> — only a hash is stored, so it cannot be shown again.
            </div>

            {[['Client ID', freshClient.clientId, 'cid'], ['Client Secret', freshClient.clientSecret, 'csec']].map(([label, val, k]) => (
              <div key={k} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 5 }}>{label}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <code style={{ flex: 1, ...codeBox, whiteSpace: 'nowrap', overflowX: 'auto', padding: '11px 13px' }}>{val}</code>
                  <button onClick={() => copy(val, k)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, background: C.primary, color: '#fff', border: 'none', borderRadius: 8, padding: '0 14px', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
                    {copied === k ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
              </div>
            ))}

            <div style={{ marginTop: 6, marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 5 }}>Remote MCP server URL</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <code style={{ flex: 1, ...codeBox, whiteSpace: 'nowrap', overflowX: 'auto', padding: '11px 13px' }}>
                  {`${window.location.origin}/api/mcp`}
                </code>
                <button onClick={() => copy(`${window.location.origin}/api/mcp`, 'curl')}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, padding: '0 14px', fontSize: 15, cursor: 'pointer', color: C.text, fontFamily: FONT }}>
                  {copied === 'curl' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => setFreshClient(null)}
                style={{ background: C.text, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {oauthDeleteTarget && (
        <DeleteConfirmModal
          open
          title="Remove this OAuth client?"
          message={`“${oauthDeleteTarget.name}” will stop working immediately, and any Claude connector using it will need to be reconnected with new credentials.`}
          confirmText="Remove client"
          onCancel={() => setOauthDeleteTarget(null)}
          onConfirm={async () => {
            try { await api.mcp.deleteOauthClient(oauthDeleteTarget.id); setOauthDeleteTarget(null); await load(); }
            catch (err) { notify(err.message || 'Could not remove the client'); }
          }}
        />
      )}

      {/* One-time fresh-key modal */}
      {freshKey && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, fontFamily: FONT }}>
          <div style={{ background: C.cardBg, borderRadius: 14, padding: 24, width: 480, boxShadow: C.shadowLg }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <Key size={18} color={C.green} />
              <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>API key created</div>
            </div>
            <div style={{ fontSize: 15, color: C.textSecondary, marginBottom: 12, lineHeight: 1.6 }}>
              Copy this key now — it won’t be shown again. For Claude.ai, use the ready-made connector URL below:
              paste it into <b>Settings → Connectors → Add custom connector</b>.
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <code style={{ flex: 1, ...codeBox, whiteSpace: 'nowrap', overflowX: 'auto', padding: '12px 14px' }}>{freshKey.key}</code>
              <button
                onClick={() => copy(freshKey.key, 'fresh')}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: C.primary, color: '#fff', border: 'none', borderRadius: 8, padding: '0 14px', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}
              >
                {copied === 'fresh' ? <Check size={14} /> : <Copy size={14} />}
                {copied === 'fresh' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text, margin: '0 0 6px' }}>
              Remote connector URL <span style={{ fontWeight: 400, color: C.textSecondary }}>— paste into Claude → Add custom connector (works on web, desktop, mobile)</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
              <code style={{ flex: 1, ...codeBox, whiteSpace: 'nowrap', overflowX: 'auto', padding: '12px 14px' }}>
                {`${window.location.origin}/api/mcp/http/${freshKey.key}`}
              </code>
              <button
                onClick={() => copy(`${window.location.origin}/api/mcp/http/${freshKey.key}`, 'freshurl')}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: C.text, color: '#fff', border: 'none', borderRadius: 8, padding: '0 14px', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}
              >
                {copied === 'freshurl' ? <Check size={14} /> : <Copy size={14} />}
                {copied === 'freshurl' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div style={{ textAlign: 'right' }}>
              <button
                onClick={() => setFreshKey(null)}
                style={{ background: C.text, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      <DeleteConfirmModal
        open={!!revokeTarget}
        title="Revoke API key"
        message={`Revoke “${revokeTarget?.label}”? Any MCP client using it will immediately lose access.`}
        confirmText="Revoke"
        onConfirm={revokeKey}
        onCancel={() => setRevokeTarget(null)}
      />
    </div>
  );
}

function IntegrationsTab() {
  // view: 'apps' | 'google' | 'service:<provider-key>'
  const [view, setView] = useState('apps');
  const [credentials, setCredentials] = useState(null);
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCredForm, setShowCredForm] = useState(false);
  const [credForm, setCredForm] = useState({ clientId: '', clientSecret: '', redirectUri: '' });
  const [savingCreds, setSavingCreds] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [busyProvider, setBusyProvider] = useState(null);
  const [toast, setToast] = useState('');

  const defaultRedirect = `${window.location.origin}/api/integrations/oauth/callback`;

  const load = async () => {
    try {
      setError('');
      const [creds, list] = await Promise.all([
        api.integrations.listCredentials(),
        api.integrations.list(),
      ]);
      setCredentials(creds);
      setConnections(list);
      setCredForm({
        clientId: creds.configured ? (creds.clientId || '') : '',
        clientSecret: '',  // never returned; blank = keep existing
        redirectUri: (creds.configured && creds.redirectUri) || defaultRedirect,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // Meta Ads connection status — drives the app-card badge. Fetched
  // independently so a failure here never blocks the Google integration UI.
  const [mkt, setMkt] = useState({ meta: null });
  const loadMkt = async () => {
    const meta = await api.marketing.metaAds.status().catch(() => null);
    setMkt({ meta });
  };
  useEffect(() => { loadMkt(); /* eslint-disable-next-line */ }, []);

  // Receive postMessage from the OAuth callback popup so we can refresh the
  // list the moment Google sends the user back. Same-origin only — the popup
  // posts to window.opener within the same origin.
  useEffect(() => {
    const handler = (e) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data || {};
      if (d.type === 'forgechat:integration:connected') {
        setToast(`Connected ${(d.provider || '').replace('_', ' ')}${d.email ? ` as ${d.email}` : ''}`);
        load();
        // If the user initiated the connect from inside the Google detail
        // view, jump them straight to the service browser so they can
        // immediately see what's now available.
        if (d.provider) setView(`service:${d.provider}`);
      } else if (d.type === 'forgechat:integration:error') {
        setToast(`Connection failed: ${d.error}`);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const saveCreds = async () => {
    if (!credForm.clientId.trim()) { setError('Client ID is required'); return; }
    if (!credForm.redirectUri.trim()) { setError('Redirect URI is required'); return; }
    if (!credentials?.configured && !credForm.clientSecret.trim()) {
      setError('Client Secret is required when configuring for the first time'); return;
    }
    try {
      setSavingCreds(true);
      setError('');
      await api.integrations.saveCredentials({
        clientId: credForm.clientId.trim(),
        clientSecret: credForm.clientSecret.trim(),
        redirectUri: credForm.redirectUri.trim(),
      });
      setToast('Credentials saved');
      setShowCredForm(false);
      setShowSecret(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingCreds(false);
    }
  };

  const handleConnect = (provider) => {
    if (!credentials?.configured) {
      setError('Save your Google OAuth credentials first.');
      setShowCredForm(true);
      return;
    }
    setBusyProvider(provider);
    const url = api.integrations.connectUrl(provider);
    const w = 560, h = 720;
    const left = (window.screen.width - w) / 2;
    const top = (window.screen.height - h) / 2;
    const popup = window.open(url, 'forgechat-google-oauth',
      `width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) {
      setError('Pop-up blocked — allow pop-ups for this site, then click Connect again.');
      setBusyProvider(null);
      return;
    }
    // Clear the busy flag once the popup closes (regardless of outcome) so the
    // user can retry if Google didn't issue a postMessage.
    const t = setInterval(() => {
      if (popup.closed) { clearInterval(t); setBusyProvider(null); }
    }, 700);
  };

  const handleDisconnect = async (conn) => {
    if (!confirm(`Disconnect ${conn.providerLabel}? You'll need to re-authorize to reconnect.`)) return;
    try {
      await api.integrations.disconnect(conn.id);
      setToast(`Disconnected ${conn.providerLabel}`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleTest = async (conn) => {
    try {
      setBusyProvider(conn.provider);
      const r = await api.integrations.test(conn.id);
      setToast(`✓ ${conn.providerLabel} is healthy${r.email ? ` (${r.email})` : ''}`);
      await load();
    } catch (err) {
      setError(`Test failed: ${err.message}`);
      await load();
    } finally {
      setBusyProvider(null);
    }
  };

  const copyRedirect = async () => {
    try { await navigator.clipboard.writeText(defaultRedirect); setToast('Redirect URI copied'); } catch {/* */}
  };

  const findConn = (key) => connections.find(c => c.provider === key);

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.textMuted, fontSize: 15, fontFamily: FONT }}>
        <Loader2 size={16} style={{ marginRight: 8, animation: 'spin 1s linear infinite' }} /> Loading…
      </div>
    );
  }

  const googleApp = INTEGRATION_APPS[0];
  const googleConnCount = googleApp.providers.filter(p => connections.find(c => c.provider === p)?.status === 'connected').length;

  // ─── Sub-views ────────────────────────────────────────────────────

  const renderAppsView = () => (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: 0 }}>Integrations</h2>
        <div style={{ fontSize: 15, color: C.textSecondary, marginTop: 4 }}>
          Connect third-party apps so your automations can read and write data outside of WhatsApp.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        <AppCard
          color={googleApp.color}
          logo={googleApp.logo(28)}
          label={googleApp.label}
          blurb={googleApp.blurb}
          onClick={() => setView('google')}
          badge={googleConnCount > 0 ? (
            <span style={{ fontSize: 13, padding: '2px 8px', background: 'var(--c-sdcfce7, #dcfce7)', color: 'var(--c-s15803d, #15803d)', borderRadius: 6, fontWeight: 600 }}>
              {googleConnCount} of {googleApp.providers.length} connected
            </span>
          ) : credentials?.configured ? (
            <span style={{ fontSize: 13, padding: '2px 8px', background: 'var(--c-sfef9c3, #fef9c3)', color: 'var(--c-warnText, #854d0e)', borderRadius: 6, fontWeight: 600 }}>Credentials saved · not connected</span>
          ) : (
            <span style={{ fontSize: 13, padding: '2px 8px', background: C.sidebarBg, color: C.textMuted, borderRadius: 6, fontWeight: 600 }}>Not configured</span>
          )}
        />
        <AppCard
          color="var(--c-x0866ff, #0866FF)"
          logo={MetaLogo(28)}
          label="Meta Ads Manager"
          blurb="Pull live campaign spend & results from your ad accounts."
          badge={connBadge(mkt.meta)}
          onClick={() => setView('meta_ads')}
        />
      </div>

      <div style={{ marginTop: 24, padding: 14, background: C.sidebarBg, border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 14, color: C.textSecondary, lineHeight: 1.7 }}>
        <div style={{ fontWeight: 600, color: C.text, marginBottom: 4 }}>How automations use these</div>
        Once an app is connected, your automation Actions can call into it:
        <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
          <li><b>Send Email</b> — via Gmail.</li>
          <li><b>Append to Google Sheet</b> — pick a sheet + tab.</li>
          <li><b>Create Calendar Event</b> — on the connected calendar.</li>
        </ul>
        More apps (Slack, Notion, custom webhooks) coming soon.
      </div>
    </div>
  );

  const renderCredentialsCard = () => (
    <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Key size={16} color={C.primary} />
          <div style={{ fontWeight: 600, fontSize: 15, color: C.text }}>Google API credentials</div>
          {credentials?.configured && !showCredForm && (
            <span style={{ fontSize: 13, padding: '2px 8px', background: '#16a34a22', color: 'var(--c-s15803d, #15803d)', borderRadius: 6, fontWeight: 600 }}>SAVED</span>
          )}
          {!credentials?.configured && !showCredForm && (
            <span style={{ fontSize: 13, padding: '2px 8px', background: 'var(--c-sfef9c3, #fef9c3)', color: 'var(--c-warnText, #854d0e)', borderRadius: 6, fontWeight: 600 }}>REQUIRED</span>
          )}
        </div>
        {!showCredForm && (
          <button onClick={() => setShowCredForm(true)} style={credentials?.configured ? igBtnSecondary() : igBtnPrimary()}>
            <Settings size={13} /> {credentials?.configured ? 'Edit credentials' : 'Configure credentials'}
          </button>
        )}
      </div>

      <div style={{ fontSize: 14, color: C.textSecondary, marginBottom: 14, lineHeight: 1.6 }}>
        Create an OAuth 2.0 Client ID at <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" style={{ color: C.primary }}>console.cloud.google.com/apis/credentials</a>{' '}
        → choose <b>Web application</b> → add the redirect URI below to <b>Authorized redirect URIs</b> → enable the <b>Sheets</b>, <b>Drive</b>, <b>Calendar</b>, and <b>Gmail</b> APIs in the same project.
      </div>

      <div style={{ marginBottom: showCredForm ? 14 : 0 }}>
        <div style={igLabelStyle()}>Authorized redirect URI (use this in Google Cloud)</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={defaultRedirect} readOnly style={{ ...igInputStyle(), background: C.sidebarBg, fontFamily: "'DM Mono', monospace", fontSize: 14 }} />
          <button onClick={copyRedirect} style={igBtnSecondary()}><Copy size={13} /> Copy</button>
        </div>
      </div>

      {showCredForm && (
        <div>
          <div style={{ marginBottom: 12 }}>
            <div style={igLabelStyle()}>Client ID</div>
            <input value={credForm.clientId} onChange={e => setCredForm({ ...credForm, clientId: e.target.value })}
              placeholder="e.g. 123456789-abc.apps.googleusercontent.com"
              style={igInputStyle()} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={igLabelStyle()}>
              Client Secret {credentials?.configured && <span style={{ fontWeight: 400, color: C.textMuted, textTransform: 'none', letterSpacing: 0 }}>— leave blank to keep existing</span>}
            </div>
            <div style={{ position: 'relative' }}>
              <input
                type={showSecret ? 'text' : 'password'}
                value={credForm.clientSecret}
                onChange={e => setCredForm({ ...credForm, clientSecret: e.target.value })}
                placeholder={credentials?.configured ? '••••••••' : 'GOCSPX-...'}
                style={{ ...igInputStyle(), paddingRight: 38 }} />
              <button type="button" onClick={() => setShowSecret(s => !s)}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 0, cursor: 'pointer', color: C.textMuted }}>
                {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
          <div style={{ marginBottom: 14 }}>
            <div style={igLabelStyle()}>Redirect URI (must match Google Cloud exactly)</div>
            <input value={credForm.redirectUri} onChange={e => setCredForm({ ...credForm, redirectUri: e.target.value })}
              style={{ ...igInputStyle(), fontFamily: "'DM Mono', monospace", fontSize: 14 }} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={saveCreds} disabled={savingCreds} style={igBtnPrimary(savingCreds)}>
              {savingCreds ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Saving…</> : <><Check size={13} /> Save credentials</>}
            </button>
            <button onClick={() => { setShowCredForm(false); setShowSecret(false); }} style={igBtnSecondary()}>Cancel</button>
          </div>
        </div>
      )}

      {!showCredForm && credentials?.configured && (
        <div style={{ marginTop: 14, fontSize: 14, color: C.textMuted, fontFamily: "'DM Mono', monospace" }}>
          Client ID: {credentials.clientId ? `${credentials.clientId.slice(0, 40)}${credentials.clientId.length > 40 ? '…' : ''}` : '—'}
        </div>
      )}
    </div>
  );

  const renderGoogleView = () => (
    <div>
      {/* Breadcrumb */}
      <button onClick={() => setView('apps')} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 0, cursor: 'pointer',
        color: C.textSecondary, fontSize: 15, fontFamily: FONT, padding: '4px 0', marginBottom: 16,
      }}>
        <ChevronLeft size={14} /> Apps
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
        <div style={{ width: 56, height: 56, borderRadius: 14, background: 'var(--c-surface, #fff)', border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {googleApp.logo(34)}
        </div>
        <div>
          <h2 style={{ fontSize: 24, fontWeight: 700, color: C.text, margin: 0 }}>Google</h2>
          <div style={{ fontSize: 15, color: C.textSecondary, marginTop: 2 }}>{googleApp.blurb}</div>
        </div>
      </div>

      {renderCredentialsCard()}

      <div style={{ fontSize: 13, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
        Google services
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {PROVIDERS.map(p => {
          const conn = findConn(p.key);
          const isConnected = conn && conn.status === 'connected';
          const isError = conn && conn.status === 'error';
          const Icon = p.icon;
          const busy = busyProvider === p.key;
          return (
            <div key={p.key} style={{
              background: C.cardBg, border: `1px solid ${isConnected ? '#bbf7d0' : isError ? '#fecaca' : C.border}`,
              borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 38, height: 38, borderRadius: 10, background: `${p.color}22`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon size={20} color={p.color} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, color: C.text }}>{p.label}</div>
                  <div style={{ fontSize: 13, color: C.textSecondary }}>{p.blurb}</div>
                </div>
                {isConnected && <CheckCircle2 size={16} color="#16a34a" />}
                {isError && <AlertCircle size={16} color="var(--c-primary, #dc2626)" />}
              </div>

              {conn ? (
                <div style={{ fontSize: 14, color: C.textSecondary, padding: '8px 10px', background: C.sidebarBg, borderRadius: 8, border: `1px solid ${C.border}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <User size={12} />
                    <span style={{ color: C.text, fontWeight: 500 }}>{conn.accountEmail || '(unknown)'}</span>
                  </div>
                  {conn.accountName && (
                    <div style={{ marginTop: 2, fontSize: 13 }}>{conn.accountName}</div>
                  )}
                  {conn.lastUsedAt && (
                    <div style={{ marginTop: 4, fontSize: 13, color: C.textMuted }}>
                      Last used {new Date(conn.lastUsedAt).toLocaleString()}
                    </div>
                  )}
                  {isError && conn.lastError && (
                    <div style={{ marginTop: 6, fontSize: 13, color: 'var(--c-dangerText, #A32D2D)' }}>
                      {conn.lastError}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 14, color: C.textMuted, fontStyle: 'italic' }}>Not connected</div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 'auto', flexWrap: 'wrap' }}>
                {isConnected ? (
                  <>
                    <button onClick={() => setView(`service:${p.key}`)} style={igBtnPrimary()}>
                      <ChevronRight size={13} /> Open
                    </button>
                    <button onClick={() => handleConnect(p.key)} disabled={busy} style={igBtnSecondary(busy)} title="Reconnect to refresh tokens">
                      {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={13} />}
                    </button>
                    <button onClick={() => handleTest(conn)} disabled={busy} style={igBtnSecondary(busy)} title="Run a live health check">
                      <Play size={12} />
                    </button>
                    <button onClick={() => handleDisconnect(conn)} style={igBtnDanger()} title="Disconnect">
                      <Unplug size={13} />
                    </button>
                  </>
                ) : (
                  <button onClick={() => handleConnect(p.key)} disabled={busy || !credentials?.configured} style={igBtnPrimary(busy || !credentials?.configured)}>
                    {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Link2 size={13} />}
                    Connect
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  // ─── Master render ─────────────────────────────────────────────────

  return (
    <div style={{ flex: 1, padding: '28px 32px', fontFamily: FONT, overflowY: 'auto' }}>
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>

      {error && (
        <div style={{ padding: '10px 14px', background: 'var(--c-dangerBg, #FCEBEB)', color: 'var(--c-dangerText, #A32D2D)', border: '1px solid #f5c2c2', borderRadius: 8, marginBottom: 16, fontSize: 15, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <span>{error}</span>
          <button onClick={() => setError('')} style={{ background: 'transparent', border: 0, cursor: 'pointer', color: 'var(--c-dangerText, #A32D2D)' }}><X size={14} /></button>
        </div>
      )}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, padding: '10px 14px', background: C.text, color: '#fff', borderRadius: 8, fontSize: 15, boxShadow: C.shadowLg, zIndex: 200 }}>{toast}</div>
      )}

      {view === 'apps' && renderAppsView()}
      {view === 'google' && renderGoogleView()}
      {view === 'meta_ads' && (
        <div>
          <button onClick={() => { setView('apps'); loadMkt(); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 0, cursor: 'pointer', color: C.textSecondary, fontSize: 15, fontFamily: FONT, padding: '4px 0', marginBottom: 16 }}>
            <ChevronLeft size={14} /> <span>Apps</span>
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, background: 'var(--c-surface, #fff)', border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {MetaLogo(28)}
            </div>
            <div>
              <h2 style={{ fontSize: 24, fontWeight: 700, color: C.text, margin: 0 }}>Meta Ads Manager</h2>
              <div style={{ fontSize: 15, color: C.textSecondary, marginTop: 2 }}>
                Pull live campaign spend &amp; results from your ad accounts.
              </div>
            </div>
          </div>
          <MetaAdsPanel onSynced={loadMkt} />
        </div>
      )}
      {view.startsWith('service:') && (
        <ServiceBrowser
          provider={view.slice('service:'.length)}
          connections={connections}
          onBack={() => setView('google')}
          onError={setError}
        />
      )}
    </div>
  );
}

// ─── Service browser (Sheets / Calendar / Gmail discovery) ────────────────

function ServiceBrowser({ provider, connections, onBack, onError }) {
  const conn = connections.find(c => c.provider === provider);
  if (!conn || conn.status !== 'connected') {
    return (
      <div>
        <button onClick={onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 0, cursor: 'pointer', color: C.textSecondary, fontSize: 15, fontFamily: FONT, padding: '4px 0', marginBottom: 16 }}>
          <ChevronLeft size={14} /> Google
        </button>
        <div style={{ padding: 24, background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, color: C.textMuted, textAlign: 'center' }}>
          This service isn't connected yet. Go back and click <b>Connect</b>.
        </div>
      </div>
    );
  }

  return (
    <div>
      <button onClick={onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 0, cursor: 'pointer', color: C.textSecondary, fontSize: 15, fontFamily: FONT, padding: '4px 0', marginBottom: 16 }}>
        <ChevronLeft size={14} /> <span>Apps</span> <ChevronRight size={12} /> <span>Google</span>
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
        <div style={{ width: 48, height: 48, borderRadius: 12, background: `${PROVIDERS.find(p => p.key === provider)?.color || C.primary}22`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {(() => {
            const p = PROVIDERS.find(x => x.key === provider);
            const Icon = p?.icon || Plug;
            return <Icon size={26} color={p?.color || C.primary} />;
          })()}
        </div>
        <div>
          <h2 style={{ fontSize: 24, fontWeight: 700, color: C.text, margin: 0 }}>{PROVIDERS.find(p => p.key === provider)?.label || provider}</h2>
          <div style={{ fontSize: 15, color: C.textSecondary, marginTop: 2 }}>
            Connected as <b>{conn.accountEmail}</b>
          </div>
        </div>
      </div>

      {provider === 'google_sheets' && <SheetsBrowser onError={onError} />}
      {provider === 'google_calendar' && <CalendarBrowser onError={onError} />}
      {provider === 'gmail' && <GmailBrowser onError={onError} />}
    </div>
  );
}

// ─── Sheets browser: list spreadsheets → drill into tabs → preview headers ──

function SheetsBrowser({ onError }) {
  const [spreadsheets, setSpreadsheets] = useState(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [selectedSheet, setSelectedSheet] = useState(null);
  const [selectedTab, setSelectedTab] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);

  // Debounce the spreadsheet search so each keystroke doesn't hit Drive
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);
    api.integrations.sheets.listSpreadsheets(debouncedSearch)
      .then(r => { if (!cancelled) setSpreadsheets(r.spreadsheets || []); })
      .catch(err => { if (!cancelled) { onError(err.message); setSpreadsheets([]); } })
      .finally(() => { if (!cancelled) setLoadingList(false); });
    return () => { cancelled = true; };
  }, [debouncedSearch, onError]);

  const openSpreadsheet = async (s) => {
    setSelectedId(s.id);
    setSelectedSheet(null);
    setSelectedTab(null);
    setPreview(null);
    setLoadingDetail(true);
    try {
      const detail = await api.integrations.sheets.getSpreadsheet(s.id);
      setSelectedSheet(detail);
      if (detail.tabs?.length) {
        openTab(s.id, detail.tabs[0].title);
      }
    } catch (err) {
      onError(err.message);
    } finally {
      setLoadingDetail(false);
    }
  };

  const openTab = async (id, tabTitle) => {
    setSelectedTab(tabTitle);
    setPreview(null);
    setLoadingPreview(true);
    try {
      const p = await api.integrations.sheets.previewTab(id, tabTitle, 5);
      setPreview(p);
    } catch (err) {
      onError(err.message);
    } finally {
      setLoadingPreview(false);
    }
  };

  return (
    <div>
      <div style={{ marginBottom: 14, position: 'relative' }}>
        <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: C.textMuted, pointerEvents: 'none' }} />
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search your spreadsheets…"
          style={{ ...igInputStyle(), paddingLeft: 34 }}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: selectedId ? '1fr 1.6fr' : '1fr', gap: 16 }}>
        {/* Left: spreadsheet list */}
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, maxHeight: 520, overflowY: 'auto' }}>
          {loadingList && (
            <div style={{ padding: 18, textAlign: 'center', color: C.textMuted, fontSize: 15 }}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', marginRight: 6 }} /> Loading…
            </div>
          )}
          {!loadingList && spreadsheets && spreadsheets.length === 0 && (
            <div style={{ padding: 18, textAlign: 'center', color: C.textMuted, fontSize: 15 }}>
              No spreadsheets found.
            </div>
          )}
          {!loadingList && spreadsheets && spreadsheets.map(s => (
            <button
              key={s.id}
              onClick={() => openSpreadsheet(s)}
              style={{
                width: '100%', textAlign: 'left', cursor: 'pointer',
                background: selectedId === s.id ? C.sidebarBg : 'transparent',
                border: 0, borderBottom: `1px solid ${C.border}`,
                padding: '12px 14px', fontFamily: FONT,
                display: 'flex', alignItems: 'center', gap: 10,
              }}
            >
              <FileSpreadsheet size={16} color="var(--c-x0f9d58, #0F9D58)" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 500, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                <div style={{ fontSize: 13, color: C.textMuted }}>
                  Edited {s.modifiedTime ? new Date(s.modifiedTime).toLocaleDateString() : '—'}
                  {s.ownerEmail && ` · ${s.ownerEmail}`}
                </div>
              </div>
              <ChevronRight size={14} color={C.textMuted} />
            </button>
          ))}
        </div>

        {/* Right: spreadsheet detail */}
        {selectedId && (
          <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 14, maxHeight: 520, overflowY: 'auto' }}>
            {loadingDetail && (
              <div style={{ color: C.textMuted, fontSize: 15, textAlign: 'center', padding: 14 }}>
                <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', marginRight: 6 }} /> Loading spreadsheet…
              </div>
            )}
            {!loadingDetail && selectedSheet && (
              <>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <div style={{ fontWeight: 600, fontSize: 16, color: C.text }}>{selectedSheet.title}</div>
                    <a
                      href={`https://docs.google.com/spreadsheets/d/${selectedSheet.id}`}
                      target="_blank" rel="noreferrer"
                      style={{ color: C.textMuted, display: 'inline-flex', alignItems: 'center' }}
                      title="Open in Google Sheets"
                    >
                      <ExternalLink size={13} />
                    </a>
                  </div>
                  <div style={{ fontSize: 13, color: C.textMuted, fontFamily: "'DM Mono', monospace" }}>
                    ID: {selectedSheet.id}
                  </div>
                </div>

                <div>
                  <div style={igLabelStyle()}>Tabs ({selectedSheet.tabs.length})</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {selectedSheet.tabs.map(t => (
                      <button
                        key={t.sheetId}
                        onClick={() => openTab(selectedSheet.id, t.title)}
                        style={{
                          cursor: 'pointer', fontFamily: FONT,
                          padding: '5px 10px', borderRadius: 6, fontSize: 14,
                          background: selectedTab === t.title ? C.primary : C.cardBg,
                          color: selectedTab === t.title ? '#fff' : C.text,
                          border: `1px solid ${selectedTab === t.title ? C.primary : C.border}`,
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                        }}
                      >
                        <Table2 size={11} /> {t.title}
                        <span style={{ opacity: 0.7, fontSize: 12 }}>· {t.rowCount}×{t.columnCount}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {selectedTab && (
                  <div>
                    <div style={igLabelStyle()}>Preview · {selectedTab}</div>
                    {loadingPreview && (
                      <div style={{ color: C.textMuted, fontSize: 14, padding: 10 }}>
                        <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', marginRight: 6 }} /> Loading…
                      </div>
                    )}
                    {!loadingPreview && preview && (
                      <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 8 }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, fontFamily: FONT }}>
                          <thead>
                            <tr style={{ background: C.sidebarBg }}>
                              {(preview.headers.length ? preview.headers : ['(empty)']).map((h, i) => (
                                <th key={i} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: C.text, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h || `Col ${i + 1}`}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {preview.rows.length === 0 && (
                              <tr>
                                <td colSpan={preview.headers.length || 1} style={{ padding: '14px 10px', color: C.textMuted, fontStyle: 'italic', textAlign: 'center' }}>
                                  No data rows in this tab yet.
                                </td>
                              </tr>
                            )}
                            {preview.rows.map((row, ri) => (
                              <tr key={ri}>
                                {row.map((cell, ci) => (
                                  <td key={ci} style={{ padding: '6px 10px', borderBottom: ri === preview.rows.length - 1 ? 0 : `1px solid ${C.border}`, color: C.text, whiteSpace: 'nowrap', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {String(cell)}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div style={{ marginTop: 8, fontSize: 13, color: C.textMuted, fontFamily: "'DM Mono', monospace" }}>
                      Use in automation: <code>{selectedSheet.id} | {selectedTab}!A:Z | val1, val2, …</code>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Calendar browser: list calendars ──────────────────────────────────────

function CalendarBrowser({ onError }) {
  const [calendars, setCalendars] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.integrations.calendar.listCalendars()
      .then(r => { if (!cancelled) setCalendars(r.calendars || []); })
      .catch(err => { if (!cancelled) { onError(err.message); setCalendars([]); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [onError]);

  if (loading) return <div style={{ color: C.textMuted, fontSize: 15, padding: 20, textAlign: 'center' }}><Loader2 size={14} style={{ animation: 'spin 1s linear infinite', marginRight: 6 }} /> Loading calendars…</div>;

  return (
    <div>
      <div style={igLabelStyle()}>Your calendars ({calendars.length})</div>
      <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15, fontFamily: FONT }}>
          <thead>
            <tr style={{ background: C.sidebarBg }}>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: C.text, borderBottom: `1px solid ${C.border}` }}>Name</th>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: C.text, borderBottom: `1px solid ${C.border}` }}>ID</th>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: C.text, borderBottom: `1px solid ${C.border}` }}>Access</th>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: C.text, borderBottom: `1px solid ${C.border}` }}>Timezone</th>
            </tr>
          </thead>
          <tbody>
            {calendars.length === 0 && (
              <tr><td colSpan={4} style={{ padding: 16, textAlign: 'center', color: C.textMuted }}>No calendars found.</td></tr>
            )}
            {calendars.map(c => (
              <tr key={c.id}>
                <td style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, color: C.text }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 12, height: 12, borderRadius: 3, background: c.color || '#4285F4', display: 'inline-block' }} />
                    <span style={{ fontWeight: 500 }}>{c.summary}</span>
                    {c.primary && <span style={{ fontSize: 12, padding: '1px 6px', background: 'var(--c-sdbeafe, #dbeafe)', color: 'var(--c-s1d4ed8, #1d4ed8)', borderRadius: 4, fontWeight: 600 }}>PRIMARY</span>}
                  </div>
                  {c.description && <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>{c.description}</div>}
                </td>
                <td style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, color: C.textMuted, fontFamily: "'DM Mono', monospace", fontSize: 13 }}>{c.id}</td>
                <td style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, color: C.text, fontSize: 14 }}>{c.accessRole}</td>
                <td style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, color: C.text, fontSize: 14 }}>{c.timeZone}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 12, fontSize: 13, color: C.textMuted, fontFamily: "'DM Mono', monospace" }}>
        Use in automation: <code>&lt;calendarId&gt; | Title | startISO | endISO | description</code>
      </div>
    </div>
  );
}

// ─── Gmail browser: profile + labels ──────────────────────────────────────

function GmailBrowser({ onError }) {
  const [profile, setProfile] = useState(null);
  const [labels, setLabels] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.integrations.gmail.profile(), api.integrations.gmail.labels()])
      .then(([p, l]) => { if (!cancelled) { setProfile(p); setLabels(l.labels || []); } })
      .catch(err => { if (!cancelled) onError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [onError]);

  if (loading) return <div style={{ color: C.textMuted, fontSize: 15, padding: 20, textAlign: 'center' }}><Loader2 size={14} style={{ animation: 'spin 1s linear infinite', marginRight: 6 }} /> Loading Gmail…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <KpiCard label="Address" value={profile?.emailAddress || '—'} />
        <KpiCard label="Total messages" value={profile?.messagesTotal?.toLocaleString() || '—'} />
        <KpiCard label="Total threads" value={profile?.threadsTotal?.toLocaleString() || '—'} />
      </div>

      <div>
        <div style={igLabelStyle()}>Labels ({labels?.length || 0})</div>
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
          {labels && labels.map(l => (
            <span key={l.id} style={{
              fontSize: 14, padding: '4px 10px', borderRadius: 6,
              background: l.type === 'system' ? C.sidebarBg : 'var(--c-sfef3c7, #fef3c7)',
              color: l.type === 'system' ? C.text : 'var(--c-warnText, #854d0e)',
              border: `1px solid ${l.type === 'system' ? C.border : '#fde68a'}`,
              display: 'inline-flex', alignItems: 'center', gap: 5,
            }}>
              <Inbox size={11} /> {l.name}
            </span>
          ))}
          {labels && labels.length === 0 && <span style={{ color: C.textMuted, fontSize: 14, fontStyle: 'italic' }}>No labels.</span>}
        </div>
      </div>

      <div style={{ fontSize: 13, color: C.textMuted, fontFamily: "'DM Mono', monospace" }}>
        Use in automation: <code>to@example.com | Subject | Body</code>
      </div>
    </div>
  );
}

function KpiCard({ label, value }) {
  return (
    <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 13, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: C.text, fontFamily: "'DM Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  );
}

function igLabelStyle() {
  return {
    display: 'block', fontSize: 13, fontWeight: 600,
    color: C.textSecondary, textTransform: 'uppercase',
    letterSpacing: '0.04em', marginBottom: 6,
  };
}
function igInputStyle() {
  return {
    width: '100%', padding: '9px 11px',
    border: `1px solid ${C.border}`, borderRadius: 8,
    fontSize: 15, fontFamily: FONT, color: C.text, background: C.cardBg,
    outline: 'none', boxSizing: 'border-box',
  };
}
function igBtnPrimary(disabled) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 14px', background: disabled ? '#999' : C.primary,
    color: '#fff', border: 0, borderRadius: 8, fontSize: 15, fontWeight: 600,
    fontFamily: FONT, cursor: disabled ? 'not-allowed' : 'pointer',
  };
}
function igBtnSecondary(disabled) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 12px', background: C.cardBg, color: C.text,
    border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 15, fontWeight: 500,
    fontFamily: FONT, cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}
function igBtnDanger() {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 12px', background: 'var(--c-surface, #fff)', color: C.primary,
    border: `1px solid #fecaca`, borderRadius: 8, fontSize: 15, fontWeight: 500,
    fontFamily: FONT, cursor: 'pointer',
  };
}

// The Webhooks tab lists one CARD per webhook provider (WhatsApp + Razorpay).
// Clicking a card opens that provider's DETAIL view: config fields on top, a
// 10-per-page event-history table below. Each provider is a self-contained panel
// rendered in mode="card" (just the tile) or mode="detail" (the full page).
function WebhooksTab() {
  const [open, setOpen] = useState(null);   // null | 'whatsapp' | 'razorpay'
  if (open === 'whatsapp') return <WhatsAppWebhookPanel mode="detail" onBack={() => setOpen(null)} />;
  if (open === 'razorpay') return <RazorpayWebhookPanel mode="detail" onBack={() => setOpen(null)} />;
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 28, overflow: 'auto', fontFamily: FONT }}>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-.02em' }}>Webhooks</h2>
        <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 4 }}>
          Inbound webhook endpoints. Open a provider to edit its configuration and view recent activity.
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14 }}>
        <WhatsAppWebhookPanel mode="card" onOpen={() => setOpen('whatsapp')} />
        <RazorpayWebhookPanel mode="card" onOpen={() => setOpen('razorpay')} />
      </div>
    </div>
  );
}

// ── WhatsApp Cloud API webhook panel ─────────────────────────────────────────
// Verify token is editable and binds to the DEFAULT WhatsApp account — the only
// API-editable verify token the Meta handshake validates (the env
// META_WEBHOOK_VERIFY_TOKEN fallback is not settable from the app).
function WhatsAppWebhookPanel({ mode, onOpen, onBack }) {
  const [view] = useState(mode);        // 'card' | 'detail' (fixed per mount)

  // Config (from whatsapp_accounts — the default account holds the editable token)
  const [accounts, setAccounts] = useState([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const defaultAccount = accounts.find(a => a.isDefault) || accounts[0] || null;
  const [verifyToken, setVerifyToken] = useState('');
  const [tokenDirty, setTokenDirty] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [savingToken, setSavingToken] = useState(false);

  // Card summary
  const [summary, setSummary] = useState({ total: 0, lastReceivedAt: null });

  // History (recent 10, paged)
  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [testOpen, setTestOpen] = useState(false);
  const PAGE_SIZE = 10;

  const webhookUrl = `${window.location.origin}/api/webhook/whatsapp`;
  const [copied, setCopied] = useState(false);
  const copyUrl = async () => {
    try { await navigator.clipboard.writeText(webhookUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard blocked */ }
  };

  // Load the default account's verify token for editing.
  const loadAccounts = async () => {
    try {
      const data = await api.whatsappAccounts.list();
      setAccounts(data || []);
      const def = (data || []).find(a => a.isDefault) || (data || [])[0] || null;
      setVerifyToken(def?.verifyToken || '');
      setTokenDirty(false);
    } catch { /* config is optional — history still works */ }
    finally { setAccountsLoaded(true); }
  };

  // Card summary: total events + most-recent received_at (list is DESC).
  const loadSummary = async () => {
    try {
      const res = await api.webhookEvents.list({ limit: 1, offset: 0 });
      setSummary({ total: res.total || 0, lastReceivedAt: res.events?.[0]?.received_at || null });
    } catch { /* ignore */ }
  };

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.webhookEvents.list({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, q });
      setEvents(res.events || []);
      setTotal(res.total || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAccounts(); loadSummary(); }, []);
  // Fetch history when the detail view is open (and on page change).
  useEffect(() => { if (view === 'detail') load(); /* eslint-disable-next-line */ }, [view, page]);
  // Debounce payload search (detail view only).
  useEffect(() => {
    if (view !== 'detail') return;
    const id = setTimeout(() => { setPage(0); load(); }, 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line
  }, [q]);

  const saveToken = async () => {
    if (!defaultAccount) { notify('Add a WhatsApp account first to set a verify token.'); return; }
    setSavingToken(true);
    try {
      await api.whatsappAccounts.update(defaultAccount.id, { verifyToken: verifyToken.trim() });
      setTokenDirty(false);
      notify('Verify token saved.');
      await loadAccounts();
    } catch (err) {
      notify(err.message || 'Failed to save verify token');
    } finally {
      setSavingToken(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const tokenSet = !!(defaultAccount && (defaultAccount.verifyToken || '').trim());

  const labelStyle = { display: 'block', fontSize: 13, fontWeight: 700, color: 'var(--c-t4, #666)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6, fontFamily: FONT };
  const roStyle = { ...inputStyle, background: 'var(--c-hover)', color: 'var(--c-s555555, #555)', fontFamily: 'DM Mono, monospace' };

  // ── Header (shared by both views) ────────────────────────────────────────────
  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
      <div>
        <h2 style={{ fontSize: 24, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-.02em' }}>Webhooks</h2>
        <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 4 }}>
          {view === 'card'
            ? 'Your WhatsApp Cloud API webhook endpoint. Open it to edit the config and view recent activity.'
            : 'Callback URL + verify token, and the most recent inbound payloads. Retention: 30 days.'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => setTestOpen(true)} style={{ ...btnSecondary, color: 'var(--c-primary, #dc2626)', borderColor: '#FCC', fontWeight: 700 }}>
          <Play size={12} /> Send Test Webhook
        </button>
        <button onClick={() => { loadSummary(); if (view === 'detail') load(); }} style={btnSecondary}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
    </div>
  );

  // ── Card ─────────────────────────────────────────────────────────────────────
  if (view === 'card') {
    return (
          <button
            onClick={onOpen}
            style={{ textAlign: 'left', background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, cursor: 'pointer', fontFamily: FONT, display: 'flex', flexDirection: 'column', gap: 14 }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = C.primary; e.currentTarget.style.boxShadow = C.shadowMd; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.boxShadow = 'none'; }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 42, height: 42, borderRadius: 10, background: 'var(--c-primaryLight)', color: 'var(--c-primary, #dc2626)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Webhook size={20} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>WhatsApp Cloud API Webhook</div>
                <div style={{ fontSize: 13, color: C.textMuted, fontFamily: 'DM Mono, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{webhookUrl}</div>
              </div>
              <ChevronRight size={18} style={{ color: 'var(--c-t7, #999)', flexShrink: 0 }} />
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 99, fontSize: 13, fontWeight: 700, ...(tokenSet ? { background: 'var(--c-successBgSoft, #E4F3EE)', color: 'var(--c-successText, #0F6E56)' } : { background: 'var(--c-surfaceSubtle, #EEEDE8)', color: 'var(--c-t4, #666)' }) }}>
                {tokenSet ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                {tokenSet ? 'Verify token set' : 'Using env fallback'}
              </span>
              {defaultAccount && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 99, fontSize: 13, fontWeight: 700, background: 'var(--c-hover)', color: 'var(--c-s555555, #555)' }}>
                  <Phone size={11} /> {maskPhone(String(defaultAccount.displayPhoneNumber || '').replace(/\D/g, ''))}
                </span>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-t6, #888)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Total events</div>
                <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 22, fontWeight: 700, color: C.text, marginTop: 2 }}>{(summary.total || 0).toLocaleString()}</div>
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-t6, #888)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Last received</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginTop: 4 }}>
                  {summary.lastReceivedAt ? new Date(summary.lastReceivedAt).toLocaleString('en-IN', { hour12: false }) : <span style={{ color: C.textMuted, fontWeight: 400 }}>No events yet</span>}
                </div>
              </div>
            </div>
          </button>
    );
  }

  // ── Detail view ──────────────────────────────────────────────────────────────
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 28, overflow: 'auto', fontFamily: FONT }}>
      <button onClick={onBack} style={{ ...btnSecondary, alignSelf: 'flex-start', marginBottom: 14 }}>
        <ArrowLeft size={13} /> Webhooks
      </button>

      {header}

      {/* Configuration panel */}
      <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, marginBottom: 18 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: '0 0 14px' }}>Configuration</h3>

        {/* Callback URL */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Callback URL</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={webhookUrl} readOnly style={roStyle} />
            <button type="button" onClick={copyUrl} title={copied ? 'Copied!' : 'Copy URL'} style={{ flexShrink: 0, width: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', color: copied ? C.green : C.textSecondary }}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 5 }}>Register this in Meta App Dashboard → WhatsApp → Configuration.</div>
        </div>

        {/* Verify token — editable, saved to the default account */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Verify token</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <input
                type={showToken ? 'text' : 'password'}
                value={verifyToken}
                onChange={e => { setVerifyToken(e.target.value); setTokenDirty(true); }}
                placeholder={defaultAccount ? 'Enter a verify token…' : 'Add a WhatsApp account first'}
                disabled={!defaultAccount}
                style={{ ...inputStyle, paddingRight: 34, fontFamily: 'DM Mono, monospace' }}
              />
              <button type="button" onClick={() => setShowToken(s => !s)} style={{ position: 'absolute', right: 6, top: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: C.textSecondary, padding: 2 }}>
                {showToken ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <button
              type="button"
              onClick={saveToken}
              disabled={!defaultAccount || !tokenDirty || savingToken}
              style={{ ...btnSecondary, opacity: (!defaultAccount || !tokenDirty || savingToken) ? 0.5 : 1, cursor: (!defaultAccount || !tokenDirty || savingToken) ? 'default' : 'pointer', fontWeight: 700 }}
            >
              {savingToken ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={12} />} Save
            </button>
          </div>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 5 }}>
            {defaultAccount
              ? <>Meta echoes this during the webhook handshake. Saved to the default number ({defaultAccount.displayName}). Leave blank to fall back to the server env token.</>
              : <>No WhatsApp account configured yet — add one under WhatsApp Accounts, then set the verify token here.</>}
          </div>
        </div>

        {/* Read-only context */}
        {defaultAccount && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
            <div>
              <div style={labelStyle}>Default number</div>
              <MaskedNumber number={String(defaultAccount.displayPhoneNumber || '').replace(/\D/g, '')} prefix="+" style={{ fontSize: 15, color: C.text, fontFamily: 'DM Mono, monospace' }} />
            </div>
            <div>
              <div style={labelStyle}>Phone number ID</div>
              <div style={{ fontSize: 15, color: C.text, fontFamily: 'DM Mono, monospace', wordBreak: 'break-all' }}>{defaultAccount.phoneNumberId || '—'}</div>
            </div>
            <div>
              <div style={labelStyle}>WABA ID</div>
              <div style={{ fontSize: 15, color: C.text, fontFamily: 'DM Mono, monospace', wordBreak: 'break-all' }}>{defaultAccount.wabaId || '—'}</div>
            </div>
          </div>
        )}
      </div>

      {/* Recent webhook history */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: 0 }}>Recent webhook events</h3>
        <div style={{ position: 'relative', width: 260, maxWidth: '100%' }}>
          <Search size={12} style={{ position: 'absolute', left: 8, top: 9, color: 'var(--c-textMuted)' }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search payload…" style={{ ...inputStyle, paddingLeft: 26 }} />
        </div>
      </div>

      {error && <div style={{ background: 'var(--c-primaryLight)', color: 'var(--c-dangerText, #A32D2D)', padding: '10px 12px', borderRadius: 8, fontSize: 14, marginBottom: 14 }}>{error}</div>}

      <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ background: 'var(--c-hover)', textAlign: 'left', borderBottom: `1px solid ${C.border}` }}>
              <th style={th}>Received</th>
              <th style={th}>Kind</th>
              <th style={th}>Type</th>
              <th style={{ ...th, minWidth: 220 }}>Content</th>
              <th style={th}>API #</th>
              <th style={th}>Contact #</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: 'var(--c-t6, #888)' }}><Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /></td></tr>
            )}
            {!loading && events.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: 'var(--c-t6, #888)' }}>No webhook events yet.</td></tr>
            )}
            {!loading && events.map(e => {
              const kc = WEBHOOK_KIND_COLORS[e.payload_kind] || WEBHOOK_KIND_COLORS.unknown;
              const preview = e.payload_preview || '';
              const previewShort = preview.length > 80 ? preview.slice(0, 80) + '…' : preview;
              return (
                <tr key={e.id} onClick={() => setDetailId(e.id)} style={{ borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}
                    onMouseEnter={ev => ev.currentTarget.style.background = 'var(--c-xfdf6f6, #FDF6F6)'}
                    onMouseLeave={ev => ev.currentTarget.style.background = 'transparent'}>
                  <td style={td}>{new Date(e.received_at).toLocaleString('en-IN', { hour12: false })}</td>
                  <td style={td}><span style={{ ...pillStyle, background: kc.bg, color: kc.color }}>{kc.label}</span></td>
                  <td style={td}>{e.payload_subtype
                    ? <span style={{ ...pillStyle, background: 'var(--c-cardBg)', border: '1px solid var(--c-borderStrong, #D5D5D0)', color: 'var(--c-s333333, #333)' }}>{e.payload_subtype}</span>
                    : <span style={{ color: 'var(--c-textMuted)' }}>—</span>}
                  </td>
                  <td style={{ ...td, color: 'var(--c-s333333, #333)', maxWidth: 360 }} title={preview}>
                    {preview ? previewShort : <span style={{ color: 'var(--c-textMuted)' }}>—</span>}
                  </td>
                  <td style={{ ...td, fontFamily: 'DM Mono, monospace', color: 'var(--c-t4, #666)' }} title={e.phone_number_id ? `phone_number_id: ${e.phone_number_id}` : ''}>
                    {e.display_phone_number
                      ? <MaskedNumber number={String(e.display_phone_number).replace(/\D/g, '')} />
                      : (e.phone_number_id ? <span style={{ color: 'var(--c-textMuted)' }}>id:{String(e.phone_number_id).slice(-6)}</span> : '—')}
                  </td>
                  <td style={{ ...td, fontFamily: 'DM Mono, monospace', color: 'var(--c-t4, #666)' }}>
                    {e.contact_phone ? <MaskedNumber number={String(e.contact_phone).replace(/\D/g, '')} /> : <span style={{ color: 'var(--c-textMuted)' }}>—</span>}
                  </td>
                  <td style={td}><Eye size={14} style={{ color: 'var(--c-t4, #666)' }} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination — recent 10 per page */}
      {total > PAGE_SIZE && (
        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, fontSize: 14, color: 'var(--c-t4, #666)' }}>
          <span>Page {page + 1} of {totalPages} ({total.toLocaleString()} total)</span>
          <button disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))} style={{ ...btnSecondary, opacity: page === 0 ? 0.5 : 1 }}><ChevronLeft size={12} /> Prev</button>
          <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)} style={{ ...btnSecondary, opacity: page >= totalPages - 1 ? 0.5 : 1 }}>Next <ChevronRight size={12} /></button>
        </div>
      )}

      {detailId && (
        <WebhookDetailDrawer id={detailId} onClose={() => setDetailId(null)} onChanged={() => { load(); loadSummary(); }} />
      )}
      {testOpen && (
        <TestWebhookModal onClose={() => setTestOpen(false)} onSent={() => { setTestOpen(false); load(); loadSummary(); }} />
      )}
    </div>
  );
}

// ── Razorpay webhook panel ───────────────────────────────────────────────────
// Config = the callback URL to paste into Razorpay + an editable webhook secret
// (write-only; used to verify each event's HMAC-SHA256 signature) + optional Key
// ID. History = received payment/refund events, each linked to the matching CRM
// lead/contact. See the step-by-step setup guide handed over after deploy.
const RZP_ACCENT = '#3395FF';                 // Razorpay blue
const RZP_STATUS_COLORS = {
  captured:   { bg: 'var(--c-successBgSoft, #E4F3EE)', color: 'var(--c-successText, #0F6E56)' },
  authorized: { bg: 'var(--c-infoBg, #E3F2FD)', color: 'var(--c-infoText, #1565C0)' },
  created:    { bg: 'var(--c-surfaceSubtle, #EEEDE8)', color: 'var(--c-t4, #666)' },
  failed:     { bg: 'var(--c-dangerBg, #FCEBEB)', color: 'var(--c-dangerText, #A32D2D)' },
  refunded:   { bg: 'var(--c-orangeBg, #FFF3E0)', color: 'var(--c-orangeText, #E65100)' },
  processed:  { bg: 'var(--c-orangeBg, #FFF3E0)', color: 'var(--c-orangeText, #E65100)' },
};
function rzpAmount(paise, currency) {
  if (paise == null) return '—';
  const v = Number(paise) / 100;
  const sym = currency === 'INR' || !currency ? '₹' : `${currency} `;
  return sym + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function RazorpayWebhookPanel({ mode, onOpen, onBack }) {
  const [view] = useState(mode);
  const [cfg, setCfg] = useState({ status: 'disconnected', hasSecret: false, keyId: '', lastEventAt: null, lastError: null, totalEvents: 0, matchedEvents: 0 });

  // Secret is write-only (never returned) — blank input means "unchanged".
  const [secret, setSecret] = useState('');
  const [secretDirty, setSecretDirty] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [keyId, setKeyId] = useState('');
  const [saving, setSaving] = useState(false);
  // API credentials — the OUTBOUND half. Kept in their own state (and their own
  // status) because a verified webhook says nothing about API access: for months
  // this panel showed "Connected" while key_id was empty and no API call was
  // possible. Sales → Payments needs these to mint links.
  const [keySecret, setKeySecret] = useState('');
  const [keySecretDirty, setKeySecretDirty] = useState(false);
  const [showKeySecret, setShowKeySecret] = useState(false);
  const [testingApi, setTestingApi] = useState(false);

  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [drawerId, setDrawerId] = useState(null);
  const [copied, setCopied] = useState(false);
  const PAGE_SIZE = 10;

  const webhookUrl = `${window.location.origin}/api/webhook/razorpay`;
  const copyUrl = async () => {
    try { await navigator.clipboard.writeText(webhookUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* blocked */ }
  };

  const loadCfg = async () => {
    try {
      const s = await api.razorpay.status();
      setCfg(s);
      setKeyId(s.keyId || '');
    } catch { /* ignore — history still works */ }
  };

  const load = async () => {
    try {
      setLoading(true); setError(null);
      const res = await api.razorpay.events({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, q });
      setEvents(res.events || []);
      setTotal(res.total || 0);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadCfg(); }, []);
  useEffect(() => { if (view === 'detail') load(); /* eslint-disable-next-line */ }, [view, page]);
  useEffect(() => {
    if (view !== 'detail') return;
    const id = setTimeout(() => { setPage(0); load(); }, 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line
  }, [q]);

  const dirty = secretDirty || keySecretDirty || (keyId || '') !== (cfg.keyId || '');
  const save = async () => {
    setSaving(true);
    try {
      const body = { keyId };
      // Each secret is only sent when it was actually typed — the field shows
      // blank for an already-stored value, and an unsent field is left alone
      // server-side rather than being cleared.
      if (secretDirty) body.webhookSecret = secret.trim();
      if (keySecretDirty) body.keySecret = keySecret.trim();
      await api.razorpay.saveConfig(body);
      setSecret(''); setSecretDirty(false);
      setKeySecret(''); setKeySecretDirty(false);
      notify('Razorpay configuration saved.');
      await loadCfg();
    } catch (err) { notify(err.message || 'Failed to save Razorpay config'); }
    finally { setSaving(false); }
  };

  // A real authenticated call to Razorpay — not a credential-shape check. The
  // only honest way to report whether link creation will actually work.
  const testApi = async () => {
    setTestingApi(true);
    try {
      const r = await api.razorpay.testApi();
      notify({ variant: 'success', title: 'API access works',
        message: `Connected to Razorpay in ${r.mode === 'live' ? 'LIVE' : 'Test'} mode with key ${r.keyId}.` });
      await loadCfg();
    } catch (err) { notify(err.message || 'Could not reach the Razorpay API'); await loadCfg(); }
    finally { setTestingApi(false); }
  };

  const apiPill = cfg.apiStatus === 'connected'
    ? { bg: 'var(--c-successBgSoft, #E4F3EE)', color: 'var(--c-successText, #0F6E56)', label: `API ready · ${cfg.keyMode === 'live' ? 'LIVE' : 'Test'}`, icon: <CheckCircle2 size={12} /> }
    : cfg.apiStatus === 'error'
      ? { bg: 'var(--c-dangerBg, #FCEBEB)', color: 'var(--c-dangerText, #A32D2D)', label: 'API error', icon: <AlertCircle size={12} /> }
      : { bg: 'var(--c-surfaceSubtle, #EEEDE8)', color: 'var(--c-t4, #666)', label: 'API not set up', icon: <AlertCircle size={12} /> };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const statusPill = cfg.status === 'connected'
    ? { bg: 'var(--c-successBgSoft, #E4F3EE)', color: 'var(--c-successText, #0F6E56)', label: 'Connected', icon: <CheckCircle2 size={12} /> }
    : cfg.status === 'error'
      ? { bg: 'var(--c-dangerBg, #FCEBEB)', color: 'var(--c-dangerText, #A32D2D)', label: 'Attention', icon: <AlertCircle size={12} /> }
      : { bg: 'var(--c-surfaceSubtle, #EEEDE8)', color: 'var(--c-t4, #666)', label: 'Not configured', icon: <AlertCircle size={12} /> };

  const labelStyle = { display: 'block', fontSize: 13, fontWeight: 700, color: 'var(--c-t4, #666)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6, fontFamily: FONT };
  const roStyle = { ...inputStyle, background: 'var(--c-hover)', color: 'var(--c-s555555, #555)', fontFamily: 'DM Mono, monospace' };

  // ── Card ─────────────────────────────────────────────────────────────────────
  if (view === 'card') {
    return (
      <button
        onClick={onOpen}
        style={{ textAlign: 'left', background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, cursor: 'pointer', fontFamily: FONT, display: 'flex', flexDirection: 'column', gap: 14 }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = RZP_ACCENT; e.currentTarget.style.boxShadow = C.shadowMd; }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.boxShadow = 'none'; }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 42, height: 42, borderRadius: 10, background: 'rgba(51,149,255,.12)', color: RZP_ACCENT, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <CreditCard size={20} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Razorpay Payments</div>
            <div style={{ fontSize: 13, color: C.textMuted, fontFamily: 'DM Mono, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{webhookUrl}</div>
          </div>
          <ChevronRight size={18} style={{ color: 'var(--c-t7, #999)', flexShrink: 0 }} />
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 99, fontSize: 13, fontWeight: 700, background: statusPill.bg, color: statusPill.color }}>
            {statusPill.icon} {statusPill.label}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 99, fontSize: 13, fontWeight: 700, background: 'var(--c-hover)', color: 'var(--c-s555555, #555)' }}>
            <LinkIcon size={11} /> {cfg.matchedEvents || 0} linked
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-t6, #888)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Total events</div>
            <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 22, fontWeight: 700, color: C.text, marginTop: 2 }}>{(cfg.totalEvents || 0).toLocaleString()}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-t6, #888)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Last received</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginTop: 4 }}>
              {cfg.lastEventAt ? new Date(cfg.lastEventAt).toLocaleString('en-IN', { hour12: false }) : <span style={{ color: C.textMuted, fontWeight: 400 }}>No events yet</span>}
            </div>
          </div>
        </div>
      </button>
    );
  }

  // ── Detail ───────────────────────────────────────────────────────────────────
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 28, overflow: 'auto', fontFamily: FONT }}>
      <button onClick={onBack} style={{ ...btnSecondary, alignSelf: 'flex-start', marginBottom: 14 }}>
        <ArrowLeft size={13} /> Webhooks
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 24, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-.02em' }}>Razorpay Payments</h2>
          <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 4 }}>
            Verify course payments and link them to leads/contacts. Paste the callback URL + secret into Razorpay → Settings → Webhooks.
          </div>
        </div>
        <button onClick={() => { loadCfg(); load(); }} style={btnSecondary}><RefreshCw size={12} /> Refresh</button>
      </div>

      {/* Configuration */}
      <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, marginBottom: 18 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: '0 0 14px' }}>Configuration</h3>

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Webhook (Callback) URL</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={webhookUrl} readOnly style={roStyle} />
            <button type="button" onClick={copyUrl} title={copied ? 'Copied!' : 'Copy URL'} style={{ flexShrink: 0, width: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', color: copied ? C.green : C.textSecondary }}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 5 }}>Paste this into Razorpay Dashboard → Settings → Webhooks → Add New Webhook.</div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Webhook secret</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <input
                type={showSecret ? 'text' : 'password'}
                value={secret}
                onChange={e => { setSecret(e.target.value); setSecretDirty(true); }}
                placeholder={cfg.hasSecret ? '•••••••• saved — type to replace' : 'Paste the secret you set in Razorpay'}
                style={{ ...inputStyle, paddingRight: 34, fontFamily: 'DM Mono, monospace' }}
              />
              <button type="button" onClick={() => setShowSecret(s => !s)} style={{ position: 'absolute', right: 6, top: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: C.textSecondary, padding: 2 }}>
                {showSecret ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 5 }}>Must EXACTLY match the secret entered in Razorpay — it's the key used to verify each event's signature.</div>
        </div>

        {/* ── API access (outbound) ───────────────────────────────────────
            Everything above receives FROM Razorpay. These two send TO it, and
            they are what Sales → Payments needs in order to create links. They
            are reported separately because a working webhook has never implied
            working API access. */}
        <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 20, paddingTop: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: 0 }}>API access</h3>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 99, fontSize: 13, fontWeight: 700, background: apiPill.bg, color: apiPill.color }}>
              {apiPill.icon} {apiPill.label}
            </span>
          </div>
          <div style={{ fontSize: 13, color: C.textSecondary, marginBottom: 14, lineHeight: 1.5 }}>
            Needed to <strong>create</strong> payment links from Sales → Payments. Razorpay Dashboard → Account &amp; Settings → API Keys.
            Razorpay keys are account-wide, so this grants ForgeGrowth write access to the gateway — start with a <strong>test</strong> key.
          </div>

          {cfg.keyMode === 'live' && cfg.hasApiKeys && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'var(--c-warnBgSoft, #FFF8E1)', color: 'var(--c-s7a5500, #7A5500)', border: '1px solid #F0E0B0', borderRadius: 8, padding: '9px 12px', marginBottom: 14, fontSize: 13 }}>
              <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>These are <strong>live</strong> keys. Links created in Sales → Payments will take real money.</span>
            </div>
          )}

          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Key ID</label>
            <input value={keyId} onChange={e => setKeyId(e.target.value)} placeholder="rzp_test_… or rzp_live_…" style={{ ...inputStyle, fontFamily: 'DM Mono, monospace' }} />
            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 5 }}>
              Test or live mode is read from this id — there is no separate switch to get out of step with it.
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Key Secret</label>
            <div style={{ position: 'relative' }}>
              <input
                type={showKeySecret ? 'text' : 'password'}
                value={keySecret}
                onChange={e => { setKeySecret(e.target.value); setKeySecretDirty(true); }}
                placeholder={cfg.hasApiKeys ? '•••••••• saved — type to replace' : 'Shown once by Razorpay when you generate the key'}
                style={{ ...inputStyle, paddingRight: 34, fontFamily: 'DM Mono, monospace' }}
              />
              <button type="button" onClick={() => setShowKeySecret(s => !s)} style={{ position: 'absolute', right: 6, top: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: C.textSecondary, padding: 2 }}>
                {showKeySecret ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 5 }}>Stored encrypted and never shown again. Different from the webhook secret above.</div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={testApi}
              disabled={testingApi || !cfg.hasApiKeys || dirty}
              title={dirty ? 'Save the configuration first' : !cfg.hasApiKeys ? 'Add a Key ID and Key Secret first' : 'Make a real call to Razorpay'}
              style={{ ...btnSecondary, opacity: (testingApi || !cfg.hasApiKeys || dirty) ? 0.5 : 1, cursor: (testingApi || !cfg.hasApiKeys || dirty) ? 'default' : 'pointer', fontWeight: 700 }}
            >
              {testingApi ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={12} />} Test API access
            </button>
            {cfg.apiLastError && <span style={{ fontSize: 13, color: 'var(--c-dangerText, #A32D2D)', flex: 1, minWidth: 180 }}>{cfg.apiLastError}</span>}
            {cfg.apiCheckedAt && !cfg.apiLastError && (
              <span style={{ fontSize: 13, color: C.textMuted }}>Last checked {new Date(cfg.apiCheckedAt).toLocaleString('en-IN', { hour12: false })}</span>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            style={{ ...btnSecondary, opacity: (!dirty || saving) ? 0.5 : 1, cursor: (!dirty || saving) ? 'default' : 'pointer', fontWeight: 700 }}
          >
            {saving ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={12} />} Save configuration
          </button>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 99, fontSize: 13, fontWeight: 700, background: statusPill.bg, color: statusPill.color }}>
            {statusPill.icon} {statusPill.label}
          </span>
          {cfg.lastError && <span style={{ fontSize: 13, color: 'var(--c-dangerText, #A32D2D)' }}>{cfg.lastError}</span>}
        </div>
      </div>

      {/* Recent events */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: 0 }}>Recent payment events</h3>
        <div style={{ position: 'relative', width: 260, maxWidth: '100%' }}>
          <Search size={12} style={{ position: 'absolute', left: 8, top: 9, color: 'var(--c-textMuted)' }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search id, email, phone, lead…" style={{ ...inputStyle, paddingLeft: 26 }} />
        </div>
      </div>

      {error && <div style={{ background: 'var(--c-primaryLight)', color: 'var(--c-dangerText, #A32D2D)', padding: '10px 12px', borderRadius: 8, fontSize: 14, marginBottom: 14 }}>{error}</div>}

      <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, minWidth: 760 }}>
          <thead>
            <tr style={{ background: 'var(--c-hover)', textAlign: 'left', borderBottom: `1px solid ${C.border}` }}>
              <th style={th}>Received</th>
              <th style={th}>Event</th>
              <th style={th}>Amount</th>
              <th style={th}>Status</th>
              <th style={th}>Payer</th>
              <th style={th}>Linked to</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: 'var(--c-t6, #888)' }}><Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /></td></tr>
            )}
            {!loading && events.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: 'var(--c-t6, #888)' }}>No Razorpay events yet.</td></tr>
            )}
            {!loading && events.map(e => {
              const sc = RZP_STATUS_COLORS[e.status] || RZP_STATUS_COLORS.created;
              const linked = e.matched_lead_name || e.matched_contact_name;
              return (
                <tr key={e.id} onClick={() => setDrawerId(e.id)} style={{ borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}
                    onMouseEnter={ev => ev.currentTarget.style.background = 'var(--c-xf4f8ff, #F4F8FF)'}
                    onMouseLeave={ev => ev.currentTarget.style.background = 'transparent'}>
                  <td style={td}>{new Date(e.received_at).toLocaleString('en-IN', { hour12: false })}</td>
                  <td style={td}>
                    <span style={{ ...pillStyle, background: 'var(--c-cardBg)', border: '1px solid var(--c-borderStrong, #D5D5D0)', color: 'var(--c-s333333, #333)' }}>{e.event_type || '—'}</span>
                    {!e.signature_valid && <span title="Signature not verified" style={{ marginLeft: 6, color: 'var(--c-dangerText, #A32D2D)' }}><AlertCircle size={12} style={{ verticalAlign: 'middle' }} /></span>}
                  </td>
                  <td style={{ ...td, fontFamily: 'DM Mono, monospace', fontWeight: 700, color: C.text }}>{rzpAmount(e.amount_paise, e.currency)}</td>
                  <td style={td}>{e.status ? <span style={{ ...pillStyle, background: sc.bg, color: sc.color }}>{e.status}</span> : <span style={{ color: 'var(--c-textMuted)' }}>—</span>}</td>
                  <td style={{ ...td, color: 'var(--c-s555555, #555)' }}>
                    {e.payer_email
                      ? <span title={e.payer_email} style={{ display: 'inline-block', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>{e.payer_email}</span>
                      : (e.payer_contact ? <MaskedNumber number={String(e.payer_contact).replace(/\D/g, '')} /> : <span style={{ color: 'var(--c-textMuted)' }}>—</span>)}
                  </td>
                  <td style={td}>
                    {linked
                      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--c-successText, #0F6E56)', fontWeight: 600 }}><LinkIcon size={12} /> {linked}</span>
                      : <span style={{ color: 'var(--c-textMuted)' }}>Unmatched</span>}
                  </td>
                  <td style={td}><Eye size={14} style={{ color: 'var(--c-t4, #666)' }} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {total > PAGE_SIZE && (
        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, fontSize: 14, color: 'var(--c-t4, #666)' }}>
          <span>Page {page + 1} of {totalPages} ({total.toLocaleString()} total)</span>
          <button disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))} style={{ ...btnSecondary, opacity: page === 0 ? 0.5 : 1 }}><ChevronLeft size={12} /> Prev</button>
          <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)} style={{ ...btnSecondary, opacity: page >= totalPages - 1 ? 0.5 : 1 }}>Next <ChevronRight size={12} /></button>
        </div>
      )}

      {drawerId && <RazorpayEventDrawer id={drawerId} onClose={() => setDrawerId(null)} />}
    </div>
  );
}

// Read-only drawer for a single Razorpay event: verification, money, payer, the
// linked lead/contact, and the raw payload.
function RazorpayEventDrawer({ id, onClose }) {
  const [ev, setEv] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.razorpay.event(id).then(e => { setEv(e); setLoading(false); }).catch(err => { notify(err.message); setLoading(false); });
  }, [id]);

  const copyJson = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(ev?.payload, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* blocked */ }
  };

  const Field = ({ label, children }) => (
    <div><div style={{ color: 'var(--c-t6, #888)', textTransform: 'uppercase', fontSize: 12, letterSpacing: '.05em', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 15, color: 'var(--c-text)', fontFamily: 'DM Mono, monospace', wordBreak: 'break-all' }}>{children}</div></div>
  );

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 250, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 640, maxWidth: '94vw', height: '100%', background: 'var(--c-cardBg)', boxShadow: C.shadowLg, display: 'flex', flexDirection: 'column', fontFamily: FONT, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--c-borderSubtle, #EEEDE8)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-text)' }}>Razorpay Event #{id}</div>
            {ev && <div style={{ fontSize: 13, color: 'var(--c-t6, #888)', marginTop: 2 }}>{new Date(ev.received_at).toLocaleString('en-IN')} · {ev.event_type}</div>}
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--c-t4, #666)' }}><X size={20} /></button>
        </div>

        {loading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--c-t6, #888)' }}><Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /></div>}

        {!loading && ev && (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--c-borderSubtle, #EEEDE8)', background: 'var(--c-hover)', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
              <div><div style={{ color: 'var(--c-t6, #888)', textTransform: 'uppercase', fontSize: 12, letterSpacing: '.05em', marginBottom: 2 }}>Signature</div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 99, fontSize: 13, fontWeight: 700, ...(ev.signature_valid ? { background: 'var(--c-successBgSoft, #E4F3EE)', color: 'var(--c-successText, #0F6E56)' } : { background: 'var(--c-dangerBg, #FCEBEB)', color: 'var(--c-dangerText, #A32D2D)' }) }}>
                  {ev.signature_valid ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />} {ev.signature_valid ? 'Verified' : 'Not verified'}
                </span>
              </div>
              <div><div style={{ color: 'var(--c-t6, #888)', textTransform: 'uppercase', fontSize: 12, letterSpacing: '.05em', marginBottom: 2 }}>Amount</div>
                <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 18, fontWeight: 700, color: 'var(--c-text)' }}>{rzpAmount(ev.amount_paise, ev.currency)} <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--c-t6, #888)' }}>{ev.status || ''}</span></div>
              </div>
            </div>

            <div style={{ padding: '14px 20px', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14, borderBottom: '1px solid var(--c-borderSubtle, #EEEDE8)' }}>
              <Field label="Payment ID">{ev.payment_id || '—'}</Field>
              <Field label="Order ID">{ev.order_id || '—'}</Field>
              <Field label="Method">{ev.method || '—'}</Field>
              <Field label="Refund ID">{ev.refund_id || '—'}</Field>
              <Field label="Payer email">{ev.payer_email || '—'}</Field>
              <Field label="Payer phone">{ev.payer_contact ? <MaskedNumber number={String(ev.payer_contact).replace(/\D/g, '')} /> : '—'}</Field>
            </div>

            {/* Linkage */}
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--c-borderSubtle, #EEEDE8)' }}>
              <div style={{ color: 'var(--c-t6, #888)', textTransform: 'uppercase', fontSize: 12, letterSpacing: '.05em', marginBottom: 8 }}>Linked CRM records</div>
              {(ev.matched_lead_name || ev.matched_contact_name) ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {ev.matched_lead_name && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 8, background: 'var(--c-successBgSoft, #E4F3EE)', color: 'var(--c-successText, #0F6E56)', fontSize: 14, fontWeight: 700 }}><LinkIcon size={13} /> Lead: {ev.matched_lead_name}</span>}
                  {ev.matched_contact_name && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 8, background: 'var(--c-infoBg, #E3F2FD)', color: 'var(--c-infoText, #1565C0)', fontSize: 14, fontWeight: 700 }}><User size={13} /> Contact: {ev.matched_contact_name}</span>}
                  {ev.match_method && <span style={{ display: 'inline-flex', alignItems: 'center', padding: '5px 10px', borderRadius: 8, background: 'var(--c-hover)', color: 'var(--c-s555555, #555)', fontSize: 13, fontWeight: 600 }}>matched by {ev.match_method}</span>}
                </div>
              ) : (
                <div style={{ fontSize: 14, color: 'var(--c-t6, #888)' }}>No matching lead or contact found for this payer (phone/email didn't match any CRM record).</div>
              )}
            </div>

            <div style={{ padding: '10px 20px', display: 'flex', gap: 8 }}>
              <button onClick={copyJson} style={btnSecondary}>{copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy payload'}</button>
            </div>
            <pre style={{ margin: '0 20px 20px', padding: 14, background: 'var(--c-hover)', borderRadius: 8, fontSize: 13, fontFamily: 'DM Mono, monospace', overflowX: 'auto', color: 'var(--c-text)' }}
                 dangerouslySetInnerHTML={{ __html: syntaxHighlight(ev.payload || {}) }} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Test Webhook Modal ───────────────────────────────────────────────────────
// Generates synthetic Meta payloads of every common shape and POSTs them through
// the live /api/webhook/whatsapp endpoint. Lets you populate the audit log,
// exercise the parser, and fire automation triggers without waiting for real
// WhatsApp traffic.

const TEST_TEMPLATES = [
  { key: 'msg_text',         label: 'Incoming text message',      kind: 'messages',  subtype: 'text' },
  { key: 'msg_image',        label: 'Incoming image',             kind: 'messages',  subtype: 'image' },
  { key: 'msg_video',        label: 'Incoming video',             kind: 'messages',  subtype: 'video' },
  { key: 'msg_voice',        label: 'Incoming voice note',        kind: 'messages',  subtype: 'voice' },
  { key: 'msg_document',     label: 'Incoming document',          kind: 'messages',  subtype: 'document' },
  { key: 'msg_location',     label: 'Incoming location',          kind: 'messages',  subtype: 'location' },
  { key: 'msg_interactive',  label: 'Interactive button reply',   kind: 'messages',  subtype: 'interactive' },
  { key: 'msg_reaction',     label: 'Reaction (emoji)',           kind: 'messages',  subtype: 'reaction' },
  { key: 'echo_text',        label: 'SMB echo: outbound text',    kind: 'smb_message_echoes', subtype: 'text' },
  { key: 'echo_image',       label: 'SMB echo: outbound image',   kind: 'smb_message_echoes', subtype: 'image' },
  { key: 'status_sent',      label: 'Status: sent',               kind: 'statuses',  subtype: 'sent' },
  { key: 'status_delivered', label: 'Status: delivered',          kind: 'statuses',  subtype: 'delivered' },
  { key: 'status_read',      label: 'Status: read',               kind: 'statuses',  subtype: 'read' },
  { key: 'status_failed',    label: 'Status: failed',             kind: 'statuses',  subtype: 'failed' },
  { key: 'tpl_approved',     label: 'Template status: APPROVED',  kind: 'template_status_update', subtype: 'APPROVED' },
  { key: 'tpl_rejected',     label: 'Template status: REJECTED',  kind: 'template_status_update', subtype: 'REJECTED' },
  { key: 'broken',           label: 'Broken payload (parser error test)', kind: 'unknown', subtype: null },
];

function buildTestPayload(key, opts) {
  const ts = Math.floor(Date.now() / 1000);
  const wamid = `wamid.TEST_${ts}_${Math.random().toString(36).slice(2, 8)}`;
  const phoneNumberId = opts.phoneNumberId || '318766817983611';
  // Stored display numbers are digits-only across the dashboard
  const displayPhone = (opts.displayPhone || '919876543210').replace(/\D/g, '');
  const from = opts.from || '919999999999';
  const profileName = opts.profileName || 'Test User';
  const text = opts.text || 'Hello from test webhook';

  const wrap = (changes) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA-TEST', changes }],
  });
  const msgEnvelope = (msg, contacts = true) => wrap([{
    field: 'messages',
    value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: displayPhone, phone_number_id: phoneNumberId },
      ...(contacts ? { contacts: [{ profile: { name: profileName }, wa_id: from }] } : {}),
      messages: [msg],
    },
  }]);
  const statusEnvelope = (status) => wrap([{
    field: 'messages',
    value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: displayPhone, phone_number_id: phoneNumberId },
      statuses: [status],
    },
  }]);

  switch (key) {
    case 'msg_text':
      return msgEnvelope({ from, id: wamid, timestamp: String(ts), type: 'text', text: { body: text } });
    case 'msg_image':
      return msgEnvelope({ from, id: wamid, timestamp: String(ts), type: 'image',
        image: { id: 'MEDIA_TEST_IMG', mime_type: 'image/jpeg', sha256: 'test', caption: text } });
    case 'msg_video':
      return msgEnvelope({ from, id: wamid, timestamp: String(ts), type: 'video',
        video: { id: 'MEDIA_TEST_VID', mime_type: 'video/mp4', sha256: 'test', caption: text } });
    case 'msg_voice':
      return msgEnvelope({ from, id: wamid, timestamp: String(ts), type: 'voice',
        voice: { id: 'MEDIA_TEST_VOICE', mime_type: 'audio/ogg; codecs=opus', sha256: 'test' } });
    case 'msg_document':
      return msgEnvelope({ from, id: wamid, timestamp: String(ts), type: 'document',
        document: { id: 'MEDIA_TEST_DOC', mime_type: 'application/pdf', filename: 'invoice.pdf', sha256: 'test' } });
    case 'msg_location':
      return msgEnvelope({ from, id: wamid, timestamp: String(ts), type: 'location',
        location: { latitude: 12.9716, longitude: 77.5946, name: 'Bangalore', address: 'KA, India' } });
    case 'msg_interactive':
      return msgEnvelope({ from, id: wamid, timestamp: String(ts), type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'btn_yes', title: text || 'Yes' } } });
    case 'msg_reaction':
      return msgEnvelope({ from, id: wamid, timestamp: String(ts), type: 'reaction',
        reaction: { message_id: `wamid.REPLY_TO_${ts}`, emoji: text || '👍' } });
    case 'echo_text':
    case 'echo_image': {
      // SMB echo: business sent a message from the WhatsApp Business app, Meta
      // echoes it back so the CRM can mirror it. Field=smb_message_echoes;
      // value.message_echoes array; `to` is the customer, business number lives
      // in metadata.display_phone_number.
      const echoMsg = key === 'echo_text'
        ? { id: wamid, timestamp: String(ts), to: from, type: 'text', text: { body: text || 'Outbound message from WA Business app' } }
        : { id: wamid, timestamp: String(ts), to: from, type: 'image',
            image: { id: 'MEDIA_TEST_ECHO_IMG', mime_type: 'image/jpeg', sha256: 'test', caption: text || 'Caption' } };
      return wrap([{
        field: 'smb_message_echoes',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: displayPhone, phone_number_id: phoneNumberId },
          message_echoes: [echoMsg],
        },
      }]);
    }
    case 'status_sent':
    case 'status_delivered':
    case 'status_read':
      return statusEnvelope({ id: wamid, status: key.replace('status_', ''), timestamp: String(ts), recipient_id: from,
        conversation: { id: `conv_${ts}`, origin: { type: 'utility' } },
        pricing: { billable: true, pricing_model: 'CBP', category: 'utility' } });
    case 'status_failed':
      return statusEnvelope({ id: wamid, status: 'failed', timestamp: String(ts), recipient_id: from,
        errors: [{ code: 131026, title: 'Message undeliverable', message: text || 'Recipient not reachable' }] });
    case 'tpl_approved':
    case 'tpl_rejected':
      return wrap([{
        field: 'message_template_status_update',
        value: {
          event: key === 'tpl_approved' ? 'APPROVED' : 'REJECTED',
          message_template_id: 1234567890,
          message_template_name: opts.templateName || 'welcome_message',
          message_template_language: 'en',
          reason: key === 'tpl_rejected' ? (text || 'ABUSIVE_CONTENT') : 'NONE',
        },
      }]);
    case 'broken':
      return { object: 'something_weird', entry: [], note: text || 'malformed payload' };
    default:
      return msgEnvelope({ from, id: wamid, timestamp: String(ts), type: 'text', text: { body: text } });
  }
}

function TestWebhookModal({ onClose, onSent }) {
  const [tplKey, setTplKey] = useState('msg_text');
  const [phoneNumberId, setPhoneNumberId] = useState('318766817983611');
  const [from, setFrom] = useState('919999999999');
  const [text, setText] = useState('Hello from test webhook');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [showPreview, setShowPreview] = useState(false);

  const payload = useMemo(() => buildTestPayload(tplKey, { phoneNumberId, from, text }), [tplKey, phoneNumberId, from, text]);
  const selectedTpl = TEST_TEMPLATES.find(t => t.key === tplKey);

  const send = async () => {
    try {
      setSending(true);
      setResult(null);
      const res = await fetch('/api/webhook/whatsapp', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.text();
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }
      setResult({ ok: res.ok, status: res.status, response: parsed });
      if (res.ok) {
        setTimeout(() => { onSent?.(); }, 800);
      }
    } catch (err) {
      setResult({ ok: false, status: 0, response: { error: err.message } });
    } finally {
      setSending(false);
    }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 260, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, width: 620, maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto', padding: 22, boxShadow: C.shadowLg, fontFamily: FONT }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--c-text)' }}>Send Test Webhook</div>
            <div style={{ fontSize: 13, color: 'var(--c-t6, #888)', marginTop: 2 }}>Posts a synthetic Meta payload through the live <code style={{ fontFamily: 'DM Mono, monospace' }}>/api/webhook/whatsapp</code> handler</div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--c-t4, #666)' }}><X size={18} /></button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
          <FilterField label="Payload type">
            <SearchableSelect
              value={tplKey}
              onChange={v => setTplKey(v)}
              options={TEST_TEMPLATES.map(t => ({ value: t.key, label: t.label }))}
              searchPlaceholder="Search payload types…"
              style={{ width: '100%' }}
              triggerStyle={{ padding: '7px 28px 7px 10px', fontSize: 14, borderWidth: 1, borderRadius: 6 }}
            />
          </FilterField>
          <FilterField label="Phone Number ID (your WABA)">
            <input value={phoneNumberId} onChange={e => setPhoneNumberId(e.target.value)} style={inputStyle} placeholder="318766817983611" />
          </FilterField>
          {selectedTpl?.kind !== 'template_status_update' && selectedTpl?.kind !== 'unknown' && (
            <FilterField label={selectedTpl?.kind === 'statuses' ? 'Recipient phone (wa_id)' : 'From phone (wa_id)'}>
              <input value={from} onChange={e => setFrom(e.target.value)} style={inputStyle} placeholder="919999999999" />
            </FilterField>
          )}
          <FilterField label={
            selectedTpl?.key === 'msg_reaction' ? 'Emoji' :
            selectedTpl?.kind === 'statuses' && tplKey === 'status_failed' ? 'Error message' :
            selectedTpl?.kind === 'template_status_update' ? (tplKey === 'tpl_rejected' ? 'Rejection reason' : 'Template name') :
            'Text / caption'
          }>
            <input value={text} onChange={e => setText(e.target.value)} style={inputStyle} />
          </FilterField>
        </div>

        <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--c-hover)', border: '1px solid var(--c-borderSubtle, #EEEDE8)', borderRadius: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div style={{ fontSize: 13, color: 'var(--c-t4, #666)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
              Payload preview <span style={{ marginLeft: 6, fontFamily: 'DM Mono, monospace', color: 'var(--c-textMuted)', textTransform: 'none', letterSpacing: 0 }}>· kind={selectedTpl?.kind} · subtype={selectedTpl?.subtype || '—'}</span>
            </div>
            <button onClick={() => setShowPreview(!showPreview)} style={btnSecondary}>
              {showPreview ? 'Hide' : 'Show'}
            </button>
          </div>
          {showPreview && (
            <pre
              style={{ background: 'var(--c-cardBg)', border: '1px solid var(--c-borderSubtle, #EEEDE8)', borderRadius: 6, padding: 10, fontSize: 13, fontFamily: 'DM Mono, monospace', overflow: 'auto', maxHeight: 240, margin: 0 }}
              dangerouslySetInnerHTML={{ __html: syntaxHighlight(JSON.stringify(payload, null, 2)) }}
            />
          )}
        </div>

        {result && (
          <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 14, background: result.ok ? 'var(--c-successBgSoft, #E4F3EE)' : 'var(--c-primaryLight)', color: result.ok ? 'var(--c-successText, #0F6E56)' : 'var(--c-dangerText, #A32D2D)' }}>
            {result.ok ? '✓ Sent' : '⚠ Failed'} · HTTP {result.status} · {JSON.stringify(result.response).slice(0, 200)}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={send} disabled={sending} style={{ ...btnSecondary, color: '#fff', background: '#dc2626', borderColor: '#dc2626', fontWeight: 700 }}>
            {sending ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={12} />} Send Webhook
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle = { width: '100%', padding: '7px 10px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 14, fontFamily: FONT, outline: 'none', background: 'var(--c-cardBg)', boxSizing: 'border-box' };
const pillStyle = { display: 'inline-block', padding: '2px 8px', borderRadius: 99, fontSize: 12, fontWeight: 700, fontFamily: 'DM Mono, monospace', textTransform: 'uppercase' };
const th = { padding: '10px 14px', fontSize: 12, fontWeight: 700, color: 'var(--c-t4, #666)', textTransform: 'uppercase', letterSpacing: '.05em' };
const td = { padding: '10px 14px', color: 'var(--c-s333333, #333)', verticalAlign: 'middle' };

function FilterField({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-t4, #666)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
