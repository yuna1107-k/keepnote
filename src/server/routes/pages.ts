import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { auditStmt, auditStmtAsync } from '../audit.ts';
import { encryptText } from '../crypto.ts';
import { pageFilesStmts } from '../pageFiles.ts';
import { indexPageLinks, pageLinksStmts } from '../pageLinks.ts';
import { indexPageTodos, pageTodosStmts } from '../pageTodos.ts';
import { cfg } from '../config.ts';
import { all, batch, get, run, sql, type SqlValue, type Stmt } from '../db.ts';
import { getSettings } from '../settings.ts';
import { publicUser, type UserRow } from '../users.ts';
import { membership, requireContributor, requireMember } from './workspaces.ts';
import { copyGithubFile, createGithubFolder, deleteGithubFile, deleteGithubFolder, desiredGithubPath, getLink, githubUrl, moveGithubPath, safeName } from '../github.ts';
import { accessMap, atLeast, type Level } from '../permissions.ts';
import { notifyWorkspace } from '../liveWorkspace.ts';
import { me, requireAuth, type AppEnv, type SessionUser } from '../session.ts';
import { body, fail, newId, now } from '../util.ts';

export type PageRow = {
  id: string;
  parent_id: string | null;
  owner_id: string;
  visibility: 'workspace' | 'private';
  title: string;
  icon: string | null;
  content: string;
  content_text: string;
  position: number;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  deleted_by: string | null;
  cover: string | null;
  cover_position: number;
  full_width: number;
  small_text: number;
  slide_theme: string | null;
  font: string;
  locked: number;
  public_slug: string | null;
  public_enabled: number;
  public_subpages: number;
  public_indexing: number;
  published_at: number | null;
  published_by: string | null;
  workspace_id: string;
  workspace_access: 'view' | 'edit';
  restricted: number;
  github_path: string | null;
  github_kind: 'root' | 'dir' | 'md' | 'file' | null;
  github_sha: string | null;
  is_template: number;
  is_database: number;
  source_md: string | null;
  github_dirty: number;
  md_rev: number;
  content_md_rev: number;
  github_conflict_at: number | null;
};

/** GitHub のフォルダ・リポジトリのページ（内容は自動生成なので編集できない） */
const isGithubFolder = (p: Pick<PageRow, 'github_kind'>) => p.github_kind === 'dir' || p.github_kind === 'root';

type AccessiblePage = PageRow & { level: Level };

export async function workspaceAccess(workspaceId: string, user: SessionUser) {
  const role = await membership(workspaceId, user.id);
  return accessMap(workspaceId, user, !!role, role === 'viewer', role === 'owner' || role === 'admin');
}

async function findPage(id: string, user: SessionUser): Promise<AccessiblePage | undefined> {
  const page = await get<PageRow>('SELECT * FROM pages WHERE id = ?', id);
  if (!page) return undefined;
  const level = (await workspaceAccess(page.workspace_id, user)).get(page.id) ?? 'none';
  return level === 'none' ? undefined : { ...page, level };
}

const DENY: Record<Level, string> = {
  none: 'ページが見つかりません',
  view: 'ページが見つかりません',
  edit: 'このページは閲覧のみ許可されています',
  full: 'この操作はページの作成者または管理者のみ行えます',
};

async function requirePage(id: string, user: SessionUser, opts: { allowDeleted?: boolean; need?: Level } = {}) {
  const page = await findPage(id, user);
  if (!page) fail(404, 'ページが見つかりません');
  if (page.deleted_at && !opts.allowDeleted) fail(400, 'このページはゴミ箱にあります');
  const need = opts.need ?? 'view';
  if (!atLeast(page.level, need)) fail(403, DENY[need]);
  return page;
}

/** サイドバーの区分：全員に共有 / 自分のページ / 自分に共有された（管理者は他メンバーの）ページ */
function sectionOf(p: Pick<PageRow, 'visibility' | 'owner_id'>, user: SessionUser) {
  if (p.visibility === 'workspace') return 'workspace';
  return p.owner_id === user.id ? 'private' : 'shared';
}

/**
 * そのページの下に置いたページが、親から受け継ぐ権限の持ち主（親たちの作成者・共有相手）。
 * 「招待した人のみ」のページより上からは受け継がないので、そこで止める。
 */
async function inheritedPrincipals(parentId: string | null) {
  const out = new Set<string>();
  if (!parentId) return out;
  const chain = await all<{ id: string; owner_id: string; restricted: number; depth: number }>(
    `WITH RECURSIVE anc(id, parent_id, depth) AS (
       SELECT id, parent_id, 0 FROM pages WHERE id = ?
       UNION ALL SELECT p.id, p.parent_id, anc.depth + 1 FROM pages p JOIN anc ON p.id = anc.parent_id WHERE anc.depth < 100
     ) SELECT p.id, p.owner_id, p.restricted, anc.depth FROM anc JOIN pages p ON p.id = anc.id ORDER BY anc.depth`,
    parentId,
  );
  const stop = chain.findIndex((a) => a.restricted);
  const used = stop >= 0 ? chain.slice(0, stop + 1) : chain;
  if (!used.length) return out;
  const ids = JSON.stringify(used.map((a) => a.id));
  for (const a of used) out.add(`owner:${a.owner_id}`);
  const shares = await all<{ kind: string; who: string; permission: string }>(
    `SELECT 'user' AS kind, user_id AS who, permission FROM page_shares WHERE page_id IN (SELECT value FROM json_each(?))
     UNION ALL SELECT 'group', group_id, permission FROM page_group_shares WHERE page_id IN (SELECT value FROM json_each(?))`,
    ids,
    ids,
  );
  for (const sh of shares) {
    out.add(`${sh.kind}:${sh.who}:view`);
    if (sh.permission === 'edit') out.add(`${sh.kind}:${sh.who}:edit`);
  }
  return out;
}

async function subtreeIds(id: string) {
  const rows = await all<{ id: string }>(
    `WITH RECURSIVE sub(id) AS (
       SELECT ? UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id
     ) SELECT id FROM sub`,
    id,
  );
  return rows.map((r) => r.id);
}

/**
 * 公開範囲を「広げる」ときに対象にするページ。「招待した人のみ」のページとその下には広げない
 * （親を全員に共有しても、招待制の子が全員に見えるようにならないように）。
 */
async function widenableSubtreeIds(id: string) {
  const rows = await all<{ id: string }>(
    `WITH RECURSIVE sub(id) AS (
       SELECT ? UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id WHERE p.restricted = 0
     ) SELECT id FROM sub`,
    id,
  );
  return rows.map((r) => r.id);
}

async function nextPosition(parentId: string | null, visibility: string, ownerId: string, workspaceId = '') {
  const row = parentId
    ? await get<{ m: number | null }>('SELECT MAX(position) AS m FROM pages WHERE parent_id = ?', parentId)
    : await get<{ m: number | null }>(
        `SELECT MAX(position) AS m FROM pages WHERE parent_id IS NULL AND workspace_id = ? AND visibility = ? AND (visibility = 'workspace' OR owner_id = ?)`,
        workspaceId,
        visibility,
        ownerId,
      );
  return (row?.m ?? 0) + 1;
}

async function userName(id: string | null) {
  if (!id) return null;
  return (await get<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', id))?.display_name ?? '削除されたユーザー';
}

async function githubPageUrl(p: PageRow) {
  const link = await getLink(p.workspace_id);
  if (!link || p.github_kind === null || (p.github_kind !== 'root' && !p.github_path)) return null;
  return githubUrl(link, p.github_kind === 'root' ? link.root_path : p.github_path!, p.github_kind);
}

async function githubSyncInfo(workspaceId: string) {
  const link = await getLink(workspaceId);
  return { lastSyncAt: link?.last_sync_at ?? null, lastSyncStatus: link?.last_sync_status ?? null };
}

async function fullPage(p: PageRow & { level?: Level }, user: SessionUser) {
  const [createdBy, updatedBy, fav] = await Promise.all([
    userName(p.created_by),
    userName(p.updated_by),
    get('SELECT 1 FROM favorites WHERE user_id = ? AND page_id = ?', user.id, p.id),
  ]);
  return {
    id: p.id,
    parentId: p.parent_id,
    title: p.title,
    icon: p.icon,
    visibility: p.visibility,
    content: JSON.parse(p.content),
    version: p.version,
    ownerId: p.owner_id,
    isOwner: p.owner_id === user.id,
    createdBy,
    updatedBy,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    deletedAt: p.deleted_at,
    favorite: !!fav,
    cover: p.cover,
    coverPosition: p.cover_position,
    fullWidth: !!p.full_width,
    smallText: !!p.small_text,
    font: p.font,
    slideTheme: p.slide_theme ?? null,
    locked: !!p.locked,
    isPublic: !!p.public_enabled,
    workspaceId: p.workspace_id,
    slug: p.public_slug,
    workspaceSlug: await workspaceSlug(p.workspace_id),
    access: p.level ?? 'view',
    workspaceAccess: p.workspace_access,
    isTemplate: !!p.is_template,
    isDatabase: !!p.is_database,
    github: p.github_kind
      ? {
          kind: p.github_kind,
          path: p.github_path,
          sourceMd: p.github_kind === 'md' && p.md_rev !== p.content_md_rev ? p.source_md : null,
          mdRev: p.md_rev,
          contentMdRev: p.content_md_rev,
          dirty: !!p.github_dirty,
          conflictAt: p.github_conflict_at,
          url: await githubPageUrl(p),
          // ワークスペースと GitHub の最終同期（自動の同期・「今すぐ同期」）
          ...(await githubSyncInfo(p.workspace_id)),
        }
      : null,
  };
}

export const pagesRoutes = new Hono<AppEnv>();
pagesRoutes.use('*', requireAuth);

/*
 * ページの名前・アイコン・場所などが変わったら、ワークスペースを開いている人に知らせる（liveWorkspace.ts）。
 * 本文だけの保存（自動保存）では知らせない
 */
const META_KEYS = ['title', 'icon', 'visibility', 'isTemplate', 'isDatabase'];
const META_ROUTE = /^\/[^/]+\/(move|reorder|restore|permanent|duplicate|database|share|access\/.+|versions\/[^/]+\/restore)$/;
pagesRoutes.use('*', async (c, next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD') return next();
  const path = c.req.path.replace(/^.*?\/api\/pages/, '') || '/';
  const isCreate = method === 'POST' && path === '/';
  const isPage = /^\/[^/]+$/.test(path) && (method === 'PATCH' || method === 'DELETE');
  if (!isCreate && !isPage && !META_ROUTE.test(path)) return next();
  if (method === 'PATCH' && isPage) {
    const input = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!input || !META_KEYS.some((k) => k in input)) return next();
  }
  // 完全に削除すると消えるので、先に調べておく
  const id = isCreate ? null : path.split('/')[1]!;
  let wsId = id ? (await get<{ workspace_id: string }>('SELECT workspace_id FROM pages WHERE id = ?', id))?.workspace_id : undefined;
  await next();
  if (c.res.status >= 400) return;
  if (!wsId) {
    try {
      wsId = ((await c.res.clone().json()) as { page?: { workspaceId?: string } })?.page?.workspaceId;
    } catch {
      /* 本文が JSON でなければ知らせない */
    }
  }
  if (wsId) notifyWorkspace(c, wsId);
});

/** サイドバー用：アクセス可能な全ページ（本文なし） */
pagesRoutes.get('/', async (c) => {
  const u = me(c);
  const { ws } = await requireMember(c.req.query('workspace') ?? '', u);
  const [pages, favorites, access] = await Promise.all([
    all<Pick<PageRow, 'id' | 'parent_id' | 'title' | 'icon' | 'visibility' | 'position' | 'updated_at' | 'public_enabled' | 'cover' | 'owner_id' | 'public_slug' | 'github_kind' | 'github_path' | 'is_database'>>(
      `SELECT id, parent_id, title, icon, visibility, position, updated_at, public_enabled, cover, owner_id, public_slug, github_kind, github_path, is_database FROM pages
       WHERE deleted_at IS NULL AND workspace_id = ? ORDER BY position, created_at`,
      ws.id,
    ),
    all<{ page_id: string }>('SELECT page_id FROM favorites WHERE user_id = ? ORDER BY created_at', u.id),
    workspaceAccess(ws.id, u),
  ]);
  const visible = pages.filter((p) => (access.get(p.id) ?? 'none') !== 'none');
  const visibleIds = new Set(visible.map((p) => p.id));
  return c.json({
    pages: visible.map((p) => ({
      id: p.id,
      // 親が見えない場合は最上位として扱う
      parentId: p.parent_id && visibleIds.has(p.parent_id) ? p.parent_id : null,
      title: p.title,
      icon: p.icon,
      visibility: p.visibility,
      position: p.position,
      updatedAt: p.updated_at,
      isPublic: !!p.public_enabled,
      cover: p.cover,
      isDatabase: !!p.is_database,
      access: access.get(p.id),
      section: sectionOf(p, u),
      slug: p.public_slug,
      githubKind: p.github_kind,
      githubPath: p.github_path,
    })),
    workspaceSlug: ws.slug ?? ws.id,
    favorites: favorites.map((f) => f.page_id).filter((id) => visibleIds.has(id)),
  });
});

/** GitHub 連携のフォルダの下に、新しいフォルダを作る（GitHub には .gitkeep を置く） */
async function createGithubFolderPage(c: Context<AppEnv>, u: SessionUser, parentId: string | null, title: string) {
  if (!parentId) fail(400, 'フォルダは GitHub と同期しているフォルダの下にだけ作れます');
  const parent = await requirePage(parentId, u, { need: 'edit' });
  if (parent.github_kind !== 'dir' && parent.github_kind !== 'root') fail(400, 'フォルダは GitHub と同期しているフォルダの下にだけ作れます');
  const link = await getLink(parent.workspace_id);
  if (!link) fail(400, 'GitHub と連携していません');
  const base = parent.github_kind === 'root' ? link.root_path : parent.github_path ?? link.root_path;
  const prefix = base ? base.replace(/\/+$/, '') + '/' : '';
  // 同じ名前があれば「（2）」などを付ける
  const wanted = safeName(title || '新しいフォルダ');
  let name = wanted;
  for (let i = 2; await get('SELECT 1 FROM pages WHERE workspace_id = ? AND github_path = ? AND deleted_at IS NULL', parent.workspace_id, prefix + name); i++) {
    name = `${wanted}（${i}）`;
  }
  const path = prefix + name;
  await createGithubFolder(link, path);
  const id = newId();
  const t = now();
  await run(
    `INSERT INTO pages (full_width, font, id, workspace_id, parent_id, owner_id, visibility, title, icon, content, content_text, position, github_kind, github_path, created_by, updated_by, created_at, updated_at)
     VALUES (1, 'serif', ?, ?, ?, ?, 'workspace', ?, ?, ?, ?, 0, 'dir', ?, ?, ?, ?, ?)`,
    id,
    parent.workspace_id,
    parent.id,
    u.id,
    await encryptText(name),
    await encryptText('ms:folder'),
    await encryptText('[]'),
    await encryptText(''),
    path,
    u.id,
    u.id,
    t,
    t,
  );
  return c.json({ page: await fullPage((await findPage(id, u))!, u) }, 201);
}

pagesRoutes.post('/', async (c) => {
  const u = me(c);
  const input = await body(
    c,
    z.object({
      parentId: z.string().nullable().default(null),
      visibility: z.enum(['workspace', 'private']).default('workspace'),
      title: z.string().max(500).default(''),
      icon: z.string().max(64).nullable().default(null),
      workspaceId: z.string().optional(),
      /** GitHub のフォルダの下にフォルダを作る */
      folder: z.boolean().optional(),
      /** 文字の形（日記は無心など）。省くと親のページと同じ（いちばん上ならセリフ） */
      font: z.enum(['default', 'serif', 'mono', 'mushin']).optional(),
    }),
  );
  if (input.folder) return createGithubFolderPage(c, u, input.parentId, input.title);
  let visibility = input.visibility;
  let workspaceId: string;
  let font = input.font ?? 'serif';
  if (input.parentId) {
    const parent = await requirePage(input.parentId, u, { need: 'edit' });
    visibility = parent.visibility;
    workspaceId = parent.workspace_id;
    // 日記などの下に作ったページは、親と同じ文字の形にする
    if (!input.font && parent.font === 'mushin') font = 'mushin';
  } else {
    const { ws } = await requireContributor(input.workspaceId ?? '', u);
    workspaceId = ws.id;
    if (visibility === 'private' && !ws.private_pages) fail(403, 'このワークスペースでは「プライベート」のページは使えません（ワークスペースの設定でオンにできます）');
  }
  // GitHub のフォルダの下に作ったページは、新しい Markdown ファイルとして GitHub に送る
  let githubKind: 'md' | null = null;
  if (input.parentId) {
    const parent = await get<{ github_kind: string | null }>('SELECT github_kind FROM pages WHERE id = ?', input.parentId);
    if (parent?.github_kind === 'md' || parent?.github_kind === 'file') fail(400, 'GitHub のファイルのページの下にはサブページを作れません（フォルダの下に作成してください）');
    if (parent?.github_kind === 'dir' || parent?.github_kind === 'root') githubKind = 'md';
  }
  const id = newId();
  const t = now();
  await run(
    `INSERT INTO pages (full_width, font, id, workspace_id, parent_id, owner_id, visibility, title, icon, content, content_text, position, created_by, updated_by, created_at, updated_at, github_kind, github_dirty, source_md)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    font,
    id,
    workspaceId,
    input.parentId,
    u.id,
    visibility,
    await encryptText(input.title),
    await encryptText(input.icon),
    await encryptText('[]'),
    await encryptText(''),
    await nextPosition(input.parentId, visibility, u.id, workspaceId),
    u.id,
    u.id,
    t,
    t,
    githubKind,
    githubKind ? 1 : 0,
    githubKind ? await encryptText('') : null,
  );
  return c.json({ page: await fullPage((await findPage(id, u))!, u) }, 201);
});

pagesRoutes.get('/trash', async (c) => {
  const u = me(c);
  const { ws } = await requireMember(c.req.query('workspace') ?? '', u);
  const [rows, access] = await Promise.all([
    all<PageRow & { deleted_by_name: string | null }>(
      `SELECT p.*, d.display_name AS deleted_by_name FROM pages p
       LEFT JOIN pages parent ON parent.id = p.parent_id
       LEFT JOIN users d ON d.id = p.deleted_by
       WHERE p.deleted_at IS NOT NULL AND p.workspace_id = ?
         AND (parent.id IS NULL OR parent.deleted_at IS NULL OR parent.deleted_at != p.deleted_at)
       ORDER BY p.deleted_at DESC`,
      ws.id,
    ),
    workspaceAccess(ws.id, u),
  ]);
  return c.json({
    pages: rows
      .filter((p) => atLeast(access.get(p.id) ?? 'none', 'edit'))
      .map((p) => ({
        id: p.id,
        title: p.title,
        icon: p.icon,
        visibility: p.visibility,
        deletedAt: p.deleted_at,
        deletedBy: p.deleted_by_name,
        canPurge: access.get(p.id) === 'full',
      })),
  });
});

pagesRoutes.get('/search', async (c) => {
  const u = me(c);
  const q = (c.req.query('q') ?? '').trim();
  if (!q) return c.json({ results: [] });
  const { ws } = await requireMember(c.req.query('workspace') ?? '', u);
  const access = await workspaceAccess(ws.id, u);
  // 本文は暗号化されている可能性があるため、復号してからサーバー内で照合する
  const all_ = await all<Pick<PageRow, 'id' | 'title' | 'icon' | 'content_text' | 'updated_at' | 'visibility'>>(
    `SELECT id, title, icon, content_text, updated_at, visibility FROM pages
     WHERE deleted_at IS NULL AND workspace_id = ? ORDER BY updated_at DESC`,
    ws.id,
  );
  const needle = q.toLowerCase();
  const rows = all_
    .filter((r) => r.title.toLowerCase().includes(needle) || r.content_text.toLowerCase().includes(needle))
    .sort((x, y) => Number(y.title.toLowerCase().includes(needle)) - Number(x.title.toLowerCase().includes(needle)));
  const lower = q.toLowerCase();
  const cut = (text: string) => {
    const idx = text.toLowerCase().indexOf(lower);
    return idx >= 0 ? (idx > 40 ? '…' : '') + text.slice(Math.max(0, idx - 40), idx + q.length + 60).replace(/\s+/g, ' ') : text.slice(0, 100).replace(/\s+/g, ' ');
  };
  const results: { id: string; title: string; icon: string | null; snippet: string; updatedAt: number; visibility: string; file?: string; database?: string }[] = rows
    .filter((r) => (access.get(r.id) ?? 'none') !== 'none')
    .slice(0, 30)
    .map((r) => ({ id: r.id, title: r.title, icon: r.icon, snippet: cut(r.content_text), updatedAt: r.updated_at, visibility: r.visibility }));
  // ページに貼ったファイルの中身（PDF・Word・表など）も探す
  if (results.length < 30) {
    const files = await all<{ file_id: string; filename: string; content_text: string | null; page_id: string; title: string; icon: string | null; updated_at: number; visibility: string }>(
      `SELECT f.id AS file_id, f.filename, f.content_text, p.id AS page_id, p.title, p.icon, p.updated_at, p.visibility
       FROM files f JOIN page_files pf ON pf.file_id = f.id JOIN pages p ON p.id = pf.page_id
       WHERE p.workspace_id = ? AND p.deleted_at IS NULL AND f.content_text IS NOT NULL`,
      ws.id,
    );
    const seen = new Set<string>();
    for (const f of files) {
      if (results.length >= 30) break;
      if ((access.get(f.page_id) ?? 'none') === 'none' || seen.has(f.file_id)) continue;
      const text = f.content_text ?? '';
      if (!text.toLowerCase().includes(needle) && !f.filename.toLowerCase().includes(needle)) continue;
      seen.add(f.file_id);
      results.push({ id: f.page_id, title: f.title, icon: f.icon, snippet: cut(text), updatedAt: f.updated_at, visibility: f.visibility, file: f.filename });
    }
  }
  // データベースの行の値（「状態：進行中」など）も探す
  if (results.length < 30) {
    const [schemas, values, members] = await Promise.all([
      all<{ page_id: string; schema: string; title: string }>(
        'SELECT d.page_id, d.schema, p.title FROM databases d JOIN pages p ON p.id = d.page_id WHERE p.workspace_id = ? AND p.deleted_at IS NULL AND p.is_database = 1',
        ws.id,
      ),
      all<{ row_id: string; data: string; parent_id: string; title: string; icon: string | null; updated_at: number; visibility: string }>(
        `SELECT v.row_id, v.data, p.parent_id, p.title, p.icon, p.updated_at, p.visibility FROM db_values v
         JOIN pages p ON p.id = v.row_id WHERE p.workspace_id = ? AND p.deleted_at IS NULL`,
        ws.id,
      ),
      all<{ id: string; name: string }>('SELECT u.id, u.display_name AS name FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?', ws.id),
    ]);
    const bySchema = new Map<string, { schema: DbSchema; title: string }>();
    for (const r of schemas) {
      try {
        bySchema.set(r.page_id, { schema: JSON.parse(r.schema), title: r.title });
      } catch {
        /* 壊れた定義は飛ばす */
      }
    }
    const names = new Map(members.map((m) => [m.id, m.name]));
    const seenRows = new Set(results.map((r) => r.id));
    for (const v of values) {
      if (results.length >= 30) break;
      const db = bySchema.get(v.parent_id);
      if (!db || seenRows.has(v.row_id) || (access.get(v.row_id) ?? 'none') === 'none') continue;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(v.data);
      } catch {
        continue;
      }
      const text = db.schema.props
        .map((p) => {
          const t = dbValueText(p, data[p.id], names);
          return t ? `${p.name}：${t}` : '';
        })
        .filter(Boolean)
        .join(' ・ ');
      if (!text.toLowerCase().includes(needle)) continue;
      seenRows.add(v.row_id);
      results.push({ id: v.row_id, title: v.title, icon: v.icon, snippet: cut(text), updatedAt: v.updated_at, visibility: v.visibility, file: undefined, database: db.title });
    }
  }
  return c.json({ results });
});

/** データベースの値を文字にする（検索用。画面の表示と同じ形） */
function dbValueText(prop: DbSchema['props'][number], v: unknown, members: Map<string, string>) {
  if (v === undefined || v === null || v === '') return '';
  const opt = (id: unknown) => prop.options?.find((o) => o.id === id)?.name ?? '';
  switch (prop.type) {
    case 'checkbox':
      return v ? 'チェックあり' : '';
    case 'select':
      return opt(v);
    case 'multi_select':
      return Array.isArray(v) ? v.map(opt).filter(Boolean).join(', ') : '';
    case 'person':
      return Array.isArray(v) ? v.map((id) => members.get(String(id)) ?? '').filter(Boolean).join(', ') : '';
    case 'date':
      return String(v).replace(/-/g, '/');
    default:
      return String(v);
  }
}

/** カスタムURL（/share/<slug>）からページを探す。公開していないページは、アクセス権のある人だけ開ける */
pagesRoutes.get('/by-slug/:slug', async (c) => {
  const u = me(c);
  const row = await get<{ id: string }>('SELECT id FROM pages WHERE public_slug = ? AND deleted_at IS NULL', c.req.param('slug'));
  const page = row ? await findPage(row.id, u) : undefined;
  if (!page) fail(404, 'ページが見つからないか、アクセス権がありません');
  return c.json({ id: page.id, workspaceSlug: await workspaceSlug(page.workspace_id) });
});

/** リンクの関係図：見られるページと、ページどうしのリンク・親子 */
pagesRoutes.get('/graph', async (c) => {
  const u = me(c);
  const { ws } = await requireMember(c.req.query('workspace') ?? '', u);
  // まだ記録していないページがあれば、先に記録する
  await indexPageLinks(300);
  const [pages, links, access] = await Promise.all([
    all<{ id: string; parent_id: string | null; title: string; icon: string | null }>(
      'SELECT id, parent_id, title, icon FROM pages WHERE workspace_id = ? AND deleted_at IS NULL',
      ws.id,
    ),
    all<{ from_id: string; to_id: string }>(
      'SELECT l.from_id, l.to_id FROM page_links l JOIN pages p ON p.id = l.from_id WHERE p.workspace_id = ? AND p.deleted_at IS NULL',
      ws.id,
    ),
    workspaceAccess(ws.id, u),
  ]);
  const visible = new Set(pages.filter((p) => (access.get(p.id) ?? 'none') !== 'none').map((p) => p.id));
  return c.json({
    nodes: pages.filter((p) => visible.has(p.id)).map((p) => ({ id: p.id, title: p.title, icon: p.icon, parentId: p.parent_id && visible.has(p.parent_id) ? p.parent_id : null })),
    links: links.filter((l) => l.from_id !== l.to_id && visible.has(l.from_id) && visible.has(l.to_id)).map((l) => ({ from: l.from_id, to: l.to_id })),
  });
});

/** 未完了の ToDo の一覧（見られるページのものだけ）。タスクの画面で使う */
pagesRoutes.get('/tasks', async (c) => {
  const u = me(c);
  const { ws } = await requireMember(c.req.query('workspace') ?? '', u);
  // まだ記録していないページがあれば、先に記録する
  await indexPageTodos(300, ws.id);
  const [rows, access] = await Promise.all([
    all<{ page_id: string; block_id: string; position: number; text: string; due: string | null; title: string; icon: string | null }>(
      `SELECT t.page_id, t.block_id, t.position, t.text, t.due, p.title, p.icon FROM page_todos t
       JOIN pages p ON p.id = t.page_id
       WHERE p.workspace_id = ? AND p.deleted_at IS NULL
       ORDER BY p.updated_at DESC, t.position`,
      ws.id,
    ),
    workspaceAccess(ws.id, u),
  ]);
  return c.json({
    tasks: rows
      .filter((r) => (access.get(r.page_id) ?? 'none') !== 'none')
      .slice(0, 2000)
      .map((r) => ({ pageId: r.page_id, pageTitle: r.title, pageIcon: r.icon, blockId: r.block_id, text: r.text, due: r.due, canEdit: atLeast(access.get(r.page_id)!, 'edit') })),
  });
});

/** ワークスペースのテンプレート（見られるものだけ） */
pagesRoutes.get('/templates', async (c) => {
  const u = me(c);
  const { ws } = await requireMember(c.req.query('workspace') ?? '', u);
  const rows = await all<{ id: string; title: string; icon: string | null }>(
    'SELECT id, title, icon FROM pages WHERE workspace_id = ? AND is_template = 1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 50',
    ws.id,
  );
  const access = await workspaceAccess(ws.id, u);
  return c.json({ templates: rows.filter((r) => (access.get(r.id) ?? 'none') !== 'none') });
});

pagesRoutes.get('/:id', async (c) => {
  const u = me(c);
  // カスタム URL（/p/<slug>）でも開けるようにする
  const param = c.req.param('id');
  const bySlug = /^[0-9a-f-]{36}$/.test(param) ? null : await get<{ id: string }>('SELECT id FROM pages WHERE public_slug = ?', param);
  const page = await requirePage(bySlug?.id ?? param, u, { allowDeleted: true });
  return c.json({ page: await fullPage(page, u) });
});

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

const COVER_RE = /^(\/api\/files\/[0-9a-f-]{36}|gradient:\d{1,2}|color:#[0-9a-fA-F]{6}|pattern:[a-z0-9-]{1,32}|photo:[a-z0-9-]{1,40}|https:\/\/[^\s"'<>]{1,2000})$/;

pagesRoutes.patch('/:id', async (c) => {
  const u = me(c);
  const input = await body(
    c,
    z.object({
      version: z.number().int(),
      title: z.string().max(500).optional(),
      icon: z.string().max(64).nullable().optional(),
      content: z.array(z.any()).optional(),
      contentText: z.string().max(2_000_000).optional(),
      cover: z.string().regex(COVER_RE).nullable().optional(),
      coverPosition: z.number().min(0).max(100).optional(),
      fullWidth: z.boolean().optional(),
      smallText: z.boolean().optional(),
      font: z.enum(['default', 'serif', 'mono', 'mushin']).optional(),
      /** スライドで表示するときのテーマ（null = 標準） */
      slideTheme: z.string().regex(/^[a-z0-9-]{1,32}$/).nullable().optional(),
      locked: z.boolean().optional(),
      /** テンプレートにする・外す */
      isTemplate: z.boolean().optional(),
      // 共同編集中は全員の内容が同じになるので、版の確認をしない
      collab: z.boolean().optional(),
      // GitHub と同期しているページ：本文の Markdown と、変換元にした GitHub の版
      markdown: z.string().max(2_000_000).optional(),
      contentMdRev: z.number().int().optional(),
    }),
  );
  const page = await requirePage(c.req.param('id'), u, { need: 'edit' });
  const editsBody = input.title !== undefined || input.content !== undefined || input.icon !== undefined;
  if (page.locked && input.locked !== false && editsBody) {
    fail(409, 'このページはロックされています。ロックを解除してから編集してください');
  }
  if (isGithubFolder(page) && input.content !== undefined) {
    fail(409, 'GitHub のフォルダのページは自動で作られるため、本文は編集できません');
  }
  if (page.github_kind === 'file' && input.content !== undefined) {
    fail(409, 'GitHub のファイルのページは、ファイルの画面から編集してください');
  }
  // GitHub のファイル・フォルダの名前を変えたら、次の送信で GitHub 上の名前も変える
  const githubRename =
    (page.github_kind === 'md' || page.github_kind === 'file' || page.github_kind === 'dir') && !!page.github_path && input.title !== undefined && input.title !== page.title;
  const sets: string[] = [];
  const params: SqlValue[] = [];
  const set = (col: string, v: SqlValue) => {
    sets.push(`${col} = ?`);
    params.push(v);
  };
  // 本文・タイトルなどは暗号化して保存する（鍵が設定されている場合）
  if (input.title !== undefined) set('title', await encryptText(input.title));
  if (input.icon !== undefined) set('icon', await encryptText(input.icon));
  if (input.content !== undefined) {
    set('content', await encryptText(JSON.stringify(input.content)));
    set('content_text', await encryptText(input.contentText ?? ''));
  }
  if (githubRename && input.title?.trim()) set('github_dirty', 1);
  if (page.github_kind === 'md') {
    let markdown = input.markdown;
    // 画面では 1 行目の見出し 1 を出していないので、元のファイルにあれば付け直す
    const heading = /^\uFEFF?#[ \t]+[^\n]*/.exec(page.source_md ?? '')?.[0];
    if (markdown !== undefined && heading && !/^\uFEFF?#[ \t]/.test(markdown)) markdown = `${heading}\n\n${markdown}`;
    if (markdown !== undefined && markdown !== (page.source_md ?? '')) {
      set('source_md', await encryptText(markdown));
      set('github_dirty', 1);
    }
    if (input.contentMdRev !== undefined) set('content_md_rev', input.contentMdRev);
  }
  if (input.cover !== undefined) set('cover', await encryptText(input.cover));
  if (input.coverPosition !== undefined) set('cover_position', input.coverPosition);
  if (input.fullWidth !== undefined) set('full_width', input.fullWidth ? 1 : 0);
  if (input.smallText !== undefined) set('small_text', input.smallText ? 1 : 0);
  if (input.font !== undefined) set('font', input.font);
  if (input.slideTheme !== undefined) set('slide_theme', input.slideTheme);
  if (input.locked !== undefined) set('locked', input.locked ? 1 : 0);
  if (input.isTemplate !== undefined) set('is_template', input.isTemplate ? 1 : 0);
  if (sets.length === 0) return c.json({ version: page.version, updatedAt: page.updated_at });

  const t = now();
  sets.push('version = version + 1', 'updated_at = ?', 'updated_by = ?');
  params.push(t, u.id);
  const stmts: Stmt[] = [];

  // 本文・タイトルの変更時は、更新前の状態を履歴に残す（同じ人の連続編集は 2 分に 1 回まで）
  if (input.title !== undefined || input.content !== undefined) {
    const last = await get<{ created_at: number; edited_by: string | null }>(
      'SELECT created_at, edited_by FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1',
      page.id,
    );
    const isBlankNew = page.version === 1 && page.content === '[]' && page.title === '';
    if (!isBlankNew && (!last || page.updated_at - last.created_at > 2 * 60_000 || last.edited_by !== page.updated_by)) {
      stmts.push(snapshotStmt(page.id, input.collab ? undefined : input.version));
    }
  }
  const updateIndex = stmts.length;
  // 使っているファイルを記録する（ファイルを見てよい人の判定に使う）
  const fileStmts = input.content !== undefined || input.cover !== undefined ? await pageFilesStmts(page.id, u, input.content !== undefined ? JSON.stringify(input.content) : null, input.cover) : [];
  // ページ同士のリンクも記録し直す（被リンクの表示に使う）
  if (input.content !== undefined) fileStmts.push(...(await pageLinksStmts(page, JSON.stringify(input.content))));
  // 未完了の ToDo も記録し直す（タスクの画面で使う）
  if (input.content !== undefined) fileStmts.push(...(await pageTodosStmts(page.id, JSON.stringify(input.content))));
  stmts.push(
    input.collab
      ? sql(`UPDATE pages SET ${sets.join(', ')} WHERE id = ?`, ...params, page.id)
      : sql(`UPDATE pages SET ${sets.join(', ')} WHERE id = ? AND version = ?`, ...params, page.id, input.version),
  );
  const results = await batch([...stmts, ...fileStmts]);
  if (results[updateIndex]!.changes === 0) {
    return c.json({ error: '他のユーザーがこのページを更新しました', page: await fullPage((await findPage(page.id, u))!, u) }, 409);
  }
  if (input.collab) {
    const v = await get<{ version: number }>('SELECT version FROM pages WHERE id = ?', page.id);
    return c.json({ version: v?.version ?? input.version + 1, updatedAt: t });
  }
  return c.json({ version: input.version + 1, updatedAt: t });
});

/** 現在の状態を履歴に保存する文（version が一致するときだけ挿入される） */
function snapshotStmt(pageId: string, version?: number) {
  return sql(
    `INSERT INTO page_versions (id, page_id, title, icon, content, content_text, edited_by, created_at)
     SELECT ?, id, title, icon, content, content_text, updated_by, updated_at FROM pages
     WHERE id = ? ${version !== undefined ? 'AND version = ?' : ''}`,
    newId(),
    pageId,
    ...(version !== undefined ? [version] : []),
  );
}

// ---- ページ履歴 ----

pagesRoutes.get('/:id/versions', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u, { allowDeleted: true });
  const rows = await all<{ id: string; title: string; icon: string | null; created_at: number; editor: string | null }>(
    `SELECT v.id, v.title, v.icon, v.created_at, u.display_name AS editor
     FROM page_versions v LEFT JOIN users u ON u.id = v.edited_by
     WHERE v.page_id = ? ORDER BY v.created_at DESC LIMIT 100`,
    page.id,
  );
  return c.json({
    versions: rows.map((v) => ({ id: v.id, title: v.title, icon: v.icon, createdAt: v.created_at, editedBy: v.editor })),
  });
});

pagesRoutes.get('/:id/versions/:vid', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u, { allowDeleted: true });
  const v = await get<{ id: string; title: string; icon: string | null; content: string; created_at: number }>(
    'SELECT id, title, icon, content, created_at FROM page_versions WHERE id = ? AND page_id = ?',
    c.req.param('vid'),
    page.id,
  );
  if (!v) fail(404, '履歴が見つかりません');
  return c.json({ version: { id: v.id, title: v.title, icon: v.icon, content: JSON.parse(v.content), createdAt: v.created_at } });
});

pagesRoutes.post('/:id/versions/:vid/restore', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u, { need: 'edit' });
  const v = await get<{ id: string }>('SELECT id FROM page_versions WHERE id = ? AND page_id = ?', c.req.param('vid'), page.id);
  if (!v) fail(404, '履歴が見つかりません');
  const t = now();
  await batch([
    snapshotStmt(page.id),
    sql(
      `UPDATE pages SET (title, icon, content, content_text) =
         (SELECT title, icon, content, content_text FROM page_versions WHERE id = ?),
       version = version + 1, updated_at = ?, updated_by = ?, locked = 0, links_indexed_at = NULL, todos_indexed_at = NULL
       WHERE id = ?`,
      v.id,
      t,
      u.id,
      page.id,
    ),
    sql(
      `DELETE FROM page_versions WHERE page_id = ? AND id NOT IN
         (SELECT id FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 100)`,
      page.id,
      page.id,
    ),
  ]);
  return c.json({ page: await fullPage((await findPage(page.id, u))!, u) });
});

// ---- 複製 ----

/** GitHub のファイルを同じフォルダに「（コピー）」として複製する */
async function duplicateGithubPage(c: Context<AppEnv>, u: SessionUser, page: AccessiblePage) {
  const link = await getLink(page.workspace_id);
  if (!link) fail(400, 'GitHub と連携していません');
  const id = newId();
  const t = now();
  const base = page.title.replace(/\.[^./]+$/, '');
  const ext = page.github_kind === 'file' ? (/\.[^./]+$/.exec(page.title)?.[0] ?? '') : '';
  const title = `${base}（コピー）${ext}`;
  let path: string | null = null;
  let sha: string | null = null;
  if (page.github_kind === 'file') {
    path = await desiredGithubPath(link, { parent_id: page.parent_id, title, github_kind: 'file', github_path: page.github_path });
    if (!path || !page.github_path) fail(409, 'GitHub にファイルが見つかりません');
    sha = await copyGithubFile(link, page.github_path, path);
  }
  await run(
    `INSERT INTO pages (full_width, font, id, workspace_id, parent_id, owner_id, visibility, title, icon, content, content_text, position, github_kind, github_path, github_sha, github_dirty, source_md, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'workspace', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    page.full_width,
    page.font,
    id,
    page.workspace_id,
    page.parent_id,
    u.id,
    await encryptText(title),
    await encryptText(page.icon),
    await encryptText(page.content),
    await encryptText(page.content_text),
    page.position + 0.5,
    page.github_kind,
    path,
    sha,
    page.github_kind === 'md' ? 1 : 0,
    page.github_kind === 'md' ? await encryptText(page.source_md ?? '') : null,
    u.id,
    u.id,
    t,
    t,
  );
  return c.json({ id, count: 1 }, 201);
}

/** このページを参照しているページ（見られるものだけ） */
pagesRoutes.get('/:id/backlinks', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u);
  const rows = await all<{ id: string; title: string; icon: string | null; workspace_id: string }>(
    `SELECT p.id, p.title, p.icon, p.workspace_id FROM page_links l JOIN pages p ON p.id = l.from_id
     WHERE l.to_id = ? AND p.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT 100`,
    page.id,
  );
  const access = await workspaceAccess(page.workspace_id, u);
  return c.json({
    pages: rows.filter((r) => r.workspace_id === page.workspace_id && (access.get(r.id) ?? 'none') !== 'none').map((r) => ({ id: r.id, title: r.title, icon: r.icon })),
  });
});

pagesRoutes.post('/:id/duplicate', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u, { need: 'edit' });
  if (page.github_kind === 'root' || page.github_kind === 'dir') fail(409, 'GitHub のフォルダは複製できません');
  if (page.github_kind === 'file' || page.github_kind === 'md') return duplicateGithubPage(c, u, page);
  const access = await workspaceAccess(page.workspace_id, u);
  const rows = await all<PageRow & { depth: number }>(
    `WITH RECURSIVE sub(id, depth) AS (
       SELECT ?, 0 UNION ALL SELECT p.id, sub.depth + 1 FROM pages p JOIN sub ON p.parent_id = sub.id WHERE p.deleted_at IS NULL
     ) SELECT pages.*, sub.depth FROM sub JOIN pages ON pages.id = sub.id
       ORDER BY sub.depth, pages.position`,
    page.id,
  ).then((list) => list.filter((r) => (access.get(r.id) ?? 'none') !== 'none'));
  const t = now();
  const idMap = new Map<string, string>();
  const stmts: Stmt[] = [];
  const fileStmts: Stmt[] = [];
  for (const r of rows) {
    const newPageId = newId();
    idMap.set(r.id, newPageId);
    const isRoot = r.id === page.id;
    const parent = isRoot ? r.parent_id : idMap.get(r.parent_id!);
    if (!isRoot && !parent) continue;
    stmts.push(
      sql(
        `INSERT INTO pages (id, workspace_id, parent_id, owner_id, visibility, title, icon, content, content_text, position,
           cover, cover_position, full_width, small_text, font, slide_theme, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newPageId,
        r.workspace_id,
        parent ?? null,
        u.id,
        r.visibility,
        await encryptText(isRoot ? `${r.title || '無題'} (コピー)` : r.title),
        await encryptText(r.icon),
        await encryptText(r.content),
        await encryptText(r.content_text),
        isRoot ? r.position + 0.5 : r.position,
        await encryptText(r.cover),
        r.cover_position,
        r.full_width,
        r.small_text,
        r.font,
        r.slide_theme,
        u.id,
        u.id,
        t,
        t,
      ),
    );
    fileStmts.push(...(await pageFilesStmts(newPageId, u, r.content, r.cover)));
  }
  await batch(stmts);
  if (fileStmts.length) await batch(fileStmts);
  return c.json({ id: idMap.get(page.id), count: stmts.length }, 201);
});

// ---- Web への外部公開 ----

async function workspaceSlug(workspaceId: string) {
  return (await get<{ slug: string | null }>('SELECT slug FROM workspaces WHERE id = ?', workspaceId))?.slug ?? workspaceId;
}

/** ページの URL：カスタム URL があれば /<ワークスペースのURL名>/<ページのURL>、なければ /p/<ID> */
async function pageUrl(page: Pick<PageRow, 'id' | 'public_slug' | 'workspace_id'>) {
  return page.public_slug ? `${cfg.ORIGIN}/${await workspaceSlug(page.workspace_id)}/${page.public_slug}` : `${cfg.ORIGIN}/p/${page.id}`;
}

async function shareInfo(page: PageRow) {
  // 祖先が「サブページも公開」で公開されていれば、このページもその公開リンク配下で見られる
  const inherited = await get<{ id: string; title: string; public_slug: string; workspace_id: string }>(
    `WITH RECURSIVE anc(id, parent_id, depth) AS (
       SELECT id, parent_id, 0 FROM pages WHERE id = ?
       UNION ALL SELECT p.id, p.parent_id, anc.depth + 1 FROM pages p JOIN anc ON p.id = anc.parent_id
     ) SELECT p.id, p.title, p.public_slug, p.workspace_id FROM anc JOIN pages p ON p.id = anc.id
       WHERE anc.depth > 0 AND p.public_enabled = 1 AND p.public_subpages = 1 AND p.deleted_at IS NULL
       ORDER BY anc.depth LIMIT 1`,
    page.id,
  );
  const settings = await getSettings();
  return {
    enabled: !!page.public_enabled,
    slug: page.public_slug,
    // 招待したアカウント向けのリンク（カスタムURLがあればそれを使う。開くにはログインとアクセス権が必要）
    memberUrl: await pageUrl(page),
    workspaceSlug: await workspaceSlug(page.workspace_id),
    url: page.public_slug ? await pageUrl(page) : null,
    subpages: !!page.public_subpages,
    indexing: !!page.public_indexing,
    publishedAt: page.published_at,
    publishedBy: await userName(page.published_by),
    inherited: inherited
      ? { pageId: inherited.id, title: inherited.title, url: `${await pageUrl(inherited)}/${page.id}` }
      : null,
    policy: settings.publishPolicy,
  };
}

pagesRoutes.get('/:id/share', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u);
  const info = await shareInfo(page);
  const allowed = info.policy === 'everyone' || (info.policy === 'admins' && u.role === 'admin');
  return c.json({ ...info, canPublish: allowed && page.level === 'full', canEditLink: page.level === 'full' });
});

pagesRoutes.put('/:id/share', async (c) => {
  const u = me(c);
  const input = await body(
    c,
    z.object({
      enabled: z.boolean(),
      subpages: z.boolean().optional(),
      indexing: z.boolean().optional(),
      // 公開URLの末尾（/share/<slug>）を任意の文字列にする
      slug: z.string().trim().optional(),
    }),
  );
  const page = await requirePage(c.req.param('id'), u, { need: 'full' });
  let customSlug: string | undefined;
  if (input.slug !== undefined && input.slug !== page.public_slug) {
    if (!SLUG_RE.test(input.slug)) fail(400, 'URL には英数字・ハイフン・アンダースコアのみ使えます（3〜64文字）');
    const taken = await get('SELECT 1 FROM pages WHERE public_slug = ? AND id != ?', input.slug, page.id);
    if (taken) fail(409, 'この URL は既に使われています');
    customSlug = input.slug;
  }
  const { publishPolicy } = await getSettings();
  if (input.enabled) {
    if (publishPolicy === 'disabled') fail(403, '外部公開は管理者によって無効化されています');
    if (publishPolicy === 'admins' && u.role !== 'admin') fail(403, '外部公開できるのは管理者のみです');
  }
  const slug = customSlug ?? page.public_slug ?? randomBytes(9).toString('base64url');
  const t = now();
  await batch([
    sql(
      `UPDATE pages SET public_slug = ?, public_enabled = ?, public_subpages = ?, public_indexing = ?,
         published_at = CASE WHEN ? = 1 AND public_enabled = 0 THEN ? ELSE published_at END,
         published_by = CASE WHEN ? = 1 AND public_enabled = 0 THEN ? ELSE published_by END
       WHERE id = ?`,
      slug,
      input.enabled ? 1 : 0,
      (input.subpages ?? !!page.public_subpages) ? 1 : 0,
      (input.indexing ?? !!page.public_indexing) ? 1 : 0,
      input.enabled ? 1 : 0,
      t,
      input.enabled ? 1 : 0,
      u.id,
      page.id,
    ),
    ...(input.enabled !== !!page.public_enabled
      ? [await auditStmtAsync(c, { id: u.id, username: u.username }, input.enabled ? 'page.publish' : 'page.unpublish', { type: 'page', id: page.id, name: page.title || '無題' })]
      : []),
  ]);
  const updated = (await findPage(page.id, u))!;
  const { publishPolicy: policy } = await getSettings();
  return c.json({ ...(await shareInfo(updated)), canPublish: policy === 'everyone' || (policy === 'admins' && u.role === 'admin'), canEditLink: true });
});

// ---- ページの共有（メンバーごとの閲覧／編集権限） ----

pagesRoutes.get('/:id/access', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u);
  // 祖先（このページを含む）に付いている共有を集める
  const fullChain = await all<{ id: string; title: string; visibility: string; workspace_access: string; restricted: number; depth: number }>(
    `WITH RECURSIVE anc(id, parent_id, depth) AS (
       SELECT id, parent_id, 0 FROM pages WHERE id = ?
       UNION ALL SELECT p.id, p.parent_id, anc.depth + 1 FROM pages p JOIN anc ON p.id = anc.parent_id
     ) SELECT p.id, p.title, p.visibility, p.workspace_access, p.restricted, anc.depth FROM anc JOIN pages p ON p.id = anc.id ORDER BY anc.depth`,
    page.id,
  );
  // 「招待した人のみ」のページより上からは引き継がない
  const stop = fullChain.findIndex((x) => x.restricted);
  const chain = stop >= 0 ? fullChain.slice(0, stop + 1) : fullChain;
  const parentHasAccess = fullChain.some((x) => x.depth > 0 && x.visibility === 'workspace') ||
    (await get(
      `SELECT 1 FROM page_shares WHERE page_id IN (SELECT value FROM json_each(?1))
       UNION ALL SELECT 1 FROM page_group_shares WHERE page_id IN (SELECT value FROM json_each(?1)) LIMIT 1`,
      JSON.stringify(fullChain.filter((x) => x.depth > 0).map((x) => x.id)),
    ));
  const shares = await all<UserRow & { page_id: string; permission: 'view' | 'edit' }>(
    `SELECT u.*, s.page_id, s.permission FROM page_shares s JOIN users u ON u.id = s.user_id
     WHERE s.page_id IN (SELECT value FROM json_each(?)) ORDER BY s.created_at`,
    JSON.stringify(chain.map((x) => x.id)),
  );
  const groupShares = await all<{ id: string; name: string; page_id: string; permission: 'view' | 'edit'; members: number }>(
    `SELECT g.id, g.name, s.page_id, s.permission, (SELECT COUNT(*) FROM user_group_members WHERE group_id = g.id) AS members
     FROM page_group_shares s JOIN user_groups g ON g.id = s.group_id
     WHERE s.page_id IN (SELECT value FROM json_each(?)) ORDER BY g.name`,
    JSON.stringify(chain.map((x) => x.id)),
  );
  const owner = await get<UserRow>('SELECT * FROM users WHERE id = ?', page.owner_id);
  const inheritedWorkspace = chain.find((x) => x.depth > 0 && x.visibility === 'workspace');
  const title = (id: string) => chain.find((x) => x.id === id)?.title || '無題';
  const canManage = page.level === 'full';
  // 招待できる相手：すべての有効なアカウント。ワークスペース外の人は、このページ以下だけを見られる「ゲスト」になる
  const members = canManage
    ? await all<UserRow & { is_member: number }>(
        `SELECT u.*, (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = ? AND m.user_id = u.id) AS is_member
         FROM users u WHERE u.status != 'disabled' ORDER BY u.display_name`,
        page.workspace_id,
      )
    : [];
  return c.json({
    canManage,
    myAccess: page.level,
    visibility: page.visibility,
    workspaceAccess: page.workspace_access,
    restricted: !!page.restricted,
    // 親ページに共有があるか（「招待した人のみ」に切り替える意味があるか）
    canRestrict: !!page.parent_id && !!parentHasAccess,
    inheritedWorkspace: inheritedWorkspace
      ? { pageId: inheritedWorkspace.id, title: inheritedWorkspace.title || '無題', access: inheritedWorkspace.workspace_access }
      : null,
    owner: owner ? publicUser(owner) : null,
    shares: await Promise.all(
      shares
        .filter((s) => s.page_id === page.id)
        .map(async (s) => ({ user: publicUser(s), permission: s.permission, guest: !(await membership(page.workspace_id, s.id)) })),
    ),
    inheritedShares: shares
      .filter((s) => s.page_id !== page.id)
      .map((s) => ({ user: publicUser(s), permission: s.permission, fromPageId: s.page_id, fromTitle: title(s.page_id) })),
    members: members.map((m) => ({ ...publicUser(m), isMember: !!m.is_member })),
    groupShares: groupShares
      .filter((g) => g.page_id === page.id)
      .map((g) => ({ group: { id: g.id, name: g.name, memberCount: g.members }, permission: g.permission })),
    inheritedGroupShares: groupShares
      .filter((g) => g.page_id !== page.id)
      .map((g) => ({ group: { id: g.id, name: g.name, memberCount: g.members }, permission: g.permission, fromPageId: g.page_id, fromTitle: title(g.page_id) })),
    groups: canManage
      ? await all<{ id: string; name: string; members: number }>(
          'SELECT g.id, g.name, (SELECT COUNT(*) FROM user_group_members WHERE group_id = g.id) AS members FROM user_groups g ORDER BY g.name',
        ).then((rows) => rows.map((g) => ({ id: g.id, name: g.name, memberCount: g.members })))
      : [],
  });
});

/** 「ワークスペースの全員」への共有と、その権限 */
pagesRoutes.put('/:id/access/general', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u, { need: 'full' });
  const input = await body(
    c,
    z.object({
      visibility: z.enum(['workspace', 'private']).optional(),
      workspaceAccess: z.enum(['view', 'edit']).optional(),
      restricted: z.boolean().optional(),
    }),
  );
  // 公開範囲はサブページにもまとめて適用する（子に残った「全員に共有」で見えてしまわないように）
  const ids = JSON.stringify(await subtreeIds(page.id));
  // 広げる変更（全員に共有・全員が編集）は、招待制の子には広げない
  const wideIds = JSON.stringify(await widenableSubtreeIds(page.id));
  const visibility = input.restricted ? 'private' : input.visibility;
  await batch([
    sql(
      'UPDATE pages SET workspace_access = COALESCE(?, workspace_access), restricted = COALESCE(?, restricted) WHERE id = ?',
      input.workspaceAccess ?? null,
      input.restricted === undefined ? null : input.restricted ? 1 : 0,
      page.id,
    ),
    ...(visibility ? [sql('UPDATE pages SET visibility = ? WHERE id IN (SELECT value FROM json_each(?))', visibility, visibility === 'private' ? ids : wideIds)] : []),
    ...(input.workspaceAccess ? [sql('UPDATE pages SET workspace_access = ? WHERE id IN (SELECT value FROM json_each(?))', input.workspaceAccess, wideIds)] : []),
    await auditStmtAsync(c, { id: u.id, username: u.username }, 'page.share', { type: 'page', id: page.id, name: page.title || '無題' }, input),
  ]);
  return c.json({ ok: true });
});

/** グループへの共有（permission: null で解除） */
pagesRoutes.put('/:id/access/groups/:groupId', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u, { need: 'full' });
  const input = await body(c, z.object({ permission: z.enum(['view', 'edit']).nullable() }));
  const group = await get<{ id: string; name: string }>('SELECT id, name FROM user_groups WHERE id = ?', c.req.param('groupId'));
  if (!group) fail(404, 'グループが見つかりません');
  await batch([
    input.permission
      ? sql(
          `INSERT INTO page_group_shares (page_id, group_id, permission, created_by, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(page_id, group_id) DO UPDATE SET permission = excluded.permission`,
          page.id,
          group.id,
          input.permission,
          u.id,
          now(),
        )
      : sql('DELETE FROM page_group_shares WHERE page_id = ? AND group_id = ?', page.id, group.id),
    await auditStmtAsync(c, { id: u.id, username: u.username }, input.permission ? 'page.share' : 'page.unshare', { type: 'page', id: page.id, name: page.title || '無題' }, {
      group: group.name,
      permission: input.permission,
    }),
  ]);
  return c.json({ ok: true });
});

/** メンバーごとの権限（permission: null で共有を解除） */
pagesRoutes.put('/:id/access/users/:userId', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u, { need: 'full' });
  const input = await body(c, z.object({ permission: z.enum(['view', 'edit']).nullable() }));
  const target = c.req.param('userId');
  const result = await setShare(c, u, page, target, input.permission);
  return c.json(result);
});

export async function setShare(
  c: Parameters<typeof me>[0],
  actor: SessionUser,
  page: Pick<PageRow, 'id' | 'title' | 'workspace_id'>,
  userId: string,
  permission: 'view' | 'edit' | null,
) {
  const target = await get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
  if (!target) fail(404, 'ユーザーが見つかりません');
  if (permission && target.status === 'disabled') fail(400, '無効化されたアカウントには共有できません');
  const guest = !(await membership(page.workspace_id, userId));
  await batch([
    permission
      ? sql(
          `INSERT INTO page_shares (page_id, user_id, permission, created_by, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(page_id, user_id) DO UPDATE SET permission = excluded.permission`,
          page.id,
          userId,
          permission,
          actor.id,
          now(),
        )
      : sql('DELETE FROM page_shares WHERE page_id = ? AND user_id = ?', page.id, userId),
    await auditStmtAsync(c, { id: actor.id, username: actor.username }, permission ? 'page.share' : 'page.unshare', { type: 'page', id: page.id, name: page.title || '無題' }, {
      member: target.username,
      permission,
      guest,
    }),
  ]);
  return { ok: true };
}

/** ページを移動（親の変更）。ルートへ移動する場合は公開範囲も指定できる */
pagesRoutes.post('/:id/move', async (c) => {
  const u = me(c);
  const input = await body(
    c,
    z.object({
      parentId: z.string().nullable(),
      visibility: z.enum(['workspace', 'private']).optional(),
    }),
  );
  const page = await requirePage(c.req.param('id'), u, { need: 'edit' });
  const ids = await subtreeIds(page.id);
  let parent: Awaited<ReturnType<typeof requirePage>> | null = null;
  if (input.parentId) {
    if (ids.includes(input.parentId)) fail(400, 'ページを自分自身のサブページへは移動できません');
    parent = await requirePage(input.parentId, u, { need: 'edit' });
    if (parent.workspace_id !== page.workspace_id) fail(400, '別のワークスペースのページの下には移動できません');
  }
  const target = parent;
  const intoGithub = target?.github_kind === 'dir' || target?.github_kind === 'root';
  if (target && (target.github_kind === 'md' || target.github_kind === 'file')) fail(400, 'GitHub のファイルのページの下には移動できません（フォルダの下へ移動してください）');
  if (page.github_kind === 'root') fail(409, 'リポジトリのページは移動できません');
  let githubAfterMove: (() => Promise<void>) | null = null;
  let needsMarkdown = false;
  if (page.github_kind && intoGithub) {
    // GitHub のフォルダの間の移動：GitHub 上でも場所を変える
    if (page.github_path) {
      const link = await getLink(page.workspace_id);
      if (!link) fail(400, 'GitHub と連携していません');
      const want = await desiredGithubPath(link, { ...page, parent_id: input.parentId });
      if (want && want !== page.github_path) githubAfterMove = () => moveGithubPath(link, page.github_path!, want);
    }
  } else if (page.github_kind && !intoGithub) {
    // GitHub の外へ：Markdown は GitHub から削除して普通のページにする（ファイル・フォルダは中身を持たないので不可）
    if (page.github_kind !== 'md') fail(409, 'GitHub のファイルやフォルダは、GitHub のフォルダの中でだけ移動できます');
    if (page.github_path) {
      const link = await getLink(page.workspace_id);
      if (link) {
        const r = await deleteGithubFile(link, page.github_path, page.github_sha);
        if (r === 'conflict') fail(409, 'ほかの場所でファイルが更新されています。少し待ってから（同期のあとで）もう一度移動してください');
      }
    }
    await run(`UPDATE pages SET github_kind = NULL, github_path = NULL, github_sha = NULL, github_dirty = 0, source_md = NULL WHERE id = ?`, page.id);
  } else if (!page.github_kind && intoGithub) {
    // 普通のページを GitHub のフォルダへ：Markdown のファイルとして追加する（本文の Markdown は画面側で作って送る）
    if (ids.length > 1) fail(400, 'サブページのあるページは GitHub のフォルダへ移動できません（Markdown のファイルにはサブページを持たせられないため）');
    await run(`UPDATE pages SET github_kind = 'md', github_path = NULL, github_sha = NULL, github_dirty = 1, source_md = NULL WHERE id = ?`, page.id);
    needsMarkdown = true;
  }
  let visibility = input.visibility ?? (parent ? parent.visibility : page.visibility);
  if (visibility !== page.visibility) {
    if (page.level !== 'full') fail(403, '共有範囲を変更できるのはページの作成者または管理者のみです');
  }
  if (!input.parentId && visibility === 'private' && page.visibility !== 'private') {
    const ws = await get<{ private_pages: number }>('SELECT private_pages FROM workspaces WHERE id = ?', page.workspace_id);
    if (!ws?.private_pages) fail(403, 'このワークスペースでは「プライベート」のページは使えません（ワークスペースの設定でオンにできます）');
  }
  // 作成者・管理者以外は、移動によってページ（とその配下）を見られる人を増やせない
  if (page.level !== 'full' && !page.restricted && (input.parentId ?? null) !== (page.parent_id ?? null)) {
    const [before, after] = await Promise.all([inheritedPrincipals(page.parent_id), inheritedPrincipals(input.parentId)]);
    after.delete(`owner:${page.owner_id}`); // ページの作成者は元から見られる
    if ([...after].some((x) => !before.has(x))) {
      fail(403, '移動先ではこのページを見られる人が増えるため、移動できるのはページの作成者または管理者のみです');
    }
  }
  await batch([
    sql(
      'UPDATE pages SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?',
      input.parentId,
      await nextPosition(input.parentId, visibility, u.id, page.workspace_id),
      now(),
      page.id,
    ),
    // 全員に共有の場所へ移すときは、招待制の子には広げない（自分だけの場所へ移すときは全部に適用する）
    sql(`UPDATE pages SET visibility = ? WHERE id IN (SELECT value FROM json_each(?))`, visibility, JSON.stringify(visibility === 'private' ? ids : await widenableSubtreeIds(page.id))),
  ]);
  if (githubAfterMove) {
    try {
      await githubAfterMove();
    } catch (e) {
      // GitHub に反映できなければ、元の場所に戻す
      await run('UPDATE pages SET parent_id = ? WHERE id = ?', page.parent_id, page.id);
      throw e;
    }
  }
  return c.json({ ok: true, needsMarkdown });
});

/** 兄弟ページ内での並び替え */
pagesRoutes.post('/:id/reorder', async (c) => {
  const u = me(c);
  const input = await body(c, z.object({ beforeId: z.string().nullable() }));
  const page = await requirePage(c.req.param('id'), u, { need: 'edit' });
  const siblings = (
    page.parent_id
      ? await all<{ id: string }>(
          `SELECT id FROM pages WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position, created_at`,
          page.parent_id,
        )
      : await all<{ id: string }>(
          `SELECT id FROM pages WHERE parent_id IS NULL AND workspace_id = ? AND visibility = ? AND deleted_at IS NULL ORDER BY position, created_at`,
          page.workspace_id,
          page.visibility,
        )
  ).filter((s) => s.id !== page.id);
  const idx = input.beforeId ? siblings.findIndex((s) => s.id === input.beforeId) : siblings.length;
  const order = [...siblings];
  order.splice(idx < 0 ? siblings.length : idx, 0, { id: page.id });
  await batch(order.map((s, i) => sql('UPDATE pages SET position = ? WHERE id = ?', i + 1, s.id)));
  return c.json({ ok: true });
});

pagesRoutes.delete('/:id', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u, { need: 'edit' });
  if (page.github_kind === 'root') fail(409, 'リポジトリのページは削除できません（GitHub 連携を解除してください）');
  // GitHub のフォルダは、中のファイルごと GitHub から削除する
  if (page.github_kind === 'dir' && page.github_path) {
    const link = await getLink(page.workspace_id);
    if (link) {
      await deleteGithubFolder(link, page.github_path);
      await auditStmtAsync(c, { id: u.id, username: u.username }, 'github.folder.delete', { type: 'workspace', id: page.workspace_id, name: page.github_path }, { path: page.github_path }).then((st) => batch([st]));
    }
  }
  // GitHub と同期しているファイルは、GitHub からも削除する
  if ((page.github_kind === 'md' || page.github_kind === 'file') && page.github_path) {
    const link = await getLink(page.workspace_id);
    if (link) {
      const r = await deleteGithubFile(link, page.github_path, page.github_sha);
      if (r === 'conflict') fail(409, 'ほかの場所でファイルが更新されています。少し待ってから（同期のあとで）もう一度削除してください');
      await auditStmtAsync(c, { id: u.id, username: u.username }, 'github.file.delete', { type: 'workspace', id: page.workspace_id, name: page.github_path }, { path: page.github_path }).then((st) => batch([st]));
    }
  }
  const access = await workspaceAccess(page.workspace_id, u);
  const allSubtreeIds = await subtreeIds(page.id);
  const ids = allSubtreeIds.filter((id) => (access.get(id) ?? 'none') !== 'none');
  const unseenIds = allSubtreeIds.filter((id) => (access.get(id) ?? 'none') === 'none');

  const stmts: Stmt[] = [
    sql(
      `UPDATE pages SET deleted_at = ?, deleted_by = ? WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
      now(),
      u.id,
      JSON.stringify(ids),
    ),
  ];
  if (unseenIds.length > 0) {
    stmts.push(
      sql(
        `UPDATE pages SET parent_id = ? WHERE deleted_at IS NULL AND parent_id IN (SELECT value FROM json_each(?)) AND id IN (SELECT value FROM json_each(?))`,
        page.parent_id,
        JSON.stringify(ids),
        JSON.stringify(unseenIds),
      ),
    );
  }
  await batch(stmts);
  return c.json({ ok: true });
});

pagesRoutes.post('/:id/restore', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u, { allowDeleted: true, need: 'edit' });
  if (!page.deleted_at) return c.json({ ok: true });
  if (page.github_kind === 'file' || page.github_kind === 'dir') {
    fail(409, 'GitHub から削除したファイル・フォルダは、アプリからは元に戻せません（GitHub の履歴から復元してください）');
  }
  const access = await workspaceAccess(page.workspace_id, u);
  const allSubtreeIds = await subtreeIds(page.id);
  const ids = allSubtreeIds.filter((id) => (access.get(id) ?? 'none') !== 'none');
  const stmts = [
    sql(
      `UPDATE pages SET deleted_at = NULL, deleted_by = NULL WHERE deleted_at = ? AND id IN (SELECT value FROM json_each(?))`,
      page.deleted_at,
      JSON.stringify(ids),
    ),
  ];
  // GitHub から削除した Markdown は、元に戻したら GitHub にもう一度作る
  if (page.github_kind === 'md' && page.github_path) {
    stmts.push(sql('UPDATE pages SET github_sha = NULL, github_dirty = 1 WHERE id = ?', page.id));
  }
  // 親がゴミ箱にある・存在しない場合は最上位に戻す
  if (page.parent_id) {
    const parent = await get<{ deleted_at: number | null }>('SELECT deleted_at FROM pages WHERE id = ?', page.parent_id);
    if (!parent || parent.deleted_at) {
      stmts.push(sql('UPDATE pages SET parent_id = NULL, position = ? WHERE id = ?', await nextPosition(null, page.visibility, u.id, page.workspace_id), page.id));
    }
  }
  await batch(stmts);
  return c.json({ ok: true });
});

pagesRoutes.delete('/:id/permanent', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u, { allowDeleted: true, need: 'full' });
  if (!page.deleted_at) fail(400, '先にゴミ箱へ移動してください');
  await batch([
    sql('UPDATE pages SET parent_id = ? WHERE parent_id = ?', page.parent_id, page.id),
    sql('DELETE FROM pages WHERE id = ?', page.id),
  ]);
  return c.json({ ok: true });
});

// ---- リアルタイム共同編集（Workers の Durable Object に接続する） ----

type RoomNamespace = { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } };

/** そのページを開いている人に知らせる（コメントが変わったなど）。共同編集の部屋がない環境では何もしない */
async function notifyRoom(c: Context<AppEnv>, pageId: string, kind: string) {
  const ns = (c.env as { PAGE_ROOM?: RoomNamespace } | undefined)?.PAGE_ROOM;
  if (!ns) return;
  try {
    await ns.get(ns.idFromName(pageId)).fetch(new Request('https://room/signal', { headers: { 'x-room-signal': JSON.stringify({ kind }) } }));
  } catch {
    // 知らせられなくても、相手は定期的に読み直す
  }
}

pagesRoutes.get('/:id/collab', async (c) => {
  const u = me(c);
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') fail(426, 'WebSocket で接続してください');
  // 他サイトからの WebSocket 接続（クッキーの悪用）を防ぐ
  if (c.req.header('origin') !== cfg.ORIGIN) fail(403, '不正なリクエスト元です');
  const page = await requirePage(c.req.param('id'), u, { allowDeleted: true });
  const ns = (c.env as { PAGE_ROOM?: RoomNamespace } | undefined)?.PAGE_ROOM;
  if (!ns) fail(501, 'この環境ではリアルタイム共同編集を利用できません');
  // ?listen=1 はお知らせを受け取るだけの接続（アプリ）。編集の内容は送らない
  const listenOnly = c.req.query('listen') === '1';
  const canEdit = !listenOnly && atLeast(page.level, 'edit') && !page.locked && !page.deleted_at;
  const headers = new Headers(c.req.raw.headers);
  // サーバーの中からだけ使うお知らせのヘッダーは、外から送られても捨てる
  headers.delete('x-room-signal');
  headers.set('x-collab-user', u.id);
  headers.set('x-collab-edit', canEdit ? '1' : '0');
  headers.set('x-collab-name', encodeURIComponent(u.display_name));
  return ns.get(ns.idFromName(page.id)).fetch(new Request(c.req.raw.url, { headers }));
});

// ---- このページを開いている人 ----

const PRESENCE_TTL = 40_000;

/** 画面から定期的に呼ばれる。自分を「閲覧中」として記録し、ほかに開いている人を返す */
pagesRoutes.post('/:id/presence', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u, { allowDeleted: true });
  const sid = c.get('sessionId') ?? u.id;
  const t = now();
  await batch([
    sql(
      `INSERT INTO page_presence (page_id, session_id, user_id, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT(page_id, session_id) DO UPDATE SET last_seen = excluded.last_seen`,
      page.id,
      sid,
      u.id,
      t,
    ),
    sql('DELETE FROM page_presence WHERE page_id = ? AND last_seen < ?', page.id, t - PRESENCE_TTL),
  ]);
  const others = await all<UserRow & { last_seen: number }>(
    `SELECT u.*, MAX(p.last_seen) AS last_seen FROM page_presence p JOIN users u ON u.id = p.user_id
     WHERE p.page_id = ? AND p.last_seen >= ? AND p.session_id != ? AND u.status = 'active'
     GROUP BY u.id ORDER BY MIN(p.last_seen)`,
    page.id,
    t - PRESENCE_TTL,
    sid,
  );
  return c.json({ viewers: others.map((o) => ({ ...publicUser(o), self: o.id === u.id })) });
});

pagesRoutes.delete('/:id/presence', async (c) => {
  await run('DELETE FROM page_presence WHERE page_id = ? AND session_id = ?', c.req.param('id'), c.get('sessionId') ?? me(c).id);
  return c.json({ ok: true });
});

pagesRoutes.put('/:id/favorite', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u);
  await run('INSERT OR IGNORE INTO favorites (user_id, page_id, created_at) VALUES (?, ?, ?)', u.id, page.id, now());
  return c.json({ ok: true });
});

pagesRoutes.delete('/:id/favorite', async (c) => {
  await run('DELETE FROM favorites WHERE user_id = ? AND page_id = ?', me(c).id, c.req.param('id'));
  return c.json({ ok: true });
});

/* ---------- コメント ----------
 * ページを見られる人は、誰でもコメント・返信できる。
 * 「解決」は編集できる人とコメントを書いた人、削除は書いた人とフルアクセスの人ができる。 */
type CommentRow = { id: string; thread_id: string | null; block_id: string | null; quote: string | null; body: string; author_id: string; author_name: string; resolved_at: number | null; created_at: number; updated_at: number };

pagesRoutes.get('/:id/comments', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u);
  const rows = await all<CommentRow>(
    `SELECT pc.id, pc.thread_id, pc.block_id, pc.quote, pc.body, pc.author_id, u.display_name AS author_name, pc.resolved_at, pc.created_at, pc.updated_at
     FROM page_comments pc JOIN users u ON u.id = pc.author_id WHERE pc.page_id = ? ORDER BY pc.created_at`,
    page.id,
  );
  const canEdit = atLeast(page.level, 'edit');
  const full = atLeast(page.level, 'full') || u.role === 'admin';
  return c.json({
    comments: rows.map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      blockId: r.block_id,
      quote: r.quote,
      body: r.body,
      author: { id: r.author_id, name: r.author_name },
      resolvedAt: r.resolved_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      canResolve: canEdit || r.author_id === u.id,
      canDelete: full || r.author_id === u.id,
    })),
  });
});

pagesRoutes.post('/:id/comments', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u);
  const input = await body(
    c,
    z.object({
      body: z.string().trim().min(1, 'コメントを入力してください').max(5000),
      threadId: z.string().nullable().default(null),
      blockId: z.string().max(100).nullable().default(null),
      quote: z.string().max(1000).nullable().default(null),
    }),
  );
  if (input.threadId) {
    const root = await get<{ page_id: string; thread_id: string | null }>('SELECT page_id, thread_id FROM page_comments WHERE id = ?', input.threadId);
    if (!root || root.page_id !== page.id || root.thread_id) fail(404, 'コメントが見つかりません');
  }
  const id = newId();
  const t = now();
  await run(
    `INSERT INTO page_comments (id, page_id, thread_id, block_id, quote, body, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    page.id,
    input.threadId,
    input.threadId ? null : input.blockId,
    input.threadId ? null : await encryptText(input.quote),
    await encryptText(input.body),
    u.id,
    t,
    t,
  );
  // 返信したら、そのスレッドは未解決に戻す
  if (input.threadId) await run('UPDATE page_comments SET resolved_at = NULL, resolved_by = NULL WHERE id = ?', input.threadId);
  await notifyRoom(c, page.id, 'comments');
  return c.json({ id }, 201);
});

async function requireComment(c: Context<AppEnv>) {
  const u = me(c);
  const page = await requirePage(c.req.param('id') ?? '', u);
  const row = await get<{ id: string; author_id: string; thread_id: string | null }>(
    'SELECT id, author_id, thread_id FROM page_comments WHERE id = ? AND page_id = ?',
    c.req.param('commentId') ?? '',
    page.id,
  );
  if (!row) fail(404, 'コメントが見つかりません');
  return { u, page, row };
}

pagesRoutes.patch('/:id/comments/:commentId', async (c) => {
  const { u, page, row } = await requireComment(c);
  const input = await body(c, z.object({ resolved: z.boolean().optional(), body: z.string().trim().min(1).max(5000).optional() }));
  if (input.body !== undefined) {
    if (row.author_id !== u.id) fail(403, '自分のコメントだけ書き直せます');
    await run('UPDATE page_comments SET body = ?, updated_at = ? WHERE id = ?', await encryptText(input.body), now(), row.id);
  }
  if (input.resolved !== undefined) {
    if (row.thread_id) fail(400, '解決はスレッドの最初のコメントで行います');
    if (!atLeast(page.level, 'edit') && row.author_id !== u.id) fail(403, 'このコメントを解決する権限がありません');
    await run('UPDATE page_comments SET resolved_at = ?, resolved_by = ? WHERE id = ?', input.resolved ? now() : null, input.resolved ? u.id : null, row.id);
  }
  await notifyRoom(c, page.id, 'comments');
  return c.json({ ok: true });
});

pagesRoutes.delete('/:id/comments/:commentId', async (c) => {
  const { u, page, row } = await requireComment(c);
  if (row.author_id !== u.id && !atLeast(page.level, 'full') && u.role !== 'admin') fail(403, 'このコメントを削除する権限がありません');
  await run('DELETE FROM page_comments WHERE id = ? OR thread_id = ?', row.id, row.id);
  await notifyRoom(c, page.id, 'comments');
  return c.json({ ok: true });
});

/* ---------- データベース ----------
 * ページをデータベースにすると、子ページが行になる。列の定義（schema）は編集できる人が変えられ、
 * 行の値はその行（子ページ）を編集できる人が変えられる。 */
const DB_TYPES = ['text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url', 'person'] as const;
const dbOption = z.object({ id: z.string().max(40), name: z.string().max(100), color: z.string().max(20) });
const dbProp = z.object({ id: z.string().max(40), name: z.string().max(100), type: z.enum(DB_TYPES), options: z.array(dbOption).max(100).optional() });
const dbView = z.object({
  id: z.string().max(40),
  name: z.string().max(100),
  type: z.enum(['table', 'board', 'calendar', 'gallery']),
  sort: z.object({ prop: z.string().max(40), dir: z.enum(['asc', 'desc']) }).nullable().optional(),
  filters: z.array(z.object({ prop: z.string().max(40), op: z.string().max(20), value: z.unknown().optional() })).max(20).optional(),
  groupBy: z.string().max(40).nullable().optional(),
  dateProp: z.string().max(40).nullable().optional(),
  hidden: z.array(z.string().max(40)).max(100).optional(),
  widths: z.record(z.string(), z.number()).optional(),
});
const dbSchema = z.object({
  props: z.array(dbProp).max(60),
  views: z.array(dbView).min(1).max(20),
  /** データベースの用途（books：読書記録。ISBN・バーコードから本を追加できる／study：勉強記録。勉強時間を集計できる） */
  kind: z.enum(['books', 'study']).optional(),
});
type DbSchema = z.infer<typeof dbSchema>;

const defaultDbSchema = (): DbSchema => ({
  props: [
    { id: 'status', name: 'ステータス', type: 'select', options: [
      { id: 'todo', name: '未着手', color: 'gray' },
      { id: 'doing', name: '進行中', color: 'blue' },
      { id: 'done', name: '完了', color: 'green' },
    ] },
    { id: 'date', name: '日付', type: 'date' },
    { id: 'tags', name: 'タグ', type: 'multi_select', options: [] },
  ],
  views: [
    { id: 'table', name: '表', type: 'table', sort: null, filters: [] },
    { id: 'board', name: 'ボード', type: 'board', groupBy: 'status', filters: [] },
    { id: 'calendar', name: 'カレンダー', type: 'calendar', dateProp: 'date', filters: [] },
  ],
});

async function requireDatabase(c: Context<AppEnv>, need: Level = 'view') {
  const u = me(c);
  const page = await requirePage(c.req.param('id') ?? '', u, { need });
  if (!page.is_database) fail(404, 'このページはデータベースではありません');
  return { u, page };
}

pagesRoutes.get('/:id/database', async (c) => {
  const { u, page } = await requireDatabase(c);
  const [row, children, access, members] = await Promise.all([
    get<{ schema: string }>('SELECT schema FROM databases WHERE page_id = ?', page.id),
    all<{ id: string; title: string; icon: string | null; cover: string | null; created_at: number; updated_at: number; position: number }>(
      'SELECT id, title, icon, cover, created_at, updated_at, position FROM pages WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position',
      page.id,
    ),
    workspaceAccess(page.workspace_id, u),
    all<{ id: string; name: string }>(
      'SELECT u.id, u.display_name AS name FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY u.display_name',
      page.workspace_id,
    ),
  ]);
  const rows = children.filter((r) => (access.get(r.id) ?? 'none') !== 'none');
  const values = new Map<string, Record<string, unknown>>();
  // 行が多くても 1 回の問い合わせに収まるように分けて読む
  for (let i = 0; i < rows.length; i += 90) {
    const part = rows.slice(i, i + 90);
    const vals = await all<{ row_id: string; data: string }>(
      `SELECT row_id, data FROM db_values WHERE row_id IN (${part.map(() => '?').join(',')})`,
      ...part.map((r) => r.id),
    );
    for (const v of vals) {
      try {
        values.set(v.row_id, JSON.parse(v.data));
      } catch {
        /* 壊れた値は空として扱う */
      }
    }
  }
  return c.json({
    schema: row ? JSON.parse(row.schema) : defaultDbSchema(),
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title,
      icon: r.icon,
      cover: r.cover,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      values: values.get(r.id) ?? {},
      canEdit: atLeast(access.get(r.id)!, 'edit'),
    })),
    members,
    canEdit: atLeast(page.level, 'edit'),
  });
});

/** ページをデータベースにする（子ページはそのまま行になる） */
pagesRoutes.post('/:id/database', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u, { need: 'edit' });
  if (page.github_kind) fail(400, 'GitHub と同期しているページはデータベースにできません');
  const exists = await get('SELECT 1 FROM databases WHERE page_id = ?', page.id);
  await batch([
    sql('UPDATE pages SET is_database = 1 WHERE id = ?', page.id),
    ...(exists ? [] : [sql('INSERT INTO databases (page_id, schema, updated_at) VALUES (?, ?, ?)', page.id, await encryptText(JSON.stringify(defaultDbSchema())), now())]),
  ]);
  return c.json({ ok: true });
});

/** データベースをやめて、ふつうのページに戻す（列の定義と値は残しておき、もう一度データベースにすると戻る） */
pagesRoutes.delete('/:id/database', async (c) => {
  const { page } = await requireDatabase(c, 'edit');
  await run('UPDATE pages SET is_database = 0 WHERE id = ?', page.id);
  return c.json({ ok: true });
});

pagesRoutes.put('/:id/database/schema', async (c) => {
  const { page } = await requireDatabase(c, 'edit');
  const schema = await body(c, dbSchema);
  if (new Set(schema.props.map((p) => p.id)).size !== schema.props.length) fail(400, '列の ID が重なっています');
  await run(
    'INSERT INTO databases (page_id, schema, updated_at) VALUES (?, ?, ?) ON CONFLICT(page_id) DO UPDATE SET schema = excluded.schema, updated_at = excluded.updated_at',
    page.id,
    await encryptText(JSON.stringify(schema)),
    now(),
  );
  return c.json({ ok: true });
});

/** 行の値を変える（送った列だけ。null はその列を空にする） */
pagesRoutes.patch('/:id/database/rows/:rowId', async (c) => {
  const u = me(c);
  const dbId = c.req.param('id');
  const rowPage = await requirePage(c.req.param('rowId'), u, { need: 'edit' });
  if (rowPage.parent_id !== dbId) fail(400, 'この行はこのデータベースのものではありません');
  const input = await body(c, z.object({ values: z.record(z.string().max(40), z.unknown()) }));
  const cur = await get<{ data: string }>('SELECT data FROM db_values WHERE row_id = ?', rowPage.id);
  const data: Record<string, unknown> = cur ? JSON.parse(cur.data) : {};
  for (const [k, v] of Object.entries(input.values)) {
    if (v === null || v === '' || (Array.isArray(v) && !v.length)) delete data[k];
    else data[k] = v;
  }
  const json = JSON.stringify(data);
  if (json.length > 50_000) fail(400, '値が大きすぎます');
  const t = now();
  await run(
    'INSERT INTO db_values (row_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(row_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
    rowPage.id,
    await encryptText(json),
    t,
  );
  return c.json({ ok: true, values: data });
});

/** サブページの一覧に出す、最初の数行（見られるページだけ） */
pagesRoutes.get('/:id/previews', async (c) => {
  const u = me(c);
  const page = await requirePage(c.req.param('id'), u);
  const [rows, access] = await Promise.all([
    all<{ id: string; content_text: string; updated_at: number; cover: string | null }>(
      'SELECT id, content_text, updated_at, cover FROM pages WHERE parent_id = ? AND deleted_at IS NULL',
      page.id,
    ),
    workspaceAccess(page.workspace_id, u),
  ]);
  return c.json({
    previews: rows
      .filter((r) => (access.get(r.id) ?? 'none') !== 'none')
      .map((r) => ({ id: r.id, snippet: r.content_text.replace(/\s+/g, ' ').trim().slice(0, 160), updatedAt: r.updated_at, cover: r.cover })),
  });
});
