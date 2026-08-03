-- 071_broadcast_recipient_filter.sql
--
-- Dynamic recipient segments for scheduled broadcasts.
--
-- A normal broadcast freezes its recipient list at creation. That can't express
-- "at 4pm, message whoever has NOT yet tapped the button" — the answer isn't
-- known until the moment it fires. `recipient_filter` is evaluated at DISPATCH
-- time and narrows the stored `recipient_numbers` down to the matching subset.
--
-- Shape (type 'button_click'):
--   {
--     "type":       "button_click",
--     "waNumber":   "919876543210",     -- business number the tap arrived on
--     "buttonText": "Get Live Link",    -- template quick-reply label
--     "since":      "2026-07-29T08:50:00.000Z",
--     "clicked":    true | false        -- true = only tappers, false = only non-tappers
--   }
--
-- `recipient_numbers` stays the authoritative POOL, so the segment can only ever
-- shrink it — a filter bug can never widen a blast to people who weren't on the
-- original list.
--
-- Idempotent / re-runnable.

ALTER TABLE coexistence.broadcasts
  ADD COLUMN IF NOT EXISTS recipient_filter JSONB;
