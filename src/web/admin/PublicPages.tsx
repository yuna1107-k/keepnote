import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Button, formatDateTime, Icon, PageIcon, Spinner, useUi } from '../ui';

type PublicPageRow = {
  id: string;
  title: string;
  icon: string | null;
  url: string;
  subpages: boolean;
  indexing: boolean;
  publishedAt: number | null;
  publishedBy: string | null;
  owner: string | null;
};

export default function PublicPages() {
  const { toast, confirm } = useUi();
  const [pages, setPages] = useState<PublicPageRow[] | null>(null);
  const load = () => api<{ pages: PublicPageRow[] }>('/admin/public-pages').then((r) => setPages(r.pages));
  useEffect(() => {
    load().catch((e) => toast(e.message, 'error'));
  }, []);

  const stop = async (p: PublicPageRow) => {
    const ok = await confirm({ title: '公開を停止しますか？', message: `「${p.title || '無題'}」の公開リンクは開けなくなります。`, confirmLabel: '公開を停止', danger: true });
    if (!ok) return;
    try {
      await api(`/admin/public-pages/${p.id}`, { method: 'DELETE' });
      toast('公開を停止しました', 'success');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="admin-page">
      <div className="admin-header">
        <div>
          <h1>外部公開</h1>
          <p className="muted small">
            Web に公開中のページの一覧です。誰に公開を許可するかは <Link to="/admin/settings">ワークスペース設定</Link> で変更できます。
          </p>
        </div>
      </div>
      {!pages ? (
        <Spinner />
      ) : (
        <div className="card no-pad">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>ページ</th>
                  <th>範囲</th>
                  <th>検索エンジン</th>
                  <th>公開者</th>
                  <th>公開日時</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pages.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="user-cell">
                        <PageIcon icon={p.icon} />
                        <div>
                          <Link to={`/p/${p.id}`} className="list-title">
                            {p.title || '無題'}
                          </Link>
                          <a className="muted small ellipsis public-url" href={p.url} target="_blank" rel="noreferrer">
                            {p.url} <Icon name="external" size={11} />
                          </a>
                        </div>
                      </div>
                    </td>
                    <td>{p.subpages ? 'サブページ含む' : 'このページのみ'}</td>
                    <td>{p.indexing ? <span className="badge badge-warn">表示</span> : <span className="badge badge-muted">非表示</span>}</td>
                    <td>{p.publishedBy ?? '—'}</td>
                    <td className="nowrap">{formatDateTime(p.publishedAt)}</td>
                    <td>
                      <Button size="sm" variant="ghost" className="text-danger" onClick={() => stop(p)}>
                        公開を停止
                      </Button>
                    </td>
                  </tr>
                ))}
                {pages.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty small">
                      公開中のページはありません
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
