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
import { simulateTrade } from '../src/lib/winrate-sim';
import { computeWinRateStats } from '../src/lib/winrate-stats';
import { tradeTriggerPrice, tradeRuleNote } from '../src/domain/winrate';
import { TRADE_RULE_VERSION } from '../src/domain/winrate-config';
import type { WinRateRecord, TradeRecord, SellReason } from '../src/domain/winrate';
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

// ───────── 入口 ─────────
async function main() {
  console.log('战法胜率 v2-t1-fix 增量修复 · 离线验收');
  console.log(`TRADE_RULE_VERSION = ${TRADE_RULE_VERSION}`);
  runCases();
  runStatsAssertion();
  runHelperAssertion();
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
