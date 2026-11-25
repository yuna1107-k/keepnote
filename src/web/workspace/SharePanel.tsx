import { useEffect, useState } from 'react';
import { api, type Page } from '../api';
import { CopyField, formatRelative, Icon, Spinner, Toggle, useUi } from '../ui';
import { AccessPanel } from './AccessPanel';
import { useWorkspace } from './WorkspaceContext';

type ShareInfo = {
  enabled: boolean;
  slug: string | null;
  url: string | null;
  memberUrl: string;
  workspaceSlug: string;
  subpages: boolean;
  indexing: boolean;
  publishedAt: number | null;
  publishedBy: string | null;
  inherited: { pageId: string; title: string; url: string } | null;
  policy: 'everyone' | 'admins' | 'disabled';
  canPublish: boolean;
  canEditLink: boolean;
};

/** ページのリンク（招待したアカウント向け・Web 公開で共通のカスタム URL） */
function PageLink({ info, busy, onSave, hint }: { info: ShareInfo; busy: boolean; onSave: (slug: string) => Promise<boolean>; hint: string }) {
  const [editing, setEditing] = useState(false);
  const [slug, setSlug] = useState('');
  const url = info.enabled && info.url ? info.url : info.memberUrl;
  return (
    <div className="page-link">
      {editing ? (
        <form
          className="slug-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await onSave(slug.trim())) setEditing(false);
          }}
        >
          <span className="slug-prefix">{window.location.host}/{info.workspaceSlug}/</span>
          <input
            className="input"
            autoFocus
            value={slug}
            maxLength={64}
            placeholder="my-page"
            onChange={(e) => setSlug(e.target.value.replace(/[^A-Za-z0-9_-]/g, '-'))}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || slug.trim().length < 3}>
            保存
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
            取消
          </button>
        </form>
      ) : (
        <CopyField value={url} />
      )}
      <div className="page-link-foot">
        <span className="muted small">{hint}</span>
        {info.canEditLink && !editing && (
          <button
            className="link-btn small"
            onClick={() => {
              setSlug(info.slug ?? '');
              setEditing(true);
            }}
          >
            <Icon name="link" size={12} /> {info.slug ? 'URL を変更' : 'URL をカスタマイズ'}
          </button>
        )}
      </div>
    </div>
  );
}

export function SharePanel({ page }: { page: Page }) {
  const { toast } = useUi();
  const ws = useWorkspace();
  const [tab, setTab] = useState<'members' | 'web'>('members');
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<ShareInfo>(`/pages/${page.id}/share`)
      .then((i) => {
        setInfo(i);
        if (i.enabled) setTab('web');
      })
      .catch((e) => toast(e.message, 'error'));
  }, [page.id, toast]);

  const save = async (patch: Partial<Pick<ShareInfo, 'enabled' | 'subpages' | 'indexing' | 'slug'>>) => {
    if (!info) return false;
    setBusy(true);
    try {
      const next = await api<ShareInfo>(`/pages/${page.id}/share`, {
        method: 'PUT',
        body: {
          enabled: patch.enabled ?? info.enabled,
          subpages: patch.subpages ?? info.subpages,
          indexing: patch.indexing ?? info.indexing,
          ...(patch.slug ? { slug: patch.slug } : {}),
        },
      });
      setInfo(next);
      ws.patchLocal(page.id, { isPublic: next.enabled, slug: next.slug });
      // 編集中のページの URL もカスタム URL に合わせる
      if (patch.slug && next.slug && !/^\/(admin|settings|workspace)?(\/|$)/.test(window.location.pathname)) {
        const path = `/${next.workspaceSlug}/${next.slug}`;
        // 開いている画面を作り直さないよう、アドレスバーだけ書き換える（次に開いたときは新しい URL で表示される）
        window.history.replaceState(window.history.state, '', path);
      }
      if (patch.enabled === true) toast('Web に公開しました', 'success');
      if (patch.enabled === false) toast('公開を停止しました');
      if (patch.slug) toast('URL を変更しました（共有リンク・公開リンクの両方に反映されます）', 'success');
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="share-panel">
      <div className="share-tabs">
        <button className={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}>
          共有
        </button>
        <button className={tab === 'web' ? 'active' : ''} onClick={() => setTab('web')}>
          Web で公開 {info?.enabled && <span className="dot-live" />}
        </button>
      </div>

      {!info ? (
        <div className="share-body center">
          <Spinner />
        </div>
      ) : tab === 'members' ? (
        <div className="share-body">
          <AccessPanel page={page} onChanged={() => ws.reload()} />
          <PageLink
            info={info}
            busy={busy}
            onSave={(slug) => save({ slug })}
            hint={info.enabled ? 'Web に公開中のため、このリンクは誰でも開けます。' : 'このリンクは、ログインしたアクセス権のある人だけが開けます。'}
          />
        </div>
      ) : (
        <div className="share-body">
          {info.inherited && !info.enabled && (
            <div className="alert alert-info">
              <Icon name="globe" size={14} />
              <div>
                親ページ「{info.inherited.title || '無題'}」の公開により、このページも公開されています。
                <a href={info.inherited.url} target="_blank" rel="noreferrer">
                  公開ページを開く
                </a>
              </div>
            </div>
          )}
          <div className="setting-row">
            <div>
              <div className="list-title">Web で公開</div>
              <div className="muted small">リンクを知っている人は、ログインせずに閲覧できます（編集はできません）。</div>
            </div>
            <Toggle checked={info.enabled} disabled={busy || (!info.enabled && !info.canPublish)} onChange={(v) => save({ enabled: v })} label="Web で公開" />
          </div>
          {!info.canPublish && !info.enabled && (
            <p className="muted small">
              {info.policy === 'disabled'
                ? '外部公開は管理者によって無効化されています。'
                : info.policy === 'admins'
                  ? '外部公開できるのは管理者のみです。'
                  : '外部公開できるのはページの作成者と管理者のみです。'}
            </p>
          )}
          <PageLink
            info={info}
            busy={busy}
            onSave={(slug) => save({ slug })}
            hint={info.enabled ? '公開中のリンクです。' : '公開すると、このリンクで誰でも閲覧できるようになります。'}
          />
          {info.enabled && (
            <>
              <div className="setting-row">
                <div>
                  <div className="list-title">サブページも公開</div>
                  <div className="muted small">このページの下にあるページも閲覧できるようにします。</div>
                </div>
                <Toggle checked={info.subpages} disabled={busy} onChange={(v) => save({ subpages: v })} label="サブページも公開" />
              </div>
              <div className="setting-row">
                <div>
                  <div className="list-title">検索エンジンに表示</div>
                  <div className="muted small">オフの場合は検索結果に表示されないよう指示します。</div>
                </div>
                <Toggle checked={info.indexing} disabled={busy} onChange={(v) => save({ indexing: v })} label="検索エンジンに表示" />
              </div>
              <div className="share-footer">
                <span className="muted small">
                  {info.publishedBy ?? '—'} が {formatRelative(info.publishedAt)}に公開
                </span>
                {info.url && (
                  <a className="btn btn-secondary btn-sm" href={info.url} target="_blank" rel="noreferrer">
                    <Icon name="external" size={14} /> 開く
                  </a>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
