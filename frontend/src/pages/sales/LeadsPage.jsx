import { useState, useEffect, useCallback } from 'react';
import { Search, Download, Users } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import { showError } from '../../lib/feedback.js';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import { useFunnelConfig } from '../../hooks/useFunnelConfig.js';
import {
  PageShell, Button, Table, Td, StageBadge, Segmented, EmptyState,
  fmtDate,
} from '../academy/shared.jsx';
import { Shimmer } from '../../components/charts.jsx';

const VIEWS = [
  { value: '', label: 'All leads' },
  { value: 'my', label: 'My Leads' },
  { value: 'hot', label: 'Hot Leads' },        // arrived within 24h
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'needs-follow-up', label: 'Needs Follow-up' },
];

export default function LeadsPage({ user, subParts, navigate }) {
  const { sources, stages } = useFunnelConfig();
  const [view, setView] = useState('');
  const [stage, setStage] = useState('');
  const [source, setSource] = useState('');
  const [search, setSearch] = useState('');
  const [leads, setLeads] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (view) params.view = view;
      if (stage) params.stage = stage;
      if (source) params.source = source;
      if (search.trim()) params.search = search.trim();
      const { leads } = await api.leads.list(params);
      setLeads(leads);
    } catch (e) { showError(e.message); }
    finally { setLoading(false); }
  }, [view, stage, source, search]);

  useEffect(() => { const t = setTimeout(load, search ? 300 : 0); return () => clearTimeout(t); }, [load, search]);

  const columns = [
    { label: 'Name' }, { label: 'WhatsApp' }, { label: 'Source' }, { label: 'Stage' },
    { label: 'Follow-ups', align: 'center' }, { label: 'BDA' },
    { label: 'Arrived' }, { label: 'Last Activity' },
  ];

  return (
    <PageShell
      title="Leads"
      subtitle="The working master table — every lead, filterable and exportable."
      actions={
        <a href={api.leads.exportUrl({ ...(view && { view }), ...(stage && { stage }), ...(source && { source }) })} download style={{ textDecoration: 'none' }}>
          <Button variant="secondary" icon={Download}>Export CSV</Button>
        </a>
      }
    >
      {/* Saved views */}
      <div style={{ marginBottom: 14 }}>
        <Segmented options={VIEWS} value={view} onChange={setView} />
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 200 }}>
          <Search size={15} color={C.textMuted} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, number, email…"
            style={{ width: '100%', padding: '9px 11px 9px 34px', borderRadius: 8, border: `1.5px solid ${C.border}`, fontFamily: FONT, fontSize: 13.5, outline: 'none', background: C.cardBg, color: C.text, boxSizing: 'border-box' }} />
        </div>
        <div style={{ width: 160 }}>
          <SearchableSelect value={stage} onChange={setStage} options={[{ value: '', label: 'All stages' }, ...stages.map(s => ({ value: s.stageKey, label: s.label }))]} placeholder="All stages" />
        </div>
        <div style={{ width: 160 }}>
          <SearchableSelect value={source} onChange={setSource} options={[{ value: '', label: 'All sources' }, ...sources.map(s => ({ value: s, label: s }))]} placeholder="All sources" />
        </div>
      </div>

      {loading ? <Shimmer height={320} radius={12} /> : (
        <>
          <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 8, fontFamily: MONO }}>{leads?.length || 0} leads</div>
          <Table
            columns={columns} rows={leads} keyOf={l => l.id}
            empty={<EmptyState Icon={Users} title="No leads match" hint="Try clearing filters or a different saved view." />}
            onRowClick={(l) => navigate && navigate('sales-pipeline')}
            renderRow={(l) => (
              <>
                <Td bold>{l.name || '—'}</Td>
                <Td mono color={C.textSecondary}>{l.whatsappNumber}</Td>
                <Td>{l.source || '—'}</Td>
                <Td><StageBadge stage={l.stage} /></Td>
                <Td align="center" mono color={l.followUpCount >= 3 ? C.primary : C.textSecondary}>{l.followUpCount}</Td>
                <Td>{l.assignedUserName || l.assignedBda || <span style={{ color: C.textMuted }}>Unassigned</span>}</Td>
                <Td color={C.textSecondary}>{fmtDate(l.createdAt)}</Td>
                <Td color={C.textSecondary}>{fmtDate(l.lastActivityAt)}</Td>
              </>
            )}
          />
        </>
      )}
    </PageShell>
  );
}
