-- 125 — Chat Analyzer output in the order a salesperson reads it:
-- summary → problems → things to note → recommended actions.
-- Three lists the model now returns alongside the existing fields. Additive;
-- analyses made before this have them empty and the UI derives the sections
-- from their older fields (objections / risk / buying signals / next action).
-- Idempotent; the boot ensure in services/chatAnalyser.js does the same.
ALTER TABLE coexistence.chat_analysis
  ADD COLUMN IF NOT EXISTS problems JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS notes JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS recommendations JSONB NOT NULL DEFAULT '[]'::jsonb;

-- One-time key clean-up. The Chats slide-over used to key a chat by the full
-- number (91XXXXXXXXXX) while the Chat Analyzer tab used the last 10 digits, so
-- a few conversations were analysed under BOTH keys. The code now always uses
-- the last 10 digits; this folds the long-key rows onto that key. Only rows with
-- no 10-digit twin are moved (none had one on 2026-09-23), so nothing collides;
-- a twin, if one ever exists, is left for a person to look at.
UPDATE coexistence.chat_analysis a SET conversation_key = right(regexp_replace(a.conversation_key,'\D','','g'),10)
 WHERE a.source = 'chat' AND length(regexp_replace(a.conversation_key,'\D','','g')) > 10
   AND NOT EXISTS (SELECT 1 FROM coexistence.chat_analysis b WHERE b.source = 'chat'
                   AND b.conversation_key = right(regexp_replace(a.conversation_key,'\D','','g'),10));
UPDATE coexistence.chat_analysis_coverage a SET conversation_key = right(regexp_replace(a.conversation_key,'\D','','g'),10)
 WHERE a.source = 'chat' AND length(regexp_replace(a.conversation_key,'\D','','g')) > 10
   AND NOT EXISTS (SELECT 1 FROM coexistence.chat_analysis_coverage b WHERE b.source = 'chat' AND b.modality = a.modality
                   AND b.conversation_key = right(regexp_replace(a.conversation_key,'\D','','g'),10));
UPDATE coexistence.chat_analysis_runs SET conversation_key = right(regexp_replace(conversation_key,'\D','','g'),10)
 WHERE source = 'chat' AND length(regexp_replace(conversation_key,'\D','','g')) > 10;
UPDATE coexistence.chat_message_artifacts SET conversation_key = right(regexp_replace(conversation_key,'\D','','g'),10)
 WHERE source = 'chat' AND length(regexp_replace(conversation_key,'\D','','g')) > 10;
