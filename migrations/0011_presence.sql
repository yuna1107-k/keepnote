-- ページを開いている人（画面から定期的に通知される。一定時間通知がなければ消える）
CREATE TABLE page_presence (
  page_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (page_id, session_id)
);
CREATE INDEX idx_page_presence_page ON page_presence(page_id, last_seen);
