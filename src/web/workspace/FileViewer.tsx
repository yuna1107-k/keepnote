/**
 * ファイルをアプリ内で開く画面。PDF・画像・動画・音声はそのまま表示し、テキストは中身を表示する。
 * - ページに貼ったファイルは、ページを編集できる人なら編集できる（テキスト・CSV・Excel・画像）。
 *   保存すると新しいファイルとしてアップロードし、ページの中の参照を差し替える（前の版はページの履歴に残る）
 * - GitHub 連携のファイルは、フォルダを編集できる人なら編集して GitHub にコミットできる
 */
import { lazy, Suspense, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError, uploadFile } from '../api';
import { Button, Icon, PageIcon, Spinner, useUi } from '../ui';
import { flushWhenIdle, selfSaved, type Flush } from './selfSaved';
import { HtmlFrame } from './HtmlFrame';
import { urlDir, useTokenizedRawUrl, withBaseHref } from './rawToken';

// PDF の表示（pdf.js）は大きいので、開くときだけ読み込む
const PdfReader = lazy(() => import('./PdfReader'));
// 表（Excel など）と Word 文書の表示も、開くときだけ読み込む
const OfficeView = lazy(() => import('./OfficeView'));
const ImageEditor = lazy(() => import('./ImageEditor'));
const DocxEditor = lazy(() => import('./DocxEditor'));
const SlidesView = lazy(() => import('./SlidesView'));
const MdSlidesView = lazy(() => import('./MdSlidesView'));
const CodeEditor = lazy(() => import('./CodeEditor'));

/** 編集できる画像（アニメーションやベクター画像は除く） */
const EDITABLE_IMAGE = /\.(png|jpe?g|webp|bmp)$/i;
/** その場で編集できる表 */
const EDITABLE_SHEET = /\.(xlsx|xlsm|ods|csv|tsv)$/i;
/** ページに変換できるファイル */
const TO_PAGE = /\.(md|markdown|html?|txt|docx|pptx|csv|tsv|xlsx|xlsm|ods|ipynb)$/i;

const TEXT_EXT = /\.(txt|text|md|markdown|log|csv|tsv|json|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|ipynb|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|r|m|jl|sql|sh|bash|zsh|ps1|bat|tex|bib|sty|cls|rst|org|adoc|env|gitignore|dockerfile|makefile|lua|pl|scala|hs|ml|vue|svelte)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba)$/i;
const SHEET_FILE = /\.(xlsx|xlsm|ods)$/i;
const DOC_FILE = /\.docx$/i;
const SLIDES_FILE = /\.pptx$/i;
/** スライドとしても見られる Markdown */
const SLIDES_MD = /\.(md|markdown)$/i;
/** 表としても見られるテキスト */
const TABLE_TEXT = /\.(csv|tsv)$/i;
/** プレビュー表示できる HTML */
const HTML_FILE = /\.(html?|xhtml)$/i;

type Kind = 'pdf' | 'text' | 'image' | 'video' | 'audio' | 'sheet' | 'doc' | 'slides';

export function viewerKind(name: string): Kind | null {
  if (/\.pdf$/i.test(name)) return 'pdf';
  if (TEXT_EXT.test(name)) return 'text';
  if (IMAGE_EXT.test(name)) return 'image';
  if (VIDEO_EXT.test(name)) return 'video';
  if (AUDIO_EXT.test(name)) return 'audio';
  if (SHEET_FILE.test(name)) return 'sheet';
  if (DOC_FILE.test(name)) return 'doc';
  if (SLIDES_FILE.test(name)) return 'slides';
  return null;
}

/** アプリ内のファイルの URL か（外部のファイルはそのまま開く） */
export function isOwnFileUrl(url: string) {
  return /^\/api\/(files\/[0-9a-f-]{36}|github\/raw\/[^/]+\/.+)$/.test(url);
}

/** GitHub のファイルなら、編集用 API のパス（/github/file/...） */
function githubFilePath(url: string) {
  const m = /^\/api\/github\/raw\/(.+)$/.exec(url);
  return m ? `/github/file/${m[1]}` : null;
}

export type ViewerFile = {
  url: string;
  name: string;
  /** 編集した内容を新しいファイルとして保存したあと、ページの中の参照を差し替える（ページを編集できるときだけ） */
  onReplace?: (url: string, name: string) => void;
  /** ファイルの中身から新しいページを作る */
  toPage?: (file: File) => Promise<void>;
};

/** テキストのファイルの種類（保存するときに付ける） */
function textType(name: string) {
  if (/\.csv$/i.test(name)) return 'text/csv';
  if (/\.tsv$/i.test(name)) return 'text/tab-separated-values';
  if (/\.(md|markdown)$/i.test(name)) return 'text/markdown';
  if (/\.json$/i.test(name)) return 'application/json';
  return 'text/plain';
}

/** 編集した内容を新しいファイルとしてアップロードし、ページの中の参照を差し替える */
async function saveAsNewFile(file: ViewerFile, blob: Blob, name = file.name) {
  const url = await uploadFile(new File([blob], name, { type: blob.type || 'application/octet-stream' }));
  selfSaved.add(url);
  file.onReplace?.(url, name);
}

/** GitHub のファイル（画像・Excel など）をそのままコミットする */
async function putGithubBinary(rawUrl: string, blob: Blob) {
  const m = /^\/api\/github\/raw\/(.+)$/.exec(rawUrl.split('?')[0]);
  if (!m) throw new Error('保存先が分かりません');
  const res = await fetch(`/api/github/bin/${m[1]}`, { method: 'PUT', body: blob, credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data?.error ?? '保存できませんでした', res.status, data);
  return data as { sha: string };
}

type TextEncoding = 'UTF-8' | 'UTF-8 (BOM)' | 'Shift_JIS';

/**
 * テキストの文字コードを推し量って読む（UTF-8 で読めなければ Shift_JIS として読む。古い CSV など）。
 * bom は「保存するときに BOM を付けるか」（BOM 付きだった・Shift_JIS だった CSV は、Excel で文字化けしないよう BOM 付き UTF-8 にする）
 */
function decodeText(buf: ArrayBuffer): { text: string; bom: boolean; encoding: TextEncoding } {
  try {
    // ignoreBOM: BOM を残して読み、付いていたかを確かめる
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
    const bom = text.startsWith('\uFEFF');
    return { text: bom ? text.slice(1) : text, bom, encoding: bom ? 'UTF-8 (BOM)' : 'UTF-8' };
  } catch {
    try {
      return { text: new TextDecoder('shift_jis').decode(buf), bom: true, encoding: 'Shift_JIS' };
    } catch {
      return { text: new TextDecoder().decode(buf), bom: false, encoding: 'UTF-8' };
    }
  }
}

/** コードエディタのステータスバーに出す文字コード（保存すると変わるときはその説明も） */
function encodingInfo(encoding: TextEncoding, bomOnSave: boolean) {
  if (encoding === 'Shift_JIS') return { name: 'Shift_JIS', note: bomOnSave ? '保存すると BOM 付きの UTF-8 になります' : '保存すると UTF-8 になります' };
  return { name: encoding };
}

/** 閉じてよいかを確かめる関数（保存していない編集があるときに確認する） */
type CloseGuard = MutableRefObject<(() => Promise<boolean>) | null>;

export function FileViewer({ file, onClose }: { file: ViewerFile; onClose: () => void }) {
  const kind = viewerKind(file.name);
  const { confirm } = useUi();
  const guard: CloseGuard = useRef(null);
  const closing = useRef(false);
  // 表・画像は、閉じるときに未保存の変更を保存する（保存できなければ確認する）
  const flush = useRef<Flush | null>(null);
  if (kind !== 'text')
    guard.current = async () =>
      !flush.current ||
      (await flush.current()) ||
      confirm({ title: '保存できませんでした', message: '閉じると、保存していない変更は失われます。', confirmLabel: '閉じる', danger: true });
  const editable = !!file.onReplace;
  // 最新の file（保存するたびに URL が変わる）を使って保存する
  const fileRef = useRef(file);
  fileRef.current = file;
  const saveNew = (blob: Blob, name?: string) => saveAsNewFile(fileRef.current, blob, name);
  const requestClose = async () => {
    if (closing.current) return;
    closing.current = true;
    try {
      if (guard.current && !(await guard.current())) return;
      onClose();
    } finally {
      closing.current = false;
    }
  };
  const requestRef = useRef(requestClose);
  requestRef.current = requestClose;
  useEffect(() => {
    // 本文の編集画面が Escape を受け取って止めてしまうので、先に受け取る
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      // 表のセルを編集中なら、Escape は編集の取り消しに使う
      const t = e.target as HTMLElement | null;
      if (t?.classList?.contains('sheet-input') || t?.classList?.contains('slide-input')) return;
      // 閉じる処理の途中（保存待ち・確認の画面）は、確認の画面に Escape を渡す
      if (closing.current) return;
      e.stopPropagation();
      void requestRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && void requestClose()}>
      <div className="file-viewer" role="dialog" aria-modal="true" aria-label={file.name}>
        {kind === 'text' ? (
          <TextFile file={file} onClose={() => void requestClose()} guard={guard} />
        ) : (
          <>
            <ViewerHeader file={file} onClose={() => void requestClose()} />
            <div
              className={`file-viewer-body ${editable && ((kind === 'image' && EDITABLE_IMAGE.test(file.name)) || (kind === 'sheet' && EDITABLE_SHEET.test(file.name)) || kind === 'doc' || kind === 'slides') ? 'is-editing' : ''}`}
            >
              {kind === 'pdf' && (
                <Suspense fallback={<Spinner />}>
                  <PdfReader url={file.url} name={file.name} />
                </Suspense>
              )}
              {kind === 'image' &&
                (editable && EDITABLE_IMAGE.test(file.name) ? (
                  <Suspense fallback={<Spinner />}>
                    <ImageEditor url={file.url} name={file.name} onSave={(blob, name) => saveNew(blob, name)} flushRef={flush} />
                  </Suspense>
                ) : (
                  <img className="file-viewer-media" src={file.url} alt={file.name} />
                ))}
              {kind === 'video' && <video className="file-viewer-media" src={file.url} controls />}
              {kind === 'audio' && <audio src={file.url} controls />}
              {kind === 'slides' && (
                <Suspense fallback={<Spinner />}>
                  <SlidesView url={file.url} onSave={editable ? (blob) => saveNew(blob) : undefined} flushRef={flush} />
                </Suspense>
              )}
              {kind === 'doc' && editable && (
                <Suspense fallback={<Spinner />}>
                  <DocxEditor url={file.url} onSave={(blob) => saveNew(blob)} flushRef={flush} />
                </Suspense>
              )}
              {(kind === 'sheet' || (kind === 'doc' && !editable)) && (
                <Suspense fallback={<Spinner />}>
                  <OfficeView url={file.url} name={file.name} onSave={editable ? ({ blob }) => saveNew(blob) : undefined} flushRef={flush} />
                </Suspense>
              )}
              {!kind && <p className="muted">このファイルはアプリ内で表示できません。ダウンロードして開いてください。</p>}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function ViewerHeader({ file, onClose, children }: { file: ViewerFile; onClose: () => void; children?: React.ReactNode }) {
  return (
    <div className="file-viewer-head">
      <span className="file-viewer-name ellipsis" title={file.name}>
        {file.name}
      </span>
      {children}
      {file.toPage && TO_PAGE.test(file.name) && <ToPageButton file={file} />}
      <a className="icon-btn" href={file.url} target="_blank" rel="noopener" title="新しいタブで開く" aria-label="新しいタブで開く">
        <Icon name="external" />
      </a>
      <a className="icon-btn" href={file.url} download={file.name} title="ダウンロード" aria-label="ダウンロード">
        <Icon name="download" />
      </a>
      <button className="icon-btn" onClick={onClose} aria-label="閉じる">
        <Icon name="x" />
      </button>
    </div>
  );
}

/** ファイルの中身から新しいページを作るボタン（Word などをページとして編集したいとき） */
function ToPageButton({ file }: { file: ViewerFile }) {
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy}
      title="このファイルの中身から新しいページを作ります（元のファイルはそのまま残ります）"
      onClick={async () => {
        setBusy(true);
        try {
          const res = await fetch(file.url, { credentials: 'same-origin' });
          if (!res.ok) throw new Error(`ファイルを開けませんでした（${res.status}）`);
          const blob = await res.blob();
          await file.toPage!(new File([blob], file.name, { type: blob.type }));
        } catch (e) {
          toast((e as Error).message || 'ページにできませんでした', 'error');
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="noteAdd" size={15} /> {busy ? 'ページにしています…' : 'ページにする'}
    </Button>
  );
}

/** 保存の状態の表示 */
const SAVE_LABEL: Record<SaveState, string> = {
  saved: '保存済み',
  pending: '未保存の変更があります',
  saving: '保存中…',
  conflict: 'ほかの場所で更新されています',
  error: '保存できませんでした',
};

/**
 * テキストのファイル。編集できるときは、開いたらそのまま書き換えられる（入力が止まって 5 秒後・閉じるとき・Ctrl/⌘+S で保存）。
 * GitHub のファイルはコミットし、ページに貼ったファイルは新しいファイルとして保存する。
 */
function TextFile({ file, onClose, guard }: { file: ViewerFile; onClose: () => void; guard: CloseGuard }) {
  const { toast, confirm } = useUi();
  const ghPath = githubFilePath(file.url);
  const [info, setInfo] = useState<{ canEdit: boolean; bom: boolean; encoding: TextEncoding; branch?: string } | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveState>('saved');
  const tableable = TABLE_TEXT.test(file.name);
  const [asTable, setAsTable] = useState(tableable);
  const slidable = SLIDES_MD.test(file.name);
  const [asSlides, setAsSlides] = useState(false);
  const htmlable = HTML_FILE.test(file.name);
  const [asHtml, setAsHtml] = useState(htmlable);
  // GitHub の HTML は、相対パスの画像なども読めるよう、トークン付きの URL で開く（rawToken.ts）。コードエディタの横並びプレビューでも使う
  const htmlSrc = useTokenizedRawUrl(htmlable && file.url ? file.url : null);
  // 保存処理から最新の値を参照するため ref にも持つ
  const cur = useRef({ text: '', saved: '', sha: '', saving: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tableFlush = useRef<Flush | null>(null);
  // この画面で読み込み済みか（保存で URL が変わっても読み直さないのは、読み込み済みのときだけ）
  const hasContent = useRef(false);

  useEffect(() => {
    // 自分で保存した直後は読み直さない（入力中の内容とカーソルをそのままにする）
    if (hasContent.current && selfSaved.has(file.url)) return;
    let alive = true;
    (async () => {
      try {
        if (ghPath) {
          const r = await api<{ text: string; sha: string; canEdit: boolean; branch?: string }>(ghPath);
          if (!alive) return;
          cur.current = { text: r.text, saved: r.text, sha: r.sha, saving: false };
          setText(r.text);
          setInfo({ canEdit: r.canEdit, bom: false, encoding: 'UTF-8', branch: r.branch });
        } else {
          const res = await fetch(file.url, { credentials: 'same-origin' });
          if (!res.ok) throw new Error(`ファイルを開けませんでした（${res.status}）`);
          const blob = await res.blob();
          if (blob.size > 2_000_000) throw new Error('ファイルが大きすぎるため、ここでは表示できません。ダウンロードして開いてください');
          const { text: t, bom, encoding } = decodeText(await blob.arrayBuffer());
          if (!alive) return;
          cur.current = { text: t, saved: t, sha: '', saving: false };
          setText(t);
          // ページに貼ったファイルは、ページを編集できる人なら編集できる
          setInfo({ canEdit: !!file.onReplace, bom, encoding });
        }
        setStatus('saved');
        hasContent.current = true;
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [file.url, ghPath]);

  // BOM 付きの UTF-8 だったファイルは BOM を付けたまま保存する。Shift_JIS だったものは、表（CSV など）だけ Excel 向けに BOM を付ける
  const bomOnSave = !!info?.bom && (info.encoding !== 'Shift_JIS' || TABLE_TEXT.test(file.name));

  const save = async (): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    const c = cur.current;
    if (!info?.canEdit || c.text === c.saved) return true;
    if (c.saving) return false;
    c.saving = true;
    setStatus('saving');
    const sending = c.text;
    try {
      if (ghPath) {
        const r = await api<{ sha: string }>(ghPath, { method: 'PUT', body: { text: sending, sha: c.sha } });
        c.sha = r.sha;
      } else {
        const bom = bomOnSave ? '\uFEFF' : '';
        await saveAsNewFile(file, new Blob([bom, sending], { type: textType(file.name) }));
      }
      c.saved = sending;
      const done = c.text === c.saved;
      setStatus(done ? 'saved' : 'pending');
      if (!done) schedule();
      return done;
    } catch (e) {
      setStatus(e instanceof ApiError && e.status === 409 ? 'conflict' : 'error');
      toast((e as Error).message || '保存できませんでした', 'error');
      return false;
    } finally {
      c.saving = false;
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  const schedule = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveRef.current(), AUTOSAVE_MS);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const change = (next: string) => {
    setText(next);
    cur.current.text = next;
    if (status !== 'conflict') {
      setStatus(next === cur.current.saved ? 'saved' : 'pending');
      schedule();
    }
  };

  // 閉じるときは、未保存の変更を保存してから閉じる（保存できなければ確認する）
  guard.current = async () => {
    // 保存の途中なら、終わるのを待ってから残りを保存する
    const ok = (await flushWhenIdle(() => cur.current.saving, () => saveRef.current())) && (tableFlush.current ? await tableFlush.current() : true);
    return ok || confirm({ title: '保存できませんでした', message: '閉じると、保存していない変更は失われます。', confirmLabel: '閉じる', danger: true });
  };

  const editable = !!info?.canEdit;
  return (
    <>
      <ViewerHeader file={file} onClose={onClose}>
        {editable && <span className={`file-status file-page-status-${status}`}>{SAVE_LABEL[status]}</span>}
        {tableable && info && (
          <Button size="sm" variant="ghost" onClick={() => setAsTable((v) => !v)}>
            {asTable ? 'テキストで表示' : '表で表示'}
          </Button>
        )}
        {slidable && info && (
          <Button size="sm" variant="ghost" onClick={() => setAsSlides((v) => !v)} title={asSlides ? 'テキスト編集に切り替えます' : 'スライドとして表示します'}>
            <Icon name="reading" size={15} /> {asSlides ? 'テキストで表示' : 'スライドで表示'}
          </Button>
        )}
        {htmlable && info && (
          <Button size="sm" variant="ghost" onClick={() => setAsHtml((v) => !v)} title={asHtml ? 'HTMLコードを表示します' : 'HTMLをプレビュー表示します'}>
            <PageIcon icon={asHtml ? 'ms:code' : 'ms:visibility'} size={15} /> {asHtml ? 'コードで表示' : 'プレビュー'}
          </Button>
        )}
      </ViewerHeader>
      <div className={`file-viewer-body ${asSlides ? 'file-viewer-slides' : asHtml ? 'file-viewer-html' : 'file-viewer-text'}`}>
        {error ? (
          <p className="muted">{error}</p>
        ) : !info ? (
          <Spinner />
        ) : asSlides ? (
          <Suspense fallback={<Spinner />}>
            <MdSlidesView markdown={text} title={file.name} onClose={() => setAsSlides(false)} />
          </Suspense>
        ) : asHtml ? (
          <div className="file-html-preview">
            {file.url && !htmlSrc ? (
              <Spinner />
            ) : (
              <HtmlFrame
                src={file.url ? htmlSrc! : undefined}
                srcDoc={!file.url ? text : undefined}
                // 中身だけで表示するときも、このサイトの権限では動かさない
                sandbox={!file.url ? 'allow-scripts allow-popups allow-forms' : undefined}
                title={file.name}
                className="file-html-iframe"
              />
            )}
          </div>
        ) : asTable ? (
          <Suspense fallback={<Spinner />}>
            <OfficeView
              name={file.name}
              text={text}
              bom={info.bom}
              flushRef={tableFlush}
              onSave={
                editable
                  ? async ({ text: next }) => {
                      change(next ?? '');
                      if (!(await saveRef.current())) throw new Error('保存できませんでした');
                    }
                  : undefined
              }
            />
          </Suspense>
        ) : (
          <Suspense fallback={<Spinner />}>
            <CodeEditor
              filename={file.name}
              value={text}
              // GitHub のファイルなら、横並びプレビューの相対パスをファイルのあるフォルダから読む
              htmlBaseHref={ghPath ? urlDir(htmlSrc ?? file.url) : undefined}
              branch={info.branch}
              encoding={encodingInfo(info.encoding, bomOnSave)}
              onChange={editable ? change : undefined}
              onSave={editable ? () => void save() : undefined}
              readOnly={!editable}
              saveStatus={status}
            />
          </Suspense>
        )}
      </div>
    </>
  );
}

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
/** 編集が止まってから GitHub にコミットするまでの時間 */
const AUTOSAVE_MS = 5_000;

/**
 * GitHub のファイルのページの本文。PDF・画像などはページ内に表示し、テキストはその場で編集できる
 * （編集は止まってから 5 秒後・ページを離れるとき・Ctrl/⌘+S で自動で GitHub にコミットする）。
 */
export function GithubFileBody({
  workspaceId,
  path,
  canEdit,
  onText,
  onSelectionText,
}: {
  workspaceId: string;
  path: string;
  canEdit: boolean;
  /** テキストのファイルの中身（文字数を数えるため） */
  onText?: (text: string) => void;
  onSelectionText?: (text: string) => void;
}) {
  const name = path.split('/').pop() ?? path;
  // 保存したら URL を変えて、新しい内容を読み直す（ブラウザに残った古い内容を使わないように）
  const [version, setVersion] = useState('');
  const url = `/api/github/raw/${workspaceId}/${encPath(path)}${version ? `?v=${version}` : ''}`;
  const kind = viewerKind(name);
  if (kind === 'text') return <GithubTextFile key={path} workspaceId={workspaceId} path={path} canEdit={canEdit} onText={onText} onSelectionText={onSelectionText} />;
  const urlRef = useRef(url);
  urlRef.current = url;
  const commit = async (blob: Blob) => {
    const r = await putGithubBinary(urlRef.current, blob);
    // 新しい版の URL にするが、編集中の画面は読み直さない
    selfSaved.add(`/api/github/raw/${workspaceId}/${encPath(path)}?v=${r.sha}`);
    setVersion(r.sha);
  };
  // GitHub のファイルは名前（拡張子）を変えずに保存できる形式だけ
  const editImage = canEdit && kind === 'image' && /\.(png|jpe?g|webp)$/i.test(name);
  const editSheet = canEdit && kind === 'sheet' && /\.(xlsx|xlsm|ods)$/i.test(name);
  const editDoc = canEdit && kind === 'doc';
  return (
    <div className={`file-page file-page-${kind ?? 'other'}`}>
      {kind === 'pdf' && (
        <Suspense fallback={<Spinner />}>
          <PdfReader url={url} name={name} />
        </Suspense>
      )}
      {kind === 'image' &&
        (editImage ? (
          <Suspense fallback={<Spinner />}>
            <ImageEditor url={url} name={name} onSave={(blob) => commit(blob)} />
          </Suspense>
        ) : (
          <img className="file-page-media" src={url} alt={name} />
        ))}
      {kind === 'video' && <video className="file-page-media" src={url} controls />}
      {kind === 'audio' && <audio src={url} controls />}
      {kind === 'slides' && (
        <Suspense fallback={<Spinner />}>
          <SlidesView url={url} onSave={canEdit ? (blob) => commit(blob) : undefined} />
        </Suspense>
      )}
      {editDoc && (
        <Suspense fallback={<Spinner />}>
          <DocxEditor url={url} onSave={(blob) => commit(blob)} />
        </Suspense>
      )}
      {(kind === 'sheet' || (kind === 'doc' && !editDoc)) && (
        <Suspense fallback={<Spinner />}>
          <OfficeView url={url} name={name} onSave={editSheet ? ({ blob }) => commit(blob) : undefined} />
        </Suspense>
      )}
      {!kind && <p className="muted">このファイルはアプリ内で表示できません。</p>}
      {kind !== 'pdf' && (
      <div className="file-page-actions">
        <a className="btn btn-ghost btn-sm" href={url} target="_blank" rel="noopener">
          <Icon name="external" size={14} /> 新しいタブで開く
        </a>
        <a className="btn btn-ghost btn-sm" href={url} download={name}>
          <Icon name="download" size={14} /> ダウンロード
        </a>
      </div>
      )}
    </div>
  );
}

type SaveState = 'saved' | 'pending' | 'saving' | 'conflict' | 'error';

function GithubTextFile({
  workspaceId,
  path,
  canEdit,
  onText,
  onSelectionText,
}: {
  workspaceId: string;
  path: string;
  canEdit: boolean;
  onText?: (text: string) => void;
  onSelectionText?: (text: string) => void;
}) {
  const { toast } = useUi();
  const apiPath = `/github/file/${workspaceId}/${encPath(path)}`;
  const [loaded, setLoaded] = useState<{ text: string; sha: string; canEdit: boolean; branch?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<SaveState>('saved');
  // 保存処理から最新の値を参照するため ref にも持つ
  const cur = useRef({ text: '', saved: '', sha: '', saving: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const tableable = TABLE_TEXT.test(path);
  const [asTable, setAsTable] = useState(tableable);
  const slidable = SLIDES_MD.test(path);
  const [asSlides, setAsSlides] = useState(false);
  const htmlable = HTML_FILE.test(path);
  const [asHtml, setAsHtml] = useState(htmlable);

  const load = async () => {
    setError(null);
    try {
      const r = await api<{ text: string; sha: string; canEdit: boolean; branch?: string }>(apiPath);
      cur.current = { text: r.text, saved: r.text, sha: r.sha, saving: false };
      setLoaded(r);
      setText(r.text);
      setStatus('saved');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, [apiPath]);

  const save = async () => {
    if (timer.current) clearTimeout(timer.current);
    const c = cur.current;
    if (c.saving || c.text === c.saved) return;
    c.saving = true;
    setStatus('saving');
    const sending = c.text;
    try {
      const r = await api<{ sha: string }>(apiPath, { method: 'PUT', body: { text: sending, sha: c.sha } });
      c.sha = r.sha;
      c.saved = sending;
      setStatus(c.text === c.saved ? 'saved' : 'pending');
      if (c.text !== c.saved) schedule();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setStatus('conflict');
      } else {
        setStatus('error');
        toast((e as Error).message, 'error');
      }
    } finally {
      c.saving = false;
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  const schedule = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveRef.current(), AUTOSAVE_MS);
  };

  // ページを離れるとき・タブを閉じるときは、未送信の変更を送る
  useEffect(() => {
    const flush = () => {
      const c = cur.current;
      if (c.text === c.saved || c.saving) return;
      void fetch(`/api${apiPath}`, {
        method: 'PUT',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: c.text, sha: c.sha }),
      });
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      if (timer.current) clearTimeout(timer.current);
      flush();
    };
  }, [apiPath]);

  // 文字数を数えるため、中身を知らせる（表の CSV などは数えない）
  useEffect(() => {
    if (loaded && !tableable) onText?.(text);
  }, [text, loaded]);
  // 選択した範囲の文字数
  useEffect(() => {
    if (!onSelectionText) return;
    const onSel = () => {
      const t = area.current;
      if (t && document.activeElement === t) return onSelectionText(t.value.slice(t.selectionStart, t.selectionEnd));
      const sel = getSelection();
      const pre = document.querySelector('.file-page-pre');
      onSelectionText(sel && pre && sel.rangeCount && pre.contains(sel.anchorNode) ? sel.toString() : '');
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, [onSelectionText]);

  // 内容に合わせて高さを伸ばす
  useEffect(() => {
    const t = area.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight + 2}px`;
  }, [text, loaded]);

  const rawUrl = `/api/github/raw/${workspaceId}/${encPath(path)}${loaded?.sha ? `?v=${loaded.sha}` : ''}`;
  // プレビュー（全画面・コードエディタの横並び）は sandbox で開くので、相対パスの画像なども読めるようトークン付きの URL にする（rawToken.ts）
  const tokenRaw = useTokenizedRawUrl(htmlable ? rawUrl : null);
  if (error) return <p className="muted file-page-error">{error}</p>;
  if (!loaded) return <Spinner />;
  const editable = canEdit && loaded.canEdit;
  const label: Record<SaveState, string> = {
    saved: '保存済み',
    pending: '未保存の変更があります',
    saving: '保存中…',
    conflict: 'ほかの場所で更新されています',
    error: '保存できませんでした',
  };

  if (asTable)
    return (
      <div className="file-page file-page-sheet">
        <div className="file-page-status">
          <span>表で表示しています</span>
          <Button size="sm" variant="ghost" onClick={() => setAsTable(false)}>
            {editable ? 'テキストで編集' : 'テキストで表示'}
          </Button>
        </div>
        <Suspense fallback={<Spinner />}>
          <OfficeView
            name={path.split('/').pop() ?? path}
            text={text}
            onSave={
              editable
                ? async ({ text: next }) => {
                    setText(next ?? '');
                    cur.current.text = next ?? '';
                    await save();
                    if (cur.current.saved !== cur.current.text) throw new Error('保存できませんでした');
                  }
                : undefined
            }
          />
        </Suspense>
      </div>
    );

  if (asSlides)
    return (
      <div className="file-page file-page-slides">
        <div className="file-page-status">
          <span>スライドで表示しています</span>
          <Button size="sm" variant="ghost" onClick={() => setAsSlides(false)}>
            {editable ? 'テキストで編集' : 'テキストで表示'}
          </Button>
        </div>
        <Suspense fallback={<Spinner />}>
          <MdSlidesView markdown={text} title={path.split('/').pop() ?? path} workspaceId={workspaceId} filePath={path} onClose={() => setAsSlides(false)} />
        </Suspense>
      </div>
    );

  // 相対パスは、ファイルのあるフォルダから読む（トークンが取れるまでは、ログインの cookie で読む URL）
  const htmlBase = urlDir(tokenRaw ?? rawUrl);
  const srcDoc = withBaseHref(text, htmlBase);

  if (asHtml)
    return (
      <div className="file-page file-page-html">
        <div className="file-page-status">
          <span>HTMLプレビューを表示しています</span>
          <Button size="sm" variant="ghost" onClick={() => setAsHtml(false)}>
            {editable ? 'コードで編集' : 'コードで表示'}
          </Button>
          <a className="btn btn-ghost btn-sm" href={tokenRaw ?? rawUrl} target="_blank" rel="noopener noreferrer">
            <PageIcon icon="ms:open_in_new" size={14} /> 新しいタブで開く
          </a>
        </div>
        <div className="file-html-preview">
          {!tokenRaw ? (
            <Spinner />
          ) : (
            <HtmlFrame
              src={status === 'saved' ? tokenRaw : undefined}
              srcDoc={status !== 'saved' ? srcDoc : undefined}
              // 保存前の内容を表示するときも、このサイトの権限では動かさない
              sandbox={status !== 'saved' ? 'allow-scripts allow-popups allow-forms' : undefined}
              title={path.split('/').pop() ?? path}
              className="file-html-iframe"
            />
          )}
        </div>
      </div>
    );

  return (
    <div className="file-page file-page-text">
      {status === 'conflict' && (
        <div className="file-page-status file-page-status-conflict">
          <span>{label[status]}</span>
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            最新の内容を読み込む（自分の変更は破棄）
          </Button>
        </div>
      )}
      <Suspense fallback={<Spinner />}>
        <CodeEditor
          filename={path.split('/').pop() ?? path}
          path={path}
          htmlBaseHref={htmlBase}
          branch={loaded.branch}
          value={text}
          onChange={
            editable
              ? (next) => {
                  setText(next);
                  cur.current.text = next;
                  if (status !== 'conflict') {
                    setStatus(next === cur.current.saved ? 'saved' : 'pending');
                    schedule();
                  }
                }
              : undefined
          }
          onSave={editable ? () => void save() : undefined}
          readOnly={!editable}
          saveStatus={status}
          onSelectionChange={onSelectionText}
          extraHeaderActions={
            <>
              {tableable && (
                <button
                  type="button"
                  className="vscode-action-btn"
                  onClick={() => setAsTable(true)}
                  title="表で表示"
                >
                  <PageIcon icon="ms:table" size={15} />
                  <span className="vscode-btn-label">表で表示</span>
                </button>
              )}
              {slidable && (
                <button
                  type="button"
                  className="vscode-action-btn"
                  onClick={() => setAsSlides(true)}
                  title="スライドで表示"
                >
                  <Icon name="reading" size={15} />
                  <span className="vscode-btn-label">スライド</span>
                </button>
              )}
              {htmlable && (
                <button
                  type="button"
                  className="vscode-action-btn"
                  onClick={() => setAsHtml(true)}
                  title="全画面プレビューで表示"
                >
                  <PageIcon icon="ms:visibility" size={15} />
                  <span className="vscode-btn-label">全画面プレビュー</span>
                </button>
              )}
            </>
          }
        />
      </Suspense>
    </div>
  );
}
