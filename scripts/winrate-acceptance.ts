/* 战法胜率 v2-t1-fix 增量修复 —— 离线验收测试（纯逻辑，无 DOM/React）
 *
 * 运行方式（项目根目录，Node CommonJS 编译产物）：
 *   node dist-test/scripts/winrate-acceptance.js
 * 由 tsconfig.test.json 编译 src + scripts 到 dist-test/（CommonJS）。
 *
 * 覆盖：
 *  - 用例1回归：目标价跳空开盘应按开盘价成交（非固定目标价）
 *  - 7 条验收用例（选 A 纯日K降级口径）
 *  - 歧义排除率统计断言
 *  - tradeTriggerPrice / tradeRuleNote 辅助函数
 */
import { simulateTrade, locateBuyDayIndex, canSettleRecord } from '../src/lib/winrate-sim';
import { computeWinRateStats } from '../src/lib/winrate-stats';
import {
  tradeTriggerPrice,
  tradeRuleNote,
  tradeInvalidNote,
  tradeViewCategory,
  TRADE_VIEW_STATUS_LABELS,
  SELL_REASON_LABELS,
  canSellToday,
  nextTradingDateGuess,
  ENTRY_STYLE_LABELS,
  ANOMALY_LABELS,
  makePlaceholderRecord,
  placeholderKind,
  isPlaceholderRecord,
  noSignalExpiryAt,
  isRecordedTabVisible,
  realRecordDates,
} from '../src/domain/winrate';
import { toFullCode, inferMarket } from '../src/lib/full-code';
import * as fs from 'fs';
import { dedupeRecords, recordBusinessKey } from '../src/lib/record-dedupe';
import { intradayCleanupFields } from '../src/lib/intraday-cleanup';
import { normalizeClosedTrade, shouldShowIntradayUnfilled, isClosedWithSell } from '../src/lib/trade-consistency';
import { floatingReturnPct } from '../src/lib/floating-return';
import { paginate } from '../src/lib/paginate';
import * as path from 'path';
import { matchesToolbarFilters, filterByToolbar } from '../src/lib/record-filters';
import { intradayVolumeColor, setColorBlindMode } from '../src/lib/market-colors';
import { friendlyMarketError, countBreadth, canUseStale, MARKET_FETCH_FAILED_TEXT } from '../src/lib/market-fallback';
import { resolvePrevClose, calcPrevChange, isUsablePrevClose, firstValidPrice } from '../src/lib/prev-close';
import { isPlanTradable, isSameDayClose } from '../src/lib/trade-plan-validity';
import { describeBuyRange } from '../src/lib/buy-range-label';
import { isPlanIncomplete, isMissingPlanAnomaly } from '../src/lib/plan-missing';
import {
  heatColor,
  calculateTreemap,
  isBoardDataMissing,
  heatFloor,
  textLevel,
  primaryMetric,
  secondaryMetric,
} from '../src/lib/board-heat';
import { formatStatsLine } from '../src/lib/kline-stats-line';
import { calcMA } from '../src/lib/indicators';
import { TRADE_RULE_VERSION, WINRATE_STRATEGY_CONFIG } from '../src/domain/winrate-config';
import type { WinRateRecord, TradeRecord, SellReason, WinRateAnomaly } from '../src/domain/winrate';
import type { KlineRow } from '../src/domain/types';
import {
  resolveAmbiguities,
  selectPeriod,
  tradingDaysBetween,
  isPendingExpired,
  findAmbiguousCandidateDay,
  disambiguateIntraday,
  sliceDayBars,
  periodFallbackChain,
  toMinuteBar,
  evaluateIntradayEntry,
  evaluateDailyEntryFallback,
  buyRangeOverlap,
  clampToBuyRange,
  type MinuteBar,
  type FetchMinuteBars,
} from '../src/lib/winrate-minute';

// ───────── 断言工具 ─────────
let passed = 0;
let failed = 0;
const fails: string[] = [];

function check(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    fails.push(label);
    console.log(`  ✗ ${label}`);
  }
}
function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

// ───────── 工厂 ─────────
function k(date: string, open: number, high: number, low: number, close: number, volume = 1000): KlineRow {
  return { date, open, high, low, close, volume };
}

// 历史 K 线（~12 根，置于记录日之前）：使买入日索引 ≥5，避免被引擎判为「次新股」（否则会加 new_stock_no_limit_check 软标注并被 excludeAnomaly 排除分母）
const HIST: KlineRow[] = [
  k('2025-12-20', 10, 10.2, 9.8, 10),
  k('2025-12-21', 10, 10.2, 9.8, 10),
  k('2025-12-22', 10, 10.2, 9.8, 10),
  k('2025-12-23', 10, 10.2, 9.8, 10),
  k('2025-12-24', 10, 10.2, 9.8, 10),
  k('2025-12-25', 10, 10.2, 9.8, 10),
  k('2025-12-26', 10, 10.2, 9.8, 10),
  k('2025-12-27', 10, 10.2, 9.8, 10),
  k('2025-12-28', 10, 10.2, 9.8, 10),
  k('2025-12-29', 10, 10.2, 9.8, 10),
  k('2025-12-30', 10, 10.2, 9.8, 10),
  k('2025-12-31', 10, 10.2, 9.8, 10),
];

type Plan = {
  date: string;
  code?: string;
  name?: string;
  buyLow?: number;
  buyHigh?: number;
  stop?: number;
  target1?: number;
  target2?: number;
  holdMax?: number;
};

function makeRec(p: Plan): WinRateRecord {
  const trade: TradeRecord = {
    buyDate: null,
    buyPrice: null,
    sellDate: null,
    sellPrice: null,
    holdDays: null,
    returnPct: null,
    sellReason: 'unknown',
    status: 'open',
    anomalies: [],
    backfilled: false,
  };
  return {
    id: `rec_${Math.random().toString(36).slice(2, 10)}`,
    date: p.date,
    strategyId: 'test-strategy',
    strategyName: '测试战法',
    code: p.code ?? '600000',
    name: p.name ?? '测试股',
    determinismScore: 80,
    scoreFactors: null,
    signalStrength: 1,
    signalStrengthSource: 'hitRatio',
    recordedPrice: p.buyLow ?? 10,
    buyLow: p.buyLow ?? null,
    buyHigh: p.buyHigh ?? null,
    stop: p.stop ?? null,
    target1: p.target1 ?? null,
    target2: p.target2 ?? null,
    holdDays: p.holdMax != null ? { min: 1, max: p.holdMax } : null,
    tPlus1SellDate: null,
    paramVersion: '2026-09-28',
    backfilled: false,
    recordedAt: `${p.date}T14:55:00.000Z`,
    priceSource: 'intraday_late',
    insufficientHits: false,
    trade,
  };
}

// ───────── 分钟线消解测试辅助 ─────────
/** 生成连续日期序列（含周末，仅作交易日历 mock 用） */
function genDates(start: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(start + 'T00:00:00');
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** 构造一笔「日K歧义」记录并预置 minuteResolve 元数据（模拟 settleOpenRecords 已挂候选日） */
function makeAmbiguousRec(opts: {
  code?: string;
  date?: string;
  stop?: number;
  target1?: number;
  target2?: number;
  sellReason?: SellReason;
  buyDate?: string;
  buyPrice?: number;
  candidateDay?: string;
  status?: 'pending' | 'resolved' | 'degraded';
  firstAttemptDate?: string;
  requiredPeriod?: 1 | 5 | 15;
}): WinRateRecord {
  const rec = makeRec({
    date: opts.date ?? '2026-01-01',
    code: opts.code ?? '600001',
    stop: opts.stop ?? 9,
    target1: opts.target1 ?? 11,
    target2: opts.target2 ?? 12,
  });
  rec.trade = {
    ...rec.trade,
    sellReason: opts.sellReason ?? 'ambiguous_intraday',
    excludedFromStats: true,
    status: 'closed',
    buyDate: opts.buyDate ?? '2026-01-02',
    buyPrice: opts.buyPrice ?? 10,
    sellDate: null,
    sellPrice: null,
    holdDays: null,
    returnPct: null,
    anomalies: [],
    minuteResolve: opts.candidateDay
      ? {
          candidateDay: opts.candidateDay,
          status: opts.status ?? 'pending',
          requiredPeriod: opts.requiredPeriod,
          firstAttemptDate: opts.firstAttemptDate,
        }
      : undefined,
  };
  return rec;
}

/** 生成某日的分钟 bars（seq: [open, high, low, close]），时间从 09:31 起每分钟一根 */
function mkMin(day: string, seq: [number, number, number, number][]): MinuteBar[] {
  return seq.map((s, i) => ({
    date: `${day} 09:${String(31 + i).padStart(2, '0')}:00`,
    open: s[0],
    high: s[1],
    low: s[2],
    close: s[3],
    volume: 1000,
  }));
}

/** 注入的 mock fetch：按 `${code}:${period}` 返回预置 bars */
function makeMockFetch(barsByKey: Record<string, MinuteBar[]>): FetchMinuteBars {
  return async (code: string, period: 1 | 5 | 15) => barsByKey[`${code}:${period}`] ?? [];
}

// 止损先触及（idx0 下穿 stop，idx1 上穿 t1）→ disambiguate 应判 stop_loss
const STOP_FIRST: [number, number, number, number][] = [
  [10.5, 10.6, 8.5, 9.0],
  [9.0, 11.5, 8.8, 11.0],
];
// 目标一先触及（idx0 上穿 t1，idx1 下穿 stop）→ disambiguate 应判 target1
const T1_FIRST: [number, number, number, number][] = [
  [10.5, 11.5, 10.4, 11.0],
  [11.0, 11.2, 8.5, 9.0],
];
// 同根 bar 双边（high≥t1 且 low≤stop 同 idx0）→ 无法定序 → 降级
const SAME_BAR: [number, number, number, number][] = [[10.5, 12.5, 8.0, 11.0]];

// ───────── 7 条验收用例 + 用例1回归 ─────────
function runCases() {
  const plan = { buyLow: 10, buyHigh: 10.5, stop: 9, target1: 11, target2: 12, holdMax: 20 };

  // 用例1（回归，改用用户给定数字）：买入当日开盘已 ≥ 目标一 → 计划失效(high_open_over_target1)，排除分母
  section('用例1（回归）：买入当日开盘越过目标一 → 失效(high_open_over_target1)');
  {
    const rec = makeRec({ date: '2026-01-01', buyLow: 9.8, buyHigh: 10.6, stop: 9.6, target1: 10.5, target2: 11.5 });
    // 记录日 / 买入日（开盘 10.55 在买入区间 [9.8,10.6] 内、且 > 目标一 10.5）
    const daily = [
      ...HIST,
      k('2026-01-01', 10, 10, 10, 10),
      k('2026-01-02', 10.55, 10.70, 10.40, 10.60), // 买入日：开盘 10.55 ≥ 目标一 10.5 → 失效
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'invalid', `status=invalid (实际: ${trade.status})`);
    check(trade.anomalies.includes('high_open_over_target1'), `anomaly=high_open_over_target1 (实际: ${trade.anomalies})`);
    check(trade.sellPrice == null, '无卖出价（未成交）');
    // 旧逻辑会买入 10.55、按 target1=10.50 卖 → 亏损约 -0.47%；新逻辑直接排除分母
    const oldReturn = ((10.5 - 10.55) / 10.55) * 100;
    check(oldReturn < 0, `旧逻辑收益为负 ≈ ${oldReturn.toFixed(2)}%（应排除）(实际: ${oldReturn.toFixed(2)})`);
    check(trade.ruleVersion === TRADE_RULE_VERSION, `ruleVersion=${TRADE_RULE_VERSION}`);
  }

  // 用例2：买入当日开盘价已 ≥ 目标一 → 计划失效未成交（high_open_over_target1）
  section('用例2：买入当日开盘越目标一 → 失效(high_open_over_target1)');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    const daily = [
      ...HIST,
      k('2026-01-01', 10, 10, 10, 10),
      k('2026-01-02', 11.3, 11.6, 11.2, 11.5), // 买入日开盘 11.3 ≥ 目标一 11（非一字板）
      k('2026-01-03', 12, 12, 12, 12),
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'invalid', `status=invalid (实际: ${trade.status})`);
    check(trade.anomalies.includes('high_open_over_target1'), `anomaly=high_open_over_target1 (实际: ${trade.anomalies})`);
    check(trade.sellPrice == null, '无卖出价');
  }

  // 用例3：T+1 首可卖日开盘跳空跌破止损 → tplus1_stop_loss（计入分母）
  section('用例3：首可卖日开盘跳空止损 → stop_gap（计入分母）');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    const daily = [
      ...HIST,
      k('2026-01-01', 10, 10, 10, 10),
      k('2026-01-02', 10.2, 10.4, 10.1, 10.3), // 买入日：10.2，未双边
      k('2026-01-03', 8.5, 8.6, 8.4, 8.5), // 首可卖日：开盘 8.5 ≤ 止损 9
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'closed', 'status=closed');
    check(trade.sellReason === 'stop_gap', `sellReason=stop_gap (实际: ${trade.sellReason})`);
    check(trade.sellPrice === 8.5, `卖出价=开盘 8.5 (实际: ${trade.sellPrice})`);
    check(trade.excludedFromStats === false, '计入分母（excluded=false）');
  }

  // 用例4：可卖日盘中单边触及目标二 → target2（按目标价成交）
  section('用例4：可卖日盘中单边触目标二 → target2');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    const daily = [
      ...HIST,
      k('2026-01-01', 10, 10, 10, 10),
      k('2026-01-02', 10.2, 10.4, 10.1, 10.3), // 买入日：10.2，未双边
      k('2026-01-03', 10.5, 12.5, 10.4, 12.4), // 首可卖日：开盘未触发，盘中 high≥12
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'closed', 'status=closed');
    check(trade.sellReason === 'target2', `sellReason=target2 (实际: ${trade.sellReason})`);
    check(trade.sellPrice === plan.target2, `卖出价=目标二 ${plan.target2} (实际: ${trade.sellPrice})`);
    check(trade.excludedFromStats === false, '计入分母（excluded=false）');
  }

  // 用例5：可卖日双边触及（low≤stop 且 high≥target1） → ambiguous_intraday，排除分母
  section('用例5：可卖日双边触及 → ambiguous_intraday（排除分母）');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    const daily = [
      ...HIST,
      k('2026-01-01', 10, 10, 10, 10),
      k('2026-01-02', 10.2, 10.4, 10.1, 10.3), // 买入日：10.2，未双边
      k('2026-01-03', 10.3, 12.5, 8.0, 11), // 首可卖日：low 8≤stop 9 且 high 12.5≥target1 11
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'closed', 'status=closed');
    check(trade.sellReason === 'ambiguous_intraday', `sellReason=ambiguous_intraday (实际: ${trade.sellReason})`);
    check(trade.excludedFromStats === true, '排除分母（excluded=true）');
  }

  // 用例6：T日双边 + 首可卖日单边跳空 → ambiguous_intraday，但计入分母（仅原因歧义）
  section('用例6：T日双边 + 首可卖日开盘跳空 → target1_gap（非歧义）');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    const daily = [
      ...HIST,
      k('2026-01-01', 10, 10, 10, 10),
      k('2026-01-02', 10.2, 11.5, 8.0, 10.3), // 买入日：low 8≤stop 9 且 high 11.5≥target1 11 → 双边
      k('2026-01-03', 11.3, 11.4, 11.2, 11.3), // 首可卖日：开盘 11.3 ≥ 目标一 11（单边跳空）
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'closed', 'status=closed');
    check(trade.sellReason === 'target1_gap', `sellReason=target1_gap（开盘跳空优先，非歧义）(实际: ${trade.sellReason})`);
    check(trade.sellPrice === 11.3, `卖出价=首可卖日开盘 11.3 (实际: ${trade.sellPrice})`);
    check(trade.excludedFromStats === false, '计入分母（excluded=false）');
  }

  // 用例7：T日只触一边（仅止损边）+ 首可卖日正常 → target1_gap（计入分母）
  section('用例7：T日只触一边 + 首可卖日开盘跳空 → target1_gap（非 tplus1）');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    const daily = [
      ...HIST,
      k('2026-01-01', 10, 10, 10, 10),
      k('2026-01-02', 10.2, 10.4, 8.0, 10.3), // 买入日：low 8≤stop 9（仅止损边），high 10.4<target1 11 → 非双边
      k('2026-01-03', 11.3, 11.4, 11.2, 11.3), // 首可卖日：开盘 11.3 ≥ 目标一 11
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'closed', 'status=closed');
    check(trade.sellReason === 'target1_gap', `sellReason=target1_gap（开盘跳空优先）(实际: ${trade.sellReason})`);
    check(trade.sellPrice === 11.3, `卖出价=首可卖日开盘 11.3 (实际: ${trade.sellPrice})`);
    check(trade.excludedFromStats === false, '计入分母（excluded=false）');
  }

  // 用例8：T日单边(目标边) + 首可卖日【未跳空】→ tplus1_target1（按首可卖日开盘价成交，计入分母）
  section('用例8：T日触目标边 + 首可卖日未跳空 → tplus1_target1');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    const daily = [
      ...HIST,
      k('2026-01-01', 10, 10, 10, 10),
      k('2026-01-02', 10.2, 11.5, 10.1, 10.3), // 买入日：high 11.5≥target1 11（T日触目标边），low 10.1>stop，未双边
      k('2026-01-03', 10.3, 10.4, 10.2, 10.3), // 首可卖日：开盘 10.3 未跳空（<target1 11, >stop 9）
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'closed', 'status=closed');
    check(trade.sellReason === 'tplus1_target1', `sellReason=tplus1_target1（首可卖日未跳空，回退T日标记）(实际: ${trade.sellReason})`);
    check(trade.sellPrice === 10.3, `卖出价=首可卖日开盘 10.3 (实际: ${trade.sellPrice})`);
    check(trade.excludedFromStats === false, '计入分母（excluded=false）');
  }

  // 用例9（回归）：open≤stop 且 high≥target1 同时成立 → 必须按 stop_gap（开盘止损），不得标 ambiguous_intraday
  section('用例9（回归）：开盘跳空止损优先于盘中双边歧义');
  {
    const rec = makeRec({ date: '2026-01-01', buyLow: 9.8, buyHigh: 10.6, stop: 9.6, target1: 10.5, target2: 11.5 });
    const daily = [
      ...HIST,
      k('2026-01-01', 10, 10, 10, 10),
      k('2026-01-02', 10.0, 10.2, 9.9, 10.1), // 买入日：开盘 10.0 在区间内、<target1、未双边
      k('2026-01-03', 9.5, 10.8, 9.4, 9.6), // 首可卖日：open 9.5≤stop 9.6（开盘跳空止损），high 10.8≥target1 10.5，low 9.4
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'closed', 'status=closed');
    check(trade.sellReason === 'stop_gap', `sellReason=stop_gap（开盘止损优先）(实际: ${trade.sellReason})`);
    check(trade.sellPrice === 9.5, `卖出价=开盘 9.5（非歧义）(实际: ${trade.sellPrice})`);
    check(trade.sellReason !== 'ambiguous_intraday', '不得标 ambiguous_intraday');
    check(trade.excludedFromStats === false, '计入分母（非歧义排除）');
  }

  // 用例10：T+1 首可卖日停牌顺延 → 仍按 tplus1_* 规则（顺延后的首可交易日视为「首可卖日」）
  section('用例10：T+1首日停牌顺延 → 仍走 tplus1_*（代码实现非仅注释）');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    const daily = [
      ...HIST,
      k('2026-01-01', 10, 10, 10, 10),
      k('2026-01-02', 10.2, 11.5, 10.1, 10.3), // 买入日：high 11.5≥target1 11（T日触目标边）
      k('2026-01-03', 9.0, 9.0, 9.0, 9.0, 0), // T+1 首日：停牌（volume=0 兜底），应跳过顺延
      k('2026-01-04', 10.3, 10.4, 10.2, 10.3), // 顺延首可卖日：开盘 10.3 未跳空 → tplus1_target1
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'closed', 'status=closed');
    check(trade.sellReason === 'tplus1_target1', `sellReason=tplus1_target1（顺延后仍回退T日标记）(实际: ${trade.sellReason})`);
    check(trade.sellPrice === 10.3, `卖出价=顺延首可卖日开盘 10.3 (实际: ${trade.sellPrice})`);
    check(trade.sellDate === '2026-01-04', `卖出日=顺延日 2026-01-04（非停牌日）(实际: ${trade.sellDate})`);
    check(trade.excludedFromStats === false, '计入分母（excluded=false）');
    check(trade.anomalies.includes('suspended_volume_zero'), `标停牌顺延 (实际: ${trade.anomalies})`);
  }

  // 用例11（#1 残留修复）：T日收盘跌破止损 且 同时触目标边 → 必须 tplus1_stop_loss（非 ambiguous_intraday）
  //   T日 close<stop（不论是否同时 high>=target1）→ 首可卖日未跳空 → tplus1_stop_loss（按首可卖日开盘价，计入分母）
  section('用例11（#1）：T日收盘破止损且同时触目标 → tplus1_stop_loss（非歧义）');
  {
    const rec = makeRec({ date: '2026-01-01', buyLow: 9.8, buyHigh: 10.6, stop: 9.6, target1: 10.5, target2: 11.5 });
    const daily = [
      ...HIST,
      k('2026-01-01', 10, 10, 10, 10),
      // 买入日：high 11.0≥target1 10.5 且 low 9.4≤stop 9.6 且 close 9.5<stop 9.6（收破止损，且同时触目标边）
      k('2026-01-02', 10.2, 11.0, 9.4, 9.5),
      // 首可卖日：开盘 10.0 在 [stop 9.6, target1 10.5] 之间，未跳空
      k('2026-01-03', 10.0, 10.1, 9.9, 10.0),
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'closed', 'status=closed');
    check(trade.sellReason === 'tplus1_stop_loss', `sellReason=tplus1_stop_loss（收盘破止损优先，不论是否同时触目标）(实际: ${trade.sellReason})`);
    check(trade.sellPrice === 10.0, `卖出价=首可卖日开盘 10.0 (实际: ${trade.sellPrice})`);
    check(trade.sellReason !== 'ambiguous_intraday', '不得标 ambiguous_intraday');
    check(trade.excludedFromStats === false, '计入分母（excluded=false）');
  }
}

// ───────── 歧义排除率统计断言 ─────────
function runStatsAssertion() {
  section('歧义排除率统计断言');
  const plan = { buyLow: 10, buyHigh: 10.5, stop: 9, target1: 11, target2: 12 };

  const records: WinRateRecord[] = [];
  // 8 笔正常平仓（目标一成交，盈利）
  for (let i = 0; i < 8; i++) {
    const rec = makeRec({ date: `2026-02-${String(1 + i).padStart(2, '0')}`, ...plan });
    const daily = [
      ...HIST,
      k(`2026-02-${String(1 + i).padStart(2, '0')}`, 10, 10, 10, 10),
      k(`2026-02-${String(2 + i).padStart(2, '0')}`, 10.2, 10.4, 10.1, 10.3),
      k(`2026-02-${String(3 + i).padStart(2, '0')}`, 11.5, 11.6, 11.2, 11.4),
    ];
    const { trade } = simulateTrade(rec, daily);
    records.push({ ...rec, trade });
  }
  // 2 笔可卖日双边 → ambiguous_intraday + 排除分母
  for (let i = 0; i < 2; i++) {
    const rec = makeRec({ date: `2026-03-${String(1 + i).padStart(2, '0')}`, ...plan });
    const daily = [
      ...HIST,
      k(`2026-03-${String(1 + i).padStart(2, '0')}`, 10, 10, 10, 10),
      k(`2026-03-${String(2 + i).padStart(2, '0')}`, 10.2, 10.4, 10.1, 10.3),
      k(`2026-03-${String(3 + i).padStart(2, '0')}`, 10.3, 12.5, 8.0, 11),
    ];
    const { trade } = simulateTrade(rec, daily);
    records.push({ ...rec, trade });
  }

  const result = computeWinRateStats(records, { excludeAnomaly: true });
  const s = result.byStrategy[0];
  check(s.total === 10, `total=10 (实际: ${s.total})`);
  check(s.ambiguityRate === 0.2, `ambiguityRate=0.2 (实际: ${s.ambiguityRate})`);
  check(s.ambiguousExcluded === 2, `ambiguousExcluded=2 (实际: ${s.ambiguousExcluded})`);
  check(s.closed === 8, `closed=8（排除2笔歧义）(实际: ${s.closed})`);
  check(s.winRate === 1, `winRate=1（仅8笔有效且全盈利）(实际: ${s.winRate})`);

  // 反例：若把 2 笔 excludedFromStats 改为 false，则 closed 应变为 10
  const recs2 = records.map((r) =>
    r.trade.sellReason === 'ambiguous_intraday'
      ? { ...r, trade: { ...r.trade, excludedFromStats: false } }
      : r,
  );
  const s2 = computeWinRateStats(recs2, { excludeAnomaly: true }).byStrategy[0];
  check(s2.closed === 10, `反例：取消排除后 closed=10 (实际: ${s2.closed})`);
  check(s2.ambiguityRate === 0.2, `反例：ambiguityRate 仍为 0.2（歧义笔数不变）(实际: ${s2.ambiguityRate})`);
}

// ───────── 辅助函数断言 ─────────
function runHelperAssertion() {
  section('tradeTriggerPrice / tradeRuleNote 辅助函数');
  const plan = { buyLow: 10, buyHigh: 10.5, stop: 9, target1: 11, target2: 12 };
  const rec = makeRec({ date: '2026-01-01', ...plan });
  const daily = [
    ...HIST,
    k('2026-01-01', 10, 10, 10, 10),
    k('2026-01-02', 10.2, 10.4, 10.1, 10.3),
    k('2026-01-03', 11.5, 11.6, 11.2, 11.4),
  ];
  const { trade } = simulateTrade(rec, daily);
  const full = { ...rec, trade };
  check(tradeTriggerPrice(full) === plan.target1, `tradeTriggerPrice=t1 (实际: ${tradeTriggerPrice(full)})`);
  const note = tradeRuleNote(full);
  check(note.includes('触发价'), `tradeRuleNote 含触发价说明 (实际: "${note}")`);
  check(note.includes('触目标一'), `tradeRuleNote 含原因 (实际: "${note}")`);
}

// ───────── 分钟线歧义消解（Step-3）断言 ─────────
async function runMinuteAssertions() {
  section('Step-3 纯函数：period 选择 / D 边界 / 时效');
  check(selectPeriod(0) === 1, 'selectPeriod(0)=1');
  check(selectPeriod(3) === 1, 'selectPeriod(3)=1');
  check(selectPeriod(4) === 5, 'selectPeriod(4)=5');
  check(selectPeriod(21) === 5, 'selectPeriod(21)=5');
  check(selectPeriod(22) === 15, 'selectPeriod(22)=15');
  check(selectPeriod(32) === 15, 'selectPeriod(32)=15');
  check(selectPeriod(33) === null, 'selectPeriod(33)=null（不拉取）');
  check(
    JSON.stringify(periodFallbackChain(2)) === JSON.stringify([1, 5, 15]),
    'periodFallbackChain(≤3)=[1,5,15]',
  );
  check(
    JSON.stringify(periodFallbackChain(10)) === JSON.stringify([5, 15]),
    'periodFallbackChain(4~21)=[5,15]',
  );
  check(JSON.stringify(periodFallbackChain(25)) === JSON.stringify([15]), 'periodFallbackChain(22~32)=[15]');
  check(JSON.stringify(periodFallbackChain(40)) === JSON.stringify([]), 'periodFallbackChain(>32)=[]');

  const ref = genDates('2026-01-02', 60);
  check(
    tradingDaysBetween('2026-01-02', '2026-01-05', ref) === 3,
    `tradingDaysBetween(有交易日历)=3 (实际: ${tradingDaysBetween('2026-01-02', '2026-01-05', ref)})`,
  );
  check(
    isPendingExpired('2026-01-02', ref[ref.length - 1], ref) === true,
    'isPendingExpired：>30 交易日 → true',
  );
  check(
    isPendingExpired('2026-03-01', ref[ref.length - 1], ref) === false,
    'isPendingExpired：近期尝试 → false',
  );
  check(
    isPendingExpired('2026-01-02', '2026-03-01') === true,
    'isPendingExpired：无日历 >42 自然日 → true（×1.4 近似，非精确交易日）',
  );
  check(isPendingExpired(undefined, '2026-03-01') === false, 'isPendingExpired：从未尝试 → false');

  // disambiguateIntraday 定序
  const dis1 = disambiguateIntraday({ bars: mkMin('2026-01-03', STOP_FIRST), stop: 9, target1: 11, target2: 12 });
  check(dis1.resolved && dis1.reason === 'stop_loss', `disambiguate 止损先 → stop_loss (实际: ${dis1.reason})`);
  const dis2 = disambiguateIntraday({ bars: mkMin('2026-01-03', T1_FIRST), stop: 9, target1: 11, target2: 12 });
  check(dis2.resolved && dis2.reason === 'target1', `disambiguate 目标一先 → target1 (实际: ${dis2.reason})`);
  const dis3 = disambiguateIntraday({ bars: mkMin('2026-01-03', SAME_BAR), stop: 9, target1: 11, target2: 12 });
  check(dis3.resolved === false, 'disambiguate 同根 bar 双边 → 无法定序（unresolved）');

  const sliced = sliceDayBars([...mkMin('2026-01-03', STOP_FIRST), ...mkMin('2026-01-04', STOP_FIRST)], '2026-01-03');
  check(sliced.length === STOP_FIRST.length, `sliceDayBars 按候选日切片 (实际: ${sliced.length})`);

  // findAmbiguousCandidateDay 应与 sim ③ 一致（返回首个可卖日双边触及日）
  {
    const rec = makeRec({ date: '2026-01-01', stop: 9, target1: 11, target2: 12 });
    const daily = [
      ...HIST,
      k('2026-01-01', 10, 10, 10, 10),
      k('2026-01-02', 10.2, 10.4, 10.1, 10.3),
      k('2026-01-03', 10.3, 12.5, 8.0, 11), // 双边触及 → 候选日
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.sellReason === 'ambiguous_intraday', `sim ③ → ambiguous_intraday (实际: ${trade.sellReason})`);
    const cand = findAmbiguousCandidateDay(daily, rec);
    check(cand === '2026-01-03', `findAmbiguousCandidateDay 复算候选日=2026-01-03 (实际: ${cand})`);
    // 候选日 + D≤3 → 应选 period=1
    check(selectPeriod(tradingDaysBetween('2026-01-03', '2026-01-06')) === 1, '候选日距结算 3 自然日 → period=1');
  }

  section('Step-3 消解编排：period=1 窗口成功');
  {
    const rec = makeAmbiguousRec({ code: '600101', candidateDay: '2026-01-03' });
    const fetch = makeMockFetch({
      '600101:1': mkMin('2026-01-03', STOP_FIRST),
      '600101:5': [],
      '600101:15': [],
    });
    const res = await resolveAmbiguities([rec], fetch, { now: '2026-01-06' });
    check(res.resolved === 1 && res.degraded === 0 && res.overWindow === 0, `resolved=1 (实际: ${res.resolved})`);
    const p = res.patches.get(rec.id);
    check(p?.minuteResolve.status === 'resolved', 'minuteResolve.status=resolved');
    check(p?.trade?.sellReason === 'stop_loss', `回填原因=stop_loss (实际: ${p?.trade?.sellReason})`);
    check(p?.trade?.excludedFromStats === false, '回填后计入分母（excluded=false）');
    check(p?.trade?.sellDate === '2026-01-03', `回填卖出日=候选日 (实际: ${p?.trade?.sellDate})`);
    check(res.fetchCounts[1] === 1, `period=1 拉取次数=1 (实际: ${res.fetchCounts[1]})`);
    // Plan A 审计：保留消解前日K结算原值 + 消解元信息（closed 记录修改可追溯）
    const a = p?.trade?.minuteResolutionAudit;
    check(a != null, 'Plan A：写入 minuteResolutionAudit 审计字段');
    check(a?.originalSellReason === 'ambiguous_intraday', `审计原值 sellReason=ambiguous_intraday (实际: ${a?.originalSellReason})`);
    check(a?.originalExcludedFromStats === true, `审计原值 excludedFromStats=true (实际: ${a?.originalExcludedFromStats})`);
    check(a?.version === 'v2-t1-fix', `审计 version=v2-t1-fix (实际: ${a?.version})`);
    check(typeof a?.resolvedAt === 'string' && a.resolvedAt.length > 0, '审计 resolvedAt 为时间戳字符串');
  }

  section('Step-3 消解编排：period=5 窗口成功（D=4~21，懒回退只拉 period=5，不拉 period=1/15）');
  {
    const rec = makeAmbiguousRec({ code: '600102', candidateDay: '2026-01-03' });
    const fetch = makeMockFetch({
      '600102:1': undefined as unknown as MinuteBar[], // 不在此窗口（不会用到）
      '600102:5': mkMin('2026-01-03', STOP_FIRST),
      '600102:15': [], // 懒回退：period=5 已命中候选日，p15 永不触发
    });
    const res = await resolveAmbiguities([rec], fetch, { now: '2026-01-13' }); // 自然 D=10
    check(res.resolved === 1, `resolved=1 (实际: ${res.resolved})`);
    check(res.fetchCounts[1] === 0, `period=1 未拉取=0 (实际: ${res.fetchCounts[1]})`);
    check(res.fetchCounts[5] === 1, `period=5 拉取次数=1 (实际: ${res.fetchCounts[5]})`);
    check(res.fetchCounts[15] === 0, `period=15 未拉取=0（懒回退省限流） (实际: ${res.fetchCounts[15]})`);
    const p = res.patches.get(rec.id);
    check(p?.trade?.sellReason === 'stop_loss', `回填原因=stop_loss (实际: ${p?.trade?.sellReason})`);
  }

  section('Step-3 消解编排：D>32 直接降级（不拉取）');
  {
    const rec = makeAmbiguousRec({ code: '600103', candidateDay: '2026-01-03' });
    const fetch = makeMockFetch({});
    const res = await resolveAmbiguities([rec], fetch, { now: '2026-03-10' }); // 自然 D=66
    check(res.resolved === 0 && res.overWindow === 1, `overWindow=1 (实际: ${res.overWindow})`);
    check(res.fetchCounts[1] === 0 && res.fetchCounts[5] === 0 && res.fetchCounts[15] === 0, '未拉取（fetch=0）');
    const p = res.patches.get(rec.id);
    check(p?.minuteResolve.status === 'degraded', 'minuteResolve.status=degraded');
    check((p?.minuteResolve.note ?? '').includes('超出分钟线窗口'), `note=超出分钟线窗口 (实际: ${p?.minuteResolve.note})`);
  }

  section('Step-3 消解编排：pending 重试成功');
  {
    const rec = makeAmbiguousRec({
      code: '600104',
      candidateDay: '2026-01-03',
      status: 'pending',
      firstAttemptDate: '2026-01-02',
    });
    const fetch = makeMockFetch({ '600104:1': mkMin('2026-01-03', STOP_FIRST) });
    const res = await resolveAmbiguities([rec], fetch, { now: '2026-01-06' });
    check(res.resolved === 1, `resolved=1（重试成功） (实际: ${res.resolved})`);
    check(res.patches.get(rec.id)?.minuteResolve.status === 'resolved', 'status=resolved');
  }

  section('Step-3 消解编排：pending >30 交易日放弃（永久降级，不拉取）');
  {
    const refCal = genDates('2026-01-02', 60);
    const rec = makeAmbiguousRec({
      code: '600105',
      candidateDay: '2026-02-28',
      status: 'pending',
      firstAttemptDate: '2026-01-02',
    });
    const fetch = makeMockFetch({});
    const res = await resolveAmbiguities([rec], fetch, { now: refCal[refCal.length - 1], refTradingDates: refCal });
    check(res.degraded === 1 && res.resolved === 0 && res.overWindow === 0, `degraded=1 (实际: ${res.degraded})`);
    check(res.fetchCounts[1] === 0, '过期记录不拉取（fetch=0）');
    const p = res.patches.get(rec.id);
    check(p?.minuteResolve.status === 'degraded', 'status=degraded');
    check((p?.minuteResolve.note ?? '').includes('时效'), `note=超出时效 (实际: ${p?.minuteResolve.note})`);
    check(p?.trade?.excludedFromStats === true, '过期降级仍排除分母（excluded=true）');
  }

  section('Step-3 消解编排：ambiguous_1min 排除分母（同 ambiguous_intraday）');
  {
    const rec = makeAmbiguousRec({
      code: '600106',
      sellReason: 'ambiguous_1min',
      candidateDay: '2026-01-03',
    });
    const fetch = makeMockFetch({ '600106:1': mkMin('2026-01-03', SAME_BAR), '600106:5': [], '600106:15': [] });
    const res = await resolveAmbiguities([rec], fetch, { now: '2026-01-06' }); // D=3≤3 但同根 bar 无法定序 → 降级 ambiguous_1min
    check(res.degraded === 1, `degraded=1 (实际: ${res.degraded})`);
    const p = res.patches.get(rec.id);
    check(p?.trade?.sellReason === 'ambiguous_1min', `sellReason=ambiguous_1min (实际: ${p?.trade?.sellReason})`);
    check(p?.trade?.excludedFromStats === true, 'ambiguous_1min 排除分母（excluded=true）');
  }

  section('Step-3 额外：period=1 拉不到目标日 → 回退 period=5 成功');
  {
    const rec = makeAmbiguousRec({ code: '600107', candidateDay: '2026-01-03' });
    // period=1 返回空（模拟数据源缺口，拉不到目标日）；period=5 含候选日
    const fetch = makeMockFetch({
      '600107:1': [],
      '600107:5': mkMin('2026-01-03', STOP_FIRST),
      '600107:15': [],
    });
    const res = await resolveAmbiguities([rec], fetch, { now: '2026-01-06' }); // D=3 → 链 [1,5,15]
    check(res.resolved === 1, `resolved=1（回退 p5 成功） (实际: ${res.resolved})`);
    check(res.fetchCounts[1] === 1, `period=1 仍尝试拉取=1 (实际: ${res.fetchCounts[1]})`);
    check(res.fetchCounts[5] === 1, `period=5 回退拉取=1 (实际: ${res.fetchCounts[5]})`);
    const p = res.patches.get(rec.id);
    check(p?.trade?.sellReason === 'stop_loss', `回填原因=stop_loss (实际: ${p?.trade?.sellReason})`);
  }

  section('Step-3 额外：同 stock 多候选日共享一次拉取（聚合 + 懒回退省限流）');
  {
    const rA = makeAmbiguousRec({ code: '600999', candidateDay: '2026-01-03' });
    const rB = makeAmbiguousRec({ code: '600999', candidateDay: '2026-01-04' });
    // 同一 (code,period=1) 的 bars 同时含两个候选日 → 仅拉一次；D≤3 命中 p1 即停，p5/p15 永不触发
    const fetch = makeMockFetch({
      '600999:1': [...mkMin('2026-01-03', STOP_FIRST), ...mkMin('2026-01-04', STOP_FIRST)],
      '600999:5': [],
      '600999:15': [],
    });
    const res = await resolveAmbiguities([rA, rB], fetch, { now: '2026-01-06' });
    check(res.resolved === 2, `resolved=2（两候选日均消解） (实际: ${res.resolved})`);
    check(res.fetchCounts[1] === 1, `同 stock 同 period 仅拉取 1 次（聚合共享） (实际: ${res.fetchCounts[1]})`);
    check(res.fetchCounts[5] === 0 && res.fetchCounts[15] === 0, `D≤3 仅 p1 命中即停，p5/p15 不拉取（懒回退省限流） (实际: [5]=${res.fetchCounts[5]},[15]=${res.fetchCounts[15]})`);
  }
}

/** ambiguous_1min 与 ambiguous_intraday 一并排除分母的统计断言 */
function runMinuteStatsAssertion() {
  section('Step-3 统计：ambiguous_1min 与 ambiguous_intraday 同排除分母');
  const plan = { buyLow: 10, buyHigh: 10.5, stop: 9, target1: 11, target2: 12 };

  const normal: WinRateRecord[] = [];
  // 1 笔正常盈利（目标一成交）
  {
    const rec = makeRec({ date: '2026-04-01', ...plan });
    const daily = [
      ...HIST,
      k('2026-04-01', 10, 10, 10, 10),
      k('2026-04-02', 10.2, 10.4, 10.1, 10.3),
      k('2026-04-03', 11.5, 11.6, 11.2, 11.4),
    ];
    const { trade } = simulateTrade(rec, daily);
    normal.push({ ...rec, trade });
  }
  // 1 笔 ambiguous_intraday
  const ambIntra = makeAmbiguousRec({ code: '600201', date: '2026-04-10', candidateDay: '2026-04-12' });
  // 1 笔 ambiguous_1min
  const amb1min = makeAmbiguousRec({
    code: '600202',
    date: '2026-04-15',
    sellReason: 'ambiguous_1min',
    candidateDay: '2026-04-17',
  });

  const records = [...normal, ambIntra, amb1min];
  const s = computeWinRateStats(records, { excludeAnomaly: true }).byStrategy[0];
  check(s.total === 3, `total=3 (实际: ${s.total})`);
  check(s.closed === 1, `closed=1（仅 1 笔有效）(实际: ${s.closed})`);
  check(s.ambiguousExcluded === 2, `ambiguousExcluded=2（intraday + 1min 同排除）(实际: ${s.ambiguousExcluded})`);
  check(s.ambiguityRate === 2 / 3, `ambiguityRate≈0.667 (实际: ${s.ambiguityRate})`);
  check(s.winRate === 1, `winRate=1（唯一有效笔盈利）(实际: ${s.winRate})`);
}

// ───────── 买入时机（t_close / t_next_open）验收（Phase B） ─────────
function runBuyTimingAssertion() {
  const plan = { buyLow: 10, buyHigh: 10.5, stop: 9, target1: 11, target2: 12 };

  // 用例A：t_close（记录日收盘买入）——收盘价落入买入区间 → 以收盘价成交，T+1 次日卖出
  section('买入时机A：t_close 记录日收盘买入（成交）');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    rec.buyTiming = 't_close';
    const daily = [
      ...HIST,
      k('2026-01-01', 10.2, 10.4, 10.1, 10.3), // 记录日=买入日：收盘 10.3 ∈ [10,10.5] → 买入价 10.3
      k('2026-01-02', 10.4, 11.6, 10.3, 11.4), // T+1 首可卖日：盘中 high≥target1 11 → target1
    ];
    const { trade, tPlus1SellDate } = simulateTrade(rec, daily);
    check(trade.status === 'closed', `status=closed (实际: ${trade.status})`);
    check(trade.buyDate === '2026-01-01', `买入日期=记录日 2026-01-01 (实际: ${trade.buyDate})`);
    check(trade.buyPrice === 10.3, `买入价=记录日收盘 10.3 (实际: ${trade.buyPrice})`);
    check(trade.sellDate === '2026-01-02', `卖出日期=T+1 次日（≠买入日）(实际: ${trade.sellDate})`);
    check(trade.sellReason === 'target1', `sellReason=target1（T+1 盘中触目标一）(实际: ${trade.sellReason})`);
    check(trade.holdDays === 1, `持有天数=1 个交易日 (实际: ${trade.holdDays})`);
    check(tPlus1SellDate === '2026-01-02', `tPlus1SellDate=2026-01-02 (实际: ${tPlus1SellDate})`);
  }

  // 用例A2：t_close 收盘高于买高 → 未成交(high_close_unfilled)
  section('买入时机A2：t_close 收盘高于买高 → 失效(high_close_unfilled)');
  {
    const rec = makeRec({ date: '2026-01-01', buyLow: 9.5, buyHigh: 10.0, stop: 9, target1: 11, target2: 12 });
    rec.buyTiming = 't_close';
    const daily = [
      ...HIST,
      k('2026-01-01', 10.2, 10.4, 10.1, 10.3), // 收盘 10.3 > 买高 10.0 → 未成交
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'invalid', `status=invalid (实际: ${trade.status})`);
    check(trade.anomalies.includes('high_close_unfilled'), `anomaly=high_close_unfilled (实际: ${trade.anomalies})`);
    check(trade.buyPrice == null, '无买入价（未成交）');
  }

  // 用例A3：t_close 收盘低于买低 → 未成交(low_close_unfilled)
  section('买入时机A3：t_close 收盘低于买低 → 失效(low_close_unfilled)');
  {
    const rec = makeRec({ date: '2026-01-01', buyLow: 10.5, buyHigh: 11.5, stop: 9, target1: 12, target2: 13 });
    rec.buyTiming = 't_close';
    const daily = [
      ...HIST,
      k('2026-01-01', 10.2, 10.4, 10.1, 10.3), // 收盘 10.3 < 买低 10.5 → 未成交
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'invalid', `status=invalid (实际: ${trade.status})`);
    check(trade.anomalies.includes('low_close_unfilled'), `anomaly=low_close_unfilled (实际: ${trade.anomalies})`);
    check(trade.buyPrice == null, '无买入价（未成交）');
  }

  // 用例B：t_next_open（次日开盘买入，显式指定）——以次日开盘价成交（≠收盘价）
  section('买入时机B：t_next_open 次日开盘买入（默认行为）');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    rec.buyTiming = 't_next_open';
    const daily = [
      ...HIST,
      k('2026-01-01', 10, 10, 10, 10),
      k('2026-01-02', 10.2, 10.4, 10.1, 10.5), // 买入日：开盘 10.2（≠收盘 10.5）
      k('2026-01-03', 11.5, 11.6, 11.2, 11.4), // T+1：盘中触目标一
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'closed', `status=closed (实际: ${trade.status})`);
    check(trade.buyDate === '2026-01-02', `买入日期=记录日次日 2026-01-02 (实际: ${trade.buyDate})`);
    check(trade.buyPrice === 10.2, `买入价=次日开盘 10.2（≠收盘 10.5）(实际: ${trade.buyPrice})`);
    check(trade.sellDate === '2026-01-03', `卖出日期=T+1 次日 (实际: ${trade.sellDate})`);
  }

  // 用例C1：t_close 的 T+1 约束——买入日（记录日）当日即使双边触及，也不得当日卖出；须等到 T+1
  section('买入时机C1：t_close T+1 约束（买入当日不卖出）');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    rec.buyTiming = 't_close';
    const daily = [
      ...HIST,
      // 买入日（记录日）：收盘 10.3∈区间→买入；但当日 high≥target1 且 low≤stop（双边触及）——不得当日卖
      k('2026-01-01', 10.2, 11.5, 8.0, 10.3),
      // T+1 首可卖日：开盘 11.5≥target1 11 → 开盘跳空 target1_gap，于 T+1 成交（非买入日）
      k('2026-01-02', 11.5, 11.6, 11.2, 11.4),
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'closed', `status=closed (实际: ${trade.status})`);
    check(trade.buyDate === '2026-01-01', `买入日期=记录日 (实际: ${trade.buyDate})`);
    check(trade.sellDate === '2026-01-02', `卖出日期=T+1 次日，≠买入日（T+1 约束）(实际: ${trade.sellDate})`);
    check(trade.sellReason === 'target1_gap', `sellReason=target1_gap（T+1 开盘跳空）(实际: ${trade.sellReason})`);
    check(trade.holdDays === 1, `持有天数=1（买入日→T+1）(实际: ${trade.holdDays})`);
  }

  // 用例C2：t_next_open 的 T+1 约束——买入日（次日）即使双边触及，也不得当日卖出；须等到 T+1
  section('买入时机C2：t_next_open T+1 约束（买入当日不卖出）');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    rec.buyTiming = 't_next_open';
    const daily = [
      ...HIST,
      k('2026-01-01', 10, 10, 10, 10),
      // 买入日（次日）：开盘 10.2∈区间→买入；当日 high≥target1 且 low≤stop（双边触及）——不得当日卖
      k('2026-01-02', 10.2, 11.5, 8.0, 10.3),
      // T+1 首可卖日：开盘 11.5≥target1 11 → 开盘跳空 target1_gap，于 T+1 成交（非买入日）
      k('2026-01-03', 11.5, 11.6, 11.2, 11.4),
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'closed', `status=closed (实际: ${trade.status})`);
    check(trade.buyDate === '2026-01-02', `买入日期=记录日次日 (实际: ${trade.buyDate})`);
    check(trade.sellDate === '2026-01-03', `卖出日期=T+1 次日，≠买入日（T+1 约束）(实际: ${trade.sellDate})`);
    check(trade.sellReason === 'target1_gap', `sellReason=target1_gap（T+1 开盘跳空）(实际: ${trade.sellReason})`);
    check(trade.holdDays === 1, `持有天数=1（买入日→T+1）(实际: ${trade.holdDays})`);
  }

  // 用例D：t_close 买入后 K 线不足以平仓（无 T+1 日）→ 维持 open，保留 buyDate/buyPrice
  section('买入时机D：t_close 买入后无后续可卖日 → 持仓中(open)，保留买入信息');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    rec.buyTiming = 't_close';
    const daily = [
      ...HIST,
      k('2026-01-01', 10.2, 10.4, 10.1, 10.3), // 记录日=买入日：收盘 10.3 买入，无后续 K → 无法平仓
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'open', `status=open（持仓中，非 data_missing）(实际: ${trade.status})`);
    check(trade.buyDate === '2026-01-01', `买入日期已落盘 (实际: ${trade.buyDate})`);
    check(trade.buyPrice === 10.3, `买入价已落盘 (实际: ${trade.buyPrice})`);
  }

  // 用例E：t_close 封板拦截（主板 10%）——记录日收盘封死涨停（close===high 且涨幅≥10%）→ 未成交(limit_up_filled_close)，排除分母
  // （主板的 plan buyHigh=10.5，收盘11.0本应判 high_close_unfilled；但封板拦截优先级更高，应先判 limit_up_filled_close）
  section('买入时机E：t_close 封板拦截（主板10%，收盘封死涨停→排除分母）');
  {
    const rec = makeRec({ date: '2026-01-01', code: '600000', ...plan }); // 主板，非ST → 10% 涨停
    rec.buyTiming = 't_close';
    const daily = [
      ...HIST,
      // 记录日=买入日：开盘10.5、最高11.0、最低10.4、收盘11.0（close===high，较前一交易日10.0涨10%→封板涨停封死）
      k('2026-01-01', 10.5, 11.0, 10.4, 11.0),
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'invalid', `status=invalid (实际: ${trade.status})`);
    check(trade.anomalies.includes('limit_up_filled_close'), `anomaly=limit_up_filled_close (实际: ${trade.anomalies})`);
    check(trade.buyPrice == null, '无买入价（未成交）');
    check(trade.excludedFromStats === true, `excludedFromStats=true（排除分母）(实际: ${trade.excludedFromStats})`);
  }

  // 用例E2：t_close 封板拦截（创业板 20%）——验证 getLimitPct 按代码前缀区分 10%/20%
  section('买入时机E2：t_close 封板拦截（创业板20%，收盘封死涨停→排除分母）');
  {
    const rec = makeRec({ date: '2026-01-01', code: '300001', ...plan }); // 创业板 → 20% 涨停
    rec.buyTiming = 't_close';
    const daily = [
      ...HIST,
      // 记录日=买入日：收盘12.0===high，较前一交易日10.0涨20%→封板涨停封死（创业板20%）
      k('2026-01-01', 11.0, 12.0, 11.0, 12.0),
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'invalid', `status=invalid (实际: ${trade.status})`);
    check(trade.anomalies.includes('limit_up_filled_close'), `anomaly=limit_up_filled_close (实际: ${trade.anomalies})`);
    check(trade.buyPrice == null, '无买入价（未成交）');
    check(trade.excludedFromStats === true, `excludedFromStats=true（排除分母）(实际: ${trade.excludedFromStats})`);
  }

  // 用例F：t_close 烂板买入——记录日盘中触及涨停但收盘回落（close<涨停价，close!==high）→ 不封板，按收盘价成交
  section('买入时机F：t_close 烂板买入（盘中触涨停但收盘回落→按收盘价成交）');
  {
    const rec = makeRec({ date: '2026-01-01', buyLow: 10, buyHigh: 11, stop: 9, target1: 12, target2: 13, holdMax: 1 });
    rec.buyTiming = 't_close';
    const daily = [
      ...HIST,
      // 记录日=买入日：盘中最高11.2（触及涨停），但收盘10.8<涨停价11.0（close!==high）→ 烂板，不封板
      k('2026-01-01', 10.5, 11.2, 10.3, 10.8),
      // T+1：无触发（low10.7>stop9, high10.9<target1 12），持有满1日→hold_expired 平仓
      k('2026-01-02', 10.8, 10.9, 10.7, 10.85),
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'closed', `status=closed（封板拦截未触发，已成交）(实际: ${trade.status})`);
    check(trade.buyPrice === 10.8, `买入价=记录日收盘 10.8（≠开盘 10.5）(实际: ${trade.buyPrice})`);
    check(trade.buyDate === '2026-01-01', `买入日期=记录日 (实际: ${trade.buyDate})`);
    check(!trade.anomalies.includes('limit_up_filled_close'), `anomaly 不含 limit_up_filled_close（烂板不拦截）(实际: ${trade.anomalies})`);
    check(trade.sellReason === 'hold_expired', `sellReason=hold_expired（T+1到期平仓）(实际: ${trade.sellReason})`);
  }
}

// ───────── 「已记录」Tab 视图分类验收（G1-G5） ─────────
function runRecordedCategoryAssertion() {
  const plan = { buyLow: 10, buyHigh: 10.5, stop: 9, target1: 11, target2: 12 };

  section('已记录Tab G1：记录刚生成（open + buyPrice=null）→ recorded，不落入「持仓中」');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    const c = tradeViewCategory(rec);
    check(c === 'recorded', `category=recorded (实际: ${c})`);
    check(c !== 'open', '不在「持仓中」Tab');
    check(TRADE_VIEW_STATUS_LABELS[c] === '待买入', `行内标签=待买入 (实际: ${TRADE_VIEW_STATUS_LABELS[c]})`);
    check(rec.trade.status === 'open', '数据层 status 仍为 open（视图分类不落盘、不改 store）');
  }

  section('已记录Tab G2：次日买入成功（open + buyPrice 已落盘）→ open，自动迁移到「持仓中」');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan }); // 默认 t_next_open
    const daily = [
      ...HIST,
      k('2026-01-01', 10.0, 10.3, 9.9, 10.1),
      k('2026-01-02', 10.2, 10.4, 10.0, 10.3), // 买入日：开盘 10.2 ∈ [10,10.5]，其后无 T+1 卖出日
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'open', `买入后 status=open (实际: ${trade.status})`);
    check(trade.buyPrice === 10.2, `buyPrice 已落盘 10.2 (实际: ${trade.buyPrice})`);
    const settled = { ...rec, trade: { ...trade } };
    const c = tradeViewCategory(settled);
    check(c === 'open', `category=open（持仓中）(实际: ${c})`);
    check(TRADE_VIEW_STATUS_LABELS[c] === '持仓中', '行内标签=持仓中');
  }

  section('已记录Tab G3：高开/封板未成交（invalid + buyPrice=null）→ invalid，保持「未成交」');
  {
    // 次日高开：买入日开盘 10.8 > buyHigh 10.5 且 < target1 11 → high_open_unfilled
    const highOpen = makeRec({ date: '2026-01-01', ...plan });
    const d1 = [
      ...HIST,
      k('2026-01-01', 10.0, 10.3, 9.9, 10.1),
      k('2026-01-02', 10.8, 10.9, 10.7, 10.85),
      k('2026-01-03', 10.8, 10.9, 10.7, 10.85),
    ];
    const t1 = simulateTrade(highOpen, d1).trade;
    check(t1.status === 'invalid', `高开 status=invalid (实际: ${t1.status})`);
    check(tradeViewCategory({ ...highOpen, trade: t1 }) === 'invalid', '高开→未成交 Tab（非已记录）');

    // 尾盘封板：t_close 收盘=最高且涨幅 10% → limit_up_filled_close，排除分母
    const sealed = makeRec({ date: '2026-01-01', ...plan });
    sealed.buyTiming = 't_close';
    const d2 = [...HIST, k('2026-01-01', 10.5, 11.0, 10.4, 11.0)];
    const t2 = simulateTrade(sealed, d2).trade;
    check(t2.status === 'invalid', `封板 status=invalid (实际: ${t2.status})`);
    check(t2.anomalies.includes('limit_up_filled_close'), `封板异常正确 (实际: ${t2.anomalies})`);
    check(tradeViewCategory({ ...sealed, trade: t2 }) === 'invalid', '封板→未成交 Tab（非已记录）');
  }

  section('已记录Tab G4：t_close 收盘价待定 → recorded；已平仓 → closed');
  {
    const pending = makeRec({ date: '2026-01-01', ...plan });
    pending.buyTiming = 't_close';
    check(tradeViewCategory(pending) === 'recorded', 't_close 待定记录归入「已记录」');
    const closedRec = makeRec({ date: '2026-01-01', ...plan });
    closedRec.trade = { ...closedRec.trade, status: 'closed', buyPrice: 10.2, sellPrice: 11, returnPct: 7.84 };
    check(tradeViewCategory(closedRec) === 'closed', '已平仓仍归「已平仓」');
  }

  section('已记录Tab G5：互斥完备性 + 统计分母不受视图分类影响');
  {
    const a = makeRec({ date: '2026-01-01', ...plan }); // recorded
    const b = makeRec({ date: '2026-01-02', ...plan });
    b.trade = { ...b.trade, buyPrice: 10.2 }; // open（已买入）
    const c = makeRec({ date: '2026-01-03', ...plan });
    c.trade = { ...c.trade, status: 'invalid' }; // invalid 且 buyPrice=null
    const d = makeRec({ date: '2026-01-04', ...plan });
    d.trade = { ...d.trade, status: 'closed', buyPrice: 10, sellPrice: 11, returnPct: 10 };
    const all = [a, b, c, d];
    const openAll = all.filter((r) => r.trade.status === 'open');
    const recorded = all.filter((r) => tradeViewCategory(r) === 'recorded');
    const holding = all.filter((r) => tradeViewCategory(r) === 'open');
    check(
      recorded.length + holding.length === openAll.length,
      `recorded+持仓中 = 原 open 集合 (${recorded.length}+${holding.length}=${openAll.length})`,
    );
    check(recorded.every((r) => !holding.includes(r)), '两类无重叠');
    check(c.trade.buyPrice == null && tradeViewCategory(c) === 'invalid', 'invalid 即使 buyPrice=null 也不误归 recorded');
    const s = computeWinRateStats(all, { excludeAnomaly: true }).byStrategy[0];
    check(s.closed === 1, `统计有效笔数=1（仅 closed，视图分类不碰分母）(实际: ${s.closed})`);
  }
}

// ───────── 结算守卫：买入日（T+1）收盘即落盘（H1-H5） ─────────
function runSettleGuardAssertion() {
  const plan = { buyLow: 10, buyHigh: 10.5, stop: 9, target1: 11, target2: 12 };
  const recDay = k('2026-01-01', 10.0, 10.3, 9.9, 10.1);
  const buyDay = k('2026-01-02', 10.2, 10.4, 10.0, 10.3); // t_next_open 的买入日

  section('结算守卫 H1：t_next_open 买入日 K 未产生 → 不结算，保持「待买入」');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    const daily = [...HIST, recDay];
    check(locateBuyDayIndex(rec, daily) === -1, `买入日索引=-1 (实际: ${locateBuyDayIndex(rec, daily)})`);
    check(canSettleRecord(rec, daily) === false, 'canSettleRecord=false');
    check(tradeViewCategory(rec) === 'recorded', '仍在「已记录」Tab');
  }

  section('结算守卫 H2：t_next_open 买入日收盘、卖出日 K 未产生 → 放行结算');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    const daily = [...HIST, recDay, buyDay];
    check(
      locateBuyDayIndex(rec, daily) === HIST.length + 1,
      `买入日索引=记录日后首根 (实际: ${locateBuyDayIndex(rec, daily)})`,
    );
    check(canSettleRecord(rec, daily) === true, 'canSettleRecord=true（旧守卫在此会跳过，推迟到 T+2）');
  }

  section('结算守卫 H3：H2 场景 simulateTrade 立即落盘 buyPrice（open，不标 data_missing）');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    const daily = [...HIST, recDay, buyDay];
    const { trade, tPlus1SellDate } = simulateTrade(rec, daily);
    check(trade.status === 'open', `status=open（持仓中）(实际: ${trade.status})`);
    check(trade.buyDate === '2026-01-02', `买入日=2026-01-02 (实际: ${trade.buyDate})`);
    check(trade.buyPrice === 10.2, `buyPrice=10.2 已落盘 (实际: ${trade.buyPrice})`);
    check(!trade.anomalies.includes('data_missing'), `不误标 data_missing (实际: ${trade.anomalies})`);
    check(tPlus1SellDate == null, 'T+1 卖出日尚未产生（null）');
    check(tradeViewCategory({ ...rec, trade }) === 'open', '买入日当天即从「待买入」迁移到「持仓中」');
  }

  section('结算守卫 H4：t_close 盘中快照保护（记录日 K 未收盘定稿 → 不结算）');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    rec.buyTiming = 't_close';
    const onlyRecordDay = [...HIST, recDay];
    check(
      locateBuyDayIndex(rec, onlyRecordDay) === HIST.length,
      `买入日=记录日索引 (实际: ${locateBuyDayIndex(rec, onlyRecordDay)})`,
    );
    check(canSettleRecord(rec, onlyRecordDay) === false, '仅到记录日 → false（避免盘中价冒充收盘价）');
    check(canSettleRecord(rec, [...HIST, recDay, buyDay]) === true, '记录日后出现新 K → true（收盘定稿）');
  }

  section('结算守卫 H5：买入日定位口径（t_close=记录日 / t_next_open=次日）');
  {
    const daily = [...HIST, recDay, buyDay];
    const a = makeRec({ date: '2026-01-01', ...plan });
    a.buyTiming = 't_close';
    const b = makeRec({ date: '2026-01-01', ...plan });
    check(locateBuyDayIndex(a, daily) === HIST.length, `t_close→记录日 (实际: ${locateBuyDayIndex(a, daily)})`);
    check(locateBuyDayIndex(b, daily) === HIST.length + 1, `t_next_open→次日 (实际: ${locateBuyDayIndex(b, daily)})`);
  }
}

// ───────── 买入执行率 / 未成交文案 / 封板拦截生效（本轮新增 J1-J4） ─────────
function runExecutionRateAssertion() {
  const plan = { buyLow: 10, buyHigh: 10.5, stop: 9, target1: 12, target2: 13, holdMax: 1 };
  const mk = (status: TradeRecord['status'], anomalies: WinRateAnomaly[] = []): WinRateRecord => {
    const r = makeRec({ date: '2026-01-01', ...plan });
    r.trade.status = status;
    r.trade.anomalies = anomalies;
    return r;
  };

  section('执行率 J1：tradeInvalidNote 各未成交原因文案');
  {
    check(tradeInvalidNote(mk('open', [])) === null, '非 invalid 返回 null（表格回退 tradeRuleNote）');
    check(
      tradeInvalidNote(mk('invalid', ['unbuyable'])) === '无行情/停牌，不可买入，未成交',
      'unbuyable → 无行情/停牌',
    );
    check(
      tradeInvalidNote(mk('invalid', ['limit_up_filled_close'])) === '尾盘封板买不进，未成交',
      'limit_up_filled_close → 尾盘封板',
    );
    check(
      tradeInvalidNote(mk('invalid', ['limit_up_unfilled'])) === '次日一字板无卖盘，未成交',
      'limit_up_unfilled → 一字板',
    );
    check(
      tradeInvalidNote(mk('invalid', ['high_open_unfilled'])) === '次日高开超出买入区间，未成交',
      'high_open_unfilled → 高开',
    );
    check(
      tradeInvalidNote(mk('invalid', ['low_close_unfilled'])) === '收盘价超出买入区间，未成交',
      'low_close_unfilled → 收盘价',
    );
    check(tradeInvalidNote(mk('invalid', [])) === '未成交', '未知 invalid → 兜底未成交');
  }

  section('执行率 J2：买入执行率 = (total - invalidCount) / total');
  {
    const closedRec = (): WinRateRecord => {
      const r = mk('closed');
      r.trade.buyPrice = 10;
      r.trade.sellPrice = 11;
      r.trade.returnPct = 10;
      return r;
    };
    // 2 closed + 1 open(未结算) + 3 invalid → total=6, invalid=3 → 0.5
    const all = [closedRec(), closedRec(), mk('open'), mk('invalid'), mk('invalid'), mk('invalid')];
    const s = computeWinRateStats(all, { excludeAnomaly: true }).byStrategy[0];
    check(s.total === 6, `total=6 (实际: ${s.total})`);
    check(s.invalidCount === 3, `invalidCount=3 (实际: ${s.invalidCount})`);
    check(
      s.executableRate === 0.5,
      `买入执行率=0.5（未结算 open 计入可执行）(实际: ${s.executableRate})`,
    );
    const noneBuyable = Array.from({ length: 5 }, () => mk('invalid'));
    const s2 = computeWinRateStats(noneBuyable, { excludeAnomaly: true }).byStrategy[0];
    check(s2.executableRate === 0, `全部买不进 → 0（长期低执行率场景）(实际: ${s2.executableRate})`);
  }

  section('执行率 J3：t_next_open 次日一字板 → limit_up_unfilled 排除（封板拦截真正生效）');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    rec.buyTiming = 't_next_open';
    const daily = [
      ...HIST,
      k('2026-01-01', 10.0, 10.2, 9.9, 10.0),
      k('2026-01-02', 11.0, 11.0, 11.0, 11.0), // 次日一字板 +10%，无卖盘
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'invalid', `status=invalid (实际: ${trade.status})`);
    check(trade.anomalies.includes('limit_up_unfilled'), `anomaly=limit_up_unfilled (实际: ${trade.anomalies})`);
    check(trade.buyPrice == null, '无买入价（未成交）');
    check(
      tradeInvalidNote({ ...rec, trade }) === '次日一字板无卖盘，未成交',
      '一字板未成交文案正确',
    );
  }

  section('执行率 J4：t_next_open 收盘封板但开盘可买 → 正常成交（不误判 invalid）');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    rec.buyTiming = 't_next_open';
    const daily = [
      ...HIST,
      k('2026-01-01', 10.0, 10.2, 9.9, 10.0),
      k('2026-01-02', 10.2, 11.0, 10.0, 11.0), // 收盘涨停，但开盘 10.2 在买入区间内 → 可买进
      k('2026-01-03', 11.0, 11.2, 10.8, 11.1),
    ];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status !== 'invalid', `不误判 invalid (实际: ${trade.status})`);
    check(trade.buyPrice === 10.2, `买入价=开盘 10.2 (实际: ${trade.buyPrice})`);
  }
}

// ───────── 未成交判定日 invalidDate（本轮新增 K1-K6） ─────────
function runInvalidDateAssertion() {
  const plan = { buyLow: 10, buyHigh: 10.5, stop: 9, target1: 12, target2: 13, holdMax: 1 };
  const recDay = k('2026-01-01', 10.0, 10.2, 9.9, 10.0);
  const highOpenDay = [...HIST, recDay, k('2026-01-02', 10.8, 10.9, 10.7, 10.85), k('2026-01-03', 10.8, 10.9, 10.7, 10.85)];
  const fillableDay = [...HIST, recDay, k('2026-01-02', 10.2, 10.4, 10.0, 10.3), k('2026-01-03', 10.3, 10.5, 10.2, 10.4)];

  section('判定日 K1：t_next_open 次日高开未成交 → invalidDate=判定当天');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    const { trade } = simulateTrade(rec, highOpenDay);
    check(trade.status === 'invalid', `status=invalid (实际: ${trade.status})`);
    check(trade.anomalies.includes('high_open_unfilled'), `anomaly 正确 (实际: ${trade.anomalies})`);
    check(trade.invalidDate === '2026-01-02', `invalidDate=次日 2026-01-02 (实际: ${trade.invalidDate})`);
    check(trade.buyDate === '2026-01-02', 'buyDate 仍为计划买入日（原有语义不变）');
  }

  section('判定日 K2：t_next_open 次日一字板 → invalidDate=判定当天');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    const daily = [...HIST, recDay, k('2026-01-02', 11.0, 11.0, 11.0, 11.0)];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'invalid', `status=invalid (实际: ${trade.status})`);
    check(trade.anomalies.includes('limit_up_unfilled'), `anomaly 正确 (实际: ${trade.anomalies})`);
    check(trade.invalidDate === '2026-01-02', `invalidDate=2026-01-02 (实际: ${trade.invalidDate})`);
  }

  section('判定日 K3：t_close 记录日封板拦截 → invalidDate=记录日');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    rec.buyTiming = 't_close';
    const daily = [...HIST, k('2026-01-01', 10.5, 11.0, 10.4, 11.0)];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'invalid', `status=invalid (实际: ${trade.status})`);
    check(trade.anomalies.includes('limit_up_filled_close'), `anomaly 正确 (实际: ${trade.anomalies})`);
    check(trade.invalidDate === '2026-01-01', `invalidDate=记录日 2026-01-01 (实际: ${trade.invalidDate})`);
  }

  section('判定日 K4：t_close 收盘价超买入区间 → invalidDate=记录日');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    rec.buyTiming = 't_close';
    const daily = [...HIST, k('2026-01-01', 10.6, 11.2, 10.5, 11.1)];
    const { trade } = simulateTrade(rec, daily);
    check(trade.status === 'invalid', `status=invalid (实际: ${trade.status})`);
    check(trade.anomalies.includes('high_close_unfilled'), `anomaly 正确 (实际: ${trade.anomalies})`);
    check(trade.invalidDate === '2026-01-01', `invalidDate=记录日 2026-01-01 (实际: ${trade.invalidDate})`);
  }

  section('判定日 K5：老数据无 invalidDate 也能正常结算，成交记录不残留');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    check(rec.trade.invalidDate === undefined, '老数据 trade 无 invalidDate 字段');
    const { trade } = simulateTrade(rec, fillableDay);
    check(trade.status !== 'invalid', `老数据正常成交 (实际: ${trade.status})`);
    check(trade.invalidDate == null, `成交记录 invalidDate 为空 (实际: ${trade.invalidDate})`);
  }

  section('判定日 K6：从 invalid 重算成成交后不残留旧判定日');
  {
    const rec = makeRec({ date: '2026-01-01', ...plan });
    const t1 = simulateTrade(rec, highOpenDay).trade;
    check(t1.invalidDate === '2026-01-02', `首次判定 invalidDate=2026-01-02 (实际: ${t1.invalidDate})`);
    const rec2 = { ...rec, trade: { ...t1 } };
    const t2 = simulateTrade(rec2, fillableDay).trade;
    check(t2.status !== 'invalid', `重算后成交 (实际: ${t2.status})`);
    check(t2.invalidDate == null, `旧判定日已清空 (实际: ${t2.invalidDate})`);
  }
}

// ───────── 混合买入时机 t_close_or_next_open（本轮新增 M1-M10） ─────────
function runHybridBuyTimingAssertion() {
  const plan = { buyLow: 10, buyHigh: 10.5, stop: 9, target1: 12, target2: 13, holdMax: 1 };
  // buyHigh 高于涨停价，用于构造「收盘价在区间内但封死涨停」这一边界（M4/M5）
  const widePlan = { ...plan, buyHigh: 11.5 };
  const mk = (p: typeof plan) => {
    const r = makeRec({ date: '2026-01-01', ...p });
    r.buyTiming = 't_close_or_next_open';
    return r;
  };
  const recDay = (close: number, high = close, open = 10.0, low = 9.9) =>
    k('2026-01-01', open, high, low, close);
  const nextDay = (open = 10.2, high = 10.4, low = 10.0, close = 10.3) =>
    k('2026-01-02', open, high, low, close);
  const thirdDay = k('2026-01-03', 10.3, 10.5, 10.2, 10.4);

  section('混合时机 M1：记录日收盘在区间内、未封板 → 当天买入成功');
  {
    const r = mk(plan);
    const daily = [...HIST, recDay(10.3, 10.4), k('2026-01-02', 10.4, 11.6, 10.3, 11.4)];
    const { trade, tPlus1SellDate } = simulateTrade(r, daily);
    check(trade.buyDate === '2026-01-01', `买入日=记录日 (实际: ${trade.buyDate})`);
    check(trade.buyPrice === 10.3, `买入价=收盘 10.3 (实际: ${trade.buyPrice})`);
    check(tPlus1SellDate === '2026-01-02', `T+1 可卖日=次日 (实际: ${tPlus1SellDate})`);
    check(trade.status === 'closed', `正常平仓 (实际: ${trade.status})`);
    check(trade.buyDate === r.date, '零字段留痕：买入日=记录日，可判定为「当天买入」');
  }

  section('混合时机 M2：记录日收盘超上限/低于下限 → 顺延次日买入成功');
  {
    const r = mk(plan);
    const daily = [...HIST, recDay(10.9, 11.0), nextDay(), thirdDay];
    const { trade, tPlus1SellDate } = simulateTrade(r, daily);
    check(trade.buyDate === '2026-01-02', `顺延买入日=次日 (实际: ${trade.buyDate})`);
    check(trade.buyPrice === 10.2, `买入价=次日开盘 10.2 (实际: ${trade.buyPrice})`);
    check(tPlus1SellDate === '2026-01-03', `T+1 可卖日按实际买入日+1 (实际: ${tPlus1SellDate})`);
    check(trade.buyDate !== r.date, '零字段留痕：买入日≠记录日，可判定为「顺延」');
    // 过低同样顺延
    const r2 = mk(plan);
    const daily2 = [...HIST, recDay(9.2, 9.8, 9.0, 8.9), nextDay(), thirdDay];
    const t2 = simulateTrade(r2, daily2).trade;
    check(t2.buyDate === '2026-01-02' && t2.buyPrice === 10.2, `收盘过低也顺延 (实际: ${t2.buyDate}/${t2.buyPrice})`);
  }

  section('混合时机 M3：记录日超上限 → 次日高开未成交');
  {
    const r = mk(plan);
    const daily = [...HIST, recDay(10.9, 11.0), k('2026-01-02', 10.8, 10.9, 10.7, 10.85), thirdDay];
    const { trade } = simulateTrade(r, daily);
    check(trade.status === 'invalid', `status=invalid (实际: ${trade.status})`);
    check(trade.anomalies.includes('high_open_unfilled'), `anomaly 正确 (实际: ${trade.anomalies})`);
    check(trade.invalidDate === '2026-01-02', `判定日=次日 (实际: ${trade.invalidDate})`);
  }

  section('混合时机 M4：收盘在区间内但封死涨停 → 顺延次日买入成功（不判失效）');
  {
    const r = mk(widePlan);
    const daily = [...HIST, k('2026-01-01', 10.5, 11.0, 10.4, 11.0), nextDay(), thirdDay];
    const { trade, tPlus1SellDate } = simulateTrade(r, daily);
    check(trade.status !== 'invalid', `不在记录日直接判失效 (实际: ${trade.status})`);
    check(!trade.anomalies.includes('limit_up_filled_close'), `不出现封板失效 (实际: ${trade.anomalies})`);
    check(trade.excludedFromStats !== true, '不设 excludedFromStats（顺延不是排除分母）');
    check(trade.buyDate === '2026-01-02', `顺延买入日=次日 (实际: ${trade.buyDate})`);
    check(trade.buyPrice === 10.2, `买入价=次日真实开盘 10.2 (实际: ${trade.buyPrice})`);
    check(tPlus1SellDate === '2026-01-03', `T+1 可卖日=2026-01-03 (实际: ${tPlus1SellDate})`);
  }

  section('混合时机 M5：记录日封板 → 次日一字板未成交');
  {
    const r = mk(widePlan);
    const daily = [...HIST, k('2026-01-01', 10.5, 11.0, 10.4, 11.0), k('2026-01-02', 12.1, 12.1, 12.1, 12.1)];
    const { trade } = simulateTrade(r, daily);
    check(trade.status === 'invalid', `status=invalid (实际: ${trade.status})`);
    check(trade.anomalies.includes('limit_up_unfilled'), `anomaly 正确 (实际: ${trade.anomalies})`);
    check(trade.invalidDate === '2026-01-02', `判定日=次日 (实际: ${trade.invalidDate})`);
  }

  section('混合时机 M6：T+1 约束在当天买入与顺延两种情况下都正确');
  {
    const r1 = mk(plan);
    const a = simulateTrade(r1, [...HIST, recDay(10.3, 10.4), k('2026-01-02', 10.4, 11.6, 10.3, 11.4)]).trade;
    check(a.sellDate != null && a.buyDate != null && a.sellDate > a.buyDate, '当天买入：卖出日 > 买入日');
    const r2 = mk(plan);
    const b = simulateTrade(r2, [...HIST, recDay(10.9, 11.0), nextDay(), thirdDay]).trade;
    check(b.sellDate != null && b.buyDate != null && b.sellDate > b.buyDate, '顺延买入：卖出日 > 买入日');
  }

  section('混合时机 M7：顺延留痕可用 buyDate !== record.date 推断（零字段方案）');
  {
    const today = mk(plan);
    const a = simulateTrade(today, [...HIST, recDay(10.3, 10.4), k('2026-01-02', 10.4, 11.6, 10.3, 11.4)]).trade;
    check(a.buyDate === today.date, '当天买入 → 相等');
    const deferred = mk(plan);
    const b = simulateTrade(deferred, [...HIST, recDay(10.9, 11.0), nextDay(), thirdDay]).trade;
    check(b.buyDate !== deferred.date, '顺延 → 不等');
  }

  section('混合时机 M8：结算守卫要求记录日 K 定稿（防盘中快照当收盘价）');
  {
    const r = mk(plan);
    const onlyToday = [...HIST, recDay(10.3, 10.4)];
    check(locateBuyDayIndex(r, onlyToday) === HIST.length, `候选买入日=记录日索引 (实际: ${locateBuyDayIndex(r, onlyToday)})`);
    check(canSettleRecord(r, onlyToday) === false, '仅到记录日 → 不结算');
    check(canSettleRecord(r, [...onlyToday, nextDay()]) === true, '含次日 K → 放行结算');
  }

  section('混合时机 M9：回归——纯 t_close / 纯 t_next_open 行为不变');
  {
    const sealed = makeRec({ date: '2026-01-01', ...plan });
    sealed.buyTiming = 't_close';
    const t1 = simulateTrade(sealed, [...HIST, k('2026-01-01', 10.5, 11.0, 10.4, 11.0)]).trade;
    check(t1.anomalies.includes('limit_up_filled_close'), '纯 t_close 封板仍判封板失效');
    check(t1.excludedFromStats === true, '纯 t_close 封板仍排除分母');
    const next = makeRec({ date: '2026-01-01', ...plan });
    next.buyTiming = 't_next_open';
    const t2 = simulateTrade(next, [...HIST, recDay(10.9, 11.0), nextDay(), thirdDay]).trade;
    check(t2.status !== 'invalid', `纯 t_next_open 不看记录日收盘 (实际: ${t2.status})`);
    check(t2.buyDate === '2026-01-02' && t2.buyPrice === 10.2, '纯 t_next_open 仍按次日开盘成交');
  }

  section('混合时机 M10：战法配置生效范围');
  {
    const c = WINRATE_STRATEGY_CONFIG;
    check(c['first-board'].buyTiming === 't_close_or_next_open', '首板打板 → 混合');
    check(c['dragon'].buyTiming === 't_close_or_next_open', '龙头战法 → 混合');
    check(c['pullback-buy'].buyTiming === 't_close_or_next_open', '低吸回踩 → 混合');
    check(c['board-advance'].buyTiming === 't_next_open', '连板晋级保持次日买（与上轮决策一致）');
    check(c['overnight-hold'].buyTiming === 't_close', '隔夜持股法保持尾盘买（顺延会破坏定义）');
  }
}

// ───────── 动态买卖规则 / 低开未成交 / 时间倒错修复（本轮新增 P1-P14） ─────────
function runDynamicRulesAssertion() {
  const plan = { buyLow: 10, buyHigh: 10.5, stop: 9, target1: 12, target2: 13, holdMax: 10 };
  // 25 根长历史，用于需要 MA20 / MA10 的用例（HIST 只有 12 根，算不出 MA20）
  const LONG_HIST: KlineRow[] = Array.from({ length: 25 }, (_, i) =>
    k(`2025-12-${String(i + 1).padStart(2, '0')}`, 10, 10.2, 9.8, 10, 1000),
  );
  const mk = (strategyId: string, timing: 't_close' | 't_next_open' | 't_close_or_next_open', p = plan) => {
    const r = makeRec({ date: '2026-01-01', ...p });
    r.strategyId = strategyId;
    r.buyTiming = timing;
    return r;
  };
  const d0 = k('2026-01-01', 10.0, 10.2, 9.9, 10.0);
  const buyDay = k('2026-01-02', 10.2, 10.4, 10.0, 10.3);

  section('动态规则 P1：t_next_open 低开跌破 buyLow → low_open_unfilled（排除分母）');
  {
    const r = mk('test-strategy', 't_next_open');
    const daily = [...HIST, d0, k('2026-01-02', 9.5, 9.8, 9.4, 9.6), k('2026-01-03', 9.6, 9.8, 9.5, 9.7)];
    const { trade } = simulateTrade(r, daily);
    check(trade.status === 'invalid', `status=invalid (实际: ${trade.status})`);
    check(trade.anomalies.includes('low_open_unfilled'), `anomaly 正确 (实际: ${trade.anomalies})`);
    check(trade.invalidDate === '2026-01-02', `判定日=次日 (实际: ${trade.invalidDate})`);
    check(trade.excludedFromStats === true, '排除分母标记已置');
    check(tradeInvalidNote({ ...r, trade }) === '次日低开跌破买入区间，未成交', '未成交文案正确');
  }

  section('动态规则 P2：t_close 时间倒错修复——买入当日盘中破止损不得驱动次日平仓');
  {
    const p = { ...plan, stop: 9.9, holdMax: 3 };
    const r = mk('test-strategy', 't_close', p);
    const daily = [
      ...HIST,
      k('2026-01-01', 10.0, 10.3, 9.5, 10.2), // 盘中 low 9.5 < stop 9.9，但收盘 10.2 在区间内
      k('2026-01-02', 10.3, 10.5, 10.2, 10.4),
      k('2026-01-03', 10.4, 10.6, 10.3, 10.5),
      k('2026-01-04', 10.5, 10.7, 10.4, 10.6),
    ];
    const { trade } = simulateTrade(r, daily);
    check(trade.sellReason !== 'tplus1_stop_loss', `不误判 T+1 止损 (实际: ${trade.sellReason})`);
    check(trade.sellReason === 'hold_expired', `正常持有到到期 (实际: ${trade.sellReason})`);
  }

  section('动态规则 P3：t_next_open 的买入当日触发标记仍然有效（回归）');
  {
    const p = { ...plan, stop: 9.9, holdMax: 10 };
    const r = mk('test-strategy', 't_next_open', p);
    const daily = [
      ...HIST, d0,
      k('2026-01-02', 10.2, 10.4, 9.5, 10.3), // 开盘买入后盘中 low 9.5 < stop
      k('2026-01-03', 10.3, 10.5, 10.2, 10.4),
    ];
    const { trade } = simulateTrade(r, daily);
    check(trade.sellReason === 'tplus1_stop_loss', `仍按 T+1 开盘平仓 (实际: ${trade.sellReason})`);
  }

  section('动态规则 P4：断板（日K近似）→ broken_board，按收盘价、计入分母');
  {
    const r = mk('first-board', 't_next_open');
    const daily = [...HIST, d0, buyDay, k('2026-01-03', 10.3, 10.5, 10.2, 10.4)];
    const { trade } = simulateTrade(r, daily);
    check(trade.sellReason === 'broken_board', `sellReason=broken_board (实际: ${trade.sellReason})`);
    check(trade.sellPrice === 10.4, `按收盘价成交 (实际: ${trade.sellPrice})`);
    check(trade.status === 'closed' && trade.excludedFromStats !== true, '正常平仓且未排除分母');
    check(SELL_REASON_LABELS.broken_board.includes('日K近似'), '卖出原因带「日K近似」标签');
  }

  section('动态规则 P5：反弹衰竭（收盘 < MA3）→ rebound_fade');
  {
    const r = mk('oversold-bounce', 't_next_open');
    const daily = [...HIST, d0, buyDay, k('2026-01-03', 10.3, 10.35, 9.8, 9.9)];
    const { trade } = simulateTrade(r, daily);
    check(trade.sellReason === 'rebound_fade', `sellReason=rebound_fade (实际: ${trade.sellReason})`);
    check(trade.sellPrice === 9.9, `按收盘价成交 (实际: ${trade.sellPrice})`);
  }

  section('动态规则 P6：量价背离（收阴且放量 / 破 MA5）→ volume_price_divergence');
  {
    const r = mk('volume-price-up', 't_next_open');
    const daily = [...HIST, d0, buyDay, k('2026-01-03', 10.4, 10.45, 9.9, 10.0, 2000)];
    const { trade } = simulateTrade(r, daily);
    check(
      trade.sellReason === 'volume_price_divergence',
      `sellReason=volume_price_divergence (实际: ${trade.sellReason})`,
    );
  }

  section('动态规则 P7：次日走弱（收盘 < 买入价）→ weak_close');
  {
    const r = mk('ultra-short', 't_next_open');
    const daily = [...HIST, d0, buyDay, k('2026-01-03', 10.3, 10.35, 9.9, 10.0)];
    const { trade } = simulateTrade(r, daily);
    check(trade.sellReason === 'weak_close', `sellReason=weak_close (实际: ${trade.sellReason})`);
  }

  section('动态规则 P8：跌破 MA20 → ma_breakdown（需长历史）');
  {
    const r = mk('trend-break', 't_next_open');
    const daily = [...LONG_HIST, d0, buyDay, k('2026-01-03', 10.3, 10.35, 9.5, 9.6)];
    const { trade } = simulateTrade(r, daily);
    check(trade.sellReason === 'ma_breakdown', `sellReason=ma_breakdown (实际: ${trade.sellReason})`);
  }

  section('动态规则 P9：放量跌破 MA10 防守线 → defense_break');
  {
    const r = mk('pullback-buy', 't_next_open');
    const daily = [...LONG_HIST, d0, buyDay, k('2026-01-03', 10.3, 10.35, 9.5, 9.6, 2000)];
    const { trade } = simulateTrade(r, daily);
    check(trade.sellReason === 'defense_break', `sellReason=defense_break (实际: ${trade.sellReason})`);
  }

  section('动态规则 P10：隔夜强制清仓（日K近似）→ overnight_exit');
  {
    const r = mk('overnight-hold', 't_close');
    const daily = [...HIST, k('2026-01-01', 10.0, 10.3, 9.9, 10.2), k('2026-01-02', 10.3, 10.5, 10.2, 10.4)];
    const { trade } = simulateTrade(r, daily);
    check(trade.sellReason === 'overnight_exit', `sellReason=overnight_exit (实际: ${trade.sellReason})`);
    check(SELL_REASON_LABELS.overnight_exit.includes('日K近似'), '卖出原因带「日K近似」标签');
  }

  section('动态规则 P11：优先级——盘中固定止盈先于收盘动态规则');
  {
    const r = mk('first-board', 't_next_open', { ...plan, target1: 10.6 });
    const daily = [...HIST, d0, buyDay, k('2026-01-03', 10.3, 11.0, 10.2, 10.9)];
    const { trade } = simulateTrade(r, daily);
    check(trade.sellReason === 'target1', `固定止盈优先 (实际: ${trade.sellReason})`);
  }

  section('动态规则 P12：混合时机顺延路径同样拦截低开');
  {
    const r = mk('test-strategy', 't_close_or_next_open');
    const daily = [...HIST, k('2026-01-01', 10.0, 11.0, 9.9, 10.9), k('2026-01-02', 9.5, 9.8, 9.4, 9.6)];
    const { trade } = simulateTrade(r, daily);
    check(trade.anomalies.includes('low_open_unfilled'), `顺延后低开被拦截 (实际: ${trade.anomalies})`);
  }

  section('动态规则 P13：MA30 指标可算（UI 默认 60 根保证 31 个可画点）');
  {
    const rows = Array.from({ length: 35 }, (_, i) => k(`2026-01-${String(i + 1).padStart(2, '0')}`, 10, 10, 10, 10));
    const ma = calcMA(rows);
    check(ma.ma30[28] == null, 'MA30 第 29 根仍为 null（历史不足）');
    check(ma.ma30[29] != null, 'MA30 第 30 根有值');
    check(ma.ma30[34] === 10, `MA30 末值正确 (实际: ${ma.ma30[34]})`);
  }

  section('动态规则 P14：未启用/未知战法不触发动态规则（零回归保障）');
  {
    const r = mk('test-strategy', 't_next_open', { ...plan, holdMax: 2 });
    // 给足 2 根可卖日 K，让 holdMax=2 的到期路径能走完
    const daily = [
      ...HIST, d0, buyDay,
      k('2026-01-03', 10.3, 10.5, 10.2, 10.4),
      k('2026-01-04', 10.4, 10.6, 10.3, 10.5),
    ];
    const { trade } = simulateTrade(r, daily);
    check(trade.sellReason !== 'broken_board' && trade.sellReason !== 'weak_close', '未知战法走原有固定判定');
    check(trade.sellReason === 'hold_expired', `按原有到期规则平仓 (实际: ${trade.sellReason})`);
    check(trade.status === 'closed', `正常平仓 (实际: ${trade.status})`);
  }
}

function runEntryEngineAssertion() {
  // ── N1. 12 战法 entryStyle 映射（用户拍板：与 buyTiming 互补、不取代）──
  section('盘中买入引擎 N1：12 战法 entryStyle 映射（与 buyTiming 互补、不取代）');
  {
    const EXPECT: Record<string, string> = {
      'first-board': 'instant',
      'board-advance': 'instant',
      'trend-break': 'intraday_limit',
      'ma-bull': 'intraday_limit',
      'dragon': 'instant',
      'pullback-buy': 'intraday_limit',
      'dragon-return': 'intraday_limit',
      'oversold-bounce': 'intraday_limit',
      'ultra-short': 'instant',
      'volume-price-up': 'intraday_limit',
      'overnight-hold': 'daily_only',
      'event': 'daily_only',
    };
    const ids = Object.keys(WINRATE_STRATEGY_CONFIG);
    check(ids.length === 12, '战法配置共 12 个（实际 ' + ids.length + '）');
    let allMatch = true;
    for (const id of Object.keys(EXPECT)) {
      if (WINRATE_STRATEGY_CONFIG[id]?.entryStyle !== EXPECT[id]) allMatch = false;
    }
    check(allMatch, '12 战法 entryStyle 逐项与拍板映射一致');
    check(
      WINRATE_STRATEGY_CONFIG['overnight-hold'].buyTiming === 't_close' &&
        WINRATE_STRATEGY_CONFIG['first-board'].buyTiming === 't_close_or_next_open',
      'entryStyle 不取代 buyTiming：两个战法原 buyTiming 保持不变',
    );
    check(
      Object.keys(ENTRY_STYLE_LABELS).length === 3 &&
        Object.values(ENTRY_STYLE_LABELS).every((v) => typeof v === 'string' && v.length > 0),
      'ENTRY_STYLE_LABELS 三种风格文案齐全',
    );
  }

  // ── N2. 严格 T+1 双条件日期锁（getMonitable / processCode 共用）──
  section('盘中买入引擎 N2：canSellToday 严格 T+1 双条件日期锁');
  {
    const r = makeRec({ date: '2026-01-01' });
    check(canSellToday(r, '2026-01-05') === false, 'buyDate 为空 → 禁止卖出');
    r.trade.buyDate = '2026-01-02';
    check(canSellToday(r, '2026-01-02') === false, '买入当日（today === buyDate）绝对禁止卖出');
    check(canSellToday(r, '2026-01-01') === false, 'today < buyDate → 禁止卖出');
    check(canSellToday(r, '2026-01-03') === false, 'tPlus1SellDate 缺省 → 周末不可卖');
    check(canSellToday(r, '2026-01-05') === true, 'tPlus1SellDate 缺省 → 下一交易日(周一)可卖');
    r.tPlus1SellDate = '2026-01-06';
    check(canSellToday(r, '2026-01-03') === false, '停牌顺延：未到 tPlus1SellDate → 禁止');
    check(canSellToday(r, '2026-01-06') === true, '到达 tPlus1SellDate → 可卖');
    check(canSellToday(r, '2026-01-07') === true, '超过 tPlus1SellDate → 可卖');
  }

  // ── N3. 下一交易日估算（entryTargetDate 锁定值）──
  section('盘中买入引擎 N3：nextTradingDateGuess 跳过周末');
  {
    check(nextTradingDateGuess('2026-01-02') === '2026-01-05', '周五 → 下周一');
    check(nextTradingDateGuess('2026-01-03') === '2026-01-05', '周六 → 下周一');
    check(nextTradingDateGuess('2026-01-04') === '2026-01-05', '周日 → 下周一');
    check(nextTradingDateGuess('2026-01-05') === '2026-01-06', '周一 → 周二');
    check(nextTradingDateGuess('not-a-date') === 'not-a-date', '非法日期 → 原样返回，不抛异常');
  }

  // ── N4. 区间工具（盘中与日K兜底共享的唯一口径）──
  section('盘中买入引擎 N4：buyRangeOverlap / clampToBuyRange 区间语义');
  {
    check(buyRangeOverlap(10.1, 10.4, 10, 10.5) === true, '日内区间与买入区间相交 → true');
    check(buyRangeOverlap(10.6, 10.9, 10, 10.5) === false, '全天最低 > 买高 → false');
    check(buyRangeOverlap(9.1, 9.9, 10, 10.5) === false, '全天最高 < 买低 → false');
    check(buyRangeOverlap(9.1, 10.9, null, null) === true, 'buyLow/buyHigh 缺失按无界放行 → true');
    check(buyRangeOverlap(10.9, 10.1, 10, 10.5) === false, '非法区间 low>high → false');
    check(clampToBuyRange(10.2, 10, 10.5) === 10.2, '价在区间内 → 原值');
    check(clampToBuyRange(9.5, 10, 10.5) === 10, '低于买低 → clamp 到 buyLow');
    check(clampToBuyRange(10.8, 10, 10.5) === 10.5, '高于买高 → clamp 到 buyHigh');
    check(clampToBuyRange(10.8, null, null) === 10.8, '无界 → 原值');
  }

  // ── N5. 盘中买入主判定（纯函数）──
  section('盘中买入引擎 N5：evaluateIntradayEntry 逐风格判定');
  {
    const mb = (date: string, open: number, high: number, low: number, close: number): MinuteBar =>
      ({ date, open, high, low, close });
    const plan = { buyLow: 10, buyHigh: 10.5, stop: 9.5 };
    const inRange = [
      mb('2026-01-02 09:30:00', 10.2, 10.3, 10.1, 10.25),
      mb('2026-01-02 09:31:00', 10.3, 10.4, 10.2, 10.35),
    ];
    check(evaluateIntradayEntry(inRange, plan, 'daily_only').kind === 'skip', 'daily_only → skip（交日K结算）');
    check(evaluateIntradayEntry(inRange, plan, undefined).kind === 'skip', '老记录缺省 entryStyle → skip（零回归）');
    check(evaluateIntradayEntry([], plan, 'instant').kind === 'skip', '空 bars → skip');
    check(
      evaluateIntradayEntry(inRange, { buyLow: null, buyHigh: null }, 'instant').kind === 'invalid',
      '无买入计划 → invalid（死规矩禁止半截计划买入）',
    );

    const d1 = evaluateIntradayEntry(inRange, plan, 'instant');
    check(d1.kind === 'bought' && d1.buyPrice === 10.2, 'instant：9:30 开盘价在区间内 → 按开盘价买入');
    check(
      evaluateIntradayEntry([mb('2026-01-02 09:30:00', 10.8, 10.9, 10.7, 10.85)], plan, 'instant').kind === 'unfilled',
      'instant：高开超限 → 未成交',
    );
    check(
      evaluateIntradayEntry([mb('2026-01-02 09:30:00', 9.5, 9.6, 9.4, 9.55)], plan, 'instant').kind === 'unfilled',
      'instant：低开跌破区间 → 未成交',
    );
    check(
      evaluateIntradayEntry(
        [mb('2026-01-02 09:30:00', 11, 11, 11, 11)],
        { ...plan, limitUpPrice: 11 },
        'instant',
      ).kind === 'unfilled',
      'instant：一字涨停无卖盘 → 未成交',
    );

    const d2 = evaluateIntradayEntry(inRange, plan, 'intraday_limit');
    check(d2.kind === 'bought' && d2.barDate === '2026-01-02 09:30:00', 'intraday_limit：首根落入即买，返回首根 bar');
    const later = [
      mb('2026-01-02 09:30:00', 10.8, 10.9, 10.7, 10.85),
      mb('2026-01-02 09:31:00', 10.4, 10.45, 10.2, 10.3),
    ];
    const d3 = evaluateIntradayEntry(later, plan, 'intraday_limit');
    check(
      d3.kind === 'bought' && d3.buyPrice === 10.4 && d3.barDate === '2026-01-02 09:31:00',
      'intraday_limit：盘中某分钟跌进区间 → 按该分钟开盘价成交',
    );
    const never = [
      mb('2026-01-02 09:30:00', 10.8, 10.9, 10.7, 10.85),
      mb('2026-01-02 09:31:00', 10.7, 10.8, 10.6, 10.75),
    ];
    check(
      evaluateIntradayEntry(never, plan, 'intraday_limit').kind === 'skip',
      'intraday_limit：全天未进入区间 → skip（交 14:50 闸门 / 日K复核）',
    );
  }

  // ── N6. 日K兜底翻案（决策点 2「绝对不漏票」）──
  section('盘中买入引擎 N6：evaluateDailyEntryFallback 日K兜底翻案');
  {
    const dayK = { open: 10.8, high: 10.9, low: 10.05, close: 10.85 }; // 开盘超买高，但日内跌进区间
    const plan = { buyLow: 10, buyHigh: 10.5, stop: 9.5 };
    const f = evaluateDailyEntryFallback(dayK, plan, 'intraday_limit');
    check(f != null && f.buyPrice === 10.5, '14:50 未成交但日K曾跌进区间 → 翻案买入（clamp 到买高）');
    check(evaluateDailyEntryFallback(dayK, plan, 'instant') === null, 'instant 不走日K翻案（与开盘口径一致）');
    check(evaluateDailyEntryFallback(dayK, plan, 'daily_only') === null, 'daily_only 不走日K翻案');
    check(
      evaluateDailyEntryFallback({ open: 10.8, high: 10.9, low: 10.7, close: 10.85 }, plan, 'intraday_limit') === null,
      '全天未进入买入区间 → 不翻案（保持未成交）',
    );
    check(
      evaluateDailyEntryFallback(dayK, { buyLow: null, buyHigh: null }, 'intraday_limit') === null,
      '无买入计划 → 不翻案',
    );
    // 口径一致性：同一组 OHLC，盘中 intraday_limit 与日K翻案结论一致
    const bars: MinuteBar[] = [
      { date: '2026-01-02 09:30:00', open: 10.8, high: 10.9, low: 10.7, close: 10.85 },
      { date: '2026-01-02 09:31:00', open: 10.4, high: 10.45, low: 10.05, close: 10.2 },
    ];
    const d = evaluateIntradayEntry(bars, plan, 'intraday_limit');
    check(
      d.kind === 'bought' && f != null && f.buyPrice > 0,
      '盘中判定与日K翻案共享同一区间语义（均判可买，结果不打架）',
    );
  }

  // ── N7. simulateTrade 端到端：防重锁定 / 日K翻案 / 老记录零回归 ──
  section('盘中买入引擎 N7：simulateTrade 端到端（防重锁定 / 日K翻案 / 零回归）');
  {
    const base = { date: '2026-01-01', buyLow: 10, buyHigh: 10.5, stop: 9, target1: 11, target2: 12 };
    const daily = [
      ...HIST,
      k('2026-01-01', 10, 10, 10, 10),
      k('2026-01-02', 10.2, 10.6, 10.1, 10.5),
      k('2026-01-03', 11.5, 11.6, 11.2, 11.4),
    ];

    // A) 盘中已买入 → 晚间结算锁定，绝不二次买入 / 覆盖触发价
    const bought = makeRec(base);
    bought.buyTiming = 't_next_open';
    bought.entryStyle = 'intraday_limit';
    bought.entryTargetDate = '2026-01-02';
    bought.trade.monitorBought = true;
    bought.trade.buyDate = '2026-01-02';
    bought.trade.buyPrice = 10.25; // 盘中真实触发价 ≠ 次日开盘 10.2
    bought.trade.entrySource = 'intraday';
    bought.trade.intradayEntryResolved = 'bought';
    const r1 = simulateTrade(bought, daily).trade;
    check(r1.buyPrice === 10.25, '盘中买入价被锁定，不被日K开盘价覆盖（防二次买入）');
    check(r1.buyDate === '2026-01-02', '买入日重绑到盘中锁定日');
    check(r1.sellDate === '2026-01-03', '锁定分支只推进卖出，T+1 正常平仓');
    check(r1.intradayEntryResolved == null, '结算后清空软标记，避免下次重复翻案');

    // B) 14:50 软未成交 + 日K曾跌进区间 → 晚间翻案买入（绝对不漏票）
    const unfilled = makeRec(base);
    unfilled.buyTiming = 't_next_open';
    unfilled.entryStyle = 'intraday_limit';
    unfilled.entryTargetDate = '2026-01-02';
    unfilled.trade.intradayEntryResolved = 'unfilled';
    unfilled.trade.entrySource = 'intraday';
    const dailyB = [
      ...HIST,
      k('2026-01-01', 10, 10, 10, 10),
      k('2026-01-02', 10.8, 10.9, 10.05, 10.85), // 开盘 10.8 > 买高，但日内 low 10.05 跌进区间
      k('2026-01-03', 11.5, 11.6, 11.2, 11.4),
    ];
    const r2 = simulateTrade(unfilled, dailyB).trade;
    check(r2.buyPrice === 10.5, '日K兜底翻案买入（clamp 到买高 10.5）');
    check(r2.entrySource === 'daily_k', '标记买入来源 daily_k');
    check(r2.status === 'closed', '翻案后正常推进到平仓（未漏票）');

    // C) 老记录无任何新字段 → 结算结果不变（302 用例零回归的显式锚点）
    const legacy = makeRec(base);
    legacy.buyTiming = 't_next_open';
    const r3 = simulateTrade(legacy, daily).trade;
    check(
      r3.buyPrice === 10.2 && r3.sellDate === '2026-01-03',
      '老记录（无新字段）按原 buyTiming 结算，零回归',
    );
  }
}

function runPlaceholderAssertion() {
  const plan = { buyLow: 10, buyHigh: 10.5, stop: 9, target1: 11, target2: 12 };

  section('占位记录 P1：no_signal 形状（status=empty / 五价全 null / code=NONE）');
  const empty = makePlaceholderRecord({
    date: '2026-01-05', kind: 'no_signal', strategyId: 'trend-break', strategyName: '趋势突破',
    priceSource: 'close', backfilled: false, recordedAt: '2026-01-05T15:05:00.000Z',
  });
  check(empty.trade.status === 'empty', 'status=empty（独立状态，绝不复用 invalid）');
  check(empty.trade.anomalies.includes('no_signal'), 'anomaly=no_signal');
  check(empty.code === 'NONE' && empty.name === '空仓', 'code/name 占位值');
  check(
    [empty.buyLow, empty.buyHigh, empty.stop, empty.target1, empty.target2, empty.recordedPrice]
      .every((v) => v === null),
    '买入区间/止损/目标/记录价全 null',
  );
  check(
    [empty.trade.buyPrice, empty.trade.sellPrice, empty.trade.returnPct].every((v) => v === null),
    '买卖价/收益率全 null（表格显示 —）',
  );
  check(ANOMALY_LABELS.no_signal === '当日全市场无符合该战法条件的标的', 'no_signal 中文说明');
  check(TRADE_VIEW_STATUS_LABELS.empty === '无信号', '状态列文案=无信号');

  section('占位记录 P2：snapshot_missing 形状（当天软件未运行）');
  const missing = makePlaceholderRecord({
    date: '2026-01-06', kind: 'snapshot_missing', strategyId: '__snapshot_missing__',
    strategyName: '系统', priceSource: 'close', backfilled: true,
    recordedAt: '2026-01-07T09:00:00.000Z',
  });
  check(missing.trade.status === 'anomaly', 'status=anomaly');
  check(missing.trade.anomalies.includes('snapshot_missing'), 'anomaly=snapshot_missing');
  check(ANOMALY_LABELS.snapshot_missing === '快照缺失（当天未生成收盘快照）', '文案明确「未运行」');
  check(missing.backfilled === true, 'backfilled=true（回看窗口内补记）');

  section('占位记录 P3：分类与识别（tradeViewCategory 口径不变）');
  check(tradeViewCategory(empty) === 'empty', 'empty 独立分类，不误归 recorded');
  check(placeholderKind(empty) === 'no_signal', 'placeholderKind(no_signal)');
  check(placeholderKind(missing) === 'snapshot_missing', 'placeholderKind(snapshot_missing)');
  const normal = makeRec({ date: '2026-01-05', ...plan });
  check(!isPlaceholderRecord(normal), '普通记录非占位');
  check(placeholderKind(normal) === null, '普通记录 placeholderKind=null');

  section('占位记录 P4：G5 互斥完备性加入占位后仍成立');
  {
    const b = makeRec({ date: '2026-01-02', ...plan });
    b.trade = { ...b.trade, buyPrice: 10.2 };
    const c = makeRec({ date: '2026-01-03', ...plan });
    c.trade = { ...c.trade, status: 'invalid' };
    const all = [normal, b, c, empty, missing];
    const openAll = all.filter((r) => r.trade.status === 'open');
    const recorded = all.filter((r) => tradeViewCategory(r) === 'recorded');
    const holding = all.filter((r) => tradeViewCategory(r) === 'open');
    check(
      recorded.length + holding.length === openAll.length,
      'recorded+持仓中 = 原 open 集合 (' + recorded.length + '+' + holding.length + '=' + openAll.length + ')',
    );
    check(recorded.every((r) => !holding.includes(r)), '两类无重叠');
  }

  section('占位记录 P5：统计层完全剔除占位（total / 执行率 / 胜率分母 / anomalyCount）');
  {
    const closedRec = makeRec({ date: '2026-01-04', ...plan });
    closedRec.trade = { ...closedRec.trade, status: 'closed', buyPrice: 10, sellPrice: 11, returnPct: 10 };
    const invalidRec = makeRec({ date: '2026-01-05', ...plan });
    invalidRec.trade = { ...invalidRec.trade, status: 'invalid' };
    const base = [closedRec, invalidRec];
    const withPh = [...base, empty, missing];
    const s0 = computeWinRateStats(base, { excludeAnomaly: true }).byStrategy[0];
    const s1 = computeWinRateStats(withPh, { excludeAnomaly: true }).byStrategy[0];
    check(s1.total === s0.total, 'total 不变 (' + s0.total + ' → ' + s1.total + ')');
    check(s1.closed === s0.closed && s1.closed === 1, '胜率有效笔数不变（仅 closed）');
    check(s1.executableRate === s0.executableRate, '买入执行率不变');
    check(s1.anomalyCount === s0.anomalyCount, 'anomalyCount 不变');
    check(s1.ambiguityRate === s0.ambiguityRate, '歧义率不变');
  }
}

function runFullCodeAssertion() {
  section('代码前缀 U1：920 北交所段必须判 bj（修复 sh920xxx 拉取空数组）');
  check(toFullCode('920045') === 'bj920045', '920045 → bj920045');
  check(toFullCode('920378') === 'bj920378', '920378 → bj920378');
  check(toFullCode('920050') === 'bj920050', '920050 → bj920050');
  check(inferMarket('920045') === 'bj', 'inferMarket(920045) = bj');
  check(toFullCode('920000') === 'bj920000', '920000 边界 → bj');

  section('代码前缀 U2：其余市场段保持原有口径（零回归）');
  check(toFullCode('430047') === 'bj430047', '43xxxx → bj（北交所老段）');
  check(toFullCode('830799') === 'bj830799', '83xxxx → bj（北交所老段）');
  check(toFullCode('600000') === 'sh600000', '60xxxx → sh');
  check(toFullCode('688001') === 'sh688001', '688xxx → sh（科创板）');
  check(toFullCode('900001') === 'sh900001', '9 开头非 920（沪 B）仍属 sh，不能误改');
  check(toFullCode('000001') === 'sz000001', '00xxxx → sz');
  check(toFullCode('300750') === 'sz300750', '30xxxx → sz（创业板）');
  check(inferMarket('600000') === 'sh', 'inferMarket(600000) = sh');
  check(inferMarket('000001') === 'sz', 'inferMarket(000001) = sz');
  check(inferMarket('430047') === 'bj', 'inferMarket(430047) = bj');

  section('代码前缀 U3：短代码补零与纯函数性');
  check(toFullCode('45') === 'sz000045', '短代码补零到 6 位');
  check(toFullCode('600000') === toFullCode('600000'), '同输入恒等（无副作用/无随机）');
}

function runEntryPriceHintAssertion() {
  const plan = { buyLow: 10, buyHigh: 10.5, stop: 9, target1: 11, target2: 12 };
  const normalDay = [...HIST, k('2026-01-01', 10.0, 10.4, 9.9, 10.3)]; // 记录日收盘 10.3

  section('尾盘复核价 E1：有 entryPriceHint 时 t_close 按复核价成交');
  {
    const r = makeRec({ date: '2026-01-01', ...plan });
    r.buyTiming = 't_close';
    r.entryPriceHint = 10.2;
    const t = simulateTrade(r, normalDay).trade;
    check(t.status === 'open', '已成交但未平仓 status=open（实际: ' + t.status + '）');
    check(t.buyPrice === 10.2, 'buyPrice=10.2 用复核价（实际: ' + t.buyPrice + '）');
    check(t.buyDate === '2026-01-01', '买入日=记录日');
  }

  section('尾盘复核价 E2：缺 entryPriceHint 时降级用日K收盘价（老数据零回归）');
  {
    const r = makeRec({ date: '2026-01-01', ...plan });
    r.buyTiming = 't_close';
    const t = simulateTrade(r, normalDay).trade;
    check(t.buyPrice === 10.3, 'buyPrice=10.3 用收盘价（实际: ' + t.buyPrice + '）');
  }

  section('尾盘复核价 E3：hint 涨破买入上限 → 兜底判未成交');
  {
    const r = makeRec({ date: '2026-01-01', ...plan });
    r.buyTiming = 't_close';
    r.entryPriceHint = 10.9;
    const t = simulateTrade(r, normalDay).trade;
    check(t.status === 'invalid', 'status=invalid（实际: ' + t.status + '）');
    check(t.anomalies.includes('high_close_unfilled'), 'anomaly=high_close_unfilled（实际: ' + t.anomalies + '）');
    check(t.buyPrice === null, '未成交 buyPrice=null');
  }

  section('尾盘复核价 E4：有 hint 时收盘封板不判「买不进」；无 hint 仍拦截');
  {
    // 记录日收盘=最高、涨幅 10% → 无 hint 时原本会 limit_up_filled_close
    const sealedDay = [...HIST, k('2026-01-01', 10.5, 11.0, 10.4, 11.0)];
    const withHint = makeRec({ date: '2026-01-01', ...plan });
    withHint.buyTiming = 't_close';
    withHint.entryPriceHint = 10.4;
    const t1 = simulateTrade(withHint, sealedDay).trade;
    check(t1.status === 'open', '有 hint → 不被封板拦截（实际: ' + t1.status + '）');
    check(t1.buyPrice === 10.4, '有 hint → 按 10.4 成交（实际: ' + t1.buyPrice + '）');

    const noHint = makeRec({ date: '2026-01-01', ...plan });
    noHint.buyTiming = 't_close';
    const t2 = simulateTrade(noHint, sealedDay).trade;
    check(t2.status === 'invalid', '无 hint → 仍判 invalid（实际: ' + t2.status + '）');
    check(t2.anomalies.includes('limit_up_filled_close'), '无 hint → limit_up_filled_close（实际: ' + t2.anomalies + '）');
  }
}

function runSnapshotCompletenessAssertion() {
  section('快照完整性 F1：源码防回归（完整性判定而非文件存在）');
  const src = fs.readFileSync('server/winrateSnapshot.mjs', 'utf8');
  check(src.includes('export async function isSnapshotComplete'), 'isSnapshotComplete 已导出');
  check(src.includes('available !== false && !x.skipFullSnapshot'),
        '完整性口径 = available!==false && !skipFullSnapshot');
  const backfill = src.slice(
    src.indexOf('export async function triggerSnapshotBackfill'),
    src.indexOf('export function shouldRunSnapshotNow'),
  );
  check(backfill.includes('isSnapshotComplete(date)'), '补跑入口用完整性判定');
  check(!backfill.includes('snapshotExists(date)'), '补跑入口不再用「文件存在」判定');
  check(src.includes('mergeSnapshotForStrategies(date, strategiesOut'),
        '全量落盘走合并写入（保留 14:55 数据）');
}

function runSnapshotCompletenessLogicAssertion() {
  section('快照完整性 F2：部分快照 / 完整快照的纯集合判定');
  // 与 server 侧同口径的纯逻辑镜像：所有必跑战法都出现才算完整。
  const required = ['first-board', 'board-advance', 'trend-break', 'ma-bull', 'dragon',
                    'pullback-buy', 'dragon-return', 'oversold-bounce', 'ultra-short', 'volume-price-up'];
  const partial = ['overnight-hold'];
  const complete = [...partial, ...required];
  const isComplete = (present: string[], req: string[]) => req.every((id) => present.includes(id));
  check(!isComplete(partial, required), '仅隔夜战法 → 不完整，必须补跑');
  check(!isComplete(required, required) === false, '仅 10 个战法（无隔夜）→ 完整');
  check(isComplete(complete, required), '10+1 全覆盖 → 完整，跳过');
  check(!isComplete([], required), '空快照 → 不完整');
}

function runRecordDedupeAssertion() {
  const mk = (date: string, sid: string, code: string, id: string) => ({ id, date, strategyId: sid, code });

  section('记录去重 D1：同一 (日期, 战法, 股票) 只保留一条');
  {
    const dup = [mk('2026-11-16', 'ma-bull', '600000', 'a'), mk('2026-11-16', 'ma-bull', '600000', 'b')];
    const out = dedupeRecords(dup);
    check(out.length === 1, '重复业务键 → 1 条（实际 ' + out.length + '）');
    check(out[0].id === 'a', '保留第一次出现的那条');
    check(recordBusinessKey(dup[0]) === '2026-11-16:ma-bull:600000', '业务键格式 = 日期:战法:股票');
  }

  section('记录去重 D2：不同股票 / 不同战法 / 不同日期都必须保留');
  {
    const multi = [
      mk('2026-11-16', 'ma-bull', '600000', '1'),
      mk('2026-11-16', 'ma-bull', '000001', '2'),
      mk('2026-11-16', 'dragon', '600000', '3'),
      mk('2026-11-15', 'ma-bull', '600000', '4'),
    ];
    check(dedupeRecords(multi).length === 4, '4 条互不相同 → 全部保留');
  }

  section('记录去重 D3：空仓占位 NONE 同天同战法只允许一条');
  {
    const none = [
      mk('2026-11-16', 'overnight-hold', 'NONE', 'x'),
      mk('2026-11-16', 'overnight-hold', 'NONE', 'y'),
      mk('2026-11-16', 'board-advance', 'NONE', 'z'),
    ];
    const out = dedupeRecords(none);
    check(out.length === 2, '同战法 NONE 去重、不同战法保留（实际 ' + out.length + '）');
    check(out[0].id === 'x', '保留第一条 NONE');
    check(recordBusinessKey(none[0]) === '2026-11-16:overnight-hold:NONE', 'NONE 业务键正确');
  }
}

function runIntradayCleanupAssertion() {
  section('盘中洗白 C1：旧歧义标签全部清除，统计口径恢复');
  {
    const old = {
      trade: {
        anomalies: ['data_missing', 'high_close_unfilled', 'suspended_deferred', 'unbuyable'] as WinRateAnomaly[],
      },
    };
    const patch = intradayCleanupFields(old);
    check(patch.excludedFromStats === false, 'excludedFromStats 强制 false（恢复计入分母）');
    check(patch.invalidReason === undefined, 'invalidReason 清空');
    check(patch.ruleVersion === 'v2-t1-fix', 'ruleVersion 升级到 v2-t1-fix（实际 ' + patch.ruleVersion + '）');
    check(Array.isArray(patch.anomalies) && patch.anomalies.length === 0, '歧义/未成交类 anomaly 全清');
  }

  section('盘中洗白 C2：客观事实类 anomaly 保留');
  {
    const old = {
      trade: {
        anomalies: ['new_stock_no_limit_check', 'backfilled', 'param_changed', 'data_missing'] as WinRateAnomaly[],
      },
    };
    const patch = intradayCleanupFields(old);
    check((patch.anomalies || []).length === 3, '保留 3 条事实标注（实际 ' + (patch.anomalies || []).length + '）');
    check((patch.anomalies || []).includes('new_stock_no_limit_check'), '保留次新股规则事实');
    check((patch.anomalies || []).includes('backfilled'), '保留补拉来源事实');
    check(!(patch.anomalies || []).includes('data_missing'), '数据缺失标注被清除');
  }

  section('盘中洗白 C3：干净记录不引入新标签');
  {
    const clean = { trade: { anomalies: ['backfilled'] as WinRateAnomaly[] } };
    const patch = intradayCleanupFields(clean);
    check((patch.anomalies || []).length === 1, '原标注原样保留');
    check(patch.excludedFromStats === false, '统计口径仍为计入');
  }
}

function runPlaceholderLifecycleAssertion() {
  section('空仓生命周期 L1：周五空仓 → 周末与下周一 17:00 前可见，17:00 后隐藏');
  {
    // 2026-11-13 是周五，T+1 交易日为 11-16（周一）
    const fri = makePlaceholderRecord({
      date: '2026-11-13', kind: 'no_signal', strategyId: 'overnight-hold',
      strategyName: '隔夜持股法', priceSource: 'close', backfilled: false,
      recordedAt: '2026-11-13T14:57:00.000Z',
    });
    const expiry = noSignalExpiryAt('2026-11-13');
    check(expiry.getFullYear() === 2026 && expiry.getMonth() === 10 && expiry.getDate() === 16,
          '截止日 = 下周一 11-16（实际 ' + expiry.toDateString() + '）');
    check(expiry.getHours() === 17 && expiry.getMinutes() === 0, '截止时刻 = 17:00');
    check(isRecordedTabVisible(fri, new Date('2026-11-13T15:00:00')), '记录日当天可见');
    check(isRecordedTabVisible(fri, new Date('2026-11-14T10:00:00')), '周六可见');
    check(isRecordedTabVisible(fri, new Date('2026-11-15T10:00:00')), '周日可见');
    check(isRecordedTabVisible(fri, new Date('2026-11-16T16:59:00')), '下周一 16:59 可见');
    check(!isRecordedTabVisible(fri, new Date('2026-11-16T17:01:00')), '下周一 17:01 隐藏');
  }

  section('空仓生命周期 L2：周一~周四按自然日+1；其它占位与普通记录不受限');
  {
    const mon = makePlaceholderRecord({
      date: '2026-11-16', kind: 'no_signal', strategyId: 'trend-break',
      strategyName: '趋势突破', priceSource: 'close', backfilled: false,
      recordedAt: '2026-11-16T09:00:00.000Z',
    });
    check(isRecordedTabVisible(mon, new Date('2026-11-17T16:59:00')), '周二 16:59 可见');
    check(!isRecordedTabVisible(mon, new Date('2026-11-17T17:01:00')), '周二 17:01 隐藏');

    const miss = makePlaceholderRecord({
      date: '2026-01-05', kind: 'snapshot_missing', strategyId: '__snapshot_missing__',
      strategyName: '系统', priceSource: 'close', backfilled: true,
      recordedAt: '2026-01-06T09:00:00.000Z',
    });
    check(isRecordedTabVisible(miss, new Date('2027-01-01T10:00:00')), 'snapshot_missing 不受时间限制');
    const normal = makeRec({ date: '2026-01-01', buyLow: 10, buyHigh: 10.5, stop: 9, target1: 11, target2: 12 });
    check(isRecordedTabVisible(normal, new Date('2027-01-01T10:00:00')), '普通记录不受时间限制');
  }

  section('空仓生命周期 L3：补拉 existingDates 不把占位日算作已完成');
  {
    const ph = makePlaceholderRecord({
      date: '2026-11-16', kind: 'no_signal', strategyId: 'ma-bull',
      strategyName: '均线多头', priceSource: 'close', backfilled: false,
      recordedAt: '2026-11-16T09:00:00.000Z',
    });
    const real = makeRec({ date: '2026-11-15', buyLow: 10, buyHigh: 10.5, stop: 9, target1: 11, target2: 12 });
    const dates = realRecordDates([ph, real]);
    check(!dates.has('2026-11-16'), '仅有 no_signal 的日期不算已有真实记录');
    check(dates.has('2026-11-15'), '有真实记录的日期照常算已有');
    const tbl = fs.readFileSync('src/components/WinRateTradeTable.tsx', 'utf8');
    check(tbl.includes('isRecordedTabVisible'), '表格层已接入生命周期过滤');
    const rec = fs.readFileSync('src/hooks/useWinRateRecorder.ts', 'utf8');
    check(rec.includes('realRecordDates(recordsNow)'), '补拉去重已改用统一纯函数');
  }
}

function runTradeConsistencyAssertion() {
  const baseTrade: TradeRecord = {
    buyDate: '2026-11-17', buyPrice: 10, sellDate: '2026-11-18', sellPrice: 9,
    holdDays: 1, returnPct: -10, sellReason: 'stop_loss', status: 'closed',
    anomalies: [], backfilled: false,
  };

  section('状态一致性 T1：已平仓残留 unfilled 软标记被强制清除');
  {
    const dirty = { ...baseTrade, intradayEntryResolved: 'unfilled' as const };
    check(!isClosedWithSell(dirty) === false, 'sellDate+sellPrice+closed 判为已卖出');
    const fixed = normalizeClosedTrade(dirty);
    check(fixed.status === 'closed', 'status 仍为 closed');
    check(fixed.intradayEntryResolved == null, 'unfilled 软标记已清（实际 ' + fixed.intradayEntryResolved + '）');
    check(!shouldShowIntradayUnfilled(fixed), '不再显示「未成交（待复核）」');
  }

  section('状态一致性 T2：intraday_unfilled anomaly 一并清除');
  {
    const dirty = {
      ...baseTrade,
      intradayEntryResolved: 'unfilled' as const,
      anomalies: ['intraday_unfilled'] as WinRateAnomaly[],
    };
    const fixed = normalizeClosedTrade(dirty);
    check(!(fixed.anomalies || []).includes('intraday_unfilled'), '未成交异常标注已清');
    check(fixed.intradayEntryResolved == null, '软标记已清');
  }

  section('状态一致性 T3：尚未平仓的 unfilled 软标记保持有效');
  {
    const open = {
      ...baseTrade, status: 'open' as const, sellDate: null, sellPrice: null,
      returnPct: null, intradayEntryResolved: 'unfilled' as const,
    };
    check(shouldShowIntradayUnfilled(open), 'open + unfilled 仍显示待复核');
    check(normalizeClosedTrade(open).intradayEntryResolved === 'unfilled', '无卖出证据不被归一化改写');
  }

  section('状态一致性 T4：干净已平仓记录不被改写（引用稳定）');
  {
    const clean = { ...baseTrade, intradayEntryResolved: null };
    const fixed = normalizeClosedTrade(clean);
    check(fixed === clean, '干净记录原对象返回，零副作用');
    check(isClosedWithSell(fixed), '已卖出判定为真');
  }
}

function runFloatingReturnAssertion() {
  section('浮动收益率 FLOAT：买入 10 元 / 现价 11 元 = +10%');
  {
    const r = floatingReturnPct(10, 11);
    check(r === 10, '收益率 = 10（实际 ' + r + '）');
    check(floatingReturnPct(10, 9) === -10, '亏损场景 = -10');
    check(floatingReturnPct(10, 10) === 0, '持平 = 0');
  }

  section('浮动收益率 FLOAT：数据缺失/非法价格回退 null（UI 显示 —）');
  {
    check(floatingReturnPct(10, null) === null, '无现价 → null');
    check(floatingReturnPct(null, 11) === null, '无买入价 → null');
    check(floatingReturnPct(0, 11) === null, '买入价为 0 → null（不伪造无穷大）');
    check(floatingReturnPct(10, Number.NaN) === null, 'NaN → null');
  }
}

function runPaginationAssertion() {
  section('分页 PAGE：默认每页 100 条且最新记录在首页');
  {
    const all = Array.from({ length: 235 }, (_, i) => i);
    const p1 = paginate(all, 1, 100);
    check(p1.rows.length === 100, '第 1 页 100 条（实际 ' + p1.rows.length + '）');
    check(p1.rows[0] === 0, '按传入顺序切片：最新记录在首页首位');
    check(p1.totalPages === 3 && p1.total === 235, '3 页 / 共 235 条');
    const p3 = paginate(all, 3, 100);
    check(p3.rows.length === 35, '末页 35 条（实际 ' + p3.rows.length + '）');
  }

  section('分页 PAGE：50 / 全部 / 页码越界 clamp');
  {
    const all = Array.from({ length: 120 }, (_, i) => i);
    const p50 = paginate(all, 2, 50);
    check(p50.rows.length === 50 && p50.rows[0] === 50, '每页 50：第 2 页从 50 开始');
    check(p50.totalPages === 3, '共 3 页');
    const allRows = paginate(all, 2, 0);
    check(allRows.rows.length === 120 && allRows.page === 1 && allRows.totalPages === 1,
          '「全部」不切片且页码归一为 1');
    const over = paginate(all, 99, 50);
    check(over.page === 3, '请求第 99 页 → clamp 到第 3 页（实际 ' + over.page + '）');
    const none = paginate([], 1, 100);
    check(none.totalPages === 1 && none.rows.length === 0, '空列表仍为 1 页 0 条');
  }
}

function runPaginationComponentAssertion() {
  section('分页组件 P1：上下两处实例共用同一套状态与组件');
  {
    const table = fs.readFileSync('src/components/WinRateTradeTable.tsx', 'utf8');
    const pagination = fs.readFileSync(
      path.join('src', 'components', 'Pagination.tsx'), 'utf8',
    );
    check(pagination.includes('export function Pagination'), '分页器已提取为独立组件');
    check((table.match(/<Pagination/g) || []).length === 2, '表格内恰好两处实例（上/下各一）');
    check((table.match(/from '.\/Pagination'/g) || []).length === 1, '只 import 一次，无重复 JSX');
    check((table.match(/page=\{pageSlice\.page\}/g) || []).length === 2,
          '两处传入同一个 pageSlice.page（状态同步）');
    check((table.match(/pageSize=\{pageSize\}/g) || []).length === 2,
          '两处传入同一个 pageSize（下拉同步）');
    check(table.includes('variant="inline"') && table.includes('variant="bottom"'),
          '上方 inline + 下方 bottom 两种布局');
  }
}

function runToolbarFilterAssertion() {
  const rows = [
    { code: '600519', name: '贵州茅台', strategyId: 'first-board', date: '2026-11-19' },
    { code: '000858', name: '五粮液', strategyId: 'trend-break', date: '2026-11-19' },
    { code: '300528', name: '幸福蓝海', strategyId: 'first-board', date: '2026-11-18' },
  ];
  const empty = { keyword: '', strategyId: '', date: '' };

  section('工具栏筛选 Q1：股票代码/名称模糊匹配');
  {
    check(filterByToolbar(rows, { ...empty, keyword: '茅台' }).length === 1, '关键词「茅台」→ 1 条');
    check(filterByToolbar(rows, { ...empty, keyword: '600519' })[0]?.name === '贵州茅台', '代码精确片段命中');
    check(filterByToolbar(rows, { ...empty, keyword: '茅' }).length === 1, '单字模糊命中');
    check(filterByToolbar(rows, { ...empty, keyword: '不存在' }).length === 0, '无匹配 → 0 条');
  }

  section('工具栏筛选 Q2：战法与单日日期');
  {
    check(filterByToolbar(rows, { ...empty, strategyId: 'first-board' }).length === 2, '战法筛选 → 2 条');
    check(filterByToolbar(rows, { ...empty, date: '2026-11-19' }).length === 2, '日期筛选 → 2 条');
    check(filterByToolbar(rows, { ...empty, strategyId: 'first-board', date: '2026-11-18' }).length === 1,
          '战法+日期叠加 → 1 条');
  }

  section('工具栏筛选 Q3：清空筛选恢复全部');
  {
    check(filterByToolbar(rows, empty).length === 3, '空条件 → 全部 3 条');
    check(matchesToolbarFilters(rows[0], empty), '单条判定：空条件放行');
    const table = fs.readFileSync('src/components/WinRateTradeTable.tsx', 'utf8');
    check(table.includes('searchKeyword') && table.includes('filterStrategy') && table.includes('filterDate'),
          '三个条件均已接入表格状态');
    check(table.includes('[statusFilter, pageSize, searchKeyword, filterStrategy, filterDate]'),
          '筛选变化时分页重置到第 1 页');
  }
}

function runIntradayVolumeColorAssertion() {
  section('分时量柱 V1：涨红跌绿，持平按涨处理');
  {
    check(intradayVolumeColor(11, 10) === '#DC2626', '11 >= 10 → 红');
    check(intradayVolumeColor(10, 10) === '#DC2626', '10 >= 10（持平）→ 红，不再落灰');
    check(intradayVolumeColor(9, 10) === '#16A34A', '9 < 10 → 绿');
  }

  section('分时量柱 V2：基准缺失不落灰');
  {
    check(intradayVolumeColor(10, null) === '#DC2626', '无昨收/无上一分钟 → 红');
    check(intradayVolumeColor(10, undefined) === '#DC2626', 'undefined 基准 → 红');
    check(intradayVolumeColor(10, Number.NaN) === '#DC2626', '非法基准 → 红');
  }

  section('分时量柱 V3：色盲模式暖冷色 + 渲染层已接入');
  {
    setColorBlindMode(true);
    check(intradayVolumeColor(11, 10) === '#F59E0B', '色盲模式涨 → 暖色');
    check(intradayVolumeColor(9, 10) === '#3B82F6', '色盲模式跌 → 冷色');
    setColorBlindMode(false);
    const chart = fs.readFileSync('src/components/KlineChart.tsx', 'utf8');
    check(chart.includes('intradayVolumeColor(p, lastValidPrice ?? prevClose)'),
          '量柱渲染改用上一分钟有效价判色');
    check(!chart.includes('changeColor(prevClose != null ? (price[s] as number) - prevClose : 0)'),
          '旧的「相对昨收 + changeColor(0)」判色已移除');
  }
}

function runMarketFallbackAssertion() {
  section('大盘兜底 M1：底层报错不暴露给用户');
  {
    check(friendlyMarketError('ValueError: No tables found') === MARKET_FETCH_FAILED_TEXT, 'No tables found → 友好文案');
    check(friendlyMarketError('ConnectionError: remote closed') === MARKET_FETCH_FAILED_TEXT, '连接失败 → 友好文案');
    check(friendlyMarketError('Traceback ...') === MARKET_FETCH_FAILED_TEXT, '堆栈 → 友好文案');
    check(friendlyMarketError(null) === MARKET_FETCH_FAILED_TEXT, '无原因 → 友好文案');
  }
  section('大盘兜底 M2：全市场快照统计涨跌家数');
  {
    const b = countBreadth([{ changePct: 3.2 }, { changePct: -1.5 }, { changePct: 0 }, { changePct: null }, { changePct: Number.NaN }]);
    check(b?.up === 1 && b?.down === 1 && b?.flat === 1, '涨1跌1平1，无效价忽略');
    check(countBreadth([]) === null, '空快照 → null，不伪造 0');
    check(countBreadth([{ changePct: null }]) === null, '全无效 → null');
  }
  section('大盘兜底 M3：stale 回退判定');
  {
    check(canUseStale(false, 1000, 60000), '拉取失败且有旧快照 → 可用 stale');
    check(!canUseStale(true, 1000, 60000), '拉取成功 → 不用 stale');
    check(!canUseStale(false, null, 60000), '无旧快照 → 不用 stale');
    const page = fs.readFileSync('src/components/MarketOverview.tsx', 'utf8');
    check(page.includes('MARKET_STALE_TEXT'), '前端已显示「数据有延迟」');
    const srv = fs.readFileSync('server/index.mjs', 'utf8');
    check(srv.includes("sidecar('/market/spot')"), '后端已接入全市场快照备源');
    check(srv.includes("staleMarketSnapshot('market-stats')"), '涨跌家数失败回退 stale');
    check(srv.includes("staleMarketSnapshot('turnover')"), '成交额失败回退 stale');
  }
}

function runPrevCloseAssertion() {
  section('昨收基准 P1：跌停票按真实昨收算出 -10%');
  {
    const c = calcPrevChange(11.17, 12.41);
    check(c != null && c.change === -1.24, '涨跌额 -1.24（实际 ' + c?.change + '）');
    check(c != null && Math.abs(c.changePct - (-9.99)) < 0.02, '涨跌幅约 -9.99%（实际 ' + c?.changePct + '）');
  }

  section('昨收基准 P2：来源优先级（日K > quote），污染值不参与');
  {
    check(resolvePrevClose(12.41, 11.17) === 12.41, '日K基准优先于被污染的 quote.prevClose');
    check(resolvePrevClose(null, 12.41) === 12.41, '日K缺失时用实时 quote 基准');
    check(resolvePrevClose(null, null) === null, '两路都缺 → null，不拿当前价凑数');
    check(resolvePrevClose(0, -1, Number.NaN, 12.41) === 12.41, '非法候选全跳过');
    check(!isUsablePrevClose(0) && !isUsablePrevClose(Number.NaN), '0 / NaN 不是可用昨收');
  }

  section('昨收基准 P3：缺基准时不显示 0.00%，UI 与渲染层已接入');
  {
    check(calcPrevChange(11.17, null) === null, '无基准 → null，UI 显示「无基准价」');
    check(calcPrevChange(null, 12.41) === null, '无现价 → null');
    check(firstValidPrice([null, 11.2, 11.17]) === 11.2, '分时首根有效价仅用于纵轴范围');
    const page = fs.readFileSync('src/components/StockDetail.tsx', 'utf8');
    check(page.includes('liveQuoteResp'), '详情页自拉实时行情');
    check(page.includes("marketApi.kline(fullCode, 'day', 'none', 3)"), '日K倒数第二根兜底');
    check(page.includes('prevClose={effectivePrevClose}'), '图表使用有效基准');
    check(page.includes('无基准价'), '缺基准时显式提示');
  }
}

function runT1AndPlanAssertion() {
  section('T+1 硬锁 T1：同日买卖绝对拒绝');
  {
    check(isSameDayClose('2026-11-18', '2026-11-18'), '11-18 买 11-18 卖 → 违规');
    check(!isSameDayClose('2026-11-18', '2026-11-19'), '隔日买卖合法');
    check(!isSameDayClose(null, '2026-11-18'), '无买入日不算违规');
    const open = { date: '2026-11-17', trade: { status: 'open' as const, buyDate: '2026-11-18' } } as WinRateRecord;
    check(!canSellToday(open, '2026-11-18'), '买入当日禁止卖出');
    check(!canSellToday(open, '2026-11-17'), '记录日早于买入日禁止卖出');
  }

  section('计划完整性 T2：残缺/倒挂计划不可交易');
  {
    check(!isPlanTradable({ buyLow: null, buyHigh: 12.09, stop: null, target1: null, target2: 11.79 }),
          '截图中的残缺计划直接拒绝');
    check(!isPlanTradable({ buyLow: 11.8, buyHigh: 12.09, stop: 11.5, target1: 12, target2: 11.79 }),
          '目标二低于买入上限 → 倒挂拒绝');
    check(isPlanTradable({ buyLow: 11.8, buyHigh: 12.09, stop: 11.5, target1: 12.8, target2: 13.5 }),
          '完整且目标递增的计划放行');
  }

  section('T+1 硬锁 T3：三层防御已落到代码');
  {
    const mon = fs.readFileSync('src/hooks/useIntradayMonitor.ts', 'utf8');
    check(mon.includes('const dayBars = sliceDayBars(bars, today);'), '卖出端只用当日 bar');
    check(mon.includes('isSameDayClose(r.trade.buyDate, trigger.barDate.slice(0, 10))'), '卖出前硬拦截同日');
    check(mon.includes('isPlanTradable('), '买入前拦截残缺计划');
    const trig = fs.readFileSync('src/lib/intraday-trigger.ts', 'utf8');
    check(trig.includes('): WinRateTradePatch | null {'), '平仓补丁可返回 null 拒绝');
    const store = fs.readFileSync('src/hooks/useWinRateStore.ts', 'utf8');
    check(store.includes('t_plus_1_violation'), '存量脏数据自动标 T+1 违规');
    const win = fs.readFileSync('src/domain/winrate.ts', 'utf8');
    check(win.includes('nextTradingDateGuess(buyDate)'), 'tPlus1SellDate 缺失时用下一交易日兜底');
  }
}

function runBuyRangeLabelAssertion() {
  section('买入区间 B1：正常区间原样展示');
  {
    const r = describeBuyRange({ buyLow: 12, buyHigh: 12.24, buyBasis: '现价 ±1%' });
    check(r.text === '12~12.24' && r.tone === 'normal', '区间文案正常（实际 ' + r.text + '）');
  }

  section('买入区间 B2：涨停封板给出明确文案与告警色');
  {
    const r = describeBuyRange({
      buyLow: null, buyHigh: null,
      buyBlockedByLimitUp: true,
      buyBasis: '涨停不可买入（止损与目标以现价为参考，供次日使用）',
    });
    check(r.text === '当日封板涨停，无法买入', '文案 = 当日封板涨停，无法买入');
    check(r.tone === 'warn', 'tone=warn，UI 用橙黄色');
  }

  section('买入区间 B3：其他缺失原因不显示裸破折号');
  {
    const none = describeBuyRange({ buyLow: null, buyBasis: '未命中任何可用战法，不给出买入区间' });
    check(none.text === '未命中可用战法，未生成区间', '未命中战法 → 明确文案');
    const miss = describeBuyRange({ buyLow: null, buyBasis: 'MA10 缺失，无法给出低吸区间', missing: ['MA10'] });
    check(miss.text === '数据拉取失败，未生成区间', '数据缺失 → 明确文案');
    check(miss.tone === 'warn', '均为告警色');
    const modal = fs.readFileSync('src/components/WinRateTradeDetailModal.tsx', 'utf8');
    check(modal.includes('describeBuyRange('), '详情弹窗已接入统一口径');
    const snap = fs.readFileSync('server/winrateSnapshot.mjs', 'utf8');
    check(snap.includes('buyBlockedByLimitUp: hit.tradePlan?.buyBlockedByLimitUp === true'),
          '后端已透传涨停标识');
  }
}

function runPlanHardGateAssertion() {
  section('计划死规矩 G1：buyLow/stop 缺失一律不可交易');
  {
    check(isPlanIncomplete({ buyLow: null, stop: 3.5 }), 'buyLow 为空 → 残缺');
    check(isPlanIncomplete({ buyLow: 11.8, stop: null }), 'stop 为空 → 残缺');
    check(isPlanIncomplete({ buyLow: 11.8, stop: 0 }), 'stop=0 → 残缺');
    check(!isPlanIncomplete({ buyLow: 11.8, stop: 11.2 }), '两者有效 → 完整');
  }

  section('计划死规矩 G2：已买入 + 残缺 → 强制标异常');
  {
    check(isMissingPlanAnomaly({ buyLow: null, stop: null, buyPrice: 3.68 }),
          '600408 那种已买入但计划全空 → 异常');
    check(!isMissingPlanAnomaly({ buyLow: null, stop: null, buyPrice: null }),
          '未买入的占位记录不算异常');
  }

  section('计划死规矩 G3：三处硬拦截均已落到代码');
  {
    const minute = fs.readFileSync('src/lib/winrate-minute.ts', 'utf8');
    check(minute.includes("if (plan.buyLow == null || plan.stop == null") , 'evaluateIntradayEntry 死规矩');
    const monitor = fs.readFileSync('src/hooks/useIntradayMonitor.ts', 'utf8');
    check(monitor.includes("dec.kind === 'invalid'"), '监控层处理 invalid 决策');
    const rec = fs.readFileSync('src/hooks/useWinRateRecorder.ts', 'utf8');
    check(rec.includes('planIncomplete && trade.buyPrice != null'), 'settleOpenRecords 死规矩');
    const store = fs.readFileSync('src/hooks/useWinRateStore.ts', 'utf8');
    check(store.includes('isMissingPlanAnomaly('), '存量加载清洗');
    const tp = fs.readFileSync('server/strategies/tradeplan.mjs', 'utf8');
    check(tp.includes('ind.dragon?.prevLimitBase ?? ind.prevLimitBase'),
          '龙回头字段路径已治本');
  }
}

function runBoardHeatAssertion() {
  section('热力图 H1：六档颜色边界（红涨绿跌）');
  {
    check(heatColor(3.01).level === 'strong-up', '>3% 深红');
    check(heatColor(3).level === 'up', '=3% 中红');
    check(heatColor(1).level === 'up', '=1% 中红');
    check(heatColor(0.5).level === 'light-up', '0~1% 浅红');
    check(heatColor(0).level === 'flat' && heatColor(0).background === '#9CA3AF',
          '=0.00% 中性灰（禁止落浅绿档）');
    check(heatColor(0.01).level === 'light-up', '+0.01% 浅红');
    check(heatColor(-0.01).level === 'light-down', '-0.01% 浅绿');
    check(heatColor(1).level === 'up' && heatColor(1.01).level === 'up', '±1.00 边界');
    check(heatColor(-1).level === 'light-down' && heatColor(-1.01).level === 'down', '-1.00 边界');
    check(heatColor(3).level === 'up' && heatColor(3.01).level === 'strong-up', '+3.00 边界');
    check(heatColor(-3).level === 'down' && heatColor(-3.01).level === 'strong-down', '-3.00 边界');
    check(heatColor(-1).level === 'light-down', '=-1% 浅绿（左闭右开）');
    check(heatColor(-3).level === 'down', '=-3% 中绿');
    check(heatColor(-3.01).level === 'strong-down', '<-3% 深绿');
    check(heatColor(null).level === 'flat', '缺失 → 中性灰');
    check(heatColor(4).foreground === '#FFFFFF', '深底白字');
    check(heatColor(0.5).foreground === '#7F1D1D', '浅底深字');
  }

  section('热力图 H2：Squarified Treemap 面积守恒、无缝、无重叠');
  {
    const boards = [
      { key: 'a', amount: 9_000_000_000 },
      { key: 'b', amount: 4_000_000_000 },
      { key: 'c', amount: 2_000_000_000 },
      { key: 'd', amount: 1_000_000_000 },
      { key: 'e', amount: 500_000_000 },
      { key: 'f', amount: null },
    ];
    const W = 1200, H = 540;
    const cells = calculateTreemap(boards, W, H);
    check(cells.length === boards.length, '每个板块都有坐标');
    const area = cells.reduce((s, c) => s + c.rect.width * c.rect.height, 0);
    check(Math.abs(area - W * H) / (W * H) < 0.0001,
          '面积严格守恒（误差 <0.01%，实际 ' + ((area / (W * H) * 100).toFixed(3)) + '%）');
    let overlap = false;
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i].rect, b = cells[j].rect;
        const ix = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
        const iy = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
        if (ix > 0.01 && iy > 0.01) overlap = true;
      }
    }
    check(!overlap, '任意两色块不重叠');
    const inBounds = cells.every((c) => c.rect.left >= -0.01 && c.rect.top >= -0.01 &&
      c.rect.left + c.rect.width <= W + 0.01 && c.rect.top + c.rect.height <= H + 0.01);
    check(inBounds, '全部色块落在容器边界内');
  }

  section('热力图 H3：接近正方形 + 成交额权重正确 + 渲染层已接入');
  {
    const boards = Array.from({ length: 20 }, (_, i) => ({ key: 'k' + i, amount: (20 - i) * 1e8 }));
    const cells = calculateTreemap(boards, 1200, 540);
    const aspects = cells.map((c) => Math.max(c.rect.width / c.rect.height, c.rect.height / c.rect.width));
    const avg = aspects.reduce((a, b) => a + b, 0) / aspects.length;
    check(avg < 3.5, '平均长宽比接近 1（实际 ' + avg.toFixed(2) + '）');
    const big = cells.find((c) => c.key === 'k0')!;
    const small = cells.find((c) => c.key === 'k19')!;
    check(big.rect.width * big.rect.height > small.rect.width * small.rect.height * 10,
          '高成交额板块面积显著大于低成交额（相对地板下阈值放宽）');
    check(calculateTreemap([], 1200, 540).length === 0, '空列表返回空数组');
    const extreme = calculateTreemap([
      { key: 'huge', amount: 9_300_000_000 },
      { key: 'tiny', amount: 1_000_000 },
      { key: 'zero', amount: 0 },
    ], 1200, 540);
    const minArea = Math.min(...extreme.map((c) => c.rect.width * c.rect.height));
    check(minArea > 1000, '零成交额板块保住可读面积（实际 ' + minArea.toFixed(0) + 'px²）');
    const page = fs.readFileSync('src/components/BoardPage.tsx', 'utf8');
    check(page.includes('ResizeObserver'), '容器尺寸变化会重算');
    check(page.includes('position: absolute') === false || page.includes('left: cell.rect.left'),
          '色块用绝对坐标定位');
    check(page.includes('calculateTreemap('), '渲染层使用 treemap 算法');
  }


  section('热力图 H5：涨跌幅权重按方向映射 + 地板保护 + 面积守恒');
  {
    const boards = [
      { key: 'surge', amount: 100_000_000, changePct: 5.0 },
      { key: 'flat', amount: 8_000_000_000, changePct: 0 },
      { key: 'crash', amount: 200_000_000, changePct: -6.0 },
      { key: 'mild', amount: 500_000_000, changePct: -0.5 },
    ];
    const W = 1200, H = 540;
    const desc = calculateTreemap(boards, W, H, 'pct_desc');
    const asc = calculateTreemap(boards, W, H, 'pct_asc');
    const area = (cells: typeof desc, key: string) => {
      const c = cells.find((x) => x.key === key)!;
      return c.rect.width * c.rect.height;
    };
    check(area(desc, 'surge') > area(desc, 'flat') && area(desc, 'surge') > area(desc, 'crash'),
          '降序权重：涨幅+5% 面积第一');
    check(area(desc, 'crash') < area(desc, 'mild'),
          '降序权重：跌幅-6% 比 -0.5% 更小');
    check(area(asc, 'crash') > area(asc, 'flat') && area(asc, 'crash') > area(asc, 'surge'),
          '升序权重：跌幅-6% 面积第一');
    check(area(asc, 'surge') < area(asc, 'mild'),
          '升序权重：涨幅+5% 比 -0.5% 更小');
    check(area(desc, 'crash') > 100 && area(asc, 'surge') > 100,
          '两端极值都有 1% 地板保住的可点击面积');
    const sum = (cells: typeof desc) => cells.reduce((t, c) => t + c.rect.width * c.rect.height, 0);
    check(Math.abs(sum(desc) - W * H) / (W * H) < 0.0001 &&
          Math.abs(sum(asc) - W * H) / (W * H) < 0.0001,
          '两种方向面积均 100% 守恒');
    const page = fs.readFileSync('src/components/BoardPage.tsx', 'utf8');
    check(page.includes(": desc ? 'amount' : 'amount_asc'"), 'desc 标志正确传入权重模式');
    check(page.includes('[heatRows, heatSize, sort, desc]'), 'desc 变化触发重算');
  }

  section('热力图 H4：输入顺序=用户排序口径，面积仍由成交额决定');
  {
    const boards = [
      { key: 'small', amount: 100_000_000 },
      { key: 'big', amount: 9_000_000_000 },
      { key: 'mid', amount: 3_000_000_000 },
    ];
    const cells = calculateTreemap(boards, 1200, 540);
    check(cells.map((c) => c.key).join(',') === 'small,big,mid',
          '输出顺序严格等于输入顺序（不再内部按权重重排）');
    const area = (k: string) => {
      const c = cells.find((x) => x.key === k)!;
      return c.rect.width * c.rect.height;
    };
    check(area('big') > area('mid') && area('mid') > area('small'),
          '面积依然严格按成交额：big > mid > small');
    const heat = fs.readFileSync('src/lib/board-heat.ts', 'utf8');
    check(!heat.includes('items.sort('), '算法内部没有覆盖外部顺序的硬编码排序');
    const page = fs.readFileSync('src/components/BoardPage.tsx', 'utf8');
    check(page.includes('[heatRows, heatSize'), '排序变化经 rows → cells 依赖链触发重算');
  }
}


function runCloseout2Assertion() {
  section('收口2 G1：成交额升序权重随方向反转（max-amount+1）');
  {
    const boards = [
      { key: 'big', amount: 9_000_000_000, changePct: 1 },
      { key: 'mid', amount: 3_000_000_000, changePct: 0 },
      { key: 'small', amount: 100_000_000, changePct: -1 },
    ];
    const W = 1200, H = 540;
    const d = calculateTreemap(boards, W, H, 'amount');
    const a = calculateTreemap([...boards].reverse(), W, H, 'amount_asc');
    const area = (cells: typeof d, k: string) => {
      const c = cells.find((x) => x.key === k)!;
      return c.rect.width * c.rect.height;
    };
    check(area(d, 'big') > area(d, 'small'), '降序：大成交额块 > 小成交额块');
    check(area(a, 'small') > area(a, 'big'), '升序：小成交额块 > 大成交额块');
    const monotone = (cells: typeof d) => {
      const xs = cells.map((c) => c.rect.width * c.rect.height);
      for (let i = 1; i < xs.length; i++) if (xs[i] > xs[i - 1] * 1.005) return false;
      return true;
    };
    check(monotone(d) && monotone(a), '成交额两个方向面积均单调不增');
  }

  section('收口2 G2：无数据板块排除 + 像素地板');
  {
    check(isBoardDataMissing({ amount: 0 }), 'amount=0 判为无数据');
    check(isBoardDataMissing({ amount: null }), 'amount=null 判为无数据');
    check(!isBoardDataMissing({ amount: 1 }), '正成交额判为有效');
    const boards = Array.from({ length: 80 }, (_, i) => ({
      key: 'k' + i,
      amount: i === 0 ? 30_000_000_000 : (81 - i) * 5_000_000,
      changePct: 1 - i * 0.05,
    }));
    const cells = calculateTreemap(boards, 1200, 540, 'amount');
    const minShort = Math.min(...cells.map((c) => Math.min(c.rect.width, c.rect.height)));
    const floor = heatFloor(1200, 540, boards.length);
    check(Number.isFinite(floor) && floor > 0, '地板为有限正数（相对口径，不再保证绝对短边36px）');
    check(minShort > 0, '短边为正（实际最小 ' + minShort.toFixed(1) + 'px）');
    check(cells.every((c) => c.rect.width > 0 && c.rect.height > 0), '无 0 面积');
  }
}


function runAdaptiveAssertion() {
  section('自适应 K1：n 口径与相对地板');
  {
    check(Math.abs(heatFloor(1200, 540, 31) - 2508) < 2, '31 块地板≈2508px²');
    check(Math.abs(heatFloor(1200, 540, 84) - 925) < 2, '84 块地板≈925px²');
    check(Math.abs(heatFloor(1200, 540, 172) - 452) < 2, '172 块地板≈452px²');
    check(heatFloor(1200, 540, 172) < heatFloor(1200, 540, 31), '地板随 n 反向缩放');
    const heat = fs.readFileSync('src/lib/board-heat.ts', 'utf8');
    check(heat.includes('n = boards.length（调用方已排除无数据板块）'), 'n 口径注释已落');
  }

  section('自适应 K2：文字分级相对阈值 + 已知缺陷锁定');
  {
    // avgArea(84)=7714, avgArea(172)=3767（area 口径）
    check(textLevel({ width: 90, height: 90 }, 84, 1200, 540) === 0, '8100px² → L0');
    check(textLevel({ width: 60, height: 40 }, 172, 1200, 540) === 1, '2400px² → L1');
    check(textLevel({ width: 25, height: 18 }, 172, 1200, 540) === 2, '450px² → L2');
    check(heatFloor(1200, 540, 0) === 0, 'n=0 → 地板0');
    const heat = fs.readFileSync('src/lib/board-heat.ts', 'utf8');
    check(heat.includes('已知缺陷，暂不修'), '领涨股面积口径已知缺陷已注释');
  }
}


function runShapeAssertion() {
  section('形状 S1：纯 squarify 满足 max aspect ≤8 且最小短边 ≥12px');
  {
    const boards = Array.from({ length: 84 }, (_, i) => ({
      key: 'k' + i,
      amount: (84 - i) * 100_000_000,
      changePct: 2 - i * 0.08,
    }));
    const cells = calculateTreemap(boards, 1200, 540, 'pct_desc');
    const maxAspect = Math.max(...cells.map((c) =>
      Math.max(c.rect.width / c.rect.height, c.rect.height / c.rect.width)));
    const minShort = Math.min(...cells.map((c) => Math.min(c.rect.width, c.rect.height)));
    check(maxAspect <= 8, 'max aspect ≤8（实际 ' + maxAspect.toFixed(2) + '）');
    check(minShort >= 12, '最小短边 ≥12px（实际 ' + minShort.toFixed(1) + 'px）');
    const heat = fs.readFileSync('src/lib/board-heat.ts', 'utf8');
    check(!heat.includes('worstAspect([...row, queue[0]], scale, shortSide) <= 4'),
          '元凶约束 worstAspect<=4 已移除');
  }
}

function runWatchButtonAssertion() {
  section('自选按钮 W1：单一数据源与幂等');
  {
    const app = fs.readFileSync('src/App.tsx', 'utf8');
    const detail = fs.readFileSync('src/components/StockDetail.tsx', 'utf8');
    const hook = fs.readFileSync('src/hooks/useWatchList.ts', 'utf8');
    check(!detail.includes('= useWatchList()') && detail.includes('import type { useWatchList }'), '详情页只做类型导入，不自建 hook 实例');
    check(app.includes('watchList={wl}'), 'App 传入同一 useWatchList 实例');
    check(detail.includes('watchList.fullCodes.includes(fullCode)'), '状态从 fullCodes 派生');
    check(detail.includes('watchList.restoreAt(item, watchIndex)'), '撤销恢复原索引');
    check(hook.includes('[{ code, fullCode: full, name, addedAt: Date.now() }, ...prev]'), '新加入排最前');
    check(hook.includes('prev.some((i) => i.code === code)'), '按 code 去重幂等');
    check(detail.includes("onToast('本地存储不可用，未保存')"), 'storageOk=false 不静默失败');
  }
  section('自选按钮 W2：四档布局与价格口径');
  {
    const detail = fs.readFileSync('src/components/StockDetail.tsx', 'utf8');
    const css = fs.readFileSync('src/styles/global.css', 'utf8');
    const chart = fs.readFileSync('src/components/KlineChart.tsx', 'utf8');
    check(detail.includes("width >= 560 ? 'dh-w0' : width >= 440 ? 'dh-w1' : width >= 380 ? 'dh-w2' : 'dh-w3'"), '面板宽度切四档');
    check(css.includes('min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;'), '名称 min-width:0 + ellipsis');
    check(css.includes('.drawer-head .price,\n.drawer-head .pct,\n.drawer-head .btn,\n.drawer-head .watch-btn { flex-shrink: 0; }'), '价格/按钮不收缩');
    check(css.includes('.dh-w2 .watch-label, .dh-w3 .watch-label { display: none; }'), '窄宽度仅星标');
    check(detail.includes('aria-label={watched ?'), '星标保留 aria-label');
    check(!chart.includes('formatChange(view.intradayHead.changeVal)'), '图表浮标不再重复涨跌');
    check(!detail.includes('区间统计：') || !detail.includes('根，涨跌'), '区间统计不再重复涨跌');
  }
}
function stripCodeNoise(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/'[^']*'/g, "''").replace(/`[^`]*`/g, '``'))
    .join('\n');
}

function runStatsLineAssertion() {
  section('统计文案 S1：分时涨跌取头部口径，不取分钟线');
  {
    const s = { days: 240, changePct: 15.59, high: 10.9, low: 10.11, volume: 1280411 };
    const line = formatStatsLine(s, true, -3.21);
    check(line.includes('-3.21%'), '分时文案包含头部口径 -3.21%（实际 ' + line + '）');
    check(!line.includes('15.59'), '分时文案不得包含分钟线 changePct 15.59');
    const klineLine = formatStatsLine(s, false, -3.21);
    check(klineLine.includes('15.59'), 'K线模式仍用自身 changePct');
  }
  section('统计文案 S2：KlineChart 源码静态检查（先剔注释与字符串）');
  {
    const raw = fs.readFileSync('src/components/KlineChart.tsx', 'utf8');
    const code = stripCodeNoise(raw);
    check(!code.includes('formatPct(view.stats.changePct)'), '源码不再直拼 view.stats.changePct');
    check(/formatStatsLine\s*\(/.test(code), '源码调用 formatStatsLine');
    check(!code.includes('view.intradayHead.price'), 'intradayHead 渲染块已移除');
  }
}
// ───────── 入口 ─────────
async function main() {
  console.log('战法胜率 v2-t1-fix 增量修复 · 离线验收');
  console.log(`TRADE_RULE_VERSION = ${TRADE_RULE_VERSION}`);
  runCases();
  runStatsAssertion();
  runHelperAssertion();
  runBuyTimingAssertion();
  runRecordedCategoryAssertion();
  runSettleGuardAssertion();
  runExecutionRateAssertion();
  runInvalidDateAssertion();
  runHybridBuyTimingAssertion();
  runDynamicRulesAssertion();
  await runMinuteAssertions();
  runMinuteStatsAssertion();
  runEntryEngineAssertion();
  runPlaceholderAssertion();
  runFullCodeAssertion();
  runEntryPriceHintAssertion();
  runSnapshotCompletenessAssertion();
  runSnapshotCompletenessLogicAssertion();
  runRecordDedupeAssertion();
  runIntradayCleanupAssertion();
  runPlaceholderLifecycleAssertion();
  runTradeConsistencyAssertion();
  runFloatingReturnAssertion();
  runPaginationAssertion();
  runPaginationComponentAssertion();
  runToolbarFilterAssertion();
  runIntradayVolumeColorAssertion();
  runMarketFallbackAssertion();
  runPrevCloseAssertion();
  runT1AndPlanAssertion();
  runBuyRangeLabelAssertion();
  runPlanHardGateAssertion();
  runBoardHeatAssertion();
  runFinalCloseoutAssertion();
  runCloseout2Assertion();
  runAdaptiveAssertion();
  runShapeAssertion();
  runWatchButtonAssertion();
  runStatsLineAssertion();

  console.log(`\n──────── 结果 ────────`);
  console.log(`通过 ${passed} / ${passed + failed}`);
  if (failed > 0) {
    console.log(`失败 ${failed} 条：`);
    fails.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  } else {
    console.log('全部通过 ✅');
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

function runFinalCloseoutAssertion() {
  section('收口 F1：主次指标随排序口径切换');
  {
    const b = { changePct: 1.04, amount: 3_483_000_000, leadName: '某某股', leadChangePct: 5.2 };
    check(primaryMetric(b, 'changePct').text === '+1.04%', '涨跌幅排序 → 主=涨跌幅');
    check(secondaryMetric(b, 'changePct').kind === 'lead', '涨跌幅排序 → 次=领涨股');
    check(primaryMetric(b, 'amount').text === '¥34.83亿', '成交额排序 → 主=成交额');
    check(secondaryMetric(b, 'amount').kind === 'pct', '成交额排序 → 次=涨跌幅');
    check(primaryMetric(b, 'leadChangePct').kind === 'pct', '领涨股排序 → 主仍为涨跌幅（保持现状）');
    check(secondaryMetric({ ...b, leadName: null }, 'changePct').text === '领涨股 —', '无领涨股 → —');
  }

  section('收口 F2：空值兜底，不产生 NaN / 0 面积');
  {
    const boards = [
      { key: 'nan', amount: null, changePct: Number.NaN },
      { key: 'nil', amount: 0, changePct: null },
      { key: 'ok', amount: 1_000_000_000, changePct: 2 },
    ];
    for (const mode of ['amount', 'pct_desc', 'pct_asc'] as const) {
      const cells = calculateTreemap(boards, 1200, 540, mode);
      check(cells.every((c) => Number.isFinite(c.rect.width) && c.rect.width > 0 &&
        Number.isFinite(c.rect.height) && c.rect.height > 0),
        mode + '：空值板块也有有限正面积');
    }
  }

  section('收口 F3：全序断言（面积随排序单调不增）+ 健壮性');
  {
    const boards = Array.from({ length: 12 }, (_, i) => ({
      key: 'k' + i,
      amount: (12 - i) * 500_000_000,
      changePct: 4 - i * 0.6,
    }));
    const sorted = [...boards].sort((a, b) => b.changePct - a.changePct);
    const cells = calculateTreemap(sorted, 1200, 540, 'pct_desc');
    const areas = cells.map((c) => c.rect.width * c.rect.height);
    let monotone = true;
    for (let i = 1; i < areas.length; i++) {
      if (areas[i] > areas[i - 1] * 1.005) monotone = false;
    }
    check(monotone, '面积序列单调不增（容差 0.5%）');
    check(areas.every((a) => Number.isFinite(a) && a > 0), '健壮性：无 NaN / 无 0 面积');
    const page = fs.readFileSync('src/components/BoardPage.tsx', 'utf8');
    check(page.includes('面积 = 当前排序字段 · 颜色 = 涨跌幅'), '右下角图例已加');
    check(page.includes('textLevel(cell.rect, heatRows.length'), '小块降级按相对阈值分级');
  }
}

