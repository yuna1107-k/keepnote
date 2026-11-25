/**
 * ファイルの取り込み（Markdown・HTML・テキスト・Office・Notion の書き出し ZIP）。
 * サイドバーの「インポート」と、インポートの画面（アプリから開く）で使う。
 */
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Modal, useUi } from '../ui';
import type { NotionProgress, NotionResult } from './notionImport';
import { importFile } from './transfer';
import { useWorkspace } from './WorkspaceContext';

export function useImporter() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { toast } = useUi();
  const importInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  // Notion の書き出し（ZIP）の取り込み状況
  const [notion, setNotion] = useState<{ progress: NotionProgress; result?: NotionResult; error?: string } | null>(null);
  const onNotionImport = async (file: File) => {
    setNotion({ progress: { phase: '準備しています', done: 0, total: 0 } });
    try {
      const { importNotionZip } = await import('./notionImport');
      const result = await importNotionZip(file, ws.current!.id, (progress) => setNotion((s) => ({ ...s, progress })));
      setNotion((s) => (s ? { ...s, result } : s));
      await ws.reload();
      navigate(`/p/${result.rootId}`);
    } catch (e) {
      setNotion((s) => ({ progress: s?.progress ?? { phase: '', done: 0, total: 0 }, error: (e as Error).message }));
      await ws.reload();
    }
  };

  const onImport = async (files: FileList | null) => {
    if (!files?.length) return;
    const zip = Array.from(files).find((f) => /\.zip$/i.test(f.name));
    if (zip) {
      if (importInput.current) importInput.current.value = '';
      return onNotionImport(zip);
    }
    setImporting(true);
    let lastId = '';
    try {
      for (const f of Array.from(files)) lastId = await importFile(f, null, 'workspace', ws.current?.id);
      await ws.reload();
      toast(`${files.length} 件のファイルを取り込みました`, 'success');
      navigate(`/p/${lastId}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setImporting(false);
      if (importInput.current) importInput.current.value = '';
    }
  };

  const input = (
    <input
      ref={importInput}
      type="file"
      accept=".md,.markdown,.html,.htm,.txt,.docx,.pptx,.csv,.tsv,.xlsx,.xlsm,.ods,.ipynb,.zip,text/markdown,text/html,text/plain,text/csv,application/zip"
      multiple
      hidden
      onChange={(e) => onImport(e.target.files)}
    />
  );
  const modal = (
    <>
        {notion && (
          <Modal
            open
            title="Notion から取り込み"
            onClose={() => (notion.result || notion.error) && setNotion(null)}
            width={460}
          >
            <div className="notion-import">
              {notion.error ? (
                <p className="notion-import-error">{notion.error}</p>
              ) : notion.result ? (
                <>
                  <p>
                    取り込みが完了しました：ページ {notion.result.pages} 件・データベース {notion.result.databases} 件・画像やファイル {notion.result.files} 件
                  </p>
                  {notion.result.failed.length > 0 && (
                    <details>
                      <summary>取り込めなかったもの（{notion.result.failed.length} 件）</summary>
                      <ul className="notion-import-failed">
                        {notion.result.failed.slice(0, 100).map((f, i) => (
                          <li key={i}>{f}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              ) : (
                <>
                  <p>
                    {notion.progress.phase}
                    {notion.progress.total > 0 && `（${notion.progress.done} / ${notion.progress.total}）`}
                  </p>
                  <div className="notion-import-bar">
                    <div style={{ width: `${notion.progress.total ? Math.round((notion.progress.done / notion.progress.total) * 100) : 5}%` }} />
                  </div>
                  <p className="muted small">この画面を閉じたり、ページを移動したりしないでください。</p>
                </>
              )}
              {(notion.result || notion.error) && (
                <div className="modal-actions">
                  <Button variant="primary" onClick={() => setNotion(null)}>
                    閉じる
                  </Button>
                </div>
              )}
            </div>
          </Modal>
        )}
    </>
  );
  return {
    choose: () => importInput.current?.click(),
    importing,
    busy: importing || (!!notion && !notion.result && !notion.error),
    input,
    modal,
  };
}
