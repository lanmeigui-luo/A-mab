/**
 * market-fallback.ts —— 大盘指标降级判定与友好文案（纯函数，可离线验收）
 *
 * 供后端统计全市场涨跌家数与前端展示兜底提示共用口径。
 * 底层数据源错误（ValueError: No tables found 等）绝不直接暴露给用户。
 */

export const MARKET_FETCH_FAILED_TEXT = '获取失败（数据源波动），5秒后重试';
export const MARKET_STALE_TEXT = '数据有延迟，正在重试…';

/** 把底层报错转成用户可理解的提示，绝不泄漏 ValueError / 网页解析细节 */
export function friendlyMarketError(reason: string | null | undefined): string {
  if (!reason) return MARKET_FETCH_FAILED_TEXT;
  if (/ValueError|No tables found|Traceback|ConnectionError|Timeout|HTTPError|JSONDecode/i.test(reason)) {
    return MARKET_FETCH_FAILED_TEXT;
  }
  return reason.length > 60 ? MARKET_FETCH_FAILED_TEXT : reason;
}

/** 从全市场行情快照统计涨跌家数；无有效价格时返回 null（不伪造 0） */
export function countBreadth(rows: { changePct?: number | null }[]): { up: number; down: number; flat: number } | null {
  let up = 0, down = 0, flat = 0;
  for (const r of rows || []) {
    const c = r?.changePct;
    if (typeof c !== 'number' || !Number.isFinite(c)) continue;
    if (c > 0.0001) up++;
    else if (c < -0.0001) down++;
    else flat++;
  }
  return up + down + flat > 0 ? { up, down, flat } : null;
}

/** 拉取失败时是否可用旧数据顶上（stale 必须标出来，绝不能伪装成实时） */
export function canUseStale(currentAvailable: boolean, lastAt: number | null | undefined, now: number): boolean {
  return !currentAvailable && lastAt != null && Number.isFinite(lastAt) && now >= lastAt;
}
