/**
 * chartUtils.ts —— P4 图表层公共派生工具（纯函数，不改动统计引擎）
 *
 * 职责：把已筛选的 WinRateRecord[] 派生为三张图所需的展示数据。
 *  - 不读 localStorage / 不调 API / 不碰 React；
 *  - 不依赖 winrate-stats.ts 的内部逻辑（仅引用其导出的 HOLD_DAYS_BUCKETS 顺序）；
 *  - 所有「拿不到」的数值保持 null，禁止编造/占位。
 *
 * 统计口径（与 winrate-stats.ts 对齐，唯一口径）：
 *  - 有效交易 = trade.status==='closed' 且 returnPct != null 且 sellPrice != null 且
 *    不含任何 anomaly（excludeAnomaly，默认 true）。
 *  - 胜率 = wins / n（n>0）；样本不足（n<10）由调用方标注。
 */

import type { WinRateRecord, PriceSource, SellReason } from '../../domain/winrate';
import { SELL_REASON_LABELS } from '../../domain/winrate';
import { HOLD_DAYS_BUCKETS } from '../../lib/winrate-stats';

/** 战法固定调色板（按策略 id 稳定映射，保证三张图配色一致） */
export const STRATEGY_PALETTE: string[] = [
  '#2563eb', // 蓝
  '#dc2626', // 红
  '#16a34a', // 绿
  '#d97706', // 琥珀
  '#7c3aed', // 紫
  '#0891b2', // 青
  '#db2777', // 品红
  '#65a30d', // 橄榄绿
];

/** 数据来源配色（柱状图/分布图按来源分组时使用） */
export const SOURCE_COLORS: Record<PriceSource, string> = {
  intraday_late: '#2563eb',
  close: '#d97706',
};

export const SOURCE_LABELS: Record<PriceSource, string> = {
  intraday_late: '盘中尾盘',
  close: '收盘',
};

/** 按 strategyId 稳定映射调色板（字符串哈希，颜色跨图一致、与顺序无关） */
export function strategyColor(strategyId: string): string {
  let h = 0;
  for (let i = 0; i < strategyId.length; i++) {
    h = (h * 31 + strategyId.charCodeAt(i)) >>> 0;
  }
  return STRATEGY_PALETTE[h % STRATEGY_PALETTE.length];
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** 有效交易判定（与 winrate-stats.computeStrategyStats 口径一致） */
export function isEligible(r: WinRateRecord, excludeAnomaly = true): boolean {
  const t = r.trade;
  return (
    t.status === 'closed' &&
    t.returnPct != null &&
    t.sellPrice != null &&
    (!excludeAnomaly || t.anomalies.length === 0)
  );
}

/** 累积上限桶归桶（复刻 winrate-stats.bucketOf：按 max 升序取首个 holdDays<=max 的桶） */
function bucketOf(holdDays: number): string {
  const b = HOLD_DAYS_BUCKETS.find((x) => holdDays <= x.max);
  return b ? b.label : '>20天';
}

// ─────────────────────────── 收益曲线（EquityCurveChart 用） ───────────────────────────

export interface EquityPoint {
  date: string;
  cumulativeReturnPct: number;
}

export interface EquitySeries {
  /** 唯一 id（战法，或 战法|来源） */
  id: string;
  strategyId: string;
  strategyName: string;
  /** 展示标签（'all' 口径下带来源后缀） */
  label: string;
  color: string;
  /** 'all' 口径下 close 用虚线区分 */
  dashed: boolean;
  /** 来源；单一来源口径为 null */
  source: PriceSource | null;
  points: EquityPoint[];
  /** 末点累计收益率，用于排序与取前 5 */
  finalReturn: number;
}

export type SrcFilter = 'all' | PriceSource;

/**
 * 从 records 派生收益曲线系列。
 * - 单一来源口径：每战法 1 条线（来源已在 records 内过滤）。
 * - 'all' 口径：每战法×来源 1 条线（intraday_late 实线 / close 虚线）。
 * - 最多 5 条；超过按末点累计收益降序取前 5（图例注明「仅显示前5」）。
 * - 空数据返回空数组（调用方显示「暂无数据」）。
 */
export function computeEquitySeries(
  records: WinRateRecord[],
  priceSourceFilter: SrcFilter,
): EquitySeries[] {
  const eligible = records.filter((r) => isEligible(r));
  if (eligible.length === 0) return [];

  const allMode = priceSourceFilter === 'all';
  const groups = new Map<string, WinRateRecord[]>();

  for (const r of eligible) {
    const key = allMode ? `${r.strategyId}|${r.priceSource ?? 'unknown'}` : r.strategyId;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const series: EquitySeries[] = [];
  for (const [key, recs] of groups) {
    const strategyId = recs[0].strategyId;
    const strategyName = recs[0].strategyName;
    const source = allMode ? (recs[0].priceSource as PriceSource | null) : null;

    // 按 sellDate 升序累计
    const sorted = recs
      .filter((r) => r.trade.sellDate != null && r.trade.returnPct != null)
      .sort((a, b) =>
        (a.trade.sellDate as string) < (b.trade.sellDate as string) ? -1 : 1,
      );
    let cum = 0;
    const rawPoints: EquityPoint[] = [];
    for (const r of sorted) {
      cum += r.trade.returnPct as number;
      rawPoints.push({ date: r.trade.sellDate as string, cumulativeReturnPct: round2(cum) });
    }
    if (rawPoints.length === 0) continue;

    // 按日期聚合：同一天可能有多笔平仓，累计收益取「当日最后累计值」（升序排列下
    // 同日期末条即包含当日全部交易后的运行总额），保证每个系列每天仅一个数据点，
    // 既消除 React duplicate key 告警，也避免同日多点同 X 坐标导致折线画成竖线。
    const lastByDate = new Map<string, number>();
    for (const p of rawPoints) lastByDate.set(p.date, p.cumulativeReturnPct);
    const points: EquityPoint[] = Array.from(lastByDate.entries())
      .map(([date, cumulativeReturnPct]) => ({ date, cumulativeReturnPct }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const label = allMode && source ? `${strategyName}·${SOURCE_LABELS[source]}` : strategyName;
    series.push({
      id: key,
      strategyId,
      strategyName,
      label,
      color: strategyColor(strategyId),
      dashed: allMode && source === 'close',
      source,
      points,
      finalReturn: points[points.length - 1].cumulativeReturnPct,
    });
  }

  // 按末点累计收益降序，最多取前 5
  series.sort((a, b) => b.finalReturn - a.finalReturn);
  return series.slice(0, 5);
}

// ─────────────────────────── 持有周期胜率（HoldDaysWinRateChart 用） ───────────────────────────

export interface BucketStat {
  label: string;
  winRate: number; // 0-100，n=0 时为 0
  n: number;
  insufficient: boolean; // n>0 且 n<10
}

export interface WinRateGroup {
  source: PriceSource | 'mixed';
  label: string;
  color: string;
  buckets: BucketStat[]; // 严格按 HOLD_DAYS_BUCKETS 顺序，7 项
  hasData: boolean; // 该来源在筛选集内是否存在任何记录（含非 closed）
}

/**
 * 从 records 派生持有周期胜率分组。
 * - 单一来源口径：返回 1 个 group（source=该来源）。
 * - 'all' 口径：返回各存在的来源 group（并排两组/堆叠，不混算）；某来源无记录则不出该 group。
 * - 每个桶独立计算 winRate 与 n，n=0 仍占位（不跳过）。
 */
export function computeBucketWinRates(
  records: WinRateRecord[],
  priceSourceFilter: SrcFilter,
): WinRateGroup[] {
  const allMode = priceSourceFilter === 'all';
  const sources: (PriceSource | 'mixed')[] = allMode
    ? (['intraday_late', 'close'] as PriceSource[])
    : [priceSourceFilter as PriceSource];

  const groups: WinRateGroup[] = [];

  for (const src of sources) {
    const recs = allMode
      ? records.filter((r) => (r.priceSource ?? 'unknown') === src)
      : records;
    const anyRecord = recs.length > 0;
    const eligible = recs.filter((r) => isEligible(r) && r.trade.holdDays != null);

    const buckets: BucketStat[] = HOLD_DAYS_BUCKETS.map((b) => {
      const inBucket = eligible.filter((r) => bucketOf(r.trade.holdDays as number) === b.label);
      const n = inBucket.length;
      const wins = inBucket.filter((r) => (r.trade.returnPct as number) > 0).length;
      return {
        label: b.label,
        winRate: n > 0 ? round2((wins / n) * 100) : 0,
        n,
        insufficient: n > 0 && n < 10,
      };
    });

    if (!anyRecord) continue; // 该来源无记录不出 group（'all' 下仅出有数据的来源）

    groups.push({
      source: src,
      label: allMode ? SOURCE_LABELS[src as PriceSource] : '',
      color: SOURCE_COLORS[src as PriceSource],
      buckets,
      hasData: eligible.length > 0,
    });
  }

  return groups;
}

// ─────────────────────────── 卖出原因分布（SellReasonDistributionChart 用） ───────────────────────────

export interface ReasonStat {
  reason: SellReason;
  label: string;
  count: number;
  pct: number; // 0-100
}

export interface ReasonGroup {
  source: PriceSource | 'mixed';
  label: string;
  color: string;
  items: ReasonStat[]; // 按 count 降序
  total: number;
}

/**
 * 从 records 派生卖出原因分布。
 * - 单一来源口径：返回 1 个 group（仅含 count>0 的原因，按笔数降序）。
 * - 'all' 口径：返回各存在的来源 group（并排两组，不混算）。
 * - 无任何有效平仓记录 → 返回空数组（调用方显示「暂无数据」）。
 */
export function computeSellReasonCounts(
  records: WinRateRecord[],
  priceSourceFilter: SrcFilter,
): ReasonGroup[] {
  const allMode = priceSourceFilter === 'all';
  const sources: (PriceSource | 'mixed')[] = allMode
    ? (['intraday_late', 'close'] as PriceSource[])
    : [priceSourceFilter as PriceSource];

  const groups: ReasonGroup[] = [];

  for (const src of sources) {
    const recs = allMode
      ? records.filter((r) => (r.priceSource ?? 'unknown') === src)
      : records;
    const eligible = recs.filter((r) => isEligible(r));

    const counts = new Map<SellReason, number>();
    for (const r of eligible) {
      counts.set(r.trade.sellReason, (counts.get(r.trade.sellReason) ?? 0) + 1);
    }
    const total = eligible.length;
    if (total === 0) {
      // 'all' 口径：该来源无有效记录则不出 group；单一口径：无数据返回空（由调用方统一显示暂无数据）
      if (!allMode) return [];
      continue;
    }

    const items: ReasonStat[] = Array.from(counts.entries())
      .map(([reason, count]) => ({
        reason,
        label: SELL_REASON_LABELS[reason] ?? reason,
        count,
        pct: round2((count / total) * 100),
      }))
      .sort((a, b) => b.count - a.count);

    groups.push({
      source: src,
      label: allMode ? SOURCE_LABELS[src as PriceSource] : '',
      color: SOURCE_COLORS[src as PriceSource],
      items,
      total,
    });
  }

  return groups;
}
