/**
 * 数式（LaTeX）。文中の数式（$...$）と、独立した数式のブロック（$$...$$）を KaTeX で表示する。
 *
 * - エディターのスキーマ（mathSchema）に、文中の「math」と、ブロックの「equation」を足す
 * - Markdown との変換：読み込み時は $ の記法を数式に、書き出し時は数式を $ の記法に戻す
 *   （数式の中の _ や * が Markdown の記号として崩れないよう、いったん目印に置き換えてから変換する）
 */
import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, type BlockNoteEditor } from '@blocknote/core';
import { createReactBlockSpec, createReactInlineContentSpec } from '@blocknote/react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useEffect, useRef, useState } from 'react';
import { Popover } from '../ui';
import { DueSpec, dueToHtml, dueToMarkdown, protectDue, restoreDue } from './due';
import { HtmlEmbedSpec } from './htmlEmbed';
import { htmlBlockAt, htmlMarksToHtml, htmlMarksToMarkdown, HTML_MARK, protectHtmlEmbeds, restoreHtmlBlock } from './htmlMarks';
import { CiteSpec, extractNoteDefs, FootnoteSpec, notesToMarkdown, protectNotesLine, ReferencesSpec, renderNotesInHtml, restoreNoteMark, restoreRefsBlock } from './notes';

export function renderTex(latex: string, display: boolean) {
  return katex.renderToString(latex, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml' });
}

/** LaTeX の入力欄（入力中もプレビューする） */
function TexEditor({ value, display, onChange, onDone }: { value: string; display: boolean; onChange: (v: string) => void; onDone: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, []);
  return (
    <div className="tex-editor" onMouseDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        className="tex-input"
        value={value}
        rows={display ? 3 : 1}
        spellCheck={false}
        placeholder={display ? '例：\\int_0^1 x^2 \\, dx = \\frac{1}{3}' : '例：x^2 + y^2 = r^2'}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !display) || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
            e.preventDefault();
            onDone();
          }
        }}
      />
      <div className="tex-hint">{display ? '⌘/Ctrl + Enter で確定' : 'Enter で確定'}・LaTeX で書けます</div>
    </div>
  );
}

function InlineMath({ latex, editable, onChange }: { latex: string; editable: boolean; onChange: (v: string) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(editable && !latex);
  const [draft, setDraft] = useState(latex);
  useEffect(() => setDraft(latex), [latex]);
  const done = () => {
    setOpen(false);
    if (draft !== latex) onChange(draft);
  };
  return (
    <>
      <span
        ref={ref}
        className={`math-inline ${latex ? '' : 'is-empty'} ${editable ? 'is-editable' : ''}`}
        onClick={() => editable && setOpen(true)}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: latex ? renderTex(latex, false) : '数式' }}
      />
      {open && (
        <Popover anchor={ref.current} onClose={done} width={360}>
          <TexEditor value={draft} display={false} onChange={setDraft} onDone={done} />
          {draft && <div className="tex-preview" dangerouslySetInnerHTML={{ __html: renderTex(draft, false) }} />}
        </Popover>
      )}
    </>
  );
}

function BlockMath({ latex, editable, onChange }: { latex: string; editable: boolean; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(editable && !latex);
  const [draft, setDraft] = useState(latex);
  useEffect(() => setDraft(latex), [latex]);
  const done = () => {
    setEditing(false);
    if (draft !== latex) onChange(draft);
  };
  return (
    <div className={`math-block ${editable ? 'is-editable' : ''}`} contentEditable={false}>
      <div
        className={`math-block-view ${draft ? '' : 'is-empty'}`}
        onClick={() => editable && setEditing(true)}
        dangerouslySetInnerHTML={{ __html: draft ? renderTex(draft, true) : '数式を入力（LaTeX）' }}
      />
      {editing && <TexEditor value={draft} display onChange={setDraft} onDone={done} />}
    </div>
  );
}

// Markdown に書き出すときの目印（16 進にして、Markdown の記号として扱われないようにする）
const hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => new TextDecoder().decode(new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16))));
const INLINE_MARK = (latex: string) => `⟦M${hex(latex)}⟧`;
const BLOCK_MARK = (latex: string) => `⟦B${hex(latex)}⟧`;

export const MathInlineSpec = createReactInlineContentSpec(
  { type: 'math', propSchema: { latex: { default: '' } }, content: 'none' },
  {
    render: (props) => (
      <InlineMath
        latex={props.inlineContent.props.latex}
        editable={props.editor.isEditable}
        onChange={(latex) => props.updateInlineContent({ type: 'math', props: { latex } })}
      />
    ),
    toExternalHTML: (props) => <span>{INLINE_MARK(props.inlineContent.props.latex)}</span>,
  },
);

// ブロックの名前は文中の数式（math）と重ならないようにする（エディター内部で同じ名前は使えない）
export const MathBlockSpec = createReactBlockSpec(
  { type: 'equation', propSchema: { latex: { default: '' } }, content: 'none' },
  {
    render: (props) => (
      <BlockMath latex={props.block.props.latex} editable={props.editor.isEditable} onChange={(latex) => props.editor.updateBlock(props.block, { props: { latex } })} />
    ),
    toExternalHTML: (props) => <p>{BLOCK_MARK(props.block.props.latex)}</p>,
  },
);

/** 数式を使えるエディターのスキーマ（画面のエディターと、Markdown の変換用エディターで共通） */
export const mathSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, equation: MathBlockSpec(), references: ReferencesSpec(), html: HtmlEmbedSpec() },
  inlineContentSpecs: { ...defaultInlineContentSpecs, math: MathInlineSpec, footnote: FootnoteSpec, cite: CiteSpec, due: DueSpec },
});

export type MathEditor = BlockNoteEditor<typeof mathSchema.blockSchema, typeof mathSchema.inlineContentSchema, typeof mathSchema.styleSchema>;

/** 変換用のエディター（画面に出さない） */
export async function headlessEditor() {
  const { BlockNoteEditor } = await import('@blocknote/core');
  return BlockNoteEditor.create({ schema: mathSchema }) as unknown as MathEditor;
}

/** 書き出した HTML の数式・脚注・引用の目印を、組んだ形にする（PDF 用） */
export function renderMathInHtml(html: string) {
  return dueToHtml(renderNotesInHtml(htmlMarksToHtml(html)))
    .replace(/<p[^>]*>\s*⟦B([0-9a-f]*)⟧\s*<\/p>/g, (_, h: string) => `<div class="report-equation">${renderTex(unhex(h), true)}</div>`)
    .replace(/⟦B([0-9a-f]*)⟧/g, (_, h: string) => `<div class="report-equation">${renderTex(unhex(h), true)}</div>`)
    .replace(/⟦M([0-9a-f]*)⟧/g, (_, h: string) => renderTex(unhex(h), false));
}

/** ブロック → Markdown（数式は $...$ / $$...$$、脚注は [^1]、引用は [@key] にする） */
export function blocksToMarkdown(editor: { blocksToMarkdownLossy: (b: any) => string }, blocks: any[]) {
  return htmlMarksToMarkdown(dueToMarkdown(notesToMarkdown(
    editor
      .blocksToMarkdownLossy(blocks)
      .replace(/^[ \t]*⟦B([0-9a-f]*)⟧[ \t]*$/gm, (_, h: string) => `$$\n${unhex(h)}\n$$`)
      .replace(/⟦M([0-9a-f]*)⟧/g, (_, h: string) => `$${unhex(h)}$`),
  )));
}

/** Markdown の中の数式を目印に置き換える（コードの中は対象外） */
function protectMath(md: string) {
  const out: string[] = [];
  // 脚注の定義（[^1]: 文）と参考文献は先に取り出す
  const { defs, lines } = extractNoteDefs(md.split('\n'));
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^\s*(```+|~~~+)\s*(\w*)/.exec(line);
    if (fence) {
      if (f && line.trim().startsWith(fence)) fence = null;
      out.push(line);
      continue;
    }
    // ```math は数式のブロック
    if (f && f[2] === 'math') {
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trim().startsWith(f[1]!)) body.push(lines[j++]!);
      out.push('', BLOCK_MARK(body.join('\n').trim()), '');
      i = j;
      continue;
    }
    if (f) {
      fence = f[1]!;
      out.push(line);
      continue;
    }
    // エディターのブロックでは表せない HTML（SVG の図・iframe・style 付きなど）は、HTML の埋め込みにする
    const html = htmlBlockAt(lines, i);
    if (html) {
      out.push('', HTML_MARK(html.html), '');
      i = html.end;
      continue;
    }
    // $$ ... $$（1 行、または複数行）
    const one = /^\s*\$\$(.+?)\$\$\s*$/.exec(line);
    if (one) {
      out.push('', BLOCK_MARK(one[1]!.trim()), '');
      continue;
    }
    if (/^\s*\$\$\s*$/.test(line) || /^\s*\$\$[^$]/.test(line)) {
      const body: string[] = [line.replace(/^\s*\$\$/, '')];
      let j = i + 1;
      while (j < lines.length && !/\$\$\s*$/.test(lines[j]!)) body.push(lines[j++]!);
      if (j < lines.length) {
        body.push(lines[j]!.replace(/\$\$\s*$/, ''));
        out.push('', BLOCK_MARK(body.join('\n').trim()), '');
        i = j;
        continue;
      }
    }
    // 文中の $...$（インラインコードの中は除く。$ の直後・直前が空白なら数式ではない、閉じた $ の直後が数字なら金額とみなす）
    out.push(
      line
        .split(/(`+[^`]*`+)/)
        .map((part) => (part.startsWith('`') ? part : protectDue(protectNotesLine(part, defs)).replace(/(^|[^\\$])\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/g, (_m, pre: string, tex: string) => `${pre}${INLINE_MARK(tex)}`)))
        .join(''),
    );
  }
  return out.join('\n');
}

/** 目印を数式に戻す（変換後のブロックを走査する） */
function restoreMath(blocks: any[]): any[] {
  const inline = (content: any): any => {
    if (!Array.isArray(content)) return content;
    const out: any[] = [];
    for (const c of content) {
      if (c.type === 'text' && /⟦[MFCD]/.test(c.text)) {
        // 数式・脚注・引用の目印
        const parts = c.text.split(/⟦([MFCD])([0-9a-f]*)⟧/);
        for (let i = 0; i < parts.length; i += 3) {
          if (parts[i]) out.push({ ...c, text: parts[i] });
          if (i + 2 < parts.length) out.push(parts[i + 1] === 'M' ? { type: 'math', props: { latex: unhex(parts[i + 2]!) } } : parts[i + 1] === 'D' ? restoreDue(parts[i + 2]!) : restoreNoteMark(parts[i + 1]!, parts[i + 2]!));
        }
      } else if (c.type === 'link') out.push({ ...c, content: inline(c.content) });
      else out.push(c);
    }
    return out;
  };
  return blocks.map((b) => {
    const text = Array.isArray(b.content) && b.content.length === 1 && b.content[0].type === 'text' ? b.content[0].text.trim() : null;
    const m = text && /^⟦B([0-9a-f]*)⟧$/.exec(text);
    if (b.type === 'paragraph' && m) return { type: 'equation', props: { latex: unhex(m[1]!) }, children: b.children ?? [] };
    const embed = b.type === 'paragraph' && text ? restoreHtmlBlock(text) : null;
    if (embed) return { ...embed, children: b.children ?? [] };
    const refs = b.type === 'paragraph' && text ? restoreRefsBlock(text) : null;
    if (refs) return { ...refs, children: b.children ?? [] };
    const next = { ...b };
    if (Array.isArray(b.content)) next.content = inline(b.content);
    else if (b.content?.type === 'tableContent') {
      next.content = { ...b.content, rows: b.content.rows.map((r: any) => ({ ...r, cells: r.cells.map((cell: any) => (Array.isArray(cell) ? inline(cell) : { ...cell, content: inline(cell.content) })) })) };
    }
    if (b.children?.length) next.children = restoreMath(b.children);
    return next;
  });
}

/** HTML → ブロック（SVG の図・iframe などは HTML の埋め込みにする） */
export async function htmlToBlocks(editor: { tryParseHTMLToBlocks: (html: string) => any }, html: string): Promise<any[]> {
  return restoreMath(await editor.tryParseHTMLToBlocks(protectHtmlEmbeds(html)));
}

/** Markdown → ブロック（$...$ / $$...$$ / ```math を数式にする） */
export async function markdownToBlocks(editor: { tryParseMarkdownToBlocks: (md: string) => any }, md: string): Promise<any[]> {
  return restoreMath(await editor.tryParseMarkdownToBlocks(protectMath(md)));
}

/** 入力中の「$...$」を数式に変える（$ を打った直後に呼ぶ） */
export function convertTypedMath(editor: any) {
  const view = editor.prosemirrorView;
  if (!view) return;
  const { state } = view;
  const { $from, empty } = state.selection;
  if (!empty || !state.schema.nodes.math) return;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const m = /(^|[^\\$])\$([^\s$￼](?:[^$￼]*[^\s$￼])?)\$$/.exec(before);
  if (!m) return;
  const len = m[2]!.length + 2;
  const from = $from.pos - len;
  view.dispatch(state.tr.replaceWith(from, $from.pos, state.schema.nodes.math.create({ latex: m[2] })));
}

/** 文中の $...$（直後・直前が空白なら数式ではない。閉じた $ の直後が数字なら金額とみなす） */
const INLINE_TEX = /(^|[^\\$])\$(?!\s)((?:\\\$|[^$\n￼])+?)(?<!\s)\$(?!\d)/g;
const BLOCK_TEX = /^\s*\$\$([\s\S]+?)\$\$\s*$/;

/**
 * 本文の中に文字のまま残っている「$...$」「$$...$$」を数式にする（貼り付けたとき・開いたとき）。
 * コード（コードブロック・インラインコード）の中は変えない。変えたら true。
 */
export function convertMathInDocument(editor: any): boolean {
  let changed = false;
  // 段落全体が $$...$$ なら、独立した数式のブロックにする
  const walk = (blocks: any[]) => {
    for (const b of blocks) {
      if (b.type === 'paragraph' && Array.isArray(b.content) && b.content.length && b.content.every((c: any) => c.type === 'text' && !c.styles?.code)) {
        const text = b.content.map((c: any) => c.text).join('');
        const m = BLOCK_TEX.exec(text);
        if (m && m[1]!.trim()) {
          editor.updateBlock(b, { type: 'equation', props: { latex: m[1]!.trim() }, content: undefined } as any);
          changed = true;
          continue;
        }
      }
      if (b.children?.length) walk(b.children);
    }
  };
  walk(editor.document);

  // 文中の $...$ を数式にする（後ろから置き換えて、位置がずれないようにする）
  const view = editor.prosemirrorView;
  if (!view) return changed;
  const { state } = view;
  const mathType = state.schema.nodes.math;
  const code = state.schema.marks.code;
  if (!mathType) return changed;
  const edits: { from: number; to: number; latex: string }[] = [];
  state.doc.descendants((node: any, pos: number) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code || !node.type.contentMatch.matchType(mathType)) return false;
    const text: string = node.textBetween(0, node.content.size, undefined, '￼');
    if (!text.includes('$')) return false;
    for (const m of text.matchAll(INLINE_TEX)) {
      const start = pos + 1 + m.index! + m[1]!.length;
      const end = start + m[2]!.length + 2;
      if (code && state.doc.rangeHasMark(start, end, code)) continue;
      edits.push({ from: start, to: end, latex: m[2]!.replace(/\\\$/g, '$') });
    }
    return false;
  });
  if (!edits.length) return changed;
  let tr = state.tr;
  for (const e of edits.sort((a, b) => b.from - a.from)) tr = tr.replaceWith(e.from, e.to, mathType.create({ latex: e.latex }));
  view.dispatch(tr);
  return true;
}
