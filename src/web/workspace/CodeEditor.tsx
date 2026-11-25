import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import CodeMirror, { type BasicSetupOptions, type ReactCodeMirrorRef, type ViewUpdate } from '@uiw/react-codemirror';
import { vscodeDark, vscodeLight } from '@uiw/codemirror-theme-vscode';
import { EditorView, keymap } from '@codemirror/view';
import { indentUnit } from '@codemirror/language';
import { html } from '@codemirror/lang-html';
import { cpp } from '@codemirror/lang-cpp';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { sql } from '@codemirror/lang-sql';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { java } from '@codemirror/lang-java';
import { php } from '@codemirror/lang-php';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { useEffectiveTheme } from '../theme';
import { PageIcon } from '../ui';
import { HtmlFrame } from './HtmlFrame';
import { withBaseHref } from './rawToken';
import { detectTextStyle } from './textStyle';

export type CodeEditorProps = {
  /** ファイル名またはパス */
  filename: string;
  /** コード本文 */
  value: string;
  /** コード変更時 */
  onChange?: (value: string) => void;
  /** 保存実行 (Cmd+S / 保存ボタン) */
  onSave?: () => void | Promise<unknown>;
  /** 読み取り専用かどうか */
  readOnly?: boolean;
  /** 保存ステータス */
  saveStatus?: 'saved' | 'pending' | 'saving' | 'conflict' | 'error';
  /** 選択テキスト変更時 */
  onSelectionChange?: (text: string) => void;
  /** モーダル内の閉じる関数 */
  onClose?: () => void;
  /** 追加のヘッダー要素（スライド切替、表切替など） */
  extraHeaderActions?: ReactNode;
  /** HTML の横並びプレビューで、相対パス（画像・CSS など）を読む基準の URL（GitHub のファイルのフォルダ） */
  htmlBaseHref?: string;
  /** 相対パスまたはフルパス */
  path?: string;
  /** 高さを100%にするかどうか（デフォルト true） */
  fullHeight?: boolean;
  /** GitHub のブランチ（GitHub のファイルのときだけステータスバーに表示） */
  branch?: string;
  /** 文字コード（note は、保存すると変わるときの説明） */
  encoding?: { name: string; note?: string };
};

/**
 * CodeMirror の基本の機能。@uiw/react-codemirror はこれ・extensions・onChange・onUpdate が変わるたびに
 * エディタの設定を全部作り直すので、描画のたびに新しいオブジェクトを渡さないよう外に置く
 */
const BASIC_SETUP: BasicSetupOptions = {
  lineNumbers: true,
  highlightActiveLineGutter: true,
  highlightSpecialChars: true,
  history: true,
  foldGutter: true,
  drawSelection: true,
  dropCursor: true,
  allowMultipleSelections: true,
  indentOnInput: true,
  syntaxHighlighting: true,
  bracketMatching: true,
  closeBrackets: true,
  autocompletion: true,
  rectangularSelection: true,
  crosshairCursor: true,
  highlightActiveLine: true,
  highlightSelectionMatches: true,
  closeBracketsKeymap: true,
  defaultKeymap: true,
  searchKeymap: true,
  historyKeymap: true,
  foldKeymap: true,
  completionKeymap: true,
  lintKeymap: true,
};

/** 手で切り替えたエディタのテーマ（アプリのテーマと違う色にしたときだけ入る） */
const THEME_KEY = 'vscode_editor_theme';

/** 言語ごとの設定（拡張機能・ラベル・アイコン色・バッジ） */
export function getLanguageConfig(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'html':
    case 'htm':
    case 'xhtml':
      return {
        id: 'html',
        name: 'HTML',
        ext: html(),
        iconColor: '#e44d26',
        badge: 'HTML',
        isHtml: true,
      };
    case 'c':
    case 'h':
      return {
        id: 'c',
        name: 'C',
        ext: cpp(),
        iconColor: '#5c6bc0',
        badge: 'C',
      };
    case 'cpp':
    case 'hpp':
    case 'cc':
    case 'cxx':
    case 'c++':
      return {
        id: 'cpp',
        name: 'C++',
        ext: cpp(),
        iconColor: '#3949ab',
        badge: 'C++',
      };
    case 'js':
    case 'mjs':
    case 'cjs':
      return {
        id: 'javascript',
        name: 'JavaScript',
        ext: javascript(),
        iconColor: '#f7df1e',
        badge: 'JS',
      };
    case 'jsx':
      return {
        id: 'jsx',
        name: 'JavaScript JSX',
        ext: javascript({ jsx: true }),
        iconColor: '#61dafb',
        badge: 'JSX',
      };
    case 'ts':
    case 'mts':
    case 'cts':
      return {
        id: 'typescript',
        name: 'TypeScript',
        ext: javascript({ typescript: true }),
        iconColor: '#3178c6',
        badge: 'TS',
      };
    case 'tsx':
      return {
        id: 'tsx',
        name: 'TypeScript JSX',
        ext: javascript({ jsx: true, typescript: true }),
        iconColor: '#3178c6',
        badge: 'TSX',
      };
    case 'py':
    case 'ipynb':
      return {
        id: 'python',
        name: 'Python',
        ext: python(),
        iconColor: '#3776ab',
        badge: 'PY',
      };
    case 'css':
    case 'scss':
    case 'less':
      return {
        id: 'css',
        name: 'CSS',
        ext: css(),
        iconColor: '#264de4',
        badge: 'CSS',
      };
    case 'json':
    case 'jsonc':
    case 'webmanifest':
      return {
        id: 'json',
        name: 'JSON',
        ext: json(),
        iconColor: '#cbcb41',
        badge: '{}',
      };
    case 'md':
    case 'markdown':
      return {
        id: 'markdown',
        name: 'Markdown',
        ext: markdown(),
        iconColor: '#42a5f5',
        badge: 'MD',
      };
    case 'sql':
      return {
        id: 'sql',
        name: 'SQL',
        ext: sql(),
        iconColor: '#e38c00',
        badge: 'SQL',
      };
    case 'rs':
      return {
        id: 'rust',
        name: 'Rust',
        ext: rust(),
        iconColor: '#dea584',
        badge: 'RS',
      };
    case 'go':
      return {
        id: 'go',
        name: 'Go',
        ext: go(),
        iconColor: '#00add8',
        badge: 'GO',
      };
    case 'java':
      return {
        id: 'java',
        name: 'Java',
        ext: java(),
        iconColor: '#b07219',
        badge: 'JAVA',
      };
    case 'php':
      return {
        id: 'php',
        name: 'PHP',
        ext: php(),
        iconColor: '#777bb4',
        badge: 'PHP',
      };
    case 'xml':
    case 'svg':
      return {
        id: 'xml',
        name: 'XML',
        ext: xml(),
        iconColor: '#ff6600',
        badge: 'XML',
      };
    case 'yaml':
    case 'yml':
      return {
        id: 'yaml',
        name: 'YAML',
        ext: yaml(),
        iconColor: '#cb171e',
        badge: 'YML',
      };
    default:
      return {
        id: 'plaintext',
        name: ext ? ext.toUpperCase() : 'Plain Text',
        ext: null,
        iconColor: '#8a9ba8',
        badge: ext ? ext.slice(0, 3).toUpperCase() : 'TXT',
      };
  }
}

/** 言語アイコンバッジ */
function FileLangBadge({ config }: { config: ReturnType<typeof getLanguageConfig> }) {
  return (
    <span
      className="vscode-lang-badge"
      style={{
        backgroundColor: config.iconColor,
      }}
      title={config.name}
    >
      {config.badge}
    </span>
  );
}

export function CodeEditor({
  filename,
  value,
  onChange,
  onSave,
  readOnly = false,
  saveStatus = 'saved',
  onSelectionChange,
  onClose,
  extraHeaderActions,
  htmlBaseHref,
  path = filename,
  fullHeight = true,
  branch,
  encoding = { name: 'UTF-8' },
}: CodeEditorProps) {
  const appTheme = useEffectiveTheme();
  // VSCodeテーマ：ふだんはアプリのテーマに合わせて変わる。手で切り替えたときだけ覚えておき、
  // アプリと同じ色に戻したら、またアプリのテーマに合わせる
  const [override, setOverride] = useState<'dark' | 'light' | null>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    return (saved === 'dark' || saved === 'light') && saved !== appTheme ? saved : null;
  });
  const themeMode = override ?? appTheme;

  const toggleTheme = () => {
    const next = themeMode === 'dark' ? 'light' : 'dark';
    if (next === appTheme) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
    setOverride(next === appTheme ? null : next);
  };

  // 長い行の折り返し（端末をまたいで覚えておく）
  const [wrap, setWrap] = useState(() => localStorage.getItem('vscode_editor_wrap') === '1');
  const toggleWrap = () => {
    setWrap((prev) => {
      localStorage.setItem('vscode_editor_wrap', prev ? '0' : '1');
      return !prev;
    });
  };

  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const langConfig = useMemo(() => getLanguageConfig(filename), [filename]);

  // カーソル位置・選択状態
  const [cursorPos, setCursorPos] = useState({ ln: 1, col: 1, selectedChars: 0 });

  // HTMLのリアルタイムスプリットプレビュー
  const [splitPreview, setSplitPreview] = useState(false);
  const [copied, setCopied] = useState(false);

  // インデント・改行コードはファイルを開いたときに一度だけ推し量る（入力のたびに変わらないように。
  // 読み込み前の空の状態で作られたときは、中身が入ったときに推し量り直す）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const style = useMemo(() => detectTextStyle(value), [path, value === '']);
  // CodeMirror は改行を LF にそろえるので、CRLF のファイルは渡すときに LF にし、受け取るときに CRLF に戻す
  // （そのままだと編集しただけで全部の行の改行が LF に変わってしまう）
  const editorValue = useMemo(() => (style.crlf ? value.replace(/\r\n?/g, '\n') : value), [value, style.crlf]);

  // 呼び出し元の関数は描画のたびに新しくなることが多い。そのまま CodeMirror に渡すと 1 文字打つたびに
  // エディタの設定を作り直してしまうので、最新のものを ref に入れ、CodeMirror には変わらない関数を渡す
  const latest = useRef({ onChange, onSave, onSelectionChange, crlf: style.crlf });
  latest.current = { onChange, onSave, onSelectionChange, crlf: style.crlf };

  // Cmd+S / Ctrl+S ショートカット
  const saveKeyExtension = useMemo(
    () =>
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            void latest.current.onSave?.();
            return true;
          },
        },
      ]),
    [],
  );

  const handleChange = useCallback((next: string) => {
    const { onChange: change, crlf } = latest.current;
    change?.(crlf ? next.replace(/\n/g, '\r\n') : next);
  }, []);
  const indentLabel = style.indent.tabs ? 'タブ' : `スペース: ${style.indent.size}`;

  // CodeMirror extensions
  const extensions = useMemo(() => {
    // Tab キー・改行で入るインデントを、ファイルのインデントに合わせる
    const list = [saveKeyExtension, indentUnit.of(style.indent.tabs ? '\t' : ' '.repeat(style.indent.size))];
    if (langConfig.ext) {
      list.push(langConfig.ext);
    }
    if (wrap) list.push(EditorView.lineWrapping);
    return list;
  }, [langConfig.ext, saveKeyExtension, style.indent.tabs, style.indent.size, wrap]);

  const handleUpdate = useCallback(
    (viewUpdate: ViewUpdate) => {
      if (viewUpdate.selectionSet || viewUpdate.docChanged) {
        const state = viewUpdate.state;
        const main = state.selection.main;
        const line = state.doc.lineAt(main.head);
        const ln = line.number;
        const col = main.head - line.from + 1;
        const selectedChars = Math.abs(main.to - main.from);
        setCursorPos({ ln, col, selectedChars });

        const onSel = latest.current.onSelectionChange;
        if (onSel) {
          const selText = selectedChars > 0 ? state.sliceDoc(main.from, main.to) : '';
          onSel(selText);
        }
      }
    },
    [],
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  // HTMLプレビュー用のsrcDoc
  const previewHtml = htmlBaseHref ? withBaseHref(value, htmlBaseHref) : value;

  // パンくずのパーツ
  const pathParts = useMemo(() => {
    const clean = path.replace(/^\/+/, '');
    return clean.split('/').filter(Boolean);
  }, [path]);

  // 保存ステータスラベル
  const statusLabel = {
    saved: '保存済み',
    pending: '● 未保存の変更',
    saving: '⟳ 保存中…',
    conflict: '⚠ 競合あり',
    error: '⚠ 保存エラー',
  }[saveStatus];

  const hasUnsavedChanges = saveStatus === 'pending';

  return (
    <div
      className={`vscode-container vscode-theme-${themeMode} ${fullHeight ? 'vscode-full-height' : ''}`}
      data-vscode-theme={themeMode}
    >
      {/* VSCode タブバー */}
      <div className="vscode-tabbar">
        <div className="vscode-tabs">
          <div className={`vscode-tab active ${hasUnsavedChanges ? 'is-dirty' : ''}`} title={path}>
            <FileLangBadge config={langConfig} />
            <span className="vscode-tab-title">{filename}</span>
            {hasUnsavedChanges ? (
              <span className="vscode-dirty-dot" title="未保存の変更" />
            ) : onClose ? (
              <button
                type="button"
                className="vscode-tab-close"
                onClick={onClose}
                aria-label="閉じる"
                title="閉じる"
              >
                ×
              </button>
            ) : null}
          </div>
        </div>

        {/* タブバー右側のツールボタン */}
        <div className="vscode-tabbar-actions">
          {extraHeaderActions}

          {/* HTMLの場合のスプリットLiveプレビューボタン */}
          {langConfig.isHtml && (
            <button
              type="button"
              className={`vscode-action-btn ${splitPreview ? 'is-active' : ''}`}
              onClick={() => setSplitPreview((prev) => !prev)}
              title={splitPreview ? 'プレビューを閉じる' : '横並びでプレビューを表示 (Split View)'}
            >
              <PageIcon icon="ms:vertical_split" size={15} />
              <span className="vscode-btn-label">{splitPreview ? 'コードのみ' : '横並びプレビュー'}</span>
            </button>
          )}

          {/* 折り返し */}
          <button
            type="button"
            className={`vscode-action-btn ${wrap ? 'is-active' : ''}`}
            onClick={toggleWrap}
            aria-pressed={wrap}
            title={wrap ? '長い行を折り返さない' : '長い行を折り返す'}
          >
            <PageIcon icon="ms:wrap_text" size={15} />
            <span className="vscode-btn-label">折り返し</span>
          </button>

          {/* コピーボタン */}
          <button
            type="button"
            className="vscode-action-btn"
            onClick={handleCopy}
            title={copied ? 'コピー完了' : 'コード全体をコピー'}
          >
            <PageIcon icon={copied ? 'ms:check' : 'ms:content_copy'} size={15} />
            <span className="vscode-btn-label">{copied ? '完了' : 'コピー'}</span>
          </button>

          {/* テーマ切替 (Dark / Light) */}
          <button
            type="button"
            className="vscode-action-btn"
            onClick={toggleTheme}
            title={`テーマ切替 (現在: ${themeMode === 'dark' ? 'Dark+' : 'Light+'}${override ? '' : '・アプリのテーマに合わせています'})`}
          >
            <PageIcon icon={themeMode === 'dark' ? 'ms:light_mode' : 'ms:dark_mode'} size={15} />
          </button>

          {/* 保存ボタン */}
          {!readOnly && onSave && (
            <button
              type="button"
              className={`vscode-action-btn vscode-save-btn ${hasUnsavedChanges ? 'is-dirty' : ''}`}
              onClick={() => void onSave()}
              title="保存 (Ctrl/⌘+S)"
            >
              <PageIcon icon="ms:save" size={15} />
              <span className="vscode-btn-label">保存</span>
            </button>
          )}

          {/* モーダル用クローズボタン */}
          {onClose && (
            <button
              type="button"
              className="vscode-action-btn vscode-close-modal-btn"
              onClick={onClose}
              title="エディタを閉じる"
              aria-label="閉じる"
            >
              <PageIcon icon="ms:close" size={16} />
            </button>
          )}
        </div>
      </div>

      {/* VSCode パンくずリスト */}
      <div className="vscode-breadcrumbs">
        <PageIcon icon="ms:folder_open" size={13} />
        <span className="vscode-crumb-item">workspace</span>
        {pathParts.map((part, i) => (
          <span key={i} className="vscode-crumb-group">
            <span className="vscode-crumb-separator">/</span>
            <span className={`vscode-crumb-item ${i === pathParts.length - 1 ? 'is-current' : ''}`}>
              {part}
            </span>
          </span>
        ))}
      </div>

      {/* エディタ本体領域（スプリット時は左右分割） */}
      <div className={`vscode-editor-body ${splitPreview ? 'is-split' : ''}`}>
        <div className="vscode-codemirror-wrapper">
          <CodeMirror
            ref={cmRef}
            value={editorValue}
            height="100%"
            theme={themeMode === 'dark' ? vscodeDark : vscodeLight}
            extensions={extensions}
            readOnly={readOnly}
            editable={!readOnly}
            indentWithTab={true}
            basicSetup={BASIC_SETUP}
            onChange={onChange ? handleChange : undefined}
            onUpdate={handleUpdate}
          />
        </div>

        {/* Live Preview (HTML分割プレビュー) */}
        {splitPreview && langConfig.isHtml && (
          <div className="vscode-preview-pane">
            <div className="vscode-preview-header">
              <span className="vscode-preview-title">
                <PageIcon icon="ms:visibility" size={13} /> HTML Live Preview
              </span>
            </div>
            <HtmlFrame
              srcDoc={previewHtml}
              title={`${filename} プレビュー`}
              className="vscode-preview-iframe"
              // allow-same-origin と allow-scripts を一緒にすると、中のスクリプトがこのサイトの権限で動けてしまうので付けない
              sandbox="allow-scripts allow-forms allow-popups"
            />
          </div>
        )}
      </div>

      {/* VSCode ステータスバー */}
      <div className="vscode-statusbar">
        <div className="vscode-statusbar-left">
          {branch && (
            <span className="vscode-status-item vscode-status-git" title="GitHub のブランチ">
              <PageIcon icon="ms:fork_right" size={13} />
              <span>{branch}</span>
            </span>
          )}
          <span className={`vscode-status-item vscode-status-${saveStatus}`} title={statusLabel}>
            <span>{statusLabel}</span>
          </span>
          {readOnly && (
            <span className="vscode-status-item vscode-status-readonly" title="閲覧専用モード">
              [読み取り専用]
            </span>
          )}
        </div>

        <div className="vscode-statusbar-right">
          <span className="vscode-status-item" title="カーソル位置">
            行 {cursorPos.ln}, 列 {cursorPos.col}
            {cursorPos.selectedChars > 0 ? ` (${cursorPos.selectedChars} 文字選択)` : ''}
          </span>
          <span className="vscode-status-item" title="インデント（ファイルの中身から判断）">
            {indentLabel}
          </span>
          <span className="vscode-status-item" title={encoding.note ? `文字コード（${encoding.note}）` : '文字コード'}>
            {encoding.name}
          </span>
          <span className="vscode-status-item" title="改行コード（保存するときもこのまま）">
            {style.crlf ? 'CRLF' : 'LF'}
          </span>
          <span className="vscode-status-item vscode-status-lang" title={`言語モード: ${langConfig.name}`}>
            {langConfig.name}
          </span>
        </div>
      </div>
    </div>
  );
}
export default CodeEditor;
