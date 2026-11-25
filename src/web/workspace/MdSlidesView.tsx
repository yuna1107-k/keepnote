import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PageFont } from '../api';
import { Button, Icon, PageIcon } from '../ui';
import { renderTex } from './math';
import { sanitizeHtml } from './office';
import { HtmlEmbedFrame } from './htmlEmbed';
import { needsEmbed } from './htmlMarks';
import { findSlideTheme, SLIDE_THEMES } from './slideThemes';

export type MdSlidesViewProps = {
  markdown: string;
  title?: string;
  font?: PageFont;
  autoPlay?: boolean;
  onClose?: () => void;
  className?: string;
  workspaceId?: string;
  filePath?: string;
  resolveImageUrl?: (url: string) => string;
  /** テーマ（slideThemes.ts の id。null・未知の id は標準） */
  theme?: string | null;
  /** 渡すと、ツールバーからテーマを選べる */
  onThemeChange?: (id: string | null) => void;
};

type SlideBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: { text: string; level: number; checked?: boolean }[] }
  | { type: 'code'; lang: string; code: string }
  | { type: 'quote'; text: string }
  | { type: 'image'; alt: string; url: string; width?: string; height?: string }
  | { type: 'table'; headers: string[]; rows: string[][]; alignments?: ('left' | 'center' | 'right')[] }
  | { type: 'html'; html: string }
  | { type: 'math'; latex: string };

type ParsedSlide = {
  id: number;
  raw: string;
  title: string;
  isTitleSlide: boolean;
  className?: string;
  showNumber?: boolean;
  footer?: string;
  header?: string;
  hasDirectFooter?: boolean;
  hasDirectPaginate?: boolean;
  notes?: string;
  blocks: SlideBlock[];
};

type DeckMeta = {
  header?: string;
  footer?: string;
  paginate?: boolean;
  accentColor?: string;
};

const isRelativeUrl = (u: string) => !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(u);

/** 相対パスを /api/github/raw/... の形式に解決する */
function makeUrlResolver(workspaceId?: string, filePath?: string, customResolver?: (url: string) => string) {
  return (url: string): string => {
    if (customResolver) return customResolver(url);
    if (!isRelativeUrl(url) || !workspaceId || !filePath) return url;
    const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
    const parts = dir ? dir.split('/') : [];
    for (const seg of url.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    const enc = parts.map(encodeURIComponent).join('/');
    return `/api/github/raw/${workspaceId}/${enc}`;
  };
}

function parseMetaFromHeader(raw: string, meta: DeckMeta) {
  const footerMatch = /\bfooter:\s*(?:["']([^"'\n\\]*)["']|([^\n\\]+?)(?:\\|$|\n))/i.exec(raw);
  if (footerMatch) {
    meta.footer = (footerMatch[1] || footerMatch[2] || '').trim();
  }
  const headerMatch = /\bheader:\s*(?:["']([^"'\n\\]*)["']|([^\n\\]+?)(?:\\|$|\n))/i.exec(raw);
  if (headerMatch) {
    meta.header = (headerMatch[1] || headerMatch[2] || '').trim();
  }
  const paginateMatch = /\bpaginate:\s*(true|false)/i.exec(raw);
  if (paginateMatch) {
    meta.paginate = paginateMatch[1]!.toLowerCase() === 'true';
  }
  const colorMatches = raw.matchAll(/(?:color|border-bottom|background|border-left|th|blockquote):\s*.*?(#[0-9a-fA-F]{3,8})/gi);
  for (const cm of colorMatches) {
    const hex = cm[1]!;
    if (!['#000', '#fff', '#000000', '#ffffff', '#0b0b0b', '#f9f9f7', '#52514e', '#c3c2b7', '#898781', '#e8f0fb'].includes(hex.toLowerCase())) {
      meta.accentColor = hex;
      break;
    }
  }
}

/** Markdown 先頭の YAML frontmatter（--- ... ---）や Marp 設定からスライド全体のメタデータを抽出・除去する */
function extractDeckMetaAndBody(md: string): { meta: DeckMeta; body: string } {
  let text = md.replace(/\r\n/g, '\n').trim();
  const meta: DeckMeta = { paginate: true };

  // 1. 標準の YAML frontmatter（--- ... ---）
  const fmMatch = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (fmMatch) {
    parseMetaFromHeader(fmMatch[1]!, meta);
    text = text.slice(fmMatch[0].length).trim();
  } else if (/^marp:\s*true/i.test(text)) {
    // 2. --- が欠落した Marp ヘッダー（単一行・複数行・CSS style ブロックを含む形式）
    const firstHr = text.search(/(?:^|\n)[ \t]*(?:\*\*\*|---|___)\s*(?:\n|$)/);
    const headerRegion = firstHr > 0 ? text.slice(0, firstHr) : text;
    const styleIdx = headerRegion.search(/\bstyle:\s*\|?/i);
    if (styleIdx >= 0) {
      let lastClose = -1;
      const braceRegex = /\{[^}]*\}/g;
      braceRegex.lastIndex = styleIdx;
      let match: RegExpExecArray | null;
      while ((match = braceRegex.exec(headerRegion)) !== null) {
        const gap = headerRegion.slice(lastClose === -1 ? styleIdx : lastClose, match.index);
        if (lastClose !== -1 && !/^[\s\\#;a-zA-Z0-9_.,>:+*~\-\[\]="']+$/.test(gap.trim())) {
          break;
        }
        lastClose = match.index + match[0].length;
      }
      if (lastClose > 0) {
        parseMetaFromHeader(headerRegion.slice(0, lastClose), meta);
        text = text.slice(lastClose).trim();
      }
    } else {
      const lastBrace = headerRegion.lastIndexOf('}');
      if (lastBrace > 0) {
        parseMetaFromHeader(headerRegion.slice(0, lastBrace + 1), meta);
        text = text.slice(lastBrace + 1).trim();
      } else {
        const endYaml = headerRegion.search(/\n[ \t]*\n/);
        if (endYaml > 0) {
          parseMetaFromHeader(headerRegion.slice(0, endYaml), meta);
          text = text.slice(endYaml).trim();
        } else {
          // 単一行 YAML
          const knownKeys = /(?:marp|theme|size|paginate|footer|header|headingDivider|backgroundColor|color|class):/gi;
          let lastKeyEnd = 0;
          let m: RegExpExecArray | null;
          while ((m = knownKeys.exec(headerRegion)) !== null) {
            const rest = headerRegion.slice(m.index + m[0].length);
            const nextBreak = rest.search(/(?:\\+[ \t]*(?:\n|$)|(?:\n[ \t]*\n)|\n(?=[a-z]+:))/i);
            if (nextBreak >= 0) {
              lastKeyEnd = m.index + m[0].length + nextBreak;
            }
          }
          if (lastKeyEnd > 0) {
            parseMetaFromHeader(headerRegion.slice(0, lastKeyEnd), meta);
            text = text.slice(lastKeyEnd).trim();
          }
        }
      }
    }
  }

  // 先頭に残った CSS セレクタ/ルールブロック、閉じ括弧、記号残骸、不要な <br> を徹底的にループ除去
  let prevText = '';
  while (prevText !== text) {
    prevText = text;
    text = text.replace(/^(?:#*\s*[.#a-zA-Z0-9_\-\s,>:*~()@]+\{[^}]*\}\s*)+/, '').trim();
    text = text.replace(/^(?:[a-zA-Z\-]+\s*:\s*[^;\n]+;?\s*)+/, '').trim();
    text = text.replace(/^(?:[;\s\\}{)\]]|<br\s*\/?>)+/gi, '').trim();
  }

  // 行末の \\ 改行や行中の \ 改行エスケープを <br> に変換
  text = text.replace(/\\+[ \t]*\n/g, '<br>\n');
  text = text.replace(/\\+[ \t]+/g, '<br>');
  // 残った行末の \ を除去
  text = text.replace(/\\+[ \t]*$/gm, '');
  // 先頭に残った不要な記号残骸や <br> や改行を除去
  prevText = '';
  while (prevText !== text) {
    prevText = text;
    text = text.replace(/^(?:#*\s*[.#a-zA-Z0-9_\-\s,>:*~()@]+\{[^}]*\}\s*)+/, '').trim();
    text = text.replace(/^(?:[;\s\\}{)\]]|<br\s*\/?>)+/gi, '').trim();
  }

  return { meta, body: text };
}

/** スライド内の Marp ディレクティブ（<!-- _class: ... -->）や発表者ノートを抽出・除去する */
function parseSlideDirectives(rawSlide: string): {
  cleanSlide: string;
  className?: string;
  showNumber?: boolean;
  footer?: string;
  header?: string;
  notes?: string;
} {
  const commentRegex = /<!--([\s\S]*?)-->/g;
  let m: RegExpExecArray | null;
  const classes: string[] = [];
  const notes: string[] = [];
  let showNumber: boolean | undefined;
  let footer: string | undefined;
  let header: string | undefined;

  while ((m = commentRegex.exec(rawSlide)) !== null) {
    const content = m[1]!.trim();
    const classMatch = /(?:^_class|^class):\s*([\w\s-]+)/im.exec(content);
    if (classMatch) {
      const cList = classMatch[1]!.trim().split(/\s+/);
      for (const c of cList) {
        if (c === 'lead') classes.push('is-lead');
        else if (c === 'small') classes.push('is-small');
        else classes.push(`is-${c}`);
      }
    }
    const pagMatch = /(?:^_paginate|^paginate):\s*(false|true)/im.exec(content);
    if (pagMatch) {
      showNumber = pagMatch[1]!.toLowerCase() === 'true';
    }
    const footMatch = /(?:^_footer|^footer):\s*"?([^"\n]*)"?/im.exec(content);
    if (footMatch) {
      footer = footMatch[1]!.trim();
    }
    const headMatch = /(?:^_header|^header):\s*"?([^"\n]*)"?/im.exec(content);
    if (headMatch) {
      header = headMatch[1]!.trim();
    }
    if (!classMatch && !pagMatch && !footMatch && !headMatch && content.length > 0) {
      notes.push(content);
    }
  }

  let cleanSlide = rawSlide.replace(commentRegex, '').trim();
  cleanSlide = cleanSlide.replace(/^(?:[;\s\\}{)\]]|<br\s*\/?>)+/gi, '').trim();
  return {
    cleanSlide,
    className: classes.length > 0 ? classes.join(' ') : undefined,
    showNumber,
    footer,
    header,
    notes: notes.length > 0 ? notes.join('\n\n') : undefined,
  };
}

/** 画像の alt テキストから Marp のサイズ指定（w:1000, h:400 など）を取り出す */
function parseImageAttributes(rawAlt: string): { alt: string; width?: string; height?: string } {
  let alt = rawAlt;
  let width: string | undefined;
  let height: string | undefined;

  const wMatch = /\b(?:w|width):(\d+(?:px|%|cqw)?)\b/i.exec(alt);
  if (wMatch) {
    const val = wMatch[1]!;
    width = /^\d+$/.test(val) ? `${val}px` : val;
    alt = alt.replace(wMatch[0], '').trim();
  }

  const hMatch = /\b(?:h|height):(\d+(?:px|%|cqw)?)\b/i.exec(alt);
  if (hMatch) {
    const val = hMatch[1]!;
    height = /^\d+$/.test(val) ? `${val}px` : val;
    alt = alt.replace(hMatch[0], '').trim();
  }

  return { alt, width, height };
}

/** コードブロック外で、水平線（---, ***, ___）によるスライド区切りを見つけて分割する */
function splitMarkdownSlides(body: string): string[] {
  const text = body.replace(/\r\n/g, '\n').trim();
  const lines = text.split('\n');
  const slides: string[] = [];
  let current: string[] = [];
  let inCode = false;
  let codeFence = '';
  let foundHr = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const fMatch = /^```+|~~~+/.exec(trimmed);
    if (fMatch) {
      if (!inCode) {
        inCode = true;
        codeFence = fMatch[0];
      } else if (trimmed.startsWith(codeFence)) {
        inCode = false;
      }
    }

    if (!inCode && /^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
      foundHr = true;
      if (current.length > 0) {
        slides.push(current.join('\n'));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    slides.push(current.join('\n'));
  }

  const filtered = slides.filter((s) => s.trim().length > 0);

  // 水平線が1つも存在しない場合、見出し1 (# ) や見出し2 (## ) で分割を試みる
  if (!foundHr && filtered.length <= 1 && text.length > 0) {
    const headingSlides: string[] = [];
    let curSlide: string[] = [];
    inCode = false;

    for (const line of lines) {
      const trimmed = line.trim();
      const fMatch = /^```+|~~~+/.exec(trimmed);
      if (fMatch) {
        if (!inCode) {
          inCode = true;
          codeFence = fMatch[0];
        } else if (trimmed.startsWith(codeFence)) {
          inCode = false;
        }
      }
      if (!inCode && /^#{1,2}\s+/.test(trimmed) && curSlide.some((l) => l.trim().length > 0)) {
        headingSlides.push(curSlide.join('\n'));
        curSlide = [line];
      } else {
        curSlide.push(line);
      }
    }
    if (curSlide.length > 0 && curSlide.some((l) => l.trim().length > 0)) {
      headingSlides.push(curSlide.join('\n'));
    }
    if (headingSlides.length > 1) {
      return headingSlides;
    }
  }

  return filtered.length > 0 ? filtered : [text];
}

/** 1つのスライドのテキストをブロックに解析する */
function parseSlideBlocks(slideText: string, resolveUrl?: (url: string) => string, isFirstSlide = false): SlideBlock[] {
  const lines = slideText.split('\n');
  const blocks: SlideBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // 1. コードブロック
    const codeMatch = /^```+(\w*)/.exec(trimmed);
    if (codeMatch) {
      const fence = codeMatch[0].slice(0, 3);
      const lang = codeMatch[1] ?? '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence)) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++; // 閉じフェンスをスキップ
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') });
      continue;
    }

    // 2. 数式ブロック ($$...$$)
    if (trimmed.startsWith('$$')) {
      const mathLines: string[] = [];
      if (trimmed === '$$') {
        i++;
        while (i < lines.length && !lines[i]!.trim().startsWith('$$')) {
          mathLines.push(lines[i]!);
          i++;
        }
        if (i < lines.length) i++;
      } else if (trimmed.endsWith('$$') && trimmed.length > 4) {
        mathLines.push(trimmed.slice(2, -2).trim());
        i++;
      } else {
        mathLines.push(trimmed.slice(2));
        i++;
        while (i < lines.length && !lines[i]!.trim().endsWith('$$')) {
          mathLines.push(lines[i]!);
          i++;
        }
        if (i < lines.length) {
          mathLines.push(lines[i]!.trim().slice(0, -2));
          i++;
        }
      }
      blocks.push({ type: 'math', latex: mathLines.join('\n').trim() });
      continue;
    }

    // 3. 見出し (# )
    const hMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (hMatch) {
      let headingText = hMatch[2]!.trim();
      while (
        i + 1 < lines.length &&
        lines[i + 1]!.trim() &&
        !/^#{1,4}\s+/.test(lines[i + 1]!.trim()) &&
        (headingText.endsWith('<br>') ||
          (isFirstSlide &&
            blocks.length === 0 &&
            !/(?:発表|グループ|ゼミ|研究室|報告|専攻|学部|学科|学生|学籍|著者|氏名|作成|担当|日時|講義|授業|\d{4}年|\d{1,2}月\d{1,2}日|\d{4}[-/.]\d{1,2}|20\d\d)/.test(
              lines[i + 1]!.trim(),
            )))
      ) {
        i++;
        const next = lines[i]!.trim();
        if (headingText.endsWith('<br>')) {
          headingText += next;
        } else {
          headingText += '<br>' + next;
        }
        if (!next.endsWith('<br>')) {
          break;
        }
      }
      blocks.push({ type: 'heading', level: hMatch[1]!.length, text: headingText });
      i++;
      continue;
    }

    // 4. 画像単独行 (![alt](url))
    const imgMatch = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(trimmed);
    if (imgMatch) {
      const { alt, width, height } = parseImageAttributes(imgMatch[1]!);
      const rawUrl = imgMatch[2]!;
      const url = resolveUrl ? resolveUrl(rawUrl) : rawUrl;
      blocks.push({ type: 'image', alt, url, width, height });
      i++;
      continue;
    }

    // 5. 引用 (> )
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        quoteLines.push(lines[i]!.trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', text: quoteLines.join('\n') });
      continue;
    }

    // 6. テーブル (| ... |)
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && i + 1 < lines.length && /^\|\s*[-:]+[-| :]*\|$/.test(lines[i + 1]!.trim())) {
      const parseCells = (row: string) =>
        row
          .slice(1, -1)
          .split('|')
          .map((c) => c.trim());
      const headers = parseCells(trimmed);
      const sepRow = parseCells(lines[i + 1]!.trim());
      const alignments = sepRow.map((c): 'left' | 'center' | 'right' => {
        const left = c.startsWith(':');
        const right = c.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        return 'left';
      });
      i += 2; // ヘッダーと区切り行をスキップ
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|') && lines[i]!.trim().endsWith('|')) {
        rows.push(parseCells(lines[i]!.trim()));
        i++;
      }
      blocks.push({ type: 'table', headers, rows, alignments });
      continue;
    }

    // 7. リスト（箇条書き・番号・タスク）
    const bulletMatch = /^(\s*)(?:[-*+]|\d+\.)\s+(.+)$/.exec(line);
    if (bulletMatch) {
      const items: { text: string; level: number; checked?: boolean }[] = [];
      const isOrdered = /^\s*\d+\./.test(line);
      while (i < lines.length) {
        const curLine = lines[i]!;
        const m = /^(\s*)(?:([-*+])|(\d+\.))\s+(.*)$/.exec(curLine);
        if (!m) {
          if (!curLine.trim()) {
            i++;
            break;
          }
          // リストの継続行
          if (items.length > 0 && /^\s{2,}/.test(curLine)) {
            items[items.length - 1]!.text += ' ' + curLine.trim();
            i++;
            continue;
          }
          break;
        }
        const indent = m[1]!.length;
        const level = Math.floor(indent / 2);
        let itemText = m[4]!;
        let checked: boolean | undefined = undefined;

        // タスクリストチェック: [ ] または [x]
        const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(itemText);
        if (taskMatch) {
          checked = taskMatch[1]!.toLowerCase() === 'x';
          itemText = taskMatch[2]!;
        }

        items.push({ text: itemText, level, checked });
        i++;
      }
      blocks.push({ type: 'list', ordered: isOrdered, items });
      continue;
    }

    // 8. HTML ブロック（<div, <iframe, <table, <p, <section, <center など）
    if (/^<([a-z1-6]+)\b[^>]*>/i.test(trimmed) && !trimmed.startsWith('<!--')) {
      const tagMatch = /^<([a-z1-6]+)\b/i.exec(trimmed);
      const tag = tagMatch ? tagMatch[1]!.toLowerCase() : '';
      const htmlLines: string[] = [line];
      if (trimmed.endsWith(`</${tag}>`) || trimmed.endsWith('/>')) {
        blocks.push({ type: 'html', html: htmlLines.join('\n') });
        i++;
        continue;
      }
      i++;
      while (i < lines.length) {
        htmlLines.push(lines[i]!);
        if (lines[i]!.includes(`</${tag}>`)) {
          i++;
          break;
        }
        i++;
      }
      blocks.push({ type: 'html', html: htmlLines.join('\n') });
      continue;
    }

    // 9. 通常段落
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^#{1,4}\s+/.test(lines[i]!.trim()) &&
      !/^```+/.test(lines[i]!.trim()) &&
      !lines[i]!.trim().startsWith('$$') &&
      !lines[i]!.trim().startsWith('>') &&
      !lines[i]!.trim().startsWith('|') &&
      !/^<([a-z1-6]+)\b[^>]*>/i.test(lines[i]!.trim()) &&
      !/^(\s*)(?:[-*+]|\d+\.)\s+/.test(lines[i]!)
    ) {
      paraLines.push(lines[i]!.trim());
      i++;
    }
    if (paraLines.length > 0) {
      const cleaned = paraLines
        .map((l) =>
          l
            .replace(/^(?:[;\s\\}{)\]]|<br\s*\/?>)+/gi, '')
            .replace(/(?:[;\s\\}{)\]]|<br\s*\/?>)+$/gi, '')
            .trim(),
        )
        .filter(Boolean);

      if (cleaned.length === 0) continue;

      // 最初のスライド（表紙）で見出しがまだ無い場合、タイトル行とサブタイトル/メタデータ行に自動分割
      if (isFirstSlide && blocks.length === 0) {
        if (cleaned.length >= 2) {
          const subRegex =
            /(?:発表|グループ|ゼミ|研究室|報告|専攻|学部|学科|学生|学籍|著者|氏名|作成|担当|日時|講義|授業|\d{4}年|\d{1,2}月\d{1,2}日|\d{4}[-/.]\d{1,2}|20\d\d)/;
          let splitIdx = -1;
          for (let k = 1; k < cleaned.length; k++) {
            if (subRegex.test(cleaned[k]!)) {
              splitIdx = k;
              break;
            }
          }
          if (splitIdx === -1 && cleaned.length >= 3) {
            splitIdx = 2;
          }
          if (splitIdx > 0) {
            const titleText = cleaned.slice(0, splitIdx).join('<br>');
            const subText = cleaned.slice(splitIdx).join('<br>');
            blocks.push({ type: 'heading', level: 1, text: titleText });
            if (subText) {
              blocks.push({ type: 'paragraph', text: subText });
            }
            continue;
          }
        }
        // 1行のみ、または分割対象外の場合は H1 見出しとして扱う
        blocks.push({ type: 'heading', level: 1, text: cleaned.join('<br>') });
        continue;
      }

      blocks.push({ type: 'paragraph', text: cleaned.join('<br>') });
    }
  }

  return blocks;
}

/** インライン記法（太字・斜体・コード・リンク・LaTeX数式・改行・URL）を ReactNode に分解して描画 */
function renderInline(text: string): ReactNode {
  if (!text) return null;
  // 1: <br> 改行
  // 2: インライン数式 $...$
  // 3: コード `...`
  // 4: 画像 ![alt](url)
  // 5: リンク [text](url)
  // 6: URL 直接貼り付け
  // 7: 太字 **...**
  // 8: 斜体 *...*
  // 9: 取り消し線 ~~...~~
  const regex =
    /(<br\s*\/?>)|(\$(?!\s)(?:\\\$|[^$\n])+?(?<!\s)\$)|(`[^`\n]+`)|(!\[[^\]]*\]\([^)\s]+\))|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<]+)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(~~[^~]+~~)/gi;

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${match.index}-${token}`;

    if (/^<br\s*\/?>$/i.test(token)) {
      nodes.push(<br key={key} />);
    } else if (token.startsWith('$') && token.endsWith('$')) {
      const latex = token.slice(1, -1);
      nodes.push(
        <span
          key={key}
          className="math-inline"
          dangerouslySetInnerHTML={{ __html: renderTex(latex, false) }}
        />,
      );
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={key} className="md-slide-code-inline">{token.slice(1, -1)}</code>);
    } else if (token.startsWith('![') && token.includes('](')) {
      const m = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
      if (m) {
        nodes.push(<img key={key} className="md-slide-inline-img" src={m[2]} alt={m[1]} />);
      }
    } else if (token.startsWith('[') && token.includes('](')) {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (m) {
        nodes.push(
          <a key={key} href={m[2]} target="_blank" rel="noopener noreferrer" className="md-slide-link">
            {m[1]}
          </a>,
        );
      }
    } else if (/^https?:\/\//i.test(token)) {
      nodes.push(
        <a key={key} href={token} target="_blank" rel="noopener noreferrer" className="md-slide-link">
          {token}
        </a>,
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('~~') && token.endsWith('~~')) {
      nodes.push(<s key={key}>{token.slice(2, -2)}</s>);
    } else {
      nodes.push(token);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return <>{nodes}</>;
}

/** 1枚のスライド要素 */
function SlideCard({
  slide,
  index,
  total,
  className,
  onClick,
}: {
  slide: ParsedSlide;
  index: number;
  total: number;
  className?: string;
  onClick?: () => void;
}) {
  const isTitle = slide.isTitleSlide;

  return (
    <figure
      className={`md-slide ${isTitle ? 'is-title-slide is-lead' : ''} ${slide.className ?? ''} ${className ?? ''}`}
      onClick={onClick}
      role="region"
      aria-label={`スライド ${index + 1} / ${total}`}
    >
      {slide.header && <header className="md-slide-header">{renderInline(slide.header)}</header>}
      <div className="md-slide-body">
        {slide.blocks.map((block, bi) => {
          switch (block.type) {
            case 'heading': {
              const isMainTitle = isTitle && (bi === 0 || block.level === 1);
              const level = isMainTitle ? 1 : block.level;
              const Tag = (level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3') as 'h1' | 'h2' | 'h3';
              return (
                <Tag key={bi} className={`md-slide-heading md-slide-h${level}`}>
                  {renderInline(block.text)}
                </Tag>
              );
            }
            case 'paragraph': {
              // タイトルスライドで見出しが1つもない場合、最初の段落をタイトル(h1)として表示
              if (isTitle && bi === 0 && !slide.blocks.some((b) => b.type === 'heading')) {
                return (
                  <h1 key={bi} className="md-slide-heading md-slide-h1">
                    {renderInline(block.text)}
                  </h1>
                );
              }
              return (
                <p key={bi} className="md-slide-paragraph">
                  {renderInline(block.text)}
                </p>
              );
            }
            case 'list': {
              return (
                <ul key={bi} className={`md-slide-list ${block.ordered ? 'is-ordered' : ''}`}>
                  {block.items.map((item, ii) => (
                    <li
                      key={ii}
                      className={`md-slide-list-item ${item.checked !== undefined ? 'is-task' : ''}`}
                      style={{ paddingLeft: `${item.level * 1.5}cqw` }}
                    >
                      {item.checked !== undefined ? (
                        <span className={`md-slide-checkbox ${item.checked ? 'is-checked' : ''}`}>
                          {item.checked ? '☑' : '☐'}
                        </span>
                      ) : block.ordered ? (
                        <span className="md-slide-num">{ii + 1}.</span>
                      ) : (
                        <span className="md-slide-bullet">•</span>
                      )}
                      <span className="md-slide-item-text">{renderInline(item.text)}</span>
                    </li>
                  ))}
                </ul>
              );
            }
            case 'code':
              return (
                <div key={bi} className="md-slide-code-block">
                  {block.lang && <div className="md-slide-code-lang">{block.lang}</div>}
                  <pre>
                    <code>{block.code}</code>
                  </pre>
                </div>
              );
            case 'quote':
              return (
                <blockquote key={bi} className="md-slide-quote">
                  {renderInline(block.text)}
                </blockquote>
              );
            case 'image': {
              const imgStyle: React.CSSProperties = {
                maxWidth: '100%',
                maxHeight: '48cqw',
                objectFit: 'contain',
              };
              if (block.width) {
                imgStyle.width = block.width.endsWith('px') ? `min(${block.width}, 100%)` : block.width;
              }
              if (block.height) {
                imgStyle.height = block.height.endsWith('px') ? `min(${block.height}, 48cqw)` : block.height;
              }
              return (
                <div key={bi} className="md-slide-image-wrapper">
                  <img src={block.url} alt={block.alt} className="md-slide-image" style={imgStyle} />
                </div>
              );
            }
            case 'table':
              return (
                <div key={bi} className="md-slide-table-wrapper">
                  <table className="md-slide-table">
                    <thead>
                      <tr>
                        {block.headers.map((h, hi) => (
                          <th key={hi} style={{ textAlign: block.alignments?.[hi] ?? 'left' }}>
                            {renderInline(h)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {block.rows.map((row, ri) => (
                        <tr key={ri}>
                          {row.map((cell, ci) => (
                            <td key={ci} style={{ textAlign: block.alignments?.[ci] ?? 'left' }}>
                              {renderInline(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            case 'html':
              // SVG の図・iframe・style 付きの HTML は、安全な枠の中にそのまま表示する
              return needsEmbed(block.html) ? (
                <div key={bi} className="md-slide-html-block">
                  <HtmlEmbedFrame html={block.html} />
                </div>
              ) : (
                <div
                  key={bi}
                  className="md-slide-html-block"
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(block.html) }}
                />
              );
            case 'math':
              return (
                <div
                  key={bi}
                  className="md-slide-math-block"
                  dangerouslySetInnerHTML={{ __html: renderTex(block.latex, true) }}
                />
              );
            default:
              return null;
          }
        })}
      </div>
      {slide.footer && (!isTitle || slide.hasDirectFooter) && (
        <footer className="md-slide-footer">{renderInline(slide.footer)}</footer>
      )}
      {slide.showNumber !== false && (!isTitle || slide.hasDirectPaginate) && (
        <figcaption className="md-slide-number">
          {index + 1} / {total}
        </figcaption>
      )}
    </figure>
  );
}

/** Markdown をスライドとして表示・発表するメインコンポーネント */
export default function MdSlidesView({ markdown, title, font, autoPlay, onClose, className, workspaceId, filePath, resolveImageUrl, theme, onThemeChange }: MdSlidesViewProps) {
  const activeTheme = findSlideTheme(theme);
  const [themeOpen, setThemeOpen] = useState(false);
  const themeRef = useRef<HTMLDivElement>(null);
  // テーマの一覧は、外を押したら閉じる
  useEffect(() => {
    if (!themeOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!themeRef.current?.contains(e.target as Node)) setThemeOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [themeOpen]);
  const [current, setCurrent] = useState(0);
  const [isGrid, setIsGrid] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(autoPlay ?? false);
  const [intervalSec, setIntervalSec] = useState<number>(5);
  const [progress, setProgress] = useState(0);
  const [showNotes, setShowNotes] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastTick = useRef<number>(performance.now());

  // Markdown をパースしてスライドの配列にする
  const { meta, slides } = useMemo<{ meta: DeckMeta; slides: ParsedSlide[] }>(() => {
    const { meta: deckMeta, body } = extractDeckMetaAndBody(markdown);
    const rawSlides = splitMarkdownSlides(body);
    const resolveUrl = makeUrlResolver(workspaceId, filePath, resolveImageUrl);

    const parsed = rawSlides.map((raw, idx) => {
      const { cleanSlide, className: directiveClass, showNumber: directiveShowNumber, footer: directiveFooter, header: directiveHeader, notes } = parseSlideDirectives(raw);
      const blocks = parseSlideBlocks(cleanSlide, resolveUrl, idx === 0);

      // スライドタイトルを検出（見出しがなければ最初の段落）
      const firstHeading = blocks.find((b) => b.type === 'heading') as { type: 'heading'; level: number; text: string } | undefined;
      const firstPara = blocks.find((b) => b.type === 'paragraph') as { type: 'paragraph'; text: string } | undefined;
      const rawTitle = firstHeading?.text ?? (idx === 0 ? firstPara?.text : undefined);
      const slideTitle = rawTitle
        ? rawTitle.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        : `スライド ${idx + 1}`;

      const isTitleSlide =
        directiveClass?.includes('is-lead') ||
        (idx === 0 && (firstHeading?.level === 1 || !blocks.some((b) => b.type === 'table' || b.type === 'list' || b.type === 'image' || b.type === 'code'))) ||
        (blocks.length <= 2 && blocks.some((b) => b.type === 'heading' && b.level === 1));

      const slideFooter = directiveFooter !== undefined ? directiveFooter : deckMeta.footer;
      const slideHeader = directiveHeader !== undefined ? directiveHeader : deckMeta.header;
      const slideShowNumber = directiveShowNumber !== undefined ? directiveShowNumber : (deckMeta.paginate ?? true);

      return {
        id: idx,
        raw,
        title: slideTitle,
        isTitleSlide: !!isTitleSlide,
        className: directiveClass,
        showNumber: slideShowNumber,
        footer: slideFooter || undefined,
        header: slideHeader || undefined,
        hasDirectFooter: directiveFooter !== undefined,
        hasDirectPaginate: directiveShowNumber !== undefined,
        notes,
        blocks,
      };
    });

    return { meta: deckMeta, slides: parsed };
  }, [markdown, workspaceId, filePath, resolveImageUrl]);

  const total = slides.length;
  const currentSlide = slides[current] ?? slides[0];

  const resetTimer = () => {
    lastTick.current = performance.now();
    setProgress(0);
  };

  const goNext = () => {
    resetTimer();
    setCurrent((c) => Math.min(c + 1, total - 1));
  };
  const goPrev = () => {
    resetTimer();
    setCurrent((c) => Math.max(c - 1, 0));
  };

  const cycleInterval = () => {
    const list = [3, 5, 10, 15];
    const nextIdx = (list.indexOf(intervalSec) + 1) % list.length;
    setIntervalSec(list[nextIdx]!);
    resetTimer();
  };

  // 自動再生タイマー
  useEffect(() => {
    if (!isPlaying || isGrid || total <= 1) {
      setProgress(0);
      return;
    }
    lastTick.current = performance.now();
    const duration = intervalSec * 1000;
    const interval = setInterval(() => {
      const elapsed = performance.now() - lastTick.current;
      if (elapsed >= duration) {
        lastTick.current = performance.now();
        setProgress(0);
        setCurrent((c) => (c + 1 >= total ? 0 : c + 1));
      } else {
        setProgress(Math.min(1, elapsed / duration));
      }
    }, 50);
    return () => clearInterval(interval);
  }, [isPlaying, isGrid, total, intervalSec]);

  // フルスクリーン切り替え
  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        if (containerRef.current?.requestFullscreen) {
          await containerRef.current.requestFullscreen();
        }
      } else {
        await document.exitFullscreen();
      }
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // キーボードナビゲーション
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 入力要素にフォーカスがある時はスキップ
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ' || e.key === 'PageDown' || e.key === 'Enter') {
        e.preventDefault();
        goNext();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Backspace') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'Home') {
        e.preventDefault();
        setCurrent(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setCurrent(total - 1);
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        setIsPlaying((v) => !v);
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        setShowNotes((v) => !v);
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        void toggleFullscreen();
      } else if (e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        setIsGrid((v) => {
          if (!v) setIsPlaying(false);
          return !v;
        });
      } else if (e.key === 'Escape') {
        if (themeOpen) {
          e.preventDefault();
          setThemeOpen(false);
        } else if (isGrid) {
          e.preventDefault();
          setIsGrid(false);
        } else if (onClose && !document.fullscreenElement) {
          e.preventDefault();
          onClose();
        }
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [total, isGrid, onClose, themeOpen]);

  // タッチスワイプ対応
  const touchStart = useRef<number | null>(null);
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStart.current = e.touches[0]?.clientX ?? null;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStart.current === null) return;
    const diff = touchStart.current - (e.changedTouches[0]?.clientX ?? touchStart.current);
    if (Math.abs(diff) > 50) {
      if (diff > 0) goNext();
      else goPrev();
    }
    touchStart.current = null;
  };

  return (
    <div
      ref={containerRef}
      className={`md-slides-view page-font-${font ?? 'default'} ${activeTheme ? `slide-theme-${activeTheme.id}` : ''} ${isFullscreen ? 'is-fullscreen' : ''} ${className ?? ''}`}
      style={meta.accentColor ? ({ '--accent': meta.accentColor } as React.CSSProperties) : undefined}
      tabIndex={0}
    >
      {/* 上部・ヘッダー情報 */}
      <div className="md-slides-toolbar">
        <div className="md-slides-title ellipsis">
          <PageIcon icon="ms:slideshow" size={18} />
          <span>{title || currentSlide?.title || 'プレゼンテーション'}</span>
        </div>
        <div className="md-slides-actions">
          <div className="md-slides-play-group">
            <Button
              size="sm"
              variant={isPlaying ? 'primary' : 'ghost'}
              title={isPlaying ? 'スライドショーを一時停止（P）' : 'スライドショーを自動再生（P）'}
              onClick={() => {
                setIsPlaying((v) => !v);
                if (isGrid) setIsGrid(false);
              }}
            >
              <PageIcon icon={isPlaying ? 'ms:pause' : 'ms:play_arrow'} size={16} />
              <span>{isPlaying ? '一時停止' : '再生'}</span>
            </Button>
            <button
              type="button"
              className="md-slides-toolbar-interval"
              onClick={cycleInterval}
              title="再生間隔を変更（クリックで 3秒/5秒/10秒/15秒 切り替え）"
            >
              {intervalSec}s
            </button>
          </div>
          {slides.some((s) => !!s.notes) && (
            <Button
              size="sm"
              variant={showNotes ? 'primary' : 'ghost'}
              title="発表者ノートを表示 / 非表示（N）"
              onClick={() => setShowNotes((v) => !v)}
            >
              <Icon name="comment" size={16} />
              <span>ノート</span>
            </Button>
          )}
          {onThemeChange && (
            <div className="md-slides-theme" ref={themeRef}>
              <Button size="sm" variant={themeOpen ? 'primary' : 'ghost'} title="スライドのテーマを選ぶ" aria-expanded={themeOpen} onClick={() => setThemeOpen((v) => !v)}>
                <PageIcon icon="ms:palette" size={16} />
                <span>{activeTheme?.label ?? 'テーマ'}</span>
              </Button>
              {themeOpen && (
                <div className="md-slides-theme-panel" role="listbox" aria-label="スライドのテーマ">
                  {[null, ...SLIDE_THEMES].map((t) => {
                    const selected = (t?.id ?? null) === (activeTheme?.id ?? null);
                    return (
                      <button
                        key={t?.id ?? 'default'}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`md-slides-theme-item ${selected ? 'is-selected' : ''}`}
                        onClick={() => {
                          onThemeChange(t?.id ?? null);
                          setThemeOpen(false);
                        }}
                      >
                        <span
                          className={`md-slides-theme-swatch ${t ? '' : 'is-default'}`}
                          style={t ? { background: t.swatch.bg, color: t.swatch.text, borderColor: t.swatch.accent } : undefined}
                          aria-hidden="true"
                        >
                          あ<i style={t ? { background: t.swatch.accent } : undefined} />
                        </span>
                        <span className="md-slides-theme-text">
                          <span className="md-slides-theme-name">{t?.label ?? '標準'}</span>
                          <span className="md-slides-theme-desc">{t?.description ?? 'アプリの色と文字の形に合わせる'}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          <Button
            size="sm"
            variant="ghost"
            title="一覧表示の切り替え（G）"
            onClick={() => {
              setIsGrid((v) => {
                if (!v) setIsPlaying(false);
                return !v;
              });
            }}
          >
            <Icon name="grid" size={16} />
            <span>{isGrid ? 'プレゼンに戻る' : '一覧'}</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title={isFullscreen ? '全画面を解除（F / Esc）' : '全画面表示（F）'}
            onClick={() => void toggleFullscreen()}
          >
            <Icon name={isFullscreen ? 'fullscreenExit' : 'fullscreen'} size={16} />
          </Button>
          {onClose && (
            <Button size="sm" variant="ghost" title="閉じる（Esc）" onClick={onClose}>
              <Icon name="x" size={16} />
            </Button>
          )}
        </div>
      </div>

      {/* メインエリア */}
      {isGrid ? (
        <div className="md-slides-grid-view">
          <div className="md-slides-grid">
            {slides.map((s, idx) => (
              <div
                key={idx}
                className={`md-slides-grid-item ${idx === current ? 'is-current' : ''}`}
                onClick={() => {
                  setCurrent(idx);
                  setIsGrid(false);
                }}
              >
                <SlideCard slide={s} index={idx} total={total} className="is-thumbnail" />
                <div className="md-slides-grid-caption">
                  <span className="md-slides-grid-no">{idx + 1}</span>
                  <span className="md-slides-grid-name ellipsis">{s.title}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div
          className="md-slides-stage"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {isPlaying && (
            <div className="md-slides-progress-track">
              <div className="md-slides-progress-bar" style={{ width: `${progress * 100}%` }} />
            </div>
          )}

          <div className="md-slides-frame">
            {currentSlide && <SlideCard slide={currentSlide} index={current} total={total} />}
          </div>

          {/* クリックでのスライド送り領域（左右エリア） */}
          <button
            type="button"
            className="md-slides-nav-zone is-prev"
            disabled={current === 0 && !isPlaying}
            onClick={goPrev}
            aria-label="前のスライドへ"
          />
          <button
            type="button"
            className="md-slides-nav-zone is-next"
            disabled={current === total - 1 && !isPlaying}
            onClick={goNext}
            aria-label="次のスライドへ"
          />

          {/* 発表者ノート表示 */}
          {showNotes && currentSlide?.notes && (
            <div className="md-slides-notes-bar" role="complementary" aria-label="発表者ノート">
              <div className="md-slides-notes-label">発表者ノート</div>
              <div className="md-slides-notes-content">{currentSlide.notes}</div>
            </div>
          )}

          {/* 下部フローティングコントロールバー */}
          <div className="md-slides-controls">
            <button
              type="button"
              className="md-slides-btn"
              disabled={current === 0 && !isPlaying}
              onClick={goPrev}
              title="前のスライド（← / Space）"
              aria-label="前のスライド"
            >
              <Icon name="chevronLeft" size={18} />
            </button>
            <button
              type="button"
              className={`md-slides-btn ${isPlaying ? 'is-active' : ''}`}
              onClick={() => setIsPlaying((v) => !v)}
              title={isPlaying ? '一時停止（P）' : '自動再生（P）'}
              aria-label={isPlaying ? '一時停止' : '自動再生'}
            >
              <PageIcon icon={isPlaying ? 'ms:pause' : 'ms:play_arrow'} size={18} />
            </button>
            {isPlaying && (
              <button
                type="button"
                className="md-slides-interval-btn"
                onClick={cycleInterval}
                title="再生間隔を変更（クリックで切り替え）"
              >
                {intervalSec}s
              </button>
            )}
            <div className="md-slides-counter">
              <span className="md-slides-cur">{current + 1}</span>
              <span className="md-slides-sep">/</span>
              <span className="md-slides-tot">{total}</span>
            </div>
            <button
              type="button"
              className="md-slides-btn"
              disabled={current === total - 1 && !isPlaying}
              onClick={goNext}
              title="次のスライド（→ / Space）"
              aria-label="次のスライド"
            >
              <Icon name="chevronRight" size={18} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
