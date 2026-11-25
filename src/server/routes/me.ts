import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { all, get, run, type SqlValue } from '../db.ts';
import { deleteFile } from './files.ts';
import { me, requireAuth, type AppEnv } from '../session.ts';
import { getUser, publicUser } from '../users.ts';
import { body, fail, now } from '../util.ts';
import { finishRegistration, publicCredential, startRegistration, type CredentialRow } from '../webauthn.ts';

export const meRoutes = new Hono<AppEnv>();
meRoutes.use('*', requireAuth);

meRoutes.get('/', async (c) => c.json({ user: publicUser((await getUser(me(c).id))!) }));

const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** プロフィール（表示名・アイコン・テーマ）の更新。指定した項目だけ変更する */
meRoutes.patch('/', async (c) => {
  const u = me(c);
  const input = await body(
    c,
    z.object({
      displayName: z.string().trim().min(1).max(64).optional(),
      // 画像アイコン：/api/files にアップロード済みのファイルID（null で解除）
      avatarFileId: z.string().uuid().nullable().optional(),
      avatarEmoji: z.string().trim().min(1).max(64).nullable().optional(),
      avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
      theme: z.enum(['system', 'light', 'dark']).optional(),
    }),
  );
  const current = (await getUser(u.id))!;
  const sets: string[] = [];
  const params: SqlValue[] = [];
  const set = (col: string, v: SqlValue) => {
    sets.push(`${col} = ?`);
    params.push(v);
  };

  if (input.displayName !== undefined) set('display_name', input.displayName);
  if (input.theme !== undefined) set('theme', input.theme);
  if (input.avatarColor !== undefined) set('avatar_color', input.avatarColor);
  if (input.avatarEmoji !== undefined) {
    set('avatar_emoji', input.avatarEmoji);
    // 絵文字を選んだら画像アイコンは外す
    if (input.avatarEmoji && input.avatarFileId === undefined) set('avatar_file_id', null);
  }
  if (input.avatarFileId !== undefined) {
    if (input.avatarFileId) {
      const file = await get<{ owner_id: string | null; mime: string }>('SELECT owner_id, mime FROM files WHERE id = ?', input.avatarFileId);
      if (!file || file.owner_id !== u.id) fail(400, 'アイコン画像が見つかりません');
      if (!AVATAR_TYPES.has(file.mime)) fail(400, 'アイコンには PNG / JPEG / WebP / GIF 画像を指定してください');
      if (input.avatarEmoji === undefined) set('avatar_emoji', null);
    }
    set('avatar_file_id', input.avatarFileId);
  }
  if (sets.length === 0) return c.json({ user: publicUser(current) });

  await run(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...params, now(), u.id);

  // 差し替え前の画像アイコンは不要になるので削除する
  if (input.avatarFileId !== undefined || input.avatarEmoji) {
    const updated = (await getUser(u.id))!;
    if (current.avatar_file_id && current.avatar_file_id !== updated.avatar_file_id) {
      await deleteFile(current.avatar_file_id);
    }
  }
  return c.json({ user: publicUser((await getUser(u.id))!) });
});

// ---- パスキー管理 ----

meRoutes.get('/passkeys', async (c) => {
  const rows = await all<CredentialRow>('SELECT * FROM credentials WHERE user_id = ? ORDER BY created_at', me(c).id);
  return c.json({ passkeys: rows.map(publicCredential) });
});

/** パスキーの追加は、少し前にログインした（本人が操作している）ときだけ。開いたままの端末で勝手に足されないように */
const FRESH_LOGIN = 15 * 60_000;
async function requireFreshLogin(c: Context<AppEnv>) {
  const row = await get<{ created_at: number }>('SELECT created_at FROM sessions WHERE id = ?', c.get('sessionId') ?? '');
  if (!row || now() - row.created_at > FRESH_LOGIN) fail(403, 'セキュリティのため、パスキーを追加する前にもう一度ログインしてください');
}

meRoutes.post('/passkeys/options', async (c) => {
  await requireFreshLogin(c);
  const user = (await getUser(me(c).id))!;
  return c.json(await startRegistration(user));
});

meRoutes.post('/passkeys/verify', async (c) => {
  await requireFreshLogin(c);
  const user = (await getUser(me(c).id))!;
  const input = await body(c, z.object({ challengeId: z.string(), name: z.string().max(64).default(''), response: z.any() }));
  const credentialId = await finishRegistration({ user, challengeId: input.challengeId, response: input.response, name: input.name });
  await audit(c, { id: user.id, username: user.username }, 'passkey.add', { type: 'user', id: user.id, name: user.username }, { credentialId });
  return c.json({ ok: true });
});

meRoutes.patch('/passkeys/:id', async (c) => {
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(64) }));
  const r = await run('UPDATE credentials SET name = ? WHERE id = ? AND user_id = ?', input.name, c.req.param('id'), me(c).id);
  if (r.changes === 0) fail(404, 'パスキーが見つかりません');
  return c.json({ ok: true });
});

meRoutes.delete('/passkeys/:id', async (c) => {
  const u = me(c);
  const count = (await get<{ n: number }>('SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?', u.id))!.n;
  if (count <= 1) fail(400, '最後のパスキーは削除できません。先に別のパスキーを追加してください');
  const r = await run('DELETE FROM credentials WHERE id = ? AND user_id = ?', c.req.param('id'), u.id);
  if (r.changes === 0) fail(404, 'パスキーが見つかりません');
  await audit(c, { id: u.id, username: u.username }, 'passkey.delete', { type: 'user', id: u.id, name: u.username }, { credentialId: c.req.param('id') });
  return c.json({ ok: true });
});

// ---- セッション管理 ----

meRoutes.get('/sessions', async (c) => {
  const rows = await all<{ id: string; created_at: number; last_seen_at: number; ip: string; user_agent: string }>(
    'SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC',
    me(c).id,
    now(),
  );
  const current = c.get('sessionId');
  return c.json({
    sessions: rows.map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      ip: s.ip,
      userAgent: s.user_agent,
      current: s.id === current,
    })),
  });
});

meRoutes.delete('/sessions/:id', async (c) => {
  await run('DELETE FROM sessions WHERE id = ? AND user_id = ?', c.req.param('id'), me(c).id);
  return c.json({ ok: true });
});

meRoutes.post('/sessions/revoke-others', async (c) => {
  await run('DELETE FROM sessions WHERE user_id = ? AND id != ?', me(c).id, c.get('sessionId') ?? '');
  return c.json({ ok: true });
});
