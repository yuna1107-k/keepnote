-- PDF のしおりとメモ（自分だけが見られる。メモは暗号化して保存）
CREATE TABLE pdf_notes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_key TEXT NOT NULL,
  page INTEGER NOT NULL,
  bookmarked INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, file_key, page)
);
