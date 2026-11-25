import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AuditLog } from '../api';
import { buildInfo } from '../buildInfo';
import { Button, formatBytes, formatRelative, Spinner, useUi } from '../ui';
import { AuditTable } from './common';

type Stats = {
  users: { total: number; active: number; pending: number; disabled: number; admins: number };
  pages: { total: number; workspace: number; private: number; trashed: number };
  passkeys: number;
  activeSessions: number;
  pendingLinks: number;
  storage: { files: number; bytes: number };
  logins24h: number;
  failedLogins24h: number;
  recent: AuditLog[];
};

function Stat({ label, value, sub, to, tone }: { label: string; value: number | string; sub?: string; to?: string; tone?: 'warn' | 'danger' }) {
  const body = (
    <>
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ? `text-${tone}` : ''}`}>{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </>
  );
  return to ? (
    <Link to={to} className="stat stat-link">
      {body}
    </Link>
  ) : (
    <div className="stat">{body}</div>
  );
}

type Backlog = { pages: number; versions: number; auditLogs: number; files: number };
type SystemInfo = { runtime: string; schema: string; origin: string; rpId: string; encryption: { enabled: boolean; remaining: Backlog | null } };

type BackupInfo = { available: boolean; encrypted: boolean; backups: { name: string; size: number; createdAt: number }[] };

/** データベースのバックアップ（6 時間ごとに自動作成、30 日分を保管） */
function BackupCard() {
  const { toast } = useUi();
  const [info, setInfo] = useState<BackupInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const load = () => api<BackupInfo>('/admin/backups').then(setInfo);
  useEffect(() => {
    load().catch(() => {});
  }, []);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ name: string; rows: number }>('/admin/backups', { method: 'POST' });
      toast(`バックアップを作成しました（${r.rows} 行）`, 'success');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const list = info?.backups ?? [];
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>データベースのバックアップ</h2>
          <p className="muted small">
            6 時間ごとに自動で作成し、30 日分を保管します（Cloudflare R2）。中身は暗号化キー（DATA_KEY）で暗号化されています。
            さらに、Cloudflare D1 の機能で過去 30 日の任意の時点に戻すこともできます。
          </p>
        </div>
        {info?.available && (
          <Button size="sm" onClick={create} disabled={busy}>
            {busy ? '作成中…' : '今すぐバックアップ'}
          </Button>
        )}
      </div>
      {!info ? (
        <Spinner />
      ) : !info.available ? (
        <p className="muted">この環境ではバックアップを利用できません。</p>
      ) : list.length === 0 ? (
        <p className="muted">まだバックアップはありません。</p>
      ) : (
        <>
          <p className="small">
            最新: {new Date(list[0]!.createdAt).toLocaleString('ja-JP')}（{formatRelative(list[0]!.createdAt)}）・保管数 {list.length}
            {!info.encrypted && <span className="badge badge-warn">暗号化されていません</span>}
          </p>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {(showAll ? list : list.slice(0, 5)).map((b) => (
                  <tr key={b.name}>
                    <td>{new Date(b.createdAt).toLocaleString('ja-JP')}</td>
                    <td className="muted">{formatBytes(b.size)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <a className="btn btn-ghost btn-sm" href={`/api/admin/backups/${b.name}`} download>
                        ダウンロード
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.length > 5 && (
            <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
              {showAll ? '閉じる' : `すべて表示（${list.length}）`}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function VersionCard() {
  const { toast } = useUi();
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api<SystemInfo>('/admin/system').then(setSys);
  useEffect(() => {
    load().catch(() => {});
  }, []);
  const remaining = sys?.encryption.remaining;
  const left = remaining ? remaining.pages + remaining.versions + remaining.auditLogs + remaining.files : 0;
  return (
    <section className="card">
      <h2>バージョン情報</h2>
      <dl className="dl version-dl">
        <dt>アプリ</dt>
        <dd>keepnote v{buildInfo.version}</dd>
        <dt>コミット</dt>
        <dd>
          <code className="version-code">{buildInfo.commit}</code>
        </dd>
        <dt>ビルド日時</dt>
        <dd>{new Date(buildInfo.builtAt).toLocaleString('ja-JP')}</dd>
        <dt>実行環境</dt>
        <dd>{sys?.runtime ?? '…'}</dd>
        <dt>データベース</dt>
        <dd>{sys?.schema ?? '…'}</dd>
        <dt>公開 URL</dt>
        <dd>{sys?.origin ?? '…'}</dd>
        <dt>データの暗号化</dt>
        <dd>
          {!sys ? (
            '…'
          ) : !sys.encryption.enabled ? (
            <span className="badge badge-warn">無効（DATA_KEY 未設定）</span>
          ) : left === 0 ? (
            <span className="badge badge-success">有効・すべて暗号化済み</span>
          ) : (
            <span className="encrypt-row">
              <span className="badge badge-warn">有効・未暗号化 {left} 件</span>
              <button
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api('/admin/system/encrypt', { body: {} });
                    await load();
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                今すぐ暗号化
              </button>
            </span>
          )}
        </dd>
      </dl>
    </section>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const { toast } = useUi();
  useEffect(() => {
    api<Stats>('/admin/stats').then(setStats).catch((e) => toast(e.message, 'error'));
  }, [toast]);
  if (!stats) return <Spinner center />;
  return (
    <div className="admin-page">
      <div className="admin-header">
        <h1>ダッシュボード</h1>
      </div>
      <div className="stat-grid">
        <Stat label="ユーザー" value={stats.users.total} sub={`有効 ${stats.users.active}・登録待ち ${stats.users.pending}・無効 ${stats.users.disabled}`} to="/admin/users" />
        <Stat label="管理者" value={stats.users.admins} to="/admin/users" />
        <Stat label="有効な登録リンク" value={stats.pendingLinks} to="/admin/links" tone={stats.pendingLinks ? 'warn' : undefined} />
        <Stat label="登録パスキー" value={stats.passkeys} />
        <Stat label="アクティブなセッション" value={stats.activeSessions} />
        <Stat label="24時間のログイン" value={stats.logins24h} sub={`失敗 ${stats.failedLogins24h} 件`} to="/admin/audit" tone={stats.failedLogins24h > 10 ? 'danger' : undefined} />
        <Stat label="ページ" value={stats.pages.total} sub={`共有 ${stats.pages.workspace}・個人 ${stats.pages.private}・ゴミ箱 ${stats.pages.trashed}`} />
        <Stat label="ファイル容量" value={formatBytes(stats.storage.bytes)} sub={`${stats.storage.files} ファイル`} />
      </div>
      <VersionCard />
      <BackupCard />
      <section className="card">
        <div className="card-head">
          <h2>最近のアクティビティ</h2>
          <Link to="/admin/audit" className="small">
            すべて表示 →
          </Link>
        </div>
        <AuditTable logs={stats.recent} compact />
      </section>
    </div>
  );
}
