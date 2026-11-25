import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { ja } from '@blocknote/core/locales';
import { BlockNoteView } from '@blocknote/mantine';
import { SideMenuExtension } from '@blocknote/core/extensions';
import { CollaborationExtension } from '@blocknote/core/yjs';
import type { CollabProvider } from './collab';
import { FileViewer, isOwnFileUrl, viewerKind, type ViewerFile } from './FileViewer';
import { blocksToMarkdown, convertMathInDocument, convertTypedMath, mathSchema, renderMathInHtml } from './math';
import { TypographyExtension } from './typography';
import { convertTypedNotes, FootnoteList, updateNotes } from './notes';
import { convertTypedDue } from './due';
import { filterSuggestionItems } from '@blocknote/core/extensions';
import {
  BlockColorsItem,
  FilePanelController,
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  DragHandleMenu,
  RemoveBlockItem,
  SideMenu,
  SideMenuController,
  useBlockNoteEditor,
  useComponentsContext,
  useCreateBlockNote,
  useExtensionState,
} from '@blocknote/react';
import { TextSelection } from '@tiptap/pm/state';
import { createContext, useContext, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { uploadFile } from '../api';
import { Icon, PageIcon } from '../ui';
import { useEffectiveTheme } from '../theme';

export type LinkCandidate = { id: string; title: string; icon: string | null; href: string; subtext?: string };

export type EditorHandle = {
  focus: () => void;
  toMarkdown: () => string;
  toHTML: () => string;
  /** 印刷・PDF 用の HTML（見出しや表などの素の HTML。数式は組んだもの） */
  toReportHTML: () => string;
  /** 内容をすべて置き換える（テンプレートを使うとき） */
  replaceAll: (blocks: any[]) => void;
};

/** ブロックの種類の変更先（Notion の「ブロックタイプの変換」） */
const TURN_INTO: { label: string; type: string; props?: Record<string, unknown> }[] = [
  { label: 'テキスト', type: 'paragraph' },
  { label: '見出し1', type: 'heading', props: { level: 1, isToggleable: false } },
  { label: '見出し2', type: 'heading', props: { level: 2, isToggleable: false } },
  { label: '見出し3', type: 'heading', props: { level: 3, isToggleable: false } },
  { label: 'トグル見出し1', type: 'heading', props: { level: 1, isToggleable: true } },
  { label: 'トグル見出し2', type: 'heading', props: { level: 2, isToggleable: true } },
  { label: 'トグル見出し3', type: 'heading', props: { level: 3, isToggleable: true } },
  { label: '箇条書きリスト', type: 'bulletListItem' },
  { label: '番号付きリスト', type: 'numberedListItem' },
  { label: 'ToDo リスト', type: 'checkListItem' },
  { label: 'トグルリスト', type: 'toggleListItem' },
  { label: '引用', type: 'quote' },
  { label: 'コード', type: 'codeBlock' },
];

/** テキストを持つブロックだけ変換できる（画像・表などは除く） */
const CONVERTIBLE = new Set(TURN_INTO.map((t) => t.type));

function TurnIntoItems() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (s) => s?.block });
  if (!block || !CONVERTIBLE.has(block.type)) return null;
  const props = block.props as Record<string, unknown>;
  const isCurrent = (t: (typeof TURN_INTO)[number]) =>
    t.type === block.type && (t.type !== 'heading' || (props.level === t.props!.level && !!props.isToggleable === t.props!.isToggleable));
  return (
    <>
      <Components.Generic.Menu.Label>種類を変更</Components.Generic.Menu.Label>
      {TURN_INTO.map((t) => (
        <Components.Generic.Menu.Item
          key={t.label}
          className="bn-menu-item"
          checked={isCurrent(t)}
          onClick={() => {
            // 選択中のブロックがあればまとめて変換する
            const selected = editor.getSelection()?.blocks;
            const targets = selected && selected.some((b) => b.id === block.id) ? selected : [block];
            for (const b of targets) if (CONVERTIBLE.has(b.type)) editor.updateBlock(b, { type: t.type as any, props: (t.props ?? {}) as any });
          }}
        >
          {t.label}
        </Components.Generic.Menu.Item>
      ))}
      <Components.Generic.Menu.Divider />
    </>
  );
}

/** ファイルを開く（ブロックのメニューから使う） */
const OpenFileCtx = createContext<((url: string, name: string) => void) | null>(null);

/** 画像・ファイルのブロックのメニュー：アプリ内で開く（編集できるものは編集も） */
function OpenFileItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (s) => s?.block });
  const open = useContext(OpenFileCtx);
  const props = block?.props as { url?: string; name?: string } | undefined;
  const url = props?.url ?? '';
  const name = props?.name || decodeURIComponent(url.split('/').pop() ?? '');
  if (!open || !url || !isOwnFileUrl(url) || !viewerKind(name)) return null;
  return (
    <>
      <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => open(url, name)}>
        開く・編集
      </Components.Generic.Menu.Item>
      <Components.Generic.Menu.Divider />
    </>
  );
}

/** 字下げ（入れ子にする・戻す）。Tab・Shift+Tab と同じ */
function IndentItems() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (s) => s?.block });
  if (!block) return null;
  const run = (nest: boolean) => {
    editor.setTextCursorPosition(block, 'end');
    if (nest ? editor.canNestBlock() : editor.canUnnestBlock()) {
      if (nest) editor.nestBlock();
      else editor.unnestBlock();
    }
    editor.focus();
  };
  // 前に同じ段のブロックがあれば字下げでき、親があれば戻せる
  const canNest = !!editor.getPrevBlock(block);
  const canUnnest = !!editor.getParentBlock(block);
  return (
    <>
      <Components.Generic.Menu.Item className="bn-menu-item" disabled={!canNest} onClick={() => run(true)}>
        字下げ（Tab・⌘+]）
      </Components.Generic.Menu.Item>
      <Components.Generic.Menu.Item className="bn-menu-item" disabled={!canUnnest} onClick={() => run(false)}>
        字下げを戻す（Shift+Tab・⌘+[）
      </Components.Generic.Menu.Item>
      <Components.Generic.Menu.Divider />
    </>
  );
}

function BlockMenu() {
  return (
    <DragHandleMenu>
      <OpenFileItem />
      <TurnIntoItems />
      <IndentItems />
      <BlockColorsItem>色</BlockColorsItem>
      <RemoveBlockItem>削除</RemoveBlockItem>
    </DragHandleMenu>
  );
}

/** 表のセルの中か（本文の表ブロック） */
function tableCellOf(editor: any) {
  const view = editor.prosemirrorView;
  if (!view) return null;
  const node = view.domAtPos(view.state.selection.from).node as Node;
  const el = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest('td, th');
  if (!el || !view.dom.contains(el)) return null;
  const tr = el.closest('tr')!;
  const table = el.closest('table')!;
  const blockId = el.closest('.bn-block-outer[data-id]')?.getAttribute('data-id');
  if (!blockId) return null;
  return { blockId, row: Array.from(table.querySelectorAll('tr')).indexOf(tr), col: Array.from(tr.children).indexOf(el) };
}

/** 表：今の行の下に行を足し、同じ列のセルにカーソルを移す */
function addTableRowBelow(editor: any, at: { blockId: string; row: number; col: number }) {
  const block = editor.getBlock(at.blockId);
  const content = block?.content;
  if (!content || content.type !== 'tableContent') return;
  const rows = content.rows as { cells: any[] }[];
  const base = rows[at.row] ?? rows[rows.length - 1];
  const emptyCell = (c: any) => ({ type: 'tableCell', props: { ...(c?.props ?? {}), colspan: 1, rowspan: 1 }, content: [] });
  const newRow = { cells: base.cells.map(emptyCell) };
  editor.updateBlock(block, { content: { ...content, rows: [...rows.slice(0, at.row + 1), newRow, ...rows.slice(at.row + 1)] } });
  // 足した行のセルへ移る
  requestAnimationFrame(() => {
    const view = editor.prosemirrorView;
    const cell = view?.dom.querySelector(`.bn-block-outer[data-id="${CSS.escape(at.blockId)}"] table`)?.querySelectorAll('tr')[at.row + 1]?.children[at.col] as Element | undefined;
    const target = cell?.querySelector('p') ?? cell;
    if (!view || !target) return;
    try {
      const pos = view.posAtDOM(target, 0);
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))).scrollIntoView());
      view.focus();
    } catch {
      /* 移れなくても、行は足してある */
    }
  });
}

/** 選択中の本文の文字列（数式・画像などは除く。ブロックの区切りは改行） */
function selectedText(editor: any): string {
  const view = editor.prosemirrorView;
  if (!view) return '';
  const { doc } = view.state;
  const text = (from: number, to: number) => (to > from ? doc.textBetween(from, to, '\n', () => '') : '');
  try {
    // 編集中はエディターの選択範囲（ブロックの選択なども含む）
    const sel = view.state.selection;
    if (view.editable && view.hasFocus()) return sel.empty ? '' : text(sel.from, sel.to);
    // 閲覧のみ：画面上の選択のうち、本文に重なる部分
    const dom = window.getSelection();
    if (!dom || dom.isCollapsed || !dom.rangeCount) return '';
    const range = dom.getRangeAt(0);
    if (!range.intersectsNode(view.dom)) return '';
    const from = view.dom.contains(range.startContainer) ? view.posAtDOM(range.startContainer, range.startOffset) : 0;
    const to = view.dom.contains(range.endContainer) ? view.posAtDOM(range.endContainer, range.endOffset) : doc.content.size;
    return text(Math.max(0, from), Math.min(doc.content.size, to));
  } catch {
    return '';
  }
}

export default function Editor({
  initialContent,
  editable,
  onChange,
  handleRef,
  resolveFileUrl,
  collab,
  onDocument,
  linkCandidates,
  onLinkClick,
  onFileToPage,
  onSelectionText,
}: {
  /** 選択中の文字列が変わったら呼ぶ（選択していないときは空文字。閲覧のみのページでも呼ぶ） */
  onSelectionText?: (text: string) => void;
  /** ファイルの中身から新しいページを作る（ファイルを開いた画面の「ページにする」） */
  onFileToPage?: (file: File) => Promise<void>;
  /** 内容が変わるたびに呼ぶ（保存とは別。目次などの表示用。相手の変更でも呼ぶ） */
  onDocument?: (blocks: any[]) => void;
  /** 「[[」で出すリンク先の候補（ページ） */
  linkCandidates?: (query: string) => LinkCandidate[];
  /** 本文のリンクをクリックしたとき。アプリ内で開いたら true を返す */
  onLinkClick?: (href: string) => boolean;
  initialContent: any[];
  editable: boolean;
  onChange?: (blocks: any[]) => void;
  handleRef?: MutableRefObject<EditorHandle | null>;
  /** 画像などの URL を書き換える（公開ページでは公開用 URL にする） */
  resolveFileUrl?: (url: string) => string;
  /** リアルタイム共同編集。seed=true のときは部屋が空なので initialContent で初期化する */
  collab?: { provider: CollabProvider; user: { name: string; color: string; canEdit: boolean }; seed: boolean };
}) {
  const theme = useEffectiveTheme();
  const editor = useCreateBlockNote({
    schema: mathSchema,
    // Tab・Shift+Tab は、ツールバーが出ているときでも字下げにする
    tabBehavior: 'prefer-indent',
    initialContent: collab ? undefined : Array.isArray(initialContent) && initialContent.length > 0 ? initialContent : undefined,
    extensions: [
      // 「->」→「→」などの記号の自動変換
      TypographyExtension(),
      ...(collab
        ? [
            CollaborationExtension({
              fragment: collab.provider.doc.getXmlFragment('document-store'),
              user: collab.user,
              provider: collab.provider,
              showCursorLabels: 'activity',
            }),
          ]
        : []),
    ],
    dictionary: ja,
    uploadFile: (file) => uploadFile(file),
    resolveFileUrl: resolveFileUrl ? async (url) => resolveFileUrl(url) : undefined,
  });

  // 共同編集では、初期の内容が入るまでの変更（空の文書など）は保存しない
  const ready = useRef(!collab);
  // 空の部屋に最初に入った人が、保存済みの内容を共同編集の文書に入れる
  useEffect(() => {
    const seeding =
      collab?.seed && Array.isArray(initialContent) && initialContent.length > 0 && collab.provider.doc.getXmlFragment('document-store').length <= 1;
    if (seeding) editor.replaceBlocks(editor.document, initialContent);
    // 初期化による変更通知が終わってから受け付ける
    const t = setTimeout(() => (ready.current = true), 0);
    return () => clearTimeout(t);
  }, [editor]);

  const onDocumentRef = useRef(onDocument);
  onDocumentRef.current = onDocument;
  useEffect(() => {
    // 脚注の番号・引用の表示は、文書が変わるたびに更新する
    updateNotes(editor, editor.document as any[], true);
    const emit = () => {
      updateNotes(editor, editor.document as any[]);
      onDocumentRef.current?.(editor.document as any[]);
    };
    const t = setTimeout(emit, 0);
    const off = editor.onChange(emit);
    return () => {
      clearTimeout(t);
      off?.();
    };
  }, [editor]);

  // 選択範囲の文字列（文字数の表示用）。閲覧のみのときはエディターが選択範囲を持たないので、画面の選択から求める
  const onSelectionTextRef = useRef(onSelectionText);
  onSelectionTextRef.current = onSelectionText;
  useEffect(() => {
    let raf = 0;
    let last = '';
    const update = () => {
      raf = 0;
      const text = selectedText(editor);
      if (text === last) return;
      last = text;
      onSelectionTextRef.current?.(text);
    };
    const schedule = () => {
      if (onSelectionTextRef.current && !raf) raf = requestAnimationFrame(update);
    };
    document.addEventListener('selectionchange', schedule);
    const off = editor.onSelectionChange(schedule);
    return () => {
      document.removeEventListener('selectionchange', schedule);
      off?.();
      cancelAnimationFrame(raf);
    };
  }, [editor]);

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      focus: () => editor.focus(),
      toMarkdown: () => blocksToMarkdown(editor, editor.document),
      toHTML: () => editor.blocksToFullHTML(editor.document),
      toReportHTML: () => renderMathInHtml(editor.blocksToHTMLLossy(editor.document)),
      replaceAll: (blocks: any[]) => editor.replaceBlocks(editor.document, blocks),
    };
  }, [editor, handleRef]);

  // ファイルのブロックの名前をクリックしたら、PDF やテキストなどはアプリ内で開く
  // 文字のまま残っている「$...$」「$$...$$」を数式にする（開いたとき。共同編集では内容が届くのを待ってからもう一度）。
  // 閲覧のみの共同編集では、変えた内容がほかの人に送られないよう変えない
  useEffect(() => {
    if (!editable && collab) return;
    const run = () => {
      try {
        convertMathInDocument(editor);
      } catch {
        // 変換できなくても表示には影響させない
      }
    };
    const timers = [setTimeout(run, 400), setTimeout(run, 2500)];
    return () => timers.forEach(clearTimeout);
  }, [editor, editable, collab]);

  // アドレスの「#block-<ID>」のブロックへ移動する（タスクの画面から開いたとき）
  useEffect(() => {
    const m = /^#block-([\w-]+)$/.exec(window.location.hash);
    if (!m) return;
    let tries = 0;
    const timer = setInterval(() => {
      const el = editor.domElement?.querySelector(`[data-id="${CSS.escape(m[1]!)}"]`) as HTMLElement | null;
      if (el || ++tries > 20) clearInterval(timer);
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.classList.add('block-flash');
      setTimeout(() => el.classList.remove('block-flash'), 2000);
    }, 200);
    return () => clearInterval(timer);
  }, [editor]);

  const [viewer, setViewer] = useState<ViewerFile | null>(null);
  /** ファイルを開く。ページを編集できるなら、編集して保存した内容でページの中の参照を差し替える */
  const openViewer = (url: string, name: string) => {
    const own = url.startsWith('/api/files/');
    setViewer({
      url: resolveFileUrl ? resolveFileUrl(url) : url,
      name,
      onReplace: editable && own ? (next, nextName) => replaceFile(url, next, nextName) : undefined,
      toPage: onFileToPage,
    });
  };
  const replaceFile = (oldUrl: string, newUrl: string, newName: string) => {
    const walk = (blocks: any[]) => {
      for (const b of blocks) {
        if (b.props?.url === oldUrl) editor.updateBlock(b, { props: { url: newUrl, ...('name' in b.props ? { name: newName } : {}) } } as any);
        if (b.children?.length) walk(b.children);
      }
    };
    walk(editor.document as any[]);
    // 開いている画面はそのまま（編集を続けられるように）、次の保存先だけ新しいファイルにする
    setViewer((v) =>
      v && {
        ...v,
        url: resolveFileUrl ? resolveFileUrl(newUrl) : newUrl,
        name: newName,
        onReplace: (next, nextName) => replaceFile(newUrl, next, nextName),
      },
    );
  };
  const openFile = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // 本文のリンク：アプリ内のページへのリンクなら、そのページを開く
    const a = target.closest('.bn-editor a[href]') as HTMLAnchorElement | null;
    if (a && onLinkClick && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      if (onLinkClick(a.getAttribute('href') ?? '')) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (!target.closest('.bn-file-name-with-icon')) return;
    const id = target.closest('[data-id]')?.getAttribute('data-id');
    const block = id ? editor.getBlock(id) : undefined;
    const props = block?.props as { url?: string; name?: string } | undefined;
    const url = props?.url ?? '';
    const name = props?.name || decodeURIComponent(url.split('/').pop() ?? '');
    if (!url || !isOwnFileUrl(url) || !viewerKind(name)) return;
    e.preventDefault();
    e.stopPropagation();
    openViewer(url, name);
  };

  return (
    <OpenFileCtx.Provider value={openViewer}>
    <div
      className="editor-click-layer"
      onClickCapture={openFile}
      onKeyDownCapture={(e) => {
        // ⌘+]・⌘+[（Ctrl+]・Ctrl+[）：今のブロックを字下げ・戻す（表のセルの中では Tab がセルの移動なので、こちらを使う）
        if (editable && (e.metaKey || e.ctrlKey) && !e.altKey && (e.key === ']' || e.key === '[')) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === ']' ? editor.canNestBlock() : editor.canUnnestBlock()) {
            if (e.key === ']') editor.nestBlock();
            else editor.unnestBlock();
          }
          return;
        }
        // 表のセルの中：Enter はセルの中で改行、⌘+Enter（Ctrl+Enter）は下に行を足す
        if (!editable || e.key !== 'Enter' || e.nativeEvent.isComposing || e.altKey) return;
        const cell = tableCellOf(editor);
        if (!cell) return;
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          e.stopPropagation();
          addTableRowBelow(editor, cell);
        } else if (!e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          const view = (editor as any).prosemirrorView;
          const br = view?.state.schema.nodes.hardBreak;
          if (view && br) view.dispatch(view.state.tr.replaceSelectionWith(br.create()).scrollIntoView());
        }
      }}
      onPasteCapture={(e) => {
        const text = e.clipboardData.getData('text/plain').trim();
        // 貼り付けた文章の中の「$...$」も数式にする
        if (editable && text.includes('$')) setTimeout(() => convertMathInDocument(editor), 0);
        // 画像 URL を単独で貼り付けた場合、画像ブロックにする
        if (editable && /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg|avif|bmp)(?:\?\S*)?$/i.test(text)) {
          const cur = editor.getTextCursorPosition()?.block;
          const empty = cur && Array.isArray(cur.content) && cur.content.length === 0;
          if (cur && empty) {
            e.preventDefault();
            editor.updateBlock(cur, { type: 'image', props: { url: text } } as any);
          }
        }
      }}
    >
      <BlockNoteView
        editor={editor}
        editable={editable}
        theme={theme}
        sideMenu={false}
        slashMenu={false}
        onChange={onChange ? () => ready.current && onChange(editor.document as any[]) : undefined}
        onKeyUp={(e: React.KeyboardEvent) => {
          // 「$...$」と打ち終えたら数式にする
          if (e.key === '$' && editable) convertTypedMath(editor);
          // 「[^脚注の文]」「[@キー]」と打ち終えたら脚注・引用にする
          if (e.key === ']' && editable) convertTypedNotes(editor);
          // 「@2026/11/20 」と打ったら期限にする
          if (e.key === ' ' && editable) convertTypedDue(editor);
        }}
      >
        {editable && <SideMenuController sideMenu={(props) => <SideMenu {...props} dragHandleMenu={BlockMenu} />} />}
        {editable && <FilePanelController />}
        {editable && linkCandidates && (
          <SuggestionMenuController
            triggerCharacter="[["
            getItems={async (query) =>
              linkCandidates(query)
                .slice(0, 30)
                .map((c) => ({
                  title: c.title,
                  subtext: c.subtext,
                  icon: <PageIcon icon={c.icon} size={18} />,
                  onItemClick: () => editor.insertInlineContent([{ type: 'link', href: c.href, content: c.title } as any, ' ']),
                }))
            }
          />
        )}
        {editable && (
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={async (query) =>
              filterSuggestionItems(
                [
                  ...getDefaultReactSlashMenuItems(editor),
                  {
                    title: '数式',
                    subtext: 'LaTeX の数式を独立した行に表示（$$...$$）',
                    aliases: ['math', 'latex', 'equation', 'sushiki', 'すうしき', 'tex'],
                    group: '基本ブロック',
                    icon: <Icon name="functions" size={18} />,
                    onItemClick: () => {
                      const cur = editor.getTextCursorPosition().block;
                      const empty = Array.isArray(cur.content) && cur.content.length === 0;
                      if (empty) editor.updateBlock(cur, { type: 'equation', props: { latex: '' } } as any);
                      else editor.insertBlocks([{ type: 'equation', props: { latex: '' } } as any], cur, 'after');
                    },
                  },
                  {
                    title: 'HTML の埋め込み',
                    subtext: 'SVG の図や <iframe> の埋め込みなど、HTML をそのまま表示する（スクリプトは動きません）',
                    aliases: ['html', 'svg', 'embed', 'iframe', 'umekomi', 'うめこみ', '埋め込み', '図', 'figure'],
                    group: 'メディア',
                    icon: <PageIcon icon="ms:code" size={18} />,
                    onItemClick: () => {
                      const cur = editor.getTextCursorPosition().block;
                      const empty = Array.isArray(cur.content) && cur.content.length === 0;
                      if (empty) editor.updateBlock(cur, { type: 'html', props: { html: '' } } as any);
                      else editor.insertBlocks([{ type: 'html', props: { html: '' } } as any], cur, 'after');
                    },
                  },
                  {
                    title: 'ウェブ画像',
                    subtext: 'URL を指定してウェブ上の画像を直接挿入',
                    aliases: ['webimage', 'imageurl', 'img', 'url', 'gazou', 'がぞう', '画像', 'ウェブ'],
                    group: 'メディア',
                    icon: <Icon name="image" size={18} />,
                    onItemClick: () => {
                      const cur = editor.getTextCursorPosition().block;
                      const empty = Array.isArray(cur.content) && cur.content.length === 0;
                      const url = window.prompt('画像のURLを入力してください（https://...）');
                      if (url && url.trim()) {
                        const block = { type: 'image', props: { url: url.trim() } } as any;
                        if (empty) editor.updateBlock(cur, block);
                        else editor.insertBlocks([block], cur, 'after');
                      }
                    },
                  },
                  ...(linkCandidates
                    ? [
                        {
                          title: 'ページへのリンク',
                          subtext: 'ほかのページを選んで、そのページへのリンクを入れる（[[ と打っても出せます）',
                          aliases: ['link', 'page', 'mention', 'pagelink', 'rinku', 'りんく', 'リンク', 'ぺーじ', 'ページ', '[['],
                          group: '基本ブロック',
                          icon: <Icon name="link" size={18} />,
                          // 「/」のメニューが閉じてから、ページの候補（[[ のメニュー）を開く
                          onItemClick: () =>
                            setTimeout(() => {
                              const menu = (editor as any).getExtension?.('suggestionMenu') as { openSuggestionMenu?: (t: string, o?: { deleteTriggerCharacter?: boolean; ignoreQueryLength?: boolean }) => void } | undefined;
                              if (menu?.openSuggestionMenu) menu.openSuggestionMenu('[[', { deleteTriggerCharacter: true, ignoreQueryLength: true });
                              else editor.insertInlineContent('[[');
                            }, 0),
                        },
                      ]
                    : []),
                  {
                    title: '期限',
                    subtext: 'ToDo に期限の日付を付ける（@2026/11/20）。「タスク」の画面に並びます',
                    aliases: ['due', 'date', 'deadline', 'kigen', 'きげん', '日付', 'しめきり', '締め切り'],
                    group: '基本ブロック',
                    icon: <Icon name="calendar" size={18} />,
                    onItemClick: () => editor.insertInlineContent([{ type: 'due', props: { date: '' } } as any, ' ']),
                  },
                  {
                    title: '脚注',
                    subtext: '文に番号を付けて、補足や出典をページの最後に書く（[^文]）',
                    aliases: ['footnote', 'note', 'kyakuchu', 'きゃくちゅう', '注'],
                    group: 'レポート',
                    icon: <Icon name="footnote" size={18} />,
                    onItemClick: () => editor.insertInlineContent([{ type: 'footnote', props: { text: '' } } as any]),
                  },
                  {
                    title: '文献の引用',
                    subtext: '参考文献の文献を「著者 (年)」で引用する（[@キー]）',
                    aliases: ['cite', 'citation', 'inyou', 'いんよう', '引用'],
                    group: 'レポート',
                    icon: <Icon name="cite" size={18} />,
                    onItemClick: () => editor.insertInlineContent([{ type: 'cite', props: { key: '', locator: '' } } as any, ' ']),
                  },
                  {
                    title: '参考文献',
                    subtext: 'BibTeX や文献の一覧を貼ると、レポートの体裁に整える',
                    aliases: ['references', 'bibliography', 'bibtex', 'sankoubunken', 'さんこうぶんけん', '文献'],
                    group: 'レポート',
                    icon: <Icon name="references" size={18} />,
                    onItemClick: () => {
                      const cur = editor.getTextCursorPosition().block;
                      const empty = Array.isArray(cur.content) && cur.content.length === 0;
                      if (empty) editor.updateBlock(cur, { type: 'references', props: { source: '' } } as any);
                      else editor.insertBlocks([{ type: 'references', props: { source: '' } } as any], cur, 'after');
                    },
                  },
                  {
                    title: '数式（文中）',
                    subtext: '文の中に LaTeX の数式を入れる（$...$）',
                    aliases: ['inline math', 'latex', 'sushiki', 'すうしき', 'tex'],
                    group: '基本ブロック',
                    icon: <Icon name="functions" size={18} />,
                    onItemClick: () => editor.insertInlineContent([{ type: 'math', props: { latex: '' } } as any, ' ']),
                  },
                ],
                query,
              )
            }
          />
        )}
      </BlockNoteView>
      <FootnoteList editor={editor} />
      {viewer && <FileViewer file={viewer} onClose={() => setViewer(null)} />}
    </div>
    </OpenFileCtx.Provider>
  );
}
