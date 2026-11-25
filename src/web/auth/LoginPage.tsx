import { useEffect, useState } from 'react';
import { canNativeLogin, nativeLogin } from '../appBridge';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api, type User } from '../api';
import { Icon, Spinner } from '../ui';
import { landingPath } from '../workspace/WorkspacePicker';
import { AuthBoard } from './AuthBoard';
import { useAuth } from './AuthContext';
import { loginWithPasskey, passkeyErrorMessage, passkeySupported } from './passkey';
import { QrLogin } from './QrLogin';

/** ログイン画面（付箋のデザイン。土台は AuthBoard） */
export default function LoginPage() {
  const { user, loading, setUser, serviceName, devLogin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  // アプリの中でのログインの結果（失敗したとき）
  useEffect(() => {
    const onError = (e: Event) => {
      setError((e as CustomEvent<string>).detail || 'ログインできませんでした');
      setBusy(false);
    };
    window.addEventListener('app-login-error', onError);
    return () => window.removeEventListener('app-login-error', onError);
  }, []);

  if (loading) return <Spinner center />;
  if (user) return <Navigate to={from} replace />;

  const supported = passkeySupported() || canNativeLogin();

  const login = async () => {
    setBusy(true);
    setError('');
    if (canNativeLogin()) {
      nativeLogin();
      return;
    }
    try {
      const u = await loginWithPasskey();
      setUser(u);
      // ワークスペースが 2 つ以上あれば、まず一覧を出す
      navigate(await landingPath(from), { replace: true });
    } catch (err) {
      setError(passkeyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthBoard
      label="ログイン"
      memo={
        <>
          アカウントは管理者が発行します。
          <br />
          パスキーの再発行は管理者に依頼してください。
        </>
      }
    >
      <h1 className="sticky-title hand">{serviceName || 'keepnote'}</h1>
      <p className="sticky-text">この端末に保存したパスキーで、ノートを開きます。</p>
      {devLogin && (
        // 手元の開発用サーバーだけ（localhost で DEV_LOGIN=1）
        <button
          className="sticky-button dev-login-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ user: User }>('/auth/dev-login', { body: { username: 'dev' } });
              setUser(r.user);
              navigate(await landingPath(from), { replace: true });
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }}
        >
          開発用ログイン（dev）
        </button>
      )}
      {supported ? (
        <button className="sticky-button" onClick={login} disabled={busy}>
          {busy ? <span className="spinner spinner-sm" aria-hidden="true" /> : <Icon name="passkey" size={22} />}
          {busy ? '確認しています…' : 'パスキーでログイン'}
        </button>
      ) : (
        <p className="auth-error" role="alert">
          このブラウザはパスキーに対応していません。最新の Chrome・Safari・Edge で開いてください。
        </p>
      )}
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      {/* パスキーがスマホにしかない PC 向け（アプリの中では出さない） */}
      {!canNativeLogin() && (
        <QrLogin
          onDone={async (u) => {
            setUser(u);
            navigate(await landingPath(from), { replace: true });
          }}
        />
      )}
    </AuthBoard>
  );
}
