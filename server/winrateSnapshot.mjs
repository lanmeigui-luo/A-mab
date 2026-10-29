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
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { runScreen } from './screen.mjs';
import { STRATEGY_DEFS } from './strategies/index.mjs';
import { computeMarketStatus } from './marketStatus.mjs';

const SNAPSHOT_DIR = fileURLToPath(new URL('../data/snapshots', import.meta.url));
const TOP_N = 5;

/** 本地日期 YYYY-MM-DD（避免 UTC 偏移吞日期） */
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function snapshotPath(date) {
  return path.join(SNAPSHOT_DIR, date + '.json');
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
  try {
    const files = await readdir(SNAPSHOT_DIR);
    return files
      .filter((f) => DATE_RE.test(f.replace(/\.json$/, '')))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/** 读取单日快照；日期非法或文件不存在返回 null */
export async function readSnapshot(date) {
  if (!DATE_RE.test(date || '')) return null;
  try {
    const raw = await readFile(snapshotPath(date), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 某日快照是否已存在 */
export async function snapshotExists(date) {
  if (!DATE_RE.test(date || '')) return false;
  try {
    await stat(snapshotPath(date));
    return true;
  } catch {
    return false;
  }
}

/**
 * 执行当日收盘快照落盘（口径 A 核心）。
 * 遍历启用战法，逐战法调 runScreen 取前 5，组合写 JSON。
 * 返回落盘结果供日志/调用方使用。
 */
export async function runDailyWinRateSnapshot() {
  const date = localDate(new Date());
  await ensureSnapshotDir();

  const enabled = STRATEGY_DEFS.filter((s) => s.available !== false);
  const strategiesOut = [];
  let totalHits = 0;
  const errors = [];

  for (const def of enabled) {
    try {
      // 与前端 recordStrategy 一致：单战法过滤，使 tradePlan / score 唯一归属该战法
      const res = await runScreen({ strategyIds: [def.id], sortBy: 'changePct', poolSize: 300 });
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

  await writeFile(snapshotPath(date), JSON.stringify(snapshot, null, 2), 'utf8');

  if (errors.length) {
    console.warn('[Scheduler] 收盘快照部分战法跳过：' + errors.join('；'));
  }
  console.log(
    `[Scheduler] 收盘快照落盘成功 ${date}：启用战法 ${enabled.length} 个，命中记录 ${totalHits} 条 → ${snapshotPath(date)}`,
  );

  return { date, ok: true, strategies: strategiesOut.length, hits: totalHits, file: snapshotPath(date), errors };
}

/** 是否处于「应触发收盘快照」的窗口：交易日 且 15:05-15:10 */
export function shouldRunSnapshotNow(now = new Date(), holidays = new Set()) {
  if (computeMarketStatus(now, holidays) === 'holiday') return false; // 非交易日/周末/节假日跳过
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= 15 * 60 + 5 && mins <= 15 * 60 + 10;
}

/**
 * 启动定时器：每分钟检查一次，命中窗口且当日快照未生成则触发。
 * getHolidays 为 getter，读取 index.mjs 异步加载后的最新节假日集合。
 */
export function startScheduler(getHolidays) {
  const tick = async () => {
    try {
      const now = new Date();
      if (!shouldRunSnapshotNow(now, getHolidays())) return;
      const date = localDate(now);
      if (await snapshotExists(date)) {
        return; // 当日已落盘，避免重复
      }
      await runDailyWinRateSnapshot();
    } catch (e) {
      console.error('[Scheduler] 检查/执行异常：', (e && e.message) || e);
    }
  };
  setInterval(tick, 60_000);
  console.log('[radar-server] 收盘快照定时器已就绪（每日 15:05-15:10 触发，落盘目录 data/snapshots/）');
}
