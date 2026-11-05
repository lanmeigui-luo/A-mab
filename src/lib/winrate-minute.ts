/**
 * winrate-minute.ts —— 分钟线歧义消解（Step-3 纯函数层）
 *
 * 设计原则：纯函数、无副作用、不读 localStorage / 不调 API / 不碰 React / 不碰 winrate-sim。
 * 输入候选记录（sellReason=ambiguous_intraday[excluded] 或 ambiguous_1min 或 pending）+ 注入的 fetchBars，
 * 输出消解结果（回填具体原因 / 标 pending 待重试 / 降级 ambient_1min / 超窗口）。
 *
 * ───────────────────────────────────────────────────────────────────────
 * 层级与边界（按需求 spec 修订）：
 *  - 候选日 = 歧义候选日（首个可卖日双边触及日）；D = 候选日距结算执行日的交易日距离。
 *  - D≤3   → period=1（1min，~4 交易日窗口）
 *  - 4≤D≤21 → period=5（5min，~21 交易日窗口）
 *  - 22≤D≤32 → period=15（15min，~32 交易日窗口，数据源最深的墙）
 *  - D>32   → 不拉取，直接降级 ambiguous_intraday（"超出分钟线窗口"），不重试
 *  - 回退链：首选 period 拉到的 bars 不含候选日 → 试更粗 period（p1→p5→p15，受 D 上界约束）→ 仍拉不到才降级。
 *    即 period=1 一失败不立即降级，而是回退到 period=5/15（若 D 允许）。
 *  - 聚合：按 (code, period) 分组，同一 stock 同一 period 只拉一次；同 stock 多候选日共享该次拉取的 bars。
 *  - ambiguous_1min 与 ambiguous_intraday 一样排除分母（excludedFromStats=true）。
 *    层级注释：1min 窗口仅 ~4 天，候选 D>4 落 period=5/15 或降级；即便落在 period=1 窗口内、
 *    但 1min 数据仍无法消解（序列缺失 / 同根 bar 双边无法定序）→ 记 ambiguous_1min。
 *
 * 时效（pending 重试放弃）：
 *  - 有交易日历工具（refTradingDates）→ 按交易日计数，>30 交易日放弃。
 *  - 无交易日历 → 自然日 ×1.4 ≈ 42 自然日近似（注释：非精确交易日），>42 自然日放弃。
 *  - 不硬编码"30 天"。
 * ───────────────────────────────────────────────────────────────────────
 */

import type { WinRateRecord, TradeRecord, SellReason, MinuteResolveMeta } from '../domain/winrate';
import type { KlineRow } from '../domain/types';
import { TRADE_RULE_VERSION } from '../domain/winrate-config';

/** 单根分钟 K 线（由服务端 kline-min 的 KlineRow 映射而来，仅取 OHLC） */
export interface MinuteBar {
  date: string; // 分钟 K 的日期时间，如 "2026-01-03 09:31:00"
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** fetchBars：注入的分钟线拉取函数（便于测试 mock；真实实现走 marketApi.klineMin） */
export type FetchMinuteBars = (code: string, period: 1 | 5 | 15) => Promise<MinuteBar[]>;

/** 时效阈值：30 交易日（有交易日历时）；无日历时按 42 自然日近似（×1.4，非精确交易日） */
const PENDING_ABANDON_TRADING_DAYS = 30;
const PENDING_ABANDON_NATURAL_DAYS = 42;

/** KlineRow（服务端 kline-min 返回）→ MinuteBar */
export function toMinuteBar(row: KlineRow): MinuteBar {
  return { date: row.date, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function normalizeDate(now: Date | string): string {
  if (typeof now === 'string') return now.length >= 10 ? now.slice(0, 10) : now;
  return now.toISOString().slice(0, 10);
}

function dateLT(a: string, b: string): boolean {
  return a < b;
}

/** 交易日距离 D：有 refTradingDates 按交易日计数；否则按自然日差（近似）。fromDate 不含、toDate 含。 */
export function tradingDaysBetween(fromDate: string, toDate: Date | string, refTradingDates?: string[] | null): number {
  const toStr = normalizeDate(toDate);
  if (refTradingDates && refTradingDates.length) {
    let n = 0;
    for (const d of refTradingDates) if (dateLT(fromDate, d) && d <= toStr) n++;
    return n;
  }
  // 无交易日历：自然日近似（注释：非精确交易日）
  const a = Date.parse(fromDate + 'T00:00:00');
  const b = Date.parse(toStr + 'T00:00:00');
  return Math.floor((b - a) / 86400000);
}

/** pending 是否过期（放弃重试）：有交易日历按 >30 交易日；否则按 >42 自然日（×1.4，非精确交易日） */
export function isPendingExpired(
  firstAttemptDate: string | undefined,
  now: Date | string,
  refTradingDates?: string[] | null,
): boolean {
  if (!firstAttemptDate) return false; // 从未尝试过 → 不视为过期，可直接重试
  const td = tradingDaysBetween(firstAttemptDate, now, refTradingDates);
  if (refTradingDates && refTradingDates.length) {
    return td > PENDING_ABANDON_TRADING_DAYS;
  }
  return td > PENDING_ABANDON_NATURAL_DAYS; // 42 自然日 ≈ 30 交易日（×1.4 近似，非精确交易日）
}

/** 选择 period（按 D 边界）；>32 返回 null（不拉取） */
export function selectPeriod(daysBetween: number): 1 | 5 | 15 | null {
  if (daysBetween <= 3) return 1;
  if (daysBetween <= 21) return 5;
  if (daysBetween <= 32) return 15;
  return null;
}

/** period 回退链（按 D 上界约束）：从最细到最粗。D>32 返回空（不拉取） */
export function periodFallbackChain(daysBetween: number): (1 | 5 | 15)[] {
  if (daysBetween > 32) return [];
  if (daysBetween >= 22) return [15];
  if (daysBetween >= 4) return [5, 15];
  return [1, 5, 15];
}

/** 从一坨分钟 bars 中切片出候选日（date 以 candidateDay 开头） */
export function sliceDayBars(bars: MinuteBar[], candidateDay: string): MinuteBar[] {
  return bars.filter((b) => b.date === candidateDay || b.date.startsWith(candidateDay + ' ') || b.date.startsWith(candidateDay + 'T'));
}

export interface DisambiguateInput {
  bars: MinuteBar[]; // 当日分钟序列（已切片）
  stop: number | null;
  target1: number | null;
  target2: number | null;
}

export interface DisambiguateResult {
  resolved: boolean;
  reason?: SellReason; // 'stop_loss' | 'target1' | 'target2'
  sellPrice?: number;
}

/**
 * 盘中定序：遍历当日分钟 bar，找「首次下穿 stop（low≤stop）」与「首次上穿 target（high≥target）」的先后。
 * 优先级（与 sim ③ 盘中单边一致）：止损先 → 目标二 → 目标一。
 * 若止损与某目标落在同一根 bar（idx 相同）→ 该粒度无法定序 → resolved=false（交由上层降级 ambiguous_1min/intrad）。
 */
export function disambiguateIntraday(input: DisambiguateInput): DisambiguateResult {
  let firstStopIdx = -1;
  let firstT2Idx = -1;
  let firstT1Idx = -1;
  for (let i = 0; i < input.bars.length; i++) {
    const b = input.bars[i];
    if (firstStopIdx < 0 && input.stop != null && b.low <= input.stop) firstStopIdx = i;
    if (firstT2Idx < 0 && input.target2 != null && b.high >= input.target2) firstT2Idx = i;
    if (firstT1Idx < 0 && input.target1 != null && b.high >= input.target1) firstT1Idx = i;
  }
  const candidates = [
    { idx: firstStopIdx, reason: 'stop_loss' as SellReason, price: input.stop! },
    { idx: firstT2Idx, reason: 'target2' as SellReason, price: input.target2! },
    { idx: firstT1Idx, reason: 'target1' as SellReason, price: input.target1! },
  ].filter((c) => c.idx >= 0);
  if (candidates.length === 0) return { resolved: false };
  candidates.sort((a, b) => a.idx - b.idx);
  const win = candidates[0];
  // 若止损与某目标在同一根 bar → 该粒度无法定序
  const sameBar = candidates.filter((c) => c.idx === win.idx);
  if (sameBar.length > 1) return { resolved: false };
  return { resolved: true, reason: win.reason, sellPrice: win.price };
}

/** 复刻 sim ③：从日 K 找出首个可卖日双边触及（low≤stop 且 high≥target1，且开盘未跳空）的候选日 */
export function findAmbiguousCandidateDay(
  daily: KlineRow[],
  record: WinRateRecord,
  options?: { suspensionRanges?: { from: string; to: string }[] },
): string | null {
  const buyIdx = firstIndexAfter(daily, record.date);
  if (buyIdx < 0) return null;
  const stop = record.stop;
  const t1 = record.target1;
  const t2 = record.target2;
  if (stop == null || t1 == null) return null;
  const inSusp = (d: string) =>
    !!options?.suspensionRanges?.some((r) => r.from <= d && d <= r.to);
  for (let i = buyIdx + 1; i < daily.length; i++) {
    const day = daily[i];
    if (inSusp(day.date) || day.volume === 0) continue; // 停牌/零量跳过（顺延）
    // ① 开盘跳空 → sim 不会走到 ③，该日非歧义候选
    if (day.open <= stop) continue;
    if (t2 != null && day.open >= t2) continue;
    if (day.open >= t1) continue;
    // ③ 盘中双边触及（与 sim ③ 一致）→ 候选日
    if (day.low <= stop && day.high >= t1) return day.date;
    // ④ 单边 / 到期 → 不会是 ambiguous_intraday(排除)，跳过
  }
  return null;
}

function firstIndexAfter(klines: KlineRow[], date: string): number {
  for (let i = 0; i < klines.length; i++) {
    if (dateLT(date, klines[i].date)) return i;
  }
  return -1;
}

// ───────── 消解编排 ─────────

export interface ResolveOpts {
  /** 结算执行日（now） */
  now: Date | string;
  /** 交易日历（用于 D 计算与时效判定）；无则自然日近似 */
  refTradingDates?: string[] | null;
}

export interface MinuteResolvePatch {
  trade?: Partial<TradeRecord>;
  minuteResolve: MinuteResolveMeta;
}

export interface ResolveResult {
  patches: Map<string, MinuteResolvePatch>;
  /** 成功消解并回填（excludedFromStats=false） */
  resolved: number;
  /** 永久降级（超窗口/超时效/无法定序 → ambiguous_1min 或 ambiguous_intraday） */
  degraded: number;
  /** D>32 直接降级（未拉取） */
  overWindow: number;
  /** 各 period 实际拉取次数（按 (code,period) 聚合后） */
  fetchCounts: { 1: number; 5: number; 15: number };
}

function needsResolution(r: WinRateRecord): boolean {
  const sr = r.trade.sellReason;
  const st = r.trade.minuteResolve?.status;
  if (st === 'resolved' || st === 'degraded') return false;
  if (sr === 'ambiguous_intraday' && r.trade.excludedFromStats === true) return true;
  if (sr === 'ambiguous_1min') return true;
  if (st === 'pending') return true;
  return false;
}

function buildResolvedPatch(
  r: WinRateRecord,
  res: DisambiguateResult,
  candidateDay: string,
  period: 1 | 5 | 15,
  ref?: string[] | null,
): MinuteResolvePatch {
  const buyPrice = r.trade.buyPrice;
  const sellPrice = res.sellPrice ?? 0;
  const returnPct = buyPrice != null ? ((sellPrice - buyPrice) / buyPrice) * 100 : null;
  const holdDays =
    r.trade.buyDate != null ? tradingDaysBetween(r.trade.buyDate, candidateDay, ref) : r.trade.holdDays;
  // Plan A 审计：保留消解前的日K结算原值，使 closed 记录的修改可追溯（合规"记录可审计"）。
  const audit = {
    originalSellReason: r.trade.sellReason,
    originalSellPrice: r.trade.sellPrice,
    originalReturnPct: r.trade.returnPct,
    originalExcludedFromStats: r.trade.excludedFromStats ?? false,
    resolvedAt: new Date().toISOString(),
    version: TRADE_RULE_VERSION,
  };
  return {
    trade: {
      sellReason: res.reason!,
      sellPrice: round2(sellPrice),
      returnPct: returnPct != null ? round2(returnPct) : null,
      holdDays: holdDays ?? null,
      excludedFromStats: false,
      status: 'closed',
      sellDate: candidateDay,
      anomalies: r.trade.anomalies,
      minuteResolutionAudit: audit,
    },
    minuteResolve: { candidateDay, status: 'resolved', requiredPeriod: period, resolvedReason: res.reason! },
  };
}

/**
 * 批量消解编排（纯函数 + 注入 fetchBars）。
 *  - 聚合：按 (code, period) 分组，同一 stock 同一 period 只拉一次。
 *  - 回退：候选日不在某 period 拉到的 bars 中 → 试更粗 period（受 D 上界约束）。
 *  - 返回 patches（按记录 id）+ 计数 + 各 period 拉取次数。
 */
export async function resolveAmbiguities(
  records: WinRateRecord[],
  fetchBars: FetchMinuteBars,
  opts: ResolveOpts,
): Promise<ResolveResult> {
  const nowStr = normalizeDate(opts.now);
  const ref = opts.refTradingDates;
  const candidates = records.filter(needsResolution);

  // 结果容器（提前声明：过期 pending 在规划前即直接降级填入）
  const patches = new Map<string, MinuteResolvePatch>();
  let resolved = 0;
  let degraded = 0;
  let overWindow = 0;

  // (code:period) → MinuteBar[] 拉取缓存（含失败空数组）；保证同 (code,period) 在全流程内仅拉取一次（聚合），
  // 但【不再预先把整条回退链全部拉取】——改为逐候选「懒回退」：先试首选 period，切片命中候选日才用，
  // 否则按 chain 顺序试更粗 period。从而 D∈[5,21] 只需 period=5（p15 永不触发），省限流。
  const barsCache = new Map<string, MinuteBar[]>();
  const fetchedSet = new Set<string>();
  async function getBars(code: string, period: 1 | 5 | 15): Promise<MinuteBar[]> {
    const key = `${code}:${period}`;
    if (fetchedSet.has(key)) return barsCache.get(key) ?? [];
    fetchedSet.add(key);
    try {
      const bars = await fetchBars(code, period);
      barsCache.set(key, bars ?? []);
    } catch {
      barsCache.set(key, []); // 拉取失败 → 空，后续按 pending 待重试处理
    }
    return barsCache.get(key) ?? [];
  }

  // 1) 计算每候选的候选日、D、回退链与过期判定；过期 pending 直接降级（不拉取）
  const perRecord = new Map<
    string,
    { candidateDay: string; status: 'fresh' | 'pending'; meta?: MinuteResolveMeta; D: number; chain: (1 | 5 | 15)[] }
  >();
  for (const r of candidates) {
    const meta = r.trade.minuteResolve;
    const candidateDay = meta?.candidateDay ?? null;
    if (!candidateDay) continue;
    const kind: 'fresh' | 'pending' = meta?.status === 'pending' ? 'pending' : 'fresh';
    // 过期 pending：提前判定，直接降级且【不进入拉取规划】（避免无谓 fetch）。无 ref 时按自然日 ×1.4≈42 近似。
    if (kind === 'pending' && meta?.firstAttemptDate && isPendingExpired(meta.firstAttemptDate, nowStr, ref)) {
      const D = tradingDaysBetween(candidateDay, nowStr, ref);
      const reason: SellReason = D <= 3 ? 'ambiguous_1min' : 'ambiguous_intraday';
      patches.set(r.id, {
        minuteResolve: { candidateDay, status: 'degraded', note: '超出时效(>30交易日/42自然日)' },
        ...(reason === 'ambiguous_1min'
          ? { trade: { sellReason: 'ambiguous_1min' as SellReason, excludedFromStats: true } }
          : {}),
      });
      degraded++;
      continue;
    }
    const D = tradingDaysBetween(candidateDay, nowStr, ref);
    perRecord.set(r.id, { candidateDay, status: kind, meta, D, chain: periodFallbackChain(D) });
  }

  // 2) 逐候选消解（懒回退：先试首选 period，切片命中候选日才用；否则按 chain 试更粗 period）
  for (const r of candidates) {
    const info = perRecord.get(r.id);
    if (!info) continue;
    const { candidateDay, meta, D, chain } = info;

    // D>32 → 超出分钟线窗口，不拉取，直接降级
    if (D > 32) {
      patches.set(r.id, {
        minuteResolve: { candidateDay, status: 'degraded', note: '超出分钟线窗口(>32交易日)' },
      });
      overWindow++;
      continue;
    }

    // 懒回退消解：沿 chain 顺序，首个切片命中候选日的 period 用于定序；命中即停（避免冗余拉取更粗 period）
    let done: MinuteResolvePatch | null = null;
    for (const p of chain) {
      const bars = await getBars(r.code, p);
      const dayBars = sliceDayBars(bars, candidateDay);
      if (dayBars.length === 0) continue; // 候选日不在该 period 窗口 → 试更粗 period（懒回退）
      const res = disambiguateIntraday({ bars: dayBars, stop: r.stop, target1: r.target1, target2: r.target2 });
      if (res.resolved && res.reason) {
        done = buildResolvedPatch(r, res, candidateDay, p, ref);
        break;
      }
    }
    if (done) {
      patches.set(r.id, done);
      resolved++;
      continue;
    }

    // 链条耗尽：区分 transient 拉取失败（bars 全空）与 永久无法消解（有数据但无法定序/窗口外）
    const anyFetched = chain.some((p) => (barsCache.get(`${r.code}:${p}`) ?? []).length > 0);
    if (!anyFetched) {
      // 拉取失败（transient）→ 保留 pending 等待下次重试
      patches.set(r.id, {
        minuteResolve: {
          candidateDay,
          status: 'pending',
          requiredPeriod: chain[0],
          firstAttemptDate: meta?.firstAttemptDate ?? nowStr,
          note: '拉取失败待重试',
        },
      });
    } else {
      // 有数据但无法定序 / 窗口外 → 永久降级
      const reason: SellReason = D <= 3 ? 'ambiguous_1min' : 'ambiguous_intraday';
      patches.set(r.id, {
        minuteResolve: { candidateDay, status: 'degraded', note: reason === 'ambiguous_1min' ? '1min无法消解' : '窗口外/无法定序' },
        ...(reason === 'ambiguous_1min'
          ? { trade: { sellReason: 'ambiguous_1min' as SellReason, excludedFromStats: true } }
          : {}),
      });
      degraded++;
    }
  }

  // fetchCounts：仅统计本流程实际尝试拉取的 (code,period)（聚合后）
  const fetchCounts = { 1: 0, 5: 0, 15: 0 };
  for (const key of fetchedSet) {
    const p = Number(key.split(':')[1]);
    if (p === 1 || p === 5 || p === 15) fetchCounts[p]++;
  }

  return { patches, resolved, degraded, overWindow, fetchCounts };
}
