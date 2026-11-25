"""
画面の部品用のアイコンフォントを作る（Material Symbols から、src/web/uiIcons.ts と
src/web/editorIcons.json（エディターの部品のアイコン）に書いたアイコンだけを抜き出す）。

  pip install fonttools brotli
  npm run icons

出力
  src/web/public/fonts/ui-icons.woff2   … 太さなどを固定した小さなフォント（塗りつぶしの軸だけ残す）
  src/web/uiIconCodepoints.ts           … アイコン名 → 文字コード（エディター用は Material Symbols の名前で引く）
"""
import json
import re
import sys
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'node_modules/material-symbols/material-symbols-outlined.woff2'
names_ts = (ROOT / 'src/web/uiIcons.ts').read_text()
icons = dict(re.findall(r"^\s+(\w+): '([a-z0-9_]+)',", names_ts, re.M))
if not icons:
    sys.exit('uiIcons.ts からアイコンを読み取れませんでした')
editor = sorted(set(json.loads((ROOT / 'src/web/editorIcons.json').read_text()).values()))

font = TTFont(SRC, lazy=False)
glyph_cp = {}
for cp, glyph in font.getBestCmap().items():
    glyph_cp.setdefault(glyph, cp)
missing = [n for n in [*icons.values(), *editor] if n not in glyph_cp]
if missing:
    sys.exit(f'Material Symbols にないアイコンです: {missing}')

# 使うアイコンだけを残す
opts = Options()
opts.layout_features = []
opts.name_IDs = ['*']
sub = Subsetter(opts)
sub.populate(unicodes=sorted({glyph_cp[n] for n in [*icons.values(), *editor]}))
sub.subset(font)
# 太さ・グレード・大きさを固定し、塗りつぶし（FILL）だけ切り替えられるようにする
font = instancer.instantiateVariableFont(font, {'wght': 400, 'GRAD': 0, 'opsz': 20})
font.flavor = 'woff2'
out = ROOT / 'src/web/public/fonts/ui-icons.woff2'
font.save(out)

cps = {key: glyph_cp[name] for key, name in icons.items()}
editor_cps = {name: glyph_cp[name] for name in editor}
(ROOT / 'src/web/uiIconCodepoints.ts').write_text(
    '// scripts/build-ui-icons.py で生成（手で編集しない）\n'
    f'export const UI_ICON_CODEPOINTS: Record<string, number> = {json.dumps(cps, indent=2)};\n\n'
    f'export const EDITOR_ICON_CODEPOINTS: Record<string, number> = {json.dumps(editor_cps, indent=2)};\n'
)
print(f'{len(icons)} + {len(editor)} アイコン → {out.relative_to(ROOT)}（{out.stat().st_size // 1024} KB）')
