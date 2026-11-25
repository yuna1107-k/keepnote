/**
 * ページの中から別のページを開くときは、今の画面の上に重ねて開く（GitHub の issue を開くように）。
 * 重ねたページの中からさらにページを開いたときは、パネルを重ねずに同じパネルの中身を切り替える
 * （開いた順は覚えておき、「←」で前のページに戻る）。Esc・× でパネルを閉じ、「全画面で開く」でふつうに移動する。
 */
import { lazy, Suspense, useEffect, useState, type MouseEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type Page } from '../api';
import { Icon, Spinner } from '../ui';
import { useWorkspace } from './WorkspaceContext';

const PageEditor = lazy(() => import('./PageView').then((m) => ({ default: m.PageEditor })));

/** ページを開く：ふつうのクリックは重ねて開き、⌘/Ctrl/Shift+クリックはふつうに移動する */
export function usePageOpener() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  return (id: string, e?: MouseEvent | { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; preventDefault?: () => void }) => {
    if (e && (e.metaKey || e.ctrlKey || e.shiftKey)) {
      e.preventDefault?.();
      navigate(`/p/${id}`);
      return;
    }
    e?.preventDefault?.();
    ws.ui.openPeek(id);
  };
}

function PeekPanel({ id, canBack }: { id: string; canBack: boolean }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [key, setKey] = useState(0);
  useEffect(() => {
    let alive = true;
    setPage(null);
    api<{ page: Page }>(`/pages/${id}`)
      .then((r) => alive && setPage(r.page))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [id, key]);
  // 名前は、開いている間の変更（このパネルでの入力・ほかの画面での変更）もすぐ映す
  const title = ws.byId.get(id)?.title ?? page?.title;
  return (
    <div className="peek-panel" role="dialog" aria-modal="true" aria-label={title || 'ページ'}>
      <div className="peek-bar">
        <button className="icon-btn" onClick={() => ws.ui.closePeek(true)} aria-label="閉じる" title="閉じる（Esc）">
          <Icon name="x" />
        </button>
        {canBack && (
          <button className="icon-btn" onClick={() => ws.ui.closePeek()} aria-label="前のページに戻る" title="前のページに戻る">
            <Icon name="arrowLeft" />
          </button>
        )}
        <span className="peek-title">{page ? title || '無題' : error ? '' : '読み込み中…'}</span>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            ws.ui.closePeek(true);
            navigate(`/p/${id}`);
          }}
        >
          <Icon name="openFull" size={14} /> 全画面で開く
        </button>
      </div>
      <div className="peek-body">
        {error ? <p className="muted small peek-error">{error}</p> : !page ? <Spinner /> : <Suspense fallback={<Spinner />}><PageEditor key={`${page.id}:${key}`} page={page} inPeek onReload={() => setKey((k) => k + 1)} /></Suspense>}
      </div>
    </div>
  );
}

export function PeekLayer() {
  const ws = useWorkspace();
  const location = useLocation();
  const stack = ws.ui.peek;
  // ほかの画面へ移ったら閉じる
  useEffect(() => ws.ui.closePeek(true), [location.pathname]);
  // Esc でパネルを閉じる（メニューや入力中の変換は除く）
  useEffect(() => {
    if (!stack.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      // メニュー・ダイアログが開いているときは、そちらを閉じるのに任せる
      if (document.querySelector('.popover, .modal-backdrop, .bn-suggestion-menu, [role="menu"]')) return;
      e.preventDefault();
      e.stopPropagation();
      ws.ui.closePeek(true);
    };
    // 本文の編集部品が Esc を受け取る前に受け取る
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [stack.length]);
  if (!stack.length) return null;
  // いちばん新しく開いたページだけを表示する（それより前のものは「←」で戻るための履歴）
  const top = stack[stack.length - 1]!;
  return (
    <div className="peek-layer">
      <div className="peek-backdrop" onClick={() => ws.ui.closePeek(true)} />
      <PeekPanel key={top} id={top} canBack={stack.length > 1} />
    </div>
  );
}
