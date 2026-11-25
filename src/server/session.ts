import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { cfg } from './config.ts';
import { batch, get, run, sql } from './db.ts';
import { getSettings } from './settings.ts';
import type { UserRow } from './users.ts';
import { clientIp, fail, newId, newToken, now, sha256 } from './util.ts';

export type SessionUser = Pick<UserRow, 'id' | 'username' | 'display_name' | 'role'>;

export type AppEnv = {
  Variables: {
    user: SessionUser | null;
    sessionId: string | null;
  };
};

export async function createSession(c: Context, userId: string) {
  const token = newToken();
  const t = now();
  const days = (await getSettings()).sessionDays;
  const expiresAt = t + days * 86400_000;
  const id = newId();
  await batch([
    sql(
      `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      sha256(token),
      t,
      expiresAt,
      t,
      clientIp(c),
      (c.req.header('user-agent') ?? '').slice(0, 300),
    ),
    sql('UPDATE users SET last_login_at = ? WHERE id = ?', t, userId),
  ]);
  setCookie(c, cfg.SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: cfg.SECURE_COOKIE,
    sameSite: 'Lax',
    maxAge: days * 86400,
  });
  return id;
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, cfg.SESSION_COOKIE, { path: '/', secure: cfg.SECURE_COOKIE });
}

export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null);
  c.set('sessionId', null);
  const token = getCookie(c, cfg.SESSION_COOKIE);
  if (token) {
    const row = await get<SessionUser & { session_id: string; expires_at: number; last_seen_at: number }>(
      `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, u.id, u.username, u.display_name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND u.status = 'active'`,
      sha256(token),
    );
    const t = now();
    if (row && row.expires_at > t) {
      c.set('user', { id: row.id, username: row.username, display_name: row.display_name, role: row.role });
      c.set('sessionId', row.session_id);
      if (t - row.last_seen_at > 5 * 60_000) {
        await run('UPDATE sessions SET last_seen_at = ?, ip = ? WHERE id = ?', t, clientIp(c), row.session_id);
      }
    } else {
      clearSessionCookie(c);
    }
  }
  await next();
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) fail(401, 'ログインが必要です');
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user) fail(401, 'ログインが必要です');
  if (user.role !== 'admin') fail(403, '管理者権限が必要です');
  await next();
};

export function me(c: Context<AppEnv>): SessionUser {
  const user = c.get('user');
  if (!user) fail(401, 'ログインが必要です');
  return user;
}
