import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type User } from '../api';
import { Icon, Spinner } from '../ui';
import { landingPath } from '../workspace/WorkspacePicker';
import { AuthBoard } from './AuthBoard';
import { useAuth } from './AuthContext';
import { guessDeviceName, passkeyErrorMessage, passkeySupported, registerWithToken } from './passkey';

type Invite = {
  username: string;
  displayName: string;
  purpose: 'invite' | 'recovery';
  expiresAt: number;
  serviceName: string;
};

export default function RegisterPage() {
  const { setUser, user: currentUser, logout } = useAuth();
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '');
  const [invite, setInvite] = useState<Invite | null>(null);
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState(guessDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<User | null>(null);

  useEffect(() => {
    // URL からトークンを消して、履歴や画面共有で漏れにくくする
    if (window.location.hash) history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setLoadError('登録リンクが正しくありません。管理者から受け取ったリンクをそのまま開いてください。');
      return;
    }
    api<Invite>('/auth/invite', { body: { token } })
      .then((inv) => {
        setInvite(inv);
        // パスキーの名前の初期値は「アカウント名_端末名」
        setName((n) => (n === guessDeviceName() ? `${inv.username}_${guessDeviceName()}` : n));
      })
      .catch((e) => setLoadError(e.message));
  }, [token]);

  const register = async () => {
    setBusy(true);
    setError('');
    try {
      if (currentUser && invite && currentUser.username !== invite.username) await logout();
      const u = await registerWithToken(token, name.trim());
      setDone(u);
      setUser(u);
    } catch (err) {
      setError(passkeyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const expires = invite ? new Date(invite.expiresAt) : null;
  const memo = invite && !done && !loadError && expires && (
    <>
      @{invite.username}
      <br />
      このリンクは{expires.getMonth() + 1}/{expires.getDate()} {String(expires.getHours()).padStart(2, '0')}:{String(expires.getMinutes()).padStart(2, '0')}まで、1回だけ使えます。
    </>
  );

  return (
    <AuthBoard label="アカウントの登録" memo={memo || undefined}>
      {loadError ? (
        <>
          <h1 className="sticky-title hand">リンクが無効です</h1>
          <p className="auth-error" role="alert">
            {loadError}
          </p>
          <button className="sticky-button sticky-button-ghost" onClick={() => navigate('/login')}>
            ログイン画面へ
          </button>
        </>
      ) : !invite ? (
        <Spinner />
      ) : done ? (
        <>
          <h1 className="sticky-title hand">登録できました</h1>
          <p className="sticky-text">次からは、このパスキーでログインできます。</p>
          <button className="sticky-button" onClick={async () => navigate(await landingPath('/'), { replace: true })}>
            ワークスペースを開く
          </button>
        </>
      ) : (
        <>
          <h1 className="sticky-title hand">{invite.purpose === 'invite' ? 'ようこそ' : 'パスキーの再登録'}</h1>
          <p className="sticky-text">
            <strong>{invite.displayName}</strong> さん、
            {invite.purpose === 'invite'
              ? `パスキーを作ると、${invite.serviceName} の登録が終わります。`
              : '新しいパスキーを作ると、アカウントにまた入れるようになります。'}
          </p>
          {!passkeySupported() ? (
            <p className="auth-error" role="alert">
              このブラウザはパスキーに対応していません。最新の Chrome・Safari・Edge で開いてください。
            </p>
          ) : (
            <>
              <label className="sticky-field">
                <span>パスキーの名前（あとから変えられます）</span>
                <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
              </label>
              <button className="sticky-button" onClick={register} disabled={busy || !name.trim()}>
                {busy ? <span className="spinner spinner-sm" aria-hidden="true" /> : <Icon name="passkey" size={22} />}
                {busy ? '作成しています…' : 'パスキーを作成'}
              </button>
            </>
          )}
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </AuthBoard>
  );
}
