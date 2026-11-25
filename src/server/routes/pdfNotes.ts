/** PDF のしおりとメモ（自分だけが見られる） */
import { Hono } from 'hono';
import { z } from 'zod';
import { encryptText } from '../crypto.ts';
import { all, get, run } from '../db.ts';
import { me, requireAuth, type AppEnv } from '../session.ts';
import { body, fail, now } from '../util.ts';

export const pdfNotesRoutes = new Hono<AppEnv>();
pdfNotesRoutes.use('*', requireAuth);

/** PDF を表す文字列（アプリ内の PDF の URL） */
const KEY_RE = /^\/api\/(files\/[0-9a-f-]{36}|github\/raw\/[^?#\s]{1,600})$/;
/** 1 人あたりの上限（使いすぎの防止） */
const MAX_NOTES = 5000;

pdfNotesRoutes.get('/', async (c) => {
  const u = me(c);
  const key = c.req.query('key') ?? '';
  if (!KEY_RE.test(key)) fail(400, 'PDF の指定が正しくありません');
  const rows = await all<{ page: number; bookmarked: number; memo: string | null }>(
    'SELECT page, bookmarked, memo FROM pdf_notes WHERE user_id = ? AND file_key = ? ORDER BY page',
    u.id,
    key,
  );
  return c.json({ notes: rows.map((r) => ({ page: r.page, bookmarked: !!r.bookmarked, memo: r.memo ?? '' })) });
});

pdfNotesRoutes.put('/', async (c) => {
  const u = me(c);
  const input = await body(
    c,
    z.object({ key: z.string().regex(KEY_RE), page: z.number().int().min(1).max(100_000), bookmarked: z.boolean(), memo: z.string().max(20_000) }),
  );
  if (!input.bookmarked && !input.memo.trim()) {
    await run('DELETE FROM pdf_notes WHERE user_id = ? AND file_key = ? AND page = ?', u.id, input.key, input.page);
    return c.json({ ok: true });
  }
  const exists = await get('SELECT 1 FROM pdf_notes WHERE user_id = ? AND file_key = ? AND page = ?', u.id, input.key, input.page);
  if (!exists) {
    const n = await get<{ n: number }>('SELECT COUNT(*) AS n FROM pdf_notes WHERE user_id = ?', u.id);
    if ((n?.n ?? 0) >= MAX_NOTES) fail(400, 'しおりとメモの数が上限に達しました');
  }
  await run(
    `INSERT INTO pdf_notes (user_id, file_key, page, bookmarked, memo, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, file_key, page) DO UPDATE SET bookmarked = excluded.bookmarked, memo = excluded.memo, updated_at = excluded.updated_at`,
    u.id,
    input.key,
    input.page,
    input.bookmarked ? 1 : 0,
    input.memo.trim() ? await encryptText(input.memo) : null,
    now(),
  );
  return c.json({ ok: true });
});
