/** 板块行情（阶段 3） */

export type BoardType = 'industry' | 'concept' | 'area';

export interface BoardRow {
  label: string;
  name: string;
  count: number | null;
  avgPrice: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  amount: number | null;
  leadCode: string | null;
  leadName: string | null;
  leadChangePct: number | null;
  leadPrice: number | null;
}

export interface BoardListResponse {
  ok: boolean;
  reason?: string;
  rows: BoardRow[];
  count: number;
  type?: BoardType;
  source?: string;
  elapsedMs?: number;
  fetchedAt?: string;
  cached?: boolean;
}

export interface BoardStock {
  fullCode: string;
  code: string;
  name: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  /** 成交量，单位：股 */
  volume: number | null;
  /** 成交额，单位：元 */
  amount: number | null;
  pe: number | null;
  pb: number | null;
  turnoverRate: number | null;
  floatMvWan: number | null;
  totalMvWan: number | null;
  tickTime: string | null;
}

export interface BoardConsResponse {
  ok: boolean;
  reason?: string;
  rows: BoardStock[];
  count: number;
  sector?: string;
  source?: string;
  elapsedMs?: number;
  fetchedAt?: string;
  cached?: boolean;
}

export const BOARD_TYPES: { key: BoardType; label: string }[] = [
  { key: 'industry', label: '行业板块' },
  { key: 'concept', label: '概念板块' },
  { key: 'area', label: '地域板块' },
];
