/**
 * ページと同じ編集画面で直した内容を、Word（.docx）に書き戻す。
 * 元のファイルのスタイル・ページの設定（用紙・余白）・ヘッダーとフッターはそのまま使い、本文だけを作り直す。
 * 対応：段落・見出し・太字/斜体/下線/取り消し線/コード・リンク・箇条書き/番号付き/チェックリスト・引用・コード・表・画像・区切り線
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const REL_LINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const REL_NUMBERING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
/** 本文の幅（A4・余白 25mm くらい）。画像がこれより大きければ縮める */
const MAX_IMAGE_EMU = 5_760_000;
const BULLET_ABS = 9001;
const NUMBER_ABS = 9002;

type Inline = { type: string; text?: string; styles?: Record<string, unknown>; href?: string; content?: Inline[] };
type Block = { type: string; props?: Record<string, any>; content?: any; children?: Block[] };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const parse = (bytes: Uint8Array | undefined) => (bytes ? new DOMParser().parseFromString(strFromU8(bytes), 'application/xml') : null);
const serialize = (doc: Document) => strToU8(XML_DECL + new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^>]*>\s*/, ''));

/** BlockNote の色の名前を Word の色にする */
const COLORS: Record<string, string> = {
  gray: '787774',
  brown: '9F6B53',
  red: 'D44C47',
  orange: 'D9730D',
  yellow: 'CB912F',
  green: '448361',
  blue: '337EA9',
  purple: '9065B0',
  pink: 'C14C8A',
};
const HIGHLIGHT: Record<string, string> = { gray: 'lightGray', brown: 'darkYellow', red: 'red', orange: 'yellow', yellow: 'yellow', green: 'green', blue: 'cyan', purple: 'magenta', pink: 'magenta' };

export async function blocksToDocx(original: ArrayBuffer, blocks: Block[]): Promise<Uint8Array> {
  const files = unzipSync(new Uint8Array(original));
  const docXml = parse(files['word/document.xml']);
  if (!docXml) throw new Error('Word のファイルとして読み取れませんでした');
  const relsXml = parse(files['word/_rels/document.xml.rels'])!;
  const typesXml = parse(files['[Content_Types].xml'])!;
  const relsRoot = relsXml.documentElement;
  // 前に保存したときに足した画像・リンクは、本文を作り直すので消す
  for (const rel of [...relsRoot.children]) if (/^rIdSn\d+$/.test(rel.getAttribute('Id') ?? '')) rel.remove();
  for (const path of Object.keys(files)) if (/^word\/media\/sn-image\d+\./.test(path)) delete files[path];
  const relIds = new Set([...relsRoot.children].map((r) => r.getAttribute('Id')));
  let relSeq = 1;
  const addRel = (type: string, target: string, external = false) => {
    while (relIds.has(`rIdSn${relSeq}`)) relSeq++;
    const id = `rIdSn${relSeq++}`;
    relIds.add(id);
    const rel = relsXml.createElementNS(relsRoot.namespaceURI, 'Relationship');
    rel.setAttribute('Id', id);
    rel.setAttribute('Type', type);
    rel.setAttribute('Target', target);
    if (external) rel.setAttribute('TargetMode', 'External');
    relsRoot.appendChild(rel);
    return id;
  };
  const ensureDefault = (ext: string, type: string) => {
    const root = typesXml.documentElement;
    if ([...root.children].some((c) => c.localName === 'Default' && c.getAttribute('Extension')?.toLowerCase() === ext)) return;
    const d = typesXml.createElementNS(root.namespaceURI, 'Default');
    d.setAttribute('Extension', ext);
    d.setAttribute('ContentType', type);
    root.insertBefore(d, root.firstChild);
  };

  // ---------- スタイル（見出し・引用など）を、元の文書のスタイルから探す ----------
  const stylesXml = parse(files['word/styles.xml']);
  const styleByName = new Map<string, string>();
  for (const st of stylesXml ? [...stylesXml.getElementsByTagNameNS(W, 'style')] : []) {
    const name = st.getElementsByTagNameNS(W, 'name')[0]?.getAttributeNS(W, 'val');
    const id = st.getAttributeNS(W, 'styleId');
    if (name && id) styleByName.set(name.toLowerCase(), id);
  }
  const headingStyle = (level: number) => styleByName.get(`heading ${level}`);
  const quoteStyle = styleByName.get('quote');
  const linkStyle = styleByName.get('hyperlink');
  const tableStyle = styleByName.get('table grid');

  // ---------- 箇条書き・番号付きの定義 ----------
  let numberingXml = parse(files['word/numbering.xml']);
  const numIds: { id: number; abs: number }[] = [];
  let numSeq = 9100;
  const newNum = (abs: number) => {
    const id = numSeq++;
    numIds.push({ id, abs });
    return id;
  };
  const bulletNum = newNum(BULLET_ABS);

  // ---------- 文字（ラン） ----------
  const runProps = (styles: Record<string, unknown> = {}) => {
    let p = '';
    if (styles.bold) p += '<w:b/><w:bCs/>';
    if (styles.italic) p += '<w:i/><w:iCs/>';
    if (styles.strike) p += '<w:strike/>';
    if (styles.underline) p += '<w:u w:val="single"/>';
    if (styles.code) p += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>';
    const color = typeof styles.textColor === 'string' ? COLORS[styles.textColor] : undefined;
    if (color) p += `<w:color w:val="${color}"/>`;
    const hl = typeof styles.backgroundColor === 'string' ? HIGHLIGHT[styles.backgroundColor] : undefined;
    if (hl) p += `<w:highlight w:val="${hl}"/>`;
    return p;
  };
  const textRun = (text: string, props: string) =>
    text
      .split('\n')
      .map((line, i) => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${i > 0 ? '<w:br/>' : ''}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`)
      .join('');
  const inlines = (content: unknown, extra = ''): string => {
    if (typeof content === 'string') return textRun(content, extra);
    if (!Array.isArray(content)) return '';
    return (content as Inline[])
      .map((c) => {
        if (c.type === 'text') return textRun(c.text ?? '', runProps(c.styles) + extra);
        if (c.type === 'link' && c.href) {
          const id = addRel(REL_LINK, c.href, true);
          const look = linkStyle ? `<w:rStyle w:val="${linkStyle}"/>` : '<w:color w:val="0563C1"/><w:u w:val="single"/>';
          return `<w:hyperlink r:id="${id}">${(c.content ?? []).map((t) => textRun(t.text ?? '', look + runProps(t.styles) + extra)).join('')}</w:hyperlink>`;
        }
        if (c.type === 'math') return textRun(`$${(c as any).props?.latex ?? ''}$`, extra);
        return c.text ? textRun(c.text, extra) : '';
      })
      .join('');
  };
  const jc = (props: Record<string, any> = {}) => {
    const a = props.textAlignment;
    return a === 'center' ? '<w:jc w:val="center"/>' : a === 'right' ? '<w:jc w:val="right"/>' : a === 'justify' ? '<w:jc w:val="both"/>' : '';
  };
  const para = (pPr: string, body: string) => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${body}</w:p>`;

  // ---------- 画像 ----------
  let imageSeq = 1;
  let drawingId = 1;
  const image = async (block: Block) => {
    const url = String(block.props?.url ?? '');
    if (!url) return '';
    let bytes: Uint8Array;
    let type = '';
    try {
      const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
      if (data) {
        // 文書に埋め込まれていた画像（data: URL）はその場で戻す
        type = data[1];
        bytes = Uint8Array.from(atob(data[2]), (c) => c.charCodeAt(0));
      } else {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error();
        const blob = await res.blob();
        type = blob.type;
        bytes = new Uint8Array(await blob.arrayBuffer());
      }
    } catch {
      return para('', textRun(`[画像: ${block.props?.name ?? ''}]`, ''));
    }
    const ext = /png/.test(type) ? 'png' : /jpe?g/.test(type) ? 'jpeg' : /gif/.test(type) ? 'gif' : null;
    if (!ext) return para('', textRun(`[画像: ${block.props?.name ?? ''}]`, ''));
    let w = 400;
    let h = 300;
    try {
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type }));
      w = bmp.width;
      h = bmp.height;
    } catch {
      // 大きさが分からなければ既定の大きさにする
    }
    const shownW = Number(block.props?.previewWidth) || w;
    let cx = Math.round(shownW * 9525);
    let cy = Math.round((shownW * h * 9525) / w);
    if (cx > MAX_IMAGE_EMU) {
      cy = Math.round((cy * MAX_IMAGE_EMU) / cx);
      cx = MAX_IMAGE_EMU;
    }
    while (files[`word/media/sn-image${imageSeq}.${ext}`]) imageSeq++;
    const path = `media/sn-image${imageSeq++}.${ext}`;
    files[`word/${path}`] = bytes as Uint8Array<ArrayBuffer>;
    ensureDefault(ext, `image/${ext}`);
    const id = addRel(REL_IMAGE, path);
    const n = drawingId++;
    const drawing =
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${9000 + n}" name="図 ${n}"/>` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${9000 + n}" name="image${n}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
      `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    const caption = block.props?.caption ? para('<w:jc w:val="center"/>', textRun(String(block.props.caption), '<w:sz w:val="18"/>')) : '';
    return para(jc(block.props) || '<w:jc w:val="center"/>', drawing) + caption;
  };

  // ---------- 表 ----------
  const table = (block: Block) => {
    const rows: { cells: any[] }[] = block.content?.rows ?? [];
    const width = Math.max(1, ...rows.map((r) => r.cells.reduce((n: number, c: any) => n + (Number(c?.props?.colspan) || 1), 0)));
    const col = Math.floor(9000 / width);
    const borders =
      '<w:tblBorders>' +
      ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join('') +
      '</w:tblBorders>';
    const tblPr = `<w:tblPr>${tableStyle ? `<w:tblStyle w:val="${tableStyle}"/>` : ''}<w:tblW w:w="0" w:type="auto"/>${tableStyle ? '' : borders}<w:tblLook w:val="04A0"/></w:tblPr>`;
    const grid = `<w:tblGrid>${Array.from({ length: width }, () => `<w:gridCol w:w="${col}"/>`).join('')}</w:tblGrid>`;
    const header = Number(block.content?.headerRows) || 0;
    const trs = rows
      .map((r, ri) => {
        const tcs = r.cells
          .map((c: any) => {
            const content = c?.type === 'tableCell' ? c.content : c;
            const span = Number(c?.props?.colspan) || 1;
            const bold = ri < header ? '<w:b/>' : '';
            return `<w:tc><w:tcPr><w:tcW w:w="${col * span}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}</w:tcPr>${para(jc(c?.props), inlines(content, bold))}</w:tc>`;
          })
          .join('');
        return `<w:tr>${ri < header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${tcs}</w:tr>`;
      })
      .join('');
    // 表のあとに空の段落を置く（Word では表が続くとくっついてしまうため）
    return `<w:tbl>${tblPr}${grid}${trs}</w:tbl>${para('', '')}`;
  };

  // ---------- ブロック ----------
  const out: string[] = [];
  let currentNumbered: number | null = null;
  const walk = async (list: Block[], depth: number) => {
    for (const b of list) {
      const p = b.props ?? {};
      const indent = depth > 0 && !/ListItem$/.test(b.type) ? `<w:ind w:left="${depth * 420}"/>` : '';
      // 番号付きリストのまとまりごとに 1 から数え直す（間にほかのブロックが入ったら別のまとまり）
      if (depth === 0 && b.type !== 'numberedListItem') currentNumbered = null;
      switch (b.type) {
        case 'heading': {
          const level = Math.min(6, Number(p.level) || 1);
          const style = headingStyle(level);
          const size = [0, 32, 28, 24, 22, 22, 22][level];
          out.push(para((style ? `<w:pStyle w:val="${style}"/>` : '') + jc(p) + indent, inlines(b.content, style ? '' : `<w:b/><w:sz w:val="${size}"/>`)));
          break;
        }
        case 'bulletListItem':
          out.push(para(`<w:numPr><w:ilvl w:val="${Math.min(depth, 8)}"/><w:numId w:val="${bulletNum}"/></w:numPr>` + jc(p), inlines(b.content)));
          break;
        case 'numberedListItem': {
          if (currentNumbered === null) currentNumbered = newNum(NUMBER_ABS);
          out.push(para(`<w:numPr><w:ilvl w:val="${Math.min(depth, 8)}"/><w:numId w:val="${currentNumbered}"/></w:numPr>` + jc(p), inlines(b.content)));
          break;
        }
        case 'checkListItem':
          out.push(para(indent + jc(p), textRun(p.checked ? '☑ ' : '☐ ', '') + inlines(b.content)));
          break;
        case 'quote':
          out.push(
            para(
              quoteStyle ? `<w:pStyle w:val="${quoteStyle}"/>` : `<w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="BFBFBF"/></w:pBdr><w:ind w:left="${360 + depth * 420}"/>`,
              inlines(b.content, quoteStyle ? '' : '<w:color w:val="595959"/>'),
            ),
          );
          break;
        case 'codeBlock': {
          const text = Array.isArray(b.content) ? (b.content as Inline[]).map((c) => c.text ?? '').join('') : String(b.content ?? '');
          for (const line of text.split('\n'))
            out.push(
              para(
                '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:before="0" w:after="0"/>' + indent,
                textRun(line, '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/>'),
              ),
            );
          break;
        }
        case 'image':
          out.push(await image(b));
          break;
        case 'table':
          out.push(table(b));
          break;
        case 'divider':
          out.push(para('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>', ''));
          break;
        case 'file':
        case 'video':
        case 'audio':
          out.push(para(indent, textRun(`[${p.name || p.url || 'ファイル'}]`, '')));
          break;
        case 'equation':
          out.push(para('<w:jc w:val="center"/>', textRun(`$$${p.latex ?? ''}$$`, '')));
          break;
        default:
          out.push(para(jc(p) + indent, inlines(b.content)));
      }
      if (b.children?.length) await walk(b.children, depth + 1);
    }
  };
  await walk(blocks, 0);

  // ---------- 本文を組み立てる（元の用紙・余白・ヘッダーとフッターの設定を残す） ----------
  const body = docXml.getElementsByTagNameNS(W, 'body')[0];
  const sectPr = body ? [...body.children].filter((c) => c.localName === 'sectPr').pop() : undefined;
  const sect = sectPr ? new XMLSerializer().serializeToString(sectPr) : '';
  const root = docXml.documentElement;
  // 元の文書の名前空間の宣言を引き継ぐ（ヘッダーなどの参照で使う）
  const nsDecl = [...root.attributes]
    .filter((a) => a.name.startsWith('xmlns:') && !['xmlns:w', 'xmlns:r', 'xmlns:wp'].includes(a.name))
    .map((a) => ` ${a.name}="${esc(a.value)}"`)
    .join('');
  const ignorable = root.getAttribute('mc:Ignorable');
  files['word/document.xml'] = strToU8(
    XML_DECL +
      `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"${nsDecl}${ignorable ? ` mc:Ignorable="${esc(ignorable)}"` : ''}>` +
      `<w:body>${out.join('') || para('', '')}${sect}</w:body></w:document>`,
  );

  // ---------- 箇条書きの定義を足す ----------
  const levels = (abs: number) =>
    Array.from({ length: 9 }, (_, i) => {
      const left = 420 * (i + 1);
      const fmt = abs === BULLET_ABS ? `<w:numFmt w:val="bullet"/><w:lvlText w:val="${['●', '○', '■'][i % 3]}"/>` : `<w:numFmt w:val="${['decimal', 'lowerLetter', 'lowerRoman'][i % 3]}"/><w:lvlText w:val="%${i + 1}."/>`;
      return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/>${fmt}<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="420"/></w:pPr></w:lvl>`;
    }).join('');
  const absXml = [BULLET_ABS, NUMBER_ABS].map((abs) => `<w:abstractNum w:abstractNumId="${abs}"><w:multiLevelType w:val="hybridMultilevel"/>${levels(abs)}</w:abstractNum>`).join('');
  const numXml = numIds
    .map(({ id, abs }) => `<w:num w:numId="${id}"><w:abstractNumId w:val="${abs}"/>${abs === NUMBER_ABS ? '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>' : ''}</w:num>`)
    .join('');
  if (numberingXml) {
    const nroot = numberingXml.documentElement;
    // 前に保存したときの定義は消してから足す
    for (const el of [...nroot.children]) {
      const abs = el.getAttributeNS(W, 'abstractNumId');
      const num = el.getAttributeNS(W, 'numId');
      if ((el.localName === 'abstractNum' && (abs === String(BULLET_ABS) || abs === String(NUMBER_ABS))) || (el.localName === 'num' && Number(num) >= 9100)) el.remove();
    }
    const frag = new DOMParser().parseFromString(`<w:x xmlns:w="${W}">${absXml}${numXml}</w:x>`, 'application/xml').documentElement;
    const firstNum = [...nroot.children].find((c) => c.localName === 'num' || c.localName === 'numIdMacAtCleanup') ?? null;
    for (const el of [...frag.children]) {
      const node = numberingXml.importNode(el, true);
      if (el.localName === 'abstractNum') nroot.insertBefore(node, firstNum);
      else nroot.insertBefore(node, [...nroot.children].find((c) => c.localName === 'numIdMacAtCleanup') ?? null);
    }
    files['word/numbering.xml'] = serialize(numberingXml);
  } else {
    numberingXml = new DOMParser().parseFromString(`<w:numbering xmlns:w="${W}">${absXml}${numXml}</w:numbering>`, 'application/xml');
    files['word/numbering.xml'] = serialize(numberingXml);
    addRel(REL_NUMBERING, 'numbering.xml');
    const troot = typesXml.documentElement;
    const o = typesXml.createElementNS(troot.namespaceURI, 'Override');
    o.setAttribute('PartName', '/word/numbering.xml');
    o.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml');
    troot.appendChild(o);
  }

  files['word/_rels/document.xml.rels'] = serialize(relsXml);
  files['[Content_Types].xml'] = serialize(typesXml);
  return zipSync(files, { level: 6 });
}
