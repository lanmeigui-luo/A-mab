/**
 * buy-range-label.ts —— 买入区间展示口径（纯函数，可离线验收）
 *
 * 后端 buildTradePlan 在两种情况下把 buyLow/buyHigh 置 null 并写入原因：
 *  1) 当日封板涨停：buyBlockedByLimitUp=true，buyBasis='涨停不可买入…'
 *  2) 未命中可用战法 / 数据不足：buyBasis 写明缺口
 * 前端过去只显示 '—'，用户看不懂。这里统一转成明确文案 + 告警色调。
 */

export interface BuyRangeSource {
  buyLow?: number | null;
  buyHigh?: number | null;
  buyBasis?: string | null;
  buyBlockedByLimitUp?: boolean;
  /** 计划计算时缺失的输入字段（仅作说明，不影响文案判定） */
  missing?: string[];
}

export interface BuyRangeLabel {
  text: string;
  /** warn = 橙黄色告警；normal = 常规 */
  tone: 'normal' | 'warn';
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

export function describeBuyRange(rec: BuyRangeSource | null | undefined): BuyRangeLabel {
  if (rec?.buyLow != null && rec.buyHigh != null) {
    return { text: fmt(rec.buyLow) + '~' + fmt(rec.buyHigh), tone: 'normal' };
  }
  if (rec?.buyBlockedByLimitUp === true) {
    return { text: '当日封板涨停，无法买入', tone: 'warn' };
  }
  const basis = (rec?.buyBasis || '').trim();
  if (basis.includes('未命中任何可用战法')) {
    return { text: '未命中可用战法，未生成区间', tone: 'warn' };
  }
  if (basis.includes('涨停基准价缺失') || basis.includes('无法给出低吸区间')) {
    return { text: '数据拉取失败，未生成区间', tone: 'warn' };
  }
  return { text: '数据拉取失败，未生成区间', tone: 'warn' };
}
