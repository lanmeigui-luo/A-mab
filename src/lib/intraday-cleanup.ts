/**
 * intraday-cleanup.ts —— 盘中实时监控成功成交后的「洗白」字段（纯函数）
 *
 * 背景：一笔旧记录可能带着 excludedFromStats:true / invalidReason / ruleVersion=v1-legacy /
 * ambiguous_intraday 等历史脏标签。一旦被 useIntradayMonitor 用真实 1min bar 成功判定买入或平仓，
 * 这笔交易就是「极其清晰」的，不应再背负任何歧义标签：
 *  1) excludedFromStats 强制 false —— 恢复计入胜率分母；
 *  2) invalidReason 清空（undefined）—— 旧规则的失效说明不再适用；
 *  3) ruleVersion 升级到当前版本（v2-t1-fix）—— 口径与判定一致；
 *  4) 清除所有「歧义 / 数据缺失 / 未成交」类 anomaly，仅保留仍成立的事实类标注。
 *
 * 纯函数、零副作用、无 @/ 别名，可安全进入 tsconfig.test.json 编译图。
 */

import { TRADE_RULE_VERSION } from '../domain/winrate-config';
import type { TradeRecord, WinRateAnomaly } from '../domain/winrate';

/**
 * 洗白后仍保留的 anomaly（客观事实，与「成交是否清晰」无关）：
 * - new_stock_no_limit_check：次新股跳过一字板判定，是规则适用性事实
 * - backfilled：记录来自补拉，是来源事实
 * - param_changed：参数版本变更，是配置事实
 * 其余（data_missing / *_unfilled / unbuyable / delisted / suspended 等）一律清除；
 * 歧义语义的 sellReason（ambiguous_intraday / ambiguous_1min）由新触发原因直接覆盖。
 */
const KEEP_ANOMALIES: ReadonlySet<WinRateAnomaly> = new Set<WinRateAnomaly>([
  'new_stock_no_limit_check',
  'backfilled',
  'param_changed',
]);

export interface IntradayCleanupSource {
  trade: { anomalies: WinRateAnomaly[] };
}

/** 返回可直接并入 updateTrade patch 的洗白字段 */
export function intradayCleanupFields(record: IntradayCleanupSource): Partial<TradeRecord> {
  return {
    excludedFromStats: false,
    invalidReason: undefined,
    ruleVersion: TRADE_RULE_VERSION,
    anomalies: (record.trade.anomalies || []).filter((a) => KEEP_ANOMALIES.has(a)),
  };
}
