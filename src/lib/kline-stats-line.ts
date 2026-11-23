/**
 * kline-stats-line.ts —— 图表底部统计文案（纯函数，可离线验收）
 * 分时模式的涨跌幅必须取头部同一口径 headerChangePct，不能用分钟线 stats.changePct。
 */
export interface StatsLineInput {
  days: number;
  changePct: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
}

const pctText = (v: number | null): string =>
  v == null || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(2);
const numText = (v: number | null): string =>
  v == null || !Number.isFinite(v) ? '—' : v.toFixed(2);
const volText = (v: number | null): string =>
  v == null || !Number.isFinite(v) ? '—' : String(v);

export function formatStatsLine(s: StatsLineInput, isIntraday: boolean, headerChangePct: number | null): string {
  const label = isIntraday ? '当日' : '区间';
  const unit = isIntraday ? '点' : '根';
  // 分时取头部同一口径（5s /api/quote），K线模式用自身 changePct
  const pct = isIntraday ? headerChangePct : s.changePct;
  return `${label} ${s.days} ${unit} · 涨跌 ${pctText(pct)}% · 最高 ${numText(s.high)} · 最低 ${numText(s.low)} · 累计量 ${volText(s.volume)}`;
}
