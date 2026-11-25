/**
 * HTML のプレビュー（iframe）。右上の「全画面」で、HTML で作ったスライドなどを画面いっぱいに表示する。
 * - 全画面にするのは iframe を包む枠（終了ボタンを出しておくため）。中の HTML から全画面にする（reveal.js の F など）のも許す
 * - 全画面にしたら iframe にフォーカスを移し、矢印キーやスペースが HTML のスライドに届くようにする
 * - Fullscreen API がない環境（iPhone の Safari、Android アプリの WebView など）は、画面いっぱいに広げた表示で代わりにする（Esc・× で戻る）
 */
import { useEffect, useRef, useState, type IframeHTMLAttributes } from 'react';
import { inApp } from '../appBridge';
import { PageIcon } from '../ui';

type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FsDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };

const fsElement = () => document.fullscreenElement ?? (document as FsDocument).webkitFullscreenElement ?? null;

export function HtmlFrame({ className = '', ...iframe }: IframeHTMLAttributes<HTMLIFrameElement> & { className?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  // native：ブラウザの全画面／pseudo：画面いっぱいに広げた表示
  const [mode, setMode] = useState<null | 'native' | 'pseudo'>(null);

  const focusFrame = () => {
    // 別のオリジンのときは contentWindow.focus() が効かないことがあるので、iframe 自体にもフォーカスする
    frame.current?.focus();
    try {
      frame.current?.contentWindow?.focus();
    } catch {
      /* フォーカスできなくても表示はできる */
    }
  };

  useEffect(() => {
    const onChange = () => {
      const on = !!wrap.current && fsElement() === wrap.current;
      setMode((m) => (on ? 'native' : m === 'native' ? null : m));
      if (on) setTimeout(focusFrame, 50);
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  // 広げた表示は Esc で戻る（iframe の中にフォーカスがあるときは、× で戻る）
  useEffect(() => {
    if (mode !== 'pseudo') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setMode(null);
    };
    window.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // 重ねて開いたページの中でも画面いっぱいに広がるように、position: fixed を閉じ込める transform を外す
    document.body.classList.add('html-frame-open');
    setTimeout(focusFrame, 50);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
      document.body.classList.remove('html-frame-open');
    };
  }, [mode]);

  const enter = async () => {
    const el = wrap.current as FsElement | null;
    if (!el) return;
    // アプリの WebView は要素の全画面に対応していない（全画面にしても何も映らない）ので、広げた表示にする
    const d = document as Document & { webkitFullscreenEnabled?: boolean };
    if (inApp || !(d.fullscreenEnabled ?? d.webkitFullscreenEnabled)) return setMode('pseudo');
    try {
      if (el.requestFullscreen) return void (await el.requestFullscreen());
      if (el.webkitRequestFullscreen) return void (await el.webkitRequestFullscreen());
    } catch {
      /* 全画面にできなければ、広げた表示にする */
    }
    setMode('pseudo');
  };
  const exit = () => {
    if (mode === 'pseudo') return setMode(null);
    const d = document as FsDocument;
    if (d.exitFullscreen) void d.exitFullscreen().catch(() => {});
    else void d.webkitExitFullscreen?.();
  };

  return (
    <div ref={wrap} className={`html-frame ${mode ? 'is-full' : ''} ${mode === 'pseudo' ? 'is-pseudo-full' : ''}`}>
      <iframe ref={frame} {...iframe} className={className} allow="fullscreen" allowFullScreen />
      <button
        type="button"
        className="html-frame-btn"
        onClick={() => (mode ? exit() : void enter())}
        title={mode ? '全画面を終わる（Esc）' : '全画面で表示（スライドは矢印キー・スペースで進めます）'}
        aria-label={mode ? '全画面を終わる' : '全画面で表示'}
      >
        <PageIcon icon={mode ? 'ms:close_fullscreen' : 'ms:open_in_full'} size={15} />
        {!mode && <span>全画面</span>}
      </button>
    </div>
  );
}
