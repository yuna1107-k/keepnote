# 第三者の素材について / Third-party notices

keepnote のソースコードは [MIT License](./LICENSE) です。ただし、次の素材はそれぞれのライセンスに従います。

The keepnote source code is licensed under the [MIT License](./LICENSE). The following bundled assets are distributed under their own terms.

| 素材 / Asset | 場所 / Location | ライセンス / License |
| --- | --- | --- |
| 手書きフォント「無心 (Mushin)」ver.1.04 — MODI工場 | `src/web/public/fonts/mushin.woff2`, `mushin-login.woff2` | MODI工場 独自ライセンス（商用利用・改変・再配布・埋め込み可。フォント単体での有料販売は不可）。全文は [`mushin-LICENSE.txt`](./src/web/public/fonts/mushin-LICENSE.txt) |
| 画面のアイコンのフォント（[Material Symbols](https://github.com/google/material-design-icons) の一部を抜き出したもの） | `src/web/public/fonts/ui-icons.woff2` | Apache License 2.0 — Copyright Google LLC |
| カバー写真 | `src/web/public/covers/` | パブリックドメインまたは CC0（Wikimedia Commons）。1 枚ずつの出典は [`SOURCES.md`](./src/web/public/covers/SOURCES.md) |

ビルド時に `node_modules` から取り込むライブラリ（React、BlockNote、pdf.js など）は、それぞれのパッケージに含まれるライセンスに従います。

Libraries pulled in from `node_modules` at build time (React, BlockNote, pdf.js, and others) are covered by the licenses shipped with each package.
