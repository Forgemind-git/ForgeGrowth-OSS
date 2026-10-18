import { Play, Music, Link as LinkIcon, Phone, Reply, KeyRound, Copy } from 'lucide-react';
import { api } from '../api.js';
import { PhoneFrame, Bubble, ChatDay, ChatEmpty, mediaStyle, DocChip, WA } from './sim/SimKit.jsx';

// The phone lives in the shared simulator kit now; re-exported so existing
// imports keep working.
export { PhoneFrame };

// Template button → the label + small icon WhatsApp draws on it.
export function templateButtonView(btn) {
  const type = btn?.type;
  const label = btn?.text || btn?.label || (type === 'QUICK_REPLY' ? 'Quick Reply' : type === 'URL' ? 'Visit Website' : type === 'PHONE_NUMBER' ? 'Call Us' : type === 'COPY_CODE' ? 'Copy Code' : 'Button');
  const icon = type === 'URL' ? <LinkIcon size={13} />
    : type === 'PHONE_NUMBER' ? <Phone size={13} />
    : type === 'OTP' ? <KeyRound size={13} />
    : type === 'COPY_CODE' ? <Copy size={13} />
    : <Reply size={13} />;
  return { label, icon };
}

export function VideoThumb({ src, height = 130 }) {
  return (
    <div style={{ position: 'relative', borderRadius: 6, overflow: 'hidden', height, background: '#1A1A1A' }}>
      {src && <video src={src} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} preload="metadata" muted />}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.3)' }}>
        <div style={{ width: 38, height: 38, borderRadius: 99, background: 'rgba(255,255,255,.18)', border: '1.5px solid rgba(255,255,255,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Play size={16} color="white" fill="white" />
        </div>
      </div>
    </div>
  );
}

/* ── Reusable WhatsApp template preview ──────────────────────────── */
// The business message arrives on the LEFT, the way the customer sees it —
// identical to the flow builder's simulator.
export default function WhatsAppPreview({ template, emptyText = 'Select a template\nto preview', height = 620 }) {
  if (!template) {
    return (
      <PhoneFrame headerTitle="Your Business" headerSubtitle="online" height={height}>
        <ChatDay />
        <ChatEmpty>{emptyText}</ChatEmpty>
      </PhoneFrame>
    );
  }

  const buttons = (template.buttons || []).map(templateButtonView);
  const mid = template.header_media_library_id;
  const ht = template.header_type;
  const media = ht === 'IMAGE'
    ? (mid ? <img src={api.mediaLibrary.downloadUrl(mid)} alt="" style={{ ...mediaStyle, height: 130, objectFit: 'cover' }} /> : <div style={{ height: 110, borderRadius: 6, background: 'var(--c-surfaceInner, #F5F5F0)' }} />)
    : ht === 'VIDEO' ? <VideoThumb src={mid ? api.mediaLibrary.downloadUrl(mid) : null} />
    : ht === 'DOCUMENT' ? <DocChip name="Document" kind="PDF" />
    : null;

  return (
    <PhoneFrame headerTitle="Your Business" headerSubtitle="online" height={height}>
      <ChatDay />
      <Bubble from="bot" media={media} buttons={buttons}>
        {template.header_text && ht === 'TEXT' && <div style={{ fontWeight: 700, marginBottom: 3 }}>{template.header_text}</div>}
        {template.body}
        {template.footer && <div style={{ fontSize: 12, color: WA.time, marginTop: 4 }}>{template.footer}</div>}
      </Bubble>
    </PhoneFrame>
  );
}


/* ── Broadcast direct-message preview ────────────────────────────── */
// Fills {{name}} / {{contact_number}} with a sample contact, so the preview
// reads like the message a real person gets rather than as literal braces.
const fillSample = (s) => String(s || '')
  .replace(/\{\{\s*(name|contact\.name)\s*\}\}/g, 'John Doe')
  .replace(/\{\{\s*(contact_number|contact\.number)\s*\}\}/g, '+91 98765 43210');

export function BroadcastMessagePreview({ messageType, body, url, mediaLibraryId, caption, mediaItems, height = 620 }) {
  const selected = mediaItems?.find(m => String(m.id) === String(mediaLibraryId));
  const src = selected ? api.mediaLibrary.downloadUrl(selected.id) : null;

  let media = null;
  if (selected) {
    if (messageType === 'image') media = <img src={src} alt={selected.name || 'Image'} style={{ ...mediaStyle, maxHeight: 220, objectFit: 'cover' }} />;
    else if (messageType === 'video') media = <VideoThumb src={src} />;
    else if (messageType === 'audio') media = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', minWidth: 180 }}>
        <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#00A884', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Music size={14} color="#fff" /></div>
        <div style={{ flex: 1, height: 4, background: 'rgba(0,0,0,0.1)', borderRadius: 2 }} />
        <span style={{ fontSize: 11, color: WA.time }}>0:15</span>
      </div>
    );
    else if (messageType === 'document') media = <DocChip name={selected.name} kind={selected.mediaType?.toUpperCase?.() || 'PDF'} />;
  }

  let text;
  if (messageType === 'text') text = fillSample(body) || 'Your message will appear here…';
  else if (messageType === 'link') text = <span style={{ color: WA.link, textDecoration: 'underline', wordBreak: 'break-all' }}>{url || 'https://example.com'}</span>;
  else text = fillSample(caption);

  const nothingYet = ['image', 'video', 'audio', 'document'].includes(messageType) && !selected && !caption;

  return (
    <PhoneFrame headerTitle="Your Business" headerSubtitle="online" height={height}>
      <ChatDay />
      {nothingYet
        ? <ChatEmpty>{'Pick a file from the\nMedia Library to preview'}</ChatEmpty>
        : <Bubble from="bot" media={media}>{text}</Bubble>}
    </PhoneFrame>
  );
}
