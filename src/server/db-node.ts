import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { DbAdapter, SqlValue } from './db.ts';

/** node:sqlite 版のアダプタ。migrations/*.sql を順番に適用する */
export function createNodeDb(file: string, migrationsDir: string): DbAdapter {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

  const cache = new Map<string, StatementSync>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  const transaction = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  // マイグレーション（ファイル名順。適用済みの数を user_version に記録）
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let i = current; i < files.length; i++) {
    const text = fs.readFileSync(path.join(migrationsDir, files[i]!), 'utf8');
    transaction(() => {
      db.exec(text);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }

  const p = (params: SqlValue[]) => params;
  return {
    async get<T>(sql: string, params: SqlValue[]) {
      return stmt(sql).get(...p(params)) as T | undefined;
    },
    async all<T>(sql: string, params: SqlValue[]) {
      return stmt(sql).all(...p(params)) as T[];
    },
    async run(sql: string, params: SqlValue[]) {
      return { changes: Number(stmt(sql).run(...p(params)).changes) };
    },
    async batch(stmts) {
      return transaction(() => stmts.map((s) => ({ changes: Number(stmt(s.sql).run(...p(s.params)).changes) })));
    },
  };
}
