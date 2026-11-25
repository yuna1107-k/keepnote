import { UI_ICON_CODEPOINTS } from './uiIconCodepoints';
import type { IconName } from './uiIcons';

export type { IconName } from './uiIcons';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

// ---------- アイコン（lucide 風の線画） ----------

/** 画面の部品のアイコン（Google の Material Symbols。使う分だけを抜き出したフォントで表示する） */
export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <span className={`ui-icon ${className ?? ''}`} aria-hidden="true" style={{ fontSize: size, width: size, height: size }}>
      {String.fromCodePoint(UI_ICON_CODEPOINTS[name]!)}
    </span>
  );
}

// ---------- ボタン ----------

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
};

export function Button({ variant = 'secondary', size = 'md', loading, className = '', children, disabled, ...rest }: BtnProps) {
  return (
    <button className={`btn btn-${variant} btn-${size} ${className}`} disabled={disabled || loading} {...rest}>
      {loading && <span className="spinner spinner-sm" />}
      {children}
    </button>
  );
}

export function Spinner({ center }: { center?: boolean }) {
  return center ? (
    <div className="center-fill">
      <span className="spinner" />
    </div>
  ) : (
    <span className="spinner" />
  );
}

// ---------- モーダル ----------

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 480,
  className = '',
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: number;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className}`} style={{ maxWidth: width }} role="dialog" aria-modal="true">
        {title && (
          <div className="modal-header">
            <h2>{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="閉じる">
              <Icon name="x" />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ---------- トースト & 確認ダイアログ ----------

type Toast = { id: number; message: string; kind: 'info' | 'error' | 'success' };
type ConfirmOpts = {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  requireText?: string;
};

type UiCtx = {
  toast: (message: string, kind?: Toast['kind']) => void;
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
};

const UiContext = createContext<UiCtx | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmState, setConfirmState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState('');
  const seq = useRef(0);

  const toast = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);

  const confirm = useCallback((opts: ConfirmOpts) => {
    setTyped('');
    return new Promise<boolean>((resolve) => setConfirmState({ ...opts, resolve }));
  }, []);

  const close = (v: boolean) => {
    confirmState?.resolve(v);
    setConfirmState(null);
  };

  return (
    <UiContext.Provider value={{ toast, confirm }}>
      {children}
      {createPortal(
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.kind}`}>
              {t.message}
            </div>
          ))}
        </div>,
        document.body,
      )}
      <Modal open={!!confirmState} onClose={() => close(false)} title={confirmState?.title} width={440}>
        {confirmState && (
          <form
            className="modal-body"
            onSubmit={(e) => {
              e.preventDefault();
              if (!confirmState.requireText || typed === confirmState.requireText) close(true);
            }}
          >
            {confirmState.message && <div className="confirm-message">{confirmState.message}</div>}
            {confirmState.requireText && (
              <label className="field">
                <span>
                  確認のため <code>{confirmState.requireText}</code> と入力してください
                </span>
                <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
              </label>
            )}
            <div className="modal-actions">
              <Button type="button" variant="ghost" onClick={() => close(false)}>
                キャンセル
              </Button>
              <Button
                type="submit"
                variant={confirmState.danger ? 'danger' : 'primary'}
                autoFocus={!confirmState.requireText}
                disabled={!!confirmState.requireText && typed !== confirmState.requireText}
              >
                {confirmState.confirmLabel ?? 'OK'}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </UiContext.Provider>
  );
}

export function useUi() {
  const v = useContext(UiContext);
  if (!v) throw new Error('UiProvider がありません');
  return v;
}

// ---------- ドロップダウンメニュー ----------

export type MenuItem = { label: string; icon?: IconName; onClick: () => void; danger?: boolean; disabled?: boolean } | 'divider';

/**
 * 浮かぶメニュー・パネルの位置を、実際の大きさを測ってから決める（画面の外にはみ出さないように）。
 * 下に入らなければボタンの上に出し、それでも入らなければ画面内に収めてスクロールできるようにする。
 */
function useFloatingPosition(ref: React.RefObject<HTMLDivElement | null>, anchor: HTMLElement | null, align: 'left' | 'right', gap: number) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const margin = 8;
      el.style.maxHeight = `${vh - margin * 2}px`;
      el.style.overflowY = 'auto';
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let top = r.bottom + gap;
      if (top + h > vh - margin) {
        const above = r.top - gap - h;
        top = above >= margin ? above : Math.max(margin, vh - margin - h);
      }
      let left = align === 'right' ? r.right - w : r.left;
      left = Math.max(margin, Math.min(left, vw - margin - w));
      el.style.top = `${top}px`;
      el.style.left = `${left}px`;
      el.style.right = 'auto';
      el.style.visibility = 'visible';
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  });
}

export function Menu({
  anchor,
  items,
  onClose,
  align = 'left',
}: {
  anchor: HTMLElement | null;
  items: MenuItem[];
  onClose: () => void;
  align?: 'left' | 'right';
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);
  useFloatingPosition(ref, anchor, align, 4);
  if (!anchor) return null;
  return createPortal(
    // 大きさを測ってから位置を決めるまでは見せない
    <div ref={ref} className="menu" style={{ top: 0, left: 0, visibility: 'hidden' }} role="menu">
      {items.map((item, i) =>
        item === 'divider' ? (
          <div key={i} className="menu-divider" />
        ) : (
          <button
            key={i}
            className={`menu-item ${item.danger ? 'danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            {item.icon && <Icon name={item.icon} />}
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

// ---------- ポップオーバー（任意の中身を持つ浮動パネル） ----------

export function Popover({
  anchor,
  onClose,
  children,
  align = 'left',
  width = 320,
  className = '',
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  align?: 'left' | 'right';
  width?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      // 中で開いたメニュー・モーダル等の操作では閉じない
      if ((t as HTMLElement).closest?.('.menu, .modal-backdrop, .emoji-picker')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);
  useFloatingPosition(ref, anchor, align, 6);
  if (!anchor) return null;
  const w = Math.min(width, window.innerWidth - 16);
  return createPortal(
    <div ref={ref} className={`popover ${className}`} style={{ top: 0, left: 0, width: w, visibility: 'hidden' }}>
      {children}
    </div>,
    document.body,
  );
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

// ---------- ユーティリティ ----------

export function formatDateTime(ms: number | null | undefined) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 相対時刻の表示を定期的に更新するための再描画タイマー */
export function useNow(intervalMs = 30_000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
}

export function formatRelative(ms: number | null | undefined) {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  // 端末とサーバーの時計のずれ（数分以内）は「たった今」として扱う
  if (diff < 60_000 && diff > -5 * 60_000) return 'たった今';
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '前' : '後';
  if (abs < 3600_000) return `${Math.floor(abs / 60_000)}分${suffix}`;
  if (abs < 86400_000) return `${Math.floor(abs / 3600_000)}時間${suffix}`;
  if (abs < 30 * 86400_000) return `${Math.floor(abs / 86400_000)}日${suffix}`;
  return formatDateTime(ms);
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function describeUserAgent(ua: string) {
  if (!ua) return '不明なデバイス';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '不明なOS';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'ブラウザ';
  return `${br} / ${os}`;
}

export function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
      <Button
        variant="primary"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} />
        {copied ? 'コピー済み' : 'コピー'}
      </Button>
    </div>
  );
}

export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  const ch = (name || '?').trim().charAt(0).toUpperCase();
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.5, background: `hsl(${hue} 45% 52%)` }}>
      {ch}
    </span>
  );
}

export const AVATAR_COLORS = ['#e16259', '#d9730d', '#dfab01', '#4d9a6a', '#0b8a8a', '#2383e2', '#6940a5', '#ad1a72', '#9a6b3f', '#5f6368'];

type AvatarUser = { displayName: string; avatarUrl?: string | null; avatarEmoji?: string | null; avatarColor?: string | null };

/** ユーザーのアイコン（画像 → 絵文字 → 頭文字の順に表示） */
export function UserAvatar({ user, size = 22, className = '' }: { user: AvatarUser | null | undefined; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const name = user?.displayName ?? '?';
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  const bg = user?.avatarColor ?? `hsl(${Math.abs(hash) % 360} 45% 52%)`;
  const radius = Math.max(4, Math.round(size * 0.22));
  const style = { width: size, height: size, borderRadius: radius };
  useEffect(() => setBroken(false), [user?.avatarUrl]);

  if (user?.avatarUrl && !broken) {
    return <img className={`avatar avatar-img ${className}`} src={user.avatarUrl} alt="" style={style} onError={() => setBroken(true)} />;
  }
  if (user?.avatarEmoji) {
    const sym = parseSymbol(user.avatarEmoji);
    return (
      <span className={`avatar ${className}`} style={{ ...style, background: user.avatarColor ?? 'var(--bg-hover)', fontSize: size * 0.6 }}>
        {sym ? <SymbolGlyph name={sym.name} size={Math.round(size * 0.7)} color={user.avatarColor ? '#fff' : (sym.color ?? 'var(--text)')} /> : user.avatarEmoji}
      </span>
    );
  }
  return (
    <span className={`avatar ${className}`} style={{ ...style, background: bg, fontSize: size * 0.5 }}>
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export function WorkspaceIcon({ ws, size = 22 }: { ws: { name: string; iconUrl?: string | null; iconEmoji?: string | null; iconColor?: string | null } | null | undefined; size?: number }) {
  return (
    <UserAvatar
      user={ws ? { displayName: ws.name, avatarUrl: ws.iconUrl, avatarEmoji: ws.iconEmoji, avatarColor: ws.iconColor } : null}
      size={size}
      className="ws-icon"
    />
  );
}

/** 画像を中央で正方形に切り抜き、size×size に縮小する（アイコン用） */
export async function squareImage(file: File, size = 256): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  const toBlob = (type: string) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.9));
  // WebP に対応していないブラウザ（一部 Safari）では PNG になるため JPEG にする
  let blob = await toBlob('image/webp');
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg');
  if (!blob) throw new Error('画像の変換に失敗しました');
  return new File([blob], blob.type === 'image/webp' ? 'avatar.webp' : 'avatar.jpg', { type: blob.type });
}

/**
 * Google のアイコン（Material Symbols）は「ms:アイコン名」または「ms:アイコン名:色（6 桁の 16 進）」で保存する。
 * それ以外の文字列は絵文字として表示する。
 */
export function parseSymbol(icon: string | null | undefined): { name: string; color: string | null } | null {
  const m = icon && /^ms:([a-z0-9_]{1,60})(?::([0-9a-f]{6}))?$/.exec(icon);
  return m ? { name: m[1]!, color: m[2] ? `#${m[2]}` : null } : null;
}

export function makeSymbol(name: string, color: string | null) {
  return color ? `ms:${name}:${color.replace('#', '').toLowerCase()}` : `ms:${name}`;
}

/** Material Symbols の 1 文字（フォントの合字でアイコンになる） */
export function SymbolGlyph({ name, size, color }: { name: string; size: number; color?: string | null }) {
  return (
    <span className="material-symbols-outlined ms-glyph" aria-hidden="true" style={{ fontSize: size, width: size, height: size, color: color ?? undefined }}>
      {name}
    </span>
  );
}

/** 絵文字または Google のアイコン */
export function IconText({ icon, size }: { icon: string; size: number }) {
  const sym = parseSymbol(icon);
  return sym ? <SymbolGlyph name={sym.name} size={size} color={sym.color} /> : <>{icon}</>;
}

export function PageIcon({ icon, size = 16 }: { icon: string | null; size?: number }) {
  if (icon) {
    const sym = parseSymbol(icon);
    if (sym) return <SymbolGlyph name={sym.name} size={Math.round(size * 1.15)} color={sym.color ?? 'var(--text-muted)'} />;
    return <span className="page-emoji" style={{ fontSize: size }}>{icon}</span>;
  }
  return <Icon name="file" size={size} className="page-default-icon" />;
}
