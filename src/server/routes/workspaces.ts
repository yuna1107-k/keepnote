import { Hono } from 'hono';
import { z } from 'zod';
import { audit, auditStmt } from '../audit.ts';
import { all, batch, get, run, sql, type SqlValue, type Stmt } from '../db.ts';
import { me, requireAuth, type AppEnv, type SessionUser } from '../session.ts';
import { cfg } from '../config.ts';
import { roomNamespace, workspaceRoomName } from '../liveWorkspace.ts';
import { publicUser, type UserRow } from '../users.ts';
import { body, fail, newId, now } from '../util.ts';
import { deleteFile } from './files.ts';

export type WorkspaceRow = {
  id: string;
  name: string;
  icon_emoji: string | null;
  icon_file_id: string | null;
  icon_color: string | null;
  slug: string | null;
  /** 「プライベート」のページを使うか（1 のときだけ使える） */
  private_pages: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
};

export type WsRole = 'owner' | 'admin' | 'member' | 'viewer';
/** ゲスト：メンバーではないが、ワークスペース内の一部のページを共有されている */
export type AccessRole = WsRole | 'guest';

export function publicWorkspace(w: WorkspaceRow, extra: Record<string, unknown> = {}) {
  return {
    id: w.id,
    name: w.name,
    iconEmoji: w.icon_emoji,
    iconUrl: w.icon_file_id ? `/api/files/${w.icon_file_id}` : null,
    iconColor: w.icon_color,
    slug: w.slug ?? w.id,
    privatePages: !!w.private_pages,
    createdAt: w.created_at,
    ...extra,
  };
}

/** URL で使えない（アプリの画面と重なる）名前 */
export const RESERVED_SLUGS = new Set(['login', 'register', 'admin', 'settings', 'workspace', 'workspaces', 'help', 'share-received', 'share-target', 'new', 'p', 'share', 'api', 'tasks', 'graph', 'approve-login', 'templates', 'import', 'covers', 'og.png', 'app-idle', '.well-known', 'assets', 'fonts', 'icons', 'pdfjs', 'sw.js', 'manifest.webmanifest', 'favicon.svg', 'robots.txt']);
export const WS_SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

/** 名前から URL 名を作る（英数字でなければランダム）。重複していれば番号を付ける */
async function uniqueSlug(base: string) {
  let slug = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!WS_SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) slug = 'ws-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  let candidate = slug;
  for (let i = 2; await get('SELECT 1 FROM workspaces WHERE slug = ?', candidate); i++) candidate = `${slug}-${i}`;
  return candidate;
}

export async function membership(workspaceId: string, userId: string) {
  return (await get<{ role: WsRole }>('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?', workspaceId, userId))?.role ?? null;
}

export async function isGuest(workspaceId: string, userId: string) {
  return !!(await get(
    `SELECT 1 FROM page_shares s JOIN pages p ON p.id = s.page_id WHERE s.user_id = ? AND p.workspace_id = ?
     UNION ALL
     SELECT 1 FROM page_group_shares g JOIN user_group_members m ON m.group_id = g.group_id JOIN pages p ON p.id = g.page_id
     WHERE m.user_id = ? AND p.workspace_id = ? LIMIT 1`,
    userId,
    workspaceId,
    userId,
    workspaceId,
  ));
}

/** ワークスペースのメンバー、またはページを共有されたゲストであることを確認する */
export async function requireMember(workspaceId: string, user: SessionUser): Promise<{ ws: WorkspaceRow; role: AccessRole }> {
  const ws = await get<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', workspaceId);
  if (!ws) fail(404, 'ワークスペースが見つかりません');
  const role = await membership(workspaceId, user.id);
  if (role) return { ws, role };
  if (await isGuest(workspaceId, user.id)) return { ws, role: 'guest' };
  fail(403, 'このワークスペースのメンバーではありません');
}

/** ページを作成・削除できるか（閲覧者は不可。管理者は常に可） */
export async function requireContributor(workspaceId: string, user: SessionUser) {
  const r = await requireMember(workspaceId, user);
  if (r.role === 'guest') fail(403, 'ゲストはワークスペースにページを作成できません');
  if (r.role === 'viewer' && user.role !== 'admin') fail(403, 'このワークスペースでは閲覧のみ許可されています');
  return r;
}

/** オーナー（またはサーバー管理者）であることを確認する */
/** オーナー・ワークスペース管理者（またはサーバー管理者）であることを確認する */
export async function requireManager(workspaceId: string, user: SessionUser) {
  const ws = await get<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', workspaceId);
  if (!ws) fail(404, 'ワークスペースが見つかりません');
  const role = await membership(workspaceId, user.id);
  if (role !== 'owner' && role !== 'admin' && user.role !== 'admin') fail(403, 'この操作はワークスペースのオーナーまたは管理者のみ行えます');
  return { ws, role };
}

/** サーバー管理者が、オーナー・ワークスペース管理者としてではなく操作したときに監査ログへ残す印 */
function viaServerAdmin(role: WsRole | null) {
  return role === 'owner' || role === 'admin' ? {} : { byServerAdmin: true };
}

/** オーナー本人（またはサーバー管理者）であることを確認する */
async function requireOwner(workspaceId: string, user: SessionUser) {
  const ws = await get<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', workspaceId);
  if (!ws) fail(404, 'ワークスペースが見つかりません');
  const role = await membership(workspaceId, user.id);
  if (role !== 'owner' && user.role !== 'admin') fail(403, 'この操作はワークスペースのオーナーのみ行えます');
  return { ws, role };
}

/** ワークスペースの作成は管理者のみ（管理者画面から行う） */
export async function canCreateWorkspace(user: SessionUser) {
  return user.role === 'admin';
}

const iconSchema = {
  iconEmoji: z.string().trim().min(1).max(64).nullable().optional(),
  iconFileId: z.string().uuid().nullable().optional(),
  iconColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
};

export const workspacesRoutes = new Hono<AppEnv>();
workspacesRoutes.use('*', requireAuth);

/** ページが変わったお知らせを受け取る接続（WebSocket。liveWorkspace.ts）。メンバーだけ */
workspacesRoutes.get('/:id/live', async (c) => {
  const u = me(c);
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') fail(426, 'WebSocket で接続してください');
  // 他サイトからの WebSocket 接続（クッキーの悪用）を防ぐ
  if (c.req.header('origin') !== cfg.ORIGIN) fail(403, '不正なリクエスト元です');
  const id = c.req.param('id');
  if (!(await membership(id, u.id))) fail(403, 'このワークスペースのメンバーではありません');
  const ns = roomNamespace(c);
  if (!ns) fail(501, 'この環境ではお知らせを受け取れません');
  const headers = new Headers(c.req.raw.headers);
  // サーバーの中からだけ使うお知らせのヘッダーは、外から送られても捨てる。受け取るだけなので編集はしない
  headers.delete('x-room-signal');
  headers.set('x-collab-user', u.id);
  headers.set('x-collab-edit', '0');
  headers.set('x-collab-name', encodeURIComponent(u.display_name));
  return ns.get(ns.idFromName(workspaceRoomName(id))).fetch(new Request(c.req.raw.url, { headers }));
});

workspacesRoutes.get('/', async (c) => {
  const u = me(c);
  // 所属するワークスペースと、ゲストとしてページを共有されているワークスペース
  const rows = await all<WorkspaceRow & { role: AccessRole; members: number }>(
    `SELECT w.*, COALESCE(m.role, 'guest') AS role, (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = w.id) AS members
     FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?
     WHERE m.user_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM page_shares s JOIN pages p ON p.id = s.page_id WHERE s.user_id = ? AND p.workspace_id = w.id)
        OR EXISTS (SELECT 1 FROM page_group_shares g JOIN user_group_members gm ON gm.group_id = g.group_id
                   JOIN pages p ON p.id = g.page_id WHERE gm.user_id = ? AND p.workspace_id = w.id)
     ORDER BY m.user_id IS NULL, w.created_at`,
    u.id,
    u.id,
    u.id,
  );
  return c.json({
    workspaces: rows.map((w) => publicWorkspace(w, { role: w.role, memberCount: w.members })),
    canCreate: await canCreateWorkspace(u),
  });
});

workspacesRoutes.post('/', async (c) => {
  const u = me(c);
  if (!(await canCreateWorkspace(u))) fail(403, 'ワークスペースを作成できるのは管理者のみです');
  const input = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(64),
      iconEmoji: iconSchema.iconEmoji,
      iconColor: iconSchema.iconColor,
      // オーナー（省略時は作成した管理者）と、最初から参加させるメンバー
      ownerId: z.string().optional(),
      memberIds: z.array(z.string()).max(200).optional(),
      viewerIds: z.array(z.string()).max(200).optional(),
      adminIds: z.array(z.string()).max(200).optional(),
    }),
  );
  const id = newId();
  const t = now();
  await batch([
    sql(
      'INSERT INTO workspaces (id, name, slug, icon_emoji, icon_color, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      input.name,
      await uniqueSlug(input.name),
      input.iconEmoji ?? null,
      input.iconColor ?? null,
      u.id,
      t,
      t,
    ),
    sql(
      `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) SELECT ?, id, 'owner', ? FROM users WHERE id = ?`,
      id,
      t,
      input.ownerId ?? u.id,
    ),
    ...[
      ...(input.adminIds ?? []).map((m) => [m, 'admin'] as const),
      ...(input.memberIds ?? []).map((m) => [m, 'member'] as const),
      ...(input.viewerIds ?? []).map((m) => [m, 'viewer'] as const),
    ].filter(([m]) => m !== (input.ownerId ?? u.id)).map(([m, role]) =>
      sql(
        `INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at) SELECT ?, id, ?, ? FROM users WHERE id = ? AND status != 'disabled'`,
        id,
        role,
        t,
        m,
      ),
    ),
    auditStmt(c, { id: u.id, username: u.username }, 'workspace.create', { type: 'workspace', id, name: input.name }),
  ]);
  const ws = (await get<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', id))!;
  return c.json({ workspace: publicWorkspace(ws, { role: await membership(id, u.id) }) }, 201);
});

workspacesRoutes.get('/:id', async (c) => {
  const u = me(c);
  const id = c.req.param('id');
  const ws = await get<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', id);
  if (!ws) fail(404, 'ワークスペースが見つかりません');
  const role = await membership(id, u.id);
  if (!role && u.role !== 'admin') fail(403, 'このワークスペースのメンバーではありません');
  const members = await all<UserRow & { ws_role: WsRole; joined_at: number }>(
    `SELECT u.*, m.role AS ws_role, m.joined_at FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ? ORDER BY m.role DESC, m.joined_at`,
    id,
  );
  const pages = (await get<{ n: number }>('SELECT COUNT(*) AS n FROM pages WHERE workspace_id = ? AND deleted_at IS NULL', id))!.n;
  return c.json({
    workspace: publicWorkspace(ws, { role, pageCount: pages }),
    canManage: role === 'owner' || role === 'admin' || u.role === 'admin',
    isOwner: role === 'owner' || u.role === 'admin',
    members: members.map((m) => ({ ...publicUser(m), wsRole: m.ws_role, joinedAt: m.joined_at })),
  });
});

workspacesRoutes.patch('/:id', async (c) => {
  const u = me(c);
  const { ws, role } = await requireManager(c.req.param('id'), u);
  const input = await body(
    c,
    z.object({ name: z.string().trim().min(1).max(64).optional(), slug: z.string().trim().toLowerCase().optional(), privatePages: z.boolean().optional(), ...iconSchema }),
  );
  const sets: string[] = [];
  const params: SqlValue[] = [];
  const set = (col: string, v: SqlValue) => {
    sets.push(`${col} = ?`);
    params.push(v);
  };
  if (input.name !== undefined) set('name', input.name);
  if (input.slug !== undefined && input.slug !== ws.slug) {
    if (!WS_SLUG_RE.test(input.slug)) fail(400, 'URL 名は英小文字・数字・ハイフン・アンダースコアの2〜40文字で、英数字から始めてください');
    if (RESERVED_SLUGS.has(input.slug)) fail(400, 'この URL 名は使えません');
    if (await get('SELECT 1 FROM workspaces WHERE slug = ? AND id != ?', input.slug, ws.id)) fail(409, 'この URL 名は既に使われています');
    set('slug', input.slug);
  }
  if (input.privatePages !== undefined) set('private_pages', input.privatePages ? 1 : 0);
  if (input.iconColor !== undefined) set('icon_color', input.iconColor);
  if (input.iconEmoji !== undefined) {
    set('icon_emoji', input.iconEmoji);
    if (input.iconEmoji && input.iconFileId === undefined) set('icon_file_id', null);
  }
  if (input.iconFileId !== undefined) {
    if (input.iconFileId) {
      const file = await get<{ owner_id: string | null; mime: string }>('SELECT owner_id, mime FROM files WHERE id = ?', input.iconFileId);
      if (!file || file.owner_id !== u.id) fail(400, 'アイコン画像が見つかりません');
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.mime)) fail(400, 'アイコンには PNG / JPEG / WebP / GIF 画像を指定してください');
      if (input.iconEmoji === undefined) set('icon_emoji', null);
    }
    set('icon_file_id', input.iconFileId);
  }
  if (sets.length) {
    await batch([
      sql(`UPDATE workspaces SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...params, now(), ws.id),
      auditStmt(c, { id: u.id, username: u.username }, 'workspace.update', { type: 'workspace', id: ws.id, name: input.name ?? ws.name }, {
        name: input.name,
        slug: input.slug !== undefined && input.slug !== ws.slug ? input.slug : undefined,
        privatePages: input.privatePages,
        icon: input.iconEmoji !== undefined || input.iconFileId !== undefined || input.iconColor !== undefined ? true : undefined,
        ...viaServerAdmin(role),
      }),
    ]);
    const updated = (await get<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', ws.id))!;
    if (ws.icon_file_id && ws.icon_file_id !== updated.icon_file_id) await deleteFile(ws.icon_file_id);
  }
  const updated = (await get<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', ws.id))!;
  return c.json({ workspace: publicWorkspace(updated, { role: await membership(ws.id, u.id) }) });
});

workspacesRoutes.delete('/:id', async (c) => {
  const u = me(c);
  const { ws } = await requireOwner(c.req.param('id'), u);
  const pages = await run('DELETE FROM pages WHERE workspace_id = ?', ws.id);
  await batch([
    sql('DELETE FROM workspaces WHERE id = ?', ws.id),
    auditStmt(c, { id: u.id, username: u.username }, 'workspace.delete', { type: 'workspace', id: ws.id, name: ws.name }, { deletedPages: pages.changes }),
  ]);
  if (ws.icon_file_id) await deleteFile(ws.icon_file_id);
  return c.json({ ok: true });
});

// ---- メンバー管理 ----

/** 追加できるユーザー（有効なユーザーのうち未参加の人） */
workspacesRoutes.get('/:id/candidates', async (c) => {
  const u = me(c);
  const { ws } = await requireManager(c.req.param('id'), u);
  const rows = await all<UserRow>(
    `SELECT * FROM users WHERE status != 'disabled'
       AND id NOT IN (SELECT user_id FROM workspace_members WHERE workspace_id = ?)
     ORDER BY display_name`,
    ws.id,
  );
  return c.json({ users: rows.map(publicUser) });
});

workspacesRoutes.post('/:id/members', async (c) => {
  const u = me(c);
  const { ws, role } = await requireManager(c.req.param('id'), u);
  const input = await body(c, z.object({ userIds: z.array(z.string()).min(1).max(200), role: z.enum(['admin', 'member', 'viewer']).default('member') }));
  const users = await all<{ id: string; username: string }>(
    `SELECT id, username FROM users WHERE status != 'disabled' AND id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(input.userIds),
  );
  const t = now();
  const stmts: Stmt[] = users.flatMap((m) => [
    sql('INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', ws.id, m.id, input.role, t),
    auditStmt(c, { id: u.id, username: u.username }, 'workspace.member_add', { type: 'workspace', id: ws.id, name: ws.name }, { member: m.username, role: input.role, ...viaServerAdmin(role) }),
  ]);
  await batch(stmts);
  return c.json({ added: users.length });
});

/** オーナーの移行：指定したメンバーをオーナーにし、元のオーナーは管理者にする */
workspacesRoutes.post('/:id/transfer', async (c) => {
  const u = me(c);
  const { ws, role } = await requireOwner(c.req.param('id'), u);
  const input = await body(c, z.object({ userId: z.string() }));
  const targetRole = await membership(ws.id, input.userId);
  if (!targetRole) fail(400, 'オーナーにできるのはワークスペースのメンバーだけです');
  if (targetRole === 'owner') return c.json({ ok: true });
  const target = await get<{ username: string; status: string }>('SELECT username, status FROM users WHERE id = ?', input.userId);
  if (!target || target.status === 'disabled') fail(400, '無効化されたアカウントはオーナーにできません');
  await batch([
    sql(`UPDATE workspace_members SET role = 'admin' WHERE workspace_id = ? AND role = 'owner'`, ws.id),
    sql(`UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?`, ws.id, input.userId),
    auditStmt(c, { id: u.id, username: u.username }, 'workspace.transfer', { type: 'workspace', id: ws.id, name: ws.name }, { member: target.username, ...(role === 'owner' ? {} : { byServerAdmin: true }) }),
  ]);
  return c.json({ ok: true });
});

workspacesRoutes.patch('/:id/members/:userId', async (c) => {
  const u = me(c);
  const { ws, role } = await requireManager(c.req.param('id'), u);
  const target = c.req.param('userId');
  const input = await body(c, z.object({ role: z.enum(['admin', 'member', 'viewer']) }));
  const current = await membership(ws.id, target);
  if (!current) fail(404, 'メンバーが見つかりません');
  if (current === 'owner') fail(400, 'オーナーの権限は変更できません。先にオーナーを別のメンバーに移行してください');
  await run('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?', input.role, ws.id, target);
  await audit(c, { id: u.id, username: u.username }, 'workspace.member_role', { type: 'workspace', id: ws.id, name: ws.name }, { userId: target, role: input.role, ...viaServerAdmin(role) });
  return c.json({ ok: true });
});

/** メンバーを外す（自分自身の場合は退出） */
workspacesRoutes.delete('/:id/members/:userId', async (c) => {
  const u = me(c);
  const wsId = c.req.param('id');
  const target = c.req.param('userId');
  const ws = await get<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', wsId);
  if (!ws) fail(404, 'ワークスペースが見つかりません');
  const actorRole = target !== u.id ? (await requireManager(wsId, u)).role : null;
  const current = await membership(wsId, target);
  if (!current) fail(404, 'メンバーが見つかりません');
  if (current === 'owner') fail(400, 'オーナーは外せません。先にオーナーを別のメンバーに移行してください');
  // 外れたメンバーのプライベートページは削除し、共有ページはそのまま残す
  await batch([
    sql(`DELETE FROM pages WHERE workspace_id = ? AND owner_id = ? AND visibility = 'private'`, wsId, target),
    sql('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?', wsId, target),
    auditStmt(c, { id: u.id, username: u.username }, target === u.id ? 'workspace.leave' : 'workspace.member_remove', { type: 'workspace', id: wsId, name: ws.name }, {
      userId: target,
      ...(target === u.id ? {} : viaServerAdmin(actorRole)),
    }),
  ]);
  return c.json({ ok: true });
});
