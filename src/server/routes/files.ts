import { Hono } from 'hono';
import { canReadFile } from '../pageFiles.ts';
import { bodyLimit } from 'hono/body-limit';
import { cfg } from '../config.ts';
import { encryptionEnabled, encryptText } from '../crypto.ts';
import { all, get, run } from '../db.ts';
import { runtime } from '../runtime.ts';
import { me, requireAuth, type AppEnv } from '../session.ts';
import { deleteFile } from '../storage.ts';
import { fail, newId, now } from '../util.ts';

export { deleteFile };

// ブラウザでそのまま表示してよい形式（それ以外はダウンロード扱い）
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-m4v',
  'video/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'audio/opus',
  'audio/flac',
  'audio/x-flac',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'application/pdf',
  'text/plain',
]);

export const filesRoutes = new Hono<AppEnv>();
filesRoutes.use('*', requireAuth);

function store() {
  const s = runtime().files;
  if (!s) fail(500, 'ファイル保存先が設定されていません（Workers の場合は R2 バケットをバインドしてください）');
  return s;
}

filesRoutes.post(
  '/',
  (c, next) => bodyLimit({ maxSize: cfg.MAX_UPLOAD_BYTES + 64 * 1024, onError: () => fail(413, 'ファイルサイズが大きすぎます') })(c, next),
  async (c) => {
    const u = me(c);
    const form = await c.req.parseBody();
    const file = form['file'];
    if (!(file instanceof File)) fail(400, 'ファイルがありません');
    if (file.size > cfg.MAX_UPLOAD_BYTES) fail(413, 'ファイルサイズが大きすぎます');
    const id = newId();
    const data = await file.arrayBuffer();
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type.toLowerCase() : 'application/octet-stream';
    await store().put(id, data, mime);
    await run(
      'INSERT INTO files (id, owner_id, filename, mime, size, created_at, encrypted) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      u.id,
      (file.name || 'file').slice(0, 255),
      mime,
      data.byteLength,
      now(),
      encryptionEnabled() ? 1 : 0,
    );
    return c.json({ id, url: `/api/files/${id}` }, 201);
  },
);

/** まだ中の文字を記録していないファイル（前に貼ったもの）。アップロードした本人と管理者の分だけ返す */
filesRoutes.get('/needs-text', async (c) => {
  const u = me(c);
  const wsId = c.req.query('workspace') ?? '';
  const rows = await all<{ id: string; filename: string; owner_id: string | null }>(
    `SELECT DISTINCT f.id, f.filename, f.owner_id FROM files f
     JOIN page_files pf ON pf.file_id = f.id JOIN pages p ON p.id = pf.page_id
     WHERE p.workspace_id = ? AND p.deleted_at IS NULL AND f.content_text IS NULL
     ORDER BY f.created_at DESC LIMIT 400`,
    wsId,
  );
  const ext = /\.(pdf|docx|xlsx|xlsm|ods|csv|tsv|pptx|txt|text|md|markdown|log|json|ya?ml|toml|ini|xml|html?|css|js|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sql|sh|tex|bib|rst|org|adoc)$/i;
  return c.json({
    files: rows
      .filter((r) => (r.owner_id === u.id || u.role === 'admin') && ext.test(r.filename))
      .slice(0, 40)
      .map((r) => ({ id: r.id, filename: r.filename })),
  });
});

/** ファイルの中の文字を記録する（検索で使う）。アップロードした本人と管理者だけ */
filesRoutes.put('/:id/text', async (c) => {
  const id = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/.test(id)) fail(404, 'ファイルが見つかりません');
  const u = me(c);
  const row = await get<{ owner_id: string | null }>('SELECT owner_id FROM files WHERE id = ?', id);
  if (!row || (row.owner_id !== u.id && u.role !== 'admin')) fail(404, 'ファイルが見つかりません');
  const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
  if (!body || typeof body.text !== 'string') fail(400, '文字がありません');
  await run('UPDATE files SET content_text = ? WHERE id = ?', await encryptText(body.text.slice(0, 500_000)), id);
  return c.json({ ok: true });
});

filesRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/.test(id)) fail(404, 'ファイルが見つかりません');
  const row = await get<{ id: string; owner_id: string | null; filename: string; mime: string; size: number }>(
    'SELECT id, owner_id, filename, mime, size FROM files WHERE id = ?',
    id,
  );
  // 見てよいファイルか（権限がなければ、あることも知らせない）
  if (!row || !(await canReadFile(me(c), row))) fail(404, 'ファイルが見つかりません');
  const stream = await store().get(id);
  if (!stream) fail(404, 'ファイルが見つかりません');
  const inline = INLINE_TYPES.has(row.mime);
  const isSvg = row.mime === 'image/svg+xml';
  const headers: Record<string, string> = {
    'Content-Type': inline || isSvg ? row.mime : 'application/octet-stream',
    'Content-Length': String(row.size),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    // アプリ内のビューア（同じサイトの iframe）では表示できるようにする
    'X-Frame-Options': 'SAMEORIGIN',
  };
  // 直接開かれた場合にスクリプトが動かないようサンドボックス化（PDFビューアは sandbox 下で動かないため除外）
  if (row.mime !== 'application/pdf') {
    headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'";
  }
  return new Response(stream, { headers });
});
