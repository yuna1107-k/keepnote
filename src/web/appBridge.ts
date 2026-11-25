/**
 * Android アプリの中で開かれているときの連携。
 * アプリは WebView の User-Agent に「KeepnoteApp/<版>」を付け、window.Keepnote を用意する。
 */
type Bridge = { back?: () => void; openPage?: (id: string) => void; pageChanged?: (id: string, title: string) => void; themeChanged?: (theme: string) => void; login?: () => void };

export const inApp = typeof navigator !== 'undefined' && /KeepnoteApp\//.test(navigator.userAgent);

const bridge = () => (window as unknown as { Keepnote?: Bridge }).Keepnote;

/** アプリの一覧の画面に戻る */
export function nativeBack() {
  const b = bridge();
  if (b?.back) b.back();
  else history.back();
}

/** 開いているページをアプリに知らせる（タイトルの表示・最近開いたページに使う） */
export function notifyPage(id: string, title: string) {
  try {
    bridge()?.pageChanged?.(id, title);
  } catch {
    // アプリが古いなどで使えなければ何もしない
  }
}

/** テーマ（システム・ライト・ダーク）を変えたら、アプリの画面も合わせる */
export function notifyTheme(theme: string) {
  try {
    bridge()?.themeChanged?.(theme);
  } catch {
    // アプリが古いなどで使えなければ何もしない
  }
}

/** アプリの中では、ログインはアプリのパスキーの画面で行う（結果は app-login-error の合図で返ってくる。成功したらアプリが画面を切り替える） */
export const canNativeLogin = () => inApp && typeof bridge()?.login === 'function';
export function nativeLogin() {
  bridge()?.login?.();
}
