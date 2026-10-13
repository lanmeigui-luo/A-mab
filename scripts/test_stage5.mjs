/**
 * 阶段 5 实测：11 种战法引擎跑真实数据
 * 输出每战法命中数、命中率分布、样本明细、评分覆盖度
 */
import fs from 'node:fs';
import { runScreen } from '../server/screen.mjs';
import { STRATEGY_DEFS } from '../server/strategies/index.mjs';

const out = [];
const log = (s) => out.push(s);

const ids = STRATEGY_DEFS.filter((s) => s.available !== false).map((s) => s.id);
log('可用战法数=' + ids.length + ' / 总数=' + STRATEGY_DEFS.length);
for (const s of STRATEGY_DEFS) {
  log(`  ${s.available === false ? '[待接入]' : '[可用]  '} ${s.id.padEnd(16)} ${s.category} ${s.name}`);
}

const t0 = Date.now();
const r = await runScreen({ sortBy: 'changePct', poolSize: 200, klineBars: 60, concurrency: 8, strategyIds: null });
log('');
log(`耗时 ${Date.now() - t0} ms · trading=${r.trading} · 候选池=${r.poolSize} · 命中=${r.hitCount} · 排除ST=${r.excludedSt ?? 0}`);
log('context=' + JSON.stringify(r.context));
log('');

// 每战法命中统计
const stat = new Map();
for (const h of r.hits) {
  for (const s of h.strategies) {
    if (!stat.has(s.id)) stat.set(s.id, { n: 0, ratios: [], samples: [] });
    const e = stat.get(s.id);
    e.n++;
    e.ratios.push(s.hitRatio);
    if (e.samples.length < 3) e.samples.push(h);
  }
}
log('—— 各战法命中 ——');
for (const s of STRATEGY_DEFS) {
  const e = stat.get(s.id);
  if (!e) {
    log(`  ${s.name.padEnd(6)} 命中 0 只` + (s.available === false ? '（数据源待接入，符合预期）' : ''));
    continue;
  }
  const avg = (e.ratios.reduce((a, b) => a + b, 0) / e.ratios.length) * 100;
  log(`  ${s.name.padEnd(6)} 命中 ${String(e.n).padStart(3)} 只 · 平均条件命中率 ${avg.toFixed(0)}%`);
  for (const h of e.samples) {
    const hit = h.strategies.find((x) => x.id === s.id);
    log(
      `      ${h.code} ${h.name.padEnd(5)} 现价 ${h.price} 涨跌 ${h.changePct?.toFixed(2)}% 评分 ${h.score.total} 覆盖 ${h.score.coverage}% :: ` +
        hit.conds.map((c) => `${c.pass ? '✓' : c.na ? '–' : '✕'}${c.key}`).join(' '),
    );
  }
}

log('');
log('—— 多战法共振 TOP5 ——');
const multi = [...r.hits].sort((a, b) => b.strategies.length - a.strategies.length).slice(0, 5);
for (const h of multi) {
  log(`  ${h.code} ${h.name} 命中 ${h.strategies.length} 种：${h.strategies.map((s) => s.name).join('+')} · 评分 ${h.score.total}`);
}

log('');
log('—— 评分覆盖度分布 ——');
const cov = new Map();
for (const h of r.hits) cov.set(h.score.coverage, (cov.get(h.score.coverage) ?? 0) + 1);
for (const [k, v] of [...cov.entries()].sort((a, b) => b[0] - a[0])) log(`  覆盖 ${k}% : ${v} 只`);

log('');
log('—— notes ——');
for (const n of r.notes) log('  ' + n);
if (r.errors?.length) {
  log('—— errors ——');
  for (const e of r.errors.slice(0, 5)) log('  ' + e);
}

// 异常校验：命中票里不应出现 ST
const st = r.hits.filter((h) => /\*?ST/i.test(h.name));
log('');
log('ST 泄漏检查：' + (st.length ? '发现 ' + st.length + ' 只 → ' + st.map((x) => x.name).join(',') : '无（正确）'));

// 异常校验：K 线不足却被趋势类战法命中
const shortBars = r.hits.filter((h) => h.indicators.bars < 60 && h.strategies.some((s) => ['trend-break', 'dragon', 'ma-bull', 'pullback-buy', 'dragon-return'].includes(s.id)));
log('短 K 线误判检查：' + (shortBars.length ? '发现 ' + shortBars.length + ' 只 → ' + shortBars.map((x) => `${x.code}(${x.indicators.bars}根)`).join(',') : '无（正确）'));

fs.writeFileSync('_out.txt', out.join('\n') + '\n', 'utf8');
