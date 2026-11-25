/** データベースの型と、並べ替え・絞り込み・表示用の小さな関数 */
import { api } from '../api';

export type DbType = 'text' | 'number' | 'select' | 'multi_select' | 'date' | 'checkbox' | 'url' | 'person';
export type DbOption = { id: string; name: string; color: string };
export type DbProp = { id: string; name: string; type: DbType; options?: DbOption[] };
export type DbFilter = { prop: string; op: string; value?: unknown };
export type DbView = {
  id: string;
  name: string;
  type: 'table' | 'board' | 'calendar' | 'gallery';
  sort?: { prop: string; dir: 'asc' | 'desc' } | null;
  filters?: DbFilter[];
  groupBy?: string | null;
  dateProp?: string | null;
  hidden?: string[];
};
export type DbSchema = { props: DbProp[]; views: DbView[]; kind?: 'books' | 'study' };
export type DbRow = { id: string; title: string; icon: string | null; cover?: string | null; createdAt: number; updatedAt: number; values: Record<string, unknown>; canEdit: boolean };
export type DbData = { schema: DbSchema; rows: DbRow[]; members: { id: string; name: string }[]; canEdit: boolean };

export const TYPE_LABEL: Record<DbType, string> = {
  text: 'テキスト',
  number: '数値',
  select: 'セレクト',
  multi_select: 'マルチセレクト',
  date: '日付',
  checkbox: 'チェックボックス',
  url: 'URL',
  person: 'ユーザー',
};
export const COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
/** 「名前」（ページのタイトル）の列 */
export const TITLE = '__title';

export const newId = () => Math.random().toString(36).slice(2, 10);

export const loadDatabase = (pageId: string) => api<DbData>(`/pages/${pageId}/database`);

/** 並べ替え・比べるときの値 */
function sortKey(row: DbRow, prop: DbProp | undefined, propId: string, members: DbData['members']): string | number {
  if (propId === TITLE) return row.title.toLowerCase();
  if (propId === '__created') return row.createdAt;
  if (propId === '__updated') return row.updatedAt;
  const v = row.values[propId];
  if (!prop || v === undefined || v === null) return '';
  switch (prop.type) {
    case 'number':
      return typeof v === 'number' ? v : Number(v) || 0;
    case 'checkbox':
      return v ? 1 : 0;
    case 'select': {
      const i = (prop.options ?? []).findIndex((o) => o.id === v);
      return i < 0 ? '' : i;
    }
    case 'multi_select':
      return (v as string[]).map((id) => prop.options?.find((o) => o.id === id)?.name ?? '').join(',');
    case 'person':
      return (v as string[]).map((id) => members.find((m) => m.id === id)?.name ?? '').join(',');
    default:
      return String(v).toLowerCase();
  }
}

export function sortRows(rows: DbRow[], schema: DbSchema, sort: DbView['sort'], members: DbData['members']) {
  if (!sort) return rows;
  const prop = schema.props.find((p) => p.id === sort.prop);
  const dir = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = sortKey(a, prop, sort.prop, members);
    const y = sortKey(b, prop, sort.prop, members);
    // 空の値はいつも最後
    if (x === '' && y !== '') return 1;
    if (y === '' && x !== '') return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

/** 列の種類ごとに選べる絞り込みの条件 */
export function opsFor(type: DbType | 'title'): { op: string; label: string; needsValue: boolean }[] {
  const empty = [
    { op: 'empty', label: '空である', needsValue: false },
    { op: 'not_empty', label: '空でない', needsValue: false },
  ];
  switch (type) {
    case 'checkbox':
      return [
        { op: 'checked', label: 'チェックあり', needsValue: false },
        { op: 'unchecked', label: 'チェックなし', needsValue: false },
      ];
    case 'number':
      return [
        { op: 'eq', label: '＝', needsValue: true },
        { op: 'gt', label: '＞', needsValue: true },
        { op: 'lt', label: '＜', needsValue: true },
        ...empty,
      ];
    case 'date':
      return [
        { op: 'eq', label: 'この日', needsValue: true },
        { op: 'before', label: 'より前', needsValue: true },
        { op: 'after', label: 'より後', needsValue: true },
        ...empty,
      ];
    case 'select':
    case 'multi_select':
    case 'person':
      return [
        { op: 'has', label: 'を含む', needsValue: true },
        { op: 'not_has', label: 'を含まない', needsValue: true },
        ...empty,
      ];
    default:
      return [
        { op: 'contains', label: 'を含む', needsValue: true },
        { op: 'not_contains', label: 'を含まない', needsValue: true },
        ...empty,
      ];
  }
}

export function filterRows(rows: DbRow[], schema: DbSchema, filters: DbFilter[] | undefined) {
  const active = (filters ?? []).filter((f) => f.prop && f.op);
  if (!active.length) return rows;
  return rows.filter((row) =>
    active.every((f) => {
      const prop = schema.props.find((p) => p.id === f.prop);
      if (f.prop !== TITLE && !prop) return true;
      const v = f.prop === TITLE ? row.title : row.values[f.prop];
      const isEmpty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
      const list = Array.isArray(v) ? (v as string[]) : v === undefined || v === null ? [] : [String(v)];
      const want = f.value;
      switch (f.op) {
        case 'empty':
          return isEmpty;
        case 'not_empty':
          return !isEmpty;
        case 'checked':
          return !!v;
        case 'unchecked':
          return !v;
        case 'contains':
          return !want || String(v ?? '').toLowerCase().includes(String(want).toLowerCase());
        case 'not_contains':
          return !want || !String(v ?? '').toLowerCase().includes(String(want).toLowerCase());
        case 'has':
          return !want || list.includes(String(want));
        case 'not_has':
          return !want || !list.includes(String(want));
        case 'eq':
          return want === undefined || want === '' || (prop?.type === 'number' ? Number(v) === Number(want) : String(v ?? '') === String(want));
        case 'gt':
          return want === undefined || want === '' || (!isEmpty && Number(v) > Number(want));
        case 'lt':
          return want === undefined || want === '' || (!isEmpty && Number(v) < Number(want));
        case 'before':
          return !want || (!isEmpty && String(v) < String(want));
        case 'after':
          return !want || (!isEmpty && String(v) > String(want));
        default:
          return true;
      }
    }),
  );
}

/** 表やカードに出す、値の文字（検索・書き出し用にも使う） */
export function valueText(prop: DbProp, v: unknown, members: DbData['members']) {
  if (v === undefined || v === null || v === '') return '';
  switch (prop.type) {
    case 'checkbox':
      return v ? '✓' : '';
    case 'select':
      return prop.options?.find((o) => o.id === v)?.name ?? '';
    case 'multi_select':
      return (v as string[]).map((id) => prop.options?.find((o) => o.id === id)?.name).filter(Boolean).join(', ');
    case 'person':
      return (v as string[]).map((id) => members.find((m) => m.id === id)?.name).filter(Boolean).join(', ');
    case 'date':
      return String(v).replace(/-/g, '/');
    default:
      return String(v);
  }
}
