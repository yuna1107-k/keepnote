import { all, batch, sql } from './db.ts';

export type Settings = {
  /** サービス名（ログイン画面・パスキーの表示名など。各ワークスペースの名前とは別） */
  serviceName: string;
  inviteExpiryHours: number;
  sessionDays: number;
  /** Web への外部公開を誰に許可するか */
  publishPolicy: 'everyone' | 'admins' | 'disabled';
  /** 既存ファイルの暗号化の進み具合（この作成日時までのファイルは処理済み） */
  filesEncryptedUntil: number;
  /** ワークスペースを作成できるユーザー */
  workspaceCreation: 'everyone' | 'admins';
};

const defaults: Settings = {
  serviceName: 'keepnote',
  inviteExpiryHours: 72,
  sessionDays: 30,
  publishPolicy: 'everyone',
  filesEncryptedUntil: 0,
  workspaceCreation: 'everyone',
};

export async function getSettings(): Promise<Settings> {
  const rows = await all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const result: Settings = { ...defaults };
  for (const row of rows) {
    // 旧バージョンでは「サービス名」を workspaceName というキーで保存していた
    if (row.key === 'workspaceName' && !rows.some((r) => r.key === 'serviceName')) {
      result.serviceName = JSON.parse(row.value);
      continue;
    }
    if (row.key in result) {
      (result as Record<string, unknown>)[row.key] = JSON.parse(row.value);
    }
  }
  return result;
}

export async function updateSettings(patch: Partial<Settings>) {
  await batch(
    Object.entries(patch)
      .filter(([key, value]) => value !== undefined && key in defaults)
      .map(([key, value]) =>
        sql(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          key,
          JSON.stringify(value),
        ),
      ),
  );
  return getSettings();
}
