/**
 * 本の情報を ISBN から調べる（読書記録で使う）。
 * openBD・国立国会図書館（NDL サーチ）・Google Books に問い合わせ、タイトル・著者・出版社・ページ数・定価・表紙を返す。
 */
import { Hono } from 'hono';
import { cfg } from '../config.ts';
import { requireAuth, type AppEnv } from '../session.ts';
import { fail, rateLimit } from '../util.ts';

export const booksRoutes = new Hono<AppEnv>();
booksRoutes.use('*', requireAuth);

/** ISBN を 13 桁にそろえる（10 桁・ハイフン付きも受け付ける）。正しくなければ null */
export function normalizeIsbn(raw: string): string | null {
  const s = raw.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (s.length === 13) {
    if (!/^97[89]\d{10}$/.test(s)) return null;
    const sum = s.slice(0, 12).split('').reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
    return (10 - (sum % 10)) % 10 === Number(s[12]) ? s : null;
  }
  if (s.length === 10) {
    const sum = s.split('').reduce((a, d, i) => a + (d === 'X' ? 10 : Number(d)) * (10 - i), 0);
    if (sum % 11 !== 0) return null;
    const core = '978' + s.slice(0, 9);
    const sum13 = core.split('').reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
    return core + ((10 - (sum13 % 10)) % 10);
  }
  return null;
}

type Book = { isbn: string; title: string; authors: string[]; publisher: string | null; published: string | null; pages: number | null; price: number | null; cover: string | null; source: string; /** 日本十進分類法の番号（例：913.6） */ ndc: string | null };

/** 「夏目, 漱石, 1867-1916」→「夏目漱石」、「Smith, John」→「John Smith」 */
function personName(raw: string) {
  const parts = raw.split(/\s*,\s*/).filter((p) => p && !/^\d{3,4}-?(\d{3,4})?$/.test(p) && !/^(著|編|訳|作|文|絵)$/.test(p));
  if (parts.length < 2) return (parts[0] ?? raw).replace(/\s*(著|編|訳)$/, '').trim();
  return /[\u3000-\u9fff]/.test(parts.join('')) ? parts.join('') : [...parts.slice(1), parts[0]].join(' ');
}

const UA = { 'User-Agent': 'keepnote/1.0 (self-hosted notes; book lookup)' };

async function fromGoogle(isbn: string): Promise<Partial<Book> | null> {
  // 鍵がないと、Google 側の回数の上限ですぐ使えなくなる
  const key = cfg.GOOGLE_BOOKS_API_KEY ? `&key=${encodeURIComponent(cfg.GOOGLE_BOOKS_API_KEY)}` : '';
  const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1${key}`, { headers: UA });
  if (!res.ok) return null;
  const data = (await res.json()) as { items?: { volumeInfo?: Record<string, any> }[] };
  const v = data.items?.[0]?.volumeInfo;
  if (!v?.title) return null;
  const img: string | undefined = v.imageLinks?.medium ?? v.imageLinks?.small ?? v.imageLinks?.thumbnail ?? v.imageLinks?.smallThumbnail;
  return {
    title: [v.title, v.subtitle].filter(Boolean).join(' '),
    authors: Array.isArray(v.authors) ? v.authors : [],
    publisher: v.publisher ?? null,
    published: v.publishedDate ?? null,
    pages: typeof v.pageCount === 'number' && v.pageCount > 0 ? v.pageCount : null,
    cover: img ? img.replace(/^http:/, 'https:').replace('&edge=curl', '') : null,
    price: null,
  };
}

async function fromOpenBd(isbn: string): Promise<Partial<Book> | null> {
  const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${isbn}`, { headers: UA });
  if (!res.ok) return null;
  const d = ((await res.json()) as any[])?.[0];
  if (!d?.summary?.title) return null;
  const s = d.summary;
  const price = d.onix?.ProductSupply?.SupplyDetail?.Price?.find?.((p: any) => p.CurrencyCode === 'JPY')?.PriceAmount;
  const extent = (d.onix?.DescriptiveDetail?.Extent ?? []).find?.((e: any) => e.ExtentUnit === '03')?.ExtentValue;
  return {
    title: s.title,
    authors: s.author ? String(s.author).split(/\s+|／|\//).map(personName).filter(Boolean) : [],
    publisher: s.publisher || null,
    published: s.pubdate || null,
    pages: extent ? Number(extent) || null : null,
    price: price ? Number(price) || null : null,
    cover: s.cover || null,
  };
}

const xmlText = (xml: string, tag: string) => {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? m[1]!.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim() : null;
};

async function fromNdl(isbn: string): Promise<Partial<Book> | null> {
  const res = await fetch(`https://ndlsearch.ndl.go.jp/api/opensearch?isbn=${isbn}&cnt=1`, { headers: UA });
  if (!res.ok) return null;
  const xml = await res.text();
  const item = /<item>([\s\S]*?)<\/item>/.exec(xml)?.[1];
  if (!item) return null;
  const title = xmlText(item, 'dc:title') ?? xmlText(item, 'title');
  if (!title) return null;
  const creators = [...item.matchAll(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/g)].map((m) => personName(m[1]!.trim()));
  const price = xmlText(item, 'dcndl:price');
  // 日本十進分類法（新しい版を優先）
  const ndc = ['NDC10', 'NDC9', 'NDC8', 'NDC'].map((t) => new RegExp(`<dc:subject[^>]*dcndl:${t}"[^>]*>([\\d.]+)</dc:subject>`).exec(item)?.[1]).find(Boolean) ?? null;
  const extent = xmlText(item, 'dc:extent');
  return {
    title,
    authors: creators,
    publisher: xmlText(item, 'dc:publisher'),
    published: xmlText(item, 'dcterms:issued') ?? xmlText(item, 'dc:date'),
    pages: extent && /(\d+)\s*p/.test(extent) ? Number(/(\d+)\s*p/.exec(extent)![1]) : null,
    price: price && /\d/.test(price) ? Number(price.replace(/[^\d]/g, '')) || null : null,
    ndc,
  };
}

booksRoutes.get('/lookup', async (c) => {
  await rateLimit(c, 'books');
  const isbn = normalizeIsbn(c.req.query('isbn') ?? '');
  if (!isbn) fail(400, 'ISBN の番号が正しくありません（13 桁または 10 桁の数字）');
  const [o, n, g] = await Promise.all([fromOpenBd(isbn).catch(() => null), fromNdl(isbn).catch(() => null), fromGoogle(isbn).catch(() => null)]);
  if (!o && !n && !g) fail(404, 'この ISBN の本が見つかりませんでした');
  // 日本の本は openBD・国会図書館のほうが正確なことが多いので、そちらを優先する
  const pick = <K extends keyof Book>(k: K) => (o?.[k] ?? n?.[k] ?? g?.[k] ?? null) as Book[K] | null;
  const book: Book = {
    isbn,
    title: pick('title') ?? '',
    authors: o?.authors?.length ? o.authors : n?.authors?.length ? n.authors : (g?.authors ?? []),
    publisher: pick('publisher'),
    published: pick('published'),
    pages: pick('pages'),
    price: pick('price'),
    cover: o?.cover || g?.cover || null,
    source: [o && 'openBD', n && '国立国会図書館', g && 'Google Books'].filter(Boolean).join('・'),
    ndc: n?.ndc ?? null,
  };
  return c.json({ book });
});
