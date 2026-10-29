import type {
  HealthInfo,
  KlineResponse,
  MarketStats,
  MinuteResponse,
  MinuteRow,
  QuoteResponse,
  SentimentStats,
  TurnoverStats,
} from '@/domain/types';
import type { BoardConsResponse, BoardListResponse, BoardType } from '@/domain/board';
import type { ScreenResponse, StrategyDef, StrategyHit, TradePlan, ScoreResult } from '@/domain/strategy';
import type { WinRateSnapshot } from '@/domain/winrate';

/** 能力矩阵（阶段 0 产物）的数据形状，只声明 UI 需要的字段 */
export interface CapabilityMatrixData {
  meta?: Record<string, unknown>;
  sources?: {
    id: string;
    name: string;
    role: string;
    authState?: string | null;
    installed?: boolean;
    reachable?: boolean;
    note?: string | null;
    coverage?: string | null;
  }[];
  fields?: {
    id: string;
    category: string;
    field: string;
    status: string;
    primarySource: string;
    endpoint?: string | null;
    path?: string | null;
    unit?: string | null;
    refreshInterval?: string | null;
    staleness?: string | null;
    latency?: string | null;
    coverage?: string | null;
    note?: string | null;
  }[];
  environmentFindings?: { issue: string; evidence: string; impact: string; workaround: string }[];
  unresolved?: string[];
}

/** 单股评估响应（/api/eval） */
export interface EvalResponse {
  ok: boolean;
  reason?: string | null;
  code?: string;
  name?: string;
  price?: number | null;
  klineSource?: string;
  klineDegraded?: boolean;
  indicators?: Record<string, unknown>;
  strategies?: StrategyHit[];
  score?: ScoreResult | null;
  tradePlan?: TradePlan | null;
  contextAvailable?: { fund: boolean; board: boolean; limitPool: boolean };
  elapsedMs?: number | null;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('响应不是合法 JSON：' + text.slice(0, 120));
  }
  if (!res.ok) {
    throw new Error(payload?.error || ('HTTP ' + res.status));
  }
  return payload as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('响应不是合法 JSON：' + text.slice(0, 120));
  }
  if (!res.ok) throw new Error(payload?.error || 'HTTP ' + res.status);
  return payload as T;
}

export const marketApi = {
  health: () => get<HealthInfo>('/api/health'),
  quotes: (codes: string[]) => get<QuoteResponse>('/api/quote?codes=' + encodeURIComponent(codes.join(','))),
  kline: (code: string, period = 'day', fq = 'qfq', count = 120) =>
    get<KlineResponse>(
      `/api/kline?code=${encodeURIComponent(code)}&period=${period}&fq=${fq}&count=${count}`,
    ),
  /** 分时（腾讯当日分钟序列）。code 为带市场前缀的 fullCode，如 sh600519 */
  minute: async (code: string): Promise<MinuteResponse> => {
    const raw = await get<MinuteResponse>('/api/minute?code=' + encodeURIComponent(code));
    const src = raw.rows as unknown as Array<{
      time: string;
      price: number;
      cumVolume: number;
      cumAmount: number;
      avg: number | null;
    }>;
    const rows: MinuteRow[] = src.map((x, i) => ({
      time: x.time,
      price: x.price,
      cumVolume: x.cumVolume,
      cumAmount: x.cumAmount,
      avg: x.avg,
      // 增量成交量 = 当前累计量 − 前一根累计量（首根为 0）
      vol: i > 0 ? Math.max(0, x.cumVolume - src[i - 1].cumVolume) : 0,
    }));
    return { ...raw, rows, sourceLabel: '腾讯分时' };
  },
  marketStats: () => get<MarketStats>('/api/market-stats'),
  sentiment: () => get<SentimentStats>('/api/sentiment'),
  turnover: () => get<TurnoverStats>('/api/turnover'),
  capability: () => get<{ ok: boolean; matrix?: CapabilityMatrixData; reason?: string }>('/api/capability'),

  boardList: (type: BoardType) =>
    get<BoardListResponse>('/api/board/list?type=' + encodeURIComponent(type)),

  boardCons: (sector: string) =>
    get<BoardConsResponse>('/api/board/cons?sector=' + encodeURIComponent(sector)),

  /** 分钟 K 线（AkShare → 东财）。period: 1/5/15/30/60 */
  klineMin: (code6: string, period = '5', adjust = 'qfq', limit = 320) =>
    get<KlineResponse>(
      `/api/kline-min?code=${encodeURIComponent(code6)}&period=${period}&adjust=${adjust}&limit=${limit}`,
    ),

  strategies: () => get<{ rows: StrategyDef[]; source: string; note: string }>('/api/strategies'),

  /** 单股评估：命中战法 + 评分 + 买卖计划 */
  eval: (fullCode: string) => get<EvalResponse>('/api/eval?code=' + encodeURIComponent(fullCode)),

  /** 选股：参数覆盖走 POST body（GET 时用需求默认值） */
  screen: (
    opts: {
      sortBy?: string;
      poolSize?: number;
      ids?: string[];
      codes?: string[];
      params?: Record<string, Record<string, number>> | null;
    } = {},
  ) => {
    const ps = new URLSearchParams();
    if (opts.sortBy) ps.set('sortBy', opts.sortBy);
    if (opts.poolSize) ps.set('poolSize', String(opts.poolSize));
    if (opts.ids?.length) ps.set('ids', opts.ids.join(','));
    if (opts.codes?.length) ps.set('codes', opts.codes.join(','));
    const hasParams = opts.params && Object.keys(opts.params).length > 0;
    if (!hasParams) return get<ScreenResponse>('/api/screen?' + ps.toString());
    return post<ScreenResponse>('/api/screen?' + ps.toString(), { params: opts.params });
  },

  /** 收盘快照（口径 A）：列出有快照的日期，供前端补拉缺失日 */
  winrateSnapshotDates: () =>
    get<{ ok: boolean; dates: string[] }>('/api/winrate-snapshot-dates'),

  /** 收盘快照（口径 A）：拉单日快照，前端转为 WinRateRecord（priceSource='close'） */
  winrateSnapshot: (date: string) =>
    get<{ ok: boolean; snapshot: WinRateSnapshot } | { ok: false; reason: string }>(
      '/api/winrate-snapshot?date=' + encodeURIComponent(date),
    ),
};
