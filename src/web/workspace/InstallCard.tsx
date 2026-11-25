/**
 * 「アプリとして使う」：ホーム画面に追加する案内（Chrome などではインストールボタン、iPhone・iPad では手順）
 */
import { useEffect, useState } from 'react';
import { installPrompt, promptInstall, useInstallPrompt } from '../install';
import { Button, Icon } from '../ui';

const standalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function InstallCard() {
  const [, setTick] = useState(0);
  useEffect(() => {
    return useInstallPrompt(() => setTick((t) => t + 1));
  }, []);
  return (
    <section className="card">
      <h2>アプリとして使う</h2>
      <p className="muted small">
        ホーム画面に追加すると、アプリのように開けます。一度開いたページは、電波がないときでも読めます（ログアウトすると端末からは消えます）。
      </p>
      {standalone() ? (
        <p className="install-state">
          <Icon name="check" size={16} /> アプリとして使っています
        </p>
      ) : installPrompt() ? (
        <Button
          variant="primary"
          onClick={() => void promptInstall()}
        >
          <Icon name="install" /> インストール
        </Button>
      ) : isIOS() ? (
        <ol className="install-steps">
          <li>Safari で、画面下（iPad は上）の共有ボタンを押します</li>
          <li>「ホーム画面に追加」を選びます</li>
          <li>右上の「追加」を押します</li>
        </ol>
      ) : (
        <p className="muted small">Chrome・Edge では、アドレスバーの右にあるインストールのボタン、またはメニューの「アプリをインストール」「ホーム画面に追加」から追加できます。</p>
      )}
    </section>
  );
}
