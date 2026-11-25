import { useEffect, useState } from 'react';
import { api, type AuditLog } from '../api';
import { Button, Spinner, useUi } from '../ui';
import { AuditTable } from './common';

const FILTERS = [
  { value: '', label: 'すべて' },
  { value: 'auth.', label: 'ログイン' },
  { value: 'auth.login_failed', label: 'ログイン失敗' },
  { value: 'passkey.', label: 'パスキー' },
  { value: 'user.', label: 'ユーザー' },
  { value: 'link.', label: '登録リンク' },
  { value: 'session.', label: 'セッション' },
  { value: 'settings.', label: '設定' },
  { value: 'page.', label: '外部公開' },
  { value: 'workspace.', label: 'ワークスペース' },
  { value: 'group.', label: 'グループ' },
];

export default function Audit() {
  const { toast } = useUi();
  const [logs, setLogs] = useState<AuditLog[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [action, setAction] = useState('');
  const [q, setQ] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchLogs = (before?: number) =>
    api<{ logs: AuditLog[]; hasMore: boolean }>(
      `/admin/audit?limit=50&action=${encodeURIComponent(action)}&q=${encodeURIComponent(q)}${before ? `&before=${before}` : ''}`,
    );

  useEffect(() => {
    const t = setTimeout(() => {
      fetchLogs()
        .then((r) => {
          setLogs(r.logs);
          setHasMore(r.hasMore);
        })
        .catch((e) => toast(e.message, 'error'));
    }, 200);
    return () => clearTimeout(t);
  }, [action, q]);

  const more = async () => {
    if (!logs?.length) return;
    setLoadingMore(true);
    try {
      const r = await fetchLogs(logs[logs.length - 1]!.id);
      setLogs([...logs, ...r.logs]);
      setHasMore(r.hasMore);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="admin-page">
      <div className="admin-header">
        <h1>監査ログ</h1>
      </div>
      <div className="toolbar">
        <input className="input" placeholder="ユーザー名・IPで検索…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input select" value={action} onChange={(e) => setAction(e.target.value)}>
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      {!logs ? (
        <Spinner />
      ) : (
        <div className="card no-pad">
          <AuditTable logs={logs} />
        </div>
      )}
      {hasMore && (
        <div className="center">
          <Button onClick={more} loading={loadingMore}>
            さらに読み込む
          </Button>
        </div>
      )}
    </div>
  );
}
