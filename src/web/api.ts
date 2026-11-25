export class ApiError extends Error {
  status: number;
  data: any;
  constructor(message: string, status: number, data: any) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let unauthorizedHandler: (() => void) | null = null;
export function onUnauthorized(fn: () => void) {
  unauthorizedHandler = fn;
}

/** サーバーにつながらず、端末に保存した内容を表示しているか（「オフラインです」の表示に使う） */
let offline = false;
const offlineListeners = new Set<(v: boolean) => void>();
function setOffline(v: boolean) {
  if (offline === v) return;
  offline = v;
  offlineListeners.forEach((l) => l(v));
}
export const isOffline = () => offline;
export function onOfflineChange(fn: (v: boolean) => void) {
  offlineListeners.add(fn);
  return () => void offlineListeners.delete(fn);
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    setOffline(true);
    throw new ApiError('サーバーにつながりません。電波の状態を確かめてください', 0, null);
  }
  setOffline(res.headers.get('X-Offline-Cache') === '1');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) unauthorizedHandler?.();
    throw new ApiError(data?.error ?? `エラーが発生しました (${res.status})`, res.status, data);
  }
  return data as T;
}

export async function uploadFile(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/files', { method: 'POST', body: form, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data?.error ?? 'アップロードに失敗しました', res.status, data);
  // ファイルの中の文字を、検索のために記録しておく（裏で行う。失敗しても気にしない）
  void recordFileText(file, data.id as string);
  return data.url as string;
}

async function recordFileText(file: File, id: string) {
  try {
    const { canExtract, extractFileText } = await import('./workspace/fileText');
    if (!canExtract(file.name)) return;
    const text = (await extractFileText(file))?.trim();
    if (!text) return;
    await fetch(`/api/files/${id}/text`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  } catch {
    // 文字を取り出せないファイルは、検索の対象にしない
  }
}

export type User = {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  status: 'pending' | 'active' | 'disabled';
  createdAt: number;
  lastLoginAt: number | null;
  avatarUrl: string | null;
  avatarEmoji: string | null;
  avatarColor: string | null;
  theme: Theme;
};

export type Theme = 'system' | 'light' | 'dark';

export type PageSummary = {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  visibility: 'workspace' | 'private';
  position: number;
  updatedAt: number;
  isPublic?: boolean;
  /** データベースのページか（子ページが行になる） */
  isDatabase?: boolean;
  cover?: string | null;
  /** このページに対する自分の権限 */
  access?: Access;
  /** サイドバーの区分（全員に共有 / 自分のページ / 共有されたページ） */
  section?: 'workspace' | 'private' | 'shared';
  /** カスタム URL（/p/<slug>, /share/<slug>） */
  slug?: string | null;
  /** GitHub と同期しているページの種類（リポジトリ・フォルダ・Markdown・その他のファイル） */
  githubKind?: 'root' | 'dir' | 'md' | 'file' | null;
  /** GitHub 上のパス（リンクの解決に使う） */
  githubPath?: string | null;
};

export type Access = 'view' | 'edit' | 'full';

export type PageFont = 'default' | 'serif' | 'mono' | 'mushin';

export type PageAppearance = {
  cover: string | null;
  coverPosition: number;
  fullWidth: boolean;
  smallText: boolean;
  font: PageFont;
  /** スライドで表示するときのテーマ（null = 標準） */
  slideTheme: string | null;
};

export type Page = PageSummary & PageAppearance & {
  /** テンプレートにしたページか */
  isTemplate?: boolean;
  locked: boolean;
  workspaceId: string;
  workspaceAccess: 'view' | 'edit';
  workspaceSlug?: string;
  content: any[];
  version: number;
  ownerId: string;
  isOwner: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: number;
  deletedAt: number | null;
  favorite: boolean;
  /** GitHub と同期しているページ */
  github: {
    kind: 'root' | 'dir' | 'md' | 'file';
    path: string | null;
    /** 画面側で変換し直す必要がある Markdown（不要なら null） */
    sourceMd: string | null;
    mdRev: number;
    contentMdRev: number;
    dirty: boolean;
    conflictAt: number | null;
    url: string | null;
    /** ワークスペースと GitHub の最終同期の時刻・結果（ok / 残り n 件 / error） */
    lastSyncAt?: number | null;
    lastSyncStatus?: string | null;
    /** 画面側で使う：開いたときの内容の Markdown（変わっていなければ GitHub に送らない） */
    baselineMd?: string;
  } | null;
};

export type Passkey = {
  id: string;
  name: string;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
};

export type SessionInfo = {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string;
  userAgent: string;
  current?: boolean;
  expiresAt?: number;
};

export type RegistrationLink = { id: string; url: string; expiresAt: number; purpose: 'invite' | 'recovery' };

export type AuditLog = {
  id: number;
  at: number;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_name: string | null;
  detail: string | null;
  ip: string | null;
};

export type Workspace = {
  id: string;
  name: string;
  iconEmoji: string | null;
  iconUrl: string | null;
  iconColor: string | null;
  /** URL 名（https://<host>/<slug>/<ページの URL>） */
  slug: string;
  /** 「プライベート」のページを使うか */
  privatePages?: boolean;
  createdAt: number;
  role: 'owner' | 'admin' | 'member' | 'viewer' | 'guest' | null;
  memberCount?: number;
  pageCount?: number;
  owners?: string | null;
};
