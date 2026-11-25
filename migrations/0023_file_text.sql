-- ファイルの中の文字（PDF・Word・表など）。検索でファイルの中身も探すため。暗号化して保存する
ALTER TABLE files ADD COLUMN content_text TEXT;
