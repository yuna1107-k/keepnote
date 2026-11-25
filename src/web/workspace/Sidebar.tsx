import { useEffect, useRef, useState, type DragEvent } from 'react';
import { NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { buildInfo } from '../buildInfo';
import { api, type PageSummary } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Button, formatDateTime, formatRelative, Icon, Menu, Modal, PageIcon, Popover, useNow, useUi, UserAvatar, WorkspaceIcon, type IconName, type MenuItem } from '../ui';
import { WorkspaceSwitcher } from './Workspaces';
import { useImporter } from './Importer';
import { canEdit, isJournal, pagePath, pageParam, pageTitle, sectionOf, useWorkspace } from './WorkspaceContext';

const EXPANDED_KEY = 'sidebar.expanded';
function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

let expandedState = loadExpanded();
const listeners = new Set<() => void>();
function setExpanded(id: string, value: boolean) {
  expandedState = new Set(expandedState);
  if (value) expandedState.add(id);
  else expandedState.delete(id);
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedState]));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}
function useExpanded(id: string): [boolean, (v: boolean) => void] {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return [expandedState.has(id), (v) => setExpanded(id, v)];
}

// ドラッグ中のページID（dragover 中は dataTransfer を読めないためモジュール変数で保持）
let draggingId: string | null = null;

type DropPos = 'before' | 'inside' | 'after';

function TreeItem({ page, depth }: { page: PageSummary; depth: number }) {
  const ws = useWorkspace();
  const activeId = ws.resolveId(pageParam(useParams()));
  const navigate = useNavigate();
  const [expandedRaw, setOpen] = useExpanded(page.id);
  // 「Journal 2026」などの日記と、データベース（読書記録など）のページは、サイドバーでは開かない
  // （日記・行はページの中のカレンダーや一覧から開く）
  const noExpand = isJournal(page.title) || !!page.isDatabase;
  const expanded = expandedRaw && !noExpand;
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [drop, setDrop] = useState<DropPos | null>(null);
  const kids = ws.childrenOf(page.id);
  const favorite = ws.favorites.includes(page.id);

  const canDropHere = () => {
    if (!draggingId || draggingId === page.id) return false;
    return !ws.ancestors(page.id).some((a) => a.id === draggingId);
  };

  const onDragOver = (e: DragEvent) => {
    if (!canDropHere()) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - r.top;
    setDrop(y < r.height * 0.28 ? 'before' : y > r.height * 0.72 ? 'after' : 'inside');
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const id = draggingId;
    const pos = drop;
    setDrop(null);
    draggingId = null;
    if (!id || !pos || !canDropHereFor(id)) return;
    if (pos === 'inside') {
      setOpen(true);
      ws.movePage(id, page.id);
      return;
    }
    const parentId = page.parentId && ws.byId.has(page.parentId) ? page.parentId : null;
    const siblings = ws.childrenOf(parentId, parentId ? undefined : sectionOf(page)).filter((s) => s.id !== id);
    const idx = siblings.findIndex((s) => s.id === page.id);
    const beforeId = pos === 'before' ? page.id : (siblings[idx + 1]?.id ?? null);
    ws.movePage(id, parentId, parentId || sectionOf(page) === 'shared' ? undefined : page.visibility, beforeId);
  };

  const canDropHereFor = (id: string) => id !== page.id && !ws.ancestors(page.id).some((a) => a.id === id);

  const editable = canEdit(page) && ws.canContribute;
  // GitHub のフォルダにはページ・フォルダを追加でき、ファイルにはサブページを作れない。リポジトリのページは移動・削除できない
  const ghFolder = page.githubKind === 'dir' || page.githubKind === 'root';
  const ghFile = page.githubKind === 'md' || page.githubKind === 'file';
  const canAddChild = editable && !ghFile;
  const items: MenuItem[] = [
    { label: favorite ? 'お気に入りから外す' : 'お気に入りに追加', icon: 'star', onClick: () => ws.setFavorite(page.id, !favorite) },
    ...(editable
      ? ([
          ...(canAddChild ? [{ label: ghFolder ? 'ページを追加' : 'サブページを追加', icon: 'plus', onClick: () => { setOpen(true); ws.createPage(page.id); } }] : []),
          ...(ghFolder ? [{ label: 'フォルダを作成', icon: 'folder', onClick: () => { setOpen(true); void ws.createFolder(page.id); } }] : []),
          ...(page.githubKind === 'root'
            ? []
            : ([
                { label: '移動', icon: 'move', onClick: () => ws.ui.setMoveTarget(page.id) },
                'divider',
                {
            label: 'ゴミ箱に移動',
            icon: 'trash',
            danger: true,
            onClick: async () => {
              await ws.trashPage(page.id);
              if (activeId === page.id || ws.ancestors(activeId ?? '').some((a) => a.id === page.id)) navigate('/');
            },
          },
              ] as MenuItem[])),
        ] as MenuItem[])
      : []),
  ];


  return (
    <div>
      <div
        className={`tree-item ${activeId === page.id ? 'active' : ''} ${drop ? `drop-${drop}` : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        draggable={editable}
        onDragStart={(e) => {
          draggingId = page.id;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', page.id);
        }}
        onDragEnd={() => {
          draggingId = null;
          setDrop(null);
        }}
        onDragOver={onDragOver}
        onDragLeave={() => setDrop(null)}
        onDrop={onDrop}
        onClick={() => navigate(pagePath(page, ws.current?.slug))}
      >
        {noExpand ? (
          <span className="tree-toggle is-static">
            <span className="tree-toggle-icon">
              <PageIcon icon={page.icon} />
            </span>
          </span>
        ) : (
          <button
            className="tree-toggle"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(!expanded);
            }}
            aria-label={expanded ? '折りたたむ' : '展開する'}
          >
            <span className="tree-toggle-icon">
              <PageIcon icon={page.icon} />
            </span>
            <span className="tree-toggle-chevron">
              <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />
            </span>
          </button>
        )}
        <span className="tree-title">{pageTitle(page)}</span>
        {page.isPublic && <Icon name="globe" size={12} className="tree-public" />}
        <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn xs" onClick={(e) => setMenuAnchor(e.currentTarget)} aria-label="メニュー">
            <Icon name="more" size={14} />
          </button>
          {canAddChild && (
            <button
              className="icon-btn xs"
              onClick={() => {
                setOpen(true);
                ws.createPage(page.id);
              }}
              aria-label="サブページを追加"
            >
              <Icon name="plus" size={14} />
            </button>
          )}
        </span>
      </div>
      {menuAnchor && <Menu anchor={menuAnchor} items={items} onClose={() => setMenuAnchor(null)} />}
      {expanded && (
        <div>
          {kids.length === 0 ? (
            <div className="tree-empty" style={{ paddingLeft: 30 + depth * 14 }}>
              サブページはありません
            </div>
          ) : (
            kids.map((k) => <TreeItem key={k.id} page={k} depth={depth + 1} />)
          )}
        </div>
      )}
    </div>
  );
}

type GithubSync = { repo: string; lastSyncAt: number | null; lastSyncStatus: string | null; lastSyncError: string | null; rootPageId: string | null };

/** ワークスペースが GitHub と連携していれば、最終同期の時刻を出す（自動の同期は 10 分ごと） */
function GithubSyncLine() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const wsId = ws.current?.id;
  const [link, setLink] = useState<GithubSync | null>(null);
  useNow(30_000);
  useEffect(() => {
    setLink(null);
    // 連携の情報は、編集できる人だけが読める
    if (!wsId || !ws.canContribute) return;
    let alive = true;
    const load = () =>
      api<{ link: GithubSync | null }>(`/github/workspaces/${wsId}`)
        .then((r) => alive && setLink(r.link))
        .catch(() => {});
    void load();
    const onVisible = () => document.visibilityState === 'visible' && void load();
    const timer = setInterval(() => document.visibilityState === 'visible' && void load(), 60_000);
    window.addEventListener('github-synced', load);
    window.addEventListener('focus', load);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('github-synced', load);
      window.removeEventListener('focus', load);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [wsId, ws.canContribute]);
  if (!link) return null;
  const error = link.lastSyncStatus === 'error';
  const root = link.rootPageId ? ws.byId.get(link.rootPageId) : undefined;
  return (
    <button
      type="button"
      className={`github-sync-line ${error ? 'is-error' : ''}`}
      title={[`GitHub（${link.repo}）`, link.lastSyncAt ? `最終同期：${formatDateTime(link.lastSyncAt)}` : 'まだ同期していません', error && link.lastSyncError ? `エラー：${link.lastSyncError}` : ''].filter(Boolean).join('\n')}
      onClick={() => root && navigate(pagePath(root, ws.current?.slug))}
      disabled={!root}
    >
      <Icon name="github" size={12} />
      <span className="ellipsis">
        {link.lastSyncAt ? `GitHub 最終同期 ${formatRelative(link.lastSyncAt)}` : 'GitHub まだ同期していません'}
        {error ? '（失敗）' : link.lastSyncStatus && link.lastSyncStatus !== 'ok' ? `（${link.lastSyncStatus}）` : ''}
      </span>
    </button>
  );
}

function Section({ title, section }: { title: string; section: 'workspace' | 'private' | 'shared' }) {
  const ws = useWorkspace();
  const [collapsed, setCollapsed] = useState(false);
  const [dropping, setDropping] = useState(false);
  const roots = ws.childrenOf(null, section);
  const visibility = section === 'workspace' ? 'workspace' : 'private';
  const readonly = section === 'shared' || !ws.canContribute;
  if (readonly && roots.length === 0) return null;
  return (
    <div className="sidebar-section">
      <div
        className={`section-header ${dropping ? 'drop-inside' : ''}`}
        onDragOver={(e) => {
          if (!draggingId || readonly) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDropping(false);
          const id = draggingId;
          draggingId = null;
          if (id) ws.movePage(id, null, visibility, null);
        }}
      >
        <button className="section-title" onClick={() => setCollapsed(!collapsed)}>
          {title}
        </button>
        {!readonly && (
          <button className="icon-btn xs section-add" onClick={() => ws.createPage(null, visibility)} aria-label={`${title}にページを追加`}>
            <Icon name="plus" size={14} />
          </button>
        )}
      </div>
      {!collapsed &&
        (roots.length === 0 ? (
          <button className="tree-item tree-add" onClick={() => ws.createPage(null, visibility)}>
            <Icon name="plus" size={14} /> ページを追加
          </button>
        ) : (
          roots.map((p) => <TreeItem key={p.id} page={p} depth={0} />)
        ))}
    </div>
  );
}

const ADMIN_ITEMS: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/admin', label: 'ダッシュボード', icon: 'grid', end: true },
  { to: '/admin/users', label: 'ユーザー', icon: 'users' },
  { to: '/admin/groups', label: 'グループ', icon: 'users' },
  { to: '/admin/workspaces', label: 'ワークスペース', icon: 'grid' },
  { to: '/admin/public', label: '外部公開', icon: 'globe' },
  { to: '/admin/audit', label: '監査ログ', icon: 'activity' },
  { to: '/admin/settings', label: '設定', icon: 'settings' },
  { to: '/admin/releases', label: 'リリース履歴', icon: 'clock' },
];

/** 「管理者画面」の下に展開するメニュー */
function AdminNav() {
  const location = useLocation();
  const onAdmin = location.pathname.startsWith('/admin');
  const [open, setOpen] = useState(onAdmin);
  useEffect(() => {
    if (onAdmin) setOpen(true);
  }, [onAdmin]);
  return (
    <div className="nav-group">
      <button className={`nav-item ${onAdmin && !open ? 'active' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="shield" /> 管理者画面
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} className="nav-chevron" />
      </button>
      {open && (
        <div className="nav-sub">
          {ADMIN_ITEMS.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end} className="nav-item nav-sub-item">
              <Icon name={i.icon} size={14} /> {i.label}
            </NavLink>
          ))}
          <div className="nav-version muted">
            keepnote v{buildInfo.version}・{buildInfo.commit}
          </div>
        </div>
      )}
    </div>
  );
}

export function Sidebar({ onCollapse }: { onCollapse: () => void }) {
  const { user, serviceName } = useAuth();
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [userMenu, setUserMenu] = useState<HTMLElement | null>(null);
  const activeId = ws.resolveId(pageParam(useParams()));
  const scrolledRef = useRef<HTMLDivElement>(null);
  const importer = useImporter();
  const { toast } = useUi();

  // 開いているページの祖先を自動で展開
  useEffect(() => {
    if (!activeId) return;
    for (const a of ws.ancestors(activeId)) if (!expandedState.has(a.id)) setExpanded(a.id, true);
  }, [activeId, ws]);

  const favorites = ws.favorites.map((id) => ws.byId.get(id)).filter((p): p is PageSummary => !!p);

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button className="workspace-switcher" onClick={(e) => setUserMenu(e.currentTarget)}>
          <WorkspaceIcon ws={ws.current ?? { name: serviceName || 'W' }} size={22} />
          <span className="workspace-name">{ws.current?.name ?? (ws.workspaces ? 'ワークスペースなし' : '')}</span>
          <Icon name="chevronDown" size={12} />
        </button>
        <button className="icon-btn" onClick={onCollapse} aria-label="サイドバーを閉じる">
          <Icon name="chevronsLeft" />
        </button>
      </div>
      <GithubSyncLine />
      {userMenu && (
        <Popover anchor={userMenu} onClose={() => setUserMenu(null)} width={300}>
          <WorkspaceSwitcher onClose={() => setUserMenu(null)} />
        </Popover>
      )}
      <button className="sidebar-user" onClick={() => navigate('/settings')} title="アカウント設定">
        <UserAvatar user={user} size={20} />
        <span className="ellipsis">{user?.displayName}</span>
        <span className="muted small ellipsis">@{user?.username}</span>
      </button>

      <nav className="sidebar-nav">
        <button className="nav-item" onClick={() => ws.ui.setSearchOpen(true)}>
          <Icon name="search" /> 検索 <kbd>⌘K</kbd>
        </button>
        <NavLink to="/" end className="nav-item">
          <Icon name="home" /> ホーム
        </NavLink>
        <NavLink to="/tasks" className="nav-item">
          <Icon name="task" /> タスク
        </NavLink>
        <NavLink to="/templates" className="nav-item">
          <Icon name="template" /> テンプレート
        </NavLink>
        <NavLink to="/graph" className="nav-item">
          <Icon name="graph" /> 関係図
        </NavLink>
        <NavLink to="/settings" className="nav-item">
          <Icon name="settings" /> 設定
        </NavLink>
        <NavLink to="/help" className="nav-item">
          <Icon name="help" /> 使い方
        </NavLink>
        {user?.role === 'admin' && <AdminNav />}
      </nav>

      <div className="sidebar-scroll" ref={scrolledRef}>
        {favorites.length > 0 && (
          <div className="sidebar-section">
            <div className="section-header">
              <span className="section-title">お気に入り</span>
            </div>
            {favorites.map((p) => (
              <TreeItem key={`fav-${p.id}`} page={p} depth={0} />
            ))}
          </div>
        )}
        <Section title="ワークスペース" section="workspace" />
        <Section title={user?.role === 'admin' ? '他のメンバーのページ' : '共有されたページ'} section="shared" />
        {/* 「プライベート」はワークスペースの設定でオンにしたときだけ（既にプライベートのページがあれば表示する） */}
        {(ws.current?.privatePages || ws.childrenOf(null, 'private').length > 0) && <Section title="プライベート" section="private" />}
      </div>

      {ws.canContribute && (
      <div className="sidebar-bottom">
        <button className="nav-item" onClick={() => ws.ui.setTrashOpen(true)}>
          <Icon name="trash" /> ゴミ箱
        </button>
        <button
          className="nav-item"
          onClick={importer.choose}
          disabled={importer.busy}
          title="Markdown・HTML・テキスト、または Notion の書き出し（ZIP）"
        >
          <Icon name="upload" /> {importer.importing ? '読み込み中…' : 'インポート'}
        </button>
        {importer.modal}
        {importer.input}
        <button className="nav-item" onClick={() => ws.createPage(null, 'workspace')}>
          <Icon name="plus" /> 新規ページ
        </button>
      </div>
      )}
    </aside>
  );
}
