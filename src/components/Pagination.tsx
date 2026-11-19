/**
 * Pagination —— 交易明细表共用的分页器（上方 inline / 下方 bottom）
 *
 * 纯受控组件：page / pageSize 状态由父组件持有，两处实例共用同一份状态，
 * 点击任一侧都会同步更新另一侧。不复制 JSX。
 */
export interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  pageSize: 50 | 100 | 0;
  onPageChange: (next: number) => void;
  onPageSizeChange: (size: 50 | 100 | 0) => void;
  /** inline = 工具栏内靠右（无额外上下留白）；bottom = 表格下方 */
  variant?: 'inline' | 'bottom';
}

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
  variant = 'bottom',
}: PaginationProps) {
  return (
    <div className={`wr-pagination ${variant === 'inline' ? 'wr-pagination-inline' : ''}`}>
      <button
        type="button"
        className="wr-page-btn"
        disabled={page <= 1}
        onClick={() => onPageChange(Math.max(1, page - 1))}
      >
        上一页
      </button>
      <span className="wr-page-info">
        当前第 {page} / {totalPages} 页，共 {total} 条记录
      </span>
      <button
        type="button"
        className="wr-page-btn"
        disabled={page >= totalPages}
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
      >
        下一页
      </button>
      <label className="wr-page-size">
        每页
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value) as 50 | 100 | 0)}
        >
          <option value={50}>50条</option>
          <option value={100}>100条</option>
          <option value={0}>全部</option>
        </select>
      </label>
    </div>
  );
}
