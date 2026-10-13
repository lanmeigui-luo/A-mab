/**
 * 技术指标（阶段 6 补齐：MACD / KDJ / RSI / BOLL / ATR / MA3）
 *
 * 原则：全部基于真实 OHLCV 自算，上游不提供任何指标值。
 * 所有函数在历史长度不足时返回 null，由调用方按「缺失不参与判定」处理，
 * 不用 0 或占位值填充。
 */

function sma(values, period) {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

/** 指数移动平均（EMA），period 起始用 SMA 作种子 */
function emaSeries(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  const out = [prev];
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** 最后一根的 EMA */
function emaLast(values, period) {
  const s = emaSeries(values, period);
  return s ? s[s.length - 1] : null;
}

/**
 * MACD：DIF = EMA12 - EMA26，DEA = EMA9(DIF)，MACD = 2 × (DIF - DEA)
 * 需要足够长的序列才能得到稳定的 DEA，低于 26+9 根时返回 null。
 */
export function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (!closes || closes.length < slow + signal) return null;
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  if (!ef || !es) return null;
  // 两条 EMA 起点不同（fast 从第 fast 根开始，slow 从第 slow 根开始），
  // 对齐到同一时间轴：以 slow 起点为基准
  const offset = slow - fast;
  const difSeries = [];
  for (let i = 0; i < es.length; i++) {
    difSeries.push(ef[i + offset] - es[i]);
  }
  const deaSeries = emaSeries(difSeries, signal);
  if (!deaSeries) return null;
  const dif = difSeries[difSeries.length - 1];
  const dea = deaSeries[deaSeries.length - 1];
  // 上一根，用于判断金叉/死叉
  const prevDif = difSeries.length > 1 ? difSeries[difSeries.length - 2] : null;
  const prevDea = deaSeries.length > 1 ? deaSeries[deaSeries.length - 2] : null;
  return {
    dif,
    dea,
    bar: 2 * (dif - dea),
    /** 金叉：上一根 DIF ≤ DEA 且本根 DIF > DEA */
    goldenCross: prevDif != null && prevDea != null && prevDif <= prevDea && dif > dea,
    deadCross: prevDif != null && prevDea != null && prevDif >= prevDea && dif < dea,
  };
}

/** Wilder 平滑（RSI / ATR 用），返回序列 */
function wilderSeries(values, period) {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  const out = [prev];
  for (let i = period; i < values.length; i++) {
    prev = prev + (values[i] - prev) / period;
    out.push(prev);
  }
  return out;
}

/** RSI（Wilder 口径） */
export function rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }
  const ag = wilderSeries(gains, period);
  const al = wilderSeries(losses, period);
  if (!ag || !al) return null;
  const avgGain = ag[ag.length - 1];
  const avgLoss = al[al.length - 1];
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * KDJ（9,3,3）
 * RSV = (C - Ln) / (Hn - Ln) × 100，K = 2/3 前K + 1/3 RSV，D = 2/3 前D + 1/3 K，J = 3K - 2D
 */
export function kdj(rows, n = 9, m1 = 3, m2 = 3) {
  if (!rows || rows.length < n) return null;
  let k = 50;
  let d = 50;
  let lastK = null;
  let lastD = null;
  for (let i = n - 1; i < rows.length; i++) {
    const win = rows.slice(i - n + 1, i + 1);
    const high = Math.max(...win.map((r) => r.high));
    const low = Math.min(...win.map((r) => r.low));
    const rsv = high === low ? 50 : ((rows[i].close - low) / (high - low)) * 100;
    lastK = k;
    lastD = d;
    k = (m1 - 1) / m1 * k + (1 / m1) * rsv;
    d = (m2 - 1) / m2 * d + (1 / m2) * rsv;
  }
  return {
    k,
    d,
    j: 3 * k - 2 * d,
    goldenCross: lastK != null && lastD != null && lastK <= lastD && k > d,
    deadCross: lastK != null && lastD != null && lastK >= lastD && k < d,
  };
}

/** BOLL（20, 2） */
export function boll(closes, period = 20, mult = 2) {
  if (!closes || closes.length < period) return null;
  const mid = sma(closes, period);
  if (mid == null) return null;
  const win = closes.slice(-period);
  let variance = 0;
  for (const v of win) variance += (v - mid) ** 2;
  const sd = Math.sqrt(variance / period);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd, sd };
}

/** ATR（Wilder，默认 14 日） */
export function atr(rows, period = 14) {
  if (!rows || rows.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < rows.length; i++) {
    const h = rows[i].high;
    const l = rows[i].low;
    const pc = rows[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const s = wilderSeries(trs, period);
  if (!s || !s.length) return null;
  const now = s[s.length - 1];
  // 7 日平均用于「波动性放大」判定（趋势突破的 ATR 条件）
  const s7 = wilderSeries(trs, 7);
  const avg7 = s7 && s7.length ? s7[s7.length - 1] : null;
  return {
    atr: now,
    atrPct: rows[rows.length - 1].close ? (now / rows[rows.length - 1].close) * 100 : null,
    /** 14 日 ATR 显著高于 7 日平均（需求 2.5：> 1.1 倍视为波动放大） */
    expanding: avg7 != null && avg7 > 0 ? now / avg7 : null,
  };
}

/** 上穿 MA3：前一日收盘 ≤ MA3，当日收盘 > MA3（超跌反弹触发条件） */
export function crossAboveMa3(rows) {
  if (!rows || rows.length < 4) return null;
  const closes = rows.map((r) => r.close);
  const ma3Now = sma(closes, 3);
  const ma3Prev = sma(closes.slice(0, -1), 3);
  const prevClose = rows[rows.length - 2].close;
  const nowClose = rows[rows.length - 1].close;
  if (ma3Now == null || ma3Prev == null) return null;
  return { ma3: ma3Now, crossed: prevClose <= ma3Prev && nowClose > ma3Now };
}

/** 近 N 日成交量峰值（低吸回踩缩量比计算用） */
export function volumePeak(rows, n = 20) {
  if (!rows || !rows.length) return null;
  const win = rows.slice(-n);
  let max = 0;
  let maxIdx = -1;
  for (let i = 0; i < win.length; i++) {
    if (win[i].volume > max) {
      max = win[i].volume;
      maxIdx = i;
    }
  }
  return { peakVolume: max, barsAgo: win.length - 1 - maxIdx };
}

/** 近 N 日涨停次数（个股股性） */
export function limitUpCount(rows, code, n = 20) {
  const isGemOrStar = /^(30|68)/.test(String(code || ''));
  const threshold = isGemOrStar ? 19.8 : 9.8;
  const win = rows.slice(-n);
  let count = 0;
  for (let i = 1; i < win.length; i++) {
    const prev = win[i - 1].close;
    if (!prev) continue;
    if (((win[i].close - prev) / prev) * 100 >= threshold) count++;
  }
  return count;
}

/**
 * 龙回头结构（需求 2.7）
 * 找出「最近一段已断板的连续涨停」，返回：
 *  - prevBoardCount 该段连板个数
 *  - restDays       断板后至今的交易日数
 *  - prevLimitBase  涨停前一日收盘价（防守线基准）
 *  - prevLimitPrice 该段最后一个涨停日的收盘价（前涨停价）
 *  - volSumRatio    回调期量能累和 / 连板段最后两日量能总和
 *
 * 若当前仍处连板中（最后一根就是涨停）或历史中无涨停段，返回 null。
 */
export function dragonStructure(rows, code) {
  if (!rows || rows.length < 10) return null;
  const isGemOrStar = /^(30|68)/.test(String(code || ''));
  const threshold = isGemOrStar ? 19.8 : 9.8;
  const isLimit = (i) => {
    if (i <= 0) return false;
    const prev = rows[i - 1].close;
    return prev ? ((rows[i].close - prev) / prev) * 100 >= threshold : false;
  };
  const n = rows.length;
  // 从倒数第二根往前找（最后一根是涨停说明仍在连板中，不属于「已断板」）
  let endIdx = -1;
  for (let i = n - 2; i >= 1; i--) {
    if (isLimit(i)) {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return null;
  // 向前扩展连续涨停段
  let startIdx = endIdx;
  while (startIdx - 1 >= 1 && isLimit(startIdx - 1)) startIdx--;
  const prevBoardCount = endIdx - startIdx + 1;
  const restDays = n - 1 - endIdx;
  const prevLimitBase = rows[startIdx - 1]?.close ?? null;
  const prevLimitPrice = rows[endIdx].close;
  // 回调期量能（断板后至今）
  let restVol = 0;
  for (let i = endIdx + 1; i < n; i++) restVol += rows[i].volume;
  // 连板段最后两日量能
  const boardVol2 = (rows[endIdx]?.volume ?? 0) + (rows[endIdx - 1]?.volume ?? 0);
  return {
    prevBoardCount,
    restDays,
    prevLimitBase,
    prevLimitPrice,
    volSumRatio: boardVol2 > 0 ? restVol / boardVol2 : null,
    restVolume: restVol,
  };
}

/** 距 30 日高点之后经过的交易日数（低吸回踩「调整周期」） */
export function daysSinceHigh(rows, window = 30) {
  if (!rows || !rows.length) return null;
  const win = rows.slice(-window);
  let maxHigh = -Infinity;
  let maxIdx = 0;
  for (let i = 0; i < win.length; i++) {
    if (win[i].high > maxHigh) {
      maxHigh = win[i].high;
      maxIdx = i;
    }
  }
  return win.length - 1 - maxIdx;
}

/**
 * 分时结构指标（隔夜持股法专用）
 *
 * 输入是通达信 5 分钟 K 线序列（tdx/server.py /intraday），每根已带
 * time / open / high / low / close / volume(手) / amount / cumAvg(当日累计均价)。
 *
 * 用 5 分钟 K 线而非分时明细接口的理由：pytdx 的 get_minute_time_data 返回的是
 * 压缩编码（price 出现过 -4885.56 这类值），无法还原；而 5 分钟 K 线能回溯
 * 全天序列，反而支撑「全天水上」「阶梯放量」这类需要时间序列的判定。
 *
 * @returns null 表示分时数据不可得，调用方应把相关条件标为 na 而非 false
 */
export function intradayStats(rows) {
  if (!rows || rows.length < 4) return null;
  const n = rows.length;
  const last = rows[n - 1];

  // 全天运行在分时均价线上方的比例
  let above = 0;
  let judged = 0;
  for (const r of rows) {
    if (r.cumAvg == null) continue;
    judged++;
    if (r.close > r.cumAvg) above++;
  }
  const aboveRate = judged ? above / judged : null;

  // 尾盘段：14:30 之后（5 分钟 bar 的时间戳是结束时间，故取 > 而非 >=）
  const tail = rows.filter((r) => r.time > '14:30');
  const pre = rows.filter((r) => r.time <= '14:30');
  const preHigh = pre.length ? Math.max(...pre.map((r) => r.high)) : null;
  const tailHigh = tail.length ? Math.max(...tail.map((r) => r.high)) : null;
  const tailNewHigh = preHigh != null && tailHigh != null ? tailHigh > preHigh : null;

  // 尾盘回踩均价不破：尾盘段每根收盘都在均价之上
  const tailHold = tail.length
    ? tail.every((r) => r.cumAvg == null || r.close >= r.cumAvg)
    : null;
  // 尾盘确有回踩动作（最低价触及均价附近，说明买点在均价支撑位）
  const tailTouched = tail.length
    ? tail.some((r) => r.cumAvg != null && r.low <= r.cumAvg * 1.003)
    : null;

  // 成交量形态：分段量能，判「阶梯式温和放大」vs「脉冲式爆量」
  const segN = Math.max(1, Math.floor(n / 6));
  const seg = [];
  for (let i = 0; i < n; i += segN) {
    seg.push(rows.slice(i, i + segN).reduce((a, b) => a + (b.volume || 0), 0));
  }
  const sorted = [...seg].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 0;
  const maxSeg = Math.max(...seg);
  // 脉冲比：最大段/中位段。比值过大说明是单笔爆量而非温和放大
  const pulseRatio = med > 0 ? maxSeg / med : null;
  const half = Math.floor(seg.length / 2);
  const firstHalf = seg.slice(0, half).reduce((a, b) => a + b, 0);
  const lastHalf = seg.slice(half).reduce((a, b) => a + b, 0);
  // 阶梯式温和放大：后半段量能高于前半段，且没有极端脉冲
  const stepUp = pulseRatio != null ? lastHalf > firstHalf && pulseRatio < 3 : null;

  // 现价相对当日均价的偏离（%). 用于「14:50 后脱离均价超过 1% 则放弃」
  const devFromAvg = last.cumAvg ? ((last.close - last.cumAvg) / last.cumAvg) * 100 : null;

  return {
    bars: n,
    date: last.date ?? null,
    dayAvg: last.cumAvg ?? null,
    close: last.close,
    aboveRate,
    aboveCount: above,
    judgedCount: judged,
    tailBars: tail.length,
    preHigh,
    tailHigh,
    tailNewHigh,
    tailHold,
    tailTouched,
    pulseRatio,
    stepUp,
    devFromAvg,
    segments: seg,
  };
}

export { sma, emaLast };
