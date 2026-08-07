---
name: forge-growth-funnel
description: >-
  Design and reshape the Forge Growth sales funnel — which stages exist, what they
  are called, what order they run in, which one counts as won, and where leads come
  from. Use when the user wants to add/rename/reorder/delete a funnel stage, change
  how leads are labelled, manage lead sources, or set up a funnel from a strategy or
  game plan. Not for moving an individual lead — that is the list_leads and
  move_lead_stage tools.
---

# Designing the funnel

The funnel is a list of **stages** in order, plus a managed list of **sources**
(where a lead came from). Every lead sits in exactly one stage. Reshaping the funnel
is the first thing to do when someone hands over a sales strategy — templates,
follow-ups and reporting all key off these stages.

There are no dedicated tools for this; use `forgechat_request` (see the
**forge-growth-api** skill for how the proxy and its area switches work). It needs
the **Leads & funnel** area.

## The one thing that will bite you

Every stage has a **permanent key** and a **renameable label**. The key comes back as
`stageKey` in API responses (it is `stage_key` in the database).

`leads.stage` stores the key. So do the cold-drop engine, the conversion maths, the
stage→WhatsApp-tag mirror and the Meta conversion mapping. **Renaming a label is
completely safe** — nothing breaks, everything re-renders. Changing a key is not
possible, by design.

**Never send a key when creating a stage.** The server slugifies the label
itself and guarantees uniqueness. A key you invent is ignored, so you would report a
key back to the user that does not exist.

Tell the user this when they name a stage: *the name can be changed later, the
underlying key cannot* — so the key is derived once, from the first name they choose.

## Reading the current funnel

```
GET /funnel/config     → stages (key, label, colour, order, isFunnel, isWon) + sources
GET /funnel/chart      → per-stage counts and stage-to-stage conversion
```

**Always read `/funnel/config` before changing anything.** Stage ids and the existing
order are needed for reorder and delete, and the user's funnel is rarely the default.

## Changing stages

```
POST /funnel/stages            { label, color?, isFunnel?, isWon? }
PUT  /funnel/stages/:id        { label?, color?, isFunnel?, isWon? }   (partial)
PUT  /funnel/stages/reorder    { order: [id, id, id, ...] }            (all ids, new order)
DELETE /funnel/stages/:id
```

- `isFunnel: false` puts a stage off to the side (a branch like *Lost*) so it does not
  count as a step in the conversion maths.
- `isWon: true` marks the stage that means "sold". Revenue, the Sales Log and the
  stage→conversion mapping all key off it.
- **Reorder takes every stage id in the new order**, not a delta.

Two refusals are deliberate and both return **409**:

- deleting a stage that still holds leads — *move them first* (the message says so)
- deleting the only `isWon` stage — mark another one won first

## Sources

```
GET    /funnel/sources
POST   /funnel/sources      { name }
PUT    /funnel/sources/:id
DELETE /funnel/sources/:id
```

A source that is in use is **deactivated rather than deleted**, so historical leads
keep their attribution. `leads.source` stays free text — the managed list is what the
pickers show, not a constraint. Sources arriving from Meta ads (*Instagram Ad*,
*Facebook Ad*, *Direct*) are created automatically; renaming one is safe.

## Designing a funnel from a game plan

1. `GET /funnel/config` — never assume the default six stages.
2. Map the user's described journey onto stages. Ask which one means **won**; there
   must be exactly one, and it drives all revenue reporting.
3. Show the proposed funnel in order, with which are branches, **before** creating
   anything. Renaming later is free, but the order and the won-stage decide how every
   report reads.
4. Create the new stages, then one `reorder` with the full list.
5. Removing an old stage: check `/funnel/chart` for leads in it first, and offer to
   move them rather than surprising the user with a 409.

Adding a stage to a live funnel is safe — no lead moves on its own. Deleting is the
only operation that can strand data, which is exactly why it is guarded.
