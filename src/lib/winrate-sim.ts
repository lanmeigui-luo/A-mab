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
 * 【T+1 买入】
 *  - A 股 T+1：记录日(date)当日不可买入，买入发生在「记录日下一交易日」(buyDay)。
 *  - 买入价 = buyDay 开盘价（次日开盘价成交）。
 *  - T+1 可卖日(tPlus1SellDate) = buyDay 的下一交易日（即买入后首个可卖出日）。
 *  - 交易日历 = K 线日期序列（本引擎不依赖任何外部日历工具）。
 *
 * 【未成交 → 信号失效(invalid)】
 *  - 次日开盘价 > buyHigh → 高开未成交：status=invalid, anomaly='high_open_unfilled'。
 *  - 次日一字涨停（open==high==low==close 且达到涨停容差）：status=invalid, anomaly='limit_up_unfilled'。
 *    （一字板判定优先于高开判定，避免把一字板误标成普通高开。）
 *  - 涨停判定仅在「非次新股」时执行；次新股（记录日前 K 线 < 5 根）仍可买入（按开盘价正常成交），
 *    仅涨停判定因历史不足不可靠，故跳过一字板判定并标注 anomaly='new_stock_no_limit_check'（软提示，不使信号失效）。
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
 * 【卖出判定（从 T+1 逐根扫描）】每根 K 线按优先级判定（同日多条件「止损优先 / 保守优先」）：
 *   1) 止损：day.low <= stop → 以止损价成交（若开盘已低于止损则按开盘价，缺口优先），reason='stop_loss'
 *   2) 目标1：day.high >= target1 → 以 target1 成交，reason='target1'
 *   3) 目标2：day.high >= target2 → 以 target2 成交，reason='target2'
 *   4) 持有周期到期：到达 holdDays.max 交易日 → 以当日收盘价成交，reason='hold_expired'
 *   同根内多条件命中时，按 1>2>3>4 顺序取最先命中者（止损优先，避免把本应止损的交易日误判为盈利）。
 *
 * 【买入当日收盘跌破止损】buyDay.close < stop → 次日（T+1）开盘价强制卖出，reason='stop_loss'。
 *   （这是独立于上方逐根扫描的「盘前已知水下」路径：买入当天收盘已破位，次日开盘平仓。）
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

import type { WinRateRecord, TradeRecord, WinRateAnomaly, SellReason } from '../domain/winrate';
import type { KlineRow } from '../domain/types';

export interface SimSuspensionRange {
  from: string; // YYYY-MM-DD 含
  to: string; // YYYY-MM-DD 含
}

export interface SimOptions {
  /** 停牌区间（P2a 仅消费不构造）；命中则跳过并标 suspended_deferred */
  suspensionRanges?: SimSuspensionRange[];
  /** ST 状态；缺省由 record.name 前缀(ST/*ST)推导 */
  isST?: boolean;
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

/** 深拷贝入参 trade（保证不修改原对象） */
function cloneTrade(t: TradeRecord): TradeRecord {
  return {
    buyDate: t.buyDate,
    buyPrice: t.buyPrice,
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
  const baseBackfilled = trade.backfilled;
  Object.assign(trade, {
    buyDate: null,
    buyPrice: null,
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

  // 定位买入日（记录日下一交易日）
  const buyIdx = firstIndexAfter(dailyK, record.date);
  if (buyIdx < 0) {
    trade.status = 'anomaly';
    trade.anomalies = ['data_missing'];
    return { trade, tPlus1SellDate: null };
  }

  // 次新股：记录日前 K 线 < 5 根 → 跳过一字板判定（historyBefore 以买入日前 K 线根数近似）
  const historyBefore = buyIdx;
  const skipLimitUpCheck = historyBefore < 5;
  const anomalies: WinRateAnomaly[] = [];
  if (skipLimitUpCheck) {
    anomalies.push('new_stock_no_limit_check');
  }

  const buyDayK = dailyK[buyIdx];

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
        trade.buyDate = buyDayK.date;
        trade.buyPrice = null;
        trade.sellReason = 'unknown';
        trade.anomalies = ['limit_up_unfilled'];
        return { trade, tPlus1SellDate: null };
      }
      // 高开未成交
      if (record.buyHigh != null && buyDayK.open > record.buyHigh) {
        trade.status = 'invalid';
        trade.buyDate = buyDayK.date;
        trade.buyPrice = null;
        trade.sellReason = 'unknown';
        trade.anomalies = ['high_open_unfilled'];
        return { trade, tPlus1SellDate: null };
      }
    }
  } else if (record.buyHigh != null && buyDayK.open > record.buyHigh) {
    // 次新股：仅做普通高开未成交判定（不做一字板判定）
    trade.status = 'invalid';
    trade.buyDate = buyDayK.date;
    trade.buyPrice = null;
    trade.sellReason = 'unknown';
    trade.anomalies = ['high_open_unfilled'];
    return { trade, tPlus1SellDate: null };
  }

  // 正常成交
  const buyPrice = buyDayK.open;
  const buyDate = buyDayK.date;
  trade.buyDate = buyDate;
  trade.buyPrice = buyPrice;
  trade.status = 'open';

  // T+1 可卖日 = 买入日下一交易日
  const sellStartIdx = buyIdx + 1;
  const tPlus1SellDate = sellStartIdx < dailyK.length ? dailyK[sellStartIdx].date : null;
  if (tPlus1SellDate == null) {
    trade.status = 'anomaly';
    trade.anomalies = ['data_missing'];
    return { trade, tPlus1SellDate: null };
  }

  // 买入当日收盘跌破止损 → 次日开盘价强制卖出（盘前已知水下，独立于逐根扫描）
  const forcedEarlyExit = record.stop != null && buyDayK.close < record.stop;

  const stop = record.stop;
  const target1 = record.target1;
  const target2 = record.target2;
  const holdMax = record.holdDays?.max ?? null;

  let sellDayIdx = -1;
  let sellPrice: number | null = null;
  let sellReason: SellReason = 'unknown';

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

    // 盘前水下：次日开盘价强制平仓
    if (forcedEarlyExit) {
      sellDayIdx = i;
      sellPrice = day.open;
      sellReason = 'stop_loss';
      break;
    }

    const daysHeld = i - buyIdx; // 持有交易日数（buyDay → 当前日）

    // 1) 止损（优先）
    if (stop != null && day.low <= stop) {
      const fill = day.open < stop ? day.open : stop; // 缺口下破按开盘价，否则按止损价
      sellDayIdx = i;
      sellPrice = fill;
      sellReason = 'stop_loss';
      break;
    }
    // 2) 目标1
    if (target1 != null && day.high >= target1) {
      sellDayIdx = i;
      sellPrice = target1;
      sellReason = 'target1';
      break;
    }
    // 3) 目标2
    if (target2 != null && day.high >= target2) {
      sellDayIdx = i;
      sellPrice = target2;
      sellReason = 'target2';
      break;
    }
    // 4) 持有周期到期
    if (holdMax != null && daysHeld >= holdMax) {
      sellDayIdx = i;
      sellPrice = day.close;
      sellReason = 'hold_expired';
      break;
    }
  }

  if (sellDayIdx < 0) {
    // 扫描耗尽仍未平仓 → 数据缺失
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

  return { trade, tPlus1SellDate };
}
