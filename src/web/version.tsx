import { useEffect, useState } from 'react';

/** 現在読み込んでいるアプリ本体のファイル名（ビルドごとに変わる） */
function currentEntry() {
  const el = document.querySelector('script[type="module"][src*="/assets/index-"]') as HTMLScriptElement | null;
  return el ? new URL(el.src).pathname : null;
}

async function latestEntry() {
  const res = await fetch('/', { cache: 'no-store', headers: { Accept: 'text/html' } });
  const html = await res.text();
  return html.match(/\/assets\/index-[^"']+\.js/)?.[0] ?? null;
}

/**
 * デプロイで古いチャンクが消えたあとに画面を開いたままだと、遅延読み込みに失敗する。
 * その場合は一度だけ自動で再読み込みする。
 */
export function installChunkErrorReload() {
  window.addEventListener('vite:preloadError', (event) => {
    const key = 'reloaded-for-update';
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch {
      /* ignore */
    }
    event.preventDefault();
    window.location.reload();
  });
  // 正常に起動できたら、次回の自動再読み込みを許可する
  setTimeout(() => {
    try {
      sessionStorage.removeItem('reloaded-for-update');
    } catch {
      /* ignore */
    }
  }, 10_000);
}

/** 新しいバージョンが公開されたら知らせるバナー */
export function UpdateBanner() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const mine = currentEntry();
    if (!mine) return; // 開発サーバーでは無効
    const check = () =>
      latestEntry()
        .then((latest) => latest && latest !== mine && setAvailable(true))
        .catch(() => {});
    const timer = setInterval(check, 2 * 60_000);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
  if (!available) return null;
  return (
    <div className="update-banner" role="status">
      新しいバージョンが公開されました。
      <button className="btn btn-primary btn-sm" onClick={() => window.location.reload()}>
        再読み込み
      </button>
    </div>
  );
}
