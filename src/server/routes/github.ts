/** GitHub 連携の API（接続・同期・送信・ファイル表示） */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { encryptText } from '../crypto.ts';
import { get, run } from '../db.ts';
import { getLink, getTextFile, githubUrl, pushPage, putBinaryFile, putTextFile, rawFile, syncWorkspace, TEXT_EXT, TEXT_MAX, unlinkWorkspace, verifyRepo } from '../github.ts';
import { accessMap } from '../permissions.ts';
import { me, requireAuth, type AppEnv, type SessionUser } from '../session.ts';
import { withStorageShim } from '../htmlShim.ts';
import { body, fail, now } from '../util.ts';
import { membership, requireContributor, requireManager } from './workspaces.ts';

export const githubRoutes = new Hono<AppEnv>();
// /rawt/ はトークン（URL のパス）で確かめるので、ログインの確認を通さない
githubRoutes.use('*', async (c, next) => (c.req.path.includes('/github/rawt/') ? next() : requireAuth(c, next)));

/* ---------- HTML のプレビュー用のトークン ----------
 * HTML のプレビューは、このサイトの権限で動かないよう sandbox（別のオリジン扱い）で開く。そのため、
 * 中の HTML が相対パスで読む画像などのリクエストにはログインの cookie が付かない（SameSite=Lax）。
 * そこで、URL のパスに期限付きのトークンを入れて配信する（/rawt/<トークン>/<ワークスペース>/<パス>）。
 * 相対パスはこのパスの下に解決されるので、同じフォルダの画像などもトークンで読める。
 * トークンはセッションに結びつけ、セッションだけが持つ値（token_hash）で署名する（ログアウトすると使えなくなる）。
 */
const RAW_TOKEN_MS = 2 * 3600_000;

async function hmacHex(key: string, msg: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** トークンの文字列が正しければ、その人（セッションが有効なときだけ） */
async function rawTokenUser(token: string, wsId: string): Promise<SessionUser | null> {
  const [sessionId, expStr, mac] = token.split('.');
  const exp = Number(expStr);
  if (!sessionId || !mac || !Number.isFinite(exp) || exp < now()) return null;
  const row = await get<SessionUser & { token_hash: string; expires_at: number }>(
    `SELECT s.token_hash, s.expires_at, u.id, u.username, u.display_name, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND u.status = 'active'`,
    sessionId,
  );
  if (!row || row.expires_at < now()) return null;
  const want = await hmacHex(row.token_hash, `${sessionId}.${exp}.${wsId}`);
  if (want.length !== mac.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ mac.charCodeAt(i);
  if (diff) return null;
  return { id: row.id, username: row.username, display_name: row.display_name, role: row.role };
}

/** HTML のプレビュー用の URL の先頭（/api/github/rawt/<トークン>/<ワークスペース>/） */
githubRoutes.get('/raw-token/:wsId', async (c) => {
  me(c);
  const sessionId = c.get('sessionId');
  const wsId = c.req.param('wsId');
  const row = sessionId ? await get<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE id = ?', sessionId) : null;
  if (!sessionId || !row) fail(401, 'ログインが必要です');
  const exp = now() + RAW_TOKEN_MS;
  const token = `${sessionId}.${exp}.${await hmacHex(row.token_hash, `${sessionId}.${exp}.${wsId}`)}`;
  return c.json({ prefix: `/api/github/rawt/${token}/${wsId}/`, expiresAt: exp });
});


function publicLink(l: NonNullable<Awaited<ReturnType<typeof getLink>>>) {
  return {
    repo: l.repo,
    branch: l.branch,
    rootPath: l.root_path,
    rootPageId: l.root_page_id,
    url: githubUrl(l, l.root_path, 'root'),
    lastSyncAt: l.last_sync_at,
    lastSyncStatus: l.last_sync_status,
    lastSyncError: l.last_sync_error,
  };
}

githubRoutes.get('/workspaces/:id', async (c) => {
  const { ws } = await requireContributor(c.req.param('id'), me(c));
  const link = await getLink(ws.id);
  return c.json({ link: link ? publicLink(link) : null });
});

/** 接続（または設定の変更）。トークンは暗号化して保存し、画面には返さない */
githubRoutes.put('/workspaces/:id', async (c) => {
  const u = me(c);
  const { ws } = await requireManager(c.req.param('id'), u);
  const input = await body(
    c,
    z.object({
      repo: z.string().trim().min(3).max(200),
      branch: z.string().trim().max(200).default(''),
      rootPath: z.string().trim().max(500).default(''),
      token: z.string().trim().max(400).optional(),
    }),
  );
  const existing = await getLink(ws.id);
  const rootPath = input.rootPath.replace(/^\/+|\/+$/g, '');
  if (existing && !input.token) {
    if (existing.repo !== input.repo || existing.root_path !== rootPath || (input.branch && existing.branch !== input.branch)) {
      fail(400, 'リポジトリ・ブランチ・ルートパスを変更する際は、新しいアクセストークンを入力してください');
    }
  }
  const token = input.token || existing?.token;
  if (!token) fail(400, 'アクセストークンを入力してください');
  const { branch, canPush } = await verifyRepo(input.repo, input.branch, token);
  if (existing && !input.token && existing.branch !== branch) {
    fail(400, 'リポジトリ・ブランチ・ルートパスを変更する際は、新しいアクセストークンを入力してください');
  }
  if (!canPush) fail(400, 'このトークンにはリポジトリへの書き込み権限がありません（Contents: Read and write が必要です）');
  if (existing && (existing.repo !== input.repo || existing.branch !== branch || existing.root_path !== rootPath)) {
    // 接続先が変わる場合は、今までのページを通常のページに戻してから接続し直す
    await unlinkWorkspace(ws.id);
  }
  const enc = await encryptText(token);
  if (existing && existing.repo === input.repo && existing.branch === branch && existing.root_path === rootPath) {
    await run('UPDATE github_links SET token = ? WHERE workspace_id = ?', enc, ws.id);
  } else {
    await run(
      `INSERT INTO github_links (workspace_id, repo, branch, root_path, token, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ws.id,
      input.repo,
      branch,
      rootPath,
      enc,
      u.id,
      now(),
    );
  }
  await audit(c, { id: u.id, username: u.username }, 'github.link', { type: 'workspace', id: ws.id, name: ws.name }, { repo: input.repo, branch });
  const result = await syncWorkspace(ws.id, u.id, { maxFetch: 25 });
  return c.json({ link: publicLink((await getLink(ws.id))!), result });
});

githubRoutes.delete('/workspaces/:id', async (c) => {
  const u = me(c);
  const { ws } = await requireManager(c.req.param('id'), u);
  await unlinkWorkspace(ws.id);
  await audit(c, { id: u.id, username: u.username }, 'github.unlink', { type: 'workspace', id: ws.id, name: ws.name });
  return c.json({ ok: true });
});

/** 今すぐ同期（取り込みは 1 回あたり上限があり、残りがあれば pending で返す） */
githubRoutes.post('/workspaces/:id/sync', async (c) => {
  const u = me(c);
  const { ws } = await requireContributor(c.req.param('id'), u);
  const result = await syncWorkspace(ws.id, u.id, { maxFetch: 25 });
  return c.json({ link: publicLink((await getLink(ws.id))!), result });
});

/** 編集したページを GitHub にコミットする */
githubRoutes.post('/pages/:id/push', async (c) => {
  const u = me(c);
  const page = await get<{ id: string; workspace_id: string }>('SELECT id, workspace_id FROM pages WHERE id = ?', c.req.param('id'));
  if (!page) fail(404, 'ページが見つかりません');
  const role = await membership(page.workspace_id, u.id);
  const level = (await accessMap(page.workspace_id, u, !!role, role === 'viewer', role === 'owner' || role === 'admin')).get(page.id);
  if (level !== 'edit' && level !== 'full') fail(403, 'このページを編集する権限がありません');
  const status = await pushPage(page.id, u.id);
  // 名前や場所が変わった場合に画面を作り直せるよう、今のパスも返す
  const after = await get<{ github_path: string | null }>('SELECT github_path FROM pages WHERE id = ?', page.id);
  return c.json({ status, path: after?.github_path ?? null });
});

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  weba: 'audio/webm',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
};

/**
 * URL の後ろのファイルパスを取り出し、そのファイルのあるフォルダ（なければリポジトリのページ）を見る権限を確かめる。
 * 権限がなければ 404（ファイルがあることも知らせない）。
 */
async function fileAccess(c: Context<AppEnv>, kind: 'raw' | 'file' | 'bin', token?: string) {
  const u = me(c);
  const wsId = c.req.param('wsId') ?? '';
  const prefix = token ? `/api/github/rawt/${token}/${wsId}/` : `/api/github/${kind}/${wsId}/`;
  const path = decodeURIComponent(new URL(c.req.url).pathname.slice(prefix.length));
  if (!path || path.split('/').some((s) => s === '..' || s === '' || s.startsWith('.'))) fail(400, 'パスが正しくありません');
  const link = await getLink(wsId);
  if (!link) fail(404, 'GitHub と連携していません');
  const root = link.root_path;
  if (root && !(path === root || path.startsWith(root + '/'))) fail(404, 'ファイルが見つかりません');
  const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
  const holder =
    dir && dir !== root
      ? await get<{ id: string }>(`SELECT id FROM pages WHERE workspace_id = ? AND github_kind = 'dir' AND github_path = ? AND deleted_at IS NULL`, wsId, dir)
      : (link.root_page_id ? await get<{ id: string }>(`SELECT id FROM pages WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`, wsId, link.root_page_id) : null);
  if (!holder) fail(404, 'ファイルが見つかりません');
  const role = await membership(wsId, u.id);
  const aMap = await accessMap(wsId, u, !!role, role === 'viewer', role === 'owner' || role === 'admin');
  const holderLevel = aMap.get(holder.id) ?? 'none';
  if (holderLevel === 'none') fail(404, 'ファイルが見つかりません');

  // ファイル自身のページがあればその権限も確認
  const filePage = await get<{ id: string }>(
    `SELECT id FROM pages WHERE workspace_id = ? AND github_kind = 'file' AND github_path = ? AND deleted_at IS NULL`,
    wsId,
    path,
  );
  let effectiveLevel = holderLevel;
  if (filePage) {
    const fileLevel = aMap.get(filePage.id) ?? 'none';
    if (fileLevel === 'none') fail(404, 'ファイルが見つかりません');
    effectiveLevel = fileLevel;
  }
  return { u, wsId, link, path, canEdit: effectiveLevel === 'edit' || effectiveLevel === 'full' };
}

/** GitHub 上のファイルをその都度取得して表示する（フォルダのページを見られる人のみ） */
githubRoutes.get('/raw/:wsId/*', (c) => serveRaw(c));

/** HTML のプレビュー用（URL のパスのトークンで確かめる。上の説明を参照） */
githubRoutes.get('/rawt/:token/:wsId/*', async (c) => {
  const token = c.req.param('token');
  const user = await rawTokenUser(token, c.req.param('wsId'));
  if (!user) fail(401, 'ページを開き直してください（表示の期限が切れました）');
  c.set('user', user);
  return serveRaw(c, token);
});

async function serveRaw(c: Context<AppEnv>, token?: string) {
  const { link, path } = await fileAccess(c, 'raw', token);
  const res = await rawFile(link, path);
  if (!res.ok || !res.body) fail(res.status === 404 ? 404 : 502, 'GitHub からファイルを取得できませんでした');
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const name = path.split('/').pop()!;
  const isText = TEXT_EXT.test(name);
  const type = TYPES[ext] ?? (isText ? 'text/plain; charset=utf-8' : 'application/octet-stream');
  const inline = !!TYPES[ext] || isText;
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    // アプリ内のビューア（同じサイトの iframe）では表示できるようにする
    'X-Frame-Options': 'SAMEORIGIN',
    'Cache-Control': 'private, max-age=300',
  };
  // リポジトリ内のファイルをこのサイトの権限で実行させない（PDF ビューアは sandbox 下で動かないため除外。PDF にこのサイトのスクリプトは実行できない）
  // トークンの入った URL を、ほかのサイトへの Referer で漏らさない
  if (token) headers['Referrer-Policy'] = 'no-referrer';
  if (ext === 'html' || ext === 'htm') {
    headers['Content-Security-Policy'] = "sandbox allow-scripts allow-popups allow-forms; default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' *; img-src * data: blob:; style-src * 'unsafe-inline'; script-src * 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'";
    return new Response(withStorageShim(await res.text()), { headers });
  } else if (ext !== 'pdf') {
    headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; frame-ancestors 'self'";
  }
  return new Response(res.body, { headers });
}

/** テキストファイルの中身（編集用）。canEdit はフォルダのページを編集できるか */
githubRoutes.get('/file/:wsId/*', async (c) => {
  const { link, path, canEdit } = await fileAccess(c, 'file');
  if (!TEXT_EXT.test(path)) fail(400, 'テキストファイルではありません');
  let file: Awaited<ReturnType<typeof getTextFile>>;
  try {
    file = await getTextFile(link, path);
  } catch (e) {
    if (e instanceof Error && e.message === 'TOO_LARGE') fail(413, 'ファイルが大きすぎるため、ここでは開けません（1MB まで）');
    throw e;
  }
  if (!file) fail(404, 'ファイルが見つかりません');
  return c.json({ text: file.text, sha: file.sha, canEdit, branch: link.branch });
});

/** テキストファイルを編集して GitHub にコミットする */
/** 画像・Excel などを編集した内容を、そのまま GitHub にコミットする（本文はファイルの中身そのもの） */
const BIN_EDITABLE = /\.(png|jpe?g|webp|xlsx|xlsm|ods|docx|pptx)$/i;
const BIN_MAX = 10 * 1024 * 1024;
githubRoutes.put('/bin/:wsId/*', async (c) => {
  const { u, wsId, link, path, canEdit } = await fileAccess(c, 'bin');
  if (!canEdit) fail(403, 'このファイルを編集する権限がありません');
  if (!BIN_EDITABLE.test(path)) fail(400, 'この形式のファイルは保存できません');
  if (Number(c.req.header('content-length') ?? 0) > BIN_MAX) fail(413, 'ファイルが大きすぎます');
  const data = new Uint8Array(await c.req.arrayBuffer());
  if (!data.byteLength) fail(400, 'ファイルが空です');
  if (data.byteLength > BIN_MAX) fail(413, 'ファイルが大きすぎます');
  const page = await get<{ github_sha: string | null }>(
    `SELECT github_sha FROM pages WHERE workspace_id = ? AND github_kind = 'file' AND github_path = ? AND deleted_at IS NULL`,
    wsId,
    path,
  );
  const result = await putBinaryFile(link, path, data, page?.github_sha ?? null);
  if (result === 'conflict') fail(409, 'GitHub 側でファイルが更新されています。開き直してから編集してください');
  await run(
    `UPDATE pages SET github_sha = ?, updated_at = ?, updated_by = ? WHERE workspace_id = ? AND github_kind = 'file' AND github_path = ? AND deleted_at IS NULL`,
    result.sha,
    now(),
    u.id,
    wsId,
    path,
  );
  await audit(c, { id: u.id, username: u.username }, 'github.file.edit', { type: 'workspace', id: wsId, name: path }, { path });
  return c.json({ sha: result.sha });
});

githubRoutes.put('/file/:wsId/*', async (c) => {
  const { u, wsId, link, path, canEdit } = await fileAccess(c, 'file');
  if (!canEdit) fail(403, 'このファイルを編集する権限がありません');
  if (!TEXT_EXT.test(path)) fail(400, 'テキストファイルではありません');
  const input = await body(c, z.object({ text: z.string().max(TEXT_MAX), sha: z.string().regex(/^[0-9a-f]{40,64}$/) }));
  const result = await putTextFile(link, path, input.text, input.sha);
  if (result === 'conflict') fail(409, 'GitHub 側でファイルが更新されています。開き直してから編集してください');
  // ファイルのページにも新しい版と最終編集者を記録する（次の同期で「更新あり」と扱わないように）
  await run(
    `UPDATE pages SET github_sha = ?, updated_at = ?, updated_by = ? WHERE workspace_id = ? AND github_kind = 'file' AND github_path = ? AND deleted_at IS NULL`,
    result.sha,
    now(),
    u.id,
    wsId,
    path,
  );
  await audit(c, { id: u.id, username: u.username }, 'github.file.edit', { type: 'workspace', id: wsId, name: path }, { path });
  return c.json({ sha: result.sha });
});
