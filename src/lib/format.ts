/** 数值格式化：全部对 null 返回「—」，不做隐式补零 */

export const DASH = '—';

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return DASH;
  return v.toFixed(digits);
}

/** 成交额：万元 → 自动切换 万元/亿元/万亿元 */
export function fmtAmount(wan: number | null | undefined): string {
  if (wan == null || Number.isNaN(wan)) return DASH;
  const yuan = wan * 10000;
  const yi = yuan / 1e8;
  if (yi >= 1e4) return (yi / 1e4).toFixed(2) + ' 万亿';
  if (yi >= 1) return yi.toFixed(2) + ' 亿';
  if (yuan >= 1e4) return (yuan / 1e4).toFixed(2) + ' 万';
  return yuan.toFixed(0) + ' 元';
}

/** 成交量：手 → 手/万手/亿手 */
export function fmtVolume(hands: number | null | undefined): string {
  if (hands == null || Number.isNaN(hands)) return DASH;
  if (hands >= 1e8) return (hands / 1e8).toFixed(2) + ' 亿手';
  if (hands >= 1e4) return (hands / 1e4).toFixed(2) + ' 万手';
  return hands.toFixed(0) + ' 手';
}

/** 市值：亿元 */
export function fmtMv(yi: number | null | undefined): string {
  if (yi == null || Number.isNaN(yi)) return DASH;
  if (yi >= 1e4) return (yi / 1e4).toFixed(2) + ' 万亿';
  return yi.toFixed(2) + ' 亿';
}

/** 指数点位：千分位 */
export function fmtIndex(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return DASH;
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 时间串 20260928161401 → 09-28 16:14 */
export function fmtUpdatedAt(raw: string): string {
  if (!raw) return DASH;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/.exec(raw.trim());
  if (!m) return raw;
  const [, y, mo, d, h, mi] = m;
  const date = `${mo}-${d}`;
  return h ? `${date} ${h}:${mi ?? '00'}` : `${y}-${date}`;
}
