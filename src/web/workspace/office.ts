/**
 * 表（CSV・TSV・Excel・OpenDocument）、Word 文書、Jupyter ノートブックを読む。
 * 表示（OfficeView）と取り込み（transfer.ts）の両方で使う。大きいので使うときだけ読み込む。
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

export type Sheet = {
  name: string;
  rows: string[][];
  truncated: boolean;
  /** 編集できないセル（Excel の数式のセル）。「行,列」 */
  locked?: Set<string>;
};

/** 表として扱う上限（これを超えた分は省く） */
export const MAX_ROWS = 5000;
export const MAX_COLS = 200;

export const SHEET_EXT = /\.(csv|tsv|xlsx|xlsm|ods)$/i;
export const DOC_EXT = /\.docx$/i;

/** 文字コードを推し量ってテキストにする（UTF-8 で読めなければ Shift_JIS として読む） */
export function decodeText(buf: ArrayBuffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    try {
      return new TextDecoder('shift_jis').decode(buf);
    } catch {
      return new TextDecoder().decode(buf);
    }
  }
}

/** CSV / TSV を行と列に分ける（ダブルクォートで囲んだ中の区切り文字・改行に対応） */
export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length > MAX_ROWS) break;
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 末尾の空の行・列を除き、上限で切る */
function tidy(name: string, raw: string[][]): Sheet {
  let rows = raw.map((r) => r.map((c) => c ?? ''));
  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  let width = 0;
  for (const r of rows) for (let i = r.length - 1; i >= 0; i--) if (r[i] !== '') {
    width = Math.max(width, i + 1);
    break;
  }
  const truncated = rows.length > MAX_ROWS || width > MAX_COLS;
  width = Math.min(width, MAX_COLS);
  rows = rows.slice(0, MAX_ROWS).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  return { name, rows, truncated };
}

// ---------- XML の読み取り ----------
const xml = (bytes: Uint8Array | undefined) => (bytes ? new DOMParser().parseFromString(strFromU8(bytes), 'application/xml') : null);
/** 名前空間の接頭辞に関係なく、要素を名前で探す */
const all = (n: ParentNode | null | undefined, local: string) => (n ? [...(n as Element | Document).getElementsByTagNameNS('*', local)] : []);
const kids = (n: Element, local: string) => [...n.children].filter((c) => c.localName === local);
const attr = (el: Element, local: string) => {
  for (const a of el.attributes) if (a.localName === local) return a.value;
  return null;
};

function unzip(buf: ArrayBuffer) {
  try {
    return unzipSync(new Uint8Array(buf));
  } catch {
    throw new Error('ファイルを読み取れませんでした（壊れているか、対応していない形式です）');
  }
}

// ---------- Excel（.xlsx） ----------
const BUILTIN_DATE = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const BUILTIN_TIME = new Set([18, 19, 20, 21, 32, 33, 45, 46, 47]);
const BUILTIN_PERCENT = new Set([9, 10]);

function colIndex(ref: string) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

/** Excel の日付（1900 年からの日数）を「2026/11/06」「2026/11/06 12:30」の形にする */
function excelDate(serial: number, kind: 'date' | 'time' | 'datetime', date1904: boolean) {
  const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86400_000);
  const d = new Date(ms);
  const date = `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${d.getUTCSeconds() ? `:${pad(d.getUTCSeconds())}` : ''}`;
  if (kind === 'time') return time;
  if (kind === 'date' || serial % 1 === 0) return date;
  return `${date} ${time}`;
}

/** 計算の誤差（0.30000000000000004 など）を表に出さない */
function numberText(v: string) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return String(Number(n.toPrecision(15)));
}

type CellFormat = 'percent' | 'date' | 'time' | 'datetime' | null;

/** ブックの共通情報（シートの場所・書式・日付の基準） */
function xlsxContext(files: Record<string, Uint8Array>) {
  const wb = xml(files['xl/workbook.xml']);
  if (!wb) throw new Error('Excel のファイルとして読み取れませんでした');
  const date1904 = all(wb, 'workbookPr').some((e) => /^(1|true)$/.test(attr(e, 'date1904') ?? ''));
  const rels = new Map(all(xml(files['xl/_rels/workbook.xml.rels']), 'Relationship').map((r) => [attr(r, 'Id')!, attr(r, 'Target')!]));
  const sheets = all(wb, 'sheet').map((s) => {
    const target = rels.get(attr(s, 'id') ?? '') ?? '';
    return { name: attr(s, 'name') ?? 'Sheet', path: target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}` };
  });
  // 書式（日付・時刻・パーセント）
  const styles = xml(files['xl/styles.xml']);
  const custom = new Map(all(styles, 'numFmt').map((f) => [Number(attr(f, 'numFmtId')), attr(f, 'formatCode') ?? '']));
  const cellXfs = all(styles, 'cellXfs')[0];
  const formats: CellFormat[] = (cellXfs ? kids(cellXfs, 'xf') : []).map((xf) => {
    const id = Number(attr(xf, 'numFmtId') ?? 0);
    const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    if (BUILTIN_PERCENT.has(id) || /%/.test(code)) return 'percent';
    if (BUILTIN_TIME.has(id)) return 'time';
    if (BUILTIN_DATE.has(id)) return 'date';
    if (/[yd]/i.test(code)) return /[hs]/i.test(code) ? 'datetime' : 'date';
    if (/[hs]/i.test(code)) return 'time';
    return null;
  });
  return { wb, date1904, sheets, formats };
}

function readXlsx(buf: ArrayBuffer): Sheet[] {
  const files = unzip(buf);
  const { date1904, sheets, formats } = xlsxContext(files);

  // 共有の文字列（ふりがな rPh は除く）
  const shared = all(xml(files['xl/sharedStrings.xml']), 'si').map((si) =>
    all(si, 't')
      .filter((t) => t.parentElement?.localName !== 'rPh' && t.parentElement?.parentElement?.localName !== 'rPh')
      .map((t) => t.textContent ?? '')
      .join(''),
  );

  return sheets.map(({ name, path }) => {
    const doc = xml(files[path]);
    const rows: string[][] = [];
    const locked = new Set<string>();
    for (const r of all(doc, 'row')) {
      const ri = Number(attr(r, 'r') ?? rows.length + 1) - 1;
      if (ri >= MAX_ROWS + 1) break;
      const row: string[] = (rows[ri] = []);
      kids(r, 'c').forEach((c, i) => {
        const ref = attr(c, 'r');
        const ci = ref ? colIndex(ref) : i;
        if (ci >= MAX_COLS + 1) return;
        // 数式のセルは、値を書き換えると数式が消えるので編集させない
        if (kids(c, 'f').length) locked.add(`${ri},${ci}`);
        const t = attr(c, 't');
        const v = kids(c, 'v')[0]?.textContent ?? '';
        let text = '';
        if (t === 's') text = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') text = all(c, 't').map((x) => x.textContent ?? '').join('');
        else if (t === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
        else if (t === 'str' || t === 'e' || t === 'd') text = v;
        else if (v !== '') {
          const fmt = formats[Number(attr(c, 's') ?? 0)];
          const n = Number(v);
          if (fmt === 'percent') text = `${numberText(String(n * 100))}%`;
          else if (fmt && Number.isFinite(n)) text = excelDate(n, fmt, date1904);
          else text = numberText(v);
        }
        row[ci] = text;
      });
    }
    return { ...tidy(name, Array.from({ length: rows.length }, (_, i) => rows[i] ?? [])), locked };
  });
}

// ---------- OpenDocument（.ods） ----------
function readOds(buf: ArrayBuffer): Sheet[] {
  const files = unzip(buf);
  const doc = xml(files['content.xml']);
  if (!doc) throw new Error('OpenDocument のファイルとして読み取れませんでした');
  const cellText = (cell: Element) => {
    const type = attr(cell, 'value-type');
    const paras = kids(cell, 'p').map((p) => p.textContent ?? '');
    if (paras.length) return paras.join('\n');
    if (type === 'date') return (attr(cell, 'date-value') ?? '').replace(/-/g, '/').replace('T', ' ');
    return attr(cell, 'value') ?? '';
  };
  return all(doc, 'table')
    .filter((t) => t.parentElement?.localName === 'spreadsheet')
    .map((table) => {
      const rows: string[][] = [];
      const locked = new Set<string>();
      const rowEls = all(table, 'table-row');
      for (const r of rowEls) {
        const row: string[] = [];
        const formulaCols: number[] = [];
        for (const cell of [...r.children].filter((c) => c.localName === 'table-cell' || c.localName === 'covered-table-cell')) {
          const text = cell.localName === 'covered-table-cell' ? '' : cellText(cell);
          // 空のセルは何万個も繰り返されることがあるので、上限までにする
          const repeat = Math.min(Number(attr(cell, 'number-columns-repeated') ?? 1), MAX_COLS + 1 - row.length);
          for (let i = 0; i < repeat; i++) {
            if (attr(cell, 'formula') !== null) formulaCols.push(row.length);
            row.push(text);
          }
          if (row.length > MAX_COLS) break;
        }
        const repeat = Math.min(Number(attr(r, 'number-rows-repeated') ?? 1), MAX_ROWS + 1 - rows.length);
        for (let i = 0; i < repeat; i++) {
          // 数式のセルは、値を書き換えると数式が消えるので編集させない
          for (const c of formulaCols) locked.add(`${rows.length},${c}`);
          rows.push(row);
        }
        if (rows.length > MAX_ROWS) break;
      }
      return { ...tidy(attr(table, 'name') ?? 'Sheet', rows), locked };
    });
}

/** 表のファイルを読み、シートごとの行と列にする */
export function readSheets(buf: ArrayBuffer, name: string): Sheet[] {
  const base = name.replace(/\.[^.]+$/, '') || 'Sheet';
  if (/\.csv$/i.test(name)) return [tidy(base, parseDelimited(decodeText(buf), ','))];
  if (/\.tsv$/i.test(name)) return [tidy(base, parseDelimited(decodeText(buf), '\t'))];
  if (/\.ods$/i.test(name)) return readOds(buf);
  return readXlsx(buf);
}

// ---------- 表の保存 ----------
export type CellEdit = { sheet: number; row: number; col: number; value: string };

/** 列の名前（0 → A、26 → AA） */
export function colName(i: number) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** 行と列を CSV / TSV の文字列にする（区切り文字・引用符・改行を含む値は "" で囲む） */
export function toDelimited(rows: string[][], sep: string, eol = '\n') {
  const quote = (v: string) => (v.includes(sep) || /["\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(quote).join(sep)).join(eol) + eol;
}

/** 「2026/11/06」「2026/11/06 12:30」「12:30」を Excel の日付の数値にする */
function toSerial(text: string, fmt: CellFormat, date1904: boolean) {
  const v = text.trim();
  const d = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (d) {
    const ms = Date.UTC(+d[1], +d[2] - 1, +d[3], +(d[4] ?? 0), +(d[5] ?? 0), +(d[6] ?? 0));
    return ms / 86400_000 + 25569 - (date1904 ? 1462 : 0);
  }
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (t && fmt === 'time') return (+t[1] * 3600 + +t[2] * 60 + +(t[3] ?? 0)) / 86400;
  return null;
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const serialize = (doc: Document) => strToU8(XML_DECL + new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^>]*>\s*/, ''));

/**
 * Excel のファイルの、編集したセルだけを書き換える（書式・ほかのセル・ほかのシートはそのまま）。
 * 数値・日付・パーセントは、セルの書式に合わせて数値として書く。保存後に開いたとき、数式は計算し直される。
 */
export function patchXlsx(buf: ArrayBuffer, edits: CellEdit[]): Uint8Array {
  const files = unzip(buf);
  const { wb, date1904, sheets, formats } = xlsxContext(files);
  const bySheet = new Map<number, CellEdit[]>();
  for (const e of edits) bySheet.set(e.sheet, [...(bySheet.get(e.sheet) ?? []), e]);

  for (const [si, list] of bySheet) {
    const path = sheets[si]?.path;
    const doc = path ? xml(files[path]) : null;
    const data = all(doc, 'sheetData')[0];
    if (!doc || !data) throw new Error('シートを書き換えられませんでした');
    const ns = doc.documentElement.namespaceURI;
    const el = (name: string) => doc.createElementNS(ns, name);

    const rowEl = (ri: number) => {
      const rows = kids(data, 'row');
      const found = rows.find((r) => Number(attr(r, 'r')) === ri + 1);
      if (found) return found;
      const row = el('row');
      row.setAttribute('r', String(ri + 1));
      data.insertBefore(row, rows.find((r) => Number(attr(r, 'r')) > ri + 1) ?? null);
      return row;
    };
    const cellEl = (row: Element, ri: number, ci: number) => {
      const ref = `${colName(ci)}${ri + 1}`;
      const cells = kids(row, 'c');
      const found = cells.find((c) => attr(c, 'r') === ref);
      if (found) return found;
      const c = el('c');
      c.setAttribute('r', ref);
      // 行の書式があれば引き継ぐ
      if (attr(row, 's') && attr(row, 'customFormat') === '1') c.setAttribute('s', attr(row, 's')!);
      row.insertBefore(c, cells.find((x) => colIndex(attr(x, 'r') ?? 'A1') > ci) ?? null);
      row.removeAttribute('spans');
      return c;
    };

    for (const e of list) {
      const c = cellEl(rowEl(e.row), e.row, e.col);
      for (const ch of [...c.children]) c.removeChild(ch);
      c.removeAttribute('t');
      const v = e.value;
      if (v === '') continue;
      const fmt = formats[Number(attr(c, 's') ?? 0)] ?? null;
      const trimmed = v.trim();
      let num: number | null = null;
      if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) num = Number(trimmed);
      else if (/^-?\d+(\.\d+)?%$/.test(trimmed)) num = Number(trimmed.slice(0, -1)) / 100;
      else if (fmt && fmt !== 'percent') num = toSerial(trimmed, fmt, date1904);
      if (num !== null && Number.isFinite(num)) {
        const ve = el('v');
        ve.textContent = String(num);
        c.appendChild(ve);
      } else if (v === 'TRUE' || v === 'FALSE') {
        c.setAttribute('t', 'b');
        const ve = el('v');
        ve.textContent = v === 'TRUE' ? '1' : '0';
        c.appendChild(ve);
      } else {
        c.setAttribute('t', 'inlineStr');
        const is = el('is');
        const t = el('t');
        t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
        t.textContent = v;
        is.appendChild(t);
        c.appendChild(is);
      }
    }

    // 使っている範囲（dimension）を広げる
    const dim = all(doc, 'dimension')[0];
    if (dim) {
      let maxR = 0;
      let maxC = 0;
      for (const r of kids(data, 'row')) {
        maxR = Math.max(maxR, Number(attr(r, 'r') ?? 0));
        for (const c of kids(r, 'c')) maxC = Math.max(maxC, colIndex(attr(c, 'r') ?? 'A1') + 1);
      }
      if (maxR && maxC) dim.setAttribute('ref', `A1:${colName(maxC - 1)}${maxR}`);
    }
    files[path!] = serialize(doc);
  }

  // 計算の順序の記録を消し、開いたときに計算し直させる（値を書き換えたセルを参照する数式のため）
  if (files['xl/calcChain.xml']) {
    delete files['xl/calcChain.xml'];
    const types = xml(files['[Content_Types].xml']);
    if (types) {
      for (const o of all(types, 'Override')) if (attr(o, 'PartName') === '/xl/calcChain.xml') o.remove();
      files['[Content_Types].xml'] = serialize(types);
    }
    const rels = xml(files['xl/_rels/workbook.xml.rels']);
    if (rels) {
      for (const r of all(rels, 'Relationship')) if (/calcChain\.xml$/.test(attr(r, 'Target') ?? '')) r.remove();
      files['xl/_rels/workbook.xml.rels'] = serialize(rels);
    }
  }
  let calcPr = all(wb, 'calcPr')[0];
  if (!calcPr) {
    calcPr = wb.createElementNS(wb.documentElement.namespaceURI, 'calcPr');
    // calcPr は definedNames（なければ sheets）の直後に置く決まり
    const after = all(wb, 'definedNames')[0] ?? all(wb, 'externalReferences')[0] ?? all(wb, 'functionGroups')[0] ?? all(wb, 'sheets')[0];
    wb.documentElement.insertBefore(calcPr, after?.nextSibling ?? null);
  }
  calcPr.setAttribute('fullCalcOnLoad', '1');
  files['xl/workbook.xml'] = serialize(wb);
  return zipSync(files, { level: 6 });
}

const ODS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
};
/** セルの値に関する属性（書き換える前に消す） */
const ODS_VALUE_ATTRS = new Set(['value-type', 'value', 'date-value', 'time-value', 'boolean-value', 'string-value', 'currency', 'formula']);

/** 繰り返し（number-…-repeated）でまとめられた要素を、index の位置で 1 つだけ切り出す */
function splitRepeated(el: Element, attrName: string, offset: number) {
  const count = Number(attr(el, attrName) ?? 1);
  if (count <= 1) return el;
  const setCount = (e: Element, n: number) => {
    for (const a of [...e.attributes]) if (a.localName === attrName) e.removeAttributeNode(a);
    if (n > 1) e.setAttributeNS(ODS.table, `table:${attrName}`, String(n));
  };
  const parent = el.parentNode!;
  if (offset > 0) {
    const before = el.cloneNode(true) as Element;
    setCount(before, offset);
    parent.insertBefore(before, el);
  }
  const after = count - offset - 1;
  if (after > 0) {
    const rest = el.cloneNode(true) as Element;
    setCount(rest, after);
    parent.insertBefore(rest, el.nextSibling);
  }
  setCount(el, 1);
  return el;
}

/**
 * OpenDocument の表（.ods）の、編集したセルだけを書き換える（書式・ほかのセル・ほかのシートはそのまま）。
 */
export function patchOds(buf: ArrayBuffer, edits: CellEdit[]): Uint8Array {
  const files = unzip(buf);
  const doc = xml(files['content.xml']);
  if (!doc) throw new Error('OpenDocument のファイルとして読み取れませんでした');
  const tables = all(doc, 'table').filter((t) => t.parentElement?.localName === 'spreadsheet');
  const el = (ns: string, name: string) => doc.createElementNS(ns, name);
  const isCell = (c: Element) => c.localName === 'table-cell' || c.localName === 'covered-table-cell';

  for (const e of edits) {
    const table = tables[e.sheet];
    if (!table) throw new Error('シートを書き換えられませんでした');
    // 行を探す（なければ足す）
    let row: Element | null = null;
    let index = 0;
    const rows = all(table, 'table-row');
    for (const r of rows) {
      const n = Number(attr(r, 'number-rows-repeated') ?? 1);
      if (e.row < index + n) {
        row = splitRepeated(r, 'number-rows-repeated', e.row - index);
        break;
      }
      index += n;
    }
    if (!row) {
      const last = rows[rows.length - 1];
      const parent = last?.parentNode ?? table;
      for (; index <= e.row; index++) {
        row = el(ODS.table, 'table:table-row');
        row.appendChild(el(ODS.table, 'table:table-cell'));
        parent.appendChild(row);
      }
    }
    // セルを探す（なければ足す）
    let cell: Element | null = null;
    let col = 0;
    const cells = [...row!.children].filter(isCell);
    for (const c of cells) {
      const n = Number(attr(c, 'number-columns-repeated') ?? 1);
      if (e.col < col + n) {
        cell = splitRepeated(c, 'number-columns-repeated', e.col - col);
        break;
      }
      col += n;
    }
    if (!cell) {
      if (e.col > col) {
        const gap = el(ODS.table, 'table:table-cell');
        if (e.col - col > 1) gap.setAttributeNS(ODS.table, 'table:number-columns-repeated', String(e.col - col));
        row!.appendChild(gap);
      }
      cell = el(ODS.table, 'table:table-cell');
      row!.appendChild(cell);
    }
    if (cell.localName === 'covered-table-cell') continue;

    // 値を書き換える（セルの書式 table:style-name は残す）
    for (const a of [...cell.attributes]) if (ODS_VALUE_ATTRS.has(a.localName)) cell.removeAttributeNode(a);
    while (cell.firstChild) cell.removeChild(cell.firstChild);
    const v = e.value;
    if (v === '') continue;
    const t = v.trim();
    const setValue = (type: string, name: string, value: string) => {
      cell!.setAttributeNS(ODS.office, 'office:value-type', type);
      if (name) cell!.setAttributeNS(ODS.office, `office:${name}`, value);
    };
    const d = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
    if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(t)) setValue('float', 'value', String(Number(t)));
    else if (/^-?\d+(\.\d+)?%$/.test(t)) setValue('percentage', 'value', String(Number(t.slice(0, -1)) / 100));
    else if (d) {
      const date = `${d[1]}-${pad(+d[2])}-${pad(+d[3])}`;
      setValue('date', 'date-value', d[4] ? `${date}T${pad(+d[4])}:${d[5]}:${d[6] ?? '00'}` : date);
    } else setValue('string', '', '');
    for (const line of v.split('\n')) {
      const p = el(ODS.text, 'text:p');
      p.textContent = line;
      cell.appendChild(p);
    }
  }

  files['content.xml'] = serialize(doc);
  // mimetype は先頭に、圧縮せずに置く決まり
  const { mimetype, ...rest } = files;
  return zipSync(mimetype ? { mimetype: [mimetype, { level: 0 }], ...rest } : rest, { level: 6 });
}

// ---------- Word（.docx） ----------
type ImageHandler = (image: { contentType: string; read: (enc?: string) => Promise<any> }) => Promise<{ src: string }>;

/** Word 文書を HTML にする。画像は既定ではファイルに埋め込んだまま（data: URL）にする */
export async function docxToHtml(buf: ArrayBuffer, onImage?: (blob: Blob) => Promise<string | null>) {
  const mammoth: any = await import('mammoth');
  const m = mammoth.default ?? mammoth;
  const options: Record<string, unknown> = {
    styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh", "p[style-name='Quote'] => blockquote > p:fresh"],
  };
  if (onImage) {
    const handler: ImageHandler = async (image) => {
      // ブラウザには Node の Buffer がないので、base64 の文字列で受け取って戻す
      const b64: string = await image.read('base64');
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const src = await onImage(new Blob([bytes], { type: image.contentType }));
      return { src: src ?? '' };
    };
    options.convertImage = m.images.imgElement(handler);
  }
  const result = await m.convertToHtml({ arrayBuffer: buf }, options);
  return result.value as string;
}

const ALLOWED_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'SUB', 'SUP', 'BR', 'UL', 'OL', 'LI',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'A', 'IMG', 'BLOCKQUOTE', 'PRE', 'CODE', 'HR',
]);
const SAFE_IMAGE = /^data:image\/(png|jpeg|gif|webp|bmp|avif);base64,[a-z0-9+/=\s]+$/i;

/** 表示用に、決まったタグと安全な属性だけを残す（スクリプト・イベント・外部の読み込みは消える） */
export function sanitizeHtml(html: string) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walk = (el: Element) => {
    for (const child of [...el.children]) {
      if (!ALLOWED_TAGS.has(child.tagName)) {
        // 中身は残してタグだけ外す（script・style などは中身ごと消す）
        if (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|TEMPLATE|SVG|MATH|NOSCRIPT)$/.test(child.tagName)) child.remove();
        else {
          walk(child);
          child.replaceWith(...child.childNodes);
        }
        continue;
      }
      for (const a of [...child.attributes]) {
        const keep =
          (child.tagName === 'A' && a.name === 'href' && /^(https?:|mailto:|#)/i.test(a.value.trim())) ||
          (child.tagName === 'IMG' && (a.name === 'src' ? SAFE_IMAGE.test(a.value) : a.name === 'alt')) ||
          ((child.tagName === 'TD' || child.tagName === 'TH') && (a.name === 'colspan' || a.name === 'rowspan') && /^\d{1,3}$/.test(a.value));
        if (!keep) child.removeAttribute(a.name);
      }
      if (child.tagName === 'IMG' && !child.getAttribute('src')) {
        child.remove();
        continue;
      }
      if (child.tagName === 'A') {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noopener noreferrer');
      }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

// ---------- Jupyter ノートブック（.ipynb） ----------
const joinSource = (s: unknown) => (Array.isArray(s) ? s.join('') : typeof s === 'string' ? s : '');

/** ノートブックを Markdown にする（説明のセルはそのまま、コードと出力はコードブロックに） */
export async function ipynbToMarkdown(text: string, onImage?: (blob: Blob) => Promise<string | null>) {
  let nb: any;
  try {
    nb = JSON.parse(text);
  } catch {
    throw new Error('ノートブックのファイルとして読み取れませんでした');
  }
  const lang = nb?.metadata?.language_info?.name || nb?.metadata?.kernelspec?.language || 'python';
  const fence = (body: string, l: string) => {
    const ticks = body.includes('```') ? '````' : '```';
    return `${ticks}${l}\n${body.replace(/\n$/, '')}\n${ticks}`;
  };
  const parts: string[] = [];
  for (const cell of nb?.cells ?? []) {
    const src = joinSource(cell.source);
    if (cell.cell_type === 'markdown') parts.push(src);
    else if (cell.cell_type === 'raw') parts.push(fence(src, ''));
    else if (cell.cell_type === 'code') {
      if (src.trim()) parts.push(fence(src, lang));
      for (const out of cell.outputs ?? []) {
        const data = out.data ?? {};
        if (out.output_type === 'stream') parts.push(fence(joinSource(out.text), 'text'));
        else if (out.output_type === 'error') parts.push(fence(`${out.ename}: ${out.evalue}`, 'text'));
        else if (data['image/png'] && onImage) {
          const b64 = joinSource(data['image/png']).replace(/\s/g, '');
          const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
          const url = await onImage(new Blob([bytes], { type: 'image/png' }));
          if (url) parts.push(`![](${url})`);
        } else if (data['text/markdown']) parts.push(joinSource(data['text/markdown']));
        else if (data['text/plain']) parts.push(fence(joinSource(data['text/plain']), 'text'));
      }
    }
  }
  return parts.filter((p) => p.trim()).join('\n\n');
}
