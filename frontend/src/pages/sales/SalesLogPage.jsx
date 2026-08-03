// Sales Log (spec §7) — a manual log of paid / converted leads. Product options
// come from the Products registry; Source options from Funnel Sources.
// Amounts are rupees at this layer (backend stores paise). Lives in Sales section.
import { useState, useEffect } from 'react';
import { Plus, Pencil, Trash2, Receipt, IndianRupee, Package, ArrowLeft } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import { showError, showSuccess } from '../../lib/feedback.js';
import { PageShell, Button, Table, Td, Modal, Field, inputStyle, EmptyState, Segmented, fmtINR, fmtDate } from '../academy/shared.jsx';
import { KpiCard, Card, Shimmer } from '../../components/charts.jsx';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import { useFunnelConfig } from '../../hooks/useFunnelConfig.js';
import SearchableSelect from '../../components/SearchableSelect.jsx';

const BLANK = { studentName: '', courseId: '', amount: '', paymentDate: new Date().toISOString().slice(0, 10), funnelSource: '', notes: '' };

export default function SalesLogPage({ user, navigate }) {
  const isAdmin = user?.role === 'admin';
  const { sources } = useFunnelConfig();
  const [rows, setRows] = useState(null);
  const [summary, setSummary] = useState(null);
  const [products, setProducts] = useState([]);
  const [filters, setFilters] = useState({ courseId: '', source: '', range: 'all' });
  const [modal, setModal] = useState(null); // { ...form, id? }
  const [saving, setSaving] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  function rangeDates(key) {
    const iso = (d) => d.toISOString().slice(0, 10);
    const now = new Date();
    if (key === 'month') return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
    if (key === 'week') { const d = new Date(now); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return { from: iso(d), to: iso(now) }; }
    return { from: '', to: '' };
  }

  async function load() {
    const dates = rangeDates(filters.range);
    const params = { courseId: filters.courseId, source: filters.source, from: dates.from, to: dates.to };
    try {
      const [list, sum] = await Promise.all([api.salesLog.list(params), api.salesLog.summary(params)]);
      setRows(list.sales || []);
      setSummary(sum);
    } catch (e) { showError(e.message); setRows([]); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filters.courseId, filters.source, filters.range]);
  useEffect(() => { api.products.list().then(r => setProducts(r.products || [])).catch(() => {}); }, []);

  async function save() {
    if (!modal.studentName.trim()) return showError('Student/client name is required');
    if (!modal.paymentDate) return showError('Date of payment is required');
    setSaving(true);
    try {
      const body = {
        studentName: modal.studentName.trim(),
        courseId: modal.courseId || null,
        amount: Number(modal.amount) || 0,
        paymentDate: modal.paymentDate,
        funnelSource: modal.funnelSource || null,
        notes: modal.notes || null,
      };
      if (modal.id) await api.salesLog.update(modal.id, body);
      else await api.salesLog.create(body);
      showSuccess(modal.id ? 'Sale updated' : 'Sale logged');
      setModal(null); load();
    } catch (e) { showError(e.message); } finally { setSaving(false); }
  }

  async function remove(row) {
    if (!(await confirm({ title: 'Delete sale', body: `Delete the sale for “${row.studentName}”? This cannot be undone.`, confirmLabel: 'Delete', danger: true }))) return;
    try { await api.salesLog.delete(row.id); load(); } catch (e) { showError(e.message); }
  }

  const courseOpts = [{ value: '', label: 'All products' }, ...products.map(c => ({ value: String(c.id), label: c.name }))];
  const courseModalOpts = [{ value: '', label: '— None —' }, ...products.map(c => ({ value: String(c.id), label: c.name }))];
  const sourceOpts = [{ value: '', label: 'All sources' }, ...sources.map(s => ({ value: s, label: s }))];
  const sourceModalOpts = [{ value: '', label: '— Not set —' }, ...sources.map(s => ({ value: s, label: s }))];

  const columns = [
    { key: 'student', label: 'Student / Client' },
    { key: 'product', label: 'Product' },
    { key: 'amount', label: 'Amount', align: 'right' },
    { key: 'date', label: 'Payment Date' },
    { key: 'source', label: 'Source' },
    { key: 'notes', label: 'Notes' },
    ...(isAdmin ? [{ key: 'act', label: '', align: 'right' }] : []),
  ];

  return (
    <PageShell
      title="Sales Log"
      subtitle="Every paid / converted lead, logged. Feeds the summary numbers above."
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button icon={ArrowLeft} onClick={() => navigate && navigate('onboarding')}>Students</Button>
          <Button variant="primary" icon={Plus} onClick={() => setModal({ ...BLANK })}>Log a sale</Button>
        </div>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 18 }}>
        <KpiCard label="Total sales" value={summary ? summary.totalSales : '—'} icon={Receipt} info="Number of sales in the current filter." />
        <KpiCard label="Total revenue" value={summary ? fmtINR(summary.totalRevenue) : '—'} accent={C.green} icon={IndianRupee} info="Sum of amounts paid in the current filter." />
        <KpiCard label="Top product" value={summary?.byProduct?.[0]?.product || '—'} accent={C.purple} icon={Package}
          sub={summary?.byProduct?.[0] ? `${summary.byProduct[0].units} sold · ${fmtINR(summary.byProduct[0].revenue)}` : null}
          info="Highest-revenue product in the current filter." />
      </div>

      <Card
        title="Sales"
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <SearchableSelect value={filters.courseId} onChange={v => setFilters(f => ({ ...f, courseId: v }))} options={courseOpts} placeholder="All products" triggerStyle={{ padding: '7px 28px 7px 10px', fontSize: 12.5 }} />
            <SearchableSelect value={filters.source} onChange={v => setFilters(f => ({ ...f, source: v }))} options={sourceOpts} placeholder="All sources" triggerStyle={{ padding: '7px 28px 7px 10px', fontSize: 12.5 }} />
            <Segmented value={filters.range} onChange={v => setFilters(f => ({ ...f, range: v }))}
              options={[{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'all', label: 'All' }]} />
          </div>
        }
      >
        {rows == null ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{[0, 1, 2, 3].map(i => <Shimmer key={i} height={34} />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState Icon={Receipt} title="No sales logged yet" hint="Click “Log a sale” to record a converted lead." />
        ) : (
          <Table
            columns={columns}
            rows={rows}
            keyOf={r => r.id}
            renderRow={r => (
              <>
                <Td bold>{r.studentName}</Td>
                <Td>{r.productLabel || '—'}</Td>
                <Td mono align="right">{fmtINR(r.amount)}</Td>
                <Td mono>{fmtDate(r.paymentDate)}</Td>
                <Td>{r.funnelSource || '—'}</Td>
                <Td color={C.textSecondary} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.notes || '—'}</Td>
                {isAdmin && (
                  <Td align="right">
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <button title="Edit" onClick={() => setModal({ ...r, courseId: r.courseId ? String(r.courseId) : '', funnelSource: r.funnelSource || '' })}
                        style={iconBtn}><Pencil size={14} /></button>
                      <button title="Delete" onClick={() => remove(r)} style={{ ...iconBtn, color: C.primary }}><Trash2 size={14} /></button>
                    </span>
                  </Td>
                )}
              </>
            )}
          />
        )}
      </Card>

      {modal && (
        <Modal title={modal.id ? 'Edit sale' : 'Log a sale'} onClose={() => setModal(null)} width={520}
          footer={<>
            <Button onClick={() => setModal(null)}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : (modal.id ? 'Save changes' : 'Log sale')}</Button>
          </>}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Student / client name">
                <input value={modal.studentName} onChange={e => setModal(m => ({ ...m, studentName: e.target.value }))} style={inputStyle} placeholder="Who purchased" autoFocus />
              </Field>
            </div>
            <Field label="Product">
              <SearchableSelect value={modal.courseId} onChange={v => setModal(m => ({ ...m, courseId: v }))} options={courseModalOpts} placeholder="— None —" />
            </Field>
            <Field label="Amount paid (₹)">
              <input type="number" min="0" value={modal.amount} onChange={e => setModal(m => ({ ...m, amount: e.target.value }))} style={{ ...inputStyle, fontFamily: MONO }} placeholder="0" />
            </Field>
            <Field label="Date of payment">
              <input type="date" value={modal.paymentDate} onChange={e => setModal(m => ({ ...m, paymentDate: e.target.value }))} style={inputStyle} />
            </Field>
            <Field label="Funnel source">
              <SearchableSelect value={modal.funnelSource} onChange={v => setModal(m => ({ ...m, funnelSource: v }))} options={sourceModalOpts} placeholder="— Not set —" />
            </Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Notes (optional)">
                <textarea value={modal.notes} onChange={e => setModal(m => ({ ...m, notes: e.target.value }))} style={{ ...inputStyle, minHeight: 64, resize: 'vertical' }} placeholder="Anything worth remembering about this sale" />
              </Field>
            </div>
          </div>
        </Modal>
      )}
      {confirmEl}
    </PageShell>
  );
}

const iconBtn = { background: 'none', border: `1.5px solid ${C.border}`, borderRadius: 7, padding: '5px 7px', cursor: 'pointer', color: C.textSecondary, display: 'inline-flex' };
