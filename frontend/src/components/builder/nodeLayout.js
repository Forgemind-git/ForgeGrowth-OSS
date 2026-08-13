/**
 * Node geometry and the output-handle vocabulary — ONE source of truth.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `outputHandlesOf`, `handlePos` and `nodeH` were three hand-written switches
 * that had to agree and did not. `outputHandlesOf` emitted one handle per list
 * SECTION while the settings panel promised one per ROW; `handlePos` had its
 * own copy of the same branching; and `ExecutionFlowCanvas` had a third copy
 * that only knew about condition yes/no, so it drew every payment and button
 * edge from the wrong point.
 *
 * Here `nodeRows()` is the authority: it produces the rows a node RENDERS, and
 * both the handle list and the handle positions are derived from it. A handle
 * that cannot be rendered cannot exist, and a rendered row always has a handle.
 * (Anti-pattern #43 — derive, never restate.)
 *
 * Deterministic on purpose, not DOM-measured: every part has a fixed line
 * budget, so `handlePos` stays a pure function and no edge can anchor to a
 * stale Y after a re-render.
 */

export const NODE_W = 300;

// ⚠ THESE MOVE WITH THE TYPE SCALE. Every value here is a pixel budget for
// text this file cannot measure, so raising a font size anywhere on the card
// without raising the matching budget puts the first output row on top of the
// subtitle — which is exactly what happened the last time these were guessed
// low. They were re-derived (not estimated) when the app moved to the shared
// scale in constants.js: the card's three header lines went 10/13/11.5 ->
// 12/15/13, and each row's label 11 -> 13.
//
// Measured against the real card: 3px accent bar + 12px padding + a 34px icon
// beside three text lines (uppercase label, title, subtitle) + 10px padding.
const HEAD_H = 90;   // type label + title + subtitle
const BODY_H = 74;   // the WhatsApp bubble drawn on a message card
export const ROW_H = 40;   // one reply button / list row
export const SYS_H = 32;   // nomatch / timeout / next step
const ROW_GAP = 5;
const ROWS_PAD = 10;
const FOOT_PAD = 12;

// The DOT is what you see; HIT is the invisible grab area centred on it. They
// are separate so the grab area can grow without moving the point every edge is
// drawn to. Row pitch is >= 30px, so these never collide — which is why the old
// width-dividing clamp is gone.
export const HANDLE_DOT = 14;
export const HANDLE_HIT = 30;

// The INPUT marker is deliberately larger than an output dot: there is exactly
// one per node, it is where a line ARRIVES, and it is the thing you aim at when
// dragging a connection backwards. Same DOT-vs-HIT split as above — the visible
// circle is what every edge is drawn to, the transparent square is what you can
// grab, so the grab area can grow without moving the geometry.
export const INPUT_DOT = 22;
export const INPUT_HIT = 40;

/**
 * The ONLY place a button becomes a string.
 *
 * Never write `b.text || b`: that returns the OBJECT when the text is an empty
 * string, and an object rendered as a React child throws, blanking the page.
 * Reachable via COPY_CODE / OTP template buttons, which the template builder
 * deliberately exempts from requiring text.
 */
export const buttonLabel = (b, i) =>
  String((b && (b.title || b.text)) || `Button ${(i ?? 0) + 1}`);

/**
 * Only a QUICK_REPLY produces an inbound webhook. A URL / PHONE_NUMBER /
 * COPY_CODE tap tells us nothing at all, so a branch drawn from one is a wire
 * that can never carry anything. Mirrors backend services/replyRouting.js.
 */
export const isQuickReplyButton = (b) =>
  String((b && b.type) || "").toUpperCase() === "QUICK_REPLY";

/** Reply buttons that can be branched on, with their ORIGINAL index. */
export const replyButtonsOf = (n) => {
  if (!n || n.type !== "message") return [];
  if (n.messageMode === "direct") {
    if (n.directType !== "quick_reply") return [];
    const bs = Array.isArray(n.directData?.buttons) ? n.directData.buttons : [];
    return bs.map((b, i) => ({ index: i, label: buttonLabel(b, i), branchable: true }));
  }
  const bs = Array.isArray(n.buttons) ? n.buttons : [];
  // Non-quick-reply buttons are still LISTED — the customer really does see the
  // link and call buttons — but marked unbranchable so the card can render them
  // without a connector rather than hiding them or offering a dead wire.
  return bs.map((b, i) => ({
    index: i, label: buttonLabel(b, i), branchable: isQuickReplyButton(b),
    kind: String((b && b.type) || "QUICK_REPLY").toUpperCase(),
  }));
};

/** List rows, addressed per ROW (was per section — the commonest list shape,
 *  one section with several rows, could not branch at all). */
export const listRowsOf = (n) => {
  if (!n || n.type !== "message" || n.messageMode !== "direct" || n.directType !== "list") return [];
  const sections = Array.isArray(n.directData?.sections) ? n.directData.sections : [];
  const out = [];
  sections.forEach((s, si) => {
    (Array.isArray(s?.rows) ? s.rows : []).forEach((r, ri) => {
      out.push({ si, ri, label: String(r?.title || `Option ${ri + 1}`) });
    });
  });
  return out;
};

/** True when this node parks the flow until the customer responds. */
export const isWaitingNode = (n) =>
  n && n.type === "message" && n.waitForReply === true;

/**
 * The text a message step will actually send, for the bubble drawn on the card.
 *
 * A template's body is not on the node, so `onSelectTemplate` stamps it as
 * `templateBody`. FlowNode can also resolve it live from the templates list;
 * this is the value the LAYOUT reasons about.
 */
export const bodyPreview = (n) => {
  if (!n || n.type !== "message") return "";
  const dd = n.directData || {};
  if (n.messageMode === "direct") {
    const dt = n.directType || "text";
    if (dt === "text" || dt === "quick_reply" || dt === "list"
      || dt === "cta_url" || dt === "location_request") return String(dd.body || "");
    if (dt === "link") return String(dd.body || dd.url || "");
    if (dt === "location") return String(dd.name || dd.address || "");
    if (dt === "contact") return String(dd.name || "");
    return String(dd.caption || "");            // image / video / document
  }
  return String(n.templateBody || "");
};

/** A media step shows a typed attachment chip above its caption. */
export const mediaChipFor = (n) => {
  if (!n || n.type !== "message" || n.messageMode !== "direct") return "";
  switch (n.directType) {
    case "image": return "Photo";
    case "video": return "Video";
    case "audio": return "Voice message";
    case "sticker": return "Sticker";
    case "document": return String(n.directData?.filename || "Document");
    case "location": return "Location";
    case "contact": return "Contact card";
    case "location_request": return "Asks for location";
    default: return "";
  }
};

/**
 * THE AUTHORITY. Every row a node renders, in order.
 * kind: 'button' | 'row' | 'branch' | 'system' | 'static'
 */
export const nodeRows = (n) => {
  if (!n) return [{ handle: "default", label: "Next step", kind: "system" }];
  const rows = [];

  if (n.type === "message") {
    replyButtonsOf(n).forEach((b) => {
      rows.push({
        handle: b.branchable ? `btn:${b.index}` : null,
        label: b.label, kind: "button", buttonKind: b.kind,
      });
    });
    listRowsOf(n).forEach((r) => {
      rows.push({ handle: `row:${r.si}:${r.ri}`, label: r.label, kind: "row" });
    });

    // A call-to-action shows its link button so the card matches what the
    // customer sees, but it carries NO connector: Meta fires no webhook when
    // that button is tapped, so a branch there could never fire.
    if (n.messageMode === "direct" && n.directType === "cta_url") {
      rows.push({
        handle: null,
        label: String(n.directData?.button_text || "Open link"),
        kind: "button", buttonKind: "URL",
      });
    }

    // Asking for a location has a real, distinct success path: the customer
    // shares one. Anything else they send is a genuine no-match, so the two
    // must not be collapsed into one branch.
    if (n.messageMode === "direct" && n.directType === "location_request" && isWaitingNode(n)) {
      rows.push({ handle: "shared", label: "Location shared", kind: "branch", tone: "good" });
      rows.push({ handle: "nomatch", label: "Any other reply", kind: "system" });
      rows.push({ handle: "timeout", label: `No reply in ${n.waitTimeoutHours || 24}h`, kind: "system" });
      return rows;
    }

    if (isWaitingNode(n)) {
      // ⚠ A question with no CHOICES has no "wrong" answer. Whatever they type
      // IS the answer, so its main path is `replied` — not `nomatch`, which
      // would be asking "did they fail to pick one of the options?" about a
      // step that offered none. Getting this wrong is what made an
      // "Ask a question" step dead-end at END OF FLOW: the only branch on
      // offer described a case that never happens.
      const hasChoices = rows.some(r => r.handle && (r.handle.startsWith("btn:") || r.handle.startsWith("row:")));
      if (hasChoices) {
        rows.push({ handle: "nomatch", label: "Any other reply", kind: "system" });
      } else {
        rows.push({ handle: "replied", label: "They reply", kind: "system" });
      }
      rows.push({
        handle: "timeout",
        label: `No reply in ${n.waitTimeoutHours || 24}h`,
        kind: "system",
      });
    } else if (!rows.some(r => r.handle)) {
      rows.push({ handle: "default", label: "Next step", kind: "system" });
    } else {
      // Buttons but no wait: the branches can never fire. Still offer the
      // continue path so the flow is not silently stuck.
      rows.push({ handle: "default", label: "Next step", kind: "system" });
    }
    return rows;
  }

  if (n.type === "condition") {
    rows.push({ handle: "yes", label: "Matched", kind: "branch", tone: "good" });
    rows.push({ handle: "no", label: "Not matched", kind: "branch", tone: "bad" });
    return rows;
  }

  if (n.type === "handoff") {
    // A handoff ends the flow — the engine breaks the walk there. Offering a
    // "next step" would be a control that can never fire.
    return [];
  }

  rows.push({ handle: "default", label: "Next step", kind: "system" });
  return rows;
};

/**
 * DERIVED. Never a second hand-maintained list.
 * Side handles (model/tool) are appended for ai_agent: they are click-to-pick
 * sockets, not rows, so they live outside nodeRows but must still be handles.
 */
export const outputHandlesOf = (n) => {
  if (n && n.type === "ai_agent") return ["default", "model", "tool"];
  return nodeRows(n).map(r => r.handle).filter(Boolean);
};

/**
 * The options a customer can TAP on this step, in the order the phone shows
 * them, each carrying the handle that tap follows.
 *
 * ⚠ This exists so the preview simulator has NO handle list of its own. It used
 * to build one inline and emitted `row:<section>` while the canvas drew
 * `row:<section>:<row>` — so tapping any list option matched no edge and the
 * simulator reported END OF FLOW on a correctly wired menu, with both options
 * collapsed onto a single handle besides. Nothing threw: a handle that matches
 * no edge is indistinguishable from "the flow finished".
 *
 * `handle: null` means the customer really does see that button but WhatsApp
 * sends us nothing when it is tapped (URL / phone / copy-code), so it can never
 * advance a flow. Callers must say so rather than silently stopping.
 *
 * Every non-null handle here is guaranteed to appear in `outputHandlesOf(n)` —
 * both read the same helpers — and that guarantee is asserted in
 * test/flowValidator.unit.test.js.
 */
export const tapTargetsOf = (n) => {
  if (!n || n.type !== "message") return [];
  if (n.messageMode === "direct") {
    const dd = n.directData || {};
    if (n.directType === "quick_reply") {
      return replyButtonsOf(n).map(b => ({
        label: b.label, handle: b.branchable ? `btn:${b.index}` : null,
      }));
    }
    if (n.directType === "list") {
      return listRowsOf(n).map(r => ({ label: r.label, handle: `row:${r.si}:${r.ri}` }));
    }
    if (n.directType === "cta_url") {
      return [{ label: String(dd.button_text || "Open link"), handle: null }];
    }
    if (n.directType === "location_request") {
      // Sharing a location is a real inbound message, so it CAN branch — but
      // only when the step is actually waiting for one.
      return [{ label: "Send location", handle: isWaitingNode(n) ? "shared" : null }];
    }
    return [];
  }
  return replyButtonsOf(n).map(b => ({
    label: b.label, handle: b.branchable ? `btn:${b.index}` : null,
  }));
};

/**
 * Node types that draw a summary panel where a message card draws its bubble.
 * Without one the card was a bare header — a plain square — while every
 * message card had a chat bubble, so the canvas looked like two products.
 */
export const SUMMARY_H = 42;
const HAS_SUMMARY = new Set(["trigger", "delay", "api", "subflow"]);
export const hasSummaryPanel = (n) => !!n && HAS_SUMMARY.has(n.type);

/**
 * Extra body height for node types that draw their own content.
 *
 * ⚠ Every pixel a card RENDERS below the header must be counted here. The row
 * positions are computed from this, so a panel that is drawn but not measured
 * puts the first output row on top of it — the same overlap the header height
 * had to be corrected for.
 */
const extraBodyH = (n) => {
  if (!n) return 0;
  if (n.type === "action") return Math.max(0, (n.actions?.length || 0) * 26);
  if (n.type === "ai_agent") return 26;
  if (hasSummaryPanel(n)) return SUMMARY_H;
  return 0;
};

/**
 * The header renders a FOURTH line — `via <number>` — on a message step that
 * names an explicit sending account. The budget never counted it, so those
 * cards had the first output row sitting on that line; it was simply rarer
 * than the three-line case and so went unreported. Counted now, because a
 * budget that is right for the common case and wrong for the rest is the
 * failure mode this whole block of constants exists to prevent.
 */
const VIA_LINE_H = 22;
const headH = (n) =>
  HEAD_H + (n && n.type === "message" && n.whatsappAccountId ? VIA_LINE_H : 0);

/** Full geometry: height plus every row's vertical centre. */
export const nodeLayout = (n) => {
  // Every message step gets the bubble, so its height is constant and the
  // geometry cannot drift with the copy.
  const hasBody = n && n.type === "message";
  let y = headH(n) + (hasBody ? BODY_H : 0) + extraBodyH(n) + ROWS_PAD;
  const rows = nodeRows(n).map((r) => {
    const h = r.kind === "system" ? SYS_H : ROW_H;
    const out = { ...r, top: y, h, cy: y + h / 2 };
    y += h + ROW_GAP;
    return out;
  });
  return { width: NODE_W, height: Math.max(96, y + FOOT_PAD), rows };
};

export const nodeH = (n) => nodeLayout(n).height;

/**
 * Where an edge attaches.
 *
 * LEFT IN, RIGHT OUT. The flow reads left-to-right, the way the canvas is now
 * arranged: an edge leaves the source's right edge at its own row's centre —
 * so a connector is unambiguously the one belonging to the label beside it —
 * and enters the target's left edge.
 *
 * Inputs were on the TOP edge until 2026-08-12. With outputs already on the
 * right, every edge had to turn a corner and dive down into the card, so a
 * node with several branches drew a fan of lines that swept back across the
 * cards below it. Entering from the left makes a branch a straight lane.
 *
 * The input sits at the card's VERTICAL MIDDLE on the left edge — centre-
 * aligned on the edge, not at the card's geometric centre. With outputs on the
 * right at their own row's height, a centred input is what makes a left-to-
 * right flow read as one lane per branch.
 *
 * ⚠ KNOWN CONSEQUENCE, accepted deliberately (changed 2026-08-12 on request):
 * this used to be a CONSTANT offset into the header precisely so an inbound
 * edge could not move. A card grows downwards as rows are added, so a
 * mid-height anchor means adding a button to a target nudges its inbound edge
 * down. That is the cost of centring; every mainstream flow builder pays it for
 * the same reason. If it is ever judged the wrong trade, the whole change is
 * reverting `inputCY` to a constant — every consumer already goes through it.
 *
 * ⚠ `inputCY` is THE authority for that Y. `handlePos` draws every inbound edge
 * endpoint from it and FlowNode positions the visible marker from it, so a
 * second copy in either place would put the arrow somewhere the line does not
 * end — the exact class of bug this module exists to prevent.
 */
export const inputCY = (n) => nodeLayout(n).height / 2;

/** @deprecated Kept only so an older import cannot crash; use inputCY(n). */
export const INPUT_CY = 42;

export const handlePos = (n, kind, which = "default") => {
  if (kind === "input") return { x: n.x, y: n.y + inputCY(n) };
  const L = nodeLayout(n);
  if (n.type === "ai_agent" && which === "model") return { x: n.x, y: n.y + L.height / 2 };
  if (n.type === "ai_agent" && which === "tool") return { x: n.x + NODE_W, y: n.y + L.height / 2 };
  const r = L.rows.find(row => row.handle === which);
  if (r) return { x: n.x + NODE_W, y: n.y + r.cy };
  // Legacy per-section list handle (`row:2`) from a config imported elsewhere:
  // land it on that section's first row rather than the bottom-centre pile.
  const legacy = /^row:(\d+)$/.exec(String(which || ""));
  if (legacy) {
    const first = L.rows.find(row => String(row.handle || "").startsWith(`row:${legacy[1]}:`));
    if (first) return { x: n.x + NODE_W, y: n.y + first.cy };
  }
  // Orphan: a handle that no longer exists (the button was deleted, or the
  // message type changed). Park it at the bottom-right so the edge is VISIBLE
  // and therefore deletable, instead of vanishing.
  return { x: n.x + NODE_W, y: n.y + L.height };
};

/** Colour family for an edge leaving `handle`. Consumers map these to tokens. */
export const handleTone = (handle) => {
  if (handle === "yes" || handle === "paid" || handle === "shared") return "good";
  if (handle === "no" || handle === "unpaid") return "bad";
  if (handle === "nomatch") return "warn";
  if (handle === "timeout") return "muted";
  if (String(handle || "").startsWith("btn:") || String(handle || "").startsWith("row:")) return "brand";
  return "plain";
};
