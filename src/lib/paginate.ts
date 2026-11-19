/**
 * paginate.ts —— 纯前端分页切片（可离线验收）
 *
 * 输入必须是「已筛选 + 已排序」的数组（交易明细按日期倒序），这里只做切片，不改数据源。
 * pageSize <= 0 表示「全部」；请求页码越界时自动 clamp 到 [1, totalPages]。
 */

export interface PageSlice<T> {
  rows: T[];
  /** 实际生效页码（已 clamp） */
  page: number;
  totalPages: number;
  total: number;
}

export function paginate<T>(all: T[], requestedPage: number, pageSize: number): PageSlice<T> {
  const list = Array.isArray(all) ? all : [];
  const total = list.length;
  if (pageSize <= 0) {
    return { rows: list, page: 1, totalPages: 1, total };
  }
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(1, Math.min(Math.trunc(requestedPage) || 1, totalPages));
  const start = (page - 1) * pageSize;
  return { rows: list.slice(start, start + pageSize), page, totalPages, total };
}
