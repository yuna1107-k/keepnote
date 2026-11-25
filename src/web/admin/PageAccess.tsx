import { useEffect, useMemo, useState } from 'react';
import { api, type Workspace } from '../api';
import { Icon, PageIcon, Spinner, useUi, WorkspaceIcon } from '../ui';

type Row = {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  visibility: 'workspace' | 'private';
  workspaceAccess: 'view' | 'edit';
  isOwner: boolean;
  direct: 'view' | 'edit' | null;
  effective: 'none' | 'view' | 'edit' | 'full';
};
type Data = { isAdmin: boolean; workspaces: { workspace: Workspace; pages: Row[] }[] };

const EFFECTIVE: Record<Row['effective'], { label: string; tone: string }> = {
  none: { label: 'アクセス不可', tone: 'muted' },
  view: { label: '閲覧のみ', tone: 'info' },
  edit: { label: '編集可', tone: 'success' },
  full: { label: 'フルアクセス', tone: 'success' },
};

/** 管理者画面：ユーザーが閲覧・編集できるページを設定する */
export function UserPageAccess({ userId }: { userId: string }) {
  const { toast } = useUi();
  const [data, setData] = useState<Data | null>(null);
  const [filter, setFilter] = useState('');
  const [onlyAccessible, setOnlyAccessible] = useState(false);

  const load = () => api<Data>(`/admin/users/${userId}/page-access`).then(setData);
  useEffect(() => {
    load().catch((e) => toast(e.message, 'error'));
  }, [userId]);

  const set = async (pageId: string, permission: string) => {
    try {
      await api(`/admin/users/${userId}/page-access`, { method: 'PUT', body: { pageId, permission: permission === 'inherit' ? null : permission } });
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  if (!data) return <Spinner />;
  if (data.isAdmin) return <p className="muted small">このユーザーは管理者のため、所属するワークスペースのすべてのページにアクセスできます。</p>;
  if (data.workspaces.length === 0) return <p className="muted small">ワークスペースがありません。</p>;

  return (
    <div className="page-access">
      <div className="toolbar">
        <input className="input" placeholder="ページ名で絞り込み…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="check-item">
          <input type="checkbox" checked={onlyAccessible} onChange={(e) => setOnlyAccessible(e.target.checked)} /> アクセスできるページだけ表示
        </label>
      </div>
      {data.workspaces.map(({ workspace, pages }) => (
        <WorkspaceTree key={workspace.id} workspace={workspace} pages={pages} filter={filter} onlyAccessible={onlyAccessible} onSet={set} />
      ))}
      <p className="muted small">
        「継承」は直接の設定なし（親ページやワークスペース全体への共有に従う）という意味です。設定はサブページにも引き継がれます。
      </p>
    </div>
  );
}

function WorkspaceTree({
  workspace,
  pages,
  filter,
  onlyAccessible,
  onSet,
}: {
  workspace: Workspace;
  pages: Row[];
  filter: string;
  onlyAccessible: boolean;
  onSet: (pageId: string, permission: string) => void;
}) {
  const tree = useMemo(() => {
    const ids = new Set(pages.map((p) => p.id));
    const children = new Map<string | null, Row[]>();
    for (const p of pages) {
      const key = p.parentId && ids.has(p.parentId) ? p.parentId : null;
      children.set(key, [...(children.get(key) ?? []), p]);
    }
    const out: { row: Row; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const r of children.get(parent) ?? []) {
        out.push({ row: r, depth });
        walk(r.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [pages]);

  const q = filter.trim().toLowerCase();
  const shown = tree.filter(({ row }) => (!q || (row.title || '無題').toLowerCase().includes(q)) && (!onlyAccessible || row.effective !== 'none'));
  const count = pages.filter((p) => p.effective !== 'none').length;

  return (
    <div className="page-access-ws">
      <div className="page-access-ws-head">
        <WorkspaceIcon ws={workspace} size={20} />
        <span className="list-title">{workspace.name}</span>
        {workspace.role === 'guest' && <span className="badge badge-warn">未所属（共有したページ以下のみ）</span>}
        <span className="muted small">
          {count} / {pages.length} ページにアクセス可能
        </span>
      </div>
      {shown.length === 0 ? (
        <div className="empty small">該当するページはありません</div>
      ) : (
        <div className="page-access-list">
          {shown.map(({ row, depth }) => (
            <div key={row.id} className={`page-access-row ${row.effective === 'none' ? 'is-none' : ''}`} style={{ paddingLeft: 8 + depth * 18 }}>
              <PageIcon icon={row.icon} />
              <span className="ellipsis page-access-title">{row.title || '無題'}</span>
              {row.visibility === 'workspace' && (
                <span className="badge badge-muted" title="ワークスペースの全員に共有">
                  <Icon name="users" size={11} /> 全員{row.workspaceAccess === 'view' ? '（閲覧）' : ''}
                </span>
              )}
              {row.isOwner && <span className="badge badge-muted">作成者</span>}
              <span className={`badge badge-${EFFECTIVE[row.effective].tone}`}>{EFFECTIVE[row.effective].label}</span>
              <select className="input select-sm" value={row.direct ?? 'inherit'} disabled={row.isOwner} onChange={(e) => onSet(row.id, e.target.value)}>
                <option value="inherit">継承</option>
                <option value="view">閲覧のみ</option>
                <option value="edit">編集可</option>
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
