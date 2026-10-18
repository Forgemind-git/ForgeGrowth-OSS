import { useState, useEffect, useCallback, Fragment } from 'react';
import { Search, Download, Upload, Users, SlidersHorizontal } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import { showError } from '../../lib/feedback.js';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import { useFunnelConfig } from '../../hooks/useFunnelConfig.js';
import { useFieldRegistry, formatFieldValue } from '../../hooks/useFieldRegistry.js';
import {
  PageShell, Button, Table, Td, StageBadge, EmptyState, LeadsViewToggle,
  fmtDate, fmtINR,
} from '../academy/shared.jsx';
import { Shimmer } from '../../components/charts.jsx';
import LeadImportModal from './LeadImportModal.jsx';
import ContactProfileModal, { ContactAvatar, contactName } from './ContactProfileModal.jsx';
import MaskedNumber from '../../components/MaskedNumber.jsx';
import { showSuccess } from '../../lib/feedback.js';
import PaymentStatusBadge from '../../components/PaymentStatusBadge.jsx';

const CHOICE_TYPES = ['dropdown', 'radio'];

// Free text (a profession typed as a paragraph, a WhatsApp name that is a
// sentence) is clipped to one line so a single long value cannot stretch its
// column across the screen — the full text is on hover and in the profile.
function Clip({ children, w = 220, muted }) {
  const text = children == null || children === '' ? null : String(children);
  return (
    <span title={text || ''} style={{ display: 'block', maxWidth: w, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: text ? undefined : C.textMuted }}>
      {text ?? '—'}
    </span>
  );
}

// One cell per registry field. System fields keep their special renderers
// (StageBadge, the red follow-up count, the Unassigned muted text); custom
// fields read the lead's custom_fields bag.
function LeadCell({ f, l }) {
  if (f.isSystem) {
    switch (f.fieldKey) {
      // A WhatsApp profile name is whatever the person typed — sometimes a whole
      // sentence — so it is clamped rather than allowed to stretch the column.
      case 'name': return (
        <Td>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10, maxWidth: 200 }}>
            <ContactAvatar label={contactName(l)} seed={l.whatsappNumber} size={30} />
            <span style={{ fontWeight: 600, color: l.name ? C.text : C.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.name || ''}>{contactName(l)}</span>
          </span>
        </Td>
      );
      case 'whatsapp_number': return <Td mono color={C.textSecondary}><MaskedNumber number={l.whatsappNumber} /></Td>;
      case 'email': return <Td color={C.textSecondary}><Clip>{l.email}</Clip></Td>;
      case 'age': return <Td align="center" mono>{l.age ?? '—'}</Td>;
      case 'profession': return <Td><Clip w={140}>{l.profession}</Clip></Td>;
      case 'pincode': return <Td mono color={C.textSecondary}>{l.pincode || '—'}</Td>;
      case 'city': return <Td><Clip w={160}>{l.city}</Clip></Td>;
      case 'source': return <Td><Clip w={150}>{l.source}</Clip></Td>;
      case 'stage': return <Td><StageBadge stage={l.stage} /></Td>;
      // leads.follow_up_count — the consecutive-chase streak the cold-drop
      // engine reads. Its only writer was the Follow-ups feature, removed
      // 2026-08-12, so the value is now frozen at whatever it last held. The
      // column is hidden by default for that reason (Admin Settings → Fields
      // can show it again); this renders the stored number if it is.
      case 'follow_up_count':
        return <Td align="center" mono color={l.followUpCount > 0 ? C.text : C.textMuted}>{l.followUpCount ?? 0}</Td>;
      case 'assigned_to': return <Td>{l.assignedUserName || l.assignedBda || <span style={{ color: C.textMuted }}>Unassigned</span>}</Td>;
      case 'paid_course': return <Td><Clip w={200}>{l.paidCourse}</Clip></Td>;
      case 'total_paid': return <Td mono align="right" bold>{l.paidAmount != null ? fmtINR(l.paidAmount) : '—'}</Td>;
      case 'payment_date': return <Td color={C.textSecondary}>{l.paymentDate ? fmtDate(l.paymentDate) : '—'}</Td>;
      case 'payment_status': return <Td><PaymentStatusBadge status={l.paymentStatus} source={l.paymentStatusSource} outstandingAmount={l.outstandingAmount} /></Td>;
      case 'created_at': return <Td color={C.textSecondary}>{fmtDate(l.createdAt)}</Td>;
      case 'last_activity_at': return <Td color={C.textSecondary}>{fmtDate(l.lastActivityAt)}</Td>;
      default: return <Td color={C.textSecondary}>—</Td>;
    }
  }
  return <Td><Clip w={200}>{formatFieldValue(l.customFields?.[f.fieldKey])}</Clip></Td>;
}

const cellAlign = (f) => (
  f.isSystem && (f.fieldKey === 'age' || f.fieldKey === 'follow_up_count') ? 'center'
    : f.isSystem && f.fieldKey === 'total_paid' ? 'right' : 'left'
);

// System columns always show — they are the primary data. A custom column
// flagged for this table shows only while at least 10% of the contacts in view
// have a value in it: measured on live data, the five custom columns were filled
// for 1–5% of contacts, so the table was mostly dashes. Filtering (to one
// source, say) brings a field back the moment it becomes common in that slice,
// and every value is always in the contact's profile.
const MIN_FILL = 0.1;
function hasValue(f, l) {
  const v = l.customFields?.[f.fieldKey];
  return !(v == null || v === '' || (Array.isArray(v) && !v.length));
}

export default function LeadsPage({ user, navigate, tabs, view = 'list', onChangeView, initialSource = '' }) {
  const { sources, stages } = useFunnelConfig();
  const { lead: leadFields } = useFieldRegistry();
  const [stage, setStage] = useState('');
  const [source, setSource] = useState(initialSource || '');
  const [cfFilters, setCfFilters] = useState({}); // field_key → value
  const [moreFilters, setMoreFilters] = useState(false);
  const [search, setSearch] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [leads, setLeads] = useState(null);
  const [total, setTotal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null); // the contact open in the profile pop-up
  const isAdmin = user?.role === 'admin';
  useEffect(() => { if (initialSource) setSource(initialSource); }, [initialSource]);

  // Columns come from the registry: everything flagged for this table, in the
  // configured order (Admin Settings → Fields), minus custom columns that are
  // empty for every contact in view.
  const flagged = leadFields.filter(f => f.showInLeads);
  const rowsInView = leads || [];
  const visible = flagged.filter(f => f.isSystem
    || (rowsInView.length > 0 && rowsInView.filter(l => hasValue(f, l)).length >= Math.max(1, Math.ceil(rowsInView.length * MIN_FILL))));
  const hiddenEmpty = flagged.length - visible.length;
  // Filters for choice-type CUSTOM fields live behind "More filters" — every
  // dropdown field the registry defines, shown on the table or not.
  const choiceFilters = leadFields.filter(f =>
    !f.isSystem && CHOICE_TYPES.includes(f.fieldType) && (f.options?.length));
  const activeCf = Object.values(cfFilters).filter(Boolean).length;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (stage) params.stage = stage;
      if (source) params.source = source;
      if (search.trim()) params.search = search.trim();
      for (const [k, v] of Object.entries(cfFilters)) if (v) params[`cf_${k}`] = v;
      const { leads, total } = await api.leads.list(params);
      setLeads(leads); setTotal(total ?? null);
    } catch (e) { showError(e.message); }
    finally { setLoading(false); }
  }, [stage, source, search, cfFilters]);

  useEffect(() => { const t = setTimeout(load, search ? 300 : 0); return () => clearTimeout(t); }, [load, search]);

  const columns = visible.map(f => ({ label: f.label, align: cellAlign(f) }));
  const exportParams = {
    ...(stage && { stage }), ...(source && { source }),
    ...Object.fromEntries(Object.entries(cfFilters).filter(([, v]) => v).map(([k, v]) => [`cf_${k}`, v])),
  };

  return (
    <PageShell
      subtitle="Everyone in Sales — from WhatsApp, ads and imports. Click a contact to open their profile."
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <LeadsViewToggle view={view} onChange={onChangeView} />
          <Button variant="secondary" icon={Upload} onClick={() => setImportOpen(true)}>Import</Button>
          {/* A plain <a download> so the auth cookie rides along. */}
          <a href={api.leads.exportUrl(exportParams)} download style={{ textDecoration: 'none' }}>
            <Button variant="secondary" icon={Download}>Export CSV</Button>
          </a>
        </div>
      }
    >
      {tabs}
      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: moreFilters ? 10 : 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 200 }}>
          <Search size={15} color={C.textMuted} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, number, email…"
            style={{ width: '100%', padding: '9px 11px 9px 34px', borderRadius: 8, border: `1.5px solid ${C.border}`, fontFamily: FONT, fontSize: 15, outline: 'none', background: C.cardBg, color: C.text, boxSizing: 'border-box' }} />
        </div>
        <div style={{ width: 170 }}>
          <SearchableSelect value={stage} onChange={setStage} options={[{ value: '', label: 'All stages' }, ...stages.map(s => ({ value: s.stageKey, label: s.label }))]} placeholder="All stages" />
        </div>
        <div style={{ width: 200 }}>
          <SearchableSelect value={source} onChange={setSource} options={[{ value: '', label: 'All sources' }, ...sources.map(s => ({ value: s, label: s }))]} placeholder="All sources" />
        </div>
        {choiceFilters.length > 0 && (
          <button onClick={() => setMoreFilters(o => !o)} data-testid="more-filters"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 13px', borderRadius: 8, border: `1.5px solid ${moreFilters || activeCf ? C.primary : C.border}`, background: moreFilters || activeCf ? C.primaryLight : C.cardBg, color: moreFilters || activeCf ? C.primary : C.textSecondary, fontFamily: FONT, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
            <SlidersHorizontal size={14} /> More filters{activeCf ? ` · ${activeCf}` : ''}
          </button>
        )}
      </div>
      {moreFilters && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center', padding: 12, borderRadius: 10, background: C.surfaceSection, border: `1px solid ${C.borderSubtle}` }}>
          {choiceFilters.map(f => (
            <div key={f.fieldKey} style={{ width: 200 }}>
              <SearchableSelect
                value={cfFilters[f.fieldKey] || ''}
                onChange={v => setCfFilters(prev => ({ ...prev, [f.fieldKey]: v }))}
                options={[{ value: '', label: `Any ${f.label.toLowerCase()}` }, ...f.options.map(o => ({ value: o, label: o }))]}
                placeholder={f.label} />
            </div>
          ))}
          {activeCf > 0 && <button onClick={() => setCfFilters({})} style={{ background: 'none', border: 'none', color: C.primary, fontFamily: FONT, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Clear</button>}
        </div>
      )}

      {loading && !leads ? <Shimmer height={320} radius={12} /> : (
        <>
          <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 8, fontFamily: MONO, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <span>{total != null && total > (leads?.length || 0) ? `Newest ${(leads?.length || 0).toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')} contacts — search or filter to narrow` : `${(leads?.length || 0).toLocaleString('en-IN')} contacts`}</span>
            {hiddenEmpty > 0 && <span title="Custom columns filled for fewer than 1 in 10 of these contacts are hidden — open a contact to see every value. Admin Settings → Fields controls which columns this table offers.">{hiddenEmpty} mostly-empty column{hiddenEmpty === 1 ? '' : 's'} hidden</span>}
          </div>
          {/* Tighter cell padding than the shared Table's, so the eight primary
              columns fit a laptop screen without a sideways scroll. */}
          <style>{'.fg-contacts .fg-table th, .fg-contacts .fg-table td { padding-left: 10px !important; padding-right: 10px !important; }'}</style>
          <div className="fg-contacts">
          <Table
            columns={columns} rows={leads} keyOf={l => l.id}
            empty={<EmptyState Icon={Users} title="No contacts match" hint="Try clearing the filters above." />}
            onRowClick={(l) => setOpen(l)}
            renderRow={(l) => (
              <>
                {visible.map(f => <Fragment key={f.fieldKey}><LeadCell f={f} l={l} /></Fragment>)}
              </>
            )}
          />
          </div>
        </>
      )}

      {open && (
        <ContactProfileModal
          lead={open}
          user={user}
          navigate={navigate}
          onClose={() => setOpen(null)}
          onChanged={load}
        />
      )}
      <LeadImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={load}
      />
    </PageShell>
  );
}
