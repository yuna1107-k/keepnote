import { useEffect, useState } from 'react';
import type { Theme } from './api';
import { notifyTheme } from './appBridge';

/** テーマ設定を <html data-theme> に反映し、次回の描画前に使えるよう保存する */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    localStorage.setItem('theme', theme);
  } catch {
    /* ignore */
  }
  notifyTheme(theme);
}

const query = '(prefers-color-scheme: dark)';

function effective(): 'light' | 'dark' {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'light' || forced === 'dark') return forced;
  return window.matchMedia(query).matches ? 'dark' : 'light';
}

/** 実際に表示中のテーマ（ユーザー設定 → OS 設定の順）を返す */
export function useEffectiveTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState(effective);
  useEffect(() => {
    const update = () => setTheme(effective());
    const mq = window.matchMedia(query);
    mq.addEventListener('change', update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq.removeEventListener('change', update);
      observer.disconnect();
    };
  }, []);
  return theme;
}
