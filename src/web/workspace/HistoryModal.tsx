import { lazy, Suspense, useEffect, useState } from 'react';
import { api, type Page } from '../api';
import { Button, formatDateTime, formatRelative, Modal, PageIcon, Spinner, useUi } from '../ui';
import { blockLines, diffLines } from './text';

const Editor = lazy(() => import('./Editor'));

type VersionSummary = { id: string; title: string; icon: string | null; createdAt: number; editedBy: string | null };
type Snapshot = { id: string; title: string; icon: string | null; content: any[]; createdAt: number };

const CURRENT = 'current';

/**
 * ページ履歴。一覧の先頭は現在の版、以降は過去の版（新しい順）。
 * 各版を選ぶと「その版で何が変わったか（1 つ前の版との差分）」と、その版の内容を表示する。
 */
export function HistoryModal({
  page,
  open,
  onClose,
  onRestored,
  canRestore = true,
}: {
  page: Page;
  open: boolean;
  onClose: () => void;
  onRestored: () => void;
  canRestore?: boolean;
}) {
  const { toast, confirm } = useUi();
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [current, setCurrent] = useState<Snapshot & { editedBy: string | null } | null>(null);
  const [selected, setSelected] = useState<string>(CURRENT);
  const [cache, setCache] = useState<Record<string, Snapshot>>({});
  const [mode, setMode] = useState<'diff' | 'content'>('diff');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setVersions(null);
    setCache({});
    setSelected(CURRENT);
    Promise.all([api<{ versions: VersionSummary[] }>(`/pages/${page.id}/versions`), api<{ page: Page }>(`/pages/${page.id}`)])
      .then(([v, p]) => {
        setVersions(v.versions);
        setCurrent({ id: CURRENT, title: p.page.title, icon: p.page.icon, content: p.page.content, createdAt: p.page.updatedAt, editedBy: p.page.updatedBy });
      })
      .catch((e) => toast(e.message, 'error'));
  }, [open, page.id, toast]);

  // 一覧（現在 + 過去）
  const list = versions && current ? [{ id: CURRENT, title: current.title, icon: current.icon, createdAt: current.createdAt, editedBy: current.editedBy }, ...versions] : null;
  const index = list?.findIndex((v) => v.id === selected) ?? -1;
  const previousId = list && index >= 0 ? list[index + 1]?.id : undefined;

  // 選択した版と、その 1 つ前の版の内容を取得
  useEffect(() => {
    if (!list) return;
    for (const id of [selected, previousId]) {
      if (!id || id === CURRENT || cache[id]) continue;
      api<{ version: Snapshot }>(`/pages/${page.id}/versions/${id}`)
        .then((r) => setCache((c) => ({ ...c, [id]: r.version })))
        .catch((e) => toast(e.message, 'error'));
    }
  }, [selected, previousId, list?.length]);

  const snap = (id: string | undefined) => (id === CURRENT ? current : id ? cache[id] : undefined);
  const detail = snap(selected);
  const previous = previousId ? snap(previousId) : { title: '', content: [] };

  const restore = async () => {
    if (!detail || selected === CURRENT) return;
    const ok = await confirm({
      title: 'この版に復元しますか？',
      message: `${formatDateTime(detail.createdAt)} の状態に戻します。現在の内容も履歴に残るので、あとから元に戻せます。`,
      confirmLabel: '復元',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api(`/pages/${page.id}/versions/${selected}/restore`, { body: {} });
      toast('ページを復元しました', 'success');
      onClose();
      onRestored();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="ページ履歴" width={1000} className="history-modal">
      <div className="history">
        <div className="history-preview">
          {!list ? (
            <Spinner center />
          ) : !detail || !previous ? (
            <Spinner center />
          ) : (
            <div className="history-doc">
              <div className="history-modes segmented">
                <button className={mode === 'diff' ? 'active' : ''} onClick={() => setMode('diff')}>
                  この版での変更
                </button>
                <button className={mode === 'content' ? 'active' : ''} onClick={() => setMode('content')}>
                  この版の内容
                </button>
              </div>
              {mode === 'diff' ? (
                <DiffView before={previous} after={detail} isFirst={!previousId} />
              ) : (
                <>
                  <div className="history-title">
                    {detail.icon && <PageIcon icon={detail.icon} size={28} />}
                    <h1>{detail.title || '無題'}</h1>
                  </div>
                  <Suspense fallback={<Spinner />}>
                    <Editor key={selected} initialContent={detail.content} editable={false} />
                  </Suspense>
                </>
              )}
            </div>
          )}
        </div>
        <aside className="history-list">
          {list?.map((v, i) => (
            <button key={v.id} className={`history-item ${selected === v.id ? 'active' : ''}`} onClick={() => setSelected(v.id)}>
              <div className="list-title">
                {formatDateTime(v.createdAt)}
                {i === 0 && <span className="badge badge-info">現在</span>}
              </div>
              <div className="muted small">
                {v.editedBy ?? '不明'}・{formatRelative(v.createdAt)}
              </div>
            </button>
          ))}
          {list && list.length === 1 && (
            <p className="muted small history-hint">編集すると、編集前の状態が自動で履歴に保存されます（同じ人の連続編集は2分ごと）。</p>
          )}
          <div className="history-actions">
            <Button
              variant="primary"
              className="w-full"
              disabled={!detail || selected === CURRENT || page.deletedAt !== null || !canRestore}
              loading={busy}
              onClick={restore}
            >
              この版に復元
            </Button>
          </div>
        </aside>
      </div>
    </Modal>
  );
}

function DiffView({ before, after, isFirst }: { before: { title: string; content: any[] }; after: { title: string; content: any[] }; isFirst: boolean }) {
  const lines = diffLines([`タイトル：${before.title || '無題'}`, ...blockLines(before.content)], [`タイトル：${after.title || '無題'}`, ...blockLines(after.content)]);
  const added = lines.filter((l) => l.type === 'add').length;
  const removed = lines.filter((l) => l.type === 'del').length;
  return (
    <div className="diff">
      <div className="diff-summary small">
        {isFirst ? (
          <span className="muted">記録されている最も古い版です</span>
        ) : added === 0 && removed === 0 ? (
          <span className="muted">1 つ前の版から本文の変更はありません（アイコンや書式のみの変更の可能性があります）</span>
        ) : (
          <>
            1 つ前の版から <span className="diff-add-text">+{added} 行</span> 追加・<span className="diff-del-text">−{removed} 行</span> 削除
          </>
        )}
      </div>
      <div className="diff-lines">
        {lines.map((l, i) => (
          <div key={i} className={`diff-line diff-${l.type}`}>
            <span className="diff-mark">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}</span>
            <span className="diff-text">{l.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
