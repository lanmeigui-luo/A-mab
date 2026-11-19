/**
 * record-filters.ts —— 交易明细工具栏筛选（纯函数，可离线验收）
 *
 * 三个条件叠加：股票代码/名称模糊匹配 + 战法 ID 精确匹配 + 单日日期精确匹配。
 * 空条件一律放行；调用方传入展示用日期（actionDate），确保「筛哪天就看哪天」。
 */

export interface ToolbarFilter {
  /** 代码或名称片段，大小写不敏感 */
  keyword: string;
  /** 战法 id，空串表示不限 */
  strategyId: string;
  /** YYYY-MM-DD，空串表示不限 */
  date: string;
}

export interface FilterableRow {
  code: string;
  name: string;
  strategyId: string;
  /** 表格第一列展示的日期（动作发生日） */
  date: string;
}

export function matchesToolbarFilters(r: FilterableRow, f: ToolbarFilter): boolean {
  const kw = (f.keyword || '').trim().toLowerCase();
  if (kw && !r.code.toLowerCase().includes(kw) && !r.name.toLowerCase().includes(kw)) return false;
  if (f.strategyId && r.strategyId !== f.strategyId) return false;
  if (f.date && r.date !== f.date) return false;
  return true;
}

export function filterByToolbar<T extends FilterableRow>(rows: T[], f: ToolbarFilter): T[] {
  return rows.filter((r) => matchesToolbarFilters(r, f));
}
