import type { Context } from 'hono';
import type { BackupStore } from './backup.ts';
import type { FileStore } from './storage.ts';

/** 実行環境ごとに異なる機能（ファイル保存・IP取得・レート制限） */
export type Runtime = {
  /** 実行環境の名前（管理者画面に表示） */
  name: string;
  files: FileStore | null;
  /** データベースのバックアップの保存先（なければバックアップしない） */
  backups?: BackupStore | null;
  clientIp: (c: Context) => string;
  /** true を返したら制限超過 */
  rateLimited: (key: string) => Promise<boolean>;
};

let rt: Runtime | null = null;

export function setRuntime(r: Runtime) {
  rt = r;
}

export function runtime(): Runtime {
  if (!rt) throw new Error('Runtime が初期化されていません');
  return rt;
}

/** 単一インスタンス用のメモリ内レート制限（固定ウィンドウ） */
export function memoryRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  return async (key: string) => {
    const t = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
    const entry = hits.get(key);
    if (!entry || entry.reset < t) {
      hits.set(key, { count: 1, reset: t + windowMs });
      return false;
    }
    entry.count++;
    return entry.count > limit;
  };
}
