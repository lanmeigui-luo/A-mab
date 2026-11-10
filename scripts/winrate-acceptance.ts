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
} from '../src/domain/winrate';
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
  await runMinuteAssertions();
  runMinuteStatsAssertion();

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
