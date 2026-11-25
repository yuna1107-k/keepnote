/**
 * ページの目次。見出しから作り、PC では右端に細い線で並べ（マウスを乗せると一覧が開く）、
 * スマホでは右下のボタンから開く。読んでいる位置の見出しを強調する。
 */
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../ui';

export type TocItem = { id: string; level: number; text: string };

const inlineText = (content: any): string =>
  Array.isArray(content) ? content.map((c) => (c.type === 'text' ? c.text : c.type === 'link' ? inlineText(c.content) : c.type === 'math' ? c.props?.latex ?? '' : '')).join('') : '';

/** ブロックから見出しを取り出す（トグルの中なども含む） */
export function headingsOf(blocks: any[]): TocItem[] {
  const out: TocItem[] = [];
  const walk = (list: any[]) => {
    for (const b of list ?? []) {
      if (b.type === 'heading') {
        const text = inlineText(b.content).trim();
        if (text) out.push({ id: b.id, level: Math.min(3, Number(b.props?.level) || 1), text });
      }
      if (b.children?.length) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

function scrollToBlock(id: string) {
  const el = document.querySelector(`.bn-editor [data-id="${CSS.escape(id)}"]`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function Toc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const minLevel = useMemo(() => Math.min(...items.map((i) => i.level)), [items]);

  // 画面の上の方にある最後の見出しを「読んでいる位置」とする
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      let current: string | null = items[0]?.id ?? null;
      for (const it of items) {
        const el = document.querySelector(`.bn-editor [data-id="${CSS.escape(it.id)}"]`);
        if (el && el.getBoundingClientRect().top < 140) current = it.id;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('scroll', onScroll, true);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [items]);

  if (items.length < 2) return null;
  const list = (
    <ol className="toc-list">
      {items.map((it) => (
        <li key={it.id} className={`toc-item toc-level-${it.level - minLevel + 1} ${active === it.id ? 'active' : ''}`}>
          <button
            onClick={() => {
              scrollToBlock(it.id);
              setOpen(false);
            }}
          >
            {it.text}
          </button>
        </li>
      ))}
    </ol>
  );
  return (
    <>
      <nav className="toc-rail" aria-label="目次">
        <div className="toc-lines" aria-hidden="true">
          {items.map((it) => (
            <span key={it.id} className={`toc-line toc-level-${it.level - minLevel + 1} ${active === it.id ? 'active' : ''}`} />
          ))}
        </div>
        <div className="toc-panel">{list}</div>
      </nav>
      <button className="toc-fab" onClick={() => setOpen((v) => !v)} aria-label="目次" aria-expanded={open}>
        <Icon name="toc" size={20} />
      </button>
      {open && (
        <div className="toc-sheet" role="dialog" aria-label="目次">
          <div className="toc-sheet-head">
            目次
            <button className="icon-btn" onClick={() => setOpen(false)} aria-label="閉じる">
              <Icon name="x" />
            </button>
          </div>
          {list}
        </div>
      )}
    </>
  );
}
