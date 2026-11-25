/**
 * 文字数・単語数を数える（ページの「…」の情報、選択範囲の文字数で使う）。
 *
 * - 文字数：空白・改行を除いた文字の数（絵文字や濁点付きの文字も 1 文字として数える）
 * - 単語数：英語などのスペースで区切られた語の数（日本語の文は単語に分けられないので数えない）
 * - 画像・ファイルなどのブロックと、数式は数えない（数式の LaTeX は文字数にすると多すぎるため）
 */

export type TextCount = { chars: number; charsWithSpaces: number; words: number };

const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('ja', { granularity: 'grapheme' }) : null;

function length(s: string) {
  if (!s) return 0;
  if (!graphemes) return Array.from(s).length;
  let n = 0;
  for (const _ of graphemes.segment(s)) n++;
  return n;
}

/** 日本語・中国語の文字と全角の記号（単語数を数えるときは区切りとして扱う） */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿ー！-｠￠-￯]/gu;

export function countText(text: string): TextCount {
  const chars = length(text.replace(/\s+/g, ''));
  // 「空白を含む」は改行（段落の区切り）は数えない
  const charsWithSpaces = length(text.replace(/[\r\n]+/g, ''));
  const words = text
    .replace(CJK, ' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return { chars, charsWithSpaces, words };
}

/** 文中の内容（文字・リンク）を文字列にする。数式などは数えない */
function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const c of content as Record<string, unknown>[]) {
    if (c?.type === 'text' && typeof c.text === 'string') out += c.text;
    else if (c?.type === 'link') out += inlineText(c.content);
  }
  return out;
}

/** ページの本文（エディターのブロック）を、数えるための文字列にする。ブロックは改行で区切る */
export function documentText(blocks: unknown): string {
  const lines: string[] = [];
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const b of list as Record<string, any>[]) {
      if (!b || typeof b !== 'object') continue;
      if (Array.isArray(b.content)) lines.push(inlineText(b.content));
      else if (b.content?.type === 'tableContent') {
        for (const row of b.content.rows ?? []) for (const cell of row.cells ?? []) lines.push(inlineText(Array.isArray(cell) ? cell : cell?.content));
      }
      walk(b.children);
    }
  };
  walk(blocks);
  return lines.join('\n');
}

export function formatCount(n: number) {
  return n.toLocaleString('ja-JP');
}
