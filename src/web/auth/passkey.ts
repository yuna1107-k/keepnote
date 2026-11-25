import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api, ApiError, type User } from '../api';

export function passkeySupported() {
  return browserSupportsWebAuthn();
}

/** 登録するパスキーの初期名をブラウザ情報から推測する（後から変更可能） */
export function guessDeviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'デバイス';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  return browser ? `${os}（${browser}）` : os;
}

export function passkeyErrorMessage(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: string };
  switch (e?.name) {
    case 'NotAllowedError':
      return 'パスキーの操作がキャンセルされたか、タイムアウトしました。この端末にパスキーが無い場合は、パスキーのある端末を使うか管理者に登録リンクを依頼してください。';
    case 'InvalidStateError':
      return 'この端末（またはパスワードマネージャー）には、既にこのアカウントのパスキーが登録されています。';
    case 'SecurityError':
      return 'このURLではパスキーを利用できません。HTTPSで接続しているか、サーバーの ORIGIN / RP_ID 設定を確認してください。';
    case 'AbortError':
      return 'パスキーの操作が中断されました。';
    case 'NotSupportedError':
      return 'このブラウザ／端末はパスキーに対応していません。';
  }
  return e?.message ?? 'パスキーの処理に失敗しました。';
}

export async function loginWithPasskey(): Promise<User> {
  const { options, challengeId } = await api('/auth/login/options', { body: {} });
  const response = await startAuthentication({ optionsJSON: options });
  const { user } = await api<{ user: User }>('/auth/login/verify', { body: { challengeId, response } });
  return user;
}

export async function registerWithToken(token: string, name: string): Promise<User> {
  const { options, challengeId } = await api('/auth/register/options', { body: { token } });
  const response = await startRegistration({ optionsJSON: options });
  const { user } = await api<{ user: User }>('/auth/register/verify', { body: { token, challengeId, response, name } });
  return user;
}

export async function addPasskey(name: string, userId?: string) {
  let opts: { options: any; challengeId: string };
  try {
    opts = await api('/me/passkeys/options', { body: {} });
  } catch (e) {
    // 前のログインから時間がたっているときは、パスキーでもう一度ログインしてから追加する
    if (!(e instanceof ApiError && e.status === 403)) throw e;
    const expected = userId ?? (await api<{ user: User | null }>('/auth/session')).user?.id;
    const u = await loginWithPasskey();
    if (expected && u.id !== expected) throw new Error('別のアカウントのパスキーでログインしました。このアカウントのパスキーでログインし直してください');
    opts = await api('/me/passkeys/options', { body: {} });
  }
  const { options, challengeId } = opts;
  const response = await startRegistration({ optionsJSON: options });
  await api('/me/passkeys/verify', { body: { challengeId, response, name } });
}
