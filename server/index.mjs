/**
 * A股博弈雷达 · 本地行情代理（零第三方依赖，Node 内置 http）
 *
 * 设计原则：
 * 1. 浏览器只访问同源 /api/*，不直连任何公开行情接口（规避跨域、限频与来源暴露）
 * 2. 主通道腾讯 → 失败自动降级新浪，降级状态必须回传给前端并显示在 UI
 * 3. 任何字段拿不到就返回 null + notes，绝不用占位值或模拟值填充
 * 4. 全部响应携带 source / elapsedMs / fetchedAt，供前端做「数据来源」标注
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { URL, fileURLToPath } from 'node:url';
import path from 'node:path';
import * as tdx from './sources/tdx.mjs';
import { computeMarketStatus, loadHolidays } from './marketStatus.mjs';
import * as tencent from './sources/tencent.mjs';
import * as sina from './sources/sina.mjs';
import * as rankSrc from './sources/sina_rank.mjs';
import { runScreen, getCachedCtx, ensureCtx } from './screen.mjs';
import { isKlineBatchValid } from './klineValidate.mjs';
import { STRATEGY_DEFS } from './strategies/index.mjs';
import { evaluateStrategies, scoreCandidate, computeIndicators, inferLimitUp } from './strategies/index.mjs';
import { buildTradePlan } from './strategies/tradeplan.mjs';
import { intradayStats } from './strategies/indicators.mjs';

const PORT = Number(process.env.PORT || 8787);
const SIDECAR = process.env.SIDECAR || 'http://127.0.0.1:8788';

// 静态托管：仅当 APP_STATIC_DIR 显式设置时启用（生产态由 main.js 注入；dev 不设置，走 vite dev server）。
// 不依赖 NODE_ENV，避免误判。SPA fallback：非 /api/* 的未知路径一律返回 index.html（见 serveStatic）。
const STATIC_DIR = process.env.APP_STATIC_DIR || '';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

// 节假日集合（data/holidays.json），加载失败不影响启动，仅周末兜底仍可用。
let HOLIDAYS = new Set();
loadHolidays(fileURLToPath(new URL('../data/holidays.json', import.meta.url)))
  .then((s) => { HOLIDAYS = s; console.log('[radar-server] holidays loaded: ' + s.size + ' days'); })
  .catch((e) => { console.warn('[radar-server] holidays.json 加载失败，仅周末兜底: ' + (e && e.message || e)); });

/** 转发到 AkShare sidecar；失败时返回 ok=false，绝不编造 */
async function sidecar(path, timeoutMs = 30000) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(SIDECAR + path, { signal: ctrl.signal });
    const j = await r.json();
    mark('akshare', !!j.ok, Date.now() - t0, j.ok ? null : j.reason);
    channelHealth.akshare.enabled = true;
    return j;
  } catch (e) {
    mark('akshare', false, Date.now() - t0, e.message);
    return { ok: false, reason: 'AkShare sidecar 不可达：' + e.message, source: 'akshare' };
  } finally {
    clearTimeout(timer);
  }
}

/** @type {Map<string, {at:number, ttl:number, data:any}>} */
const cache = new Map();

const channelHealth = {
  // 主数据源：通达信（pytdx 直连行情服务器，不依赖 WorkBuddy 会话）
  tdx: { ok: 0, fail: 0, lastMs: null, lastError: null, lastOkAt: null },
  tencent: { ok: 0, fail: 0, lastMs: null, lastError: null, lastOkAt: null },
  sina: { ok: 0, fail: 0, lastMs: null, lastError: null, lastOkAt: null },
  akshare: { ok: 0, fail: 0, lastMs: null, lastError: null, lastOkAt: null, enabled: false },
};

function mark(channel, ok, ms, err) {
  const h = channelHealth[channel];
  if (!h) return;
  if (ok) {
    h.ok++;
    h.lastMs = ms;
    h.lastOkAt = new Date().toISOString();
    h.lastError = null;
  } else {
    h.fail++;
    h.lastError = String(err || 'unknown').slice(0, 200);
  }
}

async function withCache(key, ttlMs, producer) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < hit.ttl) {
    return { ...hit.data, cached: true, cacheAgeMs: now - hit.at };
  }
  const data = await producer();
  cache.set(key, { at: now, ttl: ttlMs, data });
  return { ...data, cached: false };
}

// ---------- 健康探测辅助 ----------

// sidecar 当前提供的能力（静态清单；路由真实可用即视为具备）
const SIDECAR_CAPABILITIES = ['board', 'market', 'fund', 'limitup', 'kline-min', 'belong', 'fund-rank'];

/**
 * sidecar 健康：区分三种状态
 *  - 精简版禁用（SIDECAR_DISABLED=1）：disabled=true，不探测
 *  - 进程活着但 akshare 不可用（功能降级）：processAlive=true, available=false
 *  - 进程不可达（崩溃/未启动）：processAlive=false, available=false
 * 关键：不再靠「探测 0 端口失败」推断禁用 —— 禁用由 main.js 显式传 SIDECAR_DISABLED。
 */
async function sidecarHealth() {
  const disabled = process.env.SIDECAR_DISABLED === '1';
  if (disabled) {
    return { processAlive: false, available: false, disabled: true, lastUpdate: null, error: null, capabilities: [] };
  }
  const base = process.env.SIDECAR || 'http://127.0.0.1:8788';
  try {
    const r = await fetch(base + '/health', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) {
      return { processAlive: true, available: false, disabled: false, lastUpdate: null, error: 'sidecar /health 返回 ' + r.status, capabilities: [] };
    }
    const j = await r.json();
    const akOk = j.akshareAvailable === true;
    return {
      processAlive: true,
      available: akOk,
      disabled: false,
      lastUpdate: j.time || new Date().toISOString(),
      error: akOk ? null : 'akshare 不可用（进程存活但功能降级）',
      capabilities: SIDECAR_CAPABILITIES,
    };
  } catch (e) {
    return { processAlive: false, available: false, disabled: false, lastUpdate: null, error: 'sidecar 不可达：' + (e && e.message || e), capabilities: [] };
  }
}

/** backup 通道（腾讯/新浪）最近一次成功时间戳；不做额外探活，由 channelHealth 累计推导 */
function latestBackupUpdate() {
  const ts = [channelHealth.tencent.lastOkAt, channelHealth.sina.lastOkAt].filter(Boolean);
  return ts.length ? ts.sort().pop() : null;
}

// ---------- 静态托管（生产态） ----------

/**
 * 仅当 APP_STATIC_DIR 设置时调用。SPA fallback：非 /api/* 的未知路径一律返回 index.html。
 * 防御路径穿越：归一化后必须仍在 STATIC_DIR 内。
 */
async function serveStatic(res, p) {
  // 归一化基准目录为 OS 原生绝对路径：避免 STATIC_DIR 传入正斜杠时，与 path.join 产出的反斜杠
  // 在路径穿越守卫里比较失配（否则全部静态请求都会误判为 403）。
  const base = path.resolve(STATIC_DIR);
  // 去掉 URL 路径开头的斜杠：否则 path.resolve(base, '/assets/app.js') 会把 '/' 当作盘符根绝对路径，丢弃 base。
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const st = await stat(target);
    if (st.isFile()) {
      const body = await readFile(target);
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
      return;
    }
  } catch { /* 落到 SPA fallback */ }
  try {
    const idx = await readFile(path.join(base, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(idx);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

/** 指数代码：不需要换手率/市值/PE，主源数据已够用，不必请求补充源 */
const INDEX_CODES = new Set([
  'sh000001', 'sz399001', 'sz399006', 'sh000688', 'bj899050',
  'sh000300', 'sh000905', 'sh000852',
]);

/**
 * 行情：通达信（主数据源，pytdx 直连）优先，失败降级腾讯 → 新浪。
 *
 * 主源 + 补充源分工（需求 1.1）：
 *   通达信直连给出：现价/昨收/开/高/低/成交量/成交额/五档盘口
 *   通达信不提供：股票名称、换手率、流通市值、PE → 由腾讯作为补充源补齐
 * 指数不请求补充源（主源字段已足够）。
 */
async function getQuotes(codes) {
  // 1) 主数据源：通达信
  let tdxRes = null;
  try {
    tdxRes = await tdx.fetchQuotes(codes);
    if (tdxRes?.ok) mark('tdx', true, tdxRes.elapsedMs);
    else mark('tdx', false, null, tdxRes?.reason ?? 'tdx 返回 ok=false');
  } catch (e) {
    mark('tdx', false, null, e.message);
  }

  if (tdxRes?.ok && tdxRes.rows?.length) {
    const needExtra = codes.some((c) => !INDEX_CODES.has(c));
    let extra = null;
    let supplementedBy = null;
    if (needExtra) {
      try {
        const t = await tencent.fetchQuotes(codes);
        mark('tencent', true, t.elapsedMs);
        extra = new Map(t.rows.map((r) => [r.fullCode, r]));
        supplementedBy = 'tencent';
      } catch (e) {
        // 补充源失败不影响主源结果，但必须如实记录（名称会缺失）
        mark('tencent', false, null, e.message);
      }
    }

    const rows = tdxRes.rows.map((r) => {
      const x = extra?.get(r.fullCode);
      return {
        ...r,
        // 主源没有的字段由补充源补齐；补不到就保持 null，不用推断值
        name: x?.name ?? null,
        turnoverRate: x?.turnoverRate ?? null,
        floatMvYi: x?.floatMvYi ?? null,
        pe: x?.pe ?? null,
        pb: x?.pb ?? null,
        amplitude: x?.amplitude ?? null,
        limitUpPrice: x?.limitUpPrice ?? null,
        volumeRatio: null, // 量比两个通道都不提供，保持「待接入」
        updatedAt: r.servertime ?? new Date().toISOString().slice(11, 19),
      };
    });

    const notes = [];
    if (supplementedBy) {
      notes.push('名称/换手率/流通市值/PE 由补充源（腾讯财经）补齐 —— 通达信行情接口不提供这些字段');
    }
    notes.push('量比两个通道均不提供，显示「待接入」而非推测值');
    if (!needExtra) notes.push('指数行情全部来自通达信主源，未请求补充源');

    return {
      rows,
      missing: rows.some((r) => r.turnoverRate === null) ? ['换手率'] : [],
      source: 'tdx',
      degraded: false,
      supplementedBy,
      sourceLabel: supplementedBy ? '通达信（主源）+ 腾讯（补充）' : '通达信（直连主源）',
      elapsedMs: tdxRes.elapsedMs,
      fetchedAt: new Date().toISOString(),
      notes,
    };
  }

  // 2) 主源不可用 → 降级腾讯
  try {
    const r = await tencent.fetchQuotes(codes);
    mark('tencent', true, r.elapsedMs);
    return {
      rows: r.rows,
      missing: r.missing || [],
      source: 'tencent',
      degraded: true,
      sourceLabel: '腾讯财经（通达信主源不可用，已降级）',
      elapsedMs: r.elapsedMs,
      fetchedAt: new Date().toISOString(),
      notes: [
        '通达信主源不可用，已降级腾讯通道',
        ...(r.rows.some((x) => x.volumeRatio === null)
          ? ['量比不由该通道提供，显示为「待接入」而非推测值']
          : []),
      ],
    };
  } catch (e) {
    mark('tencent', false, null, e.message);
  }

  // 3) 最后降级新浪
  try {
    const r = await sina.fetchQuotes(codes);
    mark('sina', true, r.elapsedMs);
    return {
      rows: r.rows,
      missing: [],
      source: 'sina',
      degraded: true,
      sourceLabel: '新浪财经（二级降级通道）',
      elapsedMs: r.elapsedMs,
      fetchedAt: new Date().toISOString(),
      notes: ['通达信主源与腾讯通道均不可用，已降级新浪'],
    };
  } catch (e2) {
    mark('sina', false, null, e2.message);
    throw new Error('全部行情通道不可用：tdx/tencent/sina 均失败');
  }
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
    res.end();
    return;
  }

  // 生产态静态托管：非 /api/* 的请求交给前端（SPA fallback）。dev 下 APP_STATIC_DIR 未设置，跳过，走 vite dev server。
  if (STATIC_DIR && !p.startsWith('/api/')) {
    return serveStatic(res, p);
  }

  try {
    if (p === '/api/health') {
      // 通达信是主数据源，每次 health 都真实探测一次，不缓存旧结论
      const tdxLive = await tdx.health().catch(() => ({ ok: false, reason: 'tdx 服务不可达' }));
      const tdxStats = tdx.channelStats();
      const sc = await sidecarHealth();
      const nowIso = new Date().toISOString();
      return json(res, 200, {
        ok: true,
        time: nowIso,
        marketStatus: computeMarketStatus(new Date(), HOLIDAYS),
        sources: [
          {
            id: 'tdx',
            available: !!tdxLive?.ok,
            degraded: false,
            lastUpdate: tdxLive?.fetchedAt ?? (tdxLive?.ok ? nowIso : null),
            error: tdxLive?.ok ? null : (tdxLive?.reason ?? 'tdx 服务不可达'),
          },
          {
            id: 'sidecar',
            processAlive: sc.processAlive,
            available: sc.available,
            disabled: sc.disabled,
            lastUpdate: sc.lastUpdate,
            error: sc.error,
            capabilities: sc.capabilities,
          },
          {
            id: 'backup',
            lastUpdate: latestBackupUpdate(), // 仅时间戳，前端按新鲜度自行判断，不做 available 布尔 / 额外探活
          },
        ],
        sidecar: {
          available: sc.available,
          disabled: sc.disabled,
          capabilities: sc.capabilities,
        },
        mock: process.env.MOCK === '1',
        channels: channelHealth,
        tdxMcp: {
          available: !!tdxLive?.ok,
          mode: 'pytdx 直连行情服务器',
          reason: tdxLive?.ok ? null : (tdxLive?.reason ?? 'tdx 服务不可达'),
          plan: '已脱离 WorkBuddy 会话限制：本机 tdx/server.py 用 pytdx 直连通达信行情服务器，常驻可用',
          // 真实连接指标
          sample: tdxLive?.sample ?? null,
          poolSize: tdxLive?.poolSize ?? null,
          elapsedMs: tdxLive?.elapsedMs ?? null,
          fetchedAt: tdxLive?.fetchedAt ?? null,
          calls: { ok: tdxStats.ok, fail: tdxStats.fail },
        },
      });
    }

    if (p === '/api/quote') {
      const codes = (url.searchParams.get('codes') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 200);
      if (!codes.length) return json(res, 400, { error: 'codes 不能为空' });
      const data = await withCache('quote:' + codes.join(','), 2000, () => getQuotes(codes));
      return json(res, 200, data);
    }

    if (p === '/api/kline') {
      const code = url.searchParams.get('code');
      const period = url.searchParams.get('period') || 'day';
      const fq = url.searchParams.get('fq') || 'qfq';
      const count = Math.min(Number(url.searchParams.get('count') || 120), 800);
      if (!code) return json(res, 400, { error: 'code 不能为空' });
      const data = await withCache(`kline:${code}:${period}:${fq}:${count}`, 30000, async () => {
        // 1) 主数据源：通达信（日线支持自算前/后复权；分钟线原生不复权）
        let r = null;
        let tdxCorrupt = false;
        try {
          r = await tdx.fetchKline(code, period, count, fq);
        } catch (e) {
          mark('tdx', false, null, e.message);
        }
        // 即便接口 ok=true，也要校验数据真实性 —— 通达信公共服务器对指数等标的
        // 的 bar 缓冲区会解析损坏（仅首根正常，其余日期/成交量全是乱码），必须拦截。
        if (r?.ok && r.rows?.length && isKlineBatchValid(r.rows)) {
          return {
            rows: r.rows,
            source: 'tdx',
            sourceLabel: '通达信（直连主源）',
            period,
            fq: r.fq,
            degraded: !!r.degraded,
            elapsedMs: r.elapsedMs,
            fetchedAt: new Date().toISOString(),
            notes: r.notes ?? [],
          };
        }
        if (r?.ok && r.rows?.length && !isKlineBatchValid(r.rows)) {
          // 连接本身成功，但数据损坏：不标记通道失败，只记入降级原因
          tdxCorrupt = true;
        }
        // 2) 降级腾讯（腾讯原生支持复权，且日线会再降级新浪兜底指数）
        try {
          const t = await tencent.fetchKline(code, period, fq, count);
          mark('tencent', true, t.elapsedMs);
          return {
            rows: t.rows,
            source: 'tencent',
            sourceLabel: '腾讯财经（通达信 K 线数据异常，已降级）',
            period,
            fq: t.fq ?? fq,
            degraded: true,
            elapsedMs: t.elapsedMs,
            fetchedAt: new Date().toISOString(),
            notes: [
              (tdxCorrupt
                ? '通达信 K 线返回数据异常（疑似公共服务器 bar 解析损坏，已自动拦截）'
                : '通达信 K 线不可用' + (r?.reason ? '：' + r.reason : '')) + '，已降级腾讯/新浪通道',
              ...(t.notes ?? []),
            ],
          };
        } catch (e) {
          mark('tencent', false, null, e.message);
          return {
            rows: [],
            ok: false,
            reason: '通达信与腾讯 K 线通道均不可用：' + e.message,
            source: 'none',
            fetchedAt: new Date().toISOString(),
          };
        }
      });
      return json(res, 200, data);
    }

    if (p === '/api/minute') {
      const code = url.searchParams.get('code');
      if (!code) return json(res, 400, { error: 'code 不能为空' });
      const data = await withCache('minute:' + code, 5000, async () => {
        const r = await tencent.fetchMinute(code);
        mark('tencent', true, r.elapsedMs);
        return { ...r, fetchedAt: new Date().toISOString() };
      });
      return json(res, 200, data);
    }

    // 战法选股：手动触发，结果缓存 30 秒
    if (p === '/api/strategies') {
      return json(res, 200, {
        rows: STRATEGY_DEFS,
        source: 'local-rule-engine',
        note: '规则引擎本地实现，不依赖模型；参数为需求默认值，可调',
      });
    }

    if (p === '/api/screen') {
      const sortBy = url.searchParams.get('sortBy') || 'changePct';
      // 上限 5000：隔夜持股法需要覆盖「涨幅 3-5%」这种中等涨幅，
      // 而它在涨跌幅榜上排在 100 名开外，池子太小会整段切掉（精算量由快照预筛兜住）。
      // 3000 / 5000 属用户可选的「宽扫描」档位，分页取数 + 快照预筛即可承接。
      const poolSize = Math.min(Number(url.searchParams.get('poolSize') || 100), 5000);
      const ids = (url.searchParams.get('ids') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const codes = (url.searchParams.get('codes') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      // 战法参数覆盖（前端可调），POST body 传入；GET 时为 null，走需求默认值
      let params = null;
      if (req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        try {
          params = JSON.parse(Buffer.concat(chunks).toString('utf8')).params ?? null;
        } catch {
          params = null;
        }
      }
      const data = await withCache(
        `screen:${codes.length ? 'custom:' + codes.join('|') : sortBy + ':' + poolSize}:${ids.join('|')}:${params ? JSON.stringify(params) : ''}`,
        120000,
        () => runScreen({ sortBy, poolSize, strategyIds: ids.length ? ids : null, codes: codes.length ? codes : null, params }),
      );
      return json(res, 200, data);
    }

    if (p === '/api/rank') {
      const sortBy = url.searchParams.get('sortBy') || 'changePct';
      const perPage = Math.min(Number(url.searchParams.get('num') || 50), 100);
      const data = await withCache(`rank:${sortBy}:${perPage}`, 5000, async () => {
        const r = await rankSrc.fetchRank({ sortBy, page: 1, perPage });
        mark('sina', true, r.elapsedMs);
        return { ...r, fetchedAt: new Date().toISOString() };
      });
      return json(res, 200, data);
    }

    // 模型深度分析代理：Key 由前端解密后随请求帶來，服务端仅转发，不落盘、不记录
    if (p === '/api/llm/chat' && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json(res, 400, { error: '请求体不是合法 JSON' });
      }
      const { baseUrl, apiKey, model, messages, temperature = 0.3, maxTokens = 2048 } = body || {};
      if (!baseUrl || !apiKey || !model || !Array.isArray(messages)) {
        return json(res, 400, { error: '缺少 baseUrl / apiKey / model / messages' });
      }

      const endpoint = String(baseUrl).replace(/\/+$/, '') + '/chat/completions';
      const t0 = Date.now();
      try {
        const upstream = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + apiKey,
            'HTTP-Referer': 'http://127.0.0.1:5173',
            'X-Title': 'A股博弈雷达',
          },
          body: JSON.stringify({
            model,
            messages,
            stream: true,
            temperature,
            max_tokens: maxTokens,
          }),
        });

        if (!upstream.ok || !upstream.body) {
          const txt = await upstream.text().catch(() => '');
          return json(res, 502, {
            error: '模型服务返回 ' + upstream.status + '：' + txt.slice(0, 300),
          });
        }

        // 流式转发：把上游 SSE 原样透传给浏览器
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'X-Accel-Buffering': 'no',
        });
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(decoder.decode(value, { stream: true }));
          }
        } catch {
          /* 客户端中断 */
        }
        res.write('data: [DONE]\n\n');
        res.end();
        console.log('[llm] ok ' + model + ' ' + (Date.now() - t0) + 'ms');
      } catch (e) {
        return json(res, 502, { error: '调用模型服务失败：' + String(e.message || e) });
      }
      return;
    }

    /**
 * 情绪派生指标（需求第五章 / 需求 2.3）：
 *  - promoteRate 晋级率 = 昨日连板池（连板数≥2）中今日继续封板的比例；池 <10 家记 null
 *  - prevLimitUpPerf 昨日涨停今日表现 = 昨日涨停池个股今日平均涨跌幅
 * 全部基于真实数据，取不到时返回 null，不填 0。
 */
async function emotionExtras(todayPool) {
  const empty = {
    promoteRate: null,
    promotePoolSize: null,
    prevLimitUpPerf: null,
    prevLimitUpDate: null,
    emotionSource: null,
  };
  try {
    const prev = await sidecar('/market/prev-limitup', 300000);
    if (!prev?.ok || !Array.isArray(prev.items) || !prev.items.length) return empty;

    // 今日封板代码集合
    const todayCodes = new Set();
    const src = todayPool?.boardsByCode
      ? Object.keys(todayPool.boardsByCode)
      : Array.isArray(todayPool?.rows)
        ? todayPool.rows.map((r) => String(r['代码'] || '').padStart(6, '0'))
        : [];
    for (const c of src) todayCodes.add(String(c).padStart(6, '0'));

    const prevBoards = prev.items.filter((x) => (x.board ?? 1) >= 2);
    let promoteRate = null;
    if (prevBoards.length >= 10 && todayCodes.size) {
      const promoted = prevBoards.filter((x) => todayCodes.has(String(x.code).padStart(6, '0'))).length;
      promoteRate = promoted / prevBoards.length;
    }

    // 昨日涨停股今日表现
    let prevLimitUpPerf = null;
    try {
      const toFull = (code) => {
        const c = String(code).padStart(6, '0');
        return (/^(6|9)/.test(c) ? 'sh' : /^(4|8)/.test(c) ? 'bj' : 'sz') + c;
      };
      const want = prev.items.map((x) => toFull(x.code));
      const qmap = new Map();
      for (let i = 0; i < want.length; i += 150) {
        const q = await tencent.fetchQuotes(want.slice(i, i + 150));
        for (const row of q.rows) qmap.set(String(row.code).padStart(6, '0'), row);
      }
      const pcts = [];
      for (const x of prev.items) {
        const row = qmap.get(String(x.code).padStart(6, '0'));
        if (row?.changePct != null) pcts.push(row.changePct);
      }
      if (pcts.length) prevLimitUpPerf = pcts.reduce((a, b) => a + b, 0) / pcts.length;
    } catch {
      /* 保持 null */
    }

    return {
      promoteRate,
      promotePoolSize: prevBoards.length || null,
      prevLimitUpPerf,
      prevLimitUpDate: prev.date ?? null,
      emotionSource: 'AkShare 昨日涨停池 + 腾讯今日行情',
    };
  } catch {
    return empty;
  }
}

/**
 * 单股评估：拉行情 + K线 → 算指标 → 跑 11 战法 → 评分 → 买卖计划。
 * 复用选股流水线的同一套规则，保证详情页与选股结果口径一致。
 */
async function evalStock(fullCode, params) {
  const t0 = Date.now();
  try {
    const q = await tencent.fetchQuotes([fullCode]);
    const row = q.rows?.[0];
    if (!row) return { ok: false, reason: '行情取数失败：' + fullCode };

    const k = await tencent.fetchKline(fullCode, 'day', 'qfq', 120);
    const ind = computeIndicators(k.rows, row.code);
    if (!ind) return { ok: false, reason: 'K 线为空：' + fullCode };

    const price = row.price ?? ind.close;
    const prevClose = row.prevClose ?? ind.prev.close;
    const snap = {
      code: row.code,
      name: row.name,
      changePct: row.changePct ?? null,
      turnoverRate: row.turnoverRate ?? null,
      floatMvYi: row.floatMvYi ?? null,
      pe: row.pe ?? null,
      amountYuan: row.amountWan != null ? row.amountWan * 10000 : null,
      limitUp: inferLimitUp(row.name, row.code, prevClose, price, row.changePct ?? null),
      ipoDate: null,
    };

    // 上下文复用选股流水线的缓存；没跑过选股时按需加载一次，
    // 否则资金面/板块面会全部退化成 na（详情页会误报「不在资金流排名中」）
    const baseCtx = await ensureCtx();

    // 隔夜持股法的补充数据：分时序列 + 上市日期（通达信），板块归属（efinance）。
    // 只在需要时拉取；取不到就保持缺失，相关条件标 na。
    let intraday = null;
    try {
      const [it, fi] = await Promise.all([
        tdx.fetchIntraday(fullCode, 60),
        tdx.fetchFinance(fullCode),
      ]);
      if (it?.ok) intraday = intradayStats(it.rows);
      if (fi?.ok) snap.ipoDate = fi.ipoDate ?? null;
    } catch {
      /* 缺失即 na */
    }
    const indX = intraday ? { ...ind, intraday } : ind;

    // 板块归属与资金流排名：缓存上下文里没有就单独取一次
    const ctx = { ...baseCtx };
    if (!ctx.belong?.byCode?.get(String(row.code)) || !ctx.boardFund?.available) {
      try {
        const [bel, bf] = await Promise.all([
          sidecar('/board/belong?codes=' + row.code),
          sidecar('/board/fund'),
        ]);
        if (bel?.ok) {
          ctx.belong = {
            available: true,
            byCode: new Map(Object.entries(bel.codeToBoards ?? {})),
          };
        }
        if (bf?.ok && !ctx.boardFund?.available) {
          ctx.boardFund = {
            available: true,
            main: bf.main,
            validate: bf.validate,
            conceptTop3: bf.conceptTop3 ?? [],
            industryTop3: bf.industryTop3 ?? [],
            conceptRank: bf.conceptRank ?? {},
            industryRank: bf.industryRank ?? {},
          };
        }
      } catch {
        /* 同上 */
      }
    }

    const hits = evaluateStrategies(indX, snap, ctx, params);
    const primaryId = hits.find((h) => h.id === 'overnight-hold')?.id ?? hits[0]?.id ?? null;
    const score = scoreCandidate(indX, snap, ctx, primaryId);
    const tradePlan = buildTradePlan({ ind: indX, snap: { ...snap, price }, strategyIds: hits.map((h) => h.id) });

    return {
      ok: true,
      code: row.code,
      name: row.name,
      price,
      klineSource: k.source ?? 'tencent',
      klineDegraded: !!k.degraded,
      indicators: {
        ma5: ind.ma5, ma10: ind.ma10, ma20: ind.ma20, ma60: ind.ma60,
        ma3: ind.ma3, bias20: ind.bias20, bias60: ind.bias60,
        volRatio20: ind.volRatio20, volRatio5: ind.volRatio5,
        chg20: ind.chg20, drawdown30: ind.drawdown30, high30: ind.high30, low30: ind.low30,
        rsi14: ind.rsi14, macd: ind.macd, kdj: ind.kdj, boll: ind.boll, atr14: ind.atr14,
        bars: ind.bars,
      },
      /** 分时结构（隔夜持股法用）：缺失为 null，前端显示「未取到」 */
      intraday,
      strategies: hits,
      score,
      tradePlan,
      contextAvailable: {
        fund: !!ctx.fundRank?.byCode?.size,
        board: !!ctx.board?.available,
        limitPool: !!ctx.limitPool?.available,
        // 隔夜持股法依赖的补充通道
        boardFund: !!ctx.boardFund?.available,
        belong: !!ctx.belong?.available,
      },
      elapsedMs: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, reason: String(e.message || e), elapsedMs: Date.now() - t0 };
  }
}

/** 分市场成交额（需求第五章）：
 * 沪市/深市/北交所分别取自对应指数的成交额字段（腾讯行情 [37] 成交额万元）。
 * 这不是「全市场个股加总」，口径是指数成分成交额，UI 必须如实标注。
 */
async function marketTurnover() {
  try {
    const q = await tencent.fetchQuotes(['sh000001', 'sz399001', 'bj899050']);
    const byCode = new Map(q.rows.map((r) => [r.fullCode, r]));
    const pick = (c) => {
      const r = byCode.get(c);
      return r?.amountWan != null ? r.amountWan * 10000 : null;
    };
    const sh = pick('sh000001');
    const sz = pick('sz399001');
    const bj = pick('bj899050');
    const total = sh != null || sz != null || bj != null ? (sh ?? 0) + (sz ?? 0) + (bj ?? 0) : null;
    // 盘前/非交易时段指数成交额字段为 0，此时不能显示「0 亿」，如实标为未开始
    if (total === 0) {
      return {
        available: false,
        reason: '当前非交易时段，指数成交额为 0（开盘后自动恢复）',
        shYuan: null,
        szYuan: null,
        bjYuan: null,
        totalYuan: null,
        vsPrevYuan: null,
        vsPrevReason: null,
        sourceLabel: '腾讯（指数成交额）',
        note: '口径为指数成分成交额，非全市场个股加总',
      };
    }
    return {
      available: total != null,
      shYuan: sh,
      szYuan: sz,
      bjYuan: bj,
      totalYuan: total,
      // 较上一交易日同期增减：需要昨日同期成交额，当前无通道，如实标 null
      vsPrevYuan: null,
      vsPrevReason: '较上一交易日同期增减需昨日分时成交额序列，当前数据源未提供，不做估算',
      source: '腾讯财经（指数成交额口径）',
      sourceLabel: '腾讯（指数成交额）',
      note: '口径为指数成分成交额，非全市场个股加总；北证50 仅覆盖北交所样本',
    };
  } catch (e) {
    return { available: false, reason: String(e.message || e) };
  }
}

    // 数据源能力矩阵（阶段 0 产物）：只读磁盘 JSON，不改写任何字段
    if (p === '/api/capability') {
      try {
        const raw = await readFile(new URL('../capability-matrix.json', import.meta.url), 'utf8');
        return json(res, 200, { ok: true, matrix: JSON.parse(raw) });
      } catch (e) {
        return json(res, 200, { ok: false, reason: '能力矩阵读取失败：' + String(e.message || e) });
      }
    }

    // 单股评估：指标 + 命中战法 + 评分 + 买卖计划（供个股详情的战法信号区 / 买卖计划区）
    if (p === '/api/eval') {
      const code = url.searchParams.get('code');
      if (!code) return json(res, 400, { ok: false, reason: '缺少 code 参数' });
      const data = await withCache('eval:' + code, 30000, () => evalStock(code, null));
      return json(res, 200, data);
    }

    // 分市场成交额（需求第五章）
    if (p === '/api/turnover') {
      const data = await withCache('turnover', 5000, () => marketTurnover());
      return json(res, 200, { ...data, elapsedMs: null });
    }

    // 涨跌家数：走 AkShare sidecar（乐咕市场活跃度）
    if (p === '/api/market-stats') {
      const data = await withCache('market-stats', 10000, () => sidecar('/market/stats'));
      return json(res, 200, {
        available: !!data.ok,
        reason: data.ok ? null : data.reason,
        up: data.up ?? null,
        down: data.down ?? null,
        flat: data.flat ?? null,
        limitUp: data.limitUp ?? null,
        limitDown: data.limitDown ?? null,
        suspension: data.suspension ?? null,
        source: 'akshare',
        sourceLabel: 'AkShare（乐咕市场活跃度）',
        elapsedMs: data.elapsedMs ?? null,
        fetchedAt: data.fetchedAt ?? new Date().toISOString(),
        cached: data.cached,
      });
    }

    // 市场情绪：涨停池（涨停家数 / 连板高度 / 炸板率）
    if (p === '/api/sentiment') {
      const data = await withCache('sentiment', 30000, () => sidecar('/market/limitup'));
      return json(res, 200, {
        available: !!data.ok,
        reason: data.ok ? null : data.reason,
        limitUpCount: data.count ?? null,
        maxBoard: data.maxBoard ?? null,
        brokenCount: data.brokenCount ?? null,
        brokenRate: data.brokenRate ?? null,
        // 跌停家数：隔夜持股法的退潮门禁（跌停 > 30 家强制空仓）
        limitDownCount: data.limitDownCount ?? null,
        // 晋级率与「昨日涨停今日表现」：昨日涨停池 + 今日行情真算（需求第五章情绪指标）
        ...(await emotionExtras(data)),
        sourceLabel: 'AkShare（东财涨停池）',
        elapsedMs: data.elapsedMs ?? null,
        fetchedAt: data.fetchedAt ?? new Date().toISOString(),
        cached: data.cached,
      });
    }

    // 全市场个股资金流排名（约 5s，sidecar 内已缓存 60s）
    if (p === '/api/fund-rank') {
      const data = await withCache('fund-rank', 60000, () => sidecar('/fund/rank', 60000));
      return json(res, 200, data);
    }

    // 分钟 K 线（AkShare sidecar → 东财）
    if (p === '/api/kline-min') {
      const code = url.searchParams.get('code');
      const period = url.searchParams.get('period') || '5';
      const adjust = url.searchParams.get('adjust') || 'qfq';
      const limit = Math.min(Number(url.searchParams.get('limit') || 320), 1000);
      if (!code) return json(res, 400, { ok: false, reason: '缺少 code 参数' });
      const data = await withCache(`kmin:${code}:${period}:${adjust}:${limit}`, 20000, () =>
        sidecar(
          `/kline/min?code=${encodeURIComponent(code)}&period=${period}&adjust=${adjust}&limit=${limit}`,
        ),
      );
      // 统一字段名（sidecar 返回 datetime），并把日期压缩为 MM-DD HH:mm 便于绘图
      if (data?.ok && Array.isArray(data.rows)) {
        data.rows = data.rows.map((r) => ({
          date: String(r.datetime ?? '').slice(5, 16),
          open: r.open,
          close: r.close,
          high: r.high,
          low: r.low,
          volume: r.volume,
        }));
      }
      return json(res, 200, data);
    }

    // 板块列表：industry / concept / area（AkShare sidecar → 新浪）
    if (p === '/api/board/list') {
      const btype = url.searchParams.get('type') || 'industry';
      const data = await withCache('board-list:' + btype, 30000, () =>
        sidecar('/board/list?type=' + encodeURIComponent(btype)),
      );
      return json(res, 200, data);
    }

    // 板块成分股：sector 为板块 label
    if (p === '/api/board/cons') {
      const sector = url.searchParams.get('sector');
      if (!sector) return json(res, 400, { ok: false, reason: '缺少 sector 参数' });
      const data = await withCache('board-cons:' + sector, 30000, () =>
        sidecar('/board/cons?sector=' + encodeURIComponent(sector)),
      );
      return json(res, 200, data);
    }

    return json(res, 404, { error: 'not found: ' + p });
  } catch (err) {
    return json(res, 502, {
      error: String(err.message || err),
      channels: channelHealth,
      hint: '上游行情通道异常，前端应显示错误态而非模拟数据',
    });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[radar-server] http://127.0.0.1:' + PORT);
  console.log('[radar-server] 主数据源: 通达信（pytdx 直连，tdx/server.py:8789）');
  console.log('[radar-server] 补充源: 腾讯财经（名称/换手率/市值/PE）· 备用降级: 腾讯 → 新浪');
});
