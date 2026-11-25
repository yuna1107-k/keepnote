/**
 * ワークスペースと GitHub リポジトリの双方向同期。
 *
 * - フォルダ → ページ（github_kind = 'dir'、内容は自動生成。フォルダ内のファイル一覧）
 * - *.md → ページ（github_kind = 'md'。アプリで編集すると GitHub にコミットする）
 * - それ以外のファイルはコピーせず、表示時に GitHub から取得する（/api/github/:ws/raw/...）
 *
 * Markdown → エディタのブロックへの変換は画面側（BlockNote）で行う。サーバーは Markdown を source_md に保存し、
 * md_rev を進めることで「変換し直しが必要」と知らせる。
 */
import { auditStmt } from './audit.ts';
import { encryptText } from './crypto.ts';
import { all, batch, get, run, sql, type Stmt } from './db.ts';
import { fail, newId, now } from './util.ts';

export type GithubLink = {
  workspace_id: string;
  repo: string;
  branch: string;
  root_path: string;
  token: string;
  root_page_id: string | null;
  last_sync_at: number | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
};

type GhPage = {
  id: string;
  parent_id: string | null;
  title: string;
  content: string;
  github_path: string | null;
  github_kind: 'root' | 'dir' | 'md' | 'file' | null;
  github_sha: string | null;
  source_md: string | null;
  github_dirty: number;
  md_rev: number;
  version: number;
  position: number;
  deleted_at: number | null;
  owner_id: string;
};

let API = 'https://api.github.com';

/** テスト用：GitHub API の接続先を差し替える（Workers の変数 GITHUB_API） */
export function setGithubApi(base: string | undefined) {
  if (base) API = base.replace(/\/+$/, '');
}
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
const SKIP = (p: string) => p.split('/').some((seg) => seg.startsWith('.') || seg === 'node_modules');

export function getLink(workspaceId: string) {
  return get<GithubLink>('SELECT * FROM github_links WHERE workspace_id = ?', workspaceId);
}

async function gh(link: Pick<GithubLink, 'token'>, path: string, init: RequestInit = {}) {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${link.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'keepnote',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  });
}

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** コミットメッセージ：コミットした日時（日本時間、例：2026/11/06 23:59） */
export function commitMessage(at = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

function b64encodeUtf8(text: string) {
  return b64encodeBytes(new TextEncoder().encode(text));
}

function b64encodeBytes(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64decodeUtf8(b64: string) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** 検索用に Markdown の記号をざっくり取り除く */
function mdToText(md: string) {
  return md
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*/g, ''))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\-*+\s]+|[*_`~]/gm, '')
    .trim();
}

/** 接続前の確認：リポジトリとブランチがあり、書き込み権限があるか */
export async function verifyRepo(repo: string, branch: string, token: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail(400, 'リポジトリは「ユーザー名/リポジトリ名」の形で入力してください');
  const r = await gh({ token }, `/repos/${repo}`);
  if (r.status === 401) fail(400, 'トークンが無効です');
  if (r.status === 404) fail(400, 'リポジトリが見つかりません（トークンにこのリポジトリへのアクセス権があるか確認してください）');
  if (!r.ok) fail(400, `GitHub に接続できませんでした（${r.status}）`);
  const info = (await r.json()) as { default_branch: string; permissions?: { push?: boolean } };
  const b = branch || info.default_branch;
  const br = await gh({ token }, `/repos/${repo}/branches/${encodeURIComponent(b)}`);
  if (!br.ok) fail(400, `ブランチ「${b}」が見つかりません`);
  return { branch: b, canPush: info.permissions?.push !== false };
}

export function githubUrl(link: Pick<GithubLink, 'repo' | 'branch'>, path: string, kind: 'dir' | 'md' | 'root' | 'file') {
  return `https://github.com/${link.repo}/${kind === 'md' || kind === 'file' ? 'blob' : 'tree'}/${encodeURIComponent(link.branch)}/${encPath(path)}`.replace(/\/$/, '');
}

/** フォルダのページの内容（フォルダ内のファイル一覧）をブロックで作る */
function dirBlocks(_link: GithubLink, _dir: string): unknown[] {
  // 同期の案内はページ上部の帯（ワークスペースの管理者のみ）に出すので、本文には何も置かない
  return [];
}

/** ファイルのページのアイコン（Google のアイコン）。種類が分かるように付ける */
function fileIcon(name: string) {
  if (/\.pdf$/i.test(name)) return 'ms:picture_as_pdf:e16259';
  if (IMAGE_EXT.test(name)) return 'ms:image';
  if (/\.(mp4|webm|mov|m4v|ogv)$/i.test(name)) return 'ms:movie';
  if (/\.(mp3|ogg|oga|wav|m4a|aac|opus|flac|weba)$/i.test(name)) return 'ms:music_note';
  if (/\.(xlsx|xlsm|ods)$/i.test(name)) return 'ms:table';
  if (/\.docx$/i.test(name)) return 'ms:article';
  if (/\.pptx$/i.test(name)) return 'ms:slideshow';
  if (/\.(txt|text|log|rst|org|adoc)$/i.test(name)) return 'ms:description';
  if (/\.(csv|tsv)$/i.test(name)) return 'ms:table';
  if (TEXT_EXT.test(name)) return 'ms:code';
  return 'ms:attach_file';
}

export type SyncResult = { created: number; updated: number; removed: number; pushed: number; conflicts: number; pending: number };

/**
 * GitHub → アプリの取り込みと、アプリ → GitHub の送信をまとめて行う。
 * 1 回の実行で取得する Markdown の数には上限があり、残りは次回の実行で処理する。
 */
export async function syncWorkspace(workspaceId: string, actorId: string | null, opts: { maxFetch?: number } = {}): Promise<SyncResult> {
  const link = await getLink(workspaceId);
  if (!link) fail(404, 'GitHub と連携していません');
  const result: SyncResult = { created: 0, updated: 0, removed: 0, pushed: 0, conflicts: 0, pending: 0 };
  try {
    // 先にアプリ側の変更を送る（GitHub の新しい内容で上書きしてしまわないように）
    // （Markdown の本文の変更と、ファイル・フォルダの名前や場所の変更）
    const dirty = await all<{ id: string }>(`SELECT id FROM pages WHERE workspace_id = ? AND github_kind IN ('md', 'file', 'dir') AND github_dirty = 1 AND deleted_at IS NULL`, workspaceId);
    for (const d of dirty.slice(0, 5)) {
      const r = await pushPage(d.id, actorId);
      if (r === 'pushed') result.pushed++;
      if (r === 'conflict') result.conflicts++;
    }
    await pull(link, actorId, opts.maxFetch ?? 40, result);
    await run(
      `UPDATE github_links SET last_sync_at = ?, last_sync_status = ?, last_sync_error = NULL WHERE workspace_id = ?`,
      now(),
      result.pending ? `残り ${result.pending} 件` : 'ok',
      workspaceId,
    );
  } catch (err) {
    await run(`UPDATE github_links SET last_sync_at = ?, last_sync_status = 'error', last_sync_error = ? WHERE workspace_id = ?`, now(), String((err as Error).message ?? err).slice(0, 500), workspaceId);
    throw err;
  }
  return result;
}

async function pull(link: GithubLink, actorId: string | null, maxFetch: number, result: SyncResult) {
  const r = await gh(link, `/repos/${link.repo}/git/trees/${encodeURIComponent(link.branch)}?recursive=1`);
  if (!r.ok) fail(502, `GitHub からファイル一覧を取得できませんでした（${r.status}）`);
  const tree = (await r.json()) as { tree: { path: string; type: 'blob' | 'tree'; sha: string }[] };
  const root = link.root_path.replace(/^\/+|\/+$/g, '');
  const under = (p: string) => (root ? p === root || p.startsWith(root + '/') : true);
  const entries = tree.tree.filter((e) => under(e.path) && !SKIP(e.path));

  const dirs = new Set<string>(entries.filter((e) => e.type === 'tree').map((e) => e.path));
  const mdFiles = entries.filter((e) => e.type === 'blob' && /\.md$/i.test(e.path));
  // Markdown 以外のファイルもページにする（中身は開いたときに GitHub から取得する）
  const otherFiles = entries.filter((e) => e.type === 'blob' && !/\.md$/i.test(e.path));
  for (const f of [...mdFiles.map((m) => m.path), ...otherFiles.map((o) => o.path)]) {
    // 親フォルダも補う
    for (let d = f.substring(0, f.lastIndexOf('/')); d && under(d); d = d.substring(0, d.lastIndexOf('/'))) dirs.add(d);
  }
  if (root) dirs.delete(root);

  const pages = await all<GhPage>(
    `SELECT id, parent_id, title, content, github_path, github_kind, github_sha, source_md, github_dirty, md_rev, version, position, deleted_at, owner_id
     FROM pages WHERE workspace_id = ? AND github_kind IS NOT NULL`,
    link.workspace_id,
  );
  const byPath = new Map(pages.filter((p) => p.github_path !== null && p.github_kind !== 'root').map((p) => [p.github_path!, p]));
  const t = now();
  const owner = actorId ?? (await get<{ created_by: string }>('SELECT created_by FROM github_links WHERE workspace_id = ?', link.workspace_id))?.created_by ?? '';

  // リポジトリのページ（最上位）
  let rootPage = pages.find((p) => p.github_kind === 'root' && !p.deleted_at);
  if (!rootPage) {
    const id = newId();
    await run(
      `INSERT INTO pages (full_width, font, id, workspace_id, parent_id, owner_id, visibility, title, icon, position, github_kind, github_path, locked, created_by, updated_by, created_at, updated_at)
       VALUES (1, 'serif', ?, ?, NULL, ?, 'workspace', ?, ?, ?, 'root', ?, 0, ?, ?, ?, ?)`,
      id,
      link.workspace_id,
      owner,
      await encryptText(root ? root.split('/').pop()! : link.repo.split('/')[1]!),
      null,
      t,
      root,
      owner,
      owner,
      t,
      t,
    );
    await run('UPDATE github_links SET root_page_id = ? WHERE workspace_id = ?', id, link.workspace_id);
    rootPage = { id, parent_id: null, title: '', content: '[]', github_path: root, github_kind: 'root', github_sha: null, source_md: null, github_dirty: 0, md_rev: 0, version: 1, position: t, deleted_at: null, owner_id: owner };
    result.created++;
  } else {
    // 以前の版で付けていたタコのアイコンを外す（利用者が選んだアイコンはそのまま）
    const cur = await get<{ icon: string | null }>('SELECT icon FROM pages WHERE id = ?', rootPage.id);
    if (cur?.icon === '🐙') await run('UPDATE pages SET icon = NULL WHERE id = ?', rootPage.id);
    // 以前の版で付けていた絵文字・使えないアイコン名を、Google のアイコンに置き換える
    const old = await all<{ id: string; icon: string | null }>(`SELECT id, icon FROM pages WHERE workspace_id = ? AND github_kind IN ('dir', 'file')`, link.workspace_id);
    const fix = old.filter((p) => p.icon === '📁' || p.icon === 'ms:draft');
    for (const p of fix) await run('UPDATE pages SET icon = ? WHERE id = ?', await encryptText(p.icon === '📁' ? 'ms:folder' : 'ms:attach_file'), p.id);
  }
  const pageOf = (dir: string) => (dir === root || dir === '' ? rootPage!.id : byPath.get(dir)?.id);
  const parentDir = (p: string) => (p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '');

  // フォルダ（浅い順に作る）
  const stmts: Stmt[] = [];
  const sortedDirs = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b, 'ja'));
  for (const d of sortedDirs) {
    const existing = byPath.get(d);
    const parentId = pageOf(parentDir(d)) ?? rootPage.id;
    if (existing && !existing.deleted_at) continue;
    if (existing && existing.deleted_at) {
      stmts.push(sql('UPDATE pages SET deleted_at = NULL, deleted_by = NULL, parent_id = ? WHERE id = ?', parentId, existing.id));
      continue;
    }
    const id = newId();
    await run(
      `INSERT INTO pages (full_width, font, id, workspace_id, parent_id, owner_id, visibility, title, icon, position, github_kind, github_path, created_by, updated_by, created_at, updated_at)
       VALUES (1, 'serif', ?, ?, ?, ?, 'workspace', ?, ?, 0, 'dir', ?, ?, ?, ?, ?)`,
      id,
      link.workspace_id,
      parentId,
      owner,
      await encryptText(d.split('/').pop()!),
      await encryptText('ms:folder'),
      d,
      owner,
      owner,
      t,
      t,
    );
    byPath.set(d, { ...rootPage, id, parent_id: parentId, github_kind: 'dir', github_path: d });
    result.created++;
  }

  // Markdown ファイル
  let fetched = 0;
  for (const f of mdFiles) {
    const existing = byPath.get(f.path);
    const parentId = pageOf(parentDir(f.path)) ?? rootPage.id;
    if (existing && !existing.deleted_at && existing.github_sha === f.sha) continue;
    if (existing?.github_dirty) continue; // 送信待ちの変更があるものは、送信時に競合として処理する
    if (fetched >= maxFetch) {
      result.pending++;
      continue;
    }
    const blob = await gh(link, `/repos/${link.repo}/git/blobs/${f.sha}`);
    fetched++;
    if (!blob.ok) {
      result.pending++;
      continue;
    }
    const md = b64decodeUtf8(((await blob.json()) as { content: string }).content);
    const title = f.path.split('/').pop()!.replace(/\.md$/i, '');
    if (existing) {
      stmts.push(
        sql(
          `UPDATE pages SET source_md = ?, github_sha = ?, md_rev = md_rev + 1, content_text = ?, title = ?, parent_id = ?,
             deleted_at = NULL, deleted_by = NULL, version = version + 1, updated_at = ?, updated_by = NULL, github_conflict_at = NULL WHERE id = ?`,
          await encryptText(md),
          f.sha,
          await encryptText(mdToText(md)),
          await encryptText(title),
          parentId,
          t,
          existing.id,
        ),
      );
      result.updated++;
    } else {
      stmts.push(
        sql(
          `INSERT INTO pages (full_width, font, id, workspace_id, parent_id, owner_id, visibility, title, content, content_text, position, github_kind, github_path, github_sha, source_md, md_rev, created_by, updated_by, created_at, updated_at)
           VALUES (1, 'serif', ?, ?, ?, ?, 'workspace', ?, '[]', ?, 0, 'md', ?, ?, ?, 1, ?, NULL, ?, ?)`,
          newId(),
          link.workspace_id,
          parentId,
          owner,
          await encryptText(title),
          await encryptText(mdToText(md)),
          f.path,
          f.sha,
          await encryptText(md),
          owner,
          t,
          t,
        ),
      );
      result.created++;
    }
  }

  // Markdown 以外のファイル（ページの中身は持たず、GitHub 上の版だけ覚えておく）
  for (const f of otherFiles) {
    const existing = byPath.get(f.path);
    const parentId = pageOf(parentDir(f.path)) ?? rootPage.id;
    const name = f.path.split('/').pop()!;
    if (existing && !existing.deleted_at && existing.github_sha === f.sha && existing.parent_id === parentId) continue;
    if (existing) {
      stmts.push(
        sql(
          `UPDATE pages SET github_sha = ?, title = ?, parent_id = ?, deleted_at = NULL, deleted_by = NULL, version = version + 1, updated_at = ?, updated_by = NULL WHERE id = ?`,
          f.sha,
          await encryptText(name),
          parentId,
          t,
          existing.id,
        ),
      );
      result.updated++;
    } else {
      stmts.push(
        sql(
          `INSERT INTO pages (full_width, font, id, workspace_id, parent_id, owner_id, visibility, title, icon, content, content_text, position, github_kind, github_path, github_sha, created_by, updated_by, created_at, updated_at)
           VALUES (1, 'serif', ?, ?, ?, ?, 'workspace', ?, ?, '[]', '', 0, 'file', ?, ?, ?, NULL, ?, ?)`,
          newId(),
          link.workspace_id,
          parentId,
          owner,
          await encryptText(name),
          await encryptText(fileIcon(name)),
          f.path,
          f.sha,
          owner,
          t,
          t,
        ),
      );
      result.created++;
    }
  }

  // GitHub から消えたもの（送信待ちの新規ページ＝パス未確定のものは対象外）
  const alive = new Set([...dirs, ...mdFiles.map((m) => m.path), ...otherFiles.map((o) => o.path)]);
  for (const p of byPath.values()) {
    if (p.deleted_at || p.github_kind === 'root' || p.github_dirty) continue;
    if (!alive.has(p.github_path!)) {
      stmts.push(sql('UPDATE pages SET deleted_at = ?, deleted_by = NULL WHERE id = ? AND deleted_at IS NULL', t, p.id));
      result.removed++;
    }
  }
  if (stmts.length) await batch(stmts);

  // フォルダのページの内容（ファイル一覧）と、名前順の並び
  const fresh = await all<GhPage>(
    `SELECT id, parent_id, title, content, github_path, github_kind, github_sha, source_md, github_dirty, md_rev, version, position, deleted_at, owner_id
     FROM pages WHERE workspace_id = ? AND github_kind IS NOT NULL AND deleted_at IS NULL`,
    link.workspace_id,
  );
  const order: Stmt[] = [];
  for (const p of fresh) {
    if (p.github_kind !== 'dir' && p.github_kind !== 'root') continue;
    const dir = p.github_kind === 'root' ? root : p.github_path!;
    const blocks = JSON.stringify(dirBlocks(link, dir));
    if (blocks !== p.content) {
      order.push(
        sql('UPDATE pages SET content = ?, content_text = ?, version = version + 1, updated_at = ? WHERE id = ?', await encryptText(blocks), await encryptText(''), t, p.id),
      );
    }
    // フォルダを先に、その後はファイル名の順
    const rank = (k: GhPage) => (k.github_kind === 'dir' ? 0 : 1);
    const kids = fresh
      .filter((k) => k.parent_id === p.id)
      .sort((a, b) => rank(a) - rank(b) || (a.github_path ?? a.title).localeCompare(b.github_path ?? b.title, 'ja'));
    kids.forEach((k, i) => k.position !== i + 1 && order.push(sql('UPDATE pages SET position = ? WHERE id = ?', i + 1, k.id)));
  }
  if (order.length) await batch(order);
}

/** アプリで編集した Markdown を GitHub にコミットする */
export async function pushPage(pageId: string, actorId: string | null): Promise<'pushed' | 'skipped' | 'conflict'> {
  const page = await get<GhPage & { workspace_id: string }>(
    `SELECT id, workspace_id, parent_id, title, content, github_path, github_kind, github_sha, source_md, github_dirty, md_rev, version, position, deleted_at, owner_id
     FROM pages WHERE id = ?`,
    pageId,
  );
  if (!page || page.deleted_at || !page.github_kind || page.github_kind === 'root') return 'skipped';
  const link = await getLink(page.workspace_id);
  if (!link) return 'skipped';
  // タイトル（＝ファイル名・フォルダ名）や親フォルダが変わっていれば、GitHub 上でも名前・場所を変える
  let path = page.github_path;
  let renamed = false;
  if (path && page.title.trim()) {
    const want = await desiredGithubPath(link, page);
    if (want && want !== path) {
      await moveGithubPath(link, path, want);
      path = want;
      renamed = true;
    }
  }
  if (page.github_kind !== 'md') {
    if (page.github_dirty) await run('UPDATE pages SET github_dirty = 0 WHERE id = ?', page.id);
    return renamed ? 'pushed' : 'skipped';
  }
  if (!page.github_dirty) return renamed ? 'pushed' : 'skipped';
  // 新しいページはタイトルが決まるまで送らない（ファイル名になるため）。本文の変換が済んでいないものも送らない
  if (!path && !page.title.trim()) return 'skipped';
  if (page.source_md === null) return 'skipped';
  if (!path) {
    // 新しいページ：親フォルダの下に「タイトル.md」として作る
    path = await desiredGithubPath(link, page);
    if (!path) return 'skipped';
  }
  const md = page.source_md ?? '';
  if (renamed && page.github_path) {
    // 名前を変えただけで本文が同じなら、本文のコミットはしない
    const cur = await gh(link, `/repos/${link.repo}/contents/${encPath(path)}?ref=${encodeURIComponent(link.branch)}`);
    if (cur.ok) {
      const body = (await cur.json()) as { sha: string; content?: string };
      if (body.content !== undefined && b64decodeUtf8(body.content) === md) {
        await run('UPDATE pages SET github_sha = ?, github_dirty = 0 WHERE id = ?', body.sha, page.id);
        return 'pushed';
      }
    }
  }
  const res = await gh(link, `/repos/${link.repo}/contents/${encPath(path)}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: commitMessage(),
      content: b64encodeUtf8(md),
      branch: link.branch,
      ...(page.github_sha ? { sha: page.github_sha } : {}),
    }),
  });
  if (res.ok) {
    const sha = ((await res.json()) as { content: { sha: string } }).content.sha;
    // 送信中に再度編集された場合に備え、送った内容と同じときだけ「送信済み」にする
    // （source_md は暗号化されているので SQL では比べられない。読み直して比べる）
    const cur = await get<{ source_md: string | null }>('SELECT source_md FROM pages WHERE id = ?', page.id);
    await run('UPDATE pages SET github_sha = ?, github_path = ?, github_dirty = ? WHERE id = ?', sha, path, (cur?.source_md ?? '') === md ? 0 : 1, page.id);
    return 'pushed';
  }
  if (res.status === 409 || res.status === 422) {
    // GitHub 側も更新されていた：GitHub の内容を採用し、アプリでの編集は履歴に残す
    const remote = await gh(link, `/repos/${link.repo}/contents/${encPath(path)}?ref=${encodeURIComponent(link.branch)}`);
    if (!remote.ok) return 'skipped';
    const body = (await remote.json()) as { sha: string; content: string };
    const remoteMd = b64decodeUtf8(body.content);
    const t = now();
    await batch([
      sql(
        `INSERT INTO page_versions (id, page_id, title, icon, content, content_text, edited_by, created_at)
         SELECT ?, id, title, icon, content, content_text, updated_by, updated_at FROM pages WHERE id = ?`,
        newId(),
        page.id,
      ),
      sql(
        `UPDATE pages SET source_md = ?, github_sha = ?, github_path = ?, md_rev = md_rev + 1, github_dirty = 0, github_conflict_at = ?,
           content_text = ?, version = version + 1, updated_at = ? WHERE id = ?`,
        await encryptText(remoteMd),
        body.sha,
        path,
        t,
        await encryptText(mdToText(remoteMd)),
        t,
        page.id,
      ),
      auditStmt(null, actorId ? { id: actorId, username: '' } : null, 'github.conflict', { type: 'workspace', id: page.workspace_id }, { path }),
    ]);
    return 'conflict';
  }
  throw new Error(`GitHub へのコミットに失敗しました（${res.status}）`);
}

/** 画面で表示・編集できるテキストファイルの拡張子 */
export const TEXT_EXT = /\.(txt|text|log|csv|tsv|json|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|ipynb|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|r|m|jl|sql|sh|bash|zsh|ps1|bat|tex|bib|sty|cls|rst|org|adoc|env|gitignore|dockerfile|makefile|lua|pl|scala|hs|ml|vue|svelte)$/i;
/** テキストとして開ける大きさの上限（GitHub の contents API が中身を返す 1MB まで） */
export const TEXT_MAX = 1_000_000;

/** テキストファイルを取得する（sha は保存時の競合確認に使う） */
export async function getTextFile(link: GithubLink, path: string): Promise<{ text: string; sha: string } | null> {
  const res = await gh(link, `/repos/${link.repo}/contents/${encPath(path)}?ref=${encodeURIComponent(link.branch)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub からファイルを取得できませんでした（${res.status}）`);
  const body = (await res.json()) as { type?: string; sha: string; size: number; content?: string; encoding?: string };
  if (body.type !== 'file') return null;
  if (body.size > TEXT_MAX || body.encoding !== 'base64' || body.content === undefined) throw new Error('TOO_LARGE');
  return { text: b64decodeUtf8(body.content), sha: body.sha };
}

/** テキストファイルを GitHub にコミットする。GitHub 側が先に更新されていたら 'conflict' */
export async function putTextFile(link: GithubLink, path: string, text: string, sha: string): Promise<{ sha: string } | 'conflict'> {
  const res = await gh(link, `/repos/${link.repo}/contents/${encPath(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ message: commitMessage(), content: b64encodeUtf8(text), branch: link.branch, sha }),
  });
  if (res.status === 409 || res.status === 422) return 'conflict';
  if (!res.ok) throw new Error(`GitHub へのコミットに失敗しました（${res.status}）`);
  return { sha: ((await res.json()) as { content: { sha: string } }).content.sha };
}

/** 画像・Excel などのファイルを GitHub にコミットする。sha が分かっていて GitHub 側が先に更新されていたら 'conflict' */
export async function putBinaryFile(link: GithubLink, path: string, data: Uint8Array, sha: string | null): Promise<{ sha: string } | 'conflict'> {
  let current = sha;
  if (!current) {
    const meta = await gh(link, `/repos/${link.repo}/contents/${encPath(path)}?ref=${encodeURIComponent(link.branch)}`);
    if (meta.ok) current = ((await meta.json()) as { sha?: string }).sha ?? null;
    else if (meta.status !== 404) throw new Error(`GitHub からファイルを取得できませんでした（${meta.status}）`);
  }
  const res = await gh(link, `/repos/${link.repo}/contents/${encPath(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ message: commitMessage(), content: b64encodeBytes(data), branch: link.branch, ...(current ? { sha: current } : {}) }),
  });
  if (res.status === 409 || res.status === 422) return 'conflict';
  if (!res.ok) throw new Error(`GitHub へのコミットに失敗しました（${res.status}）`);
  return { sha: ((await res.json()) as { content: { sha: string } }).content.sha };
}

type TreeChange = { path: string; sha: string | null };

/**
 * 複数のファイルの追加・移動・削除を 1 回のコミットで行う（Git の tree を直接作る）。
 * sha は既存の blob（移動・複製のとき）。null はそのパスのファイルを削除する。
 * 途中で他のコミットが入ったら、作り直して数回まで再試行する。
 */
export async function commitTree(link: GithubLink, changes: TreeChange[], message = commitMessage()) {
  if (!changes.length) return;
  const repo = `/repos/${link.repo}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await gh(link, `${repo}/git/ref/heads/${encodeURIComponent(link.branch)}`);
    if (!ref.ok) throw new Error(`GitHub のブランチを取得できませんでした（${ref.status}）`);
    const head = ((await ref.json()) as { object: { sha: string } }).object.sha;
    const commit = await gh(link, `${repo}/git/commits/${head}`);
    if (!commit.ok) throw new Error(`GitHub のコミットを取得できませんでした（${commit.status}）`);
    const baseTree = ((await commit.json()) as { tree: { sha: string } }).tree.sha;
    const tree = await gh(link, `${repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ base_tree: baseTree, tree: changes.map((c) => ({ path: c.path, mode: '100644', type: 'blob', sha: c.sha })) }),
    });
    if (!tree.ok) throw new Error(`GitHub でファイルの一覧を作れませんでした（${tree.status}）`);
    const treeSha = ((await tree.json()) as { sha: string }).sha;
    const created = await gh(link, `${repo}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: treeSha, parents: [head] }) });
    if (!created.ok) throw new Error(`GitHub にコミットを作れませんでした（${created.status}）`);
    const newSha = ((await created.json()) as { sha: string }).sha;
    const upd = await gh(link, `${repo}/git/refs/heads/${encodeURIComponent(link.branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: newSha, force: false }) });
    if (upd.ok) return;
    if (upd.status !== 422 && upd.status !== 409) throw new Error(`GitHub のブランチを更新できませんでした（${upd.status}）`);
  }
  throw new Error('GitHub 側で同時に更新されたため、反映できませんでした。もう一度お試しください');
}

/** リポジトリ内のファイル（blob）の一覧 */
async function repoBlobs(link: GithubLink) {
  const r = await gh(link, `/repos/${link.repo}/git/trees/${encodeURIComponent(link.branch)}?recursive=1`);
  if (!r.ok) throw new Error(`GitHub からファイル一覧を取得できませんでした（${r.status}）`);
  const tree = (await r.json()) as { tree: { path: string; type: string; sha: string }[] };
  return new Map(tree.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
}

const underPath = (p: string, base: string) => p === base || p.startsWith(base + '/');
const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** 移動・削除でフォルダが空になったら、フォルダが消えないよう .gitkeep を置く（リポジトリの最上位・連携の起点は除く） */
async function keepFolder(link: GithubLink, dir: string) {
  if (!dir || dir === link.root_path) return;
  const blobs = await repoBlobs(link);
  if ([...blobs.keys()].some((p) => p.startsWith(dir + '/'))) return;
  await createGithubFolder(link, dir).catch((e) => console.error('[github] keep folder', e));
}

/**
 * ファイル・フォルダの場所や名前を変える（GitHub でのパスの変更と、アプリのページの記録の両方）。
 * フォルダの場合は、中のファイル（.gitkeep など画面に出ないものも含む）をまとめて移す。
 */
export async function moveGithubPath(link: GithubLink, from: string, to: string) {
  if (from === to) return;
  if (underPath(to, from)) fail(400, 'フォルダを自分自身の中へは移動できません');
  const blobs = await repoBlobs(link);
  const moving = [...blobs].filter(([p]) => underPath(p, from));
  if (!moving.length) fail(409, 'GitHub にファイルが見つかりません。同期してからもう一度お試しください');
  for (const [p] of moving) {
    const dest = to + p.slice(from.length);
    if (blobs.has(dest)) fail(409, `移動先に同じ名前のファイルがあります（${dest}）`);
  }
  await commitTree(link, [...moving.map(([p, sha]) => ({ path: to + p.slice(from.length), sha })), ...moving.map(([p]) => ({ path: p, sha: null }))]);
  if (parentOf(from) !== parentOf(to)) await keepFolder(link, parentOf(from));
  // アプリ側のページのパスも付け替える
  await run(
    `UPDATE pages SET github_path = ? || substr(github_path, ?) WHERE workspace_id = ? AND github_kind IN ('dir', 'md', 'file') AND (github_path = ? OR substr(github_path, 1, ?) = ?)`,
    to,
    from.length + 1,
    link.workspace_id,
    from,
    from.length + 1,
    from + '/',
  );
}

/** フォルダとその中のファイルを、まとめて GitHub から削除する */
export async function deleteGithubFolder(link: GithubLink, dir: string) {
  const blobs = await repoBlobs(link);
  const targets = [...blobs.keys()].filter((p) => underPath(p, dir));
  await commitTree(link, targets.map((p) => ({ path: p, sha: null })));
  await keepFolder(link, parentOf(dir));
}

/** ファイルを複製する（同じ中身のファイルを別の名前で作る） */
export async function copyGithubFile(link: GithubLink, from: string, to: string) {
  const blobs = await repoBlobs(link);
  const sha = blobs.get(from);
  if (!sha) fail(409, 'GitHub にファイルが見つかりません。同期してからもう一度お試しください');
  if (blobs.has(to)) fail(409, `同じ名前のファイルがあります（${to}）`);
  await commitTree(link, [{ path: to, sha }]);
  return sha;
}

/** 空のフォルダを作る（Git は空のフォルダを保存できないので、空の .gitkeep を置く） */
export async function createGithubFolder(link: GithubLink, dir: string) {
  const res = await gh(link, `/repos/${link.repo}/contents/${encPath(dir + '/.gitkeep')}`, {
    method: 'PUT',
    body: JSON.stringify({ message: commitMessage(), content: '', branch: link.branch }),
  });
  if (res.status === 422) fail(409, '同じ名前のフォルダがあります');
  if (!res.ok) throw new Error(`GitHub にフォルダを作れませんでした（${res.status}）`);
}

/** ファイル名・フォルダ名に使えない文字を置き換える */
export function safeName(title: string) {
  return title.replace(/[\\/:*?"<>|#]/g, '_').trim() || '無題';
}

/** ページのタイトルと親フォルダから、GitHub 上のあるべきパスを決める */
export async function desiredGithubPath(link: GithubLink, page: { parent_id: string | null; title: string; github_kind: string | null; github_path: string | null }) {
  const parent = await get<{ github_path: string | null; github_kind: string | null }>('SELECT github_path, github_kind FROM pages WHERE id = ?', page.parent_id ?? '');
  if (!parent || (parent.github_kind !== 'dir' && parent.github_kind !== 'root')) return null;
  const dir = parent.github_kind === 'root' ? link.root_path : parent.github_path ?? link.root_path;
  const prefix = dir ? dir.replace(/\/+$/, '') + '/' : '';
  let name = safeName(page.title);
  if (page.github_kind === 'md') name += '.md';
  if (page.github_kind === 'file') {
    // 拡張子を消した場合は元の拡張子を付ける
    const ext = /\.[^./]+$/.exec(page.github_path ?? '')?.[0] ?? '';
    if (ext && !name.toLowerCase().endsWith(ext.toLowerCase())) name += ext;
  }
  return prefix + name;
}

/**
 * GitHub のファイルを削除する（アプリでページを削除したとき）。
 * sha が今の GitHub 上の版と違う（GitHub 側で更新されていた）ときは 'conflict'、すでに無ければ 'missing'
 */
export async function deleteGithubFile(link: GithubLink, path: string, sha: string | null): Promise<'deleted' | 'missing' | 'conflict'> {
  let current = sha;
  if (!current) {
    const r = await gh(link, `/repos/${link.repo}/contents/${encPath(path)}?ref=${encodeURIComponent(link.branch)}`);
    if (r.status === 404) return 'missing';
    if (!r.ok) throw new Error(`GitHub からファイルの情報を取得できませんでした（${r.status}）`);
    current = ((await r.json()) as { sha: string }).sha;
  }
  const res = await gh(link, `/repos/${link.repo}/contents/${encPath(path)}`, {
    method: 'DELETE',
    body: JSON.stringify({ message: commitMessage(), sha: current, branch: link.branch }),
  });
  if (res.status === 404) return 'missing';
  if (res.status === 409 || res.status === 422) return 'conflict';
  if (!res.ok) throw new Error(`GitHub のファイルを削除できませんでした（${res.status}）`);
  await keepFolder(link, parentOf(path));
  return 'deleted';
}

/** GitHub 上のファイルを取得して返す（コピーは保存しない） */
export async function rawFile(link: GithubLink, path: string) {
  const res = await gh(link, `/repos/${link.repo}/contents/${encPath(path)}?ref=${encodeURIComponent(link.branch)}`, {
    headers: { Accept: 'application/vnd.github.raw' },
  });
  return res;
}

/** 連携しているすべてのワークスペースを同期する（定期実行） */
export async function syncAllGithub() {
  const links = await all<{ workspace_id: string }>('SELECT workspace_id FROM github_links');
  for (const l of links) {
    try {
      await syncWorkspace(l.workspace_id, null, { maxFetch: 25 });
    } catch (err) {
      console.error('[github] sync failed', l.workspace_id, err);
    }
  }
}

export async function unlinkWorkspace(workspaceId: string) {
  // ページはそのまま残し、通常のページに戻す
  await batch([
    sql(
      `UPDATE pages SET github_kind = NULL, github_path = NULL, github_sha = NULL, github_dirty = 0, source_md = NULL WHERE workspace_id = ? AND github_kind IS NOT NULL`,
      workspaceId,
    ),
    sql('DELETE FROM github_links WHERE workspace_id = ?', workspaceId),
  ]);
}
