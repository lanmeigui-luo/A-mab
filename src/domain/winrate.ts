/**
 * 战法胜率统计 —— P1 数据层核心类型
 *
 * 约定（与 types.ts 一致）：所有「拿不到」的数值字段一律为 null，
 * 禁止使用 0 / 占位值 / 模拟值填充。
 *
 * 字段范围（按需求 spec）：
 *   - 信号快照：日期 / 战法 / 代码 / 名称 / 确定性评分 / 信号强度
 *   - 记录时价格 / 买入区间 / 止损 / 目标1 / 目标2 / 持有周期 / T+1 可卖日期
 *   - 执行明细（见 TradeRecord）：买入日期·价 / 卖出日期·价 / 持有天数 / 收益率 / 卖出原因 / 状态 / 异常标注
 *   - 参数版本 / 补记录标记
 *
 * 注：P1 仅落地数据层（类型 + 存储），记录引擎（P2）、页面（P5）、自绘图表（P3）后续接入。
 */

/** 交易状态 */
export type TradeStatus =
  | 'open' // 已记录、尚未平仓（模拟持有中）
  | 'closed' // 已平仓（收益率已结算，不可再编辑）
  | 'invalid' // 信号失效（v1 仅留接口，引擎后续判定）
  | 'anomaly'; // 数据异常（如价格缺失），仅标记不计入正常胜率

/**
 * 卖出原因。
 * 时间语义（v2-t1-fix 起唯一口径）：A 股 T+1，买入后首个可交易日才能卖；
 * 每根可卖日 K 线按「先判开盘跳空(时间最早) → 再判盘中(双边歧义/单边) → 最后到期」的优先级，
 * 谁先触发谁成交（按时间，不采用「止损优先」保守假设）。
 *  - 开盘跳空（任意可卖日，含 T+1 首可卖日）：open≤stop→stop_gap；open≥target2→target2_gap；open≥target1→target1_gap（按开盘价成交）。
 *  - T+1 首可卖日开盘【未】跳空、但买入当日(T日)已触发某一边 → tplus1_*（按首可卖日开盘价成交，计入分母）。
 *  - 可卖日双边触及（low≤stop 且 high≥target1）→ ambiguous_intraday：可卖日双边排除分母；T日双边(首可卖日未跳空)计入分母仅原因歧义。
 *  - 盘中单边：low≤stop→stop_loss；high≥target2→target2；high≥target1→target1（按对应价成交）。
 */
export type SellReason =
  | 'target1' // 触及目标一（盘中单边）
  | 'target2' // 触及目标二（盘中单边）
  | 'stop_loss' // 触发止损（盘中单边）
  | 'hold_expired' // 持有周期到期（按战法持有上限自动了结）
  | 'signal_invalid' // 信号失效（v1 仅留接口）
  | 'manual' // 手动卖出
  | 'unknown' // 待回填 / 尚未判定
  | 'tplus1_target1' // T+1 首可卖日开盘【未】跳空、但买入当日(T日)已触目标一 → 按首可卖日开盘价成交，计入分母
  | 'tplus1_target2' // T+1 首可卖日开盘未跳空、但T日已触目标二 → 按首可卖日开盘价成交，计入分母
  | 'tplus1_stop_loss' // T+1 首可卖日开盘未跳空、但T日已触止损边 → 按首可卖日开盘价成交，计入分母
  | 'target1_gap' // 任意可卖日(含 T+1 首可卖日)开盘跳空越过目标一（按开盘价成交）
  | 'target2_gap' // 任意可卖日开盘跳空越过目标二（按开盘价成交）
  | 'stop_gap' // 任意可卖日开盘跳空跌破止损（按开盘价成交）
  | 'ambiguous_intraday'; // 日K（仅 OHLC）无法判定盘中 high/low 先后：双边触及。可卖日双边→排除分母；买入当日双边→计入分母仅原因歧义

/**
 * 异常标注（数据质量标记，不参与统计，仅展示提示）。
 * 语义 key 唯一出处在此；中文文案统一由 ANOMALY_LABELS 提供，
 * 任何逻辑层只使用英文 key，展示层再从 ANOMALY_LABELS 取中文。
 */
export type WinRateAnomaly =
  | 'high_open_unfilled' // 次日高开，未成交
  | 'limit_up_unfilled' // 次日一字涨停，未成交
  | 'unbuyable' // 不可买入（如已退市）
  | 'suspended_deferred' // 停牌顺延（按 suspensionRanges 跳过）
  | 'suspended_volume_zero' // 停牌顺延兜底（volume=0）
  | 'delisted_closed' // 已退市，无法回测
  | 'data_missing' // 数据缺失（K 线断档）
  | 'new_stock_no_limit_check' // 次新股，跳过一字板判定
  | 'backfilled' // 由补记录流程产生（非实时触发）
  | 'high_open_over_target1' // 买入当日开盘价已 ≥ 目标一，计划失效未成交
  | 'param_changed'; // 参数版本变更

/** 异常标注中文文案（唯一出处；逻辑层只用 key） */
export const ANOMALY_LABELS: Record<WinRateAnomaly, string> = {
  high_open_unfilled: '高开未成交',
  limit_up_unfilled: '一字板未成交',
  unbuyable: '不可买入',
  suspended_deferred: '停牌顺延',
  suspended_volume_zero: '停牌顺延(volume=0兜底)',
  delisted_closed: '已退市',
  data_missing: '数据缺失',
  new_stock_no_limit_check: '次新股不适用涨停判定',
  backfilled: '补记录',
  param_changed: '参数版本变更',
  high_open_over_target1: '高开越过目标一(未成交)',
};

/** 卖出原因中文文案（UI 唯一出处；逻辑层只用 SellReason key） */
export const SELL_REASON_LABELS: Record<SellReason, string> = {
  target1: '触及目标一',
  target2: '触及目标二',
  stop_loss: '触发止损',
  hold_expired: '持有到期',
  signal_invalid: '信号失效',
  manual: '手动卖出',
  unknown: '待判定',
  tplus1_target1: 'T+1触目标一(次日开盘)',
  tplus1_target2: 'T+1触目标二(次日开盘)',
  tplus1_stop_loss: 'T+1止损(次日开盘)',
  target1_gap: '跳空触目标一',
  target2_gap: '跳空触目标二',
  stop_gap: '跳空止损',
  ambiguous_intraday: '日K无法判定盘中先后',
};

/**
 * 取某笔交易的「触发阈值价」（触发成交的价格门槛）：
 *  - 目标 / 跳空原因 → 对应 target1 / target2；止损原因 → stop；
 *  - 其余（到期 / 未知 / 歧义 / 手动 / 失效）→ null。
 * 注意：实际成交价（sellPrice）可能因开盘跳空而偏离该阈值，二者需分开展示。
 */
export function tradeTriggerPrice(record: WinRateRecord): number | null {
  const r = record.trade.sellReason;
  if (r === 'target1' || r === 'target1_gap' || r === 'tplus1_target1') return record.target1;
  if (r === 'target2' || r === 'target2_gap' || r === 'tplus1_target2') return record.target2;
  if (r === 'stop_loss' || r === 'stop_gap' || r === 'tplus1_stop_loss') return record.stop;
  return null;
}

/** 交易执行规则说明（UI 展示用：触发价 / 歧义 / 历史规则标识） */
export function tradeRuleNote(record: WinRateRecord): string {
  const sr = SELL_REASON_LABELS[record.trade.sellReason];
  const tp = tradeTriggerPrice(record);
  let s = sr;
  if (tp != null) s += `（触发价 ${tp.toFixed(2)}）`;
  if (record.trade.excludedFromStats) s += ' · 日K歧义已排除分母';
  else if (record.trade.sellReason === 'ambiguous_intraday') s += ' · 日K无法判定盘中先后(计入)';
  if (record.trade.ruleVersion === 'v1-legacy') s += ' · 历史规则记录';
  return s;
}

/** 交易状态中文文案（UI 唯一出处） */
export const TRADE_STATUS_LABELS: Record<TradeStatus, string> = {
  open: '持仓中',
  closed: '已平仓',
  invalid: '未成交',
  anomaly: '异常',
};

/** 信号强度来源（v1 取 StrategyHit.hitRatio，预留枚举便于后续切换） */
export type SignalStrengthSource = 'hitRatio';

/** 因子分解（ScoreResult.factors）；直接复用 strategy.ts 的类型，不另定义 */
import type { ScoreFactor } from './strategy';

/**
 * TradeRecord：单次模拟买入 → 卖出的执行明细。
 * 只增不改；状态为 closed 后不可再编辑。
 */
export interface TradeRecord {
  /** 买入日期 YYYY-MM-DD；T+1 实际可买日可能为记录日后首个交易日 */
  buyDate: string | null;
  /** 买入价（元）；记录时无成交模拟则为 null */
  buyPrice: number | null;
  /** 卖出日期 YYYY-MM-DD；未卖出为 null */
  sellDate: string | null;
  /** 卖出价（元）；未卖出为 null */
  sellPrice: number | null;
  /** 实际持有天数（交易日）；未平仓为 null */
  holdDays: number | null;
  /** 收益率 % = (sellPrice - buyPrice) / buyPrice * 100；未平仓为 null */
  returnPct: number | null;
  /** 卖出原因（v1 仅记录字段） */
  sellReason: SellReason;
  /** 交易状态 */
  status: TradeStatus;
  /** 异常标注（可叠加多条） */
  anomalies: WinRateAnomaly[];
  /** 是否由补记录流程产生（非应用打开时实时触发） */
  backfilled: boolean;
  /** 结算规则版本（v2-t1-fix 起）：区分旧规则（v1-legacy，目标价成交口径错误）与新规则 */
  ruleVersion?: string;
  /** 失效 / 排除原因说明（如旧规则记录标「目标价成交口径错误」） */
  invalidReason?: string;
  /** 是否从胜率分母中排除（日K歧义等）：true=不计入胜率/盈亏比，但仍可在明细表查看 */
  excludedFromStats?: boolean;
}

/** 价格/信号来源口径：区分盘中尾盘快照与未来收盘快照，统计层据此隔离，不可混算 */
export type PriceSource = 'intraday_late' | 'close';

/**
 * WinRateRecord：一条「战法信号 → 模拟交易」的完整记录。
 * 由记录引擎（P2）在应用打开时检查并补记录；P1 仅定义数据层。
 */
export interface WinRateRecord {
  /** 唯一 id（创建时生成，导入去重用） */
  id: string;
  /** 记录日期 YYYY-MM-DD（功能启用后的真实日期，不补伪造历史） */
  date: string;
  /** 战法 id（对应后端 STRATEGY_DEFS.id） */
  strategyId: string;
  /** 战法名称快照 */
  strategyName: string;
  /** 6 位代码 */
  code: string;
  /** 名称快照 */
  name: string;
  /** 确定性评分（ScoreResult.total）；拿不到为 null */
  determinismScore: number | null;
  /** 因子分解（ScoreResult.factors）历史快照；落库时一并保存，供 P5 单笔详情展示各因子贡献；旧记录缺省为 null */
  scoreFactors?: ScoreFactor[] | null;
  /** 信号强度（v1 取 StrategyHit.hitRatio）；拿不到为 null */
  signalStrength: number | null;
  /** 信号强度来源（v1 固定 'hitRatio'） */
  signalStrengthSource: SignalStrengthSource;
  /** 记录时价格（元）；拿不到为 null */
  recordedPrice: number | null;
  /** 买入区间（元）；拿不到为 null */
  buyLow: number | null;
  buyHigh: number | null;
  /** 止损价（元）；拿不到为 null */
  stop: number | null;
  /** 目标价（元）；拿不到为 null */
  target1: number | null;
  target2: number | null;
  /** 持有周期（交易日），由战法 holding 推导；拿不到为 null */
  holdDays: { min: number; max: number } | null;
  /** T+1 可卖日期（A 股 T+1，首个可卖出交易日）；拿不到为 null */
  tPlus1SellDate: string | null;
  /** 战法参数快照版本（对应 winrate-config 的 paramVersion） */
  paramVersion: string;
  /** 结算规则版本（v2-t1-fix 起）：标记该记录按哪版卖出判定口径生成 */
  ruleVersion?: string;
  /** 失效 / 排除原因说明（如旧规则记录标「目标价成交口径错误」） */
  invalidReason?: string;
  /** 是否由补记录流程产生 */
  backfilled: boolean;
  /** 记录时刻 ISO（含时分秒）；盘中尾盘快照 vs 收盘快照的区分依据 */
  recordedAt: string | null;
  /** 价格/信号来源口径：intraday_late=14:50-15:00 盘中尾盘快照；close=后端收盘快照（未来） */
  priceSource: PriceSource | null;
  /** 该记录所属战法当日命中样本是否不足（命中数 < RECORD_TOP_N=5）；统计层据此标记样本不足。默认 false */
  insufficientHits: boolean;
  /** 执行明细 */
  trade: TradeRecord;
}

/** priceSource 分口径统计（P3 新增）：同一战法下按数据来源拆出的两组独立统计 */
export interface PriceSourceBreakdown {
  /** 盘中尾盘快照（intraday_late）口径统计；无该来源记录为 null */
  intraday_late: WinRateStats | null;
  /** 收盘快照（close）口径统计；无该来源记录为 null */
  close: WinRateStats | null;
}

/** WinRateStats：单战法胜率聚合（P3/P5 页面用；P1 仅定义类型） */
export interface WinRateStats {
  strategyId: string;
  strategyName: string;
  /** 信号总数 */
  total: number;
  /** 已平仓数 */
  closed: number;
  /** 盈利数（returnPct > 0） */
  wins: number;
  /** 亏损数（returnPct <= 0） */
  losses: number;
  /** 胜率 = wins / closed；无平仓为 null */
  winRate: number | null;
  /** 平均收益率 %；无平仓为 null */
  avgReturnPct: number | null;
  /** 平均持有天数；无平仓为 null */
  avgHoldDays: number | null;
  /** 盈亏比（总盈利 / 总亏损绝对值）；无亏损为 null */
  profitFactor: number | null;
  /** 信号失效数 */
  invalidCount: number;
  /** 异常标注数（含任意 anomaly 的记录数） */
  anomalyCount: number;
  /** 有效样本不足（closed < 10）标记；true 时胜率仅供参考 */
  insufficientSample: boolean;
  /** 最大回撤 %（基于该战法 closed 有效记录的累计收益曲线）；样本不足为 null */
  maxDrawdown: number | null;
  /** 命中样本不足（insufficientHits）记录数；供「样本不足命中占比」展示 */
  insufficientHitsCount: number;
  /** 最大单笔盈利 %（closed 有效记录中收益率最高的一笔；无盈利为 null） */
  maxProfitPct: number | null;
  /** 最大单笔亏损 %（closed 有效记录中收益率最低的一笔，为负值；无亏损为 null） */
  maxLossPct: number | null;
  /** 持有天数为空（未平仓/异常）的记录数；不计入持有周期分布，单独计数 */
  unbucketedCount: number;
  /** 因日K歧义（ambiguous_intraday）被排除出分母的记录数 */
  ambiguousExcluded: number;
  /** 歧义比例 = 全部 ambiguous_intraday 笔数 / 总记录数（>20% 提示胜率置信度低）；无记录为 null */
  ambiguityRate: number | null;
  /** 数据来源分口径统计（P3 新增）；intraday_late 与 close 不可混算，须分别查看 */
  priceSourceBreakdown?: PriceSourceBreakdown;
}

/** 生成记录唯一 id（优先 crypto.randomUUID，降级时间戳+随机） */
export function genWinRateRecordId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `wr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ════════════════════════════════════════════════════════════════════════════
// 收盘快照（口径 A） payload 类型
// 后端 server/winrateSnapshot.mjs 落盘的数据形状；前端拉取后转为 WinRateRecord。
// priceSource 固定 'close'，与盘中尾盘快照（intraday_late）统计层隔离、不可混算。
// ════════════════════════════════════════════════════════════════════════════

/** 快照中的单条命中（由后端 projectHit 投影自 ScreenHit，剔除体积大的 indicators / conds） */
export interface WinRateSnapshotHit {
  fullCode: string;
  code: string;
  name: string;
  /** 记录时价格（收盘快照 = 当日收盘价） */
  price: number | null;
  limitUp: { isLimitUp: boolean };
  /** 确定性评分（ScoreResult.total） */
  determinismScore: number | null;
  /** 因子分解（ScoreResult.factors），供单笔详情展示各因子贡献 */
  scoreFactors: ScoreFactor[] | null;
  /** 命中战法（含 hitRatio），前端取本战法 signalStrength */
  strategies: { id: string; hitRatio: number }[];
  /** 买卖计划（买区间 / 止损 / 目标） */
  tradePlan: {
    buyLow: number | null;
    buyHigh: number | null;
    stop: number | null;
    target1: number | null;
    target2: number | null;
  };
}

/** 快照中单个战法的命中集合 */
export interface WinRateSnapshotStrategy {
  strategyId: string;
  strategyName: string;
  /** 该战法当日命中数 < TOP_N（样本不足）；统计层据此标记样本不足 */
  insufficientHits: boolean;
  hits: WinRateSnapshotHit[];
}

/** 单日收盘快照（data/snapshots/YYYY-MM-DD.json 的内容） */
export interface WinRateSnapshot {
  date: string;
  generatedAt: string;
  priceSource: 'close';
  topN: number;
  strategies: WinRateSnapshotStrategy[];
}
