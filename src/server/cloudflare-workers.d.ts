// Workers 専用の API の最小限の型（このプロジェクトの型チェックはブラウザ用の型を使っているため）
declare module 'cloudflare:workers' {
  export class DurableObject<Env = unknown> {
    ctx: unknown;
    env: Env;
    constructor(ctx: unknown, env: Env);
  }
}

/** Workers の WebSocket（サーバー側） */
interface CfWebSocket {
  accept(): void;
  send(data: ArrayBuffer | ArrayBufferView | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error', fn: () => void): void;
}
declare const WebSocketPair: { new (): { 0: CfWebSocket; 1: CfWebSocket } };
