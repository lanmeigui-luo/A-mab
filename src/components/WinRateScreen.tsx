import { Component, useMemo, useState } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { useWinRateStore } from '../hooks/useWinRateStore';
import { computeWinRateStats, filterWinRateRecords, HOLD_DAYS_BUCKETS } from '../lib/winrate-stats';
import type { WinRateFilter } from '../lib/winrate-stats';
import type { PriceSource, WinRateRecord } from '../domain/winrate';
import { listEnabledStrategies } from '../domain/winrate-config';
import { WinRateOverviewCard } from './WinRateOverviewCard';
import { WinRateTradeTable } from './WinRateTradeTable';
import { WinRateTradeDetailModal } from './WinRateTradeDetailModal';
import { EquityCurveChart } from './charts/EquityCurveChart';
import { HoldDaysWinRateChart } from './charts/HoldDaysWinRateChart';
import { SellReasonDistributionChart } from './charts/SellReasonDistributionChart';

type TimeRange = '1w' | '1m' | '3m' | '1y' | 'all';
type SrcFilter = 'all' | PriceSource;

const TIME_RANGES: { v: TimeRange; l: string; days: number | null }[] = [
  { v: '1w', l: '近1周', days: 7 },
  { v: '1m', l: '近1月', days: 30 },
  { v: '3m', l: '近3月', days: 90 },
  { v: '1y', l: '近1年', days: 365 },
  { v: 'all', l: '全部', days: null },
];

const SRC_OPTIONS: { v: SrcFilter; l: string }[] = [
  { v: 'all', l: '全部' },
  { v: 'intraday_late', l: '盘中尾盘' },
  { v: 'close', l: '收盘' },
];

function localDateStr(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateMinusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDateStr(d);
}

/** 战法胜率主页面（P3）：筛选区 + 口径说明 + 概览卡 + 排行榜 + 明细表 + P4 占位 + 免责声明 */

// 错误边界（长期保留）：渲染期抛错时显示到页面，避免 React 静默卸载整棵树。
class WinRateErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[WinRateScreen ErrorBoundary] 捕获渲染错误:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="wr-screen">
          <div className="panel" style={{ border: '1px solid #dc2626' }}>
            <div className="panel-head">
              <h2 style={{ color: '#dc2626' }}>渲染错误（ErrorBoundary 捕获）</h2>
            </div>
            <pre style={{ whiteSpace: 'pre-wrap', color: '#b91c1c', fontSize: 12 }}>
              {String(this.state.error.stack || this.state.error.message)}
            </pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function WinRateScreenInner() {
  const { records, storageOk } = useWinRateStore();
  const enabled = useMemo(() => listEnabledStrategies(), []);
  const enabledIds = useMemo(() => enabled.map((c) => c.strategyId), [enabled]);
  const [selected, setSelected] = useState<string[]>(enabledIds);
  const [timeRange, setTimeRange] = useState<TimeRange>('1m');
  const [holdBucket, setHoldBucket] = useState<string>('');
  const [src, setSrc] = useState<SrcFilter>('intraday_late');
  const [selectedRecord, setSelectedRecord] = useState<WinRateRecord | null>(null);

  const filter: WinRateFilter = useMemo(() => {
    const tr = TIME_RANGES.find((t) => t.v === timeRange)!;
    return {
      strategyIds: selected,
      dateFrom: tr.days != null ? dateMinusDays(tr.days) : undefined,
      holdDaysBucket: holdBucket || undefined,
      priceSource: src,
      excludeAnomaly: true,
    };
  }, [selected, timeRange, holdBucket, src]);

  const result = useMemo(() => computeWinRateStats(records, filter), [records, filter]);
  const filteredRecords = useMemo(() => filterWinRateRecords(records, filter), [records, filter]);

  // P4 图表用记录：尊重时间/战法/数据来源筛选，但去掉「持有周期」过滤
  // （分桶分布图自身即按桶拆分，套用该过滤会让分布退化为单桶）。
  const chartRecords = useMemo(
    () =>
      filterWinRateRecords(records, {
        strategyIds: selected,
        dateFrom:
          TIME_RANGES.find((t) => t.v === timeRange)?.days != null
            ? dateMinusDays(TIME_RANGES.find((t) => t.v === timeRange)!.days!)
            : undefined,
        priceSource: src,
        excludeAnomaly: true,
      }),
    [records, selected, timeRange, src],
  );

  const toggleStrategy = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const hasData = records.length > 0;
  const hasFiltered = filteredRecords.length > 0;

  return (
    <div className="wr-screen">
      {/* 顶部筛选区 + 统计口径说明 */}
      <div className="panel wr-filter">
        <div className="panel-head">
          <h2>战法胜率筛选</h2>
          {!storageOk && <span className="chip warn">本地存储不可用</span>}
        </div>

        <div className="wr-filters">
          <div className="wr-fgroup wr-src-box">
            <span className="wr-flabel">数据来源（口径隔离，位置显眼）</span>
            <div className="seg">
              {SRC_OPTIONS.map((o) => (
                <button
                  key={o.v}
                  className={`seg-btn ${src === o.v ? 'on' : ''}`}
                  onClick={() => setSrc(o.v)}
                >
                  {o.l}
                </button>
              ))}
            </div>
          </div>

          <div className="wr-fgroup wr-grow">
            <span className="wr-flabel">战法（多选，默认全选）</span>
            <div className="wr-chips">
              {enabled.map((c) => (
                <button
                  key={c.strategyId}
                  className={`wr-chip ${selected.includes(c.strategyId) ? 'on' : ''}`}
                  onClick={() => toggleStrategy(c.strategyId)}
                >
                  {c.strategyName}
                </button>
              ))}
            </div>
          </div>

          <div className="wr-fgroup">
            <span className="wr-flabel">时间范围</span>
            <div className="seg">
              {TIME_RANGES.map((t) => (
                <button
                  key={t.v}
                  className={`seg-btn ${timeRange === t.v ? 'on' : ''}`}
                  onClick={() => setTimeRange(t.v)}
                >
                  {t.l}
                </button>
              ))}
            </div>
          </div>

          <div className="wr-fgroup">
            <span className="wr-flabel">持有周期</span>
            <div className="seg">
              <button
                className={`seg-btn ${holdBucket === '' ? 'on' : ''}`}
                onClick={() => setHoldBucket('')}
              >
                全部
              </button>
              {HOLD_DAYS_BUCKETS.map((b) => (
                <button
                  key={b.label}
                  className={`seg-btn ${holdBucket === b.label ? 'on' : ''}`}
                  onClick={() => setHoldBucket(b.label)}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="alert warn wr-caliber">
          胜率基于历史模拟交易；intraday_late 为盘中尾盘记录，与 close
          收盘记录不可混算；样本不足10笔标注仅供参考。持有周期为累积上限桶（≤N天），持有天数为空的记录（未平仓/异常）不计入分布并单独计数。
        </div>
      </div>

      {!hasData ? (
        <div className="empty wr-empty">
          暂无胜率记录。请在交易时段 14:50–15:00 打开应用以触发盘中尾盘记录；收盘记录（close）由后端快照后续回填。
        </div>
      ) : !hasFiltered ? (
        <div className="empty wr-empty">
          {src === 'close'
            ? '当前仅有盘中尾盘记录，收盘快照尚未接入。'
            : src === 'intraday_late'
              ? '当前仅有收盘记录，盘中尾盘记录暂无。'
              : '当前筛选条件下无记录（可能该数据来源暂无数据，或所选时间/战法无命中）。'}
        </div>
      ) : (
        <>
          {/* 概览卡 */}
          <div className="panel">
            <div className="panel-head">
              <h2>战法概览</h2>
              <span className="muted">
                「全部」为混合口径：概览卡主胜率按盘中尾盘 / 收盘拆开并排展示（不池化）；建议切换具体来源看单口径
              </span>
            </div>
            <div className="wr-overview-grid">
              {result.byStrategy.map((s) => (
                <WinRateOverviewCard key={s.strategyId} stats={s} priceSourceFilter={src} />
              ))}
            </div>
          </div>

          {/* 胜率排行榜 */}
          <div className="panel">
            <div className="panel-head">
              <h2>胜率排行榜</h2>
              <span className="muted">按胜率降序（不足样本量标注仅供参考）</span>
            </div>
            <div className="wr-rank">
              {result.ranking.map((r, i) => {
                const bd = result.byStrategy.find((b) => b.strategyId === r.strategyId)?.priceSourceBreakdown;
                return (
                  <div key={r.strategyId} className="wr-rank-row">
                    <div className="wr-rank-main">
                      <span className="wr-rank-no">{i + 1}</span>
                      <span className="wr-rank-name">{r.strategyName}</span>
                      {r.insufficientSample && <span className="chip warn">样本不足</span>}
                    </div>
                    <div className="wr-rank-meta">
                      <span className="wr-rank-win">
                        胜率 {r.winRate == null ? '—' : `${(r.winRate * 100).toFixed(1)}%`}
                      </span>
                      <span>样本 {r.closed}</span>
                      {src === 'all' && bd && (bd.intraday_late || bd.close) && (
                        <span className="wr-rank-split">
                          尾盘{' '}
                          {bd.intraday_late?.winRate == null
                            ? '—'
                            : `${(bd.intraday_late.winRate * 100).toFixed(1)}%`}
                          {' · '}收盘{' '}
                          {bd.close?.winRate == null
                            ? '—'
                            : `${(bd.close.winRate * 100).toFixed(1)}%`}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 交易明细表 */}
          <WinRateTradeTable records={filteredRecords} onSelect={setSelectedRecord} />

          {/* P4 图表层（全自绘 SVG，按数据来源口径隔离） */}
          <div className="panel">
            <div className="panel-head">
              <h2>收益曲线（累计收益率，多战法对比）</h2>
              <span className="muted">按战法固定配色；「全部」口径下每战法分盘中尾盘/收盘两条线（实线/虚线）</span>
            </div>
            <EquityCurveChart records={chartRecords} priceSourceFilter={src} />
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>持有周期胜率（累积上限桶）</h2>
              <span className="muted">每桶独立统计胜率与样本；n&lt;10 半透明标样本不足，n=0 不跳过</span>
            </div>
            <HoldDaysWinRateChart records={chartRecords} priceSourceFilter={src} />
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>卖出原因分布</h2>
              <span className="muted">有效平仓交易按卖出原因统计笔数与占比</span>
            </div>
            <SellReasonDistributionChart records={chartRecords} priceSourceFilter={src} />
          </div>
        </>
      )}

      {/* 页面底部免责声明（固定原文） */}
      <div className="wr-disclaimer">
        本应用仅供学习研究，不构成投资建议，股市有风险，入市需谨慎。胜率统计基于历史模拟，不代表未来收益。
      </div>

      {/* 单笔交易详情弹层（P5b，纯展示） */}
      <WinRateTradeDetailModal record={selectedRecord} onClose={() => setSelectedRecord(null)} />
    </div>
  );
}

export function WinRateScreen() {
  return (
    <WinRateErrorBoundary>
      <WinRateScreenInner />
    </WinRateErrorBoundary>
  );
}
