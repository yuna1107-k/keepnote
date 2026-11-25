import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** PDF 表示（pdf.js）が使う文字の対応表・標準フォント・画像の復号器を、ビルド結果の /pdfjs/ に置く */
function pdfjsAssets(): Plugin {
  return {
    name: 'pdfjs-assets',
    apply: 'build',
    closeBundle() {
      for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
        cpSync(new URL(`./node_modules/pdfjs-dist/${dir}/`, import.meta.url), new URL(`./dist/web/pdfjs/${dir}/`, import.meta.url), { recursive: true });
      }
    },
  };
}

/**
 * y-prosemirror（共同編集）の不具合の回避：相手の変更を反映した後に自分のカーソルを戻すとき、
 * 位置が文書の範囲外になると例外で反映自体が止まり、画面と実際の内容がずれてしまう。範囲内に収めるよう書き換える。
 * （y-prosemirror 1.3.7 時点。修正版が出たら外す）
 */
function ySelectionClamp(): Plugin {
  const target = /y-prosemirror\/src\/plugins\/sync-plugin\.js$/;
  return {
    name: 'y-prosemirror-selection-clamp',
    enforce: 'pre',
    transform(code, id) {
      if (!target.test(id.split('?')[0]!)) return null;
      const clamp = '((p) => Math.max(0, Math.min(p, tr.doc.content.size)))';
      const out = code
        .replace('TextSelection.between(tr.doc.resolve(anchor), tr.doc.resolve(head))', `TextSelection.between(tr.doc.resolve(${clamp}(anchor)), tr.doc.resolve(${clamp}(head)))`)
        .replace('tr.setSelection(NodeSelection.create(tr.doc, anchor))', `if (anchor !== null && anchor < tr.doc.content.size) tr.setSelection(NodeSelection.create(tr.doc, anchor))`);
      if (out === code || !out.includes(clamp)) throw new Error('y-prosemirror の修正箇所が見つかりません（バージョンが変わった可能性があります）');
      return { code: out, map: null };
    },
  };
}

/**
 * エディター（BlockNote）の部品のアイコンを、Google の Material Symbols に差し替える。
 * BlockNote は react-icons のアイコンを中に埋め込んでいるため、各アイコンの形のデータから元のアイコンを特定し
 * （src/web/editorIcons.json）、src/web/msIcon.ts の部品に置き換える。
 * 対応表にないアイコンが見つかったらビルドを止める（BlockNote の更新でアイコンが増えたときに気づけるように）。
 */
function blocknoteIcons(): Plugin {
  const map = JSON.parse(readFileSync(new URL('./src/web/editorIcons.json', import.meta.url), 'utf8')) as Record<string, string>;
  const shim = fileURLToPath(new URL('./src/web/msIcon.ts', import.meta.url));
  // 使っていない機能（コメント・版の比較）の部品は対象外
  const target = /@blocknote\/(react|mantine)\/dist\/(?!versioning)[^/]+\.js$/;
  const fn = /function ([\w$]+)\(e\) \{\n\treturn ([\w$]+)\(\{\n\t\ttag: "svg",([\s\S]*?)\n\t\}\)\(e\);\n\}/g;
  return {
    name: 'blocknote-material-icons',
    enforce: 'pre',
    transform(code, id) {
      if (!target.test(id.split('?')[0]!)) return null;
      const unknown: string[] = [];
      let count = 0;
      const out = code.replace(fn, (all, name: string, _gen: string, body: string) => {
        const ds = [...body.matchAll(/d: "([^"]*)"/g)].map((m) => m[1]).filter((d) => d !== 'M0 0h24v24H0z' && d !== 'M0 0h24v24H0V0z');
        const ms = map[createHash('sha1').update(ds.join('|')).digest('hex').slice(0, 16)];
        if (!ms) {
          unknown.push(`${name}: ${ds[0]?.slice(0, 40)}`);
          return all;
        }
        count++;
        return `function ${name}(e) {\n\treturn __msIcon(${JSON.stringify(ms)})(e);\n}`;
      });
      if (unknown.length) throw new Error(`BlockNote に Google のアイコンへの対応がないアイコンがあります（src/web/editorIcons.json に追加してください）：\n${unknown.join('\n')}`);
      if (!count) return null;
      return { code: `import { msIcon as __msIcon } from ${JSON.stringify(shim)};\n${out}`, map: null };
    },
  };
}

// バージョン情報（管理者画面に表示）。Workers Builds では WORKERS_CI_COMMIT_SHA が使える
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
function commit() {
  const ci = process.env.WORKERS_CI_COMMIT_SHA;
  if (ci) return ci.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

// 開発時は Workers（wrangler dev, 8790）に API をプロキシする。`vite --mode node` のときは Node 版（3000）へ

export default defineConfig(({ mode }) => ({
  root: 'src/web',
  plugins: [ySelectionClamp(), blocknoteIcons(), react(), pdfjsAssets()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_COMMIT__: JSON.stringify(commit()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // API_PORT：開発用ログインの環境（npm run dev:local）は、ふだんの開発と別のポートで動かす
      // 「/api/」で始まるものだけ（「/api」だけだと画面のファイル /api.ts まで API に回してしまう）
      '^/api/': { target: `http://localhost:${process.env.API_PORT ?? (mode === 'node' ? 3000 : 8790)}` },
    },
  },
}));
