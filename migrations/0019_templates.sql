-- テンプレートにしたページ（新しいページを作るときに、内容をそのまま使える）
ALTER TABLE pages ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0;
