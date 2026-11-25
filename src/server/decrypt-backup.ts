/**
 * バックアップファイル（db-*.sql.gz.enc）を SQL に戻す。
 *
 *   npm run backup:decrypt -- <バックアップ> <出力.sql> [鍵ファイル]
 *
 * 鍵は環境変数 DATA_KEY か、鍵ファイル（DATA_KEY の値だけが書かれたファイル）で渡す。
 */
import fs from 'node:fs';
import { decryptBytes, setDataKey } from './crypto.ts';

const [input, output, keyFile] = process.argv.slice(2);
if (!input || !output) {
  console.error('使い方: npm run backup:decrypt -- <バックアップ> <出力.sql> [鍵ファイル]');
  process.exit(1);
}
const key = keyFile ? fs.readFileSync(keyFile, 'utf8').trim() : process.env.DATA_KEY;
if (!key) {
  console.error('鍵がありません（環境変数 DATA_KEY か、3 つ目の引数に鍵ファイルを指定してください）');
  process.exit(1);
}
setDataKey(key);
const enc = new Uint8Array(fs.readFileSync(input));
const gz = await decryptBytes(enc);
const sql = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
fs.writeFileSync(output, sql, { mode: 0o600 });
console.log(`${output} に書き出しました（${sql.split('\n').length} 行）`);
