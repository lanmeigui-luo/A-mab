/**
 * 选股流水线：候选池 → 精确行情 → 批量 K 线 → 规则引擎 → 评分排序
 *
 * 触发方式：手动点「执行选股」（不是轮询）。
 * 原因：每个候选都要拉 K 线，100 只约 2-3 秒，不适合高频刷新。
 */

import * as rankSrc from './sources/sina_rank.mjs';
import * as tencent from './sources/tencent.mjs';
import * as tdx from './sources/tdx.mjs';
import {
  computeIndicators,
  evaluateStrategies,
  inferLimitUp,
  overnightDiagnose,
  prefilterSnap,
  scoreCandidate,
  STRATEGY_DEFS,
} from './strategies/index.mjs';
import { buildTradePlan } from './strategies/tradeplan.mjs';
import { intradayStats } from './strategies/indicators.mjs';
import { isKlineBatchValid } from './klineValidate.mjs';

const SIDECAR = process.env.SIDECAR || 'http://127.0.0.1:8788';

/** 模块级 sidecar 请求（loadContext 内的 getJson 是局部的，runScreen 另需一份） */
async function sidecarJson(path, ms = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(SIDECAR + path, { signal: ctrl.signal });
    return await r.json();
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 拉取评分上下文：全市场资金流排名 + 涨停池情绪 */
/**
 * 上下文在进程内缓存 60 秒。
 * 原因：资金流排名约 5s、板块映射首次约 14s，若每次选股都重新拉取，
 * 一次选股要等 20 秒以上。这些都是分钟级变化的数据，60 秒内复用是安全的。
 */
let ctxCache = { at: 0, data: null, meta: null };
const CTX_TTL = 60_000;

async function loadContext(force = false) {
  const now = Date.now();
  if (!force && ctxCache.data && now - ctxCache.at < CTX_TTL) {
    return {
      ctx: ctxCache.data,
      meta: { ...ctxCache.meta, ctxMs: 0, ctxCached: true },
    };
  }
  const t0 = Date.now();
  const getJson = async (path, ms) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(SIDECAR + path, { signal: ctrl.signal });
      return await r.json();
    } catch (e) {
      return { ok: false, reason: String(e.message || e) };
    } finally {
      clearTimeout(timer);
    }
  };

  const [fund, sent, bmap, prevPool, bf] = await Promise.all([
    getJson('/fund/rank', 25000),
    getJson('/market/limitup', 15000),
    getJson('/board/map?type=industry', 40000),
    getJson('/market/prev-limitup', 20000),
    // 板块资金流排名（概念为主口径 + 行业校验），隔夜持股法的板块条件
    getJson('/board/fund', 30000),
  ]);

  const byCode = new Map();
  const nets = [];
  if (fund?.ok && Array.isArray(fund.rows)) {
    for (const r of fund.rows) {
      if (r.netYuan != null) {
        byCode.set(String(r.code), r.netYuan);
        nets.push(r.netYuan);
      }
    }
  }
  nets.sort((a, b) => a - b);

  // 板块映射
  let boardCtx = { available: false, boardPct: new Map(), codeToBoard: new Map(), sortedBoardPcts: [] };
  if (bmap?.ok && bmap.codeToBoard && bmap.boards) {
    const boardPct = new Map(Object.entries(bmap.boards).map(([k, v]) => [k, typeof v === 'number' ? v : null]));
    const codeToBoard = new Map(Object.entries(bmap.codeToBoard));
    const sortedBoardPcts = [...boardPct.values()].filter((v) => typeof v === 'number').sort((a, b) => a - b);
    boardCtx = { available: true, boardPct, codeToBoard, sortedBoardPcts, boardLimitUpCount: new Map() };
  }

  const ctxMeta = {
    fundAvailable: !!fund?.ok,
    fundRows: nets.length,
    sentimentAvailable: !!sent?.ok,
    boardAvailable: boardCtx.available,
    boardCount: bmap?.boardCount ?? null,
    boardMappedStocks: bmap?.mappedStocks ?? null,
    ctxMs: Date.now() - t0,
    ctxCached: false,
    fundReason: fund?.ok ? null : fund?.reason,
  };

  // 涨停池连板结构：连板晋级战法的唯一真实依据。
  // 优先用 sidecar 预聚合的 boardsByCode；老版本 sidecar 没有该字段时，
  // 回退到直接解析涨停池 rows（同样含 代码/连板数/炸板次数），避免必须重启 sidecar。
  const limitPool = (() => {
    const byCode = new Map();
    const put = (code, board, broken, extra) => {
      const c = String(code || '').padStart(6, '0');
      if (!/^\d{6}$/.test(c)) return;
      byCode.set(c, {
        board: Number.isFinite(board) ? board : 1,
        broken: Number.isFinite(broken) ? broken : 0,
        ...(extra || {}),
      });
    };
    if (sent?.ok && sent.boardsByCode) {
      for (const [code, v] of Object.entries(sent.boardsByCode)) {
        put(code, Number(v?.board), Number(v?.broken), {
          sealYuan: v?.sealYuan ?? null,
          firstSeal: v?.firstSeal ?? null,
          industry: v?.industry ?? null,
        });
      }
    } else if (sent?.ok && Array.isArray(sent.rows)) {
      for (const r of sent.rows) {
        put(r['代码'], parseInt(r['连板数'], 10), parseInt(r['炸板次数'], 10), {
          sealYuan: r['封板资金'] ?? null,
          firstSeal: r['首次封板时间'] ?? null,
          industry: r['所属行业'] ?? null,
        });
      }
    }
    return byCode.size ? { available: true, byCode } : { available: false, byCode: new Map() };
  })();

  // 板块内涨停家数（首板「板块协同」条件）：涨停池代码 → 所属板块 → 计数
  if (limitPool.available && boardCtx.available) {
    for (const c of limitPool.byCode.keys()) {
      const b = boardCtx.codeToBoard.get(c);
      if (b) boardCtx.boardLimitUpCount.set(b, (boardCtx.boardLimitUpCount.get(b) ?? 0) + 1);
    }
  }

  // —— 晋级率与「昨日涨停今日表现」（需求 2.3 / 第五章情绪指标）——
  // 晋级率 = 昨日连板池（连板数≥2）中今日继续封板的比例；池不足 10 家记 null，不填 0。
  // 昨日涨停今日表现 = 昨日涨停池全部个股今日的平均涨跌幅（腾讯行情真算）。
  const toFullCode = (code) => {
    const c = String(code).padStart(6, '0');
    if (/^(6|9)/.test(c)) return 'sh' + c;
    if (/^(4|8)/.test(c)) return 'bj' + c;
    return 'sz' + c;
  };

  let promoteRate = null;
  let promotePoolSize = null;
  let prevLimitUpPerf = null;
  let prevLimitUpDate = null;
  if (prevPool?.ok && Array.isArray(prevPool.items) && prevPool.items.length) {
    prevLimitUpDate = prevPool.date ?? null;
    const prevBoards = prevPool.items.filter((x) => (x.board ?? 1) >= 2);
    promotePoolSize = prevBoards.length;
    if (prevBoards.length >= 10 && limitPool.available) {
      let promoted = 0;
      for (const x of prevBoards) {
        if (limitPool.byCode.has(String(x.code).padStart(6, '0'))) promoted++;
      }
      promoteRate = promoted / prevBoards.length;
    }
    // 昨日涨停股今日表现：批量拉腾讯行情（150 只一批）
    const want = prevPool.items.map((x) => toFullCode(x.code));
    const qmap = new Map();
    try {
      for (let i = 0; i < want.length; i += 150) {
        const q = await tencent.fetchQuotes(want.slice(i, i + 150));
        for (const row of q.rows) qmap.set(row.code, row);
      }
    } catch {
      /* 取不到就保持 null，不用 0 填充 */
    }
    const pcts = [];
    for (const x of prevPool.items) {
      const row = qmap.get(String(x.code).padStart(6, '0'));
      if (row?.changePct != null) pcts.push(row.changePct);
    }
    if (pcts.length) prevLimitUpPerf = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  }

  // 上证指数涨跌幅（量价齐升「强于大盘」条件）
  let indexChangePct = null;
  try {
    const idx = await tencent.fetchQuotes(['sh000001']);
    indexChangePct = idx.rows?.[0]?.changePct ?? null;
  } catch {
    /* 取不到保持 null */
  }

  const ctx = {
    fundRank: fund?.ok ? { byCode, sortedNets: nets } : { available: false, byCode: new Map(), sortedNets: [] },
    sentiment: sent?.ok
      ? {
          limitUpCount: sent.count ?? null,
          maxBoard: sent.maxBoard ?? null,
          brokenRate: sent.brokenRate ?? null,
          promoteRate,
          promotePoolSize,
          prevLimitUpPerf,
          prevLimitUpDate,
          indexChangePct,
          // 跌停家数：隔夜持股法的退潮门禁需要它。取不到保持 null，
          // 上层按「情绪不可判定」处理，绝不用 0 假装市场没有跌停。
          limitDownCount: sent.limitDownCount ?? null,
        }
      : null,
    board: boardCtx,
    limitPool,
    // 板块资金净流入排名（概念为主口径、行业作校验），隔夜持股法的板块条件
    boardFund: bf?.ok
      ? {
          available: true,
          main: bf.main,
          validate: bf.validate,
          conceptTop3: bf.conceptTop3 ?? [],
          industryTop3: bf.industryTop3 ?? [],
          conceptRank: bf.conceptRank ?? {},
          industryRank: bf.industryRank ?? {},
          unit: bf.unit ?? null,
          note: bf.note ?? null,
        }
      : { available: false, conceptTop3: [], industryTop3: [], conceptRank: {}, industryRank: {} },
    // 个股 → 所属东财板块（隔夜持股法用），由 runScreen 按候选池补全
    belong: { available: false, byCode: new Map() },
  };

  ctxMeta.limitPoolAvailable = limitPool.available;
  ctxMeta.limitPoolRows = limitPool.byCode.size;
  ctxMeta.prevLimitUpDate = prevLimitUpDate;
  ctxMeta.promoteRate = promoteRate;
  ctxMeta.prevLimitUpPerf = prevLimitUpPerf;

  ctxCache = { at: Date.now(), data: ctx, meta: ctxMeta };

  return { ctx, meta: ctxMeta };
}

/**
 * 复用已缓存的评分上下文（资金流 / 板块映射 / 涨停池），供单股评估使用。
 * 过期返回 null —— 调用方按「因子缺失」处理，不重新触发慢接口。
 */
export function getCachedCtx() {
  if (ctxCache.data && Date.now() - ctxCache.at < CTX_TTL) return ctxCache.data;
  return null;
}

/**
 * 取上下文：优先复用缓存，没有就现拉一次。
 *
 * 单股评估（/api/eval）在没有跑过选股时缓存是空的，
 * 若直接返回空对象，资金面/板块面会全部退化成 na ——
 * 详情页会显示「该股不在资金流排名中」，而实际只是没取过。
 * 这里改为按需加载（loadContext 自身有 60 秒缓存，不会每次都慢）。
 */
export async function ensureCtx() {
  const cached = getCachedCtx();
  if (cached) return cached;
  try {
    const { ctx } = await loadContext();
    return ctx ?? {};
  } catch {
    return {};
  }
}

/**
 * K 线取数：通达信（主数据源）优先，失败降级腾讯。
 * 统计各通道使用次数，结果里如实标注来源。
 */
const klineUsage = { tdx: 0, tencent: 0 };

async function fetchKlineMain(fullCode, period, count, fq) {
  try {
    const r = await tdx.fetchKline(fullCode, period, count, fq);
    // 即便接口 ok=true 也要校验真实性：通达信公共服务器对指数等标的的 bar
    // 缓冲区会解析损坏（仅首根正常、其余乱码），必须拦截以免污染精算。
    if (r?.ok && r.rows?.length && isKlineBatchValid(r.rows)) {
      klineUsage.tdx++;
      return { rows: r.rows, source: 'tdx', degraded: false, notes: r.notes ?? [] };
    }
  } catch {
    /* 主源失败，走降级 */
  }
  const t = await tencent.fetchKline(fullCode, period, fq, count);
  klineUsage.tencent++;
  return { rows: t.rows, source: 'tencent', degraded: true, notes: t.notes ?? [] };
}

async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= arr.length) return;
      out[i] = await fn(arr[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runScreen({
  sortBy = 'changePct',
  poolSize = 100,
  klineBars = 60,
  concurrency = 6,
  strategyIds = null,
  codes = null,
  /** 战法参数覆盖：{ [strategyId]: { paramKey: value } } */
  params = null,
} = {}) {
  const t0 = Date.now();
  const errors = [];

  /** 把腾讯行情行转成候选池条目（供自定义池使用） */
  const fromQuote = (q) => ({
    fullCode: q.fullCode,
    code: q.code,
    name: q.name,
    price: q.price,
    prevClose: q.prevClose,
    changePct: q.changePct,
    turnoverRate: q.turnoverRate,
    amountYuan: q.amountWan != null ? q.amountWan * 10000 : null,
    floatMvWan: q.floatMvYi != null ? q.floatMvYi * 10000 : null,
    pe: q.pe,
    fromQuote: true,
  });

  // 是否涉及隔夜持股法：它的取数需求（分时/上市日期/板块归属）与候选池口径都与其它战法不同
  const needOvernight = !strategyIds || !strategyIds.length || strategyIds.includes('overnight-hold');
  // 隔夜持股法要的是「涨幅 3-5%」这种中等涨幅，而候选池是按涨跌幅/成交额/换手率降序的 TopN。
  // 涨幅榜前排被涨停票占满，3-5% 的票排在 100 名开外，池子小于 400 时会被整段切掉
  // （实测池子 80 只时「涨幅 3-5%」这一条 pass=0，不是没有好票，是没进池子）。
  // 放大池子后靠下方快照预筛把精算量压回去，所以这里可以放心放宽。
  const OV_MIN_POOL = Number(process.env.OV_MIN_POOL || 600);
  const poolWanted = needOvernight ? Math.max(poolSize, OV_MIN_POOL) : poolSize;

  // ---- 候选池 ----
  let pool = [];
  let trading = false;
  let rankMs = 0;

  if (codes && codes.length) {
    // 自定义候选池：直接走腾讯批量行情，盘中盘后都可用
    const want = codes.slice(0, 300);
    const qmap = new Map();
    for (let i = 0; i < want.length; i += 150) {
      try {
        const q = await tencent.fetchQuotes(want.slice(i, i + 150));
        for (const row of q.rows) qmap.set(row.fullCode, row);
      } catch (e) {
        errors.push('自定义池行情失败：' + e.message);
      }
    }
    pool = want.map((c) => qmap.get(c)).filter(Boolean).map(fromQuote);
    trading = pool.some((r) => (r.price ?? 0) > 0);
    if (!pool.length) {
      return {
        ok: false,
        reason: '自定义候选池全部取数失败',
        trading: false,
        errors,
        elapsedMs: Date.now() - t0,
      };
    }
  } else {
    const perPage = Math.min(100, poolWanted);
    const pages = Math.ceil(poolWanted / perPage);
    for (let p = 1; p <= pages; p++) {
      try {
        const r = await rankSrc.fetchRank({ sortBy, page: p, perPage });
        rankMs += r.elapsedMs;
        trading = trading || r.trading;
        pool = pool.concat(r.rows);
      } catch (e) {
        errors.push('候选池第 ' + p + ' 页失败：' + e.message);
      }
    }
    pool = pool.slice(0, poolWanted);

    if (!pool.length) {
      return {
        ok: false,
        reason: '候选池为空' + (errors.length ? '：' + errors.join('；') : ''),
        trading,
        errors,
        elapsedMs: Date.now() - t0,
      };
    }

    // 未开盘时排行榜的排序字段全为 0，候选池无意义 —— 明确拒绝，不给误导性结果
    if (!trading) {
      return {
        ok: false,
        reason:
          '当前非交易时段（未开盘），排行榜的涨跌幅/成交额字段均为 0，无法生成有效候选池。请改用自选股作为候选池，或在交易时段执行。',
        trading: false,
        needCustomPool: true,
        elapsedMs: Date.now() - t0,
      };
    }
  }

  // 2. 快照预筛：只用行情快照字段就能否定的候选直接剔除，不再为它拉 K 线 / 分时 / 上市日期。
  //    隔着一层 K 线去判「涨幅 3-5%」「非创业板」没有意义 —— 快照里已经写死了答案。
  //    这一步是隔夜持股法能用大候选池的前提（见上方 OV_MIN_POOL 说明）。
  let prefiltered = 0;
  let poolScannedTotal = 0;
  if (strategyIds && strategyIds.length && pool.length) {
    const before = pool.length;
    poolScannedTotal = before;
    pool = pool.filter((row) => strategyIds.some((id) => prefilterSnap(id, row, params, { trading })));
    prefiltered = before - pool.length;
  }

  // 3. 精确行情补充（拿涨停价等），批量一次请求（只对预筛后的幸存者）
  const poolCodes = pool.map((r) => r.fullCode).filter(Boolean);
  const qmap = new Map();
  try {
    const chunks = [];
    for (let i = 0; i < poolCodes.length; i += 150) chunks.push(poolCodes.slice(i, i + 150));
    for (const c of chunks) {
      const q = await tencent.fetchQuotes(c);
      for (const row of q.rows) qmap.set(row.fullCode, row);
    }
  } catch (e) {
    errors.push('精确行情补充失败（不影响主流程）：' + e.message);
  }

  const { ctx, meta: ctxMeta } = await loadContext();

  // ST / *ST 排除（需求：首板打板、超短线等战法的明确排除项）
  let excludedSt = 0;
  const isSt = (name) => typeof name === 'string' && /\*?ST/i.test(name);

  // K 线通道降级统计：主通道被限流时会落到新浪不复权，需要如实告知
  let klineTdx = 0;
  let klineFallback = 0;

  // 隔夜持股法未命中的候选及其卡点（命中为 0 时用它解释「今天为什么没票」）
  const nearMiss = [];

  // 隔夜持股法需要的额外数据：分时序列（通达信 5 分钟）+ 上市日期（通达信财务）
  // + 板块归属（efinance 反向查询）。
  // 只在本次筛选包含该战法时才拉，避免拖慢其它战法。
  const intradayMap = new Map();
  const ipoMap = new Map();
  let overnightMeta = null;
  if (needOvernight && pool.length) {
    const tOv = Date.now();
    // 板块归属：一次批量请求（sidecar 内部 8 并发，结果缓存 6 小时）
    try {
      const bel = await sidecarJson('/board/belong?codes=' + pool.map((s) => s.code).join(','), 90000);
      if (bel?.ok) {
        ctx.belong = {
          available: true,
          byCode: new Map(Object.entries(bel.codeToBoards ?? {})),
          requested: bel.requested ?? 0,
          mapped: bel.mapped ?? 0,
          failed: bel.failed ?? 0,
        };
      }
    } catch {
      /* 取不到保持 available:false，对应条件标 na 而不是硬判失败 */
    }
    // 分时 + 上市日期：并发拉取，单只失败不影响整体
    const ovErrors = [];
    await mapLimit(pool, Math.max(4, concurrency), async (snap) => {
      try {
        const [it, fi] = await Promise.all([
          tdx.fetchIntraday(snap.fullCode, 60),
          tdx.fetchFinance(snap.fullCode),
        ]);
        if (it?.ok) {
          const st = intradayStats(it.rows);
          if (st) intradayMap.set(snap.fullCode, st);
        } else if (ovErrors.length < 5) {
          ovErrors.push(`intraday ${snap.fullCode}: ${it?.reason ?? '未知'}`);
        }
        if (fi?.ok && fi.ipoDate) ipoMap.set(snap.fullCode, fi.ipoDate);
      } catch (e) {
        if (ovErrors.length < 5) ovErrors.push(`${snap.fullCode}: ${String(e.message || e).slice(0, 100)}`);
      }
    });
    overnightMeta = {
      intradayGot: intradayMap.size,
      ipoGot: ipoMap.size,
      belongMapped: ctx.belong?.mapped ?? 0,
      belongFailed: ctx.belong?.failed ?? 0,
      elapsedMs: Date.now() - tOv,
      errors: ovErrors,
    };
    if (prefiltered) overnightMeta.prefiltered = prefiltered;
  }

  // 3. 批量 K 线 + 计算
  const screened = await mapLimit(pool, concurrency, async (snap) => {
    try {
      const k = await fetchKlineMain(snap.fullCode, 'day', klineBars, 'qfq');
      if (k.degraded) klineFallback++;
      else klineTdx++;
      const ind = computeIndicators(k.rows, snap.code);
      if (!ind) return null;
      // 分时结构指标（隔夜持股法用）；未取到时保持不存在，相关条件自动标 na
      const indX = intradayMap.has(snap.fullCode)
        ? { ...ind, intraday: intradayMap.get(snap.fullCode) }
        : ind;

      const exact = qmap.get(snap.fullCode);

      // 休市/未开盘时，行情快照的现价、涨跌幅、成交量均为 0。
      // 按需求「非交易时段保留收盘数据」，改用最后一根日 K 构造当日快照，
      // 并标注为收盘快照；换手率 K 线不提供，标为缺失（条件判定时不计入）。
      const closed = !trading;
      const kClose = ind.last.close;
      const kPrev = ind.prev.close;
      const price = closed ? kClose : (exact?.price ?? snap.price);
      const prevClose = closed ? kPrev : (exact?.prevClose ?? snap.prevClose);
      const changePct = closed
        ? kPrev
          ? ((kClose - kPrev) / kPrev) * 100
          : null
        : (exact?.changePct ?? snap.changePct);
      const turnoverRate = closed ? null : snap.turnoverRate;
      const floatMvYi = snap.floatMvWan != null ? snap.floatMvWan / 10000 : (exact?.floatMvYi ?? null);
      const pe = snap.pe ?? exact?.pe ?? null;

      const limitUp = inferLimitUp(snap.name, snap.code, prevClose, price, changePct);

      const snapForEngine = {
        code: snap.code,
        name: snap.name,
        changePct,
        turnoverRate,
        floatMvYi,
        pe,
        limitUp,
        // 上市日期（通达信财务接口），隔夜持股法的次新股排除条件
        ipoDate: ipoMap.get(snap.fullCode) ?? null,
        // 成交额（元）：超跌反弹的流动性排除条件需要
        amountYuan: closed ? null : snap.amountYuan,
      };

      const hits = evaluateStrategies(indX, snapForEngine, ctx, params);
      const wanted = strategyIds && strategyIds.length ? hits.filter((h) => strategyIds.includes(h.id)) : hits;
      if (!wanted.length) {
        // 隔夜持股法：未命中时留下「差在哪几条」，供结果页解释为什么今天没票。
        // 硬指标叠加后经常一只不剩，只回一个 0 命中，用户分不清是「今天真没票」还是「坏了」。
        if (needOvernight) {
          const dg = overnightDiagnose(indX, snapForEngine, ctx, params);
          if (dg) {
            nearMiss.push({
              code: snap.code,
              name: snap.name,
              changePct,
              turnoverRate: snap.turnoverRate,
              floatMvYi,
              blockedBy: dg.blockedBy,
              failed: dg.failed.slice(0, 4),
            });
          }
        }
        return null;
      }
      if (isSt(snap.name)) {
        excludedSt++;
        return null;
      }

      // 评分权重按主战法走：隔夜持股法有独立权重（技术35/资金25/情绪25/板块15，基本面0）
      const primaryId = wanted.find((h) => h.id === 'overnight-hold')?.id ?? wanted[0]?.id ?? null;
      const sc = scoreCandidate(indX, snapForEngine, ctx, primaryId);
      // 所属板块与板块涨跌幅（需求第三章列表字段）
      const hitBoardName = ctx.board?.codeToBoard?.get(String(snap.code)) ?? null;
      const hitBoardPct = hitBoardName != null ? (ctx.board?.boardPct?.get(hitBoardName) ?? null) : null;
      // 买卖价推荐：规则引擎按主战法计算（需求 7.3）
      const tradePlan = buildTradePlan({
        ind: indX,
        snap: { ...snapForEngine, price },
        strategyIds: wanted.map((h) => h.id),
      });

      return {
        fullCode: snap.fullCode,
        code: snap.code,
        name: snap.name,
        boardName: hitBoardName,
        boardPct: hitBoardPct,
        price,
        prevClose,
        changePct,
        turnoverRate: snap.turnoverRate,
        amountYuan: snap.amountYuan,
        floatMvYi,
        pe,
        limitUp,
        indicators: {
          ma5: ind.ma5,
          ma10: ind.ma10,
          ma20: ind.ma20,
          ma60: ind.ma60,
          volRatio20: ind.volRatio20,
          chg20: ind.chg20,
          bias20: ind.bias20,
          high30: ind.high30,
          bars: ind.bars,
        },
        strategies: wanted.map((h) => ({ id: h.id, name: h.name, hitRatio: h.hitRatio, conds: h.conds })),
        score: sc,
        tradePlan,
      };
    } catch (e) {
      errors.push(snap.code + ' K线失败：' + e.message);
      return null;
    }
  });

  const hits = screened.filter(Boolean).sort((a, b) => (b.score.total ?? -1) - (a.score.total ?? -1));

  // 隔夜持股法的情绪周期门禁（需求第三章）：退潮/冰点强制空仓
  const OV = STRATEGY_DEFS.find((s) => s.id === 'overnight-hold')?.params ?? {};
  const sv = ctx.sentiment;
  const isOvernightRetreat = !!(
    sv &&
    ((sv.promoteRate != null && sv.promoteRate < (OV.promoteRateWeak ?? 0.15)) ||
      (sv.limitDownCount != null && sv.limitDownCount > (OV.limitDownForceEmpty ?? 30)) ||
      (sv.indexChangePct != null && sv.indexChangePct < (OV.indexDropMax ?? -1.5)))
  );
  const overnightRetreatDetail = (c) => {
    const s = c?.sentiment ?? {};
    const parts = [];
    if (s.promoteRate != null && s.promoteRate < (OV.promoteRateWeak ?? 0.15))
      parts.push(`晋级率 ${(s.promoteRate * 100).toFixed(0)}% < ${(OV.promoteRateWeak ?? 0.15) * 100}%`);
    if (s.limitDownCount != null && s.limitDownCount > (OV.limitDownForceEmpty ?? 30))
      parts.push(`跌停 ${s.limitDownCount} 家 > ${OV.limitDownForceEmpty ?? 30} 家`);
    if (s.indexChangePct != null && s.indexChangePct < (OV.indexDropMax ?? -1.5))
      parts.push(`大盘 ${s.indexChangePct.toFixed(2)}% < ${OV.indexDropMax ?? -1.5}%`);
    return parts.join('；');
  };

  return {
    ok: true,
    trading,
    poolSize: pool.length,
    poolScanned: poolScannedTotal || pool.length,
    prefiltered,
    hitCount: hits.length,
    excludedSt,
    hits,
    elapsedMs: Date.now() - t0,
    rankMs,
    context: ctxMeta,
    overnight: overnightMeta
      ? {
          ...overnightMeta,
          // 命中为 0 时的解释：卡点统计 + 最接近的几只
          nearMiss: nearMiss.length
            ? nearMiss.sort((a, b) => a.blockedBy.length - b.blockedBy.length).slice(0, 5)
            : [],
          blockedTop: (() => {
            const m = new Map();
            for (const n of nearMiss) for (const k of n.blockedBy) m.set(k, (m.get(k) ?? 0) + 1);
            return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([key, count]) => ({ key, count }));
          })(),
          // 情绪周期门禁（需求第三章）：退潮/冰点强制空仓，不执行任何隔夜买入
          emptyBySentiment: isOvernightRetreat,
          retreatDetail: isOvernightRetreat ? overnightRetreatDetail(ctx) : null,
          emptyHint: isOvernightRetreat
            ? '当前市场情绪不适合隔夜持股，建议空仓'
            : '14:30 筛选后若无符合条件个股，必须空仓等待，不强行交易',
        }
      : null,
    errors: errors.slice(0, 10),
    source: {
      pool: '新浪全市场排行',
      quote: '腾讯财经',
      kline: klineTdx || klineFallback
        ? (klineTdx ? '通达信（主源）' : '腾讯财经（主源不可用，已降级）')
        : '—',
      klineTdx,
      klineFallback,
      klineUsage,
      // 隔夜持股法补充通道
      intraday: overnightMeta ? `通达信 5 分钟序列（${overnightMeta.intradayGot} 只）` : null,
      boardBelong: overnightMeta ? `efinance 板块反向查询（${overnightMeta.belongMapped} 只）` : null,
      ipoDate: overnightMeta ? `通达信财务接口（${overnightMeta.ipoGot} 只）` : null,
      fund: ctxMeta.fundAvailable ? 'AkShare 全市场资金流排名' : null,
      sentiment: ctxMeta.sentimentAvailable ? 'AkShare 东财涨停池' : null,
    },
    notes: [
      '候选池按' + (sortBy === 'amount' ? '成交额' : sortBy === 'turnover' ? '换手率' : '涨跌幅') + `降序取 ${poolScannedTotal || pool.length} 只，非全市场全量扫描`,
      prefiltered
        ? `快照预筛剔除 ${prefiltered} 只（用行情快照即可否定的：ST / 科创创业北交 / 涨幅不在区间 / 换手不在区间 / 市值不在区间），${pool.length} 只进入 K 线精算`
        : null,
      ctxMeta.fundAvailable
        ? `资金面已接入：全市场 ${ctxMeta.fundRows} 只资金流排名（AkShare）`
        : '资金面未接入：资金流排名取数失败，该因子不计入',
      ctxMeta.sentimentAvailable
        ? '情绪面已接入：涨停池（AkShare）'
        : '情绪面未接入：涨停池取数失败，该因子不计入',
      ctxMeta.limitPoolAvailable
        ? `连板结构已接入：涨停池 ${ctxMeta.limitPoolRows} 只（连板晋级战法的真实依据）`
        : '连板结构未接入：涨停池未取到，连板晋级战法本次不产生信号',
      ctxMeta.boardAvailable
        ? `板块面已接入：${ctxMeta.boardCount} 个板块 / ${ctxMeta.boardMappedStocks} 只个股映射（AkShare）`
        : '板块面未接入：板块映射取数失败，该因子不计入',
      excludedSt ? `已按战法规则排除 ${excludedSt} 只 ST / *ST 个股` : null,
      klineFallback
        ? `K 线主源（通达信）本次 ${klineFallback} 只降级到腾讯（通达信 ${klineTdx} 只成功）`
        : klineTdx
          ? `K 线全部来自通达信主源（${klineTdx} 只）`
          : null,
      trading
        ? '当前为交易时段，快照来自实时行情'
        : '当前非交易时段：现价/涨跌幅改用最后一根日 K（收盘快照），换手率无数据已标缺失并不参与判定',
    ].filter(Boolean),
  };
}
