import { useState, useEffect, useCallback, Fragment } from 'react';
import { Search, Download, Upload, Users } from 'lucide-react';
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

const CHOICE_TYPES = ['dropdown', 'radio'];

// One cell per registry field. System fields keep their special renderers
// (StageBadge, the red follow-up count, the Unassigned muted text); custom
// fields read the lead's custom_fields bag.
function LeadCell({ f, l }) {
  if (f.isSystem) {
    switch (f.fieldKey) {
      case 'name': return <Td bold>{l.name || '—'}</Td>;
      case 'whatsapp_number': return <Td mono color={C.textSecondary}>{l.whatsappNumber}</Td>;
      case 'email': return <Td color={C.textSecondary}>{l.email || '—'}</Td>;
      case 'age': return <Td align="center" mono>{l.age ?? '—'}</Td>;
      case 'profession': return <Td>{l.profession || '—'}</Td>;
      case 'pincode': return <Td mono color={C.textSecondary}>{l.pincode || '—'}</Td>;
      case 'city': return <Td>{l.city || '—'}</Td>;
      case 'source': return <Td>{l.source || '—'}</Td>;
      case 'stage': return <Td><StageBadge stage={l.stage} /></Td>;
      // leads.follow_up_count — the consecutive-chase streak the cold-drop
      // engine reads. Its only writer was the Follow-ups feature, removed
      // 2026-08-12, so the value is now frozen at whatever it last held. The
      // column is hidden by default for that reason (Admin Settings → Fields
      // can show it again); this renders the stored number if it is.
      case 'follow_up_count':
        return <Td align="center" mono color={l.followUpCount > 0 ? C.text : C.textMuted}>{l.followUpCount ?? 0}</Td>;
      case 'assigned_to': return <Td>{l.assignedUserName || l.assignedBda || <span style={{ color: C.textMuted }}>Unassigned</span>}</Td>;
      case 'paid_course': return <Td>{l.paidCourse || '—'}</Td>;
      case 'total_paid': return <Td mono align="right" bold>{l.paidAmount != null ? fmtINR(l.paidAmount) : '—'}</Td>;
      case 'payment_date': return <Td color={C.textSecondary}>{l.paymentDate ? fmtDate(l.paymentDate) : '—'}</Td>;
      case 'created_at': return <Td color={C.textSecondary}>{fmtDate(l.createdAt)}</Td>;
      case 'last_activity_at': return <Td color={C.textSecondary}>{fmtDate(l.lastActivityAt)}</Td>;
      default: return <Td color={C.textSecondary}>—</Td>;
    }
  }
  return <Td>{formatFieldValue(l.customFields?.[f.fieldKey]) ?? '—'}</Td>;
}

const cellAlign = (f) => (
  f.isSystem && (f.fieldKey === 'age' || f.fieldKey === 'follow_up_count') ? 'center'
    : f.isSystem && f.fieldKey === 'total_paid' ? 'right' : 'left'
);

export default function LeadsPage({ user, subParts, navigate, tabs, view = 'list', onChangeView }) {
  const { sources, stages } = useFunnelConfig();
  const { lead: leadFields } = useFieldRegistry();
  const [stage, setStage] = useState('');
  const [source, setSource] = useState('');
  const [cfFilters, setCfFilters] = useState({}); // field_key → value
  const [search, setSearch] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [leads, setLeads] = useState(null);
  const [loading, setLoading] = useState(true);

  // Columns come from the registry: everything flagged for the Leads table,
  // in the configured order. Admin Settings → Fields controls this.
  const visible = leadFields.filter(f => f.showInLeads);
  // Choice-type fields get their own filter control (Source and Stage already
  // have dedicated ones above).
  const choiceFilters = visible.filter(f =>
    CHOICE_TYPES.includes(f.fieldType) && !['source', 'stage'].includes(f.fieldKey) && (f.options?.length));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (stage) params.stage = stage;
      if (source) params.source = source;
      if (search.trim()) params.search = search.trim();
      for (const [k, v] of Object.entries(cfFilters)) if (v) params[`cf_${k}`] = v;
      const { leads } = await api.leads.list(params);
      setLeads(leads);
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
      title="Leads"
      subtitle="The working master table — every lead, filterable and exportable."
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
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 200 }}>
          <Search size={15} color={C.textMuted} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, number, email…"
            style={{ width: '100%', padding: '9px 11px 9px 34px', borderRadius: 8, border: `1.5px solid ${C.border}`, fontFamily: FONT, fontSize: 15, outline: 'none', background: C.cardBg, color: C.text, boxSizing: 'border-box' }} />
        </div>
        <div style={{ width: 160 }}>
          <SearchableSelect value={stage} onChange={setStage} options={[{ value: '', label: 'All stages' }, ...stages.map(s => ({ value: s.stageKey, label: s.label }))]} placeholder="All stages" />
        </div>
        <div style={{ width: 160 }}>
          <SearchableSelect value={source} onChange={setSource} options={[{ value: '', label: 'All sources' }, ...sources.map(s => ({ value: s, label: s }))]} placeholder="All sources" />
        </div>
        {choiceFilters.map(f => (
          <div key={f.fieldKey} style={{ width: 170 }}>
            <SearchableSelect
              value={cfFilters[f.fieldKey] || ''}
              onChange={v => setCfFilters(prev => ({ ...prev, [f.fieldKey]: v }))}
              options={[{ value: '', label: `All — ${f.label}` }, ...f.options.map(o => ({ value: o, label: o }))]}
              placeholder={f.label} />
          </div>
        ))}
      </div>

      {loading ? <Shimmer height={320} radius={12} /> : (
        <>
          <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 8, fontFamily: MONO }}>{leads?.length || 0} leads</div>
          <Table
            columns={columns} rows={leads} keyOf={l => l.id}
            empty={<EmptyState Icon={Users} title="No leads match" hint="Try clearing the filters above." />}
            onRowClick={(l) => onChangeView && onChangeView('board')}
            renderRow={(l) => (
              <>
                {visible.map(f => <Fragment key={f.fieldKey}><LeadCell f={f} l={l} /></Fragment>)}
              </>
            )}
          />
        </>
      )}

      <LeadImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={load}
      />
    </PageShell>
  );
}
