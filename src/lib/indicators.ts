import type { KlineRow } from '@/domain/types';

/**
 * 技术指标自算。
 * 原因：上游 K 线通道只提供 OHLCV，不返回任何指标值（通达信技术指标接口
 * 仅在会话内可用），因此 MA / MACD / KDJ / RSI / BOLL / ATR 一律在前端
 * 基于真实 K 线自算，绝不使用预置数值。
 *
 * 约定：所有 calc*Series 返回值与 rows 等长，历史不足处为 null，
 * 便于图表按索引取用；绝不用 0 补位。
 */

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

/** 指数移动平均，与输入等长，前 period-1 个为 null */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export interface MaSeries {
  ma5: (number | null)[];
  ma10: (number | null)[];
  ma20: (number | null)[];
  ma60: (number | null)[];
}

export function calcMA(rows: KlineRow[]): MaSeries {
  const closes = rows.map((r) => r.close);
  return {
    ma5: sma(closes, 5),
    ma10: sma(closes, 10),
    ma20: sma(closes, 20),
    ma60: sma(closes, 60),
  };
}

/** BOLL(20, 2) */
export function calcBOLL(rows: KlineRow[]) {
  const closes = rows.map((r) => r.close);
  const mid = sma(closes, 20);
  const upper: (number | null)[] = new Array(closes.length).fill(null);
  const lower: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    const m = mid[i];
    if (m == null) continue;
    const win = closes.slice(Math.max(0, i - 19), i + 1);
    let variance = 0;
    for (const v of win) variance += (v - m) ** 2;
    const sd = Math.sqrt(variance / win.length);
    upper[i] = m + 2 * sd;
    lower[i] = m - 2 * sd;
  }
  return { mid, upper, lower };
}

/** MACD(12, 26, 9) */
export function calcMACD(rows: KlineRow[]) {
  const closes = rows.map((r) => r.close);
  const n = closes.length;
  const dif: (number | null)[] = new Array(n).fill(null);
  const dea: (number | null)[] = new Array(n).fill(null);
  const bar: (number | null)[] = new Array(n).fill(null);
  if (!n) return { dif, dea, bar };
  const ef = ema(closes, 12);
  const es = ema(closes, 26);
  const difRaw: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (ef[i] == null || es[i] == null) continue;
    difRaw[i] = ef[i]! - es[i]!;
  }
  const start = difRaw.findIndex((v) => v != null);
  if (start >= 0) {
    const seq = difRaw.slice(start).map((v) => v as number);
    const deaSeq = ema(seq, 9);
    for (let j = 0; j < seq.length; j++) {
      const idx = start + j;
      dif[idx] = seq[j];
      if (deaSeq[j] != null) {
        dea[idx] = deaSeq[j];
        bar[idx] = 2 * (seq[j] - deaSeq[j]!);
      }
    }
  }
  return { dif, dea, bar };
}

/** KDJ(9,3,3) */
export function calcKDJ(rows: KlineRow[]) {
  const n = rows.length;
  const k: (number | null)[] = new Array(n).fill(null);
  const d: (number | null)[] = new Array(n).fill(null);
  const j: (number | null)[] = new Array(n).fill(null);
  let pk = 50;
  let pd = 50;
  for (let i = 8; i < n; i++) {
    const win = rows.slice(i - 8, i + 1);
    const high = Math.max(...win.map((r) => r.high));
    const low = Math.min(...win.map((r) => r.low));
    const rsv = high === low ? 50 : ((rows[i].close - low) / (high - low)) * 100;
    pk = (2 / 3) * pk + (1 / 3) * rsv;
    pd = (2 / 3) * pd + (1 / 3) * rsv;
    k[i] = pk;
    d[i] = pd;
    j[i] = 3 * pk - 2 * pd;
  }
  return { k, d, j };
}

/** RSI（Wilder，默认 14） */
export function calcRSI(rows: KlineRow[], period = 14): (number | null)[] {
  const n = rows.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < n; i++) {
    const diff = rows[i].close - rows[i - 1].close;
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  let ag = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let al = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period] = al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < n; i++) {
    ag += (gains[i - 1] - ag) / period;
    al += (losses[i - 1] - al) / period;
    out[i] = al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al);
  }
  return out;
}

/** ATR（Wilder，默认 14） */
export function calcATR(rows: KlineRow[], period = 14): (number | null)[] {
  const n = rows.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;
  const trs: number[] = [];
  for (let i = 1; i < n; i++) {
    const h = rows[i].high;
    const l = rows[i].low;
    const pc = rows[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let prev = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < n; i++) {
    prev = prev + (trs[i - 1] - prev) / period;
    out[i] = prev;
  }
  return out;
}

/** 区间统计：涨跌幅、最高、最低、累计量 */
export function rangeStats(rows: KlineRow[]) {
  if (!rows.length) return null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const high = Math.max(...rows.map((r) => r.high));
  const low = Math.min(...rows.map((r) => r.low));
  const volume = rows.reduce((s, r) => s + r.volume, 0);
  return {
    changePct: first.open ? ((last.close - first.open) / first.open) * 100 : null,
    high,
    low,
    volume,
    days: rows.length,
  };
}
