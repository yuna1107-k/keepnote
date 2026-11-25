import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Button, formatRelative, Icon, Modal, PageIcon, Spinner, useUi } from '../ui';
import { canEdit, pageTitle, useWorkspace } from './WorkspaceContext';

type SearchResult = { id: string; title: string; icon: string | null; snippet: string; updatedAt: number; visibility: string; file?: string; database?: string };

export function SearchDialog() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const open = ws.ui.searchOpen;
  const close = () => ws.ui.setSearchOpen(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (!open) {
      setQ('');
      setResults(null);
    }
  }, [open]);

  useEffect(() => {
    if (!q.trim()) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      api<{ results: SearchResult[] }>(`/pages/search?q=${encodeURIComponent(q)}&workspace=${encodeURIComponent(ws.current?.id ?? '')}`)
        .then((r) => {
          setResults(r.results);
          setCursor(0);
        })
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const recent = useMemo(() => [...ws.pages].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8), [ws.pages]);
  const list: SearchResult[] = results ?? recent.map((p) => ({ id: p.id, title: p.title, icon: p.icon, snippet: '', updatedAt: p.updatedAt, visibility: p.visibility }));

  const go = (id: string) => {
    close();
    navigate(`/p/${id}`);
  };

  return (
    <Modal open={open} onClose={close} width={620} className="search-modal">
      <div className="search-input">
        <Icon name="search" size={18} />
        <input
          autoFocus
          placeholder="ページを検索…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, list.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === 'Enter' && list[cursor]) {
              go(list[cursor].id);
            }
          }}
        />
      </div>
      <div className="search-results">
        {!results && <div className="search-group-label">最近更新されたページ</div>}
        {list.length === 0 && <div className="empty small">該当するページはありません</div>}
        {list.map((r, i) => (
          <button key={`${r.id}:${r.file ?? r.database ?? ''}:${i}`} className={`search-result ${i === cursor ? 'active' : ''}`} onMouseEnter={() => setCursor(i)} onClick={() => go(r.id)}>
            <PageIcon icon={r.icon} size={18} />
            <div className="search-result-body">
              <div className="search-result-title">
                {pageTitle(r)}
                {r.visibility === 'private' && <Icon name="lock" size={12} className="muted" />}
              </div>
              {r.file && (
                <div className="search-result-file">
                  <Icon name="attach" size={13} /> {r.file} の中
                </div>
              )}
              {r.database && (
                <div className="search-result-file">
                  <Icon name="database" size={13} /> データベース「{r.database}」の値
                </div>
              )}
              {r.snippet && <div className="search-result-snippet">{r.snippet}</div>}
            </div>
            <span className="muted small">{formatRelative(r.updatedAt)}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

type TrashItem = { id: string; title: string; icon: string | null; visibility: string; deletedAt: number; deletedBy: string | null; canPurge: boolean };

export function TrashDialog() {
  const ws = useWorkspace();
  const { toast, confirm } = useUi();
  const navigate = useNavigate();
  const open = ws.ui.trashOpen;
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [filter, setFilter] = useState('');

  const load = () => api<{ pages: TrashItem[] }>(`/pages/trash?workspace=${encodeURIComponent(ws.current?.id ?? '')}`).then((r) => setItems(r.pages));

  useEffect(() => {
    if (open) load().catch((e) => toast(e.message, 'error'));
    else setItems(null);
  }, [open]);

  const restore = async (id: string) => {
    try {
      await api(`/pages/${id}/restore`, { body: {} });
      toast('ページを復元しました', 'success');
      await Promise.all([load(), ws.reload()]);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const purge = async (item: TrashItem) => {
    const ok = await confirm({
      title: 'ページを完全に削除しますか？',
      message: `「${pageTitle(item)}」とそのサブページは完全に削除され、元に戻せません。`,
      confirmLabel: '完全に削除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/pages/${item.id}/permanent`, { method: 'DELETE' });
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const shown = items?.filter((i) => pageTitle(i).toLowerCase().includes(filter.toLowerCase())) ?? [];

  // まとめて選んで、復元・完全に削除する
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => setSelected(new Set()), [open, items]);
  const picked = shown.filter((i) => selected.has(i.id));
  const allPicked = shown.length > 0 && picked.length === shown.length;
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const bulk = async (kind: 'restore' | 'purge', list: TrashItem[]) => {
    if (!list.length) return;
    if (kind === 'purge') {
      const ok = await confirm({
        title: `${list.length} ページを完全に削除しますか？`,
        message: 'サブページも含めて完全に削除され、元に戻せません。',
        confirmLabel: '完全に削除',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    let failed = 0;
    for (const item of list) {
      try {
        if (kind === 'purge') await api(`/pages/${item.id}/permanent`, { method: 'DELETE' });
        else await api(`/pages/${item.id}/restore`, { body: {} });
      } catch (e) {
        // 親ページと一緒にすでに消えた・戻ったものは数えない
        if (!(e instanceof ApiError && e.status === 404)) failed++;
      }
    }
    setBusy(false);
    await Promise.all([load(), kind === 'restore' ? ws.reload() : Promise.resolve()]);
    if (failed) toast(`${failed} ページは${kind === 'purge' ? '削除' : '復元'}できませんでした`, 'error');
    else toast(kind === 'purge' ? `${list.length} ページを完全に削除しました` : `${list.length} ページを復元しました`, 'success');
  };
  const purgeable = shown.filter((i) => i.canPurge);

  return (
    <Modal open={open} onClose={() => ws.ui.setTrashOpen(false)} title="ゴミ箱" width={560}>
      <div className="modal-body">
        <input className="input" placeholder="ゴミ箱内のページを絞り込み…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {shown.length > 0 && (
          <div className="trash-bulk">
            <label className="trash-check-all">
              <input type="checkbox" checked={allPicked} onChange={() => setSelected(allPicked ? new Set() : new Set(shown.map((i) => i.id)))} />
              {picked.length ? `${picked.length} 件を選択中` : 'すべて選択'}
            </label>
            {picked.length > 0 ? (
              <>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void bulk('restore', picked)}>
                  <Icon name="restore" size={14} /> 復元
                </button>
                <button className="btn btn-ghost btn-sm danger" disabled={busy || !picked.some((i) => i.canPurge)} onClick={() => void bulk('purge', picked.filter((i) => i.canPurge))}>
                  <Icon name="trash" size={14} /> 完全に削除
                </button>
              </>
            ) : (
              purgeable.length > 0 && (
                <button className="btn btn-ghost btn-sm danger" disabled={busy} onClick={() => void bulk('purge', purgeable)}>
                  <Icon name="trash" size={14} /> {filter ? '表示中をすべて削除' : 'ゴミ箱を空にする'}
                </button>
              )
            )}
          </div>
        )}
        <div className="trash-list">
          {!items ? (
            <Spinner />
          ) : shown.length === 0 ? (
            <div className="empty small">ゴミ箱は空です</div>
          ) : (
            shown.map((item) => (
              <div key={item.id} className={`trash-item ${selected.has(item.id) ? 'is-picked' : ''}`}>
                <input type="checkbox" className="trash-check" checked={selected.has(item.id)} onChange={() => toggle(item.id)} aria-label={`${pageTitle(item)} を選ぶ`} />
                <button
                  className="trash-item-main"
                  onClick={() => {
                    ws.ui.setTrashOpen(false);
                    navigate(`/p/${item.id}`);
                  }}
                >
                  <PageIcon icon={item.icon} />
                  <div>
                    <div>{pageTitle(item)}</div>
                    <div className="muted small">
                      {formatRelative(item.deletedAt)} に {item.deletedBy ?? '不明'} が削除
                    </div>
                  </div>
                </button>
                <button className="icon-btn" title="復元" onClick={() => restore(item.id)}>
                  <Icon name="restore" />
                </button>
                {item.canPurge && (
                  <button className="icon-btn danger" title="完全に削除" onClick={() => purge(item)}>
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}

export function MoveDialog() {
  const ws = useWorkspace();
  const { user } = useAuth();
  const id = ws.ui.moveTarget;
  const page = id ? ws.byId.get(id) : undefined;
  const [filter, setFilter] = useState('');

  useEffect(() => setFilter(''), [id]);

  const excluded = useMemo(() => {
    if (!id) return new Set<string>();
    const set = new Set<string>([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of ws.pages) if (p.parentId && set.has(p.parentId) && !set.has(p.id)) {
        set.add(p.id);
        changed = true;
      }
    }
    return set;
  }, [id, ws.pages]);

  // GitHub のファイル（Markdown など）の下には移せない（フォルダの下にだけ移せる）
  const candidates = ws.pages.filter(
    (p) => !excluded.has(p.id) && canEdit(p) && p.githubKind !== 'md' && p.githubKind !== 'file' && pageTitle(p).toLowerCase().includes(filter.toLowerCase()),
  );
  const close = () => ws.ui.setMoveTarget(null);
  const move = async (parentId: string | null, visibility?: 'workspace' | 'private') => {
    if (!id) return;
    close();
    await ws.movePage(id, parentId, visibility);
  };

  return (
    <Modal open={!!page} onClose={close} title={`「${pageTitle(page)}」の移動先`} width={480}>
      <div className="modal-body">
        <input className="input" autoFocus placeholder="移動先のページを検索…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="move-list">
          <button className="move-item" onClick={() => move(null, 'workspace')}>
            <Icon name="users" /> ワークスペース（最上位）
          </button>
          {ws.current?.privatePages && (
            <button className="move-item" onClick={() => move(null, 'private')}>
              <Icon name="lock" /> プライベート（最上位）
            </button>
          )}
          <div className="menu-divider" />
          {candidates.map((p) => (
            <button key={p.id} className="move-item" onClick={() => move(p.id)}>
              <PageIcon icon={p.icon} />
              <span className="ellipsis">{pageTitle(p)}</span>
              {p.visibility === 'private' && <Icon name="lock" size={12} className="muted" />}
            </button>
          ))}
        </div>
        <p className="muted small">
          ワークスペースのページは全メンバーが閲覧・編集できます。
          {ws.current?.privatePages && `プライベートのページはあなた（${user?.displayName}）だけが閲覧できます。`}
        </p>
        <div className="modal-actions">
          <Button variant="ghost" onClick={close}>
            キャンセル
          </Button>
        </div>
      </div>
    </Modal>
  );
}
