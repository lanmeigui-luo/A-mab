/**
 * 战法规则引擎（阶段 2 建骨架，阶段 5 扩至 11 种）
 *
 * 原则：
 * 1. 全部条件基于真实 K 线与行情快照计算，不依赖任何模型
 * 2. 拿不到的因子（主力净流入、量比、情绪、板块）**不参与评分**，
 *    权重按可用因子重新归一化，并在结果中显式列出缺失因子
 *    —— 对应需求「该因子因数据源限制未纳入评分」
 * 3. 涨停判定按 A 股涨跌幅限制推断（主板 10% / 创业科创 20%），并标注为推断
 * 4. 数据源未接入的战法（如事件驱动）标记 available=false，不产生任何信号，
 *    绝不用推断值冒充真实事件
 */

import {
  macd, rsi, kdj, boll, atr, crossAboveMa3, volumePeak, limitUpCount,
  dragonStructure, daysSinceHigh,
} from './indicators.mjs';

// ---------- 指标 ----------

function smaLast(values, period) {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

/** 「N 根 K 线之前」的 MA period 值，用于判断均线方向 */
function smaAgo(values, period, ago) {
  if (values.length < period + ago) return null;
  const end = values.length - ago;
  let s = 0;
  for (let i = end - period; i < end; i++) s += values[i];
  return s / period;
}

/** 从 K 线推断连续涨停天数（连板数 K 线口径，与涨停池口径互为校验） */
function limitUpStreak(rows, code) {
  const isGemOrStar = /^(30|68)/.test(String(code || ''));
  const threshold = isGemOrStar ? 19.8 : 9.8;
  let n = 0;
  for (let i = rows.length - 1; i > 0; i--) {
    const prev = rows[i - 1].close;
    if (!prev) break;
    const pct = ((rows[i].close - prev) / prev) * 100;
    if (pct >= threshold) n++;
    else break;
  }
  return n;
}

/** 连续上涨天数（收盘价口径） */
function consecutiveUpDays(rows) {
  let n = 0;
  for (let i = rows.length - 1; i > 0; i--) {
    if (rows[i].close > rows[i - 1].close) n++;
    else break;
  }
  return n;
}

/** 近 3 日成交量是否逐日递增 */
function volumeRising3(rows) {
  if (rows.length < 3) return null;
  const a = rows[rows.length - 3].volume;
  const b = rows[rows.length - 2].volume;
  const c = rows[rows.length - 1].volume;
  return c > b && b > a;
}

export function computeIndicators(rows, code) {
  const closes = rows.map((r) => r.close);
  const vols = rows.map((r) => r.volume);
  if (!closes.length) return null;

  const last = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2] : last;

  const highs = rows.map((r) => r.high);
  const lows = rows.map((r) => r.low);

  const w30 = rows.slice(-30);
  const high30 = Math.max(...w30.map((r) => r.high));
  const low30 = Math.min(...w30.map((r) => r.low));
  const w60 = rows.slice(-60);
  const high60 = Math.max(...w60.map((r) => r.high));
  const low60 = Math.min(...w60.map((r) => r.low));

  const ma20 = smaLast(closes, 20);

  return {
    last,
    prev,
    close: last.close,
    ma5: smaLast(closes, 5),
    /** 昨日 MA5，用于判断短期均线是否向上（隔夜持股法的「MA5 向上」条件） */
    ma5Prev: smaAgo(closes, 5, 1),
    ma10: smaLast(closes, 10),
    ma20,
    ma40: smaLast(closes, 40),
    ma60: smaLast(closes, 60),
    /** 5 根 K 线前的 MA20，用于判断均线是否上行 */
    ma20Prev5: smaAgo(closes, 20, 5),
    volMa5: smaLast(vols, 5),
    volMa20: smaLast(vols, 20),
    high30,
    low30,
    high60,
    low60,
    highAll: Math.max(...highs),
    lowAll: Math.min(...lows),
    /** 20 日乖离率 % */
    bias20: ma20 ? ((last.close - ma20) / ma20) * 100 : null,
    /** 今日量 / 20 日均量 */
    volRatio20: smaLast(vols, 20) ? last.volume / smaLast(vols, 20) : null,
    /** 今日量 / 5 日均量 */
    volRatio5: smaLast(vols, 5) ? last.volume / smaLast(vols, 5) : null,
    /** 近 20 日涨幅 % */
    chg20:
      rows.length > 20 && rows[rows.length - 21]
        ? ((last.close - rows[rows.length - 21].close) / rows[rows.length - 21].close) * 100
        : null,
    /** 近 60 日涨幅 % */
    chg60:
      rows.length > 60 && rows[rows.length - 61]
        ? ((last.close - rows[rows.length - 61].close) / rows[rows.length - 61].close) * 100
        : null,
    /** 距 30 日高点回撤 %（负值） */
    drawdown30: high30 ? ((last.close - high30) / high30) * 100 : null,
    drawdown60: high60 ? ((last.close - high60) / high60) * 100 : null,
    /** K 线口径连板数（推断） */
    limitStreak: limitUpStreak(rows, code),
    /** 连涨天数（收盘价口径） */
    upDays: consecutiveUpDays(rows),
    /** 近 3 日量能递增 */
    volRising3: volumeRising3(rows),
    /** 当日最低价是否落在 MA10 附近（±5% / +2%）—— 回踩支撑判定 */
    lowNearMa10:
      smaLast(closes, 10) != null
        ? last.low <= smaLast(closes, 10) * 1.02 && last.low >= smaLast(closes, 10) * 0.95
        : null,
    /** 近 20 日涨停次数（个股股性） */
    limitUpCount20: limitUpCount(rows, code, 20),
    /** 近 20 日成交量峰值（低吸回踩缩量比） */
    volPeak: volumePeak(rows, 20),
    /** 近 20 日最高成交量距今天数内的峰值量 */
    volShrinkRatio: (() => {
      const vp = volumePeak(rows, 20);
      if (!vp || !vp.peakVolume) return null;
      return last.volume / vp.peakVolume;
    })(),
    /** 距 MA60 乖离率 %（均线多头「脱离底部」过滤） */
    bias60: smaLast(closes, 60) ? ((last.close - smaLast(closes, 60)) / smaLast(closes, 60)) * 100 : null,
    /** 5 日均量 / 20 日均量（均线多头量能确认） */
    volMa5Over20: smaLast(vols, 20) ? (smaLast(vols, 5) ?? 0) / smaLast(vols, 20) : null,
    /** MA3（超跌反弹上穿判定） */
    ma3: smaLast(closes, 3),
    ma3Cross: crossAboveMa3(rows),
    macd: macd(closes),
    rsi14: rsi(closes, 14),
    kdj: kdj(rows),
    boll: boll(closes, 20, 2),
    atr14: atr(rows, 14),
    /** 龙回头结构：前期连板 / 断板天数 / 涨停基准价 / 量能累和 */
    dragon: dragonStructure(rows, code),
    /** 距 30 日高点后的交易日数（低吸回踩调整周期） */
    adjustDays: daysSinceHigh(rows, 30),
    bars: rows.length,
  };
}

/** 涨停推断：主板 10%、创业/科创 20%，标注为推断而非上游直供 */
export function inferLimitUp(name, code, prevClose, price, changePct) {
  if (prevClose == null || price == null || changePct == null) return { isLimitUp: false, reason: '字段缺失' };
  const isGemOrStar = /^(30|68)/.test(String(code));
  const threshold = isGemOrStar ? 19.8 : 9.8;
  if (changePct >= threshold) {
    return { isLimitUp: true, threshold, byInfer: true, limitType: isGemOrStar ? '20%' : '10%' };
  }
  return { isLimitUp: false, threshold, byInfer: true };
}

// ---------- 战法定义（11 种） ----------

export const STRATEGY_DEFS = [
  // —— 打板类 ——
  {
    id: 'first-board',
    name: '首板打板',
    category: '打板类',
    desc: '9:30-10:30 封板、封单充足、实体阳线、板块协同的首板',
    // 需求 2.2 默认值
    params: {
      sealEarly: 93000,      // 首次封板时间 ≥ 09:30:00
      sealLate: 103000,      // 首次封板时间 ≤ 10:30:00
      sealLateBan: 143000,   // 14:30 后不碰
      volRatioMin: 2.5,      // 量比（腾讯无量比字段，用「今量/20日均量」替代并标注）
      turnoverMin: 8,
      turnoverMax: 15,
      turnoverBan: 25,       // >25% 黑名单
      volVsPrevMin: 1.5,     // 成交量 ≥ 前日 1.5 倍
      sealAmtPctOfFloat: 3,  // 封单金额 > 流通市值 3%
      bodyRatioMin: 70,      // 实体阳线占比 > 70%
      floatMvMinYi: 50,
      floatMvMaxYi: 200,
      boardTopN: 3,          // 板块涨幅前 3
      boardLimitUpMin: 3,    // 板块内涨停 ≥ 3 只
    },
    risk: '高风险',
    holding: '次日',
    available: true,
  },
  {
    id: 'board-advance',
    name: '连板晋级',
    category: '打板类',
    desc: '2/3 板、换手 10-25%、晋级率≥0.23、炸板率<30% 时的晋级博弈',
    // 需求 2.3 默认值
    params: {
      boardMin: 2,
      boardMax: 3,
      turnoverMin: 10,
      turnoverMax: 25,
      promoteRateMin: 0.23,  // 晋级率
      maxBoardMin: 5,        // 市场连板高度
      brokenRateMax: 30,     // 炸板率
    },
    risk: '极高风险',
    holding: '次日',
    available: true,
  },
  // —— 趋势类 ——
  {
    id: 'trend-break',
    name: '趋势突破',
    category: '趋势类',
    desc: 'MA20>MA40>MA60、量能 1.8 倍、突破 30 日新高、ATR 波动放大',
    // 需求 2.5 默认值
    params: {
      volRatioMin: 1.8,      // 成交量 > 20 日均量 1.8 倍
      atrExpandMin: 1.1,     // ATR14 / ATR7 > 1.1 视为波动性放大
      breakoutTolerance: 0.999, // 突破 30 日最高价容差
    },
    risk: '中风险',
    holding: '5-20 天',
    available: true,
  },
  {
    id: 'ma-bull',
    name: '均线多头',
    category: '趋势类',
    desc: 'MA5>MA10>MA20>MA60、5 日均量>20 日均量、距 MA60 乖离<12%',
    // 需求 2.10 默认值
    params: {
      volMa5Over20Min: 1.0,  // 5 日均量 > 20 日均量
      bias60Max: 12,         // 距 MA60 乖离 < 12%
      bottomRangeMax: 20,    // 脱离底部区域 < 20%
    },
    risk: '中风险',
    holding: '10-30 天',
    available: true,
  },
  {
    id: 'dragon',
    name: '龙头战法',
    category: '趋势类',
    desc: '连板高度≥3 或板块内涨幅前 3、阶段涨幅领先、站稳 MA60',
    // 需求 2.4 默认值
    params: {
      boardHeightMin: 3,     // 连板高度 ≥ 3 板
      boardTopN: 3,          // 或板块内涨幅前 3
      chg20Min: 20,          // 阶段涨幅（相对板块的超额涨幅由板块面对比得出）
      turnoverMin: 10,
      turnoverMax: 25,
    },
    risk: '高风险',
    holding: '1-5 天',
    available: true,
  },
  // —— 回调类 ——
  {
    id: 'pullback-buy',
    name: '低吸回踩',
    category: '回调类',
    desc: '前期涨幅 20-30% 后缩量回踩、回撤≤15%、调整≤10 日的技术确认买点',
    // 需求 2.6 默认值
    params: {
      prevGainMin: 20,       // 前期涨幅 20%-30%
      prevGainMax: 30,
      volShrinkMin: 0.3,     // 缩量至前期峰值 30%-50%
      volShrinkMax: 0.5,
      drawdownMin: -15,      // 价格回撤 ≤ 15%
      adjustDaysMax: 10,     // 调整周期 ≤ 10 日
    },
    risk: '中风险',
    holding: '3-10 天',
    available: true,
  },
  {
    id: 'dragon-return',
    name: '龙回头',
    category: '回调类',
    desc: '前期 2-3 连板后断板调整 3-8 天、守住防守线并放量反攻',
    // 需求 2.7 默认值
    params: {
      prevBoardMin: 2,       // 前期连板 2-3 个涨停板
      prevBoardMax: 3,
      restDaysMin: 3,        // 断板调整 3-8 天
      restDaysMax: 8,
      defenseLow: 3,         // 防守线 = 涨停前一日收盘 × (1+3%)
      defenseHigh: 8,        // 震荡市调至 5%-8%
      breakPrevLimitUp: 0.99, // 现价突破前涨停价 99%
      volSumRatioMin: 1,     // 回调期量能累和 / 二板后两日量能总和 ≥ 1
    },
    risk: '高风险',
    holding: '3-10 天',
    available: true,
  },
  {
    id: 'oversold-bounce',
    name: '超跌反弹',
    category: '回调类',
    desc: 'BIAS20 超跌、RSI<30、上穿 MA3 且放量确认的三重反弹信号',
    // 需求 2.8 默认值（主板 -8%，创业/科创 -12%）
    params: {
      biasMain: -8,
      biasGem: -12,
      volRatioMin: 1.5,      // 量比 ≥ 1.5
      rsiMax: 30,            // RSI14 < 30
      kdjJMax: 0,            // KDJ J < 0 或接近 0
      liquidityMinYuan: 5e7, // 流动性 ≥ 5000 万，低于此排除
    },
    risk: '中高风险',
    holding: '3-10 天',
    available: true,
  },
  // —— 量价类 ——
  {
    id: 'ultra-short',
    name: '超短线战法',
    category: '量价类',
    desc: '持股 1-3 天：量比≥2.5、换手 8-15%、MA 多头、流通<100 亿',
    // 需求 2.1 默认值
    params: {
      volRatioMin: 2.5,      // 量比 ≥ 2.5
      turnoverMin: 8,
      turnoverMax: 15,
      floatMvMaxYi: 100,     // 流通市值 < 100 亿
      bias20Max: 15,         // 20 日乖离率 < 15%
      boardChangeMin: 1,     // 所属板块涨幅 > 1%
      brokenRateMax: 30,     // 市场炸板率 < 30%
      maxBoardMin: 3,        // 连板高度 ≥ 3
      prevLimitUpPerfMin: 2, // 昨日涨停今日表现 > 2%
      fundNetMin: 0,         // 主力净流入 > 0
    },
    risk: '中高风险',
    holding: '1-3 天',
    available: true,
  },
  {
    id: 'volume-price-up',
    name: '量价齐升',
    category: '量价类',
    desc: '涨幅 2-9%、量比 1.1-5、换手 4-10%、市值 30-300 亿的良性量价配合',
    // 需求 2.9 默认值
    params: {
      changeMin: 2,          // 涨幅 2%-9%
      changeMax: 9,
      volRatioMin: 1.1,      // 量比 1.1-5
      volRatioMax: 5,
      turnoverMin: 4,
      turnoverMax: 10,
      floatMvMinYi: 30,
      floatMvMaxYi: 300,
    },
    risk: '中风险',
    holding: '3-15 天',
    available: true,
  },
  // —— 尾盘类 ——
  {
    id: 'overnight-hold',
    name: '隔夜持股法',
    category: '尾盘类',
    desc: '14:30 后选股、尾盘买入，次日 10:00 前强制卖出，持仓仅 1 个交易日',
    // 需求 v4.1 默认值（高胜率配置）
    params: {
      changeMin: 3,             // 当日涨幅 3%-5%
      changeMax: 5,
      volRatioMin: 1.4,         // 量比 > 1.4
      turnoverMin: 5,           // 换手 5%-10%（黄金区间 6%-9%）
      turnoverMax: 10,
      floatMvMinYi: 50,         // 流通市值 50-200 亿
      floatMvMaxYi: 200,
      limitUpIn20: true,        // 20 日内有涨停
      aboveRateMin: 0.8,        // 分时全天水上比例（留 20% 容差，避免单根抖动误杀）
      devFromAvgMax: 1.0,       // 现价偏离分时均价上限（%），超出则放弃
      boardFundTopN: 3,         // 所属板块属当日资金净流入前 N（概念为主口径）
      minListedDays: 100,       // 上市不足 N 天排除
      excludeGemStar: true,     // 排除科创/创业/北交所（20cm/30cm 隔夜波动过大）
      // 情绪周期门禁
      promoteRateOk: 0.23,      // 晋级率 ≥ 23% 为主升
      promoteRateWeak: 0.15,    // < 15% 为退潮
      brokenRateMax: 30,        // 炸板率 < 30%
      limitDownMax: 15,         // 跌停家数 < 15
      limitDownForceEmpty: 30,  // 跌停 > 30 家强制空仓
      indexDropMax: -1.5,       // 大盘跌幅 > 1.5% 强制空仓
    },
    risk: '中高风险',
    holding: '1 天',
    available: true,
    // 前端展示用（需求 6.1）
    winRateNote: '约 60%-65%（基于历史规则回测，非实盘保证）',
    riskNote: '隔夜突发消息风险',
    // 时间窗（需求 4.2）：非窗口内不产生新信号，但可开复盘模式用最近交易日演算
    window: { select: '14:30-14:55', buy: '14:55-15:00', sell: '次日 09:30-10:00' },
    reviewable: true,
  },
  // —— 事件类 ——
  {
    id: 'event',
    name: '事件驱动',
    category: '事件类',
    desc: '基于公告 / 题材事件驱动的择时（数据源接入后启用）',
    params: {},
    risk: '—',
    holding: '—',
    available: false,
    unavailableReason:
      '公告与题材事件源在当前环境不可用（财联社电报接口在当前 AkShare 版本不存在、巨潮资讯公告接口参数不匹配、雪球人气榜网络失败），暂未接入。接入前该战法不产生任何信号——不用推断值冒充真实事件。',
  },
];

const S = Object.fromEntries(STRATEGY_DEFS.map((s) => [s.id, s]));

/**
 * 判定单只候选命中哪些战法
 * @param {Object} ind computeIndicators 结果
 * @param {Object} snap 行情快照（code / changePct / turnoverRate / floatMvYi / pe / limitUp）
 * @param {Object} ctx 上下文，含 ctx.limitPool（涨停池连板结构）
 *
 * 条件分三态：pass（通过）/ fail（未通过）/ na（数据缺失，不参与判定）。
 * 命中率只在「可判定条件」上计算，避免用缺失项把好票误杀。
 */
export function evaluateStrategies(ind, snap, ctx = {}, overrides = null) {
  if (!ind) return [];
  const hits = [];
  /** 战法参数：默认值为需求文档给定值，用户可在前端覆盖 */
  const P = (id) => (overrides?.[id] ? { ...S[id].params, ...overrides[id] } : S[id].params);

  // 龙回头结构展开到 ind 上（无历史涨停段时各项为 null，由条件标 na）
  ind = {
    ...ind,
    prevBoardCount: ind.dragon?.prevBoardCount ?? null,
    restDays: ind.dragon?.restDays ?? null,
    prevLimitBase: ind.dragon?.prevLimitBase ?? null,
    prevLimitPrice: ind.dragon?.prevLimitPrice ?? null,
    volSumRatio: ind.dragon?.volSumRatio ?? null,
  };

  // K 线根数门槛：历史不足时 MA60/MA40 不可靠，
  // 若不设门槛，新股会因「可判定条件变少」而被误判为突破（实测 N安达上市首日即命中）。
  const MIN_BARS = {
    'ultra-short': 20,
    dragon: 60,
    'first-board': 20,
    'trend-break': 60,
    'board-advance': 20,
    'pullback-buy': 60,
    'dragon-return': 60,
    'oversold-bounce': 30,
    'volume-price-up': 20,
    'ma-bull': 60,
    'overnight-hold': 20,
    event: 60,
  };
  const barsOk = (id) => ind.bars >= (MIN_BARS[id] ?? 60);
  const pct = snap.changePct;
  const turn = snap.turnoverRate;
  const floatMv = snap.floatMvYi;
  const vr = ind.volRatio20;
  const vr5 = ind.volRatio5;

  /** 命中判定：可判定条件中通过数占比 */
  const judge = (conds, minRatio) => {
    const usable = conds.filter((c) => !c.na);
    if (!usable.length) return false;
    return usable.filter((c) => c.pass).length / usable.length >= minRatio;
  };
  const ratio = (conds) => {
    const usable = conds.filter((c) => !c.na);
    if (!usable.length) return 0;
    return usable.filter((c) => c.pass).length / usable.length;
  };

  /**
   * 统一收口：
   *  - 不可用战法不产生信号
   *  - K 线根数不足不产生信号
   *  - gates（必要条件）：已知且明确失败即淘汰；数据缺失(na)不拦截，
   *    沿用「缺失不参与判定」原则
   *  - conds（可选条件）：与 gates 一起算可判定命中率，需达到 minRatio
   *
   * 为什么要区分 gates：实测发现若只用命中率阈值，会出现
   * 「连板数不达标却命中连板晋级」「没连涨却命中量价齐升」这类标签错配——
   * 战法的身份条件必须硬约束，不能靠其他条件加分补齐。
   */
  const push = (id, { gates = [], conds = [], minRatio = 1 }) => {
    const def = S[id];
    if (!def || def.available === false) return;
    if (!barsOk(id)) return;
    for (const g of gates) if (!g.pass && !g.na) return;
    // 身份条件全部不可判定时不产生信号。
    // 否则会出现「定义该战法的结构压根没取到，却因为可选条件好而命中」——
    // 实测龙回头在无前期连板数据时命中 67 只，全是噪声。
    if (gates.length && gates.every((g) => g.na)) return;
    const all = [...gates, ...conds];
    if (!judge(all, minRatio)) return;
    hits.push({ id, name: def.name, conds: all, hitRatio: ratio(all) });
  };

  const c = (key, pass, na, detail) => ({ key, pass, na, detail });
  const naNum = (v) => v == null;

  // ---- 上下文派生量（缺失一律为 null，由调用方标 na） ----
  const code = String(snap.code);
  const bm = ctx.board;
  const boardName = bm?.codeToBoard?.get(code) ?? null;
  const boardPct = boardName != null ? (bm?.boardPct?.get(boardName) ?? null) : null;
  /** 板块涨幅在全市场板块中的分位（0-1） */
  const boardPctRank =
    boardPct != null && bm?.sortedBoardPcts?.length ? percentile(bm.sortedBoardPcts, boardPct) : null;
  /** 板块涨幅排名（1 = 最高） */
  const boardRank =
    boardPct != null && bm?.sortedBoardPcts?.length
      ? bm.sortedBoardPcts.filter((v) => v > boardPct).length + 1
      : null;
  const boardLimitUp = boardName != null ? (bm?.boardLimitUpCount?.get(boardName) ?? null) : null;
  /** 主力净流入（元），AkShare 全市场资金流排名 */
  const fundNet = ctx.fundRank?.byCode?.get(code) ?? null;
  const sent = ctx.sentiment ?? null;

  // 涨停池个股结构（连板数 / 炸板 / 封板时间 / 封单金额）
  const lp = ctx.limitPool;
  const lpItem = lp?.available ? lp?.byCode?.get(code) ?? null : null;
  /** 首次封板时间 '092500' → 92500 */
  const firstSealNum = lpItem?.firstSeal ? Number(String(lpItem.firstSeal).replace(/\D/g, '')) : null;

  // 1. 首板打板（需求 2.2）：封板时间 / 封单 / 实体阳线 / 板块协同
  {
    const p = P('first-board');
    const lim = snap.limitUp || { isLimitUp: false };
    const bodyUp = ind.close > ind.last.open;
    // 实体阳线占比 = |收-开| / (高-低)，排除长上影与一字板
    const range = ind.last.high - ind.last.low;
    const bodyRatio = range > 0 ? (Math.abs(ind.close - ind.last.open) / range) * 100 : null;
    // 封单金额 > 流通市值 3%（封板资金来自涨停池，流通市值来自行情）
    const sealAmtPct =
      lpItem?.sealYuan != null && floatMv != null && floatMv > 0
        ? (lpItem.sealYuan / (floatMv * 1e8)) * 100
        : null;
    // 排除：科创板（688）、上市 <100 天次新（K 线根数不足）
    const isStar = /^688/.test(code);
    const isNew = ind.bars < 100;
    push('first-board', {
      gates: [
        c('当日涨停', lim.isLimitUp, naNum(pct), pct != null
          ? `涨跌幅 ${pct.toFixed(2)}%（${lim.isLimitUp ? '按 ' + lim.limitType + ' 限制推断' : '未达涨停'}）`
          : '缺失'),
        c('实体阳线', bodyUp, false, `收 ${ind.close} 开 ${ind.last.open}`),
        c('首板非连板', !(lpItem && lpItem.board >= 2), !lpItem,
          lpItem ? `涨停池连板数 ${lpItem.board}${lpItem.board >= 2 ? '（属连板，不计首板）' : '（首板）'}` : '涨停池无该股，按推断判定'),
        c('非科创板', !isStar, false, isStar ? '科创板（688），需求排除' : '非 688'),
        c('非次新股', !isNew, false, isNew ? `K 线 ${ind.bars} 根 < 100（上市不足 100 天）` : `${ind.bars} 根`),
      ],
      conds: [
        c('封板时间', firstSealNum != null && firstSealNum >= p.sealEarly && firstSealNum <= p.sealLate,
          naNum(firstSealNum),
          firstSealNum != null
            ? `首次封板 ${String(firstSealNum).padStart(6, '0')}（要求 ${p.sealEarly}-${p.sealLate}）`
            : '涨停池未提供封板时间'),
        c('量能放大', vr != null && vr >= p.volRatioMin, naNum(vr),
          vr != null ? `量/20日均量 ${vr.toFixed(2)}（要求 ≥${p.volRatioMin}）` : '不可算'),
        c('实体占比', bodyRatio != null && bodyRatio >= p.bodyRatioMin, naNum(bodyRatio),
          bodyRatio != null ? `实体占振幅 ${bodyRatio.toFixed(0)}%（要求 >${p.bodyRatioMin}%）` : '不可算'),
        c('封单充足', sealAmtPct != null && sealAmtPct >= p.sealAmtPctOfFloat, naNum(sealAmtPct),
          sealAmtPct != null ? `封单占流通市值 ${sealAmtPct.toFixed(2)}%（要求 >${p.sealAmtPctOfFloat}%）` : '封板资金缺失'),
        c('换手合理', turn != null && turn >= p.turnoverMin && turn <= p.turnoverMax, naNum(turn),
          turn != null ? `换手 ${turn.toFixed(2)}%（要求 ${p.turnoverMin}-${p.turnoverMax}%）` : '休市无换手数据'),
        c('流通市值区间', floatMv != null && floatMv >= p.floatMvMinYi && floatMv <= p.floatMvMaxYi, naNum(floatMv),
          floatMv != null ? `流通 ${floatMv.toFixed(1)} 亿（要求 ${p.floatMvMinYi}-${p.floatMvMaxYi} 亿）` : '缺失'),
        c('板块协同', boardRank != null && boardLimitUp != null && boardRank <= p.boardTopN && boardLimitUp >= p.boardLimitUpMin,
          boardRank == null || boardLimitUp == null,
          boardName
            ? `板块「${boardName}」涨幅第 ${boardRank ?? '—'} 名 · 板块内涨停 ${boardLimitUp ?? '—'} 只（要求前 ${p.boardTopN} 且 ≥${p.boardLimitUpMin} 只）`
            : '该股不在板块映射中'),
      ],
      minRatio: 0.6,
    });
  }

  // 2. 连板晋级（需求 2.3）：板位 2/3 板 + 换手 10-25% + 晋级率 + 连板高度 + 炸板率
  {
    const p = P('board-advance');
    if (lpItem) {
      push('board-advance', {
        // 板位是本战法的身份条件，必须硬达标
        gates: [
          c('关注板位', lpItem.board >= p.boardMin && lpItem.board <= p.boardMax, false,
            `涨停池连板数 ${lpItem.board}（要求 ${p.boardMin}-${p.boardMax} 板）`),
          c('封板未炸', lpItem.broken === 0, false, `炸板 ${lpItem.broken} 次`),
        ],
        conds: [
          c('换手充分', turn != null && turn >= p.turnoverMin && turn <= p.turnoverMax, naNum(turn),
            turn != null ? `换手 ${turn.toFixed(2)}%（要求 ${p.turnoverMin}-${p.turnoverMax}%，排除一字板到底）` : '休市无换手数据'),
          c('市场晋级率', sent?.promoteRate != null && sent.promoteRate >= p.promoteRateMin, naNum(sent?.promoteRate),
            sent?.promoteRate != null ? `晋级率 ${(sent.promoteRate * 100).toFixed(1)}%（要求 ≥${p.promoteRateMin * 100}%）` : '晋级率未取到'),
          c('连板高度', sent?.maxBoard != null && sent.maxBoard >= p.maxBoardMin, naNum(sent?.maxBoard),
            sent?.maxBoard != null ? `最高 ${sent.maxBoard} 板（要求 ≥${p.maxBoardMin}）` : '涨停池未取到'),
          c('炸板率健康', sent?.brokenRate != null && sent.brokenRate < p.brokenRateMax, naNum(sent?.brokenRate),
            sent?.brokenRate != null ? `炸板率 ${sent.brokenRate}%（要求 <${p.brokenRateMax}%）` : '涨停池未取到'),
        ],
        minRatio: 0.6,
      });
    }
  }

  // 3. 趋势突破（需求 2.5）：均线排列 + 量能 1.8 倍 + 突破 30 日新高 + ATR 波动放大
  {
    const p = P('trend-break');
    const maOk = ind.ma20 != null && ind.ma40 != null && ind.ma60 != null && ind.ma20 > ind.ma40 && ind.ma40 > ind.ma60;
    const breakout = ind.high30 != null && ind.close >= ind.high30 * p.breakoutTolerance;
    const atrExpand = ind.atr14?.expanding ?? null;
    push('trend-break', {
      conds: [
        c('均线多头', maOk, ind.ma20 == null || ind.ma40 == null || ind.ma60 == null, 'MA20>MA40>MA60'),
        c('量能放大', vr != null && vr >= p.volRatioMin, naNum(vr), vr != null ? `量/20日均量 ${vr.toFixed(2)}（要求 ≥${p.volRatioMin}）` : '不可算'),
        c('突破30日新高', breakout, naNum(ind.high30), ind.high30 != null ? `现价 ${ind.close} vs 30日高 ${ind.high30}` : '不足 30 根'),
        c('ATR波动放大', atrExpand != null && atrExpand >= p.atrExpandMin, naNum(atrExpand),
          atrExpand != null ? `ATR14/ATR7 ${atrExpand.toFixed(2)}（要求 ≥${p.atrExpandMin}）` : 'K 线不足，ATR 不可算'),
      ],
      minRatio: 0.75,
    });
  }

  // 4. 均线多头（需求 2.10）：标准多头 + 5 日均量>20 日均量 + 距 MA60 乖离<12%
  {
    const p = P('ma-bull');
    const bull = ind.ma5 != null && ind.ma10 != null && ind.ma20 != null && ind.ma60 != null &&
      ind.ma5 > ind.ma10 && ind.ma10 > ind.ma20 && ind.ma20 > ind.ma60;
    const rising = ind.ma20Prev5 != null && ind.ma20 != null && ind.ma20 > ind.ma20Prev5;
    // 脱离底部幅度：现价相对近 60 日低点的涨幅
    const offBottom = ind.low60 ? ((ind.close - ind.low60) / ind.low60) * 100 : null;
    push('ma-bull', {
      gates: [
        c('完全多头排列', bull, ind.ma5 == null || ind.ma10 == null || ind.ma20 == null || ind.ma60 == null, 'MA5>MA10>MA20>MA60'),
        c('站上MA5', ind.ma5 != null && ind.close > ind.ma5, naNum(ind.ma5), ind.ma5 != null ? `现价 ${ind.close} vs MA5 ${ind.ma5.toFixed(2)}` : '不足 5 根'),
      ],
      conds: [
        c('MA20上行', rising, naNum(ind.ma20Prev5), ind.ma20Prev5 != null
          ? `MA20 ${ind.ma20.toFixed(2)} vs 5日前 ${ind.ma20Prev5.toFixed(2)}`
          : '不足 25 根'),
        c('量能确认', ind.volMa5Over20 != null && ind.volMa5Over20 >= p.volMa5Over20Min, naNum(ind.volMa5Over20),
          ind.volMa5Over20 != null ? `5日均量/20日均量 ${ind.volMa5Over20.toFixed(2)}（要求 >${p.volMa5Over20Min}）` : '不可算'),
        c('乖离可控', ind.bias60 != null && ind.bias60 <= p.bias60Max, naNum(ind.bias60),
          ind.bias60 != null ? `距 MA60 乖离 ${ind.bias60.toFixed(1)}%（要求 <${p.bias60Max}%）` : '不足 60 根'),
        c('未脱离底部', offBottom != null && offBottom <= p.bottomRangeMax, naNum(offBottom),
          offBottom != null ? `距 60 日低点 +${offBottom.toFixed(1)}%（要求 <${p.bottomRangeMax}%）` : '不可算'),
      ],
      minRatio: 0.6,
    });
  }

  // 5. 龙头（需求 2.4）：连板高度≥3 或板块内涨幅前 3 + 阶段涨幅领先 + 站稳 MA60
  {
    const p = P('dragon');
    const heightOk = (lpItem?.board ?? 0) >= p.boardHeightMin || (sent?.maxBoard ?? 0) >= p.boardHeightMin;
    const topInBoard = boardRank != null && boardRank <= p.boardTopN;
    push('dragon', {
      gates: [
        c('站稳 MA60', ind.ma60 != null && ind.close > ind.ma60, naNum(ind.ma60),
          ind.ma60 != null ? `现价 ${ind.close} vs MA60 ${ind.ma60.toFixed(2)}` : '不足 60 根'),
      ],
      conds: [
        c('连板高度', heightOk, lpItem == null && sent?.maxBoard == null,
          lpItem ? `连板 ${lpItem.board} 板 / 市场最高 ${sent?.maxBoard ?? '—'} 板（要求 ≥${p.boardHeightMin}）` : '涨停池无该股，按市场最高板判定'),
        c('板块内领先', topInBoard, boardRank == null,
          boardName ? `板块「${boardName}」内涨幅第 ${boardRank ?? '—'} 名（要求前 ${p.boardTopN}）` : '该股不在板块映射中'),
        c('阶段涨幅领先', ind.chg20 != null && ind.chg20 >= p.chg20Min, naNum(ind.chg20),
          ind.chg20 != null ? `20日 ${ind.chg20.toFixed(1)}%（要求 ≥${p.chg20Min}%）` : '不足 21 根 K 线'),
        c('换手充分', turn != null && turn >= p.turnoverMin && turn <= p.turnoverMax, naNum(turn),
          turn != null ? `换手 ${turn.toFixed(2)}%（要求 ${p.turnoverMin}-${p.turnoverMax}%）` : '休市无换手数据'),
      ],
      minRatio: 0.75,
    });
  }

  // 6. 低吸回踩（需求 2.6）：前期涨幅 20-30% + 缩量至峰值 30-50% + 回撤≤15% + 调整≤10日 + MACD/KDJ 金叉
  {
    const p = P('pullback-buy');
    // 调整天数：自 30 日高点之后经过的交易日数
    const adjustDays = ind.adjustDays ?? null;
    push('pullback-buy', {
      // 回踩动作是本战法的身份条件
      gates: [
        c('回踩MA10支撑', ind.lowNearMa10 === true, naNum(ind.lowNearMa10),
          ind.ma10 != null ? `最低 ${ind.last.low} vs MA10 ${ind.ma10.toFixed(2)}（±5%~+2% 内视为回踩）` : '不足 10 根'),
        c('收盘收回MA10', ind.ma10 != null && ind.close > ind.ma10, naNum(ind.ma10),
          ind.ma10 != null ? `收 ${ind.close} vs MA10 ${ind.ma10.toFixed(2)}` : '不足 10 根'),
      ],
      conds: [
        c('中期趋势向上', ind.ma20 != null && ind.ma60 != null && ind.ma20 > ind.ma60,
          naNum(ind.ma20) || naNum(ind.ma60), 'MA20>MA60'),
        c('前期涨幅', ind.chg20 != null && ind.chg20 >= p.prevGainMin && ind.chg20 <= p.prevGainMax, naNum(ind.chg20),
          ind.chg20 != null ? `20日 ${ind.chg20.toFixed(1)}%（要求 ${p.prevGainMin}-${p.prevGainMax}%）` : '不足 21 根'),
        c('缩量至峰值', ind.volShrinkRatio != null && ind.volShrinkRatio >= p.volShrinkMin && ind.volShrinkRatio <= p.volShrinkMax,
          naNum(ind.volShrinkRatio),
          ind.volShrinkRatio != null ? `今量/20日峰值量 ${(ind.volShrinkRatio * 100).toFixed(0)}%（要求 ${p.volShrinkMin * 100}-${p.volShrinkMax * 100}%）` : '不可算'),
        c('回撤可控', ind.drawdown30 != null && ind.drawdown30 >= p.drawdownMin, naNum(ind.drawdown30),
          ind.drawdown30 != null ? `距30日高 ${ind.drawdown30.toFixed(1)}%（要求 ≥${p.drawdownMin}%）` : '不足 30 根'),
        c('调整周期', adjustDays != null && adjustDays <= p.adjustDaysMax, naNum(adjustDays),
          adjustDays != null ? `高点后 ${adjustDays} 日（要求 ≤${p.adjustDaysMax}）` : '不可算'),
        c('技术金叉', ind.macd?.goldenCross === true || ind.kdj?.goldenCross === true,
          ind.macd == null && ind.kdj == null,
          ind.macd || ind.kdj
            ? `MACD ${ind.macd?.goldenCross ? '金叉' : '—'} · KDJ ${ind.kdj?.goldenCross ? '金叉' : '—'}`
            : 'K 线不足，MACD/KDJ 不可算'),
      ],
      minRatio: 0.6,
    });
  }

  // 7. 龙回头（需求 2.7）：前期 2-3 连板 + 断板调整 3-8 天 + 守住防守线 + 突破前涨停价
  {
    const p = P('dragon-return');
    // 防守线 = 涨停前一日收盘价 × (1 + 3%~8%)
    const defense = ind.prevLimitBase != null ? ind.prevLimitBase * (1 + p.defenseLow / 100) : null;
    // 必须存在「已断板的前期连板段」，否则根本不是龙回头。
    // 实测：无此判定时会命中 67 只噪声（前期连板/断板天数全为 na，却因其他条件达标而入选）。
    if (ind.dragon) {
      push('dragon-return', {
        // 「前期连板 + 断板调整 + 今日反攻」共同定义龙回头，缺一不可
        gates: [
        c('前期连板', ind.prevBoardCount != null && ind.prevBoardCount >= p.prevBoardMin && ind.prevBoardCount <= p.prevBoardMax,
          naNum(ind.prevBoardCount),
          ind.prevBoardCount != null ? `前期连板 ${ind.prevBoardCount} 个（要求 ${p.prevBoardMin}-${p.prevBoardMax}）` : 'K 线不足，连板数不可算'),
        c('断板调整天数', ind.restDays != null && ind.restDays >= p.restDaysMin && ind.restDays <= p.restDaysMax,
          naNum(ind.restDays),
          ind.restDays != null ? `断板后 ${ind.restDays} 日（要求 ${p.restDaysMin}-${p.restDaysMax}）` : '不可算'),
        c('今日反攻', ind.close > ind.prev.close, false, `收 ${ind.close} vs 昨收 ${ind.prev.close}`),
      ],
      conds: [
        c('守住防守线', defense != null && ind.close >= defense, naNum(defense),
          defense != null ? `现价 ${ind.close} vs 防守线 ${defense.toFixed(2)}（涨停前收盘 ×${1 + p.defenseLow / 100}）` : '涨停基准价缺失'),
        c('突破前涨停价', ind.prevLimitPrice != null && ind.close >= ind.prevLimitPrice * p.breakPrevLimitUp,
          naNum(ind.prevLimitPrice),
          ind.prevLimitPrice != null ? `现价 ${ind.close} vs 前涨停价 ${ind.prevLimitPrice.toFixed(2)}（×${p.breakPrevLimitUp}）` : '前涨停价不可算'),
        c('量能累和达标', ind.volSumRatio != null && ind.volSumRatio >= p.volSumRatioMin, naNum(ind.volSumRatio),
          ind.volSumRatio != null ? `回调期量能/二板后两日量能 ${ind.volSumRatio.toFixed(2)}（要求 ≥${p.volSumRatioMin}）` : '不可算'),
        c('未破MA20', ind.ma20 != null && ind.close > ind.ma20, naNum(ind.ma20),
          ind.ma20 != null ? `收 ${ind.close} vs MA20 ${ind.ma20.toFixed(2)}` : '不足 20 根'),
      ],
      minRatio: 0.6,
      });
    }
  }

  // 8. 超跌反弹（需求 2.8）：BIAS 超跌（主板 -8% / 创业科创 -12%）+ RSI<30 + 上穿 MA3 + 放量
  {
    const p = P('oversold-bounce');
    const isGemOrStar = /^(30|68)/.test(code);
    const biasThreshold = isGemOrStar ? p.biasGem : p.biasMain;
    push('oversold-bounce', {
      // BIAS 达标 + 上穿 MA3 定义「超跌」与「反弹触发」两个要件
      gates: [
        c('乖离达标', ind.bias20 != null && ind.bias20 <= biasThreshold, naNum(ind.bias20),
          ind.bias20 != null ? `BIAS20 ${ind.bias20.toFixed(1)}%（${isGemOrStar ? '创业/科创' : '主板'}要求 ≤${biasThreshold}%）` : '不足 20 根'),
        c('上穿MA3', ind.ma3Cross?.crossed === true, naNum(ind.ma3Cross),
          ind.ma3Cross ? `MA3 ${ind.ma3Cross.ma3.toFixed(2)} · ${ind.ma3Cross.crossed ? '今日上穿' : '未上穿'}` : '不足 4 根'),
      ],
      conds: [
        c('RSI超卖', ind.rsi14 != null && ind.rsi14 <= p.rsiMax, naNum(ind.rsi14),
          ind.rsi14 != null ? `RSI14 ${ind.rsi14.toFixed(1)}（要求 <${p.rsiMax}）` : 'K 线不足，RSI 不可算'),
        c('KDJ超卖', ind.kdj?.j != null && ind.kdj.j <= p.kdjJMax, naNum(ind.kdj?.j),
          ind.kdj?.j != null ? `KDJ J ${ind.kdj.j.toFixed(1)}（要求 <${p.kdjJMax}）` : 'K 线不足，KDJ 不可算'),
        c('放量确认', vr != null && vr >= p.volRatioMin, naNum(vr),
          vr != null ? `量/20日均量 ${vr.toFixed(2)}（要求 ≥${p.volRatioMin}）` : '不可算'),
        c('流动性达标', snap.amountYuan != null && snap.amountYuan >= p.liquidityMinYuan, naNum(snap.amountYuan),
          snap.amountYuan != null ? `成交额 ${(snap.amountYuan / 1e8).toFixed(2)} 亿（要求 ≥${p.liquidityMinYuan / 1e8} 亿）` : '成交额缺失'),
      ],
      minRatio: 0.5,
    });
  }

  // 9. 超短线（需求 2.1）：量比≥2.5 + 换手 8-15% + MA 多头 + 流通<100 亿 + 情绪与资金确认
  {
    const p = P('ultra-short');
    push('ultra-short', {
      gates: [
        c('量比达标', vr != null && vr >= p.volRatioMin, naNum(vr),
          vr != null ? `量/20日均量 ${vr.toFixed(2)}（腾讯无量比字段，此为替代口径，要求 ≥${p.volRatioMin}）` : '不可算'),
        c('换手活跃', turn != null && turn >= p.turnoverMin && turn <= p.turnoverMax, naNum(turn),
          turn != null ? `换手 ${turn.toFixed(2)}%（要求 ${p.turnoverMin}-${p.turnoverMax}%）` : '休市无换手数据'),
        c('当日上涨', pct != null && pct > 0, naNum(pct), pct != null ? `${pct.toFixed(2)}%` : '缺失'),
      ],
      conds: [
        c('均线多头', ind.ma5 != null && ind.ma10 != null && ind.ma20 != null && ind.ma5 > ind.ma10 && ind.ma10 > ind.ma20,
          ind.ma5 == null || ind.ma10 == null || ind.ma20 == null, 'MA5>MA10>MA20'),
        c('小市值', floatMv != null && floatMv <= p.floatMvMaxYi, naNum(floatMv),
          floatMv != null ? `流通 ${floatMv.toFixed(1)} 亿（要求 <${p.floatMvMaxYi} 亿）` : '缺失'),
        c('乖离可控', ind.bias20 != null && ind.bias20 < p.bias20Max, naNum(ind.bias20),
          ind.bias20 != null ? `BIAS20 ${ind.bias20.toFixed(1)}%（要求 <${p.bias20Max}%）` : '不足 20 根'),
        c('主力净流入', fundNet != null && fundNet > p.fundNetMin, naNum(fundNet),
          fundNet != null ? `主力净额 ${(fundNet / 1e8).toFixed(2)} 亿（要求 >0）` : '该股不在资金流排名中'),
        c('板块效应', boardPct != null && boardPct > p.boardChangeMin, naNum(boardPct),
          boardName ? `板块「${boardName}」涨幅 ${boardPct.toFixed(2)}%（要求 >${p.boardChangeMin}%）` : '该股不在板块映射中'),
        c('炸板率健康', sent?.brokenRate != null && sent.brokenRate < p.brokenRateMax, naNum(sent?.brokenRate),
          sent?.brokenRate != null ? `炸板率 ${sent.brokenRate}%（要求 <${p.brokenRateMax}%）` : '涨停池未取到'),
        c('连板高度', sent?.maxBoard != null && sent.maxBoard >= p.maxBoardMin, naNum(sent?.maxBoard),
          sent?.maxBoard != null ? `最高 ${sent.maxBoard} 板（要求 ≥${p.maxBoardMin}）` : '涨停池未取到'),
        c('昨日涨停溢价', sent?.prevLimitUpPerf != null && sent.prevLimitUpPerf > p.prevLimitUpPerfMin, naNum(sent?.prevLimitUpPerf),
          sent?.prevLimitUpPerf != null ? `昨日涨停今日表现 ${sent.prevLimitUpPerf.toFixed(2)}%（要求 >${p.prevLimitUpPerfMin}%）` : '未接入'),
      ],
      minRatio: 0.7,
    });
  }

  // 10. 量价齐升（需求 2.9）：涨幅 2-9% + 量比 1.1-5 + 换手 4-10% + 市值 30-300 亿
  {
    const p = P('volume-price-up');
    push('volume-price-up', {
      // 「价升」与「量增」同时成立才算量价齐升
      gates: [
        c('涨幅区间', pct != null && pct >= p.changeMin && pct <= p.changeMax, naNum(pct),
          pct != null ? `涨跌幅 ${pct.toFixed(2)}%（要求 ${p.changeMin}-${p.changeMax}%，排除涨停与微涨）` : '缺失'),
        c('今收>昨收', ind.close > ind.prev.close, false, `收 ${ind.close} vs 昨收 ${ind.prev.close}`),
        c('今量>昨量', ind.last.volume > ind.prev.volume, false,
          `今量 ${ind.last.volume} vs 昨量 ${ind.prev.volume}`),
      ],
      conds: [
        c('量比区间', vr != null && vr >= p.volRatioMin && vr <= p.volRatioMax, naNum(vr),
          vr != null ? `量/20日均量 ${vr.toFixed(2)}（要求 ${p.volRatioMin}-${p.volRatioMax}）` : '不可算'),
        c('换手合理', turn != null && turn >= p.turnoverMin && turn <= p.turnoverMax, naNum(turn),
          turn != null ? `换手 ${turn.toFixed(2)}%（要求 ${p.turnoverMin}-${p.turnoverMax}%）` : '休市无换手数据'),
        c('市值区间', floatMv != null && floatMv >= p.floatMvMinYi && floatMv <= p.floatMvMaxYi, naNum(floatMv),
          floatMv != null ? `流通 ${floatMv.toFixed(1)} 亿（要求 ${p.floatMvMinYi}-${p.floatMvMaxYi} 亿）` : '缺失'),
        c('均线多头', ind.ma5 != null && ind.ma10 != null && ind.ma20 != null && ind.ma5 > ind.ma10 && ind.ma10 > ind.ma20,
          ind.ma5 == null || ind.ma10 == null || ind.ma20 == null, 'MA5>MA10>MA20'),
        c('主力净流入', fundNet != null && fundNet > 0, naNum(fundNet),
          fundNet != null ? `主力净额 ${(fundNet / 1e8).toFixed(2)} 亿（要求 >0）` : '该股不在资金流排名中'),
        c('强于大盘', pct != null && sent?.indexChangePct != null && pct > sent.indexChangePct,
          pct == null || sent?.indexChangePct == null,
          pct != null && sent?.indexChangePct != null
            ? `个股 ${pct.toFixed(2)}% vs 上证 ${sent.indexChangePct.toFixed(2)}%`
            : '指数涨跌幅未取到'),
      ],
      minRatio: 0.6,
    });
  }

  // 11. 隔夜持股法：尾盘买入 → 次日 10:00 前强制卖出，持仓仅 1 个交易日
  {
    push('overnight-hold', overnightChecks({ ind, snap, ctx, p: P('overnight-hold'), pct, vr, turn, floatMv, c, naNum }));
  }


  // 12. 事件驱动：数据源未接入，不产生信号（见 STRATEGY_DEFS 的 unavailableReason）

  return hits;
}

/**
 * 隔夜持股法的条件集合。
 *
 * 单独抽出来是因为「为什么今天 0 命中」必须能解释清楚：这套战法的硬指标叠加后
 * 经常一只都不剩；若诊断另写一套判定，口径迟早和命中逻辑走偏，用户会看到
 * 「明细说通过、结果说没命中」的矛盾。现在命中判定与未命中解释共用这一份实现。
 */
function overnightChecks({ ind, snap, ctx, p, pct, vr, turn, floatMv, c, naNum }) {
  const sent = ctx.sentiment;
  // 分时结构：缺失时相关条件标 na，不把它当成「不满足」而误杀
  const ts = ind.intraday ?? null;
      // —— 排除条件：全部在代码/名称层面判定，不依赖外部行情 ——
      const code6 = String(snap.code ?? '').replace(/\D/g, '').padStart(6, '0');
      const isGem = /^(300|301)/.test(code6);
      const isStar = /^(688|689)/.test(code6);
      const isBj = /^(4|8|920)/.test(code6);
      const isSt = /ST/i.test(snap.name ?? '');
      const boardTag = isBj ? '北交所(30cm)' : isStar ? '科创板(20cm)' : isGem ? '创业板(20cm)' : null;

      // 上市天数：通达信 get_finance_info 的 ipo_date 是本项目唯一可得的上市日期来源
      const ipoDays = snap.ipoDate
        ? Math.floor((Date.now() - new Date(snap.ipoDate).getTime()) / 86400000)
        : null;

      // —— 情绪周期门禁（需求第三章）：退潮/冰点强制空仓 ——
      const promoteRate = sent?.promoteRate ?? null;
      const limitDown = sent?.limitDownCount ?? null;
      const idxPct = sent?.indexChangePct ?? null;
      const isRetreat =
        (promoteRate != null && promoteRate < p.promoteRateWeak) ||
        (limitDown != null && limitDown > p.limitDownForceEmpty) ||
        (idxPct != null && idxPct < p.indexDropMax);
      // 三项都取不到时视为「情绪不可判定」，不强制空仓（不能因数据缺失假装退潮）
      const sentimentKnown = promoteRate != null || limitDown != null || idxPct != null;

      // —— 板块归属（概念为主口径、行业为校验）来自 efinance 反向查询 ——
      // 用「个股所属板块在资金流排名表中的最佳排名」而不是简单判断名字是否在前 3。
      // 原因：东财概念资金流表混入了同花顺口径的名称（如"同花顺漂亮100""证金持股""高股息精选"），
      // 与 get_belong_board 返回的东财 BK 板块名不重合。实测某日概念前 3 全是同花顺口径时，
      // 按名字匹配会 0 命中（不是没有好票，是两套名字对不上）。改成按最佳排名判定后，
      // 概念对不上时行业排名可以兜底（行业名如"银行""化学制药"是标准名，一致率高）。
      const boards = ctx.belong?.byCode?.get(String(snap.code)) ?? null;
      const bf = ctx.boardFund;
      const bestRank = (rankMap) => {
        if (!boards || !rankMap) return null;
        let best = null;
        for (const b of boards) {
          const r = rankMap[b]?.rank;
          if (r != null && (best == null || r < best)) best = r;
        }
        return best;
      };
      const conceptRank = bestRank(bf?.conceptRank);
      const industryRank = bestRank(bf?.industryRank);
      const topN = p.boardFundTopN ?? 3;
      const inFundTop = (conceptRank != null && conceptRank <= topN) || (industryRank != null && industryRank <= topN);
      const fundTopNa = conceptRank == null && industryRank == null;
      const rankDetail =
        `概念最佳排名 ${conceptRank ?? '—'} / 行业最佳排名 ${industryRank ?? '—'}（要求任一 ≤${topN}）` +
        (bf?.conceptTop3?.length ? `；当日概念前 3：${bf.conceptTop3.map((x) => x.name).join('/')}` : '') +
        (bf?.industryTop3?.length ? `；行业前 3：${bf.industryTop3.map((x) => x.name).join('/')}` : '');

      return {
        gates: [
          c('非ST', !isSt, snap.name == null, snap.name ? `${snap.name}${isSt ? '（ST 股）' : ''}` : '名称未取到'),
          c('非科创/创业/北交', !boardTag, false,
            boardTag ? `${code6} 属${boardTag}，隔夜波动过大已排除` : `${code6} 属 10cm 主板`),
          c('上市满100天', ipoDays != null && ipoDays >= p.minListedDays, ipoDays == null,
            ipoDays != null ? `上市 ${ipoDays} 天（要求 ≥${p.minListedDays}）` : '上市日期未取到（通达信财务接口不可用）'),
          c('情绪非空仓', !isRetreat, !sentimentKnown,
            sentimentKnown
              ? `晋级率 ${promoteRate ?? '—'} · 跌停 ${limitDown ?? '—'} 家 · 大盘 ${idxPct != null ? idxPct.toFixed(2) + '%' : '—'}${isRetreat ? ' → 退潮，强制空仓' : ''}`
              : '情绪数据未取到'),
          c('涨幅3-5%', pct != null && pct >= p.changeMin && pct <= p.changeMax, naNum(pct),
            pct != null ? `${pct.toFixed(2)}%（要求 ${p.changeMin}-${p.changeMax}%）` : '缺失'),
          c('量比>1.4', vr != null && vr >= p.volRatioMin, naNum(vr),
            vr != null ? `量/20日均量 ${vr.toFixed(2)}（要求 ≥${p.volRatioMin}）` : '不可算'),
          c('换手5-10%', turn != null && turn >= p.turnoverMin && turn <= p.turnoverMax, naNum(turn),
            turn != null ? `换手 ${turn.toFixed(2)}%（要求 ${p.turnoverMin}-${p.turnoverMax}%）` : '休市无换手数据'),
          c('流通市值50-200亿', floatMv != null && floatMv >= p.floatMvMinYi && floatMv <= p.floatMvMaxYi, naNum(floatMv),
            floatMv != null ? `流通 ${floatMv.toFixed(1)} 亿（要求 ${p.floatMvMinYi}-${p.floatMvMaxYi}）` : '缺失'),
          c('站稳MA5', ind.ma5 != null && ind.close > ind.ma5, naNum(ind.ma5),
            ind.ma5 != null ? `收 ${ind.close} vs MA5 ${ind.ma5.toFixed(2)}` : '不足 5 根'),
          c('20日内有涨停', ind.limitUpCount20 != null && ind.limitUpCount20 > 0, naNum(ind.limitUpCount20),
            ind.limitUpCount20 != null ? `20 日内涨停 ${ind.limitUpCount20} 次` : '不可算'),
          c('分时全天水上', ts != null && ts.aboveRate != null && ts.aboveRate >= p.aboveRateMin,
            ts == null || ts.aboveRate == null,
            ts?.aboveRate != null
              ? `水上 ${ts.aboveCount}/${ts.judgedCount} 根（${(ts.aboveRate * 100).toFixed(0)}%，要求 ≥${(p.aboveRateMin * 100).toFixed(0)}%）`
              : '分时数据未取到'),
          c('板块资金流前3', inFundTop, fundTopNa,
            fundTopNa ? '板块归属未取到（efinance 反向查询不可用）' : rankDetail),
        ],
        conds: [
          c('MA5向上', ind.ma5 != null && ind.ma5Prev != null && ind.ma5 > ind.ma5Prev,
            ind.ma5 == null || ind.ma5Prev == null,
            ind.ma5 != null && ind.ma5Prev != null
              ? `MA5 ${ind.ma5.toFixed(2)} vs 昨日 ${ind.ma5Prev.toFixed(2)}`
              : '不足 6 根'),
          c('尾盘创当日新高', ts?.tailNewHigh === true, ts?.tailNewHigh == null,
            ts?.tailNewHigh == null ? '分时数据未取到'
              : `14:30 后高 ${ts.tailHigh} vs 前高 ${ts.preHigh}（${ts.tailNewHigh ? '创新高' : '未创新高'}）`),
          c('尾盘回踩不破均价', ts?.tailHold === true, ts?.tailHold == null,
            ts?.tailHold == null ? '分时数据未取到' : `尾盘 ${ts.tailBars} 根${ts.tailHold ? '全部收在均价上方' : '有收破均价'}`),
          c('阶梯温和放量', ts?.stepUp === true, ts?.stepUp == null,
            ts?.stepUp == null ? '分时数据未取到'
              : `脉冲比 ${ts.pulseRatio?.toFixed(2)}（要求后半段放量且 <3）`),
          c('未脱离均价', ts != null && ts.devFromAvg != null && ts.devFromAvg <= p.devFromAvgMax,
            ts == null || ts.devFromAvg == null,
            ts?.devFromAvg != null ? `偏离均价 ${ts.devFromAvg.toFixed(2)}%（要求 ≤${p.devFromAvgMax}%）` : '分时数据未取到'),
          c('行业板块校验', industryRank != null && industryRank <= topN, industryRank == null,
            industryRank == null ? '板块归属未取到'
              : `行业最佳排名 ${industryRank}${industryRank <= topN ? '（校验通过）' : '（未进前 3，仅校验不否决）'}`),
        ],
        minRatio: 0.7,
      };
}

/** 未命中时给外部（选股结果）复用的判定明细 */
export function overnightDiagnose(ind, snap, ctx = {}, overrides = null) {
  const def = S['overnight-hold'];
  if (!def) return null;
  const p = overrides?.['overnight-hold']
    ? { ...def.params, ...overrides['overnight-hold'] }
    : def.params;
  const c = (key, pass, na, detail) => ({ key, pass, na, detail });
  const naNum = (v) => v == null;
  const r = overnightChecks({
    ind, snap, ctx, p,
    pct: snap.changePct,
    vr: ind.volRatio20,
    turn: snap.turnoverRate,
    floatMv: snap.floatMvYi,
    c, naNum,
  });
  const all = [...r.gates, ...r.conds];
  return {
    gates: r.gates,
    conds: r.conds,
    failed: all.filter((x) => !x.pass && !x.na).map((x) => ({ key: x.key, detail: x.detail })),
    missing: all.filter((x) => x.na).map((x) => ({ key: x.key, detail: x.detail })),
    blockedBy: all.filter((x) => !x.pass && !x.na).map((x) => x.key),
  };
}


// ---------- 确定性评分 ----------

/**
 * 需求权重：技术面 30% / 资金面 25% / 情绪面 20% / 板块面 15% / 基本面 10%
 * 缺失因子不参与，权重按可用因子重新归一化。
 */
const FACTOR_WEIGHTS = [
  { key: 'technical', name: '技术面', weight: 0.3 },
  { key: 'capital', name: '资金面', weight: 0.25 },
  { key: 'sentiment', name: '情绪面', weight: 0.2 },
  { key: 'sector', name: '板块面', weight: 0.15 },
  { key: 'fundamental', name: '基本面', weight: 0.1 },
];

/** 在有序数组中求 v 的百分位（0-1） */
function percentile(sorted, v) {
  if (!sorted.length) return null;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * @param {Object} ind
 * @param {Object} snap
 * @param {Object} ctx 额外上下文
 *   ctx.fundRank = { byCode: Map<code,netYuan>, sortedNets: number[] }
 *   ctx.sentiment = { limitUpCount, maxBoard, brokenRate }
 *   ctx.board = { boardPct: Map<name, changePct>, codeToBoard: Map<code, name>, sortedBoardPcts: number[] }
 */
export function scoreCandidate(ind, snap, ctx = {}, strategyId = null) {
  const factors = [];

  // 隔夜持股法使用独立权重与归一化规则（v4.1 第五章）：
  // 技术 35 / 资金 25 / 情绪 25 / 板块 15，基本面 0（隔夜持仓不涉及中长期基本面）。
  // 通用权重不能直接套用，故单独实现。
  if (strategyId === 'overnight-hold') return overnightScore(ind, snap, ctx);

  // 技术面：子条件命中率
  const techConds = [
    ind.ma5 != null && ind.ma10 != null && ind.ma20 != null && ind.ma5 > ind.ma10 && ind.ma10 > ind.ma20,
    ind.volRatio20 != null && ind.volRatio20 >= 1.5,
    ind.close > ind.prev.close,
    ind.ma20 != null && ind.close > ind.ma20,
    ind.high30 != null && ind.close >= ind.high30 * 0.98,
  ];
  const techScore = (techConds.filter(Boolean).length / techConds.length) * 100;
  factors.push({
    key: 'technical',
    name: '技术面',
    weight: FACTOR_WEIGHTS[0].weight,
    score: +techScore.toFixed(1),
    available: true,
    detail: `子条件命中 ${techConds.filter(Boolean).length}/${techConds.length}（均线排列/量能/上涨/站上MA20/接近30日高）`,
  });

  // 资金面：主力净额在全市场的分位数（AkShare 全市场资金流排名）
  {
    const fr = ctx.fundRank;
    const net = fr?.byCode?.get(String(snap.code)) ?? null;
    if (net != null && fr.sortedNets?.length) {
      const pctRank = percentile(fr.sortedNets, net);
      factors.push({
        key: 'capital',
        name: '资金面',
        weight: FACTOR_WEIGHTS[1].weight,
        score: +((pctRank ?? 0) * 100).toFixed(1),
        available: true,
        detail: `主力净额 ${(net / 1e8).toFixed(2)} 亿，全市场分位 ${((pctRank ?? 0) * 100).toFixed(1)}%`,
      });
    } else {
      factors.push({
        key: 'capital',
        name: '资金面',
        weight: FACTOR_WEIGHTS[1].weight,
        score: null,
        available: false,
        detail: fr?.available === false ? '资金流排名未取到，本因子未纳入评分' : '该股不在资金流排名中，本因子未纳入评分',
      });
    }
  }

  // 情绪面：涨停家数 / 连板高度 / 炸板率（AkShare 涨停池）
  {
    const s = ctx.sentiment;
    if (s && s.limitUpCount != null) {
      const byCount = s.limitUpCount >= 50 ? 90 : s.limitUpCount >= 30 ? 75 : s.limitUpCount >= 15 ? 60 : 45;
      const byBoard = (s.maxBoard ?? 1) >= 5 ? 90 : (s.maxBoard ?? 1) === 4 ? 80 : (s.maxBoard ?? 1) === 3 ? 70 : 55;
      const br = s.brokenRate ?? 0;
      const byBroken = br < 15 ? 85 : br < 30 ? 65 : 45;
      factors.push({
        key: 'sentiment',
        name: '情绪面',
        weight: FACTOR_WEIGHTS[2].weight,
        score: +((byCount + byBoard + byBroken) / 3).toFixed(1),
        available: true,
        detail: `涨停 ${s.limitUpCount} 家 · 最高 ${s.maxBoard ?? '—'} 板 · 炸板率 ${br}%（涨停家数/连板高度/炸板率三项均分）`,
      });
    } else {
      factors.push({
        key: 'sentiment',
        name: '情绪面',
        weight: FACTOR_WEIGHTS[2].weight,
        score: null,
        available: false,
        detail: '涨停池未取到，本因子未纳入评分',
      });
    }
  }

  // 板块面：所属板块涨幅在全市场板块中的分位（60%）+ 个股相对板块强弱（40%）
  {
    const bm = ctx.board;
    const bname = bm?.codeToBoard?.get(String(snap.code)) ?? null;
    const bpct = bname != null ? (bm.boardPct?.get(bname) ?? null) : null;
    if (bname && bpct != null && bm.sortedBoardPcts?.length) {
      const bRank = percentile(bm.sortedBoardPcts, bpct) ?? 0.5;
      // 相对强度：个股涨幅 - 板块涨幅，跑赢 5 个百分点约 +25 分
      const rs = (snap.changePct ?? 0) - bpct;
      const rsScore = clamp(50 + rs * 5, 0, 100);
      factors.push({
        key: 'sector',
        name: '板块面',
        weight: FACTOR_WEIGHTS[3].weight,
        score: +(bRank * 100 * 0.6 + rsScore * 0.4).toFixed(1),
        available: true,
        detail:
          `所属板块「${bname}」涨幅 ${bpct.toFixed(2)}%，板块分位 ${(bRank * 100).toFixed(1)}%` +
          ` · 相对板块 ${rs >= 0 ? '+' : ''}${rs.toFixed(2)} 个百分点`,
      });
    } else {
      factors.push({
        key: 'sector',
        name: '板块面',
        weight: FACTOR_WEIGHTS[3].weight,
        score: null,
        available: false,
        detail: bm?.available === false
          ? '板块映射未取到，本因子未纳入评分'
          : '该股不在板块映射中，本因子未纳入评分',
      });
    }
  }

  // 基本面：PE
  let fundScore = null;
  if (snap.pe != null) {
    fundScore = snap.pe <= 0 ? 20 : snap.pe < 30 ? 80 : snap.pe < 60 ? 60 : snap.pe < 100 ? 45 : 30;
  }
  factors.push({
    key: 'fundamental',
    name: '基本面',
    weight: FACTOR_WEIGHTS[4].weight,
    score: fundScore,
    available: fundScore != null,
    detail: snap.pe != null ? `PE ${snap.pe.toFixed(2)}` : 'PE 缺失，本因子未纳入评分',
  });

  const usable = factors.filter((f) => f.available);
  const weightSum = usable.reduce((s, f) => s + f.weight, 0);
  const total = weightSum
    ? usable.reduce((s, f) => s + f.score * (f.weight / weightSum), 0)
    : null;

  // 情绪周期乘数（需求第三章）：晋级率 ≥0.23 主升 ×1.15；<0.15 退潮 ×0.85；其余不变
  // 晋级率缺失（池不足 10 家或未取到）时乘数为 1，不猜测情绪。
  const promoteRate = ctx.sentiment?.promoteRate ?? null;
  let multiplier = 1;
  let cycle = null;
  if (promoteRate != null) {
    if (promoteRate >= 0.23) {
      multiplier = 1.15;
      cycle = '主升';
    } else if (promoteRate < 0.15) {
      multiplier = 0.85;
      cycle = '退潮';
    } else {
      multiplier = 1;
      cycle = '震荡';
    }
  }
  const baseTotal = total != null ? +total.toFixed(1) : null;
  const adjusted = baseTotal != null ? +Math.min(100, baseTotal * multiplier).toFixed(1) : null;

  const missing = factors.filter((f) => !f.available).map((f) => f.name);

  return {
    total: adjusted,
    baseTotal,
    /** 情绪乘数与周期阶段，null 表示晋级率未取到、不参与调节 */
    multiplier,
    cycle,
    factors,
    missingFactors: missing,
    /** 权重被重新归一化，说明实际覆盖度 */
    coverage: +(weightSum * 100).toFixed(0),
    note:
      missing.length > 0
        ? `评分仅覆盖 ${Math.round(weightSum * 100)}% 权重（${missing.join('、')} 因数据源限制未纳入）`
        : '全因子覆盖',
  };
}

/** 隔夜持股法权重：技术 35 / 资金 25 / 情绪 25 / 板块 15，基本面 0 */
const OVERNIGHT_WEIGHTS = { technical: 0.35, capital: 0.25, sentiment: 0.25, sector: 0.15 };

/**
 * 隔夜持股法专用评分（v4.1 第五章）
 *
 * 与通用评分的两点差异：
 *  1. 权重不同 —— 情绪面从 20% 提到 25%（隔夜溢价高度依赖次日开盘情绪），基本面降为 0
 *  2. 归一化规则不同 —— 每个因子有明确的加分项与分值（如技术面 涨幅+30/量比+25/换手+20/水上+15/尾盘新高+10）
 *
 * 同样遵守三态原则：某项数据不可得就不计分也不计分母，绝不当成 0 分拉低总分。
 */
function overnightScore(ind, snap, ctx = {}) {
  const p = S['overnight-hold'].params;
  const pct = snap.changePct;
  const turn = snap.turnoverRate;
  const vr = ind.volRatio20;
  const ts = ind.intraday ?? null;
  const factors = [];

  /** 一组加分项 → 因子分（可得项内归一化到 0-100） */
  const byItems = (key, name, weight, items) => {
    const usable = items.filter((x) => !x.na);
    const got = usable.reduce((s, x) => s + (x.pass ? x.max : 0), 0);
    const full = usable.reduce((s, x) => s + x.max, 0);
    const score = full > 0 ? (got / full) * 100 : null;
    factors.push({
      key,
      name,
      weight,
      score: score != null ? +score.toFixed(1) : null,
      available: score != null,
      detail: usable.length
        ? usable.map((x) => `${x.name}${x.pass ? '✓' : '✗'}(${x.detail})`).join(' · ')
        : '全部子项数据缺失，本因子未纳入评分',
    });
  };

  // 技术面 35%
  byItems('technical', '技术面', OVERNIGHT_WEIGHTS.technical, [
    { name: '涨幅', max: 30, na: pct == null, pass: pct != null && pct >= p.changeMin && pct <= p.changeMax,
      detail: pct != null ? `${pct.toFixed(2)}%` : '缺失' },
    { name: '量比', max: 25, na: vr == null, pass: vr != null && vr >= p.volRatioMin,
      detail: vr != null ? vr.toFixed(2) : '不可算' },
    { name: '换手', max: 20, na: turn == null, pass: turn != null && turn >= p.turnoverMin && turn <= p.turnoverMax,
      detail: turn != null ? `${turn.toFixed(2)}%` : '缺失' },
    { name: '分时水上', max: 15, na: ts?.aboveRate == null, pass: ts?.aboveRate != null && ts.aboveRate >= p.aboveRateMin,
      detail: ts?.aboveRate != null ? `${(ts.aboveRate * 100).toFixed(0)}%` : '分时未取到' },
    { name: '尾盘新高', max: 10, na: ts?.tailNewHigh == null, pass: ts?.tailNewHigh === true,
      detail: ts?.tailNewHigh == null ? '分时未取到' : ts.tailNewHigh ? '是' : '否' },
  ]);

  // 资金面 25%：主力净流入正负 + 净额全市场分位
  // 需求还列了「大单净额正负」，但当前资金流通道只有主力净额，
  // 没有大单拆分，故不纳入（不用主力净额冒充大单）。
  {
    const fr = ctx.fundRank;
    const net = fr?.byCode?.get(String(snap.code)) ?? null;
    const rankScore =
      net != null && fr?.sortedNets?.length ? (percentile(fr.sortedNets, net) ?? 0) * 100 : null;
    const posScore = net == null ? null : net > 0 ? 100 : 0;
    const parts = [posScore, rankScore].filter((v) => v != null);
    const score = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
    factors.push({
      key: 'capital',
      name: '资金面',
      weight: OVERNIGHT_WEIGHTS.capital,
      score: score != null ? +score.toFixed(1) : null,
      available: score != null,
      detail:
        net != null
          ? `主力净额 ${(net / 1e8).toFixed(2)} 亿（${net > 0 ? '净流入' : '净流出'}）` +
            (rankScore != null ? ` · 全市场分位 ${rankScore.toFixed(0)}%` : '') +
            ' · 大单净额通道未提供，未纳入'
          : '该股不在资金流排名中，本因子未纳入评分',
    });
  }

  // 情绪面 25%：晋级率 / 炸板率 / 连板高度 / 涨停跌停家数比
  {
    const s = ctx.sentiment;
    const parts = [];
    const d = [];
    if (s?.promoteRate != null) {
      parts.push(clamp((s.promoteRate / 0.3) * 100, 0, 100));
      d.push(`晋级率 ${(s.promoteRate * 100).toFixed(0)}%`);
    }
    if (s?.brokenRate != null) {
      parts.push(clamp(100 - s.brokenRate * 2, 0, 100));
      d.push(`炸板率 ${s.brokenRate}%`);
    }
    if (s?.maxBoard != null) {
      parts.push(clamp((s.maxBoard / 6) * 100, 0, 100));
      d.push(`最高 ${s.maxBoard} 板`);
    }
    if (s?.limitUpCount != null && s?.limitDownCount != null) {
      const ratio = s.limitDownCount > 0 ? s.limitUpCount / s.limitDownCount : s.limitUpCount;
      parts.push(clamp((ratio / 5) * 100, 0, 100));
      d.push(`涨停/跌停 ${s.limitUpCount}/${s.limitDownCount}`);
    }
    const score = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
    factors.push({
      key: 'sentiment',
      name: '情绪面',
      weight: OVERNIGHT_WEIGHTS.sentiment,
      score: score != null ? +score.toFixed(1) : null,
      available: score != null,
      detail: score != null ? d.join(' · ') : '情绪数据未取到，本因子未纳入评分',
    });
  }

  // 板块面 15%：概念板块资金流前 3(+60) + 所属板块涨幅 >1%(+40)
  {
    const boards = ctx.belong?.byCode?.get(String(snap.code)) ?? null;
    const bf = ctx.boardFund;
    const bestRank = (rankMap) => {
      if (!boards || !rankMap) return null;
      let best = null;
      for (const b of boards) {
        const r = rankMap[b]?.rank;
        if (r != null && (best == null || r < best)) best = r;
      }
      return best;
    };
    const cr = bestRank(bf?.conceptRank);
    const ir = bestRank(bf?.industryRank);
    // 与判定一致：概念（主口径）或行业（校验/兜底）任一进前 3
    const inTop = (cr != null && cr <= 3) || (ir != null && ir <= 3);
    const topNa = cr == null && ir == null;
    const bm = ctx.board;
    const bname = bm?.codeToBoard?.get(String(snap.code)) ?? null;
    const bpct = bname != null ? (bm?.boardPct?.get(bname) ?? null) : null;
    byItems('sector', '板块面', OVERNIGHT_WEIGHTS.sector, [
      { name: '板块资金流前3', max: 60, na: topNa, pass: inTop === true,
        detail: topNa ? '板块归属未取到'
          : `概念排名 ${cr ?? '—'} / 行业排名 ${ir ?? '—'}${inTop ? '（命中）' : '（未进前3）'}` },
      { name: '板块涨幅>1%', max: 40, na: bpct == null, pass: bpct != null && bpct > 1,
        detail: bpct != null ? `${bpct.toFixed(2)}%` : '板块映射未取到' },
    ]);
  }

  const usable = factors.filter((f) => f.available);
  const weightSum = usable.reduce((s, f) => s + f.weight, 0);
  const baseTotal = weightSum
    ? +usable.reduce((s, f) => s + f.score * (f.weight / weightSum), 0).toFixed(1)
    : null;

  const promoteRate = ctx.sentiment?.promoteRate ?? null;
  let multiplier = 1;
  let cycle = null;
  if (promoteRate != null) {
    if (promoteRate >= 0.23) {
      multiplier = 1.15;
      cycle = '主升';
    } else if (promoteRate < 0.15) {
      multiplier = 0.85;
      cycle = '退潮';
    } else {
      cycle = '震荡';
    }
  }
  const total = baseTotal != null ? +Math.min(100, baseTotal * multiplier).toFixed(1) : null;

  const missing = factors.filter((f) => !f.available).map((f) => f.name);
  return {
    total,
    baseTotal,
    multiplier,
    cycle,
    factors,
    missingFactors: missing,
    coverage: +(weightSum * 100).toFixed(0),
    // 信号强度分级（需求第五章）
    strength:
      total == null ? null : total >= 80 ? '极强' : total >= 65 ? '强' : total >= 50 ? '中' : '弱',
    note:
      missing.length > 0
        ? `评分仅覆盖 ${Math.round(weightSum * 100)}% 权重（${missing.join('、')} 因数据源限制未纳入）；基本面权重为 0（隔夜持仓不涉及中长期基本面）`
        : '全因子覆盖；基本面权重为 0（隔夜持仓不涉及中长期基本面）',
    weights: '技术 35% / 资金 25% / 情绪 25% / 板块 15%（隔夜持股法专用）',
  };
}

/**
 * 廉价预筛：仅用行情快照字段（名称/代码/涨幅/换手/市值）就能否定的候选，
 * 在拉 K 线 / 分时 / 上市日期之前直接剔除。
 *
 * 存在的理由：隔夜持股法要的是「涨幅 3-5%」这种中等涨幅，而候选池是按
 * 涨跌幅/成交额/换手率降序取 TopN —— 涨幅榜前排全是涨停票，
 * 3-5% 的票排在 100 名之后，小池子根本切不进来（实测池子 80 只时该条件 pass=0）。
 * 只有把池子放大到能覆盖中等涨幅区间，才谈得上判定；但池子一大，
 * 给每只都拉 K 线 + 分时 + 上市日期就太慢。
 * 解法：先用快照字段把绝大多数候选否掉（实测 2000 → 几十只），
 * 再对幸存者做重计算。这既保住了召回，也把耗时压在可接受范围。
 *
 * 只对本战法生效：其余战法的核心条件（均线/涨停历史/量价）依赖 K 线，
 * 快照字段不足以安全否定，贸然预筛会漏票。
 *
 * @returns true = 需要进入精算；false = 可安全剔除
 */
export function prefilterSnap(strategyId, snap, overrides = null, opts = {}) {
  if (strategyId !== 'overnight-hold') return true;
  const def = S[strategyId];
  if (!def) return true;
  const p = overrides?.[strategyId] ? { ...def.params, ...overrides[strategyId] } : def.params;

  // ST / *ST：名称层面即可判定，与 K 线无关
  if (/\*?ST/i.test(snap.name ?? '')) return false;

  // 板块：代码前缀判定（688/689 科创、300/301 创业、4/8/920 北交）
  const code6 = String(snap.code ?? '').replace(/\D/g, '').padStart(6, '0');
  if (/^(300|301|688|689|4|8|920)/.test(code6)) return false;

  // 流通市值：快照自带，盘前盘后同样有效
  const mv = snap.floatMvWan != null ? snap.floatMvWan / 10000 : null;
  if (mv != null && (mv < p.floatMvMinYi || mv > p.floatMvMaxYi)) return false;

  // 涨幅 / 换手：只在交易时段可信。非交易时段排行榜这两个字段为 0，
  // 若照常否定会把所有候选清空（盘后复盘会 0 命中），故此时跳过。
  if (opts.trading !== false) {
    const pct = snap.changePct;
    if (pct != null && (pct < p.changeMin || pct > p.changeMax)) return false;
    const turn = snap.turnoverRate;
    if (turn != null && (turn < p.turnoverMin || turn > p.turnoverMax)) return false;
  }

  return true;
}
