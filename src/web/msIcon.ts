/**
 * エディター（BlockNote）の部品のアイコンを、Google の Material Symbols に置き換えるための部品。
 * ビルド時に vite.config.ts の blocknoteIcons() が、BlockNote 内の各アイコンをこれに差し替える。
 */
import { createElement, type CSSProperties } from 'react';
import { EDITOR_ICON_CODEPOINTS } from './uiIconCodepoints';

type Props = { size?: number | string; color?: string; className?: string; style?: CSSProperties; title?: string };

export function msIcon(name: string) {
  const cp = EDITOR_ICON_CODEPOINTS[name]!;
  return (props: Props) => {
    const size = props.size ?? '1em';
    return createElement(
      'span',
      {
        className: `ui-icon ${props.className ?? ''}`,
        'aria-hidden': true,
        title: props.title,
        style: { fontSize: size, width: size, height: size, color: props.color, ...props.style },
      },
      String.fromCodePoint(cp),
    );
  };
}
