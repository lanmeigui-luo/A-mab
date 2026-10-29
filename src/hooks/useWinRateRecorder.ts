/**
 * useWinRateRecorder.ts —— P2b：战法胜率「记录 / 结算 / 补记录」React hook
 *
 * 数据来源：marketApi.screen（真实选股） / marketApi.kline（真实日 K）。
 * 不写 UI、不接 App.tsx、不碰 StrategyScreen/StockDetail/DataBackup。
 * 本次为 P2b 唯一新增文件；并按 P2b 授权扩展 P1 的 winrate.ts（加 recordedAt / priceSource）
 * 与 winrate-config.ts（加 DEFAULT_RECORD_CUTOFF）。
 *
 * ───────────────────────────────────────────────────────────────────────
 * 探查结论（实现依据）：
 *  1. ScreenHit.tradePlan 是「命中主战法（最低风险优先）」的单份计划，非 per-strategy。
 *     → 记录时对每个 enabled 战法单独调用 screen({ ids: [strategyId] })，使 tradePlan/score 唯一归属该战法。
 *  2. hit.score 为 ScoreResult 主战法总分；per-strategy 调用后 score.total 即「该战法当日确定性评分」。
 *  3. hit.strategies[].id 与 winrate-config.strategyId 同源（STRATEGY_DEFS），可直接对齐。
 *  4. 记录日收盘价取 hit.price（screen 已带；盘中为实时快照），无需另调 kline。
 *  5. 停牌/涨停判定（记录日不可买入）：hit.limitUp.isLimitUp === true 或 hit.price == null
 *     → status='invalid' + anomaly='unbuyable'，不进分母（invalid 不计入 closed 胜率）。
 *  6. screen 在 14:50 调用时 hits 稳定返回（盘中 trading=true，rankings 有真实现价），带 TradePlan 与
 *     score 口径与盘中任意时刻一致；无 14:50 专属不稳定。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 【触发时机口径】（短期方案 / 长期后端收盘快照另立任务，不在 P2b 范围）
 *  - 记录窗口 = 14:50 ~ 15:00（交易时段内，工作日）。窗口内应用打开才触发当日信号记录；
 *    窗口外（<14:50 或 >=15:00）只推进已持仓记录（调 sim 结算），不做新记录。
 *  - 15:00 后打开且当日无记录：不调 screen，当日标记「待后端快照」，由 getPendingDays() 暴露，不写假记录。
 *  - 每条记录写 recordedAt（ISO 含时分）与 priceSource='intraday_late'，明确为「盘中尾盘快照」。
 *  - 统计层（P3/P5）须按 priceSource 隔离口径：intraday_late 记录与未来 close 记录【不可混算】。
 *  - 后端收盘快照（priceSource='close'）列为后续独立任务：由后端在收盘后跑排行榜生成 close 记录，
 *    回填 getPendingDays() 返回的待补日期；P2b 不实现该路径、不写假数据。
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { marketApi } from '../services/market';
import type { ScreenHit, StrategyHit } from '../domain/strategy';
import type { KlineRow } from '../domain/types';
import {
  listEnabledStrategies,
  getWinRateConfig,
  STRATEGY_PARAM_VERSION,
  DEFAULT_RECORD_CUTOFF,
  type StrategyWinRateConfig,
} from '../domain/winrate-config';
import { simulateTrade, type SimSuspensionRange } from '../lib/winrate-sim';
import {
  genWinRateRecordId,
  type WinRateRecord,
  type TradeRecord,
  type WinRateAnomaly,
  type WinRateSnapshot,
} from '../domain/winrate';
import { useWinRateStore, getLiveRecords } from './useWinRateStore';

const RECORD_TOP_N = 5;
const KLINE_COUNT = 250;
const REF_INDEX_CODE = 'sh000001';
/** 待补日期回看窗口（自然日）：getPendingDays 仅回看最近 N 天的工作日 */
const PENDING_LOOKBACK_DAYS = 15;

/** 解析 'HH:MM' → 当日分钟数 */
function parseHHMM(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}
const RECORD_CUTOFF_MINS = parseHHMM(DEFAULT_RECORD_CUTOFF); // 默认 14:50 → 890
const MARKET_CLOSE_MINS = 15 * 60; // 15:00 → 900

/** 本地日期 YYYY-MM-DD（避免 UTC 偏移吞日期） */
function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 是否工作日 */
function isWeekday(d: Date): boolean {
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

/** 交易时段（工作日 9:30-15:00）。后端排行榜仅在此能发现新候选。 */
function isWithinTradingHours(d = new Date()): boolean {
  if (!isWeekday(d)) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= 9 * 60 + 30 && mins <= MARKET_CLOSE_MINS;
}

/** 记录窗口：交易时段内 且 当前时刻 ∈ [14:50, 15:00] */
function isWithinRecordWindow(d = new Date()): boolean {
  if (!isWithinTradingHours(d)) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= RECORD_CUTOFF_MINS && mins <= MARKET_CLOSE_MINS;
}

/**
 * 仅开发期使用，生产禁用：用途是本地调试 winrate 页面（无视 14:50-15:00 记录窗口、应用打开即记当日 Top5）。
 * 守卫：首行 if (!import.meta.env.DEV) return false —— 生产构建（DEV===false）下整个函数早退返回 false，
 *       URL 参数与 localStorage 均不读取，避免被外部链接误触发写入假记录。
 * 触发方式（仅在 DEV 下生效）：
 *   1) URL 查询参数 ?wrForce=1
 *   2) localStorage['wrDevForce']==='1'
 */
function isForceRecordEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('wrForce') === '1') return true;
    if (localStorage.getItem('wrDevForce') === '1') return true;
  } catch {
    /* 非浏览器环境安全降级 */
  }
  return false;
}

/** 6 位代码 → 带市场前缀 fullCode（与 server/index.mjs toFull 一致；WinRateRecord 仅存 6 位，结算时需还原） */
function toFullCode(code: string): string {
  const c = String(code).padStart(6, '0');
  if (/^(6|9)/.test(c)) return 'sh' + c;
  if (/^(4|8)/.test(c)) return 'bj' + c;
  return 'sz' + c;
}

/** 取记录日后首个交易日索引（K 线按日期升序；与 sim 同义，仅用于预估/守卫） */
function firstIndexAfter(daily: KlineRow[], date: string): number {
  for (let i = 0; i < daily.length; i++) {
    if (daily[i].date > date) return i;
  }
  return -1;
}

/** (date, strategyId) 是否已记录（存在任意一条） */
function existsForDate(records: WinRateRecord[], date: string, strategyId: string): boolean {
  return records.some((r) => r.date === date && r.strategyId === strategyId);
}

/**
 * 收盘快照（口径 A）→ WinRateRecord[]。
 * 镜像 recordStrategy 的记录构造，但来源是后端快照而非实时 screen：
 *  - priceSource 固定 'close'（与 intraday_late 统计层隔离）
 *  - backfilled：仅历史日（非当日）置 true，当日收盘快照视为合法同日记录
 *  - T+1 结算全部留前端 settleOpenRecords（tPlus1SellDate 留 null，结算时按 buyDate 重算）
 *  - holdDays / paramVersion / strategyName 取前端 winrate-config（与盘中记录同源）
 */
function recordsFromSnapshot(snapshot: WinRateSnapshot, isHistorical: boolean): WinRateRecord[] {
  const created: WinRateRecord[] = [];
  const recordedAt = snapshot.generatedAt ?? new Date().toISOString();
  for (const strat of snapshot.strategies) {
    const cfg = getWinRateConfig(strat.strategyId);
    if (!cfg) continue; // 后端有但前端配置未映射的战法：跳过，不写脏数据
    for (const h of strat.hits) {
      const unbuyable = h.limitUp?.isLimitUp === true || h.price == null;
      const trade: TradeRecord = {
        buyDate: null,
        buyPrice: null,
        sellDate: null,
        sellPrice: null,
        holdDays: null,
        returnPct: null,
        sellReason: 'unknown',
        status: unbuyable ? 'invalid' : 'open',
        anomalies: unbuyable ? ['unbuyable'] : [],
        backfilled: isHistorical,
      };
      const rec: WinRateRecord = {
        id: genWinRateRecordId(),
        date: snapshot.date,
        strategyId: strat.strategyId,
        strategyName: strat.strategyName ?? cfg.strategyName,
        code: h.code,
        name: h.name,
        determinismScore: h.determinismScore ?? null,
        scoreFactors: h.scoreFactors ?? null,
        signalStrength: h.strategies.find((s) => s.id === strat.strategyId)?.hitRatio ?? null,
        signalStrengthSource: 'hitRatio',
        recordedPrice: h.price ?? null,
        buyLow: h.tradePlan?.buyLow ?? null,
        buyHigh: h.tradePlan?.buyHigh ?? null,
        stop: h.tradePlan?.stop ?? null,
        target1: h.tradePlan?.target1 ?? null,
        target2: h.tradePlan?.target2 ?? null,
        holdDays: cfg.holdDays,
        tPlus1SellDate: null, // 由结算逻辑重算
        paramVersion: cfg.paramVersion,
        backfilled: isHistorical,
        recordedAt,
        priceSource: 'close',
        insufficientHits: strat.insufficientHits,
        trade,
      };
      created.push(rec);
    }
  }
  return created;
}

/**
 * 模块级缓存：参考交易日历（高流动性指数日 K 日期序列）。
 * 用于区分「市场休市（参考日历本就缺该日）」与「个股停牌（参考日历有、个股 K 缺）」，
 * 后者合并为连续停牌区间传给 simulateTrade。指数 K 取数失败则返回 null，停用区间构造。
 */
let refTradingDates: string[] | null = null;
let refLoading: Promise<string[] | null> | null = null;

async function getReferenceTradingDates(): Promise<string[] | null> {
  if (refTradingDates) return refTradingDates;
  if (refLoading) return refLoading;
  refLoading = (async () => {
    try {
      const k = await marketApi.kline(REF_INDEX_CODE, 'day', 'qfq', KLINE_COUNT);
      const dates = (k.rows ?? []).map((r) => r.date).sort();
      refTradingDates = dates.length ? dates : null;
      return refTradingDates;
    } catch {
      return null;
    }
  })();
  return refLoading;
}

/**
 * 用参考日历构造个股停牌区间：参考日历中存在、但个股 K 序列缺失（且位于记录日之后）的交易日，
 * 视为个股停牌，合并为连续区间。市场休市日本就不在参考日历中，不会误判为停牌。
 */
function buildSuspensionRanges(
  stockDaily: KlineRow[],
  refDates: string[] | null,
  fromDate: string,
): SimSuspensionRange[] {
  if (!refDates || refDates.length === 0) return [];
  const stockSet = new Set(stockDaily.map((r) => r.date));
  const ranges: SimSuspensionRange[] = [];
  let curStart: string | null = null;
  let curEnd: string | null = null;
  for (const d of refDates) {
    if (d <= fromDate) continue;
    if (!stockSet.has(d)) {
      if (curStart == null) {
        curStart = d;
        curEnd = d;
      } else {
        curEnd = d;
      }
    } else if (curStart != null) {
      ranges.push({ from: curStart, to: curEnd as string });
      curStart = null;
      curEnd = null;
    }
  }
  if (curStart != null) ranges.push({ from: curStart, to: curEnd as string });
  return ranges;
}

export interface RecordStrategyResult {
  strategyId: string;
  recorded: number;
  invalid: number;
  /** 命中数 < RECORD_TOP_N（样本不足）；P1 的 WinRateRecord 无此字段，仅在此汇报层暴露 */
  insufficientHits: boolean;
  errors: string[];
}

export interface SettleResult {
  settled: number;
  /** 买入日尚未发生（记录在当日、T+1 买入日 K 未产生）→ 跳过，留待后续结算 */
  skippedNoBuyDay: number;
  errors: number;
}

export interface DailyReport {
  date: string;
  /** 记录窗口内且当日已覆盖（新记录或已存在） */
  recorded: boolean;
  /** 当前是否处于记录窗口（14:50-15:00） */
  windowOpen: boolean;
  /** 15:00 后打开且当日无记录 → 当日为待后端快照 */
  pendingToday: boolean;
  recordResults: RecordStrategyResult[];
  settle: SettleResult;
  /** 待后端收盘快照回填的日期（含历史未记录工作日，回看 PENDING_LOOKBACK_DAYS） */
  pendingDays: string[];
  /** 收盘快照（口径 A）补拉结果：本次回填的日期与新增记录数 */
  backfilledDays?: string[];
  backfilledAdded?: number;
  note?: string;
}

export function useWinRateRecorder() {
  const store = useWinRateStore();
  const { records, appendRecords, updateTrade } = store;
  const recordsRef = useRef<WinRateRecord[]>(records);
  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  const [recording, setRecording] = useState(false);
  const [settling, setSettling] = useState(false);
  const [lastReport, setLastReport] = useState<DailyReport | null>(null);

  /** 记录单个战法当日的 TopN 信号（screen 按该战法过滤 → 评分降序取前 5）。每条带 recordedAt/priceSource。 */
  const recordStrategy = useCallback(
    async (
      date: string,
      cfg: StrategyWinRateConfig,
      isBackfill: boolean,
    ): Promise<RecordStrategyResult> => {
      const res: RecordStrategyResult = {
        strategyId: cfg.strategyId,
        recorded: 0,
        invalid: 0,
        insufficientHits: false,
        errors: [],
      };
      try {
        // 关键：仅传该战法 id，使 hit 的 tradePlan / score 唯一归属该战法
        const screen = await marketApi.screen({
          ids: [cfg.strategyId],
          sortBy: 'changePct',
          poolSize: 300,
        });
        if (!screen.ok) {
          res.errors.push(screen.reason ?? 'screen 失败');
          return res;
        }
        const hits: ScreenHit[] = screen.hits ?? [];
        // 双保险：确保 hit 的 strategies 含本战法 id（ids 参数已保证）
        const matched = hits.filter((h) => h.strategies.some((s: StrategyHit) => s.id === cfg.strategyId));
        res.insufficientHits = matched.length < RECORD_TOP_N;
        const top = matched.slice(0, RECORD_TOP_N);

        const recordedAt = new Date().toISOString();
        const created: WinRateRecord[] = [];
        for (const hit of top) {
          // 记录日不可买入：涨停或行情缺失 → invalid + unbuyable，不进分母（不模拟）
          const unbuyable = hit.limitUp?.isLimitUp === true || hit.price == null;
          let tPlus1: string | null = null;
          const anomalies: WinRateAnomaly[] = [];
          if (!unbuyable) {
            // T+1 可卖日预估（best-effort）：记录时买入日 K 通常尚未产生（买入日为记录日次日），
            // 算不出属正常现象，绝不在记录时盖 data_missing（data_missing 只由结算逻辑在买入日真正缺失时判定）。
            try {
              const k = await marketApi.kline(hit.fullCode, 'day', 'qfq', KLINE_COUNT);
              const daily = k.rows ?? [];
              const idx = firstIndexAfter(daily, date);
              if (idx >= 0 && idx + 1 < daily.length) tPlus1 = daily[idx + 1].date;
              // 否则 tPlus1 保持 null，结算时由 simulateTrade 用完整 K 线重算（记录日买入日未到，不标异常）
            } catch {
              /* tPlus1 保持 null，结算时由 simulateTrade 内部重算 */
            }
          }
          const trade: TradeRecord = {
            buyDate: null,
            buyPrice: null,
            sellDate: null,
            sellPrice: null,
            holdDays: null,
            returnPct: null,
            sellReason: 'unknown',
            status: unbuyable ? 'invalid' : 'open',
            anomalies: unbuyable ? ['unbuyable'] : anomalies,
            backfilled: isBackfill,
          };
          const rec: WinRateRecord = {
            id: genWinRateRecordId(),
            date,
            strategyId: cfg.strategyId,
            strategyName: cfg.strategyName,
            code: hit.code,
            name: hit.name,
            determinismScore: hit.score?.total ?? null,
            scoreFactors: hit.score?.factors ?? null,
            signalStrength: hit.strategies.find((s) => s.id === cfg.strategyId)?.hitRatio ?? null,
            signalStrengthSource: 'hitRatio',
            recordedPrice: hit.price ?? null,
            // 复用 TradePlan 买卖区间（涨停时 buyLow/buyHigh 已被后端置 null）
            buyLow: hit.tradePlan?.buyLow ?? null,
            buyHigh: hit.tradePlan?.buyHigh ?? null,
            stop: hit.tradePlan?.stop ?? null,
            target1: hit.tradePlan?.target1 ?? null,
            target2: hit.tradePlan?.target2 ?? null,
            // 持有周期取 winrate-config 已解析的 {min,max}（与 sim 读取口径一致）
            holdDays: cfg.holdDays,
            tPlus1SellDate: tPlus1,
            paramVersion: STRATEGY_PARAM_VERSION,
            backfilled: isBackfill,
            // 触发时机口径：短期方案一律为盘中尾盘快照
            recordedAt,
            priceSource: 'intraday_late',
            // 命中样本不足（该战法当日命中数 < RECORD_TOP_N=5）；统计层据此标记样本不足
            insufficientHits: res.insufficientHits,
            trade,
          };
          created.push(rec);
        }
        // Bug1 修复：写入前按 (date, strategyId, code) 去重，避免同日同战法同股票重复记录。
        // 背景：appendRecords 仅按 id 去重，而每条记录生成随机新 id，抓不住「同日+同战法+同股票」的重复；
        // 例如在同一记录日对同战法重复触发（含 ?wrForce=1 多次）会把聚众股份 603037 记成两条。
        const existingCodes = new Set(
          recordsRef.current
            .filter((r) => r.date === date && r.strategyId === cfg.strategyId)
            .map((r) => r.code),
        );
        const fresh = created.filter((rec) => !existingCodes.has(rec.code));
        appendRecords(fresh);
        res.recorded = fresh.length;
        res.invalid = fresh.filter((r) => r.trade.status === 'invalid').length;
        return res;
      } catch (e) {
        res.errors.push((e as Error).message ?? String(e));
        return res;
      }
    },
    [appendRecords],
  );

  /** 结算所有 status=open 记录：调 kline + simulateTrade，结果写回 store（已平仓不可改）。结算不受窗口限制。 */
  const settleOpenRecords = useCallback(async (): Promise<SettleResult> => {
    const result: SettleResult = { settled: 0, skippedNoBuyDay: 0, errors: 0 };
    // 读最新内存 state（而非 recordsRef.current）：保证同一次周期内刚 append 的补拉/记录记录也能被结算
    const openRecords = getLiveRecords().filter((r) => r.trade.status === 'open');
    if (openRecords.length === 0) return result;
    const refDates = await getReferenceTradingDates().catch(() => null);
    for (const rec of openRecords) {
      try {
        const k = await marketApi.kline(toFullCode(rec.code), 'day', 'qfq', KLINE_COUNT);
        const daily = k.rows ?? [];
        if (!daily.length) {
          // K 线彻底缺失（极少见，多为网络/源抖动）：留待下轮结算，不在此标 data_missing
          result.errors++;
          continue;
        }
        // Bug2 修复：买入日尚未发生（最后一根 K 线日期 <= 记录日，即 T+1 买入日 K 未产生）→
        // 跳过，保持 status='open'，绝不允许标 data_missing。data_missing 仅在「买入日本应发生但 K 线中
        // 彻底找不到对应数据」时、由 simulateTrade 判定。
        const lastKlineDate = daily[daily.length - 1].date;
        if (lastKlineDate <= rec.date) {
          result.skippedNoBuyDay++;
          continue;
        }
        // 买入日已发生：定位买入日索引（lastKlineDate>rec.date 已保证 buyIdx>=0，此分支仅防御）
        const buyIdx = firstIndexAfter(daily, rec.date);
        if (buyIdx < 0) {
          result.skippedNoBuyDay++;
          continue;
        }
        // T+1 卖出日尚未发生（买入日已是最后一根 K 线，次交易日 K 未产生）→ 跳过保持 open，
        // 避免 simulateTrade 因 tPlus1SellDate 为 null 误标 data_missing（买入日当天结算会命中此分支）。
        if (buyIdx + 1 >= daily.length) {
          result.skippedNoBuyDay++;
          continue;
        }
        const ranges = buildSuspensionRanges(daily, refDates, rec.date);
        const { trade } = simulateTrade(rec, daily, { suspensionRanges: ranges });
        // 修正次新股 tPlus1SellDate：记录时 K 仅到记录日（买入日尚未产生）→ tPlus1 估计为空/不准；
        // 结算时 K 已含买入日，按 buyDate 重算 T+1 可卖日回填（buyDate 缺失则保持原值）
        let tPlus1SellDate = rec.tPlus1SellDate;
        if (trade.buyDate != null) {
          const bi = daily.findIndex((r) => r.date === trade.buyDate);
          if (bi >= 0 && bi + 1 < daily.length) tPlus1SellDate = daily[bi + 1].date;
        }
        const ok = updateTrade(rec.id, {
          buyDate: trade.buyDate,
          buyPrice: trade.buyPrice,
          sellDate: trade.sellDate,
          sellPrice: trade.sellPrice,
          holdDays: trade.holdDays,
          returnPct: trade.returnPct,
          sellReason: trade.sellReason,
          status: trade.status,
          anomalies: trade.anomalies,
          tPlus1SellDate,
        });
        if (ok.ok) result.settled++;
        else result.errors++;
      } catch {
        result.errors++;
      }
    }
    return result;
  }, [updateTrade]);

  /** 待后端收盘快照回填的日期：回看最近 PENDING_LOOKBACK_DAYS 个自然日，返回其中无任何记录的工作日 */
  const getPendingDays = useCallback((): string[] => {
    const todayStr = localDate();
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - PENDING_LOOKBACK_DAYS);
    const out: string[] = [];
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    // 读最新内存 state（而非 recordsRef.current）：补拉后本周期内即可反映已回填日期
    const records = getLiveRecords();
    while (cursor <= end) {
      if (isWeekday(cursor)) {
        const ds = localDate(cursor);
        if (ds > todayStr) break; // 防御：不跨到未来
        const hasAny = records.some((r) => r.date === ds);
        if (!hasAny) out.push(ds);
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }, []);

  /**
   * 收盘快照补拉（口径 A）：应用打开时，拉取后端已落盘但本地缺失的收盘快照，
   * 转为 WinRateRecord（priceSource='close'）写入 store，随后由 settleOpenRecords 结算 T+1。
   * 与 recordStrategy 同等去重：按 (date, strategyId, code) 跳过已存在记录。
   * 任何网络/解析异常都静默吞掉，绝不阻断应用打开或原结算流程。
   */
  const backfillCloseSnapshots = useCallback(async (): Promise<{ dates: string[]; added: number }> => {
    const out: { dates: string[]; added: number } = { dates: [], added: 0 };
    try {
      const datesRes = await marketApi.winrateSnapshotDates();
      if (!datesRes.ok || !Array.isArray(datesRes.dates) || !datesRes.dates.length) return out;
      const existingDates = new Set(recordsRef.current.map((r) => r.date));
      const missing = datesRes.dates.filter((d) => !existingDates.has(d));
      if (!missing.length) return out;
      const todayStr = localDate();
      for (const d of missing) {
        try {
          const snapRes = await marketApi.winrateSnapshot(d);
          if (!snapRes.ok || !('snapshot' in snapRes) || !snapRes.snapshot) continue;
          const isHistorical = d !== todayStr; // 历史缺失日（非当日）→ backfilled=true
          let recs = recordsFromSnapshot(snapRes.snapshot, isHistorical);
          // 按 (date, strategyId, code) 去重，避免同日同战法同股票重复（镜像 recordStrategy）
          const existingKeys = new Set(
            recordsRef.current
              .filter((r) => r.date === d)
              .map((r) => r.strategyId + ':' + r.code),
          );
          recs = recs.filter((r) => !existingKeys.has(r.strategyId + ':' + r.code));
          if (recs.length) {
            const { added } = appendRecords(recs);
            out.added += added;
            if (added > 0) out.dates.push(d);
          }
        } catch {
          /* 单日快照失败不影响其它日 */
        }
      }
    } catch {
      /* 后端不可达等：保持静默，不影响应用打开 */
    }
    return out;
  }, [appendRecords]);

  /**
   * 每日周期入口（应用打开时调用）：
   *  - 第一步（口径 A）：拉后端已落盘、本地缺失的收盘快照（priceSource='close'）补录，
   *    随后由 settleOpenRecords 对其中 status=open 的记录做 T+1 结算。
   *  - 记录窗口内（14:50-15:00）：对每个未记录的 enabled 战法补记当日 TopN（priceSource='intraday_late'）。
   *  - 窗口外（<14:50 或 >=15:00）：不记录新候选。>=15:00 且当日无记录 → 当日标记「待后端快照」（见 pendingDays）。
   *  - 始终：结算所有 open 记录（买入日已发生的才结算，未来的跳过）。
   */
  const runDailyCycle = useCallback(async (): Promise<DailyReport> => {
    const now = new Date();
    const date = localDate(now);

    // 1) 收盘快照补拉（口径 A）：先把后端已落盘、本地缺失的 close 记录补进来，再算后续状态
    const backfill = await backfillCloseSnapshots();

    // 2) 基于补拉后的最新记录计算当日/待补状态（读最新内存 state，避免同周期内读到旧值）
    const liveRecords = getLiveRecords();
    const windowOpen = isWithinRecordWindow(now);
    const afterClose = isWeekday(now) && now.getHours() >= 15;
    const todayExists = listEnabledStrategies().every((c) =>
      existsForDate(liveRecords, date, c.strategyId),
    );
    const pendingToday = afterClose && !todayExists;

    const report: DailyReport = {
      date,
      recorded: false,
      windowOpen,
      pendingToday,
      recordResults: [],
      settle: { settled: 0, skippedNoBuyDay: 0, errors: 0 },
      pendingDays: getPendingDays(),
      backfilledDays: backfill.dates,
      backfilledAdded: backfill.added,
    };

    if (!windowOpen && !isForceRecordEnabled()) {
      report.note =
        windowOpen === false && afterClose
          ? '已收盘且当日无记录：当日标记「待后端快照」，不写假记录；仅结算历史 open 记录。'
          : '当前不在记录窗口（14:50-15:00 交易时段内）：仅结算历史 open 记录，不做新记录。';
      setSettling(true);
      report.settle = await settleOpenRecords();
      setSettling(false);
      setLastReport(report);
      return report;
    }

    const enabled = listEnabledStrategies();
    const initialExisted = new Set(
      enabled.filter((c) => existsForDate(liveRecords, date, c.strategyId)).map((c) => c.strategyId),
    );

    setRecording(true);
    for (const cfg of enabled) {
      if (initialExisted.has(cfg.strategyId)) continue;
      const r = await recordStrategy(date, cfg, false);
      report.recordResults.push(r);
    }
    setRecording(false);

    report.recorded =
      report.recordResults.length > 0 || enabled.every((c) => initialExisted.has(c.strategyId));

    setSettling(true);
    report.settle = await settleOpenRecords();
    setSettling(false);

    report.pendingDays = getPendingDays();
    setLastReport(report);
    return report;
  }, [backfillCloseSnapshots, recordStrategy, settleOpenRecords, getPendingDays]);

  return {
    records,
    recording,
    settling,
    lastReport,
    recordStrategy,
    settleOpenRecords,
    getPendingDays,
    runDailyCycle,
  };
}
