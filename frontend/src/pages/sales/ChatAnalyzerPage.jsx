// Chats → Chat Analyzer.
//
// Four views behind one nav item: the conversations you can analyse, what it has
// cost, the run history, and its settings. Settings live HERE rather than in
// Admin Settings so the whole feature — including the switches that decide what
// it spends money on — is in one place.
//
// It sits in the Inbox group, beside Chats and Communities, because those two
// are exactly what it reads.
//
// ⚠ SIZES COME FROM THE T/W/LH SCALE, NEVER A TYPED NUMBER. The first version
// hand-typed 36 font sizes, 25 of them under 13px. If you are about to write
// `fontSize: 12`, use T.label.

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ScanSearch, RefreshCw, Settings, IndianRupee, Mic, Image as ImageIcon,
  FileText, MessageSquare, ArrowLeft, Users2, User, Check, Info, Cpu,
} from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO, T, W, LH } from '../../constants.js';
import { showError, showSuccess } from '../../lib/feedback.js';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import MaskedNumber from '../../components/MaskedNumber.jsx';
import ChatAnalyzerPanel from '../../components/ChatAnalyzerPanel.jsx';
import { funnelStageMeta } from '../../hooks/useFunnelConfig.js';
import { PageShell, Button, EmptyState, Field, inputStyle, Modal, Table, Td } from '../academy/shared.jsx';
import { Card, Shimmer, EmptyChart } from '../../components/charts.jsx';

const IC = { inline: 16, row: 18, section: 20, kpi: 22 };

// One colour per spend category, used by the stacked bar, the legend and the
// per-row bars — so a colour means the same thing everywhere on the tab.
const COST_COLOURS = {
  llm: '#534AB7',
  audio: '#0F6E56',
  image: '#dc2626',
  document: '#E8A317',
};

const VIEWS = [
  { key: 'conversations', label: 'Conversations' },
  { key: 'context', label: 'Business context' },
  { key: 'cost', label: 'Cost' },
  { key: 'runs', label: 'Run history' },
];

export default function ChatAnalyzerPage({ user, navigate, subParts = [] }) {
  const isAdmin = user?.role === 'admin';
  // Routed, not local state: a refresh or a pasted link keeps the view, and the
  // open conversation survives a reload.
  const openKey = subParts[0] === 'c' ? subParts[2] : null;
  const openSource = subParts[0] === 'c' ? subParts[1] : null;
  const view = VIEWS.some(v => v.key === subParts[0]) ? subParts[0] : 'conversations';

  if (openKey) {
    return <ConversationDetail source={openSource} conversationKey={openKey} navigate={navigate} />;
  }
  return <AnalyzerHome view={view} navigate={navigate} isAdmin={isAdmin} />;
}

function AnalyzerHome({ view, navigate, isAdmin }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <PageShell
      subtitle="What every conversation is actually saying — including the voice notes, screenshots and PDFs."
      actions={isAdmin ? <Button icon={Settings} onClick={() => setSettingsOpen(true)}>Settings</Button> : null}
    >
      <ViewTabs view={view} navigate={navigate} />
      {view === 'conversations' && <ConversationList navigate={navigate} />}
      {view === 'context' && <BusinessContext isAdmin={isAdmin} />}
      {view === 'cost' && <CostDashboard />}
      {view === 'runs' && <RunHistory navigate={navigate} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </PageShell>
  );
}

function ViewTabs({ view, navigate }) {
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 22, borderBottom: `1px solid ${C.border}` }}>
      {VIEWS.map(v => {
        const on = v.key === view;
        return (
          <button key={v.key} onClick={() => navigate('chat-analyzer', v.key)} style={{
            padding: '12px 18px', border: 'none', background: 'transparent', cursor: 'pointer',
            fontFamily: FONT, fontSize: T.bodyLg, fontWeight: on ? W.bold : W.medium,
            color: on ? C.text : C.textSecondary,
            borderBottom: `3px solid ${on ? 'var(--c-primary)' : 'transparent'}`, marginBottom: -1,
          }}>{v.label}</button>
        );
      })}
    </div>
  );
}

// ── business context ──────────────────────────────────────────────────────────
//
// What the analyser is told about the business and the products we sell. It is
// read on EVERY analysis, which is what lets a recommendation name the product
// and a follow-up message mention its real price, dates and details.

function BusinessContext({ isAdmin }) {
  const [data, setData] = useState(null);
  const [business, setBusiness] = useState('');
  const [savingBiz, setSavingBiz] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  const load = useCallback(async () => {
    try {
      const d = await api.chatAnalyzer.context.get();
      setData(d); setBusiness(d.business || '');
    } catch (e) { showError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!data) return <Shimmer height={340} radius={12} />;

  const saveBiz = async () => {
    setSavingBiz(true);
    try { await api.chatAnalyzer.context.saveBusiness(business); showSuccess('Business context saved.'); await load(); }
    catch (e) { showError(e.message); } finally { setSavingBiz(false); }
  };
  const importProducts = async () => {
    try {
      const r = await api.chatAnalyzer.context.importProducts();
      showSuccess(r.imported ? `Imported ${r.imported} product(s) from Sales → Products. Paste their full details below.` : 'Every product is already here.');
      await load();
    } catch (e) { showError(e.message); }
  };
  const toImport = (data.catalog || []).filter(c => c.active !== false && !c.imported).length;
  const p = data.preview;

  return (
    <div data-testid="ca-context" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{
        padding: '14px 16px', borderRadius: 12, background: 'var(--c-infoBg, #EAF2FB)', color: 'var(--c-infoText, #1D4E79)',
        fontSize: T.body, lineHeight: LH.normal,
      }}>
        Everything here is given to the Chat Analyzer with every conversation it reads. With it, the analysis can say
        <strong> which product</strong> the customer wants, answer their doubts with <strong>your real details</strong>,
        and draft <strong>follow-up messages</strong> you can copy and send. Paste freely — syllabus, fees, batch dates,
        FAQs, how you answer common objections.
        {!isAdmin && <div style={{ marginTop: 6 }}>Only an admin can change it.</div>}
      </div>

      <ContextMeter preview={p} />

      <Card style={{ padding: 18 }}>
        <div style={{ fontSize: T.bodyLg, fontWeight: W.bold, color: C.text, marginBottom: 4 }}>About the business</div>
        <div style={{ fontSize: T.meta, color: C.textMuted, marginBottom: 10 }}>
          Who you are, who you sell to, your tone, offers running now, anything a new salesperson should know.
        </div>
        <textarea data-testid="ca-business" value={business} onChange={e => setBusiness(e.target.value)} readOnly={!isAdmin}
          rows={6} placeholder="e.g. We run live online courses for working professionals. Batches start monthly; most leads come from Instagram ads…"
          style={{ ...inputStyle, width: '100%', fontSize: T.body, lineHeight: LH.normal, resize: 'vertical', fontFamily: FONT }} />
        {isAdmin && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <Button variant="primary" onClick={saveBiz} disabled={savingBiz || business === (data.business || '')}>
              {savingBiz ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </Card>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: T.bodyLg, fontWeight: W.bold, color: C.text, flex: 1 }}>
          Products we sell <span style={{ fontWeight: W.medium, color: C.textMuted }}>· {data.products.length}</span>
        </div>
        {isAdmin && toImport > 0 && (
          <Button onClick={importProducts}>Import {toImport} from Sales → Products</Button>
        )}
        {isAdmin && <Button variant="primary" onClick={() => setAdding(true)}>Add product</Button>}
      </div>

      {adding && (
        <ProductEditor isNew onCancel={() => setAdding(false)}
          onSave={async (v) => { await api.chatAnalyzer.context.addProduct(v); setAdding(false); showSuccess('Product added.'); await load(); }} />
      )}

      {!data.products.length && !adding && (
        <EmptyState Icon={FileText} title="No products yet"
          hint={isAdmin ? 'Add the products you sell, or import them from Sales → Products, then paste their details.' : 'An admin has not added any products yet.'} />
      )}

      {data.products.map(prod => (
        <ProductEditor key={`${prod.id}:${prod.updatedAt}`} product={prod} readOnly={!isAdmin}
          onSave={async (v) => { await api.chatAnalyzer.context.updateProduct(prod.id, v); showSuccess('Product saved.'); await load(); }}
          onDelete={async () => {
            const okDel = await confirm({ title: `Remove ${prod.name}?`, body: 'The Chat Analyzer will stop using its details. Sales → Products is not affected.', confirmLabel: 'Remove', danger: true });
            if (!okDel) return;
            await api.chatAnalyzer.context.deleteProduct(prod.id); await load();
          }} />
      ))}
      {confirmEl}
      <div style={{ fontSize: T.meta, color: C.textMuted }}>
        {data.updatedAt ? `Last changed ${new Date(data.updatedAt).toLocaleString('en-IN')}${data.updatedBy ? ` by ${data.updatedBy}` : ''}. ` : ''}
        Analyses made before a change are marked as out of date — press Update analysis on a chat to use the new context.
      </div>
    </div>
  );
}

function ContextMeter({ preview }) {
  if (!preview) return null;
  const pct = Math.min(100, Math.round((preview.chars / preview.cap) * 100));
  return (
    <div style={{ fontSize: T.meta, color: C.textSecondary }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
        <span>Sent with every analysis: {preview.chars.toLocaleString('en-IN')} of {preview.cap.toLocaleString('en-IN')} characters (~{preview.estTokens.toLocaleString('en-IN')} tokens)</span>
        <span>{pct}%</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: 'var(--c-surfaceMuted)' }}>
        <div style={{ width: `${pct}%`, height: 6, borderRadius: 3, background: preview.truncated ? 'var(--c-warnText, #b8860b)' : 'var(--c-successText)' }} />
      </div>
      {preview.truncated && (
        <div style={{ marginTop: 6, color: 'var(--c-warnText, #8a6d1f)' }}>
          Over the limit — each product's details are shortened to fit. Trim the longest pastes to keep what matters.
        </div>
      )}
    </div>
  );
}

function ProductEditor({ product, isNew, readOnly, onSave, onCancel, onDelete }) {
  const [v, setV] = useState({
    name: product?.name || '', price: product?.price || '', details: product?.details || '',
    active: product ? product.active : true,
  });
  const [saving, setSaving] = useState(false);
  const dirty = isNew || v.name !== product.name || v.price !== (product.price || '') || v.details !== (product.details || '') || v.active !== product.active;
  const save = async () => {
    setSaving(true);
    try { await onSave(v); } catch (e) { showError(e.message); } finally { setSaving(false); }
  };
  return (
    <Card style={{ padding: 18, opacity: v.active ? 1 : 0.7 }}>
      <div data-testid="ca-product" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 10 }}>
        <Field label="Product">
          <input value={v.name} onChange={e => setV({ ...v, name: e.target.value })} readOnly={readOnly}
            placeholder="e.g. Data Analytics Bootcamp" style={{ ...inputStyle, width: '100%' }} />
        </Field>
        <Field label="Price">
          <input value={v.price} onChange={e => setV({ ...v, price: e.target.value })} readOnly={readOnly}
            placeholder="e.g. ₹5,499 (₹7,499 after launch)" style={{ ...inputStyle, width: '100%' }} />
        </Field>
      </div>
      <Field label="Details for the analyzer (paste anything)">
        <textarea value={v.details} onChange={e => setV({ ...v, details: e.target.value })} readOnly={readOnly} rows={7}
          placeholder="What it includes, who it is for, batch dates, duration, payment options, refund policy, FAQs, how to answer 'too expensive' or 'no time'…"
          style={{ ...inputStyle, width: '100%', fontSize: T.body, lineHeight: LH.normal, resize: 'vertical', fontFamily: FONT }} />
      </Field>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: T.body, color: C.text, cursor: readOnly ? 'default' : 'pointer' }}>
          <input type="checkbox" checked={v.active} disabled={readOnly} onChange={e => setV({ ...v, active: e.target.checked })}
            style={{ accentColor: 'var(--c-primary)', width: 17, height: 17 }} />
          Use in analyses
        </label>
        <span style={{ fontSize: T.meta, color: C.textMuted }}>{(v.details || '').length.toLocaleString('en-IN')} characters</span>
        <div style={{ flex: 1 }} />
        {!readOnly && !isNew && <Button variant="ghost" onClick={onDelete}>Remove</Button>}
        {!readOnly && isNew && <Button onClick={onCancel}>Cancel</Button>}
        {!readOnly && <Button variant="primary" onClick={save} disabled={saving || !dirty || !v.name.trim()}>{saving ? 'Saving…' : isNew ? 'Add product' : 'Save'}</Button>}
      </div>
    </Card>
  );
}

// ── conversations ─────────────────────────────────────────────────────────────

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'never', label: 'Never analysed' },
  { value: 'stale', label: 'Has new messages' },
  { value: 'analysed', label: 'Analysed' },
  { value: 'errors', label: 'Failed' },
];

function ConversationList({ navigate }) {
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState('all');
  const [source, setSource] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);

  const load = useCallback(async () => {
    setRows(null);
    try {
      const d = await api.chatAnalyzer.list({ filter, source, search });
      setRows(d.conversations);
    } catch (e) { showError(e.message); setRows([]); }
  }, [filter, source, search]);

  useEffect(() => { const t = setTimeout(load, search ? 350 : 0); return () => clearTimeout(t); }, [load, search]);

  const toggle = (c) => setSelected(s => {
    const n = new Set(s);
    const id = `${c.source}:${c.conversationKey}`;
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const selectedTargets = useMemo(() => (rows || [])
    .filter(c => selected.has(`${c.source}:${c.conversationKey}`))
    .map(c => ({ source: c.source, conversationKey: c.conversationKey })), [rows, selected]);

  return (
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ minWidth: 210 }}>
          <SearchableSelect value={filter} onChange={setFilter} options={FILTERS} placeholder="Filter" />
        </div>
        <div style={{ minWidth: 190 }}>
          <SearchableSelect value={source} onChange={setSource} placeholder="Everywhere"
            options={[
              { value: 'all', label: 'Chats and groups' },
              { value: 'chat', label: 'Chats only' },
              { value: 'community', label: 'Groups only' },
            ]} />
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search a name or number"
          style={{ ...inputStyle, width: 260, fontSize: T.body }} />
        <Button icon={RefreshCw} onClick={load}>Refresh</Button>
        {selected.size > 0 && (
          <Button variant="primary" icon={ScanSearch} onClick={() => setBulkOpen(true)}>
            Analyse {selected.size} selected
          </Button>
        )}
      </div>

      {rows === null ? <Shimmer height={340} radius={12} /> : (
        <Table
          columns={[{ label: '' }, { label: 'Conversation' }, { label: 'What it says' }, { label: 'Messages' }, { label: 'Media' }, { label: 'Last analysed' }]}
          rows={rows}
          keyOf={c => `${c.source}:${c.conversationKey}`}
          onRowClick={c => navigate('chat-analyzer', 'c', c.source, c.conversationKey)}
          empty={<EmptyState Icon={ScanSearch} title="No conversations here"
            hint="Try a different filter, or lower the minimum message count in settings." />}
          renderRow={c => {
            const id = `${c.source}:${c.conversationKey}`;
            return (
              <>
                <Td>
                  <input type="checkbox" checked={selected.has(id)}
                    onClick={e => e.stopPropagation()} onChange={() => toggle(c)}
                    style={{ accentColor: 'var(--c-primary)', width: 17, height: 17 }} />
                </Td>
                <Td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {c.source === 'community'
                      ? <Users2 size={IC.row} color={C.textSecondary} />
                      : <User size={IC.row} color={C.textSecondary} />}
                    <div>
                      <div style={{ fontWeight: W.medium, fontSize: T.body }}>{c.name}</div>
                      {c.contactNumber && (
                        <div style={{ fontSize: T.meta, color: C.textMuted }}>
                          <MaskedNumber number={c.contactNumber} />
                        </div>
                      )}
                    </div>
                  </div>
                </Td>
                <Td style={{ whiteSpace: 'normal', minWidth: 280, maxWidth: 560 }}>
                  <RowVerdict c={c} />
                </Td>
                <Td mono>{c.messageCount ?? '—'}</Td>
                <Td><MediaCounts media={c.media} /></Td>
                <Td>
                  {c.lastRunAt
                    ? <span style={{ fontSize: T.meta, display: 'inline-flex', flexDirection: 'column', gap: 5 }}>
                        <span>{new Date(c.lastRunAt).toLocaleDateString('en-IN')}{c.isStale && <StaleBadge n={c.newMessages} />}</span>
                        <ModalityDots modalities={c.modalities} />
                      </span>
                    : <span style={{ fontSize: T.meta, color: C.textMuted }}>never</span>}
                </Td>
              </>
            );
          }}
        />
      )}

      {bulkOpen && (
        <BulkModal targets={selectedTargets} onClose={() => setBulkOpen(false)}
          onDone={() => { setSelected(new Set()); setBulkOpen(false); load(); }} />
      )}
    </>
  );
}

// What the analysis said, in the row: suggested stage, buying intent and the
// first lines of the summary — enough to pick which chat to open.
const INTENT_COLOR = { high: 'var(--c-successText)', medium: 'var(--c-warnText, #b8860b)', low: 'var(--c-dangerText)', none: 'var(--c-dangerText)' };
function RowVerdict({ c }) {
  if (!c.summary) {
    return <span style={{ fontSize: T.meta, color: C.textMuted }}>{c.lastStatus === 'error' ? 'Last run failed' : 'Not analysed yet'}</span>;
  }
  const stage = c.suggestedStage ? (funnelStageMeta(c.suggestedStage)?.label || c.suggestedStage) : null;
  return (
    <div data-testid="row-verdict">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 5 }}>
        {stage && <MiniTag>{stage}</MiniTag>}
        {c.intent && <MiniTag color={INTENT_COLOR[c.intent]}>{c.intent} intent</MiniTag>}
        {c.sentiment && <MiniTag>{c.sentiment}</MiniTag>}
      </div>
      <div style={{
        fontSize: T.meta, color: C.textSecondary, lineHeight: LH.snug,
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>{c.summary}</div>
    </div>
  );
}
function MiniTag({ children, color }) {
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 999, fontSize: T.label, fontWeight: W.bold, textTransform: 'capitalize',
      background: 'var(--c-surfaceMuted)', color: color || C.textSecondary,
    }}>{children}</span>
  );
}

function MediaCounts({ media }) {
  if (!media) return <span style={{ color: C.textMuted }}>—</span>;
  const items = [
    { n: media.audio, Icon: Mic, label: 'voice notes' },
    { n: media.image, Icon: ImageIcon, label: 'images' },
    { n: media.document, Icon: FileText, label: 'documents' },
  ].filter(i => i.n > 0);
  if (!items.length) return <span style={{ color: C.textMuted, fontSize: T.meta }}>text only</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 12 }}>
      {items.map(({ n, Icon, label }) => (
        <span key={label} title={`${n} ${label}`} style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          fontSize: T.meta, fontWeight: W.medium, color: C.textSecondary,
        }}>
          <Icon size={IC.inline} />{n}
        </span>
      ))}
    </span>
  );
}

// Which modalities the standing summary was built from — so a row can say "text
// is covered, the voice notes have never been read" rather than just "analysed".
function ModalityDots({ modalities = [] }) {
  const has = new Set(modalities);
  const all = [
    { k: 'text', Icon: MessageSquare }, { k: 'audio', Icon: Mic },
    { k: 'image', Icon: ImageIcon }, { k: 'document', Icon: FileText },
  ];
  if (!modalities.length) return <span style={{ color: C.textMuted, fontSize: T.meta }}>—</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 7 }}>
      {all.map(({ k, Icon }) => (
        <Icon key={k} size={IC.inline} title={has.has(k) ? `${k} has been read` : `${k} not read`}
          color={has.has(k) ? 'var(--c-successText)' : C.border} />
      ))}
    </span>
  );
}

function StaleBadge({ n }) {
  return (
    <span style={{
      marginLeft: 8, padding: '3px 9px', borderRadius: 999, fontSize: T.micro, fontWeight: W.bold,
      background: 'var(--c-warnBg, #FFF8E1)', color: 'var(--c-warnText, #8a6d1f)',
    }}>+{n} new</span>
  );
}

// ── bulk, with the cost shown BEFORE anything is spent ────────────────────────

function BulkModal({ targets, onClose, onDone }) {
  const [mods, setMods] = useState({ text: true, audio: false, image: false, document: false });
  const [est, setEst] = useState(null);
  const [estimating, setEstimating] = useState(false);
  const [batch, setBatch] = useState(null);
  const chosen = Object.entries(mods).filter(([, v]) => v).map(([k]) => k);

  // Re-estimated whenever the choice changes: the media switches are what move
  // the number, so an estimate from before the change would understate it.
  useEffect(() => {
    if (!chosen.length) { setEst(null); return; }
    let cancelled = false;
    setEstimating(true);
    api.chatAnalyzer.estimate({ targets, modalities: chosen })
      .then(d => { if (!cancelled) setEst(d); })
      .catch(() => { if (!cancelled) setEst(null); })
      .finally(() => { if (!cancelled) setEstimating(false); });
    return () => { cancelled = true; };
  }, [JSON.stringify(chosen), targets.length]);

  useEffect(() => {
    if (!batch?.batchId || batch.finishedAt) return;
    const t = setInterval(async () => {
      try {
        const s = await api.chatAnalyzer.batch(batch.batchId);
        setBatch(s);
        if (s.finishedAt) { clearInterval(t); showSuccess(`Analysed ${s.ok} conversation(s).`); onDone(); }
      } catch { clearInterval(t); }
    }, 1500);
    return () => clearInterval(t);
  }, [batch?.batchId, batch?.finishedAt]);

  const start = async () => {
    try { setBatch(await api.chatAnalyzer.runBulk({ targets, modalities: chosen })); }
    catch (e) { showError(e.message); }
  };

  return (
    <Modal title={`Analyse ${targets.length} conversation${targets.length === 1 ? '' : 's'}`} onClose={onClose} width={580}
      footer={batch ? <Button onClick={onClose}>Close</Button> : <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={start} disabled={!chosen.length}>Analyse</Button>
      </>}>
      {batch ? (
        <div>
          <div style={{ fontSize: T.lead, fontWeight: W.medium, marginBottom: 12 }}>
            {batch.finishedAt ? 'Finished.' : 'Working…'} {batch.done} of {batch.total}
          </div>
          <div style={{ height: 12, borderRadius: 999, background: 'var(--c-surfaceMuted)', overflow: 'hidden' }}>
            <div style={{
              width: `${batch.total ? (batch.done / batch.total) * 100 : 0}%`, height: '100%',
              background: 'var(--c-primary)', transition: 'width .3s',
            }} />
          </div>
          <div style={{ fontSize: T.body, color: C.textSecondary, marginTop: 14 }}>
            {batch.ok} analysed · {batch.skipped} already up to date · {batch.failed} failed
          </div>
          {!!batch.errors?.length && (
            <ul style={{ fontSize: T.meta, color: 'var(--c-dangerText)', marginTop: 10, paddingLeft: 20 }}>
              {batch.errors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </div>
      ) : (
        <>
          <Field label="Read">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {[['text', 'Text', MessageSquare], ['audio', 'Voice notes', Mic],
                ['image', 'Images', ImageIcon], ['document', 'Documents', FileText]].map(([k, label, Icon]) => (
                <label key={k} style={{
                  display: 'flex', alignItems: 'center', gap: 9, padding: '11px 13px', borderRadius: 10,
                  cursor: 'pointer', fontSize: T.body, fontWeight: W.medium,
                  border: `1px solid ${mods[k] ? 'var(--c-primary)' : C.border}`,
                  background: mods[k] ? 'var(--c-primaryLight)' : 'transparent',
                }}>
                  <input type="checkbox" checked={mods[k]} onChange={e => setMods(m => ({ ...m, [k]: e.target.checked }))}
                    style={{ accentColor: 'var(--c-primary)', width: 17, height: 17 }} />
                  <Icon size={IC.inline} /> {label}
                </label>
              ))}
            </div>
          </Field>

          <div style={{
            border: `1px solid ${C.border}`, borderRadius: 12, padding: 16,
            background: 'var(--c-surfaceInner)', marginTop: 8,
          }}>
            <SectionEyebrow>Estimated cost</SectionEyebrow>
            {estimating ? <Shimmer height={44} /> : !est ? (
              <div style={{ fontSize: T.body, color: C.textMuted }}>Choose what to read.</div>
            ) : (
              <>
                <div style={{ fontFamily: MONO, fontSize: T.h1, fontWeight: W.heavy, color: C.text, lineHeight: LH.tight }}>
                  ₹{est.inr.total.toFixed(2)}
                </div>
                <div style={{ fontSize: T.body, color: C.textSecondary, marginTop: 8, lineHeight: LH.snug }}>
                  {est.conversations} conversation(s) ·{' '}
                  {est.uncached.audio} voice note(s), {est.uncached.image} image(s), {est.uncached.document} document(s) to read
                  {est.cachedItems > 0 && ` · ${est.cachedItems} already read and free`}
                </div>
                {/* Honest about what the number is, rather than presenting a
                    computed figure as a quote. */}
                <div style={{ fontSize: T.meta, color: C.textMuted, marginTop: 10, display: 'flex', gap: 7, lineHeight: LH.normal }}>
                  <Info size={IC.inline} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    An estimate. OpenAI bills by tokens and never returns a price, so this is computed
                    from the rate card in settings, assuming ~{est.assumedAudioSeconds}s per voice note.
                    The real figure appears in Cost once the run finishes.
                  </span>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

// ── cost dashboard ────────────────────────────────────────────────────────────

function CostDashboard() {
  const [data, setData] = useState(null);
  const [range, setRange] = useState('30d');

  useEffect(() => {
    const from = range === 'all' ? null
      : new Date(Date.now() - (range === '7d' ? 7 : range === '30d' ? 30 : 90) * 86400000).toISOString();
    setData(null);
    api.chatAnalyzer.summary(from ? { from } : {}).then(setData).catch(e => { showError(e.message); setData(null); });
  }, [range]);

  if (!data) return <Shimmer height={420} radius={12} />;

  const m = data.byMediaType;
  // One ordered list drives the stacked bar, the legend AND the rows below, so
  // a colour and a share cannot disagree between them.
  const split = [
    { key: 'llm', label: 'Reading the conversation', Icon: MessageSquare, inr: data.cost.llmInr,
      detail: `${(data.tokens / 1000).toFixed(1)}k tokens` },
    { key: 'audio', label: 'Voice notes', Icon: Mic, inr: m.audio.inr,
      detail: `${m.audio.ok} transcribed · ${Math.round((m.audio.audioSeconds || 0) / 60)} min of audio` },
    { key: 'image', label: 'Images', Icon: ImageIcon, inr: m.image.inr,
      detail: `${m.image.ok} read` },
    { key: 'document', label: 'Documents', Icon: FileText, inr: m.document.inr,
      detail: `${m.document.ok} read locally — no API cost` },
  ];
  const total = split.reduce((s, x) => s + x.inr, 0);
  const pct = (v) => (total > 0 ? (v / total) * 100 : 0);
  const maxDaily = Math.max(...(data.daily || []).map(d => d.inr), 0);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <div style={{ width: 210 }}>
          <SearchableSelect value={range} onChange={setRange} options={[
            { value: '7d', label: 'Last 7 days' }, { value: '30d', label: 'Last 30 days' },
            { value: '90d', label: 'Last 90 days' }, { value: 'all', label: 'All time' },
          ]} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 20 }}>
        <BigKpi label="Total spend" value={`₹${data.cost.totalInr.toFixed(2)}`} Icon={IndianRupee}
          sub={`${(data.tokens / 1000).toFixed(1)}k tokens`} accent />
        <BigKpi label="Runs" value={data.runs.total} Icon={ScanSearch}
          sub={`${data.runs.ok} ok · ${data.runs.failed} failed · ${data.runs.skipped} nothing new`} />
        <BigKpi label="Conversations" value={data.runs.conversations} Icon={MessageSquare}
          sub={`${data.runs.incremental} incremental · ${data.runs.scoped} filtered`} />
        <BigKpi label="Media reused free" value={data.artifacts.reused} Icon={Check}
          sub={`${data.artifacts.fresh} newly read and paid for`} />
      </div>

      {/* The estimate caveat, stated once and prominently rather than in a
          footnote nobody reads. */}
      <div style={{
        display: 'flex', gap: 11, padding: '14px 16px', borderRadius: 12, marginBottom: 20,
        background: 'var(--c-infoBg, #EAF2FB)', color: 'var(--c-infoText, #1D4E79)',
        fontSize: T.body, lineHeight: LH.normal,
      }}>
        <Info size={IC.section} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>
          <strong>These figures are estimates.</strong> OpenAI returns token counts, never a price —
          unlike WhatsApp, which reports what each message really cost. Rupees here are tokens and audio
          minutes multiplied by the rate card in settings, at ₹{data.usdToInr}/USD. Update the rate card
          when OpenAI changes its prices, or these numbers will drift.
        </span>
      </div>

      {/* ── the split, shown as proportion first and numbers second ── */}
      <Card title="Where the money goes">
        {total <= 0 ? <EmptyChart text="Nothing has been spent in this period" /> : (
          <>
            <div style={{
              display: 'flex', height: 34, borderRadius: 10, overflow: 'hidden',
              border: `1px solid ${C.border}`, marginBottom: 18,
            }}>
              {split.filter(s => s.inr > 0).map(s => (
                <div key={s.key} title={`${s.label}: ₹${s.inr.toFixed(4)} (${pct(s.inr).toFixed(1)}%)`}
                  style={{
                    width: `${pct(s.inr)}%`, background: COST_COLOURS[s.key],
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#fff', fontSize: T.meta, fontWeight: W.bold, minWidth: 0,
                  }}>
                  {pct(s.inr) >= 12 ? `${pct(s.inr).toFixed(0)}%` : ''}
                </div>
              ))}
            </div>

            {split.map(s => (
              <div key={s.key} style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '14px 0', borderBottom: `1px solid ${C.border}`,
              }}>
                <span style={{
                  width: 38, height: 38, borderRadius: 10, flexShrink: 0,
                  background: `${COST_COLOURS[s.key]}1A`, color: COST_COLOURS[s.key],
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <s.Icon size={IC.section} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: T.body, fontWeight: W.medium, color: C.text }}>{s.label}</div>
                  <div style={{ fontSize: T.meta, color: C.textMuted, marginTop: 2 }}>{s.detail}</div>
                  {/* A per-row bar, so the eye compares rows without doing arithmetic. */}
                  <div style={{ height: 7, borderRadius: 999, background: 'var(--c-surfaceMuted)', marginTop: 8, overflow: 'hidden' }}>
                    <div style={{ width: `${pct(s.inr)}%`, height: '100%', background: COST_COLOURS[s.key] }} />
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontFamily: MONO, fontSize: T.lead, fontWeight: W.bold, color: C.text }}>
                    ₹{s.inr.toFixed(s.inr >= 1 ? 2 : 4)}
                  </div>
                  <div style={{ fontSize: T.meta, color: C.textMuted, fontFamily: MONO }}>
                    {pct(s.inr).toFixed(1)}%
                  </div>
                </div>
              </div>
            ))}

            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
              paddingTop: 16, fontWeight: W.heavy, fontSize: T.lead,
            }}>
              <span>Total</span>
              <span style={{ fontFamily: MONO, fontSize: T.h2 }}>₹{total.toFixed(2)}</span>
            </div>
          </>
        )}
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14, marginTop: 14 }}>
        <Card title="Spend per day">
          {!maxDaily ? <EmptyChart text="No spend recorded yet" /> : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 150, paddingTop: 10 }}>
              {(data.daily || []).slice(-30).map(d => (
                <div key={d.day} title={`${d.day}: ₹${d.inr.toFixed(4)} over ${d.runs} run(s)`}
                  style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', minWidth: 0 }}>
                  <div style={{
                    height: `${Math.max((d.inr / maxDaily) * 100, 3)}%`,
                    background: COST_COLOURS.llm, borderRadius: '4px 4px 0 0', minHeight: 3,
                  }} />
                </div>
              ))}
            </div>
          )}
          {!!maxDaily && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: T.meta, color: C.textMuted, marginTop: 8 }}>
              <span>{(data.daily || [])[0]?.day}</span>
              <span>peak ₹{maxDaily.toFixed(4)}/day</span>
              <span>{(data.daily || [])[(data.daily || []).length - 1]?.day}</span>
            </div>
          )}
        </Card>

        <Card title="Media read">
          <MediaStat label="Voice notes" Icon={Mic} colour={COST_COLOURS.audio} s={m.audio} />
          <MediaStat label="Images" Icon={ImageIcon} colour={COST_COLOURS.image} s={m.image} />
          <MediaStat label="Documents" Icon={FileText} colour={COST_COLOURS.document} s={m.document} />
          <div style={{ fontSize: T.meta, color: C.textMuted, marginTop: 14, lineHeight: LH.normal }}>
            &ldquo;Empty&rdquo; usually means a scanned PDF with no text layer, or a voice note with no
            speech. Those are cached as empty and never re-read, so they cost nothing again.
          </div>
        </Card>

        <Card title="By model">
          {!data.byModel.length ? <EmptyChart text="No runs yet" /> : data.byModel.map(r => (
            <div key={r.model} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '12px 0', borderBottom: `1px solid ${C.border}`,
            }}>
              <Cpu size={IC.row} color={C.textSecondary} style={{ flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: MONO, fontSize: T.body, fontWeight: W.medium, color: C.text }}>{r.model}</div>
                <div style={{ fontSize: T.meta, color: C.textMuted, marginTop: 2 }}>
                  {r.runs} run{r.runs === 1 ? '' : 's'} · {(r.tokens / 1000).toFixed(1)}k tokens
                </div>
              </div>
              <span style={{ fontFamily: MONO, fontSize: T.body, fontWeight: W.bold, color: C.text }}>
                ₹{r.inr.toFixed(r.inr >= 1 ? 2 : 4)}
              </span>
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}

function BigKpi({ label, value, sub, Icon, accent }) {
  return (
    <div style={{
      background: C.cardBg, border: `1px solid ${accent ? 'var(--c-primary)' : C.border}`,
      borderRadius: 14, padding: '18px 20px', minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        {Icon && <Icon size={IC.inline} color={C.textSecondary} />}
        <span style={{
          // T.meta, not T.label: the app's own KpiCard sets uppercase eyebrows
          // at 13px, and a 12px one here reads as a different, smaller system.
          fontSize: T.meta, fontWeight: W.bold, letterSpacing: '.06em',
          textTransform: 'uppercase', color: C.textSecondary, fontFamily: FONT,
        }}>{label}</span>
      </div>
      <div style={{ fontFamily: MONO, fontSize: T.h1, fontWeight: W.heavy, color: C.text, lineHeight: LH.tight }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: T.meta, color: C.textMuted, marginTop: 8, lineHeight: LH.snug }}>{sub}</div>}
    </div>
  );
}

function MediaStat({ label, Icon, s, colour }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0' }}>
      <span style={{
        width: 34, height: 34, borderRadius: 9, flexShrink: 0,
        background: `${colour}1A`, color: colour,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={IC.inline} />
      </span>
      <span style={{ fontSize: T.body, fontWeight: W.medium, flex: 1 }}>{label}</span>
      <span style={{ fontSize: T.meta, color: C.textSecondary, textAlign: 'right' }}>
        <strong style={{ color: C.text, fontFamily: MONO, fontSize: T.body }}>{s.ok}</strong> read
        {s.empty > 0 && ` · ${s.empty} empty`}
        {s.failed > 0 && ` · ${s.failed} failed`}
        {s.skipped > 0 && ` · ${s.skipped} skipped`}
      </span>
    </div>
  );
}

// ── run history ───────────────────────────────────────────────────────────────

function RunHistory({ navigate }) {
  const [runs, setRuns] = useState(null);
  useEffect(() => {
    api.chatAnalyzer.runs({ limit: 100 }).then(d => setRuns(d.runs)).catch(e => { showError(e.message); setRuns([]); });
  }, []);
  if (!runs) return <Shimmer height={340} radius={12} />;
  return (
    <Table
      columns={[{ label: 'When' }, { label: 'Conversation' }, { label: 'Read' }, { label: 'Messages' }, { label: 'Status' }, { label: 'Cost' }]}
      rows={runs} keyOf={r => r.id}
      onRowClick={r => r.conversationKey && navigate('chat-analyzer', 'c', r.source, r.conversationKey)}
      empty={<EmptyState Icon={ScanSearch} title="Nothing has been analysed yet" />}
      renderRow={r => (
        <>
          <Td mono>{new Date(r.startedAt).toLocaleString('en-IN')}</Td>
          <Td>
            <span style={{ fontSize: T.body }}>{r.conversationKey || '—'}</span>
            {r.scoped && <Chip>filtered</Chip>}
            {r.incremental && <Chip>incremental</Chip>}
          </Td>
          <Td>{(r.modalities || []).join(', ') || '—'}</Td>
          <Td mono>{r.messagesAnalysed ?? '—'}</Td>
          <Td color={r.status === 'error' ? 'var(--c-dangerText)' : undefined}>
            {r.status === 'skipped' ? 'nothing new' : r.status}
            {r.error && <div style={{ fontSize: T.meta, color: C.textMuted, lineHeight: LH.snug }}>{r.error}</div>}
          </Td>
          <Td mono>₹{r.costInr.toFixed(4)}</Td>
        </>
      )}
    />
  );
}

function Chip({ children }) {
  return (
    <span style={{
      marginLeft: 8, padding: '3px 8px', borderRadius: 6, fontSize: T.micro, fontWeight: W.bold,
      textTransform: 'uppercase', background: 'var(--c-surfaceMuted)', color: C.textSecondary,
    }}>{children}</span>
  );
}

// ── one conversation ──────────────────────────────────────────────────────────

function ConversationDetail({ source, conversationKey, navigate }) {
  const [meta, setMeta] = useState(null);
  useEffect(() => {
    api.chatAnalyzer.conversation(source, conversationKey)
      .then(d => setMeta(d.conversation)).catch(e => showError(e.message));
  }, [source, conversationKey]);

  return (
    <PageShell heading={meta?.displayName || 'Conversation'}
      subtitle={source === 'community' ? 'WhatsApp group' : meta?.contactNumber
        ? <MaskedNumber number={meta.contactNumber} /> : null}
      actions={<>
        <Button icon={ArrowLeft} onClick={() => navigate('chat-analyzer')}>Back</Button>
        {source === 'chat' && meta?.waNumber && meta?.contactNumber && (
          <Button icon={MessageSquare} onClick={() => navigate('chats', meta.waNumber, meta.contactNumber)}>
            Open chat
          </Button>
        )}
      </>}
    >
      <ChatAnalyzerPanel source={source} conversationKey={conversationKey} />
    </PageShell>
  );
}

// ── settings, in the tab ──────────────────────────────────────────────────────

/**
 * Voice notes transcribed by an OLDER model (Whisper, before 2026-09-23) keep
 * their text until someone asks for a redo. This redoes all of them with the
 * current model, cost shown first, in batches of `max_media_per_run`. A note is
 * only replaced when the new transcript succeeds.
 */
function OlderTranscripts() {
  const [sum, setSum] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [run, setRun] = useState(null);           // {replaced, failed[], costInr, remaining} while/after running
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.chatAnalyzer.legacyTranscripts().then(setSum).catch(() => setSum({ count: 0, error: true }));
  }, []);
  useEffect(() => { load(); }, [load]);

  const start = async () => {
    setConfirm(false); setBusy(true);
    const acc = { replaced: 0, failed: [], costInr: 0, remaining: sum.count };
    setRun({ ...acc });
    try {
      for (let i = 0; i < 100; i++) {
        const r = await api.chatAnalyzer.retranscribeLegacyBatch();
        acc.replaced += r.replaced; acc.failed.push(...r.failed); acc.costInr += r.costInr; acc.remaining = r.remaining;
        setRun({ ...acc });
        if (!r.remaining || (r.replaced === 0 && r.failed.length === 0)) break;
      }
      showSuccess(`Re-transcribed ${acc.replaced} voice note(s) for ₹${acc.costInr.toFixed(2)}.`
        + (acc.failed.length ? ` ${acc.failed.length} kept their old transcript (the new model could not read them).` : ''));
    } catch (e) { showError(e.message); }
    finally { setBusy(false); load(); }
  };

  if (!sum) return <Shimmer height={48} />;
  if (sum.error) return null;
  return (
    <div data-testid="older-transcripts" style={{ fontSize: T.meta, color: C.textSecondary, lineHeight: LH.normal }}>
      {sum.count === 0 && !run ? (
        <div>Every stored transcript was made with {sum.model || 'the current model'}.</div>
      ) : (
        <>
          <div>
            <strong style={{ color: C.text }}>{sum.count}</strong> voice note{sum.count === 1 ? '' : 's'} still have a transcript
            from an older model ({(sum.models || []).join(', ') || 'Whisper'}) — about {Math.round((sum.seconds || 0) / 60)} min of audio.
            Redoing {sum.count === 1 ? 'it' : 'them'} with MAI-Transcribe 2 is estimated at <strong style={{ color: C.text }}>₹{Number(sum.estimate?.inr || 0).toFixed(2)}</strong>.
            A transcript is replaced only when the new one succeeds.
          </div>
          {run && (
            <div data-testid="older-transcripts-progress" style={{ marginTop: 6, color: C.text }}>
              {busy ? 'Working… ' : 'Done: '}{run.replaced} replaced{run.failed.length ? `, ${run.failed.length} kept (unreadable)` : ''}
              {' · '}₹{run.costInr.toFixed(2)} spent{busy && run.remaining ? ` · ${run.remaining} to go` : ''}
            </div>
          )}
          {sum.count > 0 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              {confirm ? (
                <>
                  <Button variant="primary" onClick={start}>Yes, re-transcribe {sum.count} (~₹{Number(sum.estimate?.inr || 0).toFixed(2)})</Button>
                  <Button onClick={() => setConfirm(false)}>Cancel</Button>
                </>
              ) : (
                <Button onClick={() => setConfirm(true)} disabled={busy}>
                  {busy ? 'Re-transcribing…' : `Re-transcribe ${sum.count} older note${sum.count === 1 ? '' : 's'}`}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SettingsModal({ onClose }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [rateText, setRateText] = useState('');
  const [rateError, setRateError] = useState('');

  useEffect(() => {
    api.chatAnalyzer.config.get()
      .then(d => { setData(d); setForm(d.config); setRateText(JSON.stringify(d.config.rate_card, null, 2)); })
      .catch(e => { showError(e.message); onClose(); });
  }, [onClose]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    let rate_card;
    try {
      rate_card = JSON.parse(rateText);
      if (!rate_card || typeof rate_card !== 'object' || Array.isArray(rate_card)) throw new Error('must be an object');
      setRateError('');
    } catch (e) {
      setRateError(`The rate card is not valid JSON: ${e.message}`);
      return;
    }
    setSaving(true);
    try {
      await api.chatAnalyzer.config.update({ ...form, rate_card });
      showSuccess('Settings saved.');
      onClose();
    } catch (e) { showError(e.message); } finally { setSaving(false); }
  };

  if (!data) return <Modal title="Chat Analyzer settings" onClose={onClose} width={640}><Shimmer height={320} /></Modal>;

  const compatible = (data.models || []).filter(m => m.compatible);
  const incompatible = (data.models || []).filter(m => !m.compatible);

  return (
    <Modal title="Chat Analyzer settings" onClose={onClose} width={640}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button></>}>

      {!compatible.length && (
        <Banner tone="danger">
          No OpenAI-compatible AI model is connected, so nothing can be analysed. Add an OpenAI key in
          Admin Settings → AI Models.
          {incompatible.length > 0 && ` (${incompatible.map(m => m.provider).join(', ')} cannot be used — the analyser speaks the OpenAI API format.)`}
        </Banner>
      )}

      <Toggle label="Chat Analyzer is on" checked={!!form.enabled} onChange={v => set('enabled', v)}
        hint="Turn off to stop every run, including anything triggered from Claude." />

      <Field label="Analysis account" hint="Which connected AI account runs the analysis.">
        <SearchableSelect value={form.credential_id ?? ''} onChange={v => setForm(f => ({ ...f, credential_id: v === '' ? null : Number(v), model_id: null }))}
          placeholder="Auto — the cheapest connected model"
          options={[{ value: '', label: 'Auto — the cheapest connected model' },
            ...compatible.map(m => ({ value: m.credentialId, label: `${m.provider} · ${m.label}` }))]} />
      </Field>
      {form.credential_id != null && (() => {
        const cred = compatible.find(m => m.credentialId === form.credential_id);
        const models = cred?.models || [];
        return (
          <Field label="Model"
            hint="A mini model is ~₹0.07 per analysis. A larger model (e.g. gpt-5) follows your business context much more closely — real product details, no invented answers — but costs ~₹2 and takes about a minute. Enable more models in Admin Settings → AI Models.">
            <SearchableSelect value={form.model_id ?? ''} onChange={v => set('model_id', v === '' ? null : v)}
              placeholder="Auto — the cheapest enabled model"
              options={[{ value: '', label: 'Auto — the cheapest enabled model' }, ...models.map(id => ({ value: id, label: id }))]} />
          </Field>
        );
      })()}

      <SectionHead>What it reads by default</SectionHead>
      <div style={{ fontSize: T.meta, color: C.textSecondary, marginBottom: 12, lineHeight: LH.normal }}>
        These are only the defaults — every run can override them. Media is billed per item, which is why
        the three media switches start off.
      </div>
      <Toggle label="Text" checked={!!form.analyse_text} onChange={v => set('analyse_text', v)} />
      <Toggle label="Voice notes (transcribed with MAI-Transcribe 2 via OpenRouter)" checked={!!form.analyse_audio} onChange={v => set('analyse_audio', v)}
        hint="Each note is transcribed once and reused free afterwards." />
      <Toggle label="Images (read with a vision model)" checked={!!form.analyse_images} onChange={v => set('analyse_images', v)} />
      <Toggle label="Documents (PDF text)" checked={!!form.analyse_documents} onChange={v => set('analyse_documents', v)}
        hint="Scanned PDFs have no text layer and will come back empty." />

      <SectionHead>Older voice-note transcripts</SectionHead>
      <OlderTranscripts />

      <SectionHead>Limits</SectionHead>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <NumField label="Media items per run" value={form.max_media_per_run} onChange={v => set('max_media_per_run', v)}
          hint="Caps what one run can spend on media." />
        <NumField label="Longest voice note (seconds)" value={form.max_audio_seconds} onChange={v => set('max_audio_seconds', v)}
          hint="Measured before transcribing." />
        <NumField label="Characters kept per document" value={form.max_document_chars} onChange={v => set('max_document_chars', v)} />
        <NumField label="Conversations per bulk run" value={form.bulk_max} onChange={v => set('bulk_max', v)} />
        <NumField label="Minimum messages to list a chat" value={form.min_messages} onChange={v => set('min_messages', v)} />
        <NumField label="Messages per transcript" value={form.transcript_message_cap} onChange={v => set('transcript_message_cap', v)} />
      </div>

      <SectionHead>Cost estimation</SectionHead>
      <div style={{ fontSize: T.meta, color: C.textSecondary, marginBottom: 12, lineHeight: LH.normal }}>
        OpenAI returns token counts but never a price, so every rupee figure in this feature is computed
        from the rates below. <strong>Update them when OpenAI changes its pricing</strong>, or the Cost tab
        will quietly drift. Token rates are USD per 1M tokens; audio is USD per minute.
      </div>
      <NumField label="Rupees per USD" value={form.usd_to_inr} onChange={v => set('usd_to_inr', v)} step="0.01" />
      <Field label="Rate card">
        <textarea value={rateText} onChange={e => setRateText(e.target.value)} rows={10}
          style={{ ...inputStyle, fontFamily: MONO, fontSize: T.meta, resize: 'vertical', lineHeight: LH.snug }} />
      </Field>
      {rateError && <Banner tone="danger">{rateError}</Banner>}
    </Modal>
  );
}

function SectionEyebrow({ children }) {
  return (
    <div style={{
      fontSize: T.meta, fontWeight: W.bold, textTransform: 'uppercase', letterSpacing: '.06em',
      color: C.textSecondary, marginBottom: 10,
    }}>{children}</div>
  );
}

function SectionHead({ children }) {
  return (
    <div style={{
      fontSize: T.meta, fontWeight: W.bold, textTransform: 'uppercase', letterSpacing: '.05em',
      color: C.textSecondary, margin: '22px 0 10px', paddingTop: 16, borderTop: `1px solid ${C.border}`,
    }}>{children}</div>
  );
}

function Toggle({ label, checked, onChange, hint }) {
  return (
    <label style={{ display: 'flex', gap: 11, alignItems: 'flex-start', padding: '9px 0', cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
        style={{ accentColor: 'var(--c-primary)', marginTop: 2, width: 17, height: 17 }} />
      <span>
        <span style={{ fontSize: T.body, fontWeight: W.medium, color: C.text }}>{label}</span>
        {hint && <span style={{ display: 'block', fontSize: T.meta, color: C.textMuted, marginTop: 2, lineHeight: LH.snug }}>{hint}</span>}
      </span>
    </label>
  );
}

function NumField({ label, value, onChange, hint, step }) {
  return (
    <Field label={label} hint={hint}>
      <input type="number" step={step || '1'} value={value ?? ''} onChange={e => onChange(e.target.value)}
        style={{ ...inputStyle, fontSize: T.body }} />
    </Field>
  );
}

function Banner({ tone, children }) {
  const bg = tone === 'danger' ? 'var(--c-dangerBg)' : 'var(--c-infoBg, #EAF2FB)';
  const fg = tone === 'danger' ? 'var(--c-dangerText)' : 'var(--c-infoText, #1D4E79)';
  return (
    <div style={{ padding: '12px 14px', borderRadius: 10, background: bg, color: fg, fontSize: T.body, lineHeight: LH.normal, marginBottom: 12 }}>
      {children}
    </div>
  );
}
