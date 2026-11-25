import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type PageAppearance } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Button, Icon, IconText, PageIcon, Spinner } from '../ui';
import { Cover } from '../workspace/Cover';
import { SelectionCount, WordCountButton } from '../workspace/CountChip';
import { countText, documentText, type TextCount } from '../workspace/wordCount';

const Editor = lazy(() => import('../workspace/Editor'));

type PublicData = {
  workspaceName: string;
  workspaceSlug: string;
  slug: string;
  rootId: string;
  indexing: boolean;
  page: PageAppearance & { id: string; parentId: string | null; title: string; icon: string | null; content: any[]; updatedAt: number };
  tree: { id: string; parentId: string | null; title: string; icon: string | null }[];
};

function setRobots(index: boolean) {
  let meta = document.querySelector('meta[name="robots"]') as HTMLMetaElement | null;
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'robots';
    document.head.appendChild(meta);
  }
  meta.content = index ? 'index, follow' : 'noindex, nofollow';
}

export default function PublicPage() {
  const params = useParams();
  // /<ワークスペース>/<URL>[/<サブページID>] と、旧形式の /share/<URL>[/<サブページID>] の両方に対応
  const slug = params.pageSlug ?? params.slug;
  const pageId = params.subId ?? params.pageId;
  const [data, setData] = useState<PublicData | null>(null);
  const [error, setError] = useState('');
  const [needLogin, setNeedLogin] = useState(false);
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    setData(null);
    setError('');
    setNeedLogin(false);
    api<PublicData>(pageId ? `/public/${slug}/pages/${pageId}` : `/public/${slug}`)
      .then((d) => {
        setData(d);
        // 旧形式の URL や、ワークスペース名が違う URL で開いたときは正しい URL に置き換える
        const canonical = `/${d.workspaceSlug}/${d.slug}${pageId ? `/${pageId}` : ''}`;
        if (window.location.pathname !== canonical) navigate(canonical, { replace: true });
        document.title = `${d.page.title || '無題'} | ${d.workspaceName}`;
        setRobots(d.indexing);
        window.scrollTo(0, 0);
      })
      .catch(async (e) => {
        if (e.status !== 404) return setError(e.message);
        // 公開していないページ：招待されたアカウントなら、ログインしてページを開く
        setRobots(false);
        if (!user) return setNeedLogin(true);
        try {
          const r = await api<{ id: string; workspaceSlug: string }>(`/pages/by-slug/${slug}`);
          navigate(pageId ? `/p/${pageId}` : `/${r.workspaceSlug}/${slug}`, { replace: true });
        } catch {
          setError('このページは存在しないか、あなたには共有されていません。');
        }
      });
  }, [slug, pageId, user, loading]);


  // 文字数と、選択中の文字数
  const counts = useMemo(() => (data ? countText(documentText(data.page.content)) : null), [data]);
  const [selCounts, setSelCounts] = useState<TextCount | null>(null);
  const onSelectionText = useCallback((text: string) => setSelCounts(text.trim() ? countText(text) : null), []);
  useEffect(() => setSelCounts(null), [data]);

  const resolve = useMemo(
    () => (url: string) => url.replace(/^\/api\/files\//, `/api/public/${slug}/files/`),
    [slug],
  );

  if (needLogin)
    return (
      <div className="public-shell">
        <div className="empty-state">
          <h2>ログインが必要です</h2>
          <p className="muted">このページは、招待されたアカウントだけが閲覧できます。パスキーでログインしてください。</p>
          <Button variant="primary" onClick={() => navigate('/login', { state: { from: window.location.pathname } })}>
            <Icon name="key" /> ログイン
          </Button>
        </div>
      </div>
    );

  if (error)
    return (
      <div className="public-shell">
        <div className="empty-state">
          <h2>ページが見つかりません</h2>
          <p className="muted">{error}</p>
        </div>
      </div>
    );
  if (!data) return <Spinner center />;

  const { page, tree } = data;
  const byId = new Map(tree.map((t) => [t.id, t]));
  const crumbs: typeof tree = [];
  for (let cur = byId.get(page.id); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) crumbs.unshift(cur);
  const children = tree.filter((t) => t.parentId === page.id);
  const href = (id: string) => (id === data.rootId ? `/${data.workspaceSlug}/${data.slug}` : `/${data.workspaceSlug}/${data.slug}/${id}`);
  const pageClass = ['page', 'public-page', page.fullWidth && 'page-full', page.smallText && 'page-small', `page-font-${page.font}`]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="public-shell">
      <div className={pageClass}>
        <header className="topbar public-topbar">
          <nav className="breadcrumbs">
            {crumbs.map((c, i) => (
              <span key={c.id} className={`crumb ${i === crumbs.length - 1 ? 'current' : ''}`}>
                {i === crumbs.length - 1 ? (
                  <>
                    <PageIcon icon={c.icon} size={14} /> <span className="ellipsis">{c.title || '無題'}</span>
                  </>
                ) : (
                  <>
                    <Link to={href(c.id)}>
                      <PageIcon icon={c.icon} size={14} /> <span className="ellipsis">{c.title || '無題'}</span>
                    </Link>
                    <span className="crumb-sep">/</span>
                  </>
                )}
              </span>
            ))}
          </nav>
          <span className="public-badge">
            <Icon name="globe" size={12} /> {data.workspaceName}
          </span>
        </header>

        {page.cover && <Cover cover={page.cover} position={page.coverPosition} editable={false} resolve={resolve} />}

        <div className={`page-body ${page.cover ? 'has-cover' : ''}`}>
          <div className={`page-head ${page.icon ? 'has-icon' : ''}`}>
            {page.icon && <div className="page-icon-large static"><IconText icon={page.icon} size={72} /></div>}
            <h1 className="page-title static">{page.title || '無題'}</h1>
            <div className="page-meta muted small">
              <span>最終更新: {new Date(page.updatedAt).toLocaleDateString('ja-JP')}</span>
              {counts && (
                <>
                  <span className="meta-sep">・</span>
                  <WordCountButton counts={counts} selection={selCounts} />
                </>
              )}
            </div>
          </div>
          <div className="editor-wrap">
            <Suspense fallback={<Spinner />}>
              <Editor key={page.id} initialContent={page.content} editable={false} resolveFileUrl={resolve} onSelectionText={onSelectionText} />
            </Suspense>
          </div>
          {children.length > 0 && (
            <div className="subpages">
              {children.map((c) => (
                <Link key={c.id} to={href(c.id)} className="subpage-link">
                  <PageIcon icon={c.icon} /> <span>{c.title || '無題'}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
      <SelectionCount counts={selCounts} />
    </div>
  );
}
