/**
 * winrate-sim.ts —— P2a 纯函数：单条战法信号的模拟交易引擎（T+1 回测）
 *
 * 设计原则：纯函数、无副作用、不读 localStorage / 不调 API / 不碰 React。
 * 输入一条 WinRateRecord（信号快照 + 买入区间/止损/目标/持有周期）+ 该股日 K 数组，
 * 输出更新后的 trade 明细（不改输入对象）。
 *
 * ───────────────────────────────────────────────────────────────────────
 * 核心规则（写在此处为唯一口径来源）：
 *
 * 【买入时机 buyTiming】支持三种时机（由 WinRateRecord.buyTiming 决定，缺省 t_next_open）：
 *  - t_next_open（次日开盘买入，默认）：
 *      · 买入日 = 记录日下一交易日(buyDay)；买入价 = buyDay 开盘价。
 *      · 未成交 → status=invalid：高开未成交(high_open_unfilled) / 一字涨停未成交(limit_up_unfilled) /
 *        开盘即≥目标一(high_open_over_target1) / 次新股跳过一字板判定(new_stock_no_limit_check 软提示)。
 *  - t_close（记录日当天收盘买入）：
 *      · 买入日 = 记录日自身(buyDay = record.date)；买入价 = 记录日收盘价。
 *      · 未成交 → status=invalid：收盘低于买低(low_close_unfilled) / 收盘高于买高(high_close_unfilled) /
 *        收盘封死涨停(limit_up_filled_close，排除分母)。
 *      · 不执行一字板/高开判定（入场价是收盘价，无跳空）。
 *  - t_close_or_next_open（记录日收盘优先，买不到顺延次日）：
 *      · 记录日收盘价 ∈ [buyLow,buyHigh] 且未封死涨停 → 按记录日收盘价成交，买入日=记录日。
 *      · 否则（收盘过高/过低、或封死涨停）→ 顺延次日，完全按 t_next_open 规则判定；
 *        顺延会重绑 buyIdx，因此 T+1 可卖日按【实际买入日】计算，不会提前一天。
 *      · 纯 t_close 的封板拦截不变；仅混合时机才顺延。顺延可用 trade.buyDate !== record.date 推断。
 *  - A 股 T+1：首次可卖出日 = 实际买入日下一交易日；三种时机统一 tPlus1SellDate = buyIdx + 1。
 *  - 买入日触发标记（buyDay*Hit）仅对 t_next_open 有效：t_close 按收盘价买入，
 *    当日盘中 low/high 发生在买入之前，不能驱动次日 tplus1_*（时间倒错修复）。
 *  - 收盘确认动态规则：盘中固定阈值/双边歧义/盘中单边都未触发时，按当日收盘判
 *    战法专属动态离场（见 dynamicExitReason），按收盘价成交、计入分母。
 *    连板池 / 分时 / 10:00 时点等日K无法复现的条件一律不进引擎，不硬凑。
 *  - 交易日历 = K 线日期序列（本引擎不依赖任何外部日历工具）。
 *
 * 【未成交 → 信号失效(invalid)】
 *  - 次日开盘价 > buyHigh → 高开未成交：status=invalid, anomaly='high_open_unfilled'。
 *  - 次日一字涨停（open==high==low==close 且达到涨停容差）：status=invalid, anomaly='limit_up_unfilled'。
 *    （一字板判定优先于高开判定，避免把一字板误标成普通高开；仅 t_next_open 时机执行。）
 *  - 涨停判定仅在「非次新股」时执行；次新股（记录日前 K 线 < 5 根）仍可买入（按开盘价正常成交），
 *    仅涨停判定因历史不足不可靠，故跳过一字板判定并标注 anomaly='new_stock_no_limit_check'（软提示，不使信号失效）。
 *  - 收盘买入时机(t_close)：记录日收盘 < buyLow → low_close_unfilled；> buyHigh → high_close_unfilled。
 *
 * 【涨停幅度 limitPct 映射】（按代码前缀 + ST 状态）
 *  - 60/00 主板：非 ST 0.10，ST 0.05
 *  - 30 创业板：0.20（ST 沿用 0.20）
 *  - 688 科创板：0.20（ST 沿用 0.20）
 *  - 8/4 北交所：0.30
 *  - 涨跌幅判据用容差：(close - prevClose) / prevClose >= limitPct - 0.005，禁止 ==
 *  - prevClose 取 buyDay 前一根 K 线收盘价。
 *
 * 【复权口径】涨停判定应基于「不复权日 K」(adjust='none')。当前腾讯/新浪通道均支持
 *   fq='none'；通达信通道默认 qfq。若上游传入的是 qfq 日 K，除权日附近涨停判定可能有误差，
 *   本引擎对此不修正，仅在此声明已知限制。
 *
 * 【卖出判定（从 T+1 首可卖日逐根扫描）】每根可卖日 K 线按「时间优先级」判定（谁先触发谁成交）：
 *   ⚠️ 日K 仅 OHLC，无法判定「盘中 high 与 low 的先后」，故分两层降级处理（非「止损优先」保守假设）：
 *   ① 开盘跳空（时间上最早发生，优先级最高）：open≤stop→stop_gap；open≥target2→target2_gap；open≥target1→target1_gap
 *        （按开盘价成交，任意可卖日含 T+1 首可卖日；开盘即触及，无需分时数据判定盘中先后）。
 *   ② 开盘未跳空、且仅首可卖日检查「买入当日(T日)是否已有触发标记」（成交按首可卖日开盘价，计入分母）：
 *        T日双边都触 → ambiguous_intraday（仅原因歧义，excludedFromStats=false）；
 *        T日单边(止损/目标) → tplus1_stop_loss / tplus1_target1 / tplus1_target2。
 *   ③ 盘中（开盘未触发、首可卖日无 T日标记、或非首可卖日）：
 *        双边触及（low≤stop 且 high≥target1）→ ambiguous_intraday（默认 excludedFromStats=true，排除分母）；
 *        单边 → low≤stop→stop_loss；high≥target2→target2；high≥target1→target1（按对应价成交）。
 *   ④ 持有周期到期：到达 holdDays.max 交易日 → 以当日收盘价成交，reason='hold_expired'。
 *
 * 【买入当日（T日）触发 与 T+1 首可卖日 关系】
 *   - T日单边触发 + T+1 首可卖日开盘未跳空 → tplus1_*（按首可卖日开盘价成交，计入分母）。
 *   - T日双边都触 + T+1 首可卖日开盘未跳空 → ambiguous_intraday（excludedFromStats=false，仅原因歧义，计入分母）。
 *   - T+1 首可卖日开盘跳空（无论 T日是否触发）→ *_gap（开盘第一时间成交，计入分母，不标歧义）。
 *   - T+1 首可卖日停牌 → 顺延到下一可交易日，仍按上述规则（顺延后的首可交易日视为「首可卖日」执行 ②）。
 *
 * 【买入当日收盘跌破止损】buyDay.close < stop → 次日（T+1）首可卖日开盘价强制卖出，reason='tplus1_stop_loss'。
 *   （这是独立于上方逐根扫描的「盘前已知水下」路径：买入当天收盘已破位，次日开盘平仓；
 *    优先级位于 ①开盘跳空 之后、②T日触发标记 tplus1_* 之前；不论 T日是否同时触目标，一律走此路径，不得走 ambiguous_intraday。）
 *   注：此路径目前不追加新的 anomaly key（现有枚举无精确对应项），仅以 sellReason='stop_loss' 记录；
 *       如需独立异常标记请在 anomaly 枚举补充后接入（见最终汇报「待确认」）。
 *
 * 【停牌处理】
 *  - suspensionRanges（可选，P2a 仅消费不构造）：若某交易日落在任一 [from,to] 区间内，
 *    跳过该日（顺延），标注 anomaly='suspended_deferred'。
 *  - volume=0：兜底判定为停牌，跳过该日（顺延），标注 anomaly='suspended_volume_zero'。
 *  - 本引擎不做日期跳空检测（不主动推断缺失交易日），仅按传入 K 线逐根消费。
 *  - 持有天数 = 实际成交的交易日 K 线根数（buyDay → sellDay 之间的交易日数）。
 *
 * 【数据缺失】K 线不足以定位买入日 / 卖出日 / 扫描耗尽仍未平仓 → status='anomaly', anomaly='data_missing'。
 * 【已退市】dailyK 为空（无交易数据）→ status='anomaly', anomaly='delisted_closed'。
 *   （'unbuyable' 暂预留：当上游明确标记股票受限/永久停牌时使用，纯 sim 当前不触发。）
 *
 * 【不可变】status 已为 'closed' 的记录原样返回（已平仓不可改）。
 */

import type { WinRateRecord, TradeRecord, WinRateAnomaly, SellReason, BuyTiming } from '../domain/winrate';
import type { KlineRow, MinuteRow } from '../domain/types';
import { TRADE_RULE_VERSION } from '../domain/winrate-config';

export interface SimSuspensionRange {
  from: string; // YYYY-MM-DD 含
  to: string; // YYYY-MM-DD 含
}

export interface SimOptions {
  /** 停牌区间（P2a 仅消费不构造）；命中则跳过并标 suspended_deferred */
  suspensionRanges?: SimSuspensionRange[];
  /** ST 状态；缺省由 record.name 前缀(ST/*ST)推导 */
  isST?: boolean;
  /**
   * 【预留】分钟线数据：接入后按时间戳判定「盘中 high/low 先后」，消除日K歧义（ambiguous_intraday）。
   * 当前（选 A 纯日K降级）不传、不实现按时间分支；引擎仅依据日K OHLC 做降级判定。
   * 未来接 B 时：此处传入 `dailyK[i]` 对应的当日分钟序列，在 ③盘中双边歧义 / ④盘中单边 判定处
   * 改为「先到者成交」，并移除 ambiguous_intraday 的排除/标注。
   */
  minuteBars?: MinuteRow[];
}

export interface SimResult {
  /** 更新后的交易明细（新对象，不修改入参） */
  trade: TradeRecord;
  /** 买入日下一交易日（T+1 可卖日）；无买入则为 null */
  tPlus1SellDate: string | null;
}

/** 涨停判定容差：禁止 ==，统一用 >= limitPct - TOLERANCE */
const LIMIT_TOLERANCE = 0.005;

function isSTFromName(name: string): boolean {
  // 宽松识别：去空格大写后含 'ST'，覆盖 *ST / S*ST / ST（A 股中文名不含其他 'ST' 子串）
  return (name ?? '').replace(/\s/g, '').toUpperCase().includes('ST');
}

/** 涨停幅度（按代码前缀 + ST 状态）；纯函数、可单测 */
export function getLimitPct(code: string, isST: boolean): number {
  if (code.startsWith('688')) return 0.2; // 科创板（ST 沿用 0.20）
  if (code.startsWith('30')) return 0.2; // 创业板（ST 沿用 0.20）
  if (code.startsWith('8') || code.startsWith('4')) return 0.3; // 北交所
  // 60 / 00 主板
  return isST ? 0.05 : 0.1;
}

/** 数值四舍五入（展示型字段，避免浮点噪声） */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** 日期比较（YYYY-MM-DD 字符串字典序即时间序） */
function dateLT(a: string, b: string): boolean {
  return a < b;
}
function dateLTE(a: string, b: string): boolean {
  return a <= b;
}

/** 某日期是否落在任一停牌区间内 */
function inSuspension(date: string, ranges?: SimSuspensionRange[]): boolean {
  if (!ranges || ranges.length === 0) return false;
  return ranges.some((r) => dateLTE(r.from, date) && dateLTE(date, r.to));
}

/** 取记录日后首个交易日索引（K 线按日期升序） */
function firstIndexAfter(klines: KlineRow[], date: string): number {
  for (let i = 0; i < klines.length; i++) {
    if (dateLT(date, klines[i].date)) return i;
  }
  return -1;
}

/** 取指定日期在 K 线中的索引（记录日当天收盘买入 t_close 用）；不存在返回 -1 */
function indexOfDate(klines: KlineRow[], date: string): number {
  for (let i = 0; i < klines.length; i++) {
    if (klines[i].date === date) return i;
  }
  return -1;
}

/** 是否把「记录日」作为最早候选买入日（需要用到当日收盘价、须等 K 线定稿） */
function prefersCloseToday(buyTiming: BuyTiming): boolean {
  return buyTiming === 't_close' || buyTiming === 't_close_or_next_open';
}

/**
 * 定位【最早候选买入日】在 K 线中的索引 —— 引擎与结算侧【唯一口径】。
 *  t_close / t_close_or_next_open：记录日当天（精确日期匹配）
 *  t_next_open（默认）：记录日后首个交易日
 * 返回 -1 = 候选买入日 K 尚未产生。
 * 注意：混合时机下 simulateTrade 可能顺延到次日，实际买入日由引擎内部重绑，
 * 这里返回的是「优先尝试日」，供结算守卫判断记录日 K 是否定稿。
 */
export function locateBuyDayIndex(record: WinRateRecord, dailyK: KlineRow[]): number {
  const buyTiming: BuyTiming = record.buyTiming ?? 't_next_open';
  return prefersCloseToday(buyTiming)
    ? indexOfDate(dailyK, record.date)
    : firstIndexAfter(dailyK, record.date);
}

/**
 * 是否「收盘封死涨停」（实盘买不进）。
 * 判据与 t_close 分支一致：close===high 且 涨幅 ≥ 涨停限制 - 容差，需要前一根 K 的收盘价。
 * 数据缺失（无前 K / 前收非正）一律返回 false，沿用「缺失不拦截」原则。
 * t_close 据此直接判未成交；t_close_or_next_open 据此决定是否顺延次日。
 */
function sealedLimitUpAt(
  dayK: KlineRow,
  prevK: KlineRow | undefined,
  code: string,
  isST: boolean,
): boolean {
  if (!prevK || !(prevK.close > 0)) return false;
  const changeRate = (dayK.close - prevK.close) / prevK.close;
  return dayK.close === dayK.high && changeRate >= getLimitPct(code, isST) - LIMIT_TOLERANCE;
}

/** 今日理论涨停价（用于「断板」的日K近似判定）。无前收则返回 null，不硬凑。 */
function limitUpPriceAt(
  prevK: KlineRow | undefined,
  code: string,
  isST: boolean,
): number | null {
  if (!prevK || !(prevK.close > 0)) return null;
  return +(prevK.close * (1 + getLimitPct(code, isST))).toFixed(2);
}

/** 截至 idx（含）的 n 日收盘均价；历史不足返回 null。 */
function maAt(dailyK: KlineRow[], idx: number, n: number): number | null {
  if (idx < n - 1) return null;
  let sum = 0;
  for (let i = idx - n + 1; i <= idx; i++) sum += dailyK[i].close;
  return sum / n;
}

/** 截至 idx（含）的 n 日成交量均值；历史不足返回 null。 */
function volMaAt(dailyK: KlineRow[], idx: number, n: number): number | null {
  if (idx < n - 1) return null;
  let sum = 0;
  for (let i = idx - n + 1; i <= idx; i++) sum += dailyK[i].volume;
  return sum / n;
}

/**
 * 动态离场（日K尾盘确认制）——只实现日K(OHLCV)能真实判定的条件。
 * 连板池 / 分时 / 10:00 时点 / 封单 / 板块资金流等无法由日K复现，
 * 一律不进引擎，仅在 UI 规则说明里标注「由选股层校验，回测无法复现」。
 * 返回 null 表示当日收盘未触发；触发方按收盘价成交、正常计入胜率。
 */
function dynamicExitReason(
  strategyId: string,
  dailyK: KlineRow[],
  i: number,
  buyPrice: number,
  code: string,
  isST: boolean,
): SellReason | null {
  const day = dailyK[i];
  const ma3 = maAt(dailyK, i, 3);
  const ma5 = maAt(dailyK, i, 5);
  const ma10 = maAt(dailyK, i, 10);
  const ma20 = maAt(dailyK, i, 20);
  const volMa5 = volMaAt(dailyK, i, 5);
  const limitPrice = limitUpPriceAt(dailyK[i - 1], code, isST);

  switch (strategyId) {
    // 断板（日K近似）：收盘价 < 今日理论涨停价，即当日未封住涨停
    case 'first-board':
    case 'board-advance':
    case 'dragon':
      return limitPrice != null && day.close < limitPrice ? 'broken_board' : null;
    // 跌破关键支撑：收盘跌破 MA20
    case 'trend-break':
      return ma20 != null && day.close < ma20 ? 'ma_breakdown' : null;
    // 均线走坏：MA5 跌破 MA10，或收盘跌破 MA20
    case 'ma-bull':
      return (ma5 != null && ma10 != null && ma5 < ma10) || (ma20 != null && day.close < ma20)
        ? 'ma_breakdown'
        : null;
    // 放量跌破防守线：收盘 < MA10 且 量 > 5 日均量
    case 'pullback-buy':
      return ma10 != null && day.close < ma10 && volMa5 != null && day.volume > volMa5
        ? 'defense_break'
        : null;
    // 再度走弱：收盘跌破 MA20
    case 'dragon-return':
      return ma20 != null && day.close < ma20 ? 'ma_breakdown' : null;
    // 反弹衰竭：收盘价 < MA3（用户拍板口径）
    case 'oversold-bounce':
      return ma3 != null && day.close < ma3 ? 'rebound_fade' : null;
    // 次日不强即走：收盘价 < 买入价
    case 'ultra-short':
      return day.close < buyPrice ? 'weak_close' : null;
    // 量价背离：收阴且放量，或收盘跌破 MA5 兜底（用户拍板口径）
    case 'volume-price-up':
      return (day.close < day.open && volMa5 != null && day.volume > volMa5) ||
        (ma5 != null && day.close < ma5)
        ? 'volume_price_divergence'
        : null;
    // 隔夜强制清仓（日K近似）：10:00 时点无法判定，按首可卖日收盘离场；
    // 仅「一字缩量涨停」按 sellRules 允许持有。
    case 'overnight-hold': {
      const oneWordLimit =
        limitPrice != null &&
        day.open >= limitPrice &&
        day.open === day.high &&
        day.high === day.low &&
        day.low === day.close;
      return oneWordLimit ? null : 'overnight_exit';
    }
    default:
      return null; // 未启用战法 / 无动态规则，保持原有固定判定
  }
}

/**
 * 结算推进判定（recorder 守卫，纯函数便于离线验收）。
 *  - 候选买入日 K 未产生 → false，保持「已记录/待买入」。
 *  - t_close / t_close_or_next_open：优先尝试日 = 记录日，记录窗口（14:50-15:00）内该 K
 *    可能仍是盘中快照，需等记录日之后出现新 K 才视为收盘定稿，避免用盘中价冒充收盘价。
 *    （混合时机若顺延，这根"新 K"也正好是次日买入日，必须存在。）
 *  - t_next_open：买入日 K 一旦存在即为完整收盘日 K，**即使其后的 T+1 卖出日 K 未产生也允许结算**。
 *    simulateTrade 在 tPlus1SellDate == null 时会返回 open 并保留 buyPrice（不标 data_missing），
 *    因此买入日收盘即可落盘买入价，记录当天即可从「待买入」迁移到「持仓中」。
 */
export function canSettleRecord(record: WinRateRecord, dailyK: KlineRow[]): boolean {
  if (!dailyK || dailyK.length === 0) return false;
  const buyTiming: BuyTiming = record.buyTiming ?? 't_next_open';
  const buyIdx = locateBuyDayIndex(record, dailyK);
  if (buyIdx < 0) return false;
  if (prefersCloseToday(buyTiming) && buyIdx + 1 >= dailyK.length) return false;
  return true;
}

/** 深拷贝入参 trade（保证不修改原对象） */
function cloneTrade(t: TradeRecord): TradeRecord {
  return {
    buyDate: t.buyDate,
    buyPrice: t.buyPrice,
    invalidDate: t.invalidDate ?? null,
    sellDate: t.sellDate,
    sellPrice: t.sellPrice,
    holdDays: t.holdDays,
    returnPct: t.returnPct,
    sellReason: t.sellReason,
    status: t.status,
    anomalies: [...t.anomalies],
    backfilled: t.backfilled,
  };
}

/**
 * 单条信号模拟交易。
 * @param record  信号记录（含买入区间/止损/目标/持有周期/代码/名称）
 * @param dailyK  该股日 K 数组（按日期升序；复权口径应为 adjust='none' 不复权）
 * @param options 停牌区间 / ST 覆盖
 */
export function simulateTrade(
  record: WinRateRecord,
  dailyK: KlineRow[],
  options: SimOptions = {},
): SimResult {
  const trade = cloneTrade(record.trade);

  // 已平仓不可改
  if (trade.status === 'closed') {
    return { trade, tPlus1SellDate: record.tPlus1SellDate ?? null };
  }

  // 重新模拟：清空旧执行结果，保留 backfilled 标记
  // 重算记录统一打当前规则版本（已平仓记录已在上方提前返回，保留其自身版本，不被覆盖）
  trade.ruleVersion = TRADE_RULE_VERSION;
  const baseBackfilled = trade.backfilled;
  Object.assign(trade, {
    buyDate: null,
    buyPrice: null,
    invalidDate: null, // 重算时先清空，避免从 invalid 重算成成交/平仓后残留旧判定日
    sellDate: null,
    sellPrice: null,
    holdDays: null,
    returnPct: null,
    sellReason: 'unknown' as SellReason,
    status: 'open' as TradeRecord['status'],
    anomalies: [] as WinRateAnomaly[],
    backfilled: baseBackfilled,
  });

  // 已退市 / 无数据
  if (!dailyK || dailyK.length === 0) {
    trade.status = 'anomaly';
    trade.anomalies = ['delisted_closed'];
    return { trade, tPlus1SellDate: null };
  }

  const isST = options.isST ?? isSTFromName(record.name);
  const code = record.code;

  // ── 定位【最早候选买入日】（与结算侧共用 locateBuyDayIndex，口径唯一）──────
  let buyTiming: BuyTiming = record.buyTiming ?? 't_next_open';
  let buyIdx = locateBuyDayIndex(record, dailyK);
  if (buyIdx < 0) {
    // 无法定位候选买入日：记录日不在 K 线中 / 记录日后无交易日
    trade.status = 'anomaly';
    trade.anomalies = ['data_missing'];
    return { trade, tPlus1SellDate: null };
  }

  let buyDayK = dailyK[buyIdx];
  let buyDate = buyDayK.date;
  const anomalies: WinRateAnomaly[] = [];

  // ── 混合时机「前置降解」：先判记录日能不能买，再复用下面 t_close / t_next_open 两段逻辑 ──
  // 关键：顺延必须重绑 buyIdx / buyDayK / buyDate，否则 T+1 可卖日（sellStartIdx = buyIdx+1）
  // 会按记录日算、把可卖日提前一天。降解后下方分支与 T+1 计算一行都不用改。
  if (buyTiming === 't_close_or_next_open') {
    const tIdx = buyIdx;
    const tDayK = dailyK[tIdx];
    const skipSealedCheck = tIdx < 5; // 次新股：历史不足，沿用 t_close 的跳过约定
    const sealed = !skipSealedCheck && sealedLimitUpAt(tDayK, dailyK[tIdx - 1], code, isST);
    const closeInRange =
      (record.buyLow == null || tDayK.close >= record.buyLow) &&
      (record.buyHigh == null || tDayK.close <= record.buyHigh);
    if (closeInRange && !sealed) {
      buyTiming = 't_close'; // 记录日收盘买入（下方 t_close 分支会再校验一次，口径一致）
    } else {
      // 收盘过高/过低、或封死涨停买不进 → 顺延次日，按 t_next_open 规则独立判定
      buyTiming = 't_next_open';
      buyIdx = firstIndexAfter(dailyK, record.date);
      if (buyIdx < 0) {
        trade.status = 'anomaly';
        trade.anomalies = ['data_missing'];
        return { trade, tPlus1SellDate: null };
      }
      buyDayK = dailyK[buyIdx];
      buyDate = buyDayK.date;
    }
  }

  // ── 未成交判定 + 成交价（按买入时机分支）─────────────────────────────
  let buyPrice: number;
  if (buyTiming === 't_close') {
    // 封板拦截（尾盘涨停封死，实盘买不进 → 排除分母）：
    // 记录日收盘封死涨停（close===high 且涨幅达涨停限制）时，不能按收盘价强行买入，否则胜率虚高（幸存者偏差）。
    // 复用既有 getLimitPct（按代码前缀区分主板 10% / 创业板·科创板 20% / 北交所 30%；ST 主板 5%）与 LIMIT_TOLERANCE 容差。
    const historyBefore = buyIdx; // 记录日之前 K 线根数
    const skipLimitUpCheck = historyBefore < 5; // 次新股：历史不足，跳过封板判定（沿用既有约定）
    if (skipLimitUpCheck) {
      anomalies.push('new_stock_no_limit_check');
    }
    // 与混合时机前置判定共用 sealedLimitUpAt，保证「记录日封板」判据唯一。
    // 只有纯 t_close（或降解为 t_close 且确实未封板）会走到这里；混合时机封板时已顺延，不会进入本分支。
    if (!skipLimitUpCheck && sealedLimitUpAt(buyDayK, dailyK[buyIdx - 1], code, isST)) {
      trade.status = 'invalid';
      trade.buyDate = buyDate;
      trade.invalidDate = buyDate;
      trade.buyPrice = null;
      trade.sellReason = 'unknown';
      trade.anomalies = ['limit_up_filled_close'];
      trade.excludedFromStats = true;
      return { trade, tPlus1SellDate: null };
    }
    // 未封板：以收盘价判定是否落入买入区间 [buyLow, buyHigh]
    const close = buyDayK.close;
    if (record.buyLow != null && close < record.buyLow) {
      trade.status = 'invalid';
      trade.buyDate = buyDate;
      trade.invalidDate = buyDate;
      trade.buyPrice = null;
      trade.sellReason = 'unknown';
      trade.anomalies = ['low_close_unfilled'];
      return { trade, tPlus1SellDate: null };
    }
    if (record.buyHigh != null && close > record.buyHigh) {
      trade.status = 'invalid';
      trade.buyDate = buyDate;
      trade.invalidDate = buyDate;
      trade.buyPrice = null;
      trade.sellReason = 'unknown';
      trade.anomalies = ['high_close_unfilled'];
      return { trade, tPlus1SellDate: null };
    }
    buyPrice = close;
  } else {
    // 次日开盘买入：以次日开盘价判定
    // 次新股：记录日前 K 线 < 5 根 → 跳过一字板判定
    const historyBefore = buyIdx;
    const skipLimitUpCheck = historyBefore < 5;
    if (skipLimitUpCheck) {
      anomalies.push('new_stock_no_limit_check');
    }

    // 买入当日开盘价已 ≥ 目标一：计划失效（无法以低于目标的价格入场）→ 未成交。
    // 优先级高于普通「高开未成交」：open≥target1 一定意味着 open>buyHigh（参数校验保证 bugh<t1），
    // 故此处先判定，使 high_open_over_target1 这个专属异常可被触发（否则会被 high_open_unfilled 抢先返回）。
    const overTarget1 = record.target1 != null && buyDayK.open >= record.target1;

    if (!skipLimitUpCheck) {
      const prevK = dailyK[buyIdx - 1];
      if (prevK) {
        const prevClose = prevK.close;
        const limitPct = getLimitPct(code, isST);
        const changeRate = (buyDayK.close - prevClose) / prevClose;
        const isLimitUp =
          changeRate >= limitPct - LIMIT_TOLERANCE &&
          buyDayK.open === buyDayK.high &&
          buyDayK.high === buyDayK.low &&
          buyDayK.low === buyDayK.close;
        if (isLimitUp) {
          // 一字板未成交（优先于普通高开）
          trade.status = 'invalid';
          trade.buyDate = buyDate;
          trade.invalidDate = buyDate;
          trade.buyPrice = null;
          trade.sellReason = 'unknown';
          trade.anomalies = ['limit_up_unfilled'];
          return { trade, tPlus1SellDate: null };
        }
        if (overTarget1) {
          trade.status = 'invalid';
          trade.buyDate = buyDate;
          trade.invalidDate = buyDate;
          trade.buyPrice = null;
          trade.sellReason = 'unknown';
          trade.anomalies = ['high_open_over_target1'];
          return { trade, tPlus1SellDate: null };
        }
        // 高开未成交（仅高于买入区间上限，但低于目标一）
        if (record.buyHigh != null && buyDayK.open > record.buyHigh) {
          trade.status = 'invalid';
          trade.buyDate = buyDate;
          trade.invalidDate = buyDate;
          trade.buyPrice = null;
          trade.sellReason = 'unknown';
          trade.anomalies = ['high_open_unfilled'];
          return { trade, tPlus1SellDate: null };
        }
      }
    } else {
      if (overTarget1) {
        trade.status = 'invalid';
        trade.buyDate = buyDate;
        trade.invalidDate = buyDate;
        trade.buyPrice = null;
        trade.sellReason = 'unknown';
        trade.anomalies = ['high_open_over_target1'];
        return { trade, tPlus1SellDate: null };
      }
      // 次新股：仅做普通高开未成交判定（不做一字板判定）
      if (record.buyHigh != null && buyDayK.open > record.buyHigh) {
        trade.status = 'invalid';
        trade.buyDate = buyDate;
        trade.invalidDate = buyDate;
        trade.buyPrice = null;
        trade.sellReason = 'unknown';
        trade.anomalies = ['high_open_unfilled'];
        return { trade, tPlus1SellDate: null };
      }
    }

    // 低开未成交（硬性拦截）：次日开盘跌破买入区间下限。
    // 对要求「高开 1%-3%」的超短线等战法尤其关键——不能因为价格更低就默认捡便宜成交。
    // 放在两条高开分支之后统一判定，覆盖「正常」与「次新股跳过一字板」两条路径。
    if (record.buyLow != null && buyDayK.open < record.buyLow) {
      trade.status = 'invalid';
      trade.buyDate = buyDate;
      trade.invalidDate = buyDate;
      trade.buyPrice = null;
      trade.sellReason = 'unknown';
      trade.anomalies = ['low_open_unfilled'];
      trade.excludedFromStats = true; // 用户拍板：低开未成交排除分母
      return { trade, tPlus1SellDate: null };
    }

    buyPrice = buyDayK.open;
  }

  // 正常成交（两种时机共用）
  trade.buyDate = buyDate;
  trade.buyPrice = buyPrice;
  trade.status = 'open';

  // T+1 可卖日 = 买入日下一交易日
  const sellStartIdx = buyIdx + 1;
  const tPlus1SellDate = sellStartIdx < dailyK.length ? dailyK[sellStartIdx].date : null;
  if (tPlus1SellDate == null) {
    // 买入后无后续交易日（K 线在买入日截断）：持仓中，保留 buyDate/buyPrice，等待数据补齐，不标 data_missing。
    // 结算侧 settleOpenRecords 也会因此跳过（buyIdx+1 >= length），保持 status='open' 直到 T+1 K 线产生。
    trade.status = 'open';
    return { trade, tPlus1SellDate: null };
  }

  const stop = record.stop;
  const target1 = record.target1;
  const target2 = record.target2;
  const holdMax = record.holdDays?.max ?? null;

  // 买入当日（T日，即 buyDay）是否已有触发标记（用于 T+1 首可卖日、且开盘未跳空时回退 tplus1_*）：
  //  - 止损边：low≤stop
  //  - 目标边：high≥target1 / high≥target2
  // 时间倒错修复：t_close 的买入价 = 当日收盘价，买入时点已在收盘，
  // 当天盘中 low/high 全部发生在买入【之前】，不能当作持仓触发标记去驱动次日 tplus1_*。
  // t_next_open 的买入价 = 当日开盘价，盘中 low/high 发生在买入之后，标记有效。
  // 混合时机已在前置降解成 t_close / t_next_open，此处判 buyTiming 即可。
  const buyDayMarkersApplicable = buyTiming !== 't_close';
  const buyDayStopHit = buyDayMarkersApplicable && stop != null && buyDayK.low <= stop;
  const buyDayT2Hit = buyDayMarkersApplicable && target2 != null && buyDayK.high >= target2;
  const buyDayT1Hit = buyDayMarkersApplicable && target1 != null && buyDayK.high >= target1;
  const buyDayBothSide = buyDayStopHit && (buyDayT1Hit || buyDayT2Hit);
  // 买入当日收盘已跌破止损（close<stop）：同样只在 t_next_open 下有意义
  const buyDayCloseBelowStop = buyDayMarkersApplicable && stop != null && buyDayK.close < stop;

  let sellDayIdx = -1;
  let sellPrice: number | null = null;
  let sellReason: SellReason = 'unknown';
  let excluded = false;
  let firstSellDayProcessed = false;

  for (let i = sellStartIdx; i < dailyK.length; i++) {
    const day = dailyK[i];

    // 停牌跳过（顺延）：先判 suspensionRanges，再兜底 volume=0
    const inRange = inSuspension(day.date, options.suspensionRanges);
    const zeroVol = day.volume === 0;
    if (inRange || zeroVol) {
      if (inRange && !anomalies.includes('suspended_deferred')) anomalies.push('suspended_deferred');
      if (!inRange && zeroVol && !anomalies.includes('suspended_volume_zero')) {
        anomalies.push('suspended_volume_zero');
      }
      continue;
    }

    // isFirstSellDay = 首个实际可交易日（跳过停牌/零量日后的第一根），T+1 跳空前缀仅作用于此日
    const isFirstSellDay = !firstSellDayProcessed;
    firstSellDayProcessed = true;

    const daysHeld = i - buyIdx; // 持有交易日数（buyDay → 当前日）

    // ① 开盘跳空（时间上最早发生，优先级最高）：open 已越过触发价位 → 按开盘价成交。
    //    任意可卖日（含 T+1 首可卖日）一律用 *_gap，不进入 tplus1_* / 歧义分支。
    if (stop != null && day.open <= stop) {
      sellDayIdx = i;
      sellPrice = day.open;
      sellReason = 'stop_gap';
      excluded = false;
      break;
    }
    if (target2 != null && day.open >= target2) {
      sellDayIdx = i;
      sellPrice = day.open;
      sellReason = 'target2_gap';
      excluded = false;
      break;
    }
    if (target1 != null && day.open >= target1) {
      sellDayIdx = i;
      sellPrice = day.open;
      sellReason = 'target1_gap';
      excluded = false;
      break;
    }

    // ② 开盘未跳空：仅首可卖日检查「买入当日(T日)触发标记」→ tplus1_* / 双边歧义(计入分母)
    if (isFirstSellDay) {
      // 买入当日收盘已跌破止损 → T+1 首可卖日开盘平仓，原因 tplus1_stop_loss（优先级高于双边歧义，不论当日是否同时触目标）
      if (buyDayCloseBelowStop) {
        sellDayIdx = i;
        sellPrice = day.open;
        sellReason = 'tplus1_stop_loss';
        excluded = false;
        break;
      }
      if (buyDayStopHit || buyDayT2Hit || buyDayT1Hit) {
        if (buyDayBothSide) {
          sellDayIdx = i;
          sellPrice = day.open; // 成交价确定（首可卖日开盘），仅原因歧义
          sellReason = 'ambiguous_intraday';
          excluded = false; // 计入分母
          break;
        }
        if (buyDayStopHit) {
          sellDayIdx = i;
          sellPrice = day.open;
          sellReason = 'tplus1_stop_loss';
          excluded = false;
          break;
        }
        if (buyDayT2Hit) {
          sellDayIdx = i;
          sellPrice = day.open;
          sellReason = 'tplus1_target2';
          excluded = false;
          break;
        }
        // buyDayT1Hit 且非双边、非止损边
        sellDayIdx = i;
        sellPrice = day.open;
        sellReason = 'tplus1_target1';
        excluded = false;
        break;
      }
    }

    // ③ 盘中双边触及（日K 仅 OHLC，无法判定盘中 high/low 先后）→ 歧义，排除分母
    const dayBothSide = stop != null && day.low <= stop && target1 != null && day.high >= target1;
    if (dayBothSide) {
      sellDayIdx = i;
      sellPrice = day.open; // 代表成交价仅用于展示（已排除分母）
      sellReason = 'ambiguous_intraday';
      excluded = true;
      break;
    }

    // ④ 盘中单边（开盘未触发，盘中才触及）
    if (stop != null && day.low <= stop) {
      sellDayIdx = i;
      sellPrice = day.open < stop ? day.open : stop; // 缺口下破按开盘价，否则按止损价
      sellReason = 'stop_loss';
      excluded = false;
      break;
    }
    if (target2 != null && day.high >= target2) {
      sellDayIdx = i;
      sellPrice = target2;
      sellReason = 'target2';
      excluded = false;
      break;
    }
    if (target1 != null && day.high >= target1) {
      sellDayIdx = i;
      sellPrice = target1;
      sellReason = 'target1';
      excluded = false;
      break;
    }

    // ④½ 收盘确认动态规则（日K尾盘确认制）：
    //   盘中固定止损/止盈、双边歧义、盘中单边都未触发时，才在收盘判战法专属动态离场。
    //   触发按当日收盘价成交、excluded=false 正常计入胜率（价格明确，不是歧义）。
    //   只实现日K(OHLCV)可判定的条件；分时/连板池类条件不进引擎（见 dynamicExitReason 注释）。
    const dynReason = dynamicExitReason(record.strategyId, dailyK, i, buyPrice, code, isST);
    if (dynReason) {
      sellDayIdx = i;
      sellPrice = day.close;
      sellReason = dynReason;
      excluded = false;
      break;
    }

    // ⑤ 持有周期到期（按战法持有上限自动了结）
    if (holdMax != null && daysHeld >= holdMax) {
      sellDayIdx = i;
      sellPrice = day.close;
      sellReason = 'hold_expired';
      excluded = false;
      break;
    }
  }

  if (sellDayIdx < 0) {
    // 扫描耗尽仍未平仓：
    //  - 已成交（持仓中）→ 维持 status='open'，保留 buyDate/buyPrice，等待后续结算（tPlus1SellDate 已给出）。
    //  - 未成交（buyDate 仍为空）→ 视为数据缺失 anomaly。
    if (trade.buyDate != null) {
      trade.status = 'open';
      trade.anomalies = anomalies; // 保留次新股等软提示
      return { trade, tPlus1SellDate };
    }
    trade.status = 'anomaly';
    trade.anomalies = ['data_missing'];
    return { trade, tPlus1SellDate };
  }

  const sellDate = dailyK[sellDayIdx].date;
  const holdDays = sellDayIdx - buyIdx;
  const returnPct = ((sellPrice as number) - buyPrice) / buyPrice * 100;

  trade.sellDate = sellDate;
  trade.sellPrice = round2(sellPrice as number);
  trade.holdDays = holdDays;
  trade.returnPct = round2(returnPct);
  trade.sellReason = sellReason;
  trade.status = 'closed';
  trade.anomalies = anomalies;
  trade.excludedFromStats = excluded;
  trade.ruleVersion = TRADE_RULE_VERSION;

  return { trade, tPlus1SellDate };
}
