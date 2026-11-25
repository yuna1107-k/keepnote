# keepnote — パスキーでログインする、セルフホスト型のノート・ドキュメントワークスペース

ブロックエディタ型のノート・ドキュメントのワークスペースを、自分のサーバー（Cloudflare Workers または Node.js / Docker）で動かすためのアプリです。

> **English summary:** keepnote is a self-hosted, block-based notes and documents workspace with passkey-only sign-in. It runs on Cloudflare Workers (D1 + R2 + Durable Objects) or on Node.js / Docker with SQLite. The UI is in Japanese. Licensed under MIT.

- **ログインはパスキーのみ**（パスワード・メール認証はありません）。認証はこのアプリの中だけで完結し、外部の認証サービスは使いません
- **ユーザーは管理者だけが発行**（自己登録なし）。管理者がユーザーを作成すると、本人用の「パスキー登録リンク」が発行されます
- **管理者画面**：ダッシュボード／ユーザー管理／登録リンク管理／監査ログ／ワークスペース設定

## 主な機能

| 区分 | 内容 |
| --- | --- |
| エディタ | ブロックエディタ（`/` コマンド、見出し・リスト・チェックリスト・表・コード・数式・画像・HTML の埋め込みなど、ドラッグで並び替え）、自動保存 |
| ページ | 階層ページ、サイドバーのドラッグ＆ドロップ、アイコン・カバー写真、お気に入り、ゴミ箱、版の履歴、全文検索（⌘K / Ctrl+K） |
| 共同編集 | 同じページをリアルタイムに同時編集（Cloudflare Workers 版のみ。Durable Objects を使用。Node.js 版は版番号で競合を検知） |
| 共有 | ワークスペース単位・ページ単位の権限、招待したアカウントだけに見せるページ、Web への公開 |
| ファイル | PDF リーダー、画像・Office ファイル（Word・Excel・PowerPoint）の表示と編集、コードエディタ |
| そのほか | データベース（表・ボード・カレンダー・パネル）、スライド表示、GitHub リポジトリとの同期、日記・読書記録・勉強時間の記録 |
| アカウント | パスキーの追加・名前変更・削除、ログイン中の端末の確認とログアウト、スマホのパスキーで PC にログイン（QR コード） |
| 管理者 | ユーザー作成・権限変更・無効化・削除、招待／復旧リンクの発行と無効化、パスキー失効、セッション強制終了、監査ログ、各種設定 |

## 認証の流れ

```
管理者がユーザーを作成 ──▶ 登録リンク（1回限り・期限付き）を発行
                              │  （URLは発行時に一度だけ表示。サーバーにはハッシュのみ保存）
                              ▼
本人がリンクを開く ──▶ 端末でパスキーを作成 ──▶ アカウント有効化・ログイン
```

- 端末を紛失した場合：管理者がユーザー詳細画面から「復旧用リンク」を発行 → 本人が新しい端末でパスキーを登録
- 管理者自身がログインできなくなった場合：サーバー上で CLI から復旧リンクを発行できます（後述）

## セットアップ

### Cloudflare Workers（推奨）

D1（データベース）・R2（添付ファイル）・Durable Objects（共同編集）・Workers Static Assets（画面）で動きます。

```bash
npm install
npx wrangler login

# 1. リソースを作成し、表示された database_id を wrangler.jsonc に記入
npx wrangler d1 create keepnote
npx wrangler r2 bucket create keepnote-files

# 2. wrangler.jsonc の routes と vars.ORIGIN を、自分のドメイン（例: https://notes.example.com）に変更

# 3. データの暗号化の鍵を登録（32 バイトをランダムに作って base64 にしたもの。失くすとバックアップを復元できません）
openssl rand -base64 32 | npx wrangler secret put DATA_KEY

# 4. ビルド + デプロイ（マイグレーションは Worker が起動時に自動適用）
npm run deploy

# 5. 最初の管理者を作成し、表示された登録リンクをブラウザで開いてパスキーを作成
npm run cli:remote -- create-admin admin 管理者
```

- 管理者がパスキーを失くした場合：`npm run cli:remote -- link admin`
- ドメインを変える場合は `ORIGIN` も変更してください（パスキーはドメインに紐づくため、変更前のパスキーは使えなくなります。各ユーザーに復旧リンクを発行してください）
- 期限切れセッション等の掃除と自動バックアップは Cron Trigger で行われます

### Docker

```bash
cp .env.example .env
# .env の ORIGIN を、実際にブラウザでアクセスするURLに変更（例: https://notes.example.com）
docker compose up -d --build
docker compose logs app   # 初回起動時に管理者用のパスキー登録リンクが表示されます
```

表示されたリンク（24時間有効）をブラウザで開き、パスキーを作成すると管理者としてログインできます。
リンクを見逃した場合はコンテナを再起動すると再発行されます（有効な管理者が一人もいない間のみ）。

### HTTPS について

パスキーは `localhost` 以外では **HTTPS が必須** です。リバースプロキシで TLS を終端してください。Caddy の例：

```
notes.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

`.env` の `ORIGIN` は `https://notes.example.com` のように、ブラウザに表示されるURLと完全に一致させてください。
**ドメインを変更するとそれまでに登録したパスキーは使えなくなります**（パスキーはドメインに紐づくため）。その場合は CLI で各ユーザーの復旧リンクを発行してください。

### Docker を使わない場合

Node.js 24 以上が必要です（TypeScript を Node.js の型ストリップ機能で直接実行し、DB は組み込みの `node:sqlite` を使うため、ネイティブモジュールのビルドは不要です）。

```bash
npm ci
npm run build
ORIGIN=https://notes.example.com DATA_DIR=./data npm run start:node
```

## 開発

### Workers の環境で開発する

本番と同じ Cloudflare Workers ランタイム（`wrangler dev`、ローカルの D1 / R2）で開発します。

```bash
npm install
cp .dev.vars.example .dev.vars          # ORIGIN=http://localhost:5173
npm run dev                             # 画面: http://localhost:5173（API は wrangler dev:8790 にプロキシ）
npm run cli:local -- create-admin admin 管理者   # 表示されたリンク（:8790）の host を :5173 に変えて開く
npm run typecheck
```

- データベースのマイグレーションは Worker の初回アクセス時に自動で適用されます（`src/server/d1-migrate.ts`）。新しい SQL を `migrations/` に追加したら、同ファイルの一覧にも追記してください。
- Node.js 版で動かす場合は `npm run dev:node`（API: 3000）。

### 開発用ログインで画面を確かめる

パスキーなしでログインできる開発用の環境です（データは `./data-dev` の SQLite）。

```bash
npm run dev:local     # 画面 http://localhost:5174 ・ API :3002（DEV_LOGIN=1）
npm run seed:dev      # 「開発用」ワークスペースにサンプルのページなどを入れる
```

ログイン画面の「開発用ログイン（dev）」で入れます。開発用ログインは `DEV_LOGIN=1` で、しかも ORIGIN が `http://localhost` のときだけ有効になります（本番では環境変数があっても使えません）。

Durable Object（共同編集・ページの変更のお知らせ）まで確かめるときは、Workers の環境で動かします：

```bash
npm run build
npx wrangler dev --port 8791 --local-upstream localhost:8791 --var ORIGIN:http://localhost:8791 --var DEV_LOGIN:1 --persist-to .wrangler/dev-login
SEED_URL=http://localhost:8791 npm run seed:dev
```

### テスト

```bash
npm test              # vitest（tests/ の下）
```

## 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `ORIGIN` | `http://localhost:3000`（開発時 5173） | ブラウザからアクセスする公開URL。パスキー検証と CSRF 対策に使用 |
| `RP_ID` | `ORIGIN` のホスト名 | パスキーの RP ID |
| `DATA_KEY` | なし | データ・バックアップを暗号化する鍵（32 バイトを base64 で表したもの）。Workers ではシークレットで登録 |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 待ち受けポート・アドレス（Node.js 版） |
| `DATA_DIR` | `./data` | SQLite DB とアップロードファイルの保存先（Node.js 版） |
| `TRUST_PROXY` | `false` | `true` で `X-Forwarded-For` をクライアントIPとして記録 |
| `ADMIN_USERNAME` | `admin` | 初回起動時に作成される管理者のユーザー名（Node.js 版） |
| `MAX_UPLOAD_MB` | `20` | アップロードの最大サイズ |

## 管理用 CLI

サーバー上で実行します（稼働中でも可）。Docker の場合は `docker compose exec app` を前に付けてください。Cloudflare Workers の場合は `npm run cli:remote --` を使います。

```bash
npm run cli -- list                          # ユーザー一覧
npm run cli -- link <username>               # パスキー登録（復旧）リンクを発行
npm run cli -- create-admin <username> [表示名] # 管理者を新規作成してリンクを発行
npm run cli -- promote <username>            # 管理者に昇格（無効化されていれば有効化）
```

## バックアップと復元

### Cloudflare Workers 版

1. **自動バックアップ（R2）**: 6 時間ごとに全テーブルを書き出し、gzip で圧縮して `DATA_KEY` で暗号化したものを R2 バケットの `backups/db/` に保存します（30 日分を保管）。管理者画面のダッシュボードから一覧の確認・今すぐ作成・ダウンロードができます。
2. **D1 Time Travel**: Cloudflare D1 の機能で、過去の任意の時点に戻せます（`npx wrangler d1 time-travel info keepnote` / `restore`）。

> バックアップは `DATA_KEY` で暗号化されています。**鍵を失うとバックアップも復元できません。**

R2 のバックアップから復元する：

```sh
# 1. 管理者画面からバックアップ（db-YYYYMMDD-HHMMSS.sql.gz.enc）をダウンロード
# 2. SQL に戻す（鍵は DATA_KEY の値だけが書かれたファイル）
npm run backup:decrypt -- db-XXXXXXXX-XXXXXX.sql.gz.enc restore.sql ./DATA_KEY.txt
# 3. 流し込む（各テーブルの中身を置き換えます。先に現在の状態を書き出しておくと安全です）
npx wrangler d1 export keepnote --remote --output before-restore.sql
npx wrangler d1 execute keepnote --remote --file restore.sql
```

### Node.js / Docker 版

`DATA_DIR`（既定では `./data`）をまるごとバックアップしてください。

- `app.db`（+ `app.db-wal`）… ユーザー・パスキー公開鍵・ページ・監査ログ
- `uploads/` … アップロードされた画像・ファイル

稼働中に安全にコピーするには `sqlite3 data/app.db ".backup backup.db"` を使います。

## セキュリティ設計

- パスキー（WebAuthn）はユーザー検証（生体認証/PIN）必須・Discoverable Credential 必須。チャレンジはサーバー保存で5分有効・1回限り
- ログインに失敗したときは理由を利用者に返さず（パスキーの ID だけでアカウントの状態を探られないように）、監査ログにだけ記録
- 登録リンクのトークンは SHA-256 ハッシュのみ保存。URLフラグメント（`#token=`）で渡すためサーバーログや Referer に残りません。再発行すると古いリンクは自動で無効化
- セッションはランダムトークンの HttpOnly / SameSite=Lax Cookie（HTTPS 時は `__Host-` 接頭辞 + Secure）。DB にはハッシュのみ保存
- 状態を変更する API はすべて `Origin` ヘッダーを検証（CSRF 対策）
- 認証 API にレート制限、CSP・X-Frame-Options などのセキュリティヘッダー
- アップロードファイルは認証必須で配信し、HTML/SVG などはサンドボックス化 or ダウンロード扱い
- 最後の管理者の降格・無効化・削除や、自分自身の権限変更はできません
- ログイン成功/失敗、ユーザー・リンク・パスキー・セッションの操作はすべて監査ログに記録

## 制限事項

- リアルタイム共同編集は Cloudflare Workers 版だけで使えます（Node.js 版では、同じページを同時に編集すると競合として検知されます）
- Node.js 版は単一プロセスでの運用を前提としています（レート制限がメモリ内のため。Workers 版は Rate Limiting バインディングを使用）
- 画面は日本語のみです

## 技術構成

- サーバー: [Hono](https://hono.dev) / [SimpleWebAuthn](https://simplewebauthn.dev)
  - Cloudflare Workers 版: D1 / R2 / Durable Objects / Rate Limiting / Cron Triggers（`src/server/worker.ts`）
  - Node.js 版: Node.js 24+ / `node:sqlite` / ローカルディスク（`src/server/node.ts`）
  - 両者は同じ API コード（`src/server/app.ts`）と同じスキーマ（`migrations/`）を共有
- フロントエンド: React / Vite / [BlockNote](https://www.blocknotejs.org)

## ライセンス

[MIT License](./LICENSE)。同梱しているフォント・アイコン・写真のライセンスは [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) を見てください。
