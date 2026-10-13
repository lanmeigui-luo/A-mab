/**
 * A股红涨绿跌色阶（需求第九章规范）
 * 幅度越大颜色越深，平盘灰色。实现为**纯函数**，禁止在样式里写死颜色。
 *
 * 档位（需求给定）：
 *   +10% #B91C1C   +5% #DC2626   +1% #FCA5A5
 *     0% #6B7280
 *   -1% #86EFAC    -5% #16A34A  -10% #15803D
 */

export const FLAT_COLOR = '#6B7280';

/** 涨（红）档位，按涨幅升序 */
const UP_STOPS = [
  { pct: 0.0001, color: '#FCA5A5' }, // 微涨：浅红
  { pct: 1, color: '#FCA5A5' },
  { pct: 5, color: '#DC2626' },
  { pct: 10, color: '#B91C1C' },
];

/** 跌（绿）档位，按跌幅升序（pct 为负） */
const DOWN_STOPS = [
  { pct: -0.0001, color: '#86EFAC' }, // 微跌：浅绿
  { pct: -1, color: '#86EFAC' },
  { pct: -5, color: '#16A34A' },
  { pct: -10, color: '#15803D' },
];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToHex(rgb: [number, number, number]): string {
  const to = (v: number) =>
    Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return '#' + to(rgb[0]) + to(rgb[1]) + to(rgb[2]);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(hexA: string, hexB: string, t: number): string {
  const ca = hexToRgb(hexA);
  const cb = hexToRgb(hexB);
  return rgbToHex([lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t)]);
}

// ---------- 色盲友好模式（需求第九章） ----------
// 红绿色盲无法区分红涨绿跌，改用「暖色（涨）/ 冷色（跌）」双色阶：
// 涨 = 浅黄 → 深棕，跌 = 浅蓝 → 深蓝。明度差保证可辨，且不依赖红绿通道。
let colorBlindMode = false;

export function setColorBlindMode(v: boolean) {
  colorBlindMode = v;
}
export function isColorBlindMode() {
  return colorBlindMode;
}

const UP_CB = [
  { pct: 0.0001, color: '#FDE68A' },
  { pct: 1, color: '#FDE68A' },
  { pct: 5, color: '#F59E0B' },
  { pct: 10, color: '#B45309' },
];
const DOWN_CB = [
  { pct: -0.0001, color: '#BFDBFE' },
  { pct: -1, color: '#BFDBFE' },
  { pct: -5, color: '#3B82F6' },
  { pct: -10, color: '#1E3A8A' },
];

function pickStops(pct: number, stops: { pct: number; color: string }[]): string {
  const asc = stops[0].pct < stops[stops.length - 1].pct;
  if (pct > 0) {
    const list = asc ? stops : [...stops].reverse();
    if (pct >= 10) return list[list.length - 1].color;
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i];
      const b = list[i + 1];
      if (pct >= a.pct && pct <= b.pct) {
        const t = b.pct === a.pct ? 0 : (pct - a.pct) / (b.pct - a.pct);
        return mix(a.color, b.color, t);
      }
    }
    return list[0].color;
  }
  const list = asc ? [...stops].reverse() : stops;
  if (pct <= -10) return list[list.length - 1].color;
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i];
    const b = list[i + 1];
    if (pct <= a.pct && pct >= b.pct) {
      const t = a.pct === b.pct ? 0 : (pct - a.pct) / (b.pct - a.pct);
      return mix(a.color, b.color, t);
    }
  }
  return list[0].color;
}

/**
 * 根据涨跌幅取颜色
 * @param {number|null|undefined} pct 涨跌幅百分比，例如 -1.65
 * @returns {string} hex 颜色
 */
export function changeColor(pct: number | null | undefined): string {
  if (pct == null || Number.isNaN(pct)) return FLAT_COLOR;
  if (Math.abs(pct) < 0.0001) return FLAT_COLOR;
  if (colorBlindMode) return pickStops(pct, pct > 0 ? UP_CB : DOWN_CB);

  if (pct > 0) {
    if (pct >= 10) return '#B91C1C';
    for (let i = 0; i < UP_STOPS.length - 1; i++) {
      const a = UP_STOPS[i];
      const b = UP_STOPS[i + 1];
      if (pct >= a.pct && pct <= b.pct) {
        const t = b.pct === a.pct ? 0 : (pct - a.pct) / (b.pct - a.pct);
        return mix(a.color, b.color, t);
      }
    }
    return '#FCA5A5';
  }

  if (pct <= -10) return '#15803D';
  for (let i = 0; i < DOWN_STOPS.length - 1; i++) {
    const a = DOWN_STOPS[i];
    const b = DOWN_STOPS[i + 1];
    // a.pct 大于 b.pct（越往后越负）
    if (pct <= a.pct && pct >= b.pct) {
      const t = a.pct === b.pct ? 0 : (pct - a.pct) / (b.pct - a.pct);
      return mix(a.color, b.color, t);
    }
  }
  return '#86EFAC';
}

/** 涨跌方向：1 涨 / -1 跌 / 0 平 */
export function changeDirection(pct: number | null | undefined): 0 | 1 | -1 {
  if (pct == null || Number.isNaN(pct) || Math.abs(pct) < 0.0001) return 0;
  return pct > 0 ? 1 : -1;
}

/** 带符号的涨跌幅文本 */
export function formatPct(pct: number | null | undefined, digits = 2): string {
  if (pct == null || Number.isNaN(pct)) return '—';
  const s = pct.toFixed(digits);
  return pct > 0 ? '+' + s : s;
}

export function formatChange(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return '—';
  const s = v.toFixed(digits);
  return v > 0 ? '+' + s : s;
}
