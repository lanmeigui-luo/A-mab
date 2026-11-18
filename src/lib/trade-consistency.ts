/**
 * trade-consistency.ts —— 已平仓交易状态一致性（纯函数）
 *
 * 事故背景（2026-11-18）：盘中监控把「未成交」写成软标记 intradayEntryResolved='unfilled'，
 * 晚间日K兜底翻案买入并平仓时，simulateTrade 已把这个标记清成 null，但 settleOpenRecords
 * 的写回 patch 漏了该字段 → localStorage 里 status/sellPrice 是「已平仓」，
 * 旧软标记却残留；表格只看软标记不检查 status → 显示「未成交（待复核）」的缝合怪数据。
 *
 * 本模块给出唯一不变量：有 sellDate + sellPrice ⇒ 必须 status='closed'，且不得残留任何未成交标记。
 */

import type { TradeRecord } from '../domain/winrate';

/** 是否具备「已卖出」的完整证据 */
export function isClosedWithSell(trade: TradeRecord): boolean {
  return trade.sellDate != null && trade.sellPrice != null && trade.status === 'closed';
}

/** 是否仍应展示「未成交（待复核）」：只有尚未平仓的软标记才有复核意义 */
export function shouldShowIntradayUnfilled(trade: TradeRecord): boolean {
  return trade.intradayEntryResolved === 'unfilled' && trade.status !== 'closed';
}

/**
 * 落盘 / 加载前归一化：一旦有卖出价 + 卖出日，强制 closed 并清空所有未成交标记。
 * - intradayEntryResolved → null（软标记使命结束）
 * - anomalies 里的 intraday_unfilled 一并清除（未成交结论已被翻案）
 * 无卖出证据或本来就是其它状态时原样返回（零回归）。
 */
export function normalizeClosedTrade(trade: TradeRecord): TradeRecord {
  if (trade.sellDate == null || trade.sellPrice == null) return trade;
  const anomalies = (trade.anomalies || []).filter((a) => a !== 'intraday_unfilled');
  if (
    trade.status === 'closed' &&
    trade.intradayEntryResolved == null &&
    anomalies.length === (trade.anomalies || []).length
  ) {
    return trade;
  }
  return {
    ...trade,
    status: 'closed',
    intradayEntryResolved: null,
    anomalies,
  };
}
