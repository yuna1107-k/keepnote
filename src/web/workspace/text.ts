/** 検索用にブロックからプレーンテキストを抽出する */
export function blocksToText(blocks: unknown): string {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (typeof obj.text === 'string') out.push(obj.text);
      // 数式は LaTeX をそのまま検索できるようにする
      if (obj.type === 'math' && obj.props && typeof (obj.props as Record<string, unknown>).latex === 'string') out.push((obj.props as Record<string, string>).latex);
      // 脚注の文・引用のキー・参考文献も検索できるようにする
      if (obj.type === 'footnote' && obj.props && typeof (obj.props as Record<string, unknown>).text === 'string') out.push(` ${(obj.props as Record<string, string>).text} `);
      if (obj.type === 'cite' && obj.props && typeof (obj.props as Record<string, unknown>).key === 'string') out.push(` ${(obj.props as Record<string, string>).key} `);
      if (obj.type === 'references' && obj.props && typeof (obj.props as Record<string, unknown>).source === 'string') out.push((obj.props as Record<string, string>).source);
      if (obj.content) walk(obj.content);
      if (obj.rows) walk(obj.rows);
      if (obj.cells) walk(obj.cells);
      if (obj.children) {
        out.push('\n');
        walk(obj.children);
      }
      if (obj.props && typeof (obj.props as Record<string, unknown>).caption === 'string') {
        out.push(' ' + (obj.props as Record<string, string>).caption);
      }
      if (obj.type && obj.id) out.push('\n');
    }
  };
  walk(blocks);
  return out.join('').replace(/\n{2,}/g, '\n').trim();
}

/** 比較用：ブロックを 1 行ずつのテキストにする（子ブロックは字下げ） */
export function blockLines(blocks: unknown, depth = 0): string[] {
  if (!Array.isArray(blocks)) return [];
  const out: string[] = [];
  for (const b of blocks as Record<string, unknown>[]) {
    const own = blocksToText([{ ...b, children: [] }]).replace(/\n+/g, ' ').trim();
    const prefix = b.type === 'heading' ? '# ' : b.type === 'bulletListItem' || b.type === 'numberedListItem' ? '・' : b.type === 'checkListItem' ? '☐ ' : '';
    if (own || b.type === 'image' || b.type === 'table') out.push('　'.repeat(depth) + prefix + (own || `[${b.type}]`));
    out.push(...blockLines(b.children, depth + 1));
  }
  return out;
}

export type DiffLine = { type: 'same' | 'add' | 'del'; text: string };

/** 行単位の差分（LCS） */
export function diffLines(before: string[], after: string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i]![j] = before[i] === after[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ type: 'same', text: before[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ type: 'del', text: before[i++]! });
    else out.push({ type: 'add', text: after[j++]! });
  }
  while (i < n) out.push({ type: 'del', text: before[i++]! });
  while (j < m) out.push({ type: 'add', text: after[j++]! });
  return out;
}
