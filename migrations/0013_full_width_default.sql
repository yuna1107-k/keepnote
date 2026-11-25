-- すべてのページを全幅表示にそろえる（新しく作るページも全幅が標準。ページごとに切り替えられる）
UPDATE pages SET full_width = 1 WHERE full_width = 0;
