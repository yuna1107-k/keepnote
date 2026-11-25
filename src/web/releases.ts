/**
 * リリース履歴（管理者画面に表示）。新しいものを先頭に追加し、package.json の version も合わせて上げる。date は「YYYY-MM-DD HH:MM」（日本時間）。以前のものは日付のみ。
 * Android アプリの変更は app: true を付けて、そのアプリを作ったときのバージョンの項目に入れる（アプリの版の名前はこの version と同じ）。
 */
export type Release = { version: string; date: string; title: string; changes: { type: 'new' | 'improve' | 'fix' | 'security'; text: string; app?: boolean }[] };

export const RELEASES: Release[] = [
  {
    version: '1.0.0',
    date: '2026-11-26',
    title: '最初の公開版',
    changes: [
      { type: 'new', text: 'keepnote を公開しました。パスキーでログインする、セルフホスト型のノート・ドキュメントワークスペースです' },
    ],
  },
];
