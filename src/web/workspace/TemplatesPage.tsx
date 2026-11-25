/**
 * テンプレートの一覧。最初から入っているものと、このワークスペースで「テンプレートにする」したページを並べ、
 * そこから新しいページを作れる。
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Page } from '../api';
import { Icon, PageIcon, Spinner, useUi } from '../ui';
import { blocksToText } from './text';
import { applyTemplateDatabase, BUILTIN_TEMPLATES, fillTemplateText, prepareTemplateBlocks, type TemplateDatabase, type TemplateLook, type TemplateSource } from './templates';
import { pageTitle, useWorkspace } from './WorkspaceContext';

export default function TemplatesPage() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { toast } = useUi();
  const [mine, setMine] = useState<TemplateSource[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const wsId = ws.current?.id;

  const load = () => {
    if (!wsId) return;
    api<{ templates: TemplateSource[] }>(`/pages/templates?workspace=${encodeURIComponent(wsId)}`)
      .then((r) => setMine(r.templates))
      .catch(() => setMine([]));
  };
  useEffect(load, [wsId]);

  /** テンプレートから新しいページを作って開く */
  const use = async (t: TemplateSource) => {
    if (!wsId || busy) return;
    setBusy(t.id);
    try {
      let content: any[];
      let look: TemplateLook = {};
      let database: TemplateDatabase | undefined;
      let icon = t.icon;
      if (t.builtin) {
        const b = BUILTIN_TEMPLATES.find((x) => x.id === t.id)!;
        content = b.content;
        look = b.look ?? {};
        database = b.database;
      } else {
        const src = (await api<{ page: Page }>(`/pages/${t.id}`)).page;
        content = src.content;
        icon = src.icon;
        look = { font: src.font, cover: src.cover ?? undefined, coverPosition: src.coverPosition, fullWidth: src.fullWidth, slideTheme: src.slideTheme };
      }
      const blocks = prepareTemplateBlocks(content);
      const { page } = await api<{ page: Page }>('/pages', { body: { parentId: null, workspaceId: wsId, title: fillTemplateText(t.title), icon, ...(look.font ? { font: look.font } : {}) } });
      await api(`/pages/${page.id}`, {
        method: 'PATCH',
        body: {
          version: page.version,
          ...(blocks.length ? { content: blocks, contentText: blocksToText(blocks) } : {}),
          ...(look.cover ? { cover: look.cover, coverPosition: look.coverPosition ?? 50 } : {}),
          ...(look.fullWidth !== undefined ? { fullWidth: look.fullWidth } : {}),
          ...(look.slideTheme ? { slideTheme: look.slideTheme } : {}),
        },
      });
      if (database) await applyTemplateDatabase(page.id, database);
      await ws.reload();
      navigate(`/p/${page.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const unmark = async (t: TemplateSource) => {
    try {
      const { page } = await api<{ page: Page }>(`/pages/${t.id}`);
      await api(`/pages/${t.id}`, { method: 'PATCH', body: { version: page.version, isTemplate: false } });
      toast('テンプレートから外しました（ページはそのまま残ります）', 'success');
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const Card = ({ t, own }: { t: TemplateSource; own: boolean }) => (
    <div className="tpl-card">
      <div className="tpl-card-head">
        <PageIcon icon={t.icon} size={22} />
        <div className="tpl-card-title">{t.label ?? (fillTemplateText(t.title).replace(/\s*\d{4}\/\d{2}\/\d{2}$/, '').trim() || pageTitle(t))}</div>
      </div>
      {t.description && <p className="tpl-card-desc">{t.description}</p>}
      <div className="tpl-card-actions">
        <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void use(t)}>
          {busy === t.id ? '作成中…' : 'このテンプレートで作る'}
        </button>
        {own && (
          <>
            <Link className="btn btn-ghost btn-sm" to={`/p/${t.id}`}>
              編集
            </Link>
            <button className="btn btn-ghost btn-sm" onClick={() => void unmark(t)}>
              外す
            </button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="tasks-page tpl-page">
      <div className="tasks-head">
        <h1>
          <Icon name="template" size={26} /> テンプレート
        </h1>
      </div>
      <p className="tasks-lead">テンプレートを選ぶと、その形の新しいページを作って開きます。新しい空のページの「テンプレートから始める」からも使えます。</p>

      <h2 className="tpl-section">最初から入っているテンプレート</h2>
      <div className="tpl-grid">
        {BUILTIN_TEMPLATES.map((t) => (
          <Card key={t.id} t={t} own={false} />
        ))}
      </div>

      <h2 className="tpl-section">このワークスペースのテンプレート</h2>
      {!mine ? (
        <Spinner />
      ) : mine.length === 0 ? (
        <p className="muted small">まだありません。ページ右上の「…」メニューの「テンプレートにする」で、そのページをテンプレートにできます。</p>
      ) : (
        <div className="tpl-grid">
          {mine.map((t) => (
            <Card key={t.id} t={t} own />
          ))}
        </div>
      )}
    </div>
  );
}
