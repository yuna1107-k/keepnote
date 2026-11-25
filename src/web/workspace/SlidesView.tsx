/**
 * PowerPoint（.pptx）をアプリ内で表示する。保存先が渡されたときは、文字をクリックしてそのまま書き換えられる
 * （編集が止まってしばらくしたら・閉じるときに保存。図形・画像・デザインはそのまま残る）。
 */
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Button, Spinner } from '../ui';
import { patchPptx, readPptx, type Deck, type SlideEdits } from './pptx';
import { flushWhenIdle, selfSaved, type Flush } from './selfSaved';

const PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const AUTOSAVE_MS = 3000;
/** 1 ポイント = 12700 EMU */
const EMU_PER_PT = 12700;

export default function SlidesView({
  url,
  onSave,
  flushRef,
}: {
  url: string;
  onSave?: (blob: Blob) => Promise<void>;
  flushRef?: MutableRefObject<Flush | null>;
}) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ slide: number; key: number; value: string } | null>(null);
  const [status, setStatus] = useState<'saved' | 'pending' | 'saving' | 'error'>('saved');
  const base = useRef<ArrayBuffer | null>(null);
  // この画面で読み込み済みか（保存で URL が変わっても読み直さないのは、読み込み済みのときだけ）
  const hasContent = useRef(false);
  const edits = useRef<SlideEdits>(new Map());
  const busy = useRef(false);
  const editable = !!onSave;

  useEffect(() => {
    if (hasContent.current && selfSaved.has(url)) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`ファイルを開けませんでした（${res.status}）`);
        const buf = await res.arrayBuffer();
        const d = readPptx(buf);
        if (!alive) return;
        base.current = buf;
        edits.current = new Map();
        setDeck(d);
        hasContent.current = true;
        setStatus('saved');
      } catch (e) {
        if (alive) setError((e as Error).message || 'ファイルを読み取れませんでした');
      }
    })();
    return () => {
      alive = false;
    };
  }, [url]);

  // 画像は表示用の URL にする（閉じたら片付ける）
  const images = useMemo(() => {
    const map = new Map<string, string>();
    deck?.slides.forEach((s, i) => s.shapes.forEach((sh) => sh.image && map.set(`${i}:${sh.key}`, URL.createObjectURL(new Blob([sh.image.bytes as BlobPart], { type: sh.image.type })))));
    return map;
  }, [deck]);
  useEffect(() => () => images.forEach((u) => URL.revokeObjectURL(u)), [images]);

  const save = async (): Promise<boolean> => {
    if (!onSave || !base.current || !edits.current.size) return true;
    if (busy.current) return false;
    busy.current = true;
    setStatus('saving');
    const sent = new Map(edits.current);
    try {
      const bytes = patchPptx(base.current, sent);
      await onSave(new Blob([bytes as BlobPart], { type: PPTX_TYPE }));
      base.current = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      for (const [k, v] of sent) if (edits.current.get(k) === v) edits.current.delete(k);
      const done = !edits.current.size;
      setStatus(done ? 'saved' : 'pending');
      return done;
    } catch {
      setStatus('error');
      return false;
    } finally {
      busy.current = false;
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  if (flushRef) flushRef.current = () => flushWhenIdle(() => busy.current, () => saveRef.current());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedule = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveRef.current(), AUTOSAVE_MS);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (edits.current.size) void saveRef.current();
    },
    [],
  );

  const commit = () => {
    if (!editing || !deck) return;
    const { slide, key, value } = editing;
    setEditing(null);
    const shape = deck.slides[slide].shapes.find((s) => s.key === key);
    if (!shape) return;
    const lines = value.split('\n');
    if (lines.join('\n') === shape.paragraphs.map((p) => p.text).join('\n')) return;
    edits.current.set(`${slide}:${key}`, lines);
    const template = shape.paragraphs[0] ?? { text: '', size: null, bold: false, align: null, bullet: false };
    const paragraphs = lines.map((text, i) => ({ ...(shape.paragraphs[i] ?? shape.paragraphs[shape.paragraphs.length - 1] ?? template), text }));
    setDeck({
      ...deck,
      slides: deck.slides.map((s, i) => (i === slide ? { shapes: s.shapes.map((sh) => (sh.key === key ? { ...sh, paragraphs } : sh)) } : s)),
    });
    setStatus('pending');
    schedule();
  };

  if (error) return <p className="muted office-error">{error}</p>;
  if (!deck) return <Spinner />;
  const label = { saved: '保存済み', pending: '未保存の変更があります', saving: '保存中…', error: '保存できませんでした' }[status];
  return (
    <div className="slides-view">
      {editable && (
        <div className="sheet-toolbar">
          <span className={`sheet-status ${status !== 'saved' ? 'is-dirty' : ''}`} role="status">
            {label}・文字をクリックすると書き換えられます（図形・画像・デザインはそのまま残ります）
          </span>
          <Button size="sm" variant="primary" onClick={() => void save()} disabled={status === 'saved' || status === 'saving'}>
            今すぐ保存
          </Button>
        </div>
      )}
      <div className="slides-scroll">
        {deck.slides.map((slide, si) => (
          <figure key={si} className="slide" style={{ aspectRatio: `${deck.width} / ${deck.height}` }} aria-label={`スライド ${si + 1}`}>
            {slide.shapes.map((sh) => {
              const box = {
                left: `${(sh.x / deck.width) * 100}%`,
                top: `${(sh.y / deck.height) * 100}%`,
                width: `${(sh.w / deck.width) * 100}%`,
                height: `${(sh.h / deck.height) * 100}%`,
              };
              if (sh.kind === 'pic') return <img key={sh.key} className="slide-pic" style={box} src={images.get(`${si}:${sh.key}`)} alt="" />;
              const isEditing = editing?.slide === si && editing.key === sh.key;
              // 文字の大きさはスライドの幅に合わせる（cqw はスライドの幅の 1%）
              const size = (pt: number | null) => `${(((pt ?? (sh.title ? 36 : 18)) * EMU_PER_PT) / deck.width) * 100}cqw`;
              return (
                <div
                  key={sh.key}
                  className={`slide-text ${sh.title ? 'is-title' : ''} ${editable ? 'is-editable' : ''}`}
                  style={box}
                  onClick={() => editable && !isEditing && setEditing({ slide: si, key: sh.key, value: sh.paragraphs.map((p) => p.text).join('\n') })}
                >
                  {isEditing ? (
                    <textarea
                      className="slide-input"
                      autoFocus
                      value={editing.value}
                      style={{ fontSize: size(sh.paragraphs[0]?.size ?? null) }}
                      onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                      onBlur={commit}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          e.stopPropagation();
                          setEditing(null);
                        }
                      }}
                    />
                  ) : (
                    sh.paragraphs.map((p, pi) => (
                      <p
                        key={pi}
                        className={p.bullet ? 'is-bullet' : undefined}
                        style={{
                          fontSize: size(p.size),
                          fontWeight: p.bold || sh.title ? 700 : undefined,
                          textAlign: p.align === 'ctr' ? 'center' : p.align === 'r' ? 'right' : p.align === 'just' ? 'justify' : undefined,
                        }}
                      >
                        {p.text || ' '}
                      </p>
                    ))
                  )}
                </div>
              );
            })}
            <figcaption className="slide-no">{si + 1}</figcaption>
          </figure>
        ))}
        {!deck.slides.length && <p className="muted office-error">スライドがありません</p>}
      </div>
    </div>
  );
}
