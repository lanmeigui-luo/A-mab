import { useCallback, useEffect, useState } from 'react';

/**
 * 战法参数覆盖（需求第二章「支持参数可调」）
 * 只存「与默认值不同的项」，重置时删掉对应 key，避免默认值调整后旧数据残留。
 */
const STORAGE_KEY = 'radar.strategyParams.v1';

export type ParamOverrides = Record<string, Record<string, number>>;

function load(): ParamOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

export function useStrategyParams() {
  const [params, setParams] = useState<ParamOverrides>({});
  const [storageOk, setStorageOk] = useState(true);

  useEffect(() => {
    try {
      setParams(load());
    } catch {
      setStorageOk(false);
    }
  }, []);

  const persist = useCallback((next: ParamOverrides) => {
    setParams(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      setStorageOk(false);
    }
  }, []);

  const setParam = useCallback(
    (strategyId: string, key: string, value: number) => {
      setParams((prev) => {
        const next = { ...prev, [strategyId]: { ...(prev[strategyId] || {}), [key]: value } };
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          setStorageOk(false);
        }
        return next;
      });
    },
    [],
  );

  /** 单个战法恢复默认 */
  const resetStrategy = useCallback((strategyId: string) => {
    setParams((prev) => {
      const next = { ...prev };
      delete next[strategyId];
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* 忽略 */
      }
      return next;
    });
  }, []);

  /** 全部恢复默认 */
  const resetAll = useCallback(() => persist({}), [persist]);

  /** 导出/导入备份（需求：提供导出/导入 JSON 备份） */
  const exportJson = useCallback(
    () => JSON.stringify({ key: STORAGE_KEY, version: 1, exportedAt: new Date().toISOString(), params }, null, 2),
    [params],
  );

  const importJson = useCallback(
    (text: string) => {
      const p = JSON.parse(text);
      if (!p || typeof p.params !== 'object') throw new Error('文件格式不正确');
      persist(p.params as ParamOverrides);
    },
    [persist],
  );

  return { params, setParam, resetStrategy, resetAll, exportJson, importJson, storageOk };
}
