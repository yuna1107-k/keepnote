/**
 * テンプレート。新しい空のページで「テンプレートから始める」を選ぶと、内容をそのまま入れる。
 * {{date}}（{{日付}}）は使った日の日付（例：2026/11/06）、{{year}}（{{年}}）は年（例：2026）に置き換える。
 */
export type TemplateSource = { id: string; title: string; icon: string | null; builtin?: boolean; description?: string; /** 一覧に出す名前（作るページの名前と違うとき） */ label?: string };
/** 日本十進分類法（NDC）の 10 の分類 */
export const NDC_CLASSES: [string, string][] = [
  ['0', '総記'],
  ['1', '哲学・宗教'],
  ['2', '歴史・地理'],
  ['3', '社会科学'],
  ['4', '自然科学'],
  ['5', '技術・工学'],
  ['6', '産業'],
  ['7', '芸術・スポーツ'],
  ['8', '言語'],
  ['9', '文学'],
];

/** テンプレートで一緒に変えるページの見た目 */
export type TemplateLook = {
  font?: 'default' | 'serif' | 'mono' | 'mushin';
  cover?: string;
  coverPosition?: number;
  fullWidth?: boolean;
  /** スライドで表示するときのテーマ（slideThemes.ts の id） */
  slideTheme?: string | null;
};
/** テンプレートで作るデータベース（列と表示）。使うと、そのページをデータベースにする */
export type TemplateDatabase = { kind?: 'books' | 'study'; props: { id: string; name: string; type: string; options?: { id: string; name: string; color: string }[] }[]; views: Record<string, unknown>[] };

const h = (level: number, text: string) => ({ type: 'heading', props: { level }, content: [{ type: 'text', text, styles: {} }] });
const p = (text = '') => ({ type: 'paragraph', content: text ? [{ type: 'text', text, styles: {} }] : [] });
const bullet = (text = '') => ({ type: 'bulletListItem', content: text ? [{ type: 'text', text, styles: {} }] : [] });
const check = () => ({ type: 'checkListItem', props: { checked: false }, content: [] });
/** 灰色の小さな説明の文 */
const hint = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: { textColor: 'gray' } }] });
const divider = () => ({ type: 'divider' });
/** 太字を含む箇条書き：[['太字', true], ['ふつう']] */
const richBullet = (parts: [string, boolean?][]) => ({
  type: 'bulletListItem',
  content: parts.map(([text, bold]) => ({ type: 'text', text, styles: bold ? { bold: true } : {} })),
});
/** 1 行目を見出しにした表（side=true なら、1 列目を見出しにした「項目：内容」の表） */
const table = (rows: string[][], side = false) => ({
  type: 'table',
  content: {
    type: 'tableContent',
    ...(side ? { headerCols: 1 } : { headerRows: 1 }),
    rows: rows.map((r) => ({
      cells: r.map((text) => ({
        type: 'tableCell',
        props: { backgroundColor: 'default', textColor: 'default', textAlignment: 'left', colspan: 1, rowspan: 1 },
        content: text ? [{ type: 'text', text, styles: {} }] : [],
      })),
    })),
  },
});

/** 最初から用意しているテンプレート */
export const BUILTIN_TEMPLATES: (TemplateSource & { content: any[]; look?: TemplateLook; database?: TemplateDatabase })[] = [
  {
    // 読んだ本の記録。1 冊が 1 行（行のページに感想を書ける）
    id: 'builtin:books',
    builtin: true,
    title: '読書記録',
    icon: 'ms:menu_book',
    description: '読んだ本を 1 冊ずつ記録するシート。ISBN・バーコードから本を追加でき（タイトル・著者・表紙は自動）、点数（100 点満点）と感想を記録し、冊数・ページ数・費用を年・月・週ごとに集計できます',
    content: [p('「本を追加」から ISBN を入力するかバーコードを読むと、タイトル・著者・表紙が自動で入ります。評価と感想は表で、長い感想は本のページを開いて書けます。')],
    look: { fullWidth: true },
    database: {
      kind: 'books',
      props: [
        { id: 'author', name: '著者', type: 'text' },
        {
          id: 'status',
          name: '状態',
          type: 'select',
          options: [
            { id: 'want', name: '読みたい', color: 'gray' },
            { id: 'reading', name: '読書中', color: 'blue' },
            { id: 'done', name: '読了', color: 'green' },
            { id: 'stopped', name: '中断', color: 'orange' },
          ],
        },
        // 評価は点数（100 点満点）で入れる
        { id: 'rating', name: '点数（100点満点）', type: 'number' },
        { id: 'review', name: '感想', type: 'text' },
        { id: 'started', name: '読み始めた日', type: 'date' },
        { id: 'finished', name: '読み終えた日', type: 'date' },
        {
          // 日本十進分類法（NDC）の大きな分類
          id: 'genre',
          name: 'ジャンル',
          type: 'multi_select',
          options: NDC_CLASSES.map(([d, name], i) => ({ id: `ndc${d}`, name: `${d} ${name}`, color: ['gray', 'purple', 'brown', 'blue', 'green', 'orange', 'yellow', 'pink', 'red', 'blue'][i]! })),
        },
        { id: 'ndc', name: '分類番号', type: 'text' },
        { id: 'pages', name: 'ページ数', type: 'number' },
        { id: 'price', name: '定価（円）', type: 'number' },
        { id: 'publisher', name: '出版社', type: 'text' },
        { id: 'isbn', name: 'ISBN', type: 'text' },
      ],
      views: [
        { id: 'shelf', name: '本棚', type: 'gallery', sort: { prop: 'finished', dir: 'desc' }, filters: [] },
        { id: 'table', name: '一覧', type: 'table', sort: { prop: 'finished', dir: 'desc' }, filters: [], hidden: ['publisher', 'isbn', 'started', 'ndc'] },
        { id: 'board', name: '状態ごと', type: 'board', groupBy: 'status', filters: [] },
        { id: 'calendar', name: '読み終えた日', type: 'calendar', dateProp: 'finished', filters: [] },
      ],
    },
  },
  {
    // 日記のまとめページ。下に「2026/11/06 Fri」のような日記を作ると、年のカレンダーと日付順の一覧になる
    id: 'builtin:journal',
    builtin: true,
    label: 'Journal',
    title: 'Journal {{year}}',
    icon: 'ms:book',
    description: '日記をまとめるページ。年のカレンダーから日付を押して、その日の日記を書けます',
    content: [],
    look: { font: 'mushin', cover: 'photo:ocean', coverPosition: 50, fullWidth: true },
  },
  {
    id: 'builtin:lecture',
    builtin: true,
    title: '講義ノート {{date}}',
    icon: 'ms:school',
    description: '科目・回・日付の表と、テーマ・ノート・キーワード・疑問点・課題・まとめの欄が入った講義のノート。前回のノートへのリンクや課題の期限も入れられます',
    content: [
      table(
        [
          ['科目', ''],
          ['回', '第　回'],
          ['日付', '{{date}}'],
          ['担当・教室', ''],
          ['前回・関連', ''],
        ],
        true,
      ),
      hint('「/ページへのリンク」か [[ で、前回のノートや資料のページへリンクできます。課題に「/期限」を付けると「タスク」に並びます。'),
      h(2, '今日のテーマ'),
      p(),
      h(2, 'ノート'),
      bullet(),
      h(2, 'キーワード'),
      table([
        ['用語', '意味・説明'],
        ['', ''],
        ['', ''],
      ]),
      h(2, '疑問点・質問すること'),
      check(),
      h(2, '課題・次回までに'),
      check(),
      h(2, 'まとめ（3 行で）'),
      p(),
    ],
  },
  {
    // 勉強した時間の記録。1 回の勉強が 1 行（講義ノートは builtin:lecture で別に書く）
    id: 'builtin:study',
    builtin: true,
    label: '勉強時間記録',
    title: '勉強時間記録',
    icon: 'ms:timer',
    description: '勉強した時間を科目・種類（自習・予習・復習・課題・試験勉強）ごとに記録するシート。勉強時間を今日・今週・今月や、週・月・年ごと、科目ごとに集計できます',
    content: [p('「勉強時間を記録」で科目・種類・時間を入れて記録します。「勉強時間の集計」で、今日・今週・今月や科目ごとの時間を見られます。')],
    look: { fullWidth: true },
    database: {
      kind: 'study',
      props: [
        { id: 'subject', name: '科目', type: 'select', options: [] },
        {
          id: 'type',
          name: '種類',
          type: 'select',
          options: [
            { id: 'self', name: '自習', color: 'green' },
            { id: 'prep', name: '予習', color: 'blue' },
            { id: 'review', name: '復習', color: 'purple' },
            { id: 'homework', name: '課題', color: 'orange' },
            { id: 'exam', name: '試験勉強', color: 'red' },
          ],
        },
        { id: 'date', name: '日付', type: 'date' },
        { id: 'minutes', name: '時間（分）', type: 'number' },
        { id: 'memo', name: 'メモ', type: 'text' },
      ],
      views: [
        { id: 'table', name: '一覧', type: 'table', sort: { prop: 'date', dir: 'desc' }, filters: [] },
        { id: 'calendar', name: 'カレンダー', type: 'calendar', dateProp: 'date', filters: [] },
        { id: 'subject', name: '科目ごと', type: 'board', groupBy: 'subject', filters: [] },
      ],
    },
  },
  {
    id: 'builtin:slides',
    builtin: true,
    label: 'スライド',
    title: 'スライドプレゼンテーション',
    icon: 'ms:slideshow',
    description: 'Markdown でスライドを作成するテンプレート。---（区切り線）でスライドを区切り、プレゼンテーションとして表示・発表できます',
    look: { fullWidth: true },
    content: [
      h(1, 'プレゼンテーションのタイトル'),
      p('サブタイトル / 発表者名（{{date}}）'),
      divider(),
      h(2, 'アジェンダ'),
      bullet('背景と課題'),
      bullet('提案内容'),
      bullet('期待される効果'),
      bullet('今後のスケジュール'),
      divider(),
      h(2, '背景と課題'),
      bullet('現在の状況と取り巻く環境'),
      bullet('解決すべき主要な課題'),
      bullet('本提案が目指すゴール'),
      divider(),
      h(2, '提案内容'),
      bullet('コアとなるアプローチ'),
      bullet('他手法との比較と優位性'),
      bullet('実現のための具体的なステップ'),
      divider(),
      h(2, 'まとめ'),
      bullet('本日の要点'),
      bullet('質疑応答'),
    ],
  },
  {
    // 調査をもとにした授業・ゼミの発表の組み立て（背景から結論まで）を型にしたもの
    id: 'builtin:research-slides',
    builtin: true,
    label: '研究発表スライド',
    title: '研究発表',
    icon: 'ms:co_present',
    description:
      '背景・先行研究・仮説・調査の概要・結果・考察・結論の順に組んだ発表スライド。スライドで表示すると「研究発表」テーマ（白地に青緑の見出し、太字は赤瓦色）になり、スライドの画面の「テーマ」から変えられます',
    look: { fullWidth: true, slideTheme: 'academic' },
    content: [
      h(1, '発表のタイトル'),
      p('授業名・班名・発表者（{{date}}）'),
      divider(),
      h(2, '背景'),
      bullet('取り上げる問題と、その背景にある事実'),
      bullet('きっかけになった記事や文献（著者・年）'),
      bullet('数字で示せることは数字で（例：計画 44 件のうち目標を達成したのは 0 件）'),
      divider(),
      h(2, '先行研究'),
      table([
        ['文献', '主張'],
        ['著者（年）', '主張を 1 文で'],
        ['著者（年）', '主張を 1 文で'],
      ]),
      p('先行研究で扱われていない点と、この調査で明らかにすること'),
      divider(),
      h(2, '仮説'),
      table([
        ['', '仮説'],
        ['仮説1', '〇〇な人ほど、△△である'],
        ['仮説2', '〇〇な人ほど、△△である'],
      ]),
      divider(),
      h(2, '調査の概要'),
      bullet('実施日・対象・人数'),
      bullet('方法（アンケート・インタビューなど）と設問の数'),
      bullet('分析の手順（単純集計で仮説を見直し、クロス集計で確かめる など）'),
      divider(),
      h(2, '結果の見出しには、わかったことを 1 文で書く'),
      p('図やグラフは「/画像」で入れる'),
      bullet('人数と割合をそろえて書く（例：13 人（76%））'),
      richBullet([['いちばん伝えたいことは太字にする', true], ['（テーマの強調の色になります）']]),
      divider(),
      h(2, '結果：2 つ目のわかったこと'),
      bullet('仮説と比べて、支持されたか・されなかったか'),
      bullet('予想と違った点も書く'),
      divider(),
      h(2, '検証結果のまとめ'),
      table([
        ['', '結果', 'わかったこと'],
        ['仮説1', '支持／一部支持／不支持', ''],
        ['仮説2', '支持／一部支持／不支持', ''],
      ]),
      divider(),
      h(2, '考察'),
      bullet('結果から言えること'),
      bullet('先行研究と同じ点・違う点'),
      divider(),
      h(2, '調査の限界'),
      bullet('回答者の人数や偏り'),
      bullet('設問の不備や、比べられなかったこと'),
      divider(),
      h(2, '結論'),
      richBullet([['問いへの答えを 1〜2 文で', true]]),
      bullet('提案や、これから調べたいこと'),
      divider(),
      h(2, '参考文献'),
      bullet('著者（年）「題名」『掲載誌』巻(号)、頁'),
      bullet('著者（年）「記事名」サイト名、URL（閲覧日）'),
    ],
  },
];

function today() {
  const d = new Date();
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

export function fillTemplateText(text: string) {
  return text.replace(/\{\{\s*(date|日付)\s*\}\}/g, today()).replace(/\{\{\s*(year|年)\s*\}\}/g, String(new Date().getFullYear()));
}

/** ブロックの ID を外し（新しいページで作り直させる）、{{date}} を置き換える */
export function prepareTemplateBlocks(blocks: any[]): any[] {
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) {
        if (k === 'id') continue;
        out[k] = k === 'text' && typeof val === 'string' ? fillTemplateText(val) : walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(blocks);
}

/** 内容が空のページか（空の段落が 1 つだけ、など） */
export function isEmptyDocument(blocks: any[]) {
  return blocks.every((b) => b.type === 'paragraph' && (!Array.isArray(b.content) || b.content.length === 0) && !b.children?.length);
}

/** テンプレートのデータベースを、そのページに作る */
export async function applyTemplateDatabase(pageId: string, database: TemplateDatabase) {
  const { api } = await import('../api');
  await api(`/pages/${pageId}/database`, { method: 'POST' });
  await api(`/pages/${pageId}/database/schema`, { method: 'PUT', body: database });
}
