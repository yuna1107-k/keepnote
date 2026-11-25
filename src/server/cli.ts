/**
 * 管理用CLI
 *
 *   npm run cli -- [--d1 local|remote] <command> ...
 *
 *   create-admin <username> [表示名]   管理者を作成し登録リンクを発行
 *   link <username>                    既存ユーザーのパスキー登録（復旧）リンクを発行
 *   promote <username>                 管理者に昇格し、無効化されていれば有効化
 *   list                               ユーザー一覧
 *
 * --d1 を付けると Cloudflare D1（wrangler 経由）を操作する。付けない場合は DATA_DIR の SQLite を操作する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { auditStmt } from './audit.ts';
import { initConfig } from './config.ts';
import { all, batch, run, setDb } from './db.ts';
import { createNodeDb } from './db-node.ts';
import { createWranglerDb } from './db-wrangler.ts';
import { createUserStmt, getUserByUsername, issueRegistrationLink, membershipStmts, type UserRow } from './users.ts';
import { now } from './util.ts';

let args = process.argv.slice(2);
let d1: 'local' | 'remote' | null = null;
const d1Index = args.indexOf('--d1');
if (d1Index >= 0) {
  const mode = args[d1Index + 1];
  if (mode !== 'local' && mode !== 'remote') {
    console.error('--d1 には local か remote を指定してください');
    process.exit(1);
  }
  d1 = mode;
  args = args.filter((_, i) => i !== d1Index && i !== d1Index + 1);
}
const [cmd, ...rest] = args;

/** wrangler.jsonc の vars.ORIGIN を読む（コメントを除去して JSON として解釈） */
function wranglerOrigin(): string | undefined {
  try {
    const text = fs.readFileSync(path.resolve('wrangler.jsonc'), 'utf8');
    const json = JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, s) => s ?? '').replace(/,(\s*[}\]])/g, '$1'));
    return json?.vars?.ORIGIN;
  } catch {
    return undefined;
  }
}

if (d1) {
  const origin = process.env.ORIGIN ?? (d1 === 'local' ? 'http://localhost:8787' : wranglerOrigin());
  if (!origin) {
    console.error('ORIGIN が分かりません。wrangler.jsonc の vars.ORIGIN を設定するか、環境変数 ORIGIN を指定してください');
    process.exit(1);
  }
  initConfig({ ...process.env, ORIGIN: origin }, origin);
  setDb(createWranglerDb(d1));
} else {
  const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
  initConfig(process.env, `http://localhost:${process.env.PORT ?? 3000}`);
  setDb(createNodeDb(path.join(dataDir, 'app.db'), path.resolve(import.meta.dirname, '../../migrations')));
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function printLink(url: string, expiresAt: number) {
  console.log(`\n登録リンク（${new Date(expiresAt).toLocaleString('ja-JP')} まで有効）:\n\n  ${url}\n`);
}

try {
  switch (cmd) {
    case 'create-admin': {
      const [username, displayName] = rest;
      if (!username) die('使い方: create-admin <username> [表示名]');
      const { user, stmt } = await createUserStmt({ username, displayName: displayName ?? username, role: 'admin' });
      await batch([stmt, ...membershipStmts(user.id, ['default'], 'owner'), auditStmt(null, null, 'user.create', { type: 'user', id: user.id, name: user.username }, { role: 'admin', via: 'cli' })]);
      const link = await issueRegistrationLink(user.id, 'invite', null, 24);
      console.log(`管理者「${user.username}」を作成しました。`);
      printLink(link.url, link.expiresAt);
      break;
    }
    case 'link': {
      const [username] = rest;
      if (!username) die('使い方: link <username>');
      const user = (await getUserByUsername(username)) ?? die('ユーザーが見つかりません');
      if (user.status === 'disabled') die('ユーザーが無効化されています。先に promote などで有効化してください');
      const link = await issueRegistrationLink(user.id, user.status === 'pending' ? 'invite' : 'recovery', null, 24);
      await batch([auditStmt(null, null, 'link.issue', { type: 'user', id: user.id, name: user.username }, { via: 'cli' })]);
      printLink(link.url, link.expiresAt);
      break;
    }
    case 'promote': {
      const [username] = rest;
      const user = (username && (await getUserByUsername(username))) || die('ユーザーが見つかりません');
      const status = user.status === 'disabled' ? 'active' : user.status;
      await run('UPDATE users SET role = ?, status = ?, updated_at = ? WHERE id = ?', 'admin', status, now(), user.id);
      await batch([auditStmt(null, null, 'user.update', { type: 'user', id: user.id, name: user.username }, { role: 'admin', via: 'cli' })]);
      console.log(`「${user.username}」を管理者にしました。`);
      break;
    }
    case 'list': {
      const users = await all<UserRow & { passkeys: number }>(
        'SELECT u.*, (SELECT COUNT(*) FROM credentials WHERE user_id = u.id) AS passkeys FROM users u ORDER BY created_at',
      );
      console.table(users.map((u) => ({ username: u.username, name: u.display_name, role: u.role, status: u.status, passkeys: u.passkeys })));
      break;
    }
    default:
      console.log(`使い方:
  npm run cli -- [--d1 local|remote] create-admin <username> [表示名]
  npm run cli -- [--d1 local|remote] link <username>
  npm run cli -- [--d1 local|remote] promote <username>
  npm run cli -- [--d1 local|remote] list`);
  }
} catch (err) {
  die((err as Error).message);
}
