import { cfg } from './config.ts';
import { batch, get, sql, type Stmt } from './db.ts';
import { getSettings } from './settings.ts';
import { fail, newId, newToken, now, sha256 } from './util.ts';

export type Role = 'admin' | 'member';
export type UserStatus = 'pending' | 'active' | 'disabled';

export type UserRow = {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  status: UserStatus;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
  avatar_file_id: string | null;
  avatar_emoji: string | null;
  avatar_color: string | null;
  theme: Theme;
};

export type Theme = 'system' | 'light' | 'dark';

export type TokenRow = {
  id: string;
  user_id: string;
  token_hash: string;
  purpose: 'invite' | 'recovery';
  created_by: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
};

export const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/;

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    status: u.status,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    avatarUrl: u.avatar_file_id ? `/api/files/${u.avatar_file_id}` : null,
    avatarEmoji: u.avatar_emoji,
    avatarColor: u.avatar_color,
    theme: u.theme ?? 'system',
  };
}

export function getUser(id: string) {
  return get<UserRow>('SELECT * FROM users WHERE id = ?', id);
}

export function getUserByUsername(username: string) {
  return get<UserRow>('SELECT * FROM users WHERE username = ?', username);
}

/** ユーザー作成の INSERT 文を作る（入力チェック込み） */
export async function createUserStmt(input: { username: string; displayName: string; role: Role }) {
  if (!USERNAME_RE.test(input.username)) {
    fail(400, 'ユーザー名は英数字と . _ - の2〜32文字で、英数字から始めてください');
  }
  if (await getUserByUsername(input.username)) fail(409, 'このユーザー名は既に使われています');
  const t = now();
  const user: UserRow = {
    id: newId(),
    username: input.username,
    display_name: input.displayName,
    role: input.role,
    status: 'pending',
    created_at: t,
    updated_at: t,
    last_login_at: null,
    avatar_file_id: null,
    avatar_emoji: null,
    avatar_color: null,
    theme: 'system',
  };
  const stmt = sql(
    `INSERT INTO users (id, username, display_name, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    user.id,
    user.username,
    user.display_name,
    user.role,
    t,
    t,
  );
  return { user, stmt };
}

/**
 * パスキー登録用リンクを作る。同じユーザーの未使用リンクは無効化される。
 * トークン本体はハッシュのみ保存するため、URLは発行時にしか取得できない。
 * 返り値の stmts を batch で実行すること。
 */
export async function registrationLinkStmts(
  userId: string,
  purpose: 'invite' | 'recovery',
  createdBy: string | null,
  expiryHours?: number,
) {
  const hours = expiryHours ?? (await getSettings()).inviteExpiryHours;
  const t = now();
  const token = newToken();
  const id = newId();
  const expiresAt = t + hours * 3600_000;
  const stmts: Stmt[] = [
    sql(
      'UPDATE registration_tokens SET revoked_at = ? WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL',
      t,
      userId,
    ),
    sql(
      `INSERT INTO registration_tokens (id, user_id, token_hash, purpose, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      sha256(token),
      purpose,
      createdBy,
      t,
      expiresAt,
    ),
  ];
  // トークンをフラグメントに入れることで、サーバーログやReferer経由での漏えいを防ぐ
  return { stmts, link: { id, url: `${cfg.ORIGIN}/register#token=${token}`, expiresAt, purpose } };
}

export async function issueRegistrationLink(
  userId: string,
  purpose: 'invite' | 'recovery',
  createdBy: string | null,
  expiryHours?: number,
) {
  const { stmts, link } = await registrationLinkStmts(userId, purpose, createdBy, expiryHours);
  await batch(stmts);
  return link;
}

export async function findValidToken(token: string) {
  const row = await get<TokenRow>('SELECT * FROM registration_tokens WHERE token_hash = ?', sha256(token));
  if (!row || row.used_at || row.revoked_at || row.expires_at < now()) return null;
  const user = await getUser(row.user_id);
  if (!user || user.status === 'disabled') return null;
  return { token: row, user };
}

/** ワークスペースへの参加文（存在しないワークスペースは無視される） */
export function membershipStmts(userId: string, workspaceIds: string[], role: 'owner' | 'member'): Stmt[] {
  const t = now();
  // オーナーは 1 人だけ：既にオーナーがいれば管理者として追加する
  return workspaceIds.map((wid) =>
    sql(
      `INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at)
       SELECT id, ?, CASE WHEN ? = 'owner' AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND role = 'owner') THEN 'admin' ELSE ? END, ?
       FROM workspaces WHERE id = ?`,
      userId,
      role,
      wid,
      role,
      t,
      wid,
    ),
  );
}

export async function countActiveAdmins(excludeUserId?: string) {
  return (await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id != ?`,
    excludeUserId ?? '',
  ))!.n;
}
