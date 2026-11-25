-- ワークスペースの「閲覧者」（ページを作成・削除できない）を追加
CREATE TABLE workspace_members_new (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
INSERT INTO workspace_members_new (workspace_id, user_id, role, joined_at)
SELECT workspace_id, user_id, role, joined_at FROM workspace_members;
DROP TABLE workspace_members;
ALTER TABLE workspace_members_new RENAME TO workspace_members;
CREATE INDEX idx_workspace_members_user ON workspace_members(user_id);
