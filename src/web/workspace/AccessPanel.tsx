import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Page, type User } from '../api';
import { Icon, Spinner, useUi, UserAvatar } from '../ui';

type Perm = 'view' | 'edit';
type AccessInfo = {
  canManage: boolean;
  myAccess: 'view' | 'edit' | 'full';
  visibility: 'workspace' | 'private';
  workspaceAccess: Perm;
  restricted: boolean;
  canRestrict: boolean;
  inheritedWorkspace: { pageId: string; title: string; access: Perm } | null;
  owner: User | null;
  shares: { user: User; permission: Perm; guest?: boolean }[];
  inheritedShares: { user: User; permission: Perm; fromPageId: string; fromTitle: string }[];
  members: (User & { isMember: boolean })[];
  groupShares: { group: GroupRef; permission: Perm }[];
  inheritedGroupShares: { group: GroupRef; permission: Perm; fromPageId: string; fromTitle: string }[];
  groups: GroupRef[];
};
type GroupRef = { id: string; name: string; memberCount: number };

export const PERM_LABEL: Record<string, string> = { view: '閲覧のみ', edit: '編集可', full: 'フルアクセス' };

/** ページの共有先（ワークスペース全員 / メンバーごと）を表示・変更する */
export function AccessPanel({ page, onChanged }: { page: Page; onChanged?: () => void }) {
  const { toast } = useUi();
  const [info, setInfo] = useState<AccessInfo | null>(null);
  const [adding, setAdding] = useState('');
  const [addPerm, setAddPerm] = useState<Perm>('view');

  const load = () => api<AccessInfo>(`/pages/${page.id}/access`).then(setInfo);
  useEffect(() => {
    load().catch((e) => toast(e.message, 'error'));
  }, [page.id]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
      onChanged?.();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const setGeneral = (body: Record<string, string | boolean>) => run(() => api(`/pages/${page.id}/access/general`, { method: 'PUT', body }));
  const setUser = (userId: string, permission: Perm | null) =>
    run(() => api(`/pages/${page.id}/access/users/${userId}`, { method: 'PUT', body: { permission } }));
  const setGroup = (groupId: string, permission: Perm | null) =>
    run(() => api(`/pages/${page.id}/access/groups/${groupId}`, { method: 'PUT', body: { permission } }));
  // 招待先：「g:<id>」はグループ、それ以外はアカウント
  const invite = (target: string, permission: Perm) => (target.startsWith('g:') ? setGroup(target.slice(2), permission) : setUser(target, permission));

  if (!info) return <Spinner />;
  const manage = info.canManage;
  const sharedIds = new Set([info.owner?.id, ...info.shares.map((s) => s.user.id)]);
  const candidates = info.members.filter((m) => !sharedIds.has(m.id));
  const sharedGroups = new Set(info.groupShares.map((g) => g.group.id));
  const groupCandidates = info.groups.filter((g) => !sharedGroups.has(g.id));

  return (
    <div className="access-panel">
      {manage && candidates.length === 0 && groupCandidates.length === 0 && (
        <p className="muted small access-note">招待できるアカウントがありません。新しいアカウントは管理者画面で発行できます。</p>
      )}
      {manage && (candidates.length > 0 || groupCandidates.length > 0) && (
        <form
          className="access-invite"
          onSubmit={(e) => {
            e.preventDefault();
            if (adding) invite(adding, addPerm).then(() => setAdding(''));
          }}
        >
          <select className="input" value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">アカウントまたはグループを選んで招待…</option>
            {groupCandidates.length > 0 && (
              <optgroup label="グループ">
                {groupCandidates.map((g) => (
                  <option key={g.id} value={`g:${g.id}`}>
                    {g.name}（{g.memberCount}人）
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="アカウント">
              {candidates.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}（@{m.username}）{m.isMember ? '' : '　— ゲスト（このページ以下のみ）'}
                </option>
              ))}
            </optgroup>
          </select>
          <select className="input select-sm" value={addPerm} onChange={(e) => setAddPerm(e.target.value as Perm)}>
            <option value="view">閲覧のみ</option>
            <option value="edit">編集可</option>
          </select>
          <button className="btn btn-primary btn-sm" disabled={!adding}>
            招待
          </button>
        </form>
      )}

      {(info.canRestrict || info.restricted) && (
        <div className="access-scope">
          <div className="list-main">
            <div className="list-title">アクセスできる人</div>
            <div className="muted small">
              {info.restricted ? '親ページの共有を引き継がず、このページで招待した人だけがアクセスできます。' : '親ページで共有されている人も、このページにアクセスできます。'}
            </div>
          </div>
          {manage ? (
            <select className="input select-sm" value={info.restricted ? 'restricted' : 'inherit'} onChange={(e) => setGeneral({ restricted: e.target.value === 'restricted' })}>
              <option value="inherit">親ページと同じ</option>
              <option value="restricted">招待した人のみ</option>
            </select>
          ) : (
            <span className="muted small">{info.restricted ? '招待した人のみ' : '親ページと同じ'}</span>
          )}
        </div>
      )}

      <div className="access-list">
        <div className="access-row">
          <div className="share-audience-icon">
            <Icon name="users" />
          </div>
          <div className="list-main">
            <div className="list-title">ワークスペースの全員</div>
            <div className="muted small">
              {info.inheritedWorkspace
                ? `親ページ「${info.inheritedWorkspace.title}」から継承（${PERM_LABEL[info.inheritedWorkspace.access]}）`
                : info.visibility === 'workspace'
                  ? 'メンバー全員がアクセスできます'
                  : '招待した人だけがアクセスできます'}
            </div>
          </div>
          {manage && !info.inheritedWorkspace ? (
            <select
              className="input select-sm"
              value={info.visibility === 'workspace' ? info.workspaceAccess : 'none'}
              onChange={(e) =>
                e.target.value === 'none'
                  ? setGeneral({ visibility: 'private' })
                  : setGeneral({ visibility: 'workspace', workspaceAccess: e.target.value })
              }
            >
              <option value="none">アクセス不可</option>
              <option value="view">閲覧のみ</option>
              <option value="edit">編集可</option>
            </select>
          ) : (
            <span className="muted small">
              {info.inheritedWorkspace ? PERM_LABEL[info.inheritedWorkspace.access] : info.visibility === 'workspace' ? PERM_LABEL[info.workspaceAccess] : 'アクセス不可'}
            </span>
          )}
        </div>

        {info.owner && (
          <div className="access-row">
            <UserAvatar user={info.owner} size={28} />
            <div className="list-main">
              <div className="list-title">{info.owner.displayName}</div>
              <div className="muted small">作成者</div>
            </div>
            <span className="muted small">フルアクセス</span>
          </div>
        )}

        {info.shares.map((s) => (
          <div key={s.user.id} className="access-row">
            <UserAvatar user={s.user} size={28} />
            <div className="list-main">
              <div className="list-title">
                {s.user.displayName} {s.guest && <span className="badge badge-warn">ゲスト</span>}
              </div>
              <div className="muted small">@{s.user.username}{s.guest ? '・このページ以下のみ閲覧できます' : ''}</div>
            </div>
            {manage ? (
              <select
                className="input select-sm"
                value={s.permission}
                onChange={(e) => setUser(s.user.id, e.target.value === 'remove' ? null : (e.target.value as Perm))}
              >
                <option value="view">閲覧のみ</option>
                <option value="edit">編集可</option>
                <option value="remove">削除</option>
              </select>
            ) : (
              <span className="muted small">{PERM_LABEL[s.permission]}</span>
            )}
          </div>
        ))}

        {info.groupShares.map((g) => (
          <div key={`g-${g.group.id}`} className="access-row">
            <span className="group-icon">
              <Icon name="users" size={14} />
            </span>
            <div className="list-main">
              <div className="list-title">{g.group.name}</div>
              <div className="muted small">グループ・{g.group.memberCount}人</div>
            </div>
            {manage ? (
              <select className="input select-sm" value={g.permission} onChange={(e) => setGroup(g.group.id, e.target.value === 'remove' ? null : (e.target.value as Perm))}>
                <option value="view">閲覧のみ</option>
                <option value="edit">編集可</option>
                <option value="remove">削除</option>
              </select>
            ) : (
              <span className="muted small">{PERM_LABEL[g.permission]}</span>
            )}
          </div>
        ))}

        {info.inheritedGroupShares.map((g) => (
          <div key={`gi-${g.fromPageId}-${g.group.id}`} className="access-row inherited">
            <span className="group-icon">
              <Icon name="users" size={14} />
            </span>
            <div className="list-main">
              <div className="list-title">{g.group.name}</div>
              <div className="muted small">
                <Link to={`/p/${g.fromPageId}`}>「{g.fromTitle}」</Link>から継承
              </div>
            </div>
            <span className="muted small">{PERM_LABEL[g.permission]}</span>
          </div>
        ))}

        {info.inheritedShares.map((s) => (
          <div key={`${s.fromPageId}-${s.user.id}`} className="access-row inherited">
            <UserAvatar user={s.user} size={28} />
            <div className="list-main">
              <div className="list-title">{s.user.displayName}</div>
              <div className="muted small">
                <Link to={`/p/${s.fromPageId}`}>「{s.fromTitle}」</Link>から継承
              </div>
            </div>
            <span className="muted small">{PERM_LABEL[s.permission]}</span>
          </div>
        ))}
      </div>
      <p className="muted small access-note">
        {manage
          ? '共有はサブページにも引き継がれます。ワークスペース外のアカウントは「ゲスト」として、このページ以下だけを見られます。'
          : `あなたの権限：${PERM_LABEL[info.myAccess]}。共有設定を変更できるのは作成者と管理者です。`}
      </p>
    </div>
  );
}
