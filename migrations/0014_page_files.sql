-- ページ（と編集履歴）が使っているアップロードファイルの対応表。ファイルを見てよい人の判定に使う
-- 本文は暗号化されていて SQL では検索できないため、保存時と定期処理で記録する
CREATE TABLE page_files (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  PRIMARY KEY (page_id, file_id)
);
CREATE INDEX page_files_file ON page_files(file_id);
ALTER TABLE pages ADD COLUMN files_indexed_at INTEGER;
ALTER TABLE page_versions ADD COLUMN files_indexed_at INTEGER;
