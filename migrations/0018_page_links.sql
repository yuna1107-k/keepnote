-- ページ同士のリンク（どのページがどのページを参照しているか）。被リンクの表示に使う
-- 本文は暗号化されていて SQL では検索できないため、保存時と定期処理で記録する
CREATE TABLE page_links (
  from_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX page_links_to ON page_links(to_id);
ALTER TABLE pages ADD COLUMN links_indexed_at INTEGER;
