-- ワークスペースと GitHub リポジトリの連携
CREATE TABLE github_links (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  root_path TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL,
  root_page_id TEXT,
  last_sync_at INTEGER,
  last_sync_status TEXT,
  last_sync_error TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

-- GitHub と同期しているページ
--   github_kind: root（リポジトリ）/ dir（フォルダ）/ md（Markdown ファイル）
--   source_md: GitHub 上の Markdown（暗号化して保存）
--   md_rev / content_md_rev: GitHub から取り込んだ版と、エディタ用の内容が作られた版（違えば画面側で変換し直す）
ALTER TABLE pages ADD COLUMN github_path TEXT;
ALTER TABLE pages ADD COLUMN github_kind TEXT;
ALTER TABLE pages ADD COLUMN github_sha TEXT;
ALTER TABLE pages ADD COLUMN source_md TEXT;
ALTER TABLE pages ADD COLUMN github_dirty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN md_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN content_md_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN github_conflict_at INTEGER;
CREATE INDEX idx_pages_github ON pages(workspace_id, github_path);

-- アップロードファイルが暗号化済みか（既存ファイルの暗号化の進み具合を正確に数えるため）
ALTER TABLE files ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;
