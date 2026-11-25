/**
 * アプリケーション層での暗号化（AES-256-GCM）。
 *
 * - 鍵は環境変数 / Workers のシークレット `DATA_KEY`（32 バイトを base64 で表したもの）
 * - 文字列は `enc:v1:<base64url(iv + 暗号文)>` の形で保存する。DB から読んだ値はこの形なら自動で復号する（db.ts）
 * - ファイルは先頭に `SNE1` を付けたバイナリで保存する
 * - 鍵が未設定なら暗号化しない（平文のまま）。既存の平文データも読める
 */
const PREFIX = 'enc:v1:';
const FILE_MAGIC = new Uint8Array([0x53, 0x4e, 0x45, 0x31]); // "SNE1"

let keyPromise: Promise<CryptoKey | null> | null = null;
let rawKey: string | undefined;

export function setDataKey(base64: string | undefined) {
  rawKey = base64?.trim() || undefined;
  keyPromise = null;
}

export function encryptionEnabled() {
  return !!rawKey;
}

function key(): Promise<CryptoKey | null> {
  if (!rawKey) return Promise.resolve(null);
  keyPromise ??= (async () => {
    const bytes = Uint8Array.from(atob(rawKey!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    if (bytes.length !== 32) throw new Error('DATA_KEY は 32 バイト（base64）で指定してください');
    return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  })();
  return keyPromise;
}

function toB64url(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export const isEncrypted = (v: unknown): v is string => typeof v === 'string' && v.startsWith(PREFIX);

/**
 * 文字列を暗号化する。入力が「enc:v1:」で始まっていても必ず暗号化する
 * （利用者が暗号文に見える文字列を入力したとき、そのまま保存すると読み出しで復号に失敗するため）。
 */
export async function encryptText<T extends string | null | undefined>(value: T): Promise<T | string> {
  if (value === null || value === undefined) return value;
  const k = await key();
  if (!k) return value;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(value)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return PREFIX + toB64url(out);
}

export async function decryptText(value: string): Promise<string> {
  if (!isEncrypted(value)) return value;
  const k = await key();
  if (!k) throw new Error('暗号化されたデータを読むには DATA_KEY が必要です');
  const data = fromB64url(value.slice(PREFIX.length));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12) }, k, data.subarray(12));
  return new TextDecoder().decode(pt);
}

/**
 * 行の中の暗号化された文字列をすべて復号する。
 * 復号できない値（暗号文に見えるだけの平文など）はそのまま返し、画面全体が開けなくなるのを防ぐ。
 */
export async function decryptRow<T>(row: T): Promise<T> {
  if (!row || typeof row !== 'object') return row;
  const r = row as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    const v = r[k];
    if (!isEncrypted(v)) continue;
    try {
      r[k] = await decryptText(v);
    } catch (e) {
      // 鍵が未設定なのは設定ミスなので、今までどおりエラーにする
      if (!rawKey) throw e;
      console.warn('[crypto] 復号できない値をそのまま返します', k, e instanceof Error ? e.message : e);
    }
  }
  return row;
}

export function isEncryptedFile(bytes: Uint8Array) {
  return bytes.length >= 4 && FILE_MAGIC.every((b, i) => bytes[i] === b);
}

export async function encryptBytes(data: ArrayBuffer): Promise<ArrayBuffer> {
  const k = await key();
  if (!k) return data;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, data));
  const out = new Uint8Array(FILE_MAGIC.length + iv.length + ct.length);
  out.set(FILE_MAGIC);
  out.set(iv, 4);
  out.set(ct, 16);
  return out.buffer;
}

export async function decryptBytes(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (!isEncryptedFile(data)) return data;
  const k = await key();
  if (!k) throw new Error('暗号化されたファイルを読むには DATA_KEY が必要です');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(4, 16) }, k, data.subarray(16)));
}
