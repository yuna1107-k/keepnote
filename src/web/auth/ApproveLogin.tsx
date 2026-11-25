/**
 * スマホで承認してログイン（スマホ側）。PC に出ているコードを入力し、パスキーで本人確認をして承認する。
 * 他人に承認させてログインを乗っ取る手口を防ぐため、コードの入力とパスキーの確認の両方を求める。
 */
import { startAuthentication } from '@simplewebauthn/browser';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Button, Icon, Spinner } from '../ui';
import { passkeyErrorMessage } from './passkey';

/** 申請した端末の、おおまかな種類 */
function describe(ua: string | null) {
  if (!ua) return '不明な端末';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone / iPad' : /Linux/.test(ua) ? 'Linux' : 'その他';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'ブラウザ';
  return `${os} の ${browser}`;
}

export default function ApproveLogin() {
  const [params] = useSearchParams();
  const id = params.get('id') ?? '';
  const [info, setInfo] = useState<{ ua: string | null; ip: string | null; place: string | null; createdAt: number; expired: boolean; approved: boolean } | null>(null);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api<typeof info>(`/auth/qr/info?id=${encodeURIComponent(id)}`)
      .then(setInfo)
      .catch((e) => setError((e as Error).message));
  }, [id]);

  const approve = async () => {
    setBusy(true);
    setError('');
    try {
      const { options, challengeId } = await api('/auth/login/options', { body: {} });
      const response = await startAuthentication({ optionsJSON: options });
      await api('/auth/qr/approve', { body: { id, code, challengeId, response } });
      setDone(true);
    } catch (e) {
      const msg = (e as Error).message;
      setError(e instanceof Error && /NotAllowed|Abort/.test(e.name) ? passkeyErrorMessage(e) : msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="approve-login">
      <div className="approve-card">
        <h1>
          <Icon name="passkey" size={22} /> PC へのログインの承認
        </h1>
        {error && !info ? (
          <p className="auth-error">{error}</p>
        ) : !info ? (
          <Spinner />
        ) : done || info.approved ? (
          <p className="approve-done">承認しました。PC の画面がログイン後の画面に変わります。</p>
        ) : info.expired ? (
          <p className="auth-error">この申請は期限が切れました。PC でもう一度 QR コードを出してください。</p>
        ) : (
          <>
            <p className="approve-from">
              <strong>{describe(info.ua)}</strong> から、あなたのアカウントでのログインが申請されています。
            </p>
            <dl className="approve-meta">
              <dt>場所</dt>
              <dd>{info.place ?? '不明'}</dd>
              <dt>IP アドレス</dt>
              <dd>{info.ip ?? '不明'}</dd>
              <dt>時刻</dt>
              <dd>{new Date(info.createdAt).toLocaleString('ja-JP')}</dd>
            </dl>
            <p className="approve-warn">
              自分で操作している PC でなければ、承認しないでください。人から送られてきたコードや QR コードは、入力・承認しないでください（あなたのアカウントを乗っ取る手口です）。
            </p>
            <label className="approve-label" htmlFor="approve-code">
              PC の画面に出ている 6 桁のコード
            </label>
            <input
              id="approve-code"
              className="input approve-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
              placeholder="000000"
            />
            <Button variant="primary" loading={busy} disabled={code.length !== 6} onClick={() => void approve()}>
              パスキーで確認して承認
            </Button>
            {error && <p className="auth-error">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
