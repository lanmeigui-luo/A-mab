/**
 * trade-plan-validity.ts —— 买卖计划完整性与 T+1 合规校验（纯函数，可离线验收）
 *
 * 事故（2026-11-19 龙回头 000530）：记录日数据源缺字段 → stop/target1 为 null，
 * target2=11.79 反而低于买入价 12.09，系统仍拿这份残缺计划买入并在当日卖出。
 * 本模块给出唯一口径：计划不完整 / 目标倒挂 / 同日买卖，一律不允许执行。
 */

export interface PlanLike {
  buyLow?: number | null;
  buyHigh?: number | null;
  stop?: number | null;
  target1?: number | null;
  target2?: number | null;
}

/** 计划是否可用于真实交易：止损、目标一、买入下限缺一不可，且目标必须高于买入上限 */
export function isPlanTradable(plan: PlanLike | null | undefined): boolean {
  if (!plan) return false;
  const { buyLow, buyHigh, stop, target1 } = plan;
  const valid = (v: number | null | undefined) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (!valid(buyLow) || !valid(buyHigh) || !valid(stop) || !valid(target1)) return false;
  if ((buyHigh as number) < (buyLow as number)) return false;
  if ((target1 as number) <= (buyHigh as number)) return false;
  if (plan.target2 != null && valid(plan.target2) && (plan.target2 as number) <= (buyHigh as number)) return false;
  return true;
}

/** T+1 绝对锁：同日买卖一律拒绝（不依赖任何动态规则或字段兜底） */
export function isSameDayClose(buyDate: string | null | undefined, sellDate: string | null | undefined): boolean {
  return typeof buyDate === 'string' && typeof sellDate === 'string' && buyDate === sellDate && buyDate.length > 0;
}
