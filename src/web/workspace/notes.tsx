/**
 * 脚注と参考文献（大学のレポート向け）。
 *
 * - 脚注（footnote）：文中に小さな番号（1, 2, …）を出し、脚注の文はページの最後に並べる。番号は本文の順に自動で振る
 * - 文献の引用（cite）：文中の [@key] を「著者 (年)」と表示する。文献は同じページの「参考文献」ブロックから探す
 * - 参考文献（references）：BibTeX か、1 行に 1 件の文献を貼ると、レポートの体裁に整えた一覧を出す
 * - Markdown との変換：脚注は [^1] と「[^1]: 文」、引用は [@key]、参考文献は HTML コメントで元の文を残した一覧にする
 */
import { createReactBlockSpec, createReactInlineContentSpec } from '@blocknote/react';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Popover } from '../ui';

// ---------- 文献の読み取り ----------

export type RefEntry = {
  key: string;
  type: string;
  authors: string[];
  year: string;
  title: string;
  journal: string;
  booktitle: string;
  publisher: string;
  volume: string;
  number: string;
  pages: string;
  url: string;
  /** 1 行で書いた文献（BibTeX でないもの）は、その文をそのまま一覧に出す */
  plain?: string;
};

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** BibTeX の値の { } や簡単な記号を取り除く */
function cleanTex(v: string) {
  return v
    .replace(/\\&/g, '&')
    .replace(/\\%/g, '%')
    .replace(/\\textit\{([^}]*)\}|\\emph\{([^}]*)\}/g, (_m, a, b) => a ?? b ?? '')
    .replace(/--/g, '–')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** BibTeX を読む（@type{key, field = {値} / "値" / 数字, ...}） */
function parseBibtex(src: string): RefEntry[] {
  const out: RefEntry[] = [];
  const re = /@(\w+)\s*[{(]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const type = m[1]!.toLowerCase();
    if (type === 'comment' || type === 'string' || type === 'preamble') continue;
    let i = re.lastIndex;
    // 対応する閉じかっこまでを 1 件とする
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '{' || ch === '(') depth++;
      else if (ch === '}' || ch === ')') depth--;
      i++;
    }
    const body = src.slice(start, i - 1);
    re.lastIndex = i;
    const comma = body.indexOf(',');
    const key = (comma < 0 ? body : body.slice(0, comma)).trim();
    if (!key) continue;
    const fields: Record<string, string> = {};
    let rest = comma < 0 ? '' : body.slice(comma + 1);
    const fieldRe = /^\s*([\w-]+)\s*=\s*/;
    while (rest.trim()) {
      const f = fieldRe.exec(rest);
      if (!f) break;
      rest = rest.slice(f[0].length);
      let value = '';
      if (rest[0] === '{') {
        let d = 0;
        let j = 0;
        for (; j < rest.length; j++) {
          if (rest[j] === '{') d++;
          else if (rest[j] === '}' && --d === 0) break;
        }
        value = rest.slice(1, j);
        rest = rest.slice(j + 1);
      } else if (rest[0] === '"') {
        const j = rest.indexOf('"', 1);
        value = rest.slice(1, j < 0 ? undefined : j);
        rest = j < 0 ? '' : rest.slice(j + 1);
      } else {
        const j = rest.search(/[,\n]/);
        value = j < 0 ? rest : rest.slice(0, j);
        rest = j < 0 ? '' : rest.slice(j);
      }
      fields[f[1]!.toLowerCase()] = cleanTex(value);
      rest = rest.replace(/^\s*,/, '');
    }
    const authors = (fields.author || fields.editor || '')
      .split(/\s+and\s+/)
      .map((a) => a.trim())
      .filter(Boolean);
    out.push({
      key,
      type,
      authors,
      year: fields.year || (fields.date ?? '').slice(0, 4),
      title: fields.title ?? '',
      journal: fields.journal || fields.journaltitle || '',
      booktitle: fields.booktitle ?? '',
      publisher: fields.publisher || fields.institution || fields.school || fields.organization || '',
      volume: fields.volume ?? '',
      number: fields.number ?? '',
      pages: fields.pages ?? '',
      url: fields.url || (fields.doi ? `https://doi.org/${fields.doi}` : ''),
    });
  }
  return out;
}

/** 1 行の文献（例：山田太郎 (2020)『書名』出版社。／[key] で始めるとキーを決められる） */
function parsePlain(line: string): RefEntry | null {
  let text = line.trim().replace(/^[-*・•]\s*/, '');
  if (!text) return null;
  let key = '';
  const k = /^\[([^\]\s]+)\]\s*/.exec(text);
  if (k) {
    key = k[1]!;
    text = text.slice(k[0].length);
  }
  const year = /(1[5-9]\d{2}|20\d{2})[a-z]?/.exec(text)?.[0] ?? 'n.d.';
  // 著者：年・かっこ・句読点の手前まで
  const author = text.split(/\s*[（(]|[,，、。.]|\s(?=1[5-9]\d{2}|20\d{2})/)[0]!.trim();
  if (!key) key = (surname(author) + (year === 'n.d.' ? '' : year)).replace(/\s+/g, '');
  return { key, type: 'plain', authors: author ? [author] : [], year, title: '', journal: '', booktitle: '', publisher: '', volume: '', number: '', pages: '', url: '', plain: text };
}

/** 参考文献の文（BibTeX、または 1 行に 1 件）を読む */
export function parseReferences(source: string): RefEntry[] {
  if (!source.trim()) return [];
  if (/@\w+\s*[{(]/.test(source)) return parseBibtex(source);
  return source
    .split('\n')
    .map(parsePlain)
    .filter((e): e is RefEntry => !!e);
}

/** 姓（「Smith, John」→ Smith、「John Smith」→ Smith、「山田 太郎」「山田太郎」→ そのまま姓の部分） */
function surname(name: string) {
  const n = name.trim();
  if (n.includes(',')) return n.split(',')[0]!.trim();
  if (CJK.test(n)) return n.split(/\s+/)[0]!;
  const parts = n.split(/\s+/);
  return parts[parts.length - 1] ?? n;
}

const isJa = (e: RefEntry) => CJK.test(e.authors.join('') + e.title + (e.plain ?? ''));

/** 文中の引用の表示（山田 (2020)・Smith & Jones (2020)・山田ほか (2020)） */
export function citeLabel(e: RefEntry, locator = '') {
  const names = e.authors.map(surname);
  const ja = isJa(e);
  const who =
    names.length === 0
      ? e.title || e.key
      : names.length === 1
        ? names[0]
        : names.length === 2
          ? ja
            ? `${names[0]}・${names[1]}`
            : `${names[0]} & ${names[1]}`
          : ja
            ? `${names[0]}ほか`
            : `${names[0]} et al.`;
  return `${who} (${e.year || 'n.d.'}${locator ? `, ${locator}` : ''})`;
}

/** 一覧の 1 件の部品（italic は書名・雑誌名の斜体） */
export type RefPart = { text: string; italic?: boolean };

/** 英語の著者名を「Smith, J.」の形にする */
function enAuthor(name: string) {
  const n = name.trim();
  let last = n;
  let first = '';
  if (n.includes(',')) [last, first] = [n.split(',')[0]!.trim(), n.split(',').slice(1).join(',').trim()];
  else if (n.includes(' ')) {
    const p = n.split(/\s+/);
    last = p.pop()!;
    first = p.join(' ');
  }
  const initials = first
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => `${w[0]!.toUpperCase()}.`)
    .join(' ');
  return initials ? `${last}, ${initials}` : last;
}

/** 参考文献の一覧の 1 件（日本語のレポートでよく使う簡単な書き方） */
export function formatReference(e: RefEntry): RefPart[] {
  if (e.plain) return [{ text: e.plain }];
  const year = e.year || 'n.d.';
  if (isJa(e)) {
    const who = e.authors.join('・');
    const out: RefPart[] = [{ text: `${who}${who ? ' ' : ''}(${year})` }];
    const vol = `${e.volume}${e.number ? `(${e.number})` : ''}`;
    if (e.type === 'book') out.push({ text: `『${e.title}』${e.publisher}` });
    else if (e.journal) out.push({ text: `「${e.title}」『${e.journal}』${vol}${e.pages ? `, ${e.pages}頁` : ''}` });
    else if (e.booktitle) out.push({ text: `「${e.title}」『${e.booktitle}』${e.publisher}${e.pages ? `, ${e.pages}頁` : ''}` });
    else out.push({ text: `「${e.title}」${e.publisher}` });
    out.push({ text: `。${e.url ? ` ${e.url}` : ''}` });
    return out;
  }
  const names = e.authors.map(enAuthor);
  const who = names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`;
  const out: RefPart[] = [{ text: `${who}${who ? ' ' : ''}(${year}). ` }];
  if (e.type === 'book') {
    out.push({ text: e.title, italic: true }, { text: `. ${e.publisher}${e.publisher ? '.' : ''}` });
  } else if (e.journal) {
    out.push({ text: `${e.title}. ` }, { text: e.journal, italic: true });
    const vol = `${e.volume}${e.number ? `(${e.number})` : ''}`;
    out.push({ text: `${vol ? `, ${vol}` : ''}${e.pages ? `, ${e.pages}` : ''}.` });
  } else if (e.booktitle) {
    out.push({ text: `${e.title}. In ` }, { text: e.booktitle, italic: true }, { text: `${e.pages ? ` (pp. ${e.pages})` : ''}. ${e.publisher}${e.publisher ? '.' : ''}` });
  } else {
    out.push({ text: `${e.title}. ${e.publisher}${e.publisher ? '.' : ''}` });
  }
  if (e.url) out.push({ text: ` ${e.url}` });
  return out;
}

/** 一覧の並び：日本語の文献を先に（五十音順）、続けて英語など（アルファベット順） */
export function sortReferences(list: RefEntry[]) {
  const name = (e: RefEntry) => (e.authors[0] ? surname(e.authors[0]) : e.plain ?? e.title);
  return [...list].sort((a, b) => Number(isJa(b)) - Number(isJa(a)) || name(a).localeCompare(name(b), 'ja') || a.year.localeCompare(b.year));
}

// ---------- エディターごとの状態（脚注の番号・文献の一覧） ----------

type NotesState = { refs: Map<string, RefEntry>; footnotes: string[]; version: number };
type Store = { state: NotesState; listeners: Set<() => void>; timer?: ReturnType<typeof setTimeout> };
const stores = new WeakMap<object, Store>();

function storeOf(editor: object): Store {
  let s = stores.get(editor);
  if (!s) {
    s = { state: { refs: new Map(), footnotes: [], version: 0 }, listeners: new Set() };
    stores.set(editor, s);
  }
  return s;
}

/** 文書の中の脚注の文（本文の順）と、参考文献のブロックの文献を集める */
export function collectNotes(blocks: any[]) {
  const footnotes: string[] = [];
  const sources: string[] = [];
  const inline = (content: any) => {
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (c?.type === 'footnote') footnotes.push(String(c.props?.text ?? ''));
      else if (c?.type === 'link') inline(c.content);
    }
  };
  const walk = (list: any[]) => {
    for (const b of list ?? []) {
      if (b?.type === 'references') sources.push(String(b.props?.source ?? ''));
      if (Array.isArray(b?.content)) inline(b.content);
      else if (b?.content?.type === 'tableContent') for (const r of b.content.rows ?? []) for (const cell of r.cells ?? []) inline(Array.isArray(cell) ? cell : cell?.content);
      if (b?.children?.length) walk(b.children);
    }
  };
  walk(blocks);
  const refs = new Map<string, RefEntry>();
  for (const src of sources) for (const e of parseReferences(src)) refs.set(e.key, e);
  return { footnotes, refs };
}

/** 文書が変わったら呼ぶ（少し待ってから、脚注の番号と引用の表示を更新する） */
export function updateNotes(editor: object, blocks: any[], immediate = false) {
  const s = storeOf(editor);
  clearTimeout(s.timer);
  const run = () => {
    const { footnotes, refs } = collectNotes(blocks);
    s.state = { footnotes, refs, version: s.state.version + 1 };
    s.listeners.forEach((l) => l());
  };
  if (immediate) run();
  else s.timer = setTimeout(run, 120);
}

export function useNotes(editor: object) {
  const s = storeOf(editor);
  return useSyncExternalStore(
    (l) => {
      s.listeners.add(l);
      return () => s.listeners.delete(l);
    },
    () => s.state,
  );
}

// ---------- 画面の部品 ----------

/** 脚注の文の入力欄 */
function NoteInput({ value, placeholder, onChange, onDone, rows = 3 }: { value: string; placeholder: string; onChange: (v: string) => void; onDone: () => void; rows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, []);
  return (
    <textarea
      ref={ref}
      className="note-input"
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
          e.preventDefault();
          onDone();
        }
      }}
    />
  );
}

/** 文中の脚注の番号。押すと脚注の文を表示・編集する */
function FootnoteRef({ text, editor, onChange }: { text: string; editor: any; onChange: (v: string) => void }) {
  const ref = useRef<HTMLElement>(null);
  const notes = useNotes(editor);
  const editable = editor.isEditable;
  const [n, setN] = useState(0);
  const [open, setOpen] = useState(editable && !text);
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  // 番号は、本文の中の脚注の並び順（画面の上での順）
  useLayoutEffect(() => {
    const el = ref.current;
    const root = el?.closest('.bn-editor');
    if (!el || !root) return;
    setN([...root.querySelectorAll('.footnote-ref')].indexOf(el) + 1);
  }, [notes]);
  const done = () => {
    setOpen(false);
    if (draft !== text) onChange(draft.replace(/\n+/g, ' ').trim());
  };
  return (
    <>
      <sup
        ref={ref}
        className={`footnote-ref ${text ? '' : 'is-empty'}`}
        data-footnote={n || undefined}
        id={n ? `fnref-${n}` : undefined}
        title={text || '脚注'}
        onClick={() => setOpen(true)}
      >
        {n || '＊'}
      </sup>
      {open && (
        <Popover anchor={ref.current} onClose={done} width={340}>
          <div className="note-popover">
            <div className="note-popover-label">脚注 {n || ''}</div>
            {editable ? (
              <>
                <NoteInput value={draft} placeholder="脚注の文（出典や補足）" onChange={setDraft} onDone={done} />
                <div className="tex-hint">Enter で確定・脚注の文はページの最後にまとめて表示されます</div>
              </>
            ) : (
              <p className="note-popover-text">{text || '（空の脚注）'}</p>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}

/** 文中の文献の引用。参考文献のブロックにある文献を「著者 (年)」で表示する */
function CiteRef({ citeKey, locator, editor, onChange }: { citeKey: string; locator: string; editor: any; onChange: (key: string, locator: string) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const { refs } = useNotes(editor);
  const editable = editor.isEditable;
  const [open, setOpen] = useState(editable && !citeKey);
  const [draft, setDraft] = useState({ key: citeKey, locator });
  useEffect(() => setDraft({ key: citeKey, locator }), [citeKey, locator]);
  const entry = refs.get(citeKey);
  const done = (next = draft) => {
    setOpen(false);
    if (next.key !== citeKey || next.locator !== locator) onChange(next.key.trim(), next.locator.trim());
  };
  const candidates = [...refs.values()].filter((e) => !draft.key || e.key.toLowerCase().includes(draft.key.toLowerCase()) || citeLabel(e).includes(draft.key));
  return (
    <>
      <span
        ref={ref}
        className={`cite-ref ${entry ? '' : 'is-missing'}`}
        title={entry ? formatReference(entry).map((p) => p.text).join('') : citeKey ? `参考文献に「${citeKey}」が見つかりません` : '文献の引用'}
        onClick={() => setOpen(true)}
      >
        {entry ? citeLabel(entry, locator) : citeKey ? `[@${citeKey}${locator ? `, ${locator}` : ''}]` : '引用'}
      </span>
      {open && (
        <Popover anchor={ref.current} onClose={() => done()} width={340}>
          <div className="note-popover">
            <div className="note-popover-label">文献の引用</div>
            {editable ? (
              <>
                <div className="cite-fields">
                  <input
                    className="note-input"
                    autoFocus
                    value={draft.key}
                    placeholder="文献のキー（例：smith2020）"
                    onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Escape' || (e.key === 'Enter' && !e.nativeEvent.isComposing)) {
                        e.preventDefault();
                        done();
                      }
                    }}
                  />
                  <input
                    className="note-input"
                    value={draft.locator}
                    placeholder="ページなど（例：p. 12）"
                    onChange={(e) => setDraft({ ...draft, locator: e.target.value })}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Escape' || (e.key === 'Enter' && !e.nativeEvent.isComposing)) {
                        e.preventDefault();
                        done();
                      }
                    }}
                  />
                </div>
                {candidates.length > 0 ? (
                  <div className="cite-candidates">
                    {candidates.slice(0, 8).map((e) => (
                      <button key={e.key} className="menu-item" onMouseDown={(ev) => ev.preventDefault()} onClick={() => done({ ...draft, key: e.key })}>
                        <span className="cite-candidate-label">{citeLabel(e)}</span>
                        <code className="cite-candidate-key">{e.key}</code>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="muted small note-popover-text">このページに「参考文献」ブロックを追加すると、文献を選べるようになります。</p>
                )}
              </>
            ) : (
              <p className="note-popover-text">{entry ? <RefText entry={entry} /> : `参考文献に「${citeKey}」が見つかりません`}</p>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}

function RefText({ entry }: { entry: RefEntry }) {
  return (
    <>
      {formatReference(entry).map((p, i) => (p.italic ? <i key={i}>{p.text}</i> : <span key={i}>{p.text}</span>))}
    </>
  );
}

const REF_PLACEHOLDER = `BibTeX を貼るか、1 行に 1 件ずつ書きます。例：
@book{yamada2020,
  author = {山田 太郎},
  title = {国際関係論入門},
  publisher = {〇〇出版},
  year = {2020}
}
Smith, J. (2019). Global Politics. Oxford University Press.`;

/** 参考文献のブロック */
function References({ source, editable, onChange }: { source: string; editable: boolean; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(editable && !source);
  const [draft, setDraft] = useState(source);
  useEffect(() => setDraft(source), [source]);
  const list = sortReferences(parseReferences(draft));
  const done = () => {
    setEditing(false);
    if (draft !== source) onChange(draft);
  };
  return (
    <div className={`references-block ${editable ? 'is-editable' : ''}`} contentEditable={false}>
      <div className="references-head">
        <span className="references-title">参考文献</span>
        {editable && !editing && (
          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
            編集
          </button>
        )}
      </div>
      {list.length > 0 ? (
        <div className="references-list" role="list">
          {list.map((e) => (
            <div key={e.key} className="references-item" role="listitem">
              <RefText entry={e} />
              {editable && <code className="references-key" title="本文で [@キー] と書くと引用できます">@{e.key}</code>}
            </div>
          ))}
        </div>
      ) : (
        !editing && <p className="references-empty">{editable ? '「編集」から文献を追加します' : '文献はまだありません'}</p>
      )}
      {editing && (
        <div className="references-editor" onMouseDown={(e) => e.stopPropagation()}>
          <textarea
            className="tex-input"
            value={draft}
            rows={8}
            autoFocus
            spellCheck={false}
            placeholder={REF_PLACEHOLDER}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
                e.preventDefault();
                done();
              }
            }}
          />
          <div className="references-editor-foot">
            <span className="tex-hint">BibTeX または 1 行に 1 件。本文で [@キー] と書くと「著者 (年)」で引用できます</span>
            <button className="btn btn-primary btn-sm" onClick={done}>
              完了
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** ページの最後に出す脚注の一覧 */
export function FootnoteList({ editor }: { editor: object }) {
  const { footnotes } = useNotes(editor);
  if (!footnotes.length) return null;
  const jump = (i: number) => {
    const el = (editor as any).domElement?.querySelectorAll?.('.footnote-ref')?.[i] as HTMLElement | undefined;
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('is-flash');
    setTimeout(() => el.classList.remove('is-flash'), 1200);
  };
  return (
    <section className="footnote-list" aria-label="脚注">
      <div className="footnote-list-title">脚注</div>
      <ol>
        {footnotes.map((t, i) => (
          <li key={i} id={`fn-${i + 1}`}>
            <button className="footnote-list-num" onClick={() => jump(i)} title="本文の位置へ">
              {i + 1}
            </button>
            <span className={t ? '' : 'muted'}>{t || '（空の脚注）'}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------- Markdown・PDF との変換の目印 ----------

const hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => new TextDecoder().decode(new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16))));
export const FOOTNOTE_MARK = (text: string) => `⟦F${hex(text)}⟧`;
export const CITE_MARK = (key: string, locator: string) => `⟦C${hex(`${key}\u0001${locator}`)}⟧`;
export const REFS_MARK = (source: string) => `⟦R${hex(source)}⟧`;

export const FootnoteSpec = createReactInlineContentSpec(
  { type: 'footnote', propSchema: { text: { default: '' } }, content: 'none' },
  {
    render: (props) => (
      <FootnoteRef text={props.inlineContent.props.text} editor={props.editor} onChange={(text) => props.updateInlineContent({ type: 'footnote', props: { text } })} />
    ),
    toExternalHTML: (props) => <span>{FOOTNOTE_MARK(props.inlineContent.props.text)}</span>,
  },
);

export const CiteSpec = createReactInlineContentSpec(
  { type: 'cite', propSchema: { key: { default: '' }, locator: { default: '' } }, content: 'none' },
  {
    render: (props) => (
      <CiteRef
        citeKey={props.inlineContent.props.key}
        locator={props.inlineContent.props.locator}
        editor={props.editor}
        onChange={(key, locator) => props.updateInlineContent({ type: 'cite', props: { key, locator } })}
      />
    ),
    toExternalHTML: (props) => <span>{CITE_MARK(props.inlineContent.props.key, props.inlineContent.props.locator)}</span>,
  },
);

export const ReferencesSpec = createReactBlockSpec(
  { type: 'references', propSchema: { source: { default: '' } }, content: 'none' },
  {
    render: (props) => (
      <References source={props.block.props.source} editable={props.editor.isEditable} onChange={(source) => props.editor.updateBlock(props.block, { props: { source } })} />
    ),
    toExternalHTML: (props) => <p>{REFS_MARK(props.block.props.source)}</p>,
  },
);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** HTML に書き出した目印から文献を集める */
function refsFromMarks(text: string) {
  const refs = new Map<string, RefEntry>();
  for (const m of text.matchAll(/⟦R([0-9a-f]*)⟧/g)) for (const e of parseReferences(unhex(m[1]!))) refs.set(e.key, e);
  return refs;
}

function citeText(refs: Map<string, RefEntry>, h: string) {
  const [key = '', locator = ''] = unhex(h).split('\u0001');
  const e = refs.get(key);
  return e ? citeLabel(e, locator) : `[@${key}${locator ? `, ${locator}` : ''}]`;
}

/**
 * PDF（レポート）用：脚注は本文に上付きの番号を付け、文は「注」としてまとめる（参考文献の前、なければ最後）。
 * 引用は「著者 (年)」に、参考文献のブロックは整えた一覧にする
 */
export function renderNotesInHtml(html: string) {
  const refs = refsFromMarks(html);
  const notes: string[] = [];
  let out = html
    .replace(/⟦F([0-9a-f]*)⟧/g, (_m, h: string) => {
      notes.push(unhex(h));
      const n = notes.length;
      return `<sup class="report-fnref" id="fnref-${n}">${n}</sup>`;
    })
    .replace(/⟦C([0-9a-f]*)⟧/g, (_m, h: string) => esc(citeText(refs, h)));
  const refsHtml = (source: string) => {
    const list = sortReferences(parseReferences(source));
    if (!list.length) return '';
    const items = list.map((e) => `<li>${formatReference(e).map((p) => (p.italic ? `<i>${esc(p.text)}</i>` : esc(p.text))).join('')}</li>`).join('');
    return `<section class="report-references"><h2>参考文献</h2><ul>${items}</ul></section>`;
  };
  const notesHtml = notes.length ? `<section class="report-notes"><h2>注</h2><ol>${notes.map((t, i) => `<li id="fn-${i + 1}">${esc(t)}</li>`).join('')}</ol></section>` : '';
  let placed = !notesHtml;
  out = out.replace(/<p[^>]*>\s*⟦R([0-9a-f]*)⟧\s*<\/p>|⟦R([0-9a-f]*)⟧/g, (_m, a?: string, b?: string) => {
    const html = refsHtml(unhex(a ?? b ?? ''));
    // 注は最初の参考文献の前に置く
    if (!placed) {
      placed = true;
      return notesHtml + html;
    }
    return html;
  });
  return placed ? out : out + notesHtml;
}

/** Markdown に書き出すとき：脚注は [^1] と最後の「[^1]: 文」、引用は [@key]、参考文献は元の文を残した一覧にする */
export function notesToMarkdown(md: string) {
  const refs = refsFromMarks(md);
  const notes: string[] = [];
  let out = md
    .replace(/⟦F([0-9a-f]*)⟧/g, (_m, h: string) => {
      notes.push(unhex(h));
      return `[^${notes.length}]`;
    })
    .replace(/⟦C([0-9a-f]*)⟧/g, (_m, h: string) => {
      const [key = '', locator = ''] = unhex(h).split('\u0001');
      return `[@${key}${locator ? `, ${locator}` : ''}]`;
    })
    .replace(/^[ \t]*⟦R([0-9a-f]*)⟧[ \t]*$/gm, (_m, h: string) => {
      const source = unhex(h);
      const list = sortReferences(parseReferences(source))
        .map((e) => `- ${formatReference(e).map((p) => (p.italic ? `*${p.text}*` : p.text)).join('')}`)
        .join('\n');
      // 元の文（BibTeX など）は HTML のコメントに残して、読み込み直したときに元に戻す
      return `<!-- references\n${source.replace(/-->/g, '--​>')}\n-->\n\n**参考文献**\n\n${list}\n\n<!-- /references -->`;
    });
  if (notes.length) out = `${out.replace(/\s+$/, '')}\n\n${notes.map((t, i) => `[^${i + 1}]: ${t}`).join('\n')}\n`;
  return out;
}

/**
 * Markdown を読み込む前に：脚注・引用・参考文献を目印に置き換える（コードの中は除く。protectMath の中で行ごとに使う）。
 * defs は「[^id]: 文」の定義（先に集めて、行は取り除いておく）
 */
export function protectNotesLine(line: string, defs: Map<string, string>) {
  return line
    .replace(/\[\^([^\]\s]+)\]/g, (m, id: string) => (defs.has(id) ? FOOTNOTE_MARK(defs.get(id)!) : m))
    .replace(/\^\[([^\]]+)\]/g, (_m, text: string) => FOOTNOTE_MARK(text.trim()))
    .replace(/\[@([^\]\s,;]+)(?:,\s*([^\]]+))?\]/g, (_m, key: string, locator?: string) => CITE_MARK(key, (locator ?? '').trim()));
}

/** Markdown の脚注の定義（[^id]: 文）と参考文献の範囲を取り出す。残りの行を返す */
export function extractNoteDefs(lines: string[]) {
  const defs = new Map<string, string>();
  const out: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      if (f && line.trim().startsWith(fence)) fence = null;
      out.push(line);
      continue;
    }
    if (f) {
      fence = f[1]!;
      out.push(line);
      continue;
    }
    // 参考文献（書き出したもの）
    if (/^\s*<!--\s*references\s*$/.test(line)) {
      const src: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*-->\s*$/.test(lines[j]!)) src.push(lines[j++]!);
      let k = j + 1;
      while (k < lines.length && !/^\s*<!--\s*\/references\s*-->\s*$/.test(lines[k]!)) k++;
      if (j < lines.length && k < lines.length) {
        out.push('', REFS_MARK(src.join('\n').replace(/--​>/g, '-->')), '');
        i = k;
        continue;
      }
    }
    const d = /^\[\^([^\]\s]+)\]:\s?(.*)$/.exec(line);
    if (d) {
      const body = [d[2]!];
      // 字下げした続きの行も同じ脚注
      while (i + 1 < lines.length && /^( {2,}|\t)\S/.test(lines[i + 1]!)) body.push(lines[++i]!.trim());
      defs.set(d[1]!, body.join(' ').trim());
      continue;
    }
    out.push(line);
  }
  return { defs, lines: out };
}

/** 目印を脚注・引用に戻す（文中の内容） */
export function restoreNoteMark(kind: string, h: string): any {
  if (kind === 'F') return { type: 'footnote', props: { text: unhex(h) } };
  const [key = '', locator = ''] = unhex(h).split('\u0001');
  return { type: 'cite', props: { key, locator } };
}

/** 目印を参考文献のブロックに戻す */
export function restoreRefsBlock(text: string): any | null {
  const m = /^⟦R([0-9a-f]*)⟧$/.exec(text);
  return m ? { type: 'references', props: { source: unhex(m[1]!) } } : null;
}

/** 打ち終えた「[^脚注の文]」「[@キー]」を脚注・引用にする（] を打ったとき） */
export function convertTypedNotes(editor: any) {
  const view = editor.prosemirrorView;
  if (!view) return;
  const { state } = view;
  const { $from, empty } = state.selection;
  if (!empty || !state.schema.nodes.footnote) return;
  if ($from.parent.type.spec.code || state.doc.rangeHasMark($from.start(), $from.pos, state.schema.marks.code)) return;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const fn = /\[\^([^\]￼]+)\]$/.exec(before);
  if (fn) {
    const from = $from.pos - fn[0].length;
    view.dispatch(state.tr.replaceWith(from, $from.pos, state.schema.nodes.footnote.create({ text: fn[1]!.trim() })));
    return;
  }
  const ct = /\[@([^\]\s,;￼]+)(?:,\s*([^\]￼]+))?\]$/.exec(before);
  if (ct && state.schema.nodes.cite) {
    const from = $from.pos - ct[0].length;
    view.dispatch(state.tr.replaceWith(from, $from.pos, state.schema.nodes.cite.create({ key: ct[1]!, locator: (ct[2] ?? '').trim() })));
  }
}
