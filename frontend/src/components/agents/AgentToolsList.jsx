import { useState, useEffect } from 'react';
import { Plus, Trash2, FileSpreadsheet, AlertCircle, Globe, ClipboardList, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT } from '../../constants.js';
import Toggle from '../Toggle.jsx';
import DeleteConfirmModal from '../DeleteConfirmModal.jsx';
import GoogleSheetsToolConfig from './GoogleSheetsToolConfig.jsx';
import HttpToolConfig from './HttpToolConfig.jsx';
import LeadFormToolConfig from './LeadFormToolConfig.jsx';

/**
 * ONE list of everything this agent can do.
 *
 * This used to be three places: a block of checkboxes at the top of the Tools
 * tab, a Media card in the middle, and this component at the bottom — which
 * ALSO re-listed the checkboxes above it as a read-only "Built in" summary with
 * jump links back up to them. So the same capability appeared twice, the
 * relationship between the three cards was invisible, and turning something on
 * did not show you what there was to configure.
 *
 * Now every capability — the ones built into the agent and the ones you attach
 * per instance — is a row with the same three parts: a switch, one line saying
 * what it does, and a chevron that opens its settings in place. Nothing about a
 * tool lives anywhere except inside its own row.
 *
 * Built-in rows come from the `builtIns` prop because the editor owns the form
 * state their settings bind to. Each one carries its own `renderConfig`, so this
 * component never needs to know what any particular capability configures — and
 * a row with no settings (Update CRM) is simply a switch with no chevron.
 */

const TOOL_TYPES = [
  { type: 'lead_form', label: "Form's table", desc: 'Collect a form\'s columns in chat and write a row into its table.',
    icon: ClipboardList, iconColor: '#8E24AA', iconBg: 'var(--c-purpleBg, #F3E5F5)' },
  { type: 'google_sheets', label: 'Google Sheets', desc: 'Read, append, or update rows in a sheet.',
    icon: FileSpreadsheet, iconColor: '#0F7A38', iconBg: 'var(--c-xe6f4ea, #E6F4EA)' },
  { type: 'http_request', label: 'HTTP request', desc: 'Call an external API / device / webhook.',
    icon: Globe, iconColor: '#2563EB', iconBg: 'var(--c-infoBg, #E6EEFC)' },
];

const toolMeta = (type) => TOOL_TYPES.find(t => t.type === type) || TOOL_TYPES[1];

const CONFIG_COMPONENTS = {
  lead_form: LeadFormToolConfig,
  google_sheets: GoogleSheetsToolConfig,
  http_request: HttpToolConfig,
};

// Title + one-line summary for an attached tool. Kept here (not in the config
// components) so every row in the list is described the same way.
function describeTool(tool) {
  const cfg = tool.config || {};
  if (tool.toolType === 'http_request') {
    return {
      title: cfg.label || 'HTTP request',
      summary: `${cfg.method || 'GET'} ${cfg.url || ''}`.trim() || 'No endpoint set',
    };
  }
  if (tool.toolType === 'lead_form') {
    return {
      title: cfg.form_name || 'Form',
      summary: 'Collects this form\'s columns in chat and writes a row into its table',
    };
  }
  const sheet = [cfg.spreadsheet_name || cfg.spreadsheet_id, cfg.sheet_name].filter(Boolean).join(' · ');
  return {
    title: sheet || 'Google Sheet',
    summary: (cfg.ops || []).length ? `Can ${(cfg.ops || []).join(', ')}` : 'No operations enabled',
  };
}

export default function AgentToolsList({ agentId, tools, onChange, ensureAgentId, builtIns = [] }) {
  // One row open at a time: with a dozen capabilities, letting them all stay
  // open puts the thing you are editing back off the bottom of the screen.
  const [openKey, setOpenKey] = useState(null);
  const [adding, setAdding] = useState(null);   // tool-type string while adding
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const [pendingRemove, setPendingRemove] = useState(null);

  // Escape closes the add-tool menu. It is not a nicety: the menu is held open
  // by a FIXED full-screen backdrop, so while it is open it swallows every click
  // on the page — and every other popover in this app (SearchableSelect) already
  // closes on Escape, which makes this one the surprising exception. Found while
  // verifying: a stray Escape left the backdrop up and nothing else was clickable.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const toggleOpen = (key) => setOpenKey(cur => (cur === key ? null : key));

  const handleToolToggle = async (t) => {
    setBusy(t.id); setError('');
    try {
      await api.agents.updateTool(agentId, t.id, { isEnabled: !t.isEnabled });
      await onChange();
    } catch (e) {
      setError(pretty(e));
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async () => {
    const t = pendingRemove;
    if (!t) return;
    setBusy(t.id); setError('');
    try {
      await api.agents.removeTool(agentId, t.id);
      setPendingRemove(null);
      if (openKey === `tool-${t.id}`) setOpenKey(null);
      await onChange();
    } catch (e) {
      setError(pretty(e));
      setPendingRemove(null);
    } finally {
      setBusy(null);
    }
  };

  const AddingConfig = adding ? CONFIG_COMPONENTS[adding] : null;

  return (
    <div style={{ fontFamily: FONT }}>
      {error && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px', borderRadius: 8,
          background: 'var(--c-dangerBg, #FCEBEB)', color: 'var(--c-dangerText, #A32D2D)',
          border: '1px solid var(--c-dangerBorder, #FBC8C8)', fontSize: 14, marginBottom: 12 }}>
          <AlertCircle size={13} /> {error}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Built into the agent — a switch each, settings inside the row. */}
        {builtIns.map(cap => {
          const key = `cap-${cap.key}`;
          const body = cap.renderConfig ? cap.renderConfig() : null;
          return (
            <ToolRow
              key={key}
              icon={cap.icon}
              iconColor={cap.iconColor}
              iconBg={cap.iconBg}
              title={cap.label}
              summary={cap.on ? cap.onDesc : cap.offDesc}
              on={cap.on}
              // ⚠ Passed ONLY when the capability actually has a switch.
              // Passing the wrapper unconditionally rendered a switch on the
              // switch-less Send media row whose handler called a `cap.onToggle`
              // that does not exist. Verified in a browser: clicking it threw
              // "onToggle is not a function" and the switch did nothing. (The
              // page survived — a throw in an EVENT HANDLER does not unmount the
              // tree, unlike one during render — so the only symptom was a dead
              // control and a console error, which is precisely why a build and
              // a screenshot both pass it.)
              //
              // Turning something on opens its settings straight away: a switch
              // that reveals nothing leaves you hunting for what to fill in,
              // which is how the payment tools came to read as missing.
              onToggle={cap.onToggle
                ? (next) => { cap.onToggle(next); if (next && body) setOpenKey(key); }
                : undefined}
              // ⚠ A SWITCH-LESS row is ALWAYS openable. Send media has no
              // switch — its `on` is derived from "does it have any groups
              // yet?" — so gating on `cap.on` alone made the row unopenable on
              // every agent that had no media, which is every new agent, and
              // there would have been no way to add the first group. Only a
              // row that is genuinely switched OFF hides its settings.
              expandable={!!body && (!cap.onToggle || cap.on)}
              open={openKey === key}
              onToggleOpen={() => toggleOpen(key)}
              // data-cap kept so a deep link from elsewhere can still find the row.
              anchor={cap.key}
            >
              {body}
            </ToolRow>
          );
        })}

        {/* Attached per agent. Same row shape — deliberately not a separate
            section, since "what can this agent do?" is one question. */}
        {tools.map(t => {
          const key = `tool-${t.id}`;
          const meta = toolMeta(t.toolType);
          const { title, summary } = describeTool(t);
          const Config = CONFIG_COMPONENTS[t.toolType];
          return (
            <ToolRow
              key={key}
              icon={meta.icon}
              iconColor={meta.iconColor}
              iconBg={meta.iconBg}
              title={title}
              summary={t.isEnabled ? summary : `${summary} — currently off`}
              on={t.isEnabled}
              onToggle={() => handleToolToggle(t)}
              busy={busy === t.id}
              expandable
              open={openKey === key}
              onToggleOpen={() => toggleOpen(key)}
              typeLabel={meta.label}
              onRemove={() => setPendingRemove(t)}
            >
              {Config && openKey === key && (
                <Config
                  agentId={agentId}
                  ensureAgentId={ensureAgentId}
                  existingTool={t}
                  onCancel={() => setOpenKey(null)}
                  onSaved={async () => { setOpenKey(null); await onChange(); }}
                />
              )}
            </ToolRow>
          );
        })}

        {/* A tool being added appears as its own row at the end of the list, so
            it lands where it will live rather than in a panel of its own. */}
        {adding && AddingConfig && (() => {
          const meta = toolMeta(adding);
          return (
            <ToolRow
              key="adding"
              icon={meta.icon}
              iconColor={meta.iconColor}
              iconBg={meta.iconBg}
              title={`New ${meta.label.toLowerCase()}`}
              summary="Not saved yet"
              expandable
              open
              onToggleOpen={() => setAdding(null)}
            >
              <AddingConfig
                agentId={agentId}
                ensureAgentId={ensureAgentId}
                existingTool={null}
                onCancel={() => setAdding(null)}
                onSaved={async () => { setAdding(null); await onChange(); }}
              />
            </ToolRow>
          );
        })()}
      </div>

      {!adding && (
        <div style={{ position: 'relative', marginTop: 12, display: 'inline-block' }}>
          <button
            type="button"
            onClick={() => setMenuOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '9px 14px', borderRadius: 8,
              border: `1px dashed ${C.border}`, background: C.cardBg,
              color: C.text, fontSize: 15, fontFamily: FONT, fontWeight: 600,
              cursor: 'pointer',
            }}>
            <Plus size={13} /> Add a tool
          </button>
          {menuOpen && (
            <>
              <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
              <div style={{
                position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 50,
                background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10,
                boxShadow: C.shadowLg, padding: 6, minWidth: 280,
              }}>
                {TOOL_TYPES.map(t => {
                  const Icon = t.icon;
                  return (
                    <div key={t.type}
                      onClick={() => { setMenuOpen(false); setOpenKey(null); setAdding(t.type); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 7, cursor: 'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--c-surfaceAlt)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                      <div style={{ width: 30, height: 30, borderRadius: 7, background: t.iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Icon size={15} color={t.iconColor} />
                      </div>
                      <div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{t.label}</div>
                        <div style={{ fontSize: 13, color: C.textMuted, marginTop: 1 }}>{t.desc}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      <DeleteConfirmModal
        open={!!pendingRemove}
        title="Remove this tool?"
        message={pendingRemove
          ? `"${describeTool(pendingRemove).title}" will be removed from this agent. Rows it already saved stay exactly where they are, and the ${pendingRemove.toolType === 'lead_form' ? 'form and its table are' : 'spreadsheet or endpoint is'} not touched.`
          : ''}
        confirmText="Remove tool"
        onCancel={() => setPendingRemove(null)}
        onConfirm={handleRemove}
      />
    </div>
  );
}

/**
 * One capability. Header is a button so the whole strip is clickable and
 * keyboard-reachable; the switch and the remove button stopPropagation so
 * flipping one does not also open the row (and vice versa).
 */
function ToolRow({
  icon: Icon, iconColor, iconBg, title, summary, typeLabel,
  on, onToggle, busy, expandable, open, onToggleOpen, onRemove, anchor, children,
}) {
  const hasSwitch = typeof onToggle === 'function';
  const dim = hasSwitch && !on;
  return (
    <div
      {...(anchor ? { 'data-cap': anchor } : {})}
      style={{
        background: C.cardBg, border: `1px solid ${open ? C.borderStrong || C.border : C.border}`,
        borderRadius: 10, overflow: 'hidden',
      }}
    >
      <div
        onClick={expandable ? onToggleOpen : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '11px 13px',
          cursor: expandable ? 'pointer' : 'default',
        }}
      >
        <div style={{
          width: 30, height: 30, borderRadius: 8, flexShrink: 0,
          background: dim ? 'var(--c-surfaceAlt)' : iconBg,
          color: dim ? C.textMuted : iconColor,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={15} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: dim ? C.textSecondary : C.text,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {title}
            </span>
            {typeLabel && (
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase',
                color: C.textMuted, background: 'var(--c-surfaceAlt)', borderRadius: 20, padding: '2px 7px', flexShrink: 0 }}>
                {typeLabel}
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, color: C.textSecondary, marginTop: 2,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {summary}
          </div>
        </div>

        {onRemove && (
          <button
            type="button"
            title="Remove this tool"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 4,
              color: C.textMuted, display: 'flex', alignItems: 'center', flexShrink: 0 }}
          >
            <Trash2 size={14} />
          </button>
        )}

        {hasSwitch && (
          <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            {busy
              ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', color: C.textMuted }} />
              : <Toggle checked={!!on} onChange={onToggle} />}
          </div>
        )}

        {/* The chevron is a marker, not a second control — the whole header is
            the button. Reserved space either way so rows stay aligned. */}
        <div style={{ width: 16, flexShrink: 0, display: 'flex', justifyContent: 'center', color: C.textMuted }}>
          {expandable && (open ? <ChevronDown size={15} /> : <ChevronRight size={15} />)}
        </div>
      </div>

      {expandable && open && children && (
        <div style={{ padding: '0 13px 13px', borderTop: `1px solid ${C.border}`, paddingTop: 13 }}>
          {children}
        </div>
      )}
    </div>
  );
}

function pretty(e) {
  if (!e) return 'Unknown error';
  const msg = e.message || String(e);
  try {
    const m = msg.match(/^\d+\s+(.+)$/);
    if (m) {
      const body = JSON.parse(m[1]);
      if (body && body.error) return body.error;
    }
  } catch { /* fall through */ }
  return msg;
}
