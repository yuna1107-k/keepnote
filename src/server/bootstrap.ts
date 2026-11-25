import { auditStmt } from './audit.ts';
import { cfg } from './config.ts';
import { batch, get } from './db.ts';
import { createUserStmt, issueRegistrationLink, membershipStmts, type UserRow } from './users.ts';

/**
 * 有効な管理者が一人もいない場合（初回起動時など）、管理者用のパスキー登録リンクを発行してログに出力する。
 * ユーザーの自己登録は存在しないため、最初の管理者はこの方法でのみ作成される。
 */
export async function bootstrapAdmin() {
  const activeAdmin = await get<{ id: string }>(`SELECT id FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1`);
  if (activeAdmin) return;

  let admin = await get<UserRow>(`SELECT * FROM users WHERE role = 'admin' AND status = 'pending' ORDER BY created_at LIMIT 1`);
  if (!admin) {
    const hasUsers = (await get<{ n: number }>('SELECT COUNT(*) AS n FROM users'))!.n > 0;
    if (hasUsers) {
      console.warn('[setup] 有効な管理者がいません。`npm run cli -- create-admin <username>` で管理者を作成してください。');
      return;
    }
    const created = await createUserStmt({ username: cfg.INITIAL_ADMIN_USERNAME, displayName: '管理者', role: 'admin' });
    admin = created.user;
    await batch([
      created.stmt,
      ...membershipStmts(admin.id, ['default'], 'owner'),
      auditStmt(null, null, 'user.create', { type: 'user', id: admin.id, name: admin.username }, { role: 'admin', bootstrap: true }),
    ]);
  }
  const link = await issueRegistrationLink(admin.id, 'invite', null, 24);
  const line = '='.repeat(72);
  console.log(`\n${line}\n 初期セットアップ: 管理者「${admin.username}」のパスキー登録リンク（24時間有効）\n\n   ${link.url}\n\n このリンクをブラウザで開き、パスキーを登録してください。\n${line}\n`);
}
