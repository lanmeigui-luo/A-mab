/**
 * prev-close.ts —— 昨收基准价校验与选取（纯函数，可离线验收）
 *
 * 【2026-11-25 口径重构】当日涨跌幅一律以 /api/quote 的 changePct / prevClose 为准，
 * 前端不得用日K推导当日涨跌幅。事故背景：sh600814 盘中日K不含当天，旧实现按数组位置
 * 取 length-2 退到前天 6.90，而接口昨收是 7.59 → 显示 +21.01%（真实 +10.01%）。
 * 日K只在接口缺失时兜底，且必须通过「日期新鲜度 + 极端偏离」双校验。
 * 极端偏离用于防复权断层，不是防除权除息本身：真正根因是盘中日K不含当天、按位置取会退到更早交易日。
 */

export interface PrevChange {
  change: number;
  changePct: number;
}

function parseLocalDate(date: string): Date | null {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(date + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 跳过周末，反推 date 的上一个交易日（法定节假日无日历，沿用项目既定近似） */
export function prevTradingDateGuess(date: string): string | null {
  const d = parseLocalDate(date);
  if (!d) return null;
  do { d.setDate(d.getDate() - 1); } while (d.getDay() === 0 || d.getDay() === 6);
  return fmtLocalDate(d);
}

/** 是否是可信的正数价格 */
export function isUsablePrevClose(prev: number | null | undefined): prev is number {
  return typeof prev === 'number' && Number.isFinite(prev) && prev > 0;
}

/** 接口昨收可用：正数，且不等于现价（相等=被污染成现价，908d51d 老问题） */
function isUsableQuotePrev(prev: number | null | undefined, price: number | null | undefined): prev is number {
  if (!isUsablePrevClose(prev)) return false;
  if (typeof price === 'number' && Number.isFinite(price) && price > 0 && prev === price) return false;
  return true;
}

export interface PrevCloseInput {
  /** /api/quote 的 prevClose */
  quotePrevClose: number | null | undefined;
  /** 日K行（至少含 date / close） */
  klineRows: { date?: string | null; close?: number | null }[] | null | undefined;
  /** 今天 YYYY-MM-DD */
  today: string;
  /** 现价，用于接口污染判断与极端偏离校验 */
  price?: number | null;
  /** 极端偏离阈值，默认 0.35（覆盖北交所 30% 上限） */
  maxDeviation?: number;
}

/**
 * 当日昨收的唯一来源。顺序：
 *  1) 接口 prevClose 有效（>0 且 != price）→ 直接用
 *  2) 否则按「日期 < today」取最后一根日K（绝不按 length-2 位置取）
 *  3) 日期新鲜度：bar.date 必须等于上一个交易日，否则判日K滞后 → null
 *  4) 极端偏离：|bar.close - price| / price > 35% → null（防复权断层）
 *  5) 全过 → bar.close
 */
export function resolveTodayPrevClose(input: PrevCloseInput): number | null {
  const { quotePrevClose, klineRows, today, price } = input;
  const maxDeviation = input.maxDeviation ?? 0.35;

  if (isUsableQuotePrev(quotePrevClose, price)) return quotePrevClose;

  const rows = Array.isArray(klineRows) ? klineRows : [];
  // 按日期取「严格早于今天」的最后一根，不按数组位置（盘中日K不含当天，位置取会退到前天）
  const bars = rows
    .filter((r) => typeof r?.date === 'string' && r.date < today)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const bar = bars[bars.length - 1];
  if (!bar || !isUsablePrevClose(bar.close)) return null;

  const expected = prevTradingDateGuess(today);
  if (!expected || bar.date !== expected) return null; // 日K滞后：最新 bar 不是上一个交易日

  if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
    if (Math.abs(bar.close - price) / price > maxDeviation) return null;
  }
  return bar.close;
}

/** 兼容旧调用点：按给定优先级取第一个可用值，不参与当日涨跌幅口径 */
export function resolvePrevClose(...candidates: (number | null | undefined)[]): number | null {
  for (const c of candidates) if (isUsablePrevClose(c)) return c;
  return null;
}

/** 基于选定基准重算涨跌额与涨跌幅；无基准返回 null（UI 显示「无基准价」） */
export function calcPrevChange(price: number | null | undefined, prev: number | null | undefined): PrevChange | null {
  if (!isUsablePrevClose(prev) || typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  const change = Math.round((price - prev) * 100) / 100;
  const changePct = Math.round(((price - prev) / prev) * 10000) / 100;
  return { change, changePct };
}

/** 分时数据里第一根有效价（昨收彻底缺失时用于纵轴范围，但不得据此算涨跌幅） */
export function firstValidPrice(prices: (number | null)[]): number | null {
  for (const p of prices) if (typeof p === 'number' && Number.isFinite(p) && p > 0) return p;
  return null;
}
