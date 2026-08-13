import { useState, useEffect, useRef } from 'react';
import { Upload, FileSpreadsheet, X, Loader2, Download, CheckCircle2, AlertCircle } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import { Button } from '../academy/shared.jsx';

/**
 * Bulk-load people from a sheet, as LEADS.
 *
 * This replaces the importer that lived on the Contacts page. The difference is
 * the point of the change: that one created `contacts`, which only became leads
 * if those people later messaged in — so an imported list was invisible to the
 * funnel until it acted. These rows go straight into `leads`, matched on the last
 * ten digits, so an import lands in the funnel immediately.
 *
 * Existing leads are UPDATED, never overwritten: the server fills blank fields
 * only, so re-importing a corrected sheet is safe and a name a human typed is
 * never replaced by one from a spreadsheet.
 */
export default function LeadImportModal({ open, onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  // Reset on each open so a previous run's summary never reads as this one's.
  useEffect(() => {
    if (open) { setFile(null); setSource(''); setResult(null); setError(''); setDragging(false); }
  }, [open]);

  // Ctrl+V paste, alongside the picker and drag-drop — every file input in this
  // app supports all three in the same change.
  useEffect(() => {
    if (!open) return;
    const onPaste = (e) => {
      const f = e.clipboardData?.files?.[0];
      if (f) { setFile(f); setError(''); setResult(null); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [open]);

  if (!open) return null;

  const accept = '.csv,.xlsx,.xls';
  const take = (f) => {
    if (!f) return;
    if (!/\.(csv|xlsx|xls)$/i.test(f.name)) {
      setError('Upload a .csv or .xlsx sheet.');
      return;
    }
    setError(''); setResult(null); setFile(f);
  };

  const submit = async () => {
    if (!file) return;
    setBusy(true); setError(''); setResult(null);
    try {
      const res = await api.leads.import(file, source.trim() || undefined);
      setResult(res);
      // Refresh the table underneath even on a partial import — some rows landed.
      if ((res.imported || 0) + (res.updated || 0) > 0 && onImported) onImported();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'var(--c-overlay, rgba(0,0,0,.38))',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: 20,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.cardBg, borderRadius: 14, boxShadow: C.shadowLg, width: '100%', maxWidth: 520,
        maxHeight: '90vh', overflowY: 'auto', fontFamily: FONT, boxSizing: 'border-box',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Import leads</div>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted, display: 'flex', padding: 4 }}>
            <X size={17} />
          </button>
        </div>

        <div style={{ padding: 20 }}>
          {result ? (
            <ImportSummary result={result} />
          ) : (
            <>
              <div style={{ fontSize: 14, color: C.textSecondary, lineHeight: 1.6, marginBottom: 14 }}>
                Upload a <strong>.csv</strong> or <strong>.xlsx</strong> with one person per row. Only the
                WhatsApp number is required — Name, Email, City and Source are used when present. Someone
                already in your leads is updated rather than duplicated, and only their blank fields are filled.
              </div>

              <a href={api.leads.importTemplateUrl()} download style={{ textDecoration: 'none' }}>
                <Button variant="secondary" icon={Download}>Download a sample sheet</Button>
              </a>

              <div
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={e => { e.preventDefault(); setDragging(false); take(e.dataTransfer.files?.[0]); }}
                onClick={() => inputRef.current?.click()}
                style={{
                  marginTop: 14, padding: '22px 16px', borderRadius: 10, cursor: 'pointer', textAlign: 'center',
                  border: `1.5px dashed ${dragging ? C.primary : C.border}`,
                  background: dragging ? 'var(--c-dangerBgSoft, #FEF1F1)' : 'var(--c-surfaceAlt)',
                }}>
                <input ref={inputRef} type="file" accept={accept} style={{ display: 'none' }}
                  onChange={e => take(e.target.files?.[0])} />
                {file ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9 }}>
                    <FileSpreadsheet size={17} color={C.green} />
                    <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{file.name}</span>
                    <span style={{ fontSize: 13, color: C.textMuted, fontFamily: MONO }}>
                      {(file.size / 1024).toFixed(0)} KB
                    </span>
                  </div>
                ) : (
                  <>
                    <Upload size={20} color={C.textMuted} />
                    <div style={{ fontSize: 15, color: C.text, fontWeight: 600, marginTop: 7 }}>
                      Click to choose a file
                    </div>
                    <div style={{ fontSize: 13, color: C.textMuted, marginTop: 3 }}>
                      …or drag it here, or paste with Ctrl+V
                    </div>
                  </>
                )}
              </div>

              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
                  Source for these leads (optional)
                </div>
                <input
                  value={source}
                  onChange={e => setSource(e.target.value)}
                  placeholder="e.g. Trade show list — used only where a row has no Source of its own"
                  style={{
                    width: '100%', padding: '9px 11px', borderRadius: 8, border: `1.5px solid ${C.border}`,
                    fontFamily: FONT, fontSize: 15, outline: 'none', background: C.cardBg, color: C.text,
                    boxSizing: 'border-box',
                  }} />
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 5, lineHeight: 1.5 }}>
                  Leave blank and rows without a Source are recorded as “Imported”, so they can still be told
                  apart in the funnel.
                </div>
              </div>

              {error && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, padding: '9px 12px', borderRadius: 8,
                  background: 'var(--c-dangerBg, #FCEBEB)', color: 'var(--c-dangerText, #A32D2D)',
                  border: '1px solid var(--c-dangerBorder, #FBC8C8)', fontSize: 14 }}>
                  <AlertCircle size={14} /> {error}
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, padding: '14px 20px', borderTop: `1px solid ${C.border}` }}>
          <Button variant="secondary" onClick={onClose}>{result ? 'Done' : 'Cancel'}</Button>
          {!result && (
            <Button onClick={submit} disabled={!file || busy} icon={busy ? Loader2 : Upload}>
              {busy ? 'Importing…' : 'Import'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function ImportSummary({ result }) {
  const { imported = 0, updated = 0, skipped = [], total = 0 } = result || {};
  const landed = imported + updated;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
        {landed > 0
          ? <CheckCircle2 size={19} color={C.green} />
          : <AlertCircle size={19} color="var(--c-sb45309, #B45309)" />}
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
          {landed > 0 ? `${landed} of ${total} row(s) landed` : 'Nothing was imported'}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <Stat label="Added" value={imported} tone={C.green} />
        <Stat label="Updated" value={updated} tone={C.text} />
        <Stat label="Skipped" value={skipped.length} tone={skipped.length ? C.primary : C.textMuted} />
      </div>

      {skipped.length > 0 && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
            Skipped rows — every one says why
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 8 }}>
            {skipped.map((sk, i) => (
              <div key={i} style={{
                display: 'flex', gap: 10, padding: '7px 10px', fontSize: 14,
                borderTop: i ? `1px solid ${C.border}` : 'none',
              }}>
                <span style={{ fontFamily: MONO, color: C.textMuted, flexShrink: 0 }}>Row {sk.row}</span>
                <span style={{ color: C.textSecondary }}>{sk.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div style={{ flex: '1 1 100px', padding: '10px 12px', borderRadius: 9, border: `1px solid ${C.border}`, background: 'var(--c-surfaceAlt)' }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: tone, fontFamily: MONO }}>{value}</div>
      <div style={{ fontSize: 13, color: C.textMuted, marginTop: 1 }}>{label}</div>
    </div>
  );
}
