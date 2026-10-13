import type {
  HealthInfo,
  KlineResponse,
  MarketStats,
  MinuteResponse,
  QuoteResponse,
  SentimentStats,
  TurnoverStats,
} from '@/domain/types';
import type { BoardConsResponse, BoardListResponse, BoardType } from '@/domain/board';
import type { ScreenResponse, StrategyDef, StrategyHit, TradePlan, ScoreResult } from '@/domain/strategy';

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
  minute: (code: string) => get<MinuteResponse>('/api/minute?code=' + encodeURIComponent(code)),
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
};
