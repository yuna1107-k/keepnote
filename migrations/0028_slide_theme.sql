-- スライドで表示するときのテーマ（NULL = 標準。値は src/web/workspace/slideThemes.ts の id）
ALTER TABLE pages ADD COLUMN slide_theme TEXT;
