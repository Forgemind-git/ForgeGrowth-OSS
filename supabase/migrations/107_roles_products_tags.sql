-- 107_roles_products_tags.sql — 2026-08-12
--
-- Four changes:
--   1. team_members and bda_activity_log dropped — Team Members is gone.
--   2. user_roles: roles become editable rows (admin / sales / service).
--   3. A managed "Product" tag category, one tag per product.
--   4. The pre-existing manual "Courses" product tag migrated onto the managed
--      one, then retired.
--
-- ⚠ DEPLOY ORDER: this migration ships WITH the backend, never before it. The
-- pre-107 image reads team_members on every /numbers call (the Chats sidebar)
-- and joins it in the MCP BDA tool; dropping the table under the old image
-- breaks the number list. It would also partly undo itself — the old
-- ROLE_PAGE_DEFAULTS ignores user_roles entirely.
--
-- ⚠ WHAT IS DELIBERATELY *NOT* TOUCHED
--   • coexistence.courses and its `course_id` FKs. The Products PAGE moved into
--     Funnel Settings; the table is the Razorpay money-attribution path and is
--     unchanged. Read `course` as `product`.
--   • forgecrm_users.role keeps its TEXT value. Only the CHECK is dropped, so
--     adding a role is an INSERT and never DDL again.
--
-- Idempotent: safe to re-run.

BEGIN;

-- ── 1. Team Members ──────────────────────────────────────────────────────────
-- A business number is now named by whatsapp_accounts.display_name (edited in
-- Admin Settings → WhatsApp Accounts), which is what routes/messages.js reads.
-- bda_activity_log goes with it: "BDA" only ever meant a team member, it held
-- 0 rows, and its page was removed on 2026-08-11.
DROP TABLE IF EXISTS coexistence.bda_activity_log CASCADE;
DROP TABLE IF EXISTS coexistence.team_members     CASCADE;

-- ── 2. Roles ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.user_roles (
  role_key    TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT,
  pages       JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INT NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The CHECK froze the role list into the schema. Dropping it is what makes
-- "add a role" a row insert — exactly why the funnel work dropped the
-- equivalent CHECK on leads.stage.
ALTER TABLE coexistence.forgecrm_users DROP CONSTRAINT IF EXISTS forgecrm_users_role_check;

-- The seed rows. `pages` for admin is filled at boot from the live PAGES list;
-- an empty array here would be wrong the moment a page is added, and isAdmin()
-- short-circuits the check anyway.
INSERT INTO coexistence.user_roles (role_key, label, description, pages, is_system, sort_order) VALUES
  ('admin',   'Admin',   'Full access to everything, including these settings.', '[]'::jsonb, TRUE,  0),
  ('sales',   'Sales',   'Works the funnel: their own leads, sales log and payments.', '[]'::jsonb, FALSE, 1),
  ('service', 'Service', 'Answers conversations. Reads the funnel but does not sell.', '[]'::jsonb, FALSE, 2)
ON CONFLICT (role_key) DO NOTHING;

-- Carry the pre-107 roles across. This instance had only an admin, so both
-- update 0 rows here; they exist so a database copy taken earlier lands on a
-- valid role instead of an orphan that resolves to no pages at all.
UPDATE coexistence.forgecrm_users SET role = 'sales'   WHERE role = 'bda_sales';
UPDATE coexistence.forgecrm_users SET role = 'service' WHERE role = 'viewer';

-- ── 3 + 4. Product tags ──────────────────────────────────────────────────────
-- The managed category. Its tags are mirrored by services/productTags.js and
-- hidden from every manual picker: a tag meaning "bought X" stops meaning that
-- the moment anyone can set it by hand.
INSERT INTO coexistence.categories (id, name, description)
VALUES ('cat-product', 'Product',
        'Auto-managed: mirrors the product a customer bought so Chats can filter by it. Applied from the Sales Log. Edit the names in Admin Settings -> Funnel -> Products.')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = NOW();

-- One tag per active product. The id is keyed on the product's IMMUTABLE id,
-- never its name — contacts.tags is denormalised, so a name-keyed id would
-- orphan every copy on the first rename.
INSERT INTO coexistence.tags (id, name, color, category_id)
SELECT 'tag-product-' || c.id, c.name, '#6A3FAF', 'cat-product'
  FROM coexistence.courses c WHERE c.active = TRUE
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color, updated_at = NOW();

-- Migrate the manual tag that was doing this job by hand.
--
-- A "Courses" category held a tag with the same name as a real product, applied
-- to 7 contacts. Leaving it would put two identically-named tags on the same
-- people; deleting it without migrating would lose the tagging. So: swap the id
-- inside every blob, then retire the old tag and its category.
--
-- ⚠ The swap is done IN SQL over jsonb_array_elements, never read-modify-write,
-- and only where the contact does not already carry the managed tag — otherwise
-- a contact holding both would end up with it twice.
DO $$
DECLARE
  old_tag  TEXT;
  new_tag  TEXT;
  old_cat  TEXT;
BEGIN
  SELECT t.id, t.category_id INTO old_tag, old_cat
    FROM coexistence.tags t
    JOIN coexistence.categories c ON c.id = t.category_id
   WHERE lower(c.name) = 'courses'
     AND EXISTS (SELECT 1 FROM coexistence.courses p
                  WHERE lower(btrim(p.name)) = lower(btrim(t.name)))
   LIMIT 1;
  IF old_tag IS NULL THEN RETURN; END IF;

  SELECT 'tag-product-' || p.id INTO new_tag
    FROM coexistence.courses p
    JOIN coexistence.tags t ON lower(btrim(p.name)) = lower(btrim(t.name))
   WHERE t.id = old_tag LIMIT 1;
  IF new_tag IS NULL THEN RETURN; END IF;

  -- Contacts that would end up with both: just drop the old one.
  UPDATE coexistence.contacts
     SET tags = (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
                   FROM jsonb_array_elements(tags) t WHERE t->>'id' <> old_tag),
         updated_at = NOW()
   WHERE tags @> jsonb_build_array(jsonb_build_object('id', old_tag))
     AND tags @> jsonb_build_array(jsonb_build_object('id', new_tag));

  -- Everyone else: rewrite the entry in place, keeping their position.
  UPDATE coexistence.contacts
     SET tags = (SELECT COALESCE(jsonb_agg(
                   CASE WHEN t->>'id' = old_tag
                        THEN jsonb_build_object('id', new_tag, 'name', t->>'name',
                                                'color', '#6A3FAF', 'category_id', 'cat-product')
                        ELSE t END), '[]'::jsonb)
                   FROM jsonb_array_elements(tags) t),
         updated_at = NOW()
   WHERE tags @> jsonb_build_array(jsonb_build_object('id', old_tag));

  DELETE FROM coexistence.tags WHERE id = old_tag;
  -- Only remove the category once nothing else lives in it.
  DELETE FROM coexistence.categories c
   WHERE c.id = old_cat
     AND NOT EXISTS (SELECT 1 FROM coexistence.tags t WHERE t.category_id = c.id);
END $$;

CREATE INDEX IF NOT EXISTS idx_contacts_tags_gin ON coexistence.contacts USING GIN (tags);

COMMIT;
