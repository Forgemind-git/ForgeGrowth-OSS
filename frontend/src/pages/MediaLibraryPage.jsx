import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Upload, Image as ImageIcon, Video, FileText, Music, RefreshCw,
  Trash2, Copy, CheckCircle2, AlertTriangle, Clock, Power,
} from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO, maskPhone } from '../constants.js';

const TYPE_META = {
  image:    { Icon: ImageIcon, label: 'Image',    color: 'var(--c-s3b82f6, #3B82F6)' },
  video:    { Icon: Video,     label: 'Video',    color: 'var(--c-s8b5cf6, #8B5CF6)' },
  audio:    { Icon: Music,     label: 'Audio',    color: '#10B981' },
  document: { Icon: FileText,  label: 'Document', color: '#F59E0B' },
};

const STATUS_META = {
  pending: { label: 'Not synced',   bg: 'var(--c-surfaceMuted, #F3F4F6)', fg: 'var(--c-textSecondary, #6B7280)' },
  syncing: { label: 'Syncing…',     bg: 'var(--c-infoBg, #EFF6FF)', fg: 'var(--c-s3b82f6, #3B82F6)' },
  synced:  { label: 'Synced',       bg: 'var(--c-successBgSoft, #ECFDF5)', fg: 'var(--c-successBright, #059669)' },
  failed:  { label: 'Failed',       bg: 'var(--c-dangerBgSoft, #FEF2F2)', fg: 'var(--c-primary, #DC2626)' },
  expired: { label: 'Expired',      bg: 'var(--c-sfef3c7, #FEF3C7)', fg: 'var(--c-sb45309, #B45309)' },
};

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function daysUntil(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.round(ms / (24 * 3600 * 1000));
}

export default function MediaLibraryPage() {
  const [media, setMedia] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [previewMedia, setPreviewMedia] = useState(null);
  const [replaceMedia, setReplaceMedia] = useState(null);
  const [syncingKey, setSyncingKey] = useState(null);  // `${mediaId}:${accountId}`
  const [toast, setToast] = useState(null);

  const showToast = (msg, kind = 'info') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 3500);
  };

  const load = async () => {
    setLoading(true);
    try {
      const [mRes, aRes] = await Promise.all([
        api.mediaLibrary.list(),
        api.whatsappAccounts.list(),
      ]);
      setMedia(mRes.media || []);
      setAccounts(aRes.accounts || aRes || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleSync = async (mediaId, accountId) => {
    const key = `${mediaId}:${accountId}`;
    setSyncingKey(key);
    try {
      await api.mediaLibrary.sync(mediaId, accountId);
      showToast('Synced to Meta', 'ok');
      await load();
    } catch (err) {
      showToast(`Sync failed: ${err.message}`, 'err');
    } finally {
      setSyncingKey(null);
    }
  };

  const handleToggleAutoResync = async (m) => {
    try {
      await api.mediaLibrary.update(m.id, { autoResync: !m.autoResync });
      await load();
    } catch (err) { showToast(err.message, 'err'); }
  };

  const handleDelete = async (m) => {
    const displayName = m.name || m.originalName;
    if (!window.confirm(`Delete "${displayName}"? Synced Meta IDs will also be invalidated.`)) return;
    try {
      await api.mediaLibrary.delete(m.id);
      showToast('Deleted', 'ok');
      await load();
    } catch (err) { showToast(err.message, 'err'); }
  };

  const handleCopy = (text) => {
    navigator.clipboard.writeText(text);
    showToast('Copied to clipboard', 'ok');
  };

  const handleReplaced = async ({ resync = [] } = {}) => {
    setReplaceMedia(null);
    await load();
    const failed = resync.filter(r => !r.ok).length;
    const plural = (n) => `WhatsApp number${n === 1 ? '' : 's'}`;
    if (failed) {
      showToast(`Replaced. Re-sync failed on ${failed} ${plural(failed)}; the next send uploads it again.`, 'err');
    } else if (resync.length) {
      showToast(`Replaced and re-synced to ${resync.length} ${plural(resync.length)}`, 'ok');
    } else {
      showToast('Replaced', 'ok');
    }
  };

  return (
    <div style={{ padding: 24, fontFamily: FONT, color: C.text, maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 20 }}>
        <div>
          <p style={{ fontSize: 15, color: C.textSecondary, margin: '6px 0 0' }}>
            Upload media once, sync to each WhatsApp account on demand. Meta media IDs expire after 28 days —
            toggle <strong>Auto-resync</strong> to keep them fresh.
          </p>
        </div>
        <button
          onClick={() => setUploadOpen(true)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '10px 16px', background: C.primary, color: '#fff',
            border: 'none', borderRadius: 8, fontFamily: FONT, fontWeight: 600,
            fontSize: 15, cursor: 'pointer',
          }}
        >
          <Upload size={15} /> Upload Media
        </button>
      </div>

      {error && (
        <div style={{ padding: 12, background: 'var(--c-dangerBgSoft, #FEF2F2)', color: 'var(--c-dangerStrong, #991B1B)', borderRadius: 8, marginBottom: 16, fontSize: 15 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 60, textAlign: 'center', color: C.textMuted }}>Loading…</div>
      ) : media.length === 0 ? (
        <EmptyState onUpload={() => setUploadOpen(true)} />
      ) : (
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
          {media.map((m, idx) => (
            <MediaRow
              key={m.id}
              media={m}
              accounts={accounts}
              syncingKey={syncingKey}
              isLast={idx === media.length - 1}
              onSync={handleSync}
              onToggleAutoResync={() => handleToggleAutoResync(m)}
              onDelete={() => handleDelete(m)}
              onReplace={() => setReplaceMedia(m)}
              onCopy={handleCopy}
              onPreview={() => setPreviewMedia(m)}
            />
          ))}
        </div>
      )}

      {uploadOpen && (
        <UploadModal
          onClose={() => setUploadOpen(false)}
          onUploaded={async () => { setUploadOpen(false); await load(); showToast('Uploaded', 'ok'); }}
          onError={(msg) => showToast(msg, 'err')}
        />
      )}

      {previewMedia && (
        <PreviewModal media={previewMedia} onClose={() => setPreviewMedia(null)}
          onSaved={async (m) => { setPreviewMedia(m); await load(); showToast('Description saved', 'ok'); }}
          onError={(msg) => showToast(msg, 'err')} />
      )}

      {replaceMedia && (
        <ReplaceModal
          media={replaceMedia}
          onClose={() => setReplaceMedia(null)}
          onReplaced={handleReplaced}
        />
      )}

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, padding: '10px 16px',
          background: toast.kind === 'err' ? '#991B1B' : toast.kind === 'ok' ? '#065F46' : '#111',
          color: '#fff', borderRadius: 8, fontSize: 15, fontWeight: 600,
          boxShadow: C.shadowLg, zIndex: 1000,
        }}>{toast.msg}</div>
      )}
    </div>
  );
}

function MediaRow({ media, accounts, syncingKey, isLast, onSync, onToggleAutoResync, onDelete, onReplace, onCopy, onPreview }) {
  const meta = TYPE_META[media.mediaType] || TYPE_META.document;
  const Icon = meta.Icon;
  // Auto-expand any row that has at least one synced/failed/expired WABA so
  // the meta_media_id + expiry are immediately visible without an extra click.
  const hasAnySync = media.syncs.some(s => s.status !== 'pending');
  const [expanded, setExpanded] = useState(hasAnySync);
  const syncedCount = media.syncs.filter(s => s.status === 'synced').length;
  const nearestExpiry = media.syncs
    .filter(s => s.status === 'synced' && s.expiresAt)
    .map(s => daysUntil(s.expiresAt))
    .sort((a, b) => a - b)[0];

  return (
    <div style={{ borderBottom: isLast ? 'none' : `1px solid ${C.border}` }}>
      {/* Top row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 18px' }}>
        <div style={{
          width: 44, height: 44, borderRadius: 8, background: `${meta.color}18`,
          color: meta.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          overflow: 'hidden', position: 'relative',
        }}>
          {media.mediaType === 'image' ? (
            <img
              src={api.mediaLibrary.downloadUrl(media.id, media.sha256)}
              alt={media.originalName}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : media.mediaType === 'video' ? (
            <video
              src={api.mediaLibrary.downloadUrl(media.id, media.sha256)}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              preload="metadata"
              muted
            />
          ) : (
            <Icon size={20} />
          )}
          {media.mediaType === 'video' && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none',
            }}>
              <div style={{
                width: 18, height: 18, borderRadius: '50%', background: 'rgba(0,0,0,.5)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <div style={{
                  width: 0, height: 0, borderStyle: 'solid', borderWidth: '4px 0 4px 6px',
                  borderColor: 'transparent transparent transparent #fff', marginLeft: 2,
                }} />
              </div>
            </div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            onClick={onPreview}
            title={media.name || media.originalName}
            style={{
              fontWeight: 600, fontSize: 15, marginBottom: 2,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              color: C.primary, cursor: 'pointer', textDecoration: 'underline',
              textUnderlineOffset: 2,
            }}
          >
            {media.name || media.originalName}
          </div>
          <div style={{ fontSize: 14, color: C.textSecondary, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>{meta.label}</span>
            <span>•</span>
            <span>{fmtBytes(media.sizeBytes)}</span>
            <span>•</span>
            <span>Uploaded {fmtDate(media.uploadedAt)}</span>
            {syncedCount > 0 && (
              <>
                <span>•</span>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 8px', borderRadius: 4,
                  background: 'var(--c-successBgSoft, #ECFDF5)', color: 'var(--c-successBright, #059669)', fontWeight: 600,
                }}>
                  <CheckCircle2 size={11} />
                  Synced to {syncedCount}/{accounts.length} WABA{accounts.length > 1 ? 's' : ''}
                  {nearestExpiry !== undefined && (
                    <span style={{ color: nearestExpiry < 3 ? 'var(--c-sb45309, #B45309)' : '#059669' }}>
                      &nbsp;· next expires in {nearestExpiry}d
                    </span>
                  )}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Auto-resync toggle */}
        <button
          onClick={onToggleAutoResync}
          title={media.autoResync ? 'Disable auto-resync' : 'Enable auto-resync (refresh ~24h before expiry)'}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 12px', borderRadius: 6,
            background: media.autoResync ? 'var(--c-secfdf5, #ECFDF5)' : 'var(--c-hover)',
            color: media.autoResync ? 'var(--c-s059669, #059669)' : 'var(--c-textSecondary, #6B7280)',
            border: '1px solid transparent',
            cursor: 'pointer', fontFamily: FONT, fontSize: 14, fontWeight: 600,
          }}
        >
          <Power size={13} /> Auto-resync {media.autoResync ? 'ON' : 'OFF'}
        </button>

        <button
          onClick={() => setExpanded(e => !e)}
          style={{
            padding: '7px 12px', borderRadius: 6, background: 'var(--c-cardBg)',
            border: `1px solid ${C.border}`, cursor: 'pointer',
            fontFamily: FONT, fontSize: 14, fontWeight: 600, color: C.text,
          }}
        >
          {expanded ? 'Hide' : 'Show'} sync ({media.syncs.length}/{accounts.length})
        </button>

        <button
          onClick={onReplace}
          title="Swap in a new file — everything that uses this item sends the new one"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 12px', borderRadius: 6, background: 'var(--c-cardBg)',
            border: `1px solid ${C.border}`, cursor: 'pointer',
            fontFamily: FONT, fontSize: 14, fontWeight: 600, color: C.text,
          }}
        >
          <Upload size={13} /> Replace
        </button>

        <button
          onClick={onDelete}
          title="Delete"
          style={{
            padding: 8, borderRadius: 6, background: 'var(--c-cardBg)',
            border: `1px solid ${C.border}`, cursor: 'pointer', color: 'var(--c-dangerStrong, #991B1B)',
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* Sync grid */}
      {expanded && (
        <div style={{ padding: '0 18px 18px 78px', background: 'var(--c-surfaceInner, #FAFAF8)' }}>
          {accounts.length === 0 ? (
            <div style={{ padding: 12, color: C.textMuted, fontSize: 15 }}>
              No WhatsApp accounts configured. Add one under Admin Settings → WhatsApp Accounts.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: C.textSecondary, fontSize: 13, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                  <th style={{ padding: '10px 8px', fontWeight: 600 }}>WhatsApp Account</th>
                  <th style={{ padding: '10px 8px', fontWeight: 600 }}>Status</th>
                  <th style={{ padding: '10px 8px', fontWeight: 600 }}>Meta Media ID</th>
                  <th style={{ padding: '10px 8px', fontWeight: 600 }}>Expires</th>
                  <th style={{ padding: '10px 8px', fontWeight: 600, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map(acc => {
                  // accounts come back with id as string (BIGINT), syncs with accountId as number (INT)
                  // — normalize both to Number for the join.
                  const sync = media.syncs.find(s => Number(s.accountId) === Number(acc.id)) || { status: 'pending' };
                  const key = `${media.id}:${acc.id}`;
                  const isSyncing = syncingKey === key;
                  const s = STATUS_META[sync.status] || STATUS_META.pending;
                  const days = daysUntil(sync.expiresAt);
                  return (
                    <tr key={acc.id} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td style={{ padding: '10px 8px' }}>
                        <div style={{ fontWeight: 600 }}>{acc.displayName || acc.display_name || maskPhone(acc.display_phone_number || acc.displayPhoneNumber) || '—'}</div>
                        <div style={{ fontSize: 13, color: C.textMuted }}>
                          {maskPhone(acc.display_phone_number || acc.displayPhoneNumber) || ''}
                        </div>
                      </td>
                      <td style={{ padding: '10px 8px' }}>
                        <span style={{
                          display: 'inline-block', padding: '3px 8px', borderRadius: 4,
                          background: s.bg, color: s.fg, fontSize: 13, fontWeight: 600,
                        }}>{s.label}</span>
                        {sync.lastError && (
                          <div style={{ marginTop: 4, fontSize: 13, color: 'var(--c-dangerStrong, #991B1B)' }} title={sync.lastError}>
                            <AlertTriangle size={11} style={{ verticalAlign: '-2px' }} /> {sync.lastError.slice(0, 60)}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '10px 8px', fontFamily: MONO, fontSize: 14 }}>
                        {sync.metaMediaId ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            {sync.metaMediaId.length > 18 ? sync.metaMediaId.slice(0, 16) + '…' : sync.metaMediaId}
                            <button
                              onClick={() => onCopy(sync.metaMediaId)}
                              title="Copy media ID"
                              style={{ padding: 3, border: 'none', background: 'transparent', cursor: 'pointer', color: C.textSecondary }}
                            >
                              <Copy size={11} />
                            </button>
                          </span>
                        ) : <span style={{ color: C.textMuted }}>—</span>}
                      </td>
                      <td style={{ padding: '10px 8px' }}>
                        {sync.expiresAt ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <Clock size={11} style={{ color: days < 1 ? '#DC2626' : days < 3 ? 'var(--c-sb45309, #B45309)' : C.textMuted }} />
                            <span style={{ color: days < 1 ? 'var(--c-primary, #DC2626)' : C.text }}>
                              {days < 0 ? `${-days}d ago` : `in ${days}d`}
                            </span>
                          </span>
                        ) : <span style={{ color: C.textMuted }}>—</span>}
                      </td>
                      <td style={{ padding: '10px 8px', textAlign: 'right' }}>
                        <button
                          onClick={() => onSync(media.id, acc.id)}
                          disabled={isSyncing}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                            padding: '6px 12px', borderRadius: 6,
                            background: sync.status === 'synced' ? 'var(--c-cardBg)' : C.primary,
                            color: sync.status === 'synced' ? C.text : '#fff',
                            border: sync.status === 'synced' ? `1px solid ${C.border}` : 'none',
                            cursor: isSyncing ? 'wait' : 'pointer',
                            fontFamily: FONT, fontSize: 14, fontWeight: 600,
                            opacity: isSyncing ? 0.6 : 1,
                          }}
                        >
                          <RefreshCw size={12} className={isSyncing ? 'spin' : ''} />
                          {isSyncing ? 'Syncing…' : sync.status === 'synced' ? 'Re-sync' : 'Sync to Meta'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onUpload }) {
  return (
    <div style={{
      background: C.cardBg, border: `1px dashed ${C.border}`, borderRadius: 12,
      padding: 60, textAlign: 'center',
    }}>
      <ImageIcon size={36} style={{ color: C.textMuted, marginBottom: 12 }} />
      <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 6 }}>No media yet</div>
      <div style={{ fontSize: 15, color: C.textSecondary, marginBottom: 18 }}>
        Upload images, videos, audio or documents. Sync to Meta when you're ready to use them in chats or broadcasts.
      </div>
      <button
        onClick={onUpload}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '10px 18px', background: C.primary, color: '#fff',
          border: 'none', borderRadius: 8, fontFamily: FONT, fontWeight: 600,
          fontSize: 15, cursor: 'pointer',
        }}
      >
        <Upload size={15} /> Upload your first media
      </button>
    </div>
  );
}

function UploadModal({ onClose, onUploaded, onError }) {
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef(null);

  const handleFileChange = (f) => {
    setFile(f);
    if (f) {
      // Pre-fill name from filename without extension
      const base = f.name.replace(/\.[^/.]+$/, '');
      setName(base);
    } else {
      setName('');
    }
  };

  const submit = async () => {
    if (!file) return;
    setUploading(true);
    try {
      await api.mediaLibrary.upload(file, name || null, notes || null);
      await onUploaded();
    } catch (err) {
      onError(err.message);
      setUploading(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--c-cardBg)', borderRadius: 12, padding: 24, width: 480,
          boxShadow: C.shadowLg,
        }}
      >
        <h2 style={{ margin: '0 0 16px', fontSize: 20, fontWeight: 700 }}>Upload Media</h2>

        <div
          onClick={() => inputRef.current?.click()}
          style={{
            border: `2px dashed ${file ? C.primary : C.border}`,
            borderRadius: 8, padding: 28, textAlign: 'center', cursor: 'pointer',
            background: file ? 'var(--c-selectedTint, #FFF7F7)' : 'var(--c-surfaceInner, #FAFAF8)',
          }}
        >
          <Upload size={28} style={{ color: file ? C.primary : C.textMuted, marginBottom: 8 }} />
          <div style={{ fontWeight: 600, fontSize: 15 }}>
            {file ? file.name : 'Click to choose a file'}
          </div>
          {file && (
            <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 4 }}>
              {fmtBytes(file.size)} · {file.type || 'unknown'}
            </div>
          )}
          {!file && (
            <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 4 }}>
              Image, Video, Audio, or Document (max 50 MB)
            </div>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
            style={{ display: 'none' }}
            onChange={(e) => handleFileChange(e.target.files?.[0] || null)}
          />
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: C.textSecondary, marginBottom: 4 }}>
            Name <span style={{ fontWeight: 400, color: C.textMuted }}>(optional)</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Diwali greeting v2"
            style={{
              width: '100%', padding: '8px 10px', borderRadius: 6,
              border: `1px solid ${C.border}`, fontFamily: FONT, fontSize: 15,
              boxSizing: 'border-box',
            }}
          />
        </div>

        <div style={{ marginTop: 12 }}>
          <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: C.textSecondary, marginBottom: 4 }}>
            Description <span style={{ fontWeight: 400, color: C.textMuted }}>(optional — what this file is; AI agents read it whenever the file is sent)</span>
          </label>
          <input
            type="text"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="e.g. Course brochure — syllabus, fees, batch dates and how to enrol"
            style={{
              width: '100%', padding: '8px 10px', borderRadius: 6,
              border: `1px solid ${C.border}`, fontFamily: FONT, fontSize: 15,
              boxSizing: 'border-box',
            }}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button
            onClick={onClose}
            disabled={uploading}
            style={{
              padding: '9px 14px', borderRadius: 6, background: 'var(--c-cardBg)',
              border: `1px solid ${C.border}`, cursor: 'pointer',
              fontFamily: FONT, fontSize: 15, fontWeight: 600, color: C.text,
            }}
          >Cancel</button>
          <button
            onClick={submit}
            disabled={!file || uploading}
            style={{
              padding: '9px 16px', borderRadius: 6,
              background: !file ? 'var(--c-hover)' : C.primary,
              color: '#fff', border: 'none',
              cursor: !file || uploading ? 'not-allowed' : 'pointer',
              fontFamily: FONT, fontSize: 15, fontWeight: 600,
            }}
          >{uploading ? 'Uploading…' : 'Upload'}</button>
        </div>
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } } .spin { animation: spin 1s linear infinite; }`}</style>
    </div>
  );
}


const ARTICLE_TYPE = { image: 'an image', video: 'a video', audio: 'an audio file', document: 'a document' };

const ACCEPT_BY_TYPE = {
  image: 'image/*',
  video: 'video/*',
  audio: 'audio/*',
  document: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt',
};

// Mirrors inferMediaType() in backend routes/mediaLibrary.js. Both read the
// browser-reported type, so this warning and the server's refusal agree.
function inferMediaType(mime) {
  const m = String(mime || '');
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

function FilePreview({ kind, src, name }) {
  if (kind === 'image') {
    return <img src={src} alt={name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />;
  }
  if (kind === 'video') {
    return <video src={src} muted controls preload="metadata" style={{ maxWidth: '100%', maxHeight: '100%' }} />;
  }
  const Icon = (TYPE_META[kind] || TYPE_META.document).Icon;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, color: C.textSecondary, padding: 12, textAlign: 'center' }}>
      <Icon size={28} />
      <span style={{ fontSize: 14, wordBreak: 'break-word' }}>{name}</span>
    </div>
  );
}

function ReplaceModal({ media, onClose, onReplaced }) {
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const busyRef = useRef(false);

  const displayName = media.name || media.originalName;
  const syncedCount = media.syncs.filter(s => s.metaMediaId).length;
  const kindText = ARTICLE_TYPE[media.mediaType] || ARTICLE_TYPE.document;
  const newKind = file ? inferMediaType(file.type) : null;
  const mismatch = !!file && newKind !== media.mediaType;

  const choose = (f) => {
    if (!f || busyRef.current) return;
    setError(null);
    setFile(f);
  };

  // Derived in render, not set from an effect: an effect lags one frame, so a
  // newly chosen file rendered against the PREVIOUS url just as it was revoked
  // ("Failed to load resource: blob … ERR_FILE_NOT_FOUND").
  const fileUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (fileUrl) URL.revokeObjectURL(fileUrl); }, [fileUrl]);

  // Ctrl+V a copied file or screenshot straight in; Escape closes.
  useEffect(() => {
    const onPaste = (e) => {
      const f = e.clipboardData?.files?.[0];
      if (f) { e.preventDefault(); choose(f); }
    };
    const onKey = (e) => { if (e.key === 'Escape' && !busyRef.current) onClose(); };
    window.addEventListener('paste', onPaste);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const submit = async () => {
    if (!file || mismatch || busy) return;
    setBusy(true); busyRef.current = true; setError(null);
    try {
      const result = await api.mediaLibrary.replace(media.id, file);
      await onReplaced(result);
    } catch (err) {
      setError(err.message);
      setBusy(false); busyRef.current = false;
    }
  };

  const panel = {
    height: 190, borderRadius: 8, overflow: 'hidden',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--c-surfaceInner, #FAFAF8)',
  };
  const colLabel = {
    fontSize: 13, fontWeight: 600, color: C.textSecondary, marginBottom: 6,
    textTransform: 'uppercase', letterSpacing: '.04em',
  };

  return (
    <div
      onClick={() => { if (!busyRef.current) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', padding: 16,
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
      }}
    >
      <div
        role="dialog"
        aria-label="Replace file"
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--c-cardBg)', borderRadius: 12, padding: 24,
          width: 620, maxWidth: '100%', maxHeight: 'calc(90vh / var(--fg-zoom, 1))', overflowY: 'auto',
          boxShadow: C.shadowLg,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Replace file</h2>
        <div style={{ fontSize: 15, color: C.textSecondary, margin: '4px 0 16px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {displayName}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          <div>
            <div style={colLabel}>Current</div>
            <div style={{ ...panel, border: `1px solid ${C.border}` }}>
              <FilePreview kind={media.mediaType} src={api.mediaLibrary.downloadUrl(media.id, media.sha256)} name={media.originalName} />
            </div>
            <div style={{ fontSize: 14, color: C.textMuted, marginTop: 6 }}>
              {fmtBytes(media.sizeBytes)} · uploaded {fmtDate(media.uploadedAt)}
            </div>
          </div>

          <div>
            <div style={colLabel}>New</div>
            <div
              data-testid="replace-dropzone"
              onClick={() => { if (!busyRef.current) inputRef.current?.click(); }}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); choose(e.dataTransfer?.files?.[0]); }}
              style={{
                ...panel, cursor: busy ? 'wait' : 'pointer',
                border: `2px dashed ${dragOver || (file && !mismatch) ? C.primary : C.border}`,
                background: dragOver ? 'var(--c-selectedTint, #FFF7F7)' : panel.background,
              }}
            >
              {file && fileUrl ? (
                <FilePreview kind={newKind} src={fileUrl} name={file.name} />
              ) : (
                <div style={{ textAlign: 'center', padding: 12 }}>
                  <Upload size={26} style={{ color: C.textMuted, marginBottom: 8 }} />
                  <div style={{ fontWeight: 600, fontSize: 15 }}>Choose {kindText}</div>
                  <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 4 }}>
                    Click, drop it here, or paste with Ctrl+V
                  </div>
                </div>
              )}
              <input
                ref={inputRef}
                type="file"
                accept={ACCEPT_BY_TYPE[media.mediaType] || ACCEPT_BY_TYPE.document}
                style={{ display: 'none' }}
                onChange={(e) => { choose(e.target.files?.[0] || null); e.target.value = ''; }}
              />
            </div>
            <div style={{ fontSize: 14, color: C.textMuted, marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {file ? `${file.name} · ${fmtBytes(file.size)}` : 'Nothing chosen yet'}
            </div>
          </div>
        </div>

        {mismatch && (
          <div style={{
            marginTop: 14, padding: '10px 12px', borderRadius: 8, fontSize: 14, fontWeight: 500,
            background: 'var(--c-sfef3c7, #FEF3C7)', color: 'var(--c-sb45309, #B45309)',
            display: 'flex', gap: 8, alignItems: 'flex-start',
          }}>
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              This item is {kindText}, so it can only be replaced with {kindText}.
              Upload {ARTICLE_TYPE[newKind]} as a new item instead.
            </span>
          </div>
        )}

        <div style={{ marginTop: 14, fontSize: 14, color: C.textSecondary, lineHeight: 1.5 }}>
          The name and notes stay the same, and every automation, form, template and broadcast that
          uses this item sends the new file from now on.
          {syncedCount > 0 && ` It is synced to ${syncedCount} WhatsApp number${syncedCount === 1 ? '' : 's'}, which ${syncedCount === 1 ? 'is' : 'are'} re-synced automatically.`}
        </div>

        {error && (
          <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 14, background: 'var(--c-dangerBgSoft, #FEF2F2)', color: 'var(--c-dangerStrong, #991B1B)' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button
            onClick={onClose}
            disabled={busy}
            style={{
              padding: '9px 14px', borderRadius: 6, background: 'var(--c-cardBg)',
              border: `1px solid ${C.border}`, cursor: busy ? 'not-allowed' : 'pointer',
              fontFamily: FONT, fontSize: 15, fontWeight: 600, color: C.text,
            }}
          >Cancel</button>
          <button
            onClick={submit}
            disabled={!file || mismatch || busy}
            style={{
              padding: '9px 16px', borderRadius: 6,
              background: !file || mismatch ? 'var(--c-hover)' : C.primary,
              color: !file || mismatch ? C.textMuted : '#fff', border: 'none',
              cursor: !file || mismatch || busy ? 'not-allowed' : 'pointer',
              fontFamily: FONT, fontSize: 15, fontWeight: 600,
            }}
          >{busy ? 'Replacing…' : 'Replace file'}</button>
        </div>
      </div>
    </div>
  );
}

function PreviewModal({ media, onClose, onSaved, onError }) {
  const displayName = media.name || media.originalName;
  const [desc, setDesc] = useState(media.notes || '');
  const [saving, setSaving] = useState(false);
  const dirty = desc.trim() !== (media.notes || '').trim();
  const saveDesc = async () => {
    setSaving(true);
    try {
      const r = await api.mediaLibrary.update(media.id, { notes: desc.trim() || null });
      onSaved?.(r.media || { ...media, notes: desc.trim() || null });
    } catch (e) { onError?.(e.message || 'Could not save the description'); }
    finally { setSaving(false); }
  };
  const isImage = media.mediaType === 'image';
  const isVideo = media.mediaType === 'video';
  const isAudio = media.mediaType === 'audio';
  const downloadUrl = api.mediaLibrary.downloadUrl(media.id, media.sha256);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
        padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--c-cardBg)', borderRadius: 12, maxWidth: 720, width: '100%',
          maxHeight: 'calc(90vh / var(--fg-zoom, 1))', display: 'flex', flexDirection: 'column', overflowY: 'auto',
          boxShadow: '0 24px 48px rgba(0,0,0,.35)',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: `1px solid ${C.border}`,
        }}>
          <div style={{ fontWeight: 700, fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {displayName}
          </div>
          <button
            onClick={onClose}
            style={{
              padding: '4px 10px', borderRadius: 6, background: 'var(--c-hover)',
              border: 'none', cursor: 'pointer', fontFamily: FONT, fontSize: 14, fontWeight: 600,
              color: C.text,
            }}
          >Close</button>
        </div>

        {/* Media viewport */}
        <div style={{
          flex: 1, overflow: 'auto', padding: 18,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: '#0f0f0f',
          minHeight: 200,
        }}>
          {isImage ? (
            <img
              src={downloadUrl}
              alt={displayName}
              style={{ maxWidth: '100%', maxHeight: 'calc(60vh / var(--fg-zoom, 1))', borderRadius: 8, objectFit: 'contain' }}
            />
          ) : isVideo ? (
            <video
              src={downloadUrl}
              controls
              style={{ maxWidth: '100%', maxHeight: 'calc(60vh / var(--fg-zoom, 1))', borderRadius: 8 }}
            />
          ) : isAudio ? (
            <div style={{ textAlign: 'center', color: '#fff' }}>
              <div style={{ fontSize: 15, marginBottom: 12, opacity: .8 }}>{displayName}</div>
              <audio src={downloadUrl} controls style={{ width: 320 }} />
            </div>
          ) : (
            <div style={{ textAlign: 'center', color: '#fff' }}>
              <FileText size={48} style={{ opacity: .5, marginBottom: 12 }} />
              <div style={{ fontSize: 15, marginBottom: 4 }}>{displayName}</div>
              <div style={{ fontSize: 14, opacity: .6 }}>{media.mimeType} · {fmtBytes(media.sizeBytes)}</div>
            </div>
          )}
        </div>

        {/* Footer info */}
        <div style={{
          padding: '12px 18px', borderTop: `1px solid ${C.border}`,
          fontSize: 14, color: C.textSecondary, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center',
        }}>
          <span><strong>Type:</strong> {(TYPE_META[media.mediaType] || TYPE_META.document).label}</span>
          <span><strong>Size:</strong> {fmtBytes(media.sizeBytes)}</span>
          <span><strong>Uploaded:</strong> {fmtDate(media.uploadedAt)}</span>
          <a
            href={downloadUrl}
            download={displayName}
            style={{ marginLeft: 'auto', color: C.primary, fontWeight: 600, textDecoration: 'none' }}
          >
            Download
          </a>
        </div>

        {/* Description — what AI agents read in place of this file whenever it
            is sent in a chat. */}
        <div style={{ padding: '12px 18px 16px', borderTop: `1px solid ${C.border}` }}>
          <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: C.textSecondary, marginBottom: 4 }}>
            Description
          </label>
          <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 6 }}>
            AI agents read this whenever this file is sent in a chat, so they know what the customer was given.
          </div>
          <textarea
            data-testid="media-description"
            value={desc}
            onChange={e => setDesc(e.target.value)}
            rows={3}
            placeholder="e.g. Course brochure — syllabus, fees, batch dates and how to enrol"
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: `1px solid ${C.border}`, fontFamily: FONT, fontSize: 15, boxSizing: 'border-box', resize: 'vertical', background: 'var(--c-cardBg)', color: C.text }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="button" onClick={saveDesc} disabled={!dirty || saving}
              style={{ padding: '7px 14px', borderRadius: 8, border: 'none', cursor: dirty && !saving ? 'pointer' : 'default', background: dirty ? C.primary : 'var(--c-surfaceAlt)', color: dirty ? '#fff' : C.textMuted, fontWeight: 600, fontFamily: FONT }}>
              {saving ? 'Saving…' : 'Save description'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
