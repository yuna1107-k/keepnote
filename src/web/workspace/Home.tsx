import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { PageSummary } from '../api';
import { useAuth } from '../auth/AuthContext';
import { coverStyle } from '../covers';
import { Button, formatRelative, Icon, PageIcon, Spinner } from '../ui';
import { pagePath, pageTitle, useWorkspace } from './WorkspaceContext';
import { openedAt } from './WorkspacePicker';

function PageCard({ page }: { page: PageSummary }) {
  const wsSlug = useWorkspace().current?.slug;
  return (
    <Link to={pagePath(page, wsSlug)} className="page-card">
      <div className="page-card-cover" style={page.cover ? coverStyle(page.cover, 50) : undefined} />
      <div className="page-card-body">
        <div className="page-card-icon">
          <PageIcon icon={page.icon} size={22} />
        </div>
        <div className="page-card-title">{pageTitle(page)}</div>
        <div className="page-card-meta muted small">
          {page.visibility === 'private' && <Icon name="lock" size={11} />}
          {page.isPublic && <Icon name="globe" size={11} />}
          {formatRelative(page.updatedAt)}
        </div>
      </div>
    </Link>
  );
}

export default function Home() {
  const { user } = useAuth();
  const ws = useWorkspace();
  const navigate = useNavigate();
  // サイトを開いたときは、ワークスペースが 2 つ以上あればまず一覧を出す
  const toPicker = openedAt.top && !!ws.workspaces && ws.workspaces.length > 1;
  useEffect(() => {
    if (!ws.workspaces) return;
    if (openedAt.top && ws.workspaces.length > 1) navigate('/workspaces', { replace: true });
    openedAt.top = false;
  }, [ws.workspaces, navigate]);
  if (!ws.loaded || toPicker) return <Spinner center />;

  const recent = [...ws.pages].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
  const favorites = ws.favorites.map((id) => ws.byId.get(id)).filter((p): p is PageSummary => !!p);
  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'こんばんは' : hour < 11 ? 'おはようございます' : hour < 18 ? 'こんにちは' : 'こんばんは';
  const today = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'long' });

  return (
    <div className="home">
      <div className="home-date muted">{today}</div>
      <h1 className="home-greeting">
        {greeting}、{user?.displayName}さん
      </h1>

      <div className="home-actions">
        {ws.canContribute && (
          <>
            <Button variant="primary" onClick={() => ws.createPage(null, 'workspace')}>
              <Icon name="plus" /> 新規ページ
            </Button>
            {ws.current?.privatePages && (
              <Button onClick={() => ws.createPage(null, 'private')}>
                <Icon name="lock" /> プライベートページ
              </Button>
            )}
          </>
        )}
        <Button variant="ghost" onClick={() => ws.ui.setSearchOpen(true)}>
          <Icon name="search" /> 検索 <kbd>⌘K</kbd>
        </Button>
      </div>

      {favorites.length > 0 && (
        <section className="home-section">
          <h2>
            <Icon name="star" size={13} /> お気に入り
          </h2>
          <div className="card-grid">
            {favorites.map((p) => (
              <PageCard key={p.id} page={p} />
            ))}
          </div>
        </section>
      )}

      <section className="home-section">
        <h2>
          <Icon name="clock" size={13} /> 最近の更新
        </h2>
        {recent.length === 0 ? (
          <div className="home-empty">
            <div className="home-empty-icon">
              <Icon name="file" size={28} />
            </div>
            <div className="list-title">{ws.current?.name ?? 'ワークスペース'} へようこそ</div>
            {ws.canContribute ? (
              <>
                <p className="muted small">まだページがありません。最初のページを作成するか、Markdown / HTML ファイルを取り込んでみましょう。</p>
                <Button variant="primary" onClick={() => ws.createPage(null, 'workspace')}>
                  <Icon name="plus" /> 最初のページを作成
                </Button>
              </>
            ) : (
              <p className="muted small">あなたに共有されたページはまだありません。ページが共有されると、ここに表示されます。</p>
            )}
          </div>
        ) : (
          <div className="card-grid">
            {recent.map((p) => (
              <PageCard key={p.id} page={p} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
