/**
 * PowerPoint（.pptx）を読み、スライドの文字を書き換える。
 * 表示は文字と画像の位置だけを再現する簡易なもの。書き換えは文字だけで、図形・画像・デザインはそのまま残す。
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export type Para = { text: string; size: number | null; bold: boolean; align: string | null; bullet: boolean };
export type SlideShape = {
  /** スライドの中での順番（書き換えるときに使う） */
  key: number;
  kind: 'text' | 'pic';
  x: number;
  y: number;
  w: number;
  h: number;
  title: boolean;
  paragraphs: Para[];
  image?: { bytes: Uint8Array; type: string };
};
export type Deck = { width: number; height: number; slides: { shapes: SlideShape[] }[] };
/** 書き換え。キーは「スライド番号:図形の順番」、値は段落ごとの文字 */
export type SlideEdits = Map<string, string[]>;

const xml = (bytes: Uint8Array | undefined) => (bytes ? new DOMParser().parseFromString(strFromU8(bytes), 'application/xml') : null);
const kids = (n: Element | null | undefined, ns: string, local: string) => (n ? [...n.children].filter((c) => c.namespaceURI === ns && c.localName === local) : []);
const kid = (n: Element | null | undefined, ns: string, local: string) => kids(n, ns, local)[0] ?? null;

function unzip(buf: ArrayBuffer) {
  try {
    return unzipSync(new Uint8Array(buf));
  } catch {
    throw new Error('ファイルを読み取れませんでした（壊れているか、対応していない形式です）');
  }
}

/** 関係ファイルの相対パスを、パッケージの中のパスにする */
function resolve(base: string, target: string) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/');
  parts.pop();
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function relsOf(files: Record<string, Uint8Array>, path: string) {
  const dir = path.replace(/[^/]+$/, '');
  const name = path.split('/').pop();
  const doc = xml(files[`${dir}_rels/${name}.rels`]);
  const map = new Map<string, { target: string; type: string }>();
  for (const r of doc ? [...doc.documentElement.children] : [])
    if (r.getAttribute('TargetMode') !== 'External') map.set(r.getAttribute('Id') ?? '', { target: resolve(path, r.getAttribute('Target') ?? ''), type: r.getAttribute('Type') ?? '' });
  return map;
}

function slidePaths(files: Record<string, Uint8Array>) {
  const pres = xml(files['ppt/presentation.xml']);
  if (!pres) throw new Error('PowerPoint のファイルとして読み取れませんでした');
  const rels = relsOf(files, 'ppt/presentation.xml');
  const size = pres.getElementsByTagNameNS(P, 'sldSz')[0];
  const paths = [...pres.getElementsByTagNameNS(P, 'sldId')].map((s) => rels.get(s.getAttributeNS(R, 'id') ?? '')?.target).filter((p): p is string => !!p && !!files[p]);
  return { paths, width: Number(size?.getAttribute('cx')) || 12192000, height: Number(size?.getAttribute('cy')) || 6858000 };
}

/** スライドの中の図形（文字の図形と画像）を、文書の順番で並べる */
function shapesIn(doc: Document) {
  return [...doc.getElementsByTagNameNS(P, '*')].filter((e) => e.localName === 'sp' || e.localName === 'pic');
}

function placeholder(sp: Element) {
  const nv = kid(sp, P, 'nvSpPr') ?? kid(sp, P, 'nvPicPr');
  const ph = kid(kid(nv, P, 'nvPr'), P, 'ph');
  return ph ? { type: ph.getAttribute('type') ?? 'body', idx: ph.getAttribute('idx') } : null;
}

function xfrm(sp: Element) {
  const x = kid(kid(sp, P, 'spPr'), A, 'xfrm');
  const off = kid(x, A, 'off');
  const ext = kid(x, A, 'ext');
  return off && ext ? { x: Number(off.getAttribute('x')), y: Number(off.getAttribute('y')), w: Number(ext.getAttribute('cx')), h: Number(ext.getAttribute('cy')) } : null;
}

/** 位置が書かれていない図形は、レイアウト・マスターの同じ枠の位置を使う */
function inherited(ph: { type: string; idx: string | null }, docs: (Document | null)[]) {
  for (const d of docs) {
    if (!d) continue;
    const shapes = shapesIn(d);
    const same =
      (ph.idx && shapes.find((s) => placeholder(s)?.idx === ph.idx)) ||
      shapes.find((s) => {
        const t = placeholder(s)?.type;
        return t === ph.type || (ph.type === 'ctrTitle' && t === 'title') || (ph.type === 'subTitle' && t === 'body');
      });
    const pos = same && xfrm(same);
    if (pos) return pos;
  }
  return null;
}

function paragraphs(sp: Element): Para[] {
  const body = kid(sp, P, 'txBody');
  return kids(body, A, 'p').map((p) => {
    let text = '';
    for (const c of [...p.children]) {
      if (c.localName === 'r' || c.localName === 'fld') text += kid(c, A, 't')?.textContent ?? '';
      else if (c.localName === 'br') text += '\n';
    }
    const rPr = p.getElementsByTagNameNS(A, 'rPr')[0] ?? kid(p, A, 'endParaRPr');
    const pPr = kid(p, A, 'pPr');
    return {
      text,
      size: rPr?.getAttribute('sz') ? Number(rPr.getAttribute('sz')) / 100 : null,
      bold: rPr?.getAttribute('b') === '1',
      align: pPr?.getAttribute('algn') ?? null,
      bullet: !!kid(pPr, A, 'buChar') || !!kid(pPr, A, 'buAutoNum'),
    };
  });
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };

export function readPptx(buf: ArrayBuffer): Deck {
  const files = unzip(buf);
  const { paths, width, height } = slidePaths(files);
  const slides = paths.map((path) => {
    const doc = xml(files[path])!;
    const rels = relsOf(files, path);
    const layoutPath = [...rels.values()].find((r) => r.type.endsWith('/slideLayout'))?.target;
    const layout = layoutPath ? xml(files[layoutPath]) : null;
    const masterPath = layoutPath ? [...relsOf(files, layoutPath).values()].find((r) => r.type.endsWith('/slideMaster'))?.target : undefined;
    const master = masterPath ? xml(files[masterPath]) : null;
    const shapes: SlideShape[] = [];
    shapesIn(doc).forEach((sp, key) => {
      const ph = placeholder(sp);
      const pos = xfrm(sp) ?? (ph ? inherited(ph, [layout, master]) : null) ?? { x: 0, y: 0, w: width, h: height / 6 };
      const title = ph?.type === 'title' || ph?.type === 'ctrTitle';
      if (sp.localName === 'pic') {
        const embed = sp.getElementsByTagNameNS(A, 'blip')[0]?.getAttributeNS(R, 'embed');
        const target = embed ? rels.get(embed)?.target : undefined;
        const ext = target?.split('.').pop()?.toLowerCase() ?? '';
        if (target && files[target] && IMAGE_TYPES[ext]) shapes.push({ key, kind: 'pic', ...pos, title: false, paragraphs: [], image: { bytes: files[target], type: IMAGE_TYPES[ext] } });
        return;
      }
      if (!kid(sp, P, 'txBody')) return;
      const paras = paragraphs(sp);
      if (!paras.some((p) => p.text.trim()) && !ph) return;
      shapes.push({ key, kind: 'text', ...pos, title, paragraphs: paras });
    });
    return { shapes };
  });
  return { width, height, slides };
}

/** 書き換えた文字の図形だけを直す（最初の文字の書式を使い、ほかの書式・図形・画像はそのまま） */
export function patchPptx(buf: ArrayBuffer, edits: SlideEdits): Uint8Array {
  const files = unzip(buf);
  const { paths } = slidePaths(files);
  const bySlide = new Map<number, [number, string[]][]>();
  for (const [k, lines] of edits) {
    const [s, key] = k.split(':').map(Number);
    bySlide.set(s, [...(bySlide.get(s) ?? []), [key, lines]]);
  }
  for (const [s, list] of bySlide) {
    const path = paths[s];
    const doc = path ? xml(files[path]) : null;
    if (!doc) throw new Error('スライドを書き換えられませんでした');
    const shapes = shapesIn(doc);
    for (const [key, lines] of list) {
      const body = kid(shapes[key], P, 'txBody');
      if (!body) continue;
      let ps = kids(body, A, 'p');
      if (!ps.length) {
        const p = doc.createElementNS(A, 'a:p');
        body.appendChild(p);
        ps = [p];
      }
      lines.forEach((line, i) => {
        let p = ps[i];
        if (!p) {
          p = ps[ps.length - 1].cloneNode(true) as Element;
          body.appendChild(p);
          ps.push(p);
        }
        const runs = kids(p, A, 'r');
        let run = runs[0];
        if (!run) {
          run = doc.createElementNS(A, 'a:r');
          const rPr = kid(p, A, 'endParaRPr');
          if (rPr) {
            const copy = doc.createElementNS(A, 'a:rPr');
            for (const a of [...rPr.attributes]) copy.setAttribute(a.name, a.value);
            run.appendChild(copy);
          }
          run.appendChild(doc.createElementNS(A, 'a:t'));
          p.insertBefore(run, kid(p, A, 'endParaRPr'));
        }
        const t = kid(run, A, 't') ?? run.appendChild(doc.createElementNS(A, 'a:t'));
        t.textContent = line;
        for (const c of [...p.children]) if (c !== run && (c.localName === 'r' || c.localName === 'br' || c.localName === 'fld')) c.remove();
      });
      for (const extra of ps.slice(Math.max(1, lines.length))) extra.remove();
    }
    files[path] = strToU8(XML_DECL + new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^>]*>\s*/, ''));
  }
  return zipSync(files, { level: 6 });
}
