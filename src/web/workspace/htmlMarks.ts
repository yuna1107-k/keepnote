/**
 * HTML の埋め込みの変換（画面の部品から分けた部分。htmlMarks.test.ts で確かめる）。
 * Markdown・HTML の取り込みで HTML を目印に置き換え、ブロック「html」に戻す。書き出しでは HTML に戻す。
 * protectHtmlEmbeds・stripScripts・htmlMarksToHtml は DOMParser を使う（ブラウザでだけ動く）
 */

// 変換の途中で使う目印（16 進にして、Markdown・HTML の記号として扱われないようにする）
const hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => new TextDecoder().decode(new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16))));
export const HTML_MARK = (html: string) => `⟦H${hex(html)}⟧`;
const MARK_LINE = /^[ \t]*⟦H([0-9a-f]*)⟧[ \t]*$/;

/** 段落の文字が目印だけなら、HTML のブロックにする（目印でなければ null） */
export function restoreHtmlBlock(text: string) {
  const m = MARK_LINE.exec(text);
  return m ? { type: 'html', props: { html: unhex(m[1]!) } } : null;
}

/** 書き出した Markdown の目印を、HTML に戻す */
export const htmlMarksToMarkdown = (md: string) => md.replace(/^[ \t]*⟦H([0-9a-f]*)⟧[ \t]*$/gm, (_, h: string) => unhex(h));

/** 書き出した HTML（HTML・PDF 用）の目印を、スクリプトを外した HTML に戻す */
export const htmlMarksToHtml = (html: string) =>
  html.replace(/<p[^>]*>\s*⟦H([0-9a-f]*)⟧\s*<\/p>/g, (_, h: string) => `<div class="html-embed-export">${stripScripts(unhex(h))}</div>`).replace(/⟦H([0-9a-f]*)⟧/g, (_, h: string) => stripScripts(unhex(h)));

/** スクリプト・イベントの属性・javascript: の URL を外す（書き出し用） */
export function stripScripts(html: string) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('script, noscript').forEach((el) => el.remove());
  doc.body.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action|formaction)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    }
  });
  return doc.body.innerHTML;
}

/* ---------- Markdown の中の HTML ---------- */

/** ブロックとして扱う HTML のタグ */
const BLOCK_TAGS = new Set(['svg', 'figure', 'div', 'iframe', 'video', 'audio', 'picture', 'table', 'details', 'center', 'p', 'section', 'canvas', 'object', 'embed', 'math', 'img', 'aside', 'article', 'blockquote', 'dl', 'a']);
const VOID_TAGS = new Set(['img', 'embed']);
/** エディターのブロックでは表せない（このブロックにする）HTML */
const NEEDS_EMBED = /<(svg|iframe|video|audio|canvas|picture|figure|object|embed|math|style|details|center)\b|\s(style|align|width|height)\s*=/i;
/** そのまま（無害化して）並べると崩れる HTML か */
export const needsEmbed = (html: string) => NEEDS_EMBED.test(html);

/**
 * Markdown の i 行目から始まる HTML のブロックを取り出す。エディターのブロックで表せるもの（素の <p> や <img> など）は null
 * （エディターの変換に任せる）。end は HTML の最後の行。
 */
export function htmlBlockAt(lines: string[], i: number): { html: string; end: number } | null {
  const m = /^ {0,3}<([a-zA-Z][a-zA-Z0-9-]*)(?=[\s>/])/.exec(lines[i]!);
  if (!m) return null;
  const tag = m[1]!.toLowerCase();
  if (!BLOCK_TAGS.has(tag)) return null;
  let end = -1;
  if (!VOID_TAGS.has(tag)) {
    // 同じタグの開きと閉じを数えて、最初のタグが閉じる行まで
    const open = new RegExp(`<${tag}(?=[\\s>/])`, 'gi');
    const close = new RegExp(`</${tag}\\s*>`, 'gi');
    let depth = 0;
    for (let j = i; j < lines.length && j < i + 4000; j++) {
      depth += (lines[j]!.match(open)?.length ?? 0) - (lines[j]!.match(close)?.length ?? 0);
      if (depth <= 0) {
        end = j;
        break;
      }
    }
  }
  // 中身のないタグ（<img> など）はその行だけ。閉じが見つからないタグは、空行の手前まで
  if (end < 0) {
    end = i;
    if (!VOID_TAGS.has(tag)) while (end + 1 < lines.length && lines[end + 1]!.trim()) end++;
  }
  const html = lines.slice(i, end + 1).join('\n');
  return NEEDS_EMBED.test(html) ? { html: html.trim(), end } : null;
}

/* ---------- HTML の中の図・埋め込み ---------- */

const EMBED_SELECTOR = 'svg, iframe, video, audio, canvas, picture, object, embed, math';

/** HTML の図・埋め込みの要素を目印の段落に置き換える（エディターの変換で消えないように） */
export function protectHtmlEmbeds(html: string) {
  if (!/<(svg|iframe|video|audio|canvas|picture|object|embed|math)\b/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const picked: Element[] = [];
  doc.body.querySelectorAll(EMBED_SELECTOR).forEach((el) => {
    // 図の入った <figure> は、説明（figcaption）ごと
    const target = el.closest('figure') ?? el;
    if (!picked.some((p) => p.contains(target))) picked.push(target);
  });
  for (const el of picked) {
    const p = doc.createElement('p');
    p.textContent = HTML_MARK(el.outerHTML);
    el.replaceWith(p);
  }
  return doc.body.innerHTML;
}
