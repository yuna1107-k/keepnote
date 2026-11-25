/**
 * ログイン・登録画面の土台。壁に貼った付箋をモチーフにする
 * （黄色の付箋が本体、ピンクの付箋に手書きのメモ、小さな青い付箋に今日の日付）。
 */
import type { ReactNode } from 'react';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export function AuthBoard({ children, memo, label }: { children: ReactNode; memo?: ReactNode; label: string }) {
  const today = new Date();
  return (
    <div className="board">
      <div className="board-cluster">
        <div className="sticky sticky-blue sticky-date hand" aria-hidden="true">
          <span className="sticky-date-day">
            {today.getMonth() + 1}/{today.getDate()}
          </span>
          <span className="sticky-date-week">（{WEEKDAYS[today.getDay()]}）</span>
        </div>
        <main className="sticky sticky-yellow sticky-main" aria-label={label}>
          {children}
        </main>
        {memo && <aside className="sticky sticky-pink sticky-memo hand">{memo}</aside>}
      </div>
    </div>
  );
}
