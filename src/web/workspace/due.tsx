/**
 * ToDo の期限（文中の日付）。「@2026/11/20」と打つか、スラッシュメニューの「期限」で入れる。
 * ToDo ブロックの期限は「タスク」の画面に並ぶ（サーバーが保存時に記録する）
 */
import { createReactInlineContentSpec } from '@blocknote/react';
import { useRef, useState } from 'react';
import { Icon, Popover } from '../ui';

const pad = (n: number) => String(n).padStart(2, '0');
/** 日付（ローカル時刻）→ YYYY-MM-DD */
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayYmd = () => ymd(new Date());
/** YYYY-MM-DD → その日の 0 時（ローカル時刻） */
export const parseYmd = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

/** 期限の表示（今日・明日・昨日、今年なら月日だけ） */
export function dueLabel(date: string) {
  if (!date) return '期限を選ぶ';
  const d = parseYmd(date);
  const diff = Math.round((d.getTime() - parseYmd(todayYmd()).getTime()) / 86400000);
  if (diff === 0) return '今日';
  if (diff === 1) return '明日';
  if (diff === -1) return '昨日';
  const md = `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

/** 期限の状態：過ぎた・今日・それ以降 */
export function dueState(date: string): 'overdue' | 'today' | 'future' | 'none' {
  if (!date) return 'none';
  const t = todayYmd();
  return date < t ? 'overdue' : date === t ? 'today' : 'future';
}

function DueChip({ date, editable, onChange }: { date: string; editable: boolean; onChange: (v: string) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(editable && !date);
  const pick = (v: string) => {
    setOpen(false);
    if (v !== date) onChange(v);
  };
  const shift = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    pick(ymd(d));
  };
  return (
    <>
      <span
        ref={ref}
        className={`due-chip due-${dueState(date)} ${editable ? 'is-editable' : ''}`}
        data-due={date || undefined}
        title={date ? `期限 ${date.replace(/-/g, '/')}` : '期限'}
        onClick={() => editable && setOpen(true)}
      >
        <Icon name="calendar" size={13} />
        {dueLabel(date)}
      </span>
      {open && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)} width={260}>
          <div className="due-popover" onKeyDown={(e) => e.stopPropagation()}>
            <div className="note-popover-label">期限</div>
            <input
              type="date"
              className="note-input"
              autoFocus
              defaultValue={date || todayYmd()}
              onChange={(e) => e.target.value && /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) && onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') {
                  e.preventDefault();
                  setOpen(false);
                }
              }}
            />
            <div className="due-quick">
              <button className="btn btn-ghost btn-sm" onClick={() => shift(0)}>
                今日
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => shift(1)}>
                明日
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => shift(7)}>
                1 週間後
              </button>
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

const hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => new TextDecoder().decode(new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16))));
/** Markdown・PDF に書き出すときの目印 */
export const DUE_MARK = (date: string) => `⟦D${hex(date)}⟧`;

export const DueSpec = createReactInlineContentSpec(
  { type: 'due', propSchema: { date: { default: '' } }, content: 'none' },
  {
    render: (props) => (
      <DueChip date={props.inlineContent.props.date} editable={props.editor.isEditable} onChange={(date) => props.updateInlineContent({ type: 'due', props: { date } })} />
    ),
    toExternalHTML: (props) => <span>{DUE_MARK(props.inlineContent.props.date)}</span>,
  },
);

/** Markdown へ：@2026-11-20 */
export const dueToMarkdown = (text: string) => text.replace(/⟦D([0-9a-f]*)⟧/g, (_m, h: string) => (unhex(h) ? `@${unhex(h)}` : ''));
/** PDF（レポート）へ：（期限：2026/11/20） */
export const dueToHtml = (html: string) => html.replace(/⟦D([0-9a-f]*)⟧/g, (_m, h: string) => (unhex(h) ? `<span class="report-due">（期限：${unhex(h).replace(/-/g, '/')}）</span>` : ''));

const AT_DATE = /(^|[\s(（])@(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?![\d/-])/g;
const normalize = (y: string, m: string, d: string) => `${y}-${pad(Number(m))}-${pad(Number(d))}`;
/** Markdown から：@2026-11-20・@2026/11/20 を目印にする */
export const protectDue = (line: string) => line.replace(AT_DATE, (_m, pre: string, y: string, mo: string, d: string) => `${pre}${DUE_MARK(normalize(y, mo, d))}`);
export const restoreDue = (h: string) => ({ type: 'due', props: { date: unhex(h) } });

/** 打ち終えた「@2026/11/20 」（日付のあとに空白）を期限にする */
export function convertTypedDue(editor: any) {
  const view = editor.prosemirrorView;
  if (!view) return;
  const { state } = view;
  const { $from, empty } = state.selection;
  if (!empty || !state.schema.nodes.due || $from.parent.type.spec.code) return;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const m = /(^|[\s(（])@(\d{4})[/-](\d{1,2})[/-](\d{1,2})(\s)$/.exec(before);
  if (!m) return;
  const date = normalize(m[2]!, m[3]!, m[4]!);
  if (Number.isNaN(parseYmd(date).getTime()) || ymd(parseYmd(date)) !== date) return;
  const len = m[0].length - m[1]!.length;
  const from = $from.pos - len;
  view.dispatch(state.tr.replaceWith(from, $from.pos - 1, state.schema.nodes.due.create({ date })));
}
