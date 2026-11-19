/**
 * prev-close.ts —— 昨收基准价校验与选取（纯函数，可离线验收）
 *
 * 事故背景（2026-11-19）：冰山冷热 sz000530 跌停（-9.99%），详情页却显示 0.00%
 * 且分时线全灰。根因是详情页复用了自选股轮询的旧 quote（盘前快照 prevClose === price）。
 * 后端 /api/quote 本身正确（price 11.17 / prevClose 12.41 / -9.99%）。
 *
 * 口径：日K倒数第二根（不复权）最可靠 > 实时 quote.prevClose > 无基准价。
 * 绝不用「当前价」或「开盘价」当昨收，绝不在缺基准时算出 0.00%。
 */

export interface PrevChange {
  change: number;
  changePct: number;
}

/** 是否是可信的昨收价（必须为正、有限；允许平盘 prev === price，由调用方按来源优先级取舍） */
export function isUsablePrevClose(prev: number | null | undefined): prev is number {
  return typeof prev === 'number' && Number.isFinite(prev) && prev > 0;
}

/** 按来源优先级选昨收：第一个参数优先级最高（调用方传日K倒数第二根） */
export function resolvePrevClose(...candidates: (number | null | undefined)[]): number | null {
  for (const c of candidates) {
    if (isUsablePrevClose(c)) return c;
  }
  return null;
}

/** 基于选定基准重算涨跌额与涨跌幅；无基准返回 null（UI 显示「无基准价」，不显示 0.00%） */
export function calcPrevChange(price: number | null | undefined, prev: number | null | undefined): PrevChange | null {
  if (!isUsablePrevClose(prev) || typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  const change = Math.round((price - prev) * 100) / 100;
  const changePct = Math.round(((price - prev) / prev) * 10000) / 100;
  return { change, changePct };
}

/** 分时数据里第一根有效价（昨收彻底缺失时用于纵轴范围，但不得据此算涨跌幅） */
export function firstValidPrice(prices: (number | null)[]): number | null {
  for (const p of prices) if (typeof p === 'number' && Number.isFinite(p) && p > 0) return p;
  return null;
}
