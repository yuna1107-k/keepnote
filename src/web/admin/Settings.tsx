import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Button, Spinner, useUi } from '../ui';

type Settings = {
  serviceName: string;
  inviteExpiryHours: number;
  sessionDays: number;
  publishPolicy: 'everyone' | 'admins' | 'disabled';
  workspaceCreation: 'everyone' | 'admins';
};

export default function AdminSettings() {
  const { toast } = useUi();
  const { refresh } = useAuth();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ settings: Settings }>('/admin/settings')
      .then((r) => {
        setSettings(r.settings);
        setForm(r.settings);
      })
      .catch((e) => toast(e.message, 'error'));
  }, [toast]);

  if (!form || !settings) return <Spinner center />;

  const dirty = JSON.stringify(form) !== JSON.stringify(settings);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ settings: Settings }>('/admin/settings', { method: 'PUT', body: form });
      setSettings(r.settings);
      setForm(r.settings);
      await refresh();
      toast('設定を保存しました', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-page">
      <div className="admin-header">
        <h1>ワークスペース設定</h1>
      </div>
      <section className="card">
        <h2>サービス</h2>
        <label className="field">
          <span>サービス名</span>
          <input value={form.serviceName} maxLength={64} onChange={(e) => setForm({ ...form, serviceName: e.target.value })} />
          <small className="muted">ログイン画面や、パスキー作成時のサービス名として表示されます（各ワークスペースの名前はワークスペースの設定で変更します）。</small>
        </label>
      </section>
      <section className="card">
        <h2>外部公開</h2>
        <div className="setting-row">
          <div>
            <div className="list-title">Web への公開を許可するユーザー</div>
            <div className="muted small">「無効」にすると、公開中のページもすべて非公開になります。</div>
          </div>
          <div className="segmented">
            {(
              [
                ['everyone', '全員'],
                ['admins', '管理者のみ'],
                ['disabled', '無効'],
              ] as const
            ).map(([v, label]) => (
              <button key={v} className={form.publishPolicy === v ? 'active' : ''} onClick={() => setForm({ ...form, publishPolicy: v })}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="card">
        <h2>セキュリティ</h2>
        <div className="form-grid">
          <label className="field">
            <span>登録リンクの既定の有効期限（時間）</span>
            <input
              type="number"
              min={1}
              max={720}
              value={form.inviteExpiryHours}
              onChange={(e) => setForm({ ...form, inviteExpiryHours: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>ログインの有効期間（日）</span>
            <input type="number" min={1} max={365} value={form.sessionDays} onChange={(e) => setForm({ ...form, sessionDays: Number(e.target.value) })} />
            <small className="muted">変更は次回ログイン時から適用されます。</small>
          </label>
        </div>
        <div className="info-box small">
          <strong>認証方式：</strong>パスキーのみ（パスワード・メール認証は存在しません）
          <br />
          <strong>ユーザー登録：</strong>管理者が発行した登録リンク経由のみ（自己登録は無効）
        </div>
      </section>
      <div className="card-actions">
        <Button variant="ghost" onClick={() => setForm(settings)} disabled={!dirty}>
          元に戻す
        </Button>
        <Button variant="primary" onClick={save} loading={busy} disabled={!dirty}>
          保存
        </Button>
      </div>
    </div>
  );
}
