import { execFileSync } from 'node:child_process';
import type { DbAdapter, SqlValue, Stmt } from './db.ts';

/**
 * CLI 専用：`wrangler d1 execute` 経由で D1 に SQL を発行するアダプタ。
 * wrangler はパラメータバインドに対応しないため、値をリテラルに埋め込む（CLI 内部の値のみを扱う）。
 */
function literal(v: SqlValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString('hex')}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function inline(sql: string, params: SqlValue[]) {
  let i = 0;
  return sql.replace(/\?/g, () => literal(params[i++] ?? null));
}

export function createWranglerDb(mode: 'local' | 'remote', binding = 'DB'): DbAdapter {
  const exec = (stmts: Stmt[]) => {
    const command = stmts.map((s) => inline(s.sql, s.params).replace(/\s+/g, ' ').trim()).join('; ');
    const out = execFileSync('npx', ['wrangler', 'd1', 'execute', binding, `--${mode}`, '--json', '--command', command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(out) as { results: Record<string, unknown>[]; meta?: { changes?: number } }[];
  };
  return {
    async get<T>(sql: string, params: SqlValue[]) {
      return exec([{ sql, params }])[0]?.results[0] as T | undefined;
    },
    async all<T>(sql: string, params: SqlValue[]) {
      return (exec([{ sql, params }])[0]?.results ?? []) as T[];
    },
    async run(sql: string, params: SqlValue[]) {
      return { changes: exec([{ sql, params }])[0]?.meta?.changes ?? 0 };
    },
    async batch(stmts) {
      if (stmts.length === 0) return [];
      return exec(stmts).map((r) => ({ changes: r.meta?.changes ?? 0 }));
    },
  };
}
