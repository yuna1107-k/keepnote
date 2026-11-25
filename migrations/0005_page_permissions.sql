-- ページごとの共有（ユーザー単位の閲覧／編集権限。サブページに継承される）
CREATE TABLE page_shares (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('view', 'edit')),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, user_id)
);
CREATE INDEX idx_page_shares_user ON page_shares(user_id);

-- 「ワークスペースの全員」に共有したページで、全員に与える権限
ALTER TABLE pages ADD COLUMN workspace_access TEXT NOT NULL DEFAULT 'edit';
