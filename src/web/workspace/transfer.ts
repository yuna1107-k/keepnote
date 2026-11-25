/** ページの書き出し（Markdown / HTML）と取り込み（Markdown / HTML / テキスト） */
import { api, uploadFile, type Page } from '../api';
import { blocksToText } from './text';

export function safeFileName(title: string) {
  // 「..」などの点だけ・点で始まる名前は、展開したときにフォルダの外へ出たり隠しファイルになったりするので避ける
  const name = (title.trim() || '無題').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_').slice(0, 80);
  return name || '無題';
}

export function download(filename: string, content: string | Blob, type: string) {
  const url = URL.createObjectURL(typeof content === 'string' ? new Blob([content], { type }) : content);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 相対パスの画像URLを絶対URLにして、書き出したファイルからも辿れるようにする */
function absolutize(text: string) {
  return text.replace(/(["(])\/api\/files\//g, `$1${window.location.origin}/api/files/`);
}

export function exportMarkdown(title: string, markdown: string, author?: string) {
  const authorBlock = author?.trim() ? `執筆者: ${author.trim()}\n\n` : '';
  download(`${safeFileName(title)}.md`, `# ${title || '無題'}\n\n${authorBlock}${absolutize(markdown)}`, 'text/markdown;charset=utf-8');
}

export function exportHTML(title: string, html: string, author?: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const authorHtml = author?.trim() ? `<p class="author">${esc(author.trim())}</p>` : '';
  const doc = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title || '無題')}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif;max-width:760px;margin:48px auto;padding:0 20px;line-height:1.7;color:#37352f}
img,video{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 10px}
pre{background:#f7f6f3;padding:12px;border-radius:6px;overflow:auto}blockquote{border-left:3px solid #ccc;margin:0;padding-left:14px}
.author{text-align:right;color:#666;font-size:14px;white-space:pre-wrap;margin-top:-8px;margin-bottom:24px}
</style></head><body><h1>${esc(title || '無題')}</h1>
${authorHtml}
${absolutize(html)}
</body></html>`;
  download(`${safeFileName(title)}.html`, doc, 'text/html;charset=utf-8');
}

/** 取り込めるファイルか */
export const IMPORT_EXT = /\.(md|markdown|html?|txt|docx|pptx|csv|tsv|xlsx|xlsm|ods|ipynb)$/i;
/** 表を取り込むときの行の上限（多すぎるとページが重くなる） */
const IMPORT_MAX_ROWS = 2000;
/** ページに表示できる画像の形式（それ以外の画像は取り込まない） */
const WEB_IMAGE = /^image\/(png|jpeg|gif|webp|bmp|avif|svg\+xml)$/;

/** 文書の中の画像をアップロードして、その URL を返す（表示できない形式は null） */
async function uploadImage(blob: Blob) {
  if (!WEB_IMAGE.test(blob.type)) return null;
  const ext = blob.type.split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  try {
    return await uploadFile(new File([blob], `image.${ext}`, { type: blob.type }));
  } catch {
    return null;
  }
}

/** 段落の中の画像を段落の外に出す（そのままだと画像のブロックにならない） */
export function liftImages(html: string) {
  // 画面に出さない文書の中で組み替える（画像の読み込みなどを起こさない）
  const box = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
  for (const img of box.querySelectorAll('p img')) {
    const p = img.closest('p')!;
    img.removeAttribute('alt');
    p.parentNode!.insertBefore(img, p);
    if (!p.textContent?.trim() && !p.querySelector('img')) p.remove();
  }
  return box.innerHTML;
}

const textCell = (text: string) => ({
  type: 'tableCell',
  props: { backgroundColor: 'default', textColor: 'default', textAlignment: 'left', colspan: 1, rowspan: 1 },
  content: text ? [{ type: 'text', text, styles: {} }] : [],
});

/** ファイルを読み込んで新しいページを作る。作成したページIDを返す */
export async function importFile(file: File, parentId: string | null, visibility: 'workspace' | 'private', workspaceId?: string): Promise<string> {
  if (!IMPORT_EXT.test(file.name)) throw new Error(`「${file.name}」は取り込めない形式です`);
  const { headlessEditor, markdownToBlocks, htmlToBlocks } = await import('./math');
  const editor = await headlessEditor();
  const isHtml = /\.html?$/i.test(file.name) || file.type === 'text/html';
  const fileTitle = file.name.replace(/\.[^.]+$/, '');
  let title = fileTitle;
  let text = '';
  let blocks: any[];

  if (/\.docx$/i.test(file.name)) {
    const { docxToHtml } = await import('./office');
    const html = await docxToHtml(await file.arrayBuffer(), uploadImage);
    blocks = (await htmlToBlocks(editor, liftImages(html))).filter((b: any) => b.type !== 'image' || b.props?.url);
  } else if (/\.(csv|tsv|xlsx|xlsm|ods)$/i.test(file.name)) {
    const { readSheets } = await import('./office');
    const sheets = readSheets(await file.arrayBuffer(), file.name).filter((s) => s.rows.length);
    blocks = [];
    for (const sheet of sheets) {
      if (sheets.length > 1) blocks.push({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: sheet.name, styles: {} }] });
      const rows = sheet.rows.slice(0, IMPORT_MAX_ROWS);
      blocks.push({
        type: 'table',
        content: { type: 'tableContent', headerRows: rows.length > 1 ? 1 : undefined, rows: rows.map((r) => ({ cells: r.map(textCell) })) },
      });
      if (sheet.rows.length > IMPORT_MAX_ROWS || sheet.truncated)
        blocks.push({ type: 'paragraph', content: [{ type: 'text', text: `（大きい表のため、先頭の ${rows.length} 行だけを取り込みました）`, styles: { italic: true } }] });
    }
  } else if (/\.pptx$/i.test(file.name)) {
    // スライドごとに、タイトルを見出しにして、文字と画像を並べる
    const { readPptx } = await import('./pptx');
    const deck = readPptx(await file.arrayBuffer());
    blocks = [];
    for (const [i, slide] of deck.slides.entries()) {
      const shapes = [...slide.shapes].sort((a, b) => a.y - b.y || a.x - b.x);
      const title = shapes.find((s) => s.title)?.paragraphs.map((p) => p.text).join(' ').trim();
      blocks.push({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: title || `スライド ${i + 1}`, styles: {} }] });
      for (const sh of shapes) {
        if (sh.title) continue;
        if (sh.image) {
          const url = await uploadImage(new Blob([sh.image.bytes as BlobPart], { type: sh.image.type }));
          if (url) blocks.push({ type: 'image', props: { url } });
          continue;
        }
        for (const p of sh.paragraphs) {
          if (!p.text.trim()) continue;
          blocks.push({ type: p.bullet ? 'bulletListItem' : 'paragraph', content: [{ type: 'text', text: p.text, styles: {} }] });
        }
      }
    }
  } else if (/\.ipynb$/i.test(file.name)) {
    const { ipynbToMarkdown } = await import('./office');
    blocks = await markdownToBlocks(editor, await ipynbToMarkdown(await file.text(), uploadImage));
  } else {
    text = await file.text();
    blocks = isHtml ? await htmlToBlocks(editor, text) : await markdownToBlocks(editor, text);
  }

  // 先頭の見出し1をページタイトルとして使う
  const first = blocks[0];
  if (first?.type === 'heading' && first.props?.level === 1) {
    const t = blocksToText([first]).trim();
    if (t) {
      title = t;
      blocks = blocks.slice(1);
    }
  }
  if (isHtml) {
    const m = text.match(/<title>([^<]*)<\/title>/i);
    if (m?.[1]?.trim() && title === fileTitle) title = m[1].trim();
  }

  const { page } = await api<{ page: Page }>('/pages', { body: { parentId, visibility, workspaceId, title: title.slice(0, 500) } });
  await api(`/pages/${page.id}`, {
    method: 'PATCH',
    body: { version: page.version, content: blocks, contentText: blocksToText(blocks) },
  });
  return page.id;
}

/**
 * レポートの体裁で PDF にする（印刷画面を開く。保存先に「PDF に保存」を選ぶ）。
 * 国際関係論などのレポートに合わせた体裁：A4（余白 20mm）・明朝体 10.5pt・ゆったりした行間・両端揃え・段落頭 1 字下げ・
 * 冒頭に表題（下に横線）、縦線のない表、下中央にページ番号。
 */
/** 表の 1 行目を見出し行（thead）にする（ページをまたいだときに、次のページでも見出しを繰り返すため） */
function withTableHeads(html: string) {
  const box = document.createElement('div');
  box.innerHTML = html;
  for (const table of box.querySelectorAll('table')) {
    if (table.querySelector('thead')) continue;
    const first = table.querySelector('tr');
    if (!first || !table.querySelector('tr + tr')) continue;
    const thead = document.createElement('thead');
    thead.appendChild(first);
    table.insertBefore(thead, table.firstChild);
  }
  return box.innerHTML;
}

/**
 * 表の幅を整える（印刷する文書の中で測る）。
 * まずセルを折り返さずに並べ、本文の幅（170mm）に収まればそのまま。
 * はみ出すときは文字を少しだけ小さくし、それでも収まらなければ、幅の広い列から順に幅を揃えて
 * その列だけ折り返す（狭い列は折り返さない）。明示的な改行（<br>・段落）はそのまま残る。
 */
function fitTables(doc: Document) {
  const body = doc.querySelector('.report-body');
  if (!body) return;
  const probe = doc.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;width:170mm;height:0';
  doc.body.appendChild(probe);
  const pageWidth = probe.getBoundingClientRect().width;
  probe.remove();
  for (const table of body.querySelectorAll('table')) {
    const parent = table.parentElement!;
    const indent = parent === body ? 0 : parent.getBoundingClientRect().left - body.getBoundingClientRect().left;
    const limit = pageWidth - Math.max(0, indent) - 1;
    table.classList.add('fit-nowrap');
    if (table.getBoundingClientRect().width <= limit) continue;
    // 少しだけ小さくして収まるなら、折り返さずに済ませる
    table.classList.add('fit-small');
    const natural = table.getBoundingClientRect().width;
    if (natural <= limit) continue;

    // 列の境目を、セルの左端の位置から求める（結合したセルがあっても数えられる）
    const cells = [...table.querySelectorAll<HTMLTableCellElement>('td, th')];
    const left0 = table.getBoundingClientRect().left;
    const edges = [...new Set(cells.map((c) => Math.round(c.getBoundingClientRect().left - left0)))].sort((a, b) => a - b);
    edges.push(Math.round(natural));
    const widths = edges.slice(0, -1).map((x, i) => edges[i + 1] - x);
    if (widths.length < 1 || widths.some((w) => w <= 0)) {
      table.classList.remove('fit-nowrap');
      continue;
    }
    // 幅の上限 cap を、全体がちょうど収まるように決める（cap より狭い列はそのまま）
    const sorted = [...widths].sort((a, b) => a - b);
    let rest = limit;
    let cap = 0;
    for (let i = 0; i < sorted.length; i++) {
      const even = rest / (sorted.length - i);
      if (sorted[i] > even) {
        cap = even;
        break;
      }
      rest -= sorted[i];
    }
    const final = widths.map((w) => (cap && w > cap ? cap : w));
    const narrowed = new Set(widths.flatMap((w, i) => (cap && w > cap ? [i] : [])));

    table.querySelector('colgroup')?.remove();
    const group = doc.createElement('colgroup');
    for (const w of final) {
      const col = doc.createElement('col');
      col.style.width = `${w.toFixed(1)}px`;
      group.appendChild(col);
    }
    // 位置を先にすべて読む（折り返しを許すと表の形が変わるため）
    const starts = cells.map((c) => edges.indexOf(Math.round(c.getBoundingClientRect().left - left0)));
    for (const [n, cell] of cells.entries()) {
      const start = starts[n];
      const span = Math.max(1, cell.colSpan);
      for (let i = start; i < start + span; i++) {
        if (narrowed.has(i)) {
          cell.classList.add('fit-wrap');
          break;
        }
      }
    }
    table.insertBefore(group, table.firstChild);
    table.style.tableLayout = 'fixed';
    table.style.width = `${final.reduce((a, b) => a + b, 0).toFixed(1)}px`;
  }
}

export function exportReportPDF(title: string, bodyHtml: string, author?: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  // KaTeX など、アプリで読み込んでいるスタイル（数式の表示に必要）を引き継ぐ
  const styles = [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => `<link rel="stylesheet" href="${esc((l as HTMLLinkElement).href)}">`).join('\n');
  const authorHtml = author?.trim() ? `<div class="report-meta"><span class="report-author">${esc(author.trim())}</span></div>` : '';
  const doc = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${esc(title || '無題')}</title>
${styles}
<style>
@page { size: A4; margin: 20mm 20mm 18mm; @bottom-center { content: "– " counter(page) " –"; font-family: "Times New Roman", "Hiragino Mincho ProN", "Yu Mincho", serif; font-size: 9pt; color: #444; } }
html, body { background: #fff !important; color: #111 !important; margin: 0; }
@media screen { body { background: #e9e9e9 !important; padding: 24px 12px; } .report { box-sizing: content-box; max-width: 170mm; margin: 0 auto; background: #fff; padding: 20mm; box-shadow: 0 2px 12px rgba(0,0,0,.15); } }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.report { font-family: "Times New Roman", "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif; font-size: 10.5pt; line-height: 1.9; text-align: justify; text-justify: inter-character; font-feature-settings: "palt" 0; }
.report-head { text-align: center; margin: 0 0 1.4em; padding-bottom: 0.9em; border-bottom: 0.75pt solid #111; }
.report-title { font-size: 16pt; font-weight: bold; line-height: 1.5; margin: 0; letter-spacing: 0.02em; }
.report-meta { text-align: right; margin-top: 0.8em; font-size: 10.5pt; color: #222; }
.report-author { display: inline-block; white-space: pre-wrap; text-align: right; }
.report-body p { margin: 0; text-indent: 1em; }
.report-body p:empty { display: none; }
.report-body h1, .report-body h2, .report-body h3, .report-body h4 { font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif; font-weight: bold; line-height: 1.6; text-indent: 0; break-after: avoid; page-break-after: avoid; }
.report-body h1 { font-size: 12pt; margin: 1.8em 0 0.6em; }
.report-body h2 { font-size: 11pt; margin: 1.4em 0 0.4em; }
.report-body h3, .report-body h4 { font-size: 10.5pt; margin: 1.1em 0 0.3em; }
.report-body ul, .report-body ol { margin: 0.4em 0 0.6em; padding-left: 2em; }
.report-body li { margin: 0.1em 0; }
.report-body li p { text-indent: 0; }
.report-body blockquote { margin: 0.8em 2em; font-size: 9.5pt; line-height: 1.75; }
.report-body blockquote p { text-indent: 0; }
.report-body table { border-collapse: collapse; margin: 1em auto; font-size: 9.5pt; line-height: 1.5; border-top: 1.5px solid #111; border-bottom: 1.5px solid #111; }
.report-body tr { break-inside: avoid; page-break-inside: avoid; }
.report-body thead { display: table-header-group; }
.report-body th, .report-body td { border: 0; padding: 0.35em 0.9em; text-align: left; vertical-align: top; }
.report-body table.fit-nowrap :is(td, th, td *, th *) { white-space: nowrap; }
.report-body table.fit-small { font-size: 8.5pt; }
.report-body table.fit-small :is(td, th) { padding: 0.35em 0.7em; }
.report-body table.fit-nowrap :is(td.fit-wrap, th.fit-wrap, td.fit-wrap *, th.fit-wrap *) { white-space: normal; word-break: auto-phrase; overflow-wrap: anywhere; }
.report-body thead th, .report-body thead td { border-bottom: 0.75px solid #111; font-weight: bold; }
.report-body td p, .report-body th p { text-indent: 0; }
.report-body img { display: block; max-width: 100%; margin: 1em auto 0.4em; break-inside: avoid; }
.report-body figcaption, .report-body .bn-file-caption { text-align: center; font-size: 9pt; }
.report-body pre { font-family: "SFMono-Regular", Menlo, Consolas, monospace; font-size: 8.5pt; line-height: 1.5; border: 0.5px solid #999; padding: 0.6em 0.8em; white-space: pre-wrap; }
.report-body code { font-family: "SFMono-Regular", Menlo, Consolas, monospace; font-size: 0.9em; }
.report-body a { color: inherit; text-decoration: underline; text-decoration-thickness: 0.5px; }
.report-body hr { border: 0; border-top: 0.75px solid #111; margin: 1.2em 0; }
.report-equation { text-align: center; margin: 0.8em 0; text-indent: 0; }
.report-body .katex { font-size: 1.05em; }
.report .katex, .report .katex * { color: #111 !important; }
.report-body input[type="checkbox"] { margin-right: 0.4em; }
.report-fnref { font-size: 0.7em; line-height: 0; vertical-align: super; margin: 0 0.05em; }
.report-notes, .report-references { margin-top: 2em; }
.report-notes h2, .report-references h2 { font-size: 11pt; margin: 0 0 0.5em; }
.report-notes ol { margin: 0; padding-left: 2em; font-size: 9.5pt; line-height: 1.7; }
.report-notes li { margin: 0.15em 0; text-align: left; }
.report-references ul { list-style: none; margin: 0; padding: 0; }
.report-references li { padding-left: 2em; text-indent: -2em; margin: 0.25em 0; text-align: left; overflow-wrap: anywhere; }
</style></head>
<body><article class="report">
<header class="report-head"><h1 class="report-title">${esc(title || '無題')}</h1>${authorHtml}</header>
<main class="report-body">${absolutize(withTableHeads(bodyHtml))}</main>
</article></body></html>`;
  // 画面に見えない枠の中にレポートを用意して、印刷画面だけを開く（新しいタブは開かない）
  document.querySelector('iframe.report-print-frame')?.remove();
  const frame = document.createElement('iframe');
  frame.className = 'report-print-frame';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;left:0;top:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none;z-index:-1';
  document.body.appendChild(frame);
  const w = frame.contentWindow!;
  w.document.open();
  w.document.write(doc);
  w.document.close();
  const target = w;
  const ready = async () => {
    // 文字と画像の読み込みを待ってから印刷する
    await target.document.fonts?.ready.catch(() => {});
    await Promise.all([...target.document.images].map((img) => (img.complete ? null : new Promise((r) => ((img.onload = r), (img.onerror = r))))));
    fitTables(target.document);
    // 印刷画面を閉じたら枠を片付ける（閉じたことが分からない端末のために、時間がたっても片付ける）
    target.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 1000), { once: true });
    setTimeout(() => frame.remove(), 10 * 60_000);
    // Android アプリの中では、アプリの印刷（PDF に保存）で開く
    const app = (window as unknown as { Keepnote?: { printHtml?: (html: string, title: string) => void } }).Keepnote;
    if (app?.printHtml) {
      app.printHtml(`<!doctype html>${target.document.documentElement.outerHTML}`, title || '無題');
      setTimeout(() => frame.remove(), 1000);
      return;
    }
    target.focus();
    target.print();
  };
  if (target.document.readyState === 'complete') void ready();
  else target.addEventListener('load', () => void ready(), { once: true });
}
