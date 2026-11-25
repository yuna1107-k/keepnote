import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Page, type PageSummary, type Workspace } from '../api';
import { useAuth } from '../auth/AuthContext';
import { useUi } from '../ui';

/** 表示中に、ページの一覧を読み直す間隔 */
const POLL_MS = 20_000;
/** お知らせの接続（liveWorkspace.ts）がつながっている間は、読み直しの間隔を延ばす */
const POLL_LIVE_MS = 120_000;
/** 手元で変えた名前を、読み直しても残しておく時間 */
const LOCAL_EDIT_MS = 10_000;

type WorkspaceState = {
  loaded: boolean;
  /** 所属ワークスペース一覧（未取得なら null） */
  workspaces: Workspace[] | null;
  current: Workspace | null;
  canCreateWorkspace: boolean;
  /** ページの作成・削除・取り込みができるか（閲覧者は不可） */
  canContribute: boolean;
  switchWorkspace: (id: string) => void;
  reloadWorkspaces: () => Promise<Workspace[]>;
  pages: PageSummary[];
  favorites: string[];
  byId: Map<string, PageSummary>;
  childrenOf: (parentId: string | null, section?: Section) => PageSummary[];
  ancestors: (id: string) => PageSummary[];
  /** URL のパラメータ（ID またはカスタム URL）からページ ID を得る */
  resolveId: (param: string | undefined) => string | undefined;
  reload: () => Promise<void>;
  createPage: (parentId: string | null, visibility?: 'workspace' | 'private') => Promise<void>;
  /** 今日のノートを開く（「日記」ページの下に、なければ作る） */
  openToday: () => Promise<void>;
  createFolder: (parentId: string) => Promise<void>;
  patchLocal: (id: string, patch: Partial<PageSummary>) => void;
  setFavorite: (id: string, favorite: boolean) => Promise<void>;
  trashPage: (id: string) => Promise<void>;
  movePage: (id: string, parentId: string | null, visibility?: 'workspace' | 'private', beforeId?: string | null) => Promise<void>;
  ui: {
    searchOpen: boolean;
    setSearchOpen: (v: boolean) => void;
    trashOpen: boolean;
    setTrashOpen: (v: boolean) => void;
    moveTarget: string | null;
    setMoveTarget: (id: string | null) => void;
    /** 重ねて開いているページ（後ろほど上） */
    peek: string[];
    openPeek: (id: string) => void;
    closePeek: (all?: boolean) => void;
  };
};

type Section = 'workspace' | 'private' | 'shared';

export function sectionOf(p: PageSummary): Section {
  return p.section ?? (p.visibility === 'workspace' ? 'workspace' : 'private');
}

/** ページの URL（カスタム URL があればそれを使う） */
/** URL の末尾（パラメータ）から、ページ ID かカスタム URL を取り出す */
export function pageParam(params: Record<string, string | undefined>) {
  return params.subId ?? params.pageSlug ?? params.id;
}

/** ページの URL：カスタム URL があれば /<ワークスペースのURL名>/<ページのURL>、なければ /p/<ID> */
export const pagePath = (p: { id: string; slug?: string | null }, wsSlug?: string | null) =>
  p.slug && wsSlug ? `/${wsSlug}/${p.slug}` : `/p/${p.id}`;

export const canEdit = (p: { access?: string } | undefined) => !p?.access || p.access === 'edit' || p.access === 'full';

const Ctx = createContext<WorkspaceState | null>(null);

/** 直前に読み込んだ内容（ログアウト時は AuthContext の再読み込みで作り直される） */
const cache: { workspaces: Workspace[] | null; canCreate: boolean; pages: PageSummary[]; favorites: string[]; loaded: boolean } = {
  workspaces: null,
  canCreate: false,
  pages: [],
  favorites: [],
  loaded: false,
};

export function clearWorkspaceCache() {
  cache.workspaces = null;
  cache.pages = [];
  cache.favorites = [];
  cache.loaded = false;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  // 画面の切り替えでプロバイダが作り直されても、直前の内容をすぐ表示する（読み込み中に「なし」と出さない）
  const [pages, setPagesState] = useState<PageSummary[]>(() => cache.pages);
  const [favorites, setFavoritesState] = useState<string[]>(() => cache.favorites);
  const [loaded, setLoaded] = useState(() => cache.loaded);
  const setPages = (v: PageSummary[] | ((p: PageSummary[]) => PageSummary[])) => {
    setPagesState((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      cache.pages = next;
      return next;
    });
  };
  const setFavorites = (v: string[] | ((f: string[]) => string[])) => {
    setFavoritesState((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      cache.favorites = next;
      return next;
    });
  };
  const [searchOpen, setSearchOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  // ページの中から別のページを開くときは、画面を重ねて開く（GitHub の issue のように）
  // 手元で名前・アイコンを変えた時刻（読み直しで、保存前の古い値に戻さないため）
  const localEdits = useRef(new Map<string, number>());
  const [peek, setPeek] = useState<string[]>([]);
  const pushPeek = useCallback((id: string) => setPeek((s) => (s[s.length - 1] === id ? s : [...s.filter((x) => x !== id), id])), []);
  const closePeek = useCallback((all?: boolean) => setPeek((s) => (all ? [] : s.slice(0, -1))), []);
  const [workspaces, setWorkspacesState] = useState<Workspace[] | null>(() => cache.workspaces);
  const [canCreateWorkspace, setCanCreateState] = useState(() => cache.canCreate);
  const setWorkspaces = (v: Workspace[]) => {
    cache.workspaces = v;
    setWorkspacesState(v);
  };
  const setCanCreate = (v: boolean) => {
    cache.canCreate = v;
    setCanCreateState(v);
  };
  const [currentId, setCurrentId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('workspace');
    } catch {
      return null;
    }
  });
  const navigate = useNavigate();
  const { toast } = useUi();
  const isAdmin = useAuth().user?.role === 'admin';

  const current = workspaces?.find((w) => w.id === currentId) ?? workspaces?.[0] ?? null;
  const currentWsId = current?.id ?? null;

  const reloadWorkspaces = useCallback(async () => {
    const data = await api<{ workspaces: Workspace[]; canCreate: boolean }>('/workspaces');
    setWorkspaces(data.workspaces);
    setCanCreate(data.canCreate);
    return data.workspaces;
  }, []);

  const switchWorkspace = useCallback((id: string) => {
    setCurrentId(id);
    setLoaded(false);
    try {
      localStorage.setItem('workspace', id);
    } catch {
      /* ignore */
    }
  }, []);

  const reload = useCallback(async () => {
    if (!currentWsId) {
      setPages([]);
      setFavorites([]);
      setLoaded(true);
      return;
    }
    const data = await api<{ pages: PageSummary[]; favorites: string[] }>(`/pages?workspace=${encodeURIComponent(currentWsId)}`);
    // 入力したばかりの名前・アイコンは、まだ保存が届いていないことがあるので、少しの間は手元の値を残す
    const now = Date.now();
    setPages((prev) => {
      const recent = new Map(prev.filter((p) => (localEdits.current.get(p.id) ?? 0) > now - LOCAL_EDIT_MS).map((p) => [p.id, p]));
      return recent.size ? data.pages.map((p) => (recent.has(p.id) ? { ...p, title: recent.get(p.id)!.title, icon: recent.get(p.id)!.icon } : p)) : data.pages;
    });
    setFavorites(data.favorites);
    cache.loaded = true;
    setLoaded(true);
  }, [currentWsId]);

  useEffect(() => {
    reloadWorkspaces().catch((e) => toast(e.message, 'error'));
  }, [reloadWorkspaces, toast]);

  useEffect(() => {
    if (!workspaces) return;
    reload().catch((e) => toast(e.message, 'error'));
    // 他のタブ・端末・ユーザーの変更（名前の変更など）を拾うため、フォーカスしたとき・表示に戻ったときと、表示中は定期的に読み直す
    let last = Date.now();
    const onFocus = () => {
      last = Date.now();
      reload().catch(() => {});
    };
    const onVisible = () => document.visibilityState === 'visible' && onFocus();
    // お知らせがつながっていれば、念のためにたまに読み直すだけにする
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - last >= (liveRef.current ? POLL_LIVE_MS : POLL_MS) - 1000) onFocus();
    }, POLL_MS);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload, toast, workspaces]);

  // ページが変わったお知らせ（ほかの人・端末・タブでの名前の変更など）を受け取ったら、すぐ読み直す（liveWorkspace.ts）
  const liveRef = useRef(false);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (!currentWsId || typeof WebSocket === 'undefined') return;
    let socket: WebSocket | null = null;
    let stopped = false;
    let opened = false;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void reloadRef.current().catch(() => {}), 300);
    };
    const connect = () => {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/workspaces/${encodeURIComponent(currentWsId)}/live`);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        // つなぎ直したときは、切れていた間の変更を拾う
        if (opened) refresh();
        opened = true;
        failures = 0;
        liveRef.current = true;
      };
      socket.onmessage = (ev) => {
        // 先頭 1 バイトが 3 ならお知らせ（collab.ts の MSG_SIGNAL）。ほかは共同編集用なので使わない
        if (ev.data instanceof ArrayBuffer && new Uint8Array(ev.data)[0] === 3) refresh();
      };
      socket.onclose = (ev) => {
        liveRef.current = false;
        if (stopped) return;
        failures++;
        // 一度もつながらない環境（Node 版など）では、あきらめて定期的な読み直しに任せる
        if (!opened && failures >= 3) return;
        retry = setTimeout(connect, ev.code === 4000 ? 300 : Math.min(30_000, 1000 * 2 ** failures));
      };
    };
    connect();
    return () => {
      stopped = true;
      liveRef.current = false;
      clearTimeout(retry);
      clearTimeout(debounce);
      socket?.close();
    };
  }, [currentWsId]);

  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);

  const childrenOf = useCallback(
    (parentId: string | null, section?: Section) =>
      pages
        .filter((p) => (parentId ? p.parentId === parentId : !p.parentId || !byId.has(p.parentId)) && (!section || sectionOf(p) === section))
        .sort(
          // 「Journal 2026」などの日記のページの下は、名前の逆順（＝新しい日付が上）に並べる
          parentId && isJournal(byId.get(parentId)?.title)
            ? (a, b) => journalOrder(a.title, b.title) || a.position - b.position
            : (a, b) => a.position - b.position,
        ),
    [pages, byId],
  );

  const resolveId = useCallback(
    (param: string | undefined) => {
      if (!param) return undefined;
      if (byId.has(param)) return param;
      // URL をその場で書き換えた直後は、ルーターのパラメータが古いままのことがあるので、アドレスバーの値も見る
      const live = window.location.pathname.split('/').filter(Boolean).pop();
      return pages.find((p) => p.slug === param || (live && p.slug === live))?.id ?? param;
    },
    [byId, pages],
  );

  // 全画面で開いているページは重ねずに、重ねたものを閉じてそのページに戻る（同じページを 2 重に開かない）
  const openPeek = useCallback(
    (id: string) => {
      const last = window.location.pathname.split('/').filter(Boolean).pop();
      let param = last;
      try {
        param = last && decodeURIComponent(last);
      } catch {
        /* そのまま使う */
      }
      if (resolveId(param) === id) setPeek([]);
      else pushPeek(id);
    },
    [resolveId, pushPeek],
  );

  const ancestors = useCallback(
    (id: string) => {
      const chain: PageSummary[] = [];
      let cur = byId.get(id);
      const seen = new Set<string>();
      while (cur?.parentId && !seen.has(cur.parentId)) {
        seen.add(cur.parentId);
        const parent = byId.get(cur.parentId);
        if (!parent) break;
        chain.unshift(parent);
        cur = parent;
      }
      return chain;
    },
    [byId],
  );

  const createPage = useCallback(
    async (parentId: string | null, visibility: 'workspace' | 'private' = 'workspace') => {
      try {
        const { page } = await api<{ page: Page }>('/pages', { body: { parentId, visibility, workspaceId: currentWsId } });
        setPages((ps) => [...ps, { ...page, position: Number.MAX_SAFE_INTEGER }]);
        reload().catch(() => {});
        navigate(`/p/${page.id}`);
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    },
    [navigate, reload, toast, currentWsId],
  );

  const todayBusy = useRef(false);
  const openToday = useCallback(async () => {
    if (todayBusy.current || !currentWsId) return;
    todayBusy.current = true;
    try {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      // 例：2026/11/06 Fri（前の形式「2026年11月6日（金）」のページがあれば、それを開く）
      const title = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]}`;
      const oldTitle = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${'日月火水木金土'[d.getDay()]}）`;
      const latest = (await api<{ pages: PageSummary[] }>(`/pages?workspace=${encodeURIComponent(currentWsId)}`)).pages;
      // 「日記」は自分だけのページにする（プライベートが使えないワークスペースでは全員に共有）
      let diary = latest.find((p) => p.parentId === null && p.title === '日記' && p.access !== 'view');
      if (!diary) {
        const visibility = current?.privatePages ? 'private' : 'workspace';
        diary = (await api<{ page: Page }>('/pages', { body: { parentId: null, visibility, title: '日記', icon: '📔', workspaceId: currentWsId, font: 'mushin' } })).page;
      }
      let today = latest.find((p) => p.parentId === diary!.id && (p.title === title || p.title === oldTitle));
      // 日記は無心の文字にする（ふつうのページの標準はそのまま）
      if (!today) today = (await api<{ page: Page }>('/pages', { body: { parentId: diary.id, title, workspaceId: currentWsId, font: 'mushin' } })).page;
      await reload().catch(() => {});
      navigate(`/p/${today.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      todayBusy.current = false;
    }
  }, [currentWsId, navigate, reload, toast, current?.privatePages]);

  /** GitHub と同期しているフォルダの下に、新しいフォルダを作る */
  const createFolder = useCallback(
    async (parentId: string) => {
      try {
        const { page } = await api<{ page: Page }>('/pages', { body: { parentId, folder: true, title: '', workspaceId: currentWsId } });
        await reload();
        navigate(`/p/${page.id}`);
        toast('フォルダを作成しました。タイトルを変えると、フォルダの名前も変わります', 'success');
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    },
    [navigate, reload, toast, currentWsId],
  );

  const patchLocal = useCallback((id: string, patch: Partial<PageSummary>) => {
    if ('title' in patch || 'icon' in patch) localEdits.current.set(id, Date.now());
    setPages((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const setFavorite = useCallback(
    async (id: string, favorite: boolean) => {
      setFavorites((f) => (favorite ? [...f.filter((x) => x !== id), id] : f.filter((x) => x !== id)));
      try {
        await api(`/pages/${id}/favorite`, { method: favorite ? 'PUT' : 'DELETE' });
      } catch (e) {
        toast((e as Error).message, 'error');
        reload();
      }
    },
    [reload, toast],
  );

  const trashPage = useCallback(
    async (id: string) => {
      try {
        await api(`/pages/${id}`, { method: 'DELETE' });
        toast('ゴミ箱に移動しました');
        await reload();
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    },
    [reload, toast],
  );

  const movePage = useCallback(
    async (id: string, parentId: string | null, visibility?: 'workspace' | 'private', beforeId?: string | null) => {
      try {
        const page = byId.get(id);
        if (!page || (page.parentId ?? null) !== parentId || (visibility && page.visibility !== visibility)) {
          const r = await api<{ needsMarkdown?: boolean }>(`/pages/${id}/move`, { body: { parentId, visibility } });
          // GitHub のフォルダへ移した普通のページは、本文を Markdown にして GitHub に追加する
          if (r.needsMarkdown) await import('./githubMd').then((m) => m.convertPageToGithub(id));
        }
        if (beforeId !== undefined) {
          await api(`/pages/${id}/reorder`, { body: { beforeId } });
        }
        await reload();
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    },
    [byId, reload, toast],
  );

  const value: WorkspaceState = {
    loaded,
    workspaces,
    current,
    canCreateWorkspace,
    canContribute: !!current && current.role !== 'guest' && (current.role !== 'viewer' || isAdmin),
    switchWorkspace,
    reloadWorkspaces,
    pages,
    favorites,
    byId,
    childrenOf,
    ancestors,
    resolveId,
    reload,
    createPage,
    openToday,
    createFolder,
    patchLocal,
    setFavorite,
    trashPage,
    movePage,
    ui: { searchOpen, setSearchOpen, trashOpen, setTrashOpen, moveTarget, setMoveTarget, peek, openPeek, closePeek },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace() {
  const v = useContext(Ctx);
  if (!v) throw new Error('WorkspaceProvider がありません');
  return v;
}

/** 日記のまとめページか（「Journal 2026」のように Journal で始まる名前） */
export const isJournal = (title: string | null | undefined) => /^\s*journal\b/i.test(title ?? '');
/** 日記の並び：日付で始まるページを新しい順に先に、それ以外はその下に名前の順 */
function journalOrder(a: string, b: string) {
  const da = /^\s*\d{4}/.test(a);
  const db = /^\s*\d{4}/.test(b);
  if (da !== db) return da ? -1 : 1;
  return da ? b.localeCompare(a, 'ja', { numeric: true }) : a.localeCompare(b, 'ja', { numeric: true });
}

export function pageTitle(p: { title: string } | undefined | null) {
  return p?.title?.trim() || '無題';
}
