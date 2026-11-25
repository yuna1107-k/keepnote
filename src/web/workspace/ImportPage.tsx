/** インポートの画面（アプリのメニューから開く。サイトではサイドバーの「インポート」と同じ） */
import { Button, Icon } from '../ui';
import { useImporter } from './Importer';

export default function ImportPage() {
  const importer = useImporter();
  return (
    <div className="tasks-page">
      <div className="tasks-head">
        <h1>
          <Icon name="upload" size={26} /> インポート
        </h1>
      </div>
      <p className="tasks-lead">ファイルを選ぶと、新しいページとして取り込みます。いくつか同時に選ぶこともできます。</p>
      <Button variant="primary" onClick={importer.choose} disabled={importer.busy}>
        <Icon name="upload" size={15} /> {importer.importing ? '読み込み中…' : 'ファイルを選ぶ'}
      </Button>
      <ul className="import-formats">
        <li>Markdown・HTML・テキスト・Jupyter ノートブック</li>
        <li>Word（.docx）・PowerPoint（.pptx）・Excel / CSV（表になります）</li>
        <li>Notion の書き出し（ZIP）：ページ・データベース・画像をまとめて取り込みます</li>
      </ul>
      {importer.input}
      {importer.modal}
    </div>
  );
}
