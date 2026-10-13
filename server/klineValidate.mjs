/**
 * K 线批次真实数据校验。
 *
 * 为什么要这层校验：
 *   通达信公共服务器对「指数」等标的的 bar 缓冲区解析会损坏 —— 返回的 batch 里
 *   只有首根正常，其余日期变成 "3984-75-38"、成交量变成 1.22e111 之类乱码，
 *   但接口仍然 ok=true（不是连接失败）。因此「ok 才用主源」的逻辑会放行垃圾，
 *   前端直接把乱码渲染成蜡烛图（表现为"K线不对"）。
 *
 *   这层校验在"放行主源"之前再卡一道：任意一根不合法就判定整批损坏，交回调用方降级。
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// 量/额 sanity 上限：A 股单只日成交量（手）实际不超过 ~1e9；指数在新浪口径下 ~1e9 手。
// 留足余量到 1e13（手）/ 1e15（元），足以拦截 1e111 这类乱码，又不误伤正常数据。
const MAX_VOL = 1e13;
const MAX_AMOUNT = 1e15;

export function isKlineRowValid(r) {
  if (!r || typeof r !== 'object') return false;
  // 日期：必须 4-2-2 且年份落在 1990~2100、月 1~12、日 1~31。
  // （注意 "3984-75-38" 这种虽然月日都是两位，但年份 3984、月 75 超出范围）
  const m = DATE_RE.exec(r.date);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;

  const o = r.open;
  const c = r.close;
  const h = r.high;
  const l = r.low;
  const v = r.volume;
  const a = r.amount;
  if (![o, c, h, l].every((x) => typeof x === 'number' && Number.isFinite(x))) return false;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_VOL) return false;
  if (a != null && !(typeof a === 'number' && Number.isFinite(a) && a >= 0 && a <= MAX_AMOUNT)) return false;
  // OHLC 自洽：最高 >= max(开,收)，最低 <= min(开,收)
  if (h < Math.max(o, c) - 1e-6) return false;
  if (l > Math.min(o, c) + 1e-6) return false;
  if (h < l - 1e-6) return false;
  return true;
}

/**
 * 整批校验：空批 / 任一坏行 → 判定损坏。
 * @param {Array|null} rows
 * @returns {boolean} true 表示数据可放心使用
 */
export function isKlineBatchValid(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  for (const r of rows) {
    if (!isKlineRowValid(r)) return false;
  }
  return true;
}
