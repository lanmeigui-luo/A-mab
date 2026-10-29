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
  /** 是否可用于胜率统计（false = 数据源未接入，不产生信号） */
  enabled: boolean;
}

/** 战法参数快照版本：与本次 P1 落地时后端 STRATEGY_DEFS 对齐 */
export const STRATEGY_PARAM_VERSION = '2026-09-28';

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
  ruleNote: string;
}

/** 已核对的后端 STRATEGY_DEFS 子集（id / name / holding / available / 规则说明） */
const RAW_DEFS: RawDef[] = [
  { id: 'first-board', name: '首板打板', holding: '次日', available: true, ruleNote: '次日冲高或封板走弱即离场，持股 ≤1 个交易日' },
  { id: 'board-advance', name: '连板晋级', holding: '次日', available: true, ruleNote: '次日换手晋级失败即离场，持股 ≤1 个交易日' },
  { id: 'trend-break', name: '趋势突破', holding: '5-20 天', available: true, ruleNote: '突破后沿趋势持有 5-20 个交易日，跌破关键支撑离场' },
  { id: 'ma-bull', name: '均线多头', holding: '10-30 天', available: true, ruleNote: '均线多头排列中持有 10-30 个交易日，均线走坏离场' },
  { id: 'dragon', name: '龙头战法', holding: '1-5 天', available: true, ruleNote: '龙头主升持有 1-5 个交易日，断板即走' },
  { id: 'pullback-buy', name: '低吸回踩', holding: '3-10 天', available: true, ruleNote: '回踩确认后持有 3-10 个交易日，放量跌破防守线离场' },
  { id: 'dragon-return', name: '龙回头', holding: '3-10 天', available: true, ruleNote: '反攻确认后持有 3-10 个交易日，再度走弱离场' },
  { id: 'oversold-bounce', name: '超跌反弹', holding: '3-10 天', available: true, ruleNote: '反弹确认后持有 3-10 个交易日，反弹衰竭离场' },
  { id: 'ultra-short', name: '超短线战法', holding: '1-3 天', available: true, ruleNote: '持股 1-3 个交易日，次日不强即走' },
  { id: 'volume-price-up', name: '量价齐升', holding: '3-15 天', available: true, ruleNote: '量价配合持有 3-15 个交易日，量价背离离场' },
  { id: 'overnight-hold', name: '隔夜持股法', holding: '1 天', available: true, ruleNote: '尾盘买入、次日 10:00 前强制卖出，持仓仅 1 个交易日' },
  { id: 'event', name: '事件驱动', holding: '—', available: false, ruleNote: '数据源未接入，不产生信号（holding=—）' },
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
