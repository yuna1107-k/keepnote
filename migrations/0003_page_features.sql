-- ページの見た目（カバー・全幅・文字サイズ・フォント）とロック
ALTER TABLE pages ADD COLUMN cover TEXT;
ALTER TABLE pages ADD COLUMN cover_position REAL NOT NULL DEFAULT 50;
ALTER TABLE pages ADD COLUMN full_width INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN small_text INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN font TEXT NOT NULL DEFAULT 'default';
ALTER TABLE pages ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;

-- Web への外部公開
ALTER TABLE pages ADD COLUMN public_slug TEXT;
ALTER TABLE pages ADD COLUMN public_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN public_subpages INTEGER NOT NULL DEFAULT 1;
ALTER TABLE pages ADD COLUMN public_indexing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN published_at INTEGER;
ALTER TABLE pages ADD COLUMN published_by TEXT;
CREATE UNIQUE INDEX idx_pages_public_slug ON pages(public_slug);

-- ページ履歴（更新前の状態のスナップショット）
CREATE TABLE page_versions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  icon TEXT,
  content TEXT NOT NULL,
  content_text TEXT NOT NULL DEFAULT '',
  edited_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_page_versions_page ON page_versions(page_id, created_at);
