import React, { useState, useRef, useEffect, useCallback, useLayoutEffect, useMemo } from "react";
import { notify as appNotify } from '../lib/feedback.js';
import { api } from "../api.js";
import { maskPhone, downloadJson, slugifyName } from "../constants.js";
import AutomationExecutions from "./AutomationExecutions.jsx";
import SearchableSelect from "./SearchableSelect.jsx";
import { useFunnelConfig } from "../hooks/useFunnelConfig.js";
import {
  NODE_W, HANDLE_DOT, HANDLE_HIT, INPUT_DOT, INPUT_HIT, ROW_H, SYS_H, mediaChipFor,
  nodeH, nodeLayout, nodeRows, outputHandlesOf, handlePos, inputCY, hasSummaryPanel,
  buttonLabel, isQuickReplyButton, replyButtonsOf, listRowsOf, tapTargetsOf,
  isWaitingNode, bodyPreview, handleTone,
} from "./builder/nodeLayout.js";

/* ══════════════════════════════════════════════════════════════════════
   WhatsFlow AI — Premium WhatsApp Automation Builder (UI Mockup)
   Single-file React JSX. Inline styles + DM Sans / DM Mono.
   Design system: warm off-white #F7F7F3, white cards, WhatsApp-inspired
   enterprise green accent (#0F6E56 / #1D9E75).
   ══════════════════════════════════════════════════════════════════════ */

const fmt = (n) => "₹" + Number(n).toLocaleString("en-IN");
const fmtN = (n) => Number(n).toLocaleString("en-IN");

/* ── Color tokens ─────────────────────────────────────────────────── */
const C = {
  pageBg:"var(--c-pageBg)", cardBg:"var(--c-cardBg)", cardBorder:"var(--c-border)", cardBorderOpen:"var(--c-text)",
  innerBg:"var(--c-surfaceAlt)", innerBorder:"var(--c-border)", sectionBg:"var(--c-surfaceAlt)",
  rowDiv:"var(--c-border)", divider:"var(--c-border)", inputBorder:"var(--c-borderDark)",
  text1:"var(--c-text)", text2:"var(--c-text)", text3:"var(--c-textSecondary)", text4:"var(--c-textSecondary)", text5:"var(--c-textMuted)",
  muted:"var(--c-textMuted)", ghost:"var(--c-textMuted)", ph:"var(--c-textMuted)",
  // Semantic accents are tokens, not literals: every *Bg below is a pale tint
  // that rendered as a bright patch on the dark canvas, and every paired text
  // colour was too dark to read on it.
  brand:"var(--c-successText)", brandBright:"var(--c-successBright)", brandDark:"var(--c-successText)",
  brandBg:"var(--c-successBg)", brandTint:"var(--c-successTint)",
  purple:"var(--c-purple)", purpleBg:"var(--c-purpleBg)", purpleDark:"var(--c-purple)",
  red:"var(--c-dangerText)", redBg:"var(--c-dangerBg)", redDark:"var(--c-dangerStrong)",
  orange:"var(--c-orangeText)", orangeBg:"var(--c-orangeBg)", orangeBorder:"var(--c-orangeBorder)", orangeText:"var(--c-orangeText)",
  amber:"var(--c-warnText)", amberBg:"var(--c-warnBg)",
  blue:"var(--c-infoText)", blueBg:"var(--c-infoBg)", blueBorder:"var(--c-infoBorder)",
  navy:"var(--c-navy)", navyBg:"var(--c-navyBg)",
  teal:"var(--c-teal)", tealBg:"var(--c-tealBg)",
  pink:"var(--c-pink)", pinkBg:"var(--c-pinkBg)",
  sb:"#161513", sbItem:"#9E9A92", sbActive:"#26241F", sbBorder:"#26241F",
};

/* ── Inline SVG icon factory ──────────────────────────────────────── */
const I = (paths, s=16) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{paths}</svg>
);
const IC = {
  dash:(s)=>I(<><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></>,s),
  flow:(s)=>I(<><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><path d="M9 6h6M7.5 8.5L11 16M16.5 8.5L13 16"/></>,s),
  tpl:(s)=>I(<><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></>,s),
  contacts:(s)=>I(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,s),
  inbox:(s)=>I(<><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></>,s),
  bcast:(s)=>I(<><path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></>,s),
  plug:(s)=>I(<><path d="M9 2v6M15 2v6M5 10h14v4a7 7 0 0 1-14 0v-4zM12 21v-3"/></>,s),
  chart:(s)=>I(<><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></>,s),
  cog:(s)=>I(<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>,s),
  search:(s=14)=>I(<><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></>,s),
  bell:(s)=>I(<><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></>,s),
  help:(s)=>I(<><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/></>,s),
  plus:(s=14)=>I(<><path d="M12 5v14M5 12h14"/></>,s),
  check:(s=14)=>I(<polyline points="20 6 9 17 4 12"/>,s),
  cD:(s=12)=>I(<polyline points="6 9 12 15 18 9"/>,s),
  cR:(s=12)=>I(<polyline points="9 18 15 12 9 6"/>,s),
  more:(s)=>I(<><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></>,s),
  edit:(s)=>I(<><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></>,s),
  play:(s=14)=>I(<polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/>,s),
  copy:(s)=>I(<><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>,s),
  trash:(s)=>I(<><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></>,s),
  eye:(s)=>I(<><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>,s),
  zap:(s)=>I(<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" stroke="none"/>,s),
  msg:(s)=>I(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>,s),
  img:(s)=>I(<><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><polyline points="21 15 16 10 5 21"/></>,s),
  vid:(s)=>I(<><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></>,s),
  doc:(s)=>I(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></>,s),
  pin:(s)=>I(<><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></>,s),
  list:(s)=>I(<><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></>,s),
  qr:(s)=>I(<><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h7v7M14 18h2M18 14v2"/></>,s),
  branch:(s)=>I(<><circle cx="6" cy="3" r="2"/><circle cx="18" cy="3" r="2"/><circle cx="12" cy="21" r="2"/><path d="M6 5v6a6 6 0 0 0 6 6M18 5v6a6 6 0 0 1-6 6"/></>,s),
  clock:(s)=>I(<><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></>,s),
  api:(s)=>I(<><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></>,s),
  tag:(s)=>I(<><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></>,s),
  agent:(s)=>I(<><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></>,s),
  ai:(s)=>I(<><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></>,s),
  warn:(s=12)=>I(<><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></>,s),
  err:(s=12)=>I(<><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></>,s),
  ok:(s=14)=>I(<polyline points="20 6 9 17 4 12"/>,s),
  x:(s=14)=>I(<><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>,s),
  drag:(s)=>I(<><circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="15" cy="6" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="18" r="1" fill="currentColor"/><circle cx="15" cy="18" r="1" fill="currentColor"/></>,s),
  zIn:(s)=>I(<><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></>,s),
  zOut:(s)=>I(<><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></>,s),
  fit:(s)=>I(<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>,s),
  undo:(s)=>I(<><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></>,s),
  redo:(s)=>I(<><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></>,s),
  arr:(s)=>I(<><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></>,s),
  send:(s)=>I(<><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></>,s),
  back:(s=16)=>I(<><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></>,s),
  up:(s)=>I(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></>,s),
  dl:(s)=>I(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></>,s),
  link:(s)=>I(<><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></>,s),
  filt:(s)=>I(<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>,s),
  user:(s)=>I(<><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></>,s),
  phone:(s)=>I(<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>,s),
  bag:(s)=>I(<><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></>,s),
  mail:(s)=>I(<><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></>,s),
  refresh:(s)=>I(<><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></>,s),
  cal:(s)=>I(<><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></>,s),
  power:(s=13)=>I(<><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></>,s),
};

/* ── Primitive components ─────────────────────────────────────────── */
const Badge = ({ label, bg, color, border, dot, style }) => (
  <span style={{ fontSize:13, fontWeight:700, padding:"3px 9px", borderRadius:99, background:bg, color, fontFamily:"'DM Sans'", whiteSpace:"nowrap", letterSpacing:".03em", border:border?`1px solid ${border}`:"none", display:"inline-flex", alignItems:"center", gap:5, ...style }}>
    {dot && <span style={{ width:5, height:5, borderRadius:"50%", background:color }}/>}
    {label}
  </span>
);

const StatusPill = ({ status }) => {
  const m = {
    Live:{bg:C.brandBg,color:C.brandDark,dot:true}, Draft:{bg:"var(--c-surfaceSubtle, #EFEEE9)",color:C.text4,dot:true},
    Paused:{bg:C.orangeBg,color:C.orangeText,dot:true}, Error:{bg:C.redBg,color:C.redDark,dot:true},
    Approved:{bg:C.brandBg,color:C.brandDark,dot:true}, "Pending Review":{bg:C.amberBg,color:C.amber,dot:true},
    Rejected:{bg:C.redBg,color:C.redDark,dot:true},
    Connected:{bg:C.brandBg,color:C.brandDark,dot:true}, "Not connected":{bg:"var(--c-surfaceSubtle, #EFEEE9)",color:C.text4,dot:true},
    draft:{bg:"var(--c-surfaceSubtle, #EFEEE9)",color:C.text4,dot:true}, active:{bg:C.brandBg,color:C.brandDark,dot:true},
    inactive:{bg:"var(--c-surfaceSubtle, #EEEDE8)",color:C.text4,dot:true},
    paused:{bg:C.orangeBg,color:C.orangeText,dot:true}, error:{bg:C.redBg,color:C.redDark,dot:true},
  }[status] || {bg:"var(--c-surfaceSubtle, #EFEEE9)",color:C.text4,dot:true};
  return <Badge label={status} bg={m.bg} color={m.color} dot={m.dot}/>;
};

const Btn = ({ kind="ghost", icon, children, onClick, style, size="md", title, ...rest }) => {
  const pad = size==="sm" ? "6px 12px" : size==="lg" ? "11px 20px" : "9px 16px";
  const fs = size==="sm" ? 11 : 12;
  const v = {
    primary:{ background:C.brand, color:"#fff", border:`1px solid ${C.brand}` },
    dark:   { background:C.text1, color:"#fff", border:`1px solid ${C.text1}` },
    ghost:  { background:"var(--c-surface, #fff)", color:C.text3, border:`1.5px solid ${C.inputBorder}` },
    soft:   { background:C.brandBg, color:C.brandDark, border:"1px solid transparent" },
    danger: { background:"var(--c-surface, #fff)", color:C.redDark, border:`1.5px solid ${C.redBg}` },
  }[kind];
  return <button onClick={onClick} title={title} style={{ fontFamily:"'DM Sans'", fontSize:fs, fontWeight:600, borderRadius:10, padding:pad, cursor:"pointer", display:"inline-flex", alignItems:"center", gap:7, whiteSpace:"nowrap", transition:"all .14s", lineHeight:1, ...v, ...style }} {...rest}>{icon}{children}</button>;
};

const IconBtn = ({ children, onClick, title, danger, style }) => (
  <button onClick={onClick} title={title} style={{ width:30, height:30, border:"none", background:"transparent", borderRadius:7, cursor:"pointer", color:danger?C.redDark:C.text4, display:"flex", alignItems:"center", justifyContent:"center", ...style }}>{children}</button>
);

const Sec = ({ children, style }) => <div style={{ fontSize:13, textTransform:"uppercase", letterSpacing:".1em", color:C.muted, fontWeight:700, ...style }}>{children}</div>;

const Toggle = ({ value, onChange, size="md" }) => {
  const w = size==="sm" ? 32:38, h = size==="sm" ? 18:20, k = h-4;
  return <div onClick={() => onChange && onChange(!value)} style={{ width:w, height:h, borderRadius:99, background:value?C.brandBright:"var(--c-borderStrong, #D5D5D0)", position:"relative", cursor:"pointer", transition:"background .2s", flexShrink:0 }}>
    <div style={{ width:k, height:k, borderRadius:"50%", background:"var(--c-surface, #fff)", position:"absolute", top:2, left:value?w-k-2:2, transition:"left .18s", boxShadow:"0 1px 3px rgba(0,0,0,.2)" }}/>
  </div>;
};

const Input = ({ style, ...p }) => <input {...p} style={{ width:"100%", padding:"8px 11px", border:`1.5px solid ${C.inputBorder}`, borderRadius:8, fontSize:15, fontFamily:"'DM Sans'", outline:"none", background:"var(--c-surface, #fff)", color:C.text1, ...style }}/>;
const Textarea = ({ style, ...p }) => <textarea {...p} style={{ width:"100%", padding:"9px 11px", border:`1.5px solid ${C.inputBorder}`, borderRadius:8, fontSize:15, fontFamily:"'DM Sans'", outline:"none", background:"var(--c-surface, #fff)", color:C.text1, lineHeight:1.5, resize:"vertical", ...style }}/>;

// Textarea with a Word-like B/I/U toolbar. Wraps selection in WhatsApp
// markers (`*`, `_`, `~`); with no selection, inserts the markers and parks
// the cursor between them so the next typed characters land inside the wrap.
// NOTE: WhatsApp's `~` renders as strikethrough — there is no native underline
// syntax in WhatsApp markdown; this is the closest available marker.
const FormatTextarea = ({ value, onChange, style, ...p }) => {
  const taRef = React.useRef(null);
  const apply = (marker) => {
    const ta = taRef.current;
    if (!ta) return;
    const v = value || "";
    const s = ta.selectionStart ?? v.length;
    const e = ta.selectionEnd ?? v.length;
    const nv = v.slice(0, s) + marker + v.slice(s, e) + marker + v.slice(e);
    const ns = s + marker.length;
    const ne = e + marker.length;
    onChange({ target: { value: nv } });
    requestAnimationFrame(() => {
      ta.focus();
      try { ta.setSelectionRange(ns, ne); } catch {}
    });
  };
  const TBtn = ({ marker, label, sx, title }) => (
    <button type="button" title={title}
      onMouseDown={(ev)=>ev.preventDefault()}
      onClick={()=>apply(marker)}
      style={{ width:26, height:24, border:`1px solid ${C.inputBorder}`, borderRadius:6, background:"var(--c-surface, #fff)", color:C.text1, fontFamily:"'DM Sans'", fontSize:15, cursor:"pointer", display:"inline-flex", alignItems:"center", justifyContent:"center", ...sx }}>
      {label}
    </button>
  );
  const insertVar = (k) => {
    const ta = taRef.current;
    const v = value || "";
    const s = ta && typeof ta.selectionStart === "number" ? ta.selectionStart : v.length;
    const e = ta && typeof ta.selectionEnd === "number" ? ta.selectionEnd : v.length;
    const token = `{{${k}}}`;
    const nv = v.slice(0, s) + token + v.slice(e);
    onChange({ target: { value: nv } });
    if (ta) {
      const np = s + token.length;
      requestAnimationFrame(() => { try { ta.focus(); ta.setSelectionRange(np, np); } catch {} });
    }
  };
  return (
    <div>
      <div style={{ display:"flex", gap:4, marginBottom:6, alignItems:"center" }}>
        <TBtn marker="*" label="B" title="Bold — wraps selection in *text*" sx={{ fontWeight:700 }}/>
        <TBtn marker="_" label="I" title="Italic — wraps selection in _text_" sx={{ fontStyle:"italic" }}/>
        <TBtn marker="~" label="U" title="Underline — uses ~text~ (WhatsApp renders this as strikethrough; no native underline)" sx={{ textDecoration:"underline" }}/>
        <span style={{ marginLeft:"auto" }}>
          <VarPickerButton onInsert={insertVar}/>
        </span>
      </div>
      <textarea ref={taRef} value={value || ""} onChange={onChange}
        style={{ width:"100%", padding:"9px 11px", border:`1.5px solid ${C.inputBorder}`, borderRadius:8, fontSize:15, fontFamily:"'DM Sans'", outline:"none", background:"var(--c-surface, #fff)", color:C.text1, lineHeight:1.5, resize:"vertical", ...style }}
        {...p}/>
    </div>
  );
};
const Select = ({ style, children, ...p }) => <select {...p} style={{ width:"100%", padding:"7px 9px", border:`1.5px solid ${C.inputBorder}`, borderRadius:8, fontSize:15, fontFamily:"'DM Sans'", outline:"none", background:"var(--c-surface, #fff)", color:C.text1, ...style }}>{children}</select>;

// ─── Variable picker (Insert {{key}} into any text input) ──────────────────
// React Context lets the settings panel pass nodes+edges+currentNodeId once
// and every nested VarInput/VarTextarea/FormatTextarea reads from it.
const VarContext = React.createContext({ nodes: [], edges: [], currentNodeId: null });

// Built-in variables that the engine's resolveVariables always knows about.
// ⚠ Every key here must exist in the engine's `resolveVariables` lookup
// (backend/src/engine/automationEngine.js). An unknown token is left in the
// message as literal braces — the customer receives "{{whatever}}".
const BUILTIN_VARS = [
  { key: "name",           description: "Full contact name" },
  { key: "first_name",     description: "First word of the name" },
  { key: "phone",          description: "Contact phone number" },
  { key: "contact_number", description: "Contact phone number (alias)" },
  { key: "answer",         description: "What the customer just sent — their reply to an Ask step" },
  { key: "last_message",   description: "The customer's latest message (same value as answer)" },
];


// Small "{x}" button that opens a dropdown of available variables and
// calls onInsert(varKey) when one is picked.
const VarPickerButton = ({ onInsert, style }) => {
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const close = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const pick = (k) => { onInsert(k); setOpen(false); };
  const Row = (v) => (
    <button key={v.key} type="button" onClick={()=>pick(v.key)}
      style={{ display:"block", width:"100%", textAlign:"left", padding:"7px 11px", border:"none", background:"transparent", cursor:"pointer", fontSize:14 }}
      onMouseEnter={(e)=>e.currentTarget.style.background=C.sectionBg}
      onMouseLeave={(e)=>e.currentTarget.style.background="transparent"}>
      <span style={{ fontFamily:"'DM Mono'", color:C.brandDark, fontWeight:700 }}>{`{{${v.key}}}`}</span>
      {(v.description || v.label) && <span style={{ marginLeft:8, color:C.text5 }}>{v.description || v.label}</span>}
    </button>
  );
  return (
    <span ref={wrapRef} style={{ position:"relative", display:"inline-flex", ...style }}>
      <button
        type="button"
        title="Insert a variable"
        onMouseDown={(e)=>e.preventDefault()}
        onClick={()=>setOpen(o=>!o)}
        style={{ height:24, padding:"0 8px", border:`1px solid ${C.inputBorder}`, borderRadius:6, background:"var(--c-surface, #fff)", color:C.text1, fontFamily:"'DM Mono'", fontSize:14, cursor:"pointer", display:"inline-flex", alignItems:"center", gap:3, fontWeight:700 }}>
        {"{x}"}
      </button>
      {open && (
        <div style={{ position:"absolute", top:28, right:0, zIndex:50, minWidth:240, maxHeight:320, overflowY:"auto", background:"var(--c-surface, #fff)", border:`1px solid ${C.cardBorder}`, borderRadius:8, boxShadow:C.shadowLg || "0 8px 24px rgba(0,0,0,.12)", fontFamily:"'DM Sans'" }}>
          <div style={{ padding:"7px 11px", fontSize:13, fontWeight:700, color:C.text5, textTransform:"uppercase", letterSpacing:".06em", borderBottom:`1px solid ${C.cardBorder}` }}>Built-in</div>
          {BUILTIN_VARS.map(Row)}
        </div>
      )}
    </span>
  );
};

// Insert {{key}} at the cursor of `inputRef`'s current input/textarea, then
// call onChange with the synthesized event. Used by VarInput and VarTextarea.
function _insertVarAtCursor(inputRef, value, onChange, key) {
  const el = inputRef.current;
  const v = String(value || "");
  const token = `{{${key}}}`;
  const s = el && typeof el.selectionStart === "number" ? el.selectionStart : v.length;
  const e = el && typeof el.selectionEnd === "number" ? el.selectionEnd : v.length;
  const nv = v.slice(0, s) + token + v.slice(e);
  onChange({ target: { value: nv } });
  if (el) {
    const np = s + token.length;
    requestAnimationFrame(() => { try { el.focus(); el.setSelectionRange(np, np); } catch {} });
  }
}

// Single-line input with a built-in variable picker button on the right.
const VarInput = ({ value, onChange, style, pickerStyle, ...p }) => {
  const ref = React.useRef(null);
  return (
    <div style={{ display:"flex", alignItems:"stretch", gap:6 }}>
      <input ref={ref} value={value ?? ""} onChange={onChange}
        style={{ flex:1, padding:"8px 11px", border:`1.5px solid ${C.inputBorder}`, borderRadius:8, fontSize:15, fontFamily:"'DM Sans'", outline:"none", background:"var(--c-surface, #fff)", color:C.text1, ...style }}
        {...p}/>
      <VarPickerButton onInsert={(k)=>_insertVarAtCursor(ref, value, onChange, k)} style={pickerStyle}/>
    </div>
  );
};

// Multi-line textarea with the variable picker button parked top-right.
const VarTextarea = ({ value, onChange, style, ...p }) => {
  const ref = React.useRef(null);
  return (
    <div style={{ position:"relative" }}>
      <div style={{ position:"absolute", top:6, right:6, zIndex:2 }}>
        <VarPickerButton onInsert={(k)=>_insertVarAtCursor(ref, value, onChange, k)}/>
      </div>
      <textarea ref={ref} value={value ?? ""} onChange={onChange}
        style={{ width:"100%", padding:"9px 38px 9px 11px", border:`1.5px solid ${C.inputBorder}`, borderRadius:8, fontSize:15, fontFamily:"'DM Sans'", outline:"none", background:"var(--c-surface, #fff)", color:C.text1, lineHeight:1.5, resize:"vertical", ...style }}
        {...p}/>
    </div>
  );
};

const Field = ({ label, hint, children, style }) => (
  <div style={{ marginBottom:13, ...style }}>
    {label && <div style={{ fontSize:14, fontWeight:600, color:C.text3, marginBottom:5, fontFamily:"'DM Sans'" }}>{label}</div>}
    {children}
    {hint && <div style={{ fontSize:13, color:C.text5, marginTop:4, fontWeight:500 }}>{hint}</div>}
  </div>
);

const Pill = ({ active, children, onClick, color=C.brand, bg=C.brandBg, textDark=C.brandDark }) => (
  <button onClick={onClick} style={{
    fontSize:14, padding:"5px 11px", borderRadius:99,
    border:active?`1.5px solid ${color}`:`1.5px solid ${C.inputBorder}`,
    background:active?bg:"transparent",
    color:active?textDark:C.text4,
    fontFamily:"'DM Sans'", fontWeight:600, cursor:"pointer", whiteSpace:"nowrap",
  }}>{children}</button>
);

const Chip = ({ children, onClick }) => (
  <button onClick={onClick} style={{ fontSize:13, padding:"4px 9px", borderRadius:99, border:`1.5px solid ${C.inputBorder}`, background:"var(--c-surface, #fff)", color:C.text3, fontFamily:"'DM Mono'", fontWeight:500, cursor:"pointer" }}>{children}</button>
);

const Alert = ({ kind, children, style }) => {
  const m = {
    info:{bg:C.blueBg,color:C.blue,border:C.blueBorder,icon:IC.warn(13)},
    warn:{bg:C.orangeBg,color:C.orangeText,border:C.orangeBorder,icon:IC.warn(13)},
    error:{bg:C.redBg,color:C.redDark,border:"#F4C9C9",icon:IC.err(13)},
    ok:{bg:C.brandBg,color:C.brandDark,border:C.brandBright,icon:IC.ok(13)},
  }[kind];
  return <div style={{ background:m.bg, border:`1px solid ${m.border}`, borderRadius:10, padding:"9px 11px", display:"flex", gap:9, alignItems:"flex-start", margin:"12px 0 4px", ...style }}>
    <span style={{ fontSize:15, fontWeight:700, color:m.color, lineHeight:1, marginTop:1, flexShrink:0 }}>{m.icon}</span>
    <div style={{ fontSize:14, color:m.color, lineHeight:1.55, fontWeight:500 }}>{children}</div>
  </div>;
};


/* ══════════════════════════════════════════════════════════════════════
   3) BUILDER — HERO SCREEN
   Node types, sample flow, canvas, blocks, settings, preview, toolbar
   ══════════════════════════════════════════════════════════════════════ */

const NT_FALLBACK = { bg:"var(--c-sectionBg, #F5F5F0)", border:"var(--c-cardBorder, #E5E5E0)", color:"var(--c-t3, #444)", accent:"var(--c-t3, #444)", label:"STEP", icon:IC.flow };
const NT = {
  trigger: { bg:"var(--c-dangerBg, #FCEBEB)", border:"#E8A0A0", color:"var(--c-dangerText, #A32D2D)", accent:"var(--c-s791f1f, #791F1F)", label:"TRIGGER",       icon:IC.zap },
  message: { bg:"var(--c-xfdf2f2, #FDF2F2)", border:"#E8B0B0", color:"var(--c-xb53d3d, #B53D3D)", accent:"var(--c-dangerText, #A32D2D)", label:"MESSAGE",       icon:IC.msg },
  condition:{ bg:"var(--c-xfff5f5, #FFF5F5)", border:"#F0C0C0", color:"var(--c-xc44a4a, #C44A4A)", accent:"var(--c-dangerText, #A32D2D)", label:"CONDITION",     icon:IC.branch },
  action:  { bg:"var(--c-xfaf0f0, #FAF0F0)", border:"#D8B0B0", color:"var(--c-s8b3a3a, #8B3A3A)", accent:"var(--c-dangerText, #A32D2D)", label:"ACTION",        icon:IC.tag },
  delay:   { bg:"var(--c-xfdf8f5, #FDF8F5)", border:"#E0C8B8", color:"var(--c-xa05040, #A05040)", accent:"var(--c-dangerText, #A32D2D)", label:"DELAY",         icon:IC.clock },
  api:     { bg:"var(--c-xf5ecec, #F5ECEC)", border:"#C8A0A0", color:"var(--c-x7a2a2a, #7A2A2A)", accent:"var(--c-s791f1f, #791F1F)", label:"API",           icon:IC.api },
  handoff: { bg:"var(--c-xfdf0f0, #FDF0F0)", border:"#E0B8B8", color:"var(--c-xb04040, #B04040)", accent:"var(--c-dangerText, #A32D2D)", label:"HUMAN HANDOFF", icon:IC.agent },
  ai:      { bg:"var(--c-xf8f0f0, #F8F0F0)", border:"#D0B0B0", color:"var(--c-s8b3a3a, #8B3A3A)", accent:"var(--c-dangerText, #A32D2D)", label:"AI",            icon:IC.ai },
  ai_agent:{ bg:"var(--c-xf4ecec, #F4ECEC)", border:"#C8A8A8", color:"var(--c-x7a2e2e, #7A2E2E)", accent:"var(--c-s791f1f, #791F1F)", label:"AI AGENT",      icon:IC.ai },
  subflow: { bg:"var(--c-xf0e8e8, #F0E8E8)", border:"#C0A0A0", color:"var(--c-x6a2a2a, #6A2A2A)", accent:"var(--c-s791f1f, #791F1F)", label:"SUB-FLOW",      icon:IC.flow },
};

// Geometry and the handle vocabulary now live in builder/nodeLayout.js, where
// the rows a node RENDERS are the single authority and both the handle list and
// the handle positions are derived from them. They used to be three
// hand-written switches here that had drifted from each other and from
// ExecutionFlowCanvas's fourth copy. Re-exported so existing importers
// (ExecutionFlowCanvas, the logic tests) keep working unchanged.
export {
  NODE_W, HANDLE_DOT, HANDLE_HIT, INPUT_DOT, INPUT_HIT, ROW_H, SYS_H, mediaChipFor,
  nodeH, nodeLayout, nodeRows, outputHandlesOf, handlePos, inputCY, hasSummaryPanel,
  buttonLabel, isQuickReplyButton, replyButtonsOf, listRowsOf, tapTargetsOf,
  isWaitingNode, bodyPreview, handleTone,
} from "./builder/nodeLayout.js";

export const getTriggerDisplay = (n) => {
  const tk = n.triggerKind || 'keyword';
  if (tk === 'keyword') {
    const kw = (n.keyword || '').trim();
    const mt = n.matchType || 'exact';
    const mtLabel = mt === 'contains' ? 'contains' : mt === 'starts' ? 'starts with' : 'exact';
    const dir = n.triggerDirection || 'inbound';
    const who = dir === 'outbound' ? 'you send' : dir === 'both' ? 'either side sends' : 'contact sends';
    return {
      title: kw ? `Trigger: ${kw} keyword` : 'Trigger: Keyword',
      sub: kw ? `When ${who} "${kw}" · ${mtLabel} match` : `When ${who} a specific keyword`,
    };
  }
  if (tk === 'link') {
    // Show the CODE, because it is the whole of the configuration and the only
    // thing that decides whether this trigger can ever fire.
    const code = (n.trackingCode || '').trim();
    return {
      title: 'Trigger: wa.me Link',
      sub: code ? `When the opening message contains "${code}"` : 'No tracking code set — this can never fire',
    };
  }
  if (tk === 'newContact') return { title: 'Trigger: New Contact', sub: 'First-time message from a new contact' };
  if (tk === 'anyMessage') return { title: 'Trigger: Any Message', sub: 'Fires on every inbound message' };
  if (tk === 'tagApplied') {
    const tag = n.tag || 'a tag';
    const dir = n.tagDirection === 'removed' ? 'removed from' : 'added to';
    return { title: `Trigger: Tag ${dir} contact`, sub: `When "${tag}" is ${dir} a contact` };
  }
  return { title: n.title, sub: n.sub };
};

/* outputHandlesOf / handlePos / buttonLabel / isQuickReplyButton now come from
   builder/nodeLayout.js — see the re-export block above. */

/* ── screenToWorld is defined inside the component so it can read viewportRef ── */

/* ── Auto-layout: HORIZONTAL, left to right ── */
/**
 * Columns advance in X, siblings stack in Y.
 *
 * ⚠ It was top-down until 2026-08-12, and that is what made the canvas
 * unreadable: outputs leave from the right edge at each row's own height, so a
 * node with five branches sending five edges DOWNWARDS had to fan them back
 * across the cards beneath it, and the lines crossed each other. Reading
 * left-to-right, a branch is a straight lane at its own height and two lanes
 * only meet if their subtrees genuinely overlap.
 *
 * ⚠ Siblings are packed by their SUBTREE height, not by a fixed step. A step
 * per child buries a tall branch (a menu with ten options is well over 400px)
 * under the next one — the same bug the vertical version had to fix for X.
 * Each child is given a band as tall as everything hanging off it, and is
 * centred in that band, so no two subtrees can ever occupy the same pixels.
 */
export const layoutTree = (nodes, edges) => {
  const roots = nodes.filter(n => !edges.some(e => e.to === n.id));
  if (roots.length === 0) return nodes;
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));

  const COL_GAP = 170;   // room for a branch label between two columns
  const ROW_GAP = 44;    // vertical space between two sibling subtrees

  // A node is placed once. Guarding on the way DOWN (not after recursing)
  // keeps a cycle — or a diamond where two branches rejoin — from looping
  // forever or double-counting a shared subtree's height.
  const seen = new Set();
  const childrenOf = (id) => {
    const out = [];
    edges.forEach(e => {
      if (e.from !== id || !e.to || seen.has(e.to)) return;
      const c = byId[e.to];
      if (c && !out.includes(c)) { out.push(c); seen.add(c); }
    });
    return out;
  };

  // Height of the whole subtree rooted at n, in one pass, reusing the same
  // claim set so measuring and placing agree on who owns which child.
  const measure = (n) => {
    const kids = childrenOf(n.id);
    const own = nodeH(n);
    if (!kids.length) return { n, kids: [], h: own };
    const sub = kids.map(measure);
    const stack = sub.reduce((a, k) => a + k.h, 0) + ROW_GAP * (sub.length - 1);
    return { n, kids: sub, h: Math.max(own, stack) };
  };

  const pos = {};
  // `top` is the band this subtree owns; the node itself is centred in it.
  const place = (t, x, top) => {
    pos[t.n.id] = { x, y: Math.round(top + (t.h - nodeH(t.n)) / 2) };
    let y = top;
    t.kids.forEach(k => { place(k, x + NODE_W + COL_GAP, y); y += k.h + ROW_GAP; });
  };

  let top = 60;
  roots.forEach(r => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    const t = measure(r);
    place(t, 120, top);
    top += t.h + ROW_GAP * 2;   // a second trigger starts its own band below
  });

  // ⚠ Do NOT mutate the node objects in place — they are React state. Build a
  // position map and apply it once, so a layout run produces a new array
  // rather than silently editing the array a render is already using.
  return nodes.map(n => (pos[n.id] ? { ...n, ...pos[n.id] } : n));
};

/* ── Default trigger node ── */
const defaultTriggerNode = (x, y) => ({
  id: "n1", type: "trigger", x, y,
  title: "Trigger: PRICE keyword",
  sub: "When a contact sends PRICE via WhatsApp",
  triggerKind: "keyword",
  keyword: "PRICE",
  matchType: "exact",
  caseSensitive: false,
});

/* ── Factory for new nodes ── */
export const makeNode = (type, x, y, id, templates) => {
  const defs = {
    trigger:    { title:"Trigger", sub:"When a condition is met" },
    message:    { title:"Message", sub:"Send a WhatsApp template" },
    condition:  { title:"Condition", sub:"Check contact data or message" },
    action:     { title:"Action", sub:"Run one or more actions" },
    delay:      { title:"Delay", sub:"Wait before next step" },
    api:        { title:"API call", sub:"Send data to external system" },
    handoff:    { title:"Human handoff", sub:"Assign to a user" },
    ai:         { title:"AI step", sub:"Let AI generate a response" },
    ai_agent:   { title:"AI Agent", sub:"Reasoning agent with model & tools" },
    subflow:    { title:"Sub-flow", sub:"Run another automation" },
  }[type] || { title: type, sub: "" };
  const base = { id, type, x, y, title: defs.title, sub: defs.sub };
  if (type === "trigger") return { ...base, triggerKind: "keyword", keyword: "", matchType: "exact", caseSensitive: false };
  if (type === "message") return { ...base, templateId: "", bindings: {}, messageMode: "template", directType: "text", directData: { body: "" } };
  if (type === "condition") return { ...base, matchMode: "all", rules: [] };
  if (type === "action") return { ...base, actions: [] };
  if (type === "delay") return { ...base, delayMode: "duration", waitValue: "10", waitUnit: "minutes", useContactTz: false };
  if (type === "api") return { ...base, method: "POST", apiUrl: "", headers: [], body: "", onError: "continue", saveResponsePath: "", saveResponseField: "" };
  if (type === "ai") return { ...base, aiTask: "lead_qualification", aiGoal: "", aiContext: "", aiModelRef: null, aiFallback: "fallback_message", fallbackTemplateId: "" };
  if (type === "ai_agent") return { ...base, systemPrompt: "", agentContext: "", modelRef: null, toolRefs: [] };
  if (type === "subflow") return { ...base, flowId: "", waitMode: "await" };
  return base;
};

/* ── Trigger kinds ──
   THE authority for what a trigger can be. Both the block library's Triggers
   group and the settings panel read this one array, so a kind can never exist
   in the library with no way to configure it.

   That is not hypothetical: until now the panel had no `trigger` branch at all,
   so every trigger fell through to the generic "uses default settings" card and
   `keyword` / `matchType` / `trackingCode` / `tag` were fixed forever at
   whatever the library item happened to seed. The keyword trigger shipped
   hardcoded to "PRICE", and the wa.me-link trigger read a `trackingCode` that
   nothing on earth could set — so it could never fire.

   Every field listed here is one the ENGINE actually evaluates; see
   backend/src/engine/automationEngine.js `evaluateTriggers` (keyword / link /
   newContact / anyMessage) and `fireTagAppliedTriggers` (tagApplied). Do not
   add a field here that the engine does not read — that is a control which
   silently does nothing. */
const TRIGGER_KINDS = [
  { kind:"keyword", libName:"Keyword Trigger", label:"Keyword", icon:IC.zap, desc:"User sends a keyword",
    // Deliberately BLANK, not "PRICE". An empty keyword can never match, and
    // flowValidator blocks activation until one is typed — so the author is
    // asked once, instead of shipping somebody else's placeholder word live.
    defaults:{ keyword:"", matchType:"exact", caseSensitive:false, triggerDirection:"inbound" } },
  { kind:"link", libName:"WhatsApp Link", label:"wa.me Link", icon:IC.link, desc:"wa.me link clicked",
    defaults:{ trackingCode:"" } },
  { kind:"newContact", libName:"New Contact", label:"New Contact", icon:IC.user, desc:"New contact created",
    defaults:{} },
  { kind:"anyMessage", libName:"Inbound Message", label:"Any Message", icon:IC.msg, desc:"Any new message",
    defaults:{} },
  { kind:"tagApplied", libName:"Tag Applied", label:"Tag Applied", icon:IC.tag, desc:"Tag added to contact",
    defaults:{ tag:"", tagDirection:"added", fireOncePerTag:true } },
];
const findTriggerKind = (k) => TRIGGER_KINDS.find(t => t.kind === k) || TRIGGER_KINDS[0];

/* ── Action kinds ── */
const ACTION_KINDS = [
  { kind:"Assign to BDA",       icon:IC.agent,    valueType:"bdaUser", emptyText:"Choose a BDA Sales user" },
  // A funnel stage is NOT a tag. It drives the funnel chart, conversion maths,
  // the cold-drop engine, follow-up enrolment and the ad-conversion dispatchers.
  // Its own action, so it is findable and cannot be mistaken for a label.
  { kind:"Set Funnel Stage",   icon:IC.branch,   valueType:"funnelStage", emptyText:"Choose a funnel stage" },
  // Stores an answer on the LEAD — the record of the person, which is where a
  // typed reply belongs now that contact custom fields are gone. Carries a
  // `field` alongside `value` rather than packing both into one string: a
  // delimiter would break the first time a customer's answer contained it.
  { kind:"Set Lead Field",     icon:IC.user,     valueType:"leadField", emptyText:"Choose a field to fill" },
  { kind:"Add Tag",            icon:IC.tag,      valueType:"tag",     emptyText:"Choose a tag" },
  { kind:"Remove Tag",         icon:IC.tag,      valueType:"tag",     emptyText:"Choose a tag" },
  { kind:"Send Email",         icon:IC.mail,     valueType:"emailGmail", emptyText:"to@example.com | Subject | Body", placeholder:"to@example.com | Subject | Body — sent via connected Gmail" },
  { kind:"Append to Google Sheet", icon:IC.cog,  valueType:"text",    emptyText:"spreadsheetId | Sheet1!A:Z | val1, val2", placeholder:"1abc...XYZ | Sheet1!A:Z | {{name}}, {{phone}}, {{contact_number}}" },
  { kind:"Create Calendar Event",  icon:IC.cog,  valueType:"text",    emptyText:"primary | Title | startISO | endISO | description", placeholder:"primary | Demo with {{name}} | 2026-05-30T14:00:00+05:30 | 2026-05-30T14:30:00+05:30 | Phone {{contact_number}}" },
];
const findAction = (kind) => ACTION_KINDS.find(a => a.kind === kind) || ACTION_KINDS[0];

const DIRECT_MSG_TYPES = [
  { key:"text",        label:"Text Message",      fields:["body"] },
  { key:"image",       label:"Image Message",     fields:["url","caption"] },
  { key:"video",       label:"Video Message",     fields:["url","caption"] },
  { key:"audio",       label:"Audio Message",     fields:["url"] },
  { key:"document",    label:"Document / PDF",    fields:["url","caption","filename"] },
  { key:"contact",     label:"Contact Card",      fields:["name","phone"] },
  { key:"quick_reply", label:"Quick Reply",       fields:["body","buttons"] },
  { key:"list",        label:"List Message",      fields:["body","button_text","sections"] },
  { key:"cta_url",     label:"Call-to-action Link", fields:["body","button_text","url"] },
  { key:"dynamic_api", label:"Dynamic API Msg",   fields:["endpoint","method","headers","body"] },
];
const DIRECT_MSG_LABELS = Object.fromEntries(DIRECT_MSG_TYPES.map(t => [t.key, t.label]));
const DIRECT_MSG_MAP = Object.fromEntries(DIRECT_MSG_TYPES.map(t => [t.key, t]));

/* ── Condition sources ── */
// Sources the engine's getFieldValue actually evaluates.
const CONDITION_SOURCES = [
  { id:"system", label:"System fields" },
  { id:"tags",   label:"Tags" },
  { id:"bot",    label:"AI / Bot output" },
  { id:"time",   label:"Time" },
];
// System fields the engine resolves directly.
const WA_SYSTEM_FIELDS = ["name","phone","last_message"];
const GENERAL_FIELDS = ["city","state","pincode","budget","timeline","bhk_type","source","notes"];
// Operator strings MUST match the engine's evaluateRule() switch exactly.
const OPERATORS = ["equals","not equals","contains","not contains","starts with","ends with","is empty","is not empty","greater than","less than","has tag","not has tag","is true","is false"];
const WA_CONDITION_PRESETS = [
  { source:"time",   field:"Current time", op:"equals", value:"business", label:"During business hours" },
  { source:"bot",    field:"last_intent", op:"equals", value:"pricing", label:"AI detected intent: pricing" },
  { source:"custom", field:"city", op:"equals", value:"Chennai", label:"City is Chennai" },
];


/* ── Interactive FlowNode with input/output handles ── */
const FlowNode = ({ n, selected, isDropTarget, onSelect, onStartDrag, onStartConnect, onPickAgentResource, whatsappAccounts=[], wiredHandles, onRowClick, whatsappTemplates=[] }) => {
  const [hoverHandle, setHoverHandle] = React.useState(null);
  // A removed node type can still exist in a saved config; without the
  // fallback `t.bg` throws during render and blanks the whole app.
  const t = NT[n.type] || NT_FALLBACK;
  const h = nodeH(n);
  const isCondition = n.type === "condition";
  const isAction = n.type === "action";
  const isDisabled = !!n.disabled;
  const SEL = "#A32D2D";
  const DROP = "#1D9E75";
  return (
    <div
      data-testid="flow-node"
      data-node-card
      data-node-id={n.id}
      onMouseDown={(e) => { e.stopPropagation(); onStartDrag(e, n.id); }}
      onClick={(e) => { e.stopPropagation(); onSelect(n.id); }}
      style={{
        position:"absolute", left:n.x, top:n.y, width:NODE_W, minHeight:h,
        // ONE surface. The card used to open with a 3px accent bar in a second
        // colour, which read as two stacked shapes rather than one block and
        // made a row of nodes look striped. Separation from the canvas now
        // comes from a soft shadow and a hairline, not from a coloured lining.
        background:"var(--c-surface, #fff)",
        // A REAL hairline, not the near-invisible --c-border: on the tinted
        // canvas the card edge disappeared into the background. borderStrong
        // is the one border token with contrast against the surface in BOTH
        // themes (#D5D5D0 light / #3A3A3A dark).
        // A node's edge is STRUCTURE, so it gets its own token and 2px. At
        // 1.5px in borderStrong (#D5D5D0 — a table-divider grey) the cards
        // dissolved into the tinted canvas. Selected/drop states go to 2.5px
        // so they still read as a state ON TOP of the new resting weight,
        // rather than matching it.
        border: isDropTarget ? `2.5px solid ${DROP}` : selected ? `2.5px solid ${SEL}` : `2px solid ${isDisabled ? C.cardBorder : "var(--c-nodeBorder, #B4B3AA)"}`,
        // A chat bubble's geometry: square-ish at the top-left where the tail
        // would be — which is also where the inbound connector now lands — and
        // fully rounded elsewhere. This is what makes a step read as a message
        // rather than a box.
        borderRadius:"5px 16px 16px 16px",
        boxShadow: isDropTarget
          ? "0 0 0 4px rgba(29,158,117,.20), 0 12px 30px rgba(0,0,0,.13)"
          : selected
            ? "0 0 0 4px rgba(163,45,45,.10), 0 12px 30px rgba(0,0,0,.12)"
            : "0 2px 5px rgba(16,24,20,.055), 0 8px 20px rgba(16,24,20,.055)",
        cursor:"grab", userSelect:"none", fontFamily:"'DM Sans'", overflow:"visible",
        opacity: isDisabled ? 0.55 : 1,
        filter: isDisabled ? "grayscale(0.6)" : "none",
      }}
    >
      {isDisabled && (
        <div style={{
          position:"absolute", top:-9, right:8, zIndex:6,
          background:"var(--c-surface, #fff)", color:"var(--c-t4, #666)", border:`1px solid ${C.cardBorder}`,
          fontSize:13, fontWeight:700, padding:"2px 8px", borderRadius:99,
          letterSpacing:".1em", textTransform:"uppercase",
          boxShadow:"0 1px 3px rgba(0,0,0,.08)",
        }}>Disabled</div>
      )}
      {isAction ? (
        <div data-node-head style={{ padding:"12px 13px 9px", display:"flex", alignItems:"flex-start", gap:10 }}>
          <div style={{ width:32, height:32, borderRadius:9, background:t.bg, color:t.accent, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{IC.tag(16)}</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:12, fontWeight:800, letterSpacing:".12em", textTransform:"uppercase", color:t.accent, marginBottom:3 }}>{t.label}</div>
            <div style={{ fontSize:15, fontWeight:700, color:C.text1, lineHeight:1.3, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{n.title || "Actions"}</div>
            <div style={{ fontSize:14, color:C.text4, fontWeight:500, marginTop:3, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {(n.actions || []).length > 0 ? `${(n.actions || []).length} action${(n.actions || []).length===1?"":"s"}` : "Click to configure"}
            </div>
          </div>
          {n.warn && <div title="Compliance warning" style={{ color:C.orange, flexShrink:0, paddingTop:2 }}>{IC.warn(14)}</div>}
          {(n.error || (isCondition && (!n.rules || n.rules.length === 0))) && <div title="Set up rules to complete this condition" style={{ color:C.red, flexShrink:0, paddingTop:2 }}>{IC.err(14)}</div>}
          {n.approved && <div title="Template approved" style={{ color:C.red, flexShrink:0, paddingTop:2 }}>{IC.ok(14)}</div>}
          {n.type === "message" && n.waitForReply && (
            <div title={`Pauses here, waits up to ${n.waitTimeoutHours || 24}h for customer's reply`} style={{ color:C.muted, flexShrink:0, paddingTop:2 }}>
              {IC.clock(14)}
            </div>
          )}
        </div>
      ) : (
        <div data-node-head style={{ padding:"12px 13px 9px", display:"flex", alignItems:"flex-start", gap:10 }}>
          <div style={{ width:32, height:32, borderRadius:9, background:t.bg, color:t.accent, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{t.icon(16)}</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:12, fontWeight:800, letterSpacing:".12em", textTransform:"uppercase", color:t.accent, marginBottom:3 }}>{t.label}</div>
            <div style={{ fontSize:15, fontWeight:700, color:C.text1, lineHeight:1.3, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {n.type === 'trigger' ? getTriggerDisplay(n).title : n.title}
            </div>
            <div style={{ fontSize:14, color:C.text4, fontWeight:500, marginTop:3, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {n.type === "message" && n.messageMode === "direct" ? (DIRECT_MSG_LABELS[n.directType] || "Direct message")
               : n.type === 'trigger' ? getTriggerDisplay(n).sub
               : n.sub}
            </div>
            {n.type === "message" && n.whatsappAccountId && (
              <div style={{ fontSize:13, color:C.muted, fontWeight:500, marginTop:3, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontFamily:"'DM Mono'" }}>
                via {maskPhone(whatsappAccounts.find(a => String(a.id) === String(n.whatsappAccountId))?.displayPhoneNumber) || 'custom number'}
              </div>
            )}
          </div>
          {n.warn && <div title="Compliance warning" style={{ color:C.orange, flexShrink:0, paddingTop:2 }}>{IC.warn(14)}</div>}
          {(n.error || (isCondition && (!n.rules || n.rules.length === 0))) && <div title="Set up rules to complete this condition" style={{ color:C.red, flexShrink:0, paddingTop:2 }}>{IC.err(14)}</div>}
          {n.approved && <div title="Template approved" style={{ color:C.red, flexShrink:0, paddingTop:2 }}>{IC.ok(14)}</div>}
          {n.type === "message" && n.waitForReply && (
            <div title={`Pauses here, waits up to ${n.waitTimeoutHours || 24}h for customer's reply`} style={{ color:C.muted, flexShrink:0, paddingTop:2 }}>
              {IC.clock(14)}
            </div>
          )}
        </div>
      )}

      {isCondition && (
        <div style={{ padding:"0 12px 10px", display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
          <span style={{ fontSize:13, fontWeight:700, color:C.text3, background:C.sectionBg, border:`1px solid ${C.innerBorder}`, padding:"2px 7px", borderRadius:99, letterSpacing:".06em" }}>
            {n.matchMode === "any" ? "ANY MATCH" : "ALL MATCH"}
          </span>
          <span style={{ fontSize:13, fontWeight:700, color:C.muted, background:C.sectionBg, border:`1px solid ${C.innerBorder}`, padding:"2px 7px", borderRadius:99 }}>
            {(n.rules || []).length} rule{(n.rules || []).length === 1 ? "" : "s"}
          </span>
        </div>
      )}

      {/* Input handle — triggers don't accept inbound connections.
          Doubles as a drag SOURCE: pulling up from here and releasing on a node
          above builds the same edge a forward drag would, so a connection can be
          started from either end. */}
      {/* ⚠ Positioned from inputCY(n) — the SAME function handlePos() draws every
          inbound edge endpoint from. A literal here (it used to be
          `INPUT_CY - 22`) would put the visible arrow somewhere the line does
          not actually end. */}
      {n.type !== "trigger" && (
        <div
          data-handle="input"
          data-node-id={n.id}
          className="fg-handle"
          onMouseDown={(e) => { e.stopPropagation(); onStartConnect(e, n.id, null, "reverse"); }}
          title="Drag from here to the step that should come before this one"
          style={{ position:"absolute", left:-(INPUT_HIT/2), top:inputCY(n) - INPUT_HIT/2, width:INPUT_HIT, height:INPUT_HIT, display:"flex", alignItems:"center", justifyContent:"center", background:"transparent", zIndex:6, cursor:"crosshair" }}
        >
          {/* A round dot, centred on the left edge. The old shape was a 16x30
              half-tab tucked into the top-left corner, which read as a piece of
              the card's chrome rather than as the point a line arrives at. */}
          <div className="fg-handle-dot" style={{ display:"flex", alignItems:"center", justifyContent:"center", width:INPUT_DOT, height:INPUT_DOT, borderRadius:"50%", background:"var(--c-surface, #fff)", border:`2px solid ${t.accent}`, color:t.accent, boxShadow:"0 1px 4px rgba(0,0,0,.14)", transition:"transform .12s", pointerEvents:"none" }}>
            <svg width="11" height="11" viewBox="0 0 11 11" style={{ display:"block" }}>
              <path d="M1.5 5.5 L8 5.5 M5.5 2.5 L8.5 5.5 L5.5 8.5" stroke={t.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            </svg>
          </div>
        </div>
      )}

      {/* Output handles.
          Each dot sits inside a larger TRANSPARENT grab area centred on the very
          same point, so the visible dot (and therefore handlePos(), which every
          edge endpoint is drawn from) does not move — only the clickable region
          grows. */}
      {/* ── What the customer actually sees ──────────────────────────
          A real WhatsApp bubble on the card, so you can read the message
          without opening the step. The canvas previously showed only a type
          label ("Text Message"), which told you nothing about what would be
          sent — you had to open every node to review a flow. */}
      {/* Every OTHER step gets the same bubble treatment, so the canvas reads
          as one chat rather than message cards beside plain squares. Its
          height is SUMMARY_H in nodeLayout — change one and change both, or
          the first output row lands on top of this panel. */}
      {hasSummaryPanel(n) && (
        <div style={{ padding:"0 13px 8px" }}>
          <div style={{
            background:"var(--c-surfaceInner, #F5F5F0)",
            border:`1px solid ${C.borderSubtle || C.cardBorder}`,
            borderRadius:"3px 10px 10px 10px", padding:"6px 9px",
            minHeight:34, display:"flex", alignItems:"center",
          }}>
            <div style={{
              fontSize:13, lineHeight:1.35, color:C.text3,
              display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical",
              overflow:"hidden", wordBreak:"break-word",
            }}>
              {n.type === "trigger" ? getTriggerDisplay(n).sub
                : n.type === "delay" ? `Waits ${n.waitValue || "10"} ${n.waitUnit || "minutes"} before continuing`
                : n.type === "api" ? `${String(n.method || "GET").toUpperCase()} ${n.apiUrl || "(no URL set)"}`
                : n.summary || n.sub || "Not configured yet"}
            </div>
          </div>
        </div>
      )}

      {n.type === "message" && (() => {
        const chip = mediaChipFor(n);
        const tpl = n.messageMode !== "direct" && n.templateId
          ? (whatsappTemplates || []).find(t => String(t.id) === String(n.templateId))
          : null;
        const body = bodyPreview(n) || (tpl ? String(tpl.body || "") : "");
        const empty = !body && !chip;
        return (
          <div style={{ padding:"0 13px 8px" }}>
            <div style={{
              background:"var(--c-chatIncoming, #fff)",
              border:`1px solid ${C.borderSubtle || C.cardBorder}`,
              borderRadius:"3px 10px 10px 10px", padding:"7px 9px",
              minHeight:44, display:"flex", flexDirection:"column", gap:4,
              boxShadow:"0 1px 1px rgba(0,0,0,.05)",
            }}>
              {chip && (
                <div style={{ fontSize:12, fontWeight:800, letterSpacing:".06em", textTransform:"uppercase",
                  color:C.text5, fontFamily:"'DM Mono'" }}>{chip}</div>
              )}
              <div style={{
                fontSize:13, lineHeight:1.42, color: empty ? C.text6 : C.text2,
                fontStyle: empty ? "italic" : "normal",
                display:"-webkit-box", WebkitLineClamp: chip ? 2 : 3, WebkitBoxOrient:"vertical",
                overflow:"hidden", wordBreak:"break-word",
              }}>
                {body || (n.messageMode !== "direct" && !n.templateId ? "No template chosen yet" : "Nothing to send yet")}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Output rows ──────────────────────────────────────────────
          Every branchable thing the customer can do is its own labelled row
          with its own connector at the RIGHT edge, so a wire is unambiguously
          the one belonging to the label beside it.

          This replaces anonymous dots spaced across the BOTTOM edge by
          dividing a fixed width: at three buttons their labels overlapped, at
          ten list rows they sat 22px apart, and none of them said which button
          they belonged to. Geometry comes from nodeLayout(), the same function
          handlePos() reads, so a row and its wire can never disagree. */}
      {(() => {
        const L = nodeLayout(n);
        const wired = wiredHandles || new Set();
        const rows = L.rows.map((r, idx) => {
          const isSystem = r.kind === "system";
          const isWired = r.handle && wired.has(r.handle);
          const tone = handleTone(r.handle);
          const dotColor =
            tone === "good" ? "var(--c-successText, #0F6E56)"
            : tone === "bad" ? "var(--c-dangerText, #A32D2D)"
            : tone === "warn" ? "var(--c-orangeText, #8A5A1B)"
            : tone === "muted" ? C.muted
            : t.accent;
          return (
            <div key={r.handle || `static:${r.label}`}
              data-node-row
              style={{ position:"absolute", left:0, right:0, top:r.top, height:r.h,
                display:"flex", alignItems:"center", padding:"0 12px" }}
            >
              <div
                onMouseDown={(e) => { if (r.handle && onRowClick) e.stopPropagation(); }}
                onClick={(e) => { if (r.handle && onRowClick) { e.stopPropagation(); onRowClick(e, n.id, r.handle, r.label); } }}
                title={r.handle
                  ? `Click to choose what happens next, or drag the dot to an existing step`
                  : "This button opens a link or dialler on the customer's phone — WhatsApp tells us nothing about it, so a flow cannot branch on it"}
                style={{
                  // Rows share the card's ONE surface — no pill fills, no second
                  // tone. Structure comes from a hairline between rows and from
                  // the numbering, which also keeps the card from reading as a
                  // stack of generic chips.
                  flex:1, minWidth:0, height:"100%", display:"flex", alignItems:"center", gap:9,
                  padding:"0 2px",
                  background:"transparent",
                  border:"none",
                  borderTop: idx === 0 ? "none" : `1px solid ${C.rowSep || C.divider}`,
                  fontSize: isSystem ? 13 : 15,
                  fontWeight: isSystem ? 600 : 650,
                  fontFamily: isSystem ? "'DM Mono'" : "inherit",
                  letterSpacing: isSystem ? ".03em" : 0,
                  color: isSystem ? C.text5 : (r.handle ? C.text1 : C.text5),
                  cursor: r.handle && onRowClick ? "pointer" : "default",
                  opacity: r.handle ? 1 : 0.7,
                }}
              >
                {r.kind === "button" && (
                  <span style={{ fontFamily:"'DM Mono'", fontSize:13, fontWeight:700, color:C.text5, flexShrink:0, minWidth:9 }}>
                    {r.handle ? String(parseInt(r.handle.slice(4), 10) + 1) : "\u2014"}
                  </span>
                )}
                <span style={{ flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {r.label}
                </span>
              </div>

              {r.handle && (
                <div
                  data-handle-kind="output"
                  data-handle-which={r.handle}
                  data-node-id={n.id}
                  className="fg-handle"
                  onMouseDown={(e) => { e.stopPropagation(); onStartConnect(e, n.id, r.handle, "forward"); }}
                  onClick={(e) => {
                    // A click that was not a drag opens the step picker.
                    // Dragging still works; precision is now optional.
                    if (!isWired && onRowClick) { e.stopPropagation(); onRowClick(e, n.id, r.handle, r.label); }
                  }}
                  onMouseEnter={() => setHoverHandle(r.handle)}
                  onMouseLeave={() => setHoverHandle(null)}
                  style={{ position:"absolute", right:-(HANDLE_HIT/2), top:"50%", transform:"translateY(-50%)",
                    width:HANDLE_HIT, height:Math.min(HANDLE_HIT, r.h), display:"flex", alignItems:"center",
                    justifyContent:"center", background:"transparent", zIndex:7, cursor:"crosshair" }}
                >
                  {hoverHandle === r.handle && !isWired && (
                    <span style={{ position:"absolute", left:22, top:"50%", transform:"translateY(-50%)",
                      whiteSpace:"nowrap", fontSize:12, fontWeight:700, fontFamily:"'DM Mono'",
                      letterSpacing:".04em", color:C.text4, background:"var(--c-surface, #fff)",
                      border:`1px solid ${C.cardBorder}`, borderRadius:5, padding:"2px 7px",
                      boxShadow:"0 2px 6px rgba(0,0,0,.10)", pointerEvents:"none", zIndex:9 }}>
                      Add step
                    </span>
                  )}
                  {/* A filled dot means wired, a hollow ring means declared but
                      not yet connected — so an unfinished flow is visible at a
                      glance instead of needing every node opened. */}
                  <div className="fg-handle-dot" style={{ width:HANDLE_DOT, height:HANDLE_DOT, borderRadius:"50%",
                    background: isWired ? dotColor : "var(--c-surface, #fff)",
                    border:`2px solid ${isWired ? dotColor : C.cardBorder}`,
                    boxShadow:"0 1px 2px rgba(0,0,0,.10)", transition:"transform .12s, border-color .12s",
                    pointerEvents:"none" }}/>
                </div>
              )}
            </div>
          );
        });

        // AI Agent model/tool sockets stay SIDE handles: they are click-to-pick
        // resource pickers, not conversational branches, and must never be
        // draggable connection sources.
        if (n.type === "ai_agent") {
          ["model", "tool"].forEach((h) => {
            const filled = h === "model" ? n.modelRef : (n.toolRefs?.length);
            let labelText = h === "model" ? "Model" : "Tool";
            if (h === "model" && n.modelRef?.label) labelText = n.modelRef.label;
            if (h === "tool" && Array.isArray(n.toolRefs) && n.toolRefs.length) {
              labelText = n.toolRefs.length === 1 ? n.toolRefs[0].label : `${n.toolRefs.length} tools`;
            }
            rows.push(
              <div key={h}
                data-handle-kind="output" data-handle-which={h} data-node-id={n.id}
                className="fg-handle"
                title={h === "model" ? "Choose a model" : "Choose tools"}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onPickAgentResource && onPickAgentResource(e, n.id, h); }}
                style={{ position:"absolute", ...(h === "model" ? { left:-(HANDLE_HIT/2) } : { right:-(HANDLE_HIT/2) }),
                  top:"50%", transform:"translateY(-50%)", width:HANDLE_HIT, height:HANDLE_HIT,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  background:"transparent", zIndex:7, cursor:"pointer" }}
              >
                <div className="fg-handle-dot" style={{ position:"relative", width:HANDLE_DOT, height:HANDLE_DOT, borderRadius:"50%",
                  background: filled ? NT.ai_agent.accent : "var(--c-surface, #fff)",
                  border:`2px solid ${NT.ai_agent.accent}`, boxShadow:"0 1px 2px rgba(0,0,0,.10)",
                  transition:"transform .12s, border-color .12s", pointerEvents:"none" }}>
                  <span style={{ position:"absolute", ...(h === "model" ? { right:18 } : { left:18 }), top:"50%",
                    transform:"translateY(-50%)", fontSize:13, fontWeight:700, color:NT.ai_agent.accent,
                    whiteSpace:"nowrap", fontFamily:"'DM Mono'", letterSpacing:".06em", maxWidth:90,
                    overflow:"hidden", textOverflow:"ellipsis", background:"var(--c-surface, #fff)",
                    padding:"0 3px", borderRadius:3 }}>
                    {labelText}
                  </span>
                </div>
              </div>
            );
          });
        }
        return rows;
      })()}
    </div>
  );
};


/* ── SVG connectors between nodes ── */
/**
 * Orthogonal left-to-right route: out of the source's RIGHT edge, along a
 * vertical lane, then into the target's LEFT edge — with rounded corners.
 *
 * ⚠ `lane` is what stops branches stacking on top of each other. Every edge
 * leaving one node shares the same target column in an auto-arranged flow, so
 * with a single shared mid-x they would all run down the SAME vertical line
 * and you could not tell which option led where — the exact complaint this
 * routing exists to fix. Each branch is given its own lane, indexed by the
 * source ROW, so the vertical segments sit side by side.
 *
 * A backward edge (target left of source) cannot use a mid lane at all — the
 * lane would land inside one of the cards — so it takes a wide bezier that
 * arcs clear of both.
 */
export const edgePath = (x1, y1, x2, y2, lane = 0) => {
  const STUB = 28;                 // clears the handle before the first turn
  const R = 10;                    // corner radius
  const LANE_GAP = 16;

  // Backward or barely-forward: no room between the cards for a vertical lane.
  if (x2 - x1 < STUB * 2 + 8) {
    const bow = Math.max(70, Math.abs(y2 - y1) * 0.5 + 60);
    return `M ${x1} ${y1} C ${x1 + bow} ${y1}, ${x2 - bow} ${y2}, ${x2} ${y2}`;
  }

  // The lane sits just past the source, offset per branch, and is never
  // allowed to cross into the target's stub.
  const xm = Math.min(x1 + STUB + lane * LANE_GAP, x2 - STUB);

  // Straight shot: same row, nothing to route around.
  if (Math.abs(y2 - y1) < 2) return `M ${x1} ${y1} L ${x2} ${y2}`;

  // Not enough vertical travel to fit two radii — a gentle S instead of
  // corners tighter than the radius.
  if (Math.abs(y2 - y1) < R * 2) {
    const c = Math.max(30, (x2 - x1) * 0.4);
    return `M ${x1} ${y1} C ${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}`;
  }

  const v = y2 > y1 ? 1 : -1;      // down or up the lane
  return [
    `M ${x1} ${y1}`,
    `L ${xm - R} ${y1}`,
    `Q ${xm} ${y1} ${xm} ${y1 + R * v}`,
    `L ${xm} ${y2 - R * v}`,
    `Q ${xm} ${y2} ${xm + R} ${y2}`,
    `L ${x2} ${y2}`,
  ].join(' ');
};

const edgeColorFor = (handle) => {
  switch (handleTone(handle)) {
    case 'good':  return 'var(--c-successText, #0F6E56)';
    case 'bad':   return 'var(--c-dangerText, #A32D2D)';
    case 'warn':  return 'var(--c-orangeText, #8A5A1B)';
    case 'muted': return 'var(--c-t6, #7B7B7B)';
    case 'brand': return 'var(--c-brand, #0F6E56)';
    // ⚠ NOT a border token. This drew every plain edge in borderStrong
    // (#D5D5D0), so the commonest connector on the canvas — the one from the
    // trigger to the first step — was a near-invisible hairline while the
    // branch edges, which get semantic colours, read fine. That asymmetry is
    // what "the flow lines are too thin, we cannot see them" describes.
    // (The old fallback said #9C9B92, which was not even the token's value.)
    default:      return 'var(--c-edgeLine, #8A897F)';
  }
};

const Connectors = ({ nodes, edges, ghost, onEdgeHover }) => {
  const map = Object.fromEntries(nodes.map(n=>[n.id,n]));
  return (
    <svg style={{ position:"absolute", top:0, left:0, width:"100%", height:"100%", overflow:"visible", pointerEvents:"none" }}>
      <defs>
        {/* markerWidth is in STROKE-WIDTHS, not pixels, so a 6 that looked right
            against a 2px line renders an oversized head against a 3px one.
            Sized to 5 to keep the arrow roughly the same absolute size now that
            the line is thicker. */}
        {["good","bad","warn","muted","brand","plain"].map(tone => (
          <marker key={tone} id={`arr-${tone}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill={edgeColorFor(
              tone === "good" ? "paid" : tone === "bad" ? "unpaid" : tone === "warn" ? "nomatch"
              : tone === "muted" ? "timeout" : tone === "brand" ? "btn:0" : "default")}/>
          </marker>
        ))}
        <marker id="arrGhost" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill={C.red}/>
        </marker>
      </defs>
      {edges.map((e,i)=>{
        const a=map[e.from]; const b=map[e.to]; if (!a||!b) return null;
        const p1 = handlePos(a, "output", e.fromHandle || "default");
        const p2 = handlePos(b, "input");
        const handle = e.fromHandle || "default";
        // Lane index = this branch's ROW on the source, so every edge leaving
        // one node gets its own vertical lane instead of them all sharing one.
        const lane = Math.max(0, nodeRows(a).findIndex(r => r.handle === handle));
        const d = edgePath(p1.x, p1.y, p2.x, p2.y, lane);
        const color = edgeColorFor(handle);
        // The label is read LIVE from the source node's own row, never stored on
        // the edge — a stored copy goes stale the instant the button is renamed
        // (respond.io's "Branch 1..9" problem).
        const srcRow = nodeRows(a).find(r => r.handle === handle);
        const label = handle === "default" ? "" : (srcRow ? srcRow.label : handle);
        // The pill sits just BEFORE the target's input ("how do I reach this
        // step?"), which is where the eye lands travelling left to right. When
        // the two cards are too close for it to fit, fall back to the source's
        // own stub so the label never overlaps a card.
        const roomBefore = p2.x - p1.x > 120;
        const mx = roomBefore ? p2.x - 34 : p1.x + 40;
        const my = roomBefore ? p2.y - 14 : p1.y - 13;
        const dashed = handle === "timeout";
        return <g key={i}>
          <path d={d} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round"
                strokeDasharray={dashed ? "5 4" : undefined} markerEnd={`url(#arr-${handleTone(handle)})`}/>
          <path d={d} fill="none" stroke={color} strokeWidth={18} strokeOpacity={0}
                style={{ pointerEvents:"stroke", cursor:"pointer" }}
                onMouseEnter={() => onEdgeHover && onEdgeHover(i)}
                onMouseLeave={() => onEdgeHover && onEdgeHover(null)}/>
          {/* Room test, not a magic number. The pill sits 30px above the
              target, so it needs the source row to be at least that far up —
              a fixed ">70px apart" silently swallowed every label the moment
              the cards grew taller with the message bubble. */}
          {label && (() => {
            // ⚠ The pill is sized from the TEXT, so both must come from the
            // same font size. It used to hardcode `label.length * 6.1` — the
            // per-character advance of DM Mono at 10.5px — and when the type
            // scale moved the label to 13px the text became ~28% wider than
            // the box drawn for it and spilled over the target card. Derived
            // now, so the next size change cannot reintroduce it.
            const FS = 13;
            const CHAR_W = FS * 0.6;          // DM Mono advance is 0.6em
            const PAD_X = 10;
            const MAX_W = 190;
            const maxChars = Math.floor((MAX_W - PAD_X) / CHAR_W);
            const shown = label.length > maxChars ? label.slice(0, maxChars - 1) + "\u2026" : label;
            const w = Math.min(MAX_W, PAD_X + shown.length * CHAR_W);
            const h = FS + 9;
            return (
              <g transform={`translate(${mx}, ${my})`} style={{ pointerEvents:"none" }}>
                <rect x={-w / 2} y={-h / 2} rx={6} width={w} height={h}
                      fill="var(--c-surface, #fff)" stroke={color} strokeOpacity={.35}/>
                <text x={0} y={FS * 0.36} fontSize={FS} fontWeight={700} fill={color} textAnchor="middle"
                      fontFamily="'DM Mono', monospace">
                  {shown}
                </text>
              </g>
            );
          })()}
        </g>;
      })}
      {ghost && (
        <g>
          <path d={edgePath(ghost.x1, ghost.y1, ghost.x2, ghost.y2)} stroke={C.red} strokeWidth="2.5" strokeDasharray="6 5" fill="none" markerEnd="url(#arrGhost)"/>
          {/* The dot marks the FIXED end you started from — which on a reverse
              drag is the arrow end, since the cursor is playing the source. */}
          <circle cx={ghost.reverse ? ghost.x2 : ghost.x1} cy={ghost.reverse ? ghost.y2 : ghost.y1} r="5" fill={C.brandBright}/>
        </g>
      )}
    </svg>
  );
};

const EdgePlus = ({ x, y, onClick, withConnector=false }) => (
  <div data-testid={withConnector ? "append-plus" : "edge-plus"} onClick={onClick} style={{ position:"absolute", left:x, top:y, transform:"translate(-50%,-50%)", zIndex:8, cursor:"pointer" }}>
    <div style={{ width:26, height:26, borderRadius:"50%", background:"var(--c-surface, #fff)", border:`1.5px solid ${C.red}`, color:C.red, display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, fontWeight:700, boxShadow:"0 2px 6px rgba(0,0,0,.12)", transition:"all .15s", lineHeight:1 }}>
      {IC.plus(14)}
    </div>
    {withConnector && (
      // Purely decorative stub joining this + back to the output handle on
      // its LEFT. It MUST NOT take pointer events: it reaches the handle's
      // exact centre, and because this wrapper sits at zIndex 8 (above the
      // handle's 6) it would otherwise swallow the click on the dead centre of
      // the very dot you are trying to grab.
      <div style={{ position:"absolute", top:12, left:-34, width:34, height:2, background:C.red, zIndex:-1, pointerEvents:"none" }}/>
    )}
  </div>
);

const EdgeDelete = ({ x, y, onClick }) => (
  <div data-testid="edge-delete" onClick={onClick} title="Remove this connection" style={{ position:"absolute", left:x, top:y, transform:"translate(-50%,-50%)", zIndex:8, cursor:"pointer" }}>
    <div style={{ width:24, height:24, borderRadius:"50%", background:C.redBg, border:`1.5px solid ${C.red}`, color:C.red, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, fontWeight:700, boxShadow:"0 2px 6px rgba(0,0,0,.14)", transition:"all .15s" }}>
      {IC.x(12)}
    </div>
  </div>
);

const NodeActions = ({ x, y, onDuplicate, onDelete }) => (
  <div style={{ position:"absolute", left:x, top:y, transform:"translate(-50%,-100%)", zIndex:10, display:"flex", gap:4 }}>
    <button onClick={(e)=>{e.stopPropagation(); onDuplicate();}} style={{ background:"var(--c-surface, #fff)", border:`1px solid ${C.cardBorder}`, borderRadius:7, width:28, height:28, display:"flex", alignItems:"center", justifyContent:"center", color:C.text3, cursor:"pointer", boxShadow:"0 2px 6px rgba(0,0,0,.08)" }}>{IC.copy(13)}</button>
    <button onClick={(e)=>{e.stopPropagation(); onDelete();}} style={{ background:"var(--c-surface, #fff)", border:`1px solid ${C.redBg}`, borderRadius:7, width:28, height:28, display:"flex", alignItems:"center", justifyContent:"center", color:C.red, cursor:"pointer", boxShadow:"0 2px 6px rgba(0,0,0,.08)" }}>{IC.trash(13)}</button>
  </div>
);


/* ── AI Agent resource catalogs (models & tools — placeholders) ── */
const AGENT_MODELS = [
  { id: "chatgpt", label: "ChatGPT",  hint: "OpenAI GPT models" },
  { id: "claude",  label: "Claude",   hint: "Anthropic Claude" },
  { id: "kimi",    label: "Kimi",     hint: "Moonshot Kimi" },
];
const AGENT_TOOLS = [
  { id: "gmail",         label: "Gmail",         hint: "Send / read email" },
  { id: "google_sheets", label: "Google Sheets", hint: "Read / write rows" },
  { id: "google_calendar", label: "Google Calendar", hint: "Create / fetch events" },
  { id: "slack",         label: "Slack",         hint: "Post messages" },
  { id: "notion",        label: "Notion",        hint: "Pages / databases" },
  { id: "webhook",       label: "Custom Webhook",hint: "Hit any HTTP endpoint" },
];

const AgentResourcePicker = ({ x, y, kind, selectedIds = [], onPick, onClose, modelOptions }) => {
  const pickerRef = useRef(null);
  const [pos, setPos] = useState({ x, y });
  const options = kind === "model"
    ? (Array.isArray(modelOptions) && modelOptions.length > 0 ? modelOptions : AGENT_MODELS)
    : AGENT_TOOLS;
  const multi   = kind === "tool";

  useLayoutEffect(() => {
    const el = pickerRef.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight, M = 12;
    let nx = x, ny = y;
    if (nx + rect.width > vw - M) nx = vw - rect.width - M;
    if (nx < M) nx = M;
    if (ny + rect.height > vh - M) ny = vh - rect.height - M;
    if (ny < M) ny = M;
    setPos({ x: nx, y: ny });
  }, [x, y]);

  return (
    <div ref={pickerRef} onClick={(e)=>e.stopPropagation()} style={{ position:"fixed", left:pos.x, top:pos.y, zIndex:70, background:"var(--c-surface, #fff)", border:`1px solid ${C.cardBorder}`, borderRadius:12, padding:8, boxShadow:"0 12px 36px rgba(0,0,0,.14)", width:240 }}>
      <div style={{ fontSize:13, fontWeight:700, color:C.muted, letterSpacing:".1em", textTransform:"uppercase", padding:"4px 6px 8px" }}>
        {kind === "model" ? "Choose a model" : "Choose tools"}
      </div>
      {options.map(opt => {
        const isSel = selectedIds.includes(opt.id);
        return (
          <button key={opt.id} onClick={()=>onPick(opt)} style={{
            width:"100%", padding:"8px 9px", background: isSel ? C.sectionBg : "transparent",
            border:`1px solid ${isSel ? C.cardBorder : "transparent"}`, borderRadius:8, cursor:"pointer",
            textAlign:"left", display:"flex", alignItems:"center", gap:10, fontFamily:"'DM Sans'", marginBottom:2,
          }}
            onMouseEnter={(e)=>{ if(!isSel) e.currentTarget.style.background="var(--c-xf8f7f2, #F8F7F2)"; }}
            onMouseLeave={(e)=>{ if(!isSel) e.currentTarget.style.background="transparent"; }}
          >
            <span style={{ width:26, height:26, borderRadius:7, background:NT.ai_agent.bg, color:NT.ai_agent.color, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:14, fontWeight:700 }}>
              {opt.label.slice(0,2).toUpperCase()}
            </span>
            <span style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:15, fontWeight:700, color:C.text1 }}>{opt.label}</div>
              <div style={{ fontSize:13, color:C.muted, marginTop:1 }}>{opt.hint}</div>
            </span>
            {isSel && <span style={{ color:NT.ai_agent.accent, flexShrink:0 }}>{IC.ok(14)}</span>}
          </button>
        );
      })}
      <div style={{ borderTop:`1px solid ${C.rowDiv}`, margin:"6px 0 2px" }}/>
      <button onClick={onClose} style={{ width:"100%", padding:"6px 10px", background:"transparent", border:"none", cursor:"pointer", textAlign:"center", fontSize:14, color:C.muted, fontWeight:600 }}>
        {multi ? "Done" : "Cancel"}
      </button>
    </div>
  );
};

/* ── Node Picker (add node between / append) ── */
const NodePicker = ({ x, y, onPick, onClose, mode, groups = [] }) => {
  const [q, setQ] = useState("");
  const [activeG, setActiveG] = useState(null);
  const pickerRef = useRef(null);
  const [pos, setPos] = useState({ x, y });
  const visibleGroups = groups.filter(g => g.title !== "Triggers");
  const hasSearch = q.trim().length > 0;

  useLayoutEffect(() => {
    const el = pickerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const MARGIN = 12;
    let nx = x;
    let ny = y;
    // keep inside right edge
    if (nx + rect.width > vw - MARGIN) nx = vw - rect.width - MARGIN;
    // keep inside left edge
    if (nx < MARGIN) nx = MARGIN;
    // keep inside bottom edge — if it would overflow, shift up
    if (ny + rect.height > vh - MARGIN) ny = vh - rect.height - MARGIN;
    // keep inside top edge
    if (ny < MARGIN) ny = MARGIN;
    setPos({ x: nx, y: ny });
  }, [x, y, activeG, q]);

  return (
    <div ref={pickerRef} onClick={(e) => e.stopPropagation()} style={{ position:"fixed", left:pos.x, top:pos.y, zIndex:70, background:"var(--c-surface, #fff)", border:`1px solid ${C.cardBorder}`, borderRadius:12, padding:6, boxShadow:"0 12px 36px rgba(0,0,0,.14)", width:220, maxHeight:"70vh", overflowY:"auto" }}>
      <div style={{ fontSize:13, fontWeight:700, color:C.muted, letterSpacing:".1em", textTransform:"uppercase", padding:"4px 8px 6px" }}>{mode==="append"?"Add next step":"Insert block"}</div>
      <div style={{ padding:"0 8px 6px" }}>
        <Input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search blocks…" style={{ padding:"6px 9px", fontSize:14 }}/>
      </div>
      {visibleGroups.map(g => {
        const items = g.items.filter(i => !q || i.name.toLowerCase().includes(q.toLowerCase()));
        if (!items.length) return null;
        const isOpen = hasSearch ? true : activeG === g.title;
        return (
          <div key={g.title} style={{ marginBottom:4 }}>
            <div onClick={()=>setActiveG(prev => prev === g.title ? null : g.title)} style={{ display:"flex", alignItems:"center", gap:6, padding:"5px 8px", cursor:"pointer", borderRadius:6, transition:"background .12s" }} onMouseEnter={e=>e.currentTarget.style.background="var(--c-xf8f7f2, #F8F7F2)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <span style={{ width:6, height:6, borderRadius:99, background:g.color }}/>
              <span style={{ fontSize:13, color:C.text4, fontWeight:700, letterSpacing:".08em", textTransform:"uppercase", flex:1 }}>{g.title}</span>
              <span style={{ fontSize:13, fontWeight:600, color:C.muted, background:C.sectionBg, borderRadius:99, padding:"1px 6px", minWidth:18, textAlign:"center" }}>{items.length}</span>
              <span style={{ color:C.ghost, transform:isOpen?"rotate(180deg)":"rotate(0)", transition:"transform .15s" }}>{IC.cD(10)}</span>
            </div>
            {isOpen && items.map(it => {
              const t = NT[it.type] || NT_FALLBACK;
              return (
                <button data-testid="node-picker-item" key={it.name} onClick={()=>onPick(it)} style={{
                  width:"100%", padding:"7px 9px", background:"transparent", border:"1px solid transparent", borderRadius:7, cursor:"pointer", textAlign:"left",
                  display:"flex", alignItems:"center", gap:8, fontSize:14, fontWeight:600, color:C.text2, fontFamily:"'DM Sans'",
                }}>
                  <span style={{ width:22, height:22, borderRadius:6, background:t.bg, color:t.color, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{it.icon(13)}</span>
                  <span>{it.name}</span>
                </button>
              );
            })}
          </div>
        );
      })}
      <div style={{ borderTop:`1px solid ${C.rowDiv}`, margin:"4px 0" }}/>
      <button onClick={onClose} style={{ width:"100%", padding:"6px 10px", background:"transparent", border:"none", cursor:"pointer", textAlign:"center", fontSize:14, color:C.muted, fontWeight:600 }}>Cancel</button>
    </div>
  );
};


/* ── Block Library (left sidebar of builder) ── */
const BLOCK_GROUPS = [
  // DERIVED from TRIGGER_KINDS — never a second hand-kept list. A library item
  // with no matching kind would drop something onto the canvas that the
  // settings panel cannot configure, which is the defect this whole array
  // exists to prevent.
  { title:"Triggers", color:C.brand, items: TRIGGER_KINDS.map(t => ({
    name: t.libName, type: "trigger", icon: t.icon, desc: t.desc,
    defaults: { triggerKind: t.kind, ...t.defaults },
  })) },
  // Split by the question that actually matters when building a bot: does this
  // step just SAY something, or does it ASK and then branch on the answer?
  // Every message type used to hide behind one "WhatsApp Message" block and a
  // native dropdown, so the formats WhatsApp supports were undiscoverable.
  { title:"Send", color:C.blue, items:[
    { name:"Template",      type:"message", icon:IC.tpl,  desc:"Approved template, works any time",
      defaults:{ messageMode:"template", templateId:"", title:"Template" } },
    { name:"Text",          type:"message", icon:IC.msg,  desc:"Plain message, inside the 24h window",
      defaults:{ messageMode:"direct", directType:"text", title:"Text", directData:{ body:"" } } },
    { name:"Image",         type:"message", icon:IC.img,  desc:"Photo with an optional caption",
      defaults:{ messageMode:"direct", directType:"image", title:"Image", directData:{} } },
    { name:"Video",         type:"message", icon:IC.vid,  desc:"Video with an optional caption",
      defaults:{ messageMode:"direct", directType:"video", title:"Video", directData:{} } },
    { name:"Document",      type:"message", icon:IC.doc,  desc:"PDF or file",
      defaults:{ messageMode:"direct", directType:"document", title:"Document", directData:{} } },
    { name:"Audio",         type:"message", icon:IC.send, desc:"Voice note or audio file",
      defaults:{ messageMode:"direct", directType:"audio", title:"Audio", directData:{} } },
    { name:"Contact Card",  type:"message", icon:IC.user, desc:"Share a saveable contact",
      defaults:{ messageMode:"direct", directType:"contact", title:"Contact card", directData:{} } },
    { name:"Call to Action", type:"message", icon:IC.zap, desc:"A tappable link button",
      defaults:{ messageMode:"direct", directType:"cta_url", title:"Call to action", directData:{ button_text:"Open" } } },
  ]},
  { title:"Ask", color:C.brand, items:[
    // These default waitForReply ON. An asking step with the wait off cannot
    // branch on anything, which is the commonest way to build a dead flow.
    { name:"Ask with Buttons", type:"message", icon:IC.branch, desc:"Up to 3 tappable choices",
      defaults:{ messageMode:"direct", directType:"quick_reply", title:"Ask with buttons", waitForReply:true,
        directData:{ body:"", buttons:[{ title:"Yes" }, { title:"No" }] } } },
    { name:"Ask with a List",  type:"message", icon:IC.list, desc:"A menu of up to 10 options",
      defaults:{ messageMode:"direct", directType:"list", title:"Ask with a list", waitForReply:true,
        directData:{ body:"", button_text:"Choose", sections:[{ title:"", rows:[{ title:"Option 1" }, { title:"Option 2" }] }] } } },
    { name:"Ask a Question",   type:"message", icon:IC.msg,  desc:"Free-text answer",
      defaults:{ messageMode:"direct", directType:"text", title:"Ask a question", waitForReply:true,
        directData:{ body:"" } } },
  ]},
  { title:"Logic", color:C.orange, items:[
    { name:"Condition",         type:"condition", icon:IC.branch, desc:"If / else branch",
      defaults:{ matchMode:"all", rules:[], summary:"Branch the flow based on contact data" } },
    { name:"Smart Delay",       type:"delay",     icon:IC.clock,  desc:"Wait minutes/hours/days",
      defaults:{ delayMode:"duration", waitValue:"10", waitUnit:"minutes", useContactTz:false, summary:"Pause the flow before continuing" } },
    { name:"Random Split",      type:"condition", icon:IC.branch, desc:"A/B test paths",
      defaults:{ matchMode:"random", rules:[], summary:"Send half to Matched and half to Not-matched at random" } },
  ]},
  { title:"Actions", color:"var(--c-s5b5851, #5B5851)", items:[
    { name:"Change Funnel Stage", type:"action", icon:IC.branch, desc:"Move the lead along the funnel",
      defaults:{ title:"Change funnel stage", actions:[{ kind:"Set Funnel Stage", value:"" }] } },
    { name:"Add Tag",             type:"action", icon:IC.tag,    desc:"Tag the contact",
      defaults:{ actions:[{ kind:"Add Tag", value:"" }] } },
    { name:"Remove Tag",          type:"action", icon:IC.tag,    desc:"Remove a tag",
      defaults:{ actions:[{ kind:"Remove Tag", value:"" }] } },
    { name:"Save Answer to Lead", type:"action", icon:IC.user,   desc:"Store a reply on the lead record",
      defaults:{ title:"Save answer to lead", actions:[{ kind:"Set Lead Field", field:"", value:"{{answer}}" }] } },
    { name:"Assign to BDA",       type:"action", icon:IC.agent,  desc:"Set the contact's owner to a BDA Sales user",
      defaults:{ actions:[{ kind:"Assign to BDA", value:"" }] } },
    { name:"Send Email",          type:"action", icon:IC.mail,   desc:"Email via connected Gmail",
      defaults:{ actions:[{ kind:"Send Email", value:"" }] } },
  ]},
  // REMOVED 2026-08-11 — three groups taken out of the library:
  //
  //   AI                  (ai_agent + 5 ai steps)  — agents are built in the
  //                       AI Agents section, not dropped into a flow.
  //   API & Integrations  (api)
  //   Workflows           (subflow ×3)
  //
  // ⚠ Their ENGINE HANDLERS are deliberately kept (`NODE_HANDLERS.ai`,
  // `.ai_agent`, `.api`, `.subflow`) and so are their settings panels: removing
  // them from the library stops NEW ones being added, it does not break a flow
  // that already contains one — e.g. an automation imported from another
  // instance. Verified before deleting: 0 of the 5 live automations use any of
  // these node types (they use trigger/message/action/delay only).
  //
  // ⚠ "Schedule Flow" went with Workflows and was NOT re-added under Triggers.
  // It was never a scheduled trigger — it is a subflow with waitMode:'fire',
  // i.e. "run another flow right now, detached"; the "Run a flow at a later
  // time" wording was wrong. There is no time-based trigger in the engine at
  // all: evaluateTriggers() is called from the webhook, so every trigger kind
  // can only fire in response to an inbound message. Adding a Triggers entry
  // would have shipped a control that silently never fires (anti-pattern #20).
];

const BlockLibrary = ({ onAddBlock }) => {
  // Derived from BLOCK_GROUPS, not a hand-kept copy — a group added or removed
  // above must not need a second edit here to open by default (anti-pattern #43).
  const [openG, setOpenG] = useState(() =>
    Object.fromEntries(BLOCK_GROUPS.map(g => [g.title, true])));
  const [q, setQ] = useState("");
  return (
    <aside style={{ width:236, borderRight:`1px solid ${C.cardBorder}`, background:"var(--c-surfaceInner, #FAFAF7)", display:"flex", flexDirection:"column", flexShrink:0 }}>
      <div style={{ padding:"14px 14px 10px", borderBottom:`1px solid ${C.cardBorder}` }}>
        <div style={{ fontSize:13, color:C.muted, fontWeight:700, letterSpacing:".1em", textTransform:"uppercase", marginBottom:6 }}>Block Library</div>
        <div style={{ position:"relative" }}>
          <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:C.ph }}>{IC.search(13)}</span>
          <Input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search blocks…" style={{ paddingLeft:30, padding:"7px 10px 7px 30px", fontSize:14}}/>
        </div>
        <div style={{ fontSize:13, color:C.text5, marginTop:8, lineHeight:1.4, fontWeight:500 }}>Click any block to add it to the canvas</div>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"10px 6px" }}>
        {BLOCK_GROUPS.map(g => {
          const items = g.items.filter(i => !q || i.name.toLowerCase().includes(q.toLowerCase()));
          if (!items.length) return null;
          const isOpen = openG[g.title] !== false;
          return (
            <div key={g.title} style={{ marginBottom:8 }}>
              <div onClick={()=>setOpenG({ ...openG, [g.title]: !isOpen })} style={{ display:"flex", alignItems:"center", gap:6, padding:"6px 10px", cursor:"pointer" }}>
                <span style={{ width:6, height:6, borderRadius:99, background:g.color }}/>
                <span style={{ fontSize:13, color:C.text4, fontWeight:700, letterSpacing:".08em", textTransform:"uppercase", flex:1 }}>{g.title}</span>
                <span style={{ color:C.ghost, transform:isOpen?"rotate(180deg)":"rotate(0)", transition:"transform .15s" }}>{IC.cD(10)}</span>
              </div>
              {isOpen && items.map(it => {
                const t = NT[it.type] || NT_FALLBACK;
                return (
                  <button data-testid="block-library-item" key={it.name} title={`Click to add "${it.name}" to the canvas · ${it.desc}`}
                    draggable
                    onDragStart={(e)=>{ e.dataTransfer.setData("blockType", JSON.stringify(it)); }}
                    onClick={(e)=>onAddBlock && onAddBlock(it, e)}
                    style={{ background:"var(--c-surface, #fff)", border:`1px solid ${C.cardBorder}`, borderRadius:8, padding:"7px 9px", margin:"3px 4px", cursor:"pointer", display:"flex", alignItems:"center", gap:8, transition:"all .12s", width:"calc(100% - 8px)", textAlign:"left", fontFamily:"'DM Sans'" }}>
                    <div style={{ width:22, height:22, borderRadius:6, background:t.bg, color:t.color, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{it.icon(13)}</div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:14, fontWeight:600, color:C.text2, fontFamily:"'DM Sans'" }}>{it.name}</div>
                      <div style={{ fontSize:13, color:C.text5, marginTop:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{it.desc}</div>
                    </div>
                    <span style={{ color:C.brand, opacity:0.6, flexShrink:0 }}>{IC.plus(12)}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </aside>
  );
};


/* ── Settings Panel content for each node type ── */
/**
 * WhatsApp text formatting, as the customer will actually see it.
 * *bold* _italic_ ~strike~ ```mono``` — the builder previously showed the raw
 * markers, so you could not tell whether the formatting was right until you had
 * already sent it to somebody.
 */
const renderWaText = (raw) => {
  const src = String(raw == null ? "" : raw);
  if (!src) return null;
  const out = [];
  const re = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|```[\s\S]+?```)/g;
  let last = 0, m, k = 0;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("```")) out.push(<code key={k++} style={{ fontFamily:"'DM Mono'", fontSize:"0.94em" }}>{tok.slice(3, -3)}</code>);
    else if (tok[0] === "*") out.push(<b key={k++}>{tok.slice(1, -1)}</b>);
    else if (tok[0] === "_") out.push(<i key={k++}>{tok.slice(1, -1)}</i>);
    else out.push(<s key={k++}>{tok.slice(1, -1)}</s>);
    last = m.index + tok.length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
};

/**
 * The exact bubble a send-type step produces: header, media chip, formatted
 * body, footer, and the real reply buttons or list rows underneath.
 *
 * Only templates had a preview before, so building a list or a button menu
 * meant guessing. Every Send/Ask type renders here.
 */
const StepPreview = ({ node, templates = [] }) => {
  if (!node || node.type !== "message") return null;
  const dd = node.directData || {};
  const direct = node.messageMode === "direct";
  const dt = node.directType || "text";
  const tpl = !direct && node.templateId
    ? templates.find(t => String(t.id) === String(node.templateId)) : null;

  const header = direct ? (dd.header || "") : (tpl?.header_text || "");
  const footer = direct ? (dd.footer || "") : (tpl?.footer || "");
  const body   = direct ? bodyPreview(node) : String(tpl?.body || node.templateBody || "");
  const chip   = mediaChipFor(node);

  let actions = [];
  if (direct && dt === "quick_reply") actions = (dd.buttons || []).map((b, i) => ({ label: buttonLabel(b, i) }));
  else if (direct && dt === "cta_url") actions = [{ label: dd.button_text || "Open link", link: true }];
  else if (direct && dt === "location_request") actions = [{ label: "Send location", link: true }];
  else if (!direct && Array.isArray(tpl?.buttons)) actions = tpl.buttons.map((b, i) => ({ label: buttonLabel(b, i), link: !isQuickReplyButton(b) }));

  const listRows = direct && dt === "list"
    ? (dd.sections || []).flatMap(sec => (sec.rows || []).map(r => ({ title: r.title, desc: r.description, section: sec.title })))
    : [];

  const empty = !body && !chip && actions.length === 0 && listRows.length === 0;

  return (
    <div style={{ background:"var(--c-chatWall)", borderRadius:10, padding:"12px 12px 14px",
      border:`1px solid ${C.cardBorder}` }}>
      <div style={{ fontSize:11, fontWeight:800, letterSpacing:".12em", textTransform:"uppercase",
        color:C.muted, marginBottom:8, fontFamily:"'DM Mono'" }}>What the customer sees</div>
      <div style={{ maxWidth:250 }}>
        <div style={{ background:"var(--c-chatIncoming, #fff)", borderRadius:"3px 9px 9px 9px",
          overflow:"hidden", boxShadow:"0 1px 1px rgba(0,0,0,.08)" }}>
          <div style={{ padding:"7px 9px 5px" }}>
            {chip && (
              <div style={{ fontSize:12, fontWeight:800, letterSpacing:".05em", textTransform:"uppercase",
                color:C.text5, fontFamily:"'DM Mono'", marginBottom:5 }}>{chip}</div>
            )}
            {header && <div style={{ fontSize:14, fontWeight:700, color:C.text1, marginBottom:3 }}>{renderWaText(header)}</div>}
            <div style={{ fontSize:14, lineHeight:1.45, color: empty ? C.text6 : C.text1,
              whiteSpace:"pre-wrap", wordBreak:"break-word", fontStyle: empty ? "italic" : "normal" }}>
              {empty ? "Nothing to send yet — fill in the message below." : renderWaText(body)}
            </div>
            {footer && <div style={{ fontSize:12, color:C.text6, marginTop:5 }}>{renderWaText(footer)}</div>}
            <div style={{ fontSize:11, color:C.text6, textAlign:"right", marginTop:3 }}>12:00</div>
          </div>
          {actions.length > 0 && (
            <div style={{ borderTop:`1px solid ${C.rowSep || C.divider}` }}>
              {actions.slice(0, 3).map((a, i) => (
                <div key={i} style={{ padding:"7px 9px", textAlign:"center", fontSize:13, fontWeight:600,
                  color:"#00A5F4", borderTop: i ? `1px solid ${C.rowSep || C.divider}` : "none" }}>
                  {a.link ? "\u2197 " : ""}{a.label}
                </div>
              ))}
            </div>
          )}
          {listRows.length > 0 && (
            <div style={{ borderTop:`1px solid ${C.rowSep || C.divider}`, padding:"7px 9px", textAlign:"center",
              fontSize:13, fontWeight:600, color:"#00A5F4" }}>
              {dd.button_text || "Choose"}
            </div>
          )}
        </div>
        {listRows.length > 0 && (
          <div style={{ marginTop:7, background:"var(--c-surface, #fff)", borderRadius:9, overflow:"hidden",
            border:`1px solid ${C.cardBorder}` }}>
            {listRows.slice(0, 10).map((r, i) => (
              <div key={i} style={{ padding:"7px 10px", borderTop: i ? `1px solid ${C.rowSep || C.divider}` : "none" }}>
                <div style={{ fontSize:13, fontWeight:650, color:C.text1 }}>{r.title || `Option ${i + 1}`}</div>
                {r.desc && <div style={{ fontSize:12, color:C.text5, marginTop:1 }}>{r.desc}</div>}
              </div>
            ))}
            {listRows.length > 10 && (
              <div style={{ padding:"6px 10px", fontSize:12, color:C.dangerText, fontWeight:700 }}>
                {listRows.length} options — WhatsApp allows 10
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const PreviewBubble = ({ text }) => (
  <div style={{ marginTop:10, background:C.sectionBg, border:`1px solid ${C.innerBorder}`, borderRadius:10, padding:12 }}>
    <Sec style={{ marginBottom:8 }}>Preview in WhatsApp</Sec>
    <div style={{ background:"var(--c-surface, #fff)", border:`1px solid ${C.cardBorder}`, borderRadius:"10px 10px 10px 2px", padding:"8px 11px", fontSize:14, color:C.text1, lineHeight:1.45, maxWidth:"85%" }}>
      {text}
      <div style={{ fontSize:11, color:C.muted, textAlign:"right", marginTop:4, fontFamily:"'DM Mono'", fontWeight:600 }}>10:24 AM</div>
    </div>
  </div>
);

const PreviewQR = ({ header, body, buttons }) => (
  <div style={{ marginTop:10, background:C.sectionBg, border:`1px solid ${C.innerBorder}`, borderRadius:10, padding:12 }}>
    <Sec style={{ marginBottom:8 }}>Preview in WhatsApp</Sec>
    <div style={{ background:"var(--c-surface, #fff)", border:`1px solid ${C.cardBorder}`, borderRadius:"10px 10px 10px 2px", overflow:"hidden", maxWidth:"85%" }}>
      {header && <div style={{ padding:"7px 11px 3px", fontSize:14, fontWeight:700, color:C.text1 }}>{header}</div>}
      <div style={{ padding:"0 11px 5px", fontSize:14, color:C.text2, lineHeight:1.45 }}>{body}</div>
      <div style={{ fontSize:11, color:C.muted, textAlign:"right", padding:"0 11px 5px", fontFamily:"'DM Mono'", fontWeight:600 }}>10:24 AM</div>
      <div style={{ borderTop:`1px solid ${C.rowDiv}` }}>
        {buttons.map(b=><div key={b.text} style={{ padding:"7px 12px", textAlign:"center", fontSize:14, fontWeight:600, color:C.blue, borderBottom:`1px solid ${C.rowDiv}` }}>{b.text}</div>)}
      </div>
    </div>
  </div>
);

const TemplatePreview = ({ template }) => {
  if (!template) return null;
  const samples = template.samples || {};
  const body = (template.body || '').replace(/\{\{(\d+)\}\}/g, (_, num) => {
    const val = samples[String(num)] || samples[Number(num)];
    return val || `[var ${num}]`;
  });
  const buttons = Array.isArray(template.buttons) ? template.buttons : [];
  const hasHeader = template.header_type && template.header_type !== 'NONE' && template.header_text;
  const hasFooter = !!template.footer;
  const hasButtons = buttons.length > 0;

  return (
    <div style={{ marginTop:14, marginBottom:14, background:"var(--c-chatWall)", border:`1px solid ${C.cardBorder}`, borderRadius:12, padding:"12px 10px", overflow:"hidden", position:"relative" }}>
      {/* Same wallpaper as the real chat viewer. No extra opacity here — the
          token's own SVG carries a per-theme fill-opacity, and stacking a
          second multiplier on top would wash it out to nothing. */}
      <div style={{ position:"absolute", inset:0, backgroundImage:"var(--c-chatPattern)", pointerEvents:"none" }}/>
      <Sec style={{ marginBottom:10, position:"relative", zIndex:1 }}>Template preview</Sec>
      <div style={{ position:"relative", zIndex:1 }}>
        {/* Date pill */}
        <div style={{ display:"flex", justifyContent:"center", marginBottom:8 }}>
          <span style={{ background:"var(--c-infoBg, #E1F2FA)", color:"var(--c-s3c6678, #3C6678)", fontSize:11, padding:"2px 9px", borderRadius:99, fontWeight:600 }}>TODAY</span>
        </div>
        {/* Incoming message bubble */}
        <div style={{ display:"flex", justifyContent:"flex-start", marginBottom:4 }}>
          <div style={{ background:"var(--c-surface, #fff)", borderRadius:"0 8px 8px 8px", maxWidth:"88%", fontSize:14, color:"var(--c-t1, #111)", lineHeight:1.45, overflow:"hidden", boxShadow:"0 1px 1px rgba(0,0,0,.07)" }}>
            {hasHeader && (
              <div style={{ padding:"7px 10px 3px", fontSize:14, fontWeight:700, color:C.text1, borderBottom:"1px solid #F0F0F0" }}>
                {template.header_text}
              </div>
            )}
            <div style={{ padding:"7px 10px 5px", whiteSpace:"pre-wrap" }}>{body}</div>
            {hasFooter && (
              <div style={{ padding:"0 10px 5px", fontSize:12, color:"var(--c-s667781, #667781)", fontWeight:500 }}>
                {template.footer}
              </div>
            )}
            <div style={{ fontSize:13, color:"var(--c-s667781, #667781)", textAlign:"right", padding:"0 10px 5px", fontFamily:"-apple-system, 'SF Pro Display', sans-serif", display:"flex", justifyContent:"flex-end", alignItems:"center", gap:3 }}>
              10:24 AM
            </div>
            {hasButtons && (
              <div style={{ borderTop:"1px solid #E0E0E0" }}>
                {buttons.map((btn, idx) => (
                  <div key={idx} style={{ display:"block", width:"100%", padding:"7px 9px", border:"none", borderTop: idx > 0 ? "1px solid #F0F0F0" : "none", textAlign:"center", color:"#00A5F4", fontSize:14, fontWeight:500, background:"transparent", fontFamily:"-apple-system, 'SF Pro Display', sans-serif" }}>
                    {btn.text || btn}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};


const SettingsPanel = ({ node, nodes=[], edges=[], onUpdateNode=()=>{}, onDeleteNode=()=>{}, onDuplicateNode=()=>{}, onSaveAndClose=()=>{}, onToggleDisable=()=>{}, onDeleteButton=()=>{}, onSelectTemplate=()=>{}, onCreateTemplate=()=>{}, templates=[], tags=[], leadFields=[], otherAutomations=[], whatsappAccounts=[], assignableUsers=[], aiModels=[], automationId=null }) => {
  // Real, admin-configured stages — never a hardcoded list, which would drift
  // the moment somebody renames or adds one in Funnel Settings.
  const { stages: funnelStages } = useFunnelConfig();
  // Flattened list of connected AI models, for the legacy AI node's picker.
  const aiModelOptions = [];
  (aiModels || []).forEach(cred => {
    const all = Array.isArray(cred.availableModels) ? cred.availableModels : [];
    const enabledIds = Array.isArray(cred.enabledModels) ? new Set(cred.enabledModels) : null;
    const allowed = enabledIds ? all.filter(m => enabledIds.has(m.id)) : all;
    allowed.forEach(m => aiModelOptions.push({ credentialId: cred.id, modelId: m.id, provider: cred.provider, label: `${m.id} · ${cred.label || cred.provider}` }));
  });
  const templateOptions = templates.map(t => ({ value: String(t.id), label: `${t.name} (${t.category})`, sublabel: t.lang || t.language || 'English' }));
  const [editingTitle, setEditingTitle] = useState(false);
  const [subflowSearch, setSubflowSearch] = useState("");
  const titleInputRef = useRef(null);
  useEffect(() => { setEditingTitle(false); }, [node?.id]);
  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [editingTitle]);
  const commitTitle = () => setEditingTitle(false);
  const onTitleKey = (e) => {
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      commitTitle();
    }
  };

  const tagNames = tags.map(t => t.name).filter(Boolean);

  // Hooks for message node media library — must be at top level (Rules of Hooks)
  const [mediaItems, setMediaItems] = useState([]);
  useEffect(() => {
    if (!node || node.type !== "message") { setMediaItems([]); return; }
    if (!['image','video','audio','document'].includes(node.directType)) { setMediaItems([]); return; }
    api.mediaLibrary.list().then(r => setMediaItems(r.media || [])).catch(() => setMediaItems([]));
  }, [node?.type, node?.directType]);

  if (!node) return (
    <aside style={{ width:344, borderLeft:`1px solid ${C.cardBorder}`, background:"var(--c-surface, #fff)", flexShrink:0, padding:24, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", textAlign:"center", color:C.text5 }}>
      <div style={{ width:56, height:56, borderRadius:12, background:C.sectionBg, display:"flex", alignItems:"center", justifyContent:"center", color:C.muted, marginBottom:14 }}>{IC.flow(24)}</div>
      <div style={{ fontSize:16, fontWeight:700, color:C.text2, marginBottom:6 }}>Select a block to edit</div>
      <div style={{ fontSize:15, color:C.text5, lineHeight:1.5 }}>Click any node on the canvas to configure its message body, buttons, conditions, or API behavior.</div>
    </aside>
  );
  const t = NT[node.type] || NT_FALLBACK;

  let content = null;

  if (node.type === "message") {
    const mode = node.messageMode || "template";
    const setMode = (m) => onUpdateNode(node.id, n => ({ ...n, messageMode: m }));
    const dd = node.directData || {};
    const setDirect = (patch) => onUpdateNode(node.id, n => ({ ...n, directData: { ...(n.directData || {}), ...patch } }));
    const setDirectType = (t) => onUpdateNode(node.id, n => ({ ...n, directType: t, directData: {} }));

    const tplId = node.templateId || "";
    const tpl = templates.find(t => String(t.id) === String(tplId));
    const templateButtons = tpl?.buttons || null;

    // WABA-scoped template list: a WhatsApp template only exists on the account
    // (WABA) it was approved under. Sending an account-4 template through the
    // account-1 number makes Meta reject it with #132001 ("template does not
    // exist"). So scope the picker to templates belonging to the account this
    // message will actually send from:
    //   • explicit "Send from" account → that account only
    //   • "Default (from triggering number)" → the trigger's listened accounts
    //   • trigger listens on every account → can't scope, show all
    const _digits = (s) => String(s || '').replace(/\D/g, '');
    const _scopeAccountIds = (() => {
      if (node.whatsappAccountId) return new Set([String(node.whatsappAccountId)]);
      const triggerNode = nodes.find(n => n.type === 'trigger');
      const triggerNums = Array.isArray(triggerNode?.triggerAccounts) ? triggerNode.triggerAccounts : [];
      if (triggerNums.length === 0) return null; // listens on all numbers → no scope
      const ids = whatsappAccounts
        .filter(a => triggerNums.some(tn => _digits(tn) === _digits(a.displayPhoneNumber)))
        .map(a => String(a.id));
      return ids.length ? new Set(ids) : null;
    })();
    const scopedTemplates = _scopeAccountIds
      ? templates.filter(t => t.whatsappAccountId != null && _scopeAccountIds.has(String(t.whatsappAccountId)))
      : templates;
    const scopedTemplateOptions = scopedTemplates.map(t => ({
      value: String(t.id),
      label: `${t.name} (${t.category})`,
      sublabel: t.lang || t.language || 'English',
    }));
    const scopeAccountLabel = node.whatsappAccountId
      ? (whatsappAccounts.find(a => String(a.id) === String(node.whatsappAccountId))?.displayName || 'the selected number')
      : 'the triggering number’s account';

    const TabBtn = ({ label, active, onClick }) => (
      <button onClick={onClick} style={{ flex:1, padding:"6px 0", fontSize:14, fontWeight:700, fontFamily:"'DM Sans'", borderRadius:8, border:"none", cursor:"pointer", background: active ? C.brandBg : "transparent", color: active ? C.brandDark : C.muted }}>
        {label}
      </button>
    );

    const DirectField = ({ label, type="text", value, onChange, placeholder="", hint="" }) => (
      <Field label={label} hint={hint}>
        {type === "textarea" ? (
          <Textarea value={value || ""} onChange={e => setDirect({ [label.toLowerCase().replace(/[^a-z]/g,"_")]: e.target.value })} placeholder={placeholder} style={{ fontSize:14 }}/>
        ) : (
          <Input value={value || ""} onChange={e => setDirect({ [label.toLowerCase().replace(/[^a-z]/g,"_")]: e.target.value })} placeholder={placeholder} style={{ padding:"6px 9px", fontSize:14 }}/>
        )}
      </Field>
    );

    const renderDirectFields = () => {
      const dt = node.directType || "text";
      switch (dt) {
        case "text":
          return <Field label="Message text" hint="Max 4096 characters. Insert variables with the {x} button (e.g. {{name}})."><VarTextarea value={dd.body || ""} onChange={e=>setDirect({body:e.target.value})} placeholder="Type your message…" style={{ fontSize:14 }}/></Field>;
        case "image":
        case "video":
        case "audio":
        case "document": {
          const selected = mediaItems.find(m => String(m.id) === String(dd.mediaLibraryId));
          const filtered = mediaItems.filter(m => m.mediaType === dt);
          return <>
            <Field label="Select from Media Library">
              <select
                value={dd.mediaLibraryId || ""}
                onChange={e => setDirect({ mediaLibraryId: e.target.value || null, url: '' })}
                style={{ width:'100%', padding:'6px 9px', fontSize:14, border:`1px solid ${C.inputBorder}`, borderRadius:8, fontFamily:"'DM Sans'", background:C.cardBg }}
              >
                <option value="">— Select {dt} —</option>
                {filtered.map(m => (
                  <option key={m.id} value={m.id}>{m.name || m.originalName || `Media #${m.id}`}</option>
                ))}
              </select>
            </Field>
            {selected && (
              <div style={{ marginTop:8, borderRadius:10, overflow:'hidden', border:`1px solid ${C.innerBorder}`, background:C.innerBg }}>
                {dt === 'image' ? (
                  <img src={api.mediaLibrary.downloadUrl(selected.id)} alt="" style={{ width:'100%', height:140, objectFit:'cover' }} />
                ) : dt === 'video' ? (
                  <div style={{ position:'relative', width:'100%', height:140 }}>
                    <video src={api.mediaLibrary.downloadUrl(selected.id)} style={{ width:'100%', height:'100%', objectFit:'cover' }} preload="metadata" muted />
                    <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.25)' }}>
                      <div style={{ width:40, height:40, borderRadius:'50%', background:'rgba(255,255,255,0.9)', display:'flex', alignItems:'center', justifyContent:'center' }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ padding:16, display:'flex', alignItems:'center', gap:12 }}>
                    <div style={{ width:40, height:40, borderRadius:8, background:C.brandBg, display:'flex', alignItems:'center', justifyContent:'center', color:C.brand }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    </div>
                    <div>
                      <div style={{ fontSize:15, fontWeight:600, color:C.text2 }}>{selected.name || selected.originalName}</div>
                      <div style={{ fontSize:14, color:C.muted, textTransform:'capitalize' }}>{selected.mediaType} • {selected.mimeType}</div>
                    </div>
                  </div>
                )}
              </div>
            )}
            {dt !== 'audio' && dt !== 'sticker' && <Field label="Caption (optional)"><VarTextarea value={dd.caption || ""} onChange={e=>setDirect({caption:e.target.value})} placeholder="Optional caption…" style={{ fontSize:14}}/></Field>}
            {dt === 'document' && <Field label="Filename (optional)"><VarInput value={dd.filename || ""} onChange={e=>setDirect({filename:e.target.value})} placeholder="e.g. brochure.pdf" style={{ padding:"6px 9px", fontSize:14 }}/></Field>}
          </>;
        }
        case "cta_url":
          return <>
            <Field label="Header (optional)" hint="Shown bold above the body. Max 60 characters."><VarInput value={dd.header || ""} maxLength={60} onChange={e=>setDirect({header:e.target.value})} placeholder="e.g. Your seat is ready" style={{ padding:"6px 9px", fontSize:14, fontWeight:700 }}/></Field>
            <Field label="Body text" hint="Required by Meta. Max 1024 characters."><VarTextarea value={dd.body || ""} maxLength={1024} onChange={e=>setDirect({body:e.target.value})} placeholder="Tell them what the link is for…" style={{ fontSize:14 }}/></Field>
            <Field label="Button text" hint="Max 20 characters."><VarInput value={dd.button_text || ""} maxLength={20} onChange={e=>setDirect({button_text:e.target.value})} placeholder="e.g. Book my seat" style={{ padding:"6px 9px", fontSize:14 }}/></Field>
            <Field label="Link" hint="Must start with https://"><VarInput value={dd.url || ""} onChange={e=>setDirect({url:e.target.value})} placeholder="https://forgemind.in/apply" style={{ padding:"6px 9px", fontSize:14 }}/></Field>
            <Field label="Footer (optional)" hint="Max 60 characters."><VarInput value={dd.footer || ""} maxLength={60} onChange={e=>setDirect({footer:e.target.value})} placeholder="e.g. Limited seats" style={{ padding:"6px 9px", fontSize:14 }}/></Field>
            <Alert kind="warn" style={{ marginTop:4 }}>WhatsApp does not tell us when someone taps a link button, so this step cannot branch on it. Wire the next step from "Next step".</Alert>
          </>;
        case "contact":
          return <>
            <Field label="Full name" hint="Required by Meta. Shown as the card's title."><VarInput value={dd.name || ""} onChange={e=>setDirect({name:e.target.value})} placeholder="e.g. Rahul Sharma" style={{ padding:"6px 9px", fontSize:14 }}/></Field>
            <div style={{ display:"flex", gap:8 }}>
              <Field label="First name" style={{ flex:1 }}><VarInput value={dd.first_name || ""} onChange={e=>setDirect({first_name:e.target.value})} placeholder="Rahul" style={{ padding:"6px 9px", fontSize:14 }}/></Field>
              <Field label="Last name" style={{ flex:1 }}><VarInput value={dd.last_name || ""} onChange={e=>setDirect({last_name:e.target.value})} placeholder="Sharma" style={{ padding:"6px 9px", fontSize:14 }}/></Field>
            </div>
            <Field label="Phone number" hint="Use E.164 format (e.g. +919876543210). Variables resolved at send time."><VarInput value={dd.phone || ""} onChange={e=>setDirect({phone:e.target.value})} placeholder="+91 98765 43210" style={{ padding:"6px 9px", fontSize:14 }}/></Field>
            <Field label="Phone type"><Select value={dd.phone_type || "CELL"} onChange={e=>setDirect({phone_type:e.target.value})}><option value="CELL">Cell</option><option value="HOME">Home</option><option value="WORK">Work</option><option value="MAIN">Main</option><option value="IPHONE">iPhone</option></Select></Field>
            <Field label="Email (optional)"><VarInput value={dd.email || ""} onChange={e=>setDirect({email:e.target.value})} placeholder="rahul@example.com" style={{ padding:"6px 9px", fontSize:14 }}/></Field>
            <Field label="Organization (optional)"><VarInput value={dd.org || ""} onChange={e=>setDirect({org:e.target.value})} placeholder="Company name" style={{ padding:"6px 9px", fontSize:14 }}/></Field>
            <Alert kind="info" style={{ marginTop:4 }}>Sent as a WhatsApp contact card the recipient can save to their address book.</Alert>
          </>;
        case "quick_reply":
          return <>
            <Field label="Header (optional)" hint="Shown bold above the body. Max 60 characters."><VarInput value={dd.header || ""} maxLength={60} onChange={e=>setDirect({header:e.target.value})} placeholder="e.g. Choose an option" style={{ padding:"6px 9px", fontSize:14, fontWeight:700 }}/></Field>
            <Field label="Body text" hint="Select text then click B/I/U, or click first to type inside the markers."><FormatTextarea value={dd.body || ""} onChange={e=>setDirect({body:e.target.value})} placeholder="Your message with quick reply options…" style={{ fontSize:14 }}/></Field>
            <Sec style={{ marginBottom:6 }}>Quick reply buttons</Sec>
            {(dd.buttons || []).map((btn, i) => (
              <div key={i} style={{ display:"flex", gap:6, marginBottom:6 }}>
                <Input value={btn.title || ""} onChange={e => { const b = [...(dd.buttons||[])]; b[i] = { ...b[i], title: e.target.value }; setDirect({ buttons: b }); }} placeholder={`Button ${i+1}`} style={{ flex:1, padding:"6px 9px", fontSize:14 }}/>
                <IconBtn onClick={()=>setDirect({ buttons: (dd.buttons||[]).filter((_,j)=>j!==i) })} danger>{IC.trash(12)}</IconBtn>
              </div>
            ))}
            {(dd.buttons || []).length < 3 && (
              <Btn kind="ghost" size="sm" icon={IC.plus(11)} onClick={()=>setDirect({ buttons: [...(dd.buttons||[]), { title: "" }] })}>Add button</Btn>
            )}
            <Alert kind="info" style={{ marginTop:8 }}>Up to 3 buttons. Each button creates an output handle.</Alert>
          </>;
        case "list": {
          const sectionsArr = dd.sections || [];
          const totalRows = sectionsArr.reduce((acc, s) => acc + ((s.rows || []).length), 0);
          const ROW_CAP = 10;
          const SECTION_CAP = 10;
          const atRowCap = totalRows >= ROW_CAP;
          const atSectionCap = sectionsArr.length >= SECTION_CAP;
          return <>
            <Field label="Header (optional)" hint="Shown bold above the body. Max 60 characters."><VarInput value={dd.header || ""} maxLength={60} onChange={e=>setDirect({header:e.target.value})} placeholder="e.g. Pick a category" style={{ padding:"6px 9px", fontSize:14, fontWeight:700 }}/></Field>
            <Field label="Body text" hint="Required. Select text then click B/I/U, or click first to type inside the markers."><FormatTextarea value={dd.body || ""} onChange={e=>setDirect({body:e.target.value})} placeholder="Your message before the list…" style={{ fontSize:14 }}/></Field>
            <Field label="List button text" hint="Max 20 characters."><Input value={dd.button_text || ""} maxLength={20} onChange={e=>setDirect({button_text:e.target.value})} placeholder="e.g. View options" style={{ padding:"6px 9px", fontSize:14 }}/></Field>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginTop:12, marginBottom:6 }}>
              <Sec>List sections</Sec>
              <span style={{ fontSize:13, fontFamily:"'DM Mono'", color: atRowCap ? C.red : C.muted }}>{totalRows} / {ROW_CAP} rows</span>
            </div>
            {sectionsArr.map((sec, si) => (
              <div key={si} style={{ background:C.sectionBg, border:`1px solid ${C.innerBorder}`, borderRadius:10, padding:8, marginBottom:8 }}>
                <div style={{ display:"flex", gap:6, marginBottom:6 }}>
                  <Input value={sec.title || ""} maxLength={24} onChange={e=>{ const s=[...(dd.sections||[])]; s[si]={...s[si],title:e.target.value}; setDirect({sections:s}); }} placeholder={sectionsArr.length > 1 ? "Section title (required)" : "Section title (optional)"} style={{ flex:1, padding:"6px 9px", fontSize:14 }}/>
                  <IconBtn onClick={()=>setDirect({ sections: (dd.sections||[]).filter((_,j)=>j!==si) })} danger>{IC.trash(12)}</IconBtn>
                </div>
                {(sec.rows || []).map((row, ri) => (
                  <div key={ri} style={{ display:"flex", gap:6, marginBottom:6, paddingLeft:8, flexWrap:"wrap" }}>
                    <Input value={row.title || ""} maxLength={24} onChange={e=>{ const s=[...(dd.sections||[])]; s[si].rows[ri]={...s[si].rows[ri],title:e.target.value}; setDirect({sections:s}); }} placeholder="Row title" style={{ flex:"1 1 130px", padding:"6px 9px", fontSize:14 }}/>
                    <Input value={row.id || ""} maxLength={200} onChange={e=>{ const s=[...(dd.sections||[])]; s[si].rows[ri]={...s[si].rows[ri],id:e.target.value}; setDirect({sections:s}); }} placeholder="ID (auto)" style={{ flex:"0 0 80px", padding:"6px 9px", fontSize:14 }}/>
                    <IconBtn onClick={()=>{ const s=[...(dd.sections||[])]; s[si].rows=s[si].rows.filter((_,j)=>j!==ri); setDirect({sections:s}); }} danger>{IC.trash(12)}</IconBtn>
                    <Input value={row.description || ""} maxLength={72} onChange={e=>{ const s=[...(dd.sections||[])]; s[si].rows[ri]={...s[si].rows[ri],description:e.target.value}; setDirect({sections:s}); }} placeholder="Description (optional)" style={{ flex:"1 1 100%", padding:"6px 9px", fontSize:14 }}/>
                  </div>
                ))}
                <Btn kind="ghost" size="sm" icon={IC.plus(11)} disabled={atRowCap} onClick={()=>{ if (atRowCap) return; const s=[...(dd.sections||[])]; s[si].rows=[...(s[si].rows||[]),{title:"",id:""}]; setDirect({sections:s}); }}>Add row</Btn>
              </div>
            ))}
            <Btn kind="ghost" size="sm" icon={IC.plus(11)} disabled={atSectionCap} onClick={()=>{ if (atSectionCap) return; setDirect({ sections: [...(dd.sections||[]), { title: "", rows: [] }] }); }}>Add section</Btn>
            <Alert kind="info" style={{ marginTop:8 }}>Meta caps a list at <strong>10 rows total</strong> across all sections (max 10 sections). Section title is required when you have more than one section. Each row creates an output handle.</Alert>
          </>;
        }
        case "dynamic_api":
          return <>
            <Alert kind="info" style={{ marginBottom:10 }}>Calls a third-party HTTP endpoint instead of sending through WhatsApp. The response is logged on the execution step.</Alert>
            <Field label="Endpoint URL" hint="Must start with http:// or https://. Variables like {{contact_number}} are resolved."><VarInput value={dd.endpoint || ""} onChange={e=>setDirect({endpoint:e.target.value})} placeholder="https://api.example.com/message" style={{ padding:"6px 9px", fontSize:14 }}/></Field>
            <Field label="Method"><Select value={dd.method || "POST"} onChange={e=>setDirect({method:e.target.value})}><option>POST</option><option>GET</option><option>PUT</option><option>PATCH</option><option>DELETE</option></Select></Field>
            <Field label="Headers (JSON)" hint="Optional. Must be a JSON object."><VarTextarea value={dd.headers || ""} onChange={e=>setDirect({headers:e.target.value})} placeholder='{"Authorization": "Bearer …"}' style={{ fontSize:14 }}/></Field>
            <Field label="Body template" hint="Use {{variables}} for dynamic data. JSON is validated before sending."><VarTextarea value={dd.body || ""} onChange={e=>setDirect({body:e.target.value})} placeholder='{"to": "{{contact_number}}", "text": "Hello"}' style={{ fontSize:14}}/></Field>
            <Field label="On non-2xx response"><Select value={dd.onError || "continue"} onChange={e=>setDirect({onError:e.target.value})}><option value="continue">Continue automation</option><option value="fail">Fail this step (stop walker)</option></Select></Field>
            <Alert kind="warn" style={{ marginTop:8 }}>15-second timeout. The full response (truncated to 4 KB) is captured in the execution log.</Alert>
          </>;
        default:
          return <Alert kind="warn">Select a message type above.</Alert>;
      }
    };

    content = (<>
      {/* The preview leads, because "what will they actually receive?" is the
          question you open a message step to answer. Only templates had one
          before, so building a list or a button menu meant guessing at the
          shape and the formatting until it had already been sent. */}
      <div style={{ marginBottom:14 }}>
        <StepPreview node={node} templates={templates} />
      </div>

      <div style={{ display:"flex", gap:4, background:C.sectionBg, borderRadius:10, padding:3, marginBottom:14 }}>
        <TabBtn label="Template" active={mode==="template"} onClick={()=>setMode("template")}/>
        <TabBtn label="Direct" active={mode==="direct"} onClick={()=>setMode("direct")}/>
      </div>

      <Field label="Send from" hint="Which WhatsApp number to send this message from.">
        <Select
          value={node.whatsappAccountId || ""}
          onChange={e => onUpdateNode(node.id, { whatsappAccountId: e.target.value || null })}
        >
          <option value="">— Default (from triggering number) —</option>
          {whatsappAccounts.map(a => (
            <option key={a.id} value={a.id}>
              {a.displayName} ({maskPhone(a.displayPhoneNumber)}){a.isDefault ? ' · default' : ''}
            </option>
          ))}
        </Select>
      </Field>

      {mode === "template" ? (<>
        <div style={{ background:C.blueBg, border:`1px solid #90CAF9`, borderRadius:10, padding:"10px 12px", marginBottom:14, display:"flex", alignItems:"flex-start", gap:9 }}>
          <span style={{ color:C.blue, flexShrink:0, paddingTop:1 }}>{IC.tpl(15)}</span>
          <div style={{ flex:1, fontSize:14, color:C.text2, lineHeight:1.5 }}>
            Messages are sent using <strong>Meta-approved templates only</strong>. Reply buttons, if any, are defined by the template. To create or edit a template, use WhatsApp Manager.
          </div>
        </div>

        <Field label="WhatsApp template" hint={`Only templates approved on ${scopeAccountLabel} are shown — a template can't be sent from a number it wasn't approved on.`}>
          <SearchableSelect
            value={tplId}
            onChange={(val) => onSelectTemplate(node.id, val)}
            options={scopedTemplateOptions}
            placeholder="— Select template —"
            searchPlaceholder="Search templates..."
            emptyText={_scopeAccountIds ? `No approved templates on ${scopeAccountLabel}` : 'No templates found'}
            createLabel="Create new template"
            onCreate={onCreateTemplate}
          />
        </Field>

        {tpl && _scopeAccountIds && !(tpl.whatsappAccountId != null && _scopeAccountIds.has(String(tpl.whatsappAccountId))) && (
          <div style={{ background:"var(--c-dangerBg, #FCEBEB)", border:"1px solid #F0B4B4", borderRadius:10, padding:"10px 12px", marginBottom:14, fontSize:14, color:"var(--c-dangerText, #A32D2D)", lineHeight:1.5 }}>
            <strong>This template won’t send from {scopeAccountLabel}.</strong> “{tpl.name}” is approved on a different WhatsApp number, so Meta will reject it (#132001). Pick a template from the list above, or change “Send from”.
          </div>
        )}

        {tpl ? (<>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:14 }}>
            <Badge label={tpl.category} bg={C.brandBg} color={C.brandDark}/>
            <Badge label={tpl.lang || tpl.language || 'English'} bg={C.sectionBg} color={C.text3}/>
            <Badge label={tpl.status} bg={tpl.status==="Approved"||tpl.status==="APPROVED"?C.brandBg:"var(--c-orangeBg, #FFF3E0)"} color={tpl.status==="Approved"||tpl.status==="APPROVED"?C.brandDark:"var(--c-sb04e0e, #B04E0E)"} dot/>
            {templateButtons && (
              <Badge label={`${templateButtons.length} reply button${templateButtons.length===1?"":"s"}`} bg="var(--c-warnBgSoft, #FFF8E1)" color="var(--c-s7a5c00, #7A5C00)"/>
            )}
          </div>

          <TemplatePreview template={tpl} />

          <Field label="Template body" hint="Read-only — edit in WhatsApp Manager.">
            <div style={{ background:C.sectionBg, border:`1px solid ${C.innerBorder}`, borderRadius:10, padding:"10px 12px", fontSize:15, color:C.text2, lineHeight:1.5, fontFamily:"'DM Sans'", whiteSpace:"pre-wrap" }}>
              {tpl.body}
            </div>
          </Field>

          {((tpl.vars ?? tpl.variables?.length) > 0) && (<>
            <Sec style={{ marginBottom:8 }}>Variable bindings · {((tpl.vars ?? tpl.variables?.length) || 0)} {((tpl.vars ?? tpl.variables?.length) || 0)===1?"variable":"variables"}</Sec>
            {Array.from({length: (tpl.vars ?? tpl.variables?.length) || 0}, (_, i) => i+1).map(num => {
              const key = "var" + num;
              return (
                <div key={num} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                  <span style={{ fontSize:14, fontWeight:700, color:C.brand, fontFamily:"'DM Mono'", minWidth:34 }}>{"{{"+num+"}}"}</span>
                  <Select value={(node.bindings || {})[key] || ""} onChange={(e)=>onUpdateNode(node.id, n => ({ ...n, bindings: { ...(n.bindings || {}), [key]: e.target.value } }))} style={{ flex:1, fontSize:14 }}>
                    <option value="">— Pick a variable —</option>
                    <option value="{{name}}">Contact Name</option>
                    <option value="{{contact_number}}">Phone Number</option>
                    <option value="static">Static text…</option>
                  </Select>
                </div>
              );
            })}
          </>)}

          {templateButtons && templateButtons.length > 0 && (<>
            <Sec style={{ marginBottom:8, marginTop:18 }}>Reply buttons ({templateButtons.length})</Sec>
            <Alert kind="info" style={{ marginBottom:8 }}>Buttons are defined by the template. The node will sprout one output handle per button — wire each to the next step.</Alert>
            {templateButtons.map((b, i) => (
              <div key={i} style={{ background:C.sectionBg, border:`1px solid ${C.innerBorder}`, borderRadius:10, padding:"10px 11px", marginBottom:6, display:"flex", alignItems:"center", gap:9 }}>
                <div style={{ width:22, height:22, borderRadius:5, background:"var(--c-surface, #fff)", border:`1px solid ${C.cardBorder}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, fontFamily:"'DM Mono'", fontWeight:700, color:C.text3, flexShrink:0 }}>{i+1}</div>
                <div style={{ flex:1, fontSize:15, fontWeight:600, color:C.text1 }}>{b.text}</div>
                <span style={{ fontSize:13, fontFamily:"'DM Mono'", fontWeight:700, color:C.brandDark, background:C.brandBg, border:`1px solid ${C.brandBright}`, borderRadius:5, padding:"2px 6px", letterSpacing:".04em" }}>{`btn:${i}`}</span>
              </div>
            ))}
          </>)}

          <Alert kind="ok" style={{ marginTop:14 }}>
            This template is <strong>{tpl.status === "Approved" || tpl.status === "APPROVED" ? "approved" : "pending Meta review"}</strong>. {tpl.status === "Approved" || tpl.status === "APPROVED" ? "It can be sent any time, including outside the 24-hour service window." : "It can not be sent until Meta approves it."}
          </Alert>
          {tpl.category === "Marketing" && (
            <Alert kind="warn" style={{ marginTop:8 }}>
              <strong>Marketing template — pacing applies.</strong> Meta tests new campaigns on a small subset of recipients first (~1,000). Only after quality signals look good does it roll out fully. Plan extra time for your first send.
            </Alert>
          )}
          {tpl.category === "Authentication" && (
            <Alert kind="info" style={{ marginTop:8 }}>
              <strong>Authentication template.</strong> Reserved for OTPs, password resets, and account verification. Misuse will downgrade your WhatsApp quality rating.
            </Alert>
          )}

        </>) : (
          <Alert kind="warn">Pick a template above to configure variables and preview the message.</Alert>
        )}
      </>) : (<>
        <div style={{ background:"var(--c-warnBgSoft, #FFF8E1)", border:`1px solid #FFE082`, borderRadius:10, padding:"10px 12px", marginBottom:14, display:"flex", alignItems:"flex-start", gap:9 }}>
          <span style={{ color:"var(--c-s7a5c00, #7A5C00)", flexShrink:0, paddingTop:1 }}>{IC.warn(15)}</span>
          <div style={{ flex:1, fontSize:14, color:"var(--c-s7a5c00, #7A5C00)", lineHeight:1.5 }}>
            <strong>Direct messages</strong> are sent via the WhatsApp Business API without a template. They only work within the 24-hour conversation window. Outside that window, the message will fail.
          </div>
        </div>

        <Field label="Message type">
          <Select value={node.directType || "text"} onChange={e=>setDirectType(e.target.value)}>
            {DIRECT_MSG_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
          </Select>
        </Field>

        {renderDirectFields()}
      </>)}

      <div style={{ marginTop:14, padding:"12px", background:C.sectionBg, borderRadius:10, border:`1px solid ${C.innerBorder}` }}>
        <label style={{ display:"flex", alignItems:"flex-start", gap:8, fontSize:15, color:C.text1, cursor:"pointer", lineHeight:1.4 }}>
          <input type="checkbox"
            checked={!!node.waitForReply}
            onChange={e => onUpdateNode(node.id, { waitForReply: e.target.checked })}
            style={{ marginTop:2, flexShrink:0 }}/>
          <span>
            <strong>Wait for customer's reply</strong> before continuing
            <div style={{ fontSize:14, color:C.muted, marginTop:2 }}>
              When on, the execution pauses here. The next inbound message from the customer resumes the flow with that message as the input to downstream nodes.
            </div>
          </span>
        </label>
        {node.waitForReply && (
          <div style={{ marginTop:10, display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:14, fontWeight:600, color:C.text3 }}>Timeout</span>
            <Input type="number" min={1} max={168}
              value={node.waitTimeoutHours ?? 24}
              onChange={e => onUpdateNode(node.id, { waitTimeoutHours: Math.max(1, Math.min(168, parseInt(e.target.value || '24', 10))) })}
              style={{ width:80, padding:"5px 8px", fontSize:14 }}/>
            <span style={{ fontSize:14, color:C.muted }}>hours (max 168 = 7d). Expired pauses are marked failed.</span>
          </div>
        )}
      </div>

      <div style={{ display:"flex", gap:6, marginTop:14 }}>
        <Btn kind="primary" style={{ flex:1, justifyContent:"center" }} onClick={onSaveAndClose}>Save</Btn>
        <Btn kind="ghost" icon={IC.copy(13)} onClick={()=>onDuplicateNode(node.id)}>Duplicate</Btn>
        <Btn kind="danger" icon={IC.trash(13)} onClick={()=>onDeleteNode(node.id)}>Delete</Btn>
      </div>
    </>);
  }

  else if (node.type==="condition") {
    const fieldsBySource = { system: WA_SYSTEM_FIELDS, tags: tagNames, bot:["last_intent","bot_state"], time:["Current time","Day of week","Hour of day"] };
    const rules = node.rules || [];
    const matchMode = node.matchMode || "all";

    const updateRule = (idx, patch) => onUpdateNode(node.id, n => ({
      ...n, rules: (n.rules || []).map((r, i) => i === idx ? { ...r, ...patch } : r)
    }));
    const duplicateRule = (idx) => onUpdateNode(node.id, n => {
      const src = (n.rules || [])[idx]; if (!src) return n;
      const copy = { ...src };
      const rs = [...(n.rules || [])];
      rs.splice(idx + 1, 0, copy);
      return { ...n, rules: rs };
    });
    const deleteRule = (idx) => onUpdateNode(node.id, n => ({
      ...n, rules: (n.rules || []).filter((_, i) => i !== idx)
    }));
    const addRule = () => onUpdateNode(node.id, n => ({
      ...n, rules: [...(n.rules || []), { source:"system", field: WA_SYSTEM_FIELDS[0], op:"equals", value:"" }]
    }));
    const addPresetAsRule = (p) => onUpdateNode(node.id, n => ({
      ...n, rules: [...(n.rules || []), { source:p.source, field:p.field, op:p.op, value:p.value }]
    }));

    const walkChain = (startId) => {
      const titles = []; let cur = startId; let safety = 0;
      while (cur && safety < 6) {
        const nx = nodes.find(n => n.id === cur); if (!nx) break;
        titles.push(nx.type === "action" ? (nx.sub || nx.title) : nx.title);
        const ne = edges.find(e => e.from === cur); cur = ne ? ne.to : null;
        safety++;
      }
      return titles;
    };
    const matchedFirst    = edges.find(e => e.from === node.id && e.fromHandle === "yes");
    const notMatchedFirst = edges.find(e => e.from === node.id && e.fromHandle === "no");
    const matchedSteps    = matchedFirst    ? walkChain(matchedFirst.to)    : [];
    const notMatchedSteps = notMatchedFirst ? walkChain(notMatchedFirst.to) : [];
    const branchSummary = (steps) => steps.length === 0 ? "Not connected" : steps.slice(0,3).join(" → ") + (steps.length>3?" → …":"");

    content = (<>
      <Field label="Match mode" hint="How rules combine to produce the Matched branch.">
        <div style={{ display:"flex", gap:6 }}>
          <Pill active={matchMode!=="any"} onClick={()=>onUpdateNode(node.id, { matchMode: "all" })}>All conditions</Pill>
          <Pill active={matchMode==="any"} onClick={()=>onUpdateNode(node.id, { matchMode: "any" })}>Any condition</Pill>
        </div>
      </Field>

      <Alert kind="warn">
        <strong>WhatsApp compliance</strong>
        <div style={{ marginTop:6, display:"flex", flexDirection:"column", gap:4 }}>
          <div style={{ display:"flex", gap:5 }}><span>•</span><span>This contact is outside the 24-hour WhatsApp window. Use an approved template.</span></div>
          <div style={{ display:"flex", gap:5 }}><span>•</span><span>This contact has not opted in for WhatsApp.</span></div>
          <div style={{ display:"flex", gap:5 }}><span>•</span><span>{(matchedFirst && notMatchedFirst) ? "Both branches connected." : "This condition has no fallback path."}</span></div>
        </div>
      </Alert>

      <Sec style={{ marginTop:18, marginBottom:8 }}>Quick WhatsApp presets</Sec>
      <div style={{ background:C.sectionBg, border:`1px solid ${C.innerBorder}`, borderRadius:10, padding:8, marginBottom:14 }}>
        {WA_CONDITION_PRESETS.map(p=>(
          <button key={p.label} onClick={()=>addPresetAsRule(p)} className="picker-item" style={{
            width:"100%", padding:"7px 9px", background:"transparent",
            border:"1px solid transparent", borderTop:"1px solid transparent", cursor:"pointer", textAlign:"left",
            display:"flex", alignItems:"center", gap:8, borderRadius:7,
            fontSize:14, fontWeight:500, color:C.brand, fontFamily:"'DM Sans'",
            lineHeight:1.3, marginBottom:1,
          }}>
            <span style={{ width:18, height:18, borderRadius:5, background:"var(--c-surface, #fff)", border:`1.2px solid ${C.cardBorder}`, display:"flex", alignItems:"center", justifyContent:"center", color:C.brand, flexShrink:0 }}>{IC.plus(11)}</span>
            <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis" }}>{p.label}</span>
          </button>
        ))}
      </div>

      <Sec style={{ marginBottom:8 }}>Conditions ({rules.length} {rules.length===1?"rule":"rules"} · {matchMode==="any"?"ANY":"ALL"} match)</Sec>
      {rules.length === 0 && (
        <div style={{ background:C.redBg, border:`1px solid #F4C9C9`, borderRadius:10, padding:"11px 13px", marginBottom:8, display:"flex", alignItems:"center", gap:9 }}>
          <span style={{ color:C.redDark }}>{IC.err(14)}</span>
          <div style={{ fontSize:14, color:C.redDark, lineHeight:1.45, fontWeight:500 }}>
            No rules defined. Add at least one condition or pick a preset above.
          </div>
        </div>
      )}
      {rules.map((r, i) => {
        const noValueOp = r.op==="is empty" || r.op==="is not empty" || r.op==="is true" || r.op==="is false";
        return (
          <div key={i} style={{ background:C.sectionBg, border:`1px solid ${C.innerBorder}`, borderRadius:10, padding:11, marginBottom:6 }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:7 }}>
              <span style={{ fontSize:13, fontWeight:700, color:C.muted, letterSpacing:".1em", textTransform:"uppercase" }}>Rule {i+1}</span>
              <div style={{ display:"flex", gap:2 }}>
                <IconBtn title="Duplicate rule" onClick={()=>duplicateRule(i)}>{IC.copy(12)}</IconBtn>
                <IconBtn title="Delete rule" danger onClick={()=>deleteRule(i)}>{IC.trash(12)}</IconBtn>
              </div>
            </div>
            <div style={{ marginBottom:5 }}>
              <Select value={r.source || "custom"} onChange={(e)=>updateRule(i, { source: e.target.value, field: (fieldsBySource[e.target.value] || GENERAL_FIELDS)[0] })} style={{ fontSize:14 }}>
                {CONDITION_SOURCES.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}
              </Select>
            </div>
            <div style={{ marginBottom:5 }}>
              <Select value={r.field || ""} onChange={(e)=>updateRule(i, { field: e.target.value })} style={{ fontSize:14 }}>
                {(fieldsBySource[r.source] || GENERAL_FIELDS).map(f=><option key={f} value={f}>{f}</option>)}
              </Select>
            </div>
            <div style={{ display:"flex", gap:5 }}>
              <Select value={r.op || "equals"} onChange={(e)=>updateRule(i, { op: e.target.value })} style={{ width:140, fontSize:14 }}>
                {OPERATORS.map(op=><option key={op} value={op}>{op}</option>)}
              </Select>
              {(() => {
                const f = (r.field || "").toLowerCase();
                const isNumeric = /score|budget|count|pincode|amount|points|qty|age/.test(f);
                const isEmail   = f === "email";
                const isPhone   = f === "phone";
                const v = r.value || "";
                let valid = true;
                let hint = "";
                if (!noValueOp && v) {
                  if (isNumeric) { valid = /^-?\d+(\.\d+)?$/.test(v); hint = "Numeric value required"; }
                  else if (isEmail) { valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); hint = "Valid email required"; }
                  else if (isPhone) { valid = /^\+?91[\s-]?\d{10}$/.test(v.replace(/\s/g,"")); hint = "Format: +91 9876543210"; }
                }
                return (<>
                  <Input
                    value={v}
                    onChange={(e)=>{
                      let next = e.target.value;
                      if (isNumeric) next = next.replace(/[^\d.\-]/g, "");
                      updateRule(i, { value: next });
                    }}
                    inputMode={isNumeric || isPhone ? "numeric" : "text"}
                    placeholder={noValueOp ? "—" : isEmail ? "name@domain.com" : isPhone ? "+91 9876543210" : "Value"}
                    style={{ flex:1, fontSize:14, fontFamily: (isNumeric||isPhone) ? "'DM Mono'" : undefined, borderColor: valid ? C.inputBorder : C.red }}
                    disabled={noValueOp}
                  />
                  {!valid && <span style={{ fontSize:13, color:C.red, fontWeight:600, alignSelf:"center" }}>!</span>}
                </>);
              })()}
            </div>
          </div>
        );
      })}

      <div style={{ display:"flex", gap:6, marginTop:4 }}>
        <Btn kind="ghost" size="sm" icon={IC.plus(12)} onClick={addRule}>Add condition</Btn>
        <Btn kind="ghost" size="sm" icon={IC.plus(12)} onClick={addRule}>Add group</Btn>
      </div>

      <Sec style={{ marginTop:18, marginBottom:8 }}>Test with sample contact</Sec>
      <div style={{ background:C.sectionBg, border:`1px solid ${C.innerBorder}`, borderRadius:10, padding:11 }}>
        <Select style={{ marginBottom:8, fontSize:14, fontFamily:"'DM Mono'" }}>
          <option>— Select a sample contact —</option>
        </Select>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:rules.length?10:0 }}>
          <Btn kind="dark" size="sm" icon={IC.play(11)}>Run test</Btn>
          {rules.length > 0 && <Badge label="Matched" bg={C.brandBg} color={C.brandDark} dot style={{ padding:"4px 9px" }}/>}
        </div>
        {rules.length > 0 && (
          <div style={{ background:"var(--c-surface, #fff)", border:`1px solid ${C.cardBorder}`, borderRadius:8, padding:"8px 10px" }}>
            {rules.map((r, i)=>(
              <div key={i} style={{ display:"flex", alignItems:"center", gap:7, padding:"4px 0", fontSize:13, color:C.text3, borderBottom:i===rules.length-1?"none":`1px solid ${C.rowDiv}` }}>
                <span style={{ color:C.brand, flexShrink:0 }}>{IC.ok(11)}</span>
                <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  <strong style={{ color:C.text2 }}>{r.field}</strong> {r.op}{r.value?" "+r.value:""}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <Sec style={{ marginTop:18, marginBottom:8 }}>Branch connections</Sec>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
        <div style={{
          background: matchedSteps.length ? C.brandBg : "var(--c-surface, #fff)",
          border:`1px solid ${matchedSteps.length ? C.brandBright : C.cardBorder}`,
          borderRadius:10, padding:10,
          opacity: matchedSteps.length ? 1 : 0.85,
        }}>
          <div style={{ fontSize:13, color:C.brandDark, fontWeight:700, letterSpacing:".08em", textTransform:"uppercase", marginBottom:3 }}>Matched</div>
          <div style={{ fontSize:14, color: matchedSteps.length ? C.brandDark : C.text5, fontWeight:600, lineHeight:1.4 }}>
            {branchSummary(matchedSteps)}
          </div>
          <div style={{ fontSize:13, color: matchedSteps.length ? C.brandDark : C.muted, opacity: matchedSteps.length ? 0.75 : 1, fontFamily:"'DM Mono'", marginTop:4 }}>
            {matchedSteps.length} step{matchedSteps.length===1?"":"s"} connected
          </div>
        </div>
        <div style={{
          background: notMatchedSteps.length ? "var(--c-orangeBg, #FFF3E0)" : "var(--c-surface, #fff)",
          border: `1px solid ${notMatchedSteps.length ? "#FFCC80" : C.cardBorder}`,
          borderRadius:10, padding:10,
          opacity: notMatchedSteps.length ? 1 : 0.85,
        }}>
          <div style={{ fontSize:13, color:"var(--c-sb04e0e, #B04E0E)", fontWeight:700, letterSpacing:".08em", textTransform:"uppercase", marginBottom:3 }}>Not matched</div>
          <div style={{ fontSize:14, color: notMatchedSteps.length ? "var(--c-sb04e0e, #B04E0E)" : C.text5, fontWeight:600, lineHeight:1.4 }}>
            {branchSummary(notMatchedSteps)}
          </div>
          <div style={{ fontSize:13, color: notMatchedSteps.length ? "var(--c-sb04e0e, #B04E0E)" : C.muted, opacity: notMatchedSteps.length ? 0.75 : 1, fontFamily:"'DM Mono'", marginTop:4 }}>
            {notMatchedSteps.length} step{notMatchedSteps.length===1?"":"s"} connected
          </div>
        </div>
      </div>

      <Alert kind="info">
        Numeric operators (<em>greater than</em>, <em>less than</em>) work on number fields like <strong>budget</strong>. Tag operators (<em>has tag</em>) need the Tags source. The Time source compares against IST business hours / weekday / hour.
      </Alert>

      <div style={{ display:"flex", gap:6, marginTop:14 }}>
        <Btn kind="primary" style={{ flex:1, justifyContent:"center" }} onClick={onSaveAndClose}>Save</Btn>
        <Btn kind="ghost" icon={IC.copy(13)} onClick={()=>onDuplicateNode(node.id)}>Duplicate</Btn>
        <Btn kind="danger" icon={IC.trash(13)} onClick={()=>onDeleteNode(node.id)}>Delete</Btn>
      </div>
    </>);
  }

  else if (node.type === "delay") {
    const delayMode = node.delayMode || "duration";
    const waitValue = node.waitValue !== undefined ? node.waitValue : "10";
    const waitUnit  = node.waitUnit  || "minutes";
    const useContactTz = !!node.useContactTz;
    const setNumeric = (v) => onUpdateNode(node.id, { waitValue: String(v).replace(/\D/g, "") });
    content = (<>
      <Field label="Delay type">
        <div style={{ display:"grid", gridTemplateColumns:"repeat(2, 1fr)", gap:5 }}>
          <Pill active={delayMode==="duration"} onClick={()=>onUpdateNode(node.id, { delayMode:"duration" })}>For a duration</Pill>
          <Pill active={delayMode==="date"}     onClick={()=>onUpdateNode(node.id, { delayMode:"date"     })}>Until specific date</Pill>
          <Pill active={delayMode==="until"}    onClick={()=>onUpdateNode(node.id, { delayMode:"until"    })}>Until a specific time</Pill>
        </div>
      </Field>

      {delayMode === "duration" && (
        <Field label="Wait duration" hint="How long to pause before continuing.">
          <div style={{ display:"flex", gap:6 }}>
            <Input
              inputMode="numeric"
              value={waitValue}
              onChange={(e)=>setNumeric(e.target.value)}
              placeholder="0"
              style={{ width:80, fontFamily:"'DM Mono'", fontWeight:600 }}
            />
            <Select style={{ flex:1 }} value={waitUnit} onChange={(e)=>onUpdateNode(node.id, { waitUnit: e.target.value })}>
              <option value="seconds">Seconds</option>
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </Select>
          </div>
          {(!waitValue || waitValue === "0") && <div style={{ fontSize:13, color:C.red, marginTop:5, fontWeight:600 }}>Duration must be a positive number</div>}
        </Field>
      )}

      {delayMode === "date" && (
        <Field label="Wait until date & time" hint="Interpreted in IST. Capped at 7 days from now.">
          <Input type="datetime-local" value={node.untilDateTime || ""} onChange={(e)=>onUpdateNode(node.id, { untilDateTime: e.target.value })}/>
        </Field>
      )}

      {delayMode === "until" && (
        <Field label="Wait until time-of-day" hint="Next occurrence of this time in IST (today if still ahead, else tomorrow).">
          <Input type="time" value={node.untilTime || ""} onChange={(e)=>onUpdateNode(node.id, { untilTime: e.target.value })}/>
        </Field>
      )}

      <Alert kind="warn">Delays beyond <strong>24 hours</strong> may require an approved WhatsApp template to re-engage the contact. The delay is applied to the next message send.</Alert>

      <div style={{ display:"flex", gap:6, marginTop:14 }}>
        <Btn kind="primary" style={{ flex:1, justifyContent:"center" }} onClick={onSaveAndClose}>Save</Btn>
        <Btn kind="ghost" icon={IC.copy(13)} onClick={()=>onDuplicateNode(node.id)}>Duplicate</Btn>
        <Btn kind="danger" icon={IC.trash(13)} onClick={()=>onDeleteNode(node.id)}>Delete</Btn>
      </div>
    </>);
  }
  else if (node.type === "api") {
    const method  = node.method || "POST";
    const apiUrl  = node.apiUrl || "";
    const headers = Array.isArray(node.headers) ? node.headers : [];
    const onError = node.onError || "continue";
    const urlOk   = /^https?:\/\//i.test(apiUrl);
    const setHeader = (i, patch) => onUpdateNode(node.id, n => ({ ...n, headers: (Array.isArray(n.headers)?n.headers:[]).map((h,idx)=> idx===i ? { ...h, ...patch } : h) }));
    const addHeader = () => onUpdateNode(node.id, n => ({ ...n, headers: [ ...(Array.isArray(n.headers)?n.headers:[]), { k:"", v:"" } ] }));
    const delHeader = (i) => onUpdateNode(node.id, n => ({ ...n, headers: (Array.isArray(n.headers)?n.headers:[]).filter((_,idx)=>idx!==i) }));
    content = (<>
      <div style={{ background:C.navyBg, border:`1px solid #9FAFD0`, borderRadius:10, padding:"10px 12px", marginBottom:14, fontSize:14, color:C.text2, lineHeight:1.5 }}>
        Makes a real HTTP request when the flow reaches this step. URL, headers, and body all support <code style={{ background:C.sectionBg, padding:"1px 4px", borderRadius:3, fontFamily:"'DM Mono'" }}>{`{{variables}}`}</code> from upstream nodes. 15-second timeout.
      </div>
      <Field label="Method & URL">
        <div style={{ display:"flex", gap:6 }}>
          <Select value={method} onChange={e=>onUpdateNode(node.id,{ method:e.target.value })} style={{ width:90, fontFamily:"'DM Mono'", fontWeight:700, color:C.brand }}>
            <option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option>
          </Select>
          <Input value={apiUrl} onChange={e=>onUpdateNode(node.id,{ apiUrl:e.target.value })} placeholder="https://api.example.com/endpoint" style={{ flex:1, fontFamily:"'DM Mono'", fontSize:14, borderColor: apiUrl && !urlOk ? C.red : C.inputBorder }}/>
        </div>
        {apiUrl && !urlOk && <div style={{ fontSize:13, color:C.red, marginTop:5, fontWeight:600 }}>URL must start with http:// or https://</div>}
      </Field>
      <Field label="Headers">
        <div style={{ background:C.sectionBg, border:`1px solid ${C.innerBorder}`, borderRadius:8, padding:8 }}>
          {headers.length === 0 && <div style={{ fontSize:14, color:C.muted, padding:"2px 4px 6px" }}>No headers.</div>}
          {headers.map((h,i)=>(
            <div key={i} style={{ display:"grid", gridTemplateColumns:"1fr 1.6fr 24px", gap:5, marginBottom:4, alignItems:"center" }}>
              <Input value={h.k||""} onChange={e=>setHeader(i,{ k:e.target.value })} placeholder="Header" style={{ padding:"5px 8px", fontSize:13, fontFamily:"'DM Mono'" }}/>
              <Input value={h.v||""} onChange={e=>setHeader(i,{ v:e.target.value })} placeholder="Value" style={{ padding:"5px 8px", fontSize:13, fontFamily:"'DM Mono'" }}/>
              <IconBtn title="Remove header" onClick={()=>delHeader(i)}>{IC.x(12)}</IconBtn>
            </div>
          ))}
          <button onClick={addHeader} style={{ background:"none", border:"none", color:C.brand, fontSize:14, fontWeight:600, cursor:"pointer", padding:"3px 4px" }}>+ Add header</button>
        </div>
      </Field>
      {method !== "GET" && (
        <Field label="Body" hint="Plain text or JSON. JSON is validated and sent with application/json. Supports {{variables}}.">
          <Textarea rows={6} value={node.body || ""} onChange={(e)=>onUpdateNode(node.id,{ body: e.target.value })}
            placeholder={`{\n  "name": "{{name}}",\n  "phone": "{{contact_number}}"\n}`} style={{ fontFamily:"'DM Mono'", fontSize:14 }}/>
        </Field>
      )}
      <Field label="On error" hint="What to do if the request fails or times out.">
        <div style={{ display:"flex", gap:6 }}>
          <Pill active={onError==="continue"} onClick={()=>onUpdateNode(node.id,{ onError:"continue" })}>Continue</Pill>
          <Pill active={onError==="retry"}    onClick={()=>onUpdateNode(node.id,{ onError:"retry" })}>Retry 3×</Pill>
          <Pill active={onError==="fail"}     onClick={()=>onUpdateNode(node.id,{ onError:"fail" })}>Fail run</Pill>
        </div>
      </Field>
      <div style={{ display:"flex", gap:6, marginTop:14 }}>
        <Btn kind="primary" style={{ flex:1, justifyContent:"center" }} onClick={onSaveAndClose}>Save</Btn>
        <Btn kind="ghost" icon={IC.copy(13)} onClick={()=>onDuplicateNode(node.id)}>Duplicate</Btn>
        <Btn kind="danger" icon={IC.trash(13)} onClick={()=>onDeleteNode(node.id)}>Delete</Btn>
      </div>
    </>);
  }
  else if (node.type === "ai_agent") {
    const systemPrompt = node.systemPrompt !== undefined ? node.systemPrompt : "";
    const agentContext = node.agentContext !== undefined ? node.agentContext : "";
    const modelRef = node.modelRef || null;
    const toolRefs = Array.isArray(node.toolRefs) ? node.toolRefs : [];
    const outputVariables = Array.isArray(node.outputVariables) ? node.outputVariables : [];
    const setOutVar = (idx, patch) => onUpdateNode(node.id, n => ({
      ...n, outputVariables: (n.outputVariables || []).map((v, i) => i === idx ? { ...v, ...patch } : v)
    }));
    const addOutVar = () => onUpdateNode(node.id, n => ({
      ...n, outputVariables: [...(n.outputVariables || []), { key: "", description: "", example: "" }]
    }));
    const delOutVar = (idx) => onUpdateNode(node.id, n => ({
      ...n, outputVariables: (n.outputVariables || []).filter((_, i) => i !== idx)
    }));
    content = (<>
      <Alert kind="info">
        Click the <strong>Model</strong> handle (left) to pick a provider, and the <strong>Tool</strong> handle (right) to attach one or more tools. These are placeholders today — wiring will activate once the provider integrations ship.
      </Alert>
      <Field label="System prompt" hint="Defines the agent's persona, rules, and overall behavior.">
        <Textarea
          rows={5}
          value={systemPrompt}
          onChange={(e)=>onUpdateNode(node.id, { systemPrompt: e.target.value })}
          placeholder="You are a helpful assistant for our business…"
        />
      </Field>
      <Field label="Context" hint="Background info the agent needs every turn (products, hours, FAQs, escalation rules).">
        <Textarea
          rows={5}
          value={agentContext}
          onChange={(e)=>onUpdateNode(node.id, { agentContext: e.target.value })}
          placeholder="Add company info, pricing, working hours, anything the agent should know…"
        />
      </Field>
      <Field
        label="Max conversation turns"
        hint="1 = run once and continue (extraction only). >1 = the agent can chat back-and-forth up to this many times, and will pass to the next node as soon as it sets done:true OR the limit is reached. Each turn = one AI call."
      >
        <Input
          type="number" min={1} max={20}
          value={node.maxTurns || 1}
          onChange={(e) => {
            const n = Math.max(1, Math.min(20, parseInt(e.target.value || '1', 10) || 1));
            onUpdateNode(node.id, { maxTurns: n });
          }}
          style={{ width:80, fontFamily:"'DM Mono'", fontWeight:600 }}
        />
      </Field>
      <Field
        label="Output variables"
        hint="Pick which ForgeCRM contact fields the agent should extract. Extracted values are saved onto the contact (name → contact name, others → their custom field) and can be inserted downstream via the {x} picker (e.g. {{name}})."
      >
        {outputVariables.length === 0 && (
          <div style={{ background:C.sectionBg, border:`1px dashed ${C.cardBorder}`, borderRadius:8, padding:"10px 12px", fontSize:14, color:C.muted, fontStyle:"italic", marginBottom:8 }}>
            No output variables yet. Click "+ Add variable" to choose a ForgeCRM field (like <span style={{ fontFamily:"'DM Mono'" }}>name</span>) the agent should extract.
          </div>
        )}
        {(() => {
          // Contact custom fields were removed, so the contact NAME is the only
          // thing an extraction can be written back to. Everything else the
          // agent parses is still exposed downstream as a {{variable}}.
          const fieldOpts = [{ key: "name", label: "name · Full contact name" }];
          return outputVariables.map((ov, i) => {
            const known = !ov.key || fieldOpts.some(o => o.key === ov.key);
            return (
              <div key={i} style={{ display:"grid", gridTemplateColumns:"1fr 1fr 28px", gap:6, marginBottom:6, alignItems:"start" }}>
                <Select
                  value={ov.key || ""}
                  onChange={(e)=>{ const k = e.target.value; const o = fieldOpts.find(x=>x.key===k); setOutVar(i, { key: k, fieldName: o ? (o.fieldName || o.label) : "" }); }}
                  style={{ fontFamily:"'DM Mono'", fontSize:14 }}
                >
                  <option value="">— Select a field —</option>
                  {fieldOpts.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                  {!known && <option value={ov.key}>{ov.key} (existing)</option>}
                </Select>
                <Input
                  value={ov.description || ""}
                  onChange={(e)=>setOutVar(i, { description: e.target.value })}
                  placeholder="hint for the agent (optional)"
                  style={{ fontSize:14 }}
                />
                <IconBtn danger title="Remove variable" onClick={()=>delOutVar(i)}>{IC.trash(12)}</IconBtn>
              </div>
            );
          });
        })()}
        <Btn kind="ghost" size="sm" icon={IC.plus ? IC.plus(12) : null} onClick={addOutVar}>+ Add variable</Btn>
      </Field>
      <Field label="Model">
        <div style={{ padding:"10px 12px", border:`1.5px dashed ${C.inputBorder}`, borderRadius:8, background:C.sectionBg, fontSize:15, color:C.text3, fontFamily:"'DM Sans'" }}>
          {modelRef
            ? <>Using <strong style={{ color:C.text1 }}>{modelRef.label}</strong> — click the left handle to change.</>
            : <>No model selected. Click the <strong>left "Model"</strong> handle to pick one.</>}
        </div>
      </Field>
      <Field label={`Tools${toolRefs.length ? ` (${toolRefs.length})` : ""}`}>
        <div style={{ padding:"10px 12px", border:`1.5px dashed ${C.inputBorder}`, borderRadius:8, background:C.sectionBg, fontSize:15, color:C.text3, fontFamily:"'DM Sans'" }}>
          {toolRefs.length
            ? toolRefs.map(t => t.label).join(", ")
            : <>No tools attached. Click the <strong>right "Tool"</strong> handle to add one.</>}
        </div>
      </Field>
      <div style={{ display:"flex", gap:6, marginTop:14 }}>
        <Btn kind="primary" style={{ flex:1, justifyContent:"center" }} onClick={onSaveAndClose}>Save</Btn>
        <Btn kind="ghost" icon={IC.copy(13)} onClick={()=>onDuplicateNode(node.id)}>Duplicate</Btn>
        <Btn kind="danger" icon={IC.trash(13)} onClick={()=>onDeleteNode(node.id)}>Delete</Btn>
      </div>
    </>);
  }
  else if (node.type === "action") {
    const actions = node.actions || [];
    const updateAction = (idx, patch) => onUpdateNode(node.id, n => ({
      ...n, actions: (n.actions || []).map((a, i) => i === idx ? { ...a, ...patch } : a)
    }));
    const duplicateAction = (idx) => onUpdateNode(node.id, n => {
      const src = (n.actions || [])[idx]; if (!src) return n;
      const copy = { ...src, id: "a" + Date.now() };
      const as = [...(n.actions || [])];
      as.splice(idx + 1, 0, copy);
      return { ...n, actions: as };
    });
    const deleteAction = (idx) => onUpdateNode(node.id, n => ({
      ...n, actions: (n.actions || []).filter((_, i) => i !== idx)
    }));
    const addAction = (kind) => onUpdateNode(node.id, n => ({
      ...n, actions: [...(n.actions || []), { id:"a"+Date.now(), kind, value:"" }]
    }));

    content = (<>
      <div style={{ fontSize:16, fontWeight:600, color:C.text1, marginBottom:14, fontFamily:"'DM Sans'" }}>Perform following actions:</div>

      {actions.length === 0 && (
        <div style={{ background:C.sectionBg, border:`1px dashed ${C.cardBorder}`, borderRadius:10, padding:"18px 14px", textAlign:"center", fontSize:15, color:C.muted, fontStyle:"italic", marginBottom:12 }}>
          No actions yet. Click "+ Action" below to add one.
        </div>
      )}

      {actions.map((a, i) => {
        const kind = findAction(a.kind);
        return (
          <div key={a.id} style={{ marginBottom:16 }}>
            <div style={{ display:"flex", alignItems:"center", gap:9, marginBottom:7 }}>
              <span style={{ color:"var(--c-sc8881f, #C8881F)", display:"flex", flexShrink:0 }}>{kind.icon(17)}</span>
              <Select value={a.kind} onChange={(e)=>updateAction(i, { kind: e.target.value })} style={{ flex:1, fontSize:15, fontWeight:600, color:C.text1, border:"none", background:"transparent", padding:"2px 6px 2px 0" }}>
                {ACTION_KINDS.map(k=><option key={k.kind} value={k.kind}>{k.kind}</option>)}
              </Select>
              <IconBtn title="Duplicate action" onClick={()=>duplicateAction(i)}>{IC.copy(13)}</IconBtn>
              <IconBtn danger title="Remove action" onClick={()=>deleteAction(i)}>{IC.trash(13)}</IconBtn>
            </div>
            {kind.valueType === "bdaUser" ? (() => {
              const roleFilter = a.roleFilter || 'all';
              // ⚠ DERIVED from the users actually present, never a hardcoded
              // role list. Roles are user-defined now, so a fixed set of pills
              // would silently omit any role added in Settings — and keep
              // offering ones that were removed.
              const roleOpts = [{ v: 'all', label: 'All' },
                ...[...new Set(assignableUsers.map(u => u.role).filter(Boolean))]
                  .sort()
                  .map(r => ({ v: r, label: r.charAt(0).toUpperCase() + r.slice(1) }))];
              const assignMode = a.assignMode || 'pick';  // 'pick' | 'variable'
              const filtered = assignableUsers.filter(u =>
                roleFilter === 'all' || u.role === roleFilter
              );
              return (
                <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                  {/* Mode toggle: pick a user, or resolve from a variable */}
                  <div style={{ display:"flex", gap:4 }}>
                    {[
                      { v:'pick',     label:'Pick a user' },
                      { v:'variable', label:'By variable' },
                    ].map(opt => (
                      <button
                        key={opt.v}
                        type="button"
                        onClick={()=>updateAction(i, { assignMode: opt.v, value: '' })}
                        style={{
                          flex:1, padding:"5px 8px", fontSize:14, fontWeight:700, fontFamily:"'DM Sans'",
                          border:`1px solid ${assignMode===opt.v ? C.brand : C.cardBorder}`,
                          background: assignMode===opt.v ? C.brandBg : "var(--c-surface, #fff)",
                          color: assignMode===opt.v ? C.brandDark : C.text3,
                          borderRadius:6, cursor:"pointer",
                        }}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  {assignMode === 'variable' ? (
                    <>
                      <VarInput
                        value={a.value || ""}
                        onChange={(e)=>updateAction(i, { value: e.target.value })}
                        placeholder="{{assigned_bda_id}}"
                        style={{ fontFamily:"'DM Mono'", fontSize:14 }}
                      />
                      <div style={{ fontSize:13, color:C.text5, fontWeight:500, lineHeight:1.4 }}>
                        The resolved value must be a numeric user id (forgecrm_users.id). If it's missing or the user is disabled, the step fails.
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ display:"flex", gap:4 }}>
                        {roleOpts.map(opt => (
                          <button
                            key={opt.v}
                            type="button"
                            onClick={()=>updateAction(i, { roleFilter: opt.v })}
                            style={{
                              flex:1, padding:"5px 8px", fontSize:14, fontWeight:600, fontFamily:"'DM Sans'",
                              border:`1px solid ${roleFilter===opt.v ? C.brand : C.cardBorder}`,
                              background: roleFilter===opt.v ? C.brandBg : "var(--c-surface, #fff)",
                              color: roleFilter===opt.v ? C.brandDark : C.text3,
                              borderRadius:6, cursor:"pointer",
                            }}>
                            {opt.label}
                          </button>
                        ))}
                      </div>
                      <Select value={a.value || ""} onChange={(e)=>updateAction(i, { value: e.target.value })}>
                        <option value="">— Select user ({filtered.length} match) —</option>
                        {filtered.map(u => (
                          <option key={u.id} value={String(u.id)}>
                            {u.displayName} · {u.role === 'admin' ? 'Admin' : 'BDA Sales'}{u.email ? ` · ${u.email}` : ''}
                          </option>
                        ))}
                      </Select>
                    </>
                  )}
                </div>
              );
            })() : kind.valueType === "funnelStage" ? (
              <Select value={a.value || ""} onChange={(e)=>updateAction(i, { value: e.target.value })}>
                <option value="">— Select a stage —</option>
                {funnelStages.map(st => <option key={st.stageKey} value={st.stageKey}>{st.label}</option>)}
              </Select>
            ) : kind.valueType === "tag" ? (
              <Select value={a.value || ""} onChange={(e)=>updateAction(i, { value: e.target.value })}>
                <option value="">— Select a tag —</option>
                {tagNames.map(tg => <option key={tg} value={tg}>{tg}</option>)}
              </Select>
            ) : kind.valueType === "leadField" ? (() => {
              // TWO controls, because this action needs two values: which field
              // and what to put in it. `a.field` and `a.value` are separate
              // keys — packing them into one delimited string would break the
              // first time a customer's answer contained the delimiter.
              const chosen = leadFields.find(f => f.fieldKey === a.field);
              return (
                <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
                  <Select value={a.field || ""} onChange={(e)=>updateAction(i, { field: e.target.value })}>
                    <option value="">— Choose a field on the lead —</option>
                    {leadFields.map(f => (
                      <option key={f.fieldKey} value={f.fieldKey}>
                        {f.label}{f.isSystem ? "" : " (custom)"}
                      </option>
                    ))}
                  </Select>
                  <VarInput
                    value={a.value || ""}
                    onChange={(e)=>updateAction(i, { value: e.target.value })}
                    placeholder="{{answer}}"
                  />
                  <div style={{ fontSize:13, color:C.muted, lineHeight:1.5 }}>
                    <strong>{"{{answer}}"}</strong> is what the customer just sent — put an
                    “Ask a question” step before this one and their reply lands here.
                    {chosen && chosen.fieldType === "dropdown" && Array.isArray(chosen.options) && chosen.options.length > 0 && (
                      <> Expected values: {chosen.options.join(", ")}. Anything else is still stored, as typed.</>
                    )}
                    {chosen && chosen.fieldType === "number" && <> Must be a number.</>}
                    {chosen && chosen.fieldType === "date" && <> Must be a date.</>}
                  </div>
                  {leadFields.length === 0 && (
                    <div style={{ fontSize:13, color:C.orangeText }}>
                      No writable lead fields loaded. Add one under Settings → Fields.
                    </div>
                  )}
                </div>
              );
            })() : (
              <VarInput value={a.value || ""} onChange={(e)=>updateAction(i, { value: e.target.value })} placeholder={kind.placeholder}/>
            )}
          </div>
        );
      })}

      <details style={{ marginTop:4 }}>
        <summary style={{
          padding:"13px 16px", listStyle:"none",
          background:"transparent",
          border:`2px dashed #E5A100`,
          borderRadius:10, cursor:"pointer",
          color:"var(--c-sc8881f, #C8881F)", fontSize:16, fontWeight:600,
          fontFamily:"'DM Sans'",
          display:"flex", alignItems:"center", justifyContent:"center", gap:7,
        }}>
          <span style={{ display:"flex" }}>{IC.plus(13)}</span>
          Action
        </summary>
        <div style={{ background:"var(--c-surface, #fff)", border:`1px solid ${C.cardBorder}`, borderRadius:10, padding:6, marginTop:6, boxShadow:"0 6px 18px rgba(0,0,0,.08)", maxHeight:240, overflowY:"auto" }}>
          {ACTION_KINDS.map(k => (
            <button key={k.kind} onClick={()=>addAction(k.kind)} className="picker-item" style={{
              width:"100%", padding:"8px 10px", background:"transparent",
              border:"1px solid transparent", borderRadius:7, cursor:"pointer", textAlign:"left",
              display:"flex", alignItems:"center", gap:9, marginBottom:1,
              fontSize:15, fontWeight:500, color:C.text2, fontFamily:"'DM Sans'",
            }}>
              <span style={{ color:"var(--c-sc8881f, #C8881F)", display:"flex", flexShrink:0 }}>{k.icon(15)}</span>
              <span>{k.kind}</span>
            </button>
          ))}
        </div>
      </details>

      <div style={{ display:"flex", gap:6, marginTop:18 }}>
        <Btn kind="primary" style={{ flex:1, justifyContent:"center" }} onClick={onSaveAndClose}>Save</Btn>
        <Btn kind="ghost" icon={IC.copy(13)} onClick={()=>onDuplicateNode(node.id)}>Duplicate</Btn>
        <Btn kind="danger" icon={IC.trash(13)} onClick={()=>onDeleteNode(node.id)}>Delete</Btn>
      </div>
    </>);
  }

  else if (node.type === "subflow") {
    const flowId = node.flowId || "";
    const wf = otherAutomations.find(w => w.id === flowId);
    const waitMode = node.waitMode || "await";
    const q = subflowSearch.trim().toLowerCase();
    const filtered = otherAutomations.filter(w => !q || w.name.toLowerCase().includes(q));
    const active = filtered.filter(w=>w.status==="active"||w.status==="Active");
    const paused = filtered.filter(w=>w.status==="paused"||w.status==="Paused"||w.status==="inactive"||w.status==="Inactive");
    content = (<>
      <Field label="Sub-flow to run" hint="The selected automation will execute. Pause and resume options apply on return.">
        <div style={{ position:"relative" }}>
          <div style={{ position:"relative", marginBottom:6 }}>
            <span style={{ position:"absolute", left:9, top:"50%", transform:"translateY(-50%)", color:C.muted, pointerEvents:"none" }}>{IC.search(12)}</span>
            <Input value={subflowSearch} onChange={e=>setSubflowSearch(e.target.value)} placeholder="Search automations…" style={{ paddingLeft:28, fontSize:15 }}/>
          </div>
          <div style={{ border:`1.5px solid ${C.inputBorder}`, borderRadius:8, background:"var(--c-surface, #fff)", maxHeight:220, overflowY:"auto" }}>
            {active.length === 0 && paused.length === 0 && (
              <div style={{ padding:"10px 11px", fontSize:14, color:C.muted, textAlign:"center" }}>No automations found</div>
            )}
            {active.length > 0 && (
              <div>
                <div style={{ padding:"5px 11px", fontSize:13, fontWeight:700, color:C.muted, letterSpacing:".08em", textTransform:"uppercase", background:C.sectionBg, position:"sticky", top:0, zIndex:1 }}>Active</div>
                {active.map(w => {
                  const selected = w.id === flowId;
                  return (
                    <div key={w.id} onClick={()=>onUpdateNode(node.id, { flowId: w.id })} style={{
                      padding:"7px 11px", cursor:"pointer", display:"flex", alignItems:"center", gap:8,
                      background: selected ? C.brandBg : "transparent",
                      borderBottom:`1px solid ${C.rowDiv}`,
                    }}>
                      <span style={{ width:6, height:6, borderRadius:"50%", background: C.brandBright, flexShrink:0 }}/>
                      <span style={{ fontSize:14, fontWeight:600, color: selected ? C.brandDark : C.text2, flex:1 }}>{w.name}</span>
                      {selected && <span style={{ fontSize:13, color:C.brandDark, fontWeight:700 }}>✓</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {paused.length > 0 && (
              <div>
                <div style={{ padding:"5px 11px", fontSize:13, fontWeight:700, color:C.muted, letterSpacing:".08em", textTransform:"uppercase", background:C.sectionBg, position:"sticky", top:0, zIndex:1 }}>Paused</div>
                {paused.map(w => {
                  const selected = w.id === flowId;
                  return (
                    <div key={w.id} onClick={()=>onUpdateNode(node.id, { flowId: w.id })} style={{
                      padding:"7px 11px", cursor:"pointer", display:"flex", alignItems:"center", gap:8,
                      background: selected ? C.orangeBg : "transparent",
                      borderBottom:`1px solid ${C.rowDiv}`,
                    }}>
                      <span style={{ width:6, height:6, borderRadius:"50%", background: C.orange, flexShrink:0 }}/>
                      <span style={{ fontSize:14, fontWeight:600, color: selected ? C.orangeText : C.text2, flex:1 }}>{w.name}</span>
                      {selected && <span style={{ fontSize:13, color:C.orangeText, fontWeight:700 }}>✓</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </Field>

      {wf && (
        <div style={{ background:C.sectionBg, border:`1px solid ${C.innerBorder}`, borderRadius:10, padding:"11px 13px", marginBottom:14 }}>
          <div style={{ fontSize:15, fontWeight:700, color:C.text1, marginBottom:6 }}>{wf.name}</div>
          <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
            <Badge label={wf.status} bg={wf.status==="active"||wf.status==="Active"?C.brandBg:"var(--c-orangeBg, #FFF3E0)"} color={wf.status==="active"||wf.status==="Active"?C.brandDark:"var(--c-sb04e0e, #B04E0E)"} dot/>
          </div>
        </div>
      )}

      <Field label="When sub-flow finishes" hint="Choose how the parent flow proceeds after the sub-flow runs.">
        <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
          <Pill active={waitMode==="await"}    onClick={()=>onUpdateNode(node.id, { waitMode: "await"    })}>Wait for sub-flow, then continue</Pill>
          <Pill active={waitMode==="fire"}     onClick={()=>onUpdateNode(node.id, { waitMode: "fire"     })}>Fire and continue immediately</Pill>
          <Pill active={waitMode==="handoff"}  onClick={()=>onUpdateNode(node.id, { waitMode: "handoff"  })}>Hand off — end this flow</Pill>
        </div>
      </Field>

      <Alert kind="info">The sub-flow runs against the <strong>same contact</strong> and inherits all variables from this flow (name, custom fields, AI outputs) automatically — no mapping needed. {waitMode==="await" ? "This flow waits for it to finish, then continues." : waitMode==="fire" ? "This flow continues immediately while the sub-flow runs in the background." : "This flow ends here and the sub-flow takes over."}</Alert>

      <div style={{ display:"flex", gap:6, marginTop:14 }}>
        <Btn kind="primary" style={{ flex:1, justifyContent:"center" }} onClick={onSaveAndClose}>Save</Btn>
        <Btn kind="ghost" icon={IC.copy(13)} onClick={()=>onDuplicateNode(node.id)}>Duplicate</Btn>
        <Btn kind="danger" icon={IC.trash(13)} onClick={()=>onDeleteNode(node.id)}>Delete</Btn>
      </div>
    </>);
  }

  else if (node.type === "trigger") {
    const tk = node.triggerKind || "keyword";
    const meta = findTriggerKind(tk);

    // Switching kind REPLACES the fields of the old kind with the new kind's
    // defaults. Leaving a stale `keyword` on a node that is now `tagApplied`
    // would put a value in the config that nothing reads and that the card
    // would not show — the same invisible-state problem the old panel had.
    const switchKind = (next) => {
      if (next === tk) return;
      const cleared = {};
      TRIGGER_KINDS.forEach(k => Object.keys(k.defaults).forEach(f => { cleared[f] = undefined; }));
      onUpdateNode(node.id, { ...cleared, ...findTriggerKind(next).defaults, triggerKind: next });
    };

    const accounts = Array.isArray(node.triggerAccounts) ? node.triggerAccounts : [];
    const toggleAccount = (num) => onUpdateNode(node.id, {
      triggerAccounts: accounts.includes(num) ? accounts.filter(a => a !== num) : [...accounts, num],
    });

    content = (<>
      <Field label="What starts this flow?" hint="Only the first trigger in a flow ever fires.">
        <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
          {TRIGGER_KINDS.map(k => (
            <Pill key={k.kind} active={tk === k.kind} onClick={()=>switchKind(k.kind)}>{k.label}</Pill>
          ))}
        </div>
      </Field>

      {/* A flow imported from another instance can carry a kind this build no
          longer offers. Every live flow here is `keyword`, so this is defence —
          but without it the switcher would render with NOTHING selected and no
          fields, which reads as a broken panel rather than a retired trigger. */}
      {!TRIGGER_KINDS.some(k => k.kind === tk) && (
        <Alert kind="warn">
          This trigger is set to <strong>{tk}</strong>, which this version no longer supports —
          it will never fire. Pick one of the options above.
        </Alert>
      )}

      {tk === "keyword" && (<>
        <Field label="Keyword" hint="The word the customer sends. Leave the match type on Exact unless the word appears inside a longer sentence.">
          <Input
            value={node.keyword || ""}
            onChange={(e)=>onUpdateNode(node.id, { keyword: e.target.value })}
            placeholder="e.g. PRICE"
          />
        </Field>
        <Field label="Match">
          <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
            {/* These three strings are read verbatim by the engine's
                matchesKeyword switch. A prettier label here would compile,
                render, and silently never match. */}
            <Pill active={(node.matchType || "exact")==="exact"}    onClick={()=>onUpdateNode(node.id, { matchType:"exact" })}>Exact — the message is only this word</Pill>
            <Pill active={node.matchType==="contains"}              onClick={()=>onUpdateNode(node.id, { matchType:"contains" })}>Contains — the word appears anywhere</Pill>
            <Pill active={node.matchType==="starts"}                onClick={()=>onUpdateNode(node.id, { matchType:"starts" })}>Starts with — the message begins with it</Pill>
          </div>
        </Field>
        <Field label="Case sensitive" hint="Off means PRICE, Price and price all match.">
          <Toggle value={!!node.caseSensitive} onChange={(v)=>onUpdateNode(node.id, { caseSensitive: v })}/>
        </Field>
        <Field label="Whose message counts?" hint="Outbound fires on a message YOUR team sends — useful for internal shortcuts.">
          <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
            <Pill active={(node.triggerDirection || "inbound")==="inbound"} onClick={()=>onUpdateNode(node.id, { triggerDirection:"inbound" })}>The customer sends it</Pill>
            <Pill active={node.triggerDirection==="outbound"}               onClick={()=>onUpdateNode(node.id, { triggerDirection:"outbound" })}>Your team sends it</Pill>
            <Pill active={node.triggerDirection==="both"}                   onClick={()=>onUpdateNode(node.id, { triggerDirection:"both" })}>Either side sends it</Pill>
          </div>
        </Field>
        {!(node.keyword || "").trim() && (
          <Alert kind="warn">Type a keyword. An empty one can never match, so this flow could never start.</Alert>
        )}
      </>)}

      {tk === "link" && (<>
        <Field label="Tracking code" hint="A wa.me link carries no query string, so the ONLY thing that survives into WhatsApp is the pre-filled message. This trigger fires when that message contains this code.">
          <Input
            value={node.trackingCode || ""}
            onChange={(e)=>onUpdateNode(node.id, { trackingCode: e.target.value })}
            placeholder="e.g. WEB_HOMEPAGE_HERO"
          />
        </Field>
        {(node.trackingCode || "").trim()
          ? <Alert kind="info">Build the link so its pre-filled text contains <strong>{node.trackingCode.trim()}</strong> — Message Formats generates one for you.</Alert>
          : <Alert kind="warn">Without a code this trigger has nothing to match on, so it can never fire.</Alert>}
      </>)}

      {tk === "tagApplied" && (<>
        <Field label="Tag to watch">
          <Select value={node.tag || ""} onChange={(e)=>onUpdateNode(node.id, { tag: e.target.value })}>
            <option value="">— Select a tag —</option>
            {tagNames.map(tg => <option key={tg} value={tg}>{tg}</option>)}
          </Select>
        </Field>
        <Field label="When it is">
          <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
            <Pill active={(node.tagDirection || "added")==="added"} onClick={()=>onUpdateNode(node.id, { tagDirection:"added" })}>Added to the contact</Pill>
            <Pill active={node.tagDirection==="removed"}            onClick={()=>onUpdateNode(node.id, { tagDirection:"removed" })}>Removed from the contact</Pill>
          </div>
        </Field>
        <Field label="Only once per contact" hint="On means a contact who already ran this flow for this tag will not run it again.">
          <Toggle value={node.fireOncePerTag !== false} onChange={(v)=>onUpdateNode(node.id, { fireOncePerTag: v })}/>
        </Field>
        {!(node.tag || "").trim() && (
          <Alert kind="warn">Choose a tag. Until then this trigger has nothing to watch.</Alert>
        )}
      </>)}

      {tk === "newContact" && (
        <Alert kind="info">Fires the first time a number ever messages you — nothing else to set.</Alert>
      )}
      {tk === "anyMessage" && (
        <Alert kind="warn">Fires on <strong>every</strong> inbound message from anyone. Add a condition step early, or this will reply to every conversation you have.</Alert>
      )}

      <Field label="Listen on" hint="Which of your WhatsApp numbers this trigger watches. None selected means all of them.">
        <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
          {whatsappAccounts.length === 0 && (
            <div style={{ fontSize:14, color:C.muted }}>No WhatsApp numbers connected yet.</div>
          )}
          {whatsappAccounts.map(a => {
            const num = a.displayPhoneNumber;
            const on = accounts.includes(num);
            return (
              <div key={a.id} onClick={()=>toggleAccount(num)} style={{
                display:"flex", alignItems:"center", gap:9, padding:"7px 10px", cursor:"pointer",
                border:`1.5px solid ${on ? C.brandBright : C.innerBorder}`, borderRadius:8,
                background: on ? C.brandBg : "transparent",
              }}>
                <span style={{
                  width:15, height:15, borderRadius:4, flexShrink:0,
                  border:`1.5px solid ${on ? C.brandBright : C.inputBorder}`,
                  background: on ? C.brandBright : "transparent",
                  display:"flex", alignItems:"center", justifyContent:"center", color:"#fff",
                }}>{on ? IC.check(10) : null}</span>
                <span style={{ fontSize:14, fontWeight:600, color: on ? C.brandDark : C.text2 }}>
                  {a.displayName} <span style={{ fontWeight:500, color:C.muted }}>{maskPhone(num)}</span>
                </span>
              </div>
            );
          })}
        </div>
      </Field>
      {accounts.length === 0 && whatsappAccounts.length > 1 && (
        <Alert kind="info">Listening on all {whatsappAccounts.length} numbers.</Alert>
      )}

      <Field label="Note" hint="For your own reference — not used by the engine.">
        <Textarea rows={2} value={node.sub || ""} onChange={(e)=>onUpdateNode(node.id, { sub: e.target.value })} placeholder="Why this flow exists…"/>
      </Field>

      <div style={{ display:"flex", gap:6, marginTop:14 }}>
        <Btn kind="primary" style={{ flex:1, justifyContent:"center" }} onClick={onSaveAndClose}>Save</Btn>
        <Btn kind="ghost" icon={IC.copy(13)} onClick={()=>onDuplicateNode(node.id)}>Duplicate</Btn>
        <Btn kind="danger" icon={IC.trash(13)} onClick={()=>onDeleteNode(node.id)}>Delete</Btn>
      </div>
    </>);
  }

  if (content === null) {
    content = (<>
      <Field label="Description"><Textarea rows={3} value={node.sub || ""} onChange={(e)=>onUpdateNode(node.id, { sub: e.target.value })} placeholder="Describe what this step does…"/></Field>
      <Alert kind="info">This <strong>{t.label}</strong> block uses default settings. Configure it inline or open the advanced editor for more options.</Alert>
      <div style={{ display:"flex", gap:6, marginTop:14 }}>
        <Btn kind="primary" style={{ flex:1, justifyContent:"center" }} onClick={onSaveAndClose}>Save</Btn>
        <Btn kind="ghost" icon={IC.copy(13)} onClick={()=>onDuplicateNode(node.id)}>Duplicate</Btn>
        <Btn kind="danger" icon={IC.trash(13)} onClick={()=>onDeleteNode(node.id)}>Delete</Btn>
      </div>
    </>);
  }

  const isActionHeader = node.type === "action";

  return (
    <aside style={{ width:344, borderLeft:`1px solid ${C.cardBorder}`, background:"var(--c-surface, #fff)", flexShrink:0, overflowY:"auto" }}>
      <div style={{
        padding:"15px 18px 13px",
        borderBottom:`1px solid ${isActionHeader ? "var(--c-sf0e0a8, #F0E0A8)" : C.cardBorder}`,
        background: isActionHeader ? "var(--c-sfff6d6, #FFF6D6)" : "var(--c-surface, #fff)",
      }}>
        <div style={{ display:"flex", alignItems:"center", gap:9, marginBottom: isActionHeader ? 0 : 10 }}>
          <div style={{
            width:32, height:32, borderRadius:8,
            background: isActionHeader ? "var(--c-overlaySoft)" : t.bg,
            color: isActionHeader ? "var(--c-sc8881f, #C8881F)" : t.color,
            display:"flex", alignItems:"center", justifyContent:"center",
            border:`1px solid ${isActionHeader ? "var(--c-sf0e0a8, #F0E0A8)" : t.border}`,
            flexShrink:0,
          }}>{isActionHeader ? IC.zap(16) : t.icon(16)}</div>
          <div style={{ flex:1, minWidth:0 }}>
            {!isActionHeader && <div style={{ fontSize:13, fontWeight:700, letterSpacing:".1em", textTransform:"uppercase", color:t.accent, marginBottom:1 }}>{t.label} BLOCK</div>}
            <div style={{ display:"flex", alignItems:"center", gap:5 }}>
              {editingTitle ? (
                <input
                  ref={titleInputRef}
                  value={node.title || ""}
                  onChange={(e)=>onUpdateNode(node.id, { title: e.target.value.slice(0, 60) })}
                  onBlur={commitTitle}
                  onKeyDown={onTitleKey}
                  placeholder="Type a node name…"
                  className="rename-input"
                  style={{
                    fontSize: isActionHeader ? 18 : 15,
                    fontWeight:700,
                    color: isActionHeader ? "var(--c-s7a5c00, #7A5C00)" : C.text1,
                    fontFamily:"'DM Sans'", flex:1, minWidth:0,
                    border:`1px solid ${C.brandBright}`,
                    borderRadius:5,
                    outline:"none", background:"var(--c-surface, #fff)",
                    padding:"2px 6px",
                    margin:"-2px -6px",
                    boxShadow:`0 0 0 3px ${C.brandBg}`,
                  }}
                />
              ) : (
                <div
                  onClick={()=>setEditingTitle(true)}
                  title="Click the pencil to rename"
                  style={{
                    fontSize: isActionHeader ? 18 : 15,
                    fontWeight:700,
                    color: isActionHeader ? "var(--c-s7a5c00, #7A5C00)" : ((node.title && node.title.trim()) || node.type === 'trigger' ? C.text1 : C.muted),
                    fontFamily:"'DM Sans'", flex:1, minWidth:0,
                    padding:"2px 0",
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                    cursor:"default",
                    fontStyle: ((node.title && node.title.trim()) || node.type === 'trigger') ? "normal" : "italic",
                  }}
                >{node.type === 'trigger' ? getTriggerDisplay(node).title : ((node.title && node.title.trim()) ? node.title : "Unnamed node")}</div>
              )}
              <IconBtn
                title={editingTitle ? "Done editing" : "Rename this node"}
                onClick={()=>setEditingTitle(v => !v)}
                style={{
                  color: editingTitle ? C.brand : (isActionHeader ? "var(--c-s7a5c00, #7A5C00)" : C.text5),
                  background: editingTitle ? C.brandBg : "transparent",
                }}
              >{editingTitle ? IC.ok(13) : IC.edit(13)}</IconBtn>
            </div>
            {editingTitle && (!node.title || !String(node.title).trim()) && <div style={{ fontSize:13, color:C.red, marginTop:3, fontWeight:600 }}>Node name can't be empty</div>}
          </div>
          {!isActionHeader && <IconBtn title="Duplicate" onClick={()=>onDuplicateNode(node.id)}>{IC.copy(15)}</IconBtn>}
          {!isActionHeader && <IconBtn danger title="Delete" onClick={()=>onDeleteNode(node.id)}>{IC.trash(15)}</IconBtn>}
        </div>
        {!isActionHeader && (
          <div style={{ display:"flex", gap:6, alignItems:"center" }}>
            <Btn kind="ghost" size="sm" onClick={()=>onToggleDisable(node.id)}>{node.disabled ? "Enable" : "Disable"}</Btn>
            <Btn kind="ghost" size="sm" onClick={()=>onDuplicateNode(node.id)}>Duplicate</Btn>
            <div style={{ flex:1 }}/>
            <Badge label="Saved" bg={C.brandBg} color={C.brandDark} dot/>
          </div>
        )}
      </div>
      <div style={{ padding:18 }}>
        <VarContext.Provider value={{ nodes, edges, currentNodeId: node.id }}>
          {content}
        </VarContext.Provider>
      </div>
    </aside>
  );
};


const DownloadIcon = (s = 13) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

const BuilderToolbar = ({ automationName, status, onBack, onSave, isDirty, saving, onToggleStatus, toggleBusy, onPreview, showPreview, activeTab, onTabChange, onUndo, onRedo, canUndo, canRedo, onZoomIn, onZoomOut, onFit, onAutoLayout, onExport }) => {
  const isActive = status === 'active';
  const tabs = [
    { key: 'editor', label: 'Editor' },
    { key: 'executions', label: 'Executions' },
  ];
  return (
    <div style={{ background:"var(--c-surface, #fff)", borderBottom:`1px solid ${C.cardBorder}`, padding:"9px 16px", display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
      <Btn kind="ghost" icon={IC.back(13)} onClick={onBack}>Back</Btn>
      <div style={{ height:22, width:1, background:C.cardBorder }}/>
      <div style={{ display:"flex", flexDirection:"column", minWidth:0 }}>
        <div style={{ fontSize:16, fontWeight:700, color:C.text1, fontFamily:"'DM Sans'" }}>{automationName || "Untitled Automation"}</div>
      </div>
      <StatusPill status={status || "draft"}/>
      <div style={{ flex:1 }}/>

      {/* Center tabs */}
      <div style={{ display:"flex", gap:4, background:C.innerBg, borderRadius:10, padding:4 }}>
        {tabs.map(tab => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => onTabChange && onTabChange(tab.key)}
              style={{
                padding: '6px 18px',
                borderRadius: 8,
                border: 'none',
                fontSize: 14,
                fontWeight: 700,
                fontFamily: "'DM Sans'",
                cursor: 'pointer',
                background: isActive ? 'var(--c-surface, #fff)' : 'transparent',
                color: isActive ? C.text1 : C.text5,
                boxShadow: isActive ? '0 1px 3px rgba(0,0,0,.08)' : 'none',
                transition: 'all .15s',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div style={{ flex:1 }}/>
      <div style={{ display:"flex", gap:2 }}>
        <IconBtn title="Undo" onClick={onUndo} style={{ opacity: canUndo ? 1 : 0.35 }}>{IC.undo(15)}</IconBtn>
        <IconBtn title="Redo" onClick={onRedo} style={{ opacity: canRedo ? 1 : 0.35 }}>{IC.redo(15)}</IconBtn>
        <IconBtn title="Auto-arrange" onClick={onAutoLayout}>{IC.arr(15)}</IconBtn>
        <div style={{ height:22, width:1, background:C.cardBorder, margin:"0 6px", alignSelf:"center" }}/>
        <IconBtn title="Zoom out" onClick={onZoomOut}>{IC.zOut(15)}</IconBtn>
        <IconBtn title="Fit to screen" onClick={onFit}>{IC.fit(15)}</IconBtn>
        <IconBtn title="Zoom in" onClick={onZoomIn}>{IC.zIn(15)}</IconBtn>
      </div>
      <div style={{ height:22, width:1, background:C.cardBorder }}/>
      <Btn kind="ghost" icon={IC.eye(13)} onClick={onPreview} data-testid="preview-toggle">{showPreview ? "Hide preview" : "Preview"}</Btn>
      {onExport && (
        <Btn kind="ghost" icon={DownloadIcon(13)} onClick={onExport} title="Download this automation as a JSON file you can import elsewhere">Export</Btn>
      )}
      {onToggleStatus && (
        <Btn
          kind={isActive ? "ghost" : "primary"}
          icon={IC.power(13)}
          onClick={() => !toggleBusy && onToggleStatus(isActive ? 'inactive' : 'active')}
          title={isActive ? "Disable this automation" : "Enable this automation"}
          style={toggleBusy ? { opacity: 0.6, pointerEvents: 'none' } : (isActive ? { color: C.redDark, border: `1px solid ${C.redBg}` } : undefined)}
        >
          {toggleBusy ? (isActive ? "Disabling…" : "Enabling…") : (isActive ? "Disable" : "Enable")}
        </Btn>
      )}
      {saving ? (
        <Btn kind="ghost" disabled style={{ opacity: .7, pointerEvents: 'none' }}>Saving…</Btn>
      ) : isDirty ? (
        <Btn kind="primary" icon={IC.play(12)} onClick={onSave} title="Save changes">Save</Btn>
      ) : (
        <Btn kind="ghost" icon={IC.check(13)} disabled
          title="No unsaved changes"
          style={{ color: C.green || 'var(--c-successText, #0F6E56)', borderColor: C.green || '#0F6E56', opacity: .85, pointerEvents: 'none', cursor: 'default' }}>
          Saved
        </Btn>
      )}
      <IconBtn>{IC.more(16)}</IconBtn>
    </div>
  );
};

const PhonePreview = ({ onClose, nodes = [], edges = [], templates = [], otherAutomations = [] }) => {
  const [conv, setConv] = useState([]);
  const [waiting, setWaiting] = useState(null);
  const [typed, setTyped] = useState("");
  const [ended, setEnded] = useState(false);
  const chatRef = useRef(null);
  const timersRef = useRef([]);
  const runRef = useRef(0);

  const clearTimers = () => { timersRef.current.forEach(t => clearTimeout(t)); timersRef.current = []; };
  const sched = (cb, ms) => { const t = setTimeout(cb, ms); timersRef.current.push(t); };

  const SAMPLE_VARS = {
    "{{first_name}}": "Anjali",
    "{{phone}}":      "+91 98765 43210",
    "{{city}}":       "Chennai",
    "{{bhk_type}}":   "2BHK",
    "{{order_id}}":   "ORD-12345",
    "{{budget}}":     "₹1.2 Cr",
    "{{name}}":       "Anjali",
    "{{contact_number}}": "+91 98765 43210",
  };
  const resolveBody = (body, bindings = {}) =>
    (body || "").replace(/\{\{(\d+)\}\}/g, (_, num) => {
      const bound = bindings["var" + num];
      if (!bound) return `[var${num}]`;
      return SAMPLE_VARS[bound] || bound;
    });

  const now = () => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  };

  const resolveNext = (nodeId, fromHandle = null) => {
    // Mirror the engine exactly (automationEngine.js walkFrom / resumeAutomation):
    //   - an OMITTED fromHandle means "default", so asking for "default"
    //     explicitly must still match those edges. The old strict equality
    //     missed every one of them, and the builder deliberately omits the
    //     string when it is default — so live flow 14's trigger edge is one.
    //   - a placeholder row with a null target is not a route.
    const want = fromHandle || "default";
    const candidates = edges.filter(e =>
      e.from === nodeId && ((e.fromHandle || "default") === want) && e.to
    );
    if (!candidates.length) return null;
    let target = candidates[0].to;
    const visited = new Set([nodeId]);
    while (target && !visited.has(target)) {
      visited.add(target);
      const t = nodes.find(n => n.id === target);
      if (!t || !t.disabled) return target;
      const nx = edges.find(e => e.from === target);
      if (!nx) return null;
      target = nx.to;
    }
    return target;
  };

  const playNode = (nodeId, runId) => {
    if (runId !== runRef.current) return;
    const node = nodes.find(n => n.id === nodeId);
    if (!node) { setEnded(true); return; }
    if (node.disabled) {
      const next = resolveNext(node.id);
      next ? sched(() => playNode(next, runId), 80) : setEnded(true);
      return;
    }

    if (node.type === "message") {
      if (node.messageMode === "direct") {
        const dd = node.directData || {};
        const dt = node.directType || "text";
        let text = "";
        let media = null;
        switch (dt) {
          // No emojis anywhere in this codebase — a typed media chip renders
          // in the bubble instead, via the `media` field.
          case "text": text = dd.body || "(empty text)"; break;
          case "image": text = dd.caption || ""; media = "Photo"; break;
          case "video": text = dd.caption || ""; media = "Video"; break;
          case "audio": text = ""; media = "Voice message"; break;
          case "sticker": text = ""; media = "Sticker"; break;
          case "document": text = dd.caption || ""; media = dd.filename ? `Document · ${dd.filename}` : "Document"; break;
          case "location": text = `${dd.name || "Location"}${dd.address ? `\n${dd.address}` : ""}`.trim(); media = "Location"; break;
          case "contact": text = `${dd.name || "Contact"}${dd.phone ? `\n${dd.phone}` : ""}`; media = "Contact card"; break;
          case "cta_url":
          case "location_request":
          case "quick_reply":
          case "list":
            text = dd.body || "";
            break;
          case "dynamic_api": text = `[Dynamic API] ${dd.endpoint || "API call"}`; break;
          default: text = "(direct message)";
        }
        // ⚠ The simulator keeps NO handle list of its own. `tapTargetsOf` is the
        // same derivation the canvas draws its connector rows from, so a tap
        // here can only ever resolve a handle an edge could have been drawn to.
        // The copy that used to live in this switch emitted `row:<section>`
        // while the canvas drew `row:<section>:<row>`, so every list tap matched
        // no edge and the run reported END OF FLOW on a correctly wired menu —
        // and both options collapsed onto one handle besides. Nothing threw: a
        // handle matching no edge is indistinguishable from "the flow finished".
        const taps = tapTargetsOf(node);
        const buttons = taps.length ? taps.map(t => ({ text: t.label })) : null;
        const handles = taps.length ? taps.map(t => t.handle) : null;
        setConv(c => [...c, { from:"bot", text, time: now(), buttons, media, ownerNodeId: node.id }]);
        // A button that cannot advance the flow (a link button) must not park
        // the simulator waiting for a tap that will never mean anything.
        if (buttons && buttons.length && (handles.some(Boolean) || node.waitForReply)) {
          setWaiting({ nodeId: node.id, buttons, handles });
        } else if (node.waitForReply) {
          // No buttons, but the step waits: a free-text question. Park with no
          // buttons so the composer takes the answer.
          setWaiting({ nodeId: node.id, buttons: null, handles: null });
        } else {
          const next = resolveNext(node.id);
          next ? sched(() => playNode(next, runId), 900) : setEnded(true);
        }
        return;
      }
      const tpl = templates.find(t => String(t.id) === String(node.templateId));
      if (!tpl) {
        setConv(c => [...c, { from:"system", text:"[Warning] Message node has no template selected", time: now() }]);
        const next = resolveNext(node.id);
        next ? sched(() => playNode(next, runId), 600) : setEnded(true);
        return;
      }
      const text = resolveBody(tpl.body, node.bindings || {});
      // Every button is SHOWN (the customer really does see the link and call
      // buttons), but only a QUICK_REPLY can move the flow on — Meta sends no
      // inbound message at all for the others. A null handle marks those, and
      // the tap handler says so instead of silently doing nothing.
      //
      // The buttons come from the TEMPLATE (the node stores only a snapshot,
      // which can lag an edit), so this is the one place `tapTargetsOf` is fed
      // a synthetic node rather than the real one — same derivation, live data.
      const taps = tapTargetsOf({ ...node, messageMode: "template", buttons: tpl.buttons });
      const buttons = taps.length ? taps.map(t => ({ text: t.label })) : null;
      const handles = taps.length ? taps.map(t => t.handle) : null;
      setConv(c => [...c, { from:"bot", text, time: now(), buttons, ownerNodeId: node.id }]);
      // Park only when a tap can mean something, or the step waits for a typed
      // answer. A template whose buttons are all URL / phone taps and which is
      // NOT waiting used to strand the run here on a tap that can never advance
      // the flow — the direct-message path already guarded against exactly that.
      if (buttons && buttons.length && (handles.some(Boolean) || node.waitForReply)) {
        setWaiting({ nodeId: node.id, buttons, handles });
      } else if (node.waitForReply) {
        setWaiting({ nodeId: node.id, buttons: null, handles: null });
      } else {
        const next = resolveNext(node.id);
        next ? sched(() => playNode(next, runId), 900) : setEnded(true);
      }
    } else if (node.type === "condition") {
      const branch = (node.matchMode === "random") ? (Math.random() < 0.5 ? "yes" : "no") : "yes";
      setConv(c => [...c, { from:"system", text:`[Condition] ${node.title || "Condition"} — ${branch === "yes" ? "Matched" : "Not-matched"} branch`, time: now() }]);
      const next = resolveNext(node.id, branch);
      next ? sched(() => playNode(next, runId), 650) : setEnded(true);
    } else if (node.type === "action") {
      const actList = (node.actions || []).map(a => `${a.kind}${a.value ? " → " + a.value : ""}`);
      setConv(c => [...c, { from:"system", text:`[Action] ${actList.join(" · ") || (node.title || "Action")}`, time: now() }]);
      const next = resolveNext(node.id);
      next ? sched(() => playNode(next, runId), 600) : setEnded(true);
    } else if (node.type === "delay") {
      setConv(c => [...c, { from:"system", text:`[Delay] Wait ${node.waitValue || "10"} ${node.waitUnit || "minutes"}`, time: now() }]);
      const next = resolveNext(node.id);
      next ? sched(() => playNode(next, runId), 900) : setEnded(true);
    } else if (node.type === "ai") {
      const snippet = (node.aiGoal || "AI generates an answer").slice(0, 80);
      setConv(c => [...c, { from:"bot", text:`[AI] ${snippet}${(node.aiGoal || "").length > 80 ? "…" : ""}`, time: now() }]);
      const next = resolveNext(node.id);
      next ? sched(() => playNode(next, runId), 900) : setEnded(true);
    } else if (node.type === "ai_agent") {
      setConv(c => [...c, { from:"bot", text:`[AI Agent] (no model connected — preview unavailable)`, time: now() }]);
      const next = resolveNext(node.id);
      next ? sched(() => playNode(next, runId), 900) : setEnded(true);
    } else if (node.type === "handoff") {
      const count = (node.assigned || []).length;
      setConv(c => [...c, { from:"system", text:`[Handoff] Conversation assigned to ${count ? "the selected user" : "the inbox"} · ${node.priority || "high"} priority`, time: now() }]);
      setConv(c => [...c, { from:"system", text:"Flow ended — a live agent will continue.", time: now() }]);
      setEnded(true);
    } else if (node.type === "subflow") {
      const flow = otherAutomations.find(f => f.id === node.flowId);
      setConv(c => [...c, { from:"system", text:`[Sub-flow] ${flow?.name || "(none selected)"} · ${node.waitMode || "await"}`, time: now() }]);
      if (node.waitMode === "handoff") { setEnded(true); return; }
      const next = resolveNext(node.id);
      next ? sched(() => playNode(next, runId), 700) : setEnded(true);
    } else if (node.type === "api") {
      setConv(c => [...c, { from:"system", text:`[API] ${node.method || "POST"} ${(node.apiUrl || "API request").slice(0, 40)}`, time: now() }]);
      const next = resolveNext(node.id);
      next ? sched(() => playNode(next, runId), 700) : setEnded(true);
    } else if (node.type === "trigger") {
      const next = resolveNext(node.id);
      next ? sched(() => playNode(next, runId), 400) : setEnded(true);
    } else {
      setConv(c => [...c, { from:"system", text:`(${node.type} node — no preview)`, time: now() }]);
      const next = resolveNext(node.id);
      next ? sched(() => playNode(next, runId), 500) : setEnded(true);
    }
  };

  const onTapButton = (text, idx) => {
    if (!waiting) return;
    const { nodeId, handles } = waiting;
    // A link / call / copy-code button opens something on the phone and sends
    // us nothing, so the flow genuinely cannot continue from it. Say that
    // rather than appearing to accept the tap and then stopping.
    if (handles && handles[idx] === null) {
      setConv(c => [...c, {
        from: "system",
        text: "That button opens a link or dialler on the customer's phone. WhatsApp tells us nothing about it, so a flow cannot branch on it.",
        time: now(),
      }]);
      return;
    }
    setConv(c => [...c, { from:"user", text, time: now() }]);
    setWaiting(null);
    // A list's outputs are `row:*`, hence the explicit handle list rather than
    // an assumed `btn:<index>`.
    const next = resolveNext(nodeId, handles ? handles[idx] : `btn:${idx}`);
    if (next) sched(() => playNode(next, runRef.current), 600);
    else setEnded(true);
  };

  // Typing is allowed whenever the flow is parked on a reply — a free-text
  // question, or a menu where the customer types instead of tapping.
  const canType = !!waiting && !ended;

  const onSendTyped = () => {
    const text = typed.trim();
    if (!text || !canType) return;
    setTyped("");
    const { nodeId, handles } = waiting;
    setConv(c => [...c, { from:"user", text, time: now() }]);
    setWaiting(null);
    // Mirror resumeAutomation's order: a free-text answer follows `replied` on
    // a question that offered no choices, and `nomatch` on one that did.
    const target = resolveNext(nodeId, "replied")
      || resolveNext(nodeId, "nomatch")
      || resolveNext(nodeId, "default");
    if (target) sched(() => playNode(target, runRef.current), 600);
    else setEnded(true);
  };

  const restart = () => {
    clearTimers();
    setWaiting(null);
    setTyped("");
    setEnded(false);
    runRef.current += 1;
    const runId = runRef.current;
    setConv([]);
    const trigger = nodes.find(n => n.type === "trigger" && !n.disabled);
    if (!trigger) {
      setConv([{ from:"system", text:"[Warning] No active trigger node in this flow.", time: now() }]);
      setEnded(true);
      return;
    }
    const tk = trigger.triggerKind || "keyword";
    let firstItem;
    if (tk === "keyword") {
      const kw = (trigger.keyword || "PRICE").trim();
      const dir = trigger.triggerDirection || "inbound";
      if (dir === "outbound") {
        // Outbound trigger: YOU (a BD number) send the keyword — the flow runs
        // right after your message goes out. Show it as a business-sent message,
        // not a contact-sent one.
        setConv([
          { from:"system", text:"[Outbound] You sent this keyword from your BD number — this flow then runs.", time: now() },
          { from:"bot", text: kw, time: now(), ownerNodeId: trigger.id },
        ]);
        const next = resolveNext(trigger.id);
        if (next) sched(() => playNode(next, runId), 700);
        else setEnded(true);
        return;
      }
      firstItem = { from:"user", text: kw, time: now() };
    } else if (tk === "link") {
      const code = trigger.trackingCode || "WEB_HOMEPAGE_HERO";
      const msg  = trigger.prefilledMsg || "Hi, I'd like to know more";
      firstItem = { from:"user",   text: `${msg} · ${code}`, time: now() };
      setConv([{ from:"system", text:`[Link] Contact opened wa.me link · ${trigger.linkSource || "Website"}`, time: now() }, firstItem]);
      const next = resolveNext(trigger.id);
      if (next) sched(() => playNode(next, runId), 700);
      else setEnded(true);
      return;
    } else if (tk === "newContact") {
      firstItem = { from:"user", text:"Hello", time: now() };
      setConv([{ from:"system", text:"[New Contact] First time messaging this number", time: now() }, firstItem]);
      const next = resolveNext(trigger.id);
      if (next) sched(() => playNode(next, runId), 700);
      else setEnded(true);
      return;
    } else if (tk === "anyMessage") {
      firstItem = { from:"user", text:"Hi there", time: now() };
    } else if (tk === "tagApplied") {
      setConv([{ from:"system", text:`[Tag] "${trigger.tag || "Hot Lead"}" was ${trigger.tagDirection === "removed" ? "removed from" : "added to"} the contact`, time: now() }]);
      const next = resolveNext(trigger.id);
      if (next) sched(() => playNode(next, runId), 700);
      else setEnded(true);
      return;
    } else {
      firstItem = { from:"user", text:"(triggered)", time: now() };
    }
    setConv([firstItem]);
    const next = resolveNext(trigger.id);
    if (next) sched(() => playNode(next, runId), 700);
    else setEnded(true);
  };

  useEffect(() => {
    restart();
    return () => clearTimers();
    // eslint-disable-next-line
  }, []);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [conv, waiting, ended]);

  return (
    <div style={{ width:308, borderLeft:`1px solid ${C.cardBorder}`, background:"var(--c-surfaceInner, #FAFAF7)", flexShrink:0, display:"flex", flexDirection:"column", minHeight:0 }}>
      <div style={{ padding:"11px 14px", borderBottom:`1px solid ${C.cardBorder}`, display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
        <div>
          <div style={{ fontSize:12, color:C.muted, fontWeight:700, letterSpacing:".1em", textTransform:"uppercase" }}>Live Preview</div>
          <div style={{ fontSize:15, fontWeight:700, color:C.text1, marginTop:2 }}>WhatsApp simulator</div>
        </div>
        <IconBtn onClick={onClose}>{IC.x(15)}</IconBtn>
      </div>
      <div style={{ flex:1, minHeight:0, overflow:"hidden", padding:"14px 14px 10px", display:"flex", flexDirection:"column", alignItems:"center" }}>
        <div style={{
          width: 278, flex: 1, minHeight: 0, maxHeight: 600,
          background: "linear-gradient(155deg, var(--c-sd8d8de, #D8D8DE) 0%, #A6A6AD 30%, #82828A 58%, var(--c-sbfbfc5, #BFBFC5) 82%, #6E6E76 100%)",
          borderRadius: 52, padding: 3.5,
          boxShadow: "0 22px 50px rgba(0,0,0,.28), 0 4px 10px rgba(0,0,0,.10), inset 0 0 0 0.5px rgba(255,255,255,.55), inset 0 -2px 4px rgba(0,0,0,.18)",
          position: "relative", display: "flex", flexDirection: "column",
        }}>
          <div style={{ position:"absolute", left:0, top:84,  width:3, height:30, background:"linear-gradient(90deg,#4A4A50,#6B6B72)", borderRadius:"3px 0 0 3px" }}/>
          <div style={{ position:"absolute", left:0, top:130, width:3, height:48, background:"linear-gradient(90deg,#4A4A50,#6B6B72)", borderRadius:"3px 0 0 3px" }}/>
          <div style={{ position:"absolute", left:0, top:188, width:3, height:48, background:"linear-gradient(90deg,#4A4A50,#6B6B72)", borderRadius:"3px 0 0 3px" }}/>
          <div style={{ position:"absolute", right:0, top:130, width:3, height:64, background:"linear-gradient(270deg,#4A4A50,#6B6B72)", borderRadius:"0 3px 3px 0" }}/>
          <div style={{ position:"absolute", right:0, top:208, width:3, height:38, background:"linear-gradient(270deg,#4A4A50,#6B6B72)", borderRadius:"0 3px 3px 0" }}/>

          <div style={{ background: "#000", borderRadius: 48.5, padding: 2, flex: 1, minHeight: 0, display: "flex", flexDirection: "column", boxShadow: "inset 0 0 0 0.5px rgba(255,255,255,.12)" }}>
            <div style={{ flex: 1, minHeight: 0, position: "relative", borderRadius: 46.5, overflow: "hidden", display: "flex", flexDirection: "column", background: "#075E54" }}>
              <div style={{ position:"absolute", top:0, left:0, right:0, height:46, padding:"14px 28px 0", display:"flex", justifyContent:"space-between", alignItems:"flex-start", color:"#fff", zIndex:5, fontFamily:"-apple-system, 'SF Pro Display', system-ui, sans-serif", fontWeight:600, fontSize:15, letterSpacing:"-.01em", pointerEvents:"none" }}>
                <span style={{ minWidth:48, textAlign:"left" }}>{now()}</span>
                <div style={{ display:"flex", alignItems:"center", gap:5 }}>
                  <svg width="17" height="11" viewBox="0 0 17 11" style={{ display:"block" }}>
                    <rect x="0"  y="6.5" width="3" height="4.5" rx="0.7" fill="#fff"/>
                    <rect x="4"  y="4.5" width="3" height="6.5" rx="0.7" fill="#fff"/>
                    <rect x="8"  y="2.5" width="3" height="8.5" rx="0.7" fill="#fff"/>
                    <rect x="12" y="0.5" width="3" height="10.5" rx="0.7" fill="#fff"/>
                  </svg>
                  <svg width="15" height="11" viewBox="0 0 15 11" style={{ display:"block" }}>
                    <path d="M7.5 2.5 C 4 2.5, 1.5 4.5, 0.5 5.5 L 1.7 7 C 2.6 6.1, 4.6 4.5, 7.5 4.5 C 10.4 4.5, 12.4 6.1, 13.3 7 L 14.5 5.5 C 13.5 4.5, 11 2.5, 7.5 2.5 Z" fill="#fff"/>
                    <path d="M7.5 5.5 C 5.5 5.5, 4 6.6, 3.3 7.4 L 4.5 8.7 C 5 8.1, 6 7.5, 7.5 7.5 C 9 7.5, 10 8.1, 10.5 8.7 L 11.7 7.4 C 11 6.6, 9.5 5.5, 7.5 5.5 Z" fill="#fff"/>
                    <circle cx="7.5" cy="9.7" r="1.1" fill="#fff"/>
                  </svg>
                  <svg width="27" height="13" viewBox="0 0 27 13" style={{ display:"block" }}>
                    <rect x="0.5" y="0.5" width="23" height="12" rx="3" fill="none" stroke="#fff" strokeOpacity="0.45" strokeWidth="1"/>
                    <rect x="24.5" y="4" width="1.5" height="5" rx="0.6" fill="#fff" fillOpacity="0.45"/>
                    <rect x="2" y="2" width="20" height="9" rx="1.7" fill="#fff"/>
                  </svg>
                </div>
              </div>

              <div style={{ position:"absolute", top:11, left:"50%", transform:"translateX(-50%)", width:108, height:32, background:"#000", borderRadius:99, zIndex:6, boxShadow:"inset 0 0 0 0.5px rgba(255,255,255,.08), 0 0 0 0.5px #000" }}>
                <div style={{ position:"absolute", top:11, right:14, width:9, height:9, borderRadius:"50%", background:"#1a1a1d", boxShadow:"inset 0 0 0 1px #050505, inset 0 0 4px rgba(80,120,200,.3)" }}/>
              </div>

              <div style={{ background:"#075E54", paddingTop:50, paddingBottom:8, paddingLeft:12, paddingRight:12, color:"#fff", fontFamily:"-apple-system, 'SF Pro Display', system-ui, sans-serif", flexShrink:0, position:"relative", zIndex:1 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ color:"#fff", fontSize:22, lineHeight:1, opacity:.9, marginRight:-2 }}>‹</span>
                  <div style={{ width:30, height:30, borderRadius:"50%", background:`linear-gradient(135deg,${C.brandBright},${C.brand})`, display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontSize:14, fontWeight:700, flexShrink:0 }}>F</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:15, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>Forge Automation</div>
                    <div style={{ fontSize:12, opacity:.82, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{ended ? "Conversation ended" : waiting ? "Waiting for your reply" : "typing…"}</div>
                  </div>
                  <svg width="20" height="14" viewBox="0 0 20 14" style={{ display:"block", flexShrink:0 }}>
                    <rect x="0.5" y="1.5" width="13" height="11" rx="2.5" fill="none" stroke="#fff" strokeWidth="1.4"/>
                    <path d="M14 5.5 L19 3 L19 11 L14 8.5 Z" fill="none" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round"/>
                  </svg>
                  <svg width="15" height="15" viewBox="0 0 15 15" style={{ display:"block", flexShrink:0 }}>
                    <path d="M3 1 L5 1 L6.5 4.5 L5 6 C 6 8, 7 9, 9 10 L 10.5 8.5 L 14 10 L 14 12 C 14 13, 13 14, 12 14 C 6 14, 1 9, 1 3 C 1 2, 2 1, 3 1 Z" fill="none" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round"/>
                  </svg>
                </div>
              </div>

              {/* Anchored so a test can read the CONVERSATION alone. The canvas
                  behind it renders every node's body text too, so an unscoped
                  assertion that "the flow reached the ONE branch" passes even
                  when it reached neither. */}
              <div ref={chatRef} data-testid="preview-chat" style={{ flex:1, minHeight:0, overflowY:"auto", background:"var(--c-chatWall)", padding:"10px 7px", backgroundImage:"var(--c-chatPattern)" }}>
                <div style={{ display:"flex", justifyContent:"center", marginBottom:8 }}>
                  <span style={{ background:"var(--c-infoBg, #E1F2FA)", color:"var(--c-s3c6678, #3C6678)", fontSize:11, padding:"2px 9px", borderRadius:99, fontWeight:600 }}>TODAY</span>
                </div>
                {conv.map((m, i) => {
                  if (m.from === "system") {
                    return (
                      <div key={i} style={{ display:"flex", justifyContent:"center", margin:"6px 0" }}>
                        <div style={{ background:"var(--c-warnBgSoft, #FFF8E1)", border:"1px solid #FFE082", color:"var(--c-s7a5c00, #7A5C00)", fontSize:11, padding:"3px 9px", borderRadius:99, fontWeight:600, maxWidth:"90%", textAlign:"center", lineHeight:1.4 }}>{m.text}</div>
                      </div>
                    );
                  }
                  const isUser = m.from === "user";
                  const hasButtons = m.buttons && m.buttons.length > 0;
                  const isWaitingOnThese = waiting && waiting.nodeId === m.ownerNodeId;
                  return (
                    <div key={i} style={{ display:"flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom:4 }}>
                      <div style={{ background: isUser ? "var(--c-sdcf8c6, #DCF8C6)" : "var(--c-surface, #fff)", borderRadius: isUser ? "8px 0 8px 8px" : "0 8px 8px 8px", maxWidth: "82%", fontSize:13, color:"var(--c-t1, #111)", lineHeight:1.4, overflow:"hidden", boxShadow:"0 1px 1px rgba(0,0,0,.07)" }}>
                        <div style={{ padding:"5px 9px" }}>
                          {/* Attachments read as a typed chip, the way WhatsApp
                              shows a placeholder before media loads. */}
                          {m.media && (
                            <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom: m.text ? 4 : 2,
                              background:"var(--c-surfaceInner, #F5F5F0)", borderRadius:5, padding:"5px 7px",
                              fontSize:12, fontWeight:700, color:"var(--c-t4, #666)", letterSpacing:".02em" }}>
                              {m.media}
                            </div>
                          )}
                          {m.text}
                          <div style={{ fontSize:11, color:"var(--c-s667781, #667781)", textAlign:"right", marginTop:2, fontFamily:"-apple-system, 'SF Pro Display', sans-serif", display:"flex", justifyContent:"flex-end", alignItems:"center", gap:3 }}>
                            {m.time}
                          </div>
                        </div>
                        {hasButtons && (
                          <div style={{ borderTop:"1px solid #E0E0E0" }}>
                            {m.buttons.map((btn, idx) => (
                              // ⚠ Pass the LABEL, never the button object. The
                              // handler stores what it is given as the
                              // customer's message and the bubble renders it as
                              // a React child — handing it an object throws and
                              // PageErrorBoundary replaces the whole route with
                              // "This page ran into a problem". Payment buttons
                              // never crashed only because they pass strings.
                              <button key={idx} onClick={()=>isWaitingOnThese && onTapButton(buttonLabel(btn, idx), idx)} disabled={!isWaitingOnThese}
                                style={{ display:"block", width:"100%", padding:"7px 9px", border:"none", borderTop:"1px solid #F0F0F0", textAlign:"center", color:"#00A5F4", fontSize:13, fontWeight:500, background:"transparent", cursor: isWaitingOnThese ? "pointer" : "default", opacity: isWaitingOnThese ? 1 : 0.4, fontFamily:"-apple-system, 'SF Pro Display', sans-serif", transition:"background .12s" }}
                                onMouseEnter={(e)=>{ if (isWaitingOnThese) e.currentTarget.style.background = "var(--c-xf5fbff, #F5FBFF)"; }}
                                onMouseLeave={(e)=>{ e.currentTarget.style.background = "transparent"; }}
                              >{buttonLabel(btn, idx)}</button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {ended && (
                  <div style={{ display:"flex", justifyContent:"center", marginTop:10 }}>
                    <span style={{ background:"var(--c-successBg, #E1F5EE)", color:C.brandDark, fontSize:11, padding:"3px 10px", borderRadius:99, fontWeight:700, letterSpacing:".06em", textTransform:"uppercase" }}>End of flow</span>
                  </div>
                )}
              </div>

              {/* A REAL composer. It used to be a static div reading "Tap a
                  reply button above", so a free-text question — which by
                  definition has no buttons — could not be answered at all and
                  the preview stopped dead at END OF FLOW. */}
              <div style={{ background:"var(--c-xf0f0f0, #F0F0F0)", padding:"7px 9px 22px", display:"flex", alignItems:"center", gap:6, flexShrink:0, position:"relative" }}>
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") onSendTyped(); }}
                  disabled={!canType}
                  placeholder={
                    canType ? "Type a reply…"
                    : ended ? "Conversation ended — tap Restart"
                    : "Waiting for the next message…"
                  }
                  style={{ flex:1, background:"var(--c-surface, #fff)", borderRadius:99, padding:"6px 12px",
                    fontSize:12, color:"var(--c-t1, #111)", border:"1px solid var(--c-border, #E5E5E0)",
                    outline:"none", fontFamily:"'DM Sans'", minWidth:0 }}
                />
                <div onClick={() => canType && onSendTyped()}
                  style={{ width:28, height:28, background: canType ? "var(--c-waGreen, #25D366)" : "var(--c-t7, #999)", borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", flexShrink:0, boxShadow:"0 1px 2px rgba(0,0,0,.15)", cursor: canType ? "pointer" : "default" }}>{IC.send(13)}</div>
                <div style={{ position:"absolute", bottom:6, left:"50%", transform:"translateX(-50%)", width:110, height:4, background:"#111", borderRadius:99, opacity:.85 }}/>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div style={{ padding:"10px 12px 12px", borderTop:`1px solid ${C.cardBorder}`, display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, flexShrink:0 }}>
        <Btn kind="ghost" size="sm" onClick={restart}>↻ Restart</Btn>
        <Btn kind="primary" size="sm" icon={IC.send(12)} onClick={restart}>Run again</Btn>
      </div>
    </div>
  );
};


/* ══════════════════════════════════════════════════════════════════════
   CANVAS + BUILDER — Full pan / zoom / drag / connect
   ══════════════════════════════════════════════════════════════════════ */

const findDataAttr = (el, attr) => {
  while (el && el !== document.body) {
    if (el.dataset && el.dataset[attr] !== undefined) return el;
    el = el.parentElement;
  }
  return null;
};

const Canvas = ({
  nodes, edges, selectedId, setSelectedId, transform, setTransform,
  onStartDrag, onStartConnect, onPickAgentResource, ghost, panning, connectTargetId,
  onClickEdgePlus, onClickAppendPlus, onClickEdgeDelete, onDeleteNode, onDuplicateNode,
  viewportRef, onViewportMouseDown, onAutoLayout, whatsappAccounts, onRowClick, canvasTemplates=[],
}) => {
  const map = Object.fromEntries(nodes.map(n=>[n.id,n]));
  // Which handles already carry a real edge, so a node can render a filled dot
  // versus a hollow ring. `e.to` matters: a placeholder row with a null target
  // is not a connection, and treating it as one is what used to suppress the
  // append control on every button of a freshly-picked template.
  const [hoveredEdge, setHoveredEdge] = React.useState(null);
  const hoverTimer = React.useRef(null);
  const setEdgeHover = (i) => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    if (i == null) hoverTimer.current = setTimeout(() => setHoveredEdge(null), 260);
    else setHoveredEdge(i);
  };

  const wiredByNode = {};
  edges.forEach(e => {
    if (!e.to) return;
    (wiredByNode[e.from] || (wiredByNode[e.from] = new Set())).add(e.fromHandle || "default");
  });
  const edgePluses = edges.map((e, i) => {
    const a = map[e.from]; const b = map[e.to]; if (!a||!b) return null;
    const p1 = handlePos(a, "output", e.fromHandle || "default");
    const p2 = handlePos(b, "input");
    return { x:(p1.x + p2.x) / 2, y:(p1.y + p2.y) / 2, edgeIndex: i, isLabeled: !!e.label };
  }).filter(Boolean);

  const appendPluses = [];
  nodes.forEach(n => {
    const handles = outputHandlesOf(n);
    handles.forEach(handle => {
      // AI Agent side handles open a resource picker — no "+" append button.
      if (n.type === "ai_agent" && (handle === "model" || handle === "tool")) return;
      // ⚠ `e.to` is load-bearing. onSelectTemplate used to write placeholder
      // rows {from, to:null, fromHandle:'btn:N'}, which Connectors refused to
      // draw and edgePluses filtered out — but this test accepted them, so
      // picking a template with reply buttons left the node with N handles, no
      // edges, and NO append controls at all. Live flow 4 still carries one.
      const hasEdge = edges.some(e => e.from === n.id && (e.fromHandle || "default") === handle && e.to);
      if (!hasEdge) {
        // To the RIGHT of the row now, not 50px below it: outputs leave from
        // the right edge, so a "+" underneath would point at nothing.
        const p = handlePos(n, "output", handle);
        appendPluses.push({ x:p.x+46, y:p.y, fromId:n.id, fromHandle:handle });
      }
    });
  });

  const selectedNode = nodes.find(n => n.id === selectedId);

  return (
    <div
      ref={viewportRef}
      onMouseDown={onViewportMouseDown}
      onClick={(e) => { if (!e.target.closest("[data-node-id]")) setSelectedId(null); }}
      style={{
        flex:1, position:"relative", overflow:"hidden", background:C.pageBg,
        cursor: panning ? "grabbing" : "grab",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      <div className="canvas-bg" style={{
        position:"absolute", inset:0,
        backgroundImage:`radial-gradient(${C.cardBorder} 1px, transparent 1px)`,
        backgroundSize: `${18*transform.scale}px ${18*transform.scale}px`,
        backgroundPosition: `${transform.x}px ${transform.y}px`,
        pointerEvents:"none",
      }}/>

      <div style={{
        position:"absolute", top:0, left:0, width:"100%", height:"100%",
        transform:`translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
        transformOrigin:"0 0",
      }}>
        <Connectors nodes={nodes} edges={edges} ghost={ghost} onEdgeHover={setEdgeHover}/>

        {nodes.map(n => (
          <FlowNode
            key={n.id} n={n} selected={selectedId===n.id}
            isDropTarget={connectTargetId===n.id}
            onSelect={setSelectedId}
            onStartDrag={onStartDrag}
            onStartConnect={onStartConnect}
            onPickAgentResource={onPickAgentResource}
            whatsappAccounts={whatsappAccounts}
            wiredHandles={wiredByNode[n.id]}
            onRowClick={onRowClick}
            whatsappTemplates={canvasTemplates}
          />
        ))}

        {/* Only ONE control on an edge, and only while you are pointing at it.
            Every edge used to carry a permanent "+" and "x" chip, and every
            unconnected handle carried a third — so a five-branch node put
            thirteen red circles on the canvas, none of them attached to
            anything you were looking at. Connecting is now the handle's own
            job (click the circle), which leaves the edge with exactly one
            reason to exist: removing it. */}
        {hoveredEdge != null && edgePluses.find(p => p.edgeIndex === hoveredEdge) && (
          <div onMouseEnter={() => setEdgeHover(hoveredEdge)} onMouseLeave={() => setEdgeHover(null)}>
            <EdgeDelete
              x={edgePluses.find(p => p.edgeIndex === hoveredEdge).x}
              y={edgePluses.find(p => p.edgeIndex === hoveredEdge).y}
              onClick={(e) => onClickEdgeDelete(e, hoveredEdge)}
            />
          </div>
        )}

        {selectedNode && (
          <NodeActions
            x={selectedNode.x + NODE_W/2}
            y={selectedNode.y - 8}
            onDuplicate={()=>onDuplicateNode(selectedNode.id)}
            onDelete={()=>onDeleteNode(selectedNode.id)}
          />
        )}
      </div>

      <div style={{ position:"absolute", top:14, left:"50%", transform:"translateX(-50%)", background:"var(--c-surface, #fff)", border:`1px solid ${C.cardBorder}`, borderRadius:99, padding:"6px 14px", display:"flex", alignItems:"center", gap:10, boxShadow:"0 2px 8px rgba(0,0,0,.05)", fontSize:14, color:C.text3, fontWeight:500, fontFamily:"'DM Sans'", whiteSpace:"nowrap" }}>
        <span>Tap a step to edit</span>
        <span style={{ width:1, height:12, background:C.cardBorder }}/>
        <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}>
          <span style={{ width:16, height:16, borderRadius:"50%", background:"var(--c-surface, #fff)", border:`1.5px dashed ${C.text4}`, color:C.text4, fontSize:14, fontWeight:600, display:"inline-flex", alignItems:"center", justifyContent:"center", lineHeight:1 }}>+</span>
          Click to add a block
        </span>
        <span style={{ width:1, height:12, background:C.cardBorder }}/>
        <span>Drag handle to connect · Drag canvas to pan</span>
      </div>

      <div style={{ position:"absolute", bottom:14, left:14, display:"flex", gap:6 }}>
        <button onClick={()=>setTransform({ x:30, y:30, scale:0.7 })} style={{ background:"var(--c-surface, #fff)", border:`1px solid ${C.cardBorder}`, borderRadius:10, padding:"6px 10px", display:"flex", alignItems:"center", gap:6, fontSize:14, fontFamily:"'DM Mono'", fontWeight:700, color:C.text2, cursor:"pointer", boxShadow:"0 2px 8px rgba(0,0,0,.04)" }}>{IC.fit(13)} Fit</button>
        <button onClick={onAutoLayout} style={{ background:"var(--c-surface, #fff)", border:`1px solid ${C.cardBorder}`, borderRadius:10, padding:"6px 10px", display:"flex", alignItems:"center", gap:6, fontSize:14, fontFamily:"'DM Mono'", fontWeight:700, color:C.text2, cursor:"pointer", boxShadow:"0 2px 8px rgba(0,0,0,.04)" }}>{IC.flow(13)} Auto layout</button>
      </div>

      <MiniMap nodes={nodes} transform={transform}/>
    </div>
  );
};

const MiniMap = ({ nodes, transform }) => {
  const mw = 164, mh = 100;
  if (!nodes || !nodes.length) {
    return (
      <div style={{ position:"absolute", bottom:14, right:14, width:mw+16, background:"var(--c-surface, #fff)", border:`1px solid ${C.cardBorder}`, borderRadius:10, padding:8, boxShadow:"0 4px 14px rgba(0,0,0,.05)" }}>
        <div style={{ fontSize:13, fontWeight:700, color:C.muted, letterSpacing:".1em", textTransform:"uppercase", marginBottom:5 }}>Mini-map</div>
        <div style={{ width:mw, height:mh, background:C.sectionBg, borderRadius:6 }}/>
      </div>
    );
  }
  const minX = Math.min(...nodes.map(n=>n.x)) - 40;
  const minY = Math.min(...nodes.map(n=>n.y)) - 40;
  const maxX = Math.max(...nodes.map(n=>n.x + NODE_W)) + 40;
  const maxY = Math.max(...nodes.map(n=>n.y + nodeH(n))) + 40;
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const s = Math.min(mw / w, mh / h);
  const offX = (mw - w * s) / 2;
  const offY = (mh - h * s) / 2;
  return (
    <div style={{ position:"absolute", bottom:14, right:14, width:mw+16, background:"var(--c-surface, #fff)", border:`1px solid ${C.cardBorder}`, borderRadius:10, padding:8, boxShadow:"0 4px 14px rgba(0,0,0,.05)" }}>
      <div style={{ fontSize:13, fontWeight:700, color:C.muted, letterSpacing:".1em", textTransform:"uppercase", marginBottom:5 }}>Mini-map</div>
      <div style={{ position:"relative", width:mw, height:mh, background:C.sectionBg, borderRadius:6, overflow:"hidden" }}>
        {nodes.map(n=>{
          const t = NT[n.type] || NT_FALLBACK;
          return <div key={n.id} style={{
            position:"absolute",
            left: offX + (n.x - minX) * s,
            top:  offY + (n.y - minY) * s,
            width: NODE_W * s,
            height: nodeH(n) * s,
            background:t.accent, borderRadius:1, opacity:.9,
          }}/>;
        })}
      </div>
    </div>
  );
};


/* ══════════════════════════════════════════════════════════════════════
   AUTOMATION BUILDER VIEW — exported component
   ══════════════════════════════════════════════════════════════════════ */

const AutomationBuilderView = ({ automation, onBack, onSave, onToggleStatus, activeTab, onTabChange, initialExecutionId, onNavigate }) => {
  const [toggleBusy, setToggleBusy] = useState(false);
  const handleToggleStatus = onToggleStatus ? async (next) => {
    if (toggleBusy) return;
    setToggleBusy(true);
    try {
      // Save FIRST when going live. The activation gate validates the stored
      // config, so activating with unsaved edits would check the previous
      // version — it would pass on a flow the canvas has since broken, or
      // refuse one the canvas has since fixed. Either way "the builder said it
      // was fine" and what actually runs would disagree.
      // `isDirty` / `handleSave` are declared further down the component. That
      // is safe ONLY because this closure runs on click, long after the body
      // has finished — referencing either during RENDER would throw on the
      // temporal dead zone and white out the page.
      if (next === "active" && isDirty) await handleSave();
      await onToggleStatus(next);
    } finally { setToggleBusy(false); }
  } : undefined;
  const [templates,       setTemplates]       = useState([]);
  const [tags,            setTags]            = useState([]);
  const [otherAutomations, setOtherAutomations] = useState([]);
  const [whatsappAccounts, setWhatsappAccounts] = useState([]);
  const [aiModels,        setAiModels]        = useState([]);
  const [assignableUsers, setAssignableUsers] = useState([]);
  const [leadFields,      setLeadFields]      = useState([]);
  const [loading,         setLoading]         = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [tpls, tgs, flows, accs, ais, usrs, lf] = await Promise.all([
          api.templates.list(),
          api.tags.list(),
          api.chatbots.list(),
          api.whatsappAccounts.list(true).catch(() => []),
          api.aiModels.list().catch(() => []),
          api.users.list().catch(() => []),
          api.chatbots.leadFields().catch(() => ({ fields: [] })),
        ]);
        if (!alive) return;
        // Include APPROVED (sendable) and SUBMITTED (pending Meta review) so a
        // just-submitted template can be wired into an automation now and will
        // send once Meta approves it. The picker shows a status badge + a
        // "can not be sent until approved" note for non-approved ones.
        setTemplates((tpls || []).filter(t => {
          const s = String(t.status || "").toUpperCase();
          return s === "APPROVED" || s === "SUBMITTED";
        }));
        // Managed tags (Funnel Stage, Product) are mirrored by the backend; an
        // automation must not hand-assign one. Use Change Funnel Stage instead.
        setTags((tgs || []).filter(t => !t.managed));
        setOtherAutomations((flows || []).filter(f => f.id !== automation?.id));
        setWhatsappAccounts(accs || []);
        setAiModels(ais || []);
        setAssignableUsers((usrs || []).filter(u => u.isActive !== false && u.role !== undefined));
        // ⚠ The endpoint answers `{fields:[…]}`, not a bare array — an
        // Array.isArray guard here would render the empty picker forever
        // with a perfectly healthy backend behind it.
        setLeadFields(Array.isArray(lf) ? lf : (lf?.fields || []));
      } catch (e) {
        console.error("AutomationBuilderView load error:", e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [automation?.id]);

  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [saving, setSaving] = useState(false);
  const savedSnapshotRef = useRef("");
  const [savedSnapshot, setSavedSnapshot] = useState("");

  const idRef = useRef(1);
  const computeNextId = useCallback((currentNodes) => {
    let max = 0;
    for (const n of currentNodes) {
      const num = parseInt(String(n.id).replace(/^\D+/, ""), 10);
      if (!isNaN(num) && num > max) max = num;
    }
    return max + 1;
  }, []);
  const newId = useCallback(() => {
    const v = idRef.current;
    idRef.current += 1;
    return "n" + v;
  }, []);

  useEffect(() => {
    const cfg = automation?.config || {};
    let initialNodes, initialEdges;
    if (cfg.nodes && cfg.nodes.length > 0) {
      initialNodes = cfg.nodes.map(n => ({ ...n, disabled: n.disabled === true }));
      initialEdges = cfg.edges || [];
      setNodes(initialNodes);
      setEdges(initialEdges);
      const next = computeNextId(cfg.nodes);
      idRef.current = next;
    } else {
      const t = defaultTriggerNode(0, 0);
      idRef.current = computeNextId([t]) + 1;
      initialNodes = [t];
      initialEdges = [];
      setNodes(initialNodes);
      setEdges(initialEdges);
    }
    // Reset history with initial state
    setHistory([{ nodes: JSON.parse(JSON.stringify(initialNodes)), edges: JSON.parse(JSON.stringify(initialEdges)) }]);
    setHistoryIndex(0);
    // Reset saved snapshot to the loaded state — builder opens "clean"
    const initialSnap = JSON.stringify({ nodes: initialNodes, edges: initialEdges });
    savedSnapshotRef.current = initialSnap;
    setSavedSnapshot(initialSnap);
  }, [automation?.id]);

  const [selectedId, setSelectedId] = useState(null);
  const [transform,  setTransform]  = useState({ x:30, y:30, scale:0.7 });
  const [panning,    setPanning]    = useState(false);
  const [showPreview,setShowPreview]= useState(false);
  const [picker,     setPicker]     = useState(null);
  const [agentPicker,setAgentPicker]= useState(null);
  const [confirmOpen,setConfirmOpen]= useState(false);
  const [ghost,      setGhost]      = useState(null);
  const [connectTargetId, setConnectTargetId] = useState(null); // node highlighted as a drop target while dragging a connection

  // ── Undo / Redo history ──
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyLockRef = useRef(false);
  const dragStartStateRef = useRef(null);
  // Always the CURRENT graph. Window-registered handlers (drag, connect) run
  // from the closure they were attached in, which is stale by the time they
  // fire; reading through a ref is what makes their end-of-gesture bookkeeping
  // see what actually happened.
  const liveGraphRef = useRef({ nodes: [], edges: [] });
  liveGraphRef.current = { nodes, edges };

  const pushHistory = useCallback((currentNodes, currentEdges) => {
    if (historyLockRef.current) return;
    setHistory(prev => {
      const next = prev.slice(0, historyIndex + 1);
      next.push({
        nodes: JSON.parse(JSON.stringify(currentNodes)),
        edges: JSON.parse(JSON.stringify(currentEdges)),
      });
      return next.slice(-50);
    });
    setHistoryIndex(prev => Math.min(prev + 1, 49));
  }, [historyIndex]);

  const undo = useCallback(() => {
    if (historyIndex <= 0) return;
    historyLockRef.current = true;
    const entry = history[historyIndex - 1];
    setNodes(entry.nodes);
    setEdges(entry.edges);
    setHistoryIndex(historyIndex - 1);
    requestAnimationFrame(() => { historyLockRef.current = false; });
  }, [history, historyIndex]);

  const redo = useCallback(() => {
    if (historyIndex >= history.length - 1) return;
    historyLockRef.current = true;
    const entry = history[historyIndex + 1];
    setNodes(entry.nodes);
    setEdges(entry.edges);
    setHistoryIndex(historyIndex + 1);
    requestAnimationFrame(() => { historyLockRef.current = false; });
  }, [history, historyIndex]);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  const viewportRef   = useRef(null);
  const dragRef       = useRef(null);
  const connectRef    = useRef(null);
  const panRef        = useRef(null);
  const longPressRef  = useRef(null);

  const [selSet, setSelSet] = useState(new Set());
  const addSel = (id) => setSelSet(s => new Set([...Array.from(s), id]));
  const toggleSel = (id) => setSelSet(s => { const ns = new Set(s); if (ns.has(id)) ns.delete(id); else ns.add(id); return ns; });

  const transformRef = useRef(transform);
  useEffect(() => { transformRef.current = transform; }, [transform]);
  const selSetRef = useRef(selSet);
  useEffect(() => { selSetRef.current = selSet; }, [selSet]);

  const screenToWorld = (sx, sy) => {
    const t = transformRef.current;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return { x: sx, y: sy };
    return { x: (sx - rect.left - t.x) / t.scale, y: (sy - rect.top - t.y) / t.scale };
  };

  const autoLayout = useCallback(() => {
    setNodes(prev => {
      const next = layoutTree(prev, edges);
      pushHistory(next, edges);
      return next;
    });
  }, [edges]);

  const updateNode = (id, patch) => {
    if (typeof patch === "function") {
      setNodes(prev => prev.map(n => n.id === id ? patch(n) : n));
    } else {
      setNodes(prev => prev.map(n => n.id === id ? { ...n, ...patch } : n));
    }
  };

  const onSelectTemplate = (nodeId, templateId) => {
    const tpl = templates.find(t => String(t.id) === String(templateId));
    if (!tpl) return;
    // Stamp the body too: nodeLayout is pure and cannot look a template up, so
    // without this the card would reserve space for a bubble it cannot fill.
    updateNode(nodeId, { templateId, title: tpl.name, buttons: tpl.buttons || null, templateBody: tpl.body || "" });
    setEdges(prev => {
      // Drop this node's button edges and write NOTHING back.
      //
      // This used to push a placeholder row per button with `to: null` to mean
      // "declared but unconnected". Three consumers read that row three
      // different ways — Connectors skipped it, edgePluses filtered it out, and
      // appendPluses counted it as already wired — so the net effect was a node
      // with handles, no visible edges and no way to add one except a precision
      // drag. "Declared but unconnected" is a UI state (an empty handle), not
      // an edge; the handles come from outputHandlesOf on their own.
      const next = prev.filter(e => e.from !== nodeId || !e.fromHandle?.startsWith("btn:"));
      pushHistory(nodes, next);
      return next;
    });
  };

  const removeNode = (id) => {
    setNodes(prev => {
      const nextNodes = prev.filter(n => n.id !== id);
      setEdges(prevEdges => {
        const nextEdges = prevEdges.filter(e => e.from !== id && e.to !== id);
        pushHistory(nextNodes, nextEdges);
        return nextEdges;
      });
      return nextNodes;
    });
    if (selectedId === id) setSelectedId(null);
    setSelSet(s => { const ns = new Set(s); ns.delete(id); return ns; });
  };

  const duplicateNode = (id) => {
    const src = nodes.find(n => n.id === id);
    if (!src) return;
    const nid = newId();
    const copy = { ...src, id: nid, x: src.x + 50, y: src.y + 50 };
    if (copy.actions) copy.actions = copy.actions.map(a => ({ ...a, id: "a" + Date.now() + Math.random() }));
    setNodes(prev => {
      const next = [...prev, copy];
      pushHistory(next, edges);
      return next;
    });
    setSelectedId(nid);
  };

  const toggleNodeDisable = (id) => {
    const node = nodes.find(n => n.id === id);
    if (!node) return;
    const willDisable = !node.disabled;
    let nextEdges = edges;
    if (willDisable) {
      const inbound = edges.filter(e => e.to === id);
      const outbound = edges.filter(e => e.from === id);
      const bypass = [];
      for (const inEdge of inbound) {
        for (const outEdge of outbound) {
          bypass.push({ from: inEdge.from, to: outEdge.to, fromHandle: inEdge.fromHandle });
        }
      }
      nextEdges = [
        ...edges.filter(e => e.from !== id && e.to !== id),
        ...bypass,
      ];
      setEdges(nextEdges);
    }
    setNodes(prev => {
      const next = prev.map(n => n.id === id ? { ...n, disabled: willDisable } : n);
      pushHistory(next, nextEdges);
      return next;
    });
  };

  const onStartDrag = (e, id) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!selSet.has(id)) setSelectedId(id);
    const node = nodes.find(n => n.id === id);
    const pos = screenToWorld(e.clientX, e.clientY);
    const dx = pos.x - node.x;
    const dy = pos.y - node.y;
    dragRef.current = { id, dx, dy, multi: e.metaKey || e.ctrlKey, shift: e.shiftKey };
    dragStartStateRef.current = { nodes: JSON.parse(JSON.stringify(nodes)), edges: JSON.parse(JSON.stringify(edges)) };
    if (e.metaKey || e.ctrlKey) { toggleSel(id); }
    else if (e.shiftKey) { if (!selSet.has(id)) addSel(id); }
    else { setSelSet(new Set([id])); }
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragUp);
  };

  const onDragMove = useCallback((e) => {
    const d = dragRef.current; if (!d) return;
    const pos = screenToWorld(e.clientX, e.clientY);
    const nx = pos.x - d.dx;
    const ny = pos.y - d.dy;
    const s = selSetRef.current;
    if (s.has(d.id) && s.size > 1) {
      setNodes(prev => prev.map(n => {
        if (!s.has(n.id)) return n;
        const src = prev.find(x => x.id === d.id);
        const diffX = nx - src.x, diffY = ny - src.y;
        return { ...n, x: n.x + diffX, y: n.y + diffY };
      }));
    } else {
      setNodes(prev => prev.map(n => n.id === d.id ? { ...n, x: nx, y: ny } : n));
    }
  }, []);

  const onDragUp = useCallback(() => {
    if (dragStartStateRef.current) {
      const startNodes = dragStartStateRef.current.nodes;
      // ⚠ Read the CURRENT nodes from a ref, not from the closure.
      //
      // This handler is registered on `window` at mousedown, so the instance
      // actually attached closes over `nodes` as it was BEFORE the drag.
      // Comparing that against the deep copy taken at the same moment compares
      // a value with its own source: `hasMoved` was always false and
      // pushHistory never ran, so moving a node was not undoable and Ctrl+Z
      // silently reverted an EARLIER edit instead. Invisible to a build, and
      // to any test that calls the handler directly rather than dragging.
      const current = liveGraphRef.current;
      const hasMoved = JSON.stringify(startNodes) !== JSON.stringify(current.nodes);
      if (hasMoved) pushHistory(current.nodes, current.edges);
      dragStartStateRef.current = null;
    }
    dragRef.current = null;
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragUp);
  }, [pushHistory]);

  const onViewportMouseDown = (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.target.closest("[data-node-id]")) return;
    panRef.current = { x: e.clientX, y: e.clientY, ox: transform.x, oy: transform.y };
    setPanning(true);
    window.addEventListener("mousemove", onPanMove);
    window.addEventListener("mouseup", onPanUp);
  };
  const onPanMove = useCallback((e) => {
    const p = panRef.current; if (!p) return;
    setTransform(t => ({ ...t, x: p.ox + e.clientX - p.x, y: p.oy + e.clientY - p.y }));
  }, []);
  const onPanUp = useCallback(() => {
    panRef.current = null;
    setPanning(false);
    window.removeEventListener("mousemove", onPanMove);
    window.removeEventListener("mouseup", onPanUp);
  }, []);

  // A connection can be started from EITHER end:
  //   mode "forward" — dragging from a node's output dot, looking for a target.
  //   mode "reverse" — dragging from a node's input tab, looking for a source.
  // Both produce the identical { from, to, fromHandle } edge, so direction is
  // always real flow direction and the arrow marker never lies.
  const onStartConnect = (e, nodeId, handle, mode = "forward") => {
    e.stopPropagation();
    const node = nodes.find(n => n.id === nodeId);
    if (mode === "reverse") {
      connectRef.current = { mode: "reverse", toId: nodeId };
      const p = node ? handlePos(node, "input") : { x:0, y:0 };
      // Anchored at the input, so the ghost's arrowhead still points INTO this
      // node — the same way the finished edge will.
      setGhost({ x1: p.x, y1: p.y, x2: p.x, y2: p.y, reverse: true });
    } else {
      connectRef.current = { mode: "forward", fromId: nodeId, fromHandle: handle };
      const p = node ? handlePos(node, "output", handle) : { x:0, y:0 };
      setGhost({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
    }
    window.addEventListener("mousemove", onConnectMove);
    window.addEventListener("mouseup", onConnectUp);
  };

  // Resolve the node the cursor is over into a valid connection target. A node
  // is a valid target if it renders an input handle (triggers don't) and isn't
  // the source node — so you can drop the connection ANYWHERE on the node, not
  // just onto the tiny input handle (n8n-style).
  const dropTargetAt = (clientX, clientY, fromId) => {
    const el = document.elementFromPoint(clientX, clientY);
    if (!el || !el.closest) return null;
    const handleEl = el.closest('[data-handle="input"]');
    if (handleEl && handleEl.dataset.nodeId && handleEl.dataset.nodeId !== fromId) return handleEl.dataset.nodeId;
    const nodeEl = el.closest('[data-node-id]');
    if (nodeEl && nodeEl.dataset.nodeId !== fromId && nodeEl.querySelector('[data-handle="input"]')) return nodeEl.dataset.nodeId;
    return null;
  };

  // The mirror of dropTargetAt for a reverse drag: which node (and which of its
  // outputs) should feed the node we started from. Releasing on a specific
  // output dot picks that handle; releasing on the node body picks "default",
  // falling back to its first output for nodes that only have named ones
  // (a condition's yes/no, a quick reply's buttons).
  const sourceTargetAt = (clientX, clientY, toId) => {
    const el = document.elementFromPoint(clientX, clientY);
    if (!el || !el.closest) return null;
    const isSide = (node, h) => node.type === "ai_agent" && (h === "model" || h === "tool");
    const handleEl = el.closest('[data-handle-kind="output"]');
    if (handleEl && handleEl.dataset.nodeId && handleEl.dataset.nodeId !== toId) {
      const node = nodes.find(n => n.id === handleEl.dataset.nodeId);
      const which = handleEl.dataset.handleWhich;
      // The AI Agent's Model/Tool sockets are pickers, not connectors.
      if (node && !isSide(node, which)) return { fromId: node.id, fromHandle: which || "default" };
    }
    const nodeEl = el.closest('[data-node-id]');
    if (nodeEl && nodeEl.dataset.nodeId !== toId) {
      const node = nodes.find(n => n.id === nodeEl.dataset.nodeId);
      if (!node) return null;
      const outs = outputHandlesOf(node).filter(h => !isSide(node, h));
      if (!outs.length) return null;
      return { fromId: node.id, fromHandle: outs.includes("default") ? "default" : outs[0] };
    }
    return null;
  };

  const onConnectMove = useCallback((e) => {
    const c = connectRef.current; if (!c) return;
    const pos = screenToWorld(e.clientX, e.clientY);
    if (c.mode === "reverse") {
      // The moving end is the SOURCE, so it is the ghost's start point.
      setGhost(g => g ? { ...g, x1: pos.x, y1: pos.y } : null);
      const hit = sourceTargetAt(e.clientX, e.clientY, c.toId);
      setConnectTargetId(hit ? hit.fromId : null);
    } else {
      setGhost(g => g ? { ...g, x2: pos.x, y2: pos.y } : null);
      setConnectTargetId(dropTargetAt(e.clientX, e.clientY, c.fromId));
    }
  }, [nodes]);

  const onConnectUp = useCallback((e) => {
    const c = connectRef.current; if (!c) return;
    connectRef.current = null;
    setGhost(null);
    setConnectTargetId(null);
    window.removeEventListener("mousemove", onConnectMove);
    window.removeEventListener("mouseup", onConnectUp);

    // Both modes resolve to the same pair before touching state, so the edge
    // rules below (one edge per source handle) apply identically either way.
    let fromId = null, toId = null, fromHandle = "default";
    if (c.mode === "reverse") {
      const hit = sourceTargetAt(e.clientX, e.clientY, c.toId);
      if (!hit) return;
      fromId = hit.fromId; toId = c.toId; fromHandle = hit.fromHandle || "default";
    } else {
      toId = dropTargetAt(e.clientX, e.clientY, c.fromId);
      if (!toId) return;
      fromId = c.fromId; fromHandle = c.fromHandle || "default";
    }

    setEdges(prev => {
      const filtered = prev.filter(ed => !(ed.from === fromId && (ed.fromHandle || "default") === fromHandle));
      const newEdge = { from: fromId, to: toId };
      if (fromHandle && fromHandle !== "default") newEdge.fromHandle = fromHandle;
      const next = [...filtered, newEdge];
      pushHistory(nodes, next);
      return next;
    });
  }, [nodes, pushHistory]);

  const onClickEdgePlus = (e, edgeIndex) => {
    e.stopPropagation();
    const edge = edges[edgeIndex]; if (!edge) return;
    setEdges(prev => prev.filter((_, i) => i !== edgeIndex));
    setPicker({ x: e.clientX, y: e.clientY, connectTo: edge.from, fromHandle: edge.fromHandle, mode: "insert" });
  };

  const onClickAppendPlus = (e, fromId, fromHandle) => {
    e.stopPropagation();
    setPicker({ x: e.clientX, y: e.clientY, connectTo: fromId, fromHandle, mode: "append" });
  };

  /**
   * Click a row on a node to choose what happens next.
   *
   * The primary way to wire a branch, and the reason the old canvas was so hard
   * to use: connecting a button previously REQUIRED a precision drag from a
   * 30px dot (21px at the default zoom) onto a node that had to already exist.
   * Clicking a row needs no precision and creates the step and the wire in one
   * action. Same picker the append "+" uses — one code path, not two.
   */
  const onRowClick = (e, fromId, fromHandle, rowLabel) => {
    e.stopPropagation();
    const existing = edges.find(x => x.from === fromId && (x.fromHandle || "default") === fromHandle && x.to);
    if (existing) { setSelectedId(existing.to); return; }  // already wired: reveal the step it goes to
    setPicker({ x: e.clientX, y: e.clientY, connectTo: fromId, fromHandle, mode: "append", rowLabel });
  };

  const onPickAgentResource = (e, nodeId, kind) => {
    e.stopPropagation();
    setAgentPicker({ x: e.clientX, y: e.clientY, nodeId, kind });
  };

  const handleAgentResourcePick = (opt) => {
    if (!agentPicker) return;
    const { nodeId, kind } = agentPicker;
    if (kind === "model") {
      updateNode(nodeId, n => ({
        ...n,
        modelRef: n.modelRef?.id === opt.id ? null : {
          id: opt.id,
          label: opt.label,
          credentialId: opt.credentialId ?? null,
          modelId: opt.modelId ?? opt.id,
          provider: opt.provider ?? null,
          providerLabel: opt.providerLabel ?? null,
        },
      }));
      setAgentPicker(null);
    } else {
      updateNode(nodeId, n => {
        const list = Array.isArray(n.toolRefs) ? n.toolRefs : [];
        const exists = list.some(t => t.id === opt.id);
        return {
          ...n,
          toolRefs: exists ? list.filter(t => t.id !== opt.id) : [...list, { id: opt.id, label: opt.label }],
        };
      });
      // keep open for multi-select
    }
  };

  const onClickEdgeDelete = (e, edgeIndex) => {
    e.stopPropagation();
    setEdges(prev => {
      const next = prev.filter((_, i) => i !== edgeIndex);
      pushHistory(nodes, next);
      return next;
    });
  };

  const addNodeFromPicker = (tpl) => {
    const { x, y, connectTo, fromHandle } = picker;
    const nid = newId();
    const pos = screenToWorld(x + 60, y - 60);
    const newNode = makeNode(tpl.type, pos.x, pos.y, nid, templates);
    if (tpl.defaults) Object.assign(newNode, tpl.defaults);
    if (!newNode.title) newNode.title = tpl.name;
    if (!newNode.sub) newNode.sub = tpl.desc;
    if (newNode.actions && newNode.actions.length > 0) {
      newNode.actions = newNode.actions.map((a, idx) => ({ ...a, id: a.id || ("a" + Date.now() + idx) }));
    }
    // For AI Agent nodes, pre-select gpt-4o-mini on the user's first OpenAI
    // credential when present — the requested "cheap default". Falls through
    // to whatever the first enabled model is otherwise, so users with no
    // OpenAI key still get a sensible auto-pick.
    if (newNode.type === 'ai_agent' && !newNode.modelRef) {
      const flat = [];
      (aiModels || []).forEach(cred => {
        const all = Array.isArray(cred.availableModels) ? cred.availableModels : [];
        const enabledIds = Array.isArray(cred.enabledModels) ? new Set(cred.enabledModels) : null;
        const allowed = enabledIds ? all.filter(m => enabledIds.has(m.id)) : all;
        allowed.forEach(m => flat.push({ cred, m }));
      });
      const preferred = flat.find(o => o.cred.provider === 'openai' && o.m.id === 'gpt-4o-mini')
        || flat.find(o => o.cred.provider === 'openai')
        || flat[0];
      if (preferred) {
        const { cred, m } = preferred;
        newNode.modelRef = {
          id: `cred${cred.id}::${m.id}`,
          label: m.id,
          credentialId: cred.id,
          modelId: m.id,
          provider: cred.provider,
          providerLabel: cred.providerLabel,
        };
      }
    }
    const nextNodes = [...nodes, newNode];
    const nextEdges = connectTo ? [...edges, { from: connectTo, to: nid, fromHandle }] : edges;
    setNodes(nextNodes);
    if (connectTo) setEdges(nextEdges);
    pushHistory(nextNodes, nextEdges);
    setPicker(null);
    setSelectedId(nid);
  };

  const closePicker = () => setPicker(null);

  const onWheel = useCallback((e) => {
    if (!viewportRef.current || !viewportRef.current.contains(e.target)) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd+scroll or trackpad pinch → zoom
      const ds = e.deltaY > 0 ? 0.92 : 1.08;
      setTransform(t => ({ ...t, scale: Math.min(2, Math.max(0.3, t.scale * ds)) }));
    } else {
      // Regular scroll → pan
      setTransform(t => ({ ...t, x: t.x - e.deltaX, y: t.y - e.deltaY }));
    }
  }, []);
  useEffect(() => {
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  useEffect(() => {
    const handler = (e) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId && !e.target.closest("input,textarea,select")) {
        e.preventDefault();
        removeNode(selectedId);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && selectedId) {
        e.preventDefault();
        duplicateNode(selectedId);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && !e.target.closest("input,textarea,select")) {
        e.preventDefault();
        setSelSet(new Set(nodes.map(n => n.id)));
      }
      if (e.key === "Escape") {
        setPicker(null);
        if (!e.target.closest("input,textarea,select")) setSelectedId(null);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId, nodes, undo, redo]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onTS = (e) => {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        longPressRef.current = setTimeout(() => {
          const target = findDataAttr(document.elementFromPoint(t.clientX, t.clientY), "nodeId");
          if (target) setSelectedId(target.dataset.nodeId);
        }, 500);
      }
    };
    const onTE = () => { clearTimeout(longPressRef.current); };
    const onTM = () => { clearTimeout(longPressRef.current); };
    el.addEventListener("touchstart", onTS, { passive: true });
    el.addEventListener("touchend", onTE, { passive: true });
    el.addEventListener("touchmove", onTM, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTS);
      el.removeEventListener("touchend", onTE);
      el.removeEventListener("touchmove", onTM);
    };
  }, []);

  const openConfirm = () => setConfirmOpen(true);
  const closeConfirm = () => setConfirmOpen(false);
  const confirmDelete = () => { setConfirmOpen(false); removeNode(selectedId); };

  const selectedNode = nodes.find(n => n.id === selectedId) || null;

  const isDirty = useMemo(() => {
    return JSON.stringify({ nodes, edges }) !== savedSnapshot;
  }, [nodes, edges, savedSnapshot]);

  const handleSave = async () => {
    if (saving) return;
    const snap = JSON.stringify({ nodes, edges });
    if (snap === savedSnapshotRef.current) return; // nothing to save
    setSaving(true);
    try {
      await onSave({ config: { nodes, edges } });
      savedSnapshotRef.current = snap;
      setSavedSnapshot(snap);
    } catch (err) {
      console.error('[builder] save failed:', err);
      appNotify('Failed to save: ' + (err?.message || 'unknown error'));
    } finally {
      setSaving(false);
    }
  };

  // Export the automation as a portable JSON file. The backend export reads the
  // saved row, so flush any unsaved canvas changes first — the file then matches
  // exactly what's on screen.
  const handleExportAutomation = async () => {
    if (!automation?.id) return;
    try {
      if (isDirty) await handleSave();
      const data = await api.chatbots.exportOne(automation.id);
      downloadJson(`automation-${slugifyName(automation?.name)}`, data);
    } catch (err) {
      appNotify('Failed to export: ' + (err?.message || 'unknown error'));
    }
  };

  // "Create new template" from a Message/AI node's template picker: persist the
  // current flow (saved as a draft so nothing is lost), then deep-link to the
  // Template Builder's new-template editor (#/template-builder/new).
  const handleCreateTemplate = async () => {
    try { await handleSave(); } catch { /* handleSave already surfaces errors */ }
    if (onNavigate) onNavigate('template-builder', 'new');
  };

  if (loading) {
    return (
      <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100%", color:C.text5, fontFamily:"'DM Sans'" }}>
        <div style={{ textAlign:"center" }}>
          <div style={{ width:40, height:40, borderRadius:"50%", border:`3px solid ${C.cardBorder}`, borderTopColor:C.brand, animation:"spin .8s linear infinite", margin:"0 auto 16px" }}/>
          <div style={{ fontSize:16, fontWeight:600 }}>Loading automation builder…</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", background:C.pageBg, fontFamily:"'DM Sans', system-ui, sans-serif" }}>
      <BuilderToolbar
        automationName={automation?.name || "Untitled Automation"}
        status={automation?.status || "draft"}
        onBack={onBack}
        onSave={handleSave}
        isDirty={isDirty}
        saving={saving}
        onToggleStatus={handleToggleStatus}
        toggleBusy={toggleBusy}
        onPreview={()=>setShowPreview(v=>!v)}
        showPreview={showPreview}
        activeTab={activeTab || 'editor'}
        onTabChange={onTabChange}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        onZoomIn={() => setTransform(t => ({ ...t, scale: Math.min(2, t.scale * 1.2) }))}
        onZoomOut={() => setTransform(t => ({ ...t, scale: Math.max(0.3, t.scale / 1.2) }))}
        onFit={() => {
          if (!nodes.length || !viewportRef.current) return;
          const rect = viewportRef.current.getBoundingClientRect();
          const xs = nodes.map(n => n.x);
          const ys = nodes.map(n => n.y);
          const hs = nodes.map(n => nodeH(n));
          const minX = Math.min(...xs) - 40;
          const minY = Math.min(...ys) - 40;
          const maxX = Math.max(...xs.map((x, i) => x + NODE_W)) + 40;
          const maxY = Math.max(...ys.map((y, i) => y + hs[i])) + 40;
          const contentW = maxX - minX;
          const contentH = maxY - minY;
          const scale = Math.min(rect.width / contentW, rect.height / contentH, 1.0);
          setTransform({ x: 40 - minX * scale + (rect.width - contentW * scale) / 2, y: 30 - minY * scale + (rect.height - contentH * scale) / 2, scale: Math.max(0.3, scale * 0.9) });
        }}
        onAutoLayout={autoLayout}
        onExport={automation?.id ? handleExportAutomation : null}
      />

      {activeTab === 'executions' ? (
        <AutomationExecutions automation={automation} onBack={onBack} hideTopBar initialExecutionId={initialExecutionId} />
      ) : (
        <div style={{ display:"flex", flex:1, minHeight:0 }}>
          <BlockLibrary onAddBlock={(tpl, e) => {
            const nid = newId();
            // Place node at the center of the visible viewport
            const rect = viewportRef.current?.getBoundingClientRect();
            const t = transformRef.current;
            let pos;
            if (rect && t) {
              pos = { x: (rect.width / 2 - t.x) / t.scale, y: (rect.height / 2 - t.y) / t.scale };
            } else {
              pos = screenToWorld(e.clientX, e.clientY);
            }
            const n = makeNode(tpl.type, pos.x, pos.y, nid, templates);
            if (tpl.defaults) Object.assign(n, tpl.defaults);
            if (!n.title) n.title = tpl.name;
            if (!n.sub) n.sub = tpl.desc;
            if (n.actions && n.actions.length > 0) {
              n.actions = n.actions.map((a, idx) => ({ ...a, id: a.id || ("a" + Date.now() + idx) }));
            }
            setNodes(prev => {
              const next = [...prev, n];
              pushHistory(next, edges);
              return next;
            });
            setSelectedId(nid);
          }}/>

          <Canvas
            nodes={nodes} edges={edges} selectedId={selectedId}
            setSelectedId={setSelectedId} transform={transform} setTransform={setTransform}
            onStartDrag={onStartDrag} onStartConnect={onStartConnect}
            onPickAgentResource={onPickAgentResource}
            ghost={ghost} panning={panning} connectTargetId={connectTargetId}
            onClickEdgePlus={onClickEdgePlus} onClickAppendPlus={onClickAppendPlus}
            onClickEdgeDelete={onClickEdgeDelete}
            onDeleteNode={openConfirm} onDuplicateNode={duplicateNode}
            viewportRef={viewportRef} onViewportMouseDown={onViewportMouseDown}
            onAutoLayout={autoLayout}
            whatsappAccounts={whatsappAccounts}
            onRowClick={onRowClick}
            canvasTemplates={templates}
          />

          {selectedNode && (
            <SettingsPanel
              node={selectedNode} nodes={nodes} edges={edges}
              onUpdateNode={updateNode}
              onDeleteNode={openConfirm}
              onDuplicateNode={duplicateNode}
              onSaveAndClose={() => { handleSave(); setSelectedId(null); }}
              onToggleDisable={toggleNodeDisable}
              onDeleteButton={(nid, bid)=>updateNode(nid, n => ({
                ...n, actions: (n.actions || []).filter(a => a.id !== bid)
              }))}
              onSelectTemplate={onSelectTemplate}
              onCreateTemplate={handleCreateTemplate}
              templates={templates}
              tags={tags}
              leadFields={leadFields}
              otherAutomations={otherAutomations}
              whatsappAccounts={whatsappAccounts}
              assignableUsers={assignableUsers}
              aiModels={aiModels}
              automationId={automation?.id}
            />
          )}

          {showPreview && (
            <PhonePreview
              onClose={()=>setShowPreview(false)}
              nodes={nodes} edges={edges}
              templates={templates}
              otherAutomations={otherAutomations}
            />
          )}
        </div>
      )}

      {picker && (
        <div style={{ position:"fixed", inset:0, zIndex:60 }} onClick={closePicker}>
          <NodePicker x={picker.x} y={picker.y} onPick={addNodeFromPicker} onClose={closePicker} mode={picker.mode} groups={BLOCK_GROUPS}/>
        </div>
      )}

      {agentPicker && (() => {
        const an = nodes.find(n => n.id === agentPicker.nodeId);
        const selectedIds = agentPicker.kind === "model"
          ? (an?.modelRef ? [an.modelRef.id] : [])
          : (Array.isArray(an?.toolRefs) ? an.toolRefs.map(t => t.id) : []);
        // Flatten connected AI credentials × enabled models into picker rows.
        // Empty list → AgentResourcePicker falls back to the legacy hardcoded
        // AGENT_MODELS so the builder still works on workspaces with no AI
        // credentials connected yet.
        const modelOptions = [];
        (aiModels || []).forEach(cred => {
          const all = Array.isArray(cred.availableModels) ? cred.availableModels : [];
          const enabledIds = Array.isArray(cred.enabledModels)
            ? new Set(cred.enabledModels)
            : null; // null means "all enabled"
          const allowed = enabledIds ? all.filter(m => enabledIds.has(m.id)) : all;
          allowed.forEach(m => {
            modelOptions.push({
              id: `cred${cred.id}::${m.id}`,
              label: m.id,
              hint: `${cred.providerLabel || cred.provider}${cred.label ? ' · ' + cred.label : ''}`,
              credentialId: cred.id,
              modelId: m.id,
              provider: cred.provider,
              providerLabel: cred.providerLabel,
            });
          });
        });
        return (
          <div style={{ position:"fixed", inset:0, zIndex:60 }} onClick={()=>setAgentPicker(null)}>
            <AgentResourcePicker
              x={agentPicker.x} y={agentPicker.y} kind={agentPicker.kind}
              selectedIds={selectedIds}
              modelOptions={modelOptions}
              onPick={handleAgentResourcePick}
              onClose={()=>setAgentPicker(null)}
            />
          </div>
        );
      })()}

      {confirmOpen && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.35)", zIndex:80, display:"flex", alignItems:"center", justifyContent:"center" }} onClick={closeConfirm}>
          <div style={{ background:"var(--c-surface, #fff)", borderRadius:12, padding:"24px", width:360, boxShadow:"0 20px 50px rgba(0,0,0,.2)" }} onClick={e=>e.stopPropagation()}>
            <div style={{ fontSize:16, fontWeight:700, color:C.text1, marginBottom:8 }}>Delete this block?</div>
            <div style={{ fontSize:15, color:C.text3, lineHeight:1.5, marginBottom:20 }}>
              "{selectedNode?.title || selectedNode?.sub || "this block"}" will be removed and any connected links will be deleted. This can not be undone.
            </div>
            <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
              <Btn kind="ghost" onClick={closeConfirm}>Cancel</Btn>
              <Btn kind="danger" onClick={confirmDelete}>Delete block</Btn>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        /* The grab area is deliberately much larger than the dot, so give it a
           visible reaction — otherwise the extra room is undiscoverable and it
           still feels like you must hit the dot exactly. */
        .fg-handle:hover .fg-handle-dot {
          transform: scale(1.35);
          border-color: var(--c-dangerText, #A32D2D) !important;
        }
        .fg-handle:active .fg-handle-dot {
          transform: scale(1.15);
        }
        .picker-item:hover {
          background: var(--c-surfaceSection, #F8F7F2) !important;
          border-color: var(--c-border) !important;
        }
        .picker-item:active {
          background: var(--c-sf0efea, #F0EFEA) !important;
        }
        .rename-input::placeholder {
          color: var(--c-t7);
          font-style: italic;
        }
        .rename-input:focus {
          border-color: var(--c-successBright, #1D9E75) !important;
          box-shadow: 0 0 0 3px #E1F5EE !important;
        }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--c-borderStrong, #D5D5D0); border-radius: 99px; }
        ::-webkit-scrollbar-thumb:hover { background: #AAA; }
      `}</style>
    </div>
  );
};

export default AutomationBuilderView;
