import { decryptRow } from './crypto.ts';
/**
 * DB アクセスの共通インターフェース。
 * 実体は node:sqlite（db-node.ts）または Cloudflare D1（db-d1.ts）で、起動時に setDb() で差し込む。
 *
 * D1 は対話的トランザクションを持たないため、複数の更新をまとめて原子的に行うときは batch() を使う。
 */
export type SqlValue = string | number | null | Uint8Array;
export type Stmt = { sql: string; params: SqlValue[] };
export type RunResult = { changes: number };

export interface DbAdapter {
  get<T>(sql: string, params: SqlValue[]): Promise<T | undefined>;
  all<T>(sql: string, params: SqlValue[]): Promise<T[]>;
  run(sql: string, params: SqlValue[]): Promise<RunResult>;
  batch(stmts: Stmt[]): Promise<RunResult[]>;
}

let adapter: DbAdapter | null = null;
let rawAdapter: DbAdapter | null = null;

/** 読み出した行に含まれる暗号化された値（enc:v1:…）は、ここで自動的に復号する */
export function setDb(a: DbAdapter) {
  rawAdapter = a;
  adapter = {
    ...a,
    async get<T>(sql: string, params: SqlValue[]) {
      return decryptRow(await a.get<T>(sql, params));
    },
    async all<T>(sql: string, params: SqlValue[]) {
      const rows = await a.all<T>(sql, params);
      for (const r of rows) await decryptRow(r);
      return rows;
    },
  };
}

function db(): DbAdapter {
  if (!adapter) throw new Error('DB が初期化されていません');
  return adapter;
}

export const get = <T>(sql: string, ...params: SqlValue[]) => db().get<T>(sql, params);
export const all = <T>(sql: string, ...params: SqlValue[]) => db().all<T>(sql, params);
export const run = (sql: string, ...params: SqlValue[]) => db().run(sql, params);
export const batch = (stmts: Stmt[]) => db().batch(stmts);
/** 暗号化された値を復号せずに読む（バックアップ用） */
export const rawAll = <T>(sql: string, ...params: SqlValue[]) => {
  if (!rawAdapter) throw new Error('DB が初期化されていません');
  return rawAdapter.all<T>(sql, params);
};
export const sql = (text: string, ...params: SqlValue[]): Stmt => ({ sql: text, params });

/** D1 は BLOB を number[] や ArrayBuffer で返すことがあるため Uint8Array に揃える */
export function toBytes(v: unknown): Uint8Array<ArrayBuffer> {
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new Error('BLOB の形式が不正です');
}
