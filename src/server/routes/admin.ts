import { Hono } from 'hono';
import { z } from 'zod';
import { audit, auditStmt, auditStmtAsync } from '../audit.ts';
import { encryptionEnabled } from '../crypto.ts';
import { encryptExistingData, encryptionBacklog } from '../maintenance.ts';
import { cfg } from '../config.ts';
import { all, batch, get, run, sql, type Stmt } from '../db.ts';
import { me, requireAdmin, type AppEnv } from '../session.ts';
import { getSettings, updateSettings } from '../settings.ts';
import {
  countActiveAdmins,
  createUserStmt,
  getUser,
  issueRegistrationLink,
  publicUser,
  registrationLinkStmts,
  USERNAME_RE,
  membershipStmts,
  type UserRow,
} from '../users.ts';
import { body, escapeLike, fail, now } from '../util.ts';
import { runtime } from '../runtime.ts';
import { publicCredential, type CredentialRow } from '../webauthn.ts';
import { deleteFile } from './files.ts';
import { publicWorkspace, type WorkspaceRow } from './workspaces.ts';
import { setShare } from './pages.ts';
import { accessMap } from '../permissions.ts';
import { backupDatabase, BACKUP_NAME_RE } from '../backup.ts';

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use('*', requireAdmin);

const actor = (c: Parameters<typeof me>[0]) => {
  const u = me(c);
  return { id: u.id, username: u.username };
};

async function requireUser(id: string) {
  const user = await getUser(id);
  if (!user) fail(404, 'ユーザーが見つかりません');
  return user;
}

// ---- システム情報 ----

adminRoutes.get('/system', async (c) => {
  // データベースのスキーマ（適用済みマイグレーション）
  let schema = '不明';
  try {
    const last = await get<{ name: string }>('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1');
    if (last) schema = last.name.replace(/\.sql$/, '');
  } catch {
    const v = await get<{ user_version: number }>('PRAGMA user_version').catch(() => undefined);
    if (v) schema = `マイグレーション ${v.user_version} 件適用済み`;
  }
  return c.json({
    runtime: runtime().name,
    schema,
    origin: cfg.ORIGIN,
    rpId: cfg.RP_ID,
    encryption: { enabled: encryptionEnabled(), remaining: encryptionEnabled() ? await encryptionBacklog() : null },
  });
});

/** 暗号化前に保存されたデータを、今すぐ暗号化する */
adminRoutes.post('/system/encrypt', async (c) => {
  if (!encryptionEnabled()) fail(400, '暗号化の鍵（DATA_KEY）が設定されていません');
  const done = await encryptExistingData(500);
  return c.json({ done, remaining: await encryptionBacklog() });
});

// ---- データベースのバックアップ ----

adminRoutes.get('/backups', async (c) => {
  const store = runtime().backups;
  if (!store) return c.json({ available: false, encrypted: encryptionEnabled(), backups: [] });
  const list = (await store.list()).filter((b) => BACKUP_NAME_RE.test(b.name)).sort((a, b) => b.name.localeCompare(a.name));
  return c.json({ available: true, encrypted: encryptionEnabled(), backups: list });
});

adminRoutes.post('/backups', async (c) => {
  const u = me(c);
  const store = runtime().backups;
  if (!store) fail(501, 'この環境ではバックアップを利用できません');
  const r = await backupDatabase(store);
  await audit(c, { id: u.id, username: u.username }, 'backup.create', { type: 'system', id: r.name }, { size: r.size, rows: r.rows });
  return c.json(r);
});

adminRoutes.get('/backups/:name', async (c) => {
  const u = me(c);
  const name = c.req.param('name');
  if (!BACKUP_NAME_RE.test(name)) fail(400, 'ファイル名が正しくありません');
  const store = runtime().backups;
  const body = store ? await store.get(name) : null;
  if (!body) fail(404, 'バックアップが見つかりません');
  await audit(c, { id: u.id, username: u.username }, 'backup.download', { type: 'system', id: name });
  return new Response(body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  });
});

// ---- ダッシュボード ----

adminRoutes.get('/stats', async (c) => {
  const t = now();
  const n = async (q: string, ...p: (string | number)[]) => (await get<{ n: number }>(q, ...p))!.n;
  const [
    total, active, pending, disabled, admins,
    pagesTotal, pagesWs, pagesPriv, trashed,
    passkeys, activeSessions, pendingLinks, files, bytes, logins24h, failed24h, recent,
  ] = await Promise.all([
    n('SELECT COUNT(*) AS n FROM users'),
    n(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`),
    n(`SELECT COUNT(*) AS n FROM users WHERE status = 'pending'`),
    n(`SELECT COUNT(*) AS n FROM users WHERE status = 'disabled'`),
    n(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`),
    n('SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL'),
    n(`SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL AND visibility = 'workspace'`),
    n(`SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL AND visibility = 'private'`),
    n('SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NOT NULL'),
    n('SELECT COUNT(*) AS n FROM credentials'),
    n('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', t),
    n('SELECT COUNT(*) AS n FROM registration_tokens WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ?', t),
    n('SELECT COUNT(*) AS n FROM files'),
    n('SELECT COALESCE(SUM(size), 0) AS n FROM files'),
    n(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'auth.login' AND at > ?`, t - 86400_000),
    n(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'auth.login_failed' AND at > ?`, t - 86400_000),
    all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 10'),
  ]);
  return c.json({
    users: { total, active, pending, disabled, admins },
    pages: { total: pagesTotal, workspace: pagesWs, private: pagesPriv, trashed },
    passkeys,
    activeSessions,
    pendingLinks,
    storage: { files, bytes },
    logins24h,
    failedLogins24h: failed24h,
    recent,
  });
});

// ---- ユーザー管理 ----

adminRoutes.get('/users', async (c) => {
  const t = now();
  const rows = await all<UserRow & { passkeys: number; sessions: number; pages: number; pending_link: number }>(
    `SELECT u.*,
       (SELECT COUNT(*) FROM credentials WHERE user_id = u.id) AS passkeys,
       (SELECT COUNT(*) FROM sessions WHERE user_id = u.id AND expires_at > ?) AS sessions,
       (SELECT COUNT(*) FROM pages WHERE owner_id = u.id AND deleted_at IS NULL) AS pages,
       (SELECT COUNT(*) FROM registration_tokens WHERE user_id = u.id AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?) AS pending_link
     FROM users u ORDER BY u.created_at`,
    t,
    t,
  );
  return c.json({
    users: rows.map((u) => ({
      ...publicUser(u),
      passkeys: u.passkeys,
      sessions: u.sessions,
      pages: u.pages,
      hasPendingLink: u.pending_link > 0,
    })),
  });
});

adminRoutes.post('/users', async (c) => {
  const input = await body(
    c,
    z.object({
      username: z.string().trim(),
      displayName: z.string().trim().min(1).max(64),
      role: z.enum(['admin', 'member']).default('member'),
      expiryHours: z.number().int().min(1).max(24 * 30).optional(),
      // 参加させるワークスペース（未指定なら最初のワークスペース）
      workspaceIds: z.array(z.string()).max(100).optional(),
    }),
  );
  const { user, stmt } = await createUserStmt(input);
  const { stmts, link } = await registrationLinkStmts(user.id, 'invite', me(c).id, input.expiryHours);
  const workspaceIds = input.workspaceIds ?? ['default'];
  await batch([
    stmt,
    ...membershipStmts(user.id, workspaceIds, 'member'),
    ...stmts,
    auditStmt(c, actor(c), 'user.create', { type: 'user', id: user.id, name: user.username }, { role: input.role }),
  ]);
  return c.json({ user: publicUser(user), link }, 201);
});

adminRoutes.get('/users/:id', async (c) => {
  const user = await requireUser(c.req.param('id'));
  const t = now();
  const [passkeys, sessions, links, pages, activity] = await Promise.all([
    all<CredentialRow>('SELECT * FROM credentials WHERE user_id = ? ORDER BY created_at', user.id),
    all<{ id: string; created_at: number; last_seen_at: number; ip: string; user_agent: string; expires_at: number }>(
      'SELECT id, created_at, last_seen_at, ip, user_agent, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC',
      user.id,
      t,
    ),
    all<{ id: string; purpose: string; created_at: number; expires_at: number; used_at: number | null; revoked_at: number | null; created_by_name: string | null }>(
      `SELECT r.id, r.purpose, r.created_at, r.expires_at, r.used_at, r.revoked_at, u.display_name AS created_by_name
       FROM registration_tokens r LEFT JOIN users u ON u.id = r.created_by
       WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 20`,
      user.id,
    ),
    get<{ n: number }>('SELECT COUNT(*) AS n FROM pages WHERE owner_id = ? AND deleted_at IS NULL', user.id),
    all(
      `SELECT * FROM audit_logs WHERE actor_id = ? OR (target_type = 'user' AND target_id = ?) ORDER BY id DESC LIMIT 30`,
      user.id,
      user.id,
    ),
  ]);
  return c.json({
    user: { ...publicUser(user), updatedAt: user.updated_at },
    pages: pages!.n,
    passkeys: passkeys.map(publicCredential),
    sessions: sessions.map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
      ip: s.ip,
      userAgent: s.user_agent,
    })),
    links: links.map((l) => ({
      id: l.id,
      purpose: l.purpose,
      createdAt: l.created_at,
      expiresAt: l.expires_at,
      usedAt: l.used_at,
      revokedAt: l.revoked_at,
      createdBy: l.created_by_name,
      state: l.used_at ? 'used' : l.revoked_at ? 'revoked' : l.expires_at < t ? 'expired' : 'active',
    })),
    activity,
  });
});

adminRoutes.patch('/users/:id', async (c) => {
  const self = me(c);
  const user = await requireUser(c.req.param('id'));
  const input = await body(
    c,
    z.object({
      displayName: z.string().trim().min(1).max(64).optional(),
      // ユーザー名（ユーザーID）。ログインはパスキーの内部IDで行うため、変更してもログインには影響しない
      username: z.string().trim().optional(),
      role: z.enum(['admin', 'member']).optional(),
      status: z.enum(['active', 'disabled']).optional(),
      // 不適切なアイコンを管理者が初期状態に戻す
      resetAvatar: z.literal(true).optional(),
      // 管理者がアイコンを設定する（画像は管理者がアップロードしたファイル）
      avatarFileId: z.string().uuid().nullable().optional(),
      avatarEmoji: z.string().trim().min(1).max(64).nullable().optional(),
      avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    }),
  );
  const demoting = input.role === 'member' && user.role === 'admin';
  const disabling = input.status === 'disabled' && user.status !== 'disabled';
  if ((demoting || disabling) && user.id === self.id) {
    fail(400, '自分自身の権限変更・無効化はできません');
  }
  if ((demoting || disabling) && user.role === 'admin' && (await countActiveAdmins(user.id)) === 0) {
    fail(400, '有効な管理者が一人もいなくなるため変更できません');
  }
  if (input.status === 'active' && user.status === 'pending') {
    fail(400, 'パスキー未登録のユーザーは有効化できません。登録リンクを発行してください');
  }
  if (input.username !== undefined && input.username !== user.username) {
    if (!USERNAME_RE.test(input.username)) fail(400, 'ユーザー名は英数字と . _ - の2〜32文字で、英数字から始めてください');
    const taken = await get('SELECT 1 FROM users WHERE username = ? AND id != ?', input.username, user.id);
    if (taken) fail(409, 'このユーザー名は既に使われています');
  }
  const t = now();
  const stmts: Stmt[] = [];
  if (input.username !== undefined && input.username !== user.username) {
    stmts.push(sql('UPDATE users SET username = ?, updated_at = ? WHERE id = ?', input.username, t, user.id));
  }
  if (input.displayName !== undefined) stmts.push(sql('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?', input.displayName, t, user.id));
  if (input.role !== undefined) stmts.push(sql('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', input.role, t, user.id));
  if (input.avatarFileId) {
    const file = await get<{ owner_id: string | null; mime: string }>('SELECT owner_id, mime FROM files WHERE id = ?', input.avatarFileId);
    if (!file || file.owner_id !== self.id) fail(400, 'アイコン画像が見つかりません');
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.mime)) fail(400, 'アイコンには PNG / JPEG / WebP / GIF 画像を指定してください');
  }
  if (input.avatarFileId !== undefined) {
    stmts.push(sql('UPDATE users SET avatar_file_id = ?, avatar_emoji = CASE WHEN ? IS NULL THEN avatar_emoji ELSE NULL END, updated_at = ? WHERE id = ?', input.avatarFileId, input.avatarFileId, t, user.id));
  }
  if (input.avatarEmoji !== undefined) {
    stmts.push(sql('UPDATE users SET avatar_emoji = ?, avatar_file_id = CASE WHEN ? IS NULL THEN avatar_file_id ELSE NULL END, updated_at = ? WHERE id = ?', input.avatarEmoji, input.avatarEmoji, t, user.id));
  }
  if (input.avatarColor !== undefined) stmts.push(sql('UPDATE users SET avatar_color = ?, updated_at = ? WHERE id = ?', input.avatarColor, t, user.id));
  if (input.resetAvatar) {
    stmts.push(sql('UPDATE users SET avatar_file_id = NULL, avatar_emoji = NULL, avatar_color = NULL, updated_at = ? WHERE id = ?', t, user.id));
  }
  if (input.status !== undefined && !(input.status === 'active' && user.status === 'active')) {
    stmts.push(sql('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', input.status, t, user.id));
    if (input.status === 'disabled') {
      stmts.push(sql('DELETE FROM sessions WHERE user_id = ?', user.id));
      stmts.push(sql('UPDATE registration_tokens SET revoked_at = ? WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL', t, user.id));
    }
  }
  stmts.push(auditStmt(c, actor(c), 'user.update', { type: 'user', id: user.id, name: input.username ?? user.username }, { ...input, ...(input.username && input.username !== user.username ? { previousUsername: user.username } : {}) }));
  await batch(stmts);
  // 差し替えで不要になった画像を削除する
  const after = (await getUser(user.id))!;
  if (user.avatar_file_id && user.avatar_file_id !== after.avatar_file_id) await deleteFile(user.avatar_file_id);
  return c.json({ user: publicUser((await getUser(user.id))!) });
});

adminRoutes.delete('/users/:id', async (c) => {
  const self = me(c);
  const user = await requireUser(c.req.param('id'));
  if (user.id === self.id) fail(400, '自分自身は削除できません');
  if (user.role === 'admin' && user.status === 'active' && (await countActiveAdmins(user.id)) === 0) {
    fail(400, '最後の管理者は削除できません');
  }
  // 共有ページは削除を実行した管理者に引き継ぎ、プライベートページは削除する
  const [transferred, deleted] = await batch([
    sql(`UPDATE pages SET owner_id = ? WHERE owner_id = ? AND visibility = 'workspace'`, self.id, user.id),
    sql(`DELETE FROM pages WHERE owner_id = ? AND visibility = 'private'`, user.id),
    sql('DELETE FROM users WHERE id = ?', user.id),
  ]);
  const stats = { transferredPages: transferred!.changes, deletedPrivatePages: deleted!.changes };
  await audit(c, actor(c), 'user.delete', { type: 'user', id: user.id, name: user.username }, stats);
  return c.json({ ok: true, ...stats });
});

/** パスキー登録リンク（初回招待 / 端末紛失時の復旧）を発行。既存の未使用リンクは無効化される */
adminRoutes.post('/users/:id/registration-links', async (c) => {
  const user = await requireUser(c.req.param('id'));
  const input = await body(c, z.object({ expiryHours: z.number().int().min(1).max(24 * 30).optional() }));
  if (user.status === 'disabled') fail(400, '無効化されたユーザーにはリンクを発行できません');
  const purpose = user.status === 'pending' ? 'invite' : 'recovery';
  const link = await issueRegistrationLink(user.id, purpose, me(c).id, input.expiryHours);
  await audit(c, actor(c), 'link.issue', { type: 'user', id: user.id, name: user.username }, { purpose, expiresAt: link.expiresAt });
  return c.json({ link }, 201);
});

adminRoutes.delete('/registration-links/:id', async (c) => {
  const row = await get<{ user_id: string }>('SELECT user_id FROM registration_tokens WHERE id = ?', c.req.param('id'));
  if (!row) fail(404, 'リンクが見つかりません');
  await run('UPDATE registration_tokens SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL', now(), c.req.param('id'));
  const user = await getUser(row.user_id);
  await audit(c, actor(c), 'link.revoke', { type: 'user', id: row.user_id, name: user?.username });
  return c.json({ ok: true });
});

adminRoutes.get('/registration-links', async (c) => {
  const rows = await all<{ id: string; purpose: string; created_at: number; expires_at: number; user_id: string; username: string; display_name: string; created_by_name: string | null }>(
    `SELECT r.id, r.purpose, r.created_at, r.expires_at, r.user_id, u.username, u.display_name, cb.display_name AS created_by_name
     FROM registration_tokens r JOIN users u ON u.id = r.user_id LEFT JOIN users cb ON cb.id = r.created_by
     WHERE r.used_at IS NULL AND r.revoked_at IS NULL AND r.expires_at > ? ORDER BY r.created_at DESC`,
    now(),
  );
  return c.json({
    links: rows.map((r) => ({
      id: r.id,
      purpose: r.purpose,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      userId: r.user_id,
      username: r.username,
      displayName: r.display_name,
      createdBy: r.created_by_name,
    })),
  });
});

adminRoutes.delete('/users/:id/passkeys/:credId', async (c) => {
  const user = await requireUser(c.req.param('id'));
  const r = await run('DELETE FROM credentials WHERE id = ? AND user_id = ?', c.req.param('credId'), user.id);
  if (r.changes === 0) fail(404, 'パスキーが見つかりません');
  // なくした端末などでログインしたままにならないよう、その人のログインをすべて切る
  await run('DELETE FROM sessions WHERE user_id = ?', user.id);
  await audit(c, actor(c), 'passkey.revoke', { type: 'user', id: user.id, name: user.username }, { credentialId: c.req.param('credId') });
  return c.json({ ok: true });
});

adminRoutes.delete('/users/:id/sessions', async (c) => {
  const user = await requireUser(c.req.param('id'));
  const r = await run('DELETE FROM sessions WHERE user_id = ? AND id != ?', user.id, c.get('sessionId') ?? '');
  await audit(c, actor(c), 'session.revoke_all', { type: 'user', id: user.id, name: user.username }, { count: r.changes });
  return c.json({ ok: true });
});

adminRoutes.delete('/sessions/:id', async (c) => {
  const row = await get<{ user_id: string }>('SELECT user_id FROM sessions WHERE id = ?', c.req.param('id'));
  if (!row) fail(404, 'セッションが見つかりません');
  await run('DELETE FROM sessions WHERE id = ?', c.req.param('id'));
  const user = await getUser(row.user_id);
  await audit(c, actor(c), 'session.revoke', { type: 'user', id: row.user_id, name: user?.username });
  return c.json({ ok: true });
});

// ---- ワークスペース ----

adminRoutes.get('/workspaces', async (c) => {
  const rows = await all<WorkspaceRow & { members: number; pages: number; owners: string | null }>(
    `SELECT w.*,
       (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = w.id) AS members,
       (SELECT COUNT(*) FROM pages WHERE workspace_id = w.id AND deleted_at IS NULL) AS pages,
       (SELECT group_concat(u.display_name, '、') FROM workspace_members m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = w.id AND m.role = 'owner') AS owners
     FROM workspaces w ORDER BY w.created_at`,
  );
  return c.json({ workspaces: rows.map((w) => publicWorkspace(w, { memberCount: w.members, pageCount: w.pages, owners: w.owners })) });
});

/** ユーザーの所属ワークスペース */
adminRoutes.get('/users/:id/workspaces', async (c) => {
  const user = await requireUser(c.req.param('id'));
  const rows = await all<WorkspaceRow & { role: string | null }>(
    `SELECT w.*, m.role FROM workspaces w
     LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ? ORDER BY w.created_at`,
    user.id,
  );
  return c.json({ workspaces: rows.map((w) => publicWorkspace(w, { role: w.role })) });
});

// ---- ユーザーが閲覧できるページ ----

/** 指定ユーザーの、ワークスペースごとのページ権限一覧（直接付与された権限と、継承を含む実際の権限） */
adminRoutes.get('/users/:id/page-access', async (c) => {
  const user = await requireUser(c.req.param('id'));
  const target = { id: user.id, username: user.username, display_name: user.display_name, role: user.role };
  // ゲストとしての共有もできるよう、すべてのワークスペースを対象にする（所属しているものを先に表示）
  const workspaces = await all<WorkspaceRow & { member_role: string | null }>(
    `SELECT w.*, m.role AS member_role FROM workspaces w
     LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?
     ORDER BY m.role IS NULL, w.created_at`,
    user.id,
  );
  const result = [];
  for (const w of workspaces) {
    const [pages, shares, access] = await Promise.all([
      all<{ id: string; parent_id: string | null; title: string; icon: string | null; visibility: string; workspace_access: string; owner_id: string }>(
        `SELECT id, parent_id, title, icon, visibility, workspace_access, owner_id FROM pages
         WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY position, created_at`,
        w.id,
      ),
      all<{ page_id: string; permission: string }>(
        'SELECT s.page_id, s.permission FROM page_shares s JOIN pages p ON p.id = s.page_id WHERE s.user_id = ? AND p.workspace_id = ?',
        user.id,
        w.id,
      ),
      accessMap(w.id, target, !!w.member_role, w.member_role === 'viewer', w.member_role === 'owner' || w.member_role === 'admin'),
    ]);
    const direct = new Map(shares.map((s) => [s.page_id, s.permission]));
    result.push({
      workspace: publicWorkspace(w, { role: w.member_role ?? 'guest' }),
      pages: pages.map((p) => ({
        id: p.id,
        parentId: p.parent_id,
        title: p.title,
        icon: p.icon,
        visibility: p.visibility,
        workspaceAccess: p.workspace_access,
        isOwner: p.owner_id === user.id,
        direct: direct.get(p.id) ?? null,
        effective: access.get(p.id) ?? 'none',
      })),
    });
  }
  return c.json({ isAdmin: user.role === 'admin', workspaces: result });
});

adminRoutes.put('/users/:id/page-access', async (c) => {
  const user = await requireUser(c.req.param('id'));
  const input = await body(c, z.object({ pageId: z.string(), permission: z.enum(['view', 'edit']).nullable() }));
  const page = await get<{ id: string; title: string; workspace_id: string }>('SELECT id, title, workspace_id FROM pages WHERE id = ?', input.pageId);
  if (!page) fail(404, 'ページが見つかりません');
  return c.json(await setShare(c, me(c), page, user.id, input.permission));
});

// ---- 外部公開中のページ ----

adminRoutes.get('/public-pages', async (c) => {
  const rows = await all<{ id: string; title: string; icon: string | null; public_slug: string; ws_slug: string | null; public_subpages: number; public_indexing: number; published_at: number | null; publisher: string | null; owner: string | null }>(
    `SELECT p.id, p.title, p.icon, p.public_slug, w.slug AS ws_slug, p.public_subpages, p.public_indexing, p.published_at,
            pu.display_name AS publisher, ou.display_name AS owner
     FROM pages p LEFT JOIN users pu ON pu.id = p.published_by LEFT JOIN users ou ON ou.id = p.owner_id
     LEFT JOIN workspaces w ON w.id = p.workspace_id
     WHERE p.public_enabled = 1 AND p.deleted_at IS NULL ORDER BY p.published_at DESC`,
  );
  return c.json({
    pages: rows.map((r) => ({
      id: r.id,
      title: r.title,
      icon: r.icon,
      url: `${cfg.ORIGIN}/${r.ws_slug}/${r.public_slug}`,
      subpages: !!r.public_subpages,
      indexing: !!r.public_indexing,
      publishedAt: r.published_at,
      publishedBy: r.publisher,
      owner: r.owner,
    })),
  });
});

adminRoutes.delete('/public-pages/:id', async (c) => {
  const page = await get<{ id: string; title: string }>('SELECT id, title FROM pages WHERE id = ? AND public_enabled = 1', c.req.param('id'));
  if (!page) fail(404, '公開中のページが見つかりません');
  await batch([
    sql('UPDATE pages SET public_enabled = 0 WHERE id = ?', page.id),
    await auditStmtAsync(c, actor(c), 'page.unpublish', { type: 'page', id: page.id, name: page.title || '無題' }, { byAdmin: true }),
  ]);
  return c.json({ ok: true });
});

// ---- 監査ログ ----

adminRoutes.get('/audit', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
  const before = Number(c.req.query('before') ?? 0) || Number.MAX_SAFE_INTEGER;
  const action = c.req.query('action') ?? '';
  const q = (c.req.query('q') ?? '').trim();
  const like = `%${escapeLike(q)}%`;
  const rows = await all<{ id: number }>(
    `SELECT * FROM audit_logs
     WHERE id < ?
       AND (? = '' OR action LIKE ? ESCAPE '\\')
       AND (? = '' OR actor_name LIKE ? ESCAPE '\\' OR target_name LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\')
     ORDER BY id DESC LIMIT ?`,
    before,
    action,
    `${escapeLike(action)}%`,
    q,
    like,
    like,
    like,
    limit + 1,
  );
  return c.json({ logs: rows.slice(0, limit), hasMore: rows.length > limit });
});

// ---- ワークスペース設定 ----

adminRoutes.get('/settings', async (c) => c.json({ settings: await getSettings() }));

adminRoutes.put('/settings', async (c) => {
  const input = await body(
    c,
    z.object({
      serviceName: z.string().trim().min(1).max(64).optional(),
      inviteExpiryHours: z.number().int().min(1).max(24 * 30).optional(),
      sessionDays: z.number().int().min(1).max(365).optional(),
      publishPolicy: z.enum(['everyone', 'admins', 'disabled']).optional(),
      workspaceCreation: z.enum(['everyone', 'admins']).optional(),
    }),
  );
  const settings = await updateSettings(input);
  // 外部公開を無効にしたら、公開中のページもすべて非公開にする
  if (input.publishPolicy === 'disabled') await run('UPDATE pages SET public_enabled = 0 WHERE public_enabled = 1');
  await audit(c, actor(c), 'settings.update', { type: 'settings' }, input);
  return c.json({ settings });
});
