/**
 * リンクの関係図：ページを点、ページどうしのリンク（と親子）を線にして、ばねのように並べて見せる。
 * ドラッグで移動、ホイール・ピンチで拡大縮小、点を押すとそのページを開く。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../ui';
import { pageTitle, useWorkspace } from './WorkspaceContext';

type GNode = { id: string; title: string; icon: string | null; parentId: string | null };
type GLink = { from: string; to: string };
type SimNode = GNode & { x: number; y: number; vx: number; vy: number; deg: number; fixed: boolean };
type SimEdge = { a: SimNode; b: SimNode; kind: 'link' | 'parent' };

const remember = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
};
const save = (key: string, v: boolean) => {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* 覚えられなくても使える */
  }
};

export default function Graph() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [data, setData] = useState<{ nodes: GNode[]; links: GLink[] } | null>(null);
  const [error, setError] = useState('');
  const [showParents, setShowParents] = useState(() => remember('graph-parents', true));
  const [hideLonely, setHideLonely] = useState(() => remember('graph-lonely', false));
  const wsId = ws.current?.id;
  useEffect(() => {
    if (!wsId) return;
    let alive = true;
    setData(null);
    api<{ nodes: GNode[]; links: GLink[] }>(`/pages/graph?workspace=${encodeURIComponent(wsId)}`)
      .then((r) => alive && setData(r))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [wsId]);

  const graph = useMemo(() => {
    if (!data) return null;
    const byId = new Map<string, SimNode>();
    data.nodes.forEach((n, i) => {
      // 最初は円の上に並べる（毎回同じ形になるように乱数は使わない）
      const a = i * 2.399963;
      const r = 30 * Math.sqrt(i + 1);
      byId.set(n.id, { ...n, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, deg: 0, fixed: false });
    });
    const edges: SimEdge[] = [];
    const seen = new Set<string>();
    const add = (from: string, to: string, kind: SimEdge['kind']) => {
      const a = byId.get(from);
      const b = byId.get(to);
      const key = from < to ? `${from}|${to}` : `${to}|${from}`;
      if (!a || !b || seen.has(key)) return;
      seen.add(key);
      edges.push({ a, b, kind });
      a.deg++;
      b.deg++;
    };
    data.links.forEach((l) => add(l.from, l.to, 'link'));
    if (showParents) data.nodes.forEach((n) => n.parentId && add(n.parentId, n.id, 'parent'));
    const nodes = [...byId.values()].filter((n) => !hideLonely || n.deg > 0);
    return { nodes, edges: edges.filter((e) => nodes.includes(e.a) && nodes.includes(e.b)), linkCount: data.links.length };
  }, [data, showParents, hideLonely]);

  return (
    <div className="graph-page">
      <div className="graph-head">
        <h1>
          <Icon name="graph" size={24} /> リンクの関係図
        </h1>
        <div className="graph-options">
          <label>
            <input
              type="checkbox"
              checked={showParents}
              onChange={(e) => {
                setShowParents(e.target.checked);
                save('graph-parents', e.target.checked);
              }}
            />
            親子も線にする
          </label>
          <label>
            <input
              type="checkbox"
              checked={hideLonely}
              onChange={(e) => {
                setHideLonely(e.target.checked);
                save('graph-lonely', e.target.checked);
              }}
            />
            つながりのないページを隠す
          </label>
        </div>
      </div>
      {error ? (
        <p className="graph-note">{error}</p>
      ) : !graph ? (
        <p className="graph-note">読み込み中…</p>
      ) : graph.nodes.length === 0 ? (
        <p className="graph-note">表示するページがありません。</p>
      ) : (
        <>
          <p className="graph-note">
            ページ {graph.nodes.length} ・ リンク {graph.linkCount}。点を押すとそのページを開きます。ドラッグで動かし、ホイールやピンチで拡大・縮小できます。
          </p>
          <GraphCanvas nodes={graph.nodes} edges={graph.edges} onOpen={(id) => navigate(`/p/${id}`)} />
        </>
      )}
    </div>
  );
}

function GraphCanvas({ nodes, edges, onOpen }: { nodes: SimNode[]; edges: SimEdge[]; onOpen: (id: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const view = { x: 0, y: 0, k: 1 };
    let alpha = 1;
    let raf = 0;
    let hover: SimNode | null = null;
    let w = 0;
    let h = 0;

    const neighbors = new Map<SimNode, Set<SimNode>>();
    nodes.forEach((n) => neighbors.set(n, new Set()));
    edges.forEach((e) => {
      neighbors.get(e.a)!.add(e.b);
      neighbors.get(e.b)!.add(e.a);
    });
    // ページが少ないときは、名前をいつも出す
    const fewNodes = nodes.length <= 60;
    const radius = (n: SimNode) => 4 + Math.min(10, Math.sqrt(n.deg) * 2.2);

    const colors = () => {
      const cs = getComputedStyle(document.documentElement);
      const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
      return { text: v('--text', '#37352f'), faint: v('--text-faint', '#aaa'), accent: v('--accent', '#2383e2'), border: v('--border', '#ddd'), bg: v('--bg', '#fff'), font: v('--font', 'sans-serif') };
    };
    let col = colors();

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const first = !w;
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (first) fit();
      draw();
    };

    // 全体が収まるように、拡大率と位置を合わせる
    const fit = () => {
      if (!nodes.length || !w) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of nodes) {
        x0 = Math.min(x0, n.x);
        y0 = Math.min(y0, n.y);
        x1 = Math.max(x1, n.x);
        y1 = Math.max(y1, n.y);
      }
      const pad = 60;
      view.k = Math.min(2, Math.max(0.15, Math.min((w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0))));
      view.x = w / 2 - ((x0 + x1) / 2) * view.k;
      view.y = h / 2 - ((y0 + y1) / 2) * view.k;
    };

    const tick = () => {
      // 反発（近いほど強く押し合う）
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = (i % 7) - 3 || 1;
            dy = (j % 5) - 2 || 1;
            d2 = dx * dx + dy * dy;
          }
          if (d2 > 250_000) continue;
          const f = (900 / d2) * alpha;
          const fx = dx * f;
          const fy = dy * f;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
      }
      // ばね（線でつながった点を引き寄せる）
      for (const e of edges) {
        const dx = e.b.x - e.a.x;
        const dy = e.b.y - e.a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const rest = e.kind === 'parent' ? 60 : 80;
        const f = ((d - rest) / d) * 0.06 * alpha;
        e.a.vx += dx * f;
        e.a.vy += dy * f;
        e.b.vx -= dx * f;
        e.b.vy -= dy * f;
      }
      for (const n of nodes) {
        // 真ん中へ少し寄せる
        n.vx -= n.x * 0.004 * alpha;
        n.vy -= n.y * 0.004 * alpha;
        if (n.fixed) {
          n.vx = n.vy = 0;
          continue;
        }
        n.vx *= 0.6;
        n.vy *= 0.6;
        n.x += n.vx;
        n.y += n.vy;
      }
      alpha *= 0.985;
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(view.x, view.y);
      ctx.scale(view.k, view.k);
      const near = hover ? neighbors.get(hover)! : null;
      for (const e of edges) {
        const on = hover && (e.a === hover || e.b === hover);
        ctx.strokeStyle = on ? col.accent : col.faint;
        ctx.globalAlpha = hover && !on ? 0.35 : 1;
        ctx.lineWidth = (on ? 1.6 : e.kind === 'link' ? 1.1 : 0.8) / view.k;
        ctx.setLineDash(e.kind === 'parent' ? [4 / view.k, 3 / view.k] : []);
        ctx.beginPath();
        ctx.moveTo(e.a.x, e.a.y);
        ctx.lineTo(e.b.x, e.b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      for (const n of nodes) {
        const on = n === hover || near?.has(n);
        ctx.globalAlpha = hover && !on ? 0.3 : 1;
        ctx.fillStyle = n === hover ? col.accent : n.deg > 0 ? col.text : col.faint;
        ctx.beginPath();
        ctx.arc(n.x, n.y, radius(n) / Math.sqrt(view.k), 0, Math.PI * 2);
        ctx.fill();
      }
      // 名前：拡大しているとき・つながりの多いページ・指しているページとその周り
      const fs = 12 / view.k;
      ctx.font = `${fs}px ${col.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.lineWidth = 3 / view.k;
      ctx.strokeStyle = col.bg;
      for (const n of nodes) {
        const on = n === hover || near?.has(n);
        if (!on && !fewNodes && view.k < 1.1 && n.deg < 4) continue;
        ctx.globalAlpha = hover && !on ? 0.25 : 1;
        ctx.fillStyle = n === hover ? col.accent : col.text;
        const label = pageTitle(n).slice(0, 24);
        const y = n.y + radius(n) / Math.sqrt(view.k) + 3 / view.k;
        ctx.strokeText(label, n.x, y);
        ctx.fillText(label, n.x, y);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    };

    const loop = () => {
      if (alpha > 0.004) tick();
      draw();
      raf = alpha > 0.004 ? requestAnimationFrame(loop) : 0;
    };
    const wake = (a = 0.3) => {
      alpha = Math.max(alpha, a);
      if (!raf) raf = requestAnimationFrame(loop);
    };
    const redraw = () => {
      if (!raf) draw();
    };

    // 画面の座標 → 図の座標
    const toWorld = (cx: number, cy: number) => {
      const r = canvas.getBoundingClientRect();
      return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
    };
    const hit = (cx: number, cy: number) => {
      const p = toWorld(cx, cy);
      let best: SimNode | null = null;
      let bestD = Infinity;
      for (const n of nodes) {
        const d = Math.hypot(n.x - p.x, n.y - p.y);
        const r = radius(n) / Math.sqrt(view.k) + 6 / view.k;
        if (d < r && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    };
    const zoomAt = (cx: number, cy: number, factor: number) => {
      const r = canvas.getBoundingClientRect();
      const k = Math.min(6, Math.max(0.15, view.k * factor));
      const px = cx - r.left;
      const py = cy - r.top;
      view.x = px - ((px - view.x) * k) / view.k;
      view.y = py - ((py - view.y) * k) / view.k;
      view.k = k;
      redraw();
    };

    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { node: SimNode | null; sx: number; sy: number; moved: boolean; vx: number; vy: number } | null = null;
    let pinch: { d: number } | null = null;

    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
        if (drag?.node) drag.node.fixed = false;
        drag = null;
        return;
      }
      const node = hit(e.clientX, e.clientY);
      drag = { node, sx: e.clientX, sy: e.clientY, moved: false, vx: view.x, vy: view.y };
      if (node) node.fixed = true;
    };
    const onMove = (e: PointerEvent) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch.d);
        pinch.d = d;
        return;
      }
      if (!drag) {
        const n = hit(e.clientX, e.clientY);
        if (n !== hover) {
          hover = n;
          canvas.style.cursor = n ? 'pointer' : 'grab';
          redraw();
        }
        return;
      }
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) drag.moved = true;
      if (!drag.moved) return;
      if (drag.node) {
        const p = toWorld(e.clientX, e.clientY);
        drag.node.x = p.x;
        drag.node.y = p.y;
        wake(0.15);
      } else {
        view.x = drag.vx + (e.clientX - drag.sx);
        view.y = drag.vy + (e.clientY - drag.sy);
        canvas.style.cursor = 'grabbing';
        redraw();
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!drag) return;
      if (drag.node) {
        drag.node.fixed = false;
        if (!drag.moved) openRef.current(drag.node.id);
      }
      canvas.style.cursor = hover ? 'pointer' : 'grab';
      drag = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    const onLeave = () => {
      if (hover && !drag) {
        hover = null;
        redraw();
      }
    };

    // 最初に形を整えてから見せる（ちらつかないように）
    for (let i = 0; i < 300 && alpha > 0.02; i++) tick();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    wake(alpha);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => {
      col = colors();
      redraw();
    };
    mq.addEventListener('change', onTheme);
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener('change', onTheme);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [nodes, edges]);

  return <canvas ref={canvasRef} className="graph-canvas" aria-label="リンクの関係図" />;
}
