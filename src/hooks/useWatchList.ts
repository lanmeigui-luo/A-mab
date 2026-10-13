import { useCallback, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'radar.watchlist.v1';
const SCHEMA_VERSION = 1;

export interface WatchItem {
  code: string;      // 6 位
  fullCode: string;  // sh600519
  name?: string;     // 添加时的名称快照，行情返回后以行情为准
  addedAt: number;
}

interface Persisted {
  version: number;
  items: WatchItem[];
}

/** 6 位代码推断市场：沪 60/68/9，深 00/30，北交所 4/8 */
export function inferMarket(code: string): 'sh' | 'sz' | 'bj' | null {
  if (!/^\d{6}$/.test(code)) return null;
  const head2 = code.slice(0, 2);
  const head1 = code.slice(0, 1);
  if (head1 === '6' || head1 === '9') return 'sh';
  if (head2 === '00' || head2 === '30') return 'sz';
  if (head1 === '4' || head1 === '8') return 'bj';
  if (head2 === '68') return 'sh';
  return null;
}

export function toFullCode(code: string): string | null {
  const m = inferMarket(code);
  return m ? m + code : null;
}

function read(): WatchItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw) as Persisted;
    if (!p || p.version !== SCHEMA_VERSION || !Array.isArray(p.items)) return [];
    return p.items.filter((i) => i && typeof i.code === 'string');
  } catch {
    return [];
  }
}

function write(items: WatchItem[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, items }));
  } catch {
    /* 存储不可用时静默失败，运行时仍可用 */
  }
}

/**
 * 自选股：本地优先，存 localStorage，无云端、无账号体系。
 * 提供导出 / 导入 JSON 备份（需求要求）。
 */
export function useWatchList() {
  const [items, setItems] = useState<WatchItem[]>(() => read());
  const [storageOk, setStorageOk] = useState(true);

  useEffect(() => {
    try {
      write(items);
      setStorageOk(true);
    } catch {
      setStorageOk(false);
    }
  }, [items]);

  // 多标签页同步
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setItems(read());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const add = useCallback((code: string, name?: string) => {
    const full = toFullCode(code);
    if (!full) return { ok: false, reason: '代码需为 6 位数字' };
    setItems((prev) =>
      prev.some((i) => i.code === code)
        ? prev
        : [...prev, { code, fullCode: full, name, addedAt: Date.now() }],
    );
    return { ok: true };
  }, []);

  const remove = useCallback((code: string) => {
    setItems((prev) => prev.filter((i) => i.code !== code));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const exportJson = useCallback(() => {
    return JSON.stringify({ version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), items }, null, 2);
  }, [items]);

  const importJson = useCallback((text: string) => {
    try {
      const p = JSON.parse(text) as Persisted;
      if (!Array.isArray(p?.items)) return { ok: false, reason: '文件格式不正确' };
      const cleaned = p.items
        .filter((i) => i && /^\d{6}$/.test(String(i.code)))
        .map((i) => ({
          code: String(i.code),
          fullCode: toFullCode(String(i.code)) ?? '',
          name: typeof i.name === 'string' ? i.name : undefined,
          addedAt: Number(i.addedAt) || Date.now(),
        }))
        .filter((i) => i.fullCode);
      setItems(cleaned);
      return { ok: true, count: cleaned.length };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }, []);

  const fullCodes = useMemo(() => items.map((i) => i.fullCode), [items]);

  return { items, fullCodes, add, remove, clear, exportJson, importJson, storageOk };
}
