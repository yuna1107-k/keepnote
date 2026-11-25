-- ワークスペースの「管理者」を追加し、オーナーは 1 人だけにする
CREATE TABLE workspace_members_new (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
-- 既存のオーナーが複数いる場合は、最初に参加した人だけをオーナーとして残し、ほかは管理者にする
INSERT INTO workspace_members_new (workspace_id, user_id, role, joined_at)
SELECT m.workspace_id, m.user_id,
  CASE
    WHEN m.role = 'owner' AND m.user_id != (
      SELECT o.user_id FROM workspace_members o WHERE o.workspace_id = m.workspace_id AND o.role = 'owner'
      ORDER BY o.joined_at, o.user_id LIMIT 1
    ) THEN 'admin'
    ELSE m.role
  END,
  m.joined_at
FROM workspace_members m;
DROP TABLE workspace_members;
ALTER TABLE workspace_members_new RENAME TO workspace_members;
CREATE INDEX idx_workspace_members_user ON workspace_members(user_id);
CREATE UNIQUE INDEX idx_workspace_single_owner ON workspace_members(workspace_id) WHERE role = 'owner';
