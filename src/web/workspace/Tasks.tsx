/**
 * タスク：ワークスペースのページの、まだ終わっていない ToDo を期限の順に並べる（一覧・月のカレンダー）。
 * 見られるページの ToDo だけを出す。期限は ToDo の中の日付（@2026/11/20）
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Icon, PageIcon, Spinner } from '../ui';
import { dueLabel, parseYmd, todayYmd, ymd } from './due';
import { pageTitle, useWorkspace } from './WorkspaceContext';

type Task = { pageId: string; pageTitle: string; pageIcon: string | null; blockId: string; text: string; due: string | null; canEdit: boolean };
type Group = { key: string; title: string; tasks: Task[] };

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const taskHref = (t: Task) => `/p/${t.pageId}#block-${t.blockId}`;

function groupTasks(tasks: Task[]): Group[] {
  const today = todayYmd();
  const in7 = new Date();
  in7.setDate(in7.getDate() + 7);
  const week = ymd(in7);
  const groups: Group[] = [
    { key: 'overdue', title: '期限切れ', tasks: [] },
    { key: 'today', title: '今日', tasks: [] },
    { key: 'week', title: '7 日以内', tasks: [] },
    { key: 'later', title: 'それ以降', tasks: [] },
    { key: 'none', title: '期限なし', tasks: [] },
  ];
  const sorted = [...tasks].sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
  for (const t of sorted) {
    const g = !t.due ? 4 : t.due < today ? 0 : t.due === today ? 1 : t.due <= week ? 2 : 3;
    groups[g]!.tasks.push(t);
  }
  return groups.filter((g) => g.tasks.length);
}

function TaskRow({ task, showDue = true }: { task: Task; showDue?: boolean }) {
  const ws = useWorkspace();
  const state = !task.due ? 'none' : task.due < todayYmd() ? 'overdue' : task.due === todayYmd() ? 'today' : 'future';
  const title = pageTitle(ws.byId.get(task.pageId) ?? { title: task.pageTitle });
  return (
    <Link to={taskHref(task)} className="task-row">
      <span className="task-check" aria-hidden />
      <span className="task-main">
        <span className="task-text">{task.text || '（文なし）'}</span>
        <span className="task-page muted small">
          <PageIcon icon={ws.byId.get(task.pageId)?.icon ?? task.pageIcon} size={13} /> <span className="ellipsis">{title}</span>
        </span>
      </span>
      {showDue && task.due && (
        <span className={`due-chip due-${state}`}>
          <Icon name="calendar" size={13} />
          {dueLabel(task.due)}
        </span>
      )}
    </Link>
  );
}

function Calendar({ tasks }: { tasks: Task[] }) {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [selected, setSelected] = useState<string>(todayYmd());
  const byDay = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasks) if (t.due) m.set(t.due, [...(m.get(t.due) ?? []), t]);
    return m;
  }, [tasks]);
  // 月の表：日曜はじまり、6 週ぶん
  const start = new Date(month);
  start.setDate(1 - month.getDay());
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
  const today = todayYmd();
  const move = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const dayTasks = byDay.get(selected) ?? [];
  return (
    <div className="task-calendar">
      <div className="task-cal-head">
        <button className="icon-btn" onClick={() => move(-1)} aria-label="前の月">
          <Icon name="chevronLeft" />
        </button>
        <div className="task-cal-title">
          {month.getFullYear()}年{month.getMonth() + 1}月
        </div>
        <button className="icon-btn" onClick={() => move(1)} aria-label="次の月">
          <Icon name="chevronRight" />
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            const d = new Date();
            setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
            setSelected(today);
          }}
        >
          今日
        </button>
      </div>
      <div className="task-cal-grid" role="grid">
        {WEEK.map((w, i) => (
          <div key={w} className={`task-cal-week ${i === 0 ? 'is-sun' : i === 6 ? 'is-sat' : ''}`}>
            {w}
          </div>
        ))}
        {days.map((d) => {
          const key = ymd(d);
          const list = byDay.get(key) ?? [];
          const cls = [
            'task-cal-day',
            d.getMonth() !== month.getMonth() && 'is-other',
            key === today && 'is-today',
            key === selected && 'is-selected',
            list.length && key < today && 'has-overdue',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button key={key} className={cls} onClick={() => setSelected(key)} aria-label={`${d.getMonth() + 1}月${d.getDate()}日 ${list.length} 件`}>
              <span className="task-cal-num">{d.getDate()}</span>
              {list.length > 0 && (
                <>
                  <span className="task-cal-items">
                    {list.slice(0, 2).map((t) => (
                      <span key={`${t.pageId}:${t.blockId}`} className="task-cal-item">
                        {t.text || '（文なし）'}
                      </span>
                    ))}
                    {list.length > 2 && <span className="task-cal-more">ほか {list.length - 2} 件</span>}
                  </span>
                  <span className="task-cal-dot">{list.length}</span>
                </>
              )}
            </button>
          );
        })}
      </div>
      <div className="task-cal-list">
        <div className="task-group-title">
          {parseYmd(selected).getMonth() + 1}月{parseYmd(selected).getDate()}日（{WEEK[parseYmd(selected).getDay()]}）
        </div>
        {dayTasks.length ? dayTasks.map((t) => <TaskRow key={`${t.pageId}:${t.blockId}`} task={t} showDue={false} />) : <p className="muted small">この日が期限の ToDo はありません。</p>}
      </div>
    </div>
  );
}

export default function Tasks() {
  const ws = useWorkspace();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<'list' | 'calendar'>(() => {
    try {
      return localStorage.getItem('tasks-view') === 'calendar' ? 'calendar' : 'list';
    } catch {
      return 'list';
    }
  });
  const wsId = ws.current?.id;
  useEffect(() => {
    if (!wsId) return;
    let alive = true;
    setTasks(null);
    api<{ tasks: Task[] }>(`/pages/tasks?workspace=${encodeURIComponent(wsId)}`)
      .then((r) => alive && setTasks(r.tasks))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [wsId]);
  const choose = (v: 'list' | 'calendar') => {
    setView(v);
    try {
      localStorage.setItem('tasks-view', v);
    } catch {
      /* 覚えられなくても使える */
    }
  };
  const groups = useMemo(() => groupTasks(tasks ?? []), [tasks]);

  return (
    <div className="tasks-page">
      <div className="tasks-head">
        <h1>
          <Icon name="task" size={26} /> タスク
        </h1>
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'active' : ''} onClick={() => choose('list')}>
            一覧
          </button>
          <button role="tab" aria-selected={view === 'calendar'} className={view === 'calendar' ? 'active' : ''} onClick={() => choose('calendar')}>
            カレンダー
          </button>
        </div>
      </div>
      <p className="muted small tasks-lead">
        {ws.current?.name ?? 'ワークスペース'} のページにある、まだ終わっていない ToDo です。ToDo に <code>@2026/11/20</code> のように日付を書くと期限になります。
      </p>
      {error ? (
        <p className="muted">{error}</p>
      ) : !tasks ? (
        <Spinner />
      ) : view === 'calendar' ? (
        <Calendar tasks={tasks} />
      ) : groups.length === 0 ? (
        <div className="home-empty">
          <div className="home-empty-icon">
            <Icon name="task" size={28} />
          </div>
          <div className="list-title">終わっていない ToDo はありません</div>
          <p className="muted small">ページで「[] 」と打つか、スラッシュメニューの「ToDo リスト」で ToDo を作れます。</p>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.key} className={`task-group task-group-${g.key}`}>
            <div className="task-group-title">
              {g.title}
              <span className="task-group-count">{g.tasks.length}</span>
            </div>
            {g.tasks.map((t) => (
              <TaskRow key={`${t.pageId}:${t.blockId}`} task={t} />
            ))}
          </section>
        ))
      )}
    </div>
  );
}
