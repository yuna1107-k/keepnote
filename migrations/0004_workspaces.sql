-- 複数ワークスペース対応
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon_emoji TEXT,
  icon_file_id TEXT,
  icon_color TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_workspace_members_user ON workspace_members(user_id);

-- 既存のデータは最初のワークスペースに移す
INSERT INTO workspaces (id, name, created_at, updated_at)
VALUES (
  'default',
  COALESCE((SELECT json_extract(value, '$') FROM settings WHERE key = 'workspaceName'), 'My Workspace'),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);
INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
SELECT 'default', id, CASE WHEN role = 'admin' THEN 'owner' ELSE 'member' END, created_at FROM users;

ALTER TABLE pages ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_pages_workspace ON pages(workspace_id);
