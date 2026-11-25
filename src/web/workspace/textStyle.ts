/**
 * テキストファイルの書き方（インデント・改行コード）を中身から推し量る（コードエディタのステータスバーの表示と、
 * 入力したインデント・保存する改行コードをファイルに合わせるため）。
 */
export type TextStyle = {
  /** インデントがタブか。スペースなら size 個 */
  indent: { tabs: boolean; size: number };
  /** 改行が CRLF（Windows）か */
  crlf: boolean;
};

/** 大きなファイルでも重くならないよう、先頭の部分だけで推し量る */
const SAMPLE_CHARS = 200_000;
const SAMPLE_LINES = 5_000;

export function detectTextStyle(text: string): TextStyle {
  const sample = text.slice(0, SAMPLE_CHARS);
  const crlfCount = sample.match(/\r\n/g)?.length ?? 0;
  const lfCount = (sample.match(/\n/g)?.length ?? 0) - crlfCount;

  let tabLines = 0;
  let spaceLines = 0;
  let prev = 0;
  // 前の行より深くなったときの差（2 ずつなら 2 スペース、4 ずつなら 4 スペース）
  const steps = new Map<number, number>();
  for (const line of sample.split(/\r?\n/, SAMPLE_LINES)) {
    if (!/\S/.test(line)) continue;
    const lead = /^[ \t]*/.exec(line)![0];
    if (lead.startsWith('\t')) {
      tabLines++;
      continue;
    }
    const n = lead.length;
    if (n > 0) spaceLines++;
    // 1 だけの差は、ブロックコメントの「 * 」などなので数えない
    if (n - prev >= 2 && n - prev <= 8) steps.set(n - prev, (steps.get(n - prev) ?? 0) + 1);
    prev = n;
  }
  let size = 2;
  let best = 0;
  for (const [step, count] of steps) {
    if (count > best || (count === best && step < size)) {
      size = step;
      best = count;
    }
  }
  return { indent: { tabs: tabLines > spaceLines, size }, crlf: crlfCount > lfCount };
}
