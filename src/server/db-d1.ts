import type { D1Database } from '@cloudflare/workers-types';
import type { DbAdapter } from './db.ts';

/** Cloudflare D1 版のアダプタ。batch() は D1 の batch（暗黙のトランザクション）で実行される */
export function createD1Db(d1: D1Database): DbAdapter {
  return {
    async get<T>(sql: string, params: unknown[]) {
      return ((await d1.prepare(sql).bind(...params).first()) ?? undefined) as T | undefined;
    },
    async all<T>(sql: string, params: unknown[]) {
      return (await d1.prepare(sql).bind(...params).all()).results as T[];
    },
    async run(sql: string, params: unknown[]) {
      const r = await d1.prepare(sql).bind(...params).run();
      return { changes: r.meta.changes ?? 0 };
    },
    async batch(stmts) {
      if (stmts.length === 0) return [];
      const results = await d1.batch(stmts.map((s) => d1.prepare(s.sql).bind(...s.params)));
      return results.map((r) => ({ changes: r.meta.changes ?? 0 }));
    },
  };
}
