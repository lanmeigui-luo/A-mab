/**
 * 新浪全市场排行（选股候选池）
 * https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData
 *
 * 这是目前唯一已验证可用的「全市场排序取候选池」免费通道：
 * 可按涨跌幅 / 成交额 / 换手率排序，一次取多只，无需逐只查询。
 *
 * 字段：symbol code name trade pricechange changepercent buy sell settlement
 *       open high low volume amount ticktime per pb mktcap nmc turnoverratio
 *
 * ⚠️ 单位说明：volume 为「股」，amount 为「元」，mktcap/nmc 为「万元」。
 * ⚠️ 非交易时段 trade/volume/amount 均为 0 —— 这是真实的休市状态，
 *    后端会据此判定「未开盘」，前端显示休市，不得用占位值填充。
 */

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36',
  Referer: 'https://vip.stock.finance.sina.com.cn/',
};

export const SORT_FIELDS = {
  changePct: 'changepercent',
  amount: 'amount',
  turnover: 'turnoverratio',
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * @param {Object} opt
 * @param {'changePct'|'amount'|'turnover'} opt.sortBy
 * @param {number} opt.page 1 起
 * @param {number} opt.perPage 每页条数（新浪单页上限约 100）
 * @param {boolean} opt.asc 是否升序
 */
export async function fetchRank({ sortBy = 'changePct', page = 1, perPage = 100, asc = false } = {}) {
  const sort = SORT_FIELDS[sortBy] || 'changepercent';
  const url =
    'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData' +
    `?page=${page}&num=${perPage}&sort=${sort}&asc=${asc ? 1 : 0}&node=hs_a&symbol=&_s_r_a=page`;

  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let text;
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }
  const elapsedMs = Date.now() - t0;

  // 新浪返回的是类 JSON（键名带引号、值为字符串），且空数据返回 "null"
  if (!text || text.trim() === 'null' || text.trim() === '') {
    return { rows: [], elapsedMs, source: 'sina-rank', trading: false };
  }

  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    throw new Error('新浪排行返回非 JSON：' + text.slice(0, 120));
  }

  const rows = (Array.isArray(arr) ? arr : []).map((r) => ({
    fullCode: r.symbol,
    code: r.code,
    name: r.name,
    price: num(r.trade),
    prevClose: num(r.settlement),
    open: num(r.open),
    high: num(r.high),
    low: num(r.low),
    change: num(r.pricechange),
    changePct: num(r.changepercent),
    /** 成交量：股 */
    volumeShares: num(r.volume),
    /** 成交额：元 */
    amountYuan: num(r.amount),
    turnoverRate: num(r.turnoverratio),
    pe: num(r.per),
    pb: num(r.pb),
    /** 总市值：万元 */
    totalMvWan: num(r.mktcap),
    floatMvWan: num(r.nmc),
    tickTime: r.ticktime || '',
  }));

  // 休市判定：前 20 只现价全为 0（或空）→ 视为未开盘/休市
  const probe = rows.slice(0, 20);
  const trading = probe.length > 0 && probe.some((r) => (r.price ?? 0) > 0);

  return { rows, elapsedMs, source: 'sina-rank', trading };
}
