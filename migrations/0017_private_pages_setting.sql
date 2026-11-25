-- ワークスペースごとに「プライベート」のページ（自分だけのページ）を使うかどうか。標準は使わない
ALTER TABLE workspaces ADD COLUMN private_pages INTEGER NOT NULL DEFAULT 0;
