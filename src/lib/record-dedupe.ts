/**
 * record-dedupe.ts —— 记录业务键与去重（唯一口径）
 *
 * 业务键 = 日期 + 战法ID + 股票代码。
 * 为什么不能只按 id 去重：每条记录创建时生成随机 id，StrictMode 双调用 / 并发补拉时
 * 同一业务键会被写入两条内容完全相同、id 不同的记录（2026-11-16 实测事故）。
 * 空仓占位（code='NONE'）同样适用：同一天同一战法只允许一条。
 *
 * 纯函数、零依赖、无 @/ 别名，可安全进入 tsconfig.test.json 编译图。
 */

export interface RecordBizKey {
  date: string;
  strategyId: string;
  code: string;
}

/** 生成业务键：'2026-11-16:ma-bull:600000' */
export function recordBusinessKey(r: RecordBizKey): string {
  return String(r.date) + ':' + String(r.strategyId) + ':' + String(r.code);
}

/** 按业务键去重，保留第一次出现的记录（顺序稳定） */
export function dedupeRecords<T extends RecordBizKey>(records: T[]): T[] {
  if (!Array.isArray(records)) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of records) {
    if (!r || typeof r.date !== 'string' || typeof r.strategyId !== 'string' || typeof r.code !== 'string') continue;
    const k = recordBusinessKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}
