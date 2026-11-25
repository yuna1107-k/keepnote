import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { cfg } from './config.ts';
import { adminRoutes } from './routes/admin.ts';
import { authRoutes } from './routes/auth.ts';
import { filesRoutes } from './routes/files.ts';
import { meRoutes } from './routes/me.ts';
import { pagesRoutes } from './routes/pages.ts';
import { publicRoutes } from './routes/public.ts';
import { githubRoutes } from './routes/github.ts';
import { booksRoutes } from './routes/books.ts';
import { pdfNotesRoutes } from './routes/pdfNotes.ts';
import { workspacesRoutes } from './routes/workspaces.ts';
import { groupsRoutes } from './routes/groups.ts';
import { loadSession, type AppEnv } from './session.ts';

/** API 本体（Node.js / Workers 共通） */

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    await next();
    if (c.res.status === 101) return; // WebSocket の接続はそのまま返す
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    // ファイル表示など、個別に同じサイト内での埋め込みを許可したもの以外は埋め込み禁止
    if (!c.res.headers.has('X-Frame-Options')) c.header('X-Frame-Options', 'DENY');
    if (cfg.ORIGIN.startsWith('https://')) c.header('Strict-Transport-Security', 'max-age=31536000');
  });

  // ほかのアプリからの「共有」。ふだんはサービスワーカーが受け取るので、ここに来るのはまだ準備できていないときだけ
  app.post('/share-target', (c) => c.redirect('/share-received?retry=1', 303));

  // CSRF 対策：状態を変更するリクエストは自サイトの Origin からのみ受け付ける
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      if (c.req.header('origin') !== cfg.ORIGIN) {
        return c.json({ error: '不正なリクエスト元です（ORIGIN 設定を確認してください）' }, 403);
      }
    }
    await next();
    if (c.res.status !== 101) c.header('Cache-Control', 'no-store');
  });

  app.use('/api/*', loadSession);
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/files')) return next();
    return bodyLimit({ maxSize: 10 * 1024 * 1024, onError: (c) => c.json({ error: 'リクエストが大きすぎます' }, 413) })(c, next);
  });

  app.route('/api/auth', authRoutes);
  app.route('/api/me', meRoutes);
  app.route('/api/pages', pagesRoutes);
  app.route('/api/files', filesRoutes);
  app.route('/api/admin/groups', groupsRoutes);
  app.route('/api/admin', adminRoutes);
  app.route('/api/public', publicRoutes);
  app.route('/api/workspaces', workspacesRoutes);
  app.route('/api/github', githubRoutes);
  app.route('/api/pdf-notes', pdfNotesRoutes);
  app.route('/api/books', booksRoutes);
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.all('/api/*', (c) => c.json({ error: 'Not Found' }, 404));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'サーバーエラーが発生しました' }, 500);
  });

  return app;
}
