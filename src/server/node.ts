/** Node.js（Docker / 自前サーバー）用のエントリポイント */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import { bootstrapAdmin } from './bootstrap.ts';
import { cfg, initConfig } from './config.ts';
import { setDb } from './db.ts';
import { createNodeDb } from './db-node.ts';
import { cleanup, encryptExistingData } from './maintenance.ts';
import { indexPageFiles } from './pageFiles.ts';
import { indexPageLinks } from './pageLinks.ts';
import { indexPageTodos } from './pageTodos.ts';
import { memoryRateLimiter, setRuntime } from './runtime.ts';
import { encryptedStore, type FileStore } from './storage.ts';
import { setDataKey } from './crypto.ts';

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const PORT = Number(env.PORT ?? 3000);
const HOST = env.HOST ?? '0.0.0.0';
const DATA_DIR = path.resolve(env.DATA_DIR ?? './data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const WEB_DIST = path.resolve(env.WEB_DIST ?? './dist/web');
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../migrations');
const TRUST_PROXY = env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1';

// 開発時は Vite (5173) 経由でアクセスする
initConfig(env, isProd ? `http://localhost:${PORT}` : 'http://localhost:5173');
setDataKey(env.DATA_KEY);
setDb(createNodeDb(path.join(DATA_DIR, 'app.db'), MIGRATIONS_DIR));

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const diskStore: FileStore = {
  async put(id, data) {
    await fs.promises.writeFile(path.join(UPLOAD_DIR, id), Buffer.from(data));
  },
  async get(id) {
    const file = path.join(UPLOAD_DIR, id);
    if (!fs.existsSync(file)) return null;
    return Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  },
  async delete(id) {
    await fs.promises.rm(path.join(UPLOAD_DIR, id), { force: true });
  },
};

setRuntime({
  name: `Node.js ${process.version}`,
  files: encryptedStore(diskStore),
  clientIp: (c) => {
    if (TRUST_PROXY) {
      const fwd = c.req.header('x-forwarded-for');
      if (fwd) return fwd.split(',')[0]!.trim();
      const real = c.req.header('x-real-ip');
      if (real) return real.trim();
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  },
  rateLimited: memoryRateLimiter(40, 60_000),
});

const app = createApp();

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// 本番環境ではビルド済みのフロントエンドを配信する（SPA）
if (fs.existsSync(WEB_DIST)) {
  const root = path.relative(process.cwd(), WEB_DIST);
  app.use('*', async (c, next) => {
    await next();
    if (isProd && !c.req.path.startsWith('/api/')) c.header('Content-Security-Policy', CSP);
  });
  app.use('/assets/*', serveStatic({ root, onFound: (_p, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable') }));
  app.use('*', serveStatic({ root }));
  const indexHtml = fs.readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8');
  app.get('*', (c) => {
    c.header('Cache-Control', 'no-cache');
    return c.html(indexHtml);
  });
} else if (isProd) {
  console.warn(`[warn] フロントエンドのビルド (${WEB_DIST}) が見つかりません。先に \`npm run build\` を実行してください。`);
}

await bootstrapAdmin();
setInterval(() => void cleanup().then(() => encryptExistingData(500)).catch(console.error), 10 * 60_000).unref();
void encryptExistingData(500).catch(console.error);
// ページが使っているファイルの記録（ファイルを見てよい人の判定に使う）
const indexFiles = async () => {
  while ((await indexPageFiles(500)) > 0);
  while ((await indexPageLinks(500)) > 0);
  while ((await indexPageTodos(500)) > 0);
};
void indexFiles().catch(console.error);
setInterval(() => void indexFiles().catch(console.error), 10 * 60_000).unref();

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`[server] listening on http://${HOST}:${info.port}  (ORIGIN=${cfg.ORIGIN}, RP_ID=${cfg.RP_ID})`);
});
