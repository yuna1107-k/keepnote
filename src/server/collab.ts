/**
 * リアルタイム共同編集の部屋（Cloudflare Durable Object。ページごとに 1 つ）。
 *
 * 接続しているブラウザ同士で Yjs の更新とカーソル情報（awareness）を中継し、部屋の中で 1 つの文書にまとめる。
 * 保存は今までどおり各ブラウザが API 経由で行う（内容は全員で同じになるので、どの保存も同じ結果になる）。
 * 全員が抜けたら部屋の文書は捨てる（次に開いた人が、保存済みの内容から作り直す）。
 *
 * メッセージ（先頭 1 バイトが種類）
 *   0: 文書の更新      1: カーソル情報の更新
 *   2: 入室時の初期化（サーバー → ブラウザ）。2 バイト目が 1 なら「部屋が空なので保存済みの内容で初期化してほしい」
 */
import { DurableObject } from 'cloudflare:workers';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';

type Peer = { userId: string; name: string; canEdit: boolean; clientIds: Set<number> };
type AwarenessEntry = { clientId: number; clock: number; state: string };

/** 1 つの接続が名乗れるクライアント ID の上限（同じタブの再接続などで少し増えることがある） */
const MAX_CLIENT_IDS = 8;
/**
 * 接続の有効時間。権限は接続時にしか確認しないため、定期的につなぎ直してもらい、
 * 共有の解除・アカウントの無効化などをこの時間内に反映する（ブラウザはすぐ再接続する）
 */
const REAUTH_MS = 5 * 60_000;
/** 再接続を求めるときの切断コード */
export const CLOSE_REAUTH = 4000;

// awareness の更新（y-protocols の形式）：件数、続いて [クライアント ID, 時刻, 状態の JSON] の繰り返し。数値は可変長整数
function readVarUint(buf: Uint8Array, pos: { i: number }) {
  let n = 0;
  let mult = 1;
  for (;;) {
    if (pos.i >= buf.length) throw new Error('短すぎるデータです');
    const b = buf[pos.i++]!;
    n += (b & 0x7f) * mult;
    if (b < 0x80) return n;
    mult *= 128;
    if (mult > 2 ** 53) throw new Error('数値が大きすぎます');
  }
}

function writeVarUint(out: number[], n: number) {
  while (n > 0x7f) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
}

function decodeAwareness(buf: Uint8Array): AwarenessEntry[] {
  const pos = { i: 0 };
  const count = readVarUint(buf, pos);
  if (count > 64) throw new Error('件数が多すぎます');
  const entries: AwarenessEntry[] = [];
  for (let k = 0; k < count; k++) {
    const clientId = readVarUint(buf, pos);
    const clock = readVarUint(buf, pos);
    const len = readVarUint(buf, pos);
    if (pos.i + len > buf.length) throw new Error('短すぎるデータです');
    entries.push({ clientId, clock, state: new TextDecoder().decode(buf.subarray(pos.i, pos.i + len)) });
    pos.i += len;
  }
  return entries;
}

function encodeAwareness(entries: AwarenessEntry[]) {
  const out: number[] = [];
  writeVarUint(out, entries.length);
  for (const e of entries) {
    writeVarUint(out, e.clientId);
    writeVarUint(out, e.clock);
    const bytes = new TextEncoder().encode(e.state);
    writeVarUint(out, bytes.length);
    for (const b of bytes) out.push(b);
  }
  return new Uint8Array(out);
}

const MSG_UPDATE = 0;
const MSG_AWARENESS = 1;
const MSG_INIT = 2;
/** サーバーからのお知らせ（コメントが変わったなど）。中身は JSON の文字 */
const MSG_SIGNAL = 3;

function frame(type: number, payload: Uint8Array, extra?: number) {
  const head = extra === undefined ? 1 : 2;
  const out = new Uint8Array(head + payload.length);
  out[0] = type;
  if (extra !== undefined) out[1] = extra;
  out.set(payload, head);
  return out;
}

export class PageRoom extends DurableObject {
  private doc = new Y.Doc();
  private awareness = new awarenessProtocol.Awareness(this.doc);
  private peers = new Map<CfWebSocket, Peer>();
  /** 空の部屋で、保存済みの内容からの初期化を任せた接続（同時に入室しても 1 人だけが初期化する） */
  private seeder: CfWebSocket | null = null;
  /** この部屋の文書に、誰かが内容を入れたか */
  private seeded = false;

  /** 接続の有効時間（テストでは環境変数 COLLAB_REAUTH_MS で短くできる） */
  private reauthMs: number;

  constructor(ctx: unknown, env: unknown) {
    super(ctx, env);
    this.reauthMs = Number((env as { COLLAB_REAUTH_MS?: string } | undefined)?.COLLAB_REAUTH_MS) || REAUTH_MS;
    // サーバー側の awareness は他人の状態の保管だけに使う（自分の状態は持たない）
    this.awareness.setLocalState(null);
  }

  async fetch(request: Request): Promise<Response> {
    // ページを開いている全員に知らせる（Worker の中からだけ呼ばれる。外からは届かない）
    const signal = request.headers.get('x-room-signal');
    if (signal && request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      const data = frame(MSG_SIGNAL, new TextEncoder().encode(signal));
      for (const ws of this.peers.keys()) {
        try {
          ws.send(data);
        } catch {
          this.onClose(ws);
        }
      }
      return new Response(null, { status: 204 });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('websocket only', { status: 426 });
    const userId = request.headers.get('x-collab-user') ?? '';
    const name = decodeURIComponent(request.headers.get('x-collab-name') ?? '');
    const canEdit = request.headers.get('x-collab-edit') === '1';
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.peers.set(server, { userId, name, canEdit, clientIds: new Set() });

    const seed = canEdit && !this.seeded && !this.seeder;
    if (seed) this.seeder = server;
    server.send(frame(MSG_INIT, Y.encodeStateAsUpdate(this.doc), seed ? 1 : 0));
    const states = Array.from(this.awareness.getStates().keys());
    if (states.length) server.send(frame(MSG_AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.awareness, states)));

    // 全員が同時につなぎ直さないよう、少しずらす
    const reauth = setTimeout(() => {
      try {
        server.close(CLOSE_REAUTH, 'reauth');
      } catch {
        /* すでに切れている */
      }
      this.onClose(server);
    }, this.reauthMs + Math.floor(Math.random() * Math.min(30_000, this.reauthMs / 4)));
    server.addEventListener('close', () => clearTimeout(reauth));
    server.addEventListener('message', (ev) => void this.onMessage(server, ev.data).catch((e) => console.error('[room]', e)));
    server.addEventListener('close', () => this.onClose(server));
    server.addEventListener('error', () => this.onClose(server));
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  private broadcast(from: CfWebSocket, data: Uint8Array) {
    for (const ws of this.peers.keys()) {
      if (ws === from) continue;
      try {
        ws.send(data);
      } catch {
        this.onClose(ws);
      }
    }
  }

  private async onMessage(ws: CfWebSocket, raw: unknown) {
    const peer = this.peers.get(ws);
    if (!peer || typeof raw === 'string' || raw === null || raw === undefined) return;
    // バイナリは環境によって ArrayBuffer / Blob のどちらでも届く（Yjs の更新は順番が入れ替わっても問題ない）
    const data =
      typeof (raw as Blob).arrayBuffer === 'function' && !(raw as ArrayBuffer).byteLength
        ? new Uint8Array(await (raw as Blob).arrayBuffer())
        : ArrayBuffer.isView(raw)
          ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
          : new Uint8Array(raw as ArrayBuffer);
    const type = data[0];
    const payload = data.subarray(1);
    if (type === MSG_UPDATE) {
      // 閲覧のみの人からの変更は受け付けない
      if (!peer.canEdit) return;
      Y.applyUpdate(this.doc, payload);
      this.seeded = true;
      if (this.seeder === ws) this.seeder = null;
      this.broadcast(ws, data);
    } else if (type === MSG_AWARENESS) {
      const clean = this.sanitizeAwareness(peer, payload);
      if (!clean) return;
      awarenessProtocol.applyAwarenessUpdate(this.awareness, clean, ws);
      this.broadcast(ws, frame(MSG_AWARENESS, clean));
    }
  }

  /**
   * ブラウザから届いたカーソル情報を検査する。
   * - 他の接続が使っているクライアント ID の情報は捨てる（なりすまし防止）
   * - 名前と「編集できるか」は、接続時にサーバーが確認した値で上書きする
   *   （閲覧のみの人が編集者を名乗ると、保存の担当が決まらず内容が保存されなくなるため）
   */
  private sanitizeAwareness(peer: Peer, payload: Uint8Array) {
    let entries: AwarenessEntry[];
    try {
      entries = decodeAwareness(payload);
    } catch {
      return null;
    }
    const kept: AwarenessEntry[] = [];
    for (const e of entries) {
      const owner = this.ownerOf(e.clientId);
      if (owner && owner !== peer) continue;
      if (!owner) {
        if (peer.clientIds.size >= MAX_CLIENT_IDS) continue;
        peer.clientIds.add(e.clientId);
      }
      if (e.state !== 'null') {
        let state: unknown;
        try {
          state = JSON.parse(e.state);
        } catch {
          continue;
        }
        if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
        const st = state as Record<string, unknown>;
        const user = st.user && typeof st.user === 'object' && !Array.isArray(st.user) ? (st.user as Record<string, unknown>) : {};
        st.user = { ...user, name: peer.name || user.name, canEdit: peer.canEdit };
        e.state = JSON.stringify(st);
      }
      kept.push(e);
    }
    return kept.length ? encodeAwareness(kept) : null;
  }

  private ownerOf(clientId: number) {
    for (const p of this.peers.values()) if (p.clientIds.has(clientId)) return p;
    return null;
  }

  private onClose(ws: CfWebSocket) {
    const peer = this.peers.get(ws);
    if (!peer) return;
    this.peers.delete(ws);
    if (this.seeder === ws) this.seeder = null;
    const ids = Array.from(peer.clientIds);
    if (ids.length) {
      awarenessProtocol.removeAwarenessStates(this.awareness, ids, null);
      this.broadcast(ws, frame(MSG_AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids)));
    }
    // 全員が抜けたら文書を捨てる（保存済みの内容が正）
    if (this.peers.size === 0) {
      this.doc.destroy();
      this.doc = new Y.Doc();
      this.awareness = new awarenessProtocol.Awareness(this.doc);
      this.awareness.setLocalState(null);
      this.seeded = false;
    }
  }
}
