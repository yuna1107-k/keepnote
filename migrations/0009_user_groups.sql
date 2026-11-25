-- ユーザーグループ（管理者が作成）と、グループ単位のページ共有
CREATE TABLE user_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE user_group_members (
  group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX idx_user_group_members_user ON user_group_members(user_id);

CREATE TABLE page_group_shares (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('view', 'edit')),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, group_id)
);
CREATE INDEX idx_page_group_shares_group ON page_group_shares(group_id);
