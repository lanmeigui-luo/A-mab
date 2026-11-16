/**
 * 收盘快照：解决「浏览器没打开时漏记录」问题（口径 A · 轻量）
 *
 * 设计（见需求决策）：
 *  - 后端 Node 定时任务，在交易日 15:05-15:10 触发，对每个启用战法调一次 runScreen，
 *    取评分前 5 命中，落盘到 data/snapshots/YYYY-MM-DD.json。
 *  - 绝不移植 simulateTrade / T+1 结算等前端 TS 逻辑：快照只记「信号 + 评分 + 买卖计划」，
 *    T+1 结算全部留前端（打开应用时调 /api/winrate-snapshot 拉取后由 settleOpenRecords 补算）。
 *  - 快照统一 priceSource='close'，与盘中尾盘快照（intraday_late）统计层隔离、不可混算。
 *
 * 关于 runScreen 的 trading 门禁：
 *  runScreen 在候选池 trading=false 时返回 needCustomPool（拒绝用全 0 字段造候选池）。
 *  15:05 收盘后，若新浪排行仍返回当日收盘真实数据（trading=true），快照正常生成；
 *  若新浪已清零（trading=false），runScreen 返回 ok:false，本模块记 warning 并跳过该战法——
 *  不会落盘垃圾数据。该行为属预期内的保护性降级，下一交易日再试。
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, writeFile, readFile, readdir, stat, copyFile } from 'node:fs/promises';
import { runScreen, configureKlineCache, clearKlineCache, klineCacheStats } from './screen.mjs';
import { STRATEGY_DEFS } from './strategies/index.mjs';
import { computeMarketStatus } from './marketStatus.mjs';
import { fetchQuotes as tencentFetchQuotes } from './sources/tencent.mjs';

// 运行时数据统一落 userData（Electron 注入 RADAR_DATA_DIR），避免装在 Program Files 时无写权限；
// dev 未注入时回退到项目根 data/snapshots，保持原有行为。
// 【兼容双读】LEGACY = 模块相对的项目根/安装目录（历史快照所在地）。
// 主目录（userData）优先，LEGACY 兜底；两者相同时不重复读取。
const LEGACY_SNAPSHOT_DIR = fileURLToPath(new URL('../data/snapshots', import.meta.url));
const SNAPSHOT_DIR = process.env.RADAR_DATA_DIR
  ? path.join(process.env.RADAR_DATA_DIR, 'snapshots')
  : LEGACY_SNAPSHOT_DIR;
const SNAPSHOT_DIRS = SNAPSHOT_DIR === LEGACY_SNAPSHOT_DIR
  ? [SNAPSHOT_DIR]
  : [SNAPSHOT_DIR, LEGACY_SNAPSHOT_DIR];
const TOP_N = 5;
/** 补跑任务并发锁：全市场扫描 11 个战法耗时约 20 分钟，绝不重复启动 */
let backfillRunning = false;
/** 14:55 扫描并发锁 + 14:57 待复核候选（方案 D） */
let overnightRunning = false;
let overnightPending = null;
const SIDECAR = process.env.SIDECAR || 'http://127.0.0.1:8788';

/** 本地日期 YYYY-MM-DD（避免 UTC 偏移吞日期） */
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function snapshotPath(date) {
  return path.join(SNAPSHOT_DIR, date + '.json'); // 写入始终用主目录
}

/** 读取候选路径：主目录优先，LEGACY 兜底 */
function snapshotReadPaths(date) {
  return SNAPSHOT_DIRS.map((d) => path.join(d, date + '.json'));
}

async function ensureSnapshotDir() {
  await mkdir(SNAPSHOT_DIR, { recursive: true });
}

/**
 * 把 runScreen 返回的 ScreenHit 投影为快照所需的紧凑结构。
 * 仅保留前端转 WinRateRecord 必需字段，剔除体积大的 indicators / conds 明细。
 */
function projectHit(hit) {
  return {
    fullCode: hit.fullCode,
    code: hit.code,
    name: hit.name,
    /** 记录时价格（收盘快照 = 当日收盘价） */
    price: hit.price ?? null,
    limitUp: { isLimitUp: !!(hit.limitUp && hit.limitUp.isLimitUp) },
    /** 确定性评分（ScoreResult.total） */
    determinismScore: hit.score?.total ?? null,
    /** 因子分解（ScoreResult.factors），供前端单笔详情展示各因子贡献 */
    scoreFactors: hit.score?.factors ?? null,
    /** 命中战法（含 hitRatio），前端取本战法 signalStrength */
    strategies: (hit.strategies || []).map((s) => ({ id: s.id, hitRatio: s.hitRatio })),
    /** 买卖计划（买区间 / 止损 / 目标） */
    tradePlan: {
      buyLow: hit.tradePlan?.buyLow ?? null,
      buyHigh: hit.tradePlan?.buyHigh ?? null,
      stop: hit.tradePlan?.stop ?? null,
      target1: hit.tradePlan?.target1 ?? null,
      target2: hit.tradePlan?.target2 ?? null,
    },
  };
}

/** 列出已落盘的快照日期（升序） */
export async function listSnapshotDates() {
  const found = new Set();
  for (const dir of SNAPSHOT_DIRS) {
    try {
      const files = await readdir(dir);
      for (const f of files) {
        const d = f.replace(/\.json$/, '');
        if (DATE_RE.test(d)) found.add(d);
      }
    } catch { /* 目录不存在：跳过，继续下一个 */ }
  }
  return [...found].sort();
}

/** 读取单日快照；日期非法或文件不存在返回 null */
export async function readSnapshot(date) {
  if (!DATE_RE.test(date || '')) return null;
  for (const p of snapshotReadPaths(date)) {
    try {
      const raw = await readFile(p, 'utf8');
      return JSON.parse(raw);
    } catch { /* 该目录没有或解析失败 → 试下一个 */ }
  }
  return null;
}

/** 某日快照是否已存在 */
export async function snapshotExists(date) {
  if (!DATE_RE.test(date || '')) return false;
  for (const p of snapshotReadPaths(date)) {
    try { await stat(p); return true; } catch { /* 试下一个 */ }
  }
  return false;
}

/**
 * 一次性迁移：把 LEGACY 目录里主目录尚不存在的快照复制过去（不覆盖、不删除）。
 * 解决「打包版改到 userData 后读不到历史快照」的数据目录分叉问题。
 * 幂等：已存在的跳过；每次 server 启动调用一次。
 */
export async function migrateLegacySnapshots() {
  const out = { copied: 0, skipped: 0, errors: [] };
  if (SNAPSHOT_DIRS.length < 2) return out;
  try { await ensureSnapshotDir(); }
  catch (e) { out.errors.push(String((e && e.message) || e)); return out; }
  try {
    const files = await readdir(LEGACY_SNAPSHOT_DIR);
    for (const f of files) {
      const d = f.replace(/\.json$/, '');
      if (!DATE_RE.test(d)) continue;
      const dst = path.join(SNAPSHOT_DIR, f);
      try { await stat(dst); out.skipped++; continue; } catch { /* 不存在 → 复制 */ }
      try { await copyFile(path.join(LEGACY_SNAPSHOT_DIR, f), dst); out.copied++; }
      catch (e) { out.errors.push(f + ': ' + String((e && e.message) || e)); }
    }
  } catch { /* LEGACY 目录不存在，无需迁移 */ }
  return out;
}

/** 拉单只股票 1 分钟线并取当日 HH:MM 的 bar（14:57 复核用） */
export async function fetchMinuteBar(fullCode, hhmm, timeoutMs = 12000) {
  try {
    const r = await fetch(
      SIDECAR + '/kline/min?code=' + encodeURIComponent(fullCode) + '&period=1&adjust=none&limit=600',
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    const j = await r.json();
    if (!j?.ok) return { ok: false, reason: j?.reason ?? 'sidecar ok=false' };
    const today = localDate();
    const bar = (j.rows || []).find((x) => {
      const d = String(x.date || x.datetime || '');
      return d.slice(0, 10) === today && d.slice(11, 16) === hhmm;
    });
    if (!bar) return { ok: false, reason: '未找到当日 ' + hhmm + ' 分钟 bar' };
    return { ok: true, open: bar.open, close: bar.close, date: bar.date };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/**
 * 14:57 复核取价：优先 14:56 bar 的 close（14:56:59 最后一笔连续竞价），
 * 拿不到再退 14:57 bar 的 open。绝不使用 14:57 之后的集合竞价成交价。
 */
export async function resolveReviewPrice(fullCode) {
  const b56 = await fetchMinuteBar(fullCode, '14:56');
  if (b56.ok && b56.close > 0) return { ok: true, price: b56.close, source: '14:56_close' };
  const b57 = await fetchMinuteBar(fullCode, '14:57');
  if (b57.ok && b57.open > 0) return { ok: true, price: b57.open, source: '14:57_open' };
  // 分钟线不可用时的兜底：腾讯实时现价（14:57 tick 抓到的当时盘口价）。
  // 明确标注 source，审计时能区分「精确分钟线」与「实时现价兜底」。
  try {
    const q = await tencentFetchQuotes([fullCode]);
    const row = (q?.rows || [])[0];
    if (row?.price > 0) return { ok: true, price: row.price, source: 'quote_fallback' };
  } catch { /* 落到失败 */ }
  return { ok: false, reason: '14:56/14:57 分钟线与实时现价均不可用' };
}

/** 只跑指定战法，返回紧凑快照条目 */
async function runSnapshotForStrategies(ids, date) {
  const strategiesOut = [];
  let total = 0;
  for (const id of ids) {
    const def = STRATEGY_DEFS.find((x) => x.id === id);
    if (!def || def.available === false) continue;
    const res = await runScreen({ strategyIds: [id], sortBy: 'changePct', poolSize: 300, klineBars: 120, scan: 'full' });
    if (!res.ok) return { ok: false, reason: id + ': ' + (res.reason || 'ok=false'), strategiesOut };
    const all = res.hits || [];
    const hits = all.slice(0, TOP_N).map(projectHit);
    strategiesOut.push({ strategyId: def.id, strategyName: def.name, insufficientHits: all.length < TOP_N, hits });
    total += hits.length;
  }
  return { ok: true, strategiesOut, hits: total };
}

/** 合并写入：读已有快照，按 strategyId 替换/追加，绝不整份覆盖 */
let mergeChain = Promise.resolve();

/**
 * 合并写入（Upsert + 业务键去重 + 串行）。
 * - Upsert：按 strategyId 整组替换 hits，绝不做数组拼接（避免同一战法出现两份）。
 * - 战法内去重：按 code 去重（同战法同日同票只留一条；空仓 NONE 也只留一条）。
 * - 串行：14:57 复核与 15:05 全量可能同时触发，读-改-写必须排队，否则相互覆盖或重复。
 */
export async function mergeSnapshotForStrategies(date, strategiesOut, extra = {}) {
  const task = mergeChain.then(() => doMergeSnapshotForStrategies(date, strategiesOut, extra));
  mergeChain = task.then(() => undefined, () => undefined);
  return task;
}

async function doMergeSnapshotForStrategies(date, strategiesOut, extra = {}) {
  const existing = (await readSnapshot(date)) || {
    date, generatedAt: new Date().toISOString(), priceSource: 'close', topN: TOP_N, strategies: [],
  };
  const map = new Map((existing.strategies || []).map((x) => [x.strategyId, x]));
  for (const item of strategiesOut) {
    if (!item || !item.strategyId) continue;
    let next = item;
    if (Array.isArray(item.hits)) {
      const seen = new Set();
      const hits = item.hits.filter((h) => {
        const k = String(h?.code || h?.fullCode || '');
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      next = { ...item, hits };
    }
    map.set(next.strategyId, next); // Upsert：整组替换，不拼接
  }
  const merged = { ...existing, ...extra, date, generatedAt: new Date().toISOString(), strategies: [...map.values()] };
  await ensureSnapshotDir();
  await writeFile(snapshotPath(date), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

/** 该日是否已有指定战法的条目（用于 15:05 跳过已写入的尾盘战法） */
export async function snapshotHasStrategy(date, strategyId) {
  const snap = await readSnapshot(date);
  return !!(snap?.strategies || []).find((x) => x.strategyId === strategyId);
}

/**
 * 【完整性判定】快照是否覆盖所有「应由 15:05 全量任务生成」的战法。
 * 必须与「文件存在」严格区分：14:57 会先写入只含隔夜战法的部分快照，
 * 若把「文件存在」当成「任务完成」，15:05 的全量补跑会被永久跳过（2026-11-16 实测事故）。
 * 判定口径：所有 available!==false && !skipFullSnapshot 的战法都必须有条目。
 * 注意：skipFullSnapshot 的战法（如 14:55 的隔夜持股）由专用通道负责，不计入完整性。
 */
export async function isSnapshotComplete(date) {
  const snap = await readSnapshot(date);
  if (!snap || !Array.isArray(snap.strategies)) return false;
  const present = new Set(snap.strategies.map((x) => x.strategyId));
  const required = STRATEGY_DEFS.filter((x) => x.available !== false && !x.skipFullSnapshot);
  return required.every((x) => present.has(x.id));
}

/**
 * 执行当日收盘快照落盘（口径 A 核心）。
 * 遍历启用战法，逐战法调 runScreen 取前 5，组合写 JSON。
 * 返回落盘结果供日志/调用方使用。
 */
export async function runDailyWinRateSnapshot() {
  const date = localDate(new Date());
  await ensureSnapshotDir();
  // 11 个战法共享同一份 K 线缓存：批处理期间长 TTL（2h），结束即清空，
  // 不影响 API 手动 full 扫描的 30s 短 TTL 与新数据新鲜度。
  configureKlineCache(2 * 60 * 60 * 1000);

  const enabled = STRATEGY_DEFS.filter((s) => s.available !== false);
  const strategiesOut = [];
  let totalHits = 0;
  const errors = [];

  let attempted = 0;
  for (const def of enabled) {
    // 【方案 D】14:55 已写入的尾盘战法绝不被 15:00 收盘数据覆盖
    if (def.skipFullSnapshot && (await snapshotHasStrategy(date, def.id))) {
      console.log('[Scheduler] ' + def.id + ' 已有 ' + (def.recordTime || '盘前') + ' 记录，跳过 15:05 覆盖');
      continue;
    }
    attempted++;
    try {
      // 与前端 recordStrategy 一致：单战法过滤，使 tradePlan / score 唯一归属该战法
      // 显式写 klineBars：自动记录链路必须拿到足量 K 线，否则首板打板等战法恒 0 命中
      // 收盘快照（新记录）一律全市场扫描，消除漏斗截断偏差；已落盘历史快照不回溯。
      const res = await runScreen({ strategyIds: [def.id], sortBy: 'changePct', poolSize: 300, klineBars: 120, scan: 'full' });
      if (!res.ok) {
        // trading=false（盘后数据清零）等：保护性跳过，不落盘垃圾
        errors.push(`${def.id}: ${res.reason || 'ok=false'}`);
        continue;
      }
      const allHits = res.hits || [];
      const hits = allHits.slice(0, TOP_N).map(projectHit);
      const insufficientHits = allHits.length < TOP_N;
      strategiesOut.push({ strategyId: def.id, strategyName: def.name, insufficientHits, hits });
      totalHits += hits.length;
    } catch (e) {
      errors.push(`${def.id}: ${(e && e.message) || String(e)}`);
    }
  }

  const snapshot = {
    date,
    generatedAt: new Date().toISOString(),
    priceSource: 'close',
    topN: TOP_N,
    strategies: strategiesOut,
  };

  // 若所有启用战法都因上游不可用而跳过（trading=false 等），绝不落盘空快照：
  // 否则前端会把「没跑成」误判成「跑了但 0 命中」并生成 no_signal，属于伪造审计事实。
  // 不写文件 → 前端正确显示 snapshot_missing，且定时器下一分钟会继续重试。
  if (attempted > 0 && errors.length >= attempted) {
    console.warn('[Scheduler] 全部 ' + attempted + ' 个战法取数失败，跳过落盘（保留「快照缺失」语义）：' + errors[0]);
    clearKlineCache();
    return { date, ok: false, strategies: 0, hits: 0, file: null, errors };
  }

  // 【合并写入】若 14:57 已写入隔夜战法（含 entryPriceHint / overnightReview），
  // 绝不能用 15:05 的收盘数据整份覆盖；merge 会按 strategyId 替换/追加并保留其余字段。
  const merged = await mergeSnapshotForStrategies(date, strategiesOut, {
    priceSource: 'close',
    topN: TOP_N,
  });
  void merged; // 结果由下方日志与 return 统一披露

  if (errors.length) {
    console.warn('[Scheduler] 收盘快照部分战法跳过：' + errors.join('；'));
  }
  console.log(
    `[Scheduler] 收盘快照落盘成功 ${date}：启用战法 ${enabled.length} 个，本次执行 ${attempted} 个（跳过 ${enabled.length - attempted}），命中记录 ${totalHits} 条 → ${snapshotPath(date)}`,
  );

  const cacheStats = klineCacheStats();
  console.log('[Scheduler] K线共享池：缓存 ' + cacheStats.entries + ' 只，命中 ' + cacheStats.hits + ' 次（省去重复网络请求）');
  clearKlineCache();
  return { date, ok: true, strategies: strategiesOut.length, hits: totalHits, file: snapshotPath(date), errors };
}

/**
 * 【方案 D】14:55 单兵扫描：只跑配置了 recordTime 的尾盘战法（当前为隔夜持股法）。
 * 扫描约 44 秒，结果暂存 overnightPending，等 14:57 二次复核再落盘。
 */
export async function triggerOvernightScan(holidays = new Set()) {
  const now = new Date();
  const date = localDate(now);
  if (computeMarketStatus(now, holidays) === 'holiday') {
    return { ok: true, started: false, date, reason: '非交易日，不扫描' };
  }
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < 14 * 60 + 55) return { ok: true, started: false, date, reason: '未到 14:55' };
  if (overnightRunning) return { ok: true, started: false, date, reason: '14:55 扫描已在运行' };
  if (await snapshotHasStrategy(date, 'overnight-hold')) {
    return { ok: true, started: false, date, reason: '当日隔夜战法已记录' };
  }
  overnightRunning = true;
  setImmediate(async () => {
    try {
      const t0 = Date.now();
      const r = await runSnapshotForStrategies(['overnight-hold'], date);
      if (!r.ok) { console.warn('[Overnight] 14:55 扫描失败：' + r.reason); return; }
      const strat = r.strategiesOut[0];
      overnightPending = {
        date,
        hits: strat?.hits || [],
        strategyName: strat?.strategyName || '隔夜持股法',
        insufficientHits: !!strat?.insufficientHits,
      };
      console.log('[Overnight] 14:55 扫描完成：' + (strat?.hits || []).length + ' 只候选，耗时 ' +
        ((Date.now() - t0) / 1000).toFixed(1) + 's，等待 14:57 复核');
    } catch (e) {
      console.warn('[Overnight] 14:55 扫描异常：' + ((e && e.message) || e));
    } finally {
      overnightRunning = false;
    }
  });
  return { ok: true, started: true, date, reason: '已在后台启动 14:55 隔夜战法扫描' };
}

/**
 * 【方案 D】14:57 二次复核：候选价仍在 [buyLow,buyHigh] 内才确认成交并写 entryPriceHint；
 * 跌出下限/涨破上限/取价失败 → unfilled（前端转 invalid + intraday_unfilled）。
 */
export async function reviewOvernightPending(holidays = new Set()) {
  if (!overnightPending) return { ok: true, done: false, reason: '无待复核候选' };
  const now = new Date();
  const date = localDate(now);
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < 14 * 60 + 57) return { ok: true, done: false, reason: '未到 14:57' };
  if (mins > 15 * 60) { overnightPending = null; return { ok: true, done: false, reason: '已过 15:00，放弃复核' }; }
  if (overnightPending.date !== date) { overnightPending = null; return { ok: true, done: false, reason: '跨日，丢弃待复核' }; }

  const { hits, strategyName, insufficientHits } = overnightPending;
  overnightPending = null;

  const confirmed = [];
  const unfilled = [];
  await Promise.all(hits.map(async (h) => {
    const p = await resolveReviewPrice(h.fullCode);
    if (!p.ok) {
      unfilled.push({ ...h, unfilled: true, unfilledReason: '复核取价失败：' + p.reason });
      return;
    }
    const lo = h.tradePlan?.buyLow;
    const hi = h.tradePlan?.buyHigh;
    if (lo != null && p.price < lo) {
      unfilled.push({ ...h, unfilled: true, unfilledReason: '复核价 ' + p.price + ' 低于买入下限 ' + lo });
    } else if (hi != null && p.price > hi) {
      unfilled.push({ ...h, unfilled: true, unfilledReason: '复核价 ' + p.price + ' 高于买入上限 ' + hi });
    } else {
      confirmed.push({ ...h, entryPriceHint: p.price, entryPriceSource: p.source });
    }
  }));

  const all = [...confirmed, ...unfilled];
  await mergeSnapshotForStrategies(date, [{
    strategyId: 'overnight-hold',
    strategyName,
    insufficientHits,
    hits: all,
  }], { overnightReview: { at: new Date().toISOString(), confirmed: confirmed.length, unfilled: unfilled.length } });

  console.log('[Overnight] 14:57 复核完成：成交 ' + confirmed.length + ' 只，未成交 ' + unfilled.length + ' 只');
  return { ok: true, done: true, date, confirmed: confirmed.length, unfilled: unfilled.length };
}

/**
 * 收盘快照【手动/自动补跑】入口（用户拍板：应用打开时自动补跑）。
 * 触发条件：交易日 + 已过 15:05 + 当日快照不存在 + 当前无补跑任务。
 * 全市场扫描 11 个战法约 20 分钟，用 setImmediate 后台异步执行，立即返回不阻塞前端；
 * 本次打开不会立刻看到结果，完成后刷新页面由 backfillCloseSnapshots 补录。
 * 是否交易日用后端的 HOLIDAYS 权威判定（前端仅用工作日粗筛）。
 */
export async function triggerSnapshotBackfill(holidays = new Set()) {
  const now = new Date();
  const date = localDate(now);
  if (computeMarketStatus(now, holidays) === 'holiday') {
    return { ok: true, started: false, date, reason: '非交易日，无需补跑' };
  }
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < 15 * 60 + 5) {
    return { ok: true, started: false, date, reason: '未到 15:05，暂不补跑' };
  }
  // 与定时器共用同一「交易日 + >=15:05」判定（函数声明提升，定义在本文件下方）
  if (backfillRunning) {
    return { ok: true, started: false, date, reason: '补跑任务已在运行' };
  }
  // 【2026-11-16 事故修复】不能只看文件是否存在：14:57 会先写只含隔夜战法的部分快照。
  // 必须确认「完整」才跳过，否则 15:05 的全量任务会被部分快照永久挡住。
  if (await isSnapshotComplete(date)) {
    return { ok: true, started: false, date, reason: '当日快照已完整' };
  }
  backfillRunning = true;
  setImmediate(async () => {
    try {
      console.log('[Scheduler] 应用触发补跑：开始 ' + date);
      await runDailyWinRateSnapshot();
    } catch (e) {
      console.error('[Scheduler] 补跑失败: ' + ((e && e.message) || e));
    } finally {
      backfillRunning = false;
    }
  });
  return { ok: true, started: true, date, reason: '已在后台启动当日收盘快照补跑' };
}

/**
 * 是否应触发收盘快照：交易日 且 当前时间 >= 15:05（不再限定 15:05-15:10 的 5 分钟窗口）。
 * 只要后端服务在跑，15:10 打开、晚上 20:00 打开，检测到当天快照不存在都会立刻补跑。
 * 【不补历史日】行情接口只返回最新收盘数据；若第二天早上补昨天，会把今天的数据
 * 标成昨天的快照，属于造假。所以只补「当天」，且必须由 >=15:05 这个时间闸门保证。
 */
export function shouldRunSnapshotNow(now = new Date(), holidays = new Set()) {
  if (computeMarketStatus(now, holidays) === 'holiday') return false; // 非交易日/周末/节假日跳过
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= 15 * 60 + 5;
}

/**
 * 启动定时器：每分钟检查一次，命中窗口且当日快照未生成则触发。
 * getHolidays 为 getter，读取 index.mjs 异步加载后的最新节假日集合。
 */
export function startScheduler(getHolidays) {
  // 启动时迁移旧目录历史快照（幂等）；之后 listSnapshotDates / readSnapshot 天然双读兜底。
  migrateLegacySnapshots()
    .then((r) => {
      if (r.copied > 0 || r.errors.length) {
        console.log('[Scheduler] 历史快照迁移：新增 ' + r.copied + ' 个，跳过 ' + r.skipped + ' 个，错误 ' + r.errors.length + ' 条');
      }
    })
    .catch((e) => console.warn('[Scheduler] 快照迁移失败（不影响启动）: ' + ((e && e.message) || e)));
  const tick = async () => {
    try {
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      // 【方案 D】14:55–14:59：尾盘战法单兵扫描
      if (mins >= 14 * 60 + 55 && mins <= 14 * 60 + 59) {
        const ov = await triggerOvernightScan(getHolidays());
        if (ov.started) console.log('[Scheduler] ' + ov.reason + ' → ' + ov.date);
      }
      // 【方案 D】14:57–14:59：二次复核（14:55 扫描约 44s，此时 pending 已就绪）
      if (mins >= 14 * 60 + 57 && mins <= 14 * 60 + 59) {
        await reviewOvernightPending(getHolidays());
      }
      // ≥15:05：其余战法全量快照（自动跳过已写入的尾盘战法）
      if (shouldRunSnapshotNow(now, getHolidays())) {
        const r = await triggerSnapshotBackfill(getHolidays());
        if (r.started) console.log('[Scheduler] ' + r.reason + ' → ' + r.date);
      }
    } catch (e) {
      console.error('[Scheduler] 检查/执行异常：', (e && e.message) || e);
    }
  };
  // 启动即检查一次（不等第一个 60s 间隔）：错过窗口时只要开过软件就立刻补跑
  void tick();
  setInterval(tick, 60_000);
  console.log('[radar-server] 快照定时器已就绪：14:55 尾盘战法单兵扫描 → 14:57 复核 → 15:05 其余战法（均自动跳过已写入的尾盘战法）');
}
