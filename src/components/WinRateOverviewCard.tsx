import type { WinRateStats } from '../domain/winrate';

interface Props {
  stats: WinRateStats;
  /** 当前筛选的数据来源；'all' 时主胜率按盘中尾盘 / 收盘并排展示（不池化） */
  priceSourceFilter: 'all' | 'intraday_late' | 'close';
}

function pctRatio(x: number | null): string {
  return x == null ? '—' : `${(x * 100).toFixed(1)}%`;
}
function pctVal(x: number | null): string {
  return x == null ? '—' : `${x.toFixed(2)}%`;
}

/** 战法概览卡：胜率（'all' 不池化，按来源拆开）/ 有效交易 / 平均收益 / 盈亏比 / 最大回撤 / 最大盈利 / 最大亏损 + 样本不足命中占比 + 分口径对比 */
export function WinRateOverviewCard({ stats, priceSourceFilter }: Props) {
  const bd = stats.priceSourceBreakdown;
  const hitsPct = stats.total > 0 ? Math.round((stats.insufficientHitsCount / stats.total) * 100) : 0;
  const isAll = priceSourceFilter === 'all';
  // 仅当选定具体来源时，展示另一来源作为口径对比（'all' 已并入主数字，不再重复）
  const showSplitCompare = !isAll && bd != null && (bd.intraday_late || bd.close);
  const execRate = stats.executableRate;

  return (
    <div className="wr-ov">
      <div className="wr-ov-head">
        <span className="wr-ov-name">{stats.strategyName}</span>
        {stats.insufficientSample && <span className="chip warn">样本不足·仅供参考</span>}
        {stats.ambiguityRate != null && stats.ambiguityRate >= 0.2 && (
          <span className="chip warn">日K回测歧义比例高，胜率置信度低，建议接入分钟数据</span>
        )}
      </div>

      {/* 整卡级口径提示：'all' 下 computeWinRateStats 主统计仍为混算，须明确告知（底层统计逻辑不改） */}
      {isAll && (
        <div className="wr-ov-note">
          混合口径 · 当前汇总了「盘中尾盘」与「收盘」两类数据来源，胜率 / 盈亏比 / 平均收益 / 最大回撤等指标可能混算，仅供参考
        </div>
      )}

      <div className="wr-ov-metrics">
        <div className="wr-ov-metric">
          <div className="wr-ov-label">胜率</div>
          <div className="wr-ov-value">
            {isAll && bd ? (
              <span className="wr-ov-win-split">
                <span className="wr-ov-win-item">
                  <span className="wr-ov-win-k">尾盘</span>
                  {pctRatio(bd.intraday_late?.winRate ?? null)}
                </span>
                <span className="wr-ov-win-sep">/</span>
                <span className="wr-ov-win-item">
                  <span className="wr-ov-win-k">收盘</span>
                  {pctRatio(bd.close?.winRate ?? null)}
                </span>
              </span>
            ) : (
              pctRatio(stats.winRate)
            )}
          </div>
        </div>
        <div className="wr-ov-metric">
          <div className="wr-ov-label">有效交易</div>
          <div className="wr-ov-value mono">{stats.closed}</div>
        </div>
        <div className="wr-ov-metric">
          <div className="wr-ov-label">买入执行率</div>
          <div className={`wr-ov-value mono ${execRate != null && execRate < 0.2 ? 'ret-neg' : ''}`}>
            {execRate == null ? '—' : `${Math.round(execRate * 100)}%`}
          </div>
          {execRate != null && execRate < 0.2 && (
            <div className="wr-ov-sub">实盘几乎买不进，胜率不可信</div>
          )}
        </div>
        <div className="wr-ov-metric">
          <div className="wr-ov-label">平均收益</div>
          <div
            className={`wr-ov-value mono ${
              stats.avgReturnPct == null ? '' : stats.avgReturnPct >= 0 ? 'ret-pos' : 'ret-neg'
            }`}
          >
            {pctVal(stats.avgReturnPct)}
          </div>
        </div>
        <div className="wr-ov-metric">
          <div className="wr-ov-label">盈亏比</div>
          <div className="wr-ov-value mono">{stats.profitFactor == null ? '—' : stats.profitFactor.toFixed(2)}</div>
        </div>
        <div className="wr-ov-metric">
          <div className="wr-ov-label">最大回撤</div>
          <div className="wr-ov-value mono">{pctVal(stats.maxDrawdown)}</div>
        </div>
        <div className="wr-ov-metric">
          <div className="wr-ov-label">最大盈利</div>
          <div className={`wr-ov-value mono ${stats.maxProfitPct == null ? '' : 'ret-pos'}`}>
            {pctVal(stats.maxProfitPct)}
          </div>
        </div>
        <div className="wr-ov-metric">
          <div className="wr-ov-label">最大亏损</div>
          <div className={`wr-ov-value mono ${stats.maxLossPct == null ? '' : 'ret-neg'}`}>
            {pctVal(stats.maxLossPct)}
          </div>
        </div>
      </div>

      <div className="wr-ov-note">
        买入执行率 {stats.total - stats.invalidCount}/{stats.total}（未成交 {stats.invalidCount} 笔；未结算记录计入可执行）
      </div>

      <div className="wr-ov-note">
        样本不足命中占比 {stats.insufficientHitsCount}/{stats.total}（{hitsPct}%）
      </div>

      {stats.insufficientSample && (
        <div className="wr-ov-note">
          样本不足：有效交易 {stats.closed} 笔（&lt;10），胜率仅供参考
        </div>
      )}

      {stats.ambiguityRate != null && stats.ambiguityRate > 0 && (
        <div className="wr-ov-note">
          因日K歧义排除 {stats.ambiguousExcluded} 笔（歧义比例{' '}
          {Math.round(stats.ambiguityRate * 100)}%）
        </div>
      )}

      {stats.unbucketedCount > 0 && (
        <div className="wr-ov-note">
          持有天数缺失（未平仓/异常）：{stats.unbucketedCount} 条未计入分布
        </div>
      )}

      {showSplitCompare && (
        <div className="wr-ov-split">
          分口径对比：
          {bd!.intraday_late ? `盘中尾盘 ${pctRatio(bd!.intraday_late.winRate)}` : '盘中尾盘 —'}
          {' · '}
          {bd!.close ? `收盘 ${pctRatio(bd!.close.winRate)}` : '收盘 —'}
        </div>
      )}
    </div>
  );
}
