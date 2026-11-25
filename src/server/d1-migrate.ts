import type { D1Database } from '@cloudflare/workers-types';
import m0001 from '../../migrations/0001_init.sql';
import m0002 from '../../migrations/0002_profile.sql';
import m0003 from '../../migrations/0003_page_features.sql';
import m0004 from '../../migrations/0004_workspaces.sql';
import m0005 from '../../migrations/0005_page_permissions.sql';
import m0006 from '../../migrations/0006_workspace_viewer.sql';
import m0007 from '../../migrations/0007_page_restricted.sql';
import m0008 from '../../migrations/0008_workspace_slug.sql';
import m0009 from '../../migrations/0009_user_groups.sql';
import m0010 from '../../migrations/0010_github.sql';
import m0011 from '../../migrations/0011_presence.sql';
import m0012 from '../../migrations/0012_workspace_admin.sql';
import m0013 from '../../migrations/0013_full_width_default.sql';
import m0014 from '../../migrations/0014_page_files.sql';
import m0015 from '../../migrations/0015_serif_default.sql';
import m0016 from '../../migrations/0016_github_heading.sql';
import m0017 from '../../migrations/0017_private_pages_setting.sql';
import m0018 from '../../migrations/0018_page_links.sql';
import m0019 from '../../migrations/0019_templates.sql';
import m0020 from '../../migrations/0020_pdf_notes.sql';
import m0021 from '../../migrations/0021_service_name.sql';
import m0022 from '../../migrations/0022_page_todos.sql';
import m0023 from '../../migrations/0023_file_text.sql';
import m0024 from '../../migrations/0024_page_comments.sql';
import m0025 from '../../migrations/0025_databases.sql';
import m0026 from '../../migrations/0026_login_requests.sql';
import m0027 from '../../migrations/0027_login_requests_place.sql';
import m0028 from '../../migrations/0028_slide_theme.sql';

/**
 * Workers 起動時に、未適用のマイグレーションを D1 に適用する。
 * GitHub 連携の自動デプロイなどで、コードだけ先に更新されてもスキーマが追いつくようにするため。
 * 適用記録は wrangler と同じ d1_migrations テーブルを使うので、`wrangler d1 migrations apply` と併用できる。
 * 新しいマイグレーションを追加したら、ここにも追記すること。
 */
const MIGRATIONS: [string, string][] = [
  ['0001_init.sql', m0001],
  ['0002_profile.sql', m0002],
  ['0003_page_features.sql', m0003],
  ['0004_workspaces.sql', m0004],
  ['0005_page_permissions.sql', m0005],
  ['0006_workspace_viewer.sql', m0006],
  ['0007_page_restricted.sql', m0007],
  ['0008_workspace_slug.sql', m0008],
  ['0009_user_groups.sql', m0009],
  ['0010_github.sql', m0010],
  ['0011_presence.sql', m0011],
  ['0012_workspace_admin.sql', m0012],
  ['0013_full_width_default.sql', m0013],
  ['0014_page_files.sql', m0014],
  ['0015_serif_default.sql', m0015],
  ['0016_github_heading.sql', m0016],
  ['0017_private_pages_setting.sql', m0017],
  ['0018_page_links.sql', m0018],
  ['0019_templates.sql', m0019],
  ['0020_pdf_notes.sql', m0020],
  ['0021_service_name.sql', m0021],
  ['0022_page_todos.sql', m0022],
  ['0023_file_text.sql', m0023],
  ['0024_page_comments.sql', m0024],
  ['0025_databases.sql', m0025],
  ['0026_login_requests.sql', m0026],
  ['0027_login_requests_place.sql', m0027],
  ['0028_slide_theme.sql', m0028],
];

/** SQL ファイルを文に分割する（コメント行を除き、行末の ; で区切る） */
function statements(sql: string) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function migrateD1(db: D1Database) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS d1_migrations (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT UNIQUE,
         applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
       )`,
    )
    .run();
  const applied = new Set((await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()).results.map((r) => r.name));
  for (const [name, sql] of MIGRATIONS) {
    if (applied.has(name)) continue;
    try {
      // 1 つのマイグレーションは batch（暗黙のトランザクション）でまとめて適用する
      await db.batch([...statements(sql).map((s) => db.prepare(s)), db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name)]);
      console.log(`[migrate] applied ${name}`);
    } catch (err) {
      // 別のインスタンスが同時に適用した場合は記録済みになっているので無視する
      const done = await db.prepare('SELECT 1 FROM d1_migrations WHERE name = ?').bind(name).first();
      if (!done) throw err;
    }
  }
}
