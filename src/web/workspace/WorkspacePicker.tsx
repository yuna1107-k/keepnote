/**
 * ワークスペースの一覧（ログイン直後、ワークスペースが 2 つ以上あるときだけ表示する）。
 * 選んだワークスペースを開く。
 */
import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, type Workspace } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Icon, Spinner, WorkspaceIcon } from '../ui';

/**
 * サイトを開いた（ページを読み込んだ）ときにトップ（/）だったか。アプリの起動時に一度だけ決める
 * （このファイルは起動時に読み込まれる。アプリ内でホームに戻ったときと区別するため）
 */
export const openedAt = { top: window.location.pathname === '/' };

const ROLE: Record<string, string> = { owner: 'オーナー', admin: '管理者', member: 'メンバー', viewer: '閲覧者', guest: 'ゲスト' };

/** ログイン・登録の直後に開く場所（ワークスペースが 2 つ以上なら一覧、1 つならそのホーム） */
export async function landingPath(from = '/') {
  if (from !== '/') return from;
  try {
    const { workspaces } = await api<{ workspaces: Workspace[] }>('/workspaces');
    return workspaces.length > 1 ? '/workspaces' : '/';
  } catch {
    return '/';
  }
}

export default function WorkspacePicker() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [list, setList] = useState<Workspace[] | null>(null);
  useEffect(() => {
    if (user) void api<{ workspaces: Workspace[] }>('/workspaces').then((r) => setList(r.workspaces));
  }, [user]);
  if (loading) return <Spinner center />;
  if (!user) return <Navigate to="/login" replace />;
  if (list && list.length <= 1) return <Navigate to="/" replace />;

  const open = (id: string) => {
    openedAt.top = false;
    try {
      localStorage.setItem('workspace', id);
    } catch {
      /* 保存できなくても開ける */
    }
    navigate('/', { replace: true });
  };

  return (
    <div className="picker">
      <div className="picker-inner">
        <h1>ワークスペースを選んでください</h1>
        <p className="muted">{user.displayName} さんが参加しているワークスペースです。</p>
        {!list ? (
          <Spinner />
        ) : (
          <ul className="picker-list">
            {list.map((w) => (
              <li key={w.id}>
                <button className="picker-item" onClick={() => open(w.id)}>
                  <WorkspaceIcon ws={w} size={40} />
                  <span className="picker-main">
                    <span className="picker-name">{w.name}</span>
                    <span className="muted small">{w.role ? ROLE[w.role] : 'サーバー管理者として閲覧'}</span>
                  </span>
                  <Icon name="chevronRight" size={18} className="muted" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
