/**
 * Notion の書き出し（「Markdown と CSV」形式の ZIP）を取り込む。すべてブラウザの中で処理する。
 *
 * Notion の ZIP の中身
 * - ページ：`タイトル <32桁のID>.md`。サブページはページと同じ名前のフォルダ（`タイトル <ID>/`）の中
 * - 画像・添付ファイル：ページのフォルダの中。本文からは相対パス（URL エンコード）で参照される
 * - データベース：`名前 <ID>.csv`（と全件の `名前 <ID>_all.csv`）。各行のページは同じ名前のフォルダの中
 * - 大きな書き出しは ZIP の中に ZIP（Part-1, Part-2 …）が入っている
 *
 * 取り込み先：ワークスペースの最上位に「Notion から取り込み」ページを作り、その下に元の階層のまま作る。
 * 画像・添付ファイルはアップロードし直し、ページ同士のリンクは取り込んだページを指すように書き換える。
 */
import { strFromU8, unzipSync } from 'fflate';
import { api, uploadFile, type Page } from '../api';
import { blocksToText } from './text';

export type NotionProgress = { phase: string; done: number; total: number };
export type NotionResult = { rootId: string; pages: number; databases: number; files: number; failed: string[] };

type Entry = { path: string; data: Uint8Array };
type Node = {
  /** ZIP 内のパス（md / csv） */
  path: string;
  /** サブページが入るフォルダのパス（拡張子を除いたもの） */
  dir: string;
  kind: 'page' | 'db';
  title: string;
  parent: Node | null;
  id?: string;
  version?: number;
};

const ID_RE = /\s+[0-9a-f]{32}$/i;
const cleanName = (s: string) => s.replace(ID_RE, '').trim() || '無題';
const stripExt = (p: string) => p.replace(/\.[^./]+$/, '');
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** ZIP を展開する。中に ZIP があればそれも展開して、同じ場所に並べる */
function expand(data: Uint8Array, depth = 0): Entry[] {
  const out: Entry[] = [];
  const files = unzipSync(data);
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(name)) continue;
    if (/\.zip$/i.test(name) && depth < 3) out.push(...expand(bytes, depth + 1));
    else out.push({ path: name.normalize('NFC'), data: bytes });
  }
  return out;
}

/** 相対パスを ZIP 内のパスにする（`..` や `.` を解決） */
function resolvePath(base: string, rel: string) {
  const parts = base ? base.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Markdown のリンク・画像 `[..](..)` の URL を書き換える（URL の中の括弧も考慮する） */
function rewriteLinks(md: string, fn: (url: string) => string | null) {
  let out = '';
  let i = 0;
  while (i < md.length) {
    const j = md.indexOf('](', i);
    if (j < 0) break;
    out += md.slice(i, j + 2);
    let k = j + 2;
    let depth = 1;
    while (k < md.length && md[k] !== '\n') {
      if (md[k] === '(') depth++;
      else if (md[k] === ')' && --depth === 0) break;
      k++;
    }
    if (depth !== 0) {
      i = j + 2;
      continue;
    }
    const inner = md.slice(j + 2, k);
    // 末尾のタイトル（"..."）は分けておく
    const m = /^(\S+?)(\s+"[^"]*")?$/.exec(inner.trim()) ?? /^(.+?)(\s+"[^"]*")?$/.exec(inner.trim());
    const url = m?.[1] ?? inner;
    const next = fn(url);
    out += next === null ? inner : `${next}${m?.[2] ?? ''}`;
    out += ')';
    i = k + 1;
  }
  return out + md.slice(i);
}

/** CSV を読む（ダブルクオート・改行を含むセルに対応） */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
};

const cell = (text: string, link?: string) => ({
  type: 'tableCell',
  props: { backgroundColor: 'default', textColor: 'default', textAlignment: 'left', colspan: 1, rowspan: 1 },
  content: link ? [{ type: 'link', href: link, content: [{ type: 'text', text, styles: {} }] }] : text ? [{ type: 'text', text, styles: {} }] : [],
});

/** 同時に実行する数を制限して順に処理する */
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

export function isNotionExport(name: string) {
  return /\.zip$/i.test(name);
}

export async function importNotionZip(file: File, workspaceId: string, onProgress: (p: NotionProgress) => void): Promise<NotionResult> {
  onProgress({ phase: 'ZIP を展開しています', done: 0, total: 0 });
  const entries = expand(new Uint8Array(await file.arrayBuffer()));
  const byPath = new Map(entries.map((e) => [e.path, e]));

  // 「HTML」形式で書き出された ZIP は対象外（Markdown がない）
  const mds = entries.filter((e) => /\.md$/i.test(e.path));
  const csvs = entries.filter((e) => /\.csv$/i.test(e.path));
  if (!mds.length && !csvs.length) {
    if (entries.some((e) => /\.html?$/i.test(e.path))) throw new Error('HTML 形式の書き出しです。Notion で「Markdown と CSV」形式を選んで書き出してください');
    throw new Error('Notion の書き出し（Markdown と CSV）が見つかりませんでした');
  }

  // ページとデータベースの一覧（データベースは全件の _all.csv を優先）
  const nodes = new Map<string, Node>(); // dir → node
  for (const e of mds) {
    const dir = stripExt(e.path);
    nodes.set(dir, { path: e.path, dir, kind: 'page', title: cleanName(dir.split('/').pop()!), parent: null });
  }
  for (const e of csvs) {
    const dir = stripExt(e.path).replace(/_all$/, '');
    const cur = nodes.get(dir);
    if (cur?.kind === 'page') continue;
    if (cur && !/_all\.csv$/i.test(e.path)) continue;
    nodes.set(dir, { path: e.path, dir, kind: 'db', title: cleanName(dir.split('/').pop()!), parent: null });
  }
  // 親：同じ名前のフォルダを持つページ。なければ上の階層をたどる
  for (const n of nodes.values()) {
    for (let d = dirOf(n.path); d; d = dirOf(d)) {
      const p = nodes.get(d);
      if (p && p !== n) {
        n.parent = p;
        break;
      }
    }
  }
  const depth = (n: Node) => {
    let k = 0;
    for (let p = n.parent; p; p = p.parent) k++;
    return k;
  };
  const ordered = [...nodes.values()].sort((a, b) => depth(a) - depth(b) || a.title.localeCompare(b.title, 'ja'));

  // 1. ページを作る（親から順に）
  const stamp = new Date().toLocaleDateString('ja-JP');
  const root = (await api<{ page: Page }>('/pages', { body: { workspaceId, visibility: 'workspace', title: `Notion から取り込み（${stamp}）` } })).page;
  const failed: string[] = [];
  let done = 0;
  const total = ordered.length;
  for (const n of ordered) {
    onProgress({ phase: 'ページを作成しています', done, total });
    try {
      const parentId = n.parent?.id ?? root.id;
      const { page } = await api<{ page: Page }>('/pages', { body: { workspaceId, parentId, visibility: 'workspace', title: n.title.slice(0, 500) } });
      n.id = page.id;
      n.version = page.version;
    } catch (e) {
      failed.push(`${n.title}：${(e as Error).message}`);
    }
    done++;
  }

  // 2. 本文（画像・添付をアップロードし、リンクを書き換える）
  const { headlessEditor, markdownToBlocks } = await import('./math');
  const editor = await headlessEditor();
  const uploaded = new Map<string, Promise<string | null>>();
  let fileCount = 0;
  const upload = (path: string) => {
    let p = uploaded.get(path);
    if (!p) {
      const e = byPath.get(path)!;
      const name = path.split('/').pop()!;
      const ext = name.split('.').pop()?.toLowerCase() ?? '';
      p = uploadFile(new File([e.data as BlobPart], name, { type: MIME[ext] ?? 'application/octet-stream' })).then(
        (url) => {
          fileCount++;
          return url;
        },
        (err: Error) => {
          failed.push(`${name}：${err.message}`);
          return null;
        },
      );
      uploaded.set(path, p);
    }
    return p;
  };
  const byFile = new Map([...nodes.values()].map((n) => [n.path, n]));
  // `_all.csv` ではない方の CSV へのリンクも同じデータベースを指す
  for (const e of csvs) {
    const n = nodes.get(stripExt(e.path).replace(/_all$/, ''));
    if (n) byFile.set(e.path, n);
  }

  /** 本文中の URL を、取り込み後の URL にする（外部リンクはそのまま） */
  const target = async (from: string, url: string): Promise<string | null> => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#') || url.startsWith('/')) return null;
    const [raw, hash] = url.split('#');
    const path = resolvePath(dirOf(from), safeDecode(raw!));
    const node = byFile.get(path) ?? nodes.get(stripExt(path));
    if (node?.id) return `/p/${node.id}${hash ? `#${hash}` : ''}`;
    if (byPath.has(path) && !/\.(md|csv)$/i.test(path)) return upload(path);
    return null;
  };

  done = 0;
  await pool(ordered, 3, async (n) => {
    onProgress({ phase: '本文と画像を取り込んでいます', done, total });
    try {
      if (!n.id) return;
      let blocks: any[];
      if (n.kind === 'page') {
        let md = strFromU8(byPath.get(n.path)!.data).replace(/^﻿/, '');
        // 先頭の「# タイトル」はページのタイトルと同じなので除く
        md = md.replace(/^#\s+(.+)\r?\n/, (all, t: string) => (t.trim() === n.title ? '' : all));
        // URL を先に調べてから置き換える（非同期のため 2 回に分ける）
        const urls: string[] = [];
        rewriteLinks(md, (u) => (urls.push(u), null));
        const map = new Map<string, string | null>();
        for (const u of urls) if (!map.has(u)) map.set(u, await target(n.path, u));
        md = rewriteLinks(md, (u) => map.get(u) ?? null);
        blocks = await markdownToBlocks(editor, md);
      } else {
        // データベース：表にする。1 列目（名前）は行のページへのリンクにする
        const rows = parseCsv(strFromU8(byPath.get(n.path)!.data)).slice(0, 1000);
        const kids = new Map([...nodes.values()].filter((k) => k.parent === n && k.id).map((k) => [k.title, k.id!]));
        const width = Math.min(30, Math.max(...rows.map((r) => r.length)));
        blocks = rows.length
          ? [
              {
                type: 'table',
                content: {
                  type: 'tableContent',
                  headerRows: 1,
                  rows: rows.map((r, i) => ({
                    cells: Array.from({ length: width }, (_, c) => {
                      const text = r[c] ?? '';
                      const id = i > 0 && c === 0 ? kids.get(text.trim()) : undefined;
                      return cell(text, id ? `/p/${id}` : undefined);
                    }),
                  })),
                },
              },
            ]
          : [];
      }
      await api(`/pages/${n.id}`, { method: 'PATCH', body: { version: n.version, content: blocks, contentText: blocksToText(blocks) } });
    } catch (e) {
      failed.push(`${n.title}：${(e as Error).message}`);
    } finally {
      done++;
    }
  });
  onProgress({ phase: '完了', done: total, total });
  return {
    rootId: root.id,
    pages: ordered.filter((n) => n.kind === 'page' && n.id).length,
    databases: ordered.filter((n) => n.kind === 'db' && n.id).length,
    files: fileCount,
    failed,
  };
}
