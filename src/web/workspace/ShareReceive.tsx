/**
 * ほかのアプリから「共有」で送られたもの（文章・URL・画像・PDF など）を、新しいページとして保存する画面。
 * 送られた内容は、サービスワーカーが端末に一時的に預かっている（keepnote-share）。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, uploadFile, type Page } from '../api';
import { Button, Icon, Spinner, useUi } from '../ui';
import { useWorkspace } from './WorkspaceContext';

const SHARE_CACHE = 'keepnote-share';

type Shared = {
  title: string;
  text: string;
  url: string;
  files: { name: string; type: string; blob: Blob }[];
};

async function readShared(): Promise<Shared | null> {
  if (!('caches' in window)) return null;
  const cache = await caches.open(SHARE_CACHE);
  const meta = await cache.match('/__share/meta');
  if (!meta) return null;
  const m = (await meta.json()) as { title: string; text: string; url: string; files: { key: string; name: string; type: string }[] };
  const files = [];
  for (const f of m.files) {
    const res = await cache.match(f.key);
    if (res) files.push({ name: f.name, type: f.type, blob: await res.blob() });
  }
  return { title: m.title, text: m.text, url: m.url, files };
}

const clearShared = () => caches?.delete(SHARE_CACHE).catch(() => false);

/** 文章の中の URL をリンクにする */
function inline(text: string) {
  const out: any[] = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    if (m.index! > last) out.push({ type: 'text', text: text.slice(last, m.index), styles: {} });
    out.push({ type: 'link', href: m[0], content: [{ type: 'text', text: m[0], styles: {} }] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last), styles: {} });
  return out;
}

function titleOf(s: Shared) {
  if (s.title.trim()) return s.title.trim();
  const line = s.text.split('\n').map((l) => l.trim()).find((l) => l && !/^https?:\/\//.test(l));
  if (line) return line.slice(0, 60);
  try {
    if (s.url) return new URL(s.url).hostname;
  } catch {
    // URL として読めなければ使わない
  }
  if (s.files[0]) return s.files[0].name.replace(/\.[^.]+$/, '');
  return '共有したメモ';
}

export default function ShareReceive() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { toast } = useUi();
  const [shared, setShared] = useState<Shared | null | 'none'>(null);
  const [wsId, setWsId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const retry = new URLSearchParams(window.location.search).has('retry');

  useEffect(() => {
    readShared()
      .then((s) => setShared(s ?? 'none'))
      .catch(() => setShared('none'));
  }, []);
  useEffect(() => {
    if (!wsId && ws.current) setWsId(ws.current.id);
  }, [ws.current, wsId]);

  const writable = (ws.workspaces ?? []).filter((w) => w.role !== 'viewer');

  const save = async () => {
    if (!shared || shared === 'none' || !wsId) return;
    setBusy(true);
    try {
      const blocks: any[] = [];
      const urlInText = shared.url && shared.text.includes(shared.url);
      for (const line of shared.text.split('\n')) blocks.push(line.trim() ? { type: 'paragraph', content: inline(line) } : { type: 'paragraph' });
      if (shared.url && !urlInText) blocks.push({ type: 'paragraph', content: inline(shared.url) });
      for (const f of shared.files) {
        const url = await uploadFile(new File([f.blob], f.name, { type: f.type || f.blob.type }));
        const kind = /^image\//.test(f.type) ? 'image' : /^video\//.test(f.type) ? 'video' : /^audio\//.test(f.type) ? 'audio' : 'file';
        blocks.push({ type: kind, props: { url, name: f.name } });
      }
      while (blocks.length && !blocks[blocks.length - 1].content && blocks[blocks.length - 1].type === 'paragraph') blocks.pop();
      const { page } = await api<{ page: Page }>('/pages', { body: { parentId: null, visibility: 'workspace', workspaceId: wsId, title: titleOf(shared).slice(0, 500) } });
      await api(`/pages/${page.id}`, { method: 'PATCH', body: { version: page.version, content: blocks, contentText: shared.text } });
      await clearShared();
      if (wsId !== ws.current?.id) ws.switchWorkspace(wsId);
      else await ws.reload();
      toast('保存しました', 'success');
      navigate(`/p/${page.id}`, { replace: true });
    } catch (e) {
      toast((e as Error).message || '保存できませんでした', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-page share-receive">
      <h1>共有されたものを保存</h1>
      {shared === null ? (
        <Spinner />
      ) : shared === 'none' ? (
        <p className="muted">
          {retry ? '受け取る準備ができていませんでした。もう一度、共有し直してください。' : '保存するものがありません。ほかのアプリの「共有」から送ってください。'}
        </p>
      ) : (
        <section className="card">
          <h2 className="share-title">{titleOf(shared)}</h2>
          {shared.text && <p className="share-text">{shared.text}</p>}
          {shared.url && !shared.text.includes(shared.url) && <p className="share-text">{shared.url}</p>}
          {shared.files.length > 0 && (
            <ul className="share-files">
              {shared.files.map((f, i) => (
                <li key={i}>
                  <Icon name={/^image\//.test(f.type) ? 'image' : 'file'} size={16} /> {f.name}
                </li>
              ))}
            </ul>
          )}
          {writable.length > 1 && (
            <label className="field">
              <span>保存するワークスペース</span>
              <select value={wsId} onChange={(e) => setWsId(e.target.value)}>
                {writable.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="inline-form">
            <Button variant="primary" onClick={() => void save()} disabled={busy || !wsId}>
              {busy ? '保存しています…' : '新しいページとして保存'}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                await clearShared();
                navigate('/', { replace: true });
              }}
            >
              保存しない
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

/** ホーム画面のアイコンの長押しメニュー「新しいページ」から開く。新しいページを作って開く */
let creating = 0;
export function NewPageShortcut() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  useEffect(() => {
    if (!ws.current) return;
    if (Date.now() - creating < 3000) return;
    creating = Date.now();
    if (ws.canContribute) void ws.createPage(null, 'workspace');
    else navigate('/', { replace: true });
  }, [ws.current, ws.canContribute]);
  return <Spinner center />;
}
