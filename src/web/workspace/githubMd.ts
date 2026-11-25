/** GitHub と同期しているページの Markdown ⇔ エディタの変換（相対パスの画像はアプリ経由で表示する） */
import { api, type Page } from '../api';
import { blocksToText } from './text';

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const dirOf = (p: string) => (p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '');

function resolve(dir: string, rel: string) {
  const out = dir ? dir.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

function relative(fromDir: string, to: string) {
  const a = fromDir ? fromDir.split('/') : [];
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

const isRelative = (u: string) => !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(u);

/** GitHub の Markdown → 画面用（相対パスの画像を /api/github/raw/... に） */
export function fromGithub(md: string, workspaceId: string, path: string) {
  const dir = dirOf(path);
  const raw = (rel: string) => {
    let p = rel;
    try {
      p = decodeURI(rel);
    } catch {
      /* そのまま */
    }
    return `/api/github/raw/${workspaceId}/${encPath(resolve(dir, p))}`;
  };
  return md
    .replace(/(!\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (m, a: string, url: string, b: string) => (isRelative(url) ? a + raw(url) + b : m))
    .replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/gi, (m, a: string, url: string, b: string) => (isRelative(url) ? a + raw(url) + b : m));
}

/** 画面用の Markdown → GitHub（/api/github/raw/... を相対パスに戻す） */
export function toGithub(md: string, workspaceId: string, path: string) {
  const dir = dirOf(path);
  const prefix = `/api/github/raw/${workspaceId}/`;
  return md.split(prefix).reduce((acc, part, i) => {
    if (i === 0) return part;
    const end = part.search(/[)\s"]/);
    const target = end < 0 ? part : part.slice(0, end);
    let decoded = target;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      /* そのまま */
    }
    return acc + encodeURI(relative(dir, decoded)) + part.slice(target.length);
  }, '');
}

/**
 * 1 行目の見出し 1（`# タイトル`）を除く。タイトルはファイル名で表示するため、本文には出さない
 * （GitHub に送るときは、サーバーが元の見出しを付け直す）
 */
export function stripTitleHeading(md: string) {
  return md.replace(/^\uFEFF?#[ \t]+[^\n]*(\r?\n|$)(?:[ \t]*\r?\n)*/, '');
}

/** GitHub から取り込んだ新しい内容があれば、エディタのブロックに変換して保存する */
export async function prepareGithubPage(page: Page): Promise<Page> {
  const gh = page.github;
  if (!gh || gh.kind !== 'md') return page;
  const { headlessEditor, blocksToMarkdown, markdownToBlocks } = await import('./math');
  const editor = await headlessEditor();
  // 開いただけで GitHub に送らないよう、今の内容を Markdown にしたものを基準として持っておく
  const baseline = (blocks: any[]) => toGithub(blocksToMarkdown(editor, blocks), page.workspaceId, gh.path ?? '');
  if (gh.sourceMd === null) return { ...page, github: { ...gh, baselineMd: baseline(page.content) } };
  const blocks = await markdownToBlocks(editor, fromGithub(stripTitleHeading(gh.sourceMd), page.workspaceId, gh.path ?? ''));
  let version = page.version;
  if (page.access !== 'view' && !page.deletedAt) {
    try {
      const r = await api<{ version: number }>(`/pages/${page.id}`, {
        method: 'PATCH',
        body: { version, content: blocks, contentText: blocksToText(blocks), contentMdRev: gh.mdRev },
      });
      version = r.version;
    } catch {
      /* 保存できなくても表示はする */
    }
  }
  return { ...page, content: blocks, version, github: { ...gh, sourceMd: null, contentMdRev: gh.mdRev, baselineMd: baseline(blocks) } };
}

/** 編集した内容を GitHub に送る */
export function pushToGithub(pageId: string, keepalive = false) {
  return fetch(`/api/github/pages/${pageId}/push`, { method: 'POST', credentials: 'same-origin', keepalive }).then((r) =>
    r.ok ? (r.json() as Promise<{ status: 'pushed' | 'skipped' | 'conflict'; path: string | null }>) : null,
  );
}

/**
 * 普通のページを GitHub のフォルダへ移したときに、本文を Markdown にして送る（GitHub にファイルとして追加される）
 */
export async function convertPageToGithub(pageId: string) {
  const { page } = await api<{ page: Page }>(`/pages/${pageId}`);
  const { headlessEditor, blocksToMarkdown } = await import('./math');
  const md = blocksToMarkdown(await headlessEditor(), page.content);
  await api(`/pages/${pageId}`, { method: 'PATCH', body: { version: page.version, markdown: md } });
  await pushToGithub(pageId);
}
