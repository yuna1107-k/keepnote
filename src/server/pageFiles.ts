/**
 * アップロードしたファイルを見てよい人の判定。
 *
 * ファイルは次のどれかに当てはまる人だけが取得できる
 * - アップロードした本人・サーバー管理者
 * - アバター・ワークスペースのアイコンとして使われているファイル（ログインしていれば誰でも）
 * - そのファイルを使っているページ（編集履歴を含む）を見られる人
 *
 * ページとファイルの対応（page_files）は、本文の保存時と定期処理で記録する。
 * 既存のページの記録が終わるまでは、今までどおりログインしていれば取得できる（画像が見えなくなるのを防ぐ）。
 */
import { all, batch, get, sql, type Stmt } from './db.ts';
import { accessMap } from './permissions.ts';
import type { SessionUser } from './session.ts';
import { now } from './util.ts';

const FILE_RE = /\/api\/files\/([0-9a-f-]{36})/g;
const DONE_KEY = 'page_files_indexed';

export function fileIdsIn(...texts: (string | null | undefined)[]) {
  const ids = new Set<string>();
  for (const t of texts) if (t) for (const m of t.matchAll(FILE_RE)) ids.add(m[1]!);
  return [...ids];
}

/** ページが使っているファイルを記録する文（記録は追加のみ。消すと編集履歴の画像が見えなくなるため）
 * 保存する人がすでに読めるファイル（所有者・canReadFile が真・同じページに既にリンク済み）だけ登録する。
 */
export async function pageFilesStmts(pageId: string, user?: SessionUser, ...texts: (string | null | undefined)[]): Promise<Stmt[]> {
  const fileIds = fileIdsIn(...texts);
  if (fileIds.length === 0) {
    return [sql('UPDATE pages SET files_indexed_at = ? WHERE id = ?', now(), pageId)];
  }

  let allowedFileIds = fileIds;
  if (user) {
    const existing = new Set(
      (await all<{ file_id: string }>('SELECT file_id FROM page_files WHERE page_id = ?', pageId)).map((r) => r.file_id),
    );
    const checkedIds: string[] = [];
    for (const fId of fileIds) {
      if (existing.has(fId)) {
        checkedIds.push(fId);
        continue;
      }
      const fileRow = await get<{ id: string; owner_id: string | null }>('SELECT id, owner_id FROM files WHERE id = ?', fId);
      if (!fileRow) continue;
      if (fileRow.owner_id === user.id || (await canReadFile(user, fileRow))) {
        checkedIds.push(fId);
      }
    }
    allowedFileIds = checkedIds;
  }

  return [
    ...allowedFileIds.map((f) => sql('INSERT OR IGNORE INTO page_files (page_id, file_id) VALUES (?, ?)', pageId, f)),
    sql('UPDATE pages SET files_indexed_at = ? WHERE id = ?', now(), pageId),
  ];
}

/** まだ記録していないページ・編集履歴を少しずつ記録する。すべて終わったら印を付ける */
export async function indexPageFiles(limit = 300) {
  const pages = await all<{ id: string; content: string; cover: string | null }>('SELECT id, content, cover FROM pages WHERE files_indexed_at IS NULL LIMIT ?', limit);
  const versions = await all<{ id: string; page_id: string; content: string }>(
    'SELECT id, page_id, content FROM page_versions WHERE files_indexed_at IS NULL LIMIT ?',
    limit,
  );
  const t = now();
  const stmts: Stmt[] = [];
  for (const p of pages) stmts.push(...(await pageFilesStmts(p.id, undefined, p.content, p.cover)));
  for (const v of versions) {
    for (const f of fileIdsIn(v.content)) stmts.push(sql('INSERT OR IGNORE INTO page_files (page_id, file_id) VALUES (?, ?)', v.page_id, f));
    stmts.push(sql('UPDATE page_versions SET files_indexed_at = ? WHERE id = ?', t, v.id));
  }
  for (let i = 0; i < stmts.length; i += 100) await batch(stmts.slice(i, i + 100));
  if (pages.length < limit && versions.length < limit && !(await indexDone())) {
    await batch([sql(`INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'`, DONE_KEY)]);
  }
  return pages.length + versions.length;
}

async function indexDone() {
  return !!(await get<{ value: string }>('SELECT value FROM settings WHERE key = ?', DONE_KEY));
}

export async function canReadFile(user: SessionUser, file: { id: string; owner_id: string | null }) {
  if (file.owner_id === user.id || user.role === 'admin') return true;
  const shared = await get(
    'SELECT 1 FROM users WHERE avatar_file_id = ? UNION ALL SELECT 1 FROM workspaces WHERE icon_file_id = ? LIMIT 1',
    file.id,
    file.id,
  );
  if (shared) return true;
  if (!(await indexDone())) return true;
  const pages = await all<{ page_id: string; workspace_id: string }>(
    'SELECT f.page_id, p.workspace_id FROM page_files f JOIN pages p ON p.id = f.page_id WHERE f.file_id = ?',
    file.id,
  );
  const byWs = new Map<string, string[]>();
  for (const p of pages) byWs.set(p.workspace_id, [...(byWs.get(p.workspace_id) ?? []), p.page_id]);
  for (const [wsId, ids] of byWs) {
    const m = await get<{ role: string }>('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?', wsId, user.id);
    const access = await accessMap(wsId, user, !!m, m?.role === 'viewer', m?.role === 'owner' || m?.role === 'admin');
    if (ids.some((id) => (access.get(id) ?? 'none') !== 'none')) return true;
  }
  return false;
}
