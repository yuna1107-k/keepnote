-- 古い既定のアプリ名（Selfnote）のままなら keepnote にそろえる（ほかの名前にしている場合・新しく作ったデータベースでは何もしない）
UPDATE settings SET value = '"keepnote"' WHERE key IN ('serviceName', 'workspaceName') AND value = '"Selfnote"';
