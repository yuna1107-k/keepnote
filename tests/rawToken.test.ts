import { describe, expect, it } from 'vitest';
import { urlDir, withBaseHref } from '../src/web/workspace/rawToken';

describe('HTML プレビューの相対パス', () => {
  it('URL のフォルダの部分（? 以降は除く）', () => {
    expect(urlDir('/api/github/raw/ws/docs/slides/index.html?v=abc')).toBe('/api/github/raw/ws/docs/slides/');
    expect(urlDir('/api/github/rawt/tok/ws/index.html')).toBe('/api/github/rawt/tok/ws/');
  });
  it('<head> の先頭に <base> を入れる（属性つき・大文字の <head> も）', () => {
    expect(withBaseHref('<html><head><title>a</title></head></html>', '/x/')).toBe('<html><head><base href="/x/"><title>a</title></head></html>');
    expect(withBaseHref('<HEAD lang="ja"><title>a</title>', '/x/')).toBe('<HEAD lang="ja"><base href="/x/"><title>a</title>');
  });
  it('<header> は <head> と見なさない。<head> がなければ先頭に入れる', () => {
    expect(withBaseHref('<header>h</header><img src="a.png">', '/x/')).toBe('<base href="/x/"><header>h</header><img src="a.png">');
  });
  it('href の " はエスケープする', () => {
    expect(withBaseHref('<p>', '/a"b/')).toBe('<base href="/a&quot;b/"><p>');
  });
});
