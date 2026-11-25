import { describe, expect, it } from 'vitest';
import { withStorageShim } from '../src/server/htmlShim';

describe('withStorageShim', () => {
  it('<head> の直後に入れる', () => {
    const out = withStorageShim('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    expect(out.indexOf('<script>')).toBe(out.indexOf('<head>') + '<head>'.length);
  });
  it('<head> が無ければ doctype の後', () => {
    const out = withStorageShim('<!DOCTYPE html><p>x</p>');
    expect(out.startsWith('<!DOCTYPE html><script>')).toBe(true);
  });
  it('どちらも無ければ先頭', () => expect(withStorageShim('<p>x</p>').startsWith('<script>')).toBe(true));
  it('差し込んだスクリプトで、使えない localStorage を置き換える', () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(withStorageShim(''))![1]!;
    const win: Record<string, unknown> = {};
    Object.defineProperty(win, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    Object.defineProperty(win, 'sessionStorage', { configurable: true, value: { length: 0 } });
    new Function('window', script)(win);
    const ls = win.localStorage as Storage;
    ls.setItem('a', '1');
    expect(ls.getItem('a')).toBe('1');
    expect(ls.length).toBe(1);
    expect((win.sessionStorage as { length: number }).length).toBe(0); // 使えるものはそのまま
  });
});
