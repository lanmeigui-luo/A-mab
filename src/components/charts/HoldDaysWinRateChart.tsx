/**
 * HoldDaysWinRateChart.tsx —— P4 持有周期胜率柱状图（全自绘 SVG，不引图表库）
 *
 * 输入：已筛选的 WinRateRecord[] + 数据来源口径。
 * 规则（硬性）：
 *  - X 轴 = 7 个累积上限桶（≤1天 / ≤2天 / ... / >20天）。
 *  - Y 轴 = 胜率 0–100%。
 *  - 每桶一根柱，柱顶标胜率%，下方标 n。
 *  - n<10：柱半透明 + 标注「样本不足」。
 *  - n=0：画 0 高度柱（基线刻度）+ 标 n=0，不跳过。
 *  - 'all' 口径：来源并排两组（intraday_late / close），不混算。
 *  - 空数据：该来源无记录 → 不出该组；全部无记录 → 「暂无数据」。
 */

import { useMemo } from 'react';
import type { WinRateRecord } from '../../domain/winrate';
import { computeBucketWinRates, type SrcFilter } from './chartUtils';

interface Props {
  records: WinRateRecord[];
  priceSourceFilter: SrcFilter;
}

const W = 760;
const H = 320;
const M = { left: 38, right: 14, top: 18, bottom: 52 };

export function HoldDaysWinRateChart({ records, priceSourceFilter }: Props) {
  const groups = useMemo(
    () => computeBucketWinRates(records, priceSourceFilter),
    [records, priceSourceFilter],
  );

  if (groups.length === 0) {
    return <div className="wr-chart-empty">暂无数据</div>;
  }

  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const yFor = (wr: number) => M.top + (1 - wr / 100) * plotH;

  const nBuckets = groups[0].buckets.length;
  const slot = plotW / nBuckets;
  const nGroups = groups.length;
  // 每组柱宽：单组 0.5*slot，两组各 0.34*slot 并留缝
  const barW = nGroups === 1 ? slot * 0.5 : slot * 0.34;

  const yTicks = [0, 25, 50, 75, 100];

  return (
    <div className="wr-chart">
      <svg className="wr-chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="持有周期胜率">
        {/* Y 网格 + 刻度 */}
        {yTicks.map((v) => {
          const y = yFor(v);
          const isZero = v === 0;
          return (
            <g key={`y${v}`}>
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
                {v}%
              </text>
            </g>
          );
        })}

        {/* 柱 + X 轴标签 */}
        {groups[0].buckets.map((_, bi) => {
          const cx = M.left + slot * bi + slot / 2;
          const groupStartX =
            nGroups === 1 ? cx - barW / 2 : cx - barW - 2;
          return (
            <g key={`b${bi}`}>
              {groups.map((g, gi) => {
                const b = g.buckets[bi];
                const x = groupStartX + gi * (barW + 4);
                const y = yFor(b.winRate);
                const h = M.top + plotH - y;
                const isZero = b.n === 0;
                return (
                  <g key={`${g.source}-${bi}`}>
                    {isZero ? (
                      // n=0：基线刻度（不跳过）
                      <line
                        x1={x}
                        x2={x + barW}
                        y1={M.top + plotH}
                        y2={M.top + plotH}
                        stroke={g.color}
                        strokeWidth={2}
                      />
                    ) : (
                      <rect
                        x={x}
                        y={y}
                        width={barW}
                        height={Math.max(h, 1)}
                        fill={g.color}
                        opacity={b.insufficient ? 0.45 : 1}
                        rx={2}
                      >
                        <title>{`${g.label || '全部'} · ${b.label}\n胜率 ${b.winRate}%\n样本 n=${b.n}${b.insufficient ? '（样本不足）' : ''}`}</title>
                      </rect>
                    )}
                    {/* 柱顶胜率% */}
                    {!isZero && (
                      <text x={x + barW / 2} y={y - 4} className="wr-chart-barlabel" textAnchor="middle">
                        {b.winRate}%
                      </text>
                    )}
                    {/* n 标签 */}
                    <text
                      x={x + barW / 2}
                      y={M.top + plotH + 14}
                      className="wr-chart-n"
                      textAnchor="middle"
                    >
                      {isZero ? 'n=0' : `n=${b.n}`}
                    </text>
                    {b.insufficient && (
                      <text
                        x={x + barW / 2}
                        y={M.top + plotH + 26}
                        className="wr-chart-insufficient"
                        textAnchor="middle"
                      >
                        样本不足
                      </text>
                    )}
                  </g>
                );
              })}
              {/* 桶标签（X 轴，置于最下方） */}
              <text
                x={cx}
                y={M.top + plotH + 42}
                className="wr-chart-axis"
                textAnchor="middle"
              >
                {groups[0].buckets[bi].label}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="wr-chart-legend">
        {groups.map((g) => (
          <span key={g.source} className="wr-chart-legend-item">
            <i className="wr-chart-swatch" style={{ background: g.color, borderColor: g.color }} />
            {g.label || '全部'}
          </span>
        ))}
        <span className="wr-chart-note">半透明 = 样本不足（n&lt;10）</span>
      </div>
    </div>
  );
}
