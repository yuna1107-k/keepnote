/** GitHub の HTML ファイルを sandbox のプレビューで動かすための差し込み（htmlShim.test.ts で確かめる） */

/**
 * sandbox の中では localStorage・sessionStorage を使うとエラーになり、Marp の HTML スライドなどのスクリプトが止まる。
 * 使えないときは、その場かぎりの入れ物に置き換える小さなスクリプトを先頭に入れる
 */
const STORAGE_SHIM = `<script>(function(){function m(){var d={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}['localStorage','sessionStorage'].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:m(),configurable:true})}catch(_){}}})})();</script>`;
export function withStorageShim(html: string) {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + STORAGE_SHIM + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0] + STORAGE_SHIM + html.slice(doctype[0].length) : STORAGE_SHIM + html;
}
