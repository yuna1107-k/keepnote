-- GitHub の Markdown ページは 1 行目の見出し 1 を本文に出さないようにしたため、次に開いたときに変換し直す
-- （送信待ちの変更があるページは対象外）
UPDATE pages SET content_md_rev = -1 WHERE github_kind = 'md' AND github_dirty = 0 AND source_md IS NOT NULL;
