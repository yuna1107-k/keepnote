-- データベース：ページをデータベースにすると、子ページが行になり、列（プロパティ）の値を持てる
-- 列の定義・表示の設定（schema）と、行ごとの値（data）は JSON を暗号化して保存する
ALTER TABLE pages ADD COLUMN is_database INTEGER NOT NULL DEFAULT 0;
CREATE TABLE databases (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  schema TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE db_values (
  row_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
