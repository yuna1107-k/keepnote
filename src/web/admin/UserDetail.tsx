import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, uploadFile, type AuditLog, type Passkey, type RegistrationLink, type SessionInfo, type User } from '../api';
import { EmojiPicker } from '../workspace/EmojiPicker';
import { useAuth } from '../auth/AuthContext';
import { PasskeyList } from '../workspace/AccountSettings';
import { AVATAR_COLORS, Button, describeUserAgent, formatDateTime, formatRelative, Icon, Spinner, squareImage, useUi, UserAvatar } from '../ui';
import { AuditTable, LinkResultModal, RoleBadge, StatusBadge } from './common';
import { UserWorkspaces } from './Workspaces';
import { UserPageAccess } from './PageAccess';

type LinkInfo = {
  id: string;
  purpose: 'invite' | 'recovery';
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
  createdBy: string | null;
  state: 'active' | 'used' | 'revoked' | 'expired';
};

type Detail = {
  user: User & { updatedAt: number };
  pages: number;
  passkeys: Passkey[];
  sessions: SessionInfo[];
  links: LinkInfo[];
  activity: AuditLog[];
};

const LINK_STATE: Record<LinkInfo['state'], { label: string; tone: string }> = {
  active: { label: '有効', tone: 'warn' },
  used: { label: '使用済み', tone: 'success' },
  revoked: { label: '無効化', tone: 'muted' },
  expired: { label: '期限切れ', tone: 'muted' },
};

export default function UserDetail() {
  const { id } = useParams();
  const { user: self } = useAuth();
  const navigate = useNavigate();
  const { toast, confirm } = useUi();
  const [data, setData] = useState<Detail | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [issued, setIssued] = useState<RegistrationLink | null>(null);
  const [busy, setBusy] = useState('');
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    const d = await api<Detail>(`/admin/users/${id}`);
    setData(d);
    setDisplayName(d.user.displayName);
    setUsername(d.user.username);
  };

  useEffect(() => {
    load().catch((e) => toast(e.message, 'error'));
  }, [id]);

  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await fn();
      if (success) toast(success, 'success');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  if (!data) return <Spinner center />;
  const u = data.user;
  const isSelf = u.id === self?.id;

  const update = (body: Partial<{ displayName: string; username: string; role: string; status: string; resetAvatar: true; avatarEmoji: string; avatarColor: string }>, msg: string) =>
    run('update', () => api(`/admin/users/${u.id}`, { method: 'PATCH', body }), msg);

  const issueLink = async () => {
    if (u.status === 'active') {
      const ok = await confirm({
        title: '復旧用の登録リンクを発行しますか？',
        message: 'リンクを開いた人は、このユーザーとして新しいパスキーを登録しログインできます。本人確認を済ませた上で、本人にのみ共有してください。',
        confirmLabel: '発行する',
      });
      if (!ok) return;
    }
    await run('link', async () => {
      const r = await api<{ link: RegistrationLink }>(`/admin/users/${u.id}/registration-links`, { body: {} });
      setIssued(r.link);
    });
  };

  const toggleDisabled = async () => {
    if (u.status === 'disabled') return update({ status: 'active' }, 'ユーザーを有効化しました');
    const ok = await confirm({
      title: `${u.displayName} を無効化しますか？`,
      message: 'すべてのセッションが即座に終了し、ログインできなくなります。ページは残ります。',
      confirmLabel: '無効化',
      danger: true,
    });
    if (ok) update({ status: 'disabled' }, 'ユーザーを無効化しました');
  };

  const changeRole = async () => {
    const next = u.role === 'admin' ? 'member' : 'admin';
    const ok = await confirm({
      title: next === 'admin' ? '管理者に昇格しますか？' : 'メンバーに変更しますか？',
      message: next === 'admin' ? '管理者はユーザーの発行・削除やパスキーの失効など、すべての管理操作を行えます。' : '管理者画面にアクセスできなくなります。',
      confirmLabel: '変更',
    });
    if (ok) update({ role: next }, '権限を変更しました');
  };

  const deleteUser = async () => {
    const ok = await confirm({
      title: 'ユーザーを削除しますか？',
      message: (
        <>
          <p>
            このユーザーのパスキー・セッションはすべて削除されます。ワークスペース（共有）のページは<strong>あなたに引き継がれ</strong>、
            プライベートページは<strong>完全に削除</strong>されます。この操作は元に戻せません。
          </p>
        </>
      ),
      confirmLabel: '削除',
      danger: true,
      requireText: u.username,
    });
    if (!ok) return;
    try {
      await api(`/admin/users/${u.id}`, { method: 'DELETE' });
      toast('ユーザーを削除しました', 'success');
      navigate('/admin/users');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="admin-page">
      <Link to="/admin/users" className="back-link small">
        <Icon name="arrowLeft" size={14} /> ユーザー一覧
      </Link>
      <div className="admin-header">
        <div className="user-head">
          <UserAvatar user={u} size={48} />
          <div>
            <h1>
              {u.displayName} {isSelf && <span className="badge badge-muted">あなた</span>}
            </h1>
            <div className="user-head-meta">
              <span className="muted">@{u.username}</span>
              <RoleBadge role={u.role} />
              <StatusBadge status={u.status} />
            </div>
          </div>
        </div>
        <Button variant="primary" onClick={issueLink} loading={busy === 'link'} disabled={u.status === 'disabled'}>
          <Icon name="link" /> {u.status === 'pending' ? '招待リンクを再発行' : '復旧用リンクを発行'}
        </Button>
      </div>

      {u.status === 'pending' && (
        <div className="alert alert-warn">
          このユーザーはまだパスキーを登録していません。登録リンクを本人に共有してください（紛失した場合は再発行できます）。
        </div>
      )}

      <div className="detail-grid">
        <section className="card">
          <h2>基本情報</h2>
          <dl className="dl">
            <dt>作成日時</dt>
            <dd>{formatDateTime(u.createdAt)}</dd>
            <dt>最終ログイン</dt>
            <dd>{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : '未ログイン'}</dd>
            <dt>作成したページ</dt>
            <dd>{data.pages} 件</dd>
          </dl>
          <label className="field">
            <span>ユーザーID（英数字と . _ -、2〜32文字）</span>
            <div className="inline-form">
              <input value={username} maxLength={32} onChange={(e) => setUsername(e.target.value.trim())} />
              <Button
                onClick={async () => {
                  const ok = await confirm({
                    title: 'ユーザーIDを変更しますか？',
                    message: `@${u.username} → @${username}。ログインはパスキーで行うため影響はありません。パスキー管理アプリに表示される名前は、本人がパスキーを登録し直すまで古いIDのままです。`,
                    confirmLabel: '変更',
                  });
                  if (ok) update({ username }, 'ユーザーIDを変更しました');
                }}
                disabled={!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/.test(username) || username === u.username}
                loading={busy === 'update'}
              >
                変更
              </Button>
            </div>
          </label>
          <label className="field">
            <span>表示名</span>
            <div className="inline-form">
              <input value={displayName} maxLength={64} onChange={(e) => setDisplayName(e.target.value)} />
              <Button
                onClick={() => update({ displayName }, '表示名を変更しました')}
                disabled={!displayName.trim() || displayName === u.displayName}
                loading={busy === 'update'}
              >
                保存
              </Button>
            </div>
          </label>
        </section>

        <section className="card">
          <h2>権限と状態</h2>
          <div className="setting-row">
            <div>
              <div className="list-title">権限</div>
              <div className="muted small">{u.role === 'admin' ? '管理者：すべての管理操作が可能' : 'メンバー：ページの閲覧・編集のみ'}</div>
            </div>
            <Button onClick={changeRole} disabled={isSelf}>
              {u.role === 'admin' ? 'メンバーに変更' : '管理者に昇格'}
            </Button>
          </div>
          <div className="setting-row">
            <div>
              <div className="list-title">アカウント</div>
              <div className="muted small">{u.status === 'disabled' ? 'ログインできません' : '無効化するとログインできなくなります'}</div>
            </div>
            <Button variant={u.status === 'disabled' ? 'primary' : 'danger'} onClick={toggleDisabled} disabled={isSelf || u.status === 'pending'}>
              {u.status === 'disabled' ? '有効化' : '無効化'}
            </Button>
          </div>
          <div className="setting-row admin-avatar-row">
            <div>
              <div className="list-title">アイコン</div>
              <div className="muted small">画像・絵文字・背景色を設定するか、初期状態（頭文字）に戻せます</div>
            </div>
            <div className="admin-avatar-actions">
              <Button size="sm" onClick={() => avatarInput.current?.click()} loading={busy === 'avatar'}>
                <Icon name="image" size={14} /> 画像
              </Button>
              <Button size="sm" onClick={(e) => setEmojiAnchor(e.currentTarget)}>
                <Icon name="smile" size={14} /> 絵文字
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!u.avatarUrl && !u.avatarEmoji && !u.avatarColor}
                onClick={async () => {
                  const ok = await confirm({ title: 'アイコンをリセットしますか？', message: 'アップロードされた画像は削除されます。', confirmLabel: 'リセット', danger: true });
                  if (ok) update({ resetAvatar: true }, 'アイコンをリセットしました');
                }}
              >
                リセット
              </Button>
              <input
                ref={avatarInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  setBusy('avatar');
                  try {
                    const url = await uploadFile(await squareImage(file));
                    await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { avatarFileId: url.split('/').pop() } });
                    toast('アイコンを変更しました', 'success');
                    await load();
                  } catch (err) {
                    toast((err as Error).message, 'error');
                  } finally {
                    setBusy('');
                  }
                }}
              />
            </div>
          </div>
          <div className="color-swatches admin-avatar-colors">
            {AVATAR_COLORS.map((c) => (
              <button key={c} className={`swatch ${u.avatarColor === c ? 'active' : ''}`} style={{ background: c }} aria-label={c} onClick={() => update({ avatarColor: c }, '背景色を変更しました')} />
            ))}
          </div>
          {emojiAnchor && (
            <EmojiPicker
              anchor={emojiAnchor}
              onPick={(emoji) => {
                setEmojiAnchor(null);
                update({ avatarEmoji: emoji }, 'アイコンを変更しました');
              }}
              onClose={() => setEmojiAnchor(null)}
            />
          )}
          {isSelf && <p className="muted small">自分自身の権限や状態は変更できません。</p>}
        </section>
      </div>

      <section className="card">
        <h2>所属ワークスペース</h2>
        <UserWorkspaces userId={u.id} />
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>閲覧できるページ</h2>
            <p className="muted small">このユーザーがアクセスできるページと権限（閲覧のみ／編集可）を設定します。</p>
          </div>
        </div>
        <UserPageAccess key={u.id} userId={u.id} />
      </section>

      <section className="card">
        <div className="card-head">
          <h2>パスキー（{data.passkeys.length}）</h2>
        </div>
        <PasskeyList
          passkeys={data.passkeys}
          canDeleteLast
          onDelete={async (p) => {
            const ok = await confirm({
              title: 'パスキーを失効させますか？',
              message:
                data.passkeys.length <= 1
                  ? `「${p.name}」はこのユーザーの最後のパスキーです。失効させると、新しい登録リンクを発行するまでログインできなくなります。`
                  : `「${p.name}」ではログインできなくなります。`,
              confirmLabel: '失効',
              danger: true,
            });
            if (ok) run('pk', () => api(`/admin/users/${u.id}/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE' }), 'パスキーを失効させました');
          }}
        />
      </section>

      <section className="card">
        <div className="card-head">
          <h2>アクティブなセッション（{data.sessions.length}）</h2>
          <Button
            size="sm"
            variant="danger"
            disabled={data.sessions.length === 0}
            onClick={async () => {
              const ok = await confirm({ title: 'すべてのセッションを終了しますか？', message: 'このユーザーはすべての端末からログアウトされます。', confirmLabel: '終了', danger: true });
              if (ok) run('sess', () => api(`/admin/users/${u.id}/sessions`, { method: 'DELETE' }), 'セッションを終了しました');
            }}
          >
            すべて終了
          </Button>
        </div>
        {data.sessions.length === 0 ? (
          <div className="empty small">アクティブなセッションはありません</div>
        ) : (
          <div className="list">
            {data.sessions.map((s) => (
              <div key={s.id} className="list-row">
                <div className="list-icon">
                  <Icon name="globe" />
                </div>
                <div className="list-main">
                  <div className="list-title">{describeUserAgent(s.userAgent)}</div>
                  <div className="muted small">
                    {s.ip} ／ ログイン {formatDateTime(s.createdAt)} ／ 最終アクセス {formatRelative(s.lastSeenAt)}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => run('sess', () => api(`/admin/sessions/${s.id}`, { method: 'DELETE' }), 'セッションを終了しました')}>
                  終了
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>登録リンクの履歴</h2>
        {data.links.length === 0 ? (
          <div className="empty small">発行履歴はありません</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>種類</th>
                  <th>状態</th>
                  <th>発行</th>
                  <th>有効期限</th>
                  <th>発行者</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.links.map((l) => (
                  <tr key={l.id}>
                    <td>{l.purpose === 'invite' ? '招待' : '復旧'}</td>
                    <td>
                      <span className={`badge badge-${LINK_STATE[l.state].tone}`}>{LINK_STATE[l.state].label}</span>
                    </td>
                    <td className="nowrap">{formatDateTime(l.createdAt)}</td>
                    <td className="nowrap">{l.usedAt ? `使用: ${formatDateTime(l.usedAt)}` : formatDateTime(l.expiresAt)}</td>
                    <td>{l.createdBy ?? 'システム'}</td>
                    <td>
                      {l.state === 'active' && (
                        <Button size="sm" variant="ghost" onClick={() => run('link', () => api(`/admin/registration-links/${l.id}`, { method: 'DELETE' }), 'リンクを無効化しました')}>
                          無効化
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>アクティビティ</h2>
        <AuditTable logs={data.activity} />
      </section>

      <section className="card danger-zone">
        <h2>危険な操作</h2>
        <div className="setting-row">
          <div>
            <div className="list-title">ユーザーを削除</div>
            <div className="muted small">共有ページはあなたに引き継がれ、プライベートページは削除されます。</div>
          </div>
          <Button variant="danger" onClick={deleteUser} disabled={isSelf}>
            ユーザーを削除
          </Button>
        </div>
      </section>

      <LinkResultModal link={issued} user={u} onClose={() => setIssued(null)} />
    </div>
  );
}
