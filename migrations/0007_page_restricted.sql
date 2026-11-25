-- 親ページからの共有を引き継がず「招待した人のみ」にするページ
ALTER TABLE pages ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0;
