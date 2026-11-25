/**
 * 開発用のサンプルデータを入れる（`npm run dev:local` で動かしているサーバーに、API 経由で入れる）。
 *
 *   npm run seed:dev [-- --url http://localhost:5174]
 *
 * 開発用ログイン（dev）でログインし、「開発用」ワークスペースに、いろいろなブロックのページ・講義ノート・
 * 勉強時間記録（記録つき）・日記を作る。何度実行しても、同じ名前のページがあれば作り直さない。
 */
import { BUILTIN_TEMPLATES, prepareTemplateBlocks } from '../src/web/workspace/templates.ts';
import { blocksToText } from '../src/web/workspace/text.ts';

const urlArg = process.argv.indexOf('--url');
const BASE = (urlArg >= 0 ? process.argv[urlArg + 1] : process.env.SEED_URL) ?? 'http://localhost:5174';
let cookie = '';

async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  const text = await res.text();
  if (!res.ok) throw new Error(`${opts.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

const t = (text: string, styles: Record<string, unknown> = {}) => ({ type: 'text', text, styles });
const h = (level: number, text: string) => ({ type: 'heading', props: { level }, content: [t(text)] });
const p = (...parts: (string | ReturnType<typeof t>)[]) => ({ type: 'paragraph', content: parts.map((x) => (typeof x === 'string' ? t(x) : x)) });
const bullet = (text: string) => ({ type: 'bulletListItem', content: [t(text)] });
const check = (text: string, checked = false) => ({ type: 'checkListItem', props: { checked }, content: [t(text)] });

async function setContent(id: string, blocks: any[], extra: Record<string, unknown> = {}) {
  const { page } = await api<{ page: { version: number } }>(`/pages/${id}`);
  await api(`/pages/${id}`, { method: 'PATCH', body: { version: page.version, content: blocks, contentText: blocksToText(blocks), ...extra } });
}

async function main() {
  try {
    await api('/auth/dev-login', { body: { username: 'dev' } });
  } catch (e) {
    throw new Error(`開発用ログインに失敗しました。サーバーを npm run dev:local で動かしているか確かめてください。\n${(e as Error).message}`);
  }
  // ワークスペース
  const { workspaces } = await api<{ workspaces: { id: string; name: string }[] }>('/workspaces');
  let ws = workspaces.find((w) => w.name === '開発用');
  if (!ws) ws = (await api<{ workspace: { id: string; name: string } }>('/workspaces', { body: { name: '開発用', iconEmoji: '🧪' } })).workspace;
  const { pages } = await api<{ pages: { id: string; title: string; parentId: string | null }[] }>(`/pages?workspace=${ws.id}`);
  const exists = (title: string) => pages.some((x) => x.title === title && !x.parentId);
  const create = async (title: string, icon: string | null, parentId: string | null = null) =>
    (await api<{ page: { id: string } }>('/pages', { body: { parentId, workspaceId: ws!.id, title, icon } })).page.id;

  // いろいろなブロック
  if (!exists('サンプル：いろいろなブロック')) {
    const id = await create('サンプル：いろいろなブロック', 'ms:widgets');
    await setContent(id, [
      h(1, '見出し 1'),
      p('ふつうの文と、', t('太字', { bold: true }), '・', t('斜体', { italic: true }), '・', t('コード', { code: true }), '。'),
      h(2, 'リスト'),
      bullet('箇条書き 1'),
      bullet('箇条書き 2'),
      check('終わったこと', true),
      check('まだのこと'),
      h(2, '数式'),
      { type: 'equation', props: { latex: '\\int_0^1 x^2 \\, dx = \\frac{1}{3}' } },
      h(2, 'HTML の埋め込み（SVG の図）'),
      {
        type: 'html',
        props: {
          html: '<figure style="text-align:center;margin:0"><svg viewBox="0 0 220 90" width="320"><rect x="6" y="20" width="60" height="50" rx="8" fill="#2f6f8f"/><rect x="80" y="10" width="60" height="70" rx="8" fill="#4f9fbf"/><rect x="154" y="35" width="60" height="35" rx="8" fill="#8fc7dc"/></svg><figcaption>図 1：埋め込んだ SVG</figcaption></figure>',
        },
      },
      h(2, '表'),
      {
        type: 'table',
        content: {
          type: 'tableContent',
          headerRows: 1,
          rows: [['項目', '値'], ['りんご', '120'], ['みかん', '80']].map((r) => ({ cells: r.map((x) => ({ type: 'tableCell', props: {}, content: [t(x)] })) })),
        },
      },
      h(2, 'コード'),
      { type: 'codeBlock', props: { language: 'ts' }, content: [t("const hello = (name: string) => `こんにちは、${name}`;")] },
    ]);
  }

  // 講義ノート（テンプレート）
  const lecture = BUILTIN_TEMPLATES.find((x) => x.id === 'builtin:lecture')!;
  if (!exists('講義ノート（サンプル）')) {
    const id = await create('講義ノート（サンプル）', lecture.icon);
    await setContent(id, prepareTemplateBlocks(lecture.content));
  }

  // 勉強時間記録（テンプレート＋この 10 週ぶんの記録）
  const study = BUILTIN_TEMPLATES.find((x) => x.id === 'builtin:study')!;
  if (!exists('勉強時間記録')) {
    const id = await create('勉強時間記録', study.icon);
    await setContent(id, prepareTemplateBlocks(study.content), { fullWidth: true });
    const subjects = [
      { id: 'linear', name: '線形代数', color: 'blue' },
      { id: 'english', name: '英語', color: 'green' },
      { id: 'prog', name: 'プログラミング', color: 'purple' },
    ];
    const schema = structuredClone(study.database!);
    schema.props.find((x) => x.id === 'subject')!.options = subjects;
    await api(`/pages/${id}/database`, { method: 'POST' });
    await api(`/pages/${id}/database/schema`, { method: 'PUT', body: schema });
    const types = ['self', 'prep', 'review', 'homework', 'exam'];
    const today = new Date();
    for (let i = 0; i < 40; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - Math.floor(i * 1.8));
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const s = subjects[i % subjects.length]!;
      const row = await create(`${s.name}の勉強`, null, id);
      await api(`/pages/${id}/database/rows/${row}`, { method: 'PATCH', body: { values: { subject: s.id, type: types[i % types.length], date, minutes: 30 + ((i * 37) % 120) } } });
    }
  }

  // 日記
  const year = new Date().getFullYear();
  if (!exists(`Journal ${year}`)) {
    const id = await create(`Journal ${year}`, 'ms:book');
    const d = new Date();
    const name = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]}`;
    const entry = await create(name, null, id);
    await setContent(entry, [p('今日の日記のサンプルです。')]);
  }

  console.log(`サンプルデータを入れました（ワークスペース「開発用」）。${BASE} を開き、「開発用ログイン（dev）」でログインしてください。`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
