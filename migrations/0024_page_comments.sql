-- ページのコメント。選んだ文（quote）とブロックに付け、返信でスレッドにする（本文と quote は暗号化して保存）
CREATE TABLE page_comments (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  thread_id TEXT,
  block_id TEXT,
  quote TEXT,
  body TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resolved_at INTEGER,
  resolved_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX page_comments_page ON page_comments(page_id, created_at);
