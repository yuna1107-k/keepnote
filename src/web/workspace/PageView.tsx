import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Page, type PageAppearance, type PageFont, type User } from '../api';
import { randomGalleryCover } from '../covers';
import { Button, formatDateTime, formatRelative, Icon, IconText, Modal, PageIcon, Popover, Spinner, Toggle, useNow, useUi, UserAvatar, type MenuItem } from '../ui';

const FONTS: { value: PageFont; label: string; sample: string }[] = [
  { value: 'default', label: 'サンセリフ', sample: 'Aa' },
  { value: 'serif', label: 'セリフ', sample: 'Aa' },
  { value: 'mono', label: '等幅', sample: 'Aa' },
  { value: 'mushin', label: '無心', sample: 'あ' },
];
import { useAuth } from '../auth/AuthContext';
import { Cover, CoverPicker } from './Cover';
import { HistoryModal } from './HistoryModal';
import { SharePanel } from './SharePanel';
import { exportHTML, exportMarkdown, exportReportPDF, importFile } from './transfer';
import type { EditorHandle } from './Editor';
import { blocksToText } from './text';
import { CollabProvider, userColor, type CollabStatus } from './collab';
import { prepareGithubPage, pushToGithub, toGithub } from './githubMd';
import { EmojiPicker } from './EmojiPicker';
import { GithubFileBody } from './FileViewer';
import type { LinkCandidate } from './Editor';
import { headingsOf, Toc, type TocItem } from './Toc';
import { countText, documentText, formatCount, type TextCount } from './wordCount';
import { SelectionCount, WordCountButton } from './CountChip';
import { Subpages } from './Subpages';
import { useReadingMode } from '../readingMode';
import { CommentMarks, CommentsPanel, SelectionCommentButton, useComments } from './Comments';
import { BUILTIN_TEMPLATES, fillTemplateText, isEmptyDocument, prepareTemplateBlocks, type TemplateSource } from './templates';
import { pageParam, pagePath, pageTitle, useWorkspace } from './WorkspaceContext';
import { notifyPage } from '../appBridge';

const Editor = lazy(() => import('./Editor'));
const Database = lazy(() => import('./Database'));
const RowProperties = lazy(() => import('./Database').then((m) => ({ default: m.RowProperties })));
const MdSlidesView = lazy(() => import('./MdSlidesView'));

type Patch = Partial<PageAppearance> & { title?: string; icon?: string | null; content?: any[]; contentText?: string; locked?: boolean; markdown?: string; isTemplate?: boolean };
type SaveStatus = 'saved' | 'pending' | 'saving' | 'error';

/** 変更をまとめて、1件ずつ順番にサーバーへ保存する */
function useSaver(
  pageId: string,
  initialVersion: number,
  onConflict: (latest: Page) => void,
  onSaved?: (updatedAt: number) => void,
  collabRef?: { current: boolean },
) {
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;
  const version = useRef(initialVersion);
  const pending = useRef<Patch>({});
  const inflight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conflicted = useRef(false);
  const [status, setStatus] = useState<SaveStatus>('saved');

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (inflight.current || conflicted.current) return;
    const patch = pending.current;
    if (Object.keys(patch).length === 0) return;
    pending.current = {};
    inflight.current = true;
    setStatus('saving');
    try {
      const res = await api<{ version: number; updatedAt: number }>(`/pages/${pageId}`, {
        method: 'PATCH',
        body: { ...patch, version: version.current, ...(collabRef?.current ? { collab: true } : {}) },
      });
      version.current = res.version;
      savedRef.current?.(res.updatedAt);
      setStatus(Object.keys(pending.current).length ? 'pending' : 'saved');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.page) {
        conflicted.current = true;
        pending.current = { ...patch, ...pending.current };
        setStatus('error');
        onConflict(e.data.page);
      } else {
        pending.current = { ...patch, ...pending.current };
        setStatus('error');
        timer.current = setTimeout(() => void flush(), 5000);
      }
    } finally {
      inflight.current = false;
    }
    if (Object.keys(pending.current).length && !conflicted.current && !timer.current) await flush();
  }, [pageId, onConflict]);

  const queue = useCallback(
    (patch: Patch, delay = 700) => {
      pending.current = { ...pending.current, ...patch };
      setStatus('pending');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), delay);
    },
    [flush],
  );

  /** 競合時：サーバーの版を基準に、自分の変更で上書きする */
  const forceOverwrite = useCallback(
    (serverVersion: number) => {
      version.current = serverVersion;
      conflicted.current = false;
      void flush();
    },
    [flush],
  );

  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (Object.keys(pending.current).length || inflight.current) {
        void flush();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      void flush(); // ページ移動時に未保存分を送る
    };
  }, [flush]);

  return { status, queue, forceOverwrite };
}

/** このページを開いているほかの人（15 秒ごとに通知し合う） */
function usePresence(pageId: string) {
  const [viewers, setViewers] = useState<User[]>([]);
  useEffect(() => {
    let stopped = false;
    const beat = async () => {
      if (document.hidden) return;
      try {
        const r = await api<{ viewers: (User & { self: boolean })[] }>(`/pages/${pageId}/presence`, { body: {} });
        if (!stopped) setViewers(r.viewers.filter((v) => !v.self));
      } catch {
        /* 一時的な失敗は無視 */
      }
    };
    const leave = () => {
      void fetch(`/api/pages/${pageId}/presence`, { method: 'DELETE', keepalive: true, credentials: 'same-origin' }).catch(() => {});
    };
    void beat();
    const timer = setInterval(beat, 15_000);
    const onVisible = () => !document.hidden && void beat();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', leave);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [pageId]);
  return viewers;
}

function Presence({ viewers }: { viewers: User[] }) {
  if (viewers.length === 0) return null;
  const shown = viewers.slice(0, 4);
  return (
    <div className="presence" title={`${viewers.map((v) => v.displayName).join('、')} が閲覧中`}>
      {shown.map((v) => (
        <span key={v.id} className="presence-avatar">
          <UserAvatar user={v} size={24} />
        </span>
      ))}
      {viewers.length > shown.length && <span className="presence-more">+{viewers.length - shown.length}</span>}
    </div>
  );
}

/** リアルタイム共同編集の接続（部屋への最初の同期が終わるまで待つ） */
function useCollab(pageId: string, enabled: boolean) {
  const [state, setState] = useState<{ provider: CollabProvider; seed: boolean; ready: boolean; status: CollabStatus } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const provider = new CollabProvider(pageId);
    let alive = true;
    setState({ provider, seed: false, ready: false, status: provider.status });
    const off = provider.onStatus(() => alive && setState((s) => (s ? { ...s, status: provider.status } : s)));
    // 接続できない場合でも編集できるよう、一定時間で通常の編集に切り替える
    const timeout = setTimeout(() => alive && setState((s) => (s && !s.ready ? { ...s, ready: true, status: 'unavailable' } : s)), 6000);
    void provider.synced().then(({ seed }) => {
      clearTimeout(timeout);
      if (alive) setState((s) => (s && !s.ready ? { ...s, seed, ready: true, status: provider.status } : s));
    });
    return () => {
      alive = false;
      clearTimeout(timeout);
      off();
      provider.destroy();
    };
  }, [pageId, enabled]);
  return state;
}

function AutoTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = el.scrollHeight + 'px';
  }, [props.value]);
  return <textarea ref={ref} rows={1} {...props} />;
}

function ExportModal({
  open,
  onClose,
  defaultTitle,
  defaultFormat,
  defaultAuthor,
  onExport,
}: {
  open: boolean;
  onClose: () => void;
  defaultTitle: string;
  defaultFormat: 'pdf' | 'html' | 'md';
  defaultAuthor: string;
  onExport: (format: 'pdf' | 'html' | 'md', title: string, author: string) => void;
}) {
  const [format, setFormat] = useState<'pdf' | 'html' | 'md'>(defaultFormat);
  const [title, setTitle] = useState(defaultTitle);
  const [author, setAuthor] = useState(defaultAuthor);

  useEffect(() => {
    if (open) {
      setFormat(defaultFormat);
      setTitle(defaultTitle);
      setAuthor(defaultAuthor);
    }
  }, [open, defaultFormat, defaultTitle, defaultAuthor]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    onExport(format, title.trim() || '無題', author.trim());
  };

  return (
    <Modal open={open} onClose={onClose} title="ファイルを書き出し" width={480}>
      <form className="modal-body" onSubmit={submit}>
        <div className="field">
          <span>形式</span>
          <div className="segmented">
            <button type="button" className={format === 'pdf' ? 'active' : ''} onClick={() => setFormat('pdf')}>
              PDF（レポート形式）
            </button>
            <button type="button" className={format === 'html' ? 'active' : ''} onClick={() => setFormat('html')}>
              HTML
            </button>
            <button type="button" className={format === 'md' ? 'active' : ''} onClick={() => setFormat('md')}>
              Markdown
            </button>
          </div>
        </div>
        <label className="field">
          <span>タイトル</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="無題" />
        </label>
        <label className="field">
          <span>執筆者の名前（任意）</span>
          <input
            autoFocus
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="例: 山田 太郎 / 〇〇大学 学籍番号 など"
          />
        </label>
        <div className="modal-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" variant="primary">
            書き出し
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function PageEditor({ page, onReload, inPeek = false }: { page: Page; onReload: () => void; inPeek?: boolean }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { toast, confirm } = useUi();
  const [title, setTitle] = useState(page.title);
  // Android アプリに、開いているページを知らせる
  useEffect(() => notifyPage(page.id, title), [page.id, title]);
  const [icon, setIcon] = useState(page.icon);
  const [look, setLook] = useState<PageAppearance & { locked: boolean }>({
    cover: page.cover,
    coverPosition: page.coverPosition,
    fullWidth: page.fullWidth,
    smallText: page.smallText,
    font: page.font,
    slideTheme: page.slideTheme ?? null,
    locked: page.locked,
  });
  const [conflict, setConflict] = useState<Page | null>(null);
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [shareAnchor, setShareAnchor] = useState<HTMLElement | null>(null);
  const [coverAnchor, setCoverAnchor] = useState<HTMLElement | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [slidesOpen, setSlidesOpen] = useState(false);
  const [slidesAutoPlay, setSlidesAutoPlay] = useState(false);
  const { user } = useAuth();
  // 最終編集（サーバーが記録した保存時刻と編集者）。開いただけでは変わらない
  const [lastEdit, setLastEdit] = useState({ at: page.updatedAt, by: page.updatedBy });
  useNow(30_000);
  const editorRef = useRef<EditorHandle | null>(null);
  // コメント（ページを見られる人は誰でも付けられる）
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState<{ blockId: string | null; quote: string } | null>(null);
  const [commentFocus, setCommentFocus] = useState<string | null>(null);
  const deleted = !!page.deletedAt;
  const viewOnly = page.access === 'view';
  const gh = page.github;
  const ghFolder = gh?.kind === 'dir' || gh?.kind === 'root';
  // GitHub との同期の表示は、ワークスペースのオーナー・管理者（とサーバー管理者）だけに出す
  const ghManage = user?.role === 'admin' || ws.current?.role === 'owner' || ws.current?.role === 'admin';
  // Markdown 以外のファイル（PDF・テキストなど）のページ。本文の代わりにファイルを表示する
  const ghFile = gh?.kind === 'file' && !!gh.path;
  // 閲覧モード（読むだけ。編集の操作を隠す）
  const [reading, setReading] = useReadingMode();
  const readOnly = deleted || look.locked || viewOnly || ghFolder || ghFile || reading;
  // GitHub のファイル・フォルダもタイトル（＝ファイル名・フォルダ名）を変えられる（リポジトリのページを除く）
  const titleLocked = deleted || look.locked || viewOnly || gh?.kind === 'root' || reading;
  const [ghState, setGhState] = useState<{ dirty: boolean; conflictAt: number | null; syncing: boolean; lastSyncAt: number | null; lastSyncStatus: string | null }>({
    dirty: !!gh?.dirty,
    conflictAt: gh?.conflictAt ?? null,
    syncing: false,
    lastSyncAt: gh?.lastSyncAt ?? null,
    lastSyncStatus: gh?.lastSyncStatus ?? null,
  });
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushNow = async () => {
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = null;
    const r = await pushToGithub(page.id).catch(() => null);
    if (r?.status === 'pushed') setGhState((s) => ({ ...s, dirty: false }));
    // 名前・場所が変わったら、新しいパスで表示し直す
    if (r && gh?.path && r.path && r.path !== gh.path) {
      await ws.reload();
      onReload();
    }
    if (r?.status === 'conflict') {
      toast('ほかの場所でも同時に変更されていたため、そちらの内容を採用しました（自分の変更は編集履歴に残っています）', 'error');
      onReload();
    }
  };
  // 編集が止まって 5 秒たったら自動で GitHub にコミットする。ページを離れるときにも送る
  // （送れなかった分は、サーバーが 10 分ごとに送る）
  const schedulePush = () => {
    setGhState((s) => ({ ...s, dirty: true }));
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => void pushNow(), 5_000);
  };
  useEffect(
    () => () => {
      if (pushTimer.current) {
        clearTimeout(pushTimer.current);
        // 保存が終わるのを少し待ってから送る
        setTimeout(() => void pushToGithub(page.id, true).catch(() => {}), 2500);
      }
    },
    [page.id],
  );
  const syncGithub = async () => {
    setGhState((s) => ({ ...s, syncing: true }));
    try {
      let r: { result: { created: number; updated: number; removed: number; pushed: number; pending: number } };
      let rounds = 0;
      do {
        r = await api(`/github/workspaces/${page.workspaceId}/sync`, { method: 'POST' });
      } while (r.result.pending > 0 && ++rounds < 20);
      const { created, updated, removed, pushed } = r.result;
      setGhState((s) => ({ ...s, lastSyncAt: Date.now(), lastSyncStatus: r.result.pending ? `残り ${r.result.pending} 件` : 'ok' }));
      // サイドバーの「GitHub 最終同期」も読み直す
      window.dispatchEvent(new Event('github-synced'));
      toast(`GitHub と同期しました（追加 ${created}・更新 ${updated}・削除 ${removed}・送信 ${pushed}）`);
      await ws.reload();
      onReload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setGhState((s) => ({ ...s, syncing: false }));
    }
  };
  // 「[[」で出すリンク先の候補。GitHub の Markdown から GitHub のファイルへは相対パス（GitHub 上でもリンクになる）
  const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const relPath = (fromDir: string, to: string) => {
    const a = fromDir ? fromDir.split('/') : [];
    const b = to.split('/');
    let i = 0;
    while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => '..'), ...b.slice(i)].map(encodeURIComponent).join('/');
  };
  const linkCandidates = (query: string): LinkCandidate[] => {
    const q = query.trim().toLowerCase();
    const fromGithub = gh?.kind === 'md' && gh.path ? gh.path : null;
    return ws.pages
      .filter((p) => p.id !== page.id && pageTitle(p).toLowerCase().includes(q))
      .map((p) => ({
        id: p.id,
        title: pageTitle(p),
        icon: p.icon,
        subtext: ws.ancestors(p.id).map((a) => pageTitle(a)).join(' / ') || undefined,
        href: fromGithub ? (p.githubPath ? relPath(dirOf(fromGithub), p.githubPath) : `${location.origin}/p/${p.id}`) : `/p/${p.id}`,
      }));
  };
  // 本文のリンクをクリックしたとき：アプリ内のページなら、そのページを開く
  const onLinkClick = (href: string) => {
    let url: URL;
    try {
      url = new URL(href, location.href);
    } catch {
      return false;
    }
    const isRelative = !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href);
    if (isRelative && gh?.path) {
      // GitHub のページの相対パス
      const parts = dirOf(gh.path) ? dirOf(gh.path).split('/') : [];
      for (const seg of href.split('#')[0]!.split('/')) {
        const d = (() => {
          try {
            return decodeURIComponent(seg);
          } catch {
            return seg;
          }
        })();
        if (d === '..') parts.pop();
        else if (d && d !== '.') parts.push(d);
      }
      const target = ws.pages.find((p) => p.githubPath === parts.join('/'));
      if (target) {
        // ページの中から開くページは、画面を重ねて開く
        ws.ui.openPeek(target.id);
        return true;
      }
      return false;
    }
    if (url.origin !== location.origin) return false;
    if (url.pathname.startsWith('/p/') || url.pathname.split('/').filter(Boolean).length >= 2) {
      const id = ws.resolveId(url.pathname.split('/').filter(Boolean).pop());
      if (id && ws.byId.has(id) && !url.hash) ws.ui.openPeek(id);
      else navigate(url.pathname + url.hash);
      return true;
    }
    return false;
  };
  // このページを参照しているページ
  const [backlinks, setBacklinks] = useState<{ id: string; title: string; icon: string | null }[]>([]);
  useEffect(() => {
    let alive = true;
    void api<{ pages: { id: string; title: string; icon: string | null }[] }>(`/pages/${page.id}/backlinks`)
      .then((r) => alive && setBacklinks(r.pages))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [page.id]);

  // 目次（見出しの一覧）。内容が変わるたびに作り直す
  const [toc, setToc] = useState<TocItem[]>(() => headingsOf(page.content));
  const [emptyDoc, setEmptyDoc] = useState(() => isEmptyDocument(page.content));
  // 文字数（入力中は少し待ってから数え直す）と、選択中の文字数
  const [counts, setCounts] = useState<TextCount>(() => countText(documentText(page.content)));
  const [selCounts, setSelCounts] = useState<TextCount | null>(null);
  const countTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(countTimer.current), []);
  const onDocument = useCallback((blocks: any[]) => {
    const next = headingsOf(blocks);
    setToc((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    setEmptyDoc(isEmptyDocument(blocks));
    clearTimeout(countTimer.current);
    countTimer.current = setTimeout(() => {
      const c = countText(documentText(blocks));
      setCounts((prev) => (prev.chars === c.chars && prev.charsWithSpaces === c.charsWithSpaces && prev.words === c.words ? prev : c));
    }, 300);
  }, []);
  const onSelectionText = useCallback((text: string) => setSelCounts(text.trim() ? countText(text) : null), []);
  // GitHub のテキストファイル（Markdown 以外の .txt など）は、ファイルの中身を数える
  const [fileCounts, setFileCounts] = useState<TextCount | null>(null);
  const onFileText = useCallback((text: string) => {
    clearTimeout(countTimer.current);
    countTimer.current = setTimeout(() => setFileCounts(countText(text)), 300);
  }, []);
  const shownCounts = ghFile ? fileCounts : counts;

  // テンプレート：空の新しいページでは「テンプレートから始める」を出す
  const [isTemplate, setIsTemplate] = useState(!!page.isTemplate);
  // データベース：子ページが行になる。親がデータベースなら、このページは行なので列の値を出す
  const [isDatabase, setIsDatabase] = useState(!!page.isDatabase);
  useEffect(() => setIsDatabase(!!page.isDatabase), [page.id, page.isDatabase]);
  const parentIsDatabase = !!page.parentId && !!ws.pages.find((p) => p.id === page.parentId)?.isDatabase;
  const toggleDatabase = async () => {
    try {
      if (isDatabase) {
        if (!(await confirm({ title: 'データベースをやめますか？', message: '行はふつうのサブページに戻ります。列の値は残り、もう一度データベースにすると元に戻ります。', confirmLabel: 'やめる' }))) return;
        await api(`/pages/${page.id}/database`, { method: 'DELETE' });
      } else await api(`/pages/${page.id}/database`, { method: 'POST' });
      setIsDatabase(!isDatabase);
      ws.patchLocal(page.id, { isDatabase: !isDatabase });
      toast(isDatabase ? 'ふつうのページに戻しました' : 'データベースにしました。サブページが行になります', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const [templates, setTemplates] = useState<TemplateSource[]>([]);
  const offerTemplates = !readOnly && !conflict && emptyDoc && !title.trim() && gh?.kind !== 'file' && !isTemplate;
  useEffect(() => {
    if (!offerTemplates || templates.length) return;
    void api<{ templates: TemplateSource[] }>(`/pages/templates?workspace=${encodeURIComponent(page.workspaceId)}`)
      .then((r) => setTemplates([...BUILTIN_TEMPLATES, ...r.templates.filter((t) => t.id !== page.id)]))
      .catch(() => setTemplates(BUILTIN_TEMPLATES));
  }, [offerTemplates]);
  const applyTemplate = async (t: TemplateSource) => {
    try {
      const src = t.builtin ? BUILTIN_TEMPLATES.find((b) => b.id === t.id)! : { ...t, content: (await api<{ page: Page }>(`/pages/${t.id}`)).page.content };
      editorRef.current?.replaceAll(prepareTemplateBlocks(src.content));
      updateTitle(fillTemplateText(src.title));
      if (src.icon && !icon) updateIcon(src.icon);
      // 最初からあるテンプレートは、文字の形やカバーも合わせる（日記など）
      const builtin = t.builtin ? BUILTIN_TEMPLATES.find((b) => b.id === t.id) : undefined;
      if (builtin?.look) updateLook(builtin.look);
      // データベースのテンプレート（読書記録など）は、このページをデータベースにする
      if (builtin?.database) {
        const { applyTemplateDatabase } = await import('./templates');
        await applyTemplateDatabase(page.id, builtin.database);
        setIsDatabase(true);
        ws.patchLocal(page.id, { isDatabase: true });
      }
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const toggleTemplate = () => {
    const v = !isTemplate;
    setIsTemplate(v);
    saver.queue({ isTemplate: v }, 0);
    toast(v ? 'テンプレートにしました。新しいページで「テンプレートから始める」に表示されます' : 'テンプレートから外しました', 'success');
  };
  const viewers = usePresence(page.id);
  const collab = useCollab(page.id, !deleted && !ghFile);
  const comments = useComments(page.id, commentsOpen, collab?.provider ?? null);
  const openComments = comments.comments.filter((c) => !c.threadId && !c.resolvedAt).length;
  // 編集できない人は、部屋に中身がない（誰も編集していない）あいだは保存済みの内容を表示する。
  // 編集できない人は部屋に中身を入れられないため、そのままだと空の本文になる。誰かが編集を始めたら共同編集の表示に切り替える
  const [roomFilled, setRoomFilled] = useState(false);
  useEffect(() => {
    if (!collab?.ready) return;
    const doc = collab.provider.doc;
    const fragment = doc.getXmlFragment('document-store');
    const check = () => setRoomFilled(fragment.length > 0);
    check();
    doc.on('update', check);
    return () => doc.off('update', check);
  }, [collab?.ready, collab?.provider]);
  const collabActive = !!collab?.ready && collab.status !== 'unavailable' && (!readOnly || roomFilled);
  const collabRef = useRef(false);
  collabRef.current = collabActive;
  const saver = useSaver(
    page.id,
    page.version,
    setConflict,
    (at) => {
      setLastEdit({ at, by: user?.displayName ?? null });
      ws.patchLocal(page.id, { updatedAt: at });
    },
    collabRef,
  );

  // 保存担当が抜けて自分が担当になったときは、最新の内容を保存しておく
  const latestBlocks = useRef<any[] | null>(null);
  useEffect(() => {
    if (!collabActive) return;
    const provider = collab!.provider;
    let wasSaver = provider.isSaver();
    const onChange = () => {
      const now = provider.isSaver();
      if (now && !wasSaver && latestBlocks.current && !readOnly) {
        saver.queue({ content: latestBlocks.current, contentText: blocksToText(latestBlocks.current) });
      }
      wasSaver = now;
    };
    provider.awareness.on('change', onChange);
    return () => provider.awareness.off('change', onChange);
  }, [collabActive]);

  // タイトルも共同編集の文書で共有する
  const meta = collabActive ? collab!.provider.doc.getMap<string>('meta') : null;
  useEffect(() => {
    if (!meta) return;
    if (collab!.seed && meta.get('title') === undefined) meta.set('title', title);
    const onMeta = (ev: { transaction: { local: boolean } }) => {
      if (ev.transaction.local) return; // 自分の入力
      const t = meta.get('title');
      if (typeof t === 'string') {
        setTitle(t);
        ws.patchLocal(page.id, { title: t });
      }
    };
    meta.observe(onMeta);
    const initial = meta.get('title');
    if (typeof initial === 'string' && initial !== title) setTitle(initial);
    return () => meta.unobserve(onMeta);
  }, [meta]);

  // ほかの画面（データベースの表・ほかの端末など）でこのページの名前が変わったら、入力中でなければ映す
  const listedTitle = ws.byId.get(page.id)?.title;
  const titleFocused = useRef(false);
  // 開いたときの一覧の値は古いことがある（ページは開くときに読み直している）ので、開いた後に変わったときだけ映す
  const prevListed = useRef(listedTitle);
  useEffect(() => {
    if (prevListed.current === listedTitle) return;
    prevListed.current = listedTitle;
    if (listedTitle === undefined || titleFocused.current) return;
    setTitle((t) => (t === listedTitle ? t : listedTitle));
  }, [listedTitle]);

  const updateTitle = (v: string) => {
    setTitle(v);
    ws.patchLocal(page.id, { title: v });
    meta?.set('title', v);
    saver.queue({ title: v }, 500);
    // GitHub のページは、タイトル（ファイル名・フォルダ名）が変わったら自動でコミットする（新しいページは GitHub に追加される）
    if (gh && gh.kind !== 'root' && v.trim() && (!collabRef.current || collab?.provider.isSaver())) schedulePush();
  };
  const updateIcon = (v: string | null) => {
    setIcon(v);
    setEmojiAnchor(null);
    ws.patchLocal(page.id, { icon: v });
    saver.queue({ icon: v }, 0);
  };
  const updateLook = (patch: Partial<typeof look>) => {
    setLook((l) => ({ ...l, ...patch }));
    saver.queue(patch, 0);
  };

  const ancestors = ws.ancestors(page.id);
  const children = ws.childrenOf(page.id);
  const favorite = ws.favorites.includes(page.id);
  const isPublic = ws.byId.get(page.id)?.isPublic ?? page.isPublic;

  const duplicate = async () => {
    try {
      const r = await api<{ id: string; count: number }>(`/pages/${page.id}/duplicate`, { body: {} });
      await ws.reload();
      toast(r.count > 1 ? `サブページを含む ${r.count} ページを複製しました` : 'ページを複製しました', 'success');
      navigate(`/p/${r.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  // レポートの体裁で PDF にする
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<'pdf' | 'html' | 'md'>('pdf');
  const EXPORT_AUTHOR_KEY = 'keepnote_export_author';
  const savedAuthor = typeof window !== 'undefined' ? localStorage.getItem(EXPORT_AUTHOR_KEY) ?? '' : '';
  const [exportAuthor, setExportAuthor] = useState<string>(() => savedAuthor || user?.displayName || '');

  const openExport = (fmt: 'pdf' | 'html' | 'md') => {
    setExportFormat(fmt);
    const curSaved = typeof window !== 'undefined' ? localStorage.getItem(EXPORT_AUTHOR_KEY) : null;
    if (curSaved !== null) setExportAuthor(curSaved);
    else if (!exportAuthor && user?.displayName) setExportAuthor(user.displayName);
    setExportOpen(true);
  };

  const handleExport = (fmt: 'pdf' | 'html' | 'md', outTitle: string, outAuthor: string) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(EXPORT_AUTHOR_KEY, outAuthor);
    }
    setExportAuthor(outAuthor);
    setExportOpen(false);

    if (fmt === 'pdf') {
      if (editorRef.current) exportReportPDF(outTitle, editorRef.current.toReportHTML(), outAuthor);
      else window.print();
    } else if (fmt === 'html') {
      if (editorRef.current) exportHTML(outTitle, editorRef.current.toHTML(), outAuthor);
    } else if (fmt === 'md') {
      if (editorRef.current) exportMarkdown(outTitle, editorRef.current.toMarkdown(), outAuthor);
    }
  };

  const viewOnlyItems: MenuItem[] = [
    { label: favorite ? 'お気に入りから外す' : 'お気に入りに追加', icon: 'star', onClick: () => ws.setFavorite(page.id, !favorite) },
    { label: 'ページ履歴', icon: 'clock', onClick: () => setHistoryOpen(true) },
    {
      label: 'リンクをコピー',
      icon: 'link',
      onClick: async () => {
        await navigator.clipboard.writeText(window.location.href);
        toast('リンクをコピーしました', 'success');
      },
    },
    'divider',
    { label: 'スライドで表示', icon: 'reading', onClick: () => setSlidesOpen(true) },
    { label: 'Markdown で書き出し', icon: 'download', onClick: () => openExport('md') },
    { label: 'HTML で書き出し', icon: 'download', onClick: () => openExport('html') },
    { label: 'PDF で書き出し（レポート形式）', icon: 'download', onClick: () => openExport('pdf') },
  ];

  const menuItems: MenuItem[] = viewOnly || reading ? viewOnlyItems : [
    { label: favorite ? 'お気に入りから外す' : 'お気に入りに追加', icon: 'star', onClick: () => ws.setFavorite(page.id, !favorite) },
    { label: '複製', icon: 'duplicate', onClick: duplicate },
    { label: isTemplate ? 'テンプレートから外す' : 'テンプレートにする', icon: 'template', onClick: toggleTemplate },
    ...(ghFile || gh ? [] : [{ label: isDatabase ? 'データベースをやめる' : 'データベースにする', icon: 'database' as const, onClick: () => void toggleDatabase() }]),
    { label: '移動', icon: 'move', onClick: () => ws.ui.setMoveTarget(page.id) },
    { label: 'ページ履歴', icon: 'clock', onClick: () => setHistoryOpen(true) },
    {
      label: 'リンクをコピー',
      icon: 'link',
      onClick: async () => {
        await navigator.clipboard.writeText(window.location.href);
        toast('リンクをコピーしました', 'success');
      },
    },
    'divider',
    { label: 'スライドで表示', icon: 'reading', onClick: () => setSlidesOpen(true) },
    { label: 'Markdown で書き出し', icon: 'download', onClick: () => openExport('md') },
    { label: 'HTML で書き出し', icon: 'download', onClick: () => openExport('html') },
    { label: 'PDF で書き出し（レポート形式）', icon: 'download', onClick: () => openExport('pdf') },
    'divider',
    {
      label: 'ゴミ箱に移動',
      icon: 'trash',
      danger: true,
      onClick: async () => {
        await ws.trashPage(page.id);
        navigate(page.parentId && ws.byId.has(page.parentId) ? `/p/${page.parentId}` : '/');
      },
    },
  ];

  const restore = async () => {
    try {
      await api(`/pages/${page.id}/restore`, { body: {} });
      await ws.reload();
      onReload();
      toast('ページを復元しました', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const purge = async () => {
    const ok = await confirm({ title: 'ページを完全に削除しますか？', message: 'この操作は元に戻せません。', confirmLabel: '完全に削除', danger: true });
    if (!ok) return;
    try {
      await api(`/pages/${page.id}/permanent`, { method: 'DELETE' });
      navigate('/');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const statusLabel = { saved: '保存済み', pending: '編集中…', saving: '保存中…', error: '保存できていません' }[saver.status];
  const pageClass = ['page', isDatabase && 'is-database', children.length > 0 && 'has-subpages', commentsOpen && 'comments-open', look.fullWidth && 'page-full', look.smallText && 'page-small', `page-font-${look.font}`].filter(Boolean).join(' ');

  return (
    <div className={pageClass}>
      <header className="topbar">
        <nav className="breadcrumbs">
          {ancestors.map((a) => (
            <span key={a.id} className="crumb">
              <Link to={pagePath(a, ws.current?.slug)}>
                <PageIcon icon={a.icon} size={14} /> <span className="ellipsis">{pageTitle(a)}</span>
              </Link>
              <span className="crumb-sep">/</span>
            </span>
          ))}
          <span className="crumb current">
            <PageIcon icon={icon} size={14} /> <span className="ellipsis">{title.trim() || '無題'}</span>
          </span>
          {page.visibility === 'private' && (
            <span className="badge badge-muted" title="あなただけが閲覧できます">
              <Icon name="lock" size={11} /> プライベート
            </span>
          )}
        </nav>
        <div className="topbar-right">
          <span className={`save-status ${saver.status}`} title={`最終編集: ${formatDateTime(lastEdit.at)}${lastEdit.by ? `（${lastEdit.by}）` : ''}`}>
            {saver.status === 'saved' ? `最終編集 ${formatRelative(lastEdit.at)}` : statusLabel}
          </span>
          <Presence viewers={viewers} />
          {viewOnly && !deleted && (
            <span className="lock-chip static" title="このページは閲覧のみ許可されています">
              <Icon name="lock" size={12} /> 閲覧のみ
            </span>
          )}
          {look.locked && !deleted && !viewOnly && (
            <button className="lock-chip" onClick={() => updateLook({ locked: false })} title="クリックでロックを解除">
              <Icon name="lock" size={12} /> ロック中
            </button>
          )}
          <button
            className="icon-btn slide-play-btn"
            onClick={() => {
              setSlidesAutoPlay(true);
              setSlidesOpen(true);
            }}
            aria-label="スライドを再生"
            title="スライドを再生（スライドショー）"
          >
            <PageIcon icon="ms:slideshow" size={16} />
          </button>
          <button
            className={`icon-btn reading-btn ${reading ? 'active' : ''}`}
            onClick={() => {
              setReading(!reading);
              toast(reading ? '閲覧モードを終了しました' : '閲覧モードにしました（編集はできません）');
            }}
            aria-label="閲覧モード"
            aria-pressed={reading}
            title={reading ? '閲覧モードを終了' : '閲覧モード（読むだけ・大きな文字）'}
          >
            <Icon name="reading" />
          </button>
          {!deleted && !reading && (
            <>
              <button className={`btn btn-ghost btn-sm share-btn ${isPublic ? 'is-public' : ''}`} onClick={(e) => setShareAnchor(e.currentTarget)}>
                {isPublic && <Icon name="globe" size={14} />}共有
              </button>
              {!ghFile && (
                <button
                  className={`icon-btn comments-btn ${commentsOpen ? 'active' : ''}`}
                  onClick={() => {
                    setCommentsOpen((v) => !v);
                    setCommentFocus(null);
                  }}
                  aria-label="コメント"
                  title="コメント"
                >
                  <Icon name="comment" />
                  {openComments > 0 && <span className="comments-badge">{openComments}</span>}
                </button>
              )}
              <button className="icon-btn" onClick={() => setHistoryOpen(true)} aria-label="ページ履歴" title="ページ履歴">
                <Icon name="clock" />
              </button>
              <button className={`icon-btn ${favorite ? 'favorite-on' : ''}`} onClick={() => ws.setFavorite(page.id, !favorite)} aria-label="お気に入り">
                <Icon name="star" />
              </button>
              <button className="icon-btn" onClick={(e) => setMenuAnchor(e.currentTarget)} aria-label="メニュー">
                <Icon name="more" />
              </button>
            </>
          )}
        </div>
      </header>
      {menuAnchor && (
        <Popover anchor={menuAnchor} onClose={() => setMenuAnchor(null)} align="right" width={280}>
          <div className="page-menu">
            {!viewOnly && !deleted && (
              <>
                <div className="page-menu-label">スタイル</div>
                <div className="font-tiles">
                  {FONTS.map((f) => (
                    <button
                      key={f.value}
                      className={`font-tile ${look.font === f.value ? 'active' : ''}`}
                      onClick={() => updateLook({ font: f.value })}
                      title={f.label}
                    >
                      <span className={`font-tile-sample page-font-${f.value}`}>{f.sample}</span>
                      <span className="font-tile-label">{f.label}</span>
                    </button>
                  ))}
                </div>
                <div className="page-menu-toggles">
                  <label className="page-menu-toggle">
                    <span>小さい文字</span>
                    <Toggle checked={look.smallText} onChange={(v) => updateLook({ smallText: v })} label="小さい文字" />
                  </label>
                  <label className="page-menu-toggle">
                    <span>全幅表示</span>
                    <Toggle checked={look.fullWidth} onChange={(v) => updateLook({ fullWidth: v })} label="全幅表示" />
                  </label>
                  <label className="page-menu-toggle">
                    <span>ページをロック</span>
                    <Toggle checked={look.locked} onChange={(v) => updateLook({ locked: v })} label="ページをロック" />
                  </label>
                </div>
                <div className="menu-divider" />
              </>
            )}
            {shownCounts && (
              <>
                <div className="page-menu-info muted small">
                  {formatCount(shownCounts.chars)} 文字・{formatCount(shownCounts.words)} 語
                </div>
                <div className="menu-divider" />
              </>
            )}
            {menuItems.map((item, i) =>
              item === 'divider' ? (
                <div key={i} className="menu-divider" />
              ) : (
                <button
                  key={i}
                  className={`menu-item ${item.danger ? 'danger' : ''}`}
                  onClick={() => {
                    setMenuAnchor(null);
                    item.onClick();
                  }}
                >
                  {item.icon && <Icon name={item.icon} />}
                  {item.label}
                </button>
              ),
            )}
          </div>
        </Popover>
      )}
      {shareAnchor && (
        <Popover anchor={shareAnchor} onClose={() => setShareAnchor(null)} align="right" width={420}>
          <SharePanel page={{ ...page, isPublic }} />
        </Popover>
      )}
      <HistoryModal page={page} canRestore={!viewOnly} open={historyOpen} onClose={() => setHistoryOpen(false)} onRestored={onReload} />
      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        defaultTitle={title || '無題'}
        defaultFormat={exportFormat}
        defaultAuthor={exportAuthor}
        onExport={handleExport}
      />
      {slidesOpen &&
        createPortal(
          <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSlidesOpen(false)}>
            <div className="file-viewer file-viewer-slides-modal" role="dialog" aria-modal="true" aria-label="スライド表示">
              <Suspense fallback={<Spinner />}>
                <MdSlidesView
                  markdown={editorRef.current?.toMarkdown() ?? (page.github?.kind === 'md' ? page.github.baselineMd ?? '' : '')}
                  title={title || 'プレゼンテーション'}
                  font={look.font}
                  theme={look.slideTheme}
                  onThemeChange={viewOnly ? undefined : (slideTheme) => updateLook({ slideTheme })}
                  autoPlay={slidesAutoPlay}
                  workspaceId={page.workspaceId}
                  filePath={page.github?.path ?? undefined}
                  onClose={() => {
                    setSlidesOpen(false);
                    setSlidesAutoPlay(false);
                  }}
                />
              </Suspense>
            </div>
          </div>,
          document.body,
        )}

      {deleted && (
        <div className="banner banner-danger">
          このページはゴミ箱にあります。
          <Button size="sm" onClick={restore}>
            <Icon name="restore" size={14} /> 復元
          </Button>
          <Button size="sm" variant="danger" onClick={purge}>
            完全に削除
          </Button>
        </div>
      )}
      {gh && ghManage && (
        <div className="banner banner-info github-banner">
          <Icon name="github" size={14} />
          <span className="github-banner-text">
            <span>{ghFolder ? 'GitHub のフォルダと同期しています' : gh.path ? 'GitHub のファイルと同期しています' : '保存すると GitHub に新しいファイルとして追加します'}</span>
            {gh.path ? (
              <code className="github-path" title={gh.path}>
                {gh.path}
              </code>
            ) : null}
            {gh.kind === 'md' && ghState.dirty && <span className="muted">・まもなく自動でコミットします</span>}
            <span className={`github-sync-time ${ghState.lastSyncStatus === 'error' ? 'is-error' : ''}`} title={ghState.lastSyncAt ? `最終同期：${formatDateTime(ghState.lastSyncAt)}` : undefined}>
              ・{ghState.lastSyncAt ? `最終同期 ${formatRelative(ghState.lastSyncAt)}` : 'まだ同期していません'}
              {ghState.lastSyncStatus === 'error' ? '（失敗）' : ghState.lastSyncStatus && ghState.lastSyncStatus !== 'ok' ? `（${ghState.lastSyncStatus}）` : ''}
            </span>
          </span>
          <span className="banner-spacer" />
          {gh.url && (
            <a className="btn btn-ghost btn-sm" href={gh.url} target="_blank" rel="noreferrer">
              GitHub で開く
            </a>
          )}
          {ghFolder && !viewOnly && (
            <Button size="sm" variant="ghost" onClick={syncGithub} disabled={ghState.syncing}>
              {ghState.syncing ? '同期中…' : '今すぐ同期'}
            </Button>
          )}
        </div>
      )}
      {gh?.kind === 'md' && ghState.conflictAt && Date.now() - ghState.conflictAt < 24 * 3600_000 && (
        <div className="banner banner-warn">
          ほかの場所でも同時に変更されていたため、そちらの内容を採用しました。あなたの変更は編集履歴に残っています。
          <Button size="sm" onClick={() => setHistoryOpen(true)}>
            編集履歴を開く
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setGhState((s) => ({ ...s, conflictAt: null }))}>
            閉じる
          </Button>
        </div>
      )}
      {conflict && (
        <div className="banner banner-warn">
          {conflict.updatedBy ?? '他のユーザー'} がこのページを更新したため、あなたの変更を保存できませんでした。
          <Button size="sm" onClick={onReload}>
            最新版を読み込む（自分の変更を破棄）
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              saver.forceOverwrite(conflict.version);
              setConflict(null);
            }}
          >
            自分の変更で上書き
          </Button>
        </div>
      )}

      {look.cover && (
        <Cover
          cover={look.cover}
          position={look.coverPosition}
          editable={!readOnly}
          onChangeClick={setCoverAnchor}
          onPosition={(coverPosition) => updateLook({ coverPosition })}
        />
      )}
      {coverAnchor && (
        <CoverPicker
          anchor={coverAnchor}
          onClose={() => setCoverAnchor(null)}
          onPick={(cover) => {
            updateLook({ cover, coverPosition: 50 });
            setCoverAnchor(null);
          }}
          onRemove={
            look.cover
              ? () => {
                  updateLook({ cover: null });
                  setCoverAnchor(null);
                }
              : undefined
          }
        />
      )}

      {!ghFile && !commentsOpen && <Toc items={toc} />}
      {!ghFile && !deleted && (
        <>
          <CommentMarks comments={comments.comments} />
          {!reading && <SelectionCommentButton
            onComment={(d) => {
              setCommentDraft(d);
              setCommentsOpen(true);
            }}
          />}
          {commentsOpen && (
            <CommentsPanel
              pageId={page.id}
              comments={comments.comments}
              reload={comments.reload}
              draft={commentDraft}
              setDraft={setCommentDraft}
              focusThread={commentFocus}
              onClose={() => {
                setCommentsOpen(false);
                setCommentDraft(null);
              }}
            />
          )}
        </>
      )}
      <div className={`page-body ${look.cover ? 'has-cover' : ''} ${ghFile ? 'is-file' : ''}`}>
        <div className={`page-head ${icon ? 'has-icon' : ''}`}>
          {icon && (
            <button className="page-icon-large" onClick={(e) => !readOnly && setEmojiAnchor(e.currentTarget)}>
              <IconText icon={icon} size={72} />
            </button>
          )}
          {!readOnly && (
            <div className="page-head-actions">
              {!icon && (
                <button className="btn btn-ghost btn-sm" onClick={(e) => setEmojiAnchor(e.currentTarget)}>
                  <Icon name="smile" size={14} /> アイコンを追加
                </button>
              )}
              {!look.cover && (
                <button className="btn btn-ghost btn-sm" onClick={() => updateLook({ cover: randomGalleryCover(), coverPosition: 50 })}>
                  <Icon name="image" size={14} /> カバーを追加
                </button>
              )}
            </div>
          )}
          <AutoTextarea
            className="page-title"
            placeholder="無題"
            value={title}
            readOnly={titleLocked}
            maxLength={500}
            onChange={(e) => updateTitle(e.target.value.replace(/\n/g, ''))}
            onFocus={() => (titleFocused.current = true)}
            onBlur={() => (titleFocused.current = false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                editorRef.current?.focus();
              }
            }}
          />
          {isTemplate && (
            <div className="template-chip">
              <Icon name="template" size={13} /> テンプレート
              <span className="muted">（新しいページで「テンプレートから始める」に表示されます。{'{{date}}'} は使った日の日付になります）</span>
            </div>
          )}
          <div className="page-meta muted small">
            <span title={formatDateTime(page.createdAt)}>
              作成 {formatDateTime(page.createdAt)}
              {page.createdBy && `（${page.createdBy}）`}
            </span>
            <span className="meta-sep">・</span>
            <span title={formatDateTime(lastEdit.at)}>
              最終編集 {formatRelative(lastEdit.at)}
              {lastEdit.by && `（${lastEdit.by}）`}
            </span>
            {shownCounts && (
              <>
                <span className="meta-sep">・</span>
                <WordCountButton counts={shownCounts} selection={selCounts} />
              </>
            )}
          </div>
        </div>
        {emojiAnchor && (
          <EmojiPicker anchor={emojiAnchor} onPick={updateIcon} onRemove={icon ? () => updateIcon(null) : undefined} onClose={() => setEmojiAnchor(null)} />
        )}

        {offerTemplates && templates.length > 0 && (
          <div className="template-offer">
            <span className="muted small">テンプレートから始める</span>
            <div className="template-offer-list">
              {templates.map((t) => (
                <button key={t.id} className="template-offer-item" onClick={() => void applyTemplate(t)}>
                  <PageIcon icon={t.icon} size={15} /> {t.label ?? (fillTemplateText(t.title).replace(/\s*\d{4}\/\d{2}\/\d{2}$/, '') || '無題')}
                </button>
              ))}
            </div>
          </div>
        )}
        {parentIsDatabase && !deleted && (
          <Suspense fallback={null}>
            <RowProperties databaseId={page.parentId!} rowId={page.id} readOnly={reading} />
          </Suspense>
        )}
        <div className="editor-wrap">
          <Suspense fallback={<Spinner />}>
            {ghFile ? (
              <GithubFileBody
                workspaceId={page.workspaceId}
                path={gh!.path!}
                canEdit={!deleted && !look.locked && !viewOnly && !reading}
                onText={onFileText}
                onSelectionText={onSelectionText}
              />
            ) : collab && !collab.ready ? (
              <Spinner />
            ) : (
              <Editor
                key={collabActive ? 'collab' : 'solo'}
                initialContent={page.content}
                editable={!readOnly && !conflict}
                handleRef={editorRef}
                onDocument={onDocument}
                onSelectionText={onSelectionText}
                linkCandidates={linkCandidates}
                onLinkClick={onLinkClick}
                onFileToPage={async (f) => {
                  // 普通のページなら子ページとして作る（GitHub のフォルダの中には作らない）
                  const id = await importFile(f, gh ? null : page.id, page.visibility === 'private' ? 'private' : 'workspace', ws.current?.id);
                  await ws.reload();
                  toast('ページにしました', 'success');
                  navigate(`/p/${id}`);
                }}
                collab={
                  collabActive
                    ? { provider: collab!.provider, seed: collab!.seed, user: { name: user?.displayName ?? '?', color: userColor(user?.id ?? ''), canEdit: !readOnly } }
                    : undefined
                }
                onChange={(blocks) => {
                  latestBlocks.current = blocks;
                  // 共同編集中は、保存担当の 1 人だけが部屋の内容（全員の編集をまとめたもの）を保存する
                  if (collabActive && !collab!.provider.isSaver()) return;
                  if (gh?.kind === 'md') {
                    const md = toGithub(editorRef.current?.toMarkdown() ?? '', page.workspaceId, gh.path ?? '');
                    if (md === gh.baselineMd) return; // 内容は変わっていない
                    gh.baselineMd = md;
                    saver.queue({ content: blocks, contentText: blocksToText(blocks), markdown: md });
                    schedulePush();
                    return;
                  }
                  saver.queue({ content: blocks, contentText: blocksToText(blocks) });
                }}
              />
            )}
          </Suspense>
        </div>

        {/* GitHub のフォルダには、ページ（Markdown）とフォルダを追加できる */}
        {ghFolder && !deleted && !viewOnly && (
          <div className="github-folder-actions">
            <button className="subpage-add" onClick={() => ws.createPage(page.id)}>
              <Icon name="plus" size={14} /> ページを追加
            </button>
            <button className="subpage-add" onClick={() => void ws.createFolder(page.id)}>
              <Icon name="folder" size={14} /> フォルダを作成
            </button>
          </div>
        )}
        {backlinks.length > 0 && (
          <div className="backlinks">
            <div className="backlinks-title">
              <Icon name="backlink" size={14} /> このページを参照しているページ（{backlinks.length}）
            </div>
            {backlinks.map((b) => (
              <Link key={b.id} to={`/p/${b.id}`} className="subpage-link">
                <PageIcon icon={ws.byId.get(b.id)?.icon ?? b.icon} /> <span>{(ws.byId.get(b.id)?.title ?? b.title) || '無題'}</span>
              </Link>
            ))}
          </div>
        )}
        {isDatabase && !deleted && (
          <Suspense fallback={<Spinner />}>
            <Database pageId={page.id} readOnly={reading} />
          </Suspense>
        )}
        {!deleted && !isDatabase && (children.length > 0 || (!readOnly && gh?.kind !== 'md')) && (
          <Subpages pageId={page.id} title={title} items={children} canAdd={!readOnly && gh?.kind !== 'md'} />
        )}
      </div>
      <SelectionCount counts={selCounts} />
    </div>
  );
}

export default function PageView() {
  const id = pageParam(useParams());
  const ws = useWorkspace();
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const loaded = useRef<{ page: Page | null; key: number }>({ page: null, key: 0 });
  loaded.current = { page, key: reloadKey };
  const lastKey = useRef(reloadKey);
  const wsRef2 = useRef(ws);
  wsRef2.current = ws;

  useEffect(() => {
    // 同じページの ID ⇔ カスタム URL の書き換えだけなら読み込み直さない
    const cur = loaded.current.page;
    if (cur && lastKey.current === reloadKey && (cur.id === id || cur.slug === id || wsRef2.current.byId.get(cur.id)?.slug === id)) return;
    lastKey.current = reloadKey;
    let cancelled = false;
    setPage(null);
    setError('');
    api<{ page: Page }>(`/pages/${id}`)
      .then((r) => prepareGithubPage(r.page))
      .then((p) => !cancelled && setPage(p))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  if (error)
    return (
      <div className="empty-state">
        <h2>ページを開けません</h2>
        <p className="muted">{error}</p>
        <Link to="/" className="btn btn-secondary btn-md">
          ホームへ戻る
        </Link>
      </div>
    );
  // カスタム URL があるページは、アドレスバーもカスタム URL にする
  const navigateTo = useNavigate();
  useEffect(() => {
    if (!page?.slug || !page.workspaceSlug) return;
    // /p/<ID>・/p/<カスタムURL> で開いたときは、/<ワークスペース>/<カスタムURL> に置き換える
    if (window.location.pathname.startsWith('/p/')) navigateTo(`/${page.workspaceSlug}/${page.slug}`, { replace: true });
  }, [page?.id, page?.slug, id]);

  // 別のワークスペースのページを開いたら、そのワークスペースに切り替える
  // （ページを開いた時だけ判定する。開いたまま切り替えた場合に元へ戻さないため）
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const handled = useRef<string | null>(null);
  const wsLoaded = !!ws.workspaces;
  useEffect(() => {
    const w = wsRef.current;
    if (!page || !w.workspaces || handled.current === page.id) return;
    handled.current = page.id;
    if (w.current && page.workspaceId !== w.current.id && w.workspaces.some((x) => x.id === page.workspaceId)) {
      w.switchWorkspace(page.workspaceId);
    }
  }, [page?.id, wsLoaded]);

  // URL が変わった直後は前のページを表示しない（誤って前のページに入力が保存されるのを防ぐ）
  if (!page || (page.id !== id && page.slug !== id && ws.byId.get(page.id)?.slug !== id)) return <Spinner center />;
  return <PageEditor key={`${page.id}:${reloadKey}`} page={page} onReload={() => setReloadKey((k) => k + 1)} />;
}
