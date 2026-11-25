/**
 * アップロードしたファイルから文字を取り出す（検索でファイルの中身も探すため）。
 * PDF・Word・表（Excel・ODS・CSV）・PowerPoint・テキストに対応する。重いので使うときだけ読み込む。
 */
const TEXT_EXT = /\.(txt|text|md|markdown|log|json|ya?ml|toml|ini|xml|html?|css|js|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sql|sh|tex|bib|rst|org|adoc)$/i;

export const canExtract = (name: string) => /\.(pdf|docx|xlsx|xlsm|ods|csv|tsv|pptx)$/i.test(name) || TEXT_EXT.test(name);

export async function extractFileText(file: File): Promise<string | null> {
  const name = file.name;
  const buf = await file.arrayBuffer();
  if (/\.pdf$/i.test(name)) {
    const pdfjs = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const task = pdfjs.getDocument({ data: new Uint8Array(buf), cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/' });
    const doc = await task.promise;
    const parts: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, 300); i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      parts.push(content.items.map((it) => ('str' in it ? it.str : '')).join(''));
    }
    void task.destroy();
    return parts.join('\n');
  }
  if (/\.docx$/i.test(name)) {
    const { docxToHtml } = await import('./office');
    const html = await docxToHtml(buf);
    return new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
  }
  if (/\.(xlsx|xlsm|ods|csv|tsv)$/i.test(name)) {
    const { readSheets } = await import('./office');
    return readSheets(buf, name)
      .map((s) => `${s.name}\n${s.rows.map((r) => r.join(' ')).join('\n')}`)
      .join('\n');
  }
  if (/\.pptx$/i.test(name)) {
    const { readPptx } = await import('./pptx');
    return readPptx(buf)
      .slides.map((s) => s.shapes.flatMap((sh) => sh.paragraphs.map((p) => p.text)).join('\n'))
      .join('\n');
  }
  if (TEXT_EXT.test(name)) return new TextDecoder().decode(buf);
  return null;
}
