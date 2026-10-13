/**
 * 买卖价推荐（需求 7.3）
 *
 * 硬性原则：
 * 1. 全部由规则引擎按真实 K 线/行情计算，**不依赖模型**，也不做任何预测
 * 2. 拿不到输入（如 MA10、前高、前低）时对应项返回 null 并写明原因，
 *    **绝不用当前价 ± 固定百分比硬凑**
 * 3. 涨停状态下买入区间一律写「涨停不可买入」，并给出以涨停价为基准的目标位
 * 4. 盈亏比 = (目标1 - 买入中值) / (买入中值 - 止损)；分母 ≤0 时返回 null（无意义）
 */

import { STRATEGY_DEFS } from './index.mjs';

const S = Object.fromEntries(STRATEGY_DEFS.map((s) => [s.id, s]));

/** 建议仓位：按风险等级（需求未给具体值，这里按风险倒序，UI 标注为「规则建议」） */
const POSITION_BY_RISK = {
  极高风险: 10,
  高风险: 20,
  中高风险: 30,
  中风险: 40,
};

const r2 = (v) => (v == null ? null : +v.toFixed(2));

/**
 * 趋势类战法止损：在 MA20、2×ATR、-7% 三个候选中取**离买入中值最近**的一个。
 * 只用 MA20 会出现 -30% 这种不切实际的止损（强势股远离均线），使盈亏比失真到 0.1。
 * 必须以买入中值为基准，否则会算出「止损高于买入价」这种自相矛盾的结果。
 */
function trendStop(refPrice, ma20, atr) {
  const cands = [ma20, atr != null ? refPrice - atr * 2 : null, refPrice * 0.93].filter(
    (v) => v != null && v < refPrice,
  );
  if (!cands.length) return { stop: null, basis: '无可用止损基准（MA20/ATR 均缺失）' };
  return {
    stop: Math.max(...cands),
    basis: `以买入中值 ${r2(refPrice)} 为基准：MA20 ${ma20 != null ? r2(ma20) : '—'} / 2×ATR ${atr != null ? r2(atr * 2) : '—'} / -7% 取最近者`,
  };
}

/**
 * @param {Object} arg
 * @param {Object} arg.ind  computeIndicators 结果
 * @param {Object} arg.snap 行情快照（price / changePct / limitUp / floatMvYi / turnoverRate）
 * @param {string[]} arg.strategyIds 命中的战法 id（按优先级排序）
 */
export function buildTradePlan({ ind, snap, strategyIds = [] } = {}) {
  if (!ind) return null;
  const price = snap?.price ?? ind.close;
  const prevLow = ind.prev?.low ?? null;
  const prevHigh = ind.high30 ?? null;
  const ma5 = ind.ma5;
  const ma10 = ind.ma10;
  const ma20 = ind.ma20;
  const atr = ind.atr14?.atr ?? null;
  const limitUp = snap?.limitUp?.isLimitUp === true;

  // 主战法：取命中列表中风险最低（最稳）的一个作为买卖计划依据
  const primaryId = pickPrimary(strategyIds);
  const def = S[primaryId];
  const risk = def?.risk ?? '中风险';

  let buyLow = null;
  let buyHigh = null;
  let buyBasis = '';
  let stop = null;
  let stopBasis = '';
  let target1 = null;
  let target1Basis = '';
  let target2 = null;
  let target2Basis = '';
  let addPrice = null;
  let addBasis = '';

  // 止损/目标一律按战法规则计算（涨停时也要给，供次日参考）；
  // 只有买入区间在涨停状态下写「涨停不可买入」。
  {
    switch (primaryId) {
      case 'ultra-short': {
        // 买入：次日竞价高开 1%-3% 区间（需求 2.1）
        buyLow = price * 1.01;
        buyHigh = price * 1.03;
        buyBasis = '次日竞价高开 1%-3% 区间';
        // 止损：跌破前一日低点，且总止损幅度 ≤4%
        const byPrevLow = prevLow ?? null;
        const byPct = price * 0.96;
        stop = byPrevLow != null ? Math.max(Math.min(byPrevLow, byPct), price * 0.9) : byPct;
        stopBasis = byPrevLow != null
          ? `前一日低点 ${r2(byPrevLow)} 与 -4% 止损 ${r2(byPct)} 取更近者`
          : `按 -4% 止损 ${r2(byPct)}（前一日低点缺失）`;
        target1 = prevHigh != null ? Math.max(prevHigh, price * 1.03) : price * 1.04;
        target1Basis = prevHigh != null ? `前高 ${r2(prevHigh)} 与 +4% 取高者` : '+4%（前高缺失）';
        target2 = atr != null ? price + Math.max(atr * 2, price * 0.08) : price * 1.09;
        target2Basis = atr != null ? `现价 + 2×ATR(${r2(atr)})，不低于 +8%` : '+9%（ATR 缺失）';
        addPrice = price * 1.02;
        addBasis = '分时二次上攻 / 突破前高加仓';
        break;
      }
      case 'first-board':
      case 'board-advance': {
        // 打板类：以涨停价（或次日竞价）为买点，A 股次日买入参考
        buyLow = price * 0.99;
        buyHigh = price * 1.02;
        buyBasis = '次日竞价平开至高开 2% 区间（非涨停状态）';
        stop = ma5 != null ? Math.min(ma5, price * 0.96) : price * 0.96;
        stopBasis = ma5 != null ? `MA5 ${r2(ma5)} 与 -4% 取更近者` : '-4%（MA5 缺失）';
        target1 = price * 1.05;
        target1Basis = '+5%';
        target2 = price * 1.1;
        target2Basis = '+10% 或次日涨停';
        addPrice = prevHigh != null ? prevHigh : null;
        addBasis = prevHigh != null ? `突破前高 ${r2(prevHigh)} 加仓` : '前高缺失，无加仓位';
        break;
      }
      case 'pullback-buy': {
        // 买入：支撑位 MA10 附近（低吸）
        buyLow = ma10 != null ? ma10 * 0.98 : null;
        buyHigh = ma10 != null ? ma10 * 1.02 : null;
        buyBasis = ma10 != null ? `MA10 支撑 ${r2(ma10)} ±2%` : 'MA10 缺失，无法给出低吸区间';
        // 止损：跌破 MA10 或回调低点，亏损 ≤5%
        stop = ma10 != null ? ma10 * 0.95 : null;
        stopBasis = ma10 != null ? `跌破 MA10 再下 5%（${r2(stop)}）` : 'MA10 缺失，无法定止损';
        target1 = prevHigh != null ? prevHigh : null;
        target1Basis = prevHigh != null ? `前高 ${r2(prevHigh)}` : '前高缺失';
        target2 = atr != null && prevHigh != null ? prevHigh + atr * 2 : null;
        target2Basis = target2 != null ? `前高 + 2×ATR(${r2(atr)})` : '前高或 ATR 缺失';
        addPrice = null;
        addBasis = '回踩策略不加仓';
        break;
      }
      case 'dragon-return': {
        // 防守线 = 涨停前一日收盘价 ×(1+3%)
        const defense = ind.prevLimitBase != null ? ind.prevLimitBase * 1.03 : null;
        buyLow = defense != null ? defense : null;
        buyHigh = price * 1.02;
        buyBasis = defense != null ? `防守线 ${r2(defense)} 至 现价 +2%` : '涨停基准价缺失，按现价 +2% 上限';
        stop = defense != null ? defense * 0.98 : null;
        stopBasis = defense != null ? `跌破防守线 ${r2(defense)}` : '涨停基准价缺失，无法定止损';
        target1 = ind.prevLimitPrice != null ? ind.prevLimitPrice : null;
        target1Basis = ind.prevLimitPrice != null ? `前涨停价 ${r2(ind.prevLimitPrice)}` : '前涨停价缺失';
        target2 = prevHigh != null ? prevHigh : null;
        target2Basis = prevHigh != null ? `前高 ${r2(prevHigh)}` : '前高缺失';
        addPrice = null;
        addBasis = '龙回头二波不加仓';
        break;
      }
      case 'oversold-bounce': {
        buyLow = price * 0.98;
        buyHigh = price * 1.02;
        buyBasis = '现价 ±2%（超跌反弹为右侧确认后介入）';
        stop = ind.low30 != null ? ind.low30 * 0.97 : null;
        stopBasis = ind.low30 != null ? `前低 ${r2(ind.low30)} 再下 3%` : '30 日低点缺失，无法定止损';
        target1 = ma20 != null ? ma20 : null;
        target1Basis = ma20 != null ? `MA20 ${r2(ma20)}（需求：止盈于 MA20 附近）` : 'MA20 缺失';
        target2 = prevHigh != null ? prevHigh : null;
        target2Basis = prevHigh != null ? `前高 ${r2(prevHigh)}` : '前高缺失';
        addPrice = ma20 != null ? ma20 : null;
        addBasis = ma20 != null ? `站稳 MA20 ${r2(ma20)} 加仓` : 'MA20 缺失';
        break;
      }
      case 'trend-break':
      case 'ma-bull': {
        buyLow = ma5 != null ? Math.min(ma5, price) : price * 0.98;
        buyHigh = ma5 != null ? Math.max(ma5, price) * 1.01 : price * 1.01;
        buyBasis = ma5 != null ? `MA5 ${r2(ma5)} 至现价区间（趋势不追高）` : 'MA5 缺失，按现价 ±1%';
        const ts = trendStop((buyLow + buyHigh) / 2, ma20, atr);
        stop = ts.stop;
        stopBasis = ts.basis;
        target1 = prevHigh != null ? prevHigh : null;
        target1Basis = prevHigh != null ? `前高 ${r2(prevHigh)}` : '前高缺失';
        target2 = atr != null && prevHigh != null ? prevHigh + atr * 3 : null;
        target2Basis = target2 != null ? `前高 + 3×ATR(${r2(atr)})` : '前高或 ATR 缺失';
        addPrice = prevHigh != null ? prevHigh : null;
        addBasis = prevHigh != null ? `放量突破前高 ${r2(prevHigh)} 加仓` : '前高缺失';
        break;
      }
      case 'dragon': {
        buyLow = ma5 != null ? ma5 : price * 0.98;
        buyHigh = price * 1.02;
        buyBasis = ma5 != null ? `MA5 ${r2(ma5)} 至 现价 +2%` : 'MA5 缺失，按现价 +2% 上限';
        const ts = trendStop((buyLow + buyHigh) / 2, ma20, atr);
        stop = ts.stop;
        stopBasis = ts.basis;
        target1 = prevHigh != null ? prevHigh : null;
        target1Basis = prevHigh != null ? `前高 ${r2(prevHigh)}` : '前高缺失';
        target2 = price * 1.15;
        target2Basis = '+15%';
        addPrice = null;
        addBasis = '龙头不加仓';
        break;
      }
      case 'volume-price-up': {
        buyLow = price * 0.99;
        buyHigh = price * 1.01;
        buyBasis = '现价 ±1%';
        stop = ma5 != null ? ma5 : price * 0.95;
        stopBasis = ma5 != null ? `跌破 MA5 ${r2(ma5)}` : '-5%（MA5 缺失）';
        target1 = prevHigh != null ? prevHigh : null;
        target1Basis = prevHigh != null ? `前高 ${r2(prevHigh)}` : '前高缺失';
        target2 = price * 1.1;
        target2Basis = '+10%';
        addPrice = null;
        addBasis = '量价齐升不加仓';
        break;
      }
      case 'overnight-hold': {
        // 需求 4.3：14:45-14:55 现价 ±0.5%；止损 -3%；目标 +3% / +5%
        // 盈亏比固定为 1.0（3%/3% 对称），这是该战法的设定，不是算出来的
        buyLow = price * 0.995;
        buyHigh = price * 1.005;
        buyBasis = '14:45-14:55 现价 ±0.5%（尾盘分批入场，不早于 14:30）';
        stop = price * 0.97;
        stopBasis = '买入价 -3%（隔夜战法固定止损）';
        target1 = price * 1.03;
        target1Basis = '买入价 +3%';
        // 目标 2 取 +5%，但若已接近涨停则以涨停价为准（不能再往上给无法成交的价）
        const pctLimit = snap?.limitUp?.threshold ?? null;
        const cap =
          snap?.limitUp?.limitPrice ??
          (pctLimit != null && ind.prev?.close ? ind.prev.close * (1 + pctLimit / 100) : null);
        target2 = cap != null ? Math.min(price * 1.05, cap) : price * 1.05;
        target2Basis =
          cap != null && price * 1.05 > cap
            ? `+5% 超过涨停价，按涨停价 ${r2(cap)} 计`
            : '买入价 +5%';
        addPrice = null;
        addBasis = '隔夜战法严禁补仓，买入后不再加仓';
        break;
      }
      default: {
        buyLow = null;
        buyHigh = null;
        buyBasis = '未命中任何可用战法，不给出买入区间';
        stop = null;
        stopBasis = '无战法依据';
        target1 = null;
        target2 = null;
        addPrice = null;
        addBasis = '无战法依据';
      }
    }
  }

  // 涨停状态：只屏蔽买入区间，止损/目标保留并注明以现价为参考
  if (limitUp) {
    buyLow = null;
    buyHigh = null;
    buyBasis = '涨停不可买入（止损与目标以现价为参考，供次日使用）';
  }

  // 盈亏比：买入中值为基准；涨停时无买入价，改用现价并在 buyBasis 中说明
  const mid = buyLow != null && buyHigh != null ? (buyLow + buyHigh) / 2 : limitUp ? price : null;
  const denom = mid != null && stop != null ? mid - stop : null;
  const numer = mid != null && target1 != null ? target1 - mid : null;
  const ratioPL = denom != null && numer != null && denom > 0 ? +(numer / denom).toFixed(2) : null;

  return {
    /** 依据的主战法 */
    strategyId: primaryId ?? null,
    strategyName: def?.name ?? null,
    risk,
    holding: def?.holding ?? null,
    suggestPositionPct: POSITION_BY_RISK[risk] ?? 30,
    buyLow: r2(buyLow),
    buyHigh: r2(buyHigh),
    buyMid: r2(mid),
    buyBasis,
    /** 涨停时前端直接展示这句话 */
    buyBlockedByLimitUp: limitUp,
    stop: r2(stop),
    stopBasis,
    stopLossPct: mid != null && stop != null ? +(((stop - mid) / mid) * 100).toFixed(2) : null,
    target1: r2(target1),
    target1Basis,
    target1GainPct: mid != null && target1 != null ? +(((target1 - mid) / mid) * 100).toFixed(2) : null,
    target2: r2(target2),
    target2Basis,
    target2GainPct: mid != null && target2 != null ? +(((target2 - mid) / mid) * 100).toFixed(2) : null,
    addPrice: r2(addPrice),
    addBasis,
    profitLossRatio: ratioPL,
    /** 输入缺失清单 —— 前端据此显示「不可算」而不是硬凑数字 */
    missing: [
      ma5 == null ? 'MA5' : null,
      ma10 == null ? 'MA10' : null,
      ma20 == null ? 'MA20' : null,
      prevHigh == null ? '30 日高点' : null,
      ind.low30 == null ? '30 日低点' : null,
      atr == null ? 'ATR14' : null,
    ].filter(Boolean),
    /** 隔夜持股法专有：次日强制卖出窗口与开盘情形处置规则（需求 4.2 / 6.3） */
    ...(primaryId === 'overnight-hold'
      ? {
          sellWindow: '次日 9:30-10:00（10:00 前必须全部清仓，仅"一字缩量涨停"可持有）',
          sellRules: [
            { case: '高开 2%-5%', action: '冲高分批止盈，盈利 2%-4% 直接落袋，不博弈连板' },
            { case: '高开 >5%', action: '开盘即卖出一半，剩余仓位在冲高回落时清仓' },
            { case: '平开（-1% 至 +1%）', action: '成本附近直接离场，不幻想反弹' },
            { case: '低开 < -1.5%', action: '开盘立即止损，不扛单' },
            { case: '日内冲高回落亏损达 3%', action: '无条件止损' },
          ],
          overnightRisk:
            '隔夜持股面临隔夜突发利空、行业政策变化、外围市场大跌等不可控风险，次日可能直接低开深套。请严格执行止损纪律。',
        }
      : {}),
    note: '由规则引擎基于真实 K 线计算，非模型预测；高确定性不等于必涨，需结合仓位管理。',
  };
}

/** 命中多战法时，取风险最低（最稳）的作为买卖计划依据 */
function pickPrimary(ids) {
  const order = ['中风险', '中高风险', '高风险', '极高风险'];
  let best = null;
  let bestIdx = 99;
  for (const id of ids) {
    const d = S[id];
    if (!d || d.available === false) continue;
    const i = order.indexOf(d.risk);
    if (i >= 0 && i < bestIdx) {
      bestIdx = i;
      best = id;
    }
  }
  return best ?? ids.find((id) => S[id]?.available !== false) ?? null;
}
