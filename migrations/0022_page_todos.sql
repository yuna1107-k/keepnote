-- ページの中の未完了の ToDo（期限つき）。「タスク」の画面で、ページをまたいで一覧にする
-- 本文は暗号化されていて SQL では探せないため、保存時と定期処理で記録する（text・due は暗号化して保存）
CREATE TABLE page_todos (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  due TEXT,
  PRIMARY KEY (page_id, block_id)
);
ALTER TABLE pages ADD COLUMN todos_indexed_at INTEGER;
