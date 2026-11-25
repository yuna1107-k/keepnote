import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { audit, auditStmt } from '../audit.ts';
import { cfg } from '../config.ts';
import { batch, get, run, sql } from '../db.ts';
import { clearSessionCookie, createSession, type AppEnv } from '../session.ts';
import { getSettings } from '../settings.ts';
import { findValidToken, getUser, publicUser } from '../users.ts';
import { body, clientIp, fail, newToken, now, rateLimit, sha256 } from '../util.ts';
import { finishLogin, finishRegistration, startLogin, startRegistration } from '../webauthn.ts';

export const authRoutes = new Hono<AppEnv>();

/**
 * ログインに失敗したときに利用者へ返すメッセージ。理由（パスキーの削除・アカウントの無効化など）は監査ログにだけ残す。
 * パスキーの ID を知っているだけの人に、アカウントの状態を探らせないため
 */
const LOGIN_FAILED_MESSAGE = 'ログインに失敗しました';

authRoutes.use('*', async (c, next) => {
  if (c.req.method !== 'GET') await rateLimit(c, 'auth');
  await next();
});

/** 現在のセッション情報（未ログインでも 200 を返す） */
authRoutes.get('/session', async (c) => {
  const user = c.get('user');
  const settings = await getSettings();
  const row = user ? await getUser(user.id) : undefined;
  return c.json({
    serviceName: settings.serviceName,
    user: row ? publicUser(row) : null,
    // 開発用ログインを使えるか（localhost で DEV_LOGIN=1 のときだけ）
    ...(cfg.DEV_LOGIN ? { devLogin: true } : {}),
  });
});

/**
 * 開発用ログイン：パスキーなしで、指定したユーザー（なければ管理者として作る）でログインする。
 * 手元で画面を確かめるため（README の「開発用ログイン」）。localhost で DEV_LOGIN=1 のときだけ使える
 */
authRoutes.post('/dev-login', async (c) => {
  if (!cfg.DEV_LOGIN) fail(404, '見つかりません');
  const { username } = await body(c, z.object({ username: z.string().regex(/^[a-z0-9_-]{1,32}$/).default('dev') }));
  let user = await get<{ id: string; status: string }>('SELECT id, status FROM users WHERE username = ?', username);
  if (!user) {
    const id = crypto.randomUUID();
    const t = now();
    await run(
      `INSERT INTO users (id, username, display_name, role, status, created_at, updated_at, theme) VALUES (?, ?, ?, 'admin', 'active', ?, ?, 'system')`,
      id,
      username,
      `開発用（${username}）`,
      t,
      t,
    );
    user = { id, status: 'active' };
  }
  if (user.status !== 'active') await run(`UPDATE users SET status = 'active', updated_at = ? WHERE id = ?`, now(), user.id);
  await createSession(c, user.id);
  return c.json({ user: publicUser((await getUser(user.id))!) });
});

// ---- 招待 / 復旧リンクからのパスキー登録 ----

const tokenSchema = z.object({ token: z.string().min(10).max(200) });

authRoutes.post('/invite', async (c) => {
  const { token } = await body(c, tokenSchema);
  const found = await findValidToken(token);
  if (!found) fail(404, 'このリンクは無効か、有効期限が切れています。管理者に再発行を依頼してください');
  return c.json({
    username: found.user.username,
    displayName: found.user.display_name,
    purpose: found.token.purpose,
    expiresAt: found.token.expires_at,
    serviceName: (await getSettings()).serviceName,
  });
});

authRoutes.post('/register/options', async (c) => {
  const { token } = await body(c, tokenSchema);
  const found = await findValidToken(token);
  if (!found) fail(404, 'このリンクは無効か、有効期限が切れています');
  return c.json(await startRegistration(found.user, found.token.id));
});

authRoutes.post('/register/verify', async (c) => {
  const input = await body(
    c,
    tokenSchema.extend({
      challengeId: z.string(),
      name: z.string().max(64).default(''),
      response: z.any(),
    }),
  );
  const found = await findValidToken(input.token);
  if (!found) fail(404, 'このリンクは無効か、有効期限が切れています');
  const { user, token } = found;

  const credentialId = await finishRegistration({
    user,
    challengeId: input.challengeId,
    response: input.response,
    name: input.name,
    tokenId: token.id,
  });

  const t = now();
  await batch([
    sql('UPDATE registration_tokens SET used_at = ? WHERE id = ?', t, token.id),
    // 復旧（パスキーをなくした等）のときは、ほかの端末に残っているログインを切る
    ...(token.purpose === 'recovery' ? [sql('DELETE FROM sessions WHERE user_id = ?', user.id)] : []),
    sql(`UPDATE users SET status = 'active', updated_at = ? WHERE id = ? AND status = 'pending'`, t, user.id),
    auditStmt(c, { id: user.id, username: user.username }, 'passkey.register', { type: 'user', id: user.id, name: user.username }, {
      purpose: token.purpose,
      credentialId,
    }),
  ]);
  await createSession(c, user.id);
  return c.json({ user: publicUser((await getUser(user.id))!) });
});

// ---- パスキーでログイン ----

authRoutes.post('/login/options', async (c) => {
  return c.json(await startLogin());
});

authRoutes.post('/login/verify', async (c) => {
  const input = await body(c, z.object({ challengeId: z.string(), response: z.any() }));
  if (!input.response || typeof input.response.id !== 'string') fail(401, LOGIN_FAILED_MESSAGE);
  const result = await finishLogin(input.challengeId, input.response);
  if (!result.ok) {
    // 理由（削除されたパスキー・無効化されたアカウントなど）は監査ログにだけ残し、利用者には伝えない
    const u = 'user' in result ? result.user : undefined;
    await audit(c, u ? { id: u.id, username: u.username } : null, 'auth.login_failed', u ? { type: 'user', id: u.id, name: u.username } : undefined, {
      reason: result.reason,
    });
    fail(401, LOGIN_FAILED_MESSAGE);
  }
  await createSession(c, result.user.id);
  await audit(c, { id: result.user.id, username: result.user.username }, 'auth.login', { type: 'user', id: result.user.id, name: result.user.username });
  return c.json({ user: publicUser((await getUser(result.user.id))!) });
});

authRoutes.post('/logout', async (c) => {
  const sid = c.get('sessionId');
  const user = c.get('user');
  if (sid) await run('DELETE FROM sessions WHERE id = ?', sid);
  clearSessionCookie(c);
  if (user) await audit(c, { id: user.id, username: user.username }, 'auth.logout');
  return c.json({ ok: true });
});

// ---- スマホで承認してログイン ----
// Windows の一部の機種では、スマホのパスキーで PC にログインする仕組み（Bluetooth を使う）が使えない。
// そのため PC に QR コードと 6 桁のコードを出し、ログイン済みのスマホがパスキーで本人確認をして承認する。

const QR_TTL = 5 * 60_000;

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
/** 時間の差から推測されないよう、最後まで比べる */
function sameCode(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const randomCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, '0');

type LoginRequestRow = { id: string; secret_hash: string; code: string; user_id: string | null; approved_at: number | null; consumed_at: number | null; attempts: number; ua: string | null; ip: string | null; place: string | null; created_at: number; expires_at: number };

/** 申請した場所（Cloudflare が付ける国・市。分からなければ空） */
function placeOf(c: Context<AppEnv>) {
  const cf = (c.req.raw as unknown as { cf?: { city?: string; region?: string; country?: string } }).cf;
  return [cf?.city, cf?.region, cf?.country].filter(Boolean).join(', ') || null;
}

/** PC：ログインの申請を作る（QR コードとコードを画面に出す） */
authRoutes.post('/qr/start', async (c) => {
  const t = now();
  const id = randomHex(16);
  const secret = newToken();
  const code = randomCode();
  await run(
    'INSERT INTO login_requests (id, secret_hash, code, ua, ip, place, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    sha256(secret),
    code,
    (c.req.header('user-agent') ?? '').slice(0, 300),
    clientIp(c),
    placeOf(c),
    t,
    t + QR_TTL,
  );
  return c.json({ id, secret, code, expiresAt: t + QR_TTL });
});

/** PC：承認されたかを確かめる（承認されていたら、ここでログインする） */
authRoutes.get('/qr/poll', async (c) => {
  const id = c.req.query('id') ?? '';
  const secret = c.req.header('x-login-secret') ?? '';
  const row = await get<LoginRequestRow>('SELECT * FROM login_requests WHERE id = ?', id);
  if (!row || !secret || row.secret_hash !== sha256(secret)) fail(404, '申請が見つかりません');
  if (row.consumed_at) fail(409, 'この申請はすでに使われました');
  if (row.expires_at < now()) return c.json({ status: 'expired' });
  if (!row.approved_at || !row.user_id) return c.json({ status: 'pending' });
  // 承認された：どのアカウントかを PC に見せ、PC で確かめてからログインする（他人のアカウントに入らされないように）
  const user = await getUser(row.user_id);
  if (!user || user.status !== 'active') fail(401, LOGIN_FAILED_MESSAGE);
  return c.json({ status: 'approved', account: { name: user.display_name, username: user.username } });
});

/** PC：承認したアカウントを確かめて、ログインする（一度だけ使える） */
authRoutes.post('/qr/finish', async (c) => {
  const input = await body(c, z.object({ id: z.string().max(64) }));
  const secret = c.req.header('x-login-secret') ?? '';
  const row = await get<LoginRequestRow>('SELECT * FROM login_requests WHERE id = ?', input.id);
  if (!row || !secret || row.secret_hash !== sha256(secret)) fail(404, '申請が見つかりません');
  if (row.expires_at < now()) fail(409, 'この申請は期限が切れました');
  if (!row.approved_at || !row.user_id) fail(409, 'まだ承認されていません');
  const res = await run('UPDATE login_requests SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', now(), row.id);
  if (!res.changes) fail(409, 'この申請はすでに使われました');
  const user = await getUser(row.user_id);
  if (!user || user.status !== 'active') {
    await audit(c, user ? { id: user.id, username: user.username } : null, 'auth.login_failed', user ? { type: 'user', id: user.id, name: user.username } : undefined, {
      reason: user ? `user_${user.status}` : 'unknown_user',
      method: 'qr',
    });
    fail(401, LOGIN_FAILED_MESSAGE);
  }
  await createSession(c, user.id);
  await audit(c, { id: user.id, username: user.username }, 'auth.login', { type: 'user', id: user.id, name: user.username }, { method: 'qr' });
  return c.json({ user: publicUser(user) });
});

/** スマホ：承認する前に、申請の内容（どの端末からか）を確かめる */
authRoutes.get('/qr/info', async (c) => {
  if (!c.get('user')) fail(401, 'ログインしてください');
  const row = await get<LoginRequestRow>('SELECT * FROM login_requests WHERE id = ?', c.req.query('id') ?? '');
  if (!row) fail(404, '申請が見つかりません。PC の画面の QR コードを読み直してください');
  return c.json({ ua: row.ua, ip: row.ip, place: row.place, createdAt: row.created_at, expired: row.expires_at < now() || !!row.consumed_at, approved: !!row.approved_at });
});

/** スマホ：PC に出ているコードを入力し、パスキーで本人確認をして承認する */
authRoutes.post('/qr/approve', async (c) => {
  const me = c.get('user');
  if (!me) fail(401, 'ログインしてください');
  const input = await body(c, z.object({ id: z.string().max(64), code: z.string().max(10), challengeId: z.string(), response: z.any() }));
  const row = await get<LoginRequestRow>('SELECT * FROM login_requests WHERE id = ?', input.id);
  if (!row) fail(404, '申請が見つかりません');
  if (row.expires_at < now() || row.consumed_at) fail(409, 'この申請は期限が切れました。PC でもう一度 QR コードを出してください');
  if (row.approved_at) fail(409, 'この申請はすでに承認されています');
  // 試行回数は先に数える（同時にたくさん送っても 5 回までしか試せない）
  const tried = await run('UPDATE login_requests SET attempts = attempts + 1 WHERE id = ? AND attempts < 5', row.id);
  if (!tried.changes) fail(429, 'コードの入力に何度も失敗したため、この申請は使えません。PC でもう一度 QR コードを出してください');
  if (!sameCode(input.code.replace(/\s/g, ''), row.code)) fail(400, 'コードが違います。PC の画面に出ている 6 桁のコードを入力してください');
  if (!input.response || typeof input.response.id !== 'string') fail(400, '不正なリクエストです');
  // パスキーで本人確認（ログインしている本人のパスキーであること）。理由は監査ログにだけ残す
  const result = await finishLogin(input.challengeId, input.response);
  if (!result.ok || result.user.id !== me.id) {
    await audit(c, { id: me.id, username: me.username }, 'auth.qr_approve_failed', { type: 'user', id: me.id, name: me.username }, {
      reason: result.ok ? 'other_user' : result.reason,
    });
    fail(401, LOGIN_FAILED_MESSAGE);
  }
  const res = await run('UPDATE login_requests SET user_id = ?, approved_at = ? WHERE id = ? AND approved_at IS NULL', me.id, now(), row.id);
  if (!res.changes) fail(409, 'この申請はすでに承認されています');
  await audit(c, { id: me.id, username: me.username }, 'auth.qr_approve', { type: 'user', id: me.id, name: me.username });
  return c.json({ ok: true });
});
