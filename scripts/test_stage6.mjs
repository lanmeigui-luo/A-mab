import fs from 'node:fs';
import { runScreen } from '../server/screen.mjs';
import { STRATEGY_DEFS } from '../server/strategies/index.mjs';
import { computeIndicators } from '../server/strategies/index.mjs';
import * as tencent from '../server/sources/tencent.mjs';

const out = [];
const log = (s) => out.push(s);

// 1) 指标自检
try {
  const k = await tencent.fetchKline('sh600519', 'day', 'qfq', 120);
  const ind = computeIndicators(k.rows, '600519');
  log(`[指标] bars=${ind.bars} close=${ind.close}`);
  log(`  MA5=${ind.ma5?.toFixed(2)} MA20=${ind.ma20?.toFixed(2)} MA60=${ind.ma60?.toFixed(2)}`);
  log(`  MACD=${ind.macd ? `dif ${ind.macd.dif.toFixed(3)} dea ${ind.macd.dea.toFixed(3)} bar ${ind.macd.bar.toFixed(3)}` : 'null'}`);
  log(`  RSI14=${ind.rsi14?.toFixed(1) ?? 'null'} KDJ=${ind.kdj ? `K${ind.kdj.k.toFixed(1)} D${ind.kdj.d.toFixed(1)} J${ind.kdj.j.toFixed(1)}` : 'null'}`);
  log(`  BOLL=${ind.boll ? `${ind.boll.lower.toFixed(2)}/${ind.boll.mid.toFixed(2)}/${ind.boll.upper.toFixed(2)}` : 'null'}`);
  log(`  ATR14=${ind.atr14 ? `${ind.atr14.atr.toFixed(2)} expand ${ind.atr14.expanding?.toFixed(2)}` : 'null'}`);
  log(`  bias20=${ind.bias20?.toFixed(2)} bias60=${ind.bias60?.toFixed(2)} volMa5Over20=${ind.volMa5Over20?.toFixed(2)}`);
  log(`  volShrinkRatio=${ind.volShrinkRatio?.toFixed(3)} adjustDays=${ind.adjustDays} ma3Cross=${JSON.stringify(ind.ma3Cross)}`);
  log(`  dragon=${JSON.stringify(ind.dragon)}`);
  log(`  limitUpCount20=${ind.limitUpCount20} upDays=${ind.upDays} volRising3=${ind.volRising3}`);
} catch (e) {
  log('[指标] ERR ' + e.message);
}

// 2) 全市场选股
const t0 = Date.now();
const r = await runScreen({ sortBy: 'changePct', poolSize: 200, klineBars: 120, concurrency: 8, strategyIds: null });
log('');
log(`[选股] ${Date.now() - t0}ms trading=${r.trading} 池=${r.poolSize} 命中=${r.hitCount} 排除ST=${r.excludedSt ?? 0}`);
log('ctx=' + JSON.stringify(r.context));

const stat = new Map();
for (const h of r.hits) {
  for (const s of h.strategies) {
    if (!stat.has(s.id)) stat.set(s.id, { n: 0, samples: [] });
    const e = stat.get(s.id);
    e.n++;
    if (e.samples.length < 2) e.samples.push(h);
  }
}
log('');
log('—— 各战法命中 ——');
for (const s of STRATEGY_DEFS) {
  const e = stat.get(s.id);
  if (!e) {
    log(`  ${s.name.padEnd(6)} 0 只` + (s.available === false ? '（待接入）' : ''));
    continue;
  }
  log(`  ${s.name.padEnd(6)} ${String(e.n).padStart(3)} 只`);
  for (const h of e.samples) {
    const hit = h.strategies.find((x) => x.id === s.id);
    log(`      ${h.code} ${h.name} 评分 ${h.score.total} :: ` + hit.conds.map((c) => `${c.pass ? '✓' : c.na ? '–' : '✕'}${c.key}`).join(' '));
  }
}

log('');
for (const n of r.notes) log('  ' + n);
if (r.errors?.length) for (const e of r.errors.slice(0, 5)) log('  ERR ' + e);

fs.writeFileSync('_out.txt', out.join('\n') + '\n', 'utf8');
