/**
 * 前に貼ったファイルの中の文字を、裏で少しずつ読み取って記録する（検索でファイルの中身も探せるように）。
 * 画面が使われていないときに 1 件ずつ行い、この画面を開いているあいだに 1 回だけ回す。
 */
import { api } from '../api';

const done = new Set<string>();

const idle = () =>
  new Promise<void>((resolve) => {
    if ('requestIdleCallback' in window) (window as any).requestIdleCallback(() => resolve(), { timeout: 4000 });
    else setTimeout(resolve, 800);
  });

export async function backfillFileText(workspaceId: string) {
  if (done.has(workspaceId) || !navigator.onLine) return;
  done.add(workspaceId);
  const { canExtract, extractFileText } = await import('./fileText');
  const tried = new Set<string>();
  // 1 回に 40 件ずつ。読めなかったファイルも「空」として記録するので、同じものを何度も読まない
  for (let round = 0; round < 10; round++) {
    let files: { id: string; filename: string }[];
    try {
      files = (await api<{ files: { id: string; filename: string }[] }>(`/files/needs-text?workspace=${encodeURIComponent(workspaceId)}`)).files.filter((f) => !tried.has(f.id));
    } catch {
      return;
    }
    if (!files.length) return;
    for (const f of files) {
      tried.add(f.id);
      if (document.hidden) await new Promise((r) => document.addEventListener('visibilitychange', r, { once: true }));
      await idle();
      let text = '';
      try {
        if (canExtract(f.filename)) {
          const res = await fetch(`/api/files/${f.id}`, { credentials: 'same-origin' });
          if (res.ok) text = ((await extractFileText(new File([await res.blob()], f.filename))) ?? '').trim();
        }
      } catch {
        // 読めないファイルは空として記録する
      }
      try {
        await fetch(`/api/files/${f.id}/text`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      } catch {
        return;
      }
    }
  }
}
