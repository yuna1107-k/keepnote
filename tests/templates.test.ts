import { describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES, fillTemplateText, isEmptyDocument, prepareTemplateBlocks } from '../src/web/workspace/templates';
import { filterRows, sortRows, type DbRow, type DbSchema } from '../src/web/workspace/dbModel';

describe('テンプレート', () => {
  it('{{date}}・{{year}} を置き換える', () => {
    expect(fillTemplateText('講義ノート {{date}}')).toMatch(/^講義ノート \d{4}\/\d{2}\/\d{2}$/);
    expect(fillTemplateText('Journal {{年}}')).toBe(`Journal ${new Date().getFullYear()}`);
  });
  it('ブロックの ID を外し、本文の {{date}} も置き換える', () => {
    const out = prepareTemplateBlocks([{ id: 'x', type: 'paragraph', content: [{ type: 'text', text: '{{date}}', styles: {} }] }]);
    expect(out[0].id).toBeUndefined();
    expect(out[0].content[0].text).not.toContain('{{');
  });
  it('ID が重ならない', () => {
    const ids = BUILTIN_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('データベースのテンプレートの表示が、ある列だけを使う', () => {
    for (const t of BUILTIN_TEMPLATES.filter((x) => x.database)) {
      const props = new Set(t.database!.props.map((p) => p.id));
      for (const v of t.database!.views as { groupBy?: string; dateProp?: string; sort?: { prop: string } }[]) {
        for (const ref of [v.groupBy, v.dateProp, v.sort?.prop]) if (ref) expect(props.has(ref), `${t.id}: ${ref}`).toBe(true);
      }
    }
  });
  it('空のページの判定', () => {
    expect(isEmptyDocument([{ type: 'paragraph', content: [] }])).toBe(true);
    expect(isEmptyDocument([{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }])).toBe(false);
  });
});

describe('データベースの絞り込み・並べ替え', () => {
  const schema: DbSchema = {
    props: [
      { id: 'n', name: '数', type: 'number' },
      { id: 's', name: '状態', type: 'select', options: [{ id: 'a', name: 'A', color: 'gray' }, { id: 'b', name: 'B', color: 'blue' }] },
    ],
    views: [{ id: 'v', name: '表', type: 'table' }],
  };
  const row = (id: string, values: Record<string, unknown>): DbRow => ({ id, title: id, icon: null, createdAt: 0, updatedAt: 0, values, canEdit: true });
  const rows = [row('x', { n: 3, s: 'b' }), row('y', { n: 10, s: 'a' }), row('z', {})];
  it('数値は数として比べる（"10" < "3" にならない）', () => {
    expect(sortRows(rows, schema, { prop: 'n', dir: 'asc' }, []).map((r) => r.id)).toEqual(['x', 'y', 'z']);
  });
  it('空の値は降順でも最後', () => {
    expect(sortRows(rows, schema, { prop: 'n', dir: 'desc' }, []).map((r) => r.id)).toEqual(['y', 'x', 'z']);
  });
  it('セレクトは選択肢の順', () => {
    expect(sortRows(rows, schema, { prop: 's', dir: 'asc' }, []).map((r) => r.id)).toEqual(['y', 'x', 'z']);
  });
  it('絞り込み', () => {
    expect(filterRows(rows, schema, [{ prop: 's', op: 'has', value: 'a' }]).map((r) => r.id)).toEqual(['y']);
    expect(filterRows(rows, schema, [{ prop: 'n', op: 'gt', value: 5 }]).map((r) => r.id)).toEqual(['y']);
    expect(filterRows(rows, schema, [{ prop: 'n', op: 'empty' }]).map((r) => r.id)).toEqual(['z']);
  });
});
