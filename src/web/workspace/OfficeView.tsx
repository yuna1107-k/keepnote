/**
 * 表（CSV・TSV・Excel・OpenDocument）と Word 文書をアプリ内で表示する。
 * 保存先が渡されたときは、表をその場で編集できる（CSV・TSV・Excel）。
 * 変換のライブラリが大きいので、開くときだけ読み込む。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from 'react';
import { Button, Icon, Spinner } from '../ui';
import { flushWhenIdle, selfSaved, type Flush } from './selfSaved';
import { colName, docxToHtml, patchOds, patchXlsx, readSheets, sanitizeHtml, SHEET_EXT, toDelimited, type CellEdit, type Sheet } from './office';

/** 一度に描く行の数（多い表は「さらに表示」で増やす） */
const PAGE_ROWS = 300;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ODS_TYPE = 'application/vnd.oasis.opendocument.spreadsheet';

export type SaveHandler = (data: { blob: Blob; text?: string }) => Promise<void>;

type Props = {
  /** ファイルの URL（text を渡したときは使わない） */
  url?: string;
  name: string;
  /** CSV・TSV の中身がすでに手元にあるとき */
  text?: string;
  /** 編集して保存できるとき（CSV・TSV・Excel） */
  onSave?: SaveHandler;
  /** 保存ボタンの文言 */
  saveLabel?: string;
  /** text を渡したとき、保存で BOM を付けるか（元が Shift_JIS・BOM 付きだった CSV） */
  bom?: boolean;
  /** 未保存の変更があるかを知らせる（閉じるときの確認に使う） */
  onDirty?: (dirty: boolean) => void;
  /** 未保存の変更を今すぐ保存する関数を受け取る（閉じるときに使う） */
  flushRef?: MutableRefObject<Flush | null>;
};

/** 編集が止まってから保存するまでの時間 */
const AUTOSAVE_MS = 3000;

/** 元のファイルの情報（保存するときに同じ形に戻すため） */
type Source = { buf: ArrayBuffer; bom: boolean; eol: string };

export default function OfficeView({ url, name, text, bom: textBom, onSave, saveLabel, onDirty, flushRef }: Props) {
  // 自分で保存した内容（text が戻ってきても読み直さない）
  const ownText = useRef<string | null>(null);
  // この画面で読み込み済みか（保存で URL が変わっても読み直さないのは、読み込み済みのときだけ）
  const hasContent = useRef(false);
  const isSheet = SHEET_EXT.test(name);
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 自分で保存した直後は読み直さない（編集中の選択や入力をそのままにする）
    if (hasContent.current && ((url && selfSaved.has(url)) || (text !== undefined && text === ownText.current))) return;
    let alive = true;
    setError(null);
    (async () => {
      try {
        let buf: ArrayBuffer;
        if (text !== undefined) buf = new TextEncoder().encode(text).buffer as ArrayBuffer;
        else {
          const res = await fetch(url!, { credentials: 'same-origin' });
          if (!res.ok) throw new Error(`ファイルを開けませんでした（${res.status}）`);
          buf = await res.arrayBuffer();
        }
        if (buf.byteLength > 30_000_000) throw new Error('ファイルが大きすぎるため、ここでは表示できません。ダウンロードして開いてください');
        if (isSheet) {
          const s = readSheets(buf, name);
          const head = new Uint8Array(buf.slice(0, 3));
          const utf8 = (() => {
            try {
              new TextDecoder('utf-8', { fatal: true }).decode(buf);
              return true;
            } catch {
              return false;
            }
          })();
          // BOM 付き・Shift_JIS だった CSV は、Excel で文字化けしないよう BOM 付きの UTF-8 で保存する
          const bom = text !== undefined ? !!textBom : (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) || !utf8;
          const eol = /\r\n/.test(new TextDecoder().decode(buf.slice(0, 65536))) ? '\r\n' : '\n';
          if (alive) {
            hasContent.current = true;
            setSheets(s);
            setSource({ buf, bom, eol });
          }
        } else {
          const h = sanitizeHtml(await docxToHtml(buf));
          if (alive) setHtml(h);
        }
      } catch (e) {
        if (alive) setError((e as Error).message || 'ファイルを読み取れませんでした');
      }
    })();
    return () => {
      alive = false;
    };
  }, [url, name, text, isSheet, textBom]);

  if (error) return <p className="muted office-error">{error}</p>;
  if (isSheet) return sheets && source ? <SheetTabs sheets={sheets} source={source} name={name} onSave={onSave} saveLabel={saveLabel} onDirty={onDirty} flushRef={flushRef} ownText={ownText} /> : <Spinner />;
  if (html === null) return <Spinner />;
  return (
    <article className="docx-view">
      {/* sanitizeHtml で決まったタグと安全な属性だけにしてある */}
      {html.trim() ? <div dangerouslySetInnerHTML={{ __html: html }} /> : <p className="muted">（文書は空です）</p>}
    </article>
  );
}

function SheetTabs({
  sheets: initial,
  source,
  name,
  onSave,
  saveLabel,
  onDirty,
  flushRef,
  ownText,
}: {
  sheets: Sheet[];
  source: Source;
  name: string;
  onSave?: SaveHandler;
  saveLabel?: string;
  onDirty?: (dirty: boolean) => void;
  flushRef?: MutableRefObject<Flush | null>;
  ownText: MutableRefObject<string | null>;
}) {
  const kind = /\.csv$/i.test(name) ? 'csv' : /\.tsv$/i.test(name) ? 'tsv' : /\.(xlsx|xlsm)$/i.test(name) ? 'xlsx' : /\.ods$/i.test(name) ? 'ods' : 'other';
  const [sheets, setSheets] = useState(() => initial.map((s) => ({ ...s, rows: s.rows.map((r) => [...r]) })));
  const [index, setIndex] = useState(0);
  const edits = useRef(new Map<string, CellEdit>());
  const base = useRef(source.buf);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const sheet = sheets[index];

  // 途中までしか読んでいない CSV を保存すると残りが消えるので、編集させない
  const truncatedText = (kind === 'csv' || kind === 'tsv') && sheet?.truncated;
  const editable = !!onSave && kind !== 'other' && !truncatedText;
  const canDelete = kind === 'csv' || kind === 'tsv';

  useEffect(() => onDirty?.(dirty), [dirty, onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const dirtyRef = useRef(false);
  const changes = useRef(0);
  const rowsRef = useRef(sheets[0]?.rows ?? []);
  rowsRef.current = sheets[0]?.rows ?? [];
  const update = (fn: (rows: string[][]) => string[][]) => {
    setSheets((all) => {
      const next = all.map((s, i) => (i === index ? { ...s, rows: fn(s.rows) } : s));
      rowsRef.current = next[0]?.rows ?? [];
      return next;
    });
    changes.current++;
    dirtyRef.current = true;
    setDirty(true);
    setNotice('');
  };

  const setCell = (r: number, c: number, value: string) => {
    if (sheet.locked?.has(`${r},${c}`)) {
      setNotice('数式のセルは編集できません（数式が消えるため）。Excel で編集してください');
      return;
    }
    if ((sheet.rows[r]?.[c] ?? '') === value) return;
    edits.current.set(`${index}:${r}:${c}`, { sheet: index, row: r, col: c, value });
    update((rows) => {
      const width = Math.max(rows[0]?.length ?? 0, c + 1);
      const next = rows.map((row) => (row.length < width ? [...row, ...Array(width - row.length).fill('')] : row));
      while (next.length <= r) next.push(Array(width).fill(''));
      next[r] = next[r].map((v, j) => (j === c ? value : v));
      return next;
    });
  };

  const busy = useRef(false);
  const save = async (): Promise<boolean> => {
    if (!onSave || !dirtyRef.current) return true;
    if (busy.current) return false;
    busy.current = true;
    setSaving(true);
    // 保存中に入った編集は、次の保存に回す
    const sent = new Map(edits.current);
    const version = changes.current;
    try {
      if (kind === 'xlsx' || kind === 'ods') {
        const bytes = kind === 'xlsx' ? patchXlsx(base.current, [...sent.values()]) : patchOds(base.current, [...sent.values()]);
        await onSave({ blob: new Blob([bytes as BlobPart], { type: kind === 'xlsx' ? XLSX_TYPE : ODS_TYPE }) });
        base.current = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      } else {
        const text = toDelimited(rowsRef.current, kind === 'tsv' ? '\t' : ',', source.eol);
        const type = kind === 'tsv' ? 'text/tab-separated-values' : 'text/csv';
        ownText.current = text;
        await onSave({ blob: new Blob([source.bom ? '\uFEFF' : '', text], { type }), text });
      }
      for (const [k, v] of sent) if (edits.current.get(k) === v) edits.current.delete(k);
      const done = changes.current === version;
      dirtyRef.current = !done;
      setDirty(!done);
      setNotice(done ? '保存済み' : '');
      return done;
    } catch (e) {
      setNotice((e as Error).message || '保存できませんでした');
      return false;
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  if (flushRef) flushRef.current = () => flushWhenIdle(() => busy.current, () => saveRef.current());
  // 編集が止まってしばらくしたら保存する
  useEffect(() => {
    if (!dirty || !onSave) return;
    const t = setTimeout(() => void saveRef.current(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [dirty, sheets, onSave]);
  // 画面を離れるときも保存する
  useEffect(() => () => void (dirtyRef.current && saveRef.current()), []);

  if (!sheet) return <p className="muted office-error">シートがありません</p>;
  return (
    <div className="sheet-view">
      {sheets.length > 1 && (
        <div className="sheet-tabs" role="tablist" aria-label="シート">
          {sheets.map((s, i) => (
            <button key={i} role="tab" aria-selected={i === index} className={`sheet-tab ${i === index ? 'is-active' : ''}`} onClick={() => setIndex(i)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      {editable && (
        <div className="sheet-toolbar">
          <SheetActions
            onAddRow={() => update((rows) => [...rows, Array(Math.max(1, rows[0]?.length ?? 1)).fill('')])}
            onAddCol={() => update((rows) => (rows.length ? rows.map((r) => [...r, '']) : [['']]))}
            canDelete={canDelete}
            sheet={sheet}
            onDeleteRow={(r) => update((rows) => rows.filter((_, i) => i !== r))}
            onDeleteCol={(c) => update((rows) => rows.map((row) => row.filter((_, j) => j !== c)))}
          />
          <span className={`sheet-status ${dirty ? 'is-dirty' : ''}`} role="status">
            {saving ? '保存中…' : notice || (dirty ? '未保存の変更があります' : kind === 'xlsx' || kind === 'ods' ? '書式や数式はそのまま残ります（自動で保存します）' : '自動で保存します')}
          </span>
          <Button size="sm" variant="primary" onClick={() => void save()} disabled={!dirty || saving}>
            {saveLabel ?? '今すぐ保存'}
          </Button>
        </div>
      )}
      {!editable && onSave && truncatedText && <p className="muted small sheet-note">大きいファイルのため、途中までを表示しています（編集はできません）</p>}
      <SheetTable
        key={index}
        sheet={sheet}
        editable={editable}
        onEdit={setCell}
        onSave={() => void save()}
        onSelect={() => setNotice('')}
      />
    </div>
  );
}

/** 選んでいるセル（行の削除・列の削除で使う） */
let lastSelected: { r: number; c: number } | null = null;

function SheetActions({
  onAddRow,
  onAddCol,
  canDelete,
  sheet,
  onDeleteRow,
  onDeleteCol,
}: {
  onAddRow: () => void;
  onAddCol: () => void;
  canDelete: boolean;
  sheet: Sheet;
  onDeleteRow: (r: number) => void;
  onDeleteCol: (c: number) => void;
}) {
  return (
    <div className="sheet-actions">
      <Button size="sm" variant="ghost" onClick={onAddRow}>
        <Icon name="plus" size={14} /> 行
      </Button>
      <Button size="sm" variant="ghost" onClick={onAddCol}>
        <Icon name="plus" size={14} /> 列
      </Button>
      {canDelete && (
        <>
          <Button size="sm" variant="ghost" onClick={() => lastSelected && lastSelected.r < sheet.rows.length && onDeleteRow(lastSelected.r)} title="選んでいるセルの行を削除">
            行を削除
          </Button>
          <Button size="sm" variant="ghost" onClick={() => lastSelected && onDeleteCol(lastSelected.c)} title="選んでいるセルの列を削除">
            列を削除
          </Button>
        </>
      )}
    </div>
  );
}

function SheetTable({
  sheet,
  editable,
  onEdit,
  onSave,
  onSelect,
}: {
  sheet: Sheet;
  editable: boolean;
  onEdit: (r: number, c: number, value: string) => void;
  onSave: () => void;
  onSelect: () => void;
}) {
  const [shown, setShown] = useState(PAGE_ROWS);
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const width = Math.max(sheet.rows[0]?.length ?? 0, editable ? 1 : 0);
  const height = Math.max(sheet.rows.length, editable ? 1 : 0);
  const cols = useMemo(() => Array.from({ length: width }, (_, i) => colName(i)), [width]);

  const select = (r: number, c: number) => {
    const next = { r: Math.max(0, Math.min(r, height - 1)), c: Math.max(0, Math.min(c, width - 1)) };
    setSel(next);
    lastSelected = next;
    onSelect();
    if (next.r >= shown) setShown(next.r + PAGE_ROWS);
    requestAnimationFrame(() => wrap.current?.querySelector(`[data-cell="${next.r},${next.c}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  };
  const startEdit = (r: number, c: number, value?: string) => {
    if (!editable) return;
    if (sheet.locked?.has(`${r},${c}`)) {
      onEdit(r, c, sheet.rows[r]?.[c] ?? '');
      return;
    }
    setEditing({ r, c, value: value ?? sheet.rows[r]?.[c] ?? '' });
  };
  const commit = (move?: 'down' | 'right' | 'left') => {
    if (!editing) return;
    onEdit(editing.r, editing.c, editing.value);
    const { r, c } = editing;
    setEditing(null);
    if (move === 'down') select(r + 1 < height ? r + 1 : r, c);
    else if (move === 'right') select(r, c + 1);
    else if (move === 'left') select(r, c - 1);
    requestAnimationFrame(() => wrap.current?.focus());
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (editing) commit();
      onSave();
      return;
    }
    if (editing || !sel) return;
    const { r, c } = sel;
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (moves[e.key]) {
      e.preventDefault();
      select(r + moves[e.key][0], c + moves[e.key][1]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      select(r, c + (e.shiftKey ? -1 : 1));
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      startEdit(r, c);
    } else if (editable && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      onEdit(r, c, '');
    } else if (editable && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      startEdit(r, c, e.key);
    } else if (editable && (e.key === 'Process' || e.keyCode === 229)) {
      // 日本語入力が始まったら、そのまま入力欄で続けられるように編集を始める
      startEdit(r, c, '');
    }
  };

  // 表計算ソフトからコピーした範囲（タブ区切り）を、選んでいるセルから貼り付ける
  const onPaste = (e: React.ClipboardEvent) => {
    if (!editable || editing || !sel) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    lines.forEach((line, i) => line.split('\t').forEach((v, j) => onEdit(sel.r + i, sel.c + j, v)));
  };

  if (!sheet.rows.length && !editable) return <p className="muted office-error">（このシートは空です）</p>;
  const rows = Array.from({ length: Math.min(height, shown) }, (_, i) => sheet.rows[i] ?? Array(width).fill(''));
  return (
    <>
      <div className={`sheet-scroll ${editable ? 'is-editable' : ''}`} ref={wrap} tabIndex={0} onKeyDown={onKey} onPaste={onPaste} aria-label="表">
        <table className="sheet-table">
          <thead>
            <tr>
              <th className="sheet-corner" />
              {cols.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <th scope="row">{i + 1}</th>
                {cols.map((_, j) => {
                  const cell = r[j] ?? '';
                  const isSel = sel?.r === i && sel.c === j;
                  const isEditing = editing?.r === i && editing.c === j;
                  const locked = sheet.locked?.has(`${i},${j}`);
                  const cls = [/^-?[\d,.]+%?$/.test(cell) ? 'is-num' : '', isSel ? 'is-selected' : '', locked ? 'is-locked' : '', isEditing ? 'is-editing' : '']
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <td
                      key={j}
                      data-cell={`${i},${j}`}
                      className={cls || undefined}
                      title={locked ? '数式のセル' : undefined}
                      onMouseDown={() => {
                        if (editing && !isEditing) commit();
                        select(i, j);
                      }}
                      onDoubleClick={() => startEdit(i, j)}
                    >
                      {isEditing ? (
                        <textarea
                          className="sheet-input"
                          autoFocus
                          rows={Math.max(1, editing.value.split('\n').length)}
                          value={editing.value}
                          onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
                          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                          onBlur={() => commit()}
                          onKeyDown={(e) => {
                            if (e.nativeEvent.isComposing) return;
                            e.stopPropagation();
                            if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
                              e.preventDefault();
                              commit('down');
                            } else if (e.key === 'Tab') {
                              e.preventDefault();
                              commit(e.shiftKey ? 'left' : 'right');
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              setEditing(null);
                              requestAnimationFrame(() => wrap.current?.focus());
                            } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                              e.preventDefault();
                              commit();
                              onSave();
                            }
                          }}
                        />
                      ) : (
                        cell
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="sheet-foot muted small">
        {sheet.rows.length} 行 × {sheet.rows[0]?.length ?? 0} 列
        {sheet.truncated && '（大きいため、途中までを表示しています）'}
        {editable && '・ダブルクリックか Enter で編集、Shift+Enter で改行'}
        {shown < height && (
          <button className="btn btn-ghost btn-sm" onClick={() => setShown((n) => n + PAGE_ROWS * 3)}>
            さらに表示
          </button>
        )}
      </div>
    </>
  );
}
