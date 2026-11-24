// winrate-backfill.ts —— 历史快照回填的纯函数（离线可测）
import type { WinRateRecord } from '../domain/winrate';

/** 自动回填范围：以快照日期列表为准，取「尾部 N 个」（升序列表的最后 N 个）。
 *  不是自然日往回推 N 天，也不是最近 N 个工作日——快照哪天有就按哪天算。 */
export function selectAutoDates(snapshotDates: string[], limit = 5): string[] {
  return [...snapshotDates].sort().slice(-limit);
}

/** 本地记录能否被收盘快照覆盖：
 *  仅「待买入 + intraday_late」可被 close 记录覆盖（盘中计划按 14:50 实时价，收盘按 15:10）。
 *  持仓中 / 已平仓 / 未成交 / 其他来源一律保留本地，绝不覆盖。 */
export function canOverwriteWithClose(local: WinRateRecord | undefined): boolean {
  if (!local) return true;
  if (local.priceSource !== 'intraday_late') return false;
  return local.trade?.status === 'open' && local.trade.buyPrice == null;
}

/** 战法级合并计划：返回应新增的记录，以及应覆盖（同 key）的记录。
 *  existingKeys 形如 `date:strategyId:code`；existingByKey 提供本地记录用于覆盖判定。
 *  hits=0 且该日该战法无任何本地记录 → 补 no_signal 占位。 */
export interface SnapshotStrategy {
  strategyId: string;
  strategyName?: string;
  hits: unknown[];
}
export interface MergePlanInput {
  date: string;
  strategies: SnapshotStrategy[];
  existingKeys: Set<string>;
  existingByKey: Map<string, WinRateRecord>;
  makeHit: (hit: unknown, strategy: SnapshotStrategy) => WinRateRecord;
  makeNoSignal: (strategy: SnapshotStrategy) => WinRateRecord;
}
export interface MergePlan {
  toAdd: WinRateRecord[];
  toReplace: WinRateRecord[];
}
export function planStrategyMerge(input: MergePlanInput): MergePlan {
  const toAdd: WinRateRecord[] = [];
  const toReplace: WinRateRecord[] = [];
  for (const strat of input.strategies) {
    const hits = strat.hits ?? [];
    if (hits.length === 0) {
      // 该日该战法已有任何本地记录（含占位）→ 不重复写 no_signal
      const hasAny = [...input.existingKeys].some((k) =>
        k.startsWith(input.date + ':' + strat.strategyId + ':'));
      if (!hasAny) toAdd.push(input.makeNoSignal(strat));
      continue;
    }
    for (const hit of hits) {
      const rec = input.makeHit(hit, strat);
      const key = input.date + ':' + rec.strategyId + ':' + rec.code;
      if (!input.existingKeys.has(key)) {
        toAdd.push(rec);
        continue;
      }
      const local = input.existingByKey.get(key);
      if (canOverwriteWithClose(local)) toReplace.push(rec);
    }
  }
  return { toAdd, toReplace };
}

/** 计算缺失日期（快照有、但本地按战法未补全的日期），倒序返回。
 *  用 records 的 date 集合判断「该日是否完全补齐」由调用方按战法级处理，此处仅给候选。 */
export function missingSnapshotDates(snapshotDates: string[], recordedDates: Set<string>): string[] {
  return [...snapshotDates].filter((d) => !recordedDates.has(d)).sort().reverse();
}

/** 分批：每批最多 N 个日期 */
export function chunkDates<T>(dates: T[], size = 3): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < dates.length; i += size) out.push(dates.slice(i, i + size));
  return out;
}

/** 让出主线程（批间调用，避免长任务卡 UI） */
export function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
