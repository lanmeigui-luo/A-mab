/**
 * 新浪财经备用行情源（公开接口，免 Key，需 Referer）
 * 仅用于腾讯通道不可用时的降级：只取价格类字段。
 *
 * ⚠️ 单位说明：新浪对个股返回的成交量单位是「股」，对指数与腾讯一致，
 * 同一接口内单位不统一。为避免千倍误差，本模块**不解析成交量**，
 * 成交量字段返回 null 并由 unitNotes 标注，禁止前端猜测换算。
 */

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36',
  Referer: 'https://finance.sina.com.cn',
};

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

export async function fetchQuotes(codes) {
  if (!codes.length) return { rows: [], elapsedMs: 0, source: 'sina' };
  const url = 'https://hq.sinajs.cn/list=' + codes.join(',');
  const { text, elapsedMs } = await httpGet(url);
  const rows = [];

  for (const line of text.split(';')) {
    const m = line.match(/hq_str_([a-z]{2}\d{6})="([^"]*)"/);
    if (!m) continue;
    const [, fullCode, payload] = m;
    const f = payload.split(',');
    if (f.length < 32) continue;
    const price = num(f[3]);
    const prevClose = num(f[2]);
    const amount = num(f[9]); // 元
    rows.push({
      code: fullCode.slice(2),
      fullCode,
      market: fullCode.slice(0, 2),
      name: f[0] || '',
      price,
      prevClose,
      open: num(f[1]),
      high: num(f[4]),
      low: num(f[5]),
      volume: null,
      change: price != null && prevClose != null ? +(price - prevClose).toFixed(4) : null,
      changePct:
        price != null && prevClose != null && prevClose !== 0
          ? +(((price - prevClose) / prevClose) * 100).toFixed(2)
          : null,
      amountWan: amount != null ? +(amount / 10000).toFixed(2) : null,
      turnoverRate: null,
      pe: null,
      pb: null,
      amplitude:
        num(f[4]) != null && num(f[5]) != null && prevClose
          ? +(((num(f[4]) - num(f[5])) / prevClose) * 100).toFixed(2)
          : null,
      floatMvYi: null,
      totalMvYi: null,
      limitUpPrice: null,
      volumeRatio: null,
      updatedAt: (f[30] || '') + ' ' + (f[31] || ''),
      unitNotes: ['sina: volume 未解析（单位不统一）', 'sina: 换手率/量比/PE/PB 不提供'],
    });
  }
  return { rows, elapsedMs, source: 'sina', degraded: true };
}
