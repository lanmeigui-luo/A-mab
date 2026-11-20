/**
 * board-heat.ts —— 板块热力图（纯函数，可离线验收）
 *
 * 布局：Squarified Treemap（Bruls/Huizing/van Wijk）。
 * 递归沿短边成行、逐行塞入使长宽比最优的项，100% 填满容器、无缝隙，
 * 每个色块尽可能接近正方形。彻底取代 CSS Grid span 方案。
 * 颜色：红涨绿跌六档 + 中性缺失档。
 */

export interface HeatColor {
  background: string;
  foreground: string;
  level: 'strong-up' | 'up' | 'light-up' | 'flat' | 'light-down' | 'down' | 'strong-down';
}

/** 涨跌幅 → 色块配色（浅底配深字、深底配白字，保证六档都清晰可读） */
export function heatColor(pct: number | null | undefined): HeatColor {
  if (pct == null || !Number.isFinite(pct)) {
    return { background: '#F3F4F6', foreground: '#4B5563', level: 'flat' };
  }
  // 【平盘档】0.00% 必须中性灰，禁止落入 -1~0 的浅绿档
  if (pct === 0) return { background: '#9CA3AF', foreground: '#1F2937', level: 'flat' };
  if (pct > 3) return { background: '#991B1B', foreground: '#FFFFFF', level: 'strong-up' };
  if (pct >= 1) return { background: '#DC2626', foreground: '#FFFFFF', level: 'up' };
  if (pct > 0) return { background: '#FCA5A5', foreground: '#7F1D1D', level: 'light-up' };
  if (pct >= -1) return { background: '#86EFAC', foreground: '#14532D', level: 'light-down' };
  if (pct >= -3) return { background: '#16A34A', foreground: '#FFFFFF', level: 'down' };
  return { background: '#15803D', foreground: '#FFFFFF', level: 'strong-down' };
}

export interface TreemapItem {
  /** 稳定标识（板块 label） */
  key: string;
  /** 成交额（元）；amount 模式下作为权重 */
  amount: number | null | undefined;
  /** 涨跌幅（%）；pct_desc / pct_asc 模式下参与权重映射 */
  changePct?: number | null;
}

/** 权重口径：成交额体量 / 涨跌幅极端程度 */
export type TreemapWeightMode = 'amount' | 'amount_asc' | 'pct_desc' | 'pct_asc';

/**
 * 【n 的唯一口径】n = 参与布局的块数（调用方 heatRows.length，已排除无数据板块）。
 * 地板按 n 相对计算；排除数变化会导致地板整体缩放，属可接受行为。
 */
export function heatFloor(width: number, height: number, n: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(n) || n <= 0) return 0;
  return ((width * height) / n) * 0.12;
}

/** 文字分级：阈值从平均块短边推导，不随视图硬编码 */
export type TextLevel = 0 | 1 | 2;
export function textLevel(rect: { width: number; height: number }, n: number, W: number, H: number): TextLevel {
  // 【area 口径】信息量由面积决定；short 是布局产物，受长宽比影响，不用于分级。
  const area = rect.width * rect.height;
  const avgArea = (W * H) / Math.max(n, 1);
  if (area >= avgArea * 0.8) return 0;
  if (area >= avgArea * 0.35) return 1;
  return 2;
}

/**
 * 【P1 无数据判据】上游 AkShare 对无行情板块会返回 amount/volume/avgPrice 全 0
 * 且 leadName='--' 的占位记录（实测「社会工作」hangye_ZQ84）。这类记录不得进入 treemap，
 * 否则会被 +1 / 地板放大成巨大的误导性色块。
 */
export function isBoardDataMissing(b: { amount?: number | null }): boolean {
  return !(typeof b.amount === 'number' && Number.isFinite(b.amount) && b.amount > 0);
}

export interface TreemapRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TreemapCell extends TreemapItem {
  rect: TreemapRect;
}

interface WorkItem {
  key: string;
  weight: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一行内最差长宽比（越小越接近正方形） */
function worstAspect(row: WorkItem[], scale: number, shortSide: number): number {
  if (!row.length || shortSide <= 0) return Infinity;
  const total = row.reduce((s, it) => s + it.weight, 0) * scale;
  if (total <= 0) return Infinity;
  const thickness = total / shortSide;
  if (thickness <= 0) return Infinity;
  let worst = 1;
  for (const it of row) {
    const side = (it.weight * scale) / thickness;
    if (side <= 0) return Infinity;
    worst = Math.max(worst, side / thickness, thickness / side);
  }
  return worst;
}

/**
 * 纯函数：把板块按成交额映射成填满容器的绝对坐标。
 * 输出按输入顺序对应（调用方可用 key 找回原记录），面积严格守恒。
 */
export function calculateTreemap(
  boards: TreemapItem[],
  containerWidth: number,
  containerHeight: number,
  weightMode: TreemapWeightMode = 'amount',
): TreemapCell[] {
  const W = Number.isFinite(containerWidth) ? Math.max(0, containerWidth) : 0;
  const H = Number.isFinite(containerHeight) ? Math.max(0, containerHeight) : 0;
  if (!boards.length || W <= 0 || H <= 0) return [];

  // 【动态权重】面积口径跟随排序键 + 排序方向：
  //  - amount   → weight = 成交额（降序：资金体量大的块大）
  //  - amount_asc→ weight = maxAmount - amount + 1（升序：资金体量小的块大，与 pct_asc 同构）
  //  - pct_desc → weight = pct - min(pct) + 1（涨得最多面积最大，跌得最多保底 1）
  //  - pct_asc  → weight = max(pct) - pct + 1（跌得最惨面积最大，涨得最多保底 1）
  //  - 领涨股排序由调用方 fallback 到 amount
  // 【空值兜底】null / NaN / undefined 一律回退 0（有限正数口径），
  // 由后面的 +1 与地板保证任何板块都不会得到 NaN 或 0 面积。
  const amountValues = boards.map((b) =>
    typeof b.amount === 'number' && Number.isFinite(b.amount) && b.amount > 0 ? b.amount : 0,
  );
  const maxAmount = amountValues.length ? Math.max(...amountValues) : 0;
  const pctValues = boards.map((b) =>
    typeof b.changePct === 'number' && Number.isFinite(b.changePct) ? b.changePct : 0,
  );
  const minPct = pctValues.length ? Math.min(...pctValues) : 0;
  const maxPct = pctValues.length ? Math.max(...pctValues) : 0;
  const raw = boards.map((_b, i) => {
    if (weightMode === 'pct_desc') return pctValues[i] - minPct + 1;
    if (weightMode === 'pct_asc') return maxPct - pctValues[i] + 1;
    if (weightMode === 'amount_asc') return maxAmount - amountValues[i] + 1;
    // 已知缺陷，暂不修：领涨股排序键按 leadChangePct 排列，但面积口径仍是 amount（fallback）。
    return amountValues[i];
  });
  // 【自适应地板】旧 3200px² 在 172 板块下等于平均块的 85%，把面积差异全抹平。
  // 新口径：目标面积 = (容器面积 ÷ n) × 0.12，n = boards.length（调用方已排除无数据板块）。
  // 反推权重地板：f/(Σraw+n·f)·A ≥ target ⇒ f ≥ target·Σraw/(A - target·n)。
  const containerArea = W * H;
  const rawSum = raw.reduce((t, v) => t + v, 0);
  const targetArea = heatFloor(W, H, boards.length);
  const pixelFloor = rawSum > 0 && containerArea > targetArea * boards.length
    ? (targetArea * rawSum) / (containerArea - targetArea * boards.length)
    : 0;
  const floor = pixelFloor;
  const items: WorkItem[] = boards.map((b, i) => ({
    key: b.key,
    weight: Math.max(raw[i], floor),
  }));
  // 【尊重外部顺序】不再按权重重排：调用方传入的顺序就是用户选的排序口径。
  // 面积口径与排列口径可以不同（例如涨跌幅排序 + 涨跌幅面积）。
  // 非权重顺序时 squarified 的长宽比可能略差，这是用户明确接受的妥协。

  const totalWeight = items.reduce((s, it) => s + it.weight, 0);
  const scale = (W * H) / totalWeight;
  const rect: Rect = { x: 0, y: 0, w: W, h: H };
  const out = new Map<string, TreemapRect>();

  let queue = items.slice();
  while (queue.length) {
    const shortSide = Math.min(rect.w, rect.h);
    if (shortSide <= 0) break;

    // 贪心成行：不断加入下一项，只要最差长宽比不恶化
    const row: WorkItem[] = [queue[0]];
    queue = queue.slice(1);
    // 【对照实验结论】上一版 worstAspect<=4 逼迫提前断行、剩余矩形越切越扁，
    // 实测把 maxAspect 从 1.41/1.96 恶化到 36/77 —— 已移除，恢复纯 squarify。
    while (queue.length &&
           worstAspect([...row, queue[0]], scale, shortSide) <= worstAspect(row, scale, shortSide)) {
      row.push(queue[0]);
      queue = queue.slice(1);
    }

    const rowArea = row.reduce((s, it) => s + it.weight, 0) * scale;
    if (rect.w >= rect.h) {
      // 宽矩形 → 沿短边(高)切一条垂直带，带内自上而下排列
      const bandW = Math.min(rect.w, rowArea / rect.h);
      let y = rect.y;
      for (let i = 0; i < row.length; i++) {
        const it = row[i];
        const isLast = i === row.length - 1;
        const h = isLast ? rect.y + rect.h - y : (it.weight * scale) / bandW;
        out.set(it.key, { left: rect.x, top: y, width: bandW, height: h });
        y += h;
      }
      rect.x += bandW;
      rect.w -= bandW;
    } else {
      // 高矩形 → 沿短边(宽)切一条水平带，带内自左向右排列
      const bandH = Math.min(rect.h, rowArea / rect.w);
      let x = rect.x;
      for (let i = 0; i < row.length; i++) {
        const it = row[i];
        const isLast = i === row.length - 1;
        const w = isLast ? rect.x + rect.w - x : (it.weight * scale) / bandH;
        out.set(it.key, { left: x, top: rect.y, width: w, height: bandH });
        x += w;
      }
      rect.y += bandH;
      rect.h -= bandH;
    }
  }

  return boards.map((b) => ({ ...b, rect: out.get(b.key) ?? { left: 0, top: 0, width: 0, height: 0 } }));
}

/** 板块排序键（与 BoardPage 的 SortKey 同口径） */
export type BoardSortKey = 'changePct' | 'amount' | 'leadChangePct';

export interface MetricText {
  text: string;
  kind: 'pct' | 'amount' | 'lead' | 'none';
}

export interface MetricSource {
  changePct?: number | null;
  amount?: number | null;
  leadName?: string | null;
  leadChangePct?: number | null;
}

const fmtPctText = (v: number | null | undefined): string =>
  typeof v === 'number' && Number.isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(2) + '%' : '—';

/** 成交额紧凑展示：元 → 亿 / 万 */
const fmtAmountText = (v: number | null | undefined): string => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e8) return '¥' + (v / 1e8).toFixed(2) + '亿';
  return '¥' + (v / 1e4).toFixed(0) + '万';
};

/** 主指标：跟随排序口径。领涨股排序保持现状（主=涨跌幅）。 */
export function primaryMetric(b: MetricSource, sort: BoardSortKey): MetricText {
  if (sort === 'amount') return { text: fmtAmountText(b.amount), kind: 'amount' };
  return { text: fmtPctText(b.changePct), kind: 'pct' };
}

/** 次指标：成交额排序→涨跌幅；涨跌幅/领涨股排序→领涨股（无则 —）。 */
export function secondaryMetric(b: MetricSource, sort: BoardSortKey): MetricText {
  if (sort === 'amount') return { text: fmtPctText(b.changePct), kind: 'pct' };
  const name = typeof b.leadName === 'string' ? b.leadName.trim() : '';
  if (!name) return { text: '领涨股 —', kind: 'none' };
  return {
    text: name + ' ' + fmtPctText(b.leadChangePct),
    kind: 'lead',
  };
}
