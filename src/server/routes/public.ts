import { Hono } from 'hono';
import { all, get } from '../db.ts';
import { runtime } from '../runtime.ts';
import type { AppEnv } from '../session.ts';
import { getSettings } from '../settings.ts';
import { fail } from '../util.ts';
import type { PageRow } from './pages.ts';

/**
 * Web に公開されたページの閲覧用 API（ログイン不要・読み取り専用）。
 * /share/<slug> で公開されたページと、「サブページも公開」が有効ならその配下のページを返す。
 */
export const publicRoutes = new Hono<AppEnv>();

publicRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

async function publishedRoot(slug: string) {
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(slug)) fail(404, 'ページが見つかりません');
  if ((await getSettings()).publishPolicy === 'disabled') fail(404, 'ページが見つかりません');
  const root = await get<PageRow>('SELECT * FROM pages WHERE public_slug = ? AND public_enabled = 1 AND deleted_at IS NULL', slug);
  if (!root) fail(404, 'ページが見つかりません');
  return root;
}

/**
 * 公開範囲に含まれるページ（ルート + サブページ公開時はゴミ箱にない子孫）。
 * 「招待した人のみ」のページ、公開したページと見える範囲が違うページ（ワークスペース内の非公開ページなど）、
 * 他の人の非公開ページは、その配下も含めて公開しない。
 */
async function visibleTree(root: PageRow) {
  if (!root.public_subpages) return [root];
  return all<PageRow>(
    `WITH RECURSIVE sub(id) AS (
       SELECT ? UNION ALL
       SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id
       WHERE p.deleted_at IS NULL AND p.restricted = 0 AND p.visibility = ? AND (p.visibility <> 'private' OR p.owner_id = ?)
     ) SELECT pages.* FROM sub JOIN pages ON pages.id = sub.id ORDER BY pages.position, pages.created_at`,
    root.id,
    root.visibility,
    root.owner_id,
  );
}

function publicPage(p: PageRow) {
  return {
    id: p.id,
    parentId: p.parent_id,
    title: p.title,
    icon: p.icon,
    cover: p.cover,
    coverPosition: p.cover_position,
    fullWidth: !!p.full_width,
    smallText: !!p.small_text,
    font: p.font,
    slideTheme: p.slide_theme ?? null,
    content: JSON.parse(p.content),
    updatedAt: p.updated_at,
  };
}

async function respond(slug: string, pageId: string | null) {
  const root = await publishedRoot(slug);
  const tree = await visibleTree(root);
  const page = pageId ? tree.find((p) => p.id === pageId) : root;
  if (!page) fail(404, 'ページが見つかりません');
  return {
    ...(await get<{ name: string; slug: string | null }>('SELECT name, slug FROM workspaces WHERE id = ?', root.workspace_id).then((w) => ({
      workspaceName: w?.name ?? '',
      workspaceSlug: w?.slug ?? root.workspace_id,
    }))),
    slug: root.public_slug,
    rootId: root.id,
    indexing: !!root.public_indexing,
    page: publicPage(page),
    tree: tree.map((p) => ({ id: p.id, parentId: p.id === root.id ? null : p.parent_id, title: p.title, icon: p.icon })),
  };
}

publicRoutes.get('/:slug', async (c) => {
  const data = await respond(c.req.param('slug'), null);
  if (!data.indexing) c.header('X-Robots-Tag', 'noindex, nofollow');
  return c.json(data);
});

publicRoutes.get('/:slug/pages/:pageId', async (c) => {
  const data = await respond(c.req.param('slug'), c.req.param('pageId'));
  if (!data.indexing) c.header('X-Robots-Tag', 'noindex, nofollow');
  return c.json(data);
});

/** 公開ページ内で使われている画像・ファイルだけを配信する */
publicRoutes.get('/:slug/files/:fileId', async (c) => {
  const fileId = c.req.param('fileId');
  if (!/^[0-9a-f-]{36}$/.test(fileId)) fail(404, 'ファイルが見つかりません');
  const root = await publishedRoot(c.req.param('slug'));
  const tree = await visibleTree(root);
  const ref = `/api/files/${fileId}`;
  if (!tree.some((p) => p.content.includes(ref) || p.cover === ref)) fail(404, 'ファイルが見つかりません');
  const pageIds = tree.map((p) => p.id);
  const inPageFiles =
    pageIds.length > 0 &&
    (await get(
      `SELECT 1 FROM page_files WHERE file_id = ? AND page_id IN (${pageIds.map(() => '?').join(',')}) LIMIT 1`,
      fileId,
      ...pageIds,
    ));
  if (!inPageFiles) fail(404, 'ファイルが見つかりません');
  const row = await get<{ filename: string; mime: string; size: number }>('SELECT filename, mime, size FROM files WHERE id = ?', fileId);
  const stream = row ? await runtime().files?.get(fileId) : null;
  if (!row || !stream) fail(404, 'ファイルが見つかりません');
  const safeInline = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm)|audio\/(mpeg|ogg|wav|webm)|application\/pdf)$/.test(row.mime);
  return new Response(stream, {
    headers: {
      'Content-Type': safeInline || row.mime === 'image/svg+xml' ? row.mime : 'application/octet-stream',
      'Content-Length': String(row.size),
      'Content-Disposition': `${safeInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      ...(row.mime === 'application/pdf' ? {} : { 'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox" }),
    },
  });
});
