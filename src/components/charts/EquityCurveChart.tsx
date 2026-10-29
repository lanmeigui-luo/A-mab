/**
 * EquityCurveChart.tsx —— P4 收益曲线（全自绘 SVG，不引图表库）
 *
 * 输入：已筛选的 WinRateRecord[] + 数据来源口径（src 顶部筛选）。
 * 规则（硬性）：
 *  - 单一来源：每战法 1 条折线（按战法固定配色）。
 *  - 'all'：每战法×来源 2 条线（intraday_late 实线 / close 虚线），不混算。
 *  - 最多 5 条；超过 5 条按末点累计收益降序取前 5，图例注明「仅显示前5」。
 *  - 空数据：显示「暂无数据」，不画坐标系、不崩。
 *  - 单点：画一个圆点 + 一条水平参考线，不崩。
 *  - 0 参考线始终存在。
 *  - hover：每点 `<title>` 显示日期与累计收益率。
 */

import { useMemo } from 'react';
import type { WinRateRecord } from '../../domain/winrate';
import {
  computeEquitySeries,
  type SrcFilter,
} from './chartUtils';

interface Props {
  records: WinRateRecord[];
  priceSourceFilter: SrcFilter;
}

const W = 760;
const H = 320;
const M = { left: 50, right: 18, top: 18, bottom: 42 };

export function EquityCurveChart({ records, priceSourceFilter }: Props) {
  const series = useMemo(
    () => computeEquitySeries(records, priceSourceFilter),
    [records, priceSourceFilter],
  );

  if (series.length === 0) {
    return <div className="wr-chart-empty">暂无数据</div>;
  }

  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  // 所有点的日期并集（升序），作为 X 域
  const unionDates = Array.from(
    new Set(series.flatMap((s) => s.points.map((p) => p.date))),
  ).sort();
  const dateIdx = new Map(unionDates.map((d, i) => [d, i]));

  // Y 域：始终包含 0
  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (const s of series) {
    for (const p of s.points) {
      if (p.cumulativeReturnPct < dataMin) dataMin = p.cumulativeReturnPct;
      if (p.cumulativeReturnPct > dataMax) dataMax = p.cumulativeReturnPct;
    }
  }
  if (!isFinite(dataMin) || !isFinite(dataMax)) {
    dataMin = -1;
    dataMax = 1;
  }
  let yMin = Math.min(0, dataMin);
  let yMax = Math.max(0, dataMax);
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  } else {
    const pad = (yMax - yMin) * 0.12;
    yMin -= pad;
    yMax += pad;
  }

  const xFor = (date: string): number => {
    if (unionDates.length <= 1) return M.left + plotW / 2;
    const i = dateIdx.get(date) ?? 0;
    return M.left + (i / (unionDates.length - 1)) * plotW;
  };
  const yFor = (val: number): number => {
    if (yMax === yMin) return M.top + plotH / 2;
    return M.top + (1 - (val - yMin) / (yMax - yMin)) * plotH;
  };

  // X 轴抽稀（5–7 刻度）
  const tickStep = Math.max(1, Math.ceil(unionDates.length / 6));
  const xTicks: { i: number; d: string }[] = [];
  for (let i = 0; i < unionDates.length; i += tickStep) {
    xTicks.push({ i, d: unionDates[i] });
  }
  if (unionDates.length > 0 && xTicks[xTicks.length - 1].i !== unionDates.length - 1) {
    xTicks.push({ i: unionDates.length - 1, d: unionDates[unionDates.length - 1] });
  }

  // Y 轴刻度（含 0）
  const yTicks: number[] = [];
  const yIntervals = 4;
  for (let k = 0; k <= yIntervals; k++) {
    yTicks.push(yMin + ((yMax - yMin) * k) / yIntervals);
  }

  const truncated = series.length >= 5; // computeEquitySeries 已截断到 5

  return (
    <div className="wr-chart">
      <svg className="wr-chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="收益曲线">
        {/* Y 网格 + 刻度 */}
        {yTicks.map((v, k) => {
          const y = yFor(v);
          const isZero = Math.abs(v) < 1e-6;
          return (
            <g key={`y${k}`}>
              <line
                x1={M.left}
                x2={W - M.right}
                y1={y}
                y2={y}
                stroke={isZero ? '#9ca3af' : '#eef0f2'}
                strokeWidth={isZero ? 1.2 : 1}
                strokeDasharray={isZero ? '4 3' : undefined}
              />
              <text x={M.left - 6} y={y + 3} className="wr-chart-axis" textAnchor="end">
                {v.toFixed(0)}%
              </text>
            </g>
          );
        })}

        {/* X 轴刻度 */}
        {xTicks.map((t) => (
          <text
            key={`x${t.i}`}
            x={xFor(t.d)}
            y={H - M.bottom + 16}
            className="wr-chart-axis"
            textAnchor="middle"
          >
            {t.d.slice(5)}
          </text>
        ))}

        {/* 各系列折线 / 单点 */}
        {series.map((s) => {
          if (s.points.length === 1) {
            const p = s.points[0];
            const x = xFor(p.date);
            const y = yFor(p.cumulativeReturnPct);
            return (
              <g key={s.id}>
                <line
                  x1={M.left}
                  x2={W - M.right}
                  y1={y}
                  y2={y}
                  stroke={s.color}
                  strokeWidth={1}
                  strokeDasharray="5 4"
                  opacity={0.7}
                />
                <circle cx={x} cy={y} r={4} fill={s.color}>
                  <title>{`${s.label}\n${p.date}  累计 ${p.cumulativeReturnPct > 0 ? '+' : ''}${p.cumulativeReturnPct}%`}</title>
                </circle>
              </g>
            );
          }
          const d = s.points
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(p.date).toFixed(1)} ${yFor(p.cumulativeReturnPct).toFixed(1)}`)
            .join(' ');
          return (
            <g key={s.id}>
              <path
                d={d}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeDasharray={s.dashed ? '6 4' : undefined}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {s.points.map((p) => (
                <circle
                  key={`${s.strategyId}-${p.date}-${s.source ?? 'na'}`}
                  cx={xFor(p.date)}
                  cy={yFor(p.cumulativeReturnPct)}
                  r={3}
                  fill={s.color}
                >
                  <title>{`${s.label}\n${p.date}  累计 ${p.cumulativeReturnPct > 0 ? '+' : ''}${p.cumulativeReturnPct}%`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>

      {/* 图例（HTML，便于样式与色盲模式） */}
      <div className="wr-chart-legend">
        {series.map((s) => (
          <span key={s.id} className="wr-chart-legend-item">
            <i
              className="wr-chart-swatch"
              style={{
                background: s.dashed ? 'transparent' : s.color,
                borderColor: s.color,
                borderStyle: s.dashed ? 'dashed' : 'solid',
              }}
            />
            {s.label}
          </span>
        ))}
        {truncated && <span className="wr-chart-note">仅显示前5（按累计收益降序）</span>}
      </div>
    </div>
  );
}
