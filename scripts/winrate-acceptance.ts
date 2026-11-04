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

// ───────── 入口 ─────────
console.log('战法胜率 v2-t1-fix 增量修复 · 离线验收');
console.log(`TRADE_RULE_VERSION = ${TRADE_RULE_VERSION}`);
runCases();
runStatsAssertion();
runHelperAssertion();

console.log(`\n──────── 结果 ────────`);
console.log(`通过 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.log(`失败 ${failed} 条：`);
  fails.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
} else {
  console.log('全部通过 ✅');
}
