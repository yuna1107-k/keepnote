/**
 * この画面で保存したファイルの URL。
 * 保存すると URL が変わる（新しいファイル・GitHub の新しい版）が、編集中の画面は読み直さずにそのまま続ける。
 */
export const selfSaved = new Set<string>();

/** 未保存の変更を今すぐ保存する関数。保存できた（または変更がない）ら true */
export type Flush = () => Promise<boolean>;

/**
 * 閉じる前の保存。保存の途中なら終わるのを待ってから、残りの変更を保存する
 * （保存中に閉じようとしても無視されないように）
 */
export async function flushWhenIdle(isBusy: () => boolean, save: Flush): Promise<boolean> {
  const start = Date.now();
  while (isBusy() && Date.now() - start < 60_000) await new Promise((r) => setTimeout(r, 50));
  return save();
}
