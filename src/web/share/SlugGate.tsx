import { lazy, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Spinner } from '../ui';

const PageView = lazy(() => import('../workspace/PageView'));
const PublicPage = lazy(() => import('./PublicPage'));

/**
 * /<ワークスペースのURL名>/<ページのURL> の中身。
 * アクセス権のあるログイン中のユーザーには編集画面を、それ以外には公開ページ（またはログイン案内）を表示する。
 * 外枠（サイドバー）は AppShell が共通で持つので、ここでは作らない。
 */
export default function SlugGate() {
  const { wsSlug, pageSlug } = useParams();
  const { user } = useAuth();
  const [mode, setMode] = useState<'loading' | 'member' | 'public'>(user ? 'loading' : 'public');

  useEffect(() => {
    if (!user) return setMode('public');
    // 同じページの URL 変更などで再確認するときは、表示を消さずに判定する
    api<{ id: string; workspaceSlug: string }>(`/pages/by-slug/${encodeURIComponent(pageSlug ?? '')}`)
      .then((r) => setMode(r.workspaceSlug === wsSlug ? 'member' : 'public'))
      .catch(() => setMode('public'));
  }, [user, wsSlug, pageSlug]);

  if (mode === 'loading') return <Spinner center />;
  return mode === 'member' ? <PageView /> : <PublicPage />;
}
