import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AVATAR_COLORS, makeSymbol, SymbolGlyph } from '../ui';

/** 検索語を入れていないときに出す、よく使う Google のアイコン */
const POPULAR =
  'description article note_stack edit_note book menu_book library_books folder folder_open inventory_2 bookmark star favorite lightbulb check_circle task_alt checklist list format_list_bulleted calendar_month event schedule alarm today home work school science calculate code terminal bug_report database cloud language public map location_on flag push_pin label sell link attach_file image photo_camera movie music_note headphones mic chat forum mail call person group groups face pets eco park local_cafe restaurant shopping_cart payments savings account_balance trending_up bar_chart pie_chart insights analytics rocket_launch flight directions_car train sports_esports fitness_center sports_soccer palette brush draw build settings tune key lock shield security verified warning error info help search visibility notifications campaign emoji_objects psychology auto_awesome bolt local_fire_department water_drop sunny dark_mode';

/** 日本語で探せるようにする言い換え（英語名の一部に置き換えて検索する） */
const JA: Record<string, string> = {
  家: 'home', ホーム: 'home', 本: 'book', ノート: 'note', メモ: 'note', 文書: 'description', ファイル: 'file', フォルダ: 'folder',
  星: 'star', ハート: 'favorite', 好き: 'favorite', 電球: 'lightbulb', アイデア: 'lightbulb', チェック: 'check', 完了: 'done', リスト: 'list',
  カレンダー: 'calendar', 予定: 'event', 時計: 'schedule', 時間: 'schedule', アラーム: 'alarm', 仕事: 'work', 学校: 'school', 勉強: 'school',
  科学: 'science', 計算: 'calculate', コード: 'code', 虫: 'bug', バグ: 'bug', クラウド: 'cloud', 地図: 'map', 場所: 'location', 旗: 'flag',
  ピン: 'push_pin', リンク: 'link', 画像: 'image', 写真: 'photo', カメラ: 'camera', 動画: 'movie', 映画: 'movie', 音楽: 'music', マイク: 'mic',
  チャット: 'chat', メール: 'mail', 電話: 'call', 人: 'person', グループ: 'group', 顔: 'face', ペット: 'pets', 植物: 'eco', 葉: 'eco',
  カフェ: 'cafe', コーヒー: 'coffee', 食事: 'restaurant', 買い物: 'shopping', お金: 'payments', 銀行: 'account_balance', グラフ: 'chart',
  ロケット: 'rocket', 飛行機: 'flight', 車: 'car', 電車: 'train', ゲーム: 'game', 運動: 'fitness', サッカー: 'soccer', 絵: 'palette',
  筆: 'brush', 道具: 'build', 設定: 'settings', 鍵: 'key', ロック: 'lock', 盾: 'shield', 警告: 'warning', 注意: 'warning', エラー: 'error',
  情報: 'info', ヘルプ: 'help', 検索: 'search', 目: 'visibility', 通知: 'notifications', ベル: 'notifications', 稲妻: 'bolt', 火: 'fire',
  水: 'water', 太陽: 'sunny', 晴れ: 'sunny', 月: 'dark_mode', 夜: 'dark_mode', 雨: 'rainy', 雪: 'ac_unit', 天気: 'weather',
  ゴミ箱: 'delete', 削除: 'delete', 追加: 'add', 編集: 'edit', ペン: 'edit', 保存: 'save', ダウンロード: 'download', アップロード: 'upload',
  共有: 'share', 送信: 'send', 矢印: 'arrow', 音: 'volume', 動物: 'pets', 犬: 'pets', 猫: 'pets', 病院: 'hospital', 薬: 'medication',
  健康: 'health', 旅行: 'travel', ホテル: 'hotel', 地球: 'public', 世界: 'public', 言語: 'language', 翻訳: 'translate', 大学: 'school',
  授業: 'school', 講義: 'school', 宿題: 'assignment', 課題: 'assignment', 試験: 'quiz', 目標: 'flag', 進捗: 'trending_up', 分析: 'analytics',
};

const SYMBOL_COLORS: (string | null)[] = [null, ...AVATAR_COLORS];
const PAGE = 240;

const GROUPS: { label: string; emojis: string }[] = [
  { label: 'よく使う', emojis: '📄📝📌📎📚📖📒📓📔📕📗📘📙🗂️📁📂🗃️🗒️📋📊📈📉🗓️📅⏰✅☑️✔️❗❓💡🔥⭐🌟✨🎯🚀' },
  { label: '顔', emojis: '😀😃😄😁😆😅🤣😂🙂😉😊😇🥰😍🤩😘😋😛🤔🤨😐😑😶🙄😏😴😌😎🤓🧐😕😟😮😲😳🥺😢😭😤😡🤯😱🥳🤗🤫🤭' },
  { label: '人と手', emojis: '👍👎👏🙌🤝🙏✌️🤞👌🤘👋✍️💪🧠👀👤👥🧑‍💻👩‍💻👨‍💻🧑‍🏫🧑‍🔬🧑‍🎨🧑‍🍳🧑‍🚀🦸' },
  { label: '自然', emojis: '🌱🌿🍀🌳🌲🌴🌵🌸🌼🌻🌹🍁🍂🌊🌈☀️🌙⭐☁️⛅🌧️❄️⚡🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🐔🐧🐦🦉🐝🦋🐢🐬🐳' },
  { label: '食べ物', emojis: '🍎🍊🍋🍌🍉🍇🍓🍒🍑🥝🍅🥑🥦🥕🌽🍞🧀🍳🍔🍟🍕🌮🍣🍱🍙🍜🍰🎂🍩🍪☕🍵🍺🍷' },
  { label: '活動・物', emojis: '⚽🏀🏈⚾🎾🏐🎮🎲🎨🎬🎤🎧🎹🎸🏆🥇🎁🎉🎈💻🖥️⌨️🖱️📱☎️📷🔍🔑🔒🔓🔧🔨⚙️🧪🧲💰💳✉️📦🏠🏢🏫🏥✈️🚗🚲⛰️🏖️' },
  { label: '記号', emojis: '❤️🧡💛💚💙💜🖤🤍💯🔴🟠🟡🟢🔵🟣⚫⚪🟥🟧🟨🟩🟦🟪⬛⬜🔶🔷➕➖✖️➗❌⭕🚫⚠️♻️🔁🔄▶️⏸️⏹️🆕🆗🆒' },
];

const split = (s: string) => [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(s)].map((x) => x.segment);

export function EmojiPicker({
  anchor,
  onPick,
  onRemove,
  onClose,
  symbols = true,
}: {
  anchor: HTMLElement;
  onPick: (emoji: string) => void;
  onRemove?: () => void;
  onClose: () => void;
  /** Google のアイコンのタブを出すか */
  symbols?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<'emoji' | 'symbol'>(() => {
    try {
      // 標準は Google のアイコン
      return symbols && localStorage.getItem('iconPickerTab') !== 'emoji' ? 'symbol' : 'emoji';
    } catch {
      return 'emoji';
    }
  });
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  const switchTab = (t: 'emoji' | 'symbol') => {
    setTab(t);
    try {
      localStorage.setItem('iconPickerTab', t);
    } catch {
      /* 保存できなくても動作には影響しない */
    }
  };

  const r = anchor.getBoundingClientRect();
  const all = GROUPS.flatMap((g) => split(g.emojis));
  return createPortal(
    <div
      ref={ref}
      className="emoji-picker"
      style={{ top: Math.max(8, Math.min(r.bottom + 6, window.innerHeight - 410)), left: Math.max(8, Math.min(r.left, window.innerWidth - 348)) }}
    >
      <div className="emoji-picker-head">
        {symbols && (
          <div className="picker-tabs">
            <button className={`picker-tab ${tab === 'emoji' ? 'active' : ''}`} onClick={() => switchTab('emoji')}>
              絵文字
            </button>
            <button className={`picker-tab ${tab === 'symbol' ? 'active' : ''}`} onClick={() => switchTab('symbol')}>
              アイコン
            </button>
          </div>
        )}
        <span className="grow" />
        {tab === 'emoji' && (
          <button className="btn btn-ghost btn-sm" onClick={() => onPick(all[Math.floor(Math.random() * all.length)]!)}>
            ランダム
          </button>
        )}
        {onRemove && (
          <button className="btn btn-ghost btn-sm" onClick={onRemove}>
            削除
          </button>
        )}
      </div>
      {tab === 'emoji' ? (
        <div className="emoji-picker-body">
          {GROUPS.map((g) => (
            <div key={g.label}>
              <div className="emoji-group-label">{g.label}</div>
              <div className="emoji-grid">
                {split(g.emojis).map((e, i) => (
                  <button key={i} className="emoji-btn" onClick={() => onPick(e)}>
                    {e}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <SymbolTab onPick={onPick} />
      )}
    </div>,
    document.body,
  );
}

function SymbolTab({ onPick }: { onPick: (icon: string) => void }) {
  const [names, setNames] = useState<string[] | null>(null);
  const [query, setQuery] = useState('');
  const [color, setColor] = useState<string | null>(() => {
    try {
      const c = localStorage.getItem('iconPickerColor');
      return c && /^#[0-9a-f]{6}$/i.test(c) ? c : null;
    } catch {
      return null;
    }
  });
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => {
    let alive = true;
    // 一覧（約 4,000 件）は使うときだけ読み込む
    void import('./symbolNames').then((m) => alive && setNames(m.SYMBOL_NAMES));
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => setLimit(PAGE), [query]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return POPULAR.split(' ');
    if (!names) return [];
    const words = q
      .split(/\s+/)
      .map((w) => (JA[w] ?? Object.entries(JA).find(([k]) => k.includes(w) || w.includes(k))?.[1] ?? w).replace(/[\s-]+/g, '_'));
    const hit = names.filter((n) => words.every((w) => n.includes(w)));
    // 完全一致 → 先頭一致 → それ以外の順
    const rank = (n: string) => (words.some((w) => n === w) ? 0 : words.some((w) => n.startsWith(w)) ? 1 : 2);
    return hit.sort((a, b) => rank(a) - rank(b) || a.length - b.length);
  }, [query, names]);

  const pickColor = (c: string | null) => {
    setColor(c);
    try {
      if (c) localStorage.setItem('iconPickerColor', c);
      else localStorage.removeItem('iconPickerColor');
    } catch {
      /* 保存できなくても動作には影響しない */
    }
  };

  return (
    <>
      <div className="symbol-tools">
        <input className="input" autoFocus placeholder="アイコンを検索（英語・日本語）" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="symbol-colors">
          {SYMBOL_COLORS.map((c) => (
            <button
              key={c ?? 'none'}
              className={`symbol-color ${color === c ? 'active' : ''}`}
              style={{ background: c ?? 'var(--text-muted)' }}
              title={c ? '色' : '標準の色'}
              aria-label={c ? `色 ${c}` : '標準の色'}
              onClick={() => pickColor(c)}
            />
          ))}
        </div>
      </div>
      <div className="emoji-picker-body">
        {!query.trim() && <div className="emoji-group-label">よく使う</div>}
        {query.trim() && !names && <div className="muted small symbol-empty">読み込み中…</div>}
        {query.trim() && names && results.length === 0 && <div className="muted small symbol-empty">見つかりませんでした</div>}
        <div className="emoji-grid">
          {results.slice(0, limit).map((n) => (
            <button key={n} className="emoji-btn" title={n} onClick={() => onPick(makeSymbol(n, color))}>
              <SymbolGlyph name={n} size={22} color={color ?? 'var(--text)'} />
            </button>
          ))}
        </div>
        {results.length > limit && (
          <button className="btn btn-ghost btn-sm symbol-more" onClick={() => setLimit((l) => l + PAGE)}>
            さらに表示（残り {results.length - limit} 件）
          </button>
        )}
      </div>
    </>
  );
}
