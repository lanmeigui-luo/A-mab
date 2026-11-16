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

  for (const def of enabled) {
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
  if (enabled.length > 0 && errors.length >= enabled.length) {
    console.warn('[Scheduler] 全部 ' + enabled.length + ' 个战法取数失败，跳过落盘（保留「快照缺失」语义）：' + errors[0]);
    clearKlineCache();
    return { date, ok: false, strategies: 0, hits: 0, file: null, errors };
  }

  await writeFile(snapshotPath(date), JSON.stringify(snapshot, null, 2), 'utf8');

  if (errors.length) {
    console.warn('[Scheduler] 收盘快照部分战法跳过：' + errors.join('；'));
  }
  console.log(
    `[Scheduler] 收盘快照落盘成功 ${date}：启用战法 ${enabled.length} 个，命中记录 ${totalHits} 条 → ${snapshotPath(date)}`,
  );

  const cacheStats = klineCacheStats();
  console.log('[Scheduler] K线共享池：缓存 ' + cacheStats.entries + ' 只，命中 ' + cacheStats.hits + ' 次（省去重复网络请求）');
  clearKlineCache();
  return { date, ok: true, strategies: strategiesOut.length, hits: totalHits, file: snapshotPath(date), errors };
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
  if (await snapshotExists(date)) {
    return { ok: true, started: false, date, reason: '当日快照已存在' };
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
      if (!shouldRunSnapshotNow(now, getHolidays())) return;
      // 不再在 tick 内 await 全市场扫描：交给带并发锁的后台补跑入口。
      // 旧实现无锁，任务跑 20 分钟期间每分钟都会再启动一次，最多可并发 5+ 个扫描。
      const r = await triggerSnapshotBackfill(getHolidays());
      if (r.started) console.log('[Scheduler] ' + r.reason + ' → ' + r.date);
    } catch (e) {
      console.error('[Scheduler] 检查/执行异常：', (e && e.message) || e);
    }
  };
  // 启动即检查一次（不等第一个 60s 间隔）：错过窗口时只要开过软件就立刻补跑
  void tick();
  setInterval(tick, 60_000);
  console.log('[radar-server] 收盘快照定时器已就绪（交易日 15:05 后任意时刻，当日快照缺失即自动补跑）');
}
