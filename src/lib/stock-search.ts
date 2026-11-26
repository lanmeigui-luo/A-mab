/**
 * stock-search.ts —— 本地股票字典的匹配打分（纯函数、零依赖、无 @/ 别名）
 *
 * 四路匹配，命中即算分，取最高档：
 *   代码精确 1000 / 名称全等 1000 > 名称前缀 940 > 首字母全等 960 > 首字母前缀 920- > 全拼全等 930 >
 *   全拼前缀 900- > 名称子串 860 > 首字母子串 760 > 全拼子串 700 > 代码子串 650
 * 排序：分数降序 → 名称短优先 → 代码升序（保证同一输入结果确定）
 *
 * 之所以「名称/拼音都要过 norm()」：字典里存在「万 科Ａ」这类带空格与全角字符的名称。
 */

export type Market = 'sh' | 'sz' | 'bj';
export type MatchKind = 'code' | 'name' | 'ini' | 'py';

export interface StockRow {
  code: string;
  name: string;
  market: Market;
  /** 全拼，小写无音调 */
  py: string;
  /** 首字母，小写 */
  ini: string;
}

export interface StockHit extends StockRow {
  score: number;
  kind: MatchKind;
}

/** 去空白（含全角空格）+ 小写；全角字母转半角 */
export function normalizeKey(input: string): string {
  return String(input ?? '')
    .replace(/\s+/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

export function searchStocks(rows: StockRow[], query: string, limit = 10): StockHit[] {
  const q = normalizeKey(query);
  if (!q || limit <= 0) return [];

  const isNumeric = /^\d+$/.test(q);
  const out: StockHit[] = [];

  for (const row of rows) {
    let best = 0;
    let kind: MatchKind = 'name';
    const consider = (score: number, k: MatchKind) => {
      if (score > best) {
        best = score;
        kind = k;
      }
    };

    if (isNumeric) {
      if (row.code === q) consider(1000, 'code');
      else if (row.code.startsWith(q)) consider(900 - (6 - q.length), 'code');
      else if (q.length >= 3 && row.code.includes(q)) consider(650, 'code');
    } else {
      const nm = normalizeKey(row.name);
      if (nm === q) consider(1000, 'name');
      else if (nm.startsWith(q)) consider(940, 'name');
      else if (nm.includes(q)) consider(860, 'name');

      if (row.ini === q) consider(960, 'ini');
      else if (row.ini.startsWith(q)) consider(920 - Math.min(20, row.ini.length - q.length), 'ini');
      else if (q.length >= 2 && row.ini.includes(q)) consider(760, 'ini');

      if (row.py === q) consider(930, 'py');
      else if (row.py.startsWith(q)) consider(900 - Math.min(30, row.py.length - q.length), 'py');
      else if (q.length >= 3 && row.py.includes(q)) consider(700, 'py');
    }

    if (best > 0) out.push({ ...row, score: best, kind });
  }

  out.sort((a, b) => b.score - a.score || a.name.length - b.name.length || (a.code < b.code ? -1 : 1));
  return out.slice(0, limit);
}
