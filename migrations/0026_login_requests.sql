-- スマホで承認してログイン（パスキーがスマホにしかない PC 向け）。PC が申請し、ログイン済みのスマホがパスキーで本人確認して承認する
CREATE TABLE login_requests (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  code TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  approved_at INTEGER,
  consumed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  ua TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
