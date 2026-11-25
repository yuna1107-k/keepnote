import { useState } from 'react';
import { Popover } from '../ui';
import { formatCount, type TextCount } from './wordCount';

/** ページの情報の行に出す「○ 文字」。押すと詳しい数を出す */
export function WordCountButton({ counts, selection }: { counts: TextCount; selection: TextCount | null }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button className="word-count-btn" onClick={(e) => setAnchor(e.currentTarget)} title="文字数の詳細">
        {formatCount(counts.chars)} 文字
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={260}>
          <WordCountDetail counts={counts} selection={selection} />
        </Popover>
      )}
    </>
  );
}

/** 選択中の文字数（画面の下に小さく出す） */
export function SelectionCount({ counts }: { counts: TextCount | null }) {
  if (!counts) return null;
  return (
    <div className="selection-count" role="status">
      選択中 <b>{formatCount(counts.chars)}</b> 文字
      {counts.words > 0 && <>・{formatCount(counts.words)} 語</>}
    </div>
  );
}

/** 文字数の詳細（ページ全体と、選択中の範囲） */
export function WordCountDetail({ counts, selection }: { counts: TextCount; selection: TextCount | null }) {
  const rows = (c: TextCount) => (
    <dl className="word-count-dl">
      <dt>文字数</dt>
      <dd>{formatCount(c.chars)}</dd>
      <dt>文字数（空白を含む）</dt>
      <dd>{formatCount(c.charsWithSpaces)}</dd>
      <dt>単語数</dt>
      <dd>{formatCount(c.words)}</dd>
      <dt>原稿用紙（400字）</dt>
      <dd>{formatCount(Math.ceil(c.chars / 400))} 枚</dd>
    </dl>
  );
  return (
    <div className="word-count-detail">
      <div className="page-menu-label">このページ</div>
      {rows(counts)}
      {selection && (
        <>
          <div className="page-menu-label">選択中</div>
          {rows(selection)}
        </>
      )}
      <p className="muted small">文字数は空白・改行を除いた数です。単語数は英語などのスペースで区切られた語の数で、数式・画像は数えません。</p>
    </div>
  );
}
