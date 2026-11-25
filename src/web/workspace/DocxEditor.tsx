/**
 * Word（.docx）を、ページと同じ編集画面でそのまま編集する。
 * 編集が止まってしばらくしたら docx に書き戻して保存する（元の文書のスタイル・用紙・余白・ヘッダーとフッターは残す）。
 */
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { ja } from '@blocknote/core/locales';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { uploadFile } from '../api';
import { useEffectiveTheme } from '../theme';
import { Button, Spinner } from '../ui';
import { blocksToDocx } from './docxWriter';
import { docxToHtml } from './office';
import { flushWhenIdle, selfSaved, type Flush } from './selfSaved';
import { liftImages } from './transfer';

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const AUTOSAVE_MS = 4000;

export default function DocxEditor({
  url,
  onSave,
  flushRef,
}: {
  url: string;
  onSave: (blob: Blob) => Promise<void>;
  flushRef?: MutableRefObject<Flush | null>;
}) {
  const theme = useEffectiveTheme();
  const editor = useCreateBlockNote({ dictionary: ja, uploadFile: (file) => uploadFile(file) });
  const base = useRef<ArrayBuffer | null>(null);
  // この画面で読み込み済みか（保存で URL が変わっても読み直さないのは、読み込み済みのときだけ）
  const hasContent = useRef(false);
  const ready = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'saved' | 'pending' | 'saving' | 'error'>('saved');
  const changes = useRef(0);
  const savedAt = useRef(0);
  const busy = useRef(false);

  useEffect(() => {
    if (hasContent.current && selfSaved.has(url)) return;
    let alive = true;
    ready.current = false;
    (async () => {
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`ファイルを開けませんでした（${res.status}）`);
        const buf = await res.arrayBuffer();
        const html = await docxToHtml(buf);
        const blocks = await editor.tryParseHTMLToBlocks(liftImages(html));
        if (!alive) return;
        base.current = buf;
        editor.replaceBlocks(editor.document, blocks.length ? blocks : [{ type: 'paragraph' }]);
        changes.current = savedAt.current = 0;
        setStatus('saved');
        setLoaded(true);
        hasContent.current = true;
        // 読み込みで起きた変更は数えない
        requestAnimationFrame(() => (ready.current = true));
      } catch (e) {
        if (alive) setError((e as Error).message || 'ファイルを読み取れませんでした');
      }
    })();
    return () => {
      alive = false;
    };
  }, [url, editor]);

  const save = async (): Promise<boolean> => {
    if (!base.current || changes.current === savedAt.current) return true;
    if (busy.current) return false;
    busy.current = true;
    setStatus('saving');
    const at = changes.current;
    try {
      const bytes = await blocksToDocx(base.current, editor.document as any[]);
      await onSave(new Blob([bytes as BlobPart], { type: DOCX_TYPE }));
      base.current = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      savedAt.current = at;
      const done = changes.current === at;
      setStatus(done ? 'saved' : 'pending');
      return done;
    } catch {
      setStatus('error');
      return false;
    } finally {
      busy.current = false;
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  if (flushRef) flushRef.current = () => flushWhenIdle(() => busy.current, () => saveRef.current());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (changes.current !== savedAt.current) void saveRef.current();
    },
    [],
  );

  const label = { saved: '保存済み', pending: '未保存の変更があります', saving: '保存中…', error: '保存できませんでした' }[status];
  if (error) return <p className="muted office-error">{error}</p>;
  return (
    <div className="docx-editor">
      <div className="sheet-toolbar">
        <span className={`sheet-status ${status !== 'saved' ? 'is-dirty' : ''}`} role="status">
          {label}・Word の文書をそのまま編集できます（文字の大きさやフォントなどの細かい書式は、保存すると簡略化されます）
        </span>
        <Button size="sm" variant="primary" onClick={() => void save()} disabled={status === 'saved' || status === 'saving'}>
          今すぐ保存
        </Button>
      </div>
      {!loaded && <Spinner />}
      <div className="docx-editor-body" style={{ display: loaded ? undefined : 'none' }}>
        <BlockNoteView
          editor={editor}
          theme={theme}
          onChange={() => {
            if (!ready.current) return;
            changes.current++;
            setStatus('pending');
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => void saveRef.current(), AUTOSAVE_MS);
          }}
        />
      </div>
    </div>
  );
}
