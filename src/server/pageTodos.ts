/**
 * ページの中の未完了の ToDo の記録（「タスク」の画面で使う）。
 *
 * 本文（JSON）の ToDo ブロック（checkListItem）のうち、チェックしていないものを記録する。
 * 期限は ToDo の文の中の日付（due。「@2026/11/20」と打つと入る）。文と期限は暗号化して保存する
 */
import { encryptText } from './crypto.ts';
import { all, batch, sql, type Stmt } from './db.ts';
import { now } from './util.ts';

export type Todo = { blockId: string; text: string; due: string | null };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 文中の内容を文字列にする（期限の日付・脚注は除く） */
function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const c of content as Record<string, any>[]) {
    if (c?.type === 'text' && typeof c.text === 'string') out += c.text;
    else if (c?.type === 'link') out += inlineText(c.content);
    else if (c?.type === 'math' && typeof c.props?.latex === 'string') out += `$${c.props.latex}$`;
  }
  return out;
}

function firstDue(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const c of content as Record<string, any>[]) {
    if (c?.type === 'due' && typeof c.props?.date === 'string' && DATE_RE.test(c.props.date)) return c.props.date;
  }
  return null;
}

/** 本文（ブロックの配列）から未完了の ToDo を集める */
export function extractTodos(blocks: unknown): Todo[] {
  const out: Todo[] = [];
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const b of list as Record<string, any>[]) {
      if (b?.type === 'checkListItem' && !b.props?.checked && typeof b.id === 'string') {
        const text = inlineText(b.content).replace(/\s+/g, ' ').trim();
        const due = firstDue(b.content);
        if (text || due) out.push({ blockId: b.id, text: text.slice(0, 500), due });
      }
      walk(b?.children);
    }
  };
  walk(blocks);
  return out;
}

/** ToDo の記録を作り直す文 */
export async function pageTodosStmts(pageId: string, content: string): Promise<Stmt[]> {
  let blocks: unknown = [];
  try {
    blocks = JSON.parse(content);
  } catch {
    /* 読めない本文は ToDo なしとして扱う */
  }
  const todos = extractTodos(blocks);
  const stmts: Stmt[] = [sql('DELETE FROM page_todos WHERE page_id = ?', pageId)];
  for (const [i, t] of todos.entries()) {
    stmts.push(
      sql(
        'INSERT OR REPLACE INTO page_todos (page_id, block_id, position, text, due) VALUES (?, ?, ?, ?, ?)',
        pageId,
        t.blockId,
        i,
        await encryptText(t.text),
        t.due ? await encryptText(t.due) : null,
      ),
    );
  }
  stmts.push(sql('UPDATE pages SET todos_indexed_at = ? WHERE id = ?', now(), pageId));
  return stmts;
}

/** まだ記録していないページを少しずつ記録する（workspaceId を渡すと、そのワークスペースだけ） */
export async function indexPageTodos(limit = 300, workspaceId?: string) {
  const pages = workspaceId
    ? await all<{ id: string; content: string }>('SELECT id, content FROM pages WHERE todos_indexed_at IS NULL AND workspace_id = ? LIMIT ?', workspaceId, limit)
    : await all<{ id: string; content: string }>('SELECT id, content FROM pages WHERE todos_indexed_at IS NULL LIMIT ?', limit);
  const stmts: Stmt[] = [];
  for (const p of pages) stmts.push(...(await pageTodosStmts(p.id, p.content)));
  for (let i = 0; i < stmts.length; i += 100) await batch(stmts.slice(i, i + 100));
  return pages.length;
}
