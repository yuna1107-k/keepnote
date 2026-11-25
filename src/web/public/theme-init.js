// 描画前に保存済みのテーマを適用して、ちらつきを防ぐ
try {
  var t = localStorage.getItem('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
