/**
 * 通达信数据源（主数据源）
 *
 * 与 tdx MCP 的根本区别：
 *   WorkBuddy 的「通达信 MCP」工具只在会话内有效，常驻 Node 服务拿不到。
 *   这里走本机 tdx/server.py（pytdx 直连通达信行情服务器），
 *   不依赖会话、不依赖 OAuth，因此可以作为真正的主数据源常驻运行。
 *
 * 能力边界（实测，不夸大）：
 *   ✅ 现价/昨收/开/高/低/成交量(手)/成交额(元)/五档盘口
 *   ✅ 日/周/月/1分/5分/15分/30分/60分 K 线
 *   ✅ 沪 sh / 深 sz / 科创 / 创业板 / 北交所 bj(920xxx) / 指数
 *   ❌ 换手率、流通市值、PE —— 通达信行情接口不提供，需补充源（腾讯）补齐
 */

const TDX = process.env.TDX || 'http://127.0.0.1:8789';

/** 通道健康统计，供 /api/health 展示 */
const stats = { ok: 0, fail: 0, lastMs: null, lastError: null };

function noteOk(ms) {
  stats.ok++;
  stats.lastMs = ms;
  stats.lastError = null;
}
function noteFail(msg) {
  stats.fail++;
  stats.lastError = String(msg).slice(0, 160);
}

async function getJson(path, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const t0 = Date.now();
  try {
    const r = await fetch(TDX + path, { signal: ctrl.signal });
    return await r.json();
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

export function channelStats() {
  return { ...stats };
}

export async function health() {
  const j = await getJson('/health', 6000);
  if (j?.ok) noteOk(j.elapsedMs ?? null);
  else noteFail(j?.reason ?? 'tdx 服务不可用');
  return j;
}

/** 批量行情：分片并发，避免单次请求过大 */
export async function fetchQuotes(fullCodes, chunkSize = 60) {
  const out = [];
  let lastMeta = null;
  for (let i = 0; i < fullCodes.length; i += chunkSize) {
    const part = fullCodes.slice(i, i + chunkSize);
    const j = await getJson('/quotes?codes=' + encodeURIComponent(part.join(',')), 15000);
    lastMeta = j;
    if (!j?.ok) {
      noteFail(j?.reason ?? 'quotes 失败');
      continue;
    }
    noteOk(j.elapsedMs ?? null);
    out.push(...(j.rows ?? []));
  }
  return {
    ok: out.length > 0,
    rows: out,
    elapsedMs: lastMeta?.elapsedMs ?? null,
    server: lastMeta?.server ?? '通达信行情服务器（pytdx 直连）',
    sourceLabel: '通达信（直连）',
    requested: fullCodes.length,
    count: out.length,
  };
}

/**
 * K 线。period: day/week/month/m1/m5/m15/m30/m60
 * 通达信返回不复权数据；复权由调用方决定（后端暂无复权因子，如实标注 none）。
 */
export async function fetchKline(fullCode, period = 'day', count = 120, fq = 'qfq') {
  const adj = fq === 'qfq' || fq === 'hfq' ? fq : 'none';
  const j = await getJson(
    `/kline?code=${encodeURIComponent(fullCode)}&period=${period}&count=${count}&adjust=${adj}`,
    15000,
  );
  if (!j?.ok) {
    noteFail(j?.reason ?? 'kline 失败');
    return { ok: false, reason: j?.reason ?? '通达信 K 线取数失败' };
  }
  noteOk(j.elapsedMs ?? null);
  const notes = [];
  if (j.fqNote) notes.push(j.fqNote);
  // 请求复权但通达信没给成，必须如实告知，不能假装已复权
  if (adj !== 'none' && j.fq !== adj) {
    notes.push(`请求 ${adj.toUpperCase()} 未生效，本次实际为 ${j.fq === 'none' ? '不复权' : j.fq}`);
  }
  return {
    ok: true,
    rows: j.rows ?? [],
    elapsedMs: j.elapsedMs ?? null,
    source: 'tdx',
    sourceLabel: '通达信（直连）',
    period,
    fq: j.fq ?? 'none',
    degraded: adj !== 'none' && j.fq !== adj,
    notes,
  };
}

/**
 * 当日分时序列（5 分钟 K 线回溯）。
 * 用于隔夜持股法的分时均价线、全天水上、阶梯放量、尾盘创新高等判定。
 * 注意：这是**额外一次请求/只**，因此只在选中需要分时的战法时才调用。
 */
export async function fetchIntraday(fullCode, count = 60) {
  const j = await getJson(
    `/intraday?code=${encodeURIComponent(fullCode)}&count=${count}`,
    12000,
  );
  if (!j?.ok) {
    noteFail(j?.reason ?? 'intraday 失败');
    return { ok: false, reason: j?.reason ?? '通达信分时取数失败' };
  }
  noteOk(j.elapsedMs ?? null);
  return {
    ok: true,
    rows: j.rows ?? [],
    date: j.date ?? null,
    elapsedMs: j.elapsedMs ?? null,
    source: 'tdx',
    sourceLabel: '通达信（5 分钟序列）',
  };
}

/** 公司财务概览（核心是上市日期，用于次新股排除） */
export async function fetchFinance(fullCode) {
  const j = await getJson('/finance?code=' + encodeURIComponent(fullCode), 12000);
  if (!j?.ok) {
    noteFail(j?.reason ?? 'finance 失败');
    return { ok: false, reason: j?.reason ?? '通达信财务信息取数失败' };
  }
  noteOk(null);
  return { ok: true, ipoDate: j.ipoDate ?? null, floatShares: j.floatShares ?? null };
}

/** 除权除息（供后续自算复权） */
export async function fetchXdxr(fullCode) {
  return getJson('/xdxr?code=' + encodeURIComponent(fullCode), 15000);
}
