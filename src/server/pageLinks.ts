/**
 * ページ同士のリンクの記録（被リンクの表示に使う）。
 *
 * 本文の中のリンクから、参照先のページを探す
 * - /p/<ページID>（https://…/p/<ID> も含む）
 * - GitHub の Markdown ページでは、相対パスのリンク（../MATH/calc.md など）を、同じワークスペースの GitHub のページに対応付ける
 */
import { all, batch, sql, type Stmt } from './db.ts';
import { now } from './util.ts';

const PAGE_ID_RE = /\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
const HREF_RE = /"href":"((?:[^"\\]|\\.)*)"/g;

type LinkSource = { id: string; workspace_id: string; github_path: string | null };

function resolve(dir: string, rel: string) {
  const parts = dir ? dir.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** 本文（JSON 文字列）から、参照しているページの ID を集める */
export async function linkTargets(page: LinkSource, content: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const m of content.matchAll(PAGE_ID_RE)) ids.add(m[1]!);
  if (page.github_path) {
    const rels: string[] = [];
    for (const m of content.matchAll(HREF_RE)) {
      let href: string;
      try {
        href = JSON.parse(`"${m[1]}"`) as string;
      } catch {
        continue;
      }
      if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) continue;
      rels.push(href.split('#')[0]!);
    }
    if (rels.length) {
      const dir = page.github_path.includes('/') ? page.github_path.slice(0, page.github_path.lastIndexOf('/')) : '';
      const byPath = new Map(
        (await all<{ id: string; github_path: string }>('SELECT id, github_path FROM pages WHERE workspace_id = ? AND github_path IS NOT NULL AND deleted_at IS NULL', page.workspace_id)).map(
          (p) => [p.github_path, p.id],
        ),
      );
      for (const rel of rels) {
        let decoded = rel;
        try {
          decoded = decodeURIComponent(rel);
        } catch {
          /* そのまま */
        }
        const id = byPath.get(resolve(dir, decoded).replace(/\/$/, ''));
        if (id) ids.add(id);
      }
    }
  }
  ids.delete(page.id);
  return [...ids];
}

/** リンクの記録を作り直す文（今の本文のリンクだけにする） */
export async function pageLinksStmts(page: LinkSource, content: string): Promise<Stmt[]> {
  const targets = await linkTargets(page, content);
  return [
    sql('DELETE FROM page_links WHERE from_id = ?', page.id),
    ...targets.map((t) => sql('INSERT OR IGNORE INTO page_links (from_id, to_id) SELECT ?, id FROM pages WHERE id = ?', page.id, t)),
    sql('UPDATE pages SET links_indexed_at = ? WHERE id = ?', now(), page.id),
  ];
}

/** まだ記録していないページを少しずつ記録する */
export async function indexPageLinks(limit = 300) {
  const pages = await all<LinkSource & { content: string }>('SELECT id, workspace_id, github_path, content FROM pages WHERE links_indexed_at IS NULL LIMIT ?', limit);
  const stmts: Stmt[] = [];
  for (const p of pages) stmts.push(...(await pageLinksStmts(p, p.content)));
  for (let i = 0; i < stmts.length; i += 100) await batch(stmts.slice(i, i + 100));
  return pages.length;
}
