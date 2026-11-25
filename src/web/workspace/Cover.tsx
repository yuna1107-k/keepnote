import { useRef, useState } from 'react';
import { uploadFile } from '../api';
import { COVER_COLORS, COVER_GRADIENTS, COVER_PASTELS, COVER_PATTERNS, COVER_PHOTOS, coverStyle, isImageCover, PATTERN_GROUPS, PHOTO_GROUPS, photoUrl } from '../covers';
import { Button, Icon, Popover, useUi } from '../ui';

/** カバー選択パネル（ギャラリー / アップロード / 画像リンク） */
export function CoverPicker({
  anchor,
  onPick,
  onRemove,
  onClose,
}: {
  anchor: HTMLElement;
  onPick: (cover: string) => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const { toast } = useUi();
  const [tab, setTab] = useState<'gallery' | 'upload' | 'link'>('gallery');
  const [link, setLink] = useState('');
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const upload = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('画像ファイルを選択してください', 'error');
    setUploading(true);
    try {
      onPick(await uploadFile(file));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setUploading(false);
    }
  };

  return (
    <Popover anchor={anchor} onClose={onClose} width={460} className="cover-picker">
      <div className="share-tabs">
        <button className={tab === 'gallery' ? 'active' : ''} onClick={() => setTab('gallery')}>
          ギャラリー
        </button>
        <button className={tab === 'upload' ? 'active' : ''} onClick={() => setTab('upload')}>
          アップロード
        </button>
        <button className={tab === 'link' ? 'active' : ''} onClick={() => setTab('link')}>
          リンク
        </button>
        {onRemove && (
          <button className="share-tabs-right" onClick={onRemove}>
            削除
          </button>
        )}
      </div>
      <div className="share-body">
        {tab === 'gallery' && (
          <div className="cover-gallery">
            {PHOTO_GROUPS.map((group) => (
              <div key={group.id}>
                <div className="cover-group-label">{group.label}</div>
                <div className="cover-grid">
                  {COVER_PHOTOS.filter((p) => p.group === group.id).map((p) => (
                    <button key={p.id} className="cover-swatch cover-photo" onClick={() => onPick(`photo:${p.id}`)} aria-label={p.label} title={p.label}>
                      <img src={photoUrl(p.id, true)} alt="" loading="lazy" decoding="async" />
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="cover-group-label">グラデーション</div>
            <div className="cover-grid">
              {COVER_GRADIENTS.map((g, i) => (
                <button key={i} className="cover-swatch" style={{ background: g }} onClick={() => onPick(`gradient:${i}`)} aria-label={`グラデーション ${i + 1}`} />
              ))}
            </div>
            {PATTERN_GROUPS.map((group) => (
              <div key={group.id}>
                <div className="cover-group-label">{group.label}</div>
                <div className="cover-grid">
                  {COVER_PATTERNS.filter((p) => p.group === group.id).map((p) => (
                    <button
                      key={p.id}
                      className="cover-swatch"
                      style={coverStyle(`pattern:${p.id}`, 50)}
                      onClick={() => onPick(`pattern:${p.id}`)}
                      aria-label={p.label}
                      title={p.label}
                    />
                  ))}
                </div>
              </div>
            ))}
            <div className="cover-group-label">カラー</div>
            <div className="cover-grid">
              {COVER_COLORS.map((c) => (
                <button key={c} className="cover-swatch" style={{ background: c }} onClick={() => onPick(`color:${c}`)} aria-label={c} />
              ))}
            </div>
            <div className="cover-group-label">淡い色</div>
            <div className="cover-grid">
              {COVER_PASTELS.map((c) => (
                <button key={c} className="cover-swatch is-light" style={{ background: c }} onClick={() => onPick(`color:${c}`)} aria-label={c} />
              ))}
            </div>
          </div>
        )}
        {tab === 'upload' && (
          <div className="cover-upload">
            <Button variant="primary" loading={uploading} onClick={() => input.current?.click()}>
              <Icon name="upload" size={14} /> 画像をアップロード
            </Button>
            <p className="muted small">横幅 1500px 以上の画像がおすすめです。</p>
            <input ref={input} type="file" accept="image/*" hidden onChange={(e) => upload(e.target.files?.[0])} />
          </div>
        )}
        {tab === 'link' && (
          <form
            className="cover-link"
            onSubmit={(e) => {
              e.preventDefault();
              if (/^https:\/\/\S+$/.test(link)) onPick(link);
              else toast('https:// から始まる画像の URL を入力してください', 'error');
            }}
          >
            <input className="input" autoFocus placeholder="https://… 画像の URL を貼り付け" value={link} onChange={(e) => setLink(e.target.value)} />
            <Button type="submit" variant="primary">
              設定
            </Button>
          </form>
        )}
      </div>
    </Popover>
  );
}

/** ページ上部のカバー表示。画像のときはドラッグで表示位置を調整できる */
export function Cover({
  cover,
  position,
  editable,
  resolve,
  onChangeClick,
  onPosition,
}: {
  cover: string;
  position: number;
  editable: boolean;
  resolve?: (url: string) => string;
  onChangeClick?: (el: HTMLElement) => void;
  onPosition?: (pos: number) => void;
}) {
  const [repositioning, setRepositioning] = useState(false);
  const [pos, setPos] = useState(position);
  const drag = useRef<{ y: number; start: number } | null>(null);
  const image = isImageCover(cover);

  return (
    <div
      className={`page-cover ${repositioning ? 'repositioning' : ''}`}
      style={coverStyle(cover, repositioning ? pos : position, resolve)}
      onPointerDown={(e) => {
        if (!repositioning) return;
        drag.current = { y: e.clientY, start: pos };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const h = (e.currentTarget as HTMLElement).clientHeight;
        setPos(Math.min(100, Math.max(0, drag.current.start - ((e.clientY - drag.current.y) / h) * 100)));
      }}
      onPointerUp={() => (drag.current = null)}
    >
      {repositioning && <div className="cover-hint">ドラッグして位置を調整</div>}
      {editable && (
        <div className="cover-actions">
          {repositioning ? (
            <>
              <button
                onClick={() => {
                  onPosition?.(Math.round(pos));
                  setRepositioning(false);
                }}
              >
                位置を保存
              </button>
              <button onClick={() => setRepositioning(false)}>キャンセル</button>
            </>
          ) : (
            <>
              <button onClick={(e) => onChangeClick?.(e.currentTarget)}>カバーを変更</button>
              {image && (
                <button
                  onClick={() => {
                    setPos(position);
                    setRepositioning(true);
                  }}
                >
                  位置を調整
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
