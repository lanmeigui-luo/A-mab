/**
 * floating-return.ts —— 持仓浮动收益率（纯函数，可离线验收）
 *
 * 数据缺失（现价未拉到 / 停牌 / 非法价格）一律返回 null，由调用方显示 '—'，不抛错、不伪造 0%。
 * 结果保留两位小数，与已平仓的 returnPct 口径一致。
 */

/** (现价 - 买入价) / 买入价 × 100；买入价或现价无效时返回 null */
export function floatingReturnPct(
  buyPrice: number | null | undefined,
  currentPrice: number | null | undefined,
): number | null {
  if (buyPrice == null || currentPrice == null) return null;
  if (!Number.isFinite(buyPrice) || !Number.isFinite(currentPrice)) return null;
  if (buyPrice <= 0 || currentPrice <= 0) return null;
  return Math.round(((currentPrice - buyPrice) / buyPrice) * 10000) / 100;
}
