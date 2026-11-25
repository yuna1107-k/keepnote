import type { Context } from 'hono';
import { run, sql, type Stmt } from './db.ts';
import { encryptText } from './crypto.ts';
import { clientIp, now } from './util.ts';

export type Actor = { id: string; username: string } | null;
type Target = { type: string; id?: string | null; name?: string | null };

/** 監査ログの INSERT 文を作る（他の更新と batch でまとめたいとき用） */
/** ページ名は本文と同じく暗号化して記録する（読み出し時に自動で復号される） */
export async function auditStmtAsync(c: Context | null, actor: Actor, action: string, target?: Target, detail?: Record<string, unknown>): Promise<Stmt> {
  if (target?.type === 'page' && target.name) target = { ...target, name: (await encryptText(target.name)) as string };
  return auditStmt(c, actor, action, target, detail);
}

export function auditStmt(c: Context | null, actor: Actor, action: string, target?: Target, detail?: Record<string, unknown>): Stmt {
  return sql(
    `INSERT INTO audit_logs (at, actor_id, actor_name, action, target_type, target_id, target_name, detail, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    now(),
    actor?.id ?? null,
    actor?.username ?? null,
    action,
    target?.type ?? null,
    target?.id ?? null,
    target?.name ?? null,
    detail ? JSON.stringify(detail) : null,
    c ? clientIp(c) : 'cli',
  );
}

export async function audit(c: Context | null, actor: Actor, action: string, target?: Target, detail?: Record<string, unknown>) {
  const s = auditStmt(c, actor, action, target, detail);
  await run(s.sql, ...s.params);
}
