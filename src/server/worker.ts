/** Cloudflare Workers 用のエントリポイント */
import type { D1Database, ExecutionContext, R2Bucket, RateLimit, ScheduledController } from '@cloudflare/workers-types';
import { createApp } from './app.ts';
import { initConfig } from './config.ts';
import { setDb } from './db.ts';
import { createD1Db } from './db-d1.ts';
import { cleanup, encryptExistingData } from './maintenance.ts';
import { indexPageFiles } from './pageFiles.ts';
import { indexPageLinks } from './pageLinks.ts';
import { indexPageTodos } from './pageTodos.ts';
import { migrateD1 } from './d1-migrate.ts';
import { memoryRateLimiter, runtime, setRuntime } from './runtime.ts';
import { encryptedStore, type FileStore } from './storage.ts';
import { setDataKey } from './crypto.ts';
import { setGithubApi, syncAllGithub } from './github.ts';
import { backupDatabase, type BackupStore } from './backup.ts';

export { PageRoom } from './collab.ts';

export type Env = {
  DB: D1Database;
  FILES?: R2Bucket;
  AUTH_LIMITER?: RateLimit;
  ORIGIN?: string;
  RP_ID?: string;
  MAX_UPLOAD_MB?: string;
  ADMIN_USERNAME?: string;
  /** データ暗号化の鍵（wrangler secret put DATA_KEY） */
  DATA_KEY?: string;
  /** テスト用の GitHub API の接続先 */
  GITHUB_API?: string;
  /** リアルタイム共同編集の部屋 */
  PAGE_ROOM?: unknown;
};

function r2Store(bucket: R2Bucket): FileStore {
  return {
    async put(id, data, contentType) {
      await bucket.put(id, data, { httpMetadata: { contentType } });
    },
    async get(id) {
      const obj = await bucket.get(id);
      return obj ? (obj.body as unknown as ReadableStream) : null;
    },
    async delete(id) {
      await bucket.delete(id);
    },
  };
}

/** R2 の backups/db/ にバックアップを置く */
function r2Backups(bucket: R2Bucket): BackupStore {
  const prefix = 'backups/db/';
  return {
    async put(name, data) {
      await bucket.put(prefix + name, data, { httpMetadata: { contentType: 'application/octet-stream' } });
    },
    async list() {
      const out: { name: string; size: number; createdAt: number }[] = [];
      let cursor: string | undefined;
      do {
        const r = await bucket.list({ prefix, cursor, limit: 1000 });
        for (const o of r.objects) out.push({ name: o.key.slice(prefix.length), size: o.size, createdAt: o.uploaded.getTime() });
        cursor = r.truncated ? r.cursor : undefined;
      } while (cursor);
      return out;
    },
    async get(name) {
      const obj = await bucket.get(prefix + name);
      return obj ? (obj.body as unknown as ReadableStream) : null;
    },
    async delete(name) {
      await bucket.delete(prefix + name);
    },
  };
}

let initialized = false;
let migrated: Promise<void> | null = null;
let backlogStarted = false;
let filesIndexStarted = false;
const fallbackLimiter = memoryRateLimiter(40, 60_000);

// バインディングはデプロイ単位で固定なので、アイソレートごとに一度だけ初期化する
function init(env: Env, requestUrl?: string) {
  if (initialized) return;
  initConfig(env, requestUrl ? new URL(requestUrl).origin : 'http://localhost:8787');
  setDataKey(env.DATA_KEY);
  setGithubApi(env.GITHUB_API);
  setDb(createD1Db(env.DB));
  setRuntime({
    name: 'Cloudflare Workers',
    files: env.FILES ? encryptedStore(r2Store(env.FILES)) : null,
    backups: env.FILES ? r2Backups(env.FILES) : null,
    // Workers では Cloudflare が付与する CF-Connecting-IP が信頼できる
    clientIp: (c) => c.req.header('cf-connecting-ip') ?? 'unknown',
    rateLimited: env.AUTH_LIMITER
      ? async (key) => !(await env.AUTH_LIMITER!.limit({ key })).success
      : fallbackLimiter,
  });
  initialized = true;
}

const app = createApp();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    init(env, request.url);
    migrated ??= migrateD1(env.DB).catch((err) => {
      migrated = null; // 次のリクエストで再試行する
      throw err;
    });
    await migrated;
    // 暗号化前のデータが残っていれば、少しずつ暗号化する（アイソレートごとに一度）
    if (!backlogStarted && env.DATA_KEY) {
      backlogStarted = true;
      ctx.waitUntil(encryptExistingData(200).catch((e) => console.error('[encrypt]', e)));
    }
    // ページが使っているファイルの記録が残っていれば、少しずつ記録する（アイソレートごとに一度）
    if (!filesIndexStarted) {
      filesIndexStarted = true;
      ctx.waitUntil(indexPageFiles(300).then(() => indexPageLinks(300)).then(() => indexPageTodos(300)).catch((e) => console.error('[page-index]', e)));
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    init(env);
    // 10 分ごと：GitHub と同期。6 時間ごと：古いデータの掃除と暗号化
    const github = (controller.cron as string) === '*/10 * * * *';
    // バックアップは 6 時間ごと（0:30, 6:30, …）。ほかの処理と別の実行にして、1 回あたりの上限に収める
    const at = new Date(controller.scheduledTime);
    const backupTime = github && at.getUTCMinutes() === 30 && at.getUTCHours() % 6 === 0;
    ctx.waitUntil(
      migrateD1(env.DB).then(async () => {
        if (backupTime) {
          const store = runtime().backups;
          if (store) await backupDatabase(store).catch((e) => console.error('[backup]', e));
        } else if (github) {
          await indexPageFiles(500).catch((e) => console.error('[page-files]', e));
          await indexPageLinks(500).catch((e) => console.error('[page-links]', e));
          await indexPageTodos(500).catch((e) => console.error('[page-todos]', e));
          await syncAllGithub();
        }
        else await cleanup().then(() => encryptExistingData(500));
      }),
    );
  },
};
