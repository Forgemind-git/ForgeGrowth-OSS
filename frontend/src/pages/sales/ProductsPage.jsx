// Products — anything you sell: a course, a consulting engagement, a template
// pack, a webinar. Each product carries an optional default (headline) price
// plus any number of payment links, one per price variant.
//
// Default price vs payment link — these answer different questions and one
// cannot stand in for the other:
//   default price — what you normally charge. Pre-fills a manual sale. A
//                   product can have one before any payment link exists.
//   payment link  — the EXACT amount a Razorpay link charges, used to attribute
//                   an incoming payment to this product automatically.
//
// (This was "Courses" until the rename. The API is /products; the underlying
// table is still `courses` on purpose — see migration 084.)
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Package, Plus, Pencil, Trash2, ImagePlus, IndianRupee, X, Loader2,
  ExternalLink,
} from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import { PageShell, Button, Modal, Field, inputStyle, EmptyState } from '../academy/shared.jsx';
import { notify } from '../../lib/feedback.js';

function rupees(paise) {
  if (paise == null) return '₹0';
  return '₹' + (Number(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export default function ProductsPage({ user }) {
  const [products, setProducts] = useState(null);
  const [unattributed, setUnattributed] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [productModal, setProductModal] = useState(null); // {mode:'create'|'edit', product}
  const [linkModal, setLinkModal] = useState(null);       // {productId, link?}
  const [confirmDel, setConfirmDel] = useState(null);     // {type:'product'|'link', id, name}

  const load = useCallback(async () => {
    try {
      setLoading(true); setError(null);
      const [p, rev] = await Promise.all([api.products.list(), api.products.revenue().catch(() => null)]);
      setProducts(p.products || []);
      setUnattributed(rev?.unattributed || null);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const doDelete = async () => {
    if (!confirmDel) return;
    try {
      if (confirmDel.type === 'product') await api.products.delete(confirmDel.id);
      else await api.products.deleteLink(confirmDel.id);
      setConfirmDel(null);
      load();
    } catch (err) { notify(err.message); }
  };

  return (
    <PageShell
      title="Products"
      subtitle="Everything you sell — a course, a consulting package, a template, a webinar. Set a default price, then add payment links so payments match automatically."
      actions={<Button variant="primary" icon={Plus} onClick={() => setProductModal({ mode: 'create' })}>New product</Button>}
    >
      {error && <div style={{ background: C.primaryLight, color: '#A32D2D', padding: '10px 12px', borderRadius: 8, fontSize: 12, marginBottom: 14 }}>{error}</div>}

      {unattributed && unattributed.paid_count > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#FFF8E1', color: '#7A5500', border: '1px solid #F0E0B0', borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontFamily: FONT, fontSize: 13 }}>
          <IndianRupee size={15} />
          {rupees(unattributed.revenue_paise)} from {unattributed.paid_count} payment(s) isn't matched to any product yet — add a payment link with that price so it attributes automatically.
        </div>
      )}

      {loading && !products ? (
        <div style={{ padding: 60, textAlign: 'center', color: C.textMuted, fontFamily: FONT }}>Loading products…</div>
      ) : products && products.length === 0 ? (
        <EmptyState Icon={Package} title="No products yet" hint="Add your first product — a course, a consulting package, a template or a webinar — then give it a price." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
          {products && products.map(product => {
            const revenue = (product.links || []).reduce((s, l) => s + Number(l.revenue_paise || 0), 0);
            const paid = (product.links || []).reduce((s, l) => s + (l.paid_count || 0), 0);
            return (
              <div key={product.id} style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column', opacity: product.active ? 1 : 0.6 }}>
                {/* Thumbnail */}
                <div style={{ position: 'relative', aspectRatio: '16 / 9', background: C.hover, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {product.thumbnail_url
                    ? <img src={product.thumbnail_url} alt={product.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <Package size={40} color={C.textMuted} style={{ opacity: 0.5 }} />}
                  <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 6 }}>
                    <button title="Edit product" onClick={() => setProductModal({ mode: 'edit', product })} style={iconBtn}><Pencil size={14} /></button>
                    <button title="Delete product" onClick={() => setConfirmDel({ type: 'product', id: product.id, name: product.name })} style={iconBtn}><Trash2 size={14} /></button>
                  </div>
                </div>

                {/* Body */}
                <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: C.text }}>{product.name}</h3>
                      {product.default_price_paise != null && (
                        <span title="Default price — pre-fills a manual sale" style={{
                          fontFamily: MONO, fontSize: 12, fontWeight: 700, color: C.green,
                          background: 'rgba(15,110,86,.09)', padding: '2px 8px', borderRadius: 99,
                        }}>{rupees(product.default_price_paise)}</span>
                      )}
                      {!product.active && <span style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase' }}>inactive</span>}
                    </div>
                    {product.description && <div style={{ fontSize: 12.5, color: C.textSecondary, marginTop: 4, lineHeight: 1.45 }}>{product.description}</div>}
                  </div>

                  {/* Revenue chip */}
                  <div style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '8px 0', borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
                    <div>
                      <div style={{ fontSize: 9.5, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.05em' }}>Collected</div>
                      <div style={{ fontFamily: MONO, fontSize: 17, fontWeight: 700, color: C.text }}>{rupees(revenue)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9.5, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.05em' }}>Sold</div>
                      <div style={{ fontFamily: MONO, fontSize: 17, fontWeight: 700, color: C.text }}>{paid}</div>
                    </div>
                  </div>

                  {/* Price variants / links */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.05em' }}>Payment links & prices</div>
                    {(product.links || []).length === 0 && <div style={{ fontSize: 12, color: C.textMuted }}>No links yet — add one so its payments attribute here.</div>}
                    {(product.links || []).map(l => (
                      <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: C.hover, borderRadius: 9, padding: '8px 10px' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{l.label}</span>
                            {l.url && <a href={l.url} target="_blank" rel="noreferrer" title="Open link" style={{ color: C.textMuted, lineHeight: 0 }}><ExternalLink size={12} /></a>}
                          </div>
                          <div style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO }}>
                            {rupees(l.amount_paise)}{l.match_text ? ` · “${l.match_text}”` : ''}{l.paid_count ? ` · ${l.paid_count} sold` : ''}
                          </div>
                        </div>
                        <button title="Edit" onClick={() => setLinkModal({ productId: product.id, link: l })} style={miniBtn}><Pencil size={12} /></button>
                        <button title="Delete" onClick={() => setConfirmDel({ type: 'link', id: l.id, name: l.label })} style={miniBtn}><Trash2 size={12} /></button>
                      </div>
                    ))}
                    <Button variant="secondary" icon={Plus} onClick={() => setLinkModal({ productId: product.id })} style={{ alignSelf: 'flex-start', marginTop: 2 }}>Add price / link</Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {productModal && <ProductModal data={productModal} onClose={() => setProductModal(null)} onSaved={() => { setProductModal(null); load(); }} />}
      {linkModal && <LinkModal data={linkModal} onClose={() => setLinkModal(null)} onSaved={(msg) => { setLinkModal(null); if (msg) notify(msg); load(); }} />}
      {confirmDel && (
        <Modal title={`Delete ${confirmDel.type}`} onClose={() => setConfirmDel(null)}
          footer={<><Button variant="ghost" onClick={() => setConfirmDel(null)}>Cancel</Button><Button variant="danger" icon={Trash2} onClick={doDelete}>Delete</Button></>}>
          <div style={{ padding: '18px 22px', fontFamily: FONT, fontSize: 14, color: C.text }}>
            Delete <b>{confirmDel.name}</b>? {confirmDel.type === 'product' ? 'Its payment links are removed and past payments are detached (kept in history, un-attributed).' : 'Past payments matched via this link stay in history but lose their attribution.'}
          </div>
        </Modal>
      )}
    </PageShell>
  );
}

// ── Product create/edit modal (with thumbnail upload + Ctrl+V paste) ─────────
function ProductModal({ data, onClose, onSaved }) {
  const edit = data.mode === 'edit';
  const [name, setName] = useState(data.product?.name || '');
  const [description, setDescription] = useState(data.product?.description || '');
  const [thumbnailUrl, setThumbnailUrl] = useState(data.product?.thumbnail_url || '');
  const [defaultPrice, setDefaultPrice] = useState(
    data.product?.default_price_paise != null ? String(Number(data.product.default_price_paise) / 100) : ''
  );
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);

  const uploadFile = useCallback(async (file) => {
    if (!file || !file.type.startsWith('image/')) { notify('Please choose an image file.'); return; }
    setUploading(true);
    try { const { url } = await api.upload(file); setThumbnailUrl(url); }
    catch (err) { notify(err.message || 'Upload failed'); }
    finally { setUploading(false); }
  }, []);

  // Ctrl+V paste an image while the modal is open (Forge convention).
  useEffect(() => {
    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find(it => it.type.startsWith('image/'));
      if (item) { const f = item.getAsFile(); if (f) uploadFile(f); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [uploadFile]);

  const save = async () => {
    if (!name.trim()) { notify('Product name is required.'); return; }
    // Blank is a valid answer — the price is optional. Only a value that is
    // present AND not a number is an error.
    const priceStr = defaultPrice.trim();
    if (priceStr && (!Number.isFinite(Number(priceStr)) || Number(priceStr) < 0)) {
      notify('Enter a valid default price in ₹, or leave it blank.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: name.trim(), description: description.trim(), thumbnailUrl: thumbnailUrl || '',
        defaultPrice: priceStr === '' ? null : Number(priceStr),
      };
      if (edit) await api.products.update(data.product.id, body);
      else await api.products.create(body);
      onSaved();
    } catch (err) { notify(err.message || 'Save failed'); }
    finally { setSaving(false); }
  };

  return (
    <Modal title={edit ? 'Edit product' : 'New product'} onClose={onClose} width={520}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : (edit ? 'Save' : 'Create')}</Button></>}>
      <div style={{ padding: '18px 22px', fontFamily: FONT }}>
        {/* Thumbnail */}
        <Field label="Thumbnail" hint="Upload, drag-drop, or paste (Ctrl+V) an image.">
          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={e => { e.preventDefault(); }}
            onDrop={e => { e.preventDefault(); uploadFile(e.dataTransfer.files?.[0]); }}
            style={{ aspectRatio: '16 / 9', border: `1.5px dashed ${C.border}`, borderRadius: 10, background: C.hover, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', overflow: 'hidden', position: 'relative' }}>
            {uploading ? <Loader2 size={22} color={C.textMuted} style={{ animation: 'spin 1s linear infinite' }} />
              : thumbnailUrl ? <img src={thumbnailUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <div style={{ textAlign: 'center', color: C.textMuted }}><ImagePlus size={26} /><div style={{ fontSize: 12, marginTop: 6 }}>Click, drop, or paste an image</div></div>}
            {thumbnailUrl && !uploading && (
              <button onClick={e => { e.stopPropagation(); setThumbnailUrl(''); }} style={{ position: 'absolute', top: 8, right: 8, ...iconBtn }}><X size={14} /></button>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={e => uploadFile(e.target.files?.[0])} />
        </Field>

        <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Applied AI with Claude" style={inputStyle} /></Field>

        <Field label="Default price (₹)" hint="Optional. What you normally charge — it pre-fills the amount when you log a sale. Leave blank if the price varies every time.">
          <div style={{ position: 'relative' }}>
            <IndianRupee size={14} style={{ position: 'absolute', left: 11, top: 11, color: C.textMuted }} />
            <input value={defaultPrice} onChange={e => setDefaultPrice(e.target.value)} placeholder="4999" inputMode="decimal" style={{ ...inputStyle, paddingLeft: 30 }} />
          </div>
        </Field>

        <Field label="Description">
          <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What this product includes…" rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
        </Field>
      </div>
    </Modal>
  );
}

// ── Payment-link (price variant) modal ───────────────────────────────────────
function LinkModal({ data, onClose, onSaved }) {
  const edit = !!data.link;
  const [label, setLabel] = useState(data.link?.label || '');
  const [amount, setAmount] = useState(data.link ? String(Number(data.link.amount_paise) / 100) : '');
  const [matchText, setMatchText] = useState(data.link?.match_text || '');
  const [url, setUrl] = useState(data.link?.url || '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!label.trim()) { notify('A price-variant label is required (e.g. Full price / Early bird).'); return; }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) { notify('Enter a valid price in ₹.'); return; }
    setSaving(true);
    try {
      const body = { label: label.trim(), amountRupees: amt, matchText: matchText.trim(), url: url.trim() };
      const res = edit ? await api.products.updateLink(data.link.id, body) : await api.products.addLink(data.productId, body);
      onSaved(res?.backfilled ? `Saved. Matched ${res.backfilled} past payment(s) to this product.` : 'Saved.');
    } catch (err) { notify(err.message || 'Save failed'); setSaving(false); }
  };

  return (
    <Modal title={edit ? 'Edit price / link' : 'Add price / link'} onClose={onClose} width={480}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button></>}>
      <div style={{ padding: '18px 22px', fontFamily: FONT }}>
        <Field label="Price variant label" hint="How this price is described — Full price, Early bird, WhatsApp 50% off…">
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Full price" style={inputStyle} />
        </Field>
        <Field label="Price (₹)" hint="The EXACT amount this Razorpay link charges — payments matching this amount attribute to this product.">
          <div style={{ position: 'relative' }}>
            <IndianRupee size={14} style={{ position: 'absolute', left: 11, top: 11, color: C.textMuted }} />
            <input value={amount} onChange={e => setAmount(e.target.value)} placeholder="4999" inputMode="decimal" style={{ ...inputStyle, paddingLeft: 30 }} />
          </div>
        </Field>
        <Field label="Disambiguation text (optional)" hint="Only needed if two products share the same price. A word from the payment page title/description that identifies THIS product.">
          <input value={matchText} onChange={e => setMatchText(e.target.value)} placeholder="e.g. AI Academy" style={inputStyle} />
        </Field>
        <Field label="Payment link URL (optional, for reference)">
          <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://rzp.io/l/…" style={inputStyle} />
        </Field>
      </div>
    </Modal>
  );
}

const iconBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 7, border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,.92)', color: '#333', boxShadow: '0 1px 3px rgba(0,0,0,.15)' };
const miniBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 6, border: `1px solid ${C.border}`, cursor: 'pointer', background: C.cardBg, color: C.textSecondary, flexShrink: 0 };
