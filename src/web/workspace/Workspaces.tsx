import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, uploadFile, type User, type Workspace } from '../api';
import { useAuth } from '../auth/AuthContext';
import { AVATAR_COLORS, Button, formatRelative, Icon, Modal, Spinner, squareImage, Toggle, UserAvatar, useUi, WorkspaceIcon } from '../ui';
import { EmojiPicker } from './EmojiPicker';
import { useWorkspace } from './WorkspaceContext';

export const ROLE_LABEL: Record<string, string> = { owner: 'オーナー', admin: '管理者', member: 'メンバー', viewer: '閲覧者', guest: 'ゲスト' };

// ---------- 切り替えパネル ----------

export function WorkspaceSwitcher({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const go = (path: string) => {
    onClose();
    navigate(path);
  };
  return (
    <div className="ws-switcher">
      <div className="ws-switcher-user muted small">{user?.username}</div>
      <div className="ws-switcher-list">
        {ws.workspaces?.map((w) => (
          <button
            key={w.id}
            className={`ws-switcher-item ${ws.current?.id === w.id ? 'active' : ''}`}
            onClick={() => {
              ws.switchWorkspace(w.id);
              go('/');
            }}
          >
            <WorkspaceIcon ws={w} size={28} />
            <div className="ws-switcher-meta">
              <div className="list-title ellipsis">{w.name}</div>
              <div className="muted small">
                {ROLE_LABEL[w.role ?? 'member']}・{w.memberCount ?? 1}人
              </div>
            </div>
            {ws.current?.id === w.id && <Icon name="check" size={14} />}
          </button>
        ))}
      </div>
      <div className="menu-divider" />
      {ws.current && ws.current.role !== 'guest' && (
        <button className="menu-item" onClick={() => go('/workspace')}>
          <Icon name="settings" /> ワークスペースの設定
        </button>
      )}
      {user?.role === 'admin' && (
        <button className="menu-item" onClick={() => go('/admin/workspaces')}>
          <Icon name="plus" /> ワークスペースを作成（管理者画面）
        </button>
      )}
      <div className="menu-divider" />
      {/* アカウント設定と管理者画面はサイドバーから開く */}
      <button className="menu-item" onClick={() => logout().then(() => navigate('/login'))}>
        <Icon name="logout" /> ログアウト
      </button>
    </div>
  );
}

// ---------- 設定画面 ----------

type Member = User & { wsRole: 'owner' | 'admin' | 'member' | 'viewer'; joinedAt: number };
type Detail = { workspace: Workspace & { pageCount: number }; canManage: boolean; isOwner: boolean; members: Member[] };

/**
 * ワークスペースの設定画面。
 * adminMode のときは管理者画面から開いたもの（サーバー管理者が、所属していないワークスペースも含めて設定を変える）
 */
export function WorkspaceSettings({ workspaceId, adminMode = false }: { workspaceId?: string; adminMode?: boolean } = {}) {
  const ws = useWorkspace();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast, confirm } = useUi();
  const [data, setData] = useState<Detail | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const id = workspaceId ?? ws.current?.id;

  const load = async () => {
    if (!id) return;
    const d = await api<Detail>(`/workspaces/${id}`);
    setData(d);
    setName(d.workspace.name);
    setSlug(d.workspace.slug);
  };
  useEffect(() => {
    setData(null);
    load().catch((e) => toast(e.message, 'error'));
  }, [id]);

  if (!id) return <div className="empty-state">ワークスペースがありません</div>;
  if (!data) return <Spinner center />;
  const w = data.workspace;
  const manage = data.canManage;

  const patch = async (body: Record<string, unknown>, msg?: string) => {
    try {
      await api(`/workspaces/${id}`, { method: 'PATCH', body });
      await Promise.all([load(), ws.reloadWorkspaces()]);
      if (msg) toast(msg, 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const onFile = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadFile(await squareImage(file));
      await patch({ iconFileId: url.split('/').pop() }, 'アイコンを変更しました');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const member = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      await Promise.all([load(), ws.reloadWorkspaces()]);
      toast(msg, 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const leave = async () => {
    const ok = await confirm({
      title: `${w.name} から退出しますか？`,
      message: 'このワークスペースにあるあなたのプライベートページは削除されます。共有ページは残ります。',
      confirmLabel: '退出',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/workspaces/${id}/members/${user!.id}`, { method: 'DELETE' });
      const list = await ws.reloadWorkspaces();
      if (list[0]) ws.switchWorkspace(list[0].id);
      navigate('/');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: 'ワークスペースを削除しますか？',
      message: `「${w.name}」と、その中のすべてのページ（${w.pageCount} 件）が完全に削除されます。この操作は元に戻せません。`,
      confirmLabel: '削除',
      danger: true,
      requireText: w.name,
    });
    if (!ok) return;
    try {
      await api(`/workspaces/${id}`, { method: 'DELETE' });
      const list = await ws.reloadWorkspaces();
      if (list[0] && (!adminMode || ws.current?.id === id)) ws.switchWorkspace(list[0].id);
      toast('ワークスペースを削除しました', 'success');
      navigate(adminMode ? '/admin/workspaces' : '/');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="settings-page">
      {adminMode && (
        <Link to="/admin/workspaces" className="back-link small">
          <Icon name="arrowLeft" size={14} /> ワークスペース一覧
        </Link>
      )}
      <h1>{adminMode ? `「${w.name}」の設定` : 'ワークスペースの設定'}</h1>
      {adminMode && !w.role && (
        <p className="muted small admin-ws-note">サーバー管理者として設定を変更しています。このワークスペースには参加していません。変更は監査ログに記録されます。</p>
      )}

      <section className="card">
        <h2>一般</h2>
        <div className="profile-row">
          <div className="avatar-editor">
            <WorkspaceIcon ws={w} size={88} />
            {uploading && (
              <div className="avatar-editor-busy">
                <Spinner />
              </div>
            )}
          </div>
          <div className="avatar-controls">
            {manage ? (
              <>
                <div className="avatar-buttons">
                  <Button size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
                    <Icon name="image" size={14} /> 画像をアップロード
                  </Button>
                  <Button size="sm" onClick={(e) => setEmojiAnchor(e.currentTarget)}>
                    <Icon name="smile" size={14} /> 絵文字
                  </Button>
                  {(w.iconUrl || w.iconEmoji) && (
                    <Button size="sm" variant="ghost" onClick={() => patch({ iconFileId: null, iconEmoji: null }, 'アイコンを初期状態に戻しました')}>
                      リセット
                    </Button>
                  )}
                </div>
                <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => onFile(e.target.files?.[0])} />
                <div className="color-swatches">
                  {AVATAR_COLORS.map((c) => (
                    <button key={c} className={`swatch ${w.iconColor === c ? 'active' : ''}`} style={{ background: c }} onClick={() => patch({ iconColor: c })} aria-label={c} />
                  ))}
                </div>
              </>
            ) : (
              <p className="muted small">アイコンと名前はオーナーのみ変更できます。</p>
            )}
          </div>
        </div>
        <label className="field">
          <span>ワークスペース名</span>
          <div className="inline-form">
            <input value={name} maxLength={64} disabled={!manage} onChange={(e) => setName(e.target.value)} />
            {manage && (
              <Button onClick={() => patch({ name }, '名前を変更しました')} disabled={!name.trim() || name === w.name}>
                保存
              </Button>
            )}
          </div>
        </label>
        <label className="field">
          <span>URL 名（ページの URL は {window.location.host}/{slug || '…'}/〇〇 になります）</span>
          <div className="inline-form">
            <input
              value={slug}
              maxLength={40}
              disabled={!manage}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))}
            />
            {manage && (
              <Button
                onClick={async () => {
                  const ok = await confirm({
                    title: 'URL 名を変更しますか？',
                    message: `/${w.slug}/… のリンクは /${slug}/… に変わります。古いリンクは開けなくなるので、共有済みのリンクは送り直してください。`,
                    confirmLabel: '変更',
                  });
                  if (ok) patch({ slug }, 'URL 名を変更しました');
                }}
                disabled={!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(slug) || slug === w.slug}
              >
                変更
              </Button>
            )}
          </div>
        </label>
        <div className="setting-row">
          <div>
            <div className="list-title">「プライベート」のページを使う</div>
            <div className="muted small">オンにすると、サイドバーに自分だけが見られる「プライベート」の区分が表示されます。</div>
          </div>
          <Toggle
            checked={!!w.privatePages}
            disabled={!manage}
            onChange={(v) => patch({ privatePages: v }, v ? '「プライベート」のページを使えるようにしました' : '「プライベート」のページを使わないようにしました')}
            label="「プライベート」のページを使う"
          />
        </div>
        <dl className="dl">
          <dt>作成日時</dt>
          <dd>{new Date(w.createdAt).toLocaleString('ja-JP')}</dd>
          <dt>ページ数</dt>
          <dd>{w.pageCount} 件</dd>
          <dt>あなたの権限</dt>
          <dd>{w.role ? ROLE_LABEL[w.role] : adminMode ? 'サーバー管理者' : 'サーバー管理者として閲覧中'}</dd>
        </dl>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>メンバー（{data.members.length}）</h2>
            <p className="muted small">オーナー（1人）と管理者はメンバーと設定を管理できます。メンバーはページを作成でき、共有されたページを閲覧・編集できます。閲覧者は共有されたページの閲覧のみできます。新しいユーザーの発行はサーバー管理者が行います。</p>
          </div>
          {manage && (
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <Icon name="plus" /> メンバーを追加
            </Button>
          )}
        </div>
        <div className="list">
          {data.members.map((m) => (
            <div key={m.id} className="list-row">
              <UserAvatar user={m} size={32} />
              <div className="list-main">
                <div className="list-title">
                  {m.displayName} {m.id === user?.id && <span className="badge badge-muted">あなた</span>}
                </div>
                <div className="muted small">
                  @{m.username}・{formatRelative(m.joinedAt)}に参加
                </div>
              </div>
              {m.wsRole === 'owner' ? (
                <span className="badge badge-info">オーナー</span>
              ) : manage ? (
                <select
                  className="input select-sm"
                  value={m.wsRole}
                  onChange={(e) =>
                    member(() => api(`/workspaces/${id}/members/${m.id}`, { method: 'PATCH', body: { role: e.target.value } }), '権限を変更しました')
                  }
                >
                  <option value="admin">管理者</option>
                  <option value="member">メンバー</option>
                  <option value="viewer">閲覧者</option>
                </select>
              ) : (
                <span className="badge badge-muted">{ROLE_LABEL[m.wsRole]}</span>
              )}
              {data.isOwner && m.wsRole !== 'owner' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    const ok = await confirm({
                      title: `${m.displayName} にオーナーを移行しますか？`,
                      message: 'オーナーは各ワークスペースに 1 人だけです。移行すると、現在のオーナーは「管理者」になります。',
                      confirmLabel: 'オーナーを移行',
                    });
                    if (ok) member(() => api(`/workspaces/${id}/transfer`, { body: { userId: m.id } }), 'オーナーを移行しました');
                  }}
                >
                  オーナーにする
                </Button>
              )}
              {manage && m.id !== user?.id && m.wsRole !== 'owner' && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  onClick={async () => {
                    const ok = await confirm({
                      title: `${m.displayName} をワークスペースから外しますか？`,
                      message: 'この人のプライベートページは削除されます。共有ページは残ります。',
                      confirmLabel: '外す',
                      danger: true,
                    });
                    if (ok) member(() => api(`/workspaces/${id}/members/${m.id}`, { method: 'DELETE' }), 'メンバーを外しました');
                  }}
                >
                  外す
                </Button>
              )}
            </div>
          ))}
        </div>
      </section>

      {manage && !adminMode && <GithubCard workspaceId={id} />}

      {!adminMode && <ExportCard workspaceId={id} name={w.name} />}

      <section className="card danger-zone">
        <h2>危険な操作</h2>
        {!adminMode && w.role && w.role !== 'owner' && (
          <div className="setting-row">
            <div>
              <div className="list-title">ワークスペースから退出</div>
              <div className="muted small">あなたのプライベートページは削除されます。</div>
            </div>
            <Button variant="danger" onClick={leave}>
              退出
            </Button>
          </div>
        )}
        {!adminMode && w.role === 'owner' && <p className="muted small">オーナーは退出できません。退出するには、先に別のメンバーにオーナーを移行してください。</p>}
        {data.isOwner && (
          <div className="setting-row">
            <div>
              <div className="list-title">ワークスペースを削除</div>
              <div className="muted small">すべてのページが完全に削除されます。</div>
            </div>
            <Button variant="danger" onClick={remove}>
              削除
            </Button>
          </div>
        )}
      </section>

      {emojiAnchor && (
        <EmojiPicker
          anchor={emojiAnchor}
          onPick={(e) => {
            setEmojiAnchor(null);
            patch({ iconEmoji: e }, 'アイコンを変更しました');
          }}
          onClose={() => setEmojiAnchor(null)}
        />
      )}
      <AddMembersModal workspaceId={id} open={addOpen} onClose={() => setAddOpen(false)} onAdded={() => Promise.all([load(), ws.reloadWorkspaces()])} />
    </div>
  );
}

function AddMembersModal({ workspaceId, open, onClose, onAdded }: { workspaceId: string; open: boolean; onClose: () => void; onAdded: () => void }) {
  const { toast } = useUi();
  const [users, setUsers] = useState<User[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<'member' | 'viewer' | 'admin'>('member');

  useEffect(() => {
    if (!open) return;
    setRole('member');
    setSelected(new Set());
    setFilter('');
    setUsers(null);
    api<{ users: User[] }>(`/workspaces/${workspaceId}/candidates`)
      .then((r) => setUsers(r.users))
      .catch((e) => toast(e.message, 'error'));
  }, [open, workspaceId, toast]);

  const shown = users?.filter((u) => `${u.displayName} ${u.username}`.toLowerCase().includes(filter.toLowerCase())) ?? [];

  const add = async () => {
    setBusy(true);
    try {
      await api(`/workspaces/${workspaceId}/members`, { body: { userIds: [...selected], role } });
      toast(`${selected.size} 人を追加しました`, 'success');
      onAdded();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="メンバーを追加" width={460}>
      <div className="modal-body">
        <input className="input" autoFocus placeholder="名前で絞り込み…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="move-list">
          {!users ? (
            <Spinner />
          ) : shown.length === 0 ? (
            <div className="empty small">追加できるユーザーがいません。新しいユーザーはサーバー管理者が発行します。</div>
          ) : (
            shown.map((u) => (
              <label key={u.id} className="move-item check-item">
                <input
                  type="checkbox"
                  checked={selected.has(u.id)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(u.id);
                    else next.delete(u.id);
                    setSelected(next);
                  }}
                />
                <UserAvatar user={u} size={24} />
                <span className="ellipsis">{u.displayName}</span>
                <span className="muted small">@{u.username}</span>
                {u.status === 'pending' && <span className="badge badge-warn">登録待ち</span>}
              </label>
            ))
          )}
        </div>
        <div className="modal-actions">
          <select className="input select-sm" value={role} onChange={(e) => setRole(e.target.value as typeof role)} style={{ marginRight: 'auto' }}>
            <option value="member">メンバーとして追加</option>
            <option value="viewer">閲覧者として追加</option>
            <option value="admin">管理者として追加</option>
          </select>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button variant="primary" disabled={selected.size === 0} loading={busy} onClick={add}>
            {selected.size > 0 ? `${selected.size} 人を追加` : '追加'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

type GithubLinkInfo = {
  repo: string;
  branch: string;
  rootPath: string;
  rootPageId: string | null;
  url: string;
  lastSyncAt: number | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
};
type SyncResult = { created: number; updated: number; removed: number; pushed: number; conflicts: number; pending: number };

/** GitHub リポジトリとの連携（オーナー・管理者のみ） */
function GithubCard({ workspaceId }: { workspaceId: string }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { toast, confirm } = useUi();
  const [link, setLink] = useState<GithubLinkInfo | null | undefined>(undefined);
  const [form, setForm] = useState({ repo: '', branch: '', rootPath: '', token: '' });
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(false);

  const load = async () => {
    const r = await api<{ link: GithubLinkInfo | null }>(`/github/workspaces/${workspaceId}`);
    setLink(r.link);
    if (r.link) setForm({ repo: r.link.repo, branch: r.link.branch, rootPath: r.link.rootPath, token: '' });
  };
  useEffect(() => {
    load().catch((e) => toast(e.message, 'error'));
  }, [workspaceId]);

  // 取り込みは 1 回あたりの件数に上限があるので、残りがなくなるまで繰り返す
  const runSync = async (first?: SyncResult) => {
    const total = first ?? { created: 0, updated: 0, removed: 0, pushed: 0, conflicts: 0, pending: 0 };
    let pending = first?.pending ?? 1;
    for (let i = 0; pending > 0 && i < 40; i++) {
      setBusy(`同期中…${total.created + total.updated > 0 ? `（${total.created + total.updated} 件取り込み済み）` : ''}`);
      const r = await api<{ link: GithubLinkInfo; result: SyncResult }>(`/github/workspaces/${workspaceId}/sync`, { method: 'POST' });
      for (const k of Object.keys(total) as (keyof SyncResult)[]) if (k !== 'pending') total[k] += r.result[k];
      pending = r.result.pending;
      setLink(r.link);
    }
    await ws.reload();
    toast(`GitHub と同期しました（追加 ${total.created}・更新 ${total.updated}・削除 ${total.removed}・送信 ${total.pushed}）`, 'success');
  };

  const connect = async () => {
    setBusy('接続中…');
    try {
      const r = await api<{ link: GithubLinkInfo; result: SyncResult }>(`/github/workspaces/${workspaceId}`, {
        method: 'PUT',
        body: { repo: form.repo.trim(), branch: form.branch.trim(), rootPath: form.rootPath.trim(), ...(form.token.trim() ? { token: form.token.trim() } : {}) },
      });
      setLink(r.link);
      setForm((f) => ({ ...f, token: '' }));
      setEditing(false);
      await runSync(r.result);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  const sync = async () => {
    try {
      await runSync();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  const unlink = async () => {
    const ok = await confirm({
      title: 'GitHub との連携を解除しますか？',
      message: '取り込んだページは通常のページとして残ります。GitHub 上のファイルは変更されません。',
      confirmLabel: '連携を解除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/github/workspaces/${workspaceId}`, { method: 'DELETE' });
      setLink(null);
      setForm({ repo: '', branch: '', rootPath: '', token: '' });
      await ws.reload();
      toast('GitHub との連携を解除しました', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  if (link === undefined) return null;
  const showForm = !link || editing;
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>
            <Icon name="github" size={18} /> GitHub 連携
          </h2>
          <p className="muted small">
            リポジトリのフォルダと Markdown をページとして取り込み、アプリでの編集を GitHub にコミットします（10 分ごとに自動で同期）。
            Markdown 以外のファイルは、開いたときに GitHub から取得して表示します。
          </p>
        </div>
      </div>
      {link && !editing && (
        <div className="setting-row">
          <div>
            <div>
              <a href={link.url} target="_blank" rel="noreferrer">
                {link.repo}
              </a>
              <span className="muted">（{link.branch}{link.rootPath ? ` / ${link.rootPath}` : ''}）</span>
            </div>
            <div className="muted small">
              {link.lastSyncAt ? `最終同期 ${formatRelative(link.lastSyncAt)}` : 'まだ同期していません'}
              {link.lastSyncStatus === 'error' && link.lastSyncError ? `・エラー: ${link.lastSyncError}` : link.lastSyncStatus && link.lastSyncStatus !== 'ok' ? `・${link.lastSyncStatus}` : ''}
            </div>
          </div>
          <div className="inline-form">
            {link.rootPageId && (
              <Button size="sm" variant="ghost" onClick={() => navigate(`/p/${link.rootPageId}`)}>
                ページを開く
              </Button>
            )}
            <Button size="sm" onClick={sync} disabled={!!busy}>
              {busy || '今すぐ同期'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={!!busy}>
              設定を変更
            </Button>
            <Button size="sm" variant="danger" onClick={unlink} disabled={!!busy}>
              連携を解除
            </Button>
          </div>
        </div>
      )}
      {showForm && (
        <>
          <label className="field">
            <span>リポジトリ（ユーザー名/リポジトリ名）</span>
            <input value={form.repo} placeholder="owner/repository" onChange={(e) => setForm({ ...form, repo: e.target.value })} />
          </label>
          <div className="inline-form">
            <label className="field" style={{ flex: 1 }}>
              <span>ブランチ（空欄なら既定のブランチ）</span>
              <input value={form.branch} placeholder="main" onChange={(e) => setForm({ ...form, branch: e.target.value })} />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>フォルダ（空欄ならリポジトリ全体）</span>
              <input value={form.rootPath} placeholder="notes" onChange={(e) => setForm({ ...form, rootPath: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span>アクセストークン{link ? '（変更する場合のみ入力）' : ''}</span>
            <input
              type="password"
              autoComplete="off"
              value={form.token}
              placeholder="github_pat_…"
              onChange={(e) => setForm({ ...form, token: e.target.value })}
            />
            <span className="muted small">
              GitHub の Settings → Developer settings → Fine-grained tokens で、このリポジトリのみを対象に「Contents: Read and write」を許可したトークンを作成してください。トークンは暗号化して保存され、画面には表示されません。
            </span>
          </label>
          <div className="inline-form">
            <Button variant="primary" onClick={connect} disabled={!!busy || !form.repo.trim() || (!link && !form.token.trim())}>
              {busy || (link ? '保存して同期' : '接続して取り込む')}
            </Button>
            {editing && (
              <Button variant="ghost" onClick={() => setEditing(false)} disabled={!!busy}>
                キャンセル
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** まるごと書き出し：見られるページをすべて Markdown にして、ファイルと一緒に ZIP にする */
function ExportCard({ workspaceId, name }: { workspaceId: string; name: string }) {
  const { toast } = useUi();
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const run = async () => {
    setProgress({ done: 0, total: 0, label: '準備しています' });
    try {
      const { exportWorkspace } = await import('./exportAll');
      const r = await exportWorkspace(workspaceId, name, setProgress);
      toast(`${r.pages} ページ・${r.files} ファイルを書き出しました${r.failed ? `（${r.failed} ページは読み込めませんでした）` : ''}`, r.failed ? 'info' : 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setProgress(null);
    }
  };
  return (
    <section className="card">
      <h2>まるごと書き出し</h2>
      <div className="setting-row">
        <div>
          <div className="list-title">すべてのページを ZIP で保存</div>
          <div className="muted small">あなたが見られるページを Markdown にして、ページの並びのとおりにフォルダへ分けます。貼ってあるファイルも一緒に入ります。</div>
          {progress && (
            <div className="export-progress">
              <progress max={Math.max(1, progress.total)} value={progress.done} />
              <span className="muted small">
                {progress.total ? `${progress.done} / ${progress.total}　` : ''}
                {progress.label}
              </span>
            </div>
          )}
        </div>
        <Button onClick={() => void run()} disabled={!!progress}>
          {progress ? '書き出し中…' : '書き出す'}
        </Button>
      </div>
    </section>
  );
}
