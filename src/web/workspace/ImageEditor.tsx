/**
 * 画像の簡単な編集（回転・反転・切り抜き）。保存は呼び出し元が行う（新しいファイルとして保存・GitHub にコミット）。
 */
import { useEffect, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { flushWhenIdle, selfSaved, type Flush } from './selfSaved';
import { Button, Icon, Spinner } from '../ui';

type Rect = { x: number; y: number; w: number; h: number };

/** 保存するときの形式（元の形式に合わせる。BMP などは PNG にする） */
function outputType(name: string) {
  if (/\.jpe?g$/i.test(name)) return { type: 'image/jpeg', ext: 'jpg' };
  if (/\.webp$/i.test(name)) return { type: 'image/webp', ext: 'webp' };
  return { type: 'image/png', ext: 'png' };
}

/** 編集できる画像か（アニメーションやベクター画像は、描き直すと内容が変わるので除く） */
export const EDITABLE_IMAGE = /\.(png|jpe?g|webp|bmp)$/i;

export default function ImageEditor({
  url,
  name,
  onSave,
  saveLabel = '今すぐ保存',
  onDirty,
  flushRef,
}: {
  /** 未保存の変更を今すぐ保存する関数を受け取る（閉じるときに使う） */
  flushRef?: MutableRefObject<Flush | null>;
  url: string;
  name: string;
  /** 保存する画像と、ファイル名（BMP などは拡張子が変わる） */
  onSave: (blob: Blob, name: string) => Promise<void>;
  saveLabel?: string;
  onDirty?: (dirty: boolean) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // この画面で読み込み済みか（保存で URL が変わっても読み直さないのは、読み込み済みのときだけ）
  const hasContent = useRef(false);
  const history = useRef<HTMLCanvasElement[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cropping, setCropping] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // 編集した回数（自動保存のきっかけ）
  const [rev, setRev] = useState(0);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const busy = useRef(false);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => onDirty?.(dirty), [dirty, onDirty]);

  useEffect(() => {
    // 自分で保存した直後は読み直さない（続けて編集できるように）
    if (hasContent.current && selfSaved.has(url)) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`画像を開けませんでした（${res.status}）`);
        const bitmap = await createImageBitmap(await res.blob());
        if (!alive) return;
        const c = canvas.current!;
        c.width = bitmap.width;
        c.height = bitmap.height;
        c.getContext('2d')!.drawImage(bitmap, 0, 0);
        setSize({ w: c.width, h: c.height });
        history.current = [];
        setDirty(false);
        setReady(true);
        hasContent.current = true;
      } catch (e) {
        if (alive) setError((e as Error).message || '画像を開けませんでした');
      }
    })();
    return () => {
      alive = false;
    };
  }, [url]);

  /** 今の画像を控えてから、描き直す */
  const apply = (w: number, h: number, draw: (ctx: CanvasRenderingContext2D, src: HTMLCanvasElement) => void) => {
    const c = canvas.current!;
    const copy = document.createElement('canvas');
    copy.width = c.width;
    copy.height = c.height;
    copy.getContext('2d')!.drawImage(c, 0, 0);
    history.current = [...history.current.slice(-9), copy];
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.save();
    draw(ctx, copy);
    ctx.restore();
    setSize({ w, h });
    setRect(null);
    setDirty(true);
    setRev((r) => r + 1);
  };

  const rotate = (dir: 1 | -1) =>
    apply(canvas.current!.height, canvas.current!.width, (ctx, src) => {
      ctx.translate(dir === 1 ? src.height : 0, dir === 1 ? 0 : src.width);
      ctx.rotate((dir * Math.PI) / 2);
      ctx.drawImage(src, 0, 0);
    });
  const flip = () =>
    apply(canvas.current!.width, canvas.current!.height, (ctx, src) => {
      ctx.translate(src.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(src, 0, 0);
    });
  const crop = () => {
    if (!rect || rect.w < 2 || rect.h < 2) return;
    const r = rect;
    apply(Math.round(r.w), Math.round(r.h), (ctx, src) => ctx.drawImage(src, -Math.round(r.x), -Math.round(r.y)));
    setCropping(false);
  };
  const undo = () => {
    const prev = history.current.pop();
    if (!prev) return;
    const c = canvas.current!;
    c.width = prev.width;
    c.height = prev.height;
    c.getContext('2d')!.drawImage(prev, 0, 0);
    setSize({ w: c.width, h: c.height });
    setRect(null);
    setDirty(true);
    setRev((r) => r + 1);
  };

  /** 画面上の位置を、画像の中の位置にする */
  const point = (e: ReactPointerEvent) => {
    const b = canvas.current!.getBoundingClientRect();
    const sx = canvas.current!.width / b.width;
    const sy = canvas.current!.height / b.height;
    return {
      x: Math.max(0, Math.min(canvas.current!.width, (e.clientX - b.left) * sx)),
      y: Math.max(0, Math.min(canvas.current!.height, (e.clientY - b.top) * sy)),
    };
  };

  const save = async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    if (busy.current) return false;
    busy.current = true;
    setSaving(true);
    const at = rev;
    try {
      const out = outputType(name);
      const blob = await new Promise<Blob | null>((r) => canvas.current!.toBlob(r, out.type, 0.92));
      if (!blob) throw new Error('画像を作れませんでした');
      const newName = /\.(png|jpe?g|webp)$/i.test(name) ? name : name.replace(/\.[^.]+$/, '') + `.${out.ext}`;
      await onSave(blob, newName);
      // 保存中にさらに編集していたら、そのぶんは次に保存する
      if (revRef.current === at) {
        setDirty(false);
        dirtyRef.current = false;
      }
      setError(null);
      return !dirtyRef.current;
    } catch (e) {
      setError((e as Error).message || '保存できませんでした');
      return false;
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  const revRef = useRef(rev);
  revRef.current = rev;
  const saveRef = useRef(save);
  saveRef.current = save;
  if (flushRef) flushRef.current = () => flushWhenIdle(() => busy.current, () => saveRef.current());
  // 編集してしばらくしたら保存する
  useEffect(() => {
    if (!dirty || cropping) return;
    const t = setTimeout(() => void saveRef.current(), 2500);
    return () => clearTimeout(t);
  }, [dirty, rev, cropping]);
  useEffect(() => () => void (dirtyRef.current && saveRef.current()), []);

  const b = canvas.current?.getBoundingClientRect();
  const scale = b && size.w ? b.width / size.w : 1;
  return (
    <div className="image-editor">
      <div className="image-editor-bar">
        <Button size="sm" variant="ghost" onClick={() => rotate(-1)} disabled={!ready || saving} title="左に回転">
          <Icon name="rotateLeft" size={16} /> 左に回転
        </Button>
        <Button size="sm" variant="ghost" onClick={() => rotate(1)} disabled={!ready || saving} title="右に回転">
          <Icon name="rotateRight" size={16} /> 右に回転
        </Button>
        <Button size="sm" variant="ghost" onClick={flip} disabled={!ready || saving}>
          <Icon name="flip" size={16} /> 左右反転
        </Button>
        <Button size="sm" variant={cropping ? 'primary' : 'ghost'} onClick={() => (setCropping((v) => !v), setRect(null))} disabled={!ready || saving}>
          <Icon name="crop" size={16} /> 切り抜き
        </Button>
        {cropping && (
          <Button size="sm" variant="primary" onClick={crop} disabled={!rect || rect.w < 2 || rect.h < 2}>
            この範囲にする
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={undo} disabled={!history.current.length || saving}>
          <Icon name="undo" size={16} /> 元に戻す
        </Button>
        <span className="image-editor-size muted small">
          {saving ? '保存中…' : dirty ? '未保存の変更があります' : '自動で保存します'}・{size.w} × {size.h}
        </span>
        <Button size="sm" variant="primary" onClick={() => void save()} disabled={!dirty || saving}>
          {saveLabel}
        </Button>
      </div>
      {cropping && <p className="image-editor-hint muted small">画像の上をドラッグして、残す範囲を選んでください</p>}
      {error && <p className="muted office-error">{error}</p>}
      <div className="image-editor-stage">
        {!ready && !error && <Spinner />}
        <div className="image-editor-canvas-wrap">
          <canvas
            ref={canvas}
            className={`image-editor-canvas ${cropping ? 'is-cropping' : ''}`}
            style={{ display: ready ? undefined : 'none' }}
            onPointerDown={(e) => {
              if (!cropping) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = point(e);
              setRect({ ...drag.current, w: 0, h: 0 });
            }}
            onPointerMove={(e) => {
              if (!cropping || !drag.current) return;
              const p = point(e);
              const s = drag.current;
              setRect({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
            }}
            onPointerUp={() => (drag.current = null)}
          />
          {cropping && rect && rect.w > 0 && (
            <div
              className="image-editor-crop"
              style={{ left: rect.x * scale, top: rect.y * scale, width: rect.w * scale, height: rect.h * scale }}
              aria-hidden="true"
            />
          )}
        </div>
      </div>
    </div>
  );
}
