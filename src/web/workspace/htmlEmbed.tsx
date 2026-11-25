/**
 * HTML の埋め込み（SVG の図・<figure>・<iframe> の埋め込み・style 付きの HTML など）。
 *
 * - エディターのブロック「html」：HTML をそのまま、安全な枠（スクリプトの動かない iframe）の中に表示する。
 *   中身の高さに合わせて枠の高さを変える。https の <iframe> だけの埋め込み（YouTube など）は、その iframe を直接置く
 * - Markdown の取り込み：エディターのブロックで表せない HTML（SVG・iframe・style 付きなど）を、このブロックにする
 * - HTML の取り込み：<svg>・<iframe>・<video> などの要素を、このブロックにする
 * - 書き出し：Markdown では HTML のまま、HTML・PDF ではスクリプトを外した HTML にする
 */
import { createReactBlockSpec } from '@blocknote/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEffectiveTheme } from '../theme';

import { HTML_MARK } from './htmlMarks';

/* ---------- 表示 ---------- */

/** https の <iframe> だけの埋め込みなら、その属性 */
function singleIframe(html: string) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const els = [...doc.body.children];
  if (els.length !== 1 || els[0]!.tagName !== 'IFRAME' || doc.body.textContent?.trim()) return null;
  const f = els[0] as HTMLIFrameElement;
  const src = f.getAttribute('src') ?? '';
  if (!/^https:\/\//i.test(src)) return null;
  const w = Number(f.getAttribute('width')) || 0;
  const h = Number(f.getAttribute('height')) || 0;
  return { src, title: f.getAttribute('title') ?? '埋め込み', ratio: w > 0 && h > 0 ? w / h : 16 / 9, height: !w && h ? h : 0 };
}

/** HTML を、スクリプトの動かない枠の中に表示する（高さは中身に合わせる） */
export function HtmlEmbedFrame({ html }: { html: string }) {
  const theme = useEffectiveTheme();
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(60);
  // 文字の色・フォントは、置いた場所（ページ・スライド）に合わせる
  const [look, setLook] = useState<{ color: string; font: string; size: string } | null>(null);
  useEffect(() => {
    if (!box.current) return;
    const cs = getComputedStyle(box.current);
    setLook({ color: cs.color, font: cs.fontFamily, size: cs.fontSize });
  }, [theme]);
  const iframe = useMemo(() => singleIframe(html), [html]);
  const doc = useMemo(() => {
    if (iframe || !look) return '';
    // color-scheme は外の iframe と同じにする（違うと、ダークモードで枠の後ろが白く塗られる）
    const css = `:root{color-scheme:light dark}
html,body{margin:0;padding:0;background:transparent;color:${look.color};font-family:${look.font};font-size:${look.size};line-height:1.6}
body{overflow-x:auto;overflow-y:hidden}
img,video,canvas,iframe{max-width:100%}
img,video{height:auto}
svg{max-width:100%;height:auto}
a{color:inherit}`;
    // リンクは新しいタブで開く。スクリプトは枠の設定（sandbox）で動かない
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${css.replace(/<\//g, '<\\/')}</style></head><body>${html}</body></html>`;
  }, [html, look, iframe]);

  useEffect(() => {
    const f = frame.current;
    if (!f || iframe) return;
    let ro: ResizeObserver | null = null;
    const onLoad = () => {
      const d = f.contentDocument;
      if (!d) return;
      const measure = () => setHeight(Math.max(20, Math.ceil(d.documentElement.scrollHeight)));
      measure();
      ro?.disconnect();
      ro = new ResizeObserver(measure);
      ro.observe(d.body);
      d.querySelectorAll('img, video').forEach((el) => el.addEventListener('load', measure));
    };
    f.addEventListener('load', onLoad);
    return () => {
      f.removeEventListener('load', onLoad);
      ro?.disconnect();
    };
  }, [doc, iframe]);

  if (iframe)
    return (
      <div ref={box} className="html-embed-frame">
        <iframe
          src={iframe.src}
          title={iframe.title}
          className="html-embed-iframe"
          style={iframe.height ? { height: iframe.height } : { aspectRatio: String(iframe.ratio) }}
          sandbox="allow-scripts allow-same-origin allow-popups allow-presentation allow-forms"
          allow="fullscreen; picture-in-picture; encrypted-media; clipboard-write"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          loading="lazy"
        />
      </div>
    );
  return (
    <div ref={box} className="html-embed-frame">
      {doc && (
        // allow-same-origin は高さを測るため（allow-scripts が無いので、中のスクリプトは動かない）
        <iframe ref={frame} srcDoc={doc} title="HTML の埋め込み" className="html-embed-doc" style={{ height }} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" />
      )}
    </div>
  );
}

function HtmlEmbedBlock({ html, editable, onChange }: { html: string; editable: boolean; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(editable && !html.trim());
  const [draft, setDraft] = useState(html);
  useEffect(() => setDraft(html), [html]);
  const done = () => {
    setEditing(false);
    if (draft !== html) onChange(draft);
  };
  return (
    <div className={`html-embed ${editable ? 'is-editable' : ''}`} contentEditable={false}>
      {draft.trim() ? (
        <HtmlEmbedFrame html={draft} />
      ) : (
        <button type="button" className="html-embed-empty" onClick={() => editable && setEditing(true)}>
          HTML を入力（SVG の図・&lt;iframe&gt; の埋め込みなど）
        </button>
      )}
      {editable && !editing && draft.trim() && (
        <button type="button" className="html-embed-edit" onClick={() => setEditing(true)}>
          HTML を編集
        </button>
      )}
      {editing && (
        <div className="html-embed-editor" onMouseDown={(e) => e.stopPropagation()}>
          <textarea
            className="html-embed-input"
            value={draft}
            rows={Math.min(16, Math.max(4, draft.split('\n').length + 1))}
            spellCheck={false}
            autoFocus
            placeholder={'<svg viewBox="0 0 100 50">…</svg>\n<iframe src="https://www.youtube.com/embed/…"></iframe>'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
                e.preventDefault();
                done();
              }
            }}
          />
          <div className="html-embed-hint">
            <span>⌘/Ctrl + Enter で確定・スクリプトは動きません</span>
            <button type="button" className="btn btn-primary btn-sm" onClick={done}>
              確定
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export const HtmlEmbedSpec = createReactBlockSpec(
  { type: 'html', propSchema: { html: { default: '' } }, content: 'none' },
  {
    render: (props) => <HtmlEmbedBlock html={props.block.props.html} editable={props.editor.isEditable} onChange={(html) => props.editor.updateBlock(props.block, { props: { html } })} />,
    toExternalHTML: (props) => <p>{HTML_MARK(props.block.props.html)}</p>,
  },
);
