import type { AuditLog, RegistrationLink, User } from '../api';
import { Button, CopyField, formatDateTime, formatRelative, Icon, Modal } from '../ui';

export const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'ログイン',
  'auth.login_failed': 'ログイン失敗',
  'auth.logout': 'ログアウト',
  'auth.qr_approve': 'スマホでログインを承認',
  'auth.qr_approve_failed': 'スマホでの承認に失敗',
  'passkey.register': 'パスキー登録（リンク経由）',
  'passkey.add': 'パスキー追加',
  'passkey.delete': 'パスキー削除',
  'passkey.revoke': 'パスキー失効（管理者）',
  'user.create': 'ユーザー作成',
  'user.update': 'ユーザー更新',
  'user.delete': 'ユーザー削除',
  'link.issue': '登録リンク発行',
  'link.revoke': '登録リンク無効化',
  'session.revoke': 'セッション失効',
  'session.revoke_all': '全セッション失効',
  'settings.update': '設定変更',
  'page.publish': 'ページを公開',
  'workspace.create': 'ワークスペース作成',
  'group.create': 'グループ作成',
  'group.update': 'グループ更新',
  'group.delete': 'グループ削除',
  'group.member_add': 'グループにメンバー追加',
  'group.member_remove': 'グループからメンバー削除',
  'page.share': 'ページを共有',
  'page.unshare': 'ページの共有を解除',
  'workspace.update': 'ワークスペース更新',
  'workspace.delete': 'ワークスペース削除',
  'workspace.member_add': 'メンバー追加',
  'workspace.member_remove': 'メンバー削除',
  'workspace.member_role': 'メンバー権限変更',
  'workspace.leave': 'ワークスペース退出',
  'workspace.transfer': 'オーナー移行',
  'page.unpublish': 'ページの公開停止',
};

const FAIL_REASONS: Record<string, string> = {
  unknown_credential: '未登録のパスキー',
  other_user: '別のアカウントのパスキー',
  unknown_user: '存在しないアカウント',
  user_handle_mismatch: 'ユーザー不一致',
  verification_error: '署名検証エラー',
  not_verified: '検証失敗',
  user_disabled: 'アカウント無効',
  user_pending: '未登録アカウント',
};

export function actionTone(action: string) {
  if (action === 'auth.login_failed' || action === 'auth.qr_approve_failed' || action.endsWith('.delete') || action.endsWith('revoke') || action.endsWith('revoke_all')) return 'danger';
  if (action.startsWith('auth.')) return 'muted';
  return 'info';
}

export function describeDetail(log: AuditLog) {
  if (!log.detail) return '';
  try {
    const d = JSON.parse(log.detail) as Record<string, unknown>;
    const parts: string[] = [];
    if (d.reason) parts.push(FAIL_REASONS[String(d.reason)] ?? String(d.reason));
    if (d.role) parts.push(`権限: ${d.role === 'admin' ? '管理者' : 'メンバー'}`);
    if (d.status) parts.push(`状態: ${STATUS_LABELS[d.status as User['status']] ?? d.status}`);
    if (d.displayName) parts.push(`表示名: ${d.displayName}`);
    if (d.previousUsername) parts.push(`ユーザーID: @${d.previousUsername} → @${d.username}`);
    if (d.purpose) parts.push(d.purpose === 'invite' ? '招待' : '復旧');
    if (d.bootstrap) parts.push('初期セットアップ');
    if (d.resetAvatar) parts.push('アイコンをリセット');
    if (d.byAdmin) parts.push('管理者による停止');
    if (d.member) parts.push(`対象: ${d.member}`);
    if (d.group) parts.push(`グループ: ${d.group}`);
    if (typeof d.deletedPages === 'number') parts.push(`ページ ${d.deletedPages} 件を削除`);
    if (d.workspaceCreation) parts.push(`ワークスペース作成: ${d.workspaceCreation === 'everyone' ? '全員' : '管理者のみ'}`);
    if (d.publishPolicy) parts.push(`外部公開: ${({ everyone: '全員', admins: '管理者のみ', disabled: '無効' } as Record<string, string>)[String(d.publishPolicy)]}`);
    if (d.via === 'cli') parts.push('CLI');
    if (typeof d.transferredPages === 'number') parts.push(`共有ページ ${d.transferredPages} 件を引継ぎ / 個人ページ ${d.deletedPrivatePages} 件を削除`);
    if (d.serviceName || d.workspaceName) parts.push(`サービス名: ${d.serviceName ?? d.workspaceName}`);
    if (d.inviteExpiryHours) parts.push(`リンク有効期限: ${d.inviteExpiryHours}時間`);
    if (d.sessionDays) parts.push(`セッション: ${d.sessionDays}日`);
    return parts.join('、');
  } catch {
    return '';
  }
}

export function AuditTable({ logs, compact }: { logs: AuditLog[]; compact?: boolean }) {
  if (logs.length === 0) return <div className="empty small">記録はありません</div>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>日時</th>
            <th>操作</th>
            <th>実行者</th>
            <th>対象</th>
            {!compact && <th>詳細</th>}
            {!compact && <th>IP</th>}
          </tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id}>
              <td className="nowrap" title={formatDateTime(l.at)}>
                {compact ? formatRelative(l.at) : formatDateTime(l.at)}
              </td>
              <td>
                <span className={`badge badge-${actionTone(l.action)}`}>{ACTION_LABELS[l.action] ?? l.action}</span>
              </td>
              <td>{l.actor_name ?? (l.ip === 'cli' ? 'システム' : '—')}</td>
              <td>{l.target_name ?? (l.target_type === 'settings' ? 'ワークスペース' : '—')}</td>
              {!compact && <td className="muted small">{describeDetail(l)}</td>}
              {!compact && <td className="muted small nowrap">{l.ip}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const STATUS_LABELS: Record<User['status'], string> = {
  pending: '登録待ち',
  active: '有効',
  disabled: '無効',
};

export function StatusBadge({ status }: { status: User['status'] }) {
  const tone = status === 'active' ? 'success' : status === 'pending' ? 'warn' : 'danger';
  return <span className={`badge badge-${tone}`}>{STATUS_LABELS[status]}</span>;
}

export function RoleBadge({ role }: { role: User['role'] }) {
  return role === 'admin' ? (
    <span className="badge badge-info">
      <Icon name="shield" size={11} /> 管理者
    </span>
  ) : (
    <span className="badge badge-muted">メンバー</span>
  );
}

export function LinkResultModal({
  link,
  user,
  onClose,
}: {
  link: RegistrationLink | null;
  user: Pick<User, 'displayName' | 'username'> | null;
  onClose: () => void;
}) {
  return (
    <Modal open={!!link} onClose={onClose} title="パスキー登録リンクを発行しました" width={560}>
      {link && (
        <div className="modal-body">
          <p>
            <strong>{user?.displayName}</strong>（@{user?.username}）に以下のリンクを安全な方法で共有してください。
            リンクを開いた端末でパスキーが作成されます。
          </p>
          <CopyField value={link.url} />
          <div className="alert alert-warn">
            <Icon name="lock" size={14} />
            <div>
              このリンクは<strong>今回しか表示されません</strong>（サーバーにはハッシュのみ保存されます）。
              <br />
              有効期限: {formatDateTime(link.expiresAt)}／1回のみ使用可能。紛失した場合は再発行してください（古いリンクは自動で無効になります）。
            </div>
          </div>
          <div className="modal-actions">
            <Button variant="primary" onClick={onClose}>
              閉じる
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
