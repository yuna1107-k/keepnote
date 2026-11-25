/**
 * ワークスペースの「ページが変わった」お知らせ（名前・アイコン・場所の変更、作成・削除など）。
 *
 * 共同編集の部屋（collab.ts の PageRoom。Durable Object）を、ワークスペースごとに「ws:<ID>」の名前で使う。
 * 画面はその部屋に、お知らせを受け取るだけの接続（編集しない）をつなぎ、お知らせが来たらページの一覧を読み直す。
 * お知らせには名前などを入れない（プライベートのページの名前がほかの人に届かないように。一覧は権限に合わせて返す）。
 * Durable Object がない環境（Node 版）では何もしない（画面は定期的に読み直す）。
 */
import type { Context } from 'hono';
import type { AppEnv } from './session.ts';

export type RoomNamespace = { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } };

export const workspaceRoomName = (workspaceId: string) => `ws:${workspaceId}`;

export function roomNamespace(c: Context<AppEnv>) {
  return (c.env as { PAGE_ROOM?: RoomNamespace } | undefined)?.PAGE_ROOM ?? null;
}

/** ワークスペースを開いている人に、ページが変わったことを知らせる（応答を待たせない） */
export function notifyWorkspace(c: Context<AppEnv>, workspaceId: string) {
  const ns = roomNamespace(c);
  if (!ns) return;
  const p = ns
    .get(ns.idFromName(workspaceRoomName(workspaceId)))
    .fetch(new Request('https://room/signal', { headers: { 'x-room-signal': JSON.stringify({ kind: 'pages' }) } }))
    .then(() => undefined)
    .catch(() => undefined);
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    // waitUntil のない環境では、そのまま投げっぱなしにする
  }
}
