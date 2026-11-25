/**
 * 勉強時間記録（勉強時間のデータベース）の道具：
 * - 勉強した時間を、科目・種類と一緒に記録する（講義ノートは別の「講義ノート」テンプレートで書く）
 * - 勉強時間を、今日・今週・今月・全期間と、年・月・週ごと、科目ごとに集計する
 */
import { useMemo, useState } from 'react';
import { api, type Page } from '../api';
import { Button, Modal, useUi } from '../ui';
import { COLORS, newId, type DbData, type DbSchema } from './dbModel';
import { formatMinutes, hourTicks, num, studyEntries, totalOf, trendBuckets, weekStart, ymd, type Entry, type Trend } from './studyStats';

export { formatMinutes };

/** 勉強記録のデータベースか（テンプレートで作ったもの） */
export const isStudyDb = (data: DbData) => data.schema.kind === 'study';

const prop = (schema: DbSchema, id: string) => schema.props.find((p) => p.id === id);

/* ---------- 記録する ---------- */

export function StudyAddDialog({ dbId, data, onClose, onAdded }: { dbId: string; data: DbData; onClose: () => void; onAdded: (rowId: string) => void }) {
  const { toast } = useUi();
  const subjects = prop(data.schema, 'subject')?.options ?? [];
  const types = prop(data.schema, 'type')?.options ?? [];
  // 前回と同じ科目から始める
  const lastSubject = useMemo(() => {
    const last = [...data.rows].sort((a, b) => b.createdAt - a.createdAt).find((r) => typeof r.values.subject === 'string');
    return (last?.values.subject as string | undefined) ?? subjects[0]?.id ?? '';
  }, [data, subjects]);
  const [subject, setSubject] = useState(subjects.length ? lastSubject : '__new');
  const [newSubject, setNewSubject] = useState('');
  const [type, setType] = useState(types.find((o) => o.id === 'self')?.id ?? types[0]?.id ?? '');
  const [date, setDate] = useState(ymd(new Date()));
  const [minutes, setMinutes] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (busy) return;
    setBusy(true);
    try {
      let subjectId: string | null = subject && subject !== '__new' ? subject : null;
      let subjectName = subjects.find((o) => o.id === subjectId)?.name ?? '';
      // 新しい科目は、科目の選択肢に足してから使う
      const typed = newSubject.trim();
      if (subject === '__new' && typed) {
        const existing = subjects.find((o) => o.name === typed);
        if (existing) subjectId = existing.id;
        else {
          subjectId = newId();
          const option = { id: subjectId, name: typed, color: COLORS[subjects.length % COLORS.length]! };
          const schema: DbSchema = { ...data.schema, props: data.schema.props.map((p) => (p.id === 'subject' ? { ...p, options: [...(p.options ?? []), option] } : p)) };
          await api(`/pages/${dbId}/database/schema`, { method: 'PUT', body: schema });
        }
        subjectName = typed;
      }
      const name = title.trim() || subjectName || '勉強';
      const { page } = await api<{ page: Page }>('/pages', { body: { parentId: dbId, title: name } });
      const values: Record<string, unknown> = { date };
      if (subjectId) values.subject = subjectId;
      if (type) values.type = type;
      if (minutes.trim() && num(minutes) > 0) values.minutes = num(minutes);
      await api(`/pages/${dbId}/database/rows/${page.id}`, { method: 'PATCH', body: { values } });
      toast(`「${name}」を記録しました`, 'success');
      onAdded(page.id);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="勉強時間を記録" width={440}>
      <div className="modal-body book-add study-add">
        <label className="study-field">
          <span>科目</span>
          <select className="input" value={subject} onChange={(e) => setSubject(e.target.value)}>
            {subjects.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
            <option value="__new">＋ 新しい科目…</option>
          </select>
        </label>
        {subject === '__new' && <input className="input" placeholder="科目の名前（例：線形代数）" value={newSubject} autoFocus onChange={(e) => setNewSubject(e.target.value)} aria-label="新しい科目の名前" />}
        <div className="book-add-row">
          {types.length > 0 && (
            <label className="study-field">
              <span>種類</span>
              <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
                {types.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="study-field">
            <span>日付</span>
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        <label className="study-field">
          <span>時間（分）</span>
          <div className="book-add-row">
            <input className="input" type="number" inputMode="numeric" min={0} step={5} placeholder="例：60" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            {[30, 60, 90].map((m) => (
              <Button key={m} size="sm" variant="ghost" onClick={() => setMinutes(String(m))}>
                {m}
              </Button>
            ))}
          </div>
        </label>
        <label className="study-field">
          <span>内容（空なら科目名）</span>
          <input className="input" placeholder="例：問題集 p.20〜35" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <Button variant="primary" onClick={() => void add()} loading={busy}>
          記録する
        </Button>
      </div>
    </Modal>
  );
}

/* ---------- 集計 ---------- */

type Unit = 'year' | 'month' | 'week';
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

export function StudyStats({ data }: { data: DbData }) {
  const entries = useMemo(() => studyEntries(data), [data]);
  const years = [...new Set(entries.map((x) => x.d.getFullYear()))].sort((a, b) => b - a);
  const [unit, setUnit] = useState<Unit>('week');
  const [year, setYear] = useState(() => years[0] ?? new Date().getFullYear());
  const total = totalOf;

  const scoped = unit === 'year' ? entries : entries.filter((x) => x.d.getFullYear() === year);
  const groups = useMemo(() => {
    const m = new Map<string, { label: string; list: Entry[]; order: number }>();
    for (const x of scoped) {
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
  }, [scoped, unit]);
  const maxGroup = Math.max(1, ...groups.map((g) => total(g.list)));

  // 科目ごと（年ごとのときは全期間、それ以外は選んだ年）
  const subjectProp = prop(data.schema, 'subject');
  const bySubject = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of scoped) {
      const id = typeof x.r.values.subject === 'string' ? x.r.values.subject : '';
      m.set(id, (m.get(id) ?? 0) + x.min);
    }
    return [...m.entries()]
      .map(([id, min]) => ({ name: subjectProp?.options?.find((o) => o.id === id)?.name ?? '科目なし', color: subjectProp?.options?.find((o) => o.id === id)?.color ?? 'gray', min }))
      .sort((a, b) => b.min - a.min);
  }, [scoped, subjectProp]);
  const maxSubject = Math.max(1, ...bySubject.map((s) => s.min));

  return (
    <div className="book-stats">
      <div className="book-stats-bar">
        <div className="segmented" role="tablist">
          {(
            [
              ['week', '週ごと'],
              ['month', '月ごと'],
              ['year', '年ごと'],
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
        <p className="muted small">まだ記録がありません。「日付」と「時間（分）」を入れると集計されます。</p>
      ) : (
        <>
          <table className="book-stats-table">
            <thead>
              <tr>
                <th>期間</th>
                <th>勉強時間</th>
                <th>回数</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const min = total(g.list);
                return (
                  <tr key={g.label}>
                    <td>{g.label}</td>
                    <td>
                      <span className="book-bar" style={{ width: `${(min / maxGroup) * 100}%` }} />
                      <span className="book-bar-label">{formatMinutes(min)}</span>
                    </td>
                    <td>{g.list.length} 回</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <h4 className="study-subject-title">科目ごと{unit === 'year' ? '（全期間）' : `（${year}年）`}</h4>
          <table className="book-stats-table">
            <tbody>
              {bySubject.map((s) => (
                <tr key={s.name}>
                  <td>
                    <span className={`db-tag c-${s.color}`}>{s.name}</span>
                  </td>
                  <td>
                    <span className="book-bar" style={{ width: `${(s.min / maxSubject) * 100}%` }} />
                    <span className="book-bar-label">{formatMinutes(s.min)}</span>
                  </td>
                  <td>{Math.round((s.min / Math.max(1, total(scoped))) * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/* ---------- 勉強時間のトップ（今日・今週・今月・全期間と、推移のグラフ） ---------- */

const TREND: [Trend, string][] = [
  ['week', '1週間ごと'],
  ['month', '1ヶ月ごと'],
  ['year', '1年ごと'],
  ['total', '合計'],
];

const hourLabel = (h: number) => (h > 0 && h < 1 ? `${Math.round(h * 60)}分` : `${h.toLocaleString()}時間`);

function StudyTrendChart({ entries }: { entries: Entry[] }) {
  const [trend, setTrend] = useState<Trend>(() => {
    try {
      const v = localStorage.getItem('study-trend');
      return TREND.some(([t]) => t === v) ? (v as Trend) : 'week';
    } catch {
      return 'week';
    }
  });
  const choose = (t: Trend) => {
    setTrend(t);
    setHover(null);
    try {
      localStorage.setItem('study-trend', t);
    } catch {
      /* 覚えられなくても使える */
    }
  };
  const [hover, setHover] = useState<number | null>(null);
  const buckets = useMemo(() => trendBuckets(entries, trend, new Date()), [entries, trend]);
  const { max, ticks } = hourTicks(Math.max(0, ...buckets.map((b) => b.min / 60)));
  const W = 720;
  const H = 210;
  const L = 56;
  const B = 24;
  const T = 10;
  const plotW = W - L - 6;
  const plotH = H - B - T;
  const slot = plotW / buckets.length;
  const yOf = (min: number) => T + plotH * (1 - min / 60 / max);
  const xOf = (i: number) => L + slot * i + slot / 2;
  // 目盛りの文字が重ならないように、だいたい 12 個まで出す
  const every = Math.max(1, Math.ceil(buckets.length / 12));
  // 合計は累計。ほかは期間ごとの合計
  const isTotal = trend === 'total';
  const sum = isTotal ? (buckets[buckets.length - 1]?.min ?? 0) : buckets.reduce((a, b) => a + b.min, 0);
  const avg = !isTotal && buckets.length ? sum / buckets.length : 0;
  const h = hover !== null ? buckets[hover] : null;
  const caption = { week: 'この 12 週', month: 'この 12 か月', year: '全期間', total: 'これまで' }[trend];
  const per = { week: '1週間', month: '1ヶ月', year: '1年', total: '' }[trend];
  const line = buckets.map((b, i) => `${i ? 'L' : 'M'}${xOf(i)},${yOf(b.min)}`).join(' ');

  return (
    <div className="trend study-trend">
      <div className="trend-bar">
        <div className="segmented" role="tablist" aria-label="推移の単位">
          {TREND.map(([t, l]) => (
            <button key={t} role="tab" aria-selected={trend === t} className={trend === t ? 'active' : ''} onClick={() => choose(t)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <p className="trend-caption">
        {caption}の勉強時間：<strong>{formatMinutes(sum)}</strong>
        {!isTotal && sum > 0 && (
          <>
            （{per}あたり平均 {formatMinutes(avg)}）
          </>
        )}
      </p>
      <div className="trend-plot" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`勉強時間の推移（${TREND.find(([t]) => t === trend)![1]}）`}>
          {ticks.map((v) => {
            const y = T + plotH * (1 - v / max);
            return (
              <g key={v}>
                <line x1={L} x2={W - 6} y1={y} y2={y} className="trend-grid" />
                <text x={L - 6} y={y + 4} textAnchor="end" className="trend-axis">
                  {hourLabel(v)}
                </text>
              </g>
            );
          })}
          {/* 折れ線（下を薄く塗る） */}
          {buckets.length > 0 && (
            <>
              <path className="study-trend-area" d={`${line} L${xOf(buckets.length - 1)},${T + plotH} L${xOf(0)},${T + plotH} Z`} />
              <path className="study-trend-line" d={line} />
              {hover !== null && <line className="study-trend-guide" x1={xOf(hover)} x2={xOf(hover)} y1={T} y2={T + plotH} />}
              {/* 点は、数が多くないときだけ全部に打つ（指している点はいつも出す） */}
              {buckets.map((b, i) =>
                buckets.length <= 31 || hover === i ? <circle key={b.key} className={`study-trend-dot ${hover === i ? 'is-hover' : ''}`} cx={xOf(i)} cy={yOf(b.min)} r={hover === i ? 5 : 3.5} /> : null,
              )}
            </>
          )}
          {buckets.map((b, i) => {
            return (
              <g key={b.key} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
                {/* 指しやすいよう、点より広い当たり判定 */}
                <rect x={L + slot * i} y={T} width={slot} height={plotH} fill="transparent" />
                {/* 右端（いま）にそろえて間引く */}
                {(buckets.length - 1 - i) % every === 0 && (
                  <text x={xOf(i)} y={H - 6} textAnchor="middle" className="trend-axis">
                    {b.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {h && (
          <div className="trend-tip" style={{ left: `${(xOf(hover!) / W) * 100}%` }}>
            <strong>{h.tip}</strong>
            <span>
              {isTotal ? '累計 ' : ''}
              {formatMinutes(h.min)}・{h.count} 回
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function StudyDashboard({ data }: { data: DbData }) {
  const entries = useMemo(() => studyEntries(data), [data]);
  const now = new Date();
  const todayKey = ymd(now);
  const ws = weekStart(now).getTime();
  const cards = [
    { label: '今日', list: entries.filter((x) => ymd(x.d) === todayKey) },
    { label: '今週', list: entries.filter((x) => weekStart(x.d).getTime() === ws) },
    { label: '今月', list: entries.filter((x) => x.d.getFullYear() === now.getFullYear() && x.d.getMonth() === now.getMonth()) },
    { label: '今年', list: entries.filter((x) => x.d.getFullYear() === now.getFullYear()) },
    { label: '合計', list: entries },
  ];
  return (
    <div className="study-dash">
      <div className="book-stats-cards">
        {cards.map((c) => (
          <div key={c.label} className="book-stat study-stat">
            <span>{c.label}</span>
            <strong>{formatMinutes(totalOf(c.list))}</strong>
            <em>{c.list.length} 回</em>
          </div>
        ))}
      </div>
      <StudyTrendChart entries={entries} />
    </div>
  );
}
