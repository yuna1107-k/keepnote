/**
 * ページのコメント。本文の文を選んで「コメント」を押すと、その文とブロックにスレッドを付けられる。
 * 右の欄で一覧・返信・解決・削除ができる。ページを見られる人は誰でもコメントできる。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { formatRelative, Icon, useUi } from '../ui';

export type PageComment = {
  id: string;
  threadId: string | null;
  blockId: string | null;
  quote: string | null;
  body: string;
  author: { id: string; name: string };
  resolvedAt: number | null;
  createdAt: number;
  canResolve: boolean;
  canDelete: boolean;
};

type Draft = { blockId: string | null; quote: string };

/** コメントを読み込む（ほかの人の変更は、共同編集の接続で知らせが来たらすぐ読み直す） */
export function useComments(pageId: string, active: boolean, provider?: { onSignal(fn: (kind: string) => void): () => void } | null) {
  const [comments, setComments] = useState<PageComment[]>([]);
  const reload = useCallback(async () => {
    try {
      setComments((await api<{ comments: PageComment[] }>(`/pages/${pageId}/comments`)).comments);
    } catch {
      // 読めないときは前の一覧のまま
    }
  }, [pageId]);
  useEffect(() => {
    setComments([]);
    void reload();
  }, [reload]);
  // ほかの人がコメントしたら、すぐ読み直す（共同編集の接続で知らせが届く）
  useEffect(() => provider?.onSignal((kind) => kind === 'comments' && void reload()), [provider, reload]);
  // 接続がないとき（閲覧だけの環境など）の予備：欄を開いている間は定期的に読み直す
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void reload(), provider ? 60_000 : 15_000);
    return () => clearInterval(t);
  }, [active, reload, provider]);
  return { comments, reload };
}

/** 選んでいる文と、そのブロック（本文の中を選んでいるときだけ） */
function currentSelection(): Draft | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
  if (!node?.closest('.page-body .bn-editor')) return null;
  const quote = sel.toString().trim().replace(/\s+/g, ' ');
  if (!quote) return null;
  const block = node.closest('[data-id]');
  return { blockId: block?.getAttribute('data-id') ?? null, quote: quote.slice(0, 1000) };
}

/** 本文で文を選んだときに出る「コメント」ボタン */
export function SelectionCommentButton({ onComment }: { onComment: (d: Draft) => void }) {
  const [pos, setPos] = useState<{ x: number; y: number; draft: Draft } | null>(null);
  useEffect(() => {
    let t = 0;
    const update = () => {
      clearTimeout(t);
      t = window.setTimeout(() => {
        const draft = currentSelection();
        const sel = window.getSelection();
        if (!draft || !sel?.rangeCount) return setPos(null);
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (!r.width && !r.height) return setPos(null);
        setPos({ x: Math.min(window.innerWidth - 110, r.right + 6), y: Math.max(8, r.top - 40), draft });
      }, 120);
    };
    document.addEventListener('selectionchange', update);
    window.addEventListener('scroll', update, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener('selectionchange', update);
      window.removeEventListener('scroll', update, true);
    };
  }, []);
  if (!pos) return null;
  return (
    <button
      className="comment-float-btn"
      style={{ left: pos.x, top: pos.y }}
      // 押しても選んだ文が消えないようにする
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onComment(pos.draft);
        setPos(null);
      }}
    >
      <Icon name="comment" size={14} /> コメント
    </button>
  );
}

/** コメントが付いているブロックに印をつける（本文には手を加えない） */
export function CommentMarks({ comments }: { comments: PageComment[] }) {
  const open = comments.filter((c) => !c.threadId && !c.resolvedAt && c.blockId);
  const ids = [...new Set(open.map((c) => c.blockId!))].filter((id) => /^[\w-]+$/.test(id));
  if (!ids.length) return null;
  const sel = ids.map((id) => `.page-body .bn-block-outer[data-id="${id}"] > .bn-block > .bn-block-content`).join(',\n');
  return <style>{`${sel} { background: var(--comment-bg); box-shadow: inset 3px 0 0 var(--comment-line); border-radius: 2px; }`}</style>;
}

export function CommentsPanel({
  pageId,
  comments,
  reload,
  draft,
  setDraft,
  focusThread,
  onClose,
}: {
  pageId: string;
  comments: PageComment[];
  reload: () => Promise<void>;
  draft: Draft | null;
  setDraft: (d: Draft | null) => void;
  focusThread: string | null;
  onClose: () => void;
}) {
  const { toast } = useUi();
  const [showResolved, setShowResolved] = useState(false);
  const threads = useMemo(() => {
    const roots = comments.filter((c) => !c.threadId);
    const replies = (id: string) => comments.filter((c) => c.threadId === id);
    // 本文の順に並べる（見つからないブロックは最後）
    const order = new Map<string, number>();
    document.querySelectorAll('.page-body .bn-block-outer[data-id]').forEach((el, i) => order.set(el.getAttribute('data-id')!, i));
    return roots
      .map((r) => ({ root: r, replies: replies(r.id) }))
      .sort((a, b) => (order.get(a.root.blockId ?? '') ?? 1e9) - (order.get(b.root.blockId ?? '') ?? 1e9) || a.root.createdAt - b.root.createdAt);
  }, [comments]);
  const open = threads.filter((t) => !t.root.resolvedAt);
  const resolved = threads.filter((t) => t.root.resolvedAt);

  const send = async (body: string, extra: { threadId?: string; blockId?: string | null; quote?: string | null }) => {
    try {
      await api(`/pages/${pageId}/comments`, { body: { body, ...extra } });
      await reload();
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    }
  };
  const patch = async (id: string, data: object) => {
    try {
      await api(`/pages/${pageId}/comments/${id}`, { method: 'PATCH', body: data });
      await reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = async (id: string) => {
    try {
      await api(`/pages/${pageId}/comments/${id}`, { method: 'DELETE' });
      await reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <aside className="comments-panel" aria-label="コメント">
      <div className="comments-head">
        <strong>コメント</strong>
        <span className="comments-count">{open.length}</span>
        <button className="icon-btn" onClick={onClose} aria-label="コメントを閉じる">
          <Icon name="x" />
        </button>
      </div>
      <div className="comments-list">
        {draft && (
          <div className="comment-thread is-draft">
            <blockquote className="comment-quote">{draft.quote}</blockquote>
            <Composer
              autoFocus
              placeholder="コメントを書く"
              submitLabel="コメントする"
              onCancel={() => setDraft(null)}
              onSubmit={async (body) => {
                if (await send(body, { blockId: draft.blockId, quote: draft.quote })) setDraft(null);
              }}
            />
          </div>
        )}
        {!draft && !open.length && (
          <p className="comments-empty">
            本文の文を選ぶと出る「コメント」ボタンから、コメントを付けられます。
          </p>
        )}
        {open.map((t) => (
          <Thread key={t.root.id} t={t} focused={focusThread === t.root.id} send={send} patch={patch} remove={remove} />
        ))}
        {resolved.length > 0 && (
          <button className="comments-resolved-toggle" onClick={() => setShowResolved((v) => !v)}>
            <Icon name={showResolved ? 'chevronDown' : 'chevronRight'} size={14} /> 解決済み（{resolved.length}）
          </button>
        )}
        {showResolved && resolved.map((t) => <Thread key={t.root.id} t={t} focused={false} send={send} patch={patch} remove={remove} />)}
      </div>
    </aside>
  );
}

function Thread({
  t,
  focused,
  send,
  patch,
  remove,
}: {
  t: { root: PageComment; replies: PageComment[] };
  focused: boolean;
  send: (body: string, extra: { threadId: string }) => Promise<boolean>;
  patch: (id: string, data: object) => Promise<void>;
  remove: (id: string) => Promise<void>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [replying, setReplying] = useState(false);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focused]);
  const jump = () => {
    const el = t.root.blockId ? document.querySelector(`.page-body .bn-block-outer[data-id="${CSS.escape(t.root.blockId)}"]`) : null;
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('comment-flash');
    setTimeout(() => el.classList.remove('comment-flash'), 1400);
  };
  return (
    <div ref={ref} className={`comment-thread ${t.root.resolvedAt ? 'is-resolved' : ''} ${focused ? 'is-focused' : ''}`}>
      {t.root.quote && (
        <button className="comment-quote" onClick={jump} title="本文のこの場所へ移動">
          {t.root.quote}
        </button>
      )}
      {[t.root, ...t.replies].map((c) => (
        <div key={c.id} className="comment">
          <div className="comment-meta">
            <span className="comment-author">{c.author.name}</span>
            <span className="comment-time">{formatRelative(c.createdAt)}</span>
            {c.canDelete && (
              <button className="comment-link" onClick={() => void remove(c.id)}>
                {c === t.root ? 'スレッドを削除' : '削除'}
              </button>
            )}
          </div>
          <div className="comment-body">{c.body}</div>
        </div>
      ))}
      <div className="comment-actions">
        {replying ? (
          <Composer
            autoFocus
            placeholder="返信を書く"
            submitLabel="返信する"
            onCancel={() => setReplying(false)}
            onSubmit={async (body) => {
              if (await send(body, { threadId: t.root.id })) setReplying(false);
            }}
          />
        ) : (
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => setReplying(true)}>
              返信
            </button>
            {t.root.canResolve && (
              <button className="btn btn-ghost btn-sm" onClick={() => void patch(t.root.id, { resolved: !t.root.resolvedAt })}>
                <Icon name="check" size={14} /> {t.root.resolvedAt ? '未解決に戻す' : '解決'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Composer({
  placeholder,
  submitLabel,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  submitLabel: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    await onSubmit(text.trim());
    setBusy(false);
  };
  return (
    <div className="comment-composer">
      <textarea
        autoFocus={autoFocus}
        value={text}
        placeholder={placeholder}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="comment-composer-actions">
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>
          やめる
        </button>
        <button className="btn btn-primary btn-sm" disabled={!text.trim() || busy} onClick={() => void submit()}>
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
