import type { CSSProperties } from 'react';

/**
 * カバーのギャラリー（グラデーション）。
 * ページには「gradient:番号」で保存されるので、並び順は変えずに末尾へ足していく
 */
export const COVER_GRADIENTS = [
  'linear-gradient(135deg, #f6d365 0%, #fda085 100%)',
  'linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%)',
  'linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)',
  'linear-gradient(135deg, #fbc2eb 0%, #a6c1ee 100%)',
  'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  'linear-gradient(135deg, #30cfd0 0%, #330867 100%)',
  'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
  'linear-gradient(160deg, #e0c3fc 0%, #8ec5fc 100%)',
  'linear-gradient(160deg, #ffecd2 0%, #fcb69f 100%)',
  // ここから追加分
  'linear-gradient(135deg, #ffdde1 0%, #ee9ca7 100%)',
  'linear-gradient(120deg, #d4fc79 0%, #96e6a1 100%)',
  'linear-gradient(120deg, #fccb90 0%, #d57eeb 100%)',
  'linear-gradient(135deg, #89f7fe 0%, #66a6ff 100%)',
  'linear-gradient(180deg, #2b5876 0%, #4e4376 100%)',
  'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)',
  'linear-gradient(180deg, #fdfbfb 0%, #ebedee 100%)',
  'linear-gradient(135deg, #c79081 0%, #dfa579 100%)',
  'linear-gradient(180deg, #0c3483 0%, #a2b6df 100%)',
  'linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%)',
  'linear-gradient(120deg, #e6b980 0%, #eacda3 100%)',
  'linear-gradient(180deg, #ff7e5f 0%, #feb47b 100%)',
  'radial-gradient(circle at 20% 30%, #fbd3e9 0%, transparent 55%), radial-gradient(circle at 80% 70%, #bbd2ff 0%, transparent 55%), #fdf6ff',
  'radial-gradient(circle at 25% 40%, #ffe29f 0%, transparent 50%), radial-gradient(circle at 75% 60%, #ffa99f 0%, transparent 55%), #fff4ec',
  'radial-gradient(circle at 30% 70%, #a8edea 0%, transparent 55%), radial-gradient(circle at 70% 30%, #c2ffd8 0%, transparent 55%), #f2fffb',
  'linear-gradient(180deg, #141e30 0%, #243b55 100%)',
];

/** 単色（「color:#rrggbb」で保存される） */
export const COVER_COLORS = ['#e16259', '#d9730d', '#dfab01', '#4d9a6a', '#0b8a8a', '#2383e2', '#6940a5', '#ad1a72', '#9a6b3f', '#37352f', '#4f6d7a', '#c0587a'];
/** 淡い色（単色の追加分） */
export const COVER_PASTELS = ['#fde2e1', '#fdebd3', '#fbf3c4', '#e8f5c8', '#dcefdc', '#d6eeee', '#dbe9fb', '#e7def6', '#f6dceb', '#fdf3e7', '#efe4d8', '#ececea'];

/** SVG を CSS の背景に使える data: URL にする */
const svg = (body: string, w: number, h: number) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>${body}</svg>`)}")`;

/**
 * 紙の質感（ざらつき）。ノイズの明るさで透明度を変えて、まだらな粒にする。
 * strength は粒の濃さ、freq は粒の細かさ、rgb は粒の色（0〜1）
 */
const grain = (strength: number, freq = 0.8, rgb = '0.3 0.24 0.16') => {
  const [r, g, b] = rgb.split(' ');
  return svg(
    `<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='${freq}' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 ${r} 0 0 0 0 ${g} 0 0 0 0 ${b} ${3 * strength} 0 0 0 ${-1.2 * strength}'/></filter><rect width='100%' height='100%' filter='url(#n)'/>`,
    200,
    200,
  );
};

/** 中心 (cx, cy)・半径 r の六角形（上下が平ら）の頂点 */
const hex = (cx: number, cy: number, r: number) =>
  [0, 60, 120, 180, 240, 300].map((a) => `${(cx + r * Math.cos((a * Math.PI) / 180)).toFixed(2)},${(cy + r * Math.sin((a * Math.PI) / 180)).toFixed(2)}`).join(' ');

export type CoverPattern = { id: string; label: string; group: 'pattern' | 'paper' | 'wa'; background: string };

/**
 * 模様・紙・和柄（「pattern:id」で保存される）。CSS と SVG だけで描くので、外部の画像は使わない。
 * id はページに保存されるので変えないこと
 */
export const COVER_PATTERNS: CoverPattern[] = [
  // ---- 模様 ----
  { id: 'dots', label: 'ドット', group: 'pattern', background: 'radial-gradient(#e8a0a0 2px, transparent 2.5px) 0 0 / 22px 22px, #fff4f1' },
  { id: 'polka', label: '水玉', group: 'pattern', background: 'radial-gradient(#ffffff 6px, transparent 6.5px) 0 0 / 40px 40px, radial-gradient(#ffffff 6px, transparent 6.5px) 20px 20px / 40px 40px, #7fb4e6' },
  {
    id: 'stripe',
    label: 'ストライプ',
    group: 'pattern',
    background: 'repeating-linear-gradient(45deg, #ffe8a3 0 14px, #fff6d6 14px 28px)',
  },
  {
    id: 'border',
    label: 'ボーダー',
    group: 'pattern',
    background: 'repeating-linear-gradient(0deg, #2f4a7a 0 12px, #f4f1ea 12px 24px)',
  },
  {
    id: 'gingham',
    label: 'ギンガムチェック',
    group: 'pattern',
    background:
      'linear-gradient(90deg, rgba(214, 84, 84, 0.45) 50%, transparent 50%) 0 0 / 32px 32px, linear-gradient(rgba(214, 84, 84, 0.45) 50%, transparent 50%) 0 0 / 32px 32px, #fff',
  },
  {
    id: 'grid',
    label: 'グリッド',
    group: 'pattern',
    background: 'linear-gradient(rgba(255,255,255,0.18) 1px, transparent 1px) 0 0 / 24px 24px, linear-gradient(90deg, rgba(255,255,255,0.18) 1px, transparent 1px) 0 0 / 24px 24px, #1f3b57',
  },
  {
    id: 'stars',
    label: '星空',
    group: 'pattern',
    background: `${svg(
      "<g fill='#fff'><circle cx='18' cy='24' r='1.2'/><circle cx='70' cy='12' r='0.8'/><circle cx='120' cy='40' r='1.5' fill='#ffe9a8'/><circle cx='190' cy='18' r='1'/><circle cx='40' cy='80' r='0.9'/><circle cx='96' cy='96' r='1.3' fill='#cfe0ff'/><circle cx='160' cy='76' r='0.8'/><circle cx='210' cy='120' r='1.2'/><circle cx='26' cy='140' r='1'/><circle cx='130' cy='146' r='0.9'/><circle cx='176' cy='150' r='1.4' fill='#ffe9a8'/><circle cx='66' cy='120' r='0.7'/></g>",
      220,
      160,
    )} 0 0 / 220px 160px, linear-gradient(180deg, #0b1d3a 0%, #23315e 60%, #4a3f73 100%)`,
  },
  {
    id: 'waves',
    label: '波',
    group: 'pattern',
    background: `${svg("<path d='M0 20 Q 20 0 40 20 T 80 20' fill='none' stroke='#ffffff' stroke-opacity='0.55' stroke-width='3'/>", 80, 40)} 0 0 / 80px 40px, linear-gradient(180deg, #5ec5d9, #2f86b5)`,
  },
  {
    id: 'zigzag',
    label: 'ジグザグ',
    group: 'pattern',
    background:
      'linear-gradient(135deg, #f2b880 25%, transparent 25%) -24px 0 / 48px 48px, linear-gradient(225deg, #f2b880 25%, transparent 25%) -24px 0 / 48px 48px, linear-gradient(315deg, #f2b880 25%, transparent 25%) 0 0 / 48px 48px, linear-gradient(45deg, #f2b880 25%, transparent 25%) 0 0 / 48px 48px, #fbe3c8',
  },
  {
    id: 'confetti',
    label: '紙吹雪',
    group: 'pattern',
    background:
      'radial-gradient(#f28b82 3px, transparent 3.5px) 0 0 / 60px 50px, radial-gradient(#fbbc04 2.5px, transparent 3px) 20px 30px / 70px 60px, radial-gradient(#81c995 3px, transparent 3.5px) 40px 10px / 50px 70px, radial-gradient(#8ab4f8 2.5px, transparent 3px) 10px 45px / 80px 55px, radial-gradient(#c58af9 2px, transparent 2.5px) 35px 5px / 45px 65px, #fffaf2',
  },
  {
    id: 'tartan',
    label: 'タータン',
    group: 'pattern',
    background:
      'repeating-linear-gradient(90deg, rgba(20, 60, 40, 0.5) 0 20px, transparent 20px 40px, rgba(220, 180, 60, 0.6) 40px 42px, transparent 42px 60px), repeating-linear-gradient(0deg, rgba(20, 60, 40, 0.5) 0 20px, transparent 20px 40px, rgba(220, 180, 60, 0.6) 40px 42px, transparent 42px 60px), #8c1c2b',
  },
  {
    id: 'circles',
    label: 'まる',
    group: 'pattern',
    background:
      'radial-gradient(circle at 12% 60%, rgba(255, 255, 255, 0.3) 0 70px, transparent 71px), radial-gradient(circle at 42% 15%, rgba(255, 255, 255, 0.22) 0 100px, transparent 101px), radial-gradient(circle at 82% 75%, rgba(255, 255, 255, 0.26) 0 130px, transparent 131px), linear-gradient(135deg, #7f7fd5, #86a8e7 50%, #91eae4)',
  },
  // ---- 紙・ノート ----
  {
    id: 'sticky',
    label: '付箋',
    group: 'paper',
    background: `${grain(0.12)}, linear-gradient(180deg, #fff3a8 0%, #ffe97a 100%)`,
  },
  {
    id: 'sticky-pink',
    label: '付箋（ピンク）',
    group: 'paper',
    background: `${grain(0.12)}, linear-gradient(180deg, #ffd9e4 0%, #ffc2d4 100%)`,
  },
  {
    id: 'sticky-blue',
    label: '付箋（水色）',
    group: 'paper',
    background: `${grain(0.12)}, linear-gradient(180deg, #d6efff 0%, #b9e2fb 100%)`,
  },
  {
    id: 'sticky-green',
    label: '付箋（黄緑）',
    group: 'paper',
    background: `${grain(0.12)}, linear-gradient(180deg, #e9f7c4 0%, #d6efa0 100%)`,
  },
  {
    id: 'ruled',
    label: '罫線ノート',
    group: 'paper',
    background:
      'linear-gradient(90deg, transparent 63px, rgba(229, 115, 115, 0.6) 63px 65px, transparent 65px), repeating-linear-gradient(180deg, transparent 0 27px, rgba(120, 160, 210, 0.45) 27px 28px), #fdfcf7',
  },
  {
    id: 'graph',
    label: '方眼紙',
    group: 'paper',
    background:
      'linear-gradient(rgba(90, 160, 140, 0.35) 1px, transparent 1px) 0 0 / 100px 100px, linear-gradient(90deg, rgba(90, 160, 140, 0.35) 1px, transparent 1px) 0 0 / 100px 100px, linear-gradient(rgba(90, 160, 140, 0.16) 1px, transparent 1px) 0 0 / 20px 20px, linear-gradient(90deg, rgba(90, 160, 140, 0.16) 1px, transparent 1px) 0 0 / 20px 20px, #fbfdf9',
  },
  {
    id: 'dot-grid',
    label: 'ドット方眼',
    group: 'paper',
    background: 'radial-gradient(rgba(80, 80, 80, 0.35) 1.2px, transparent 1.6px) 0 0 / 20px 20px, #fbfaf6',
  },
  {
    id: 'genko',
    label: '原稿用紙',
    group: 'paper',
    background: `${svg("<rect x='5.5' y='0.5' width='23' height='23' fill='none' stroke='#d77a6f' stroke-opacity='0.7'/>", 34, 24)} 0 0 / 34px 24px, #fdfbf4`,
  },
  { id: 'kraft', label: 'クラフト紙', group: 'paper', background: `${grain(0.3, 0.6)}, linear-gradient(135deg, #d2b48c 0%, #c4a27a 100%)` },
  { id: 'washi', label: '和紙', group: 'paper', background: `${grain(0.1)}, radial-gradient(circle at 30% 40%, #fffdf6, #f3ecdc)` },
  { id: 'cork', label: 'コルクボード', group: 'paper', background: `${grain(0.6, 0.45)}, radial-gradient(circle at 40% 40%, #c99a66, #a8774a)` },
  { id: 'blackboard', label: '黒板', group: 'paper', background: `${grain(0.25, 0.7, '1 1 1')}, radial-gradient(circle at 50% 40%, #3f5f4f, #26392f)` },
  // ---- 和柄 ----
  {
    id: 'ichimatsu',
    label: '市松',
    group: 'wa',
    background: 'conic-gradient(#2e5e4e 25%, #e8e1cf 0 50%, #2e5e4e 0 75%, #e8e1cf 0) 0 0 / 40px 40px',
  },
  {
    id: 'seigaiha',
    label: '青海波',
    group: 'wa',
    background: `${svg(
      "<defs><g id='f'><circle r='20' fill='#1f4e79'/><circle r='16' fill='#f3efe4'/><circle r='13' fill='#1f4e79'/><circle r='9' fill='#f3efe4'/><circle r='6' fill='#1f4e79'/><circle r='2.5' fill='#f3efe4'/></g></defs><use href='#f' x='20' y='-10'/><use href='#f' x='0' y='0'/><use href='#f' x='40' y='0'/><use href='#f' x='20' y='10'/><use href='#f' x='0' y='20'/><use href='#f' x='40' y='20'/><use href='#f' x='20' y='30'/>",
      40,
      20,
    )} 0 0 / 40px 20px, #1f4e79`,
  },
  {
    id: 'shippo',
    label: '七宝',
    group: 'wa',
    background: `${svg("<g fill='none' stroke='#c9a24a' stroke-width='1.6'><circle cx='0' cy='0' r='20'/><circle cx='40' cy='0' r='20'/><circle cx='0' cy='40' r='20'/><circle cx='40' cy='40' r='20'/><circle cx='20' cy='20' r='20'/></g>", 40, 40)} 0 0 / 40px 40px, #7a1f2b`,
  },
  {
    id: 'asanoha',
    label: '麻の葉',
    group: 'wa',
    background: `${svg(
      "<g fill='none' stroke='#f2d7e0' stroke-width='1'><path d='M0 0 L30 17.32 L60 0 M0 34.64 L30 17.32 L60 34.64 M30 0 L30 34.64 M0 0 L0 34.64 M60 0 L60 34.64 M0 0 L15 25.98 L30 17.32 M60 0 L45 25.98 L30 17.32 M0 34.64 L15 8.66 L30 17.32 M60 34.64 L45 8.66 L30 17.32 M0 17.32 L30 17.32 L60 17.32'/></g>",
      60,
      34.64,
    )} 0 0 / 60px 34.64px, #c0587a`,
  },
  {
    id: 'yagasuri',
    label: '矢絣',
    group: 'wa',
    background: `${svg(
      "<g fill='#6b3d7a'><polygon points='0,0 10,9 20,0 20,20 10,29 0,20'/><polygon points='20,20 30,29 40,20 40,40 30,49 20,40'/><polygon points='20,-20 30,-11 40,-20 40,0 30,9 20,0'/></g>",
      40,
      40,
    )} 0 0 / 40px 40px, #f1e6f3`,
  },
  {
    id: 'uroko',
    label: '鱗',
    group: 'wa',
    background: `${svg("<polygon points='0,34.64 20,0 40,34.64' fill='#c8553d'/>", 40, 34.64)} 0 0 / 40px 34.64px, #f6e7c8`,
  },
  {
    id: 'kikko',
    label: '亀甲',
    group: 'wa',
    background: `${svg(
      `<g fill='none' stroke='#e9dcb5' stroke-width='1.2'>${[
        [20, 17.32],
        [50, 0],
        [50, 34.64],
        [-10, 0],
        [-10, 34.64],
      ]
        .map(([x, y]) => `<polygon points='${hex(x!, y!, 20)}'/><polygon points='${hex(x!, y!, 15)}'/>`)
        .join('')}</g>`,
      60,
      34.64,
    )} 0 0 / 60px 34.64px, #2f5d50`,
  },
  {
    id: 'kanoko',
    label: '鹿の子',
    group: 'wa',
    background: `${svg(
      `${[
        [12, 12],
        [0, 0],
        [24, 0],
        [0, 24],
        [24, 24],
      ]
        .map(([x, y]) => `<rect x='${x! - 5}' y='${y! - 5}' width='10' height='10' rx='2.5' fill='#fbeff0' transform='rotate(45 ${x} ${y})'/><circle cx='${x}' cy='${y}' r='1.8' fill='#b23a48'/>`)
        .join('')}`,
      24,
      24,
    )} 0 0 / 24px 24px, #b23a48`,
  },
];

export const PATTERN_GROUPS: { id: CoverPattern['group']; label: string }[] = [
  { id: 'pattern', label: '模様' },
  { id: 'paper', label: '紙・ノート' },
  { id: 'wa', label: '和柄' },
];

/** 写真のカバー（パブリックドメイン・CC0 の写真と名画。/covers/ に置いてある） */
export type CoverPhoto = { id: string; label: string; group: 'nature' | 'japan' | 'study' | 'space' | 'art' };
export const PHOTO_GROUPS: { id: CoverPhoto['group']; label: string }[] = [
  { id: 'nature', label: '写真：自然' },
  { id: 'japan', label: '写真：日本' },
  { id: 'study', label: '写真：勉強' },
  { id: 'space', label: '写真：宇宙（NASA）' },
  { id: 'art', label: '名画' },
];
export const COVER_PHOTOS: CoverPhoto[] = [
  { id: 'lake-mirror', label: '山の湖', group: 'nature' },
  { id: 'mountain-lake', label: '湖と山', group: 'nature' },
  { id: 'wave', label: '波', group: 'nature' },
  { id: 'ocean', label: '青い海', group: 'nature' },
  { id: 'sunset-sea', label: '夕暮れの海', group: 'nature' },
  { id: 'fog-forest', label: '霧の森', group: 'nature' },
  { id: 'forest-aerial', label: '森', group: 'nature' },
  { id: 'clouds-high', label: '雲の上', group: 'nature' },
  { id: 'sky', label: '青空', group: 'nature' },
  { id: 'flowers', label: '花畑', group: 'nature' },
  { id: 'highland', label: '雲の山', group: 'nature' },
  { id: 'sunset-lake', label: '夕焼けの湖', group: 'nature' },
  { id: 'sakura', label: '桜', group: 'japan' },
  { id: 'bamboo', label: '竹林', group: 'japan' },
  { id: 'tateyama', label: '立山', group: 'japan' },
  { id: 'snow-mountains', label: '雪の村', group: 'japan' },
  { id: 'lost-japan', label: '夜の神社', group: 'japan' },
  { id: 'in-japan', label: 'ラーメン屋', group: 'japan' },
  { id: 'desk', label: '机', group: 'study' },
  { id: 'study-room', label: '書斎', group: 'study' },
  { id: 'bookshelf', label: '本棚', group: 'study' },
  { id: 'journal', label: 'ノートとコーヒー', group: 'study' },
  { id: 'coffee-notes', label: 'ノートとペン', group: 'study' },
  { id: 'library', label: '図書館（シアトル）', group: 'study' },
  { id: 'books', label: '本の山', group: 'study' },
  { id: 'milky-way', label: '天の川の中心', group: 'space' },
  { id: 'city-lights', label: '夜の地球', group: 'space' },
  { id: 'iss-morning', label: '宇宙からの朝', group: 'space' },
  { id: 'hubble', label: '星団', group: 'space' },
  { id: 'star-trails', label: '星の軌跡', group: 'space' },
  { id: 'great-wave', label: '神奈川沖浪裏（北斎）', group: 'art' },
  { id: 'red-fuji', label: '凱風快晴（北斎）', group: 'art' },
  { id: 'water-lily-pond', label: '睡蓮の池（モネ）', group: 'art' },
  { id: 'water-lilies-sunset', label: '睡蓮・夕日（モネ）', group: 'art' },
  { id: 'starry-night', label: 'ローヌ川の星月夜（ゴッホ）', group: 'art' },
];
export const photoUrl = (id: string, thumb = false) => `/covers/${id}${thumb ? '.thumb' : ''}.jpg`;

export function isImageCover(cover: string) {
  return cover.startsWith('/api/files/') || cover.startsWith('https://') || cover.startsWith('photo:');
}

/** カバー値から背景スタイルを作る。resolve は画像URLの書き換え（公開ページ用） */
export function coverStyle(cover: string, position: number, resolve: (url: string) => string = (u) => u): CSSProperties {
  if (cover.startsWith('gradient:')) return { background: COVER_GRADIENTS[Number(cover.slice(9))] ?? COVER_GRADIENTS[0] };
  if (cover.startsWith('color:')) return { background: cover.slice(6) };
  if (cover.startsWith('pattern:')) return { background: (COVER_PATTERNS.find((p) => p.id === cover.slice(8)) ?? COVER_PATTERNS[0]!).background };
  const url = cover.startsWith('photo:') ? photoUrl(cover.slice(6)) : resolve(cover);
  return {
    backgroundImage: `url("${url.replace(/"/g, '%22')}")`,
    backgroundSize: 'cover',
    backgroundPosition: `center ${position}%`,
  };
}

/** 「カバーを追加」で付けるカバー（グラデーション・模様・紙・写真からランダムに選ぶ） */
export function randomGalleryCover() {
  const all = [
    ...COVER_GRADIENTS.map((_, i) => `gradient:${i}`),
    ...COVER_PATTERNS.filter((p) => p.group !== 'wa').map((p) => `pattern:${p.id}`),
    ...COVER_PHOTOS.filter((p) => p.group !== 'art').map((p) => `photo:${p.id}`),
  ];
  return all[Math.floor(Math.random() * all.length)]!;
}
