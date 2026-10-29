/**
 * 领域类型
 * 约定：所有「拿不到」的数值字段一律为 null，前端渲染为「—」或「待接入」，
 * 禁止使用 0 / 占位值 / 模拟值填充。
 */

export interface Quote {
  code: string;
  fullCode: string;
  market: 'sh' | 'sz' | 'bj';
  name: string;
  price: number | null;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  /** 成交量，单位：手 */
  volume: number | null;
  change: number | null;
  changePct: number | null;
  /** 成交额，单位：万元 */
  amountWan: number | null;
  /** 换手率 % */
  turnoverRate: number | null;
  pe: number | null;
  pb: number | null;
  amplitude: number | null;
  floatMvYi: number | null;
  totalMvYi: number | null;
  limitUpPrice: number | null;
  /** 量比：当前无免费通道提供 */
  volumeRatio: number | null;
  updatedAt: string;
  unitNotes?: string[];
}

export interface QuoteResponse {
  rows: Quote[];
  missing?: string[];
  source: 'tencent' | 'sina';
  degraded: boolean;
  sourceLabel: string;
  elapsedMs: number;
  fetchedAt: string;
  notes: string[];
  cached?: boolean;
  cacheAgeMs?: number;
}

export interface KlineRow {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  /** 成交量，单位：手 */
  volume: number;
}

export interface KlineResponse {
  rows: KlineRow[];
  source: string;
  sourceLabel: string;
  period: string;
  fq: string;
  elapsedMs: number;
  fetchedAt: string;
  notes: string[];
}

export interface MinuteRow {
  /** 时间，格式 HHMM，如 "0930" */
  time: string;
  /** 当前价 */
  price: number;
  /** 累计成交量（手），后端直供 */
  cumVolume: number;
  /** 累计成交额（元），后端直供 */
  cumAmount: number;
  /** 分时均价（元），后端自算（累计成交额 / 累计股数） */
  avg: number | null;
  /** 每分钟增量成交量（手），前端由 cumVolume 差分得到，用于分时副图 */
  vol: number;
}

export interface MinuteResponse {
  rows: MinuteRow[];
  source: string;
  /** 前端友好的数据源标签（腾讯分时） */
  sourceLabel: string;
  date: string;
  elapsedMs: number;
  fetchedAt: string;
  notes: string[];
}

export interface MarketStats {
  available: boolean;
  reason?: string | null;
  up: number | null;
  down: number | null;
  flat: number | null;
  limitUp: number | null;
  limitDown: number | null;
  suspension?: number | null;
  source?: string;
  sourceLabel?: string;
  elapsedMs?: number | null;
  fetchedAt?: string;
}

export interface SentimentStats {
  available: boolean;
  reason?: string | null;
  limitUpCount: number | null;
  maxBoard: number | null;
  brokenCount: number | null;
  brokenRate: number | null;
  /** 晋级率：昨日连板池今日继续封板比例；池 <10 家为 null */
  promoteRate?: number | null;
  promotePoolSize?: number | null;
  /** 昨日涨停今日表现：昨日涨停池个股今日平均涨跌幅 % */
  prevLimitUpPerf?: number | null;
  prevLimitUpDate?: string | null;
  sourceLabel?: string;
  fetchedAt?: string;
}

/** 分市场成交额（需求第五章） */
export interface TurnoverStats {
  available: boolean;
  reason?: string | null;
  shYuan: number | null;
  szYuan: number | null;
  bjYuan: number | null;
  totalYuan: number | null;
  /** 较上一交易日同期增减；无通道时为 null */
  vsPrevYuan: number | null;
  vsPrevReason?: string | null;
  sourceLabel?: string;
  note?: string | null;
}

export interface HealthInfo {
  ok: boolean;
  channels: Record<string, { ok: number; fail: number; lastMs: number | null; lastError: string | null; lastOkAt?: string | null }>;
  /** 主数据源：通达信直连（pytdx），不再依赖 WorkBuddy 会话 */
  tdxMcp: {
    available: boolean;
    mode?: string;
    reason?: string | null;
    plan?: string;
    sample?: { price?: number | null; changePct?: number | null } | null;
    poolSize?: number | null;
    elapsedMs?: number | null;
    fetchedAt?: string | null;
    calls?: { ok: number; fail: number };
  };
}

/** 大盘指数定义（需求第五章） */
export const INDEX_DEFS = [
  { code: 'sh000001', name: '上证指数' },
  { code: 'sz399001', name: '深证成指' },
  { code: 'sz399006', name: '创业板指' },
  { code: 'sh000688', name: '科创50' },
  { code: 'bj899050', name: '北证50' },
  { code: 'sh000300', name: '沪深300' },
  { code: 'sh000905', name: '中证500' },
  { code: 'sh000852', name: '中证1000' },
] as const;
