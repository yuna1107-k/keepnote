/**
 * データベース：子ページを行にして、列（プロパティ）の値を表・ボード・カレンダーで見る。
 * 列の定義と表示の設定はデータベースのページに、値は行（子ページ）ごとに保存する。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Page } from '../api';
import { Icon, PageIcon, Popover, Spinner, useUi } from '../ui';
import { DbCell, Tag } from './DbCell';
import {
  COLORS,
  filterRows,
  loadDatabase,
  newId,
  opsFor,
  sortRows,
  TITLE,
  TYPE_LABEL,
  valueText,
  type DbData,
  type DbFilter,
  type DbOption,
  type DbProp,
  type DbRow,
  type DbSchema,
  type DbType,
  type DbView,
} from './dbModel';
import { ymd } from './due';
import { BookAddDialog, BookDashboard, BookStats, isBookDb } from './Books';
import { isStudyDb, StudyAddDialog, StudyDashboard, StudyStats } from './Study';
import { useWorkspace } from './WorkspaceContext';
import { usePageOpener } from './PagePeek';

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const VIEW_ICON = { table: 'table', board: 'board', calendar: 'calendar', gallery: 'grid' } as const;
const VIEW_LABEL = { table: '表', board: 'ボード', calendar: 'カレンダー', gallery: 'パネル' } as const;

/** データベースの読み込みと変更（画面にはすぐ反映し、裏で保存する） */
export function useDatabase(pageId: string) {
  const { toast } = useUi();
  const ws = useWorkspace();
  const [data, setData] = useState<DbData | null>(null);
  const [error, setError] = useState('');
  const dataRef = useRef<DbData | null>(null);
  dataRef.current = data;

  const reload = useCallback(async () => {
    try {
      setData(await loadDatabase(pageId));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [pageId]);
  useEffect(() => {
    setData(null);
    void reload();
  }, [reload]);

  const fail = (e: unknown) => {
    toast((e as Error).message, 'error');
    void reload();
  };

  const saveSchema = (schema: DbSchema) => {
    setData((d) => (d ? { ...d, schema } : d));
    api(`/pages/${pageId}/database/schema`, { method: 'PUT', body: schema }).catch(fail);
  };
  const updateSchema = (fn: (s: DbSchema) => DbSchema) => {
    if (dataRef.current) saveSchema(fn(dataRef.current.schema));
  };
  const setValues = (rowId: string, values: Record<string, unknown>) => {
    setData((d) =>
      d
        ? {
            ...d,
            rows: d.rows.map((r) => {
              if (r.id !== rowId) return r;
              const next = { ...r.values };
              for (const [k, v] of Object.entries(values)) {
                if (v === null || v === '' || (Array.isArray(v) && !v.length)) delete next[k];
                else next[k] = v;
              }
              return { ...r, values: next };
            }),
          }
        : d,
    );
    api(`/pages/${pageId}/database/rows/${rowId}`, { method: 'PATCH', body: { values } }).catch(fail);
  };
  const addOption = (propId: string, o: DbOption) =>
    updateSchema((s) => ({ ...s, props: s.props.map((p) => (p.id === propId ? { ...p, options: [...(p.options ?? []), o] } : p)) }));
  const addRow = async (values: Record<string, unknown> = {}) => {
    try {
      const { page } = await api<{ page: Page }>('/pages', { body: { parentId: pageId, title: '' } });
      const row: DbRow = { id: page.id, title: '', icon: null, createdAt: page.createdAt, updatedAt: page.updatedAt, values: {}, canEdit: true };
      setData((d) => (d ? { ...d, rows: [...d.rows, row] } : d));
      if (Object.keys(values).length) setValues(page.id, values);
      void ws.reload();
      return page.id;
    } catch (e) {
      fail(e);
      return null;
    }
  };
  /** 入力中の名前を、保存を待たずにすべての画面へ映す */
  const renameRowLocal = (rowId: string, title: string) => {
    setData((d) => (d ? { ...d, rows: d.rows.map((r) => (r.id === rowId ? { ...r, title } : r)) } : d));
    ws.patchLocal(rowId, { title });
  };
  const renameRow = async (rowId: string, title: string) => {
    renameRowLocal(rowId, title);
    try {
      const { page } = await api<{ page: Page }>(`/pages/${rowId}`);
      await api(`/pages/${rowId}`, { method: 'PATCH', body: { version: page.version, title } });
      ws.patchLocal(rowId, { title });
    } catch (e) {
      fail(e);
    }
  };
  const deleteRow = async (rowId: string) => {
    setData((d) => (d ? { ...d, rows: d.rows.filter((r) => r.id !== rowId) } : d));
    try {
      await api(`/pages/${rowId}`, { method: 'DELETE' });
      void ws.reload();
    } catch (e) {
      fail(e);
    }
  };
  // 行の名前・アイコンは、ほかの画面（行のページ・サイドバーなど）での変更もすぐ映すため、ページの一覧の値を使う
  const merged = useMemo(() => {
    if (!data) return data;
    let changed = false;
    const rows = data.rows.map((r) => {
      const s = ws.byId.get(r.id);
      if (!s || (s.title === r.title && s.icon === r.icon)) return r;
      changed = true;
      return { ...r, title: s.title, icon: s.icon };
    });
    return changed ? { ...data, rows } : data;
  }, [data, ws.byId]);
  return { data: merged, error, reload, saveSchema, updateSchema, setValues, addOption, addRow, renameRow, renameRowLocal, deleteRow };
}
type DbApi = ReturnType<typeof useDatabase>;

export default function Database({ pageId, readOnly = false }: { pageId: string; readOnly?: boolean }) {
  const db = useDatabase(pageId);
  const viewKey = `db-view-${pageId}`;
  const [viewId, setViewId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(viewKey);
    } catch {
      return null;
    }
  });
  // 行のページから戻ってきたときなどに、最新の値を読み直す
  useEffect(() => {
    const onFocus = () => void db.reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [db.reload]);

  // 編集できない人の並べ替え・絞り込みは、この画面の中だけで使う（保存しない）
  const [local, setLocal] = useState<Record<string, Partial<DbView>>>({});
  // 読書記録：本の追加と集計
  const openPage = usePageOpener();
  const [bookAdd, setBookAdd] = useState(false);
  const [showStats, setShowStats] = useState(false);
  // 勉強時間記録：記録と集計
  const [studyAdd, setStudyAdd] = useState(false);
  if (db.error) return <p className="muted small">{db.error}</p>;
  if (!db.data) return <Spinner />;
  const { schema } = db.data;
  const canEdit = db.data.canEdit && !readOnly;
  const rows0 = readOnly ? db.data.rows.map((r) => ({ ...r, canEdit: false })) : db.data.rows;
  const base = schema.views.find((v) => v.id === viewId) ?? schema.views[0]!;
  const view: DbView = canEdit ? base : { ...base, ...local[base.id] };
  const choose = (id: string) => {
    setViewId(id);
    try {
      localStorage.setItem(viewKey, id);
    } catch {
      /* 覚えられなくても使える */
    }
  };
  const updateView = (patch: Partial<DbView>) =>
    canEdit
      ? db.updateSchema((s) => ({ ...s, views: s.views.map((v) => (v.id === view.id ? { ...v, ...patch } : v)) }))
      : setLocal((l) => ({ ...l, [view.id]: { ...l[view.id], ...patch } }));
  const rows = sortRows(filterRows(rows0, schema, view.filters), schema, view.sort, db.data.members);

  return (
    <div className="db">
      {isBookDb(db.data) && <BookDashboard dbId={pageId} data={db.data} />}
      {isBookDb(db.data) && (
        <div className="book-tools">
          {canEdit && (
            <button className="btn btn-primary btn-sm" onClick={() => setBookAdd(true)}>
              <Icon name="plus" size={14} /> 本を追加（ISBN・バーコード）
            </button>
          )}
          <button className={`btn btn-ghost btn-sm ${showStats ? 'active' : ''}`} onClick={() => setShowStats((v) => !v)}>
            <Icon name="graph" size={14} /> {showStats ? '集計を閉じる' : '読んだ量の集計'}
          </button>
        </div>
      )}
      {showStats && isBookDb(db.data) && <BookStats data={db.data} />}
      {isStudyDb(db.data) && <StudyDashboard data={db.data} />}
      {isStudyDb(db.data) && (
        <div className="book-tools">
          {canEdit && (
            <button className="btn btn-primary btn-sm" onClick={() => setStudyAdd(true)}>
              <Icon name="plus" size={14} /> 勉強時間を記録
            </button>
          )}
          <button className={`btn btn-ghost btn-sm ${showStats ? 'active' : ''}`} onClick={() => setShowStats((v) => !v)}>
            <Icon name="graph" size={14} /> {showStats ? '集計を閉じる' : '期間・科目ごとの表'}
          </button>
        </div>
      )}
      {showStats && isStudyDb(db.data) && <StudyStats data={db.data} />}
      {studyAdd && (
        <StudyAddDialog
          dbId={pageId}
          data={db.data}
          onClose={() => setStudyAdd(false)}
          onAdded={() => {
            void db.reload();
            setStudyAdd(false);
          }}
        />
      )}
      {bookAdd && (
        <BookAddDialog
          dbId={pageId}
          data={db.data}
          onClose={() => setBookAdd(false)}
          onAdded={(id) => {
            void db.reload();
            setBookAdd(false);
            openPage(id);
          }}
        />
      )}
      <ViewBar db={db} view={view} choose={choose} canEdit={canEdit} updateView={updateView} />
      {view.type === 'table' && <TableView db={db} view={view} rows={rows} canEdit={canEdit} updateView={updateView} />}
      {view.type === 'board' && <BoardView db={db} view={view} rows={rows} canEdit={canEdit} updateView={updateView} />}
      {view.type === 'calendar' && <CalendarView db={db} view={view} rows={rows} canEdit={canEdit} updateView={updateView} />}
      {view.type === 'gallery' && <GalleryView db={db} view={view} rows={rows} canEdit={canEdit} updateView={updateView} />}
    </div>
  );
}

type ViewProps = { db: DbApi; view: DbView; rows: DbRow[]; canEdit: boolean; updateView: (p: Partial<DbView>) => void };

/* ---------- 表示の切り替え・絞り込み・並べ替え ---------- */

function ViewBar({ db, view, choose, canEdit, updateView }: { db: DbApi; view: DbView; choose: (id: string) => void; canEdit: boolean; updateView: (p: Partial<DbView>) => void }) {
  const schema = db.data!.schema;
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [viewAnchor, setViewAnchor] = useState<HTMLElement | null>(null);
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null);
  const filters = view.filters ?? [];
  const addView = (type: DbView['type']) => {
    const v: DbView = {
      id: newId(),
      name: VIEW_LABEL[type],
      type,
      filters: [],
      sort: null,
      groupBy: type === 'board' ? (schema.props.find((p) => p.type === 'select')?.id ?? null) : null,
      dateProp: type === 'calendar' ? (schema.props.find((p) => p.type === 'date')?.id ?? null) : null,
    };
    db.updateSchema((s) => ({ ...s, views: [...s.views, v] }));
    choose(v.id);
    setAddAnchor(null);
  };
  return (
    <div className="db-bar">
      <div className="db-tabs" role="tablist">
        {schema.views.map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={v.id === view.id}
            className={`db-tab ${v.id === view.id ? 'active' : ''}`}
            onClick={(e) => (v.id === view.id && canEdit ? setViewAnchor(e.currentTarget) : choose(v.id))}
          >
            <Icon name={VIEW_ICON[v.type]} size={14} /> {v.name || VIEW_LABEL[v.type]}
          </button>
        ))}
        {canEdit && (
          <button className="db-tab db-tab-add" onClick={(e) => setAddAnchor(e.currentTarget)} aria-label="表示を追加" title="表示を追加">
            <Icon name="plus" size={14} />
          </button>
        )}
      </div>
      <div className="db-tools">
        <button className={`db-tool ${filters.length ? 'on' : ''}`} onClick={(e) => setFilterAnchor(e.currentTarget)}>
          <Icon name="filter" size={14} /> 絞り込み{filters.length ? `（${filters.length}）` : ''}
        </button>
        <button className={`db-tool ${view.sort ? 'on' : ''}`} onClick={(e) => setSortAnchor(e.currentTarget)}>
          <Icon name="sort" size={14} /> 並べ替え
        </button>
        {canEdit && (
          <button className="btn btn-primary btn-sm" onClick={() => void db.addRow(view.type === 'calendar' && view.dateProp ? { [view.dateProp]: ymd(new Date()) } : {})}>
            <Icon name="plus" size={14} /> 新規
          </button>
        )}
      </div>
      {addAnchor && (
        <Popover anchor={addAnchor} onClose={() => setAddAnchor(null)} width={200}>
          <div className="db-menu">
            {(['table', 'board', 'calendar', 'gallery'] as const).map((t) => (
              <button key={t} className="db-menu-item" onClick={() => addView(t)}>
                <Icon name={VIEW_ICON[t]} size={15} /> {VIEW_LABEL[t]}
              </button>
            ))}
          </div>
        </Popover>
      )}
      {viewAnchor && (
        <Popover anchor={viewAnchor} onClose={() => setViewAnchor(null)} width={240}>
          <div className="db-menu">
            <input className="db-menu-input" defaultValue={view.name} placeholder="表示の名前" onBlur={(e) => e.target.value !== view.name && updateView({ name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
            {schema.views.length > 1 && (
              <button
                className="db-menu-item danger"
                onClick={() => {
                  db.updateSchema((s) => ({ ...s, views: s.views.filter((v) => v.id !== view.id) }));
                  choose(schema.views.find((v) => v.id !== view.id)!.id);
                  setViewAnchor(null);
                }}
              >
                <Icon name="trash" size={15} /> この表示を削除
              </button>
            )}
          </div>
        </Popover>
      )}
      {filterAnchor && (
        <Popover anchor={filterAnchor} onClose={() => setFilterAnchor(null)} width={380}>
          <FilterEditor db={db} filters={filters} onChange={(f) => updateView({ filters: f })} />
        </Popover>
      )}
      {sortAnchor && (
        <Popover anchor={sortAnchor} onClose={() => setSortAnchor(null)} width={300}>
          <div className="db-menu">
            <div className="db-menu-label">並べ替え</div>
            <div className="db-filter-row">
              <select value={view.sort?.prop ?? ''} onChange={(e) => updateView({ sort: e.target.value ? { prop: e.target.value, dir: view.sort?.dir ?? 'asc' } : null })}>
                <option value="">並べ替えない（手動の順）</option>
                <option value={TITLE}>名前</option>
                {schema.props.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                <option value="__created">作成日時</option>
                <option value="__updated">更新日時</option>
              </select>
              {view.sort && (
                <select value={view.sort.dir} onChange={(e) => updateView({ sort: { ...view.sort!, dir: e.target.value as 'asc' | 'desc' } })}>
                  <option value="asc">昇順</option>
                  <option value="desc">降順</option>
                </select>
              )}
            </div>
            {!canEdit && <p className="db-hint">表示の設定はこの画面だけで変わり、保存はされません。</p>}
          </div>
        </Popover>
      )}
    </div>
  );
}

function FilterEditor({ db, filters, onChange }: { db: DbApi; filters: DbFilter[]; onChange: (f: DbFilter[]) => void }) {
  const { schema, members } = db.data!;
  const set = (i: number, patch: Partial<DbFilter>) => onChange(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <div className="db-menu">
      <div className="db-menu-label">絞り込み（すべての条件に合う行だけ）</div>
      {filters.map((f, i) => {
        const prop = schema.props.find((p) => p.id === f.prop);
        const type: DbType | 'title' = f.prop === TITLE ? 'title' : (prop?.type ?? 'text');
        const ops = opsFor(type);
        const op = ops.find((o) => o.op === f.op) ?? ops[0]!;
        const options = prop?.type === 'person' ? members.map((m) => ({ id: m.id, name: m.name })) : (prop?.options ?? []);
        return (
          <div key={i} className="db-filter-row">
            <select value={f.prop} onChange={(e) => set(i, { prop: e.target.value, op: opsFor(e.target.value === TITLE ? 'title' : (schema.props.find((p) => p.id === e.target.value)?.type ?? 'text'))[0]!.op, value: undefined })}>
              <option value={TITLE}>名前</option>
              {schema.props.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select value={op.op} onChange={(e) => set(i, { op: e.target.value })}>
              {ops.map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
            {op.needsValue &&
              (prop && ['select', 'multi_select', 'person'].includes(prop.type) ? (
                <select value={String(f.value ?? '')} onChange={(e) => set(i, { value: e.target.value })}>
                  <option value="">（選ぶ）</option>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={type === 'date' ? 'date' : type === 'number' ? 'number' : 'text'}
                  value={String(f.value ?? '')}
                  onChange={(e) => set(i, { value: e.target.value })}
                  placeholder="値"
                />
              ))}
            <button className="icon-btn xs" onClick={() => onChange(filters.filter((_, j) => j !== i))} aria-label="条件を消す">
              <Icon name="x" size={14} />
            </button>
          </div>
        );
      })}
      <button className="db-menu-item" onClick={() => onChange([...filters, { prop: TITLE, op: 'contains', value: '' }])}>
        <Icon name="plus" size={15} /> 条件を追加
      </button>
    </div>
  );
}

/* ---------- 列の設定 ---------- */

function PropMenu({ db, prop, onClose, onHide }: { db: DbApi; prop: DbProp; onClose: () => void; onHide?: () => void }) {
  const { confirm } = useUi();
  const update = (patch: Partial<DbProp>) => db.updateSchema((s) => ({ ...s, props: s.props.map((p) => (p.id === prop.id ? { ...p, ...patch } : p)) }));
  const setOption = (id: string, patch: Partial<DbOption> | null) =>
    update({ options: (prop.options ?? []).flatMap((o) => (o.id !== id ? [o] : patch ? [{ ...o, ...patch }] : [])) });
  const move = (dir: -1 | 1) =>
    db.updateSchema((s) => {
      const props = [...s.props];
      const i = props.findIndex((p) => p.id === prop.id);
      const j = i + dir;
      if (j < 0 || j >= props.length) return s;
      [props[i], props[j]] = [props[j]!, props[i]!];
      return { ...s, props };
    });
  return (
    <div className="db-menu">
      <input className="db-menu-input" autoFocus defaultValue={prop.name} placeholder="列の名前" onBlur={(e) => e.target.value.trim() && e.target.value !== prop.name && update({ name: e.target.value.trim() })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      <div className="db-menu-label">種類</div>
      <select className="db-menu-select" value={prop.type} onChange={(e) => update({ type: e.target.value as DbType, options: prop.options ?? [] })}>
        {(Object.keys(TYPE_LABEL) as DbType[]).map((t) => (
          <option key={t} value={t}>
            {TYPE_LABEL[t]}
          </option>
        ))}
      </select>
      {(prop.type === 'select' || prop.type === 'multi_select') && (
        <>
          <div className="db-menu-label">選択肢</div>
          {(prop.options ?? []).map((o) => (
            <div key={o.id} className="db-option-row">
              <select className={`db-color c-${o.color}`} value={o.color} onChange={(e) => setOption(o.id, { color: e.target.value })} aria-label="色">
                {COLORS.map((c) => (
                  <option key={c} value={c}>
                    {COLOR_LABEL[c]}
                  </option>
                ))}
              </select>
              <input defaultValue={o.name} onBlur={(e) => e.target.value !== o.name && setOption(o.id, { name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
              <button className="icon-btn xs" onClick={() => setOption(o.id, null)} aria-label="選択肢を消す">
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
          <button className="db-menu-item" onClick={() => update({ options: [...(prop.options ?? []), { id: newId(), name: `選択肢 ${(prop.options?.length ?? 0) + 1}`, color: COLORS[(prop.options?.length ?? 0) % COLORS.length]! }] })}>
            <Icon name="plus" size={15} /> 選択肢を追加
          </button>
        </>
      )}
      <div className="db-menu-sep" />
      <button className="db-menu-item" onClick={() => move(-1)}>
        <Icon name="chevronLeft" size={15} /> 左へ移動
      </button>
      <button className="db-menu-item" onClick={() => move(1)}>
        <Icon name="chevronRight" size={15} /> 右へ移動
      </button>
      {onHide && (
        <button className="db-menu-item" onClick={() => { onHide(); onClose(); }}>
          <Icon name="eyeOff" size={15} /> この表示で隠す
        </button>
      )}
      <button
        className="db-menu-item danger"
        onClick={async () => {
          if (!(await confirm({ title: `「${prop.name}」の列を削除しますか？`, message: 'この列の値もすべて見えなくなります。', confirmLabel: '削除', danger: true }))) return;
          db.updateSchema((s) => ({ ...s, props: s.props.filter((p) => p.id !== prop.id) }));
          onClose();
        }}
      >
        <Icon name="trash" size={15} /> 列を削除
      </button>
    </div>
  );
}
const COLOR_LABEL: Record<string, string> = { gray: '灰', brown: '茶', orange: '橙', yellow: '黄', green: '緑', blue: '青', purple: '紫', pink: '桃', red: '赤' };

/* ---------- 表 ---------- */

function TableView({ db, view, rows, canEdit, updateView }: ViewProps) {
  const { schema, members } = db.data!;
  const { confirm } = useUi();
  const openPage = usePageOpener();
  const [propAnchor, setPropAnchor] = useState<{ el: HTMLElement; id: string } | null>(null);
  const [hiddenAnchor, setHiddenAnchor] = useState<HTMLElement | null>(null);
  const hidden = new Set(view.hidden ?? []);
  const props = schema.props.filter((p) => !hidden.has(p.id));
  const hiddenProps = schema.props.filter((p) => hidden.has(p.id));
  const addProp = (e: React.MouseEvent<HTMLElement>) => {
    const p: DbProp = { id: newId(), name: `列 ${schema.props.length + 1}`, type: 'text' };
    db.updateSchema((s) => ({ ...s, props: [...s.props, p] }));
    setPropAnchor({ el: e.currentTarget, id: p.id });
  };
  const menuProp = propAnchor && schema.props.find((p) => p.id === propAnchor.id);
  // ⌘+Enter（Ctrl+Enter）で行を足し、その行の名前の欄に移る
  const [focusRow, setFocusRow] = useState<string | null>(null);
  const addRowAndFocus = async () => {
    if (!canEdit) return;
    const id = await db.addRow();
    if (id) setFocusRow(id);
  };
  return (
    <div className="db-table-wrap">
      <table className="db-table">
        <thead>
          <tr>
            <th className="db-th-title">名前</th>
            {props.map((p) => (
              <th key={p.id}>
                <button className="db-th-btn" disabled={!canEdit} onClick={(e) => setPropAnchor({ el: e.currentTarget, id: p.id })}>
                  {p.name}
                </button>
              </th>
            ))}
            {canEdit && (
              <th className="db-th-add">
                <button className="icon-btn xs" onClick={addProp} aria-label="列を追加" title="列を追加">
                  <Icon name="plus" size={14} />
                </button>
                {hiddenProps.length > 0 && (
                  <button className="icon-btn xs" onClick={(e) => setHiddenAnchor(e.currentTarget)} aria-label="隠した列" title={`隠した列（${hiddenProps.length}）`}>
                    <Icon name="eyeOff" size={14} />
                  </button>
                )}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="db-td-title">
                <span className="db-title-cell">
                  {r.icon && <PageIcon icon={r.icon} size={15} />}
                  <TitleInput row={r} readOnly={!r.canEdit} autoFocus={focusRow === r.id} onRename={(t) => void db.renameRow(r.id, t)} onRenameLocal={(t) => db.renameRowLocal(r.id, t)} onAddRow={() => void addRowAndFocus()} />
                  <button className="db-open" onClick={(e) => openPage(r.id, e)} title="開く（⌘+クリックで全画面）">
                    <Icon name="openFull" size={13} /> 開く
                  </button>
                  {r.canEdit && (
                    <button
                      className="db-open db-row-delete"
                      title="この行を削除（ゴミ箱へ）"
                      aria-label={`${r.title || '無題'} の行を削除`}
                      onClick={async () => {
                        if (await confirm({ title: `「${r.title || '無題'}」の行を削除しますか？`, message: '行のページはゴミ箱に移ります（ゴミ箱から戻せます）。', confirmLabel: '削除', danger: true })) void db.deleteRow(r.id);
                      }}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  )}
                </span>
              </td>
              {props.map((p) => (
                <td key={p.id} className={`db-td-${p.type}`}>
                  <DbCell prop={p} value={r.values[p.id]} members={members} readOnly={!r.canEdit} onChange={(v) => db.setValues(r.id, { [p.id]: v })} onAddOption={(o) => db.addOption(p.id, o)} onAddRow={() => void addRowAndFocus()} />
                </td>
              ))}
              {canEdit && <td />}
            </tr>
          ))}
        </tbody>
      </table>
      {canEdit && (
        <button className="db-add-row" onClick={() => void db.addRow()}>
          <Icon name="plus" size={14} /> 新規
        </button>
      )}
      {!rows.length && !canEdit && <p className="db-hint">行がありません。</p>}
      {propAnchor && menuProp && (
        <Popover anchor={propAnchor.el} onClose={() => setPropAnchor(null)} width={280}>
          <PropMenu db={db} prop={menuProp} onClose={() => setPropAnchor(null)} onHide={() => updateView({ hidden: [...(view.hidden ?? []), menuProp.id] })} />
        </Popover>
      )}
      {hiddenAnchor && (
        <Popover anchor={hiddenAnchor} onClose={() => setHiddenAnchor(null)} width={220}>
          <div className="db-menu">
            <div className="db-menu-label">隠した列（押すと表示）</div>
            {hiddenProps.map((p) => (
              <button key={p.id} className="db-menu-item" onClick={() => updateView({ hidden: (view.hidden ?? []).filter((x) => x !== p.id) })}>
                {p.name}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}

function TitleInput({ row, readOnly, autoFocus, onRename, onRenameLocal, onAddRow }: { row: DbRow; readOnly: boolean; autoFocus?: boolean; onRename: (t: string) => void; onRenameLocal: (t: string) => void; onAddRow: () => void }) {
  const [text, setText] = useState(row.title);
  // 保存した名前（入力中にほかの画面へ映した名前とは別に覚えておく）
  const saved = useRef(row.title);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setText(row.title);
      saved.current = row.title;
    }
  }, [row.title]);
  const save = (t: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (t === saved.current) return;
    saved.current = t;
    onRename(t);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <input
      className="db-input db-title-input"
      value={text}
      placeholder="無題"
      readOnly={readOnly}
      autoFocus={autoFocus}
      onFocus={() => (focused.current = true)}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        // 入力したそばからサイドバーなどに映し、止まって 0.8 秒で保存する
        onRenameLocal(t);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => save(t), 800);
      }}
      onBlur={() => {
        focused.current = false;
        save(text);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
        (e.target as HTMLInputElement).blur();
        // ⌘+Enter（Ctrl+Enter）：下に行を足す
        if (e.metaKey || e.ctrlKey) onAddRow();
      }}
    />
  );
}

/** カードに出す、名前以外の値（空の列は出さない） */
function CardProps({ row, props, members, skip }: { row: DbRow; props: DbProp[]; members: DbData['members']; skip?: string | null }) {
  const items = props.filter((p) => p.id !== skip && valueText(p, row.values[p.id], members));
  if (!items.length) return null;
  return (
    <div className="db-card-props">
      {items.map((p) => {
        const v = row.values[p.id];
        if (p.type === 'select' || p.type === 'multi_select') {
          const ids = Array.isArray(v) ? (v as string[]) : [String(v)];
          return ids.map((id) => {
            const o = p.options?.find((x) => x.id === id);
            return o ? <Tag key={`${p.id}:${id}`} option={o} /> : null;
          });
        }
        return (
          <span key={p.id} className="db-card-prop" title={p.name}>
            {valueText(p, v, members)}
          </span>
        );
      })}
    </div>
  );
}

/* ---------- ボード ---------- */

function BoardView({ db, view, rows, canEdit, updateView }: ViewProps) {
  const { schema, members } = db.data!;
  const openPage = usePageOpener();
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const selects = schema.props.filter((p) => p.type === 'select');
  const group = schema.props.find((p) => p.id === view.groupBy && p.type === 'select');
  const visible = schema.props.filter((p) => !(view.hidden ?? []).includes(p.id));
  if (!group) {
    return (
      <div className="db-empty-view">
        {selects.length ? (
          <label>
            分ける列：
            <select value="" onChange={(e) => updateView({ groupBy: e.target.value })}>
              <option value="">（選ぶ）</option>
              {selects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="db-hint">ボードで分けるには「セレクト」の列が必要です。表の「＋」から列を追加し、種類を「セレクト」にしてください。</p>
        )}
      </div>
    );
  }
  const columns: { id: string | null; option: DbOption | null }[] = [...(group.options ?? []).map((o) => ({ id: o.id, option: o })), { id: null, option: null }];
  const drop = (colId: string | null) => {
    if (dragId) db.setValues(dragId, { [group.id]: colId });
    setDragId(null);
    setOver(null);
  };
  return (
    <>
      {selects.length > 1 && canEdit && (
        <div className="db-subbar">
          分ける列：
          <select value={group.id} onChange={(e) => updateView({ groupBy: e.target.value })}>
            {selects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="db-board">
        {columns.map((col) => {
          const list = rows.filter((r) => (col.id === null ? !group.options?.some((o) => o.id === r.values[group.id]) : r.values[group.id] === col.id));
          if (col.id === null && !list.length && !canEdit) return null;
          return (
            <div
              key={col.id ?? '__none'}
              className={`db-column ${over === (col.id ?? '__none') ? 'is-over' : ''}`}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                setOver(col.id ?? '__none');
              }}
              onDragLeave={() => setOver((o) => (o === (col.id ?? '__none') ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                drop(col.id);
              }}
            >
              <div className="db-column-head">
                {col.option ? <Tag option={col.option} /> : <span className="db-empty">{group.name}なし</span>}
                <span className="db-column-count">{list.length}</span>
              </div>
              {list.map((r) => (
                <button
                  key={r.id}
                  className={`db-card ${dragId === r.id ? 'is-dragging' : ''}`}
                  draggable={r.canEdit}
                  onDragStart={(e) => {
                    setDragId(r.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setOver(null);
                  }}
                  onClick={(e) => openPage(r.id, e)}
                >
                  <span className="db-card-title">
                    {r.icon && <PageIcon icon={r.icon} size={14} />} {r.title || '無題'}
                  </span>
                  <CardProps row={r} props={visible} members={members} skip={group.id} />
                </button>
              ))}
              {canEdit && (
                <button className="db-add-row" onClick={() => void db.addRow(col.id ? { [group.id]: col.id } : {})}>
                  <Icon name="plus" size={14} /> 新規
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ---------- パネル（表紙・名前・もう 1 つの列だけを並べる。読書記録の本棚） ---------- */

function GalleryView({ db, view, rows, canEdit }: ViewProps) {
  const { schema, members } = db.data!;
  const openPage = usePageOpener();
  // 名前の下に出す列（読書記録なら著者。なければ、隠していない最初の文字の列）
  const sub = schema.props.find((p) => p.id === 'author') ?? schema.props.find((p) => p.type === 'text' && !(view.hidden ?? []).includes(p.id));
  return (
    <div className="db-gallery">
      {rows.map((r) => (
        <button key={r.id} className="db-gallery-card" onClick={(e) => openPage(r.id, e)} title={r.title}>
          {r.cover && /^(https:\/\/|\/api\/files\/)/.test(r.cover) ? (
            <img src={r.cover} alt="" className="db-gallery-cover" referrerPolicy="no-referrer" loading="lazy" />
          ) : (
            <span className="db-gallery-cover is-empty">{r.title || '無題'}</span>
          )}
          <span className="db-gallery-title">{r.title || '無題'}</span>
          {sub && <span className="db-gallery-sub">{valueText(sub, r.values[sub.id], members)}</span>}
        </button>
      ))}
      {canEdit && (
        <button
          className="db-gallery-card db-gallery-add"
          onClick={async () => {
            const id = await db.addRow();
            if (id) openPage(id);
          }}
        >
          <span className="db-gallery-cover is-empty">
            <Icon name="plus" size={20} />
          </span>
          <span className="db-gallery-title">新規</span>
        </button>
      )}
    </div>
  );
}

/* ---------- カレンダー ---------- */

function CalendarView({ db, view, rows, canEdit, updateView }: ViewProps) {
  const { schema } = db.data!;
  const openPage = usePageOpener();
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const dates = schema.props.filter((p) => p.type === 'date');
  const dateProp = schema.props.find((p) => p.id === view.dateProp && p.type === 'date');
  const byDay = useMemo(() => {
    const m = new Map<string, DbRow[]>();
    if (dateProp) for (const r of rows) {
      const d = r.values[dateProp.id];
      if (typeof d === 'string') m.set(d, [...(m.get(d) ?? []), r]);
    }
    return m;
  }, [rows, dateProp]);
  if (!dateProp) {
    return (
      <div className="db-empty-view">
        {dates.length ? (
          <label>
            日付の列：
            <select value="" onChange={(e) => updateView({ dateProp: e.target.value })}>
              <option value="">（選ぶ）</option>
              {dates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="db-hint">カレンダーで見るには「日付」の列が必要です。表の「＋」から列を追加し、種類を「日付」にしてください。</p>
        )}
      </div>
    );
  }
  const start = new Date(month);
  start.setDate(1 - month.getDay());
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
  const today = ymd(new Date());
  const move = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const noDate = rows.filter((r) => typeof r.values[dateProp.id] !== 'string');
  return (
    <div className="db-cal">
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
        <button className="btn btn-ghost btn-sm" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>
          今日
        </button>
        {dates.length > 1 && canEdit && (
          <select className="db-cal-prop" value={dateProp.id} onChange={(e) => updateView({ dateProp: e.target.value })} aria-label="日付の列">
            {dates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="task-cal-grid db-cal-grid">
        {WEEK.map((w, i) => (
          <div key={w} className={`task-cal-week ${i === 0 ? 'is-sun' : i === 6 ? 'is-sat' : ''}`}>
            {w}
          </div>
        ))}
        {days.map((d) => {
          const key = ymd(d);
          const list = byDay.get(key) ?? [];
          return (
            <div
              key={key}
              className={`db-cal-day ${d.getMonth() !== month.getMonth() ? 'is-other' : ''} ${key === today ? 'is-today' : ''} ${over === key ? 'is-over' : ''}`}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                setOver(key);
              }}
              onDragLeave={() => setOver((o) => (o === key ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) db.setValues(dragId, { [dateProp.id]: key });
                setDragId(null);
                setOver(null);
              }}
            >
              <div className="db-cal-num">
                <span>{d.getDate()}</span>
                {canEdit && (
                  <button className="db-cal-add" onClick={() => void db.addRow({ [dateProp.id]: key })} aria-label={`${d.getMonth() + 1}月${d.getDate()}日に追加`}>
                    <Icon name="plus" size={12} />
                  </button>
                )}
              </div>
              {list.map((r) => (
                <button
                  key={r.id}
                  className="db-cal-item"
                  draggable={r.canEdit}
                  onDragStart={() => setDragId(r.id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setOver(null);
                  }}
                  onClick={(e) => openPage(r.id, e)}
                >
                  {r.title || '無題'}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      {noDate.length > 0 && (
        <div className="db-cal-nodate">
          <span className="muted small">日付なし（{noDate.length}）：</span>
          {noDate.map((r) => (
            <button key={r.id} className="db-cal-item" draggable={r.canEdit} onDragStart={() => setDragId(r.id)} onDragEnd={() => setDragId(null)} onClick={(e) => openPage(r.id, e)}>
              {r.title || '無題'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- 行のページに出す、列の値 ---------- */

export function RowProperties({ databaseId, rowId, readOnly = false }: { databaseId: string; rowId: string; readOnly?: boolean }) {
  const db = useDatabase(databaseId);
  const [propAnchor, setPropAnchor] = useState<{ el: HTMLElement; id: string } | null>(null);
  if (!db.data) return null;
  const row = db.data.rows.find((r) => r.id === rowId);
  if (!row) return null;
  const { schema, members } = db.data;
  const canEdit = db.data.canEdit && !readOnly;
  const rowEditable = row.canEdit && !readOnly;
  const menuProp = propAnchor && schema.props.find((p) => p.id === propAnchor.id);
  return (
    <div className="db-row-props">
      {schema.props.map((p) => (
        <div key={p.id} className="db-row-prop">
          <button className="db-row-prop-name" disabled={!canEdit} onClick={(e) => setPropAnchor({ el: e.currentTarget, id: p.id })}>
            {p.name}
          </button>
          <div className={`db-row-prop-value db-td-${p.type}`}>
            <DbCell prop={p} value={row.values[p.id]} members={members} readOnly={!rowEditable} onChange={(v) => db.setValues(row.id, { [p.id]: v })} onAddOption={(o) => db.addOption(p.id, o)} />
          </div>
        </div>
      ))}
      {canEdit && (
        <button
          className="db-row-prop-add"
          onClick={(e) => {
            const p: DbProp = { id: newId(), name: `列 ${schema.props.length + 1}`, type: 'text' };
            db.updateSchema((s) => ({ ...s, props: [...s.props, p] }));
            setPropAnchor({ el: e.currentTarget, id: p.id });
          }}
        >
          <Icon name="plus" size={14} /> 列を追加
        </button>
      )}
      {propAnchor && menuProp && (
        <Popover anchor={propAnchor.el} onClose={() => setPropAnchor(null)} width={280}>
          <PropMenu db={db} prop={menuProp} onClose={() => setPropAnchor(null)} />
        </Popover>
      )}
    </div>
  );
}
