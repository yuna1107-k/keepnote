/**
 * スライドで表示するときのテーマ。見た目は styles.css の .slide-theme-<id> に書く。
 * 「研究発表」は調査・研究の発表向けの配色（白地・青緑の見出し・赤瓦色の強調）、
 * ほかも日本語の文字で読みやすいように調整した配色。
 * ページには id だけを保存する（知らない id は標準として表示する）。
 */
export type SlideTheme = {
  id: string;
  label: string;
  description: string;
  /** 一覧の見本：背景・文字・強調の色 */
  swatch: { bg: string; text: string; accent: string };
};

export const SLIDE_THEMES: SlideTheme[] = [
  {
    id: 'academic',
    label: '研究発表',
    description: '白地に青緑の見出し、結論は赤瓦色。表紙は明朝。調査結果や表の多い発表に',
    swatch: { bg: '#FAFBFC', text: '#22313A', accent: '#A23B2A' },
  },
  {
    id: 'ocean',
    label: '深い海',
    description: '紺の地に浅葱色。落ち着いた報告や提案に',
    swatch: { bg: '#1A2332', text: '#F1FAEE', accent: '#2D8B8B' },
  },
  {
    id: 'forest',
    label: '森',
    description: '生成りの地に深緑、見出しは明朝。環境・暮らしの話題に',
    swatch: { bg: '#FAF9F6', text: '#2D4A2B', accent: '#7D8471' },
  },
  {
    id: 'minimal',
    label: 'モノトーン',
    description: '灰色だけで組んだ、飾りの少ないテーマ',
    swatch: { bg: '#FFFFFF', text: '#36454F', accent: '#708090' },
  },
  {
    id: 'arctic',
    label: '氷',
    description: '白と淡い水色に鋼の青。技術や医療の説明に',
    swatch: { bg: '#FAFAFA', text: '#24364F', accent: '#4A6FA5' },
  },
  {
    id: 'sunset',
    label: '夕暮れ',
    description: '深い青緑に橙と砂色。企画やイベントの紹介に',
    swatch: { bg: '#264653', text: '#FFFFFF', accent: '#E76F51' },
  },
  {
    id: 'galaxy',
    label: '夜空',
    description: '濃い紫の地に藤色。作品紹介や印象に残したい発表に',
    swatch: { bg: '#2B1E3E', text: '#E6E6FA', accent: '#A490C2' },
  },
];

export function findSlideTheme(id: string | null | undefined) {
  return id ? SLIDE_THEMES.find((t) => t.id === id) ?? null : null;
}
