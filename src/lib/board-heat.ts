/**
 * board-heat.ts —— 板块热力图映射（纯函数，可离线验收）
 *
 * 红涨绿跌六档 + 中性缺失档；面积按【成交额】分档，资金在哪哪个板块就大。
 * 纯 CSS Grid 近似 treemap，不引入任何可视化库。
 */

export interface HeatColor {
  background: string;
  foreground: string;
  /** 档位标识，供测试与调试 */
  level: 'strong-up' | 'up' | 'light-up' | 'flat' | 'light-down' | 'down' | 'strong-down';
}

/** 涨跌幅 → 色块配色（浅底配深字、深底配白字，保证六档都清晰可读） */
export function heatColor(pct: number | null | undefined): HeatColor {
  if (pct == null || !Number.isFinite(pct)) {
    return { background: '#F3F4F6', foreground: '#4B5563', level: 'flat' };
  }
  if (pct > 3) return { background: '#991B1B', foreground: '#FFFFFF', level: 'strong-up' };
  if (pct >= 1) return { background: '#DC2626', foreground: '#FFFFFF', level: 'up' };
  if (pct > 0) return { background: '#FCA5A5', foreground: '#7F1D1D', level: 'light-up' };
  if (pct >= -1) return { background: '#86EFAC', foreground: '#14532D', level: 'light-down' };
  if (pct >= -3) return { background: '#16A34A', foreground: '#FFFFFF', level: 'down' };
  return { background: '#15803D', foreground: '#FFFFFF', level: 'strong-down' };
}

export interface HeatSpan {
  /** 横跨列数（12 列栅格） */
  col: number;
  /** 纵跨行数 */
  row: number;
}

/** 成交额（元）→ 面积档位。无量/缺失给最小块，避免塌缩或异常放大。 */
export function heatSpan(amount: number | null | undefined): HeatSpan {
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return { col: 1, row: 1 };
  if (amount >= 5_000_000_000) return { col: 3, row: 2 }; // ≥50 亿
  if (amount >= 2_000_000_000) return { col: 2, row: 2 }; // ≥20 亿
  if (amount >= 800_000_000) return { col: 2, row: 1 };   // ≥8 亿
  return { col: 1, row: 1 };
}
