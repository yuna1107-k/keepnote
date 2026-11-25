/**
 * 「ホーム画面に追加」の合図を受け取っておく。
 * 合図はページを開いた直後に一度だけ届くので、起動時に読み込む（設定画面を開いたときでは間に合わない）。
 */
export type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as InstallPrompt;
  listeners.forEach((l) => l());
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  listeners.forEach((l) => l());
});

export const installPrompt = () => deferred;
export function useInstallPrompt(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
export async function promptInstall() {
  const d = deferred;
  if (!d) return;
  await d.prompt();
  await d.userChoice.catch(() => null);
  deferred = null;
  listeners.forEach((l) => l());
}
