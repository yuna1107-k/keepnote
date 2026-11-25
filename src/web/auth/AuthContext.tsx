import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, onUnauthorized, type User } from '../api';
import { applyTheme } from '../theme';

type AuthState = {
  loading: boolean;
  user: User | null;
  /** サービス名（サーバー全体の名前） */
  serviceName: string;
  /** 開発用ログインを使えるか（localhost で DEV_LOGIN=1 のサーバーのときだけ） */
  devLogin: boolean;
  refresh: () => Promise<void>;
  setUser: (u: User | null) => void;
  logout: () => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [serviceName, setServiceName] = useState('');
  const [devLogin, setDevLogin] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ user: User | null; serviceName: string; devLogin?: boolean }>('/auth/session');
      setDevLogin(data.devLogin === true);
      // ログインが切れていた（期限切れ・管理者が切った）ときは、端末に保存したページの内容も消す
      if (!data.user) {
        navigator.serviceWorker?.controller?.postMessage('clear');
        await caches?.delete('keepnote-data-v1').catch(() => {});
        await caches?.delete('keepnote-share').catch(() => {});
      }
      setUser(data.user);
      setServiceName(data.serviceName);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    onUnauthorized(() => setUser(null));
  }, [refresh]);

  useEffect(() => {
    document.title = serviceName || 'keepnote';
  }, [serviceName]);

  // ログイン中はアカウントのテーマ設定を反映（ログアウト後も同じ端末では引き継ぐ）
  useEffect(() => {
    if (user) applyTheme(user.theme);
  }, [user?.theme]);

  const logout = useCallback(async () => {
    await api('/auth/logout', { body: {} }).catch(() => {});
    // 別のアカウントでログインしたときに前の人の内容が見えないよう、キャッシュを捨てる
    (await import('../workspace/WorkspaceContext')).clearWorkspaceCache();
    // オフライン用に端末に保存したページの内容も消す
    navigator.serviceWorker?.controller?.postMessage('clear');
    await caches?.delete('keepnote-data-v1').catch(() => {});
    await caches?.delete('keepnote-share').catch(() => {});
    setUser(null);
  }, []);

  return (
    <Ctx.Provider value={{ loading, user, serviceName, devLogin, refresh, setUser, logout }}>{children}</Ctx.Provider>
  );
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider がありません');
  return v;
}
