import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Button, formatDateTime, formatRelative, Spinner, useUi } from '../ui';

type ActiveLink = {
  id: string;
  purpose: 'invite' | 'recovery';
  createdAt: number;
  expiresAt: number;
  userId: string;
  username: string;
  displayName: string;
  createdBy: string | null;
};

export default function Links() {
  const { toast, confirm } = useUi();
  const [links, setLinks] = useState<ActiveLink[] | null>(null);
  const load = () => api<{ links: ActiveLink[] }>('/admin/registration-links').then((r) => setLinks(r.links));
  useEffect(() => {
    load().catch((e) => toast(e.message, 'error'));
  }, []);

  const revoke = async (l: ActiveLink) => {
    const ok = await confirm({ title: 'リンクを無効化しますか？', message: `${l.displayName} 宛ての登録リンクは使用できなくなります。`, confirmLabel: '無効化', danger: true });
    if (!ok) return;
    try {
      await api(`/admin/registration-links/${l.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="admin-page">
      <div className="admin-header">
        <div>
          <h1>登録リンク</h1>
          <p className="muted small">
            未使用で有効期限内のパスキー登録リンクの一覧です。リンクのURLは発行時にのみ表示されます。新しいリンクはユーザー詳細画面から発行できます。
          </p>
        </div>
      </div>
      {!links ? (
        <Spinner />
      ) : (
        <div className="card no-pad">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>対象ユーザー</th>
                  <th>種類</th>
                  <th>発行</th>
                  <th>有効期限</th>
                  <th>発行者</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <Link to={`/admin/users/${l.userId}`}>{l.displayName}</Link> <span className="muted small">@{l.username}</span>
                    </td>
                    <td>{l.purpose === 'invite' ? '招待' : '復旧'}</td>
                    <td className="nowrap">{formatDateTime(l.createdAt)}</td>
                    <td className="nowrap">
                      {formatDateTime(l.expiresAt)} <span className="muted small">（{formatRelative(l.expiresAt)}）</span>
                    </td>
                    <td>{l.createdBy ?? 'システム'}</td>
                    <td>
                      <Button size="sm" variant="ghost" className="text-danger" onClick={() => revoke(l)}>
                        無効化
                      </Button>
                    </td>
                  </tr>
                ))}
                {links.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty small">
                      有効な登録リンクはありません
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
