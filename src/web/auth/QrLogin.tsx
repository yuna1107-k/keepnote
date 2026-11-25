/**
 * スマホで承認してログイン（PC 側）。
 * Windows の一部の機種では、スマホのパスキーを使うログイン（Bluetooth）が使えないため、
 * QR コードと 6 桁のコードを出し、ログイン済みのスマホで承認してもらう。
 */
import qrcode from 'qrcode-generator';
import { useEffect, useRef, useState } from 'react';
import { api, type User } from '../api';

type Request = { id: string; secret: string; code: string; expiresAt: number };

export function QrLogin({ onDone }: { onDone: (u: User) => void }) {
  const [req, setReq] = useState<Request | null>(null);
  const [state, setState] = useState<'idle' | 'waiting' | 'confirm' | 'expired' | 'error'>('idle');
  const [account, setAccount] = useState<{ name: string; username: string } | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState('');
  const [left, setLeft] = useState(0);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const start = async () => {
    setError('');
    try {
      const r = await api<Request>('/auth/qr/start', { body: {} });
      setReq(r);
      setState('waiting');
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  };

  // 承認されるのを待つ（2 秒ごとに確かめる）
  useEffect(() => {
    if (state !== 'waiting' || !req) return;
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      setLeft(Math.max(0, Math.round((req.expiresAt - Date.now()) / 1000)));
      try {
        const res = await fetch(`/api/auth/qr/poll?id=${encodeURIComponent(req.id)}`, { credentials: 'same-origin', headers: { 'x-login-secret': req.secret } });
        const data = (await res.json().catch(() => ({}))) as { status?: string; account?: { name: string; username: string }; error?: string };
        if (!alive) return;
        // 承認された：どのアカウントかを見せて、確かめてからログインする
        if (data.status === 'approved' && data.account) {
          setAccount(data.account);
          return setState('confirm');
        }
        if (data.status === 'expired' || !res.ok) return setState('expired');
      } catch {
        /* 電波が悪いときは次に確かめる */
      }
      timer = window.setTimeout(tick, 2000);
    };
    let timer = window.setTimeout(tick, 1500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [state, req]);

  if (state === 'idle' || state === 'error') {
    return (
      <div className="qr-login">
        <button className="qr-login-open" onClick={() => void start()}>
          スマホで承認してログイン
        </button>
        <p className="qr-login-hint">パスキーがスマホにしかなく、この PC でうまくいかないとき</p>
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }
  if (state === 'confirm' && account) {
    const finish = async () => {
      setFinishing(true);
      setError('');
      try {
        const res = await fetch('/api/auth/qr/finish', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-login-secret': req!.secret },
          body: JSON.stringify({ id: req!.id }),
        });
        const data = (await res.json().catch(() => ({}))) as { user?: User; error?: string };
        if (!res.ok || !data.user) throw new Error(data.error ?? 'ログインできませんでした');
        doneRef.current(data.user);
      } catch (e) {
        setError((e as Error).message);
        setFinishing(false);
      }
    };
    return (
      <div className="qr-login is-open">
        <p className="qr-login-step">
          スマホで承認されました。
          <br />
          <strong>{account.name}</strong>（@{account.username}）としてログインしますか？
        </p>
        <button className="sticky-button" onClick={() => void finish()} disabled={finishing}>
          {finishing ? '確認しています…' : 'このアカウントでログイン'}
        </button>
        <button className="qr-login-open" onClick={() => setState('idle')}>
          自分のアカウントではない（やめる）
        </button>
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }
  const url = `${window.location.origin}/approve-login?id=${req!.id}`;
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return (
    <div className="qr-login is-open">
      {state === 'expired' ? (
        <>
          <p className="qr-login-step">時間切れになりました。</p>
          <button className="qr-login-open" onClick={() => void start()}>
            もう一度 QR コードを出す
          </button>
        </>
      ) : (
        <>
          <ol className="qr-login-steps">
            <li>ログインしているスマホのカメラで、この QR コードを読みます</li>
            <li>スマホに下のコードを入力し、パスキーで確認して「承認」を押します</li>
          </ol>
          <div className="qr-login-code" aria-label={`コード ${req!.code.split('').join(' ')}`}>
            {req!.code.slice(0, 3)} {req!.code.slice(3)}
          </div>
          <div className="qr-login-qr" dangerouslySetInnerHTML={{ __html: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) }} />
          <p className="qr-login-hint">
            承認を待っています…（あと {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}）
          </p>
        </>
      )}
    </div>
  );
}
