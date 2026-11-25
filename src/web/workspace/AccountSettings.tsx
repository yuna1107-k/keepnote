import { useEffect, useRef, useState } from 'react';
import { api, uploadFile, type Passkey, type SessionInfo, type Theme, type User } from '../api';
import { useAuth } from '../auth/AuthContext';
import { addPasskey, guessDeviceName, passkeyErrorMessage } from '../auth/passkey';
import {
  AVATAR_COLORS,
  Button,
  describeUserAgent,
  formatDateTime,
  formatRelative,
  Icon,
  Modal,
  Spinner,
  squareImage,
  useUi,
  UserAvatar,
} from '../ui';
import { EmojiPicker } from './EmojiPicker';
import { InstallCard } from './InstallCard';

type ProfilePatch = Partial<{ displayName: string; avatarFileId: string | null; avatarEmoji: string | null; avatarColor: string | null; theme: Theme }>;

function useProfileUpdate() {
  const { setUser } = useAuth();
  const { toast } = useUi();
  return async (patch: ProfilePatch, message?: string) => {
    try {
      const { user } = await api<{ user: User }>('/me', { method: 'PATCH', body: patch });
      setUser(user);
      if (message) toast(message, 'success');
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    }
  };
}

function ProfileCard() {
  const { user } = useAuth();
  const { toast } = useUi();
  const update = useProfileUpdate();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  if (!user) return null;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('画像ファイルを選択してください', 'error');
      return;
    }
    setUploading(true);
    try {
      const square = await squareImage(file);
      const url = await uploadFile(square);
      await update({ avatarFileId: url.split('/').pop()! }, 'アイコンを変更しました');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const hasCustom = !!(user.avatarUrl || user.avatarEmoji || user.avatarColor);

  return (
    <section className="card">
      <h2>プロフィール</h2>
      <div className="profile-row">
        <div className="avatar-editor">
          <UserAvatar user={user} size={88} />
          {uploading && (
            <div className="avatar-editor-busy">
              <Spinner />
            </div>
          )}
        </div>
        <div className="avatar-controls">
          <div className="avatar-buttons">
            <Button size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
              <Icon name="file" size={14} /> 画像をアップロード
            </Button>
            <Button size="sm" onClick={(e) => setEmojiAnchor(e.currentTarget)}>
              <Icon name="smile" size={14} /> 絵文字
            </Button>
            {hasCustom && (
              <Button size="sm" variant="ghost" onClick={() => update({ avatarFileId: null, avatarEmoji: null, avatarColor: null }, 'アイコンを初期状態に戻しました')}>
                リセット
              </Button>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif"
            hidden
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          <div className="color-swatches" role="radiogroup" aria-label="背景色">
            <button
              className={`swatch swatch-auto ${!user.avatarColor ? 'active' : ''}`}
              title="自動"
              aria-label="自動"
              onClick={() => update({ avatarColor: null })}
            />
            {AVATAR_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch ${user.avatarColor === c ? 'active' : ''}`}
                style={{ background: c }}
                aria-label={c}
                onClick={() => update({ avatarColor: c })}
              />
            ))}
          </div>
          <p className="muted small">
            画像は中央で正方形に切り抜かれます。背景色は絵文字・頭文字のアイコンに使われます。
          </p>
        </div>
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

      <div className="form-grid">
        <label className="field">
          <span>ユーザー名</span>
          <input value={user.username} disabled />
        </label>
        <label className="field">
          <span>表示名</span>
          <input value={displayName} maxLength={64} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
      </div>
      <div className="card-actions">
        <Button
          variant="primary"
          loading={saving}
          disabled={!displayName.trim() || displayName === user.displayName}
          onClick={async () => {
            setSaving(true);
            await update({ displayName }, '表示名を更新しました');
            setSaving(false);
          }}
        >
          保存
        </Button>
      </div>
    </section>
  );
}

function AppearanceCard() {
  const { user } = useAuth();
  const update = useProfileUpdate();
  if (!user) return null;
  const options: { value: Theme; label: string }[] = [
    { value: 'system', label: 'システムに合わせる' },
    { value: 'light', label: 'ライト' },
    { value: 'dark', label: 'ダーク' },
  ];
  return (
    <section className="card">
      <h2>表示</h2>
      <div className="setting-row">
        <div>
          <div className="list-title">テーマ</div>
          <div className="muted small">この設定はアカウントに保存され、どの端末でも同じテーマで表示されます。</div>
        </div>
        <div className="segmented">
          {options.map((o) => (
            <button key={o.value} className={user.theme === o.value ? 'active' : ''} onClick={() => update({ theme: o.value })}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

export function PasskeyList({
  passkeys,
  onRename,
  onDelete,
  canDeleteLast = false,
}: {
  passkeys: Passkey[];
  onRename?: (p: Passkey) => void;
  onDelete: (p: Passkey) => void;
  canDeleteLast?: boolean;
}) {
  if (passkeys.length === 0) return <div className="empty small">登録されたパスキーはありません</div>;
  return (
    <div className="list">
      {passkeys.map((p) => (
        <div key={p.id} className="list-row">
          <div className="list-icon">
            <Icon name="key" />
          </div>
          <div className="list-main">
            <div className="list-title">
              {p.name}
              {p.backedUp && <span className="badge badge-muted">同期済み</span>}
            </div>
            <div className="muted small">
              登録: {formatDateTime(p.createdAt)} ／ 最終使用: {p.lastUsedAt ? formatRelative(p.lastUsedAt) : '未使用'}
            </div>
          </div>
          {onRename && (
            <Button size="sm" variant="ghost" onClick={() => onRename(p)}>
              名前を変更
            </Button>
          )}
          <Button size="sm" variant="ghost" className="text-danger" disabled={!canDeleteLast && passkeys.length <= 1} onClick={() => onDelete(p)}>
            削除
          </Button>
        </div>
      ))}
    </div>
  );
}

export default function AccountSettings() {
  const { toast, confirm } = useUi();
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<Passkey | null>(null);
  const [newName, setNewName] = useState('');

  const load = async () => {
    const [p, s] = await Promise.all([
      api<{ passkeys: Passkey[] }>('/me/passkeys'),
      api<{ sessions: SessionInfo[] }>('/me/sessions'),
    ]);
    setPasskeys(p.passkeys);
    setSessions(s.sessions);
  };

  useEffect(() => {
    load().catch((e) => toast(e.message, 'error'));
  }, []);

  const add = async () => {
    setAdding(true);
    try {
      await addPasskey(guessDeviceName());
      toast('パスキーを追加しました', 'success');
      await load();
    } catch (e) {
      toast(passkeyErrorMessage(e), 'error');
    } finally {
      setAdding(false);
    }
  };

  const remove = async (p: Passkey) => {
    const ok = await confirm({
      title: 'パスキーを削除しますか？',
      message: `「${p.name}」ではログインできなくなります。端末やパスワードマネージャー側のパスキーは別途削除してください。`,
      confirmLabel: '削除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/me/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const rename = async () => {
    if (!renaming) return;
    try {
      await api(`/me/passkeys/${encodeURIComponent(renaming.id)}`, { method: 'PATCH', body: { name: newName } });
      setRenaming(null);
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const revokeSession = async (id: string) => {
    await api(`/me/sessions/${id}`, { method: 'DELETE' });
    await load();
  };

  const revokeOthers = async () => {
    const ok = await confirm({ title: '他のすべての端末からログアウトしますか？', confirmLabel: 'ログアウト', danger: true });
    if (!ok) return;
    await api('/me/sessions/revoke-others', { body: {} });
    toast('他の端末からログアウトしました', 'success');
    await load();
  };

  return (
    <div className="settings-page">
      <h1>アカウント設定</h1>

      <ProfileCard />
      <AppearanceCard />
      <InstallCard />

      <section className="card">
        <div className="card-head">
          <div>
            <h2>パスキー</h2>
            <p className="muted small">
              このワークスペースはパスキーでのみログインできます。端末の紛失に備えて、複数の端末にパスキーを登録しておくことをおすすめします。
            </p>
          </div>
          <Button variant="primary" onClick={add} loading={adding}>
            <Icon name="plus" /> パスキーを追加
          </Button>
        </div>
        {passkeys ? (
          <PasskeyList
            passkeys={passkeys}
            onDelete={remove}
            onRename={(p) => {
              setRenaming(p);
              setNewName(p.name);
            }}
          />
        ) : (
          <Spinner />
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>ログイン中の端末</h2>
            <p className="muted small">心当たりのないセッションはログアウトさせてください。</p>
          </div>
          <Button onClick={revokeOthers} disabled={!sessions || sessions.length <= 1}>
            他の端末からログアウト
          </Button>
        </div>
        {sessions ? (
          <div className="list">
            {sessions.map((s) => (
              <div key={s.id} className="list-row">
                <div className="list-icon">
                  <Icon name="globe" />
                </div>
                <div className="list-main">
                  <div className="list-title">
                    {describeUserAgent(s.userAgent)}
                    {s.current && <span className="badge badge-success">この端末</span>}
                  </div>
                  <div className="muted small">
                    {s.ip} ／ ログイン: {formatDateTime(s.createdAt)} ／ 最終アクセス: {formatRelative(s.lastSeenAt)}
                  </div>
                </div>
                {!s.current && (
                  <Button size="sm" variant="ghost" onClick={() => revokeSession(s.id)}>
                    ログアウト
                  </Button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Spinner />
        )}
      </section>

      <Modal open={!!renaming} onClose={() => setRenaming(null)} title="パスキーの名前を変更" width={420}>
        <form
          className="modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            rename();
          }}
        >
          <label className="field">
            <span>名前</span>
            <input autoFocus value={newName} maxLength={64} onChange={(e) => setNewName(e.target.value)} />
          </label>
          <div className="modal-actions">
            <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
              キャンセル
            </Button>
            <Button type="submit" variant="primary" disabled={!newName.trim()}>
              保存
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
