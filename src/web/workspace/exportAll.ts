/**
 * ワークスペースのまるごと書き出し：見られるページをすべて Markdown にして、
 * ページの並び（親子）のとおりにフォルダへ分け、貼ってあるファイルと一緒に ZIP にする。
 * すべてブラウザの中で行う（サーバーに ZIP を作らせない）。
 */
import { zipSync, strToU8, type Zippable } from 'fflate';
import { api, type Page, type PageSummary } from '../api';
import { blocksToMarkdown, headlessEditor } from './math';
import { download, safeFileName } from './transfer';
import { loadDatabase, valueText } from './dbModel';

export type ExportProgress = { done: number; total: number; label: string };

const FILE_URL = /\/api\/files\/[0-9a-f-]{36}/g;

export async function exportWorkspace(workspaceId: string, workspaceName: string, onProgress: (p: ExportProgress) => void) {
  const { pages } = await api<{ pages: PageSummary[] }>(`/pages?workspace=${encodeURIComponent(workspaceId)}`);
  const byParent = new Map<string | null, PageSummary[]>();
  const ids = new Set(pages.map((p) => p.id));
  for (const p of pages) {
    const parent = p.parentId && ids.has(p.parentId) ? p.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), p]);
  }
  byParent.forEach((list) => list.sort((a, b) => a.position - b.position));

  // ページごとの置き場所（子ページがあるページはフォルダにする）
  const paths = new Map<string, { dir: string; file: string }>();
  const place = (parent: string | null, dir: string) => {
    const used = new Set<string>();
    for (const p of byParent.get(parent) ?? []) {
      let name = safeFileName(p.title);
      for (let i = 2; used.has(name.toLowerCase()); i++) name = `${safeFileName(p.title)} (${i})`;
      used.add(name.toLowerCase());
      const hasChildren = (byParent.get(p.id) ?? []).length > 0;
      const here = hasChildren ? `${dir}${name}/` : dir;
      paths.set(p.id, { dir: here, file: `${here}${name}.md` });
      if (hasChildren) place(p.id, here);
    }
  };
  place(null, '');

  const editor = await headlessEditor();
  const zip: Zippable = {};
  const fileNames = new Map<string, string>();
  const usedFileNames = new Set<string>();
  const total = pages.length;
  let done = 0;
  let failed = 0;

  for (const summary of pages) {
    const where = paths.get(summary.id);
    if (!where) continue;
    onProgress({ done, total, label: summary.title || '無題' });
    try {
      const { page } = await api<{ page: Page }>(`/pages/${summary.id}`);
      let md = blocksToMarkdown(editor, page.content as any[]);
      // 貼ってあるファイルを取り込み、Markdown の中のリンクを ZIP の中の場所に書き換える
      for (const url of new Set(md.match(FILE_URL) ?? [])) {
        let name = fileNames.get(url);
        if (!name) {
          const res = await fetch(url, { credentials: 'same-origin' });
          if (!res.ok) continue;
          const disp = res.headers.get('Content-Disposition') ?? '';
          const m = /filename\*=UTF-8''([^;]+)/i.exec(disp) ?? /filename="?([^";]+)"?/i.exec(disp);
          let base = safeFileName(m ? decodeURIComponent(m[1]!) : url.split('/').pop()!);
          const dot = base.lastIndexOf('.');
          const stem = dot > 0 ? base.slice(0, dot) : base;
          const ext = dot > 0 ? base.slice(dot) : '';
          for (let i = 2; usedFileNames.has(base.toLowerCase()); i++) base = `${stem} (${i})${ext}`;
          usedFileNames.add(base.toLowerCase());
          name = `ファイル/${base}`;
          fileNames.set(url, name);
          zip[name] = [new Uint8Array(await res.arrayBuffer()), { level: 0 }];
        }
        // ページの場所から見た相対パス
        const up = '../'.repeat(where.dir.split('/').filter(Boolean).length);
        md = md.split(url).join(encodeURI(`${up}${name}`));
      }
      zip[where.file] = strToU8(`# ${page.title || '無題'}\n\n${md}`);
      // データベースは、行と列の値を CSV にして同じ場所に置く（Excel などで開ける）
      if (summary.isDatabase) {
        const db = await loadDatabase(summary.id);
        // =・+・-・@ で始まる値は Excel で数式として動くので、先頭に ' を付けて文字にする
        const cell = (raw: string) => {
          const v = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
          return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
        };
        const header = ['名前', ...db.schema.props.map((p) => p.name)];
        const lines = db.rows.map((r) => [r.title || '無題', ...db.schema.props.map((p) => valueText(p, r.values[p.id], db.members))].map(cell).join(','));
        // Excel で文字化けしないよう、先頭に BOM を付ける
        zip[where.file.replace(/\.md$/, '.csv')] = strToU8('\uFEFF' + [header.map(cell).join(','), ...lines].join('\r\n'));
      }
    } catch {
      failed++;
    }
    done++;
  }
  onProgress({ done, total, label: 'ZIP にまとめています' });
  const data = zipSync(zip, { level: 6 });
  const date = new Date();
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  download(`${safeFileName(workspaceName)}-${stamp}.zip`, new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), 'application/zip');
  return { pages: done - failed, files: fileNames.size, failed };
}
