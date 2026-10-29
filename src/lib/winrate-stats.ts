/**
 * winrate-stats.ts —— P2a 纯函数：胜率统计聚合
 *
 * 设计原则：纯函数、无副作用、不读 localStorage / 不调 API / 不碰 React。
 * 输入：WinRateRecord[] + 筛选条件
 * 输出：按战法聚合的 WinRateStats[] + 排行榜 + 持有周期分布 + 卖出原因分布
 *       + 最大回撤 + 累计收益曲线
 *
 * ───────────────────────────────────────────────────────────────────────
 * 统计口径（唯一出处）：
 *  - total：筛选后的记录总数。
 *  - closed（= 有效交易）：trade.status==='closed' 且不含任何 anomaly 的记录。
 *    （异常标注不参与统计，仅展示；status='anomaly'/'invalid' 与 closed-with-anomaly 均不计入绩效。）
 *  - wins：closed 中 returnPct > 0；losses：closed 中 returnPct <= 0。
 *  - winRate = wins / closed（closed=0 为 null）。
 *  - avgReturnPct / avgHoldDays：closed 集合上的均值。
 *  - profitFactor（盈亏比）= 平均盈利 / 平均亏损绝对值（无亏损为 null，无盈利为 0）。
 *  - invalidCount：status==='invalid' 的记录数。
 *  - anomalyCount：含任意 anomaly 的记录数（含 closed-with-anomaly 与 status='anomaly'）。
 *  - insufficientSample：closed < 10 标 true。
 *  - 最大回撤 / 累计收益曲线：基于 closed 记录按 sellDate 升序的累计收益率序列。
 */

import type {
  WinRateRecord,
  WinRateStats,
  TradeStatus,
  SellReason,
  PriceSource,
} from '../domain/winrate';

export interface WinRateFilter {
  strategyId?: string;
  strategyIds?: string[]; // 战法多选（页面筛选）；为空/未提供时不限制
  code?: string;
  dateFrom?: string; // YYYY-MM-DD 含
  dateTo?: string; // YYYY-MM-DD 含
  status?: TradeStatus;
  /** 仅统计有效（无 anomaly）记录；默认 true */
  excludeAnomaly?: boolean;
  /** 数据来源口径：'all'=不限制（但返回结果按 priceSource 分组给出，不合并收益口径）；
   *  'intraday_late' / 'close'=仅统计该来源。默认 'all'。 */
  priceSource?: PriceSource | 'all';
  /** 持有周期分组（对应 HOLD_DAYS_BUCKETS.label）；提供则仅统计该桶记录。默认不限。 */
  holdDaysBucket?: string;
}

export interface HoldDaysBucket {
  /** 累积上限桶标签（展示用），如 "≤5天" / ">20天" */
  label: string;
  /** 下限参考（结构保留）；累积桶以 max 为上限阈值判定，min 仅作文档/下限参考 */
  min: number;
  /** 累积上限阈值：holdDays <= max 即归入该桶；数组按 max 升序排列，最后一个 max=Infinity 表示 >20天 */
  max: number;
}

/**
 * 持有周期分组（拍板 A：累积上限桶）。
 * 归桶规则：按 max 阈值升序取第一个满足 holdDays <= max 的桶，每个有效值唯一落桶、无丢弃。
 *   ≤1天 / ≤2天 / ≤3天 / ≤5天 / ≤10天 / ≤20天 / >20天
 * holdDays 为 null（未平仓/异常）不进任何桶，单独计入 unbucketedCount。
 *
 * 【顺序约束】必须严格按 max 升序，末桶 max=Infinity；bucketOf 依赖此顺序，
 * 调序 / 加桶会静默错桶。模块加载时见下方开发期自检。
 */
export const HOLD_DAYS_BUCKETS: HoldDaysBucket[] = [
  { label: '≤1天', min: 1, max: 1 },
  { label: '≤2天', min: 1, max: 2 },
  { label: '≤3天', min: 1, max: 3 },
  { label: '≤5天', min: 1, max: 5 },
  { label: '≤10天', min: 1, max: 10 },
  { label: '≤20天', min: 1, max: 20 },
  { label: '>20天', min: 21, max: Infinity },
];

// 开发期自检：max 必须严格升序且末桶必须为 Infinity，否则 bucketOf 会静默错桶。
// 不抛异常，只 console.error 警告，避免阻断启动。
(() => {
  let ok = true;
  for (let i = 1; i < HOLD_DAYS_BUCKETS.length; i++) {
    if (!(HOLD_DAYS_BUCKETS[i].max > HOLD_DAYS_BUCKETS[i - 1].max)) ok = false;
  }
  if (HOLD_DAYS_BUCKETS[HOLD_DAYS_BUCKETS.length - 1].max !== Infinity) ok = false;
  if (!ok) console.error('HOLD_DAYS_BUCKETS 顺序异常，bucketOf 可能返回错误桶');
})();

export interface EquityPoint {
  date: string;
  cumulativeReturnPct: number;
}

export interface WinRateStatsResult {
  byStrategy: WinRateStats[];
  ranking: Array<{
    strategyId: string;
    strategyName: string;
    winRate: number | null;
    closed: number;
    total: number;
    insufficientSample: boolean;
  }>;
  holdDaysDistribution: Record<string, number>;
  sellReasonDistribution: Partial<Record<SellReason, number>>;
  maxDrawdown: number | null;
  equityCurve: EquityPoint[];
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function dateInRange(d: string, from?: string, to?: string): boolean {
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

/** 累积上限桶归桶：按 max 阈值升序取第一个满足 holdDays <= max 的桶（每个值唯一落桶，无丢弃） */
function bucketOf(holdDays: number): string {
  const b = HOLD_DAYS_BUCKETS.find((x) => holdDays <= x.max);
  return b ? b.label : '>20天';
}

/** 按 WinRateFilter 过滤记录（导出，供明细表复用，避免筛选逻辑重复） */
export function filterWinRateRecords(
  records: WinRateRecord[],
  filter: WinRateFilter = {},
): WinRateRecord[] {
  const psFilter = filter.priceSource ?? 'all';
  return records.filter((r) => {
    if (filter.strategyId && r.strategyId !== filter.strategyId) return false;
    // 战法多选：空数组 = 全不选（不匹配任何记录）；非空 = 仅保留所选
    if (filter.strategyIds) {
      if (filter.strategyIds.length === 0) return false;
      if (!filter.strategyIds.includes(r.strategyId)) return false;
    }
    if (filter.code && r.code !== filter.code) return false;
    if (!dateInRange(r.date, filter.dateFrom, filter.dateTo)) return false;
    if (filter.status && r.trade.status !== filter.status) return false;
    if (psFilter !== 'all' && r.priceSource !== psFilter) return false;
    if (filter.holdDaysBucket) {
      const hd = r.trade.holdDays;
      if (hd == null || bucketOf(hd) !== filter.holdDaysBucket) return false;
    }
    return true;
  });
}

/** 单战法统计聚合（内部复用：主口径与 priceSource 分口径共用） */
function computeStrategyStats(
  recs: WinRateRecord[],
  strategyId: string,
  strategyName: string,
  excludeAnomaly: boolean,
  equityOut?: WinRateRecord[],
): WinRateStats {
  const total = recs.length;
  const invalidCount = recs.filter((r) => r.trade.status === 'invalid').length;
  const anomalyCount = recs.filter((r) => r.trade.anomalies.length > 0).length;
  const insufficientHitsCount = recs.filter((r) => r.insufficientHits).length;
  // 持有天数缺失口径：仅 status==='open' | 'anomaly' 且 holdDays 为 null 计入；
  // invalid（未成交/不可买入）不计入 unbucketedCount（与卡片文案「未平仓/异常」一致）。
  const unbucketedCount = recs.filter(
    (r) =>
      (r.trade.status === 'open' || r.trade.status === 'anomaly') &&
      r.trade.holdDays == null,
  ).length;

  // 有效交易 = closed 且无 anomaly（excludeAnomaly）
  const eligible = recs.filter(
    (r) =>
      r.trade.status === 'closed' &&
      r.trade.returnPct != null &&
      r.trade.sellPrice != null &&
      (!excludeAnomaly || r.trade.anomalies.length === 0),
  );
  const closed = eligible.length;
  const wins = eligible.filter((r) => (r.trade.returnPct as number) > 0).length;
  const losses = closed - wins;
  const winRate = closed > 0 ? wins / closed : null;
  const avgReturnPct =
    closed > 0
      ? round2(eligible.reduce((s, r) => s + (r.trade.returnPct as number), 0) / closed)
      : null;
  const avgHoldDays =
    closed > 0
      ? round2(eligible.reduce((s, r) => s + (r.trade.holdDays as number), 0) / closed)
      : null;

  // 盈亏比 = 平均盈利 / 平均亏损绝对值
  const winsArr = eligible
    .filter((r) => (r.trade.returnPct as number) > 0)
    .map((r) => r.trade.returnPct as number);
  const lossesArr = eligible
    .filter((r) => (r.trade.returnPct as number) <= 0)
    .map((r) => r.trade.returnPct as number);
  let profitFactor: number | null = null;
  if (lossesArr.length > 0) {
    const avgWin = winsArr.length > 0 ? winsArr.reduce((s, x) => s + x, 0) / winsArr.length : 0;
    const avgLossAbs = Math.abs(lossesArr.reduce((s, x) => s + x, 0) / lossesArr.length);
    profitFactor = round2(avgWin / avgLossAbs);
  }

  // 最大回撤：该战法 closed 有效记录按 sellDate 升序的累计收益曲线
  const sortedEquity = eligible
    .filter((r) => r.trade.sellDate != null && r.trade.returnPct != null)
    .sort((a, b) => ((a.trade.sellDate as string) < (b.trade.sellDate as string) ? -1 : 1));
  let maxDrawdown: number | null = null;
  if (sortedEquity.length >= 2) {
    let peak = sortedEquity[0].trade.returnPct as number;
    let cum = sortedEquity[0].trade.returnPct as number;
    let mdd = 0;
    for (let i = 1; i < sortedEquity.length; i++) {
      cum += sortedEquity[i].trade.returnPct as number;
      peak = Math.max(peak, cum);
      const dd = peak - cum;
      if (dd > mdd) mdd = dd;
    }
    maxDrawdown = round2(mdd);
  }

  if (equityOut) equityOut.push(...eligible);

  // 最大单笔盈利 / 亏损：基于 closed 有效记录的逐笔收益率
  const rets = eligible.map((r) => r.trade.returnPct as number);
  const winRets = rets.filter((x) => x > 0);
  const lossRets = rets.filter((x) => x <= 0);
  const maxProfitPct = winRets.length > 0 ? round2(Math.max(...winRets)) : null;
  const maxLossPct = lossRets.length > 0 ? round2(Math.min(...lossRets)) : null;

  return {
    strategyId,
    strategyName,
    total,
    closed,
    wins,
    losses,
    winRate,
    avgReturnPct,
    avgHoldDays,
    profitFactor,
    invalidCount,
    anomalyCount,
    insufficientSample: closed < 10,
    maxDrawdown,
    insufficientHitsCount,
    maxProfitPct,
    maxLossPct,
    unbucketedCount,
  };
}

/** 计算胜率统计聚合 */
export function computeWinRateStats(
  records: WinRateRecord[],
  filter: WinRateFilter = {},
): WinRateStatsResult {
  const excludeAnomaly = filter.excludeAnomaly ?? true;
  const filtered = filterWinRateRecords(records, filter);

  // 按战法分组
  const groups = new Map<string, WinRateRecord[]>();
  for (const r of filtered) {
    const arr = groups.get(r.strategyId) ?? [];
    arr.push(r);
    groups.set(r.strategyId, arr);
  }

  const byStrategy: WinRateStats[] = [];
  const ranking: WinRateStatsResult['ranking'] = [];
  const equityRecords: WinRateRecord[] = []; // 全局 closed 有效记录（用于分布/曲线）

  for (const [strategyId, recs] of groups) {
    const strategyName = recs[0]?.strategyName ?? strategyId;
    const stats = computeStrategyStats(recs, strategyId, strategyName, excludeAnomaly, equityRecords);

    // priceSource 分口径（intraday_late / close 不可混算；每组独立统计，无该来源为 null）
    const intraday = recs.filter((r) => r.priceSource === 'intraday_late');
    const close = recs.filter((r) => r.priceSource === 'close');
    stats.priceSourceBreakdown = {
      intraday_late: intraday.length
        ? computeStrategyStats(intraday, strategyId, strategyName, excludeAnomaly)
        : null,
      close: close.length ? computeStrategyStats(close, strategyId, strategyName, excludeAnomaly) : null,
    };

    byStrategy.push(stats);
    ranking.push({
      strategyId,
      strategyName,
      winRate: stats.winRate,
      closed: stats.closed,
      total: stats.total,
      insufficientSample: stats.insufficientSample,
    });
  }

  // 排行榜：按胜率降序（null 排末尾）
  ranking.sort((a, b) => {
    if (a.winRate == null && b.winRate == null) return 0;
    if (a.winRate == null) return 1;
    if (b.winRate == null) return -1;
    return (b.winRate as number) - (a.winRate as number);
  });

  // byStrategy 同序（按胜率降序）
  byStrategy.sort((a, b) => {
    if (a.winRate == null && b.winRate == null) return 0;
    if (a.winRate == null) return 1;
    if (b.winRate == null) return -1;
    return (b.winRate as number) - (a.winRate as number);
  });

  // 持有周期分布 + 卖出原因分布（全局 closed 有效）
  const holdDaysDistribution: Record<string, number> = {};
  for (const b of HOLD_DAYS_BUCKETS) holdDaysDistribution[b.label] = 0;
  const sellReasonDistribution: Partial<Record<SellReason, number>> = {};
  for (const r of equityRecords) {
    const hd = r.trade.holdDays;
    if (hd != null) {
      const label = bucketOf(hd);
      holdDaysDistribution[label] = (holdDaysDistribution[label] ?? 0) + 1;
    }
    const sr = r.trade.sellReason;
    sellReasonDistribution[sr] = (sellReasonDistribution[sr] ?? 0) + 1;
  }

  // 累计收益曲线（按 sellDate 升序；sellDate 为 null 的跳过）
  const sortedEquity = equityRecords
    .filter((r) => r.trade.sellDate != null && r.trade.returnPct != null)
    .sort((a, b) =>
      (a.trade.sellDate as string) < (b.trade.sellDate as string) ? -1 : 1,
    );
  let cum = 0;
  const equityCurve: EquityPoint[] = [];
  for (const r of sortedEquity) {
    cum += r.trade.returnPct as number;
    equityCurve.push({ date: r.trade.sellDate as string, cumulativeReturnPct: round2(cum) });
  }

  // 最大回撤（基于累计收益曲线）
  let maxDrawdown: number | null = null;
  if (equityCurve.length >= 2) {
    let peak = equityCurve[0].cumulativeReturnPct;
    let mdd = 0;
    for (const p of equityCurve) {
      peak = Math.max(peak, p.cumulativeReturnPct);
      const dd = peak - p.cumulativeReturnPct;
      if (dd > mdd) mdd = dd;
    }
    maxDrawdown = round2(mdd);
  }

  return {
    byStrategy,
    ranking,
    holdDaysDistribution,
    sellReasonDistribution,
    maxDrawdown,
    equityCurve,
  };
}
