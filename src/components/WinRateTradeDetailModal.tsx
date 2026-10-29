import { useEffect, useMemo, useState } from 'react';
import type { WinRateRecord } from '@/domain/winrate';
import {
  TRADE_STATUS_LABELS,
  SELL_REASON_LABELS,
} from '@/domain/winrate';
import { marketApi } from '@/services/market';
import type { KlineResponse, KlineRow } from '@/domain/types';
import { getWinRateConfig } from '@/domain/winrate-config';
import { fmtNum } from '@/lib/format';

/** 6 位代码 → 带市场前缀 fullCode（与 useWinRateRecorder.toFullCode 规则一致；WinRateRecord.code 仅存 6 位） */
function toFullCode(code: string): string {
  const c = String(code).padStart(6, '0');
  if (/^(6|9)/.test(c)) return 'sh' + c;
  if (/^(4|8)/.test(c)) return 'bj' + c;
  return 'sz' + c;
}

const UP_COLOR = '#e23b3b'; // 红涨
const DOWN_COLOR = '#16a34a'; // 绿跌

/**
 * 迷你 K 线（纯 SVG 自绘，不引图表库）：
 * - 每根日 K 等宽等距铺在 innerW 内，蜡烛中心 x = PAD_L + (i+0.5)*slotW；
 * - 价格 y 按可视区间 [minP, maxP] 线性映射到 [PAD_T, PAD_T+innerH]，上边界=最高价、下边界=最低价；
 * - 实体 = open→close 矩形（红涨绿跌），影线 = high→low 竖线；
 * - showPoints=true 时叠加 buyPrice（绿）/ sellPrice（红）水平虚线 + 买入日/卖出日三角标记；
 * - X 轴取 ~6 个日期刻度（MM-DD）。
 */
function MiniKline({
  rows,
  buyDate,
  sellDate,
  buyPrice,
  sellPrice,
  showPoints,
}: {
  rows: KlineRow[];
  buyDate: string | null;
  sellDate: string | null;
  buyPrice: number | null;
  sellPrice: number | null;
  showPoints: boolean;
}) {
  const W = 760;
  const H = 300;
  const PAD_L = 10;
  const PAD_R = 10;
  const PAD_T = 14;
  const PAD_B = 24;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  // 可视价格区间：含 K 线高低 + 买卖价，上下各留 6% 余量
  let minP = Math.min(...rows.map((r) => r.low));
  let maxP = Math.max(...rows.map((r) => r.high));
  if (showPoints) {
    if (buyPrice != null) {
      minP = Math.min(minP, buyPrice);
      maxP = Math.max(maxP, buyPrice);
    }
    if (sellPrice != null) {
      minP = Math.min(minP, sellPrice);
      maxP = Math.max(maxP, sellPrice);
    }
  }
  const span = maxP - minP || 1;
  minP -= span * 0.06;
  maxP += span * 0.06;
  const full = maxP - minP || 1;

  const n = rows.length;
  const slotW = innerW / n;
  const cx = (i: number) => PAD_L + (i + 0.5) * slotW;
  const y = (p: number) => PAD_T + (1 - (p - minP) / full) * innerH;
  const candleW = Math.max(2, Math.min(14, slotW * 0.62));
  const idxByDate = new Map<string, number>();
  rows.forEach((r, i) => idxByDate.set(r.date, i));

  const tickCount = Math.min(6, n);
  const ticks: { x: number; label: string }[] = [];
  if (tickCount > 0) {
    for (let t = 0; t < tickCount; t++) {
      const i = tickCount === 1 ? 0 : Math.round((t / (tickCount - 1)) * (n - 1));
      ticks.push({ x: cx(i), label: rows[i].date.slice(5) });
    }
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="wr-mini-kline" preserveAspectRatio="xMidYMid meet">
      {/* 上下边界参考线 */}
      <line x1={PAD_L} y1={y(maxP)} x2={W - PAD_R} y2={y(maxP)} stroke="#eef0f3" />
      <line x1={PAD_L} y1={y(minP)} x2={W - PAD_R} y2={y(minP)} stroke="#eef0f3" />

      {rows.map((r, i) => {
        const isUp = r.close >= r.open;
        const col = isUp ? UP_COLOR : DOWN_COLOR;
        const x = cx(i);
        const yo = y(r.open);
        const yc = y(r.close);
        const top = Math.min(yo, yc);
        const h = Math.max(1, Math.abs(yc - yo));
        return (
          <g key={r.date}>
            <line x1={x} y1={y(r.high)} x2={x} y2={y(r.low)} stroke={col} strokeWidth={1} />
            <rect x={x - candleW / 2} y={top} width={candleW} height={h} fill={col} />
          </g>
        );
      })}

      {/* 买入价水平线（绿） + 买入日三角标记 */}
      {showPoints && buyPrice != null && (
        <g>
          <line
            x1={PAD_L}
            y1={y(buyPrice)}
            x2={W - PAD_R}
            y2={y(buyPrice)}
            stroke={DOWN_COLOR}
            strokeWidth={1.4}
            strokeDasharray="6 4"
          />
          <text x={PAD_L + 2} y={y(buyPrice) - 4} fontSize={11} fill={DOWN_COLOR}>
            买入 {fmtNum(buyPrice)}
          </text>
          {buyDate != null && idxByDate.has(buyDate) && (() => {
            const x = cx(idxByDate.get(buyDate)!);
            return <polygon points={`${x},${PAD_T - 2} ${x - 5},${PAD_T - 11} ${x + 5},${PAD_T - 11}`} fill={DOWN_COLOR} />;
          })()}
        </g>
      )}

      {/* 卖出价水平线（红） + 卖出日三角标记 */}
      {showPoints && sellPrice != null && (
        <g>
          <line
            x1={PAD_L}
            y1={y(sellPrice)}
            x2={W - PAD_R}
            y2={y(sellPrice)}
            stroke={UP_COLOR}
            strokeWidth={1.4}
            strokeDasharray="6 4"
          />
          <text x={W - PAD_R - 2} y={y(sellPrice) + 13} fontSize={11} fill={UP_COLOR} textAnchor="end">
            卖出 {fmtNum(sellPrice)}
          </text>
          {sellDate != null && idxByDate.has(sellDate) && (() => {
            const x = cx(idxByDate.get(sellDate)!);
            return <polygon points={`${x},${H - PAD_B + 2} ${x - 5},${H - PAD_B + 11} ${x + 5},${H - PAD_B + 11}`} fill={UP_COLOR} />;
          })()}
        </g>
      )}

      {/* X 轴日期刻度 */}
      {ticks.map((t, i) => (
        <text key={i} x={t.x} y={H - 7} fontSize={10} fill="#9ca3af" textAnchor="middle">
          {t.label}
        </text>
      ))}
    </svg>
  );
}

/**
 * 单笔交易详情弹层（P5b，纯展示，绝不可修改记录）。
 * 三块纵向排列：A 基础信息 & 因子贡献 / B 交易点 K 线图 / C 战法规则说明。
 */
export function WinRateTradeDetailModal({
  record,
  onClose,
}: {
  record: WinRateRecord | null;
  onClose: () => void;
}) {
  const [kline, setKline] = useState<KlineResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [kErr, setKErr] = useState<string | null>(null);

  // 仅在 closed 且买卖价齐全时标买卖点；未成交/不可买入仅画蜡烛不标买卖点
  const showPoints =
    record != null &&
    record.trade.status === 'closed' &&
    record.trade.buyPrice != null &&
    record.trade.sellPrice != null;

  // 拉取日 K（6 位码→fullCode）；record 变化或置空时重新取数，组件卸载/切换时取消
  useEffect(() => {
    if (!record) {
      setKline(null);
      setLoading(false);
      setKErr(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setKErr(null);
    marketApi
      .kline(toFullCode(record.code), 'day', 'qfq', 160)
      .then((res) => {
        if (cancelled) return;
        setKline(res);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setKErr(String((e as Error).message || e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [record]);

  // 取交易日期前后的 K 窗口（前后各留 14 根做上下文），记录日作为锚点
  const visibleRows = useMemo<KlineRow[]>(() => {
    if (!record || !kline?.rows?.length) return [];
    const all = kline.rows;
    const startAnchor = record.trade.buyDate ?? record.date;
    const endAnchor = record.trade.sellDate ?? record.date;
    let si = all.findIndex((r) => r.date >= startAnchor);
    if (si < 0) si = 0;
    const from = Math.max(0, si - 14);
    let ei = all.findIndex((r) => r.date > endAnchor);
    if (ei < 0) ei = all.length - 1;
    const to = Math.min(all.length - 1, ei + 14);
    return all.slice(from, to + 1);
  }, [record, kline]);

  if (!record) return null;

  const ret = record.trade.returnPct;
  const cfg = getWinRateConfig(record.strategyId);
  const factors = record.scoreFactors ?? [];
  const maxScore = factors.reduce((m, f) => (f.score == null ? m : Math.max(m, f.score)), 0) || 1;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal wr-detail-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>交易详情</h3>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="wr-detail-body">
          {/* A. 基础信息 & 因子贡献 */}
          <section className="detail-section">
            <div className="ds-head">基础信息 &amp; 因子贡献</div>
            <div className="wr-detail-basic">
              <div>
                <span>战法</span>
                <strong>{record.strategyName}</strong>
              </div>
              <div>
                <span>股票</span>
                <strong>
                  {record.name} <span className="mono muted">{record.code}</span>
                </strong>
              </div>
              <div>
                <span>记录日</span>
                <strong className="mono">{record.date}</strong>
              </div>
              <div>
                <span>状态</span>
                <span className={`wr-status wr-status-${record.trade.status}`}>
                  {TRADE_STATUS_LABELS[record.trade.status]}
                </span>
              </div>
              <div>
                <span>收益率</span>
                <strong className={ret == null ? '' : ret >= 0 ? 'ret-pos' : 'ret-neg'}>
                  {ret == null ? '—' : `${ret.toFixed(2)}%`}
                </strong>
              </div>
              <div>
                <span>卖出原因</span>
                <strong>{SELL_REASON_LABELS[record.trade.sellReason]}</strong>
              </div>
            </div>

            <div className="wr-score-total">
              确定性评分：
              <strong>{record.determinismScore == null ? '数据未提供' : record.determinismScore.toFixed(1)}</strong>
            </div>

            {factors.length === 0 ? (
              <div className="muted">数据未提供（本记录无因子贡献快照）</div>
            ) : (
              <div className="wr-factors">
                {factors.map((f) => {
                  const pct = f.score == null ? 0 : Math.max(0, Math.min(100, (f.score / maxScore) * 100));
                  return (
                    <div className="wr-factor" key={f.key}>
                      <div className="wr-factor-top">
                        <span className="wr-factor-name">{f.name}</span>
                        <span className="muted">
                          权重 {f.weight}
                          {f.available ? '' : ' · 缺数据'}
                        </span>
                        <span className="wr-factor-score">{f.score == null ? '—' : f.score}</span>
                      </div>
                      <div className="wr-factor-bar">
                        <span style={{ width: `${pct}%` }} />
                      </div>
                      <div className="wr-factor-detail muted">{f.detail}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* B. 交易点 K 线图 */}
          <section className="detail-section">
            <div className="ds-head">交易点 K 线图</div>
            {loading ? (
              <div className="empty">加载中…</div>
            ) : kErr || visibleRows.length === 0 ? (
              <div className="empty">无 K 线数据</div>
            ) : (
              <MiniKline
                rows={visibleRows}
                buyDate={record.trade.buyDate}
                sellDate={record.trade.sellDate}
                buyPrice={record.trade.buyPrice}
                sellPrice={record.trade.sellPrice}
                showPoints={showPoints}
              />
            )}
          </section>

          {/* C. 战法规则说明 */}
          <section className="detail-section">
            <div className="ds-head">战法规则说明</div>
            {cfg ? (
              <div className="wr-rule">
                <div className="wr-rule-row">
                  <span>持有周期</span>
                  <strong>
                    {cfg.holdingRaw}
                    {cfg.holdDays ? `（${cfg.holdDays.min}-${cfg.holdDays.max} 交易日）` : '（未映射）'}
                  </strong>
                </div>
                <div className="wr-rule-row">
                  <span>买卖规则</span>
                  <span>{cfg.ruleNote}</span>
                </div>
                <div className="wr-rule-row muted">
                  <span>参数版本</span>
                  <span>{cfg.paramVersion}</span>
                </div>
              </div>
            ) : (
              <div className="muted">未找到该战法配置（{record.strategyId}）</div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
