import { describe, expect, it } from 'vitest';
import { formatMinutes, hourTicks, trendBuckets, weekStart, type Entry } from '../src/web/workspace/studyStats';

const at = (s: string, min: number): Entry => ({ r: {} as Entry['r'], d: new Date(`${s}T00:00:00`), min });
const now = new Date('2026-11-17T12:00:00'); // 火曜日

describe('formatMinutes', () => {
  it('1 時間未満は分だけ', () => expect(formatMinutes(45)).toBe('45分'));
  it('ちょうどの時間', () => expect(formatMinutes(120)).toBe('2時間'));
  it('時間と分', () => expect(formatMinutes(150)).toBe('2時間30分'));
});

describe('weekStart', () => {
  it('月曜日に戻す', () => expect(weekStart(now).getDay()).toBe(1));
  it('日曜日は前の週の月曜日', () => expect(weekStart(new Date('2026-11-22T10:00:00')).getDate()).toBe(16));
});

describe('hourTicks', () => {
  it('1 時間未満は 15 分きざみ', () => expect(hourTicks(0.75)).toEqual({ max: 0.75, ticks: [0, 0.25, 0.5, 0.75] }));
  it('きりのよい間隔', () => expect(hourTicks(37)).toEqual({ max: 40, ticks: [0, 10, 20, 30, 40] }));
  it('0 のときも目盛りを出す', () => expect(hourTicks(0).ticks.length).toBeGreaterThan(1));
});

describe('trendBuckets', () => {
  const entries = [at('2026-11-10', 60), at('2026-11-16', 30), at('2026-11-17', 45), at('2025-03-01', 120), at('2026-01-05', 90)];
  it('週ごと：この 12 週', () => {
    const b = trendBuckets(entries, 'week', now);
    expect(b).toHaveLength(12);
    expect(b.at(-1)).toMatchObject({ min: 75, count: 2 }); // 11/16（月）からの週
    expect(b.at(-2)).toMatchObject({ min: 60, count: 1 });
  });
  it('月ごと：この 12 か月', () => {
    const b = trendBuckets(entries, 'month', now);
    expect(b).toHaveLength(12);
    expect(b.at(-1)!.min).toBe(135);
  });
  it('年ごと：最初の記録の年から今年まで', () => {
    expect(trendBuckets(entries, 'year', now).map((x) => [x.label, x.min])).toEqual([
      ['2025', 120],
      ['2026', 225],
    ]);
  });
  it('合計：累計は減らず、最後が全体の合計', () => {
    const b = trendBuckets(entries, 'total', now);
    for (let i = 1; i < b.length; i++) expect(b[i]!.min).toBeGreaterThanOrEqual(b[i - 1]!.min);
    expect(b.at(-1)).toMatchObject({ min: 345, count: 5 });
  });
  it('合計：短い期間は日ごと（2 週間ぶんは出す）', () => {
    const b = trendBuckets([at('2026-11-15', 30), at('2026-11-17', 20)], 'total', now);
    expect(b).toHaveLength(14);
    expect(b.at(-1)!.min).toBe(50);
  });
});
