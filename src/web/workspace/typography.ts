/**
 * 記号の自動変換（Notion と同じように、打った「->」を「→」などにする）。
 *
 * - ProseMirror の入力ルールとして、文字を打った瞬間に変換する（貼り付けた文章は変えない）
 * - コードブロック・インラインコード・数式の中（打ちかけの「$...」「`...」も含む）では変換しない
 * - 変換した直後に ⌘/Ctrl + Z を押すと、打ったとおりの文字に戻る
 */
import { createExtension } from '@blocknote/core';
import { InputRule, inputRules } from 'prosemirror-inputrules';
import type { EditorState, Transaction } from 'prosemirror-state';

/**
 * 段落の中で、pos より前に閉じていない「$」（打ちかけの数式）や「`」（打ちかけのインラインコード）があるか。
 * 閉じたときに数式・コードになるので、その中の記号は変えない
 */
function inPendingMathOrCode(state: EditorState, pos: number) {
  const $pos = state.doc.resolve(pos);
  const before = $pos.parent.textBetween(0, $pos.parentOffset, undefined, '￼');
  if ((before.match(/`/g) ?? []).length % 2 === 1) return true;
  if (!before.includes('$')) return false;
  // 「\$」は文字としての $。「$$」も 1 つの区切りとして数える。
  // 数式の外で「$」のすぐ後が数字なら金額（$5 など）なので、数式の始まりとは見なさない
  const text = before.replace(/\\\$/g, '');
  let open = false;
  for (const m of text.matchAll(/\$\$?/g)) {
    if (!open && m[0] === '$' && /\d/.test(text[m.index + 1] ?? '')) continue;
    open = !open;
  }
  return open;
}

type Rule = { find: RegExp; to: string; /** 段落の先頭では変換しない（「---」の区切り線を作れるように） */ notAtStart?: boolean };

/**
 * 変換の一覧。長い記号（<=> など）は、短い記号が先に変換された結果（≤ など）に続けて打ったときに作る。
 * 例：「<」「=」で ≤ になり、続けて「>」を打つと ⇔ になる
 */
const RULES: Rule[] = [
  { find: /←>$/, to: '↔' },
  { find: /≤>$/, to: '⇔' },
  // 「-->」は「--」が先に「—」になるので、続けて「>」を打ったら矢印にする
  { find: /—>$/, to: '→' },
  { find: /<-$/, to: '←' },
  { find: /->$/, to: '→' },
  { find: /<=$/, to: '≤' },
  { find: /=>$/, to: '⇒' },
  { find: />=$/, to: '≥' },
  { find: /!=$/, to: '≠' },
  { find: /\+-$/, to: '±' },
  { find: /\.\.\.$/, to: '…' },
  // 「---」（区切り線）の途中の「--」は変えない
  { find: /(?<![-—])--$/, to: '—', notAtStart: true },
  { find: /\([cC]\)$/, to: '©' },
  { find: /\([rR]\)$/, to: '®' },
  { find: /\((?:tm|TM|Tm)\)$/, to: '™' },
];

export const TypographyExtension = createExtension(() => {
  const plugin = inputRules({
    rules: RULES.map(
      (r) =>
        new InputRule(
          r.find,
          (state: EditorState, _match: RegExpMatchArray, start: number, end: number): Transaction | null => {
            if (r.notAtStart && state.doc.resolve(start).parentOffset === 0) return null;
            if (inPendingMathOrCode(state, start)) return null;
            return state.tr.insertText(r.to, start, end);
          },
          { inCodeMark: false },
        ),
    ),
  });

  return {
    key: 'typography',
    prosemirrorPlugins: [plugin],
    keyboardShortcuts: {
      // 変換した直後の ⌘/Ctrl + Z は、変換だけを取り消す（打ったとおりの文字に戻す）
      'Mod-z': ({ editor }) => {
        const view = editor.prosemirrorView;
        if (!view) return false;
        const undoable = plugin.getState(view.state);
        if (!undoable) return false;
        const tr = view.state.tr;
        const done = undoable.transform;
        for (let i = done.steps.length - 1; i >= 0; i--) tr.step(done.steps[i]!.invert(done.docs[i]!));
        const marks = tr.doc.resolve(undoable.from).marks();
        if (undoable.text) tr.replaceWith(undoable.from, undoable.to, view.state.schema.text(undoable.text, marks));
        else tr.delete(undoable.from, undoable.to);
        view.dispatch(tr);
        return true;
      },
    },
  };
});
