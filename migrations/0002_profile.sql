-- アカウントアイコンと表示テーマ
ALTER TABLE users ADD COLUMN avatar_file_id TEXT;
ALTER TABLE users ADD COLUMN avatar_emoji TEXT;
ALTER TABLE users ADD COLUMN avatar_color TEXT;
ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'system';
