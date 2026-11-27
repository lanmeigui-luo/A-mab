/**
 * plan-overlay.ts —— 历史交易明细 → 个股 K 线的「记录战法」叠加层（纯函数，可离线验收）
 *
 * 背景：从「历史交易明细」点开个股 K 线时，用户要同时看到两份战法信息：
 *  1. 记录战法：这条历史记录当时的战法名 + 买卖计划（止损/目标/买入区间等）；
 *  2. 实时战法：当前 /api/eval 命中的战法（原有行为）。
 * 且战法线默认关闭，手动打开后画的是「历史记录的计划线」；从自选股等其它入口进来仍画实时线。
 *
 * 纯函数下沉的原因：验收脚本（scripts/winrate-acceptance.ts）只编译纯逻辑、不碰 React。
 * 这些判定逻辑留在组件里无法验收，故抽到这里。本模块一律用相对路径 import，
 * 避免 tsconfig.test.json（不配 @/ paths）的 TS2307 别名坑。
 */
import type { TradePlan, StrategyHit } from '../domain/strategy';
import type { WinRateRecord } from '../domain/winrate';

/** 从历史记录打平字段重建当时的 TradePlan（用于「记录战法」展示 + 画线）。
 *  WinRateRecord 不存嵌套 TradePlan，计划字段是打平存储的，故在此重建。
 *  缺失字段一律给 null / 空串，不用固定值硬凑；返回 null 表示该记录没有可用计划价位。 */
export function planFromRecord(record: WinRateRecord | null | undefined): TradePlan | null {
  if (!record) return null;
  const hasAnyPrice =
    record.buyLow != null ||
    record.buyHigh != null ||
    record.stop != null ||
    record.target1 != null ||
    record.target2 != null;
  if (!hasAnyPrice) return null;
  return {
    strategyId: record.strategyId ?? null,
    strategyName: record.strategyName ?? null,
    risk: '',
    holding: record.holdDays ? `${record.holdDays.min}~${record.holdDays.max}` : null,
    suggestPositionPct: 0,
    buyLow: record.buyLow ?? null,
    buyHigh: record.buyHigh ?? null,
    buyMid:
      record.buyLow != null && record.buyHigh != null
        ? (record.buyLow + record.buyHigh) / 2
        : null,
    buyBasis: record.buyBasis ?? '',
    buyBlockedByLimitUp: record.buyBlockedByLimitUp === true,
    stop: record.stop ?? null,
    stopBasis: '',
    stopLossPct: null,
    target1: record.target1 ?? null,
    target1Basis: '',
    target1GainPct: null,
    target2: record.target2 ?? null,
    target2Basis: '',
    target2GainPct: null,
    addPrice: null,
    addBasis: '',
    profitLossRatio: null,
    missing: Array.isArray(record.missing) ? record.missing : [],
    note: '历史记录快照（来自交易明细），非当前实时评估',
  };
}

/**
 * 决定 K 线实际画哪条战法线。
 * - showPlan=false（默认）：一律不画，返回 null。
 * - showPlan=true：优先用 overridePlan（历史记录线，从交易明细进来才有）；
 *   没有 override 才回落 livePlan（实时线，自选股等入口）。
 */
export function resolveChartPlan(
  showPlan: boolean,
  overridePlan: TradePlan | null,
  livePlan: TradePlan | null,
): TradePlan | null {
  if (!showPlan) return null;
  return overridePlan ?? livePlan ?? null;
}

/** 战法信号区的「记录战法」分组标题文案（验收点 3：明确写出「记录战法：首板打板」） */
export function recordedStrategyLabel(strategyName: string | null | undefined): string {
  const name = (strategyName ?? '').trim();
  return name ? `记录战法：${name}` : '记录战法';
}

export interface SignalGroup {
  kind: 'recorded' | 'live';
  label: string;
  plan: TradePlan | null;
  strategyName: string | null;
}

/**
 * 组织「战法信号」区域的两部分内容。
 * - 若传了 overridePlan/overrideStrategyName，先放「记录战法」组（历史计划）；
 * - 再放实时命中战法组（保留 /api/eval 的结果）。
 * 两组可并存；实时无命中时 live 组仍以 plan/name 呈现（若 livePlan 存在），否则不产生 live 组。
 */
export function buildSignalGroups(
  overridePlan: TradePlan | null,
  overrideStrategyName: string | null | undefined,
  livePlan: TradePlan | null,
): SignalGroup[] {
  const groups: SignalGroup[] = [];
  if (overridePlan) {
    groups.push({
      kind: 'recorded',
      label: recordedStrategyLabel(overrideStrategyName ?? overridePlan.strategyName),
      plan: overridePlan,
      strategyName: overrideStrategyName ?? overridePlan.strategyName ?? null,
    });
  }
  if (livePlan) {
    groups.push({
      kind: 'live',
      label: '实时评估战法',
      plan: livePlan,
      strategyName: livePlan.strategyName ?? null,
    });
  }
  return groups;
}

/**
 * 实时命中战法列表是否需要在「记录战法」之外单独渲染。
 * 用于组件判定：历史记录组 + 实时命中信号列表同时存在。
 */
export function shouldShowBothSections(
  hasOverride: boolean,
  liveSignals: StrategyHit[] | null | undefined,
): boolean {
  return hasOverride && Array.isArray(liveSignals) && liveSignals.length > 0;
}
