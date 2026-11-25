/**
 * 閲覧モード：オンのあいだは、すべてのページを読むだけにして（編集の操作を隠す）、本文を大きく読みやすく見せる。
 * この端末で覚えておく（ページを移っても、開き直しても続く）。
 */
import { useSyncExternalStore } from 'react';

const KEY = 'reading-mode';
const listeners = new Set<() => void>();

function read() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}
let current = read();
const apply = () => document.documentElement.classList.toggle('reading-mode', current);
apply();

export function setReadingMode(on: boolean) {
  current = on;
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* 覚えられなくても、この画面では使える */
  }
  apply();
  listeners.forEach((l) => l());
}

export function useReadingMode(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  return [on, setReadingMode];
}
