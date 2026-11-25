/**
 * 実行環境（Node.js / Cloudflare Workers）ごとに一度だけ初期化される設定。
 * Node.js では process.env、Workers では env バインディングから作られる。
 */
export type Config = {
  ORIGIN: string;
  RP_ID: string;
  SECURE_COOKIE: boolean;
  SESSION_COOKIE: string;
  MAX_UPLOAD_BYTES: number;
  INITIAL_ADMIN_USERNAME: string;
  /** 本の表紙を Google Books から取るための鍵（なくても動く。`wrangler secret put GOOGLE_BOOKS_API_KEY`） */
  GOOGLE_BOOKS_API_KEY?: string;
  /**
   * 開発用ログイン（パスキーなしでログインできる）。DEV_LOGIN=1 で、しかも ORIGIN が localhost の http のときだけ有効。
   * 本番（https・localhost 以外）では、環境変数があっても有効にならない
   */
  DEV_LOGIN: boolean;
};

export const cfg = {} as Config;

export function initConfig(env: Record<string, unknown>, defaultOrigin: string) {
  const str = (k: string) => (typeof env[k] === 'string' && env[k] !== '' ? (env[k] as string) : undefined);
  const origin = (str('ORIGIN') ?? defaultOrigin).replace(/\/+$/, '');
  cfg.ORIGIN = origin;
  cfg.RP_ID = str('RP_ID') ?? new URL(origin).hostname;
  cfg.SECURE_COOKIE = origin.startsWith('https://');
  cfg.SESSION_COOKIE = cfg.SECURE_COOKIE ? '__Host-session' : 'session';
  cfg.MAX_UPLOAD_BYTES = Number(str('MAX_UPLOAD_MB') ?? 20) * 1024 * 1024;
  cfg.INITIAL_ADMIN_USERNAME = str('ADMIN_USERNAME') ?? 'admin';
  cfg.GOOGLE_BOOKS_API_KEY = str('GOOGLE_BOOKS_API_KEY');
  const host = new URL(origin).hostname;
  cfg.DEV_LOGIN = str('DEV_LOGIN') === '1' && !cfg.SECURE_COOKIE && (host === 'localhost' || host === '127.0.0.1' || host === '[::1]');
}
