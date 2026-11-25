import { encryptionEnabled, encryptText } from './crypto.ts';
import { all, batch, get, run, sql, type Stmt } from './db.ts';
import { runtime } from './runtime.ts';
import { now } from './util.ts';

/** 期限切れのチャレンジ・セッション・古い登録リンクを削除する（定期実行） */
export async function cleanup() {
  const t = now();
  await batch([
    sql('DELETE FROM webauthn_challenges WHERE expires_at < ?', t),
    sql('DELETE FROM sessions WHERE expires_at < ?', t),
    sql('DELETE FROM page_presence WHERE last_seen < ?', t - 3600_000),
    sql('DELETE FROM registration_tokens WHERE expires_at < ? AND used_at IS NULL', t - 30 * 86400_000),
    sql('DELETE FROM login_requests WHERE expires_at < ?', t - 3600_000),
  ]);
}

const PLAIN = (col: string, nullable = false) => (nullable ? `(${col} IS NOT NULL AND ${col} NOT LIKE 'enc:v1:%')` : `${col} NOT LIKE 'enc:v1:%'`);
const PAGE_PLAIN = `(${PLAIN('title')} OR ${PLAIN('content')} OR ${PLAIN('content_text')} OR ${PLAIN('icon', true)} OR ${PLAIN('cover', true)})`;
const VERSION_PLAIN = `(${PLAIN('title')} OR ${PLAIN('content')} OR ${PLAIN('content_text')} OR ${PLAIN('icon', true)})`;
const AUDIT_PLAIN = `target_type = 'page' AND ${PLAIN('target_name', true)}`;

/** まだ暗号化されていないデータの件数 */
export async function encryptionBacklog() {
  const n = async (q: string, ...p: (string | number)[]) => (await get<{ n: number }>(q, ...p))!.n;
  return {
    pages: await n(`SELECT COUNT(*) AS n FROM pages WHERE ${PAGE_PLAIN}`),
    versions: await n(`SELECT COUNT(*) AS n FROM page_versions WHERE ${VERSION_PLAIN}`),
    auditLogs: await n(`SELECT COUNT(*) AS n FROM audit_logs WHERE ${AUDIT_PLAIN}`),
    files: runtime().files ? await n('SELECT COUNT(*) AS n FROM files WHERE encrypted = 0') : 0,
  };
}

/**
 * 暗号化を有効にする前に保存されたデータを暗号化する（少しずつ。定期実行と管理者画面から呼ばれる）。
 * 読み出しは平文・暗号文のどちらにも対応しているので、途中で止まっても問題ない。
 */
export async function encryptExistingData(limit = 100) {
  const done = { pages: 0, versions: 0, auditLogs: 0, files: 0 };
  if (!encryptionEnabled()) return done;
  const enc = (v: string | null) => encryptText(v) as Promise<string | null>;

  const pages = await all<{ id: string; version: number; title: string; icon: string | null; content: string; content_text: string; cover: string | null }>(
    `SELECT id, version, title, icon, content, content_text, cover FROM pages WHERE ${PAGE_PLAIN} LIMIT ?`,
    limit,
  );
  const stmts: Stmt[] = [];
  for (const p of pages) {
    stmts.push(
      sql(
        'UPDATE pages SET title = ?, icon = ?, content = ?, content_text = ?, cover = ? WHERE id = ? AND version = ?',
        await enc(p.title),
        await enc(p.icon),
        await enc(p.content),
        await enc(p.content_text),
        await enc(p.cover),
        p.id,
        p.version,
      ),
    );
  }
  done.pages = pages.length;

  const versions = await all<{ id: string; title: string; icon: string | null; content: string; content_text: string }>(
    `SELECT id, title, icon, content, content_text FROM page_versions WHERE ${VERSION_PLAIN} LIMIT ?`,
    limit,
  );
  for (const v of versions) {
    stmts.push(
      sql('UPDATE page_versions SET title = ?, icon = ?, content = ?, content_text = ? WHERE id = ?', await enc(v.title), await enc(v.icon), await enc(v.content), await enc(v.content_text), v.id),
    );
  }
  done.versions = versions.length;

  const logs = await all<{ id: number; target_name: string }>(`SELECT id, target_name FROM audit_logs WHERE ${AUDIT_PLAIN} LIMIT ?`, limit);
  for (const l of logs) stmts.push(sql('UPDATE audit_logs SET target_name = ? WHERE id = ?', await enc(l.target_name), l.id));
  done.auditLogs = logs.length;
  if (stmts.length) await batch(stmts);

  // ファイル（作成日時の順に処理し、どこまで済んだかを記録する）
  const store = runtime().files as (ReturnType<typeof import('./storage.ts').encryptedStore>) | null;
  if (store?.encryptExisting) {
    const files = await all<{ id: string; mime: string }>('SELECT id, mime FROM files WHERE encrypted = 0 ORDER BY created_at LIMIT ?', Math.min(limit, 20));
    for (const f of files) {
      try {
        if (await store.encryptExisting(f.id, f.mime)) done.files++;
        // 暗号化した、または既に暗号化済みだったもの
        await run('UPDATE files SET encrypted = 1 WHERE id = ?', f.id);
      } catch (e) {
        console.error('[encrypt] file', f.id, e);
      }
    }
  }
  return done;
}
