/** 战法选股（阶段 2）相关类型 */

export interface StrategyDef {
  id: string;
  name: string;
  /** 分组：打板类 / 趋势类 / 回调类 / 量价类 / 事件类 */
  category: string;
  desc: string;
  params: Record<string, number>;
  risk: string;
  holding: string;
  /** false 表示数据源未接入，不产生任何信号 */
  available: boolean;
  /** 未接入原因，前端原样展示 */
  unavailableReason?: string;
  /** 历史胜率参考（战法自带，非实盘保证） */
  winRateNote?: string;
  riskNote?: string;
  /** 选股/买卖时间窗（尾盘类战法才有） */
  window?: {
    select: string;
    buy: string;
    sell: string;
  } | null;
  /** 是否支持复盘模式（非交易时段用最近交易日数据演算） */
  reviewable?: boolean;
}

export interface StrategyCond {
  key: string;
  pass: boolean;
  /** 数据缺失、不参与判定（三态：pass / fail / na） */
  na?: boolean;
  detail: string;
}

export interface StrategyHit {
  id: string;
  name: string;
  hitRatio: number;
  conds: StrategyCond[];
}

export interface ScoreFactor {
  key: string;
  name: string;
  weight: number;
  score: number | null;
  available: boolean;
  detail: string;
}

export interface ScoreResult {
  total: number | null;
  /** 情绪乘数作用前的原始总分 */
  baseTotal?: number | null;
  /** 情绪周期乘数（1 = 晋级率未取到，不参与调节） */
  multiplier?: number;
  /** 主升 / 震荡 / 退潮 / null */
  cycle?: string | null;
  factors: ScoreFactor[];
  missingFactors: string[];
  coverage: number;
  note: string;
}

/** 买卖价推荐（规则引擎计算，需求 7.3） */
export interface TradePlan {
  strategyId: string | null;
  strategyName: string | null;
  risk: string;
  holding: string | null;
  suggestPositionPct: number;
  buyLow: number | null;
  buyHigh: number | null;
  buyMid: number | null;
  buyBasis: string;
  /** 涨停时不给出买入区间 */
  buyBlockedByLimitUp: boolean;
  stop: number | null;
  stopBasis: string;
  stopLossPct: number | null;
  target1: number | null;
  target1Basis: string;
  target1GainPct: number | null;
  target2: number | null;
  target2Basis: string;
  target2GainPct: number | null;
  addPrice: number | null;
  addBasis: string;
  profitLossRatio: number | null;
  /** 输入缺失清单 */
  missing: string[];
  note: string;
  /** 隔夜持股法专有：次日强制卖出窗口 */
  sellWindow?: string | null;
  /** 隔夜持股法专有：次日开盘 5 种情形的处置规则 */
  sellRules?: SellRule[] | null;
  /** 隔夜持股法专有：隔夜风险提示 */
  overnightRisk?: string | null;
}

/** 次日卖出情形处置（隔夜持股法） */
export interface SellRule {
  case: string;
  action: string;
}

export interface ScreenHit {
  fullCode: string;
  code: string;
  name: string;
  price: number | null;
  prevClose: number | null;
  changePct: number | null;
  turnoverRate: number | null;
  amountYuan: number | null;
  floatMvYi: number | null;
  pe: number | null;
  /** 所属板块（需求第三章列表字段） */
  boardName?: string | null;
  boardPct?: number | null;
  limitUp: { isLimitUp: boolean; limitType?: string; threshold?: number };
  indicators: {
    ma5: number | null;
    ma10: number | null;
    ma20: number | null;
    ma60: number | null;
    volRatio20: number | null;
    chg20: number | null;
    bias20: number | null;
    high30: number | null;
    bars: number;
  };
  strategies: StrategyHit[];
  score: ScoreResult;
  /** 买卖价推荐 */
  tradePlan?: TradePlan | null;
}

export interface ScreenResponse {
  ok: boolean;
  reason?: string;
  trading: boolean;
  /** 未开盘时排行榜排序字段全为 0，需改用自定义候选池 */
  needCustomPool?: boolean;
  poolSize: number;
  /** 快照预筛前扫描的候选数（隔夜战法会自动放大池子） */
  poolScanned?: number;
  /** 快照预筛剔除数 */
  prefiltered?: number;
  hitCount: number;
  hits: ScreenHit[];
  elapsedMs: number;
  errors: string[];
  source: { pool: string; quote: string; kline: string };
  notes: string[];
  cached?: boolean;
  /** 隔夜持股法的取数情况与空仓门禁 */
  overnight?: OvernightMeta | null;
}

/** 隔夜持股法的运行元信息（命中为 0 时用它解释原因） */
export interface OvernightMeta {
  intradayGot?: number;
  ipoGot?: number;
  belongMapped?: number;
  belongFailed?: number;
  elapsedMs?: number;
  errors?: string[];
  prefiltered?: number;
  /** 情绪周期触发强制空仓 */
  emptyBySentiment: boolean;
  retreatDetail: string | null;
  emptyHint: string;
  /** 最接近但被卡住的候选（按卡点数量升序） */
  nearMiss?: NearMiss[];
  /** 卡点统计：哪条条件卡掉了最多候选 */
  blockedTop?: BlockedStat[];
}

export interface NearMiss {
  code: string;
  name: string;
  changePct: number | null;
  turnoverRate: number | null;
  floatMvYi: number | null;
  /** 未通过的条件名 */
  blockedBy: string[];
  failed: { key: string; detail: string }[];
}

export interface BlockedStat {
  key: string;
  count: number;
}
