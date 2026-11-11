/**
 * intraday-trigger.ts —— 盘中实时监控的「触发判定 + 平仓补丁构建」（纯函数层）
 *
 * 设计原则：纯函数、无副作用、不读 localStorage / 不调 API / 不碰 React。
 * 复用 winrate-minute.ts 的 disambiguateIntraday（盘中定序 + 同根 bar 双边歧义返回 unresolved）。
 *
 * 与日K结算的差异（透明度优先、保留数据真实性）：
 *  - 同根 bar 双边歧义（止损与某目标落在同一根 1min bar）→ 返回 null，不平仓，
 *    交由日K结算（simulateTrade）兜底，不强行判定，避免伪造成交顺序。
 *  - 命中即按「触发阈值价」平仓（stop/target1/target2），与日K引擎口径一致；
 *    holdDays 用自然日近似（无交易日历），daily-K 结算不会再改已平仓记录，属已知的轻量近似。
 */

import type { WinRateRecord, SellReason } from '../domain/winrate';
import type { WinRateTradePatch } from '../hooks/useWinRateStore';
import { disambiguateIntraday, tradingDaysBetween, type MinuteBar } from './winrate-minute';

/** 一笔记录的买卖计划（止损 / 目标一 / 目标二） */
export interface IntradayPlan {
  stop: number | null;
  target1: number | null;
  target2: number | null;
}

/** 触发结果：具体卖出原因 + 触发价 + 触发 bar 的时刻 */
export interface IntradayTrigger {
  reason: SellReason;
  sellPrice: number;
  /** 触发 bar 的日期时间，如 "2026-11-06 14:32:00" */
  barDate: string;
}

/**
 * 评估一批分钟 bar 是否触发盘中平仓。
 *  - 空计划（止损/目标全空）→ null（无可判定条件）。
 *  - 同根 bar 双边歧义 → disambiguateIntraday 返回 unresolved → null（交由日K兜底）。
 *  - 否则返回最早触发（优先级 止损→目标二→目标一）。
 */
export function evaluateIntradayTrigger(
  bars: MinuteBar[],
  plan: IntradayPlan,
): IntradayTrigger | null {
  if (!bars.length) return null;
  if (plan.stop == null && plan.target1 == null && plan.target2 == null) return null;

  const res = disambiguateIntraday({
    bars,
    stop: plan.stop,
    target1: plan.target1,
    target2: plan.target2,
  });
  if (!res.resolved || !res.reason || res.sellPrice == null || res.idx == null) return null;

  const bar = bars[res.idx];
  return { reason: res.reason, sellPrice: res.sellPrice, barDate: bar.date };
}

/** 保留两位小数（与 sim 口径一致） */
function r2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * 由触发结果构建平仓补丁：落 sellReason / sellPrice / sellDate / returnPct / holdDays /
 * status='closed' / monitorClosed=true（透明度标记），并保留原 anomalies。
 * 注意：holdDays 用自然日近似（tradingDaysBetween 无 refTradingDates 时按自然日），
 * 属盘中实时监控的已知轻量近似——已平仓记录不被日K结算再次改写。
 */
export function buildIntradayClosePatch(
  record: WinRateRecord,
  trigger: IntradayTrigger,
): WinRateTradePatch {
  const buyPrice = record.trade.buyPrice;
  const sellPrice = trigger.sellPrice;
  const returnPct =
    buyPrice != null && sellPrice != null ? r2(((sellPrice - buyPrice) / buyPrice) * 100) : null;
  const sellDate = trigger.barDate.length >= 10 ? trigger.barDate.slice(0, 10) : trigger.barDate;
  const buyDate = record.trade.buyDate;
  const holdDays = buyDate != null ? tradingDaysBetween(buyDate, sellDate) : null;

  return {
    sellReason: trigger.reason,
    sellPrice,
    sellDate,
    returnPct,
    holdDays,
    status: 'closed',
    monitorClosed: true,
    anomalies: record.trade.anomalies,
  };
}
