/**
 * 腾讯财经行情源（公开接口，免 Key）
 * 已验证：qt.gtimg.cn 批量实时行情、ifzq.gtimg.cn K 线，返回 GBK 编码。
 *（web.ifzq.gtimg.cn 已被 WAF 拦截，勿改回）
 *
 * 字段索引（qt.gtimg.cn，v_xxx="..." 按 ~ 切分）：
 *  1 名称  2 代码  3 现价  4 昨收  5 今开  6 成交量(手)
 *  30 时间  31 涨跌额  32 涨跌幅  33 最高  34 最低
 *  35 价/量/额  36 成交量  37 成交额(万元)  38 换手率  39 PE(TTM)
 *  43 振幅  44 流通市值(亿)  45 总市值(亿)  46 PB  47 涨停价
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://gu.qq.com' };

/**
 * K 线域名必须用 ifzq.gtimg.cn，不能用 web.ifzq.gtimg.cn。
 * 实测：web.ifzq.gtimg.cn 的 fqkline 接口被腾讯 WAF 拦截，
 * 返回 501 并跳转 waf.tencent.com/501page.html；ifzq.gtimg.cn 返回同样的
 * 数据且三个接口（fqkline / mkline / minute）全部正常。
 */
const KLINE_HOST = 'https://ifzq.gtimg.cn';

/** GBK 解码：腾讯/新浪均返回 GBK，必须显式解码，否则中文名称乱码 */
function decodeGBK(buf) {
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

async function httpGet(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    return { text: decodeGBK(buf), elapsedMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 批量实时行情
 * @param {string[]} codes 形如 ['sh000001','sz399001']
 */
export async function fetchQuotes(codes) {
  if (!codes.length) return { rows: [], elapsedMs: 0, source: 'tencent' };
  const url = 'https://qt.gtimg.cn/q=' + codes.join(',');
  const { text, elapsedMs } = await httpGet(url);
  const rows = [];
  const missing = [];
  const requested = new Set(codes);

  for (const line of text.split(';')) {
    const m = line.match(/v_([a-z]{2}\d{6})="([^"]*)"/);
    if (!m) continue;
    const [, fullCode, payload] = m;
    const f = payload.split('~');
    if (f.length < 40) continue;
    const market = fullCode.slice(0, 2);
    requested.delete(fullCode);
    rows.push({
      code: f[2] || fullCode.slice(2),
      fullCode,
      market,
      name: f[1] || '',
      price: num(f[3]),
      prevClose: num(f[4]),
      open: num(f[5]),
      volume: num(f[6]),          // 手
      change: num(f[31]),
      changePct: num(f[32]),
      high: num(f[33]),
      low: num(f[34]),
      amountWan: num(f[37]),      // 成交额，万元
      turnoverRate: num(f[38]),   // 换手率 %
      pe: num(f[39]),
      amplitude: num(f[43]),
      floatMvYi: num(f[44]),      // 流通市值 亿
      totalMvYi: num(f[45]),
      pb: num(f[46]),
      limitUpPrice: num(f[47]) && num(f[47]) > 0 ? num(f[47]) : null,
      volumeRatio: null,          // 腾讯不提供量比，需另源或自算
      updatedAt: f[30] || '',
    });
  }
  for (const c of requested) missing.push(c);
  return { rows, missing, elapsedMs, source: 'tencent' };
}

const PERIOD_MAP = {
  day: 'day',
  week: 'week',
  month: 'month',
  // 分钟线走独立的 mkline 接口，fqkline 不支持（实测返回 code=1）
  m5: 'm5',
  m15: 'm15',
  m30: 'm30',
  m60: 'm60',
};

/**
 * 降级通道：新浪日/周/月线（不复权）。
 * 触发原因：腾讯 ifzq.gtimg.cn 在批量请求后会被 WAF 按 IP 限流，
 * 返回 501 并跳转 waf.tencent.com/501page.html（实测连续 5 次均 501，
 * 加 Referer 无效），此时必须有可用通道，否则整条选股流水线归零。
 * 单位换算：新浪 volume 单位为「股」，腾讯为「手」，统一转成手（/100）。
 */
async function fetchSinaPeriodKline(fullCode, p, count) {
  const scale = p === 'day' ? 240 : p === 'week' ? 1200 : p === 'month' ? 7200 : null;
  if (!scale) throw new Error('sina fallback 不支持周期: ' + p);
  const url =
    'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData' +
    `?symbol=${fullCode}&scale=${scale}&ma=no&datalen=${count}`;
  const { text, elapsedMs } = await httpGet(url, 10000);
  const arr = JSON.parse(text);
  if (!Array.isArray(arr) || !arr.length) throw new Error('sina kline empty: ' + fullCode);
  const raw = arr.map((r) => [
    String(r.day).slice(0, 10),
    Number(r.open),
    Number(r.close),
    Number(r.high),
    Number(r.low),
    Number(r.volume) / 100,
  ]);
  return { raw, elapsedMs, source: 'sina', adjust: 'none' };
}

/** 日/周/月线：fqkline 接口，返回 key 形如 qfqday / hfqday / day */
async function fetchPeriodKline(fullCode, p, fq, count) {
  try {
    const fqParam = fq === 'qfq' ? 'qfq' : fq === 'hfq' ? 'hfq' : '';
    const param = [fullCode, p, '', '', count, fqParam].join(',');
    const url = KLINE_HOST + '/appstock/app/fqkline/get?param=' + param;
    const { text, elapsedMs } = await httpGet(url, 10000);
    const json = JSON.parse(text);
    if (json.code !== 0) throw new Error('fqkline api code=' + json.code);

    const node = json.data?.[fullCode];
    if (!node) throw new Error('fqkline empty: ' + fullCode);

    // 注意：腾讯返回的是「复权前缀 + 周期」，如 qfqday，不是 dayqfq
    const prefix = fq === 'qfq' ? 'qfq' : fq === 'hfq' ? 'hfq' : '';
    const key = prefix + p;
    const raw = node[key] || node[p] || [];
    if (!raw.length) throw new Error('fqkline no rows: ' + fullCode);
    return { raw, elapsedMs, source: 'tencent', adjust: fq || 'none' };
  } catch (e) {
    // 主通道失败（含 WAF 501）→ 降级新浪，并把降级事实带回给调用方
    const fb = await fetchSinaPeriodKline(fullCode, p, count);
    return { ...fb, degraded: true, degradeReason: String(e.message || e).slice(0, 120) };
  }
}

/** 分钟线：mkline 接口（无复权参数） */
async function fetchMinuteKline(fullCode, p, count) {
  const param = [fullCode, p, '', count].join(',');
  const url = KLINE_HOST + '/appstock/app/kline/mkline?param=' + param;
  const { text, elapsedMs } = await httpGet(url, 10000);
  const json = JSON.parse(text);
  if (json.code !== 0) throw new Error('mkline api code=' + json.code);
  const node = json.data?.[fullCode];
  const raw = node?.[p] || [];
  return { raw, elapsedMs };
}

export async function fetchKline(fullCode, period = 'day', fq = 'qfq', count = 120) {
  const p = PERIOD_MAP[period] || 'day';
  const isMinute = p.startsWith('m') && p !== 'month';
  const res = isMinute
    ? await fetchMinuteKline(fullCode, p, count)
    : await fetchPeriodKline(fullCode, p, fq, count);
  const { raw, elapsedMs } = res;

  // 每条：[日期, 开, 收, 高, 低, 量(手)]
  const rows = raw.map((r) => ({
    date: String(r[0]),
    open: Number(r[1]),
    close: Number(r[2]),
    high: Number(r[3]),
    low: Number(r[4]),
    volume: Number(r[5]),
  }));

  const notes = isMinute ? ['分钟线通道不提供复权参数，返回未复权数据'] : [];
  // 降级到新浪时如实标注：数据源与复权口径都与主通道不同
  if (res.degraded) {
    notes.push(
      `主通道（腾讯 fqkline）不可用，已降级新浪日线：${res.degradeReason}。` +
        '降级数据为不复权口径，除权日附近均线会有偏差。',
    );
  }

  return {
    rows,
    elapsedMs,
    source: res.source || 'tencent',
    period: p,
    // 分钟线不支持复权参数，如实标注，不假装已复权
    fq: isMinute ? 'none' : res.adjust || fq,
    degraded: !!res.degraded,
    notes,
  };
}

/** 分时（当日分钟序列） */
export async function fetchMinute(fullCode) {
  const url = KLINE_HOST + '/appstock/app/minute/query?code=' + fullCode;
  const { text, elapsedMs } = await httpGet(url, 10000);
  const json = JSON.parse(text);
  const node = json.data?.[fullCode];
  const raw = node?.data?.data || [];

  // 每条："0930 1236.00 349 43136400"
  // 实测第 3 字段为**累计**成交量(手)，第 4 字段为**累计**成交额(元)。
  // 均价线必须自算：均价 = 累计成交额 / (累计成交量 × 100)，不可直接取第 4 字段。
  const rows = raw.map((s) => {
    const p = s.trim().split(/\s+/);
    const cumVolHands = Number(p[2]);
    const cumAmountYuan = Number(p[3]);
    const shares = cumVolHands * 100;
    return {
      time: p[0],
      price: Number(p[1]),
      cumVolume: cumVolHands,
      cumAmount: cumAmountYuan,
      avg: shares > 0 ? +(cumAmountYuan / shares).toFixed(3) : null,
    };
  });
  return {
    rows,
    elapsedMs,
    source: 'tencent',
    date: node?.data?.date || '',
    notes: ['分时均价由累计成交额/累计股数自算，非上游直供字段'],
  };
}
