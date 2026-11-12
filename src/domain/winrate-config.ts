/**
 * 战法 → 持有周期 / 买卖规则 映射（P1 数据层）
 *
 * 数据来源：后端 server/strategies/index.mjs 的 STRATEGY_DEFS
 * （真实 id / holding / available）。前端 domain/strategy.ts 仅定义类型、不含清单，
 * 故此处基于已核对的 STRATEGY_DEFS 落地映射，并标记参数快照版本。
 * 后端策略参数若调整，应升版 STRATEGY_PARAM_VERSION 并同步各 entry.paramVersion。
 *
 * ⚠️ 本清单为「手工同步自 server/strategies/index.mjs」，后端增删战法需同步此处。
 */

import type { BuyTiming, EntryStyle } from './winrate';

export interface HoldDays {
  min: number;
  max: number;
}

export interface StrategyWinRateConfig {
  strategyId: string;
  strategyName: string;
  /** 持有周期（交易日）；无法映射（如 '—'、未接入）为 null */
  holdDays: HoldDays | null;
  /** 原始 holding 字符串（便于核对，如 '3-10 天'） */
  holdingRaw: string;
  /** 买卖规则说明（v1 文字描述，引擎后续细化） */
  ruleNote: string;
  /** 战法参数快照版本 */
  paramVersion: string;
  /** 买入时机：t_close=记录日收盘买入；t_next_open=记录日次日开盘（默认） */
  buyTiming: BuyTiming;
  /**
   * 盘中买入风格（与 buyTiming 互补、不取代）：盘中实时买入引擎据此决定是否 / 如何盘中触发。
   * 详见 winrate.ts 的 EntryStyle 注释。历史旧 WinRateRecord 无此字段时按 daily_only 处理。
   */
  entryStyle: EntryStyle;
  /** 是否可用于胜率统计（false = 数据源未接入，不产生信号） */
  enabled: boolean;
}

/** 战法参数快照版本：与本次 P1 落地时后端 STRATEGY_DEFS 对齐 */
export const STRATEGY_PARAM_VERSION = '2026-09-28';

/**
 * 结算规则版本（v2-t1-fix 起）：标识交易模拟引擎的卖出判定口径。
 *  - v1-legacy：旧规则，目标价被当作固定成交价、忽略开盘跳空，口径有误，已迁移排除分母。
 *  - v2-t1-fix：T+1 可卖日按「先判双边歧义 → 开盘跳空 → 盘中单边 → 到期」优先级，
 *    谁先触发谁成交（按时间，不采用止损优先保守假设）；开盘跳空按开盘价成交。
 * 落库于 TradeRecord.ruleVersion / WinRateRecord.ruleVersion，供统计层区分新旧记录、明细表展示。
 */
export const TRADE_RULE_VERSION = 'v2-t1-fix';

/**
 * 记录窗口截止时刻（HH:MM，本地时区）。P2b 短期方案：仅在该窗口（14:50-15:00 交易时段内）
 * 应用打开才触发当日信号记录；窗口外只结算历史 open 记录，不做新记录。
 * 15:00 后打开且当日无记录 → 当日标记「待后端快照」（见 useWinRateRecorder.getPendingDays），不写假记录。
 */
export const DEFAULT_RECORD_CUTOFF = '14:50';

/** 解析 holding 字符串 → 数值区间；无法解析返回 null（如 '—'、'T+0'） */
function parseHoldDays(holding: string): HoldDays | null {
  const t = (holding ?? '').trim();
  if (t === '次日' || t === '1 天' || t === 'T+1') return { min: 1, max: 1 };
  const range = t.match(/^(\d+)\s*-\s*(\d+)\s*天$/);
  if (range) {
    const min = parseInt(range[1], 10);
    const max = parseInt(range[2], 10);
    if (min > 0 && max >= min) return { min, max };
  }
  const single = t.match(/^(\d+)\s*天$/);
  if (single) {
    const d = parseInt(single[1], 10);
    if (d > 0) return { min: d, max: d };
  }
  return null;
}

interface RawDef {
  id: string;
  name: string;
  holding: string;
  available: boolean;
  buyTiming: BuyTiming;
  entryStyle: EntryStyle;
  ruleNote: string;
}

/**
 * 已核对的后端 STRATEGY_DEFS 子集（id / name / holding / available / 规则说明）
 *
 * entryStyle 映射依据（用户拍板，与 buyTiming 互补、不取代）：
 *  - instant（打板 / 开盘判定类）：首板打板、连板晋级、龙头战法、超短线战法
 *    → 买入日 9:30 第一分钟按开盘价一次性判定，高开超限 / 一字板 / 低开即未成交。
 *  - intraday_limit（低吸 / 趋势类）：趋势突破、均线多头、低吸回踩、龙回头、超跌反弹、量价齐升
 *    → 买入日盘中每分钟检查价格是否进入 [buyLow,buyHigh]，落入即买；14:50 未触发交日K兜底翻案。
 *  - daily_only（尾盘买入口径）：隔夜持股法（决策点 1，次日开盘绝不参与盘中监控）、
 *    事件驱动（未接入，不产生信号）→ 完全交给日K结算。
 */
const RAW_DEFS: RawDef[] = [
  { id: 'first-board', name: '首板打板', holding: '次日', available: true, buyTiming: 't_close_or_next_open', entryStyle: 'instant', ruleNote: '记录日收盘优先、封板或超区间顺延次日；次日冲高或封板走弱即离场，持股 ≤1 个交易日' },
  { id: 'board-advance', name: '连板晋级', holding: '次日', available: true, buyTiming: 't_next_open', entryStyle: 'instant', ruleNote: '次日换手晋级失败即离场，持股 ≤1 个交易日' },
  { id: 'trend-break', name: '趋势突破', holding: '5-20 天', available: true, buyTiming: 't_next_open', entryStyle: 'intraday_limit', ruleNote: '突破后沿趋势持有 5-20 个交易日，跌破关键支撑离场' },
  { id: 'ma-bull', name: '均线多头', holding: '10-30 天', available: true, buyTiming: 't_next_open', entryStyle: 'intraday_limit', ruleNote: '均线多头排列中持有 10-30 个交易日，均线走坏离场' },
  { id: 'dragon', name: '龙头战法', holding: '1-5 天', available: true, buyTiming: 't_close_or_next_open', entryStyle: 'instant', ruleNote: '记录日收盘优先、封板或超区间顺延次日；龙头主升持有 1-5 个交易日，断板即走' },
  { id: 'pullback-buy', name: '低吸回踩', holding: '3-10 天', available: true, buyTiming: 't_close_or_next_open', entryStyle: 'intraday_limit', ruleNote: '记录日收盘优先、未进伏击圈顺延次日；回踩确认后持有 3-10 个交易日，放量跌破防守线离场' },
  { id: 'dragon-return', name: '龙回头', holding: '3-10 天', available: true, buyTiming: 't_next_open', entryStyle: 'intraday_limit', ruleNote: '反攻确认后持有 3-10 个交易日，再度走弱离场' },
  { id: 'oversold-bounce', name: '超跌反弹', holding: '3-10 天', available: true, buyTiming: 't_next_open', entryStyle: 'intraday_limit', ruleNote: '反弹确认后持有 3-10 个交易日，反弹衰竭离场' },
  { id: 'ultra-short', name: '超短线战法', holding: '1-3 天', available: true, buyTiming: 't_next_open', entryStyle: 'instant', ruleNote: '持股 1-3 个交易日，次日不强即走' },
  { id: 'volume-price-up', name: '量价齐升', holding: '3-15 天', available: true, buyTiming: 't_next_open', entryStyle: 'intraday_limit', ruleNote: '量价配合持有 3-15 个交易日，量价背离离场' },
  { id: 'overnight-hold', name: '隔夜持股法', holding: '1 天', available: true, buyTiming: 't_close', entryStyle: 'daily_only', ruleNote: '尾盘买入、次日 10:00 前强制卖出，持仓仅 1 个交易日' },
  { id: 'event', name: '事件驱动', holding: '—', available: false, buyTiming: 't_next_open', entryStyle: 'daily_only', ruleNote: '数据源未接入，不产生信号（holding=—）' },
];

/** 战法 → 胜率配置映射表（P1 落地全量，由 STRATEGY_DEFS 核对） */
export const WINRATE_STRATEGY_CONFIG: Record<string, StrategyWinRateConfig> = Object.fromEntries(
  RAW_DEFS.map((d): [string, StrategyWinRateConfig] => [
    d.id,
    {
      strategyId: d.id,
      strategyName: d.name,
      holdDays: parseHoldDays(d.holding),
      holdingRaw: d.holding,
      buyTiming: d.buyTiming,
      entryStyle: d.entryStyle,
      ruleNote: d.ruleNote,
      paramVersion: STRATEGY_PARAM_VERSION,
      enabled: d.available,
    },
  ]),
);

/** 取单战法配置（不存在返回 undefined） */
export function getWinRateConfig(strategyId: string): StrategyWinRateConfig | undefined {
  return WINRATE_STRATEGY_CONFIG[strategyId];
}

/** 可用于胜率统计的战法（enabled 且持有周期可映射） */
export function listEnabledStrategies(): StrategyWinRateConfig[] {
  return Object.values(WINRATE_STRATEGY_CONFIG).filter((c) => c.enabled && c.holdDays !== null);
}

/** 无法映射 / 未接入的战法（供汇报缺失项） */
export function listUnmappedStrategies(): StrategyWinRateConfig[] {
  return Object.values(WINRATE_STRATEGY_CONFIG).filter((c) => !c.enabled || c.holdDays === null);
}

/**
 * 买卖计划参数冲突校验：合规区间必须满足
 *   stop < buyLow ≤ buyHigh < target1 < target2
 * 任一为 null（未知）则视为不可校验 → 返回 ok（不拦截，交结算逻辑降级处理）。
 * 违规返回 ok=false 并附中文 reason。记录引擎在落库前调用：违规的 tradePlan 不生成该记录。
 */
export function validateWinRateParams(
  stop: number | null,
  buyLow: number | null,
  buyHigh: number | null,
  target1: number | null,
  target2: number | null,
): { ok: boolean; reason?: string } {
  if ([stop, buyLow, buyHigh, target1, target2].some((v) => v == null)) return { ok: true };
  const s = stop as number;
  const bl = buyLow as number;
  const bh = buyHigh as number;
  const t1 = target1 as number;
  const t2 = target2 as number;
  if (!(s < bl)) return { ok: false, reason: '止损价须低于买入区间下限' };
  if (!(bl <= bh)) return { ok: false, reason: '买入区间下限须 ≤ 上限' };
  if (!(bh < t1)) return { ok: false, reason: '买入区间上限须低于目标一' };
  if (!(t1 < t2)) return { ok: false, reason: '目标一须低于目标二' };
  return { ok: true };
}
