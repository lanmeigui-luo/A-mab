import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollingState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  lastAt: number | null;
  refresh: () => void;
  setIntervalMs: (ms: number) => void;
}

/**
 * 轮询 Hook
 * - 页面不可见时暂停（省流，符合需求「只刷新当前可见区域」）
 * - 失败保留上一次数据并置 error，不清空（避免闪白）
 * - 请求串行化，不并发堆积
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  deps: unknown[] = [],
  enabled = true,
): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [ms, setMs] = useState(intervalMs);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const inFlight = useRef(false);
  const timer = useRef<number | null>(null);
  const alive = useRef(true);

  const run = useCallback(async () => {
    if (inFlight.current || !alive.current) return;
    inFlight.current = true;
    try {
      const r = await fetcherRef.current();
      if (!alive.current) return;
      setData(r);
      setError(null);
      setLastAt(Date.now());
    } catch (e) {
      if (!alive.current) return;
      // 失败保留上一次数据
      setError(String((e as Error)?.message || e));
    } finally {
      inFlight.current = false;
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    // enabled=false：暂停轮询（如分时模式下不空轮询日K），保留已有数据
    if (!enabled) {
      setLoading(false);
      return;
    }
    run();

    const schedule = () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(async () => {
        if (document.visibilityState === 'visible') await run();
        schedule();
      }, ms);
    };
    schedule();

    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      alive.current = false;
      if (timer.current) window.clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, run, enabled, ...deps]);

  const setIntervalMs = useCallback((v: number) => setMs(v), []);

  return { data, error, loading, lastAt, refresh: run, setIntervalMs };
}
