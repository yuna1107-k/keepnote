/**
 * データベースの自動バックアップ。
 *
 * すべてのテーブルを SQL（INSERT 文）に書き出し、gzip で圧縮して DATA_KEY で暗号化し、保存先（Workers では R2 の backups/db/）に置く。
 * 暗号化された列（enc:v1:…）は暗号化されたまま書き出す。古いものは自動で削除する。
 *
 * 復元: npm run backup:decrypt -- <ファイル> <出力.sql> で SQL に戻し、wrangler d1 execute で流し込む（README 参照）。
 */
import { encryptBytes } from './crypto.ts';
import { rawAll } from './db.ts';

export type BackupStore = {
  put(name: string, data: ArrayBuffer): Promise<void>;
  list(): Promise<{ name: string; size: number; createdAt: number }[]>;
  get(name: string): Promise<ReadableStream | null>;
  delete(name: string): Promise<void>;
};

/** 30 日分（6 時間ごと × 4 回/日） */
const KEEP = 120;
const PAGE = 500;
export const BACKUP_NAME_RE = /^db-\d{8}-\d{6}\.sql\.gz\.enc$/;

function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Uint8Array || v instanceof ArrayBuffer || Array.isArray(v)) {
    const bytes = v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : Uint8Array.from(v as number[]);
    return `X'${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** すべてのテーブルを SQL にする（スキーマはマイグレーションで作るので、データのみ） */
export async function dumpDatabase(): Promise<{ sql: string; tables: number; rows: number }> {
  const tables = await rawAll<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`,
  );
  const out: string[] = [
    `-- keepnote database backup ${new Date().toISOString()}`,
    'PRAGMA defer_foreign_keys = true;',
  ];
  let rows = 0;
  for (const { name } of tables) {
    out.push(`DELETE FROM ${ident(name)};`);
    for (let offset = 0; ; offset += PAGE) {
      const page = await rawAll<Record<string, unknown>>(`SELECT * FROM ${ident(name)} LIMIT ${PAGE} OFFSET ${offset}`);
      for (const r of page) {
        const cols = Object.keys(r);
        out.push(`INSERT INTO ${ident(name)} (${cols.map(ident).join(', ')}) VALUES (${cols.map((c) => literal(r[c])).join(', ')});`);
      }
      rows += page.length;
      if (page.length < PAGE) break;
    }
  }
  return { sql: out.join('\n') + '\n', tables: tables.length, rows };
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** バックアップを 1 つ作り、古いものを消す */
export async function backupDatabase(store: BackupStore) {
  const { sql, tables, rows } = await dumpDatabase();
  const data = await encryptBytes(await gzip(sql));
  const name = `db-${stamp()}.sql.gz.enc`;
  await store.put(name, data);
  const list = (await store.list()).filter((b) => BACKUP_NAME_RE.test(b.name)).sort((a, b) => b.name.localeCompare(a.name));
  for (const old of list.slice(KEEP)) await store.delete(old.name);
  return { name, size: data.byteLength, tables, rows };
}
