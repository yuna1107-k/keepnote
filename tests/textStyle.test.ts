import { describe, expect, it } from 'vitest';
import { detectTextStyle } from '../src/web/workspace/textStyle';

describe('テキストの書き方を推し量る', () => {
  it('2 スペース・4 スペースのインデント', () => {
    expect(detectTextStyle('a {\n  b {\n    c;\n  }\n}\n').indent).toEqual({ tabs: false, size: 2 });
    expect(detectTextStyle('def f():\n    if x:\n        y()\n    return 1\n').indent).toEqual({ tabs: false, size: 4 });
  });
  it('閉じるときに何段も浅くなる差は数えない', () => {
    expect(detectTextStyle('a\n  b\n    c\n      d\na\n  b\n').indent).toEqual({ tabs: false, size: 2 });
  });
  it('ブロックコメントの「 * 」は 1 スペースのインデントと見なさない', () => {
    expect(detectTextStyle('/**\n * doc\n * more\n */\nfunction f() {\n  return 1;\n}\n').indent).toEqual({ tabs: false, size: 2 });
  });
  it('タブのインデント', () => {
    expect(detectTextStyle('func f() {\n\tif x {\n\t\ty()\n\t}\n}\n').indent.tabs).toBe(true);
  });
  it('インデントがなければ 2 スペース', () => {
    expect(detectTextStyle('hello\nworld\n').indent).toEqual({ tabs: false, size: 2 });
    expect(detectTextStyle('').indent).toEqual({ tabs: false, size: 2 });
  });
  it('改行コード（混ざっていたら多いほう）', () => {
    expect(detectTextStyle('a\nb\nc\n').crlf).toBe(false);
    expect(detectTextStyle('a\r\nb\r\nc\r\n').crlf).toBe(true);
    expect(detectTextStyle('a\r\nb\r\nc\n').crlf).toBe(true);
    expect(detectTextStyle('a\r\nb\nc\n').crlf).toBe(false);
  });
});
