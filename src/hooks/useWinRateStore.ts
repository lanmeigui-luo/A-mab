import { useCallback, useSyncExternalStore } from 'react';
import type { WinRateRecord, TradeRecord } from '../domain/winrate';

const STORAGE_KEY = 'radar.winrate.v1';
const SCHEMA_VERSION = 1;

/** updateTrade 允许回写的字段：trade 核心字段 + tPlus1SellDate（次新股结算时回填）。已平仓记录整条禁改。 */
export type WinRateTradePatch = Partial<TradeRecord> & { tPlus1SellDate?: string | null };

interface Persisted {
  version: number;
  records: WinRateRecord[];
}

// ───────────────────────────────────────────────────────────────────────
// 模块级单例：所有 hook 实例共享同一份 state，append/update 后 notify 所有订阅者。
// ───────────────────────────────────────────────────────────────────────
let state: WinRateRecord[] = read();
let storageOk = true; // 默认 true；首次写入失败才降级为 false
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** getSnapshot 返回稳定引用：state 未变更时引用不变，避免 useSyncExternalStore 无限渲染 */
function getSnapshot(): WinRateRecord[] {
  return state;
}

/** 同步读取最新内存 state（绕过 React ref 的渲染延迟）：供结算/补拉在同一次周期内读到刚写入的记录 */
export function getLiveRecords(): WinRateRecord[] {
  return state;
}

/** storageOk 为原始 boolean，按值比较，同样可安全做 snapshot */
function getStorageOkSnapshot(): boolean {
  return storageOk;
}

function read(): WinRateRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw) as Persisted;
    if (!p || p.version !== SCHEMA_VERSION || !Array.isArray(p.records)) return [];
    // 仅保留结构合法、含 id / code / strategyId 的记录；旧数据缺 insufficientHits 时补默认 false
    return p.records
      .filter(
        (r) => r && typeof r.id === 'string' && typeof r.code === 'string' && typeof r.strategyId === 'string',
      )
      .map((r) => ({ ...r, insufficientHits: r.insufficientHits ?? false, scoreFactors: r.scoreFactors ?? null }));
  } catch {
    return [];
  }
}

/** 写回 localStorage，返回是否成功（false 表示存储不可用 → storageOk 降级） */
function writeRecords(records: WinRateRecord[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, records }));
    return true;
  } catch {
    return false;
  }
}

/** 唯一的状态变更入口：替换内存 state → 持久化 → 通知所有订阅者 */
function setRecords(next: WinRateRecord[]) {
  state = next;
  const ok = writeRecords(state);
  if (ok !== storageOk) storageOk = ok;
  emit();
}

// 跨标签页同步：仅在其他标签页写入 STORAGE_KEY 时触发（同标签页写入已由 setRecords 直接 notify）
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      state = read();
      emit();
    }
  });
}

/** 导入合并摘要 */
export interface ImportSummary {
  ok: boolean;
  reason?: string;
  /** 新增（id 不存在） */
  added: number;
  /** 更新（id 存在且未平仓，以导入为准覆盖） */
  updated: number;
  /** 跳过（id 存在且已平仓 / 非法） */
  skipped: number;
  /** 合并后总数 */
  total: number;
}

/**
 * 战法胜率记录：本地优先，存 localStorage（key=radar.winrate.v1），无云端、无账号。
 * 范式照搬 useWatchList：版本化 schema + 多标签页 storage 同步 + 导出/导入。
 * 约束：只增不改；已平仓（trade.status==='closed'）记录不可编辑。
 *
 * P2c 改造：store 改为【模块级单例】——所有组件实例共享同一份内存 state，
 * 通过 useSyncExternalStore 订阅；append/update 后 notify 所有订阅者，
 * 跨标签页 storage event 同步与 storageOk 降级逻辑原样保留。对外 API 签名不变。
 */
export function useWinRateStore() {
  const records = useSyncExternalStore(subscribe, getSnapshot);
  const storageOkVal = useSyncExternalStore(subscribe, getStorageOkSnapshot);

  /** 仅追加：批量新增记录，不修改已有记录（id 去重） */
  const appendRecords = useCallback((incoming: WinRateRecord[]): { added: number } => {
    if (!Array.isArray(incoming) || incoming.length === 0) return { added: 0 };
    const existing = new Set(state.map((r) => r.id));
    const fresh = incoming.filter((r) => r && typeof r.id === 'string' && !existing.has(r.id));
    if (fresh.length === 0) return { added: 0 };
    setRecords([...state, ...fresh]);
    return { added: fresh.length };
  }, []);

  /**
   * 受保护的更新接口：仅允许更新未平仓（status !== 'closed'）记录的 trade 字段。
   * 已平仓记录拒绝修改（只增不改）。
   * 允许一并回写 tPlus1SellDate（次新股结算时由 recorder 传入；仍受已平仓保护约束）。
   */
  const updateTrade = useCallback(
    (recordId: string, patch: WinRateTradePatch): { ok: boolean; reason?: string } => {
      let done = false;
      const { tPlus1SellDate, ...tradePatch } = patch;
      const next = state.map((r) => {
        if (r.id !== recordId) return r;
        if (r.trade.status === 'closed') return r; // 已平仓不可编辑
        done = true;
        const updated: WinRateRecord = {
          ...r,
          trade: { ...r.trade, ...tradePatch },
        };
        if (tPlus1SellDate !== undefined) updated.tPlus1SellDate = tPlus1SellDate;
        return updated;
      });
      if (done) setRecords(next);
      return done ? { ok: true } : { ok: false, reason: '记录不存在或已平仓（不可编辑）' };
    },
    [],
  );

  /** 导出 JSON（含版本与导出时间） */
  const exportWinRateJson = useCallback((): string => {
    return JSON.stringify(
      { version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), records: state },
      null,
      2,
    );
  }, []);

  /** 导入 JSON：校验 + 合并（按 id 去重；已平仓跳过更新） */
  const importWinRateJson = useCallback((text: string): ImportSummary => {
    try {
      const p = JSON.parse(text) as Persisted;
      if (!Array.isArray(p?.records)) {
        return { ok: false, reason: '文件格式不正确（缺少 records 数组）', added: 0, updated: 0, skipped: 0, total: 0 };
      }
      const cleaned = p.records
        .filter(
          (r) => r && typeof r.id === 'string' && typeof r.code === 'string' && typeof r.strategyId === 'string',
        )
        .map((r) => ({ ...r, insufficientHits: r.insufficientHits ?? false, scoreFactors: r.scoreFactors ?? null }));
      if (cleaned.length === 0) {
        return { ok: false, reason: '无有效记录', added: 0, updated: 0, skipped: 0, total: 0 };
      }
      const map = new Map(state.map((r) => [r.id, r] as const));
      let added = 0;
      let updated = 0;
      let skipped = 0;
      for (const r of cleaned) {
        const old = map.get(r.id);
        if (!old) {
          map.set(r.id, r);
          added++;
        } else if (old.trade.status === 'closed') {
          skipped++; // 已平仓不可覆盖
        } else {
          map.set(r.id, r); // 未平仓：以导入为准覆盖
          updated++;
        }
      }
      const merged = Array.from(map.values());
      setRecords(merged);
      return { ok: true, added, updated, skipped, total: merged.length };
    } catch (e) {
      return { ok: false, reason: (e as Error).message, added: 0, updated: 0, skipped: 0, total: 0 };
    }
  }, []);

  const getById = useCallback((id: string): WinRateRecord | null => state.find((r) => r.id === id) ?? null, []);

  return {
    records,
    total: records.length,
    appendRecords,
    updateTrade,
    exportWinRateJson,
    importWinRateJson,
    getById,
    storageOk: storageOkVal,
  };
}
