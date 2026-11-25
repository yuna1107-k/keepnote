import { useReadingMode } from '../readingMode';
import { PeekLayer } from './PagePeek';
import { useEffect, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { isOffline, onOfflineChange } from '../api';
import { inApp, nativeBack } from '../appBridge';
import { Button, Icon } from '../ui';
import { MoveDialog, SearchDialog, TrashDialog } from './Dialogs';
import { Sidebar } from './Sidebar';
import { useWorkspace, WorkspaceProvider } from './WorkspaceContext';

function NoWorkspace() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  return (
    <div className="empty-state">
      <h2>参加しているワークスペースがありません</h2>
      <p className="muted">
        {ws.canCreateWorkspace ? '管理者画面からワークスペースを作成してください。' : '管理者に、ワークスペースへの追加またはページの共有を依頼してください。'}
      </p>
      {ws.canCreateWorkspace && (
        <Button variant="primary" onClick={() => navigate('/admin/workspaces')}>
          管理者画面でワークスペースを作成
        </Button>
      )}
    </div>
  );
}

function Shell({ children }: { children?: ReactNode }) {
  const ws = useWorkspace();
  const location = useLocation();
  const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
  // Android アプリの中では、ページの一覧はアプリの画面で出すのでサイドバーは使わない
  const [open, setOpen] = useState(() => !inApp && !isMobile());

  // エディタは重いので、ワークスペースを開いた時点で先読みしておく
  useEffect(() => {
    void import('./Editor');
  }, []);

  useEffect(() => {
    if (isMobile()) setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ws.ui.setSearchOpen(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ws.ui]);

  // オフラインかどうか（オフラインのときは上に帯を出す）
  const [netOffline, setNetOffline] = useState(!navigator.onLine);
  const [apiOffline, setApiOffline] = useState(isOffline);
  const offline = netOffline || apiOffline;
  useEffect(() => {
    const on = () => setNetOffline(false);
    const off = () => setNetOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const stop = onOfflineChange(setApiOffline);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      stop();
    };
  }, []);

  // 前に貼ったファイルの中身も検索できるよう、裏で少しずつ読み取る
  const wsId = ws.current?.id;
  useEffect(() => {
    if (!wsId) return;
    const t = setTimeout(() => void import('./fileTextBackfill').then((m) => m.backfillFileText(wsId)), 8000);
    return () => clearTimeout(t);
  }, [wsId]);

  // 閲覧モードのあいだは、サイドバーを隠して本文だけにする
  const [reading] = useReadingMode();
  return (
    <div className={`app ${open && !reading ? 'sidebar-open' : 'sidebar-closed'} ${inApp ? 'app-mode' : ''}`}>
      {open && !reading && <div className="sidebar-overlay" onClick={() => setOpen(false)} />}
      {!inApp && !reading && (
        <div className="sidebar-wrap">
          <Sidebar onCollapse={() => setOpen(false)} />
        </div>
      )}
      <main className="main">
        {offline && (
          <div className="offline-banner" role="status">
            <Icon name="offline" size={15} /> オフラインです。保存済みの内容を表示しています（変更は保存されません）
          </div>
        )}
        {inApp ? (
          <button className="icon-btn sidebar-open-btn" onClick={nativeBack} aria-label="戻る">
            <Icon name="chevronLeft" />
          </button>
        ) : (
          !open && !reading && (
            <button className="icon-btn sidebar-open-btn" onClick={() => setOpen(true)} aria-label="サイドバーを開く">
              <Icon name="menu" />
            </button>
          )
        )}
        {ws.workspaces && ws.workspaces.length === 0 && location.pathname === '/' ? <NoWorkspace /> : (children ?? <Outlet />)}
      </main>
      <PeekLayer />
      <SearchDialog />
      <TrashDialog />
      <MoveDialog />
    </div>
  );
}

export default function WorkspaceLayout({ children }: { children?: ReactNode }) {
  return (
    <WorkspaceProvider>
      <Shell>{children}</Shell>
    </WorkspaceProvider>
  );
}
