import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type User, type Workspace } from '../api';
import { useAuth } from '../auth/AuthContext';
import { AVATAR_COLORS, Button, formatDateTime, Icon, Modal, Spinner, useUi, UserAvatar, WorkspaceIcon } from '../ui';
import { EmojiPicker } from '../workspace/EmojiPicker';

function CreateModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { user } = useAuth();
  const { toast } = useUi();
  const [users, setUsers] = useState<User[]>([]);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string | null>(null);
  const [color, setColor] = useState<string>(AVATAR_COLORS[5]!);
  const [ownerId, setOwnerId] = useState('');
  const [roles, setRoles] = useState<Record<string, 'admin' | 'member' | 'viewer' | ''>>({});
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setEmoji(null);
    setColor(AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!);
    setOwnerId(user?.id ?? '');
    setRoles({});
    api<{ users: User[] }>('/admin/users')
      .then((r) => setUsers(r.users.filter((u) => u.status !== 'disabled')))
      .catch(() => {});
  }, [open, user?.id]);

  const submit = async () => {
    setBusy(true);
    try {
      const entries = Object.entries(roles).filter(([id, r]) => r && id !== ownerId);
      await api('/workspaces', {
        body: {
          name,
          iconEmoji: emoji,
          iconColor: color,
          ownerId,
          memberIds: entries.filter(([, r]) => r === 'member').map(([id]) => id),
          viewerIds: entries.filter(([, r]) => r === 'viewer').map(([id]) => id),
          adminIds: entries.filter(([, r]) => r === 'admin').map(([id]) => id),
        },
      });
      toast('ワークスペースを作成しました', 'success');
      onCreated();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="ワークスペースを作成" width={520}>
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && ownerId) submit();
        }}
      >
        <div className="ws-create-preview">
          <button type="button" className="ws-create-icon" onClick={(e) => setEmojiAnchor(e.currentTarget)} title="アイコンを選ぶ">
            <WorkspaceIcon ws={{ name: name || 'W', iconEmoji: emoji, iconColor: color }} size={64} />
          </button>
          <div className="color-swatches">
            {AVATAR_COLORS.map((c) => (
              <button type="button" key={c} className={`swatch ${color === c ? 'active' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
            ))}
          </div>
        </div>
        <label className="field">
          <span>ワークスペース名</span>
          <input autoFocus value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="例：チーム、プロジェクト名" />
        </label>
        <label className="field">
          <span>オーナー（名前・アイコン・メンバーを管理できる人）</span>
          <select className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}（@{u.username}）
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span>最初から参加させるアカウント</span>
          <div className="check-list">
            {users
              .filter((u) => u.id !== ownerId)
              .map((u) => (
                <div key={u.id} className="check-item">
                  <UserAvatar user={u} size={20} />
                  <span className="ellipsis" style={{ flex: 1 }}>
                    {u.displayName} <span className="muted small">@{u.username}</span>
                  </span>
                  <select className="input select-sm" value={roles[u.id] ?? ''} onChange={(e) => setRoles({ ...roles, [u.id]: e.target.value as 'admin' | 'member' | 'viewer' | '' })}>
                    <option value="">参加しない</option>
                    <option value="admin">管理者</option>
                    <option value="member">メンバー</option>
                    <option value="viewer">閲覧者</option>
                  </select>
                </div>
              ))}
            {users.length <= 1 && <div className="empty small">ほかのアカウントはまだありません</div>}
          </div>
        </div>
        <p className="muted small">メンバーはページを作成でき、閲覧者は共有されたページの閲覧のみできます。参加させなくても、ページ単位の共有（ゲスト）は可能です。</p>
        <div className="modal-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || !ownerId}>
            作成
          </Button>
        </div>
      </form>
      {emojiAnchor && (
        <EmojiPicker
          anchor={emojiAnchor}
          onPick={(e) => {
            setEmoji(e);
            setEmojiAnchor(null);
          }}
          onRemove={emoji ? () => (setEmoji(null), setEmojiAnchor(null)) : undefined}
          onClose={() => setEmojiAnchor(null)}
        />
      )}
    </Modal>
  );
}

export default function AdminWorkspaces() {
  const { toast, confirm } = useUi();
  const [list, setList] = useState<Workspace[] | null>(null);
  const [creating, setCreating] = useState(false);
  const load = () => api<{ workspaces: Workspace[] }>('/admin/workspaces').then((r) => setList(r.workspaces));
  useEffect(() => {
    load().catch((e) => toast(e.message, 'error'));
  }, [toast]);

  const remove = async (w: Workspace) => {
    const ok = await confirm({
      title: 'ワークスペースを削除しますか？',
      message: `「${w.name}」と、その中のすべてのページ（${w.pageCount ?? 0} 件）が完全に削除されます。この操作は元に戻せません。`,
      confirmLabel: '削除',
      danger: true,
      requireText: w.name,
    });
    if (!ok) return;
    try {
      await api(`/workspaces/${w.id}`, { method: 'DELETE' });
      toast('ワークスペースを削除しました', 'success');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="admin-page">
      <div className="admin-header">
        <div>
          <h1>ワークスペース</h1>
          <p className="muted small">
            ワークスペースの作成・削除は管理者だけが行えます。「設定」から、参加していないワークスペースも含めて名前・アイコン・URL 名・メンバーなどを変更できます。
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> ワークスペースを作成
        </Button>
      </div>
      {!list ? (
        <Spinner />
      ) : (
        <div className="card no-pad">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>ワークスペース</th>
                  <th>オーナー</th>
                  <th>メンバー</th>
                  <th>ページ</th>
                  <th>作成日時</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((w) => (
                  <tr key={w.id}>
                    <td>
                      <Link to={`/admin/workspaces/${w.id}`} className="user-cell admin-ws-link">
                        <WorkspaceIcon ws={w} size={28} />
                        <span className="list-title">{w.name}</span>
                      </Link>
                    </td>
                    <td>{w.owners ?? <span className="muted">なし</span>}</td>
                    <td>{w.memberCount}</td>
                    <td>{w.pageCount}</td>
                    <td className="nowrap">{formatDateTime(w.createdAt)}</td>
                    <td className="nowrap">
                      <Link to={`/admin/workspaces/${w.id}`} className="btn btn-ghost btn-sm">
                        <Icon name="settings" size={14} /> 設定
                      </Link>
                      <Button size="sm" variant="ghost" className="text-danger" onClick={() => remove(w)}>
                        削除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <CreateModal open={creating} onClose={() => setCreating(false)} onCreated={() => load()} />
    </div>
  );
}

/** ユーザー詳細：所属ワークスペースの追加・削除 */
export function UserWorkspaces({ userId }: { userId: string }) {
  const { toast, confirm } = useUi();
  const [list, setList] = useState<Workspace[] | null>(null);
  const load = () => api<{ workspaces: Workspace[] }>(`/admin/users/${userId}/workspaces`).then((r) => setList(r.workspaces));
  useEffect(() => {
    load().catch((e) => toast(e.message, 'error'));
  }, [userId]);

  const toggle = async (w: Workspace) => {
    try {
      if (w.role) {
        const ok = await confirm({
          title: `「${w.name}」から外しますか？`,
          message: 'このユーザーのプライベートページ（このワークスペース内）は削除されます。',
          confirmLabel: '外す',
          danger: true,
        });
        if (!ok) return;
        await api(`/workspaces/${w.id}/members/${userId}`, { method: 'DELETE' });
      } else {
        await api(`/workspaces/${w.id}/members`, { body: { userIds: [userId] } });
      }
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const transfer = async (w: Workspace) => {
    const ok = await confirm({ title: `「${w.name}」のオーナーをこのユーザーにしますか？`, message: '現在のオーナーは「管理者」になります。', confirmLabel: 'オーナーを移行' });
    if (!ok) return;
    try {
      await api(`/workspaces/${w.id}/transfer`, { body: { userId } });
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const setRole = async (w: Workspace, role: string) => {
    try {
      await api(`/workspaces/${w.id}/members/${userId}`, { method: 'PATCH', body: { role } });
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  if (!list) return <Spinner />;
  return (
    <div className="list">
      {list.map((w) => (
        <div key={w.id} className="list-row">
          <WorkspaceIcon ws={w} size={28} />
          <div className="list-main">
            <div className="list-title">{w.name}</div>
          </div>
          {w.role === 'owner' ? (
            <span className="badge badge-info">オーナー</span>
          ) : (
            w.role && (
              <>
                <select className="input select-sm" value={w.role} onChange={(e) => setRole(w, e.target.value)}>
                  <option value="admin">管理者</option>
                  <option value="member">メンバー</option>
                  <option value="viewer">閲覧者</option>
                </select>
                <button className="btn btn-ghost btn-sm" onClick={() => transfer(w)}>
                  オーナーにする
                </button>
              </>
            )
          )}
          {w.role !== 'owner' && (
          <button className={`btn btn-sm ${w.role ? 'btn-ghost text-danger' : 'btn-secondary'}`} onClick={() => toggle(w)}>
            {w.role ? '外す' : '参加させる'}
          </button>
          )}
        </div>
      ))}
      {list.length === 0 && <div className="empty small">ワークスペースがありません</div>}
    </div>
  );
}
