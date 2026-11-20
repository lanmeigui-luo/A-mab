/**
 * plan-missing.ts —— 买卖计划完整性死规矩（纯函数，可离线验收）
 *
 * 2026-11-20 龙回头 600408 事故：字段路径错位导致 buyLow/stop 全空，
 * 但半截计划仍一路走到买入成交。这里定义唯一不变量：
 * 只要已产生买入价（buyPrice），buyLow 与 stop 必须同时有效，否则判 missing_plan_anomaly。
 */

export interface PlanCheckSource {
  buyLow?: number | null;
  stop?: number | null;
  buyPrice?: number | null;
}

const usable = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

/** 计划是否残缺到不可交易（buyLow 或 stop 缺失/非法） */
export function isPlanIncomplete(p: PlanCheckSource | null | undefined): boolean {
  if (!p) return true;
  return !usable(p.buyLow) || !usable(p.stop);
}

/** 已买入但计划残缺 → 必须标异常的脏数据 */
export function isMissingPlanAnomaly(r: PlanCheckSource | null | undefined): boolean {
  if (!r || !usable(r.buyPrice)) return false;
  return isPlanIncomplete(r);
}
