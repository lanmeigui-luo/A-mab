/**
 * 市场状态机：preopen / trading / closed / holiday
 *
 * 判定顺序（短路）：
 *   1. 节假日命中（data/holidays.json 的 Set，含法定节假日）
 *   2. 周六 / 周日（周末休市）
 *   3. 时间窗
 *
 * 状态语义（README 需注明）：
 *   - preopen ：09:00–09:30 盘前集合竞价
 *   - trading ：09:30–11:30 上午连续竞价；13:00–15:00 下午连续竞价
 *   - closed  ：11:30–13:00 午休（语义是「非连续交易时段」，不是「停盘错误」）；
 *              以及 <09:00、≥15:00 的收盘后/夜间
 *   - holiday ：法定节假日 或 周末
 *
 * 设计取舍：15:00–15:30 不单独拆出 postclose。本应用没有收盘后结算/夜盘等差别化逻辑，
 * postclose 与 closed 行为完全一致，合并到 closed 让状态机更简洁（4 态而非 5 态）。
 * 若后续加入「收盘后数据结算窗口」等差异化处理，再拆回 postclose。
 */

const MARKET_STATES = ['preopen', 'trading', 'closed', 'holiday'];

function toKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 是否休市日：命中 holidays Set 或周末 */
export function isHoliday(date, holidays) {
  const set = holidays instanceof Set ? holidays : new Set(holidays || []);
  if (set.has(toKey(date))) return true;
  const dow = date.getDay(); // 0=周日, 6=周六
  return dow === 0 || dow === 6;
}

/** 把 'HH:MM' 折算成当天分钟数 */
function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * @param {Date} [now] 可注入，便于单测（不依赖真实时钟）
 * @param {Set<string>|string[]} [holidays] 休市日集合，可注入
 * @returns {'preopen'|'trading'|'closed'|'holiday'}
 */
export function computeMarketStatus(now = new Date(), holidays = new Set()) {
  if (isHoliday(now, holidays)) return 'holiday';
  const t = minutesOfDay(now);
  if (t >= 9 * 60 && t < 9 * 60 + 30) return 'preopen'; // 09:00–09:30
  if (t >= 9 * 60 + 30 && t < 11 * 60 + 30) return 'trading'; // 09:30–11:30 上午
  if (t >= 11 * 60 + 30 && t < 13 * 60) return 'closed'; // 11:30–13:00 午休（非连续交易时段）
  if (t >= 13 * 60 && t < 15 * 60) return 'trading'; // 13:00–15:00 下午
  return 'closed'; // <09:00 或 ≥15:00 收盘后/夜间
}

/** 从 holidays.json 加载为 Set（失败抛错，由调用方兜底） */
export async function loadHolidays(jsonPath) {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(jsonPath, 'utf8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error('holidays.json 必须是字符串数组');
  return new Set(arr);
}

export { MARKET_STATES };
