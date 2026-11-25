-- ワークスペースの URL 名（https://<host>/<slug>/<ページの URL>）
ALTER TABLE workspaces ADD COLUMN slug TEXT;
UPDATE workspaces SET slug = CASE
  WHEN length(name) BETWEEN 2 AND 40 AND name NOT GLOB '*[^A-Za-z0-9_-]*' AND name GLOB '[A-Za-z0-9]*'
       AND lower(name) NOT IN ('login', 'register', 'admin', 'settings', 'workspace', 'p', 'share', 'api', 'assets', 'fonts')
    THEN lower(name)
  ELSE 'ws-' || substr(replace(id, '-', ''), 1, 8)
END;
CREATE UNIQUE INDEX idx_workspaces_slug ON workspaces(slug);
