/**
 * useIntradayMonitor.ts —— 盘中 1 分钟级实时监控（方案 A：前端常驻）
 *
 * 设计要点（与用户拍板的决策点一致）：
 *  1. 挂载点：在 App 根调用，全局常驻，任意页面都生效，不依赖 winrate Tab 打开。
 *  2. 同根 bar 双边歧义：evaluateIntradayTrigger 复用 disambiguateIntraday，
 *     同一根 1min bar 双边触及 → 返回 null，不平仓，交由日K结算（simulateTrade）兜底，
 *     绝不伪造成交顺序（保留数据真实性）。
 *  3. 透明度：命中平仓的记录置 monitorClosed=true，详情页可识别「盘中实时监控平仓」。
 *
 * ── 盘中实时买入引擎（本轮新增）────────────────────────────────────────
 *  4. 买入监控：状态为「待买入」（status=open 且 buyPrice==null，沿用既有语义、不新增 pending）
 *     且 entryTargetDate === today 的记录，按 entryStyle 盘中判定：
 *       · instant：9:30 第一分钟按开盘价一次性判定（高开超限 / 一字板 / 低开 → 未成交）；
 *       · intraday_limit：盘中每分钟检查价格是否进入 [buyLow,buyHigh]，落入即模拟买入；
 *       · daily_only（隔夜持股）：完全不参与，只交日K结算。
 *  5. 状态流转：待买入 → 持仓中（盘中 bought）→ 未成交（软标记，14:50 闸门）。
 *     「未成交」绝不落成终态 status='invalid'：settleOpenRecords 只处理 open，标 invalid
 *     会永远无法翻案。软标记（status 仍 open）让晚间日K兜底有权复判，保证绝对不漏票。
 *  6. 防重：盘中买入写 monitorBought=true，simulateTrade 据此锁定买入价、只推进卖出，
 *     晚间日K兜底绝不二次买入 / 覆盖触发价。
 *  7. 严格 T+1：卖出判定双条件 canSellToday() 同时加在 getMonitable() 与 processCode() 两处，
 *     买入当日（today === buyDate）哪怕盘中触及止损也绝对禁止卖出。
 *  8. 限流（用户拍板）：/api/quote 一次批量粗筛（当日 high/low 极值做「本轮不可能有动作」的
 *     安全跳过）+ 按 code 去重串行 + 不新增后端端点；粗筛失败一律保守放行拉分钟线。
 *
 * 实时机制：
 *  - 60s 轮询（仅交易时段内），逐股票拉最近 ~60 根 1min，按时间顺序判定最早触发点。
 *  - 后台标签页时浏览器会节流/暂停定时器；回到前台（visibilitychange→visible）时触发
 *    「缺口回填」：用更长窗口（~240 根 1min ≈ 4 交易日）回放缺失的分钟 bar，按时间顺序补判。
 *  - 买入判定必须先 sliceDayBars(bars, today) 切片当日，避免缺口回填的跨日 bar 串日误判。
 *  - 用 per-code 游标（lastCursor）记录已处理到的最新 bar 时刻，避免重复判定同一根 bar。
 */

import { useEffect, useRef } from 'react';
import { useWinRateStore, getLiveRecords, type WinRateTradePatch } from './useWinRateStore';
import { fetchMinuteBars, toFullCode } from './useWinRateRecorder';
import { marketApi } from '../services/market';
import { isWithinTradingHours, RECORD_CUTOFF_MINS, isWeekday } from '../lib/tradingTime';
import { evaluateIntradayTrigger, buildIntradayClosePatch } from '../lib/intraday-trigger';
import {
  evaluateIntradayEntry,
  sliceDayBars,
  type MinuteBar,
  type EntryPlan,
} from '../lib/winrate-minute';
import { canSellToday, type WinRateRecord } from '../domain/winrate';
import type { Quote } from '../domain/types';

/** 轮询间隔（毫秒）：1 分钟 */
const POLL_INTERVAL_MS = 60_000;
/** 实时轮询窗口：最近 ~60 根 1min（约 1 交易日） */
const NORMAL_LIMIT = 60;
/** 缺口回填窗口：最多 ~240 根 1min（约 4 交易日） */
const GAP_FILL_LIMIT = 240;
/** /api/quote 单次上限（server/index.mjs slice(0, 200)） */
const QUOTE_BATCH = 200;

/** 本地日期 YYYY-MM-DD（避免 UTC 偏移吞日期） */
function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 行情代码规范化：去掉市场前缀、取末 6 位，保证与 WinRateRecord.code 对齐 */
function normCode(s: string): string {
  return String(s ?? '').replace(/^(sh|sz|bj)/i, '').slice(-6);
}

/**
 * 可被盘中监控【平仓】的记录：已买入 + 有止损/目标 + 严格 T+1 日期锁（双条件第一处）。
 * 买入当日（today === buyDate）盘中哪怕触及止损也绝对禁止卖出，必须在 T+1 日及以后。
 */
function getMonitable(today: string): WinRateRecord[] {
  return getLiveRecords().filter(
    (r) =>
      r.trade.status === 'open' &&
      r.trade.buyPrice != null &&
      (r.stop != null || r.target1 != null || r.target2 != null) &&
      canSellToday(r, today),
  );
}

/**
 * 可被盘中监控【买入】的记录（待买入）：
 *  - status=open 且 buyPrice==null（沿用既有「待买入」语义，不新增 pending 数据层状态）
 *  - intradayEntryResolved 未判定（bought / unfilled 都不再参与，天然幂等）
 *  - entryStyle 非 null / 非 daily_only（隔夜持股尾盘买入只交日K结算）
 *  - entryTargetDate === today：唯一允许盘中触发的买入日（用户拍板日期锁）
 *  历史旧记录无 entryStyle / entryTargetDate → 自动排除，零回归。
 */
function getPendingEntries(today: string): WinRateRecord[] {
  return getLiveRecords().filter(
    (r) =>
      r.trade.status === 'open' &&
      r.trade.buyPrice == null &&
      r.trade.intradayEntryResolved == null &&
      r.entryStyle != null &&
      r.entryStyle !== 'daily_only' &&
      r.entryTargetDate === today,
  );
}

interface CodeGroup {
  sell: WinRateRecord[];
  buy: WinRateRecord[];
}

/** 按 6 位 code 聚合，保证同只股票只拉一次分钟线 / 只占一次粗筛名额 */
function groupByCode(sell: WinRateRecord[], buy: WinRateRecord[]): Map<string, CodeGroup> {
  const m = new Map<string, CodeGroup>();
  const ensure = (code: string): CodeGroup => {
    let g = m.get(code);
    if (!g) {
      g = { sell: [], buy: [] };
      m.set(code, g);
    }
    return g;
  };
  for (const r of sell) ensure(r.code).sell.push(r);
  for (const r of buy) ensure(r.code).buy.push(r);
  return m;
}

interface CoarseResult {
  /** 本轮需要拉 1min bars 的 code（粗筛后幸存者） */
  fetchCodes: Set<string>;
  /** 用 quote 即可安全判定「9:30 未成交」的 instant 记录（开盘价固定不变，不拉分钟线） */
  directUnfilled: WinRateRecord[];
}

/**
 * /api/quote 粗筛（用户拍板限流方案：不新增后端端点、按 code 去重串行）。
 * Quote 带【当日累计 high/low 极值】，用于「截至当前本轮不可能有动作」的安全跳过：
 *  - 卖出：全天未触及任何一边 → 本轮拉分钟线也不会有触发，跳过；下一轮 quote 更新后若触及再拉（不漏票）。
 *  - intraday_limit 买入：截至当前全天极值未与买入区间有交集 → 本轮跳过。
 *  - instant 买入：q.open 是固定开盘价，越界 / 一字板可【直接判未成交】（终态，不拉分钟线）。
 * 字段缺失（null）一律保守放行，绝不用 0 冒充行情；粗筛失败（接口异常）→ quotes 为空 → 全部放行。
 * 注意：粗筛是【每轮动态】的，不是一次性排除——high 单调升 / low 单调降，触及一旦发生 quote 极值
 * 就会反映，下一轮自然重新纳入，故不会漏票。
 */
function coarseFilter(groups: Map<string, CodeGroup>, quotes: Map<string, Quote>): CoarseResult {
  const fetchCodes = new Set<string>();
  const directUnfilled: WinRateRecord[] = [];
  for (const [code, g] of groups) {
    const q = quotes.get(code);
    let needFetch = false;

    // 卖出组：只要有一条可能已触发，就需要分钟线定序
    for (const r of g.sell) {
      const untouched =
        q != null &&
        q.low != null &&
        q.high != null &&
        (r.stop == null || q.low > r.stop) &&
        (r.target1 == null || q.high < r.target1) &&
        (r.target2 == null || q.high < r.target2);
      if (!untouched) {
        needFetch = true;
        break;
      }
    }

    for (const r of g.buy) {
      const style = r.entryStyle ?? 'daily_only';
      if (style === 'instant' && q != null && q.open != null) {
        const oneWordLimit =
          q.limitUpPrice != null &&
          q.high != null &&
          q.low != null &&
          q.open >= q.limitUpPrice &&
          q.high === q.low;
        const overHigh = r.buyHigh != null && q.open > r.buyHigh;
        const underLow = r.buyLow != null && q.open < r.buyLow;
        if (oneWordLimit || overHigh || underLow) {
          directUnfilled.push(r); // 开盘价固定，9:30 判定为终态，无需分钟线
        } else {
          needFetch = true; // 开盘价在区间内 → 拉真实 9:30 bar 做一字板 / 成交确认
        }
        continue;
      }
      if (style === 'intraday_limit' && q != null && q.high != null && q.low != null) {
        const noOverlap =
          (r.buyHigh != null && q.low > r.buyHigh) || // 全天最低都高于买高
          (r.buyLow != null && q.high < r.buyLow); // 全天最高都低于买低
        if (!noOverlap) needFetch = true;
        continue;
      }
      // 无 quote / daily_only / 未知风格 → 保守拉分钟线
      needFetch = true;
    }

    if (needFetch) fetchCodes.add(code);
  }
  return { fetchCodes, directUnfilled };
}

/**
 * 处理单只股票：拉分钟线 → 切片当日 bars → 逐记录判定买入 / 卖出。
 * 游标（lastCursor）只用于卖出端避免重复判定；买入端用【全部当日 bars】覆盖缺口回填
 * （买入一旦成功即退出待买入集合，天然幂等）。
 */
function processCode(
  code: string,
  group: CodeGroup,
  bars: MinuteBar[],
  today: string,
  lastCursor: Map<string, string>,
  updateTrade: (id: string, patch: WinRateTradePatch) => { ok: boolean; reason?: string },
  quotes: Map<string, Quote>,
  handledBuyIds: Set<string>,
): void {
  if (!bars.length) return;
  const cursor = lastCursor.get(code);
  const newBars = cursor ? bars.filter((b) => b.date > cursor) : bars;
  const dayBars = sliceDayBars(bars, today); // 买入判定必须切片当日，避免缺口回填串日
  const q = quotes.get(code);

  // ── 卖出端 ──
  if (newBars.length > 0) {
    for (const r of group.sell) {
      // 严格 T+1 双条件锁（第二处，用户明确要求与 getMonitable() 同时加）
      if (!canSellToday(r, today)) continue;
      const trigger = evaluateIntradayTrigger(newBars, {
        stop: r.stop,
        target1: r.target1,
        target2: r.target2,
      });
      if (trigger) updateTrade(r.id, buildIntradayClosePatch(r, trigger));
    }
  }

  // ── 买入端 ──
  if (dayBars.length > 0) {
    for (const r of group.buy) {
      if (handledBuyIds.has(r.id)) continue; // 已由 quote 粗筛直接判未成交
      const plan: EntryPlan = {
        buyLow: r.buyLow,
        buyHigh: r.buyHigh,
        limitUpPrice: q?.limitUpPrice ?? null,
      };
      const dec = evaluateIntradayEntry(dayBars, plan, r.entryStyle);
      if (dec.kind === 'bought') {
        // 盘中实时成交 → 转「持仓中」，并打防重标记：晚间日K兜底据此锁定买入、绝不二次买入
        updateTrade(r.id, {
          buyDate: today,
          buyPrice: dec.buyPrice,
          status: 'open',
          monitorBought: true,
          entrySource: 'intraday',
          intradayEntryResolved: 'bought',
        });
      } else if (dec.kind === 'unfilled') {
        // instant 9:30 一次性判定未成交 → 软标记（status 仍 open），晚间日K兜底有权复判
        updateTrade(r.id, {
          intradayEntryResolved: 'unfilled',
          entrySource: 'intraday',
        });
      }
      // skip → 保持「待买入」，下一轮继续监控
    }
  }

  lastCursor.set(code, bars[bars.length - 1].date);
}

export function useIntradayMonitor(): void {
  const { updateTrade } = useWinRateStore();
  const cursorRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let alive = true;

    /** 一轮扫描：非交易时段直接跳过；/api/quote 粗筛 → 按 code 去重串行拉分钟线 → 判定 */
    const sweep = async (limit: number): Promise<void> => {
      if (!isWithinTradingHours()) return;
      const today = localDate();
      const sellRecs = getMonitable(today);
      const buyRecs = getPendingEntries(today);
      if (sellRecs.length === 0 && buyRecs.length === 0) return;

      const groups = groupByCode(sellRecs, buyRecs);

      // 1) /api/quote 批量粗筛（一次请求；失败静默放行 → quotes 为空 → 全部拉分钟线）
      let quotes = new Map<string, Quote>();
      const codes = [...groups.keys()].slice(0, QUOTE_BATCH);
      if (codes.length) {
        try {
          const res = await marketApi.quotes(codes.map(toFullCode));
          for (const q of res.rows ?? []) quotes.set(normCode(q.code || q.fullCode), q);
        } catch {
          quotes = new Map(); // 粗筛不可用 → 保守放行，绝不因限流漏判
        }
      }

      const { fetchCodes, directUnfilled } = coarseFilter(groups, quotes);
      const handledBuyIds = new Set<string>();
      for (const r of directUnfilled) {
        handledBuyIds.add(r.id);
        updateTrade(r.id, {
          intradayEntryResolved: 'unfilled',
          entrySource: 'intraday',
        });
      }

      // 2) 按 code 去重、串行拉 1min bars（不新增后端端点；粗筛已砍掉大部分 code）
      for (const [code, group] of groups) {
        if (!alive) return;
        if (!fetchCodes.has(code)) continue;
        const bars = await fetchMinuteBars(code, 1, limit).catch(() => [] as MinuteBar[]);
        processCode(code, group, bars, today, cursorRef.current, updateTrade, quotes, handledBuyIds);
      }

      // 3) 14:50 闸门：当天仍未触发买入的待买入记录 → 打软标记（status 保持 open），
      //    晚间日K兜底有权翻案复判，保证「绝对不漏票」。
      const now = new Date();
      if (isWeekday(now) && now.getHours() * 60 + now.getMinutes() >= RECORD_CUTOFF_MINS) {
        for (const r of getPendingEntries(today)) {
          updateTrade(r.id, {
            intradayEntryResolved: 'unfilled',
            entrySource: 'intraday',
          });
        }
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
