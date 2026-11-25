import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type RegistrationLink, type User, type Workspace } from '../api';
import { Button, formatRelative, Icon, Modal, Spinner, useUi, UserAvatar, WorkspaceIcon } from '../ui';
import { LinkResultModal, RoleBadge, StatusBadge } from './common';

type AdminUser = User & { passkeys: number; sessions: number; pages: number; hasPendingLink: boolean };

function CreateUserModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (u: User, link: RegistrationLink) => void }) {
  const { toast } = useUi();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [expiry, setExpiry] = useState('');
  const [allWs, setAllWs] = useState<Workspace[]>([]);
  const [wsIds, setWsIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setUsername('');
      setDisplayName('');
      setRole('member');
      setExpiry('');
      setError('');
      api<{ workspaces: Workspace[] }>('/admin/workspaces')
        .then((r) => {
          setAllWs(r.workspaces);
          setWsIds(new Set(r.workspaces.slice(0, 1).map((w) => w.id)));
        })
        .catch(() => {});
    }
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ user: User; link: RegistrationLink }>('/admin/users', {
        body: { username, displayName: displayName || username, role, expiryHours: expiry ? Number(expiry) : undefined, workspaceIds: [...wsIds] },
      });
      onCreated(res.user, res.link);
      toast('ユーザーを作成しました', 'success');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="ユーザーを追加" width={480}>
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="muted small">作成後に表示される登録リンクを本人に渡すと、本人の端末でパスキーを作成してログインできるようになります。</p>
        <label className="field">
          <span>ユーザー名（ログインIDではなく識別用。英数字と . _ -）</span>
          <input autoFocus required value={username} pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{1,31}" maxLength={32} onChange={(e) => setUsername(e.target.value)} placeholder="taro.yamada" />
        </label>
        <label className="field">
          <span>表示名</span>
          <input value={displayName} maxLength={64} onChange={(e) => setDisplayName(e.target.value)} placeholder="山田 太郎" />
        </label>
        <div className="field">
          <span>権限</span>
          <div className="segmented">
            <button type="button" className={role === 'member' ? 'active' : ''} onClick={() => setRole('member')}>
              メンバー
            </button>
            <button type="button" className={role === 'admin' ? 'active' : ''} onClick={() => setRole('admin')}>
              管理者
            </button>
          </div>
        </div>
        {allWs.length > 0 && (
          <div className="field">
            <span>参加させるワークスペース</span>
            <div className="check-list">
              {allWs.map((w) => (
                <label key={w.id} className="check-item">
                  <input
                    type="checkbox"
                    checked={wsIds.has(w.id)}
                    onChange={(e) => {
                      const next = new Set(wsIds);
                      if (e.target.checked) next.add(w.id);
                      else next.delete(w.id);
                      setWsIds(next);
                    }}
                  />
                  <WorkspaceIcon ws={w} size={20} /> {w.name}
                </label>
              ))}
            </div>
          </div>
        )}
        <label className="field">
          <span>登録リンクの有効期限（時間・空欄で既定値）</span>
          <input type="number" min={1} max={720} value={expiry} onChange={(e) => setExpiry(e.target.value)} placeholder="既定値" />
        </label>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="modal-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!username}>
            作成して登録リンクを発行
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default function Users() {
  const { toast } = useUi();
  const navigate = useNavigate();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ user: User; link: RegistrationLink } | null>(null);
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState<'all' | User['status']>('all');

  const load = () => api<{ users: AdminUser[] }>('/admin/users').then((r) => setUsers(r.users));
  useEffect(() => {
    load().catch((e) => toast(e.message, 'error'));
  }, []);

  const shown =
    users?.filter(
      (u) =>
        (status === 'all' || u.status === status) &&
        (u.username.toLowerCase().includes(filter.toLowerCase()) || u.displayName.toLowerCase().includes(filter.toLowerCase())),
    ) ?? [];

  return (
    <div className="admin-page">
      <div className="admin-header">
        <h1>ユーザー</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> ユーザーを追加
        </Button>
      </div>
      <div className="toolbar">
        <input className="input" placeholder="名前で絞り込み…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="segmented">
          {(['all', 'active', 'pending', 'disabled'] as const).map((s) => (
            <button key={s} className={status === s ? 'active' : ''} onClick={() => setStatus(s)}>
              {{ all: 'すべて', active: '有効', pending: '登録待ち', disabled: '無効' }[s]}
            </button>
          ))}
        </div>
      </div>
      {!users ? (
        <Spinner />
      ) : (
        <div className="card no-pad">
          <div className="table-wrap">
            <table className="table table-hover">
              <thead>
                <tr>
                  <th>ユーザー</th>
                  <th>権限</th>
                  <th>状態</th>
                  <th>パスキー</th>
                  <th>ページ</th>
                  <th>最終ログイン</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((u) => (
                  <tr key={u.id} onClick={() => navigate(`/admin/users/${u.id}`)}>
                    <td>
                      <Link to={`/admin/users/${u.id}`} className="user-cell" onClick={(e) => e.stopPropagation()}>
                        <UserAvatar user={u} size={28} />
                        <div>
                          <div className="list-title">{u.displayName}</div>
                          <div className="muted small">@{u.username}</div>
                        </div>
                      </Link>
                    </td>
                    <td>
                      <RoleBadge role={u.role} />
                    </td>
                    <td>
                      <StatusBadge status={u.status} />
                      {u.hasPendingLink && (
                        <span className="badge badge-muted" title="未使用の登録リンクがあります">
                          <Icon name="link" size={11} /> リンク有効
                        </span>
                      )}
                    </td>
                    <td>{u.passkeys}</td>
                    <td>{u.pages}</td>
                    <td className="nowrap">{u.lastLoginAt ? formatRelative(u.lastLoginAt) : <span className="muted">未ログイン</span>}</td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty small">
                      該当するユーザーはいません
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <CreateUserModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(user, link) => {
          setCreating(false);
          setResult({ user, link });
          load();
        }}
      />
      <LinkResultModal link={result?.link ?? null} user={result?.user ?? null} onClose={() => setResult(null)} />
    </div>
  );
}
