/** データベースの値を表示・編集する部品（表のセル・行のページのプロパティで使う） */
import { useEffect, useState } from 'react';
import { Icon, Popover } from '../ui';
import { COLORS, newId, type DbData, type DbOption, type DbProp } from './dbModel';

export function Tag({ option }: { option: DbOption }) {
  return <span className={`db-tag c-${option.color}`}>{option.name || '無題'}</span>;
}

/** 入力欄（文字・数値・URL）。打ち終えた（フォーカスを外した）ときに保存する。
 * 文字の列は Enter でセルの中で改行、⌘+Enter（Ctrl+Enter）で確定して下に行を足す */
function TextInput({ prop, value, onChange, readOnly, onAddRow }: { prop: DbProp; value: unknown; onChange: (v: unknown) => void; readOnly: boolean; onAddRow?: () => void }) {
  const initial = value === undefined || value === null ? '' : String(value);
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  const commit = () => {
    if (text === initial) return;
    if (prop.type === 'number') {
      const n = text.trim() === '' ? null : Number(text.replace(/[,，]/g, ''));
      if (n !== null && Number.isNaN(n)) return setText(initial);
      onChange(n);
    } else onChange(text.trim() ? text : null);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      setText(initial);
      requestAnimationFrame(() => (e.target as HTMLElement).blur());
      return;
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      commit();
      (e.target as HTMLElement).blur();
      onAddRow?.();
    } else if (prop.type !== 'text') {
      // 数値・URL は 1 行なので、Enter で確定する
      (e.target as HTMLElement).blur();
    }
  };
  if (prop.type === 'text') {
    return (
      <textarea
        className="db-input db-textarea"
        value={text}
        readOnly={readOnly}
        rows={1}
        placeholder={readOnly ? '' : '空'}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        ref={(el) => {
          // 中身に合わせて高さを変える
          if (el) {
            el.style.height = 'auto';
            el.style.height = `${el.scrollHeight}px`;
          }
        }}
      />
    );
  }
  return (
    <span className="db-input-wrap">
      <input
        className={`db-input ${prop.type === 'number' ? 'is-number' : ''}`}
        value={text}
        readOnly={readOnly}
        inputMode={prop.type === 'number' ? 'decimal' : prop.type === 'url' ? 'url' : undefined}
        placeholder={readOnly ? '' : '空'}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      {prop.type === 'url' && /^https?:\/\//.test(initial) && (
        <a className="db-url-open" href={initial} target="_blank" rel="noreferrer" title="開く">
          <Icon name="external" size={13} />
        </a>
      )}
    </span>
  );
}

/** セレクト・マルチセレクト・ユーザーを選ぶ */
function Chooser({
  prop,
  value,
  members,
  onChange,
  onAddOption,
  readOnly,
}: {
  prop: DbProp;
  value: unknown;
  members: DbData['members'];
  onChange: (v: unknown) => void;
  onAddOption: (o: DbOption) => void;
  readOnly: boolean;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const multi = prop.type !== 'select';
  const options: DbOption[] = prop.type === 'person' ? members.map((m) => ({ id: m.id, name: m.name, color: 'gray' })) : (prop.options ?? []);
  const selected: string[] = Array.isArray(value) ? (value as string[]) : value ? [String(value)] : [];
  const shown = options.filter((o) => o.name.toLowerCase().includes(query.trim().toLowerCase()));
  const exact = options.some((o) => o.name === query.trim());
  const toggle = (id: string) => {
    if (!multi) {
      onChange(selected[0] === id ? null : id);
      setAnchor(null);
      return;
    }
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };
  const create = () => {
    const name = query.trim();
    if (!name || exact || prop.type === 'person') return;
    const o = { id: newId(), name, color: COLORS[(prop.options?.length ?? 0) % COLORS.length]! };
    onAddOption(o);
    toggle(o.id);
    setQuery('');
  };
  return (
    <>
      <button className="db-chooser" disabled={readOnly} onClick={(e) => setAnchor(e.currentTarget)}>
        {selected.length ? (
          selected.map((id) => {
            const o = options.find((x) => x.id === id);
            return o ? prop.type === 'person' ? <span key={id} className="db-person">{o.name}</span> : <Tag key={id} option={o} /> : null;
          })
        ) : (
          <span className="db-empty">{readOnly ? '' : '空'}</span>
        )}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => { setAnchor(null); setQuery(''); }} width={260}>
          <div className="db-chooser-pop">
            <input
              autoFocus
              className="db-chooser-search"
              placeholder={prop.type === 'person' ? 'ユーザーを探す' : '探す・新しく作る'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  if (shown.length === 1 && (exact || prop.type === 'person')) toggle(shown[0]!.id);
                  else create();
                }
              }}
            />
            <div className="db-chooser-list">
              {shown.map((o) => (
                <button key={o.id} className={`db-chooser-item ${selected.includes(o.id) ? 'on' : ''}`} onClick={() => toggle(o.id)}>
                  {prop.type === 'person' ? <span className="db-person">{o.name}</span> : <Tag option={o} />}
                  {selected.includes(o.id) && <Icon name="check" size={14} />}
                </button>
              ))}
              {query.trim() && !exact && prop.type !== 'person' && (
                <button className="db-chooser-item" onClick={create}>
                  <Icon name="plus" size={14} /> 「{query.trim()}」を作る
                </button>
              )}
              {!shown.length && !query.trim() && <p className="db-chooser-none">{prop.type === 'person' ? 'メンバーがいません' : '入力して選択肢を作れます'}</p>}
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

export function DbCell({
  prop,
  value,
  members,
  readOnly,
  onChange,
  onAddOption,
  onAddRow,
}: {
  prop: DbProp;
  value: unknown;
  members: DbData['members'];
  readOnly: boolean;
  onChange: (v: unknown) => void;
  onAddOption: (o: DbOption) => void;
  /** ⌘+Enter（Ctrl+Enter）で下に行を足す（表のときだけ） */
  onAddRow?: () => void;
}) {
  switch (prop.type) {
    case 'checkbox':
      return <input type="checkbox" className="db-check" checked={!!value} disabled={readOnly} onChange={(e) => onChange(e.target.checked || null)} />;
    case 'date':
      return (
        <input
          type="date"
          className="db-input db-date"
          value={typeof value === 'string' ? value : ''}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case 'select':
    case 'multi_select':
    case 'person':
      return <Chooser prop={prop} value={value} members={members} onChange={onChange} onAddOption={onAddOption} readOnly={readOnly} />;
    default:
      return <TextInput prop={prop} value={value} onChange={onChange} readOnly={readOnly} onAddRow={onAddRow} />;
  }
}
