-- soundboard packs remember who made them, so Create Expressions edits only one's own packs (like sounds, emojis, stickers).
-- Packs made before this have no creator: only Manage Expressions edits them. Undo: ALTER TABLE soundboard_packs DROP COLUMN user_id
ALTER TABLE soundboard_packs ADD COLUMN user_id TEXT;
