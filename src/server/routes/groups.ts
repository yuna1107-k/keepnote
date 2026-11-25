import { Hono } from 'hono';
import { z } from 'zod';
import { audit, auditStmt } from '../audit.ts';
import { all, batch, get, run, sql, type Stmt } from '../db.ts';
import { me, requireAdmin, type AppEnv } from '../session.ts';
import { publicUser, type UserRow } from '../users.ts';
import { body, fail, newId, now } from '../util.ts';

/** ユーザーグループ（管理者のみ作成・編集できる） */
export const groupsRoutes = new Hono<AppEnv>();
groupsRoutes.use('*', requireAdmin);

type GroupRow = { id: string; name: string; description: string | null; created_at: number; updated_at: number };

const actor = (c: Parameters<typeof me>[0]) => {
  const u = me(c);
  return { id: u.id, username: u.username };
};

async function requireGroup(id: string) {
  const g = await get<GroupRow>('SELECT * FROM user_groups WHERE id = ?', id);
  if (!g) fail(404, 'グループが見つかりません');
  return g;
}

const memberStmts = (groupId: string, userIds: string[]): Stmt[] =>
  userIds.map((uid) =>
    sql(
      `INSERT OR IGNORE INTO user_group_members (group_id, user_id, added_at) SELECT ?, id, ? FROM users WHERE id = ?`,
      groupId,
      now(),
      uid,
    ),
  );

groupsRoutes.get('/', async (c) => {
  const rows = await all<GroupRow & { members: number; pages: number }>(
    `SELECT g.*, (SELECT COUNT(*) FROM user_group_members WHERE group_id = g.id) AS members,
            (SELECT COUNT(*) FROM page_group_shares WHERE group_id = g.id) AS pages
     FROM user_groups g ORDER BY g.name`,
  );
  return c.json({
    groups: rows.map((g) => ({ id: g.id, name: g.name, description: g.description, memberCount: g.members, pageCount: g.pages, createdAt: g.created_at })),
  });
});

groupsRoutes.post('/', async (c) => {
  const input = await body(
    c,
    z.object({ name: z.string().trim().min(1).max(64), description: z.string().trim().max(200).optional(), memberIds: z.array(z.string()).max(500).optional() }),
  );
  const id = newId();
  const t = now();
  await batch([
    sql('INSERT INTO user_groups (id, name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, input.name, input.description ?? null, me(c).id, t, t),
    ...memberStmts(id, input.memberIds ?? []),
    auditStmt(c, actor(c), 'group.create', { type: 'group', id, name: input.name }, { members: input.memberIds?.length ?? 0 }),
  ]);
  return c.json({ id }, 201);
});

groupsRoutes.get('/:id', async (c) => {
  const g = await requireGroup(c.req.param('id'));
  const [members, pages] = await Promise.all([
    all<UserRow>(`SELECT u.* FROM user_group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY u.display_name`, g.id),
    all<{ id: string; title: string; icon: string | null; permission: string; ws: string | null }>(
      `SELECT p.id, p.title, p.icon, s.permission, w.name AS ws FROM page_group_shares s JOIN pages p ON p.id = s.page_id
       LEFT JOIN workspaces w ON w.id = p.workspace_id WHERE s.group_id = ? AND p.deleted_at IS NULL ORDER BY p.title`,
      g.id,
    ),
  ]);
  return c.json({
    group: { id: g.id, name: g.name, description: g.description, createdAt: g.created_at },
    members: members.map(publicUser),
    pages: pages.map((p) => ({ id: p.id, title: p.title, icon: p.icon, permission: p.permission, workspace: p.ws })),
  });
});

groupsRoutes.patch('/:id', async (c) => {
  const g = await requireGroup(c.req.param('id'));
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(64).optional(), description: z.string().trim().max(200).nullable().optional() }));
  await batch([
    sql(
      'UPDATE user_groups SET name = COALESCE(?, name), description = CASE WHEN ? THEN ? ELSE description END, updated_at = ? WHERE id = ?',
      input.name ?? null,
      input.description !== undefined ? 1 : 0,
      input.description ?? null,
      now(),
      g.id,
    ),
    auditStmt(c, actor(c), 'group.update', { type: 'group', id: g.id, name: input.name ?? g.name }, input),
  ]);
  return c.json({ ok: true });
});

groupsRoutes.delete('/:id', async (c) => {
  const g = await requireGroup(c.req.param('id'));
  await batch([sql('DELETE FROM user_groups WHERE id = ?', g.id), auditStmt(c, actor(c), 'group.delete', { type: 'group', id: g.id, name: g.name })]);
  return c.json({ ok: true });
});

groupsRoutes.post('/:id/members', async (c) => {
  const g = await requireGroup(c.req.param('id'));
  const input = await body(c, z.object({ userIds: z.array(z.string()).min(1).max(500) }));
  await batch([...memberStmts(g.id, input.userIds), auditStmt(c, actor(c), 'group.member_add', { type: 'group', id: g.id, name: g.name }, { count: input.userIds.length })]);
  return c.json({ ok: true });
});

groupsRoutes.delete('/:id/members/:userId', async (c) => {
  const g = await requireGroup(c.req.param('id'));
  await run('DELETE FROM user_group_members WHERE group_id = ? AND user_id = ?', g.id, c.req.param('userId'));
  await audit(c, actor(c), 'group.member_remove', { type: 'group', id: g.id, name: g.name }, { userId: c.req.param('userId') });
  return c.json({ ok: true });
});
