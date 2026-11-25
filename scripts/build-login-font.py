"""
ログイン・登録画面の手書き文字用に、無心フォント（public/fonts/mushin.woff2、2.7MB）から
英数字・かな・カナと、画面で使う漢字だけを抜き出す。

  pip install fonttools brotli
  python3 scripts/build-login-font.py
"""
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
text = ''.join(chr(c) for c in range(0x20, 0x7F))  # 英数字・記号
text += ''.join(chr(c) for c in range(0x3041, 0x3097))  # ひらがな
text += ''.join(chr(c) for c in range(0x30A1, 0x30FB)) + 'ー・、。「」'  # カタカナ
text += '年月日曜火水木金土鍵開帳面記録自分私的覚書管理者発行端末変登録頼有効期限回使再作成新規完了無効今度次様方依'  # 画面で使う漢字
font = TTFont(ROOT / 'src/web/public/fonts/mushin.woff2')
opts = Options()
opts.flavor = 'woff2'
opts.name_IDs = ['*']
opts.layout_features = ['*']
sub = Subsetter(opts)
sub.populate(text=text)
sub.subset(font)
font.flavor = 'woff2'
out = ROOT / 'src/web/public/fonts/mushin-login.woff2'
font.save(out)
print(f'{out.relative_to(ROOT)}（{out.stat().st_size // 1024} KB）')
