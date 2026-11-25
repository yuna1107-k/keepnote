/**
 * ページの下のサブページ一覧。
 * 題に日付（2026/11/06 など）が入ったページが多いときは、日記のように新しい順・月ごとに並べ、最初の数行も見せる。
 * それ以外のページは「そのほかのページ」にまとめる。いつでも「作った順」の素の一覧にも戻せる。
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type PageSummary } from '../api';
import { Icon, PageIcon, useUi } from '../ui';
import { useNavigate } from 'react-router-dom';
import { isJournal, pagePath, pageTitle, useWorkspace } from './WorkspaceContext';
import { usePageOpener } from './PagePeek';

type Preview = { id: string; snippet: string; updatedAt: number };
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

/** 題の頭の日付（2026/11/06・2026-11-06・2026年11月6日） */
export function titleDate(title: string): Date | null {
  const m = /^\s*(\d{4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})/.exec(title);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1 ? null : d;
}

/** 題から日付の部分を除いた残り（「2026/11/06 Fri 旅行」→「旅行」） */
function restOfTitle(title: string) {
  return title
    .replace(/^\s*\d{4}\s*[/\-.年]\s*\d{1,2}\s*[/\-.月]\s*\d{1,2}\s*日?/, '')
    .replace(/^\s*[（(]?\s*(Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*\.?\s*[）)]?/i, '')
    .replace(/^\s*[（(][日月火水木金土][）)]/, '')
    .replace(/^[\s\-–—:：・|]+/, '')
    .trim();
}

export function Subpages({ pageId, title, items, canAdd }: { pageId: string; title: string; items: PageSummary[]; canAdd: boolean }) {
  const ws = useWorkspace();
  const openPage = usePageOpener();
  // 「Journal 2026」などの日記のページは、新しい日付が上になるよう並べ、年のカレンダーも出す
  const journal = isJournal(title);
  // カレンダーと一覧で同じ年を使う（はじめは名前の年。「Journal 2026」なら 2026）
  const [year, setYear] = useState(() => Number(/(\d{4})/.exec(title)?.[1] ?? new Date().getFullYear()));
  const key = `subpages-mode-${pageId}`;
  const [mode, setMode] = useState<'smart' | 'plain'>(() => {
    try {
      return localStorage.getItem(key) === 'plain' ? 'plain' : 'smart';
    } catch {
      return 'smart';
    }
  });
  const dated = useMemo(() => items.map((p) => ({ p, d: titleDate(p.title) })).filter((x) => x.d) as { p: PageSummary; d: Date }[], [items]);
  // 日記のページは 1 件目から（まだなくても）カレンダーと日付ごとの表示にする
  const smart = journal || dated.length >= 2;
  const [previews, setPreviews] = useState<Map<string, Preview>>(new Map());
  const ids = items.map((i) => i.id).join(',');
  useEffect(() => {
    if (!smart || mode !== 'smart') return;
    let alive = true;
    api<{ previews: Preview[] }>(`/pages/${pageId}/previews`)
      .then((r) => alive && setPreviews(new Map(r.previews.map((x) => [x.id, x]))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pageId, ids, smart, mode]);
  const choose = (m: 'smart' | 'plain') => {
    setMode(m);
    try {
      localStorage.setItem(key, m);
    } catch {
      /* 覚えられなくても使える */
    }
  };

  const add = canAdd && (
    <button className="subpage-add" onClick={() => ws.createPage(pageId)}>
      <Icon name="plus" size={14} /> サブページを追加
    </button>
  );

  if (!smart || mode === 'plain') {
    return (
      <div className={`subpages ${journal ? 'is-journal' : ''}`}>
        {journal && <YearCalendar pageId={pageId} year={year} setYear={setYear} entries={dated} canAdd={canAdd} />}
        {smart && (
          <div className="subpages-bar">
            <button className="subpages-mode" onClick={() => choose('smart')}>
              日付ごとに表示
            </button>
          </div>
        )}
        {items.map((c) => (
          <Link key={c.id} to={pagePath(c, ws.current?.slug)} className="subpage-link" onClick={(e) => openPage(c.id, e)}>
            <PageIcon icon={c.icon} /> <span>{pageTitle(c)}</span>
          </Link>
        ))}
        {add}
      </div>
    );
  }

  // 月ごと（新しい順）に分ける
  const months = new Map<string, { label: string; list: { p: PageSummary; d: Date }[] }>();
  // 新しい日付が上（日記は同じ日なら名前の逆順）
  const order = (a: { p: PageSummary; d: Date }, b: { p: PageSummary; d: Date }) =>
    b.d.getTime() - a.d.getTime() || (journal ? b.p.title.localeCompare(a.p.title, 'ja', { numeric: true }) : b.p.updatedAt - a.p.updatedAt);
  for (const x of [...dated].filter((x) => !journal || x.d.getFullYear() === year).sort(order)) {
    const k = `${x.d.getFullYear()}-${x.d.getMonth()}`;
    if (!months.has(k)) months.set(k, { label: `${x.d.getFullYear()}年${x.d.getMonth() + 1}月`, list: [] });
    months.get(k)!.list.push(x);
  }
  const datedIds = new Set(dated.map((x) => x.p.id));
  const others = items.filter((p) => !datedIds.has(p.id));

  return (
    <div className={`subpages subpages-smart ${journal ? 'is-journal' : ''}`}>
      {journal && <YearCalendar pageId={pageId} year={year} setYear={setYear} entries={dated} canAdd={canAdd} />}
      <div className="subpages-bar">
        <span className="subpages-count">{journal ? `${year}年の日記 ${[...months.values()].reduce((n, m) => n + m.list.length, 0)} 件` : `${items.length} ページ`}</span>
        <button className="subpages-mode" onClick={() => choose('plain')}>
          作った順の一覧にする
        </button>
      </div>
      {journal && months.size === 0 && <p className="journal-empty">{year}年の日記はまだありません。カレンダーの日付を押すと、その日の日記を書けます。</p>}
      {[...months.values()].map((m) => (
        <section key={m.label} className="journal-month">
          <h3 className="journal-month-title">
            {m.label}
            <span>{m.list.length}</span>
          </h3>
          <div className="journal-list">
            {m.list.map(({ p, d }) => {
              const rest = restOfTitle(p.title);
              const snippet = previews.get(p.id)?.snippet ?? '';
              return (
                <Link key={p.id} to={pagePath(p, ws.current?.slug)} className="journal-entry" onClick={(e) => openPage(p.id, e)}>
                  <span className={`journal-date ${d.getDay() === 0 ? 'is-sun' : d.getDay() === 6 ? 'is-sat' : ''}`}>
                    <span className="journal-day">{d.getDate()}</span>
                    <span className="journal-week">{WEEK[d.getDay()]}</span>
                  </span>
                  <span className="journal-body">
                    <span className="journal-title">
                      {p.icon && <PageIcon icon={p.icon} size={15} />}
                      {rest || snippet.slice(0, 40) || <span className="journal-none">（まだ何も書いていません）</span>}
                    </span>
                    {snippet && (rest || snippet.length > 40) && <span className="journal-snippet">{rest ? snippet : snippet.slice(40)}</span>}
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
      {others.length > 0 && (
        <section className="journal-month">
          <h3 className="journal-month-title">
            そのほかのページ
            <span>{others.length}</span>
          </h3>
          <div className="subpage-grid">
            {others.map((c) => (
              <Link key={c.id} to={pagePath(c, ws.current?.slug)} className="subpage-link" onClick={(e) => openPage(c.id, e)}>
                <PageIcon icon={c.icon} /> <span>{pageTitle(c)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
      {add}
    </div>
  );
}

/** 年のカレンダー（Apple のカレンダーの「年」の表示のように 12 か月を並べ、日記のある日に点を付ける） */
export function YearCalendar({
  pageId,
  year,
  setYear,
  entries,
  canAdd,
}: {
  pageId: string;
  year: number;
  setYear: (fn: (y: number) => number) => void;
  entries: { p: PageSummary; d: Date }[];
  canAdd: boolean;
}) {
  const ws = useWorkspace();
  const openPage = usePageOpener();
  const { toast } = useUi();
  const [creating, setCreating] = useState(false);
  // 日記のない日を押したら、その日の日記（「2026/11/06 Fri」）を作って開く
  const create = async (y: number, m: number, d: number) => {
    if (creating) return;
    setCreating(true);
    try {
      const pad = (n: number) => String(n).padStart(2, '0');
      const name = `${y}/${pad(m + 1)}/${pad(d)} ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(y, m, d).getDay()]}`;
      const { page } = await api<{ page: { id: string } }>('/pages', { body: { parentId: pageId, title: name } });
      await ws.reload();
      openPage(page.id);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setCreating(false);
    }
  };
  const now = new Date();
  const byDay = useMemo(() => {
    const m = new Map<string, PageSummary[]>();
    for (const { p, d } of entries) {
      const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return m;
  }, [entries]);
  const count = entries.filter((x) => x.d.getFullYear() === year).length;
  const isToday = (m: number, d: number) => now.getFullYear() === year && now.getMonth() === m && now.getDate() === d;
  return (
    <div className="year-cal">
      <div className="year-cal-head">
        <button className="icon-btn" onClick={() => setYear((y) => y - 1)} aria-label="前の年">
          <Icon name="chevronLeft" />
        </button>
        <h3 className="year-cal-year">{year}</h3>
        <button className="icon-btn" onClick={() => setYear((y) => y + 1)} aria-label="次の年">
          <Icon name="chevronRight" />
        </button>
        <span className="year-cal-count">{count ? `${count} 日分の日記` : 'この年の日記はありません'}</span>
      </div>
      <div className="year-cal-grid">
        {Array.from({ length: 12 }, (_, m) => {
          const first = new Date(year, m, 1).getDay();
          const days = new Date(year, m + 1, 0).getDate();
          const current = now.getFullYear() === year && now.getMonth() === m;
          return (
            <div key={m} className="year-cal-month">
              <div className={`year-cal-month-name ${current ? 'is-current' : ''}`}>{m + 1}月</div>
              <div className="year-cal-days">
                {WEEK.map((w, i) => (
                  <span key={w} className={`year-cal-week ${i === 0 ? 'is-sun' : ''}`}>
                    {w}
                  </span>
                ))}
                {Array.from({ length: first }, (_, i) => (
                  <span key={`b${i}`} />
                ))}
                {Array.from({ length: days }, (_, i) => {
                  const d = i + 1;
                  const list = byDay.get(`${year}-${m}-${d}`);
                  const cls = `year-cal-day ${isToday(m, d) ? 'is-today' : ''} ${list ? 'has-entry' : ''} ${(first + i) % 7 === 0 ? 'is-sun' : ''}`;
                  return list ? (
                    <button
                      key={d}
                      className={cls}
                      title={list.map((p) => pageTitle(p)).join('\n')}
                      aria-label={`${m + 1}月${d}日の日記を開く`}
                      onClick={(e) => openPage(list[0]!.id, e)}
                    >
                      <span className="year-cal-num">{d}</span>
                      <span className="year-cal-dot" />
                    </button>
                  ) : canAdd ? (
                    <button key={d} className={`${cls} is-empty`} disabled={creating} aria-label={`${m + 1}月${d}日の日記を書く`} title="この日の日記を書く" onClick={() => void create(year, m, d)}>
                      <span className="year-cal-num">{d}</span>
                    </button>
                  ) : (
                    <span key={d} className={cls}>
                      <span className="year-cal-num">{d}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
