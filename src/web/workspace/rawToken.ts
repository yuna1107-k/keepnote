/**
 * GitHub の HTML ファイルのプレビュー用の URL。
 * プレビューは sandbox（別のオリジン扱い）で開くため、中の HTML が相対パスで読む画像などにログインの cookie が付かない。
 * そこで /api/github/raw/<ワークスペース>/<パス> を、期限付きのトークンを入れた /api/github/rawt/<トークン>/<ワークスペース>/<パス> にする
 * （トークンはワークスペースごとに覚えておき、期限の少し前に取り直す）。
 */
import { useEffect, useState } from 'react';
import { api } from '../api';

const cache = new Map<string, { prefix: string; expiresAt: number }>();
const RAW = /^\/api\/github\/raw\/([^/]+)\/(.+)$/;

export async function tokenizedRawUrl(url: string) {
  const m = RAW.exec(url);
  if (!m) return url;
  const [, wsId, rest] = m;
  let t = cache.get(wsId!);
  if (!t || t.expiresAt - Date.now() < 10 * 60_000) {
    t = await api<{ prefix: string; expiresAt: number }>(`/github/raw-token/${encodeURIComponent(wsId!)}`);
    cache.set(wsId!, t);
  }
  return t.prefix + rest;
}

/** 上の URL にする（取りに行っている間は null。取れなければ元の URL） */
export function useTokenizedRawUrl(url: string | null | undefined) {
  const [out, setOut] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setOut(null);
    if (!url) return;
    tokenizedRawUrl(url)
      .then((u) => alive && setOut(u))
      .catch(() => alive && setOut(url));
    return () => {
      alive = false;
    };
  }, [url]);
  return out;
}

/** URL のフォルダの部分（最後の / まで。? 以降は除く） */
export const urlDir = (url: string) => url.split('?')[0]!.replace(/[^/]*$/, '');

/** HTML の <head> の先頭に <base href> を入れる（相対パスの画像・CSS などを href の場所から読ませる） */
export function withBaseHref(html: string, href: string) {
  const tag = `<base href="${href.replace(/"/g, '&quot;')}">`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (!head) return tag + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + tag + html.slice(at);
}
