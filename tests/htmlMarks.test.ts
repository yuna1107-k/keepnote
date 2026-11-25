import { describe, expect, it } from 'vitest';
import { HTML_MARK, htmlBlockAt, htmlMarksToMarkdown, needsEmbed, restoreHtmlBlock } from '../src/web/workspace/htmlMarks';

/** Markdown の中から、埋め込みにする HTML を順に取り出す */
function blocks(md: string) {
  const lines = md.split('\n');
  const out: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    const r = htmlBlockAt(lines, i);
    if (r) {
      out.push([i, r.end]);
      i = r.end;
    }
  }
  return out;
}

describe('htmlBlockAt', () => {
  it('入れ子の SVG は最初のタグが閉じるまで', () => {
    expect(blocks('<svg viewBox="0 0 10 10">\n  <svg><rect/></svg>\n</svg>\n本文')).toEqual([[0, 2]]);
  });
  it('align 付きの段落は埋め込みにする', () => {
    expect(blocks('<p align="center">\n  <img src="a.png" width="300">\n</p>')).toEqual([[0, 2]]);
  });
  it('素の <div>・<img> はエディターの変換に任せる', () => {
    expect(blocks('<div>plain</div>\n<img src="b.png">')).toEqual([]);
  });
  it('<img> の行だけを見て、次の行の iframe は別に取り出す', () => {
    expect(blocks('<img src="b.png">\n<iframe src="https://www.youtube.com/embed/x"></iframe>')).toEqual([[1, 1]]);
  });
  it('中に空行のある <details> も閉じるまで', () => {
    expect(blocks('<details><summary>s</summary>\n\nhidden\n\n</details>\nend')).toEqual([[0, 4]]);
  });
  it('インデントが 4 つ以上（コード）は対象外', () => {
    expect(blocks('    <svg></svg>')).toEqual([]);
  });
});

describe('目印の往復', () => {
  const html = '<svg viewBox="0 0 1 1"><text>日本語 & "記号"</text></svg>';
  it('段落の目印から HTML のブロックに戻す', () => {
    expect(restoreHtmlBlock(HTML_MARK(html))).toEqual({ type: 'html', props: { html } });
  });
  it('目印でない文はそのまま（null）', () => expect(restoreHtmlBlock('ふつうの文')).toBeNull());
  it('Markdown に書き出すと HTML に戻る', () => {
    expect(htmlMarksToMarkdown(`前\n\n${HTML_MARK(html)}\n\n後`)).toBe(`前\n\n${html}\n\n後`);
  });
});

describe('needsEmbed', () => {
  it('SVG・iframe・style 付きは埋め込み', () => {
    expect(needsEmbed('<svg></svg>')).toBe(true);
    expect(needsEmbed('<div style="color:red">x</div>')).toBe(true);
  });
  it('素の HTML はそのまま並べる', () => expect(needsEmbed('<p>文</p>')).toBe(false));
});
