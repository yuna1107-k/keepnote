/**
 * PDF を電子書籍のように読む画面（pdf.js でページを描画する）。
 * - 画面に 1 ページ（横長の画面では見開き 2 ページ）を収めて表示し、左右のクリック・矢印キー・スワイプでめくる
 * - 見開きは本と同じく、1 ページ目（表紙）だけ単独、その後は 2-3, 4-5 … の組み合わせ
 * - 最後に開いていたページを覚えておき、次に開いたときはその続きから
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { api } from '../api';
import { Icon, Spinner } from '../ui';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Mode = 'auto' | 'single' | 'double';

const posKey = (url: string) => `pdfpos:${url}`;
const MODE_KEY = 'pdfReaderMode';

function readStore(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 保存できなくても読むことはできる */
  }
}

/** 見開きのとき、そのページを含む組の左側のページ番号 */
const spreadStart = (p: number) => (p <= 1 ? 1 : p % 2 === 0 ? p : p - 1);

export default function PdfReader({ url, name }: { url: string; name: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [page, setPage] = useState(() => Math.max(1, Number(readStore(posKey(url))) || 1));
  const [mode, setMode] = useState<Mode>(() => (readStore(MODE_KEY) as Mode) || 'auto');
  const [ratio, setRatio] = useState(1.414); // 1 ページ目の 縦 / 横
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [dir, setDir] = useState<1 | -1>(1);
  const [full, setFull] = useState(false);
  // しおりとメモ（アプリ内の PDF のときだけ。自分だけが見られる）
  const notesKey = /^\/api\/(files\/[0-9a-f-]{36}|github\/raw\/[^?#\s]+)$/.test(url) ? url : null;
  const [notes, setNotes] = useState<Map<number, { bookmarked: boolean; memo: string }>>(new Map());
  const [panel, setPanel] = useState(false);
  const memoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!notesKey) return;
    void api<{ notes: { page: number; bookmarked: boolean; memo: string }[] }>(`/pdf-notes?key=${encodeURIComponent(notesKey)}`)
      .then((r) => setNotes(new Map(r.notes.map((n) => [n.page, { bookmarked: n.bookmarked, memo: n.memo }]))))
      .catch(() => {});
  }, [notesKey]);
  const saveNote = (pageNo: number, next: { bookmarked: boolean; memo: string }, delay = 0) => {
    setNotes((m) => {
      const copy = new Map(m);
      if (!next.bookmarked && !next.memo.trim()) copy.delete(pageNo);
      else copy.set(pageNo, next);
      return copy;
    });
    if (!notesKey) return;
    if (memoTimer.current) clearTimeout(memoTimer.current);
    const send = () => void api('/pdf-notes', { method: 'PUT', body: { key: notesKey, page: pageNo, ...next } }).catch(() => {});
    if (delay) memoTimer.current = setTimeout(send, delay);
    else send();
  };
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);

  // 読み込み
  useEffect(() => {
    let alive = true;
    setDoc(null);
    setError(null);
    const task = pdfjs.getDocument({
      url,
      withCredentials: true,
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      wasmUrl: '/pdfjs/wasm/',
    });
    task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => total && setProgress(Math.round((loaded / total) * 100));
    task.promise.then(
      async (d) => {
        if (!alive) return void task.destroy();
        const first = await d.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        setRatio(vp.height / vp.width);
        setPage((p) => Math.min(p, d.numPages));
        setDoc(d);
      },
      (e: Error) => alive && setError(e?.message ?? 'PDF を開けませんでした'),
    );
    return () => {
      alive = false;
      void task.destroy();
    };
  }, [url]);

  // 表示領域の大きさ
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e!.contentRect.width, h: e!.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc]);

  const n = doc?.numPages ?? 0;
  // 横長の画面で、縦長のページなら見開き
  const double = mode === 'double' || (mode === 'auto' && size.w > size.h * 1.15 && ratio > 1 && n > 2);
  const start = double ? spreadStart(page) : page;
  const pages = double && start > 1 && start + 1 <= n ? [start, start + 1] : [start];

  useEffect(() => {
    if (doc) writeStore(posKey(url), String(start));
  }, [doc, url, start]);
  const note = notes.get(start) ?? { bookmarked: false, memo: '' };

  const go = useCallback(
    (delta: 1 | -1) => {
      if (!n) return;
      setDir(delta);
      setPage((p) => {
        if (!double) return Math.min(n, Math.max(1, p + delta));
        const s = spreadStart(p);
        const next = delta > 0 ? (s === 1 ? 2 : s + 2) : s <= 2 ? 1 : s - 2;
        return Math.min(n, Math.max(1, next));
      });
    },
    [n, double],
  );
  const jump = (p: number) => {
    setDir(p >= page ? 1 : -1);
    setPage(Math.min(n, Math.max(1, p)));
  };

  // キーボード（入力欄にいるときは何もしない）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey)) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) go(1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) go(-1);
      else if (e.key === 'Home') jump(1);
      else if (e.key === 'End') jump(n);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // スワイプ
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') touch.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const t = touch.current;
    touch.current = null;
    if (!t) return;
    const dx = e.clientX - t.x;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - t.y) * 1.5) go(dx < 0 ? 1 : -1);
  };

  // 全画面
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen?.();
  };

  const setModeAndSave = (m: Mode) => {
    setMode(m);
    writeStore(MODE_KEY, m);
  };

  // ページの表示サイズ：表示領域に収まる最大の大きさ
  const gap = pages.length > 1 ? 0 : 0;
  const pageW = size.w && size.h ? Math.floor(Math.min((size.w - gap) / pages.length, size.h / ratio)) : 0;
  const pageH = Math.floor(pageW * ratio);

  if (error) {
    return (
      <div className="pdf-reader pdf-reader-error">
        <p className="muted">PDF を表示できませんでした（{error}）</p>
        <a className="btn btn-ghost btn-sm" href={url} target="_blank" rel="noopener">
          <Icon name="external" size={14} /> 新しいタブで開く
        </a>
      </div>
    );
  }

  return (
    <div className={`pdf-reader ${full ? 'is-full' : ''} ${panel ? 'has-panel' : ''}`} ref={root}>
      <div className="pdf-stage" ref={stage} onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
        {!doc ? (
          <div className="pdf-loading">
            <Spinner />
            {progress > 0 && <span className="muted small">{progress}%</span>}
          </div>
        ) : (
          pageW > 0 && (
            <div key={pages.join('-')} className={`pdf-spread ${dir > 0 ? 'turn-next' : 'turn-prev'} ${pages.length > 1 ? 'is-double' : ''}`}>
              {pages.map((p, i) => (
                <PdfPage key={p} doc={doc} num={p} width={pageW} height={pageH} side={pages.length > 1 ? (i === 0 ? 'left' : 'right') : 'single'} />
              ))}
            </div>
          )
        )}
        {doc && (
          <>
            <button className="pdf-zone pdf-zone-prev" onClick={() => go(-1)} disabled={start <= 1} aria-label="前のページ">
              <span className="pdf-arrow"><Icon name="chevronLeft" size={30} /></span>
            </button>
            <button className="pdf-zone pdf-zone-next" onClick={() => go(1)} disabled={pages[pages.length - 1]! >= n} aria-label="次のページ">
              <span className="pdf-arrow"><Icon name="chevronRight" size={30} /></span>
            </button>
          </>
        )}
      </div>
      {doc && panel && notesKey && (
        <aside className="pdf-panel" aria-label="しおりとメモ">
          <div className="pdf-panel-head">
            <span>{start} ページのメモ</span>
            <button className="icon-btn" onClick={() => setPanel(false)} aria-label="閉じる">
              <Icon name="x" />
            </button>
          </div>
          <textarea
            className="pdf-memo"
            value={note.memo}
            placeholder="このページのメモ（自分だけが見られます）"
            onChange={(e) => saveNote(start, { ...note, memo: e.target.value }, 800)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <div className="pdf-panel-list-title">しおりとメモのあるページ</div>
          {notes.size === 0 ? (
            <p className="pdf-panel-empty">まだありません</p>
          ) : (
            <ul className="pdf-panel-list">
              {[...notes.entries()]
                .sort(([a], [b]) => a - b)
                .map(([pg, n]) => (
                  <li key={pg}>
                    <button className={pg === start ? 'active' : ''} onClick={() => jump(pg)}>
                      <span className="pdf-panel-page">
                        {n.bookmarked && <Icon name="bookmark" size={13} />} {pg} ページ
                      </span>
                      {n.memo && <span className="pdf-panel-memo">{n.memo}</span>}
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </aside>
      )}
      {doc && (
        <div className="pdf-bar">
          <span className="pdf-count">
            {pages.length > 1 ? `${pages[0]}-${pages[1]}` : pages[0]} / {n}
          </span>
          <input
            className="pdf-slider"
            type="range"
            min={1}
            max={n}
            value={start}
            onChange={(e) => jump(Number(e.target.value))}
            aria-label="ページ"
          />
          {notesKey && (
            <>
              <button
                className={`icon-btn pdf-bookmark ${note.bookmarked ? 'on' : ''}`}
                onClick={() => saveNote(start, { ...note, bookmarked: !note.bookmarked })}
                title={note.bookmarked ? 'しおりを外す' : 'このページにしおりを付ける'}
                aria-label={note.bookmarked ? 'しおりを外す' : 'しおりを付ける'}
                aria-pressed={note.bookmarked}
              >
                <Icon name="bookmark" size={18} />
              </button>
              <button className={`icon-btn ${panel ? 'on' : ''}`} onClick={() => setPanel((v) => !v)} title="しおりとメモ" aria-label="しおりとメモ" aria-expanded={panel}>
                <Icon name="note" size={18} />
                {notes.size > 0 && <span className="pdf-note-count">{notes.size}</span>}
              </button>
            </>
          )}
          <div className="pdf-modes" role="group" aria-label="表示">
            {(['auto', 'single', 'double'] as const).map((m) => (
              <button key={m} className={`pdf-mode ${mode === m ? 'active' : ''}`} onClick={() => setModeAndSave(m)}>
                {m === 'auto' ? '自動' : m === 'single' ? '単ページ' : '見開き'}
              </button>
            ))}
          </div>
          <button className="icon-btn" onClick={toggleFull} title={full ? '全画面を終了' : '全画面'} aria-label={full ? '全画面を終了' : '全画面'}>
            <Icon name={full ? 'fullscreenExit' : 'fullscreen'} size={18} />
          </button>
          <a className="icon-btn" href={url} target="_blank" rel="noopener" title="ブラウザの PDF 表示で開く（検索・文字の選択）" aria-label="新しいタブで開く">
            <Icon name="external" />
          </a>
          <a className="icon-btn" href={url} download={name} title="ダウンロード" aria-label="ダウンロード">
            <Icon name="download" />
          </a>
        </div>
      )}
    </div>
  );
}

/** 1 ページを canvas に描く（画面の解像度に合わせる） */
function PdfPage({ doc, num, width, height, side }: { doc: PDFDocumentProxy; num: number; width: number; height: number; side: 'left' | 'right' | 'single' }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    let task: RenderTask | null = null;
    let alive = true;
    setDrawn(false);
    void doc.getPage(num).then((pg) => {
      if (!alive || !canvas.current) return;
      const base = pg.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const vp = pg.getViewport({ scale: (width / base.width) * dpr });
      const c = canvas.current;
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      task = pg.render({ canvas: c, viewport: vp });
      task.promise.then(
        () => alive && setDrawn(true),
        () => {},
      );
    });
    return () => {
      alive = false;
      task?.cancel();
    };
  }, [doc, num, width]);
  // 次のページを先に読み込んでおく
  useEffect(() => {
    if (num < doc.numPages) void doc.getPage(num + 1);
  }, [doc, num]);
  return (
    <div className={`pdf-page pdf-page-${side} ${drawn ? 'is-drawn' : ''}`} style={{ width, height }}>
      <canvas ref={canvas} style={{ width, height }} aria-label={`${num} ページ`} />
    </div>
  );
}
