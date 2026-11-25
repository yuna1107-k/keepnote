/**
 * リアルタイム共同編集の接続（ブラウザ側）。ページごとの部屋（サーバーの Durable Object）と WebSocket でつなぎ、
 * Yjs の文書とカーソル情報を同期する。切断されたら自動で再接続し、再接続時は手元の内容も送り直す。
 */
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';

const MSG_UPDATE = 0;
const MSG_AWARENESS = 1;
const MSG_INIT = 2;
const MSG_SIGNAL = 3;

export type CollabStatus = 'connecting' | 'connected' | 'offline' | 'unavailable';

function frame(type: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(payload.length + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

export class CollabProvider {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  status: CollabStatus = 'connecting';
  /** 相手からの変更を反映している最中か（このときの変更は自分では保存しない） */
  applyingRemote = false;
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private listeners = new Set<() => void>();
  private signalListeners = new Set<(kind: string) => void>();

  /** サーバーからのお知らせ（「comments」など）を受け取る */
  onSignal(fn: (kind: string) => void) {
    this.signalListeners.add(fn);
    return () => void this.signalListeners.delete(fn);
  }
  private firstSync: Promise<{ seed: boolean }>;
  private resolveFirst!: (v: { seed: boolean }) => void;

  private pageId: string;

  constructor(pageId: string) {
    this.pageId = pageId;
    this.firstSync = new Promise((r) => (this.resolveFirst = r));
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== this) this.send(frame(MSG_UPDATE, update));
    });
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === this) return;
      const changed = added.concat(updated, removed);
      this.send(frame(MSG_AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)));
    });
    this.connect();
  }

  /**
   * 保存を担当するか：編集できる人のうち、クライアント ID が最も小さい 1 人だけが部屋の内容を保存する
   * （全員が保存すると、届く前の古い内容で上書きしてしまうことがあるため）
   */
  isSaver() {
    const editors = [...this.awareness.getStates().entries()].filter(([, s]) => (s as { user?: { canEdit?: boolean } }).user?.canEdit).map(([id]) => id);
    if (!editors.includes(this.doc.clientID)) editors.push(this.doc.clientID);
    return Math.min(...editors) === this.doc.clientID;
  }

  /** 最初の同期の完了を待つ。seed=true なら部屋が空なので、保存済みの内容で初期化する役 */
  synced() {
    return this.firstSync;
  }

  onStatus(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setStatus(s: CollabStatus) {
    this.status = s;
    this.listeners.forEach((l) => l());
  }

  private send(data: Uint8Array<ArrayBuffer>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  private connect() {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/pages/${this.pageId}/collab`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.setStatus('connecting');
    let opened = false;
    ws.onopen = () => {
      opened = true;
    };
    ws.onmessage = (ev) => {
      const data = new Uint8Array(ev.data as ArrayBuffer);
      const type = data[0];
      if (type === MSG_INIT) {
        const seed = data[1] === 1;
        this.applyingRemote = true;
        try {
          Y.applyUpdate(this.doc, data.subarray(2), this);
        } finally {
          this.applyingRemote = false;
        }
        // 再接続時：手元にしかない変更を部屋に送る
        this.send(frame(MSG_UPDATE, Y.encodeStateAsUpdate(this.doc)));
        if (this.awareness.getLocalState()) {
          this.send(frame(MSG_AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID])));
        }
        this.retry = 0;
        this.setStatus('connected');
        this.resolveFirst({ seed });
      } else if (type === MSG_UPDATE) {
        this.applyingRemote = true;
        try {
          Y.applyUpdate(this.doc, data.subarray(1), this);
        } finally {
          this.applyingRemote = false;
        }
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, data.subarray(1), this);
      } else if (type === MSG_SIGNAL) {
        try {
          const { kind } = JSON.parse(new TextDecoder().decode(data.subarray(1))) as { kind: string };
          this.signalListeners.forEach((l) => l(kind));
        } catch {
          /* 読めないお知らせは無視する */
        }
      }
    };
    ws.onclose = (ev) => {
      this.ws = null;
      if (this.closed) return;
      // サーバーからの定期的なつなぎ直し（権限の再確認）：すぐ再接続する
      if (ev.code === 4000) {
        this.retry = 0;
        this.connect();
        return;
      }
      // 一度もつながらない（Node 版など共同編集のない環境）場合は、通常の編集に戻す
      if (!opened && this.retry >= 2) {
        this.setStatus('unavailable');
        this.resolveFirst({ seed: true });
        return;
      }
      this.setStatus('offline');
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  destroy() {
    this.closed = true;
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    this.ws?.close();
    this.awareness.destroy();
    this.doc.destroy();
  }
}

const COLORS = ['#e16259', '#d9730d', '#dfab01', '#4d9a6a', '#0b8a8a', '#2383e2', '#6940a5', '#ad1a72'];
export function userColor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return COLORS[Math.abs(h) % COLORS.length]!;
}
