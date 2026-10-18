// Every WhatsApp automation template must produce a flow the BACKEND accepts:
// run through the real flowValidator + flowAuthoring.danglingHandles, not a
// frontend restatement of them.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { TEMPLATES, INDUSTRIES, GOALS, TRIGGERS, defaultValues, buildTemplate } from "../automationTemplates/catalog.js";
import { LIMITS } from "../automationTemplates/flowKit.js";
import { outputHandlesOf } from "../builder/nodeLayout.js";

const require = createRequire(import.meta.url);
const { validateFlow } = require("../../../../backend/src/services/flowValidator.js");
const { danglingHandles, AUTHORABLE_TYPES } = require("../../../../backend/src/services/flowAuthoring.js");

const STAGES = ["new", "engaged", "hot", "cold_lost", "enrolled"];
const INTERACTIVE = new Set(["quick_reply", "list", "cta_url"]);

function build(tpl, { stageKeys = STAGES, humanTag = "Needs a person" } = {}) {
  const v = defaultValues(tpl);
  if (tpl.trigger.kind === "tagApplied") v.__trigger.tag = "Some tag";
  if ("humanTag" in v) v.humanTag = humanTag;
  return buildTemplate(tpl, v, { stageKeys });
}

describe("automation template catalog", () => {
  it("has unique ids and valid taxonomy references", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    TEMPLATES.forEach((t) => {
      const ind = INDUSTRIES.find((i) => i.id === t.industry);
      expect(ind, t.id).toBeTruthy();
      expect(ind.subs.some((s) => s.id === t.sub), `${t.id} sub`).toBe(true);
      expect(GOALS.some((g) => g.id === t.goal), `${t.id} goal`).toBe(true);
      expect(TRIGGERS.some((g) => g.id === t.trigger.kind), `${t.id} trigger`).toBe(true);
    });
    // Every sub-division holds at least one template — an empty filter reads as broken.
    INDUSTRIES.forEach((i) => i.subs.forEach((s) =>
      expect(TEMPLATES.some((t) => t.industry === i.id && t.sub === s.id), `${i.id}/${s.id}`).toBe(true)));
  });

  for (const tpl of TEMPLATES) {
    for (const variant of [{}, { stageKeys: [] }, { humanTag: "" }]) {
      it(`${tpl.id} builds a valid flow ${JSON.stringify(variant)}`, () => {
        const cfg = build(tpl, variant);
        const { nodes, edges } = cfg;
        const res = validateFlow(cfg);
        expect(res.blocking, JSON.stringify(res.blocking)).toEqual([]);
        expect(danglingHandles(cfg), "dangling").toEqual([]);

        const ids = nodes.map((n) => n.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(nodes.filter((n) => n.type === "trigger").length).toBe(1);

        nodes.forEach((n) => {
          expect(Object.prototype.hasOwnProperty.call(AUTHORABLE_TYPES, n.type), `${n.id} type ${n.type}`).toBe(true);
          expect(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.id} placed`).toBe(true);
          const dd = n.directData || {};
          if (n.directType === "quick_reply") {
            expect(dd.buttons.length).toBeGreaterThan(0);
            expect(dd.buttons.length).toBeLessThanOrEqual(LIMITS.buttons);
            dd.buttons.forEach((b) => expect(b.title.length).toBeLessThanOrEqual(LIMITS.button));
            expect(new Set(dd.buttons.map((b) => b.title)).size).toBe(dd.buttons.length);
          }
          if (n.directType === "list") {
            const rs = dd.sections.flatMap((s) => s.rows);
            expect(rs.length).toBeGreaterThan(0);
            expect(rs.length).toBeLessThanOrEqual(LIMITS.rows);
            rs.forEach((r) => expect(r.title.length).toBeLessThanOrEqual(LIMITS.row));
          }
          if (n.type === "message" && n.messageMode === "direct" && ["text", "quick_reply", "list", "cta_url"].includes(n.directType))
            expect(String(dd.body || "").trim(), `${n.id} body`).not.toBe("");
          if (n.type === "action") {
            expect(n.actions.length).toBeGreaterThan(0);
            n.actions.filter((a) => a.kind === "Set Funnel Stage").forEach((a) => expect((variant.stageKeys ?? STAGES)).toContain(a.value));
            n.actions.filter((a) => a.kind === "Add Tag").forEach((a) => expect(a.value).toBeTruthy());
          }
        });

        // Every edge leaves on a handle the node really has (canvas + engine agree).
        edges.forEach((e) => {
          const from = nodes.find((n) => n.id === e.from);
          expect(outputHandlesOf(from), `${e.from} ${e.fromHandle}`).toContain(e.fromHandle || "default");
          expect(ids).toContain(e.to);
        });

        // Pacing: no plain text/media step feeds an interactive one directly.
        edges.forEach((e) => {
          const a = nodes.find((n) => n.id === e.from), b = nodes.find((n) => n.id === e.to);
          const plain = a.type === "message" && !a.waitForReply && !INTERACTIVE.has(a.directType);
          if (plain && b.type === "message" && INTERACTIVE.has(b.directType)) throw new Error(`no pacing delay ${a.id} -> ${b.id}`);
        });

        // Every step is reachable from the trigger.
        const seen = new Set(["trigger1"]); const q = ["trigger1"];
        while (q.length) { const id = q.shift(); edges.filter((e) => e.from === id).forEach((e) => { if (!seen.has(e.to)) { seen.add(e.to); q.push(e.to); } }); }
        expect(ids.filter((id) => !seen.has(id)), "unreachable").toEqual([]);
      });
    }
  }
});
