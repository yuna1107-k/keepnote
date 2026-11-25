/**
 * 使い方（ヘルプ）のページ。目次から各項目へ移動できる。管理者には管理者向けの項目も表示する。
 */
import { useEffect, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Icon } from '../ui';
import type { IconName } from '../uiIcons';
import './help.css';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
/** ⌘ / Ctrl、Option / Alt を端末に合わせて表示する */
const MOD = isMac ? '⌘' : 'Ctrl';
const ALT = isMac ? 'Option' : 'Alt';

type SectionDef = { id: string; title: string; icon: IconName };

const SECTIONS: SectionDef[] = [
  { id: 'start', title: 'はじめに（ログインとパスキー）', icon: 'passkey' },
  { id: 'pages', title: 'ページを作る・整理する', icon: 'file' },
  { id: 'writing', title: '書く', icon: 'type' },
  { id: 'math', title: '数式', icon: 'functions' },
  { id: 'notes', title: '脚注と参考文献', icon: 'references' },
  { id: 'tasks', title: 'ToDo の期限とタスク', icon: 'task' },
  { id: 'comments', title: 'コメント', icon: 'comment' },
  { id: 'database', title: 'データベース', icon: 'database' },
  { id: 'links', title: 'ページへのリンクとバックリンク', icon: 'backlink' },
  { id: 'toc-templates', title: '目次とテンプレート', icon: 'toc' },
  { id: 'files', title: 'ファイルと PDF', icon: 'pdf' },
  { id: 'transfer', title: '取り込みと書き出し', icon: 'importExport' },
  { id: 'sharing', title: '共有と公開・権限', icon: 'share' },
  { id: 'collab', title: '共同編集', icon: 'users' },
  { id: 'history', title: '履歴とゴミ箱', icon: 'clock' },
  { id: 'workspaces', title: 'ワークスペースとプライベート', icon: 'grid' },
  { id: 'github', title: 'GitHub 連携', icon: 'github' },
  { id: 'app', title: 'アプリとして使う', icon: 'install' },
  { id: 'shortcuts', title: 'キーボードショートカット', icon: 'keyboard' },
  { id: 'trouble', title: '困ったとき', icon: 'help' },
];
const ADMIN_SECTION: SectionDef = { id: 'admin', title: '管理者の方へ', icon: 'shield' };

function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  // ルーターの状態はそのままに、アドレスバーにだけ項目の目印を付ける（再読み込みしても同じ場所へ）
  window.history.replaceState(window.history.state, '', `#${id}`);
}

function Section({ def, children }: { def: SectionDef; children: ReactNode }) {
  return (
    <section id={def.id} className="help-section" aria-labelledby={`${def.id}-title`}>
      <h2 id={`${def.id}-title`}>
        <span className="help-section-icon">
          <Icon name={def.icon} size={18} />
        </span>
        {def.title}
      </h2>
      {children}
    </section>
  );
}

/** キーの組み合わせ（例：⌘ + K） */
function Keys({ k }: { k: string[] }) {
  return (
    <span className="help-keys">
      {k.map((key, i) => (
        <span key={i}>
          {i > 0 && <span className="help-keys-plus">+</span>}
          <kbd>{key}</kbd>
        </span>
      ))}
    </span>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="help-note">
      <Icon name="info" size={16} />
      <div>{children}</div>
    </div>
  );
}

function ShortcutTable({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <div className="help-table-wrap">
      <table className="help-table">
        <tbody>
          {rows.map(([keys, what], i) => (
            <tr key={i}>
              <td className="help-table-key">{keys}</td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const def = (id: string) => SECTIONS.find((s) => s.id === id)!;

export default function HelpPage() {
  const { user, serviceName } = useAuth();
  const isAdmin = user?.role === 'admin';
  const sections = isAdmin ? [...SECTIONS, ADMIN_SECTION] : SECTIONS;
  const name = serviceName || 'keepnote';

  // アドレスに項目の目印（#…）が付いていれば、その項目から表示する
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    const t = setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 0);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="settings-page help">
      <h1 id="help-top">使い方</h1>
      <p className="help-lead">
        {name} は、自分のノートや資料をまとめておくための場所です。ページに文章・表・数式・画像・PDF などを入れて、階層で整理できます。必要な人とだけ共有したり、同時に編集したりもできます。
      </p>

      <nav className="help-toc" aria-label="目次">
        <div className="help-toc-title">目次</div>
        <ol>
          {sections.map((s) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  scrollToSection(s.id);
                }}
              >
                <Icon name={s.icon} size={16} />
                <span>{s.title}</span>
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <Section def={def('start')}>
        <p>パスワードは使いません。端末の指紋・顔認証・PIN などで本人を確かめる「パスキー」でログインします。</p>
        <h3>アカウントを登録する</h3>
        <ol className="help-steps">
          <li>アカウントは管理者が発行します。管理者から届いた登録リンクを開きます。</li>
          <li>「パスキーを作成」を押し、端末の案内に従います。</li>
          <li>これで登録は完了です。次からはログイン画面の「パスキーでログイン」で入れます。</li>
        </ol>
        <p className="help-small">登録リンクは有効期限までに 1 回だけ使えます。期限が切れたら、管理者に発行し直してもらってください。</p>

        <h3>別の端末でも使う</h3>
        <p>
          <strong>アカウント設定</strong>（サイドバーの「設定」）の「パスキー」で「パスキーを追加」を押すと、今使っている端末にもパスキーを作れます。端末をなくしたときに備えて、2 台以上に登録しておくのがおすすめです。iCloud キーチェーンなどで同期されているパスキーには「同期済み」と表示されます。
        </p>
        <Note>パスキーをすべてなくしてログインできなくなったときは、管理者にパスキーの再発行（復旧用のリンク）を頼んでください。</Note>

        <h3>アカウント設定でできること</h3>
        <ul>
          <li>表示名とアイコン（画像・絵文字・背景色）の変更</li>
          <li>テーマ（システムに合わせる・ライト・ダーク）の切り替え。どの端末でも同じテーマになります</li>
          <li>ログイン中の端末の確認と、ほかの端末からのログアウト</li>
        </ul>

        <h3>画面の見方</h3>
        <p>
          左のサイドバーにページの一覧が並びます。サイドバーは左上のボタンか <Keys k={[MOD, '\\']} /> で開け閉めできます。スマホでは左上のメニューボタンから開きます。
        </p>
      </Section>

      <Section def={def('pages')}>
        <h3>ページを作る</h3>
        <ul>
          <li>サイドバーの下にある「新規ページ」、またはホームの「新規ページ」を押します。</li>
          <li>ページの中にページ（サブページ）を作るには、ページのいちばん下の「サブページを追加」を押します。サイドバーでページにマウスを乗せたときの「＋」や「…」のメニューからも作れます。</li>
          <li>タイトルを入力して Enter を押すと、本文に移ります。</li>
        </ul>

        <h3>並べ替える・移動する</h3>
        <ul>
          <li>サイドバーのページをドラッグすると並べ替えられます。ほかのページの真ん中に重ねると、そのページの中に入ります。</li>
          <li>ページ右上の「…」メニューの「移動」からも、移動先を検索して移せます。</li>
          <li>よく使うページは右上の星で「お気に入り」に入れると、サイドバーの上に並びます。</li>
        </ul>

        <h3>探す</h3>
        <p>
          サイドバーの「検索」か <Keys k={[MOD, 'K']} /> で、ページのタイトルと本文に加えて、ページに貼ったファイル（PDF・Word・Excel・PowerPoint・テキスト）の中身からも探せます。何も入力しないときは、最近更新されたページが並びます。
        </p>

        <h3>見た目を整える</h3>
        <ul>
          <li>タイトルの上の「アイコンを追加」で、絵文字か Google のアイコン（日本語でも検索でき、色も選べます）を付けられます。</li>
          <li>「カバーを追加」で、ページの上に画像を表示できます（ギャラリー・アップロード・画像のリンクから選べます）。ギャラリーには、写真（自然・日本・勉強・宇宙）と名画（北斎・モネ・ゴッホ）、グラデーション・模様・紙やノート（付箋・方眼紙・原稿用紙など）・和柄・単色があります。</li>
          <li>
            右上の「…」メニューの「スタイル」で、フォント（サンセリフ・セリフ・等幅・無心）、小さい文字、全幅表示を切り替えられます。ページごとに設定できます。
          </li>
          <li>同じメニューの「ページをロック」をオンにすると、うっかり書き換えるのを防げます。右上の「ロック中」を押すと解除できます。</li>
          <li>ページ右上の本のボタンで「閲覧モード」になります。すべてのページが読むだけになり（編集の操作は隠れます）、サイドバーを隠して本文を大きく表示します。もう一度押すと戻ります。この端末で覚えておきます。</li>
          <li>「複製」でサブページごとコピーでき、「リンクをコピー」でページの URL をコピーできます。</li>
        </ul>
      </Section>

      <Section def={def('writing')}>
        <p>入力した内容は自動で保存されます。右上に「保存済み」「保存中…」などの状態が表示されます。</p>

        <h3>スラッシュメニュー</h3>
        <p>
          行の先頭で <kbd>/</kbd> を打つと、入れられるものの一覧が開きます。続けて文字を打つと絞り込めます（例：「/表」「/画像」）。
        </p>
        <ul className="help-columns">
          <li>見出し・折りたたみ見出し</li>
          <li>箇条書き・番号付きリスト</li>
          <li>チェックリスト・折りたたみリスト</li>
          <li>引用・コードブロック</li>
          <li>表</li>
          <li>画像・動画・音声・ファイル</li>
          <li>区切り線・改ページ</li>
          <li>絵文字</li>
          <li>数式・数式（文中）</li>
        </ul>

        <h3>ブロックを動かす・変える</h3>
        <ul>
          <li>行の左にマウスを乗せると出る「＋」で、その下に新しいブロックを入れられます。</li>
          <li>「⋮⋮」のつまみをドラッグすると並べ替えられます。クリックすると、色・削除・「種類を変更」（見出しやリストへの変換）のメニューが開きます。</li>
          <li>文字を選ぶと、太字・斜体・リンク・文字の色などのボタンが出ます。</li>
        </ul>

        <h3>Markdown の書き方で入力する</h3>
        <p>行の先頭で次のように打つと、そのブロックに変わります。</p>
        <ShortcutTable
          rows={[
            [<code># ／ ## ／ ###（＋スペース）</code>, '見出し 1 ／ 2 ／ 3'],
            [<code>- または *（＋スペース）</code>, '箇条書き'],
            [<code>1.（＋スペース）</code>, '番号付きリスト'],
            [<code>[]（＋スペース）</code>, 'チェックリスト（[x] でチェック済み）'],
            [<code>&gt;（＋スペース）</code>, '引用'],
            [<code>```（＋スペース）</code>, 'コードブロック'],
            [<code>---</code>, '区切り線'],
            [<code>**文字**</code>, '太字'],
            [<code>*文字*</code>, '斜体'],
            [<code>`文字`</code>, 'コード（文中）'],
            [<code>$x^2$</code>, '数式（文中）'],
          ]}
        />

        <h3>記号の自動変換</h3>
        <p>
          次のように打つと、自動で記号に変わります。変わった直後に <Keys k={[MOD, 'Z']} /> を押すと、打ったとおりの文字に戻せます。コード・数式の中とタイトルでは変わりません（<code>$5 -&gt;</code> のような金額の $ は数式とみなさないので、変わります）。
        </p>
        <ShortcutTable
          rows={[
            [<code>-&gt; ／ &lt;- ／ &lt;-&gt;</code>, '→ ／ ← ／ ↔'],
            [<code>=&gt; ／ &lt;=&gt;</code>, '⇒ ／ ⇔'],
            [<code>!= ／ &gt;= ／ &lt;=</code>, '≠ ／ ≥ ／ ≤'],
            [<code>+-</code>, '±'],
            [<code>...</code>, '…'],
            [<code>--</code>, '—（ダッシュ）'],
            [<code>(c) ／ (r) ／ (tm)</code>, '© ／ ® ／ ™'],
          ]}
        />

        <h3>文字数を見る</h3>
        <p>
          タイトルの下に、ページの文字数（空白・改行を除く）が表示されます。押すと、空白を含む文字数・単語数・原稿用紙（400 字）の枚数も確認できます。文字を選ぶと、選んだ部分の文字数が画面の右下に表示されます。Web で公開したページや、GitHub のテキストファイル（.txt など）のページでも同じように見られます。
        </p>
        <p className="help-small">
          よく使うキー操作は「<a href="#shortcuts" onClick={(e) => { e.preventDefault(); scrollToSection('shortcuts'); }}>キーボードショートカット</a>」にまとめています。
        </p>
      </Section>

      <Section def={def('math')}>
        <p>LaTeX の書き方で数式を入れられます。</p>
        <ul>
          <li>
            <strong>文の中の数式</strong>：<code>$x^2 + y^2 = r^2$</code> のように $ で挟んで打つと、閉じる $ を打った時点で数式になります。スラッシュメニューの「数式（文中）」からも入れられます。
          </li>
          <li>
            <strong>独立した数式</strong>：スラッシュメニューの「数式」で、1 行を使った大きな数式を入れられます。
          </li>
          <li>数式をクリックすると LaTeX を編集でき、入力中も仕上がりを確認できます。文中の数式は Enter、独立した数式は <Keys k={[MOD, 'Enter']} /> で確定します（Esc でも閉じます）。</li>
        </ul>
        <p className="help-small">
          Markdown の取り込み・書き出しや GitHub 連携では、<code>$...$</code>・<code>$$...$$</code>・<code>```math</code> を数式として扱います。PDF の書き出しでも数式はきれいに組まれます。
        </p>
      </Section>

      <Section def={def('notes')}>
        <p>大学のレポートなどで使う脚注と、参考文献の一覧・文中の引用を入れられます。</p>
        <h3>脚注</h3>
        <ul>
          <li>
            スラッシュメニューの「脚注」を選ぶか、本文で <code>[^脚注の文]</code> と打つと、文に小さな番号が付きます。番号は本文の順に自動で 1, 2, 3… と振られます。
          </li>
          <li>番号を押すと、脚注の文を確認・編集できます。脚注の文は、ページの最後に「脚注」としてまとめて表示されます。</li>
        </ul>
        <h3>参考文献と引用</h3>
        <ul>
          <li>
            スラッシュメニューの「参考文献」でブロックを入れ、<strong>BibTeX</strong>（Google Scholar や CiNii の「BibTeX」をそのまま貼れます）か、<strong>1 行に 1 件</strong>の文献を書きます。著者・年・題名・雑誌名・出版社を、レポートでよく使う形に整えて並べます（日本語の文献が先、続いて英語の文献）。
          </li>
          <li>
            本文で <code>[@キー]</code> と打つと、「山田 (2020)」「Smith &amp; Jones (2019)」のように引用できます。ページも書くときは <code>[@キー, p. 12]</code> とします。キーは参考文献のブロックの各行の右に表示されます（BibTeX では <code>@book{'{'}キー, …</code> のキー、1 行の文献では「著者名＋年」。行の頭に <code>[キー]</code> と書くと自分で決められます）。
          </li>
          <li>スラッシュメニューの「文献の引用」からは、一覧から文献を選んで入れられます。</li>
        </ul>
        <p className="help-small">
          PDF で書き出す（レポート形式）と、脚注は本文の番号と「注」の一覧（参考文献の前）になります。Markdown の書き出しや GitHub 連携では、脚注は <code>[^1]</code>、引用は <code>[@キー]</code> の書き方になり、読み込み直しても元に戻ります。
        </p>
      </Section>

      <Section def={def('tasks')}>
        <h3>ToDo に期限を付ける</h3>
        <ul>
          <li>
            ToDo リストの文の中で <code>@2026/11/20</code>（または <code>@2026-11-20</code>）と打って空白を入れると、期限の日付になります。スラッシュメニューの「期限」からも入れられます。
          </li>
          <li>期限を押すと、カレンダーで日付を変えられます（「今日」「明日」「1 週間後」もすぐ選べます）。今日が期限のものは黄色、過ぎたものは赤で表示されます。</li>
        </ul>
        <h3>タスクの画面</h3>
        <p>
          サイドバーの「タスク」を開くと、今のワークスペースのページにある、まだチェックしていない ToDo がまとめて表示されます。「期限切れ」「今日」「7 日以内」「それ以降」「期限なし」に分かれ、押すとそのページの ToDo の位置へ移動します。「カレンダー」では、月ごとに期限の日に並べて見られます。
        </p>
        <p className="help-small">あなたが見られるページの ToDo だけが表示されます。完了にするときは、ページの ToDo をチェックしてください。</p>
      </Section>

      <Section def={def('comments')}>
        <p>本文の文を選ぶと「コメント」ボタンが出ます。押すと右の欄でコメントを書けます。コメントの付いた段落には黄色の印がつきます。</p>
        <ul>
          <li>ページ右上の吹き出しのボタンで、コメントの欄を開け閉めできます。数字はまだ解決していないコメントの数です。</li>
          <li>コメントの上の引用を押すと、本文のその場所へ移動します。</li>
          <li>「返信」でやりとりを続けられ、「解決」で片付けられます（解決済みは欄の下にまとまります）。</li>
        </ul>
        <p className="help-small">
          ページを見られる人は誰でもコメントできます（閲覧のみの人も）。解決はページを編集できる人とコメントを書いた人、削除は書いた人とフルアクセスの人ができます。コメントは本文とは別に保存されるので、書き出しや履歴には入りません。
        </p>
      </Section>

      <Section def={def('database')}>
        <p>ページ右上の「…」から「データベースにする」を選ぶと、そのページのサブページが「行」になり、列（ステータス・日付・タグなど）の値を持てるようになります。</p>
        <ul>
          <li>「表」「ボード」「カレンダー」で見られます。タブの「＋」で表示を増やせ、選んでいるタブをもう一度押すと名前の変更・削除ができます。</li>
          <li>表の見出しを押すと、列の名前・種類（テキスト・数値・セレクト・マルチセレクト・日付・チェックボックス・URL・ユーザー）・選択肢の色を変えられます。見出しの右の「＋」で列を追加できます。</li>
          <li>ボードではカードをドラッグして、ステータスなどを変えられます。カレンダーでは日付の上の「＋」でその日の行を作れ、ドラッグで日付を変えられます。</li>
          <li>「絞り込み」「並べ替え」は表示ごとに保存されます（閲覧のみの人の操作は、その画面の中だけで使われます）。</li>
          <li>行を開くと、ページの上に列の値が表示され、そこでも変えられます。</li>
        </ul>
        <p className="help-small">「データベースをやめる」でふつうのページに戻せます。列の値は残るので、もう一度データベースにすると元どおりになります。</p>
      </Section>

      <Section def={def('links')}>
        <ul>
          <li>サイドバーの「関係図」で、ページどうしのリンクを図で見られます。線の多いページほど点が大きくなります。点を押すとそのページを開き、ドラッグで動かす・ホイールやピンチで拡大縮小ができます。点線は親子のつながりです。</li>
          <li>
            本文で <kbd>[[</kbd> と打つと、ページの一覧が出ます。選ぶとそのページへのリンクが入ります。続けて文字を打つと絞り込めます。
          </li>
          <li>本文のリンクをクリックすると、そのページを開きます。</li>
          <li>
            ほかのページからリンクされているページでは、本文の下に「このページを参照しているページ」（バックリンク）が表示されます。関係するページをたどるのに便利です。
          </li>
        </ul>
      </Section>

      <Section def={def('toc-templates')}>
        <h3>目次</h3>
        <p>
          見出しを使うと、自動で目次ができます。パソコンではページの右端に細い線で並び、マウスを乗せると一覧が開きます。スマホでは右下のボタンから開きます。いま読んでいる位置の見出しが強調され、クリックするとその見出しへ移動します。
        </p>
        <h3>テンプレート</h3>
        <ul>
          <li>よく使う形のページは、右上の「…」メニューの「テンプレートにする」でテンプレートにできます。</li>
          <li>サイドバーの「テンプレート」で一覧を見られ、「このテンプレートで作る」で新しいページを作れます。最初から「Journal」（日記をまとめるページ。年のカレンダー付き）と「講義ノート」が入っています。</li>
          <li>新しい空のページを開くと「テンプレートから始める」に候補が並び、選ぶと内容・アイコン・タイトルが入ります。</li>
          <li>
            テンプレートの中の <code>{'{{date}}'}</code> は、使った日の日付（例：2026/11/06）に変わります。
          </li>
          <li>「講義ノート」のテンプレートを最初から用意しています。</li>
        </ul>
      </Section>

      <Section def={def('files')}>
        <h3>ファイルを入れる</h3>
        <p>
          スラッシュメニューの「画像」「動画」「音声」「ファイル」から入れるか、ファイルを本文にドラッグ＆ドロップします。ファイルの名前をクリックすると、アプリの中で開きます。
        </p>
        <h3>アプリの中で見られるファイル</h3>
        <dl className="help-formats">
          <div>
            <dt>PDF</dt>
            <dd>電子書籍のように読めます（下の「PDF を読む」）</dd>
          </div>
          <div>
            <dt>画像</dt>
            <dd>png, jpg, gif, webp, avif, svg, bmp, ico</dd>
          </div>
          <div>
            <dt>動画</dt>
            <dd>mp4, webm, mov, m4v, ogv</dd>
          </div>
          <div>
            <dt>音声</dt>
            <dd>mp3, m4a, aac, wav, ogg, oga, opus, flac, weba</dd>
          </div>
          <div>
            <dt>テキスト・コード</dt>
            <dd>txt, md, json, csv など多数</dd>
          </div>
          <div>
            <dt>表</dt>
            <dd>csv, tsv, xlsx, ods を表として表示</dd>
          </div>
          <div>
            <dt>Word 文書</dt>
            <dd>docx</dd>
          </div>
          <div>
            <dt>スライド</dt>
            <dd>pptx（文字と画像の位置を再現した簡易な表示）</dd>
          </div>
        </dl>

        <h3>ファイルを編集する</h3>
        <p>ページを編集できる人は、ページに貼ったファイルをアプリの中で編集できます。ファイルの名前をクリックするか、ブロックの左のつまみのメニューから「開く・編集」を選ぶと、開いたらそのまま編集できます。編集が止まって数秒たったときと、閉じるときに自動で保存されます。</p>
        <ul>
          <li>
            <strong>テキスト・コード</strong>… そのまま書き換えられます（<Keys k={[MOD, 'S']} /> ですぐに保存）。
          </li>
          <li>
            <strong>表（csv, tsv, xlsx, ods）</strong>… セルをダブルクリックするか Enter で編集し、Enter で確定します（Shift+Enter でセルの中で改行）。行や列を足せます。Excel から範囲をコピーして貼り付けることもできます。
            Excel のファイルは、書き換えたセルだけを保存するので、書式やほかのシートはそのまま残ります。数式のセルは編集できません（数式が消えるため）。
          </li>
          <li>
            <strong>画像（png, jpg, webp, bmp）</strong>… 回転・左右反転・切り抜きができます。切り抜きは、画像の上をドラッグして残す範囲を選びます。
          </li>
          <li>
            <strong>Word（docx）</strong>… ページと同じ操作（見出し・太字・箇条書き・表・画像など）で、そのまま編集できます。docx のまま保存され、用紙・余白・スタイル・ヘッダーとフッターは残ります（文字の大きさやフォントなどの細かい書式は簡略化されます）。
          </li>
          <li>
            <strong>PowerPoint（pptx）</strong>… スライドの文字をクリックすると書き換えられます。図形・画像・デザインはそのまま残ります。
          </li>
          <li>
            <strong>ページにする</strong>… Word・PowerPoint・表などを開いた画面で「ページにする」を押すと、中身から新しいページを作れます（元のファイルはそのまま残ります）。
          </li>
        </ul>
        <Note>保存すると、編集した内容が新しいファイルとしてページに入ります。編集前のファイルは、ページの履歴から戻せます。</Note>

        <h3>PDF を読む</h3>
        <ul>
          <li>画面に 1 ページずつ表示し、横長の画面では本のように見開きで表示します。下のボタンで「自動・単ページ・見開き」を切り替えられます。</li>
          <li>ページの左右をクリック、矢印キー、またはスワイプでめくれます。</li>
          <li>次に開いたときは、前回読んでいたページから始まります。</li>
          <li>全画面表示にもできます。文字を検索・選択したいときは「新しいタブで開く」でブラウザの PDF 表示を使えます。ダウンロードもできます。</li>
        </ul>
        <h3>しおりとメモ</h3>
        <ul>
          <li>しおりのボタンで、今のページにしおりを付けたり外したりできます。</li>
          <li>メモのボタンで横にパネルが開き、ページごとにメモを書けます。しおりやメモのあるページの一覧から、そのページへ移動できます。</li>
          <li>しおりとメモは自分だけが見られます。別の端末で開いても同じものが表示されます。</li>
        </ul>
      </Section>

      <Section def={def('transfer')}>
        <h3>取り込む（新しいページになります）</h3>
        <p>サイドバーの下の「インポート」からファイルを選びます。いくつか同時に選ぶこともできます。</p>
        <ul>
          <li>Markdown（.md）・HTML・テキスト</li>
          <li>Word（.docx）</li>
          <li>PowerPoint（.pptx）… スライドごとに見出しと文字・画像になります</li>
          <li>表（csv, tsv, xlsx, ods）… 表のブロックになります</li>
          <li>Jupyter ノートブック（.ipynb）</li>
          <li>Notion の書き出し（ZIP）</li>
        </ul>
        <p className="help-small">先頭の見出し 1 は、ページのタイトルとして使われます。</p>

        <h3>Notion から移る</h3>
        <ol className="help-steps">
          <li>Notion で、移したいページを「Markdown と CSV」の形式で書き出します（ZIP ファイルになります）。</li>
          <li>{name} のサイドバーの「インポート」で、その ZIP ファイルを選びます。</li>
          <li>取り込みが終わるまで、画面を閉じずに待ちます。</li>
        </ol>
        <p>
          ページの階層・画像や添付ファイル・ページ同士のリンクがそのまま移ります。データベースは表のページになり、各行のページはその下に入ります。
        </p>

        <h3>書き出す</h3>
        <p>ページ右上の「…」メニューから選びます。</p>
        <ul>
          <li>
            <strong>Markdown で書き出し</strong>・<strong>HTML で書き出し</strong>：ファイルとして保存します。
          </li>
          <li>
            <strong>PDF で書き出し（レポート形式）</strong>：レポートの体裁（A4・明朝体・両端揃え・段落の 1 字下げ、冒頭に表題、ページ番号）で印刷画面が開きます。保存先で「PDF に保存」を選んでください。長い表はページをまたいでも、次のページで見出しの行が繰り返されます。
          </li>
        </ul>
        <h3>まるごと書き出す</h3>
        <p>
          ワークスペースの設定の「まるごと書き出し」で、あなたが見られるページをすべて ZIP で保存できます。ページは Markdown になり、ページの並び（親子）のとおりにフォルダへ分かれます。貼ってあるファイルは「ファイル」フォルダに入り、本文からのリンクもそこを指します。
        </p>
      </Section>

      <Section def={def('sharing')}>
        <p>ページ右上の「共有」から設定します。共有の設定はサブページにも引き継がれます。</p>
        <h3>共有（ログインした人向け）</h3>
        <ul>
          <li>
            <strong>ワークスペースの全員</strong>に対して「アクセス不可・閲覧のみ・編集可」を選べます。
          </li>
          <li>
            アカウントやグループを選んで<strong>招待</strong>し、「閲覧のみ」か「編集可」を選べます。ワークスペースに入っていない人は「ゲスト」として、そのページ以下だけを見られます。
          </li>
          <li>「アクセスできる人」を「招待した人のみ」にすると、親ページの共有を引き継がず、このページで招待した人だけが見られます。</li>
          <li>「URL をカスタマイズ」で、ページの URL を分かりやすい名前に変えられます。</li>
          <li>共有の設定を変えられるのは、ページの作成者と管理者です。</li>
        </ul>
        <h3>Web で公開（ログインなしで見られる）</h3>
        <ul>
          <li>「Web で公開」をオンにすると、リンクを知っている人は誰でもログインせずに閲覧できます（編集はできません）。</li>
          <li>「サブページも公開」「検索エンジンに表示」も選べます。</li>
          <li>公開できる人は管理者の設定で決まります。公開中は「共有」ボタンに地球のマークが付きます。</li>
        </ul>
        <h3>ワークスペースでの役割</h3>
        <dl className="help-formats">
          <div>
            <dt>オーナー・管理者</dt>
            <dd>ワークスペースのすべてのページを見て編集でき、メンバーと設定を管理できます</dd>
          </div>
          <div>
            <dt>メンバー</dt>
            <dd>ページを作り、共有されたページを閲覧・編集できます</dd>
          </div>
          <div>
            <dt>閲覧者</dt>
            <dd>共有されたページを見ることだけができます</dd>
          </div>
          <div>
            <dt>ゲスト</dt>
            <dd>招待されたページとその下のページだけを見られます</dd>
          </div>
        </dl>
        <p className="help-small">閲覧のみのページには、右上に「閲覧のみ」と表示されます。</p>
      </Section>

      <Section def={def('collab')}>
        <ul>
          <li>同じページを何人かで同時に編集できます。入力はその場でほかの人の画面にも反映され、自動でまとまります。</li>
          <li>ほかの人のカーソルと名前が表示されるので、どこを書いているか分かります。</li>
          <li>ページを開いている人のアイコンが、右上に並びます。</li>
        </ul>
        <Note>
          通信の具合などで同じページの変更がぶつかったときは、上に帯が出ます。「最新版を読み込む」か「自分の変更で上書き」を選んでください。
        </Note>
      </Section>

      <Section def={def('history')}>
        <h3>ページ履歴</h3>
        <ul>
          <li>編集すると、編集前の状態が自動で履歴に残ります。右上の時計のボタンで開きます。</li>
          <li>版を選ぶと、1 つ前の版から何が変わったかが色分けで表示されます。</li>
          <li>「この版に復元」で、その時点の内容に戻せます。復元する前の内容も履歴に残るので、あとから元に戻せます。</li>
        </ul>
        <h3>ゴミ箱</h3>
        <ul>
          <li>ページは「…」メニューの「ゴミ箱に移動」で削除します。サブページも一緒に移ります。</li>
          <li>ゴミ箱では、チェックを付けたページをまとめて復元・完全に削除できます。何も選んでいないときは「ゴミ箱を空にする」ですべて完全に削除できます。</li>
          <li>サイドバーの下の「ゴミ箱」から、元に戻す（復元）か、完全に削除できます。完全に削除したページは元に戻せません。</li>
        </ul>
      </Section>

      <Section def={def('workspaces')}>
        <ul>
          <li>ページは「ワークスペース」ごとに分かれています。サイドバーのいちばん上の名前を押すと、ほかのワークスペースに切り替えられます。</li>
          <li>同じメニューの「ワークスペースの設定」で、名前・アイコン・URL 名、メンバーと役割を管理できます（変更できる項目は役割によって異なります）。</li>
          <li>新しいワークスペースは、管理者が作成します。</li>
        </ul>
        <h3>プライベートのページ</h3>
        <p>
          ワークスペースの設定で「『プライベート』のページを使う」をオンにすると、サイドバーに「プライベート」の区分が出ます。ここに作ったページは自分だけが見られます。
        </p>
        <h3>サイドバーの区分</h3>
        <ul>
          <li>
            <strong>お気に入り</strong>：星を付けたページ
          </li>
          <li>
            <strong>ワークスペース</strong>：ワークスペースのページ
          </li>
          <li>
            <strong>共有されたページ</strong>：ほかの人から招待されたページ
          </li>
          <li>
            <strong>プライベート</strong>：自分だけのページ（オンにしたときだけ）
          </li>
        </ul>
      </Section>

      <Section def={def('github')}>
        <p>ワークスペースを GitHub のリポジトリとつなぐと、リポジトリのフォルダやファイルをページとして読み書きできます。</p>
        <ul>
          <li>フォルダと Markdown のファイルがページとして並びます。PDF・画像・テキストなどほかのファイルもページになり、種類が分かるアイコンが付きます。</li>
          <li>Markdown のページを編集すると、自動で GitHub に保存（コミット）されます。入力が止まってしばらくしたときと、ページを離れたときに送られます。</li>
          <li>
            テキストやコードのファイルは、その場で編集できます。入力が止まってしばらくしたとき・ページを離れたとき・<Keys k={[MOD, 'S']} /> で GitHub に保存されます。
          </li>
          <li>CSV・Excel（xlsx）のファイルは表として、画像（png, jpg, webp）は回転・切り抜きで編集でき、自動で GitHub に保存されます。</li>
          <li>フォルダの中では「ページを追加」「フォルダを作成」が使えます。新しいページは、タイトルを付けた時点でファイルとして追加されます。</li>
          <li>移動・名前の変更（タイトルの変更）・複製・削除も GitHub に反映されます。削除した Markdown は、ゴミ箱から戻すと GitHub に作り直されます。</li>
          <li>GitHub 側の変更は、10 分ごとに自動で取り込まれます。</li>
        </ul>
        <Note>
          連携の設定（ワークスペースの設定 →「GitHub 連携」）と、同期の状態を示す帯・「今すぐ同期」は、ワークスペースのオーナーと管理者にだけ表示されます。ほかの場所でも同時に変更されていたときは GitHub 側の内容が使われ、自分の変更はページ履歴に残ります。
        </Note>
      </Section>

      <Section def={def('app')}>
        <p>ホーム画面に追加すると、アプリのように開けます。アカウント設定の「アプリとして使う」に、端末に合わせた手順が出ます。</p>
        <h3>iPhone・iPad</h3>
        <ol className="help-steps">
          <li>Safari で開き、共有ボタンを押します。</li>
          <li>「ホーム画面に追加」を選び、「追加」を押します。</li>
        </ol>
        <h3>パソコン・Android</h3>
        <p>Chrome や Edge では、アカウント設定の「インストール」ボタン、またはブラウザのメニューの「アプリをインストール」「ホーム画面に追加」から追加できます。</p>
        <h3>電波がないとき</h3>
        <p>
          前に開いたことのあるページは、オフラインでも読めます。オフラインのときは上に帯が表示され、その間の変更は保存されません。端末に残した内容は、ログアウトすると消えます。
        </p>
      </Section>

      <Section def={def('shortcuts')}>
        <h3>全体</h3>
        <ShortcutTable
          rows={[
            [<Keys k={[MOD, 'K']} />, '検索'],
            [<Keys k={[MOD, '\\']} />, 'サイドバーを開く・閉じる'],
          ]}
        />
        <h3>本文</h3>
        <ShortcutTable
          rows={[
            [<kbd>/</kbd>, 'スラッシュメニュー'],
            [<kbd>[[</kbd>, 'ページへのリンク'],
            [<Keys k={[MOD, 'B']} />, '太字'],
            [<Keys k={[MOD, 'I']} />, '斜体'],
            [<Keys k={[MOD, 'U']} />, '下線'],
            [<Keys k={[MOD, 'Shift', 'S']} />, '取り消し線'],
            [<Keys k={[MOD, 'E']} />, 'コード（文中）'],
            [<Keys k={[MOD, ALT, '1〜3']} />, '見出し 1〜3'],
            [<Keys k={[MOD, ALT, '0']} />, '標準テキストに戻す'],
            [<Keys k={[MOD, 'Shift', '7']} />, '番号付きリスト'],
            [<Keys k={[MOD, 'Shift', '8']} />, '箇条書き'],
            [<Keys k={[MOD, 'Shift', '9']} />, 'チェックリスト'],
            [<Keys k={[MOD, 'Shift', '6']} />, '折りたたみリスト'],
            [<><kbd>Tab</kbd> ／ <Keys k={['Shift', 'Tab']} /></>, '字下げ・字下げを戻す'],
            [<Keys k={[MOD, 'Shift', '↑ / ↓']} />, 'ブロックを上・下へ移動'],
            [<Keys k={[MOD, 'Z']} />, '元に戻す'],
            [<Keys k={[MOD, 'Shift', 'Z']} />, 'やり直す'],
          ]}
        />
        <h3>PDF を読むとき</h3>
        <ShortcutTable
          rows={[
            [<><kbd>→</kbd> ／ <kbd>PageDown</kbd> ／ <kbd>Space</kbd></>, '次のページ'],
            [<><kbd>←</kbd> ／ <kbd>PageUp</kbd> ／ <Keys k={['Shift', 'Space']} /></>, '前のページ'],
            [<><kbd>Home</kbd> ／ <kbd>End</kbd></>, '最初・最後のページ'],
            [<kbd>Esc</kbd>, 'ファイルの表示を閉じる'],
          ]}
        />
      </Section>

      <Section def={def('trouble')}>
        <dl className="help-faq">
          <dt>ログインできない</dt>
          <dd>
            パスキーを登録した端末（または同期しているパスワードマネージャー）で試してください。どの端末でも入れないときは、管理者にパスキーの再発行を頼んでください。「このブラウザはパスキーに対応していません」と出るときは、最新の Chrome・Safari・Edge で開いてください。
          </dd>
          <dt>間違えて消した・書き換えた</dt>
          <dd>消したページは「ゴミ箱」から、書き換えた内容は「ページ履歴」から戻せます。</dd>
          <dt>ページが開けない・編集できない</dt>
          <dd>
            アクセス権がないか、ゴミ箱に移されたか、URL が変わった可能性があります。ページの作成者か管理者に確認してください。「ロック中」と出ているときは、押すとロックを外せます。
          </dd>
          <dt>「保存できていません」と出る</dt>
          <dd>通信を確認してください。オフラインの間の変更は保存されません。</dd>
          <dt>「新しいバージョンが公開されました」と出た</dt>
          <dd>「再読み込み」を押すと、新しいバージョンになります。</dd>
          <dt>PDF に保存する方法が分からない</dt>
          <dd>
            「PDF で書き出し」で開く印刷画面で、送信先（プリンター）に「PDF に保存」を選びます。iPhone・iPad では、印刷画面の共有ボタンから保存できます。
          </dd>
        </dl>
      </Section>

      {isAdmin && (
        <Section def={ADMIN_SECTION}>
          <p className="help-small">この項目は管理者にだけ表示されています。サイドバーの「管理者画面」から操作します。</p>
          <h3>人を招く</h3>
          <ol className="help-steps">
            <li>「ユーザー」で「ユーザーを追加」を押し、名前・権限・参加させるワークスペースを入力します。</li>
            <li>「作成して登録リンクを発行」を押すと登録リンクが表示されるので、本人に渡します（リンクはこのときにしか表示されません）。</li>
            <li>本人がリンクを開いてパスキーを作ると、登録が完了します。</li>
          </ol>
          <h3>パスキーをなくした人がいたら</h3>
          <p>
            ユーザーの詳細画面で「復旧用リンクを発行」を押し、本人に渡します。まだ登録していない人には「招待リンクを再発行」が使えます。使われていないリンクは「登録リンク」で無効にできます。
          </p>
          <h3>そのほか</h3>
          <ul>
            <li>
              <strong>ワークスペース</strong>：新しいワークスペースの作成
            </li>
            <li>
              <strong>グループ</strong>：ユーザーをまとめて、ページの共有先に使えます
            </li>
            <li>
              <strong>外部公開</strong>：Web に公開中のページの一覧。「設定」で、公開を許可する人（全員・管理者のみ・無効）を決められます
            </li>
            <li>
              <strong>監査ログ</strong>：ログインや設定の変更などの記録
            </li>
            <li>
              <strong>ダッシュボード</strong>：利用状況と、データのバックアップ（6 時間ごとに自動。今すぐ作成・ダウンロードもできます）
            </li>
            <li>
              <strong>リリース履歴</strong>：これまでの変更の一覧
            </li>
          </ul>
          <p className="help-small">管理者のサイドバーでは、「共有されたページ」の区分が「他のメンバーのページ」になります。</p>
        </Section>
      )}

      <p className="help-back">
        <a
          href="#help-top"
          onClick={(e) => {
            e.preventDefault();
            scrollToSection('help-top');
          }}
        >
          目次に戻る
        </a>
      </p>
    </div>
  );
}
