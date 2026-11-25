-- ページの標準フォントをセリフにする（既存のページもそろえる。ページごとに切り替えられる）
UPDATE pages SET font = 'serif' WHERE font = 'default';
