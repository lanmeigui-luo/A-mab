/**
 * useIntradayMonitor.ts —— 盘中 1 分钟级实时监控（方案 A：前端常驻）
 *
 * 设计要点（与用户拍板的 3 个决策点一致）：
 *  1. 挂载点：在 App 根调用，全局常驻，任意页面都生效，不依赖 winrate Tab 打开。
 *  2. 同根 bar 双边歧义：evaluateIntradayTrigger 复用 disambiguateIntraday，
 *     同一根 1min bar 双边触及 → 返回 null，不平仓，交由日K结算（simulateTrade）兜底，
 *     绝不伪造成交顺序（保留数据真实性）。
 *  3. 透明度：命中平仓的记录置 monitorClosed=true，详情页可识别「盘中实时监控平仓」。
 *
 * 实时机制：
 *  - 60s 轮询（仅交易时段内），逐股票拉最近 ~60 根 1min，按时间顺序判定最早触发点。
 *  - 后台标签页时浏览器会节流/暂停定时器；回到前台（visibilitychange→visible）时触发
 *    「缺口回填」：用更长窗口（~240 根 1min ≈ 4 交易日）回放缺失的分钟 bar，按时间顺序补判。
 *  - 用 per-code 游标（lastCursor）记录已处理到的最新 bar 时刻，避免重复判定同一根 bar
 *    （记录一旦平仓即退出 open 集合，天然幂等）。
 */

import { useEffect, useRef } from 'react';
import { useWinRateStore, getLiveRecords, type WinRateTradePatch } from './useWinRateStore';
import { fetchMinuteBars } from './useWinRateRecorder';
import { isWithinTradingHours } from '../lib/tradingTime';
import { evaluateIntradayTrigger, buildIntradayClosePatch } from '../lib/intraday-trigger';
import type { WinRateRecord } from '../domain/winrate';
import type { MinuteBar } from '../lib/winrate-minute';

/** 轮询间隔（毫秒）：1 分钟 */
const POLL_INTERVAL_MS = 60_000;
/** 实时轮询窗口：最近 ~60 根 1min（约 1 交易日） */
const NORMAL_LIMIT = 60;
/** 缺口回填窗口：最多 ~240 根 1min（约 4 交易日） */
const GAP_FILL_LIMIT = 240;

/** 取当前可被盘中监控平仓的记录：已买入（buyPrice 非空）且有止损/目标条件 */
function getMonitable(): WinRateRecord[] {
  return getLiveRecords().filter(
    (r) =>
      r.trade.status === 'open' &&
      r.trade.buyPrice != null &&
      (r.stop != null || r.target1 != null || r.target2 != null),
  );
}

/**
 * 处理单只股票：拉分钟线 → 取游标之后的新 bar → 逐记录判定 → 命中即平仓。
 * 游标（lastCursor）记录该股票已处理到的最新 bar 时刻，保证幂等且不错过缺口。
 */
function processCode(
  code: string,
  group: WinRateRecord[],
  bars: MinuteBar[],
  lastCursor: Map<string, string>,
  updateTrade: (id: string, patch: WinRateTradePatch) => { ok: boolean; reason?: string },
): void {
  if (!bars.length) return;
  const cursor = lastCursor.get(code);
  const newBars = cursor ? bars.filter((b) => b.date > cursor) : bars;
  if (newBars.length > 0) {
    for (const r of group) {
      const trigger = evaluateIntradayTrigger(newBars, {
        stop: r.stop,
        target1: r.target1,
        target2: r.target2,
      });
      if (trigger) updateTrade(r.id, buildIntradayClosePatch(r, trigger));
    }
  }
  lastCursor.set(code, bars[bars.length - 1].date);
}

export function useIntradayMonitor(): void {
  const { updateTrade } = useWinRateStore();
  const cursorRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let alive = true;

    /** 一轮扫描：非交易时段直接跳过；按 code 聚合，每只股票只拉一次分钟线 */
    const sweep = async (limit: number): Promise<void> => {
      if (!isWithinTradingHours()) return;
      const recs = getMonitable();
      if (recs.length === 0) return;

      const byCode = new Map<string, WinRateRecord[]>();
      for (const r of recs) {
        if (!byCode.has(r.code)) byCode.set(r.code, []);
        byCode.get(r.code)!.push(r);
      }

      for (const [code, group] of byCode) {
        if (!alive) return;
        const bars = await fetchMinuteBars(code, 1, limit).catch(() => [] as MinuteBar[]);
        processCode(code, group, bars, cursorRef.current, updateTrade);
      }
    };

    /** 回到前台：缺口回填，用更长窗口回放缺失的分钟 bar */
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      void sweep(GAP_FILL_LIMIT);
    };

    const timer = window.setInterval(() => void sweep(NORMAL_LIMIT), POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [updateTrade]);
}
