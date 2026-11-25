import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type User } from '../api';
import { Button, Icon, Modal, PageIcon, Spinner, useUi, UserAvatar } from '../ui';

type Group = { id: string; name: string; description: string | null; memberCount: number; pageCount: number; createdAt: number };
type Detail = {
  group: { id: string; name: string; description: string | null };
  members: User[];
  pages: { id: string; title: string; icon: string | null; permission: string; workspace: string | null }[];
};

function MemberPicker({ users, selected, onChange }: { users: User[]; selected: Set<string>; onChange: (s: Set<string>) => void }) {
  const [filter, setFilter] = useState('');
  const shown = users.filter((u) => `${u.displayName} ${u.username}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      <input className="input" placeholder="名前で絞り込み…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="check-list" style={{ marginTop: 6 }}>
        {shown.map((u) => (
          <label key={u.id} className="check-item">
            <input
              type="checkbox"
              checked={selected.has(u.id)}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(u.id);
                else next.delete(u.id);
                onChange(next);
              }}
            />
            <UserAvatar user={u} size={20} />
            <span className="ellipsis">{u.displayName}</span>
            <span className="muted small">@{u.username}</span>
          </label>
        ))}
        {shown.length === 0 && <div className="empty small">該当するアカウントはありません</div>}
      </div>
    </>
  );
}

function GroupModal({ groupId, open, onClose, onChanged }: { groupId: string | null; open: boolean; onClose: () => void; onChanged: () => void }) {
  const { toast, confirm } = useUi();
  const [users, setUsers] = useState<User[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const isNew = !groupId;

  const load = async () => {
    if (!groupId) return;
    const d = await api<Detail>(`/admin/groups/${groupId}`);
    setDetail(d);
    setName(d.group.name);
    setDescription(d.group.description ?? '');
    setSelected(new Set(d.members.map((m) => m.id)));
  };

  useEffect(() => {
    if (!open) return;
    setDetail(null);
    setName('');
    setDescription('');
    setSelected(new Set());
    api<{ users: User[] }>('/admin/users').then((r) => setUsers(r.users.filter((u) => u.status !== 'disabled')));
    load().catch((e) => toast(e.message, 'error'));
  }, [open, groupId]);

  const save = async () => {
    setBusy(true);
    try {
      if (isNew) {
        await api('/admin/groups', { body: { name, description: description || undefined, memberIds: [...selected] } });
        toast('グループを作成しました', 'success');
      } else {
        await api(`/admin/groups/${groupId}`, { method: 'PATCH', body: { name, description: description || null } });
        const before = new Set(detail?.members.map((m) => m.id));
        const added = [...selected].filter((id) => !before.has(id));
        const removed = [...before].filter((id) => !selected.has(id));
        if (added.length) await api(`/admin/groups/${groupId}/members`, { body: { userIds: added } });
        for (const id of removed) await api(`/admin/groups/${groupId}/members/${id}`, { method: 'DELETE' });
        toast('グループを更新しました', 'success');
      }
      onChanged();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!groupId || !detail) return;
    const ok = await confirm({
      title: 'グループを削除しますか？',
      message: `「${detail.group.name}」に共有されていたページ（${detail.pages.length} 件）は、このグループ経由では見られなくなります。`,
      confirmLabel: '削除',
      danger: true,
    });
    if (!ok) return;
    await api(`/admin/groups/${groupId}`, { method: 'DELETE' });
    toast('グループを削除しました', 'success');
    onChanged();
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={isNew ? 'グループを作成' : 'グループを編集'} width={520}>
      {!isNew && !detail ? (
        <div className="modal-body">
          <Spinner />
        </div>
      ) : (
        <form
          className="modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save();
          }}
        >
          <label className="field">
            <span>グループ名</span>
            <input autoFocus value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="例：営業チーム、外部パートナー" />
          </label>
          <label className="field">
            <span>説明（任意）</span>
            <input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="field">
            <span>メンバー（{selected.size} 人）</span>
            <MemberPicker users={users} selected={selected} onChange={setSelected} />
          </div>
          {detail && detail.pages.length > 0 && (
            <div className="field">
              <span>このグループに共有されているページ</span>
              <div className="check-list">
                {detail.pages.map((p) => (
                  <Link key={p.id} to={`/p/${p.id}`} className="check-item" onClick={onClose}>
                    <PageIcon icon={p.icon} />
                    <span className="ellipsis">{p.title || '無題'}</span>
                    <span className="muted small">{p.workspace}・{p.permission === 'edit' ? '編集可' : '閲覧のみ'}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
          <p className="muted small">ページの「共有」からグループを招待すると、メンバー全員がそのページ以下にアクセスできます（ワークスペース外のメンバーはゲストになります）。</p>
          <div className="modal-actions">
            {!isNew && (
              <Button type="button" variant="danger" onClick={remove} style={{ marginRight: 'auto' }}>
                削除
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              キャンセル
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
              {isNew ? '作成' : '保存'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export default function Groups() {
  const { toast } = useUi();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const load = () => api<{ groups: Group[] }>('/admin/groups').then((r) => setGroups(r.groups));
  useEffect(() => {
    load().catch((e) => toast(e.message, 'error'));
  }, []);

  return (
    <div className="admin-page">
      <div className="admin-header">
        <div>
          <h1>グループ</h1>
          <p className="muted small">アカウントをまとめて、ページをグループ単位で共有できます。</p>
        </div>
        <Button variant="primary" onClick={() => setEditing(null)}>
          <Icon name="plus" /> グループを作成
        </Button>
      </div>
      {!groups ? (
        <Spinner />
      ) : (
        <div className="card no-pad">
          <div className="table-wrap">
            <table className="table table-hover">
              <thead>
                <tr>
                  <th>グループ</th>
                  <th>メンバー</th>
                  <th>共有されたページ</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.id} onClick={() => setEditing(g.id)}>
                    <td>
                      <div className="user-cell">
                        <span className="group-icon">
                          <Icon name="users" size={14} />
                        </span>
                        <div>
                          <div className="list-title">{g.name}</div>
                          {g.description && <div className="muted small">{g.description}</div>}
                        </div>
                      </div>
                    </td>
                    <td>{g.memberCount} 人</td>
                    <td>{g.pageCount} 件</td>
                  </tr>
                ))}
                {groups.length === 0 && (
                  <tr>
                    <td colSpan={3} className="empty small">
                      グループはまだありません
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <GroupModal groupId={editing ?? null} open={editing !== undefined} onClose={() => setEditing(undefined)} onChanged={() => load()} />
    </div>
  );
}
