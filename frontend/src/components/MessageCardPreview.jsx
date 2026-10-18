import { Image as ImageIcon, Music, Link as LinkIcon } from 'lucide-react';
import { api } from '../api.js';
import { FONT } from '../constants.js';
import { templateButtonView, VideoThumb } from './WhatsAppPreview.jsx';
import { Bubble, DocChip, WA, mediaStyle } from './sim/SimKit.jsx';

// Fill {{n}} blanks with the template's own example values, so a card reads
// like a real message ("Hi Priya…") instead of "Hi {{1}}…".
function fillSamples(text, samples) {
  if (!text) return '';
  const s = samples && typeof samples === 'object' ? samples : {};
  return String(text).replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => (s[n] ? String(s[n]) : m));
}

function parseButtons(b) {
  if (Array.isArray(b)) return b;
  if (typeof b === 'string') { try { const x = JSON.parse(b); return Array.isArray(x) ? x : []; } catch { return []; } }
  return [];
}

/**
 * A small WhatsApp-style preview for a grid card: the chat wallpaper and one
 * message bubble, clipped to a fixed height with a fade so long messages do
 * not make cards uneven. Not a phone — a whole phone per card would be four
 * times the height and say nothing more.
 *
 *   template  a template row (header_type, header_text, header_media_library_id,
 *             body, footer, buttons, samples)
 *   direct    a non-template broadcast ({ messageType, body, url, caption, mediaLibraryId })
 */
export default function MessageCardPreview({ template, direct, height = 210, emptyText = 'No preview', topInset = 0 }) {
  let bubble = null;
  if (template) {
    const ht = template.header_type;
    const mid = template.header_media_library_id;
    const src = mid ? api.mediaLibrary.downloadUrl(mid) : null;
    const media = ht === 'IMAGE'
      ? (src ? <img src={src} alt="" loading="lazy" style={{ ...mediaStyle, height: 110, objectFit: 'cover' }} />
             : <div style={{ height: 90, borderRadius: 6, background: 'linear-gradient(135deg,var(--c-borderStrong, #c9c9c9),#999)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ImageIcon size={22} color="rgba(255,255,255,.85)" /></div>)
      : ht === 'VIDEO' ? <VideoThumb src={src} height={110} />
      : ht === 'DOCUMENT' ? <DocChip name="Document" kind="PDF" />
      : null;
    const body = fillSamples(template.body, template.samples);
    bubble = (
      <Bubble from="bot" media={media} buttons={parseButtons(template.buttons).map(templateButtonView)} maxWidth="92%">
        {ht === 'TEXT' && template.header_text && <div style={{ fontWeight: 700, marginBottom: 3 }}>{fillSamples(template.header_text, template.samples)}</div>}
        {body}
        {template.footer && <div style={{ fontSize: 12, color: WA.time, marginTop: 4 }}>{template.footer}</div>}
      </Bubble>
    );
  } else if (direct) {
    const t = direct.messageType;
    const src = direct.mediaLibraryId ? api.mediaLibrary.downloadUrl(direct.mediaLibraryId) : null;
    const media = t === 'image' ? (src ? <img src={src} alt="" loading="lazy" style={{ ...mediaStyle, height: 110, objectFit: 'cover' }} /> : null)
      : t === 'video' ? <VideoThumb src={src} height={110} />
      : t === 'document' ? <DocChip name="Document" kind="PDF" />
      : t === 'audio' ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px' }}><Music size={16} color={WA.time} /><div style={{ flex: 1, height: 3, background: 'rgba(0,0,0,.12)', borderRadius: 2 }} /></div>
      : null;
    const text = t === 'link' ? direct.url : t === 'text' ? direct.body : direct.caption;
    bubble = (
      <Bubble from="bot" media={media} maxWidth="92%">
        {t === 'link' && text
          ? <span style={{ color: WA.link, display: 'inline-flex', alignItems: 'center', gap: 4, wordBreak: 'break-all' }}><LinkIcon size={12} /> {text}</span>
          : (text || null)}
      </Bubble>
    );
  }

  return (
    <div data-testid="card-preview" data-has-bubble={bubble ? '1' : '0'} style={{
      position: 'relative', height, overflow: 'hidden', padding: `${10 + topInset}px 10px 0`, boxSizing: 'border-box',
      background: 'var(--c-chatWall)', backgroundImage: 'var(--c-chatPattern)', fontFamily: FONT,
    }}>
      {bubble || (
        <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: WA.time, textAlign: 'center', padding: 12 }}>{emptyText}</div>
      )}
      {/* Fade instead of a hard cut, so a long message reads as "continues". */}
      <div aria-hidden style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 36, background: 'linear-gradient(to bottom, transparent, var(--c-chatWall))', pointerEvents: 'none' }} />
    </div>
  );
}
