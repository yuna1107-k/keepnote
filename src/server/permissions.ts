import { all } from './db.ts';
import type { SessionUser } from './session.ts';

/**
 * ページの権限レベル
 *   full: 作成者・管理者（共有設定・公開・完全削除が可能）
 *   edit: 編集可
 *   view: 閲覧のみ
 */
export type Level = 'none' | 'view' | 'edit' | 'full';

const rank: Record<Level, number> = { none: 0, view: 1, edit: 2, full: 3 };
export const atLeast = (level: Level, need: Level) => rank[level] >= rank[need];
const max = (a: Level, b: Level): Level => (rank[a] >= rank[b] ? a : b);

type Node = { id: string; parent_id: string | null; owner_id: string; visibility: string; workspace_access: string; restricted: number };

/**
 * ワークスペース内の全ページについて、ユーザーの権限を計算する。
 * - サーバー管理者は、所属するワークスペースのすべてのページに full
 * - それ以外は「自分が作成」「ワークスペース全員に共有」「自分に共有」のうち最も強いもの。親ページの権限は子に継承される
 */
export async function accessMap(
  workspaceId: string,
  user: SessionUser,
  isMember: boolean,
  isViewer = false,
  /** ワークスペースのオーナー・管理者は、ワークスペース内のすべてのページにフルアクセス */
  isWorkspaceAdmin = false,
): Promise<Map<string, Level>> {
  const result = new Map<string, Level>();
  const [nodes, shares] = await Promise.all([
    all<Node>('SELECT id, parent_id, owner_id, visibility, workspace_access, restricted FROM pages WHERE workspace_id = ?', workspaceId),
    // 本人への共有と、所属するグループへの共有
    all<{ page_id: string; permission: 'view' | 'edit' }>(
      `SELECT s.page_id, s.permission FROM page_shares s JOIN pages p ON p.id = s.page_id
       WHERE s.user_id = ? AND p.workspace_id = ?
       UNION ALL
       SELECT g.page_id, g.permission FROM page_group_shares g
       JOIN user_group_members m ON m.group_id = g.group_id
       JOIN pages p ON p.id = g.page_id
       WHERE m.user_id = ? AND p.workspace_id = ?`,
      user.id,
      workspaceId,
      user.id,
      workspaceId,
    ),
  ]);
  // ゲスト（ワークスペース外）で共有が 1 つもなければ何も見えない
  if (!isMember && shares.length === 0) return result;
  if ((user.role === 'admin' || isWorkspaceAdmin) && isMember) {
    isViewer = false;
    for (const n of nodes) result.set(n.id, 'full');
    return result;
  }
  const shareOf = new Map<string, Level>();
  for (const s of shares) shareOf.set(s.page_id, max(shareOf.get(s.page_id) ?? 'none', s.permission));
  const children = new Map<string | null, Node[]>();
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    const key = n.parent_id && ids.has(n.parent_id) ? n.parent_id : null;
    const list = children.get(key) ?? [];
    list.push(n);
    children.set(key, list);
  }
  const visit = (n: Node, inherited: Level) => {
    // 「招待した人のみ」のページは、親からの共有を引き継がない
    let level: Level = n.restricted ? 'none' : inherited;
    if (n.owner_id === user.id) level = max(level, 'full');
    // 「ワークスペースの全員」への共有はメンバーだけに適用（ゲストは個別の共有のみ）
    if (isMember && n.visibility === 'workspace') level = max(level, n.workspace_access === 'view' ? 'view' : 'edit');
    const s = shareOf.get(n.id);
    if (s) level = max(level, s);
    result.set(n.id, level);
    for (const c of children.get(n.id) ?? []) visit(c, level);
  };
  for (const root of children.get(null) ?? []) visit(root, 'none');
  // 閲覧者は、共有された権限に関わらず閲覧のみ
  if (isViewer) for (const [id, l] of result) if (l !== 'none') result.set(id, 'view');
  return result;
}
