/**
 * 勉強時間記録の集計（画面の部品から分けた計算だけの部分。studyStats.test.ts で確かめる）
 */
import type { DbData, DbRow } from './dbModel';

export const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
/** 日付を「2026-11-17」の形に（端末の時刻で） */
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 分を「2時間30分」のように */
export function formatMinutes(min: number) {
  const m = Math.round(min);
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}時間${m % 60}分` : `${h}時間`;
}

/** 週のはじめ（月曜日） */
export function weekStart(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export type Entry = { r: DbRow; d: Date; min: number };

/** 日付と時間が入っている記録 */
export const studyEntries = (data: DbData) =>
  data.rows
    .map((r) => ({ r, d: typeof r.values.date === 'string' ? new Date(`${r.values.date}T00:00:00`) : null, min: num(r.values.minutes) }))
    .filter((x) => x.d && !Number.isNaN(x.d.getTime()) && x.min > 0) as Entry[];
export const totalOf = (list: Entry[]) => list.reduce((a, x) => a + x.min, 0);

export type Trend = 'week' | 'month' | 'year' | 'total';

/** 目盛り（時間）：きりのよい間隔で 3〜5 本。1 時間に満たないときは 15 分きざみ */
export function hourTicks(maxHours: number) {
  if (maxHours <= 0) return { max: 1, ticks: [0, 0.5, 1] };
  const rough = maxHours / 4;
  let step: number;
  if (rough <= 0.25) step = 0.25;
  else if (rough <= 0.5) step = 0.5;
  else {
    const p = 10 ** Math.floor(Math.log10(rough));
    const n = rough / p;
    step = Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p);
  }
  const max = Math.ceil(maxHours / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return { max, ticks };
}

export type Bucket = { key: string; label: string; tip: string; from: Date; to: Date; min: number; count: number };

/** 期間の入れ物を作る（0 の期間も場所を空けておく） */
export function trendBuckets(entries: Entry[], trend: Trend, now: Date): Bucket[] {
  const list: Omit<Bucket, 'min' | 'count'>[] = [];
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (trend === 'week') {
    // この 12 週
    const end = weekStart(now);
    for (let i = 11; i >= 0; i--) {
      const s = new Date(end);
      s.setDate(end.getDate() - i * 7);
      const e = new Date(s);
      e.setDate(s.getDate() + 7);
      list.push({ key: ymd(s), label: `${s.getMonth() + 1}/${s.getDate()}`, tip: `${s.getMonth() + 1}/${s.getDate()}（月）からの週`, from: s, to: e });
    }
  } else if (trend === 'month') {
    // この 12 か月
    for (let i = 11; i >= 0; i--) {
      const s = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const e = new Date(s.getFullYear(), s.getMonth() + 1, 1);
      list.push({ key: ymd(s), label: s.getMonth() === 0 || i === 11 ? `${s.getFullYear() % 100}/${s.getMonth() + 1}` : `${s.getMonth() + 1}`, tip: `${s.getFullYear()}年${s.getMonth() + 1}月`, from: s, to: e });
    }
  } else if (trend === 'year') {
    const first = Math.min(now.getFullYear(), ...entries.map((x) => x.d.getFullYear()));
    for (let y = first; y <= now.getFullYear(); y++) list.push({ key: `${y}`, label: `${y}`, tip: `${y}年`, from: new Date(y, 0, 1), to: new Date(y + 1, 0, 1) });
  } else {
    // 合計：最初の記録から今日までの累計。長さに合わせて、日・週・月ごとに点を打つ
    const first = entries.length ? day(new Date(Math.min(...entries.map((x) => x.d.getTime())))) : day(now);
    const today = day(now);
    const days = Math.round((today.getTime() - first.getTime()) / 86400000) + 1;
    if (days <= 62) {
      // 短いときも 2 週間分は見せる
      const s0 = new Date(today);
      s0.setDate(today.getDate() - Math.max(days, 14) + 1);
      for (let d = new Date(s0); d <= today; d.setDate(d.getDate() + 1)) {
        const s = new Date(d);
        const e = new Date(d);
        e.setDate(d.getDate() + 1);
        list.push({ key: ymd(s), label: `${s.getMonth() + 1}/${s.getDate()}`, tip: `${s.getFullYear()}/${s.getMonth() + 1}/${s.getDate()} まで`, from: s, to: e });
      }
    } else if (days <= 7 * 104) {
      for (let s = weekStart(first); s <= today; ) {
        const e = new Date(s);
        e.setDate(s.getDate() + 7);
        list.push({ key: ymd(s), label: `${s.getMonth() + 1}/${s.getDate()}`, tip: `${s.getFullYear()}/${s.getMonth() + 1}/${s.getDate()} の週まで`, from: s, to: e });
        s = e;
      }
    } else {
      for (let s = new Date(first.getFullYear(), first.getMonth(), 1); s <= today; ) {
        const e = new Date(s.getFullYear(), s.getMonth() + 1, 1);
        list.push({ key: ymd(s), label: `${s.getFullYear() % 100}/${s.getMonth() + 1}`, tip: `${s.getFullYear()}年${s.getMonth() + 1}月まで`, from: s, to: e });
        s = e;
      }
    }
  }
  let acc = 0;
  let accCount = 0;
  return list.map((b) => {
    const inside = entries.filter((x) => (trend === 'total' ? x.d < b.to : x.d >= b.from && x.d < b.to));
    if (trend === 'total') {
      acc = totalOf(inside);
      accCount = inside.length;
      return { ...b, min: acc, count: accCount };
    }
    return { ...b, min: totalOf(inside), count: inside.length };
  });
}
