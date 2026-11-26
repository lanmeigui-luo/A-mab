/**
 * stock-index.ts —— 本地股票字典的运行时载体
 *
 * 数据文件 src/assets/stock-index.json 由 scripts/build-stock-index.mjs 生成
 * （新浪全市场 5580 只，2026-11-26 实测）。这里是唯一读取入口：
 *   - STOCK_ROWS：匹配用全量行
 *   - stockOf(code)：按代码反查，供顶部过滤复用拼音字段
 *
 * 不在运行时做拼音转换（字典已预生成），因此不引入任何拼音依赖。
 */
import raw from '../assets/stock-index.json';
import type { Market, StockRow } from './stock-search';

type RawRow = [string, string, string, string, string];

interface RawIndex {
  builtAt: string;
  source: string;
  count: number;
  rows: RawRow[];
}

const data = raw as unknown as RawIndex;

/** 字典构建时间（ISO），用于排查「搜不到新股」这类问题 */
export const STOCK_INDEX_BUILT_AT = data.builtAt;

export const STOCK_ROWS: StockRow[] = data.rows.map(([code, name, market, py, ini]) => ({
  code,
  name,
  market: market as Market,
  py,
  ini,
}));

const BY_CODE = new Map(STOCK_ROWS.map((r) => [r.code, r] as const));

export function stockOf(code: string): StockRow | undefined {
  return BY_CODE.get(code);
}
