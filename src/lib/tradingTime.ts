/**
 * tradingTime.ts —— 交易时段判定（纯函数，无副作用，可被 monitor / recorder / UI 共用）
 *
 * 从 useWinRateRecorder.ts 抽取出来，避免多个模块各自复制一份时点判定逻辑。
 * 仅依赖 winrate-config 的 DEFAULT_RECORD_CUTOFF（记录窗口截止时刻），不读 API / 不碰 React。
 */

import { DEFAULT_RECORD_CUTOFF } from '../domain/winrate-config';

/** 解析 'HH:MM' → 当日分钟数 */
export function parseHHMM(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/** 记录窗口截止时刻（默认 14:50 → 890） */
export const RECORD_CUTOFF_MINS = parseHHMM(DEFAULT_RECORD_CUTOFF);
/** 收盘时刻（15:00 → 900） */
export const MARKET_CLOSE_MINS = 15 * 60;

/** 是否工作日（周一~周五） */
export function isWeekday(d: Date): boolean {
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

/** 交易时段（工作日 9:30-15:00）。后端排行榜仅在此能发现新候选。 */
export function isWithinTradingHours(d = new Date()): boolean {
  if (!isWeekday(d)) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= 9 * 60 + 30 && mins <= MARKET_CLOSE_MINS;
}

/** 记录窗口：交易时段内 且 当前时刻 ∈ [14:50, 15:00] */
export function isWithinRecordWindow(d = new Date()): boolean {
  if (!isWithinTradingHours(d)) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= RECORD_CUTOFF_MINS && mins <= MARKET_CLOSE_MINS;
}
