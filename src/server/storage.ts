/**
 * アップロードファイルの保存先。Node.js ではローカルディスク、Workers では R2 を使う。
 * 実行環境に応じた実装を runtime.ts の setRuntime() で差し込む。
 */
import { decryptBytes, encryptBytes, isEncryptedFile } from './crypto.ts';
import { run } from './db.ts';
import { runtime } from './runtime.ts';

export interface FileStore {
  put(id: string, data: ArrayBuffer, contentType: string): Promise<void>;
  get(id: string): Promise<ReadableStream | null>;
  delete(id: string): Promise<void>;
}

async function readAll(stream: ReadableStream): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 保存時に暗号化し、読み出し時に復号するラッパー（鍵が未設定なら素通し） */
export function encryptedStore(inner: FileStore): FileStore & { inner: FileStore; encryptExisting(id: string, contentType: string): Promise<boolean> } {
  return {
    inner,
    async put(id, data, contentType) {
      await inner.put(id, await encryptBytes(data), contentType);
    },
    async get(id) {
      const stream = await inner.get(id);
      if (!stream) return null;
      const plain = await decryptBytes(await readAll(stream));
      return new Response(plain).body!;
    },
    delete: (id) => inner.delete(id),
    /** 平文で保存されているファイルを暗号化し直す。暗号化したら true */
    async encryptExisting(id, contentType) {
      const stream = await inner.get(id);
      if (!stream) return false;
      const bytes = await readAll(stream);
      if (isEncryptedFile(bytes)) return false;
      const copy = bytes.slice().buffer;
      const enc = await encryptBytes(copy);
      if (enc === copy) return false;
      await inner.put(id, enc, contentType);
      return true;
    },
  };
}

/** ファイルを記録・実体ともに削除する（保存先がない・既に無い場合は無視） */
export async function deleteFile(id: string): Promise<void> {
  await run('DELETE FROM files WHERE id = ?', id);
  await runtime().files?.delete(id).catch(() => {});
}

