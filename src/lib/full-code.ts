/**
 * full-code.ts —— 6 位股票代码 → 带市场前缀 fullCode（唯一口径）
 *
 * 与后端 sidecar/server.py 的 full_code() 保持一致。
 * 【关键】920 开头是北交所，必须先于「9 开头 → sh」判断：
 *   历史 bug 把 920045 拼成 sh920045，腾讯/新浪/东财全部返回空数组，
 *   导致这 3 只北交所票在结算时永久拿不到日K、卡死在「待买入」。
 *
 * 纯函数、零外部依赖、无 @/ 别名 —— 可安全进入 tsconfig.test.json 编译图。
 */

export type MarketPrefix = 'sh' | 'sz' | 'bj';

/** 6 位代码推断市场；宽松版（自动补零），用于已有 WinRateRecord.code */
export function inferMarket(code: string): MarketPrefix {
  const c = String(code ?? '').padStart(6, '0');
  if (c.startsWith('920')) return 'bj';       // 北交所 920 段，必须最先判断
  if (c.startsWith('4') || c.startsWith('8')) return 'bj'; // 北交所 43/83/87 段
  if (c.startsWith('6') || c.startsWith('9')) return 'sh'; // 沪市 60/68/900（B股）
  return 'sz';                                  // 深市 00/30 及其余兜底
}

/** 6 位代码 → sh/sz/bj + 6 位代码 */
export function toFullCode(code: string): string {
  const c = String(code ?? '').padStart(6, '0');
  return inferMarket(c) + c;
}
