/**
 * 読書記録（本のデータベース）の道具：
 * - ISBN の入力やバーコードの読み取りで本を追加する（タイトル・著者・表紙などは自動で取ってくる）
 * - 読み終えた本の冊数・ページ数・費用（定価）を、全期間・年・月・週ごとに集計する
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, uploadFile, type Page, type PageSummary } from '../api';
import { Button, Icon, Modal, useUi } from '../ui';
import type { DbData, DbRow, DbSchema } from './dbModel';
import { NDC_CLASSES } from './templates';
import { ymd } from './due';
import { YearCalendar } from './Subpages';
import { useWorkspace } from './WorkspaceContext';
import { usePageOpener } from './PagePeek';

type Book = { isbn: string; title: string; authors: string[]; publisher: string | null; published: string | null; pages: number | null; price: number | null; cover: string | null; source: string; ndc: string | null };

/** 読書記録のデータベースか（テンプレートで作ったもの、または ISBN の列があるもの） */
export const isBookDb = (data: DbData) => data.schema.kind === 'books' || data.schema.props.some((p) => p.id === 'isbn');

const optionId = (data: DbData, propId: string, name: string) => data.schema.props.find((p) => p.id === propId)?.options?.find((o) => o.name === name || o.id === name)?.id;

/* ---------- ISBN・バーコードから追加 ---------- */

export function BookAddDialog({ dbId, data, onClose, onAdded }: { dbId: string; data: DbData; onClose: () => void; onAdded: (rowId: string) => void }) {
  const { toast } = useUi();
  const [isbn, setIsbn] = useState('');
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(() => optionId(data, 'status', 'done') ?? 'done');
  const [finished, setFinished] = useState(ymd(new Date()));
  const [scanning, setScanning] = useState(false);
  // 表紙が見つからないときは、写真を撮るか画像を選んで表紙にする
  const [photo, setPhoto] = useState<File | null>(null);
  const photoUrl = useMemo(() => (photo ? URL.createObjectURL(photo) : null), [photo]);
  useEffect(() => () => void (photoUrl && URL.revokeObjectURL(photoUrl)), [photoUrl]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canScan = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
  const has = (id: string) => data.schema.props.some((p) => p.id === id);
  const duplicate = book && data.rows.some((r) => String(r.values.isbn ?? '').replace(/-/g, '') === book.isbn);

  const lookup = async (value = isbn) => {
    if (!value.trim()) return;
    setBusy(true);
    setError('');
    setBook(null);
    setPhoto(null);
    try {
      setBook((await api<{ book: Book }>(`/books/lookup?isbn=${encodeURIComponent(value)}`)).book);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // バーコードを読む（ブラウザの BarcodeDetector。Android の Chrome などで使える）
  useEffect(() => {
    if (!scanning) return;
    let stream: MediaStream | null = null;
    let alive = true;
    let timer = 0;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!alive) return stream.getTracks().forEach((t) => t.stop());
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();
        const detector = new (window as any).BarcodeDetector({ formats: ['ean_13'] });
        const tick = async () => {
          if (!alive) return;
          try {
            const codes = (await detector.detect(video)) as { rawValue: string }[];
            const hit = codes.map((c) => c.rawValue).find((v) => /^97[89]\d{10}$/.test(v));
            if (hit) {
              setScanning(false);
              setIsbn(hit);
              void lookup(hit);
              return;
            }
          } catch {
            /* 次のこまで試す */
          }
          timer = window.setTimeout(tick, 250);
        };
        void tick();
      } catch {
        setError('カメラを使えませんでした。ISBN の番号を入力してください');
        setScanning(false);
      }
    })();
    return () => {
      alive = false;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [scanning]);

  const add = async () => {
    if (!book) return;
    setBusy(true);
    try {
      const { page } = await api<{ page: Page }>('/pages', { body: { parentId: dbId, title: book.title } });
      // 表紙は本のページのカバーにする（撮った写真があればそちら）
      const cover = photo ? await uploadFile(photo) : book.cover && /^https:\/\//.test(book.cover) ? book.cover : null;
      if (cover) await api(`/pages/${page.id}`, { method: 'PATCH', body: { version: page.version, cover, coverPosition: 30 } }).catch(() => {});
      const values: Record<string, unknown> = {};
      if (has('author') && book.authors.length) values.author = book.authors.join('、');
      if (has('status')) values.status = status;
      if (has('finished') && status === (optionId(data, 'status', 'done') ?? 'done')) values.finished = finished;
      if (has('pages') && book.pages) values.pages = book.pages;
      if (has('price') && book.price) values.price = book.price;
      if (has('publisher') && book.publisher) values.publisher = book.publisher;
      if (has('isbn')) values.isbn = book.isbn;
      // ジャンル：日本十進分類法の番号の頭の数字で分ける（例：913.6 → 9 文学）
      if (book.ndc && has('ndc')) values.ndc = book.ndc;
      const genre = data.schema.props.find((p) => p.id === 'genre' && p.type === 'multi_select');
      const cls = book.ndc ? NDC_CLASSES.find(([d]) => d === book.ndc![0]) : undefined;
      if (genre && cls) {
        const id = `ndc${cls[0]}`;
        // 前に作った読書記録で選択肢がなければ足す
        if (!genre.options?.some((o) => o.id === id)) {
          const schema: DbSchema = { ...data.schema, props: data.schema.props.map((p) => (p.id === 'genre' ? { ...p, options: [...(p.options ?? []), { id, name: `${cls[0]} ${cls[1]}`, color: 'gray' }] } : p)) };
          await api(`/pages/${dbId}/database/schema`, { method: 'PUT', body: schema });
        }
        values.genre = [id];
      }
      await api(`/pages/${dbId}/database/rows/${page.id}`, { method: 'PATCH', body: { values } });
      toast(`「${book.title}」を追加しました`, 'success');
      setBook(null);
      setIsbn('');
      setPhoto(null);
      onAdded(page.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const statusProp = data.schema.props.find((p) => p.id === 'status' && p.type === 'select');
  return (
    <Modal open onClose={onClose} title="本を追加" width={460}>
      <div className="modal-body book-add">
        <div className="book-add-row">
          <input
            className="input"
            inputMode="numeric"
            placeholder="ISBN（例：9784101010014）"
            value={isbn}
            autoFocus
            onChange={(e) => setIsbn(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void lookup()}
          />
          <Button onClick={() => void lookup()} loading={busy && !book} disabled={!isbn.trim()}>
            調べる
          </Button>
        </div>
        {canScan && (
          <Button variant="ghost" onClick={() => setScanning((v) => !v)}>
            <Icon name="image" size={15} /> {scanning ? '読み取りをやめる' : 'カメラでバーコードを読む'}
          </Button>
        )}
        {scanning && <video ref={videoRef} className="book-scan" muted playsInline />}
        {!canScan && <p className="muted small">本の裏の「978」または「979」で始まる 13 桁の番号を入力してください。</p>}
        {error && <p className="auth-error">{error}</p>}
        {book && (
          <div className="book-card">
            <label className="book-cover-pick" title="表紙の写真を撮る・画像を選ぶ">
              {photoUrl || book.cover ? (
                <img src={photoUrl ?? book.cover!} alt="" className="book-cover" referrerPolicy="no-referrer" />
              ) : (
                <span className="book-cover is-empty">
                  表紙なし
                  <br />
                  写真を撮る
                </span>
              )}
              <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
            </label>
            <div className="book-info">
              <strong>{book.title}</strong>
              <span>{book.authors.join('、') || '著者不明'}</span>
              <span className="muted small">
                {[book.publisher, book.pages && `${book.pages} ページ`, book.price && `${book.price.toLocaleString()} 円`].filter(Boolean).join('・')}
              </span>
              {book.ndc && <span className="muted small">分類：{book.ndc}（{NDC_CLASSES.find(([d]) => d === book.ndc![0])?.[1] ?? ''}）</span>}
              <span className="muted small">出典：{book.source}</span>
              <span className="muted small">表紙を押すと、写真を撮ったり画像を選んだりして表紙にできます</span>
            </div>
          </div>
        )}
        {book && duplicate && <p className="approve-warn">この本はすでに記録されています。</p>}
        {book && statusProp && (
          <div className="book-add-row">
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="状態">
              {statusProp.options?.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            {status === (optionId(data, 'status', 'done') ?? 'done') && <input className="input" type="date" value={finished} onChange={(e) => setFinished(e.target.value)} aria-label="読み終えた日" />}
          </div>
        )}
        {book && (
          <Button variant="primary" onClick={() => void add()} loading={busy}>
            この本を追加
          </Button>
        )}
      </div>
    </Modal>
  );
}

/* ---------- 集計 ---------- */

type Unit = 'year' | 'month' | 'week';
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

/** 週のはじめ（月曜日） */
function weekStart(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export function BookStats({ data }: { data: DbData }) {
  const doneId = optionId(data, 'status', 'done') ?? 'done';
  // 読み終えた本（「読了」か、読み終えた日があるもの）
  const finished = useMemo(
    () =>
      data.rows
        .map((r: DbRow) => ({ r, d: typeof r.values.finished === 'string' ? new Date(`${r.values.finished}T00:00:00`) : null }))
        .filter((x) => x.d && !Number.isNaN(x.d.getTime()) && (!r_status(x.r) || r_status(x.r) === doneId)) as { r: DbRow; d: Date }[],
    [data, doneId],
  );
  function r_status(r: DbRow) {
    return r.values.status as string | undefined;
  }
  const years = [...new Set(finished.map((x) => x.d.getFullYear()))].sort((a, b) => b - a);
  const [unit, setUnit] = useState<Unit>('year');
  const [year, setYear] = useState(() => years[0] ?? new Date().getFullYear());
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
  const sum = (list: { r: DbRow }[]) => ({
    books: list.length,
    pages: list.reduce((a, x) => a + num(x.r.values.pages), 0),
    cost: list.reduce((a, x) => a + num(x.r.values.price), 0),
    unknownPrice: list.filter((x) => !num(x.r.values.price)).length,
  });
  const total = sum(finished);

  const groups = useMemo(() => {
    const m = new Map<string, { label: string; list: { r: DbRow; d: Date }[]; order: number }>();
    for (const x of finished) {
      if (unit !== 'year' && x.d.getFullYear() !== year) continue;
      let key: string;
      let label: string;
      let order: number;
      if (unit === 'year') {
        key = String(x.d.getFullYear());
        label = `${key}年`;
        order = x.d.getFullYear();
      } else if (unit === 'month') {
        key = `${x.d.getMonth()}`;
        label = `${x.d.getMonth() + 1}月`;
        order = x.d.getMonth();
      } else {
        const s = weekStart(x.d);
        const e = new Date(s);
        e.setDate(s.getDate() + 6);
        key = ymd(s);
        label = `${s.getMonth() + 1}/${s.getDate()}（${WEEK[s.getDay()]}）〜 ${e.getMonth() + 1}/${e.getDate()}`;
        order = s.getTime();
      }
      if (!m.has(key)) m.set(key, { label, list: [], order });
      m.get(key)!.list.push(x);
    }
    return [...m.values()].sort((a, b) => b.order - a.order);
  }, [finished, unit, year]);
  const maxBooks = Math.max(1, ...groups.map((g) => g.list.length));
  const yearTotal = sum(finished.filter((x) => x.d.getFullYear() === year));

  return (
    <div className="book-stats">
      <div className="book-stats-cards">
        <div className="book-stat">
          <span>全期間</span>
          <strong>{total.books} 冊</strong>
          <em>
            {total.pages.toLocaleString()} ページ・{total.cost.toLocaleString()} 円
          </em>
        </div>
        {unit !== 'year' && (
          <div className="book-stat">
            <span>{year}年</span>
            <strong>{yearTotal.books} 冊</strong>
            <em>
              {yearTotal.pages.toLocaleString()} ページ・{yearTotal.cost.toLocaleString()} 円
            </em>
          </div>
        )}
      </div>
      <div className="book-stats-bar">
        <div className="segmented" role="tablist">
          {(
            [
              ['year', '年ごと'],
              ['month', '月ごと'],
              ['week', '週ごと'],
            ] as const
          ).map(([u, l]) => (
            <button key={u} role="tab" aria-selected={unit === u} className={unit === u ? 'active' : ''} onClick={() => setUnit(u)}>
              {l}
            </button>
          ))}
        </div>
        {unit !== 'year' && (
          <select className="input book-year" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="年">
            {(years.length ? years : [year]).map((y) => (
              <option key={y} value={y}>
                {y}年
              </option>
            ))}
          </select>
        )}
      </div>
      {groups.length === 0 ? (
        <p className="muted small">まだ読み終えた本がありません。「状態」を読了にして「読み終えた日」を入れると集計されます。</p>
      ) : (
        <table className="book-stats-table">
          <thead>
            <tr>
              <th>期間</th>
              <th>冊数</th>
              <th>ページ</th>
              <th>費用（定価）</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const s = sum(g.list);
              return (
                <tr key={g.label}>
                  <td>{g.label}</td>
                  <td>
                    <span className="book-bar" style={{ width: `${(s.books / maxBooks) * 100}%` }} />
                    <span className="book-bar-label">{s.books} 冊</span>
                  </td>
                  <td>{s.pages.toLocaleString()}</td>
                  <td>
                    {s.cost.toLocaleString()} 円{s.unknownPrice > 0 && <span className="muted small">（定価なし {s.unknownPrice} 冊）</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ---------- 読書記録のトップ（ウィジェット） ---------- */

function Shelf({ rows, ratingOf, empty }: { rows: DbRow[]; ratingOf: (r: DbRow) => string; empty: string }) {
  const openPage = usePageOpener();
  if (!rows.length) return <p className="muted small book-shelf-empty">{empty}</p>;
  return (
    <div className="book-shelf">
      {rows.map((r) => (
        <button key={r.id} className="book-shelf-item" onClick={(e) => openPage(r.id, e)} title={r.title}>
          {r.cover && /^https:\/\//.test(r.cover) ? (
            <img src={r.cover} alt="" className="book-shelf-cover" referrerPolicy="no-referrer" loading="lazy" />
          ) : (
            <span className="book-shelf-cover is-empty">{r.title || '無題'}</span>
          )}
          <span className="book-shelf-title">{r.title || '無題'}</span>
          {ratingOf(r) && <span className="book-shelf-rating">{ratingOf(r)}</span>}
        </button>
      ))}
    </div>
  );
}

type Metric = 'books' | 'pages' | 'cost';
const METRIC: Record<Metric, { label: string; unit: string }> = { books: { label: '冊数', unit: '冊' }, pages: { label: 'ページ', unit: 'ページ' }, cost: { label: '金額', unit: '円' } };

/** 目盛り：きりのよい間隔で 3〜5 本。冊数のような整数は、目盛りも必ず整数にする */
function niceTicks(maxValue: number) {
  if (maxValue <= 0) return { max: 1, ticks: [0, 1] };
  const rough = maxValue / 4;
  const p = 10 ** Math.floor(Math.log10(rough));
  const n = rough / p;
  const step = Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p);
  const max = Math.ceil(maxValue / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) ticks.push(v);
  return { max, ticks };
}

/** 推移のグラフ（1 つの量だけを棒で。上は丸め、指すと値を出す） */
function TrendChart({ finished }: { finished: { r: DbRow; d: Date }[] }) {
  const now = new Date();
  const [metric, setMetric] = useState<Metric>('books');
  const [unit, setUnit] = useState<Unit>('month');
  const years = [...new Set([now.getFullYear(), ...finished.map((x) => x.d.getFullYear())])].sort((a, b) => b - a);
  const [year, setYear] = useState(now.getFullYear());
  const [hover, setHover] = useState<number | null>(null);
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
  // 期間ごとの入れ物を先に作る（0 の期間も棒の場所を空けておく）
  const buckets = useMemo(() => {
    const list: { key: string; label: string; tip: string; from: Date; to: Date }[] = [];
    if (unit === 'month') {
      for (let m = 0; m < 12; m++) list.push({ key: `${m}`, label: `${m + 1}`, tip: `${year}年${m + 1}月`, from: new Date(year, m, 1), to: new Date(year, m + 1, 1) });
    } else if (unit === 'week') {
      const end = weekStart(now);
      for (let i = 11; i >= 0; i--) {
        const s = new Date(end);
        s.setDate(end.getDate() - i * 7);
        const e = new Date(s);
        e.setDate(s.getDate() + 7);
        list.push({ key: ymd(s), label: `${s.getMonth() + 1}/${s.getDate()}`, tip: `${s.getMonth() + 1}/${s.getDate()}（月）からの週`, from: s, to: e });
      }
    } else {
      const ys = [...years].sort((a, b) => a - b);
      for (const y of ys) list.push({ key: `${y}`, label: `${y}`, tip: `${y}年`, from: new Date(y, 0, 1), to: new Date(y + 1, 0, 1) });
    }
    return list.map((b) => {
      const inside = finished.filter((x) => x.d >= b.from && x.d < b.to);
      return { ...b, books: inside.length, pages: inside.reduce((a, x) => a + num(x.r.values.pages), 0), cost: inside.reduce((a, x) => a + num(x.r.values.price), 0) };
    });
  }, [finished, unit, year]);
  const { max, ticks } = niceTicks(Math.max(0, ...buckets.map((b) => b[metric])));
  const W = 720;
  const H = 210;
  const L = 44;
  const B = 24;
  const T = 10;
  const plotW = W - L - 6;
  const plotH = H - B - T;
  const slot = plotW / buckets.length;
  const barW = Math.max(4, Math.min(28, slot - 2 - slot * 0.35));
  const fmt = (v: number) => v.toLocaleString();
  const total = buckets.reduce((a, b) => a + b[metric], 0);
  const h = hover !== null ? buckets[hover] : null;
  return (
    <div className="trend">
      <div className="trend-bar">
        <div className="segmented" role="tablist" aria-label="グラフにする量">
          {(Object.keys(METRIC) as Metric[]).map((m) => (
            <button key={m} role="tab" aria-selected={metric === m} className={metric === m ? 'active' : ''} onClick={() => setMetric(m)}>
              {METRIC[m].label}
            </button>
          ))}
        </div>
        <div className="segmented" role="tablist" aria-label="期間">
          {(
            [
              ['month', '月ごと'],
              ['week', '週ごと'],
              ['year', '年ごと'],
            ] as const
          ).map(([u, l]) => (
            <button key={u} role="tab" aria-selected={unit === u} className={unit === u ? 'active' : ''} onClick={() => setUnit(u)}>
              {l}
            </button>
          ))}
        </div>
        {unit === 'month' && (
          <select className="input book-year" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="年">
            {years.map((y) => (
              <option key={y} value={y}>
                {y}年
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="trend-caption">
        {unit === 'month' ? `${year}年` : unit === 'week' ? 'この 12 週' : '全期間'}の{METRIC[metric].label}：<strong>{fmt(total)} {METRIC[metric].unit}</strong>
      </p>
      <div className="trend-plot" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${METRIC[metric].label}の推移`}>
          {ticks.map((v) => {
            const y = T + plotH * (1 - v / max);
            return (
              <g key={v}>
                <line x1={L} x2={W - 6} y1={y} y2={y} className="trend-grid" />
                <text x={L - 6} y={y + 4} textAnchor="end" className="trend-axis">
                  {fmt(v)}
                </text>
              </g>
            );
          })}
          {buckets.map((b, i) => {
            const v = b[metric];
            const bh = (v / max) * plotH;
            const x = L + slot * i + (slot - barW) / 2;
            const y = T + plotH - bh;
            const r = Math.min(4, barW / 2, bh);
            return (
              <g key={b.key} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
                {/* 指しやすいよう、棒より広い当たり判定 */}
                <rect x={L + slot * i} y={T} width={slot} height={plotH} fill="transparent" />
                {v > 0 && (
                  <path
                    className={`trend-col ${hover === i ? 'is-hover' : ''}`}
                    d={`M${x},${T + plotH} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${T + plotH} Z`}
                  />
                )}
                {(buckets.length <= 12 || i % 2 === 0) && (
                  <text x={L + slot * i + slot / 2} y={H - 6} textAnchor="middle" className="trend-axis">
                    {b.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {h && (
          <div className="trend-tip" style={{ left: `${((L + slot * hover! + slot / 2) / W) * 100}%` }}>
            <strong>{h.tip}</strong>
            <span>
              {h.books} 冊・{fmt(h.pages)} ページ・{fmt(h.cost)} 円
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function BookDashboard({ dbId, data }: { dbId: string; data: DbData }) {
  const ws = useWorkspace();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const doneId = optionId(data, 'status', 'done') ?? 'done';
  const readingId = optionId(data, 'status', 'reading') ?? 'reading';
  const ratingProp = data.schema.props.find((p) => p.id === 'rating');
  // 点数（数値）なら「85点」。前に作った読書記録の ★ の選択肢にも対応する
  const ratingOf = (r: DbRow) => {
    const v = r.values.rating;
    if (ratingProp?.type === 'number') return typeof v === 'number' || (typeof v === 'string' && v !== '') ? `${v}点` : '';
    return ratingProp?.options?.find((o) => o.id === v)?.name ?? '';
  };
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
  const finished = data.rows
    .map((r) => ({ r, d: typeof r.values.finished === 'string' ? new Date(`${r.values.finished}T00:00:00`) : null }))
    .filter((x) => x.d && !Number.isNaN(x.d.getTime()) && (!x.r.values.status || x.r.values.status === doneId)) as { r: DbRow; d: Date }[];
  const total = (list: { r: DbRow }[]) => ({ books: list.length, pages: list.reduce((a, x) => a + num(x.r.values.pages), 0), cost: list.reduce((a, x) => a + num(x.r.values.price), 0) });
  const thisYear = total(finished.filter((x) => x.d.getFullYear() === now.getFullYear()));
  const thisMonth = total(finished.filter((x) => x.d.getFullYear() === now.getFullYear() && x.d.getMonth() === now.getMonth()));
  const all = total(finished);
  const reading = data.rows.filter((r) => r.values.status === readingId);
  const recent = [...finished].sort((a, b) => b.d.getTime() - a.d.getTime()).slice(0, 12).map((x) => x.r);
  // 読み終えた日に点を付けるカレンダー（日記と同じ形）
  const entries = finished.map((x) => ({ p: (ws.byId.get(x.r.id) ?? { id: x.r.id, title: x.r.title, icon: x.r.icon }) as PageSummary, d: x.d }));
  const tile = (label: string, value: string, unit: string, sub: string) => (
    <div className="book-tile">
      <span className="book-tile-label">{label}</span>
      <span className="book-tile-value">
        {value}
        <small>{unit}</small>
      </span>
      <span className="book-tile-sub">{sub}</span>
    </div>
  );
  return (
    <div className="book-dash">
      <div className="book-tiles">
        {tile(`${now.getFullYear()}年に読んだ本`, thisYear.books.toLocaleString(), '冊', `今月 ${thisMonth.books} 冊・全期間 ${all.books} 冊`)}
        {tile('読んだページ', thisYear.pages.toLocaleString(), 'ページ', `今月 ${thisMonth.pages.toLocaleString()}・全期間 ${all.pages.toLocaleString()}`)}
        {tile('本に使った金額（定価）', thisYear.cost.toLocaleString(), '円', `今月 ${thisMonth.cost.toLocaleString()}・全期間 ${all.cost.toLocaleString()}`)}
      </div>
      <section className="book-widget">
        <h3>読んだ量の推移</h3>
        <TrendChart finished={finished} />
      </section>
      <section className="book-widget">
        <h3>読書中</h3>
        <Shelf rows={reading} ratingOf={() => ''} empty="読んでいる本はありません。状態を「読書中」にすると、ここに並びます。" />
      </section>
      <section className="book-widget">
        <h3>最近読んだ本</h3>
        <Shelf rows={recent} ratingOf={ratingOf} empty="読み終えた本はまだありません。" />
      </section>
      <section className="book-widget book-widget-cal">
        <YearCalendar pageId={dbId} year={year} setYear={(fn) => setYear(fn)} entries={entries} canAdd={false} />
      </section>
    </div>
  );
}
