import { useCallback, useEffect, useState } from 'react';
import { setColorBlindMode } from '@/lib/market-colors';

/**
 * 色盲友好模式（需求第九章）
 * 打开后用「暖色=涨 / 冷色=跌」替代红绿，并在根节点加 class 供 CSS 覆盖
 * （涨跌家数条、状态标签等纯 CSS 色块）。
 */
const STORAGE_KEY = 'radar.colorBlind.v1';

export function useColorBlind() {
  const [on, setOn] = useState(false);

  useEffect(() => {
    try {
      setOn(localStorage.getItem(STORAGE_KEY) === '1');
    } catch {
      /* 忽略 */
    }
  }, []);

  useEffect(() => {
    setColorBlindMode(on);
    document.documentElement.classList.toggle('cb-mode', on);
    try {
      localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch {
      /* 忽略 */
    }
  }, [on]);

  const toggle = useCallback(() => setOn((v) => !v), []);
  return { on, toggle };
}
