/**
 * SellReasonDistributionChart.tsx —— P4 卖出原因分布（全自绘 SVG 横向柱状，不引图表库）
 *
 * 输入：已筛选的 WinRateRecord[] + 数据来源口径。
 * 规则（硬性）：
 *  - 使用 SELL_REASON_LABELS 中文文案（UI 唯一出处）。
 *  - 横向柱状，按笔数降序；每项标笔数与占比%。
 *  - 'all' 口径：来源并排两组（盘中尾盘 / 收盘），不混算。
 *  - 空数据：该来源无有效平仓 → 不出该组；全部无 → 「暂无数据」。
 */

import { useMemo } from 'react';
import type { WinRateRecord } from '../../domain/winrate';
import { computeSellReasonCounts, type SrcFilter } from './chartUtils';

interface Props {
  records: WinRateRecord[];
  priceSourceFilter: SrcFilter;
}

// 单组布局（每个原因一行）
const ROW_H = 26;
const LABEL_W = 78;
const VALUE_W = 96;
const PAD_TOP = 8;

export function SellReasonDistributionChart({ records, priceSourceFilter }: Props) {
  const groups = useMemo(
    () => computeSellReasonCounts(records, priceSourceFilter),
    [records, priceSourceFilter],
  );

  if (groups.length === 0) {
    return <div className="wr-chart-empty">暂无数据</div>;
  }

  // 并排两组：每组一个 SVG 列；单组占满
  const colW = 360;

  return (
    <div className="wr-chart wr-chart-dist">
      <div className="wr-chart-dist-row">
        {groups.map((g) => {
          const rowCount = g.items.length;
          const H = PAD_TOP * 2 + rowCount * ROW_H;
          const barAreaW = colW - LABEL_W - VALUE_W;
          const maxCount = Math.max(1, ...g.items.map((i) => i.count));
          return (
            <div className="wr-chart-dist-col" key={g.source}>
              <div className="wr-chart-dist-head">
                <i className="wr-chart-swatch" style={{ background: g.color, borderColor: g.color }} />
                {g.label || '全部'}（n={g.total}）
              </div>
              <svg
                className="wr-chart-svg"
                viewBox={`0 0 ${colW} ${H}`}
                role="img"
                aria-label={`卖出原因分布-${g.label || '全部'}`}
              >
                {g.items.map((it, ri) => {
                  const y = PAD_TOP + ri * ROW_H;
                  const barW = Math.max(2, (it.count / maxCount) * barAreaW);
                  return (
                    <g key={it.reason}>
                      <text x={0} y={y + ROW_H / 2 + 4} className="wr-chart-axis" textAnchor="start">
                        {it.label}
                      </text>
                      <rect
                        x={LABEL_W}
                        y={y + 4}
                        width={barW}
                        height={ROW_H - 10}
                        fill={g.color}
                        rx={3}
                        opacity={0.9}
                      >
                        <title>{`${it.label}\n${it.count} 笔（${it.pct}%）`}</title>
                      </rect>
                      <text
                        x={LABEL_W + barAreaW + 8}
                        y={y + ROW_H / 2 + 4}
                        className="wr-chart-barlabel"
                        textAnchor="start"
                      >
                        {it.count}（{it.pct}%）
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          );
        })}
      </div>
    </div>
  );
}
