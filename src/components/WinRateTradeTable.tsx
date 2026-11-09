import { useMemo, useState } from 'react';
import type { WinRateRecord } from '../domain/winrate';
import {
  SELL_REASON_LABELS,
  TRADE_VIEW_STATUS_LABELS,
  ANOMALY_LABELS,
  tradeTriggerPrice,
  tradeRuleNote,
  tradeInvalidNote,
  tradeViewCategory,
  type TradeViewCategory,
} from '../domain/winrate';

type SortKey = 'date' | 'strategyName' | 'returnPct';
/** 'recorded' 为展示层分类（已记录/待买入），不是数据层 TradeStatus */
type StatusFilter = 'all' | TradeViewCategory;

interface Props {
  /** 已按页面筛选（战法/时间/来源/持有周期）过滤后的记录 */
  records: WinRateRecord[];
  /** 行点击：打开单笔详情弹层（P5b） */
  onSelect?: (record: WinRateRecord) => void;
}

const STATUS_FILTERS: { v: StatusFilter; l: string }[] = [
  { v: 'all', l: '全部' },
  { v: 'recorded', l: '已记录' },
  { v: 'open', l: '持仓中' },
  { v: 'closed', l: '已平仓' },
  { v: 'invalid', l: '未成交' },
];

/**
 * 第一列「日期」= 实际动作发生日。**排序与渲染共用本函数**，避免两处口径漂移。
 *  - 已平仓 → 卖出日 sellDate
 *  - 持仓中（open 且已有 buyDate）→ 买入日 buyDate
 *  - 已记录（open 但 buyDate 为空）/ 未成交 / 异常 → 记录日 date
 * 字段缺失一律回退记录日；不按 buyDate+holdDays 推算（holdDays 是交易日数，按自然日相加会跨周末/节假日算错）。
 */
function actionDate(r: WinRateRecord): string {
  if (r.trade.status === 'closed') return r.trade.sellDate ?? r.date;
  if (r.trade.status === 'open' && r.trade.buyDate) return r.trade.buyDate;
  return r.date;
}

/**
 * 第四列「信号 / 判定日」= 信号 / 建仓 / 判定日，与第一列互补，保证复盘时两个日期都不丢：
 *  - 未成交 → 判定当天 invalidDate（次日高开/一字板、记录日封板等）；
 *    老数据或记录生成阶段直接判 invalid 的记录没有该字段，回退记录日 r.date 并说明
 *  - 已平仓 → 买入日 buyDate（卖出日已在第一列）
 *  - 其余（已记录/持仓中）→ 记录日 date
 */
function signalDate(r: WinRateRecord): string | null {
  if (r.trade.status === 'invalid') return r.trade.invalidDate ?? r.date;
  if (r.trade.status === 'closed') return r.trade.buyDate;
  return r.date;
}

/** 交易明细表：支持按战法/时间/收益率排序，按状态筛选；异常标注仅经 ANOMALY_LABELS 取中文 */
export function WinRateTradeTable({ records, onSelect }: Props) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const rows = useMemo(() => {
    let r = records;
    // 按视图分类筛选：open 且 buyPrice==null 归「已记录」，「持仓中」严格为已买入未卖出
    if (statusFilter !== 'all') r = r.filter((x) => tradeViewCategory(x) === statusFilter);
    const arr = [...r];
    arr.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      if (sortKey === 'returnPct') {
        av = a.trade.returnPct ?? -Infinity;
        bv = b.trade.returnPct ?? -Infinity;
      } else if (sortKey === 'strategyName') {
        av = a.strategyName;
        bv = b.strategyName;
      } else {
        // 排序严格按第一列实际显示值（actionDate），保证「看到的日期」与排序依据一致
        av = actionDate(a);
        bv = actionDate(b);
      }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [records, statusFilter, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(k);
      setSortDir('desc');
    }
  };
  const sortMark = (k: SortKey) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>交易明细</h2>
        <span className="muted">共 {rows.length} 条</span>
      </div>

      <div className="wr-table-toolbar">
        <div className="seg">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s.v}
              className={`seg-btn ${statusFilter === s.v ? 'on' : ''}`}
              onClick={() => setStatusFilter(s.v)}
            >
              {s.l}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">当前筛选无交易明细</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="wr-th-sort" onClick={() => toggleSort('date')}>
                  日期{sortMark('date')}
                </th>
                <th className="wr-th-sort" onClick={() => toggleSort('strategyName')}>
                  战法{sortMark('strategyName')}
                </th>
                <th>股票</th>
                <th>信号 / 判定日</th>
                <th className="num">买入价</th>
                <th className="num">卖出价</th>
                <th className="num">触发价</th>
                <th className="num">持有天数</th>
                <th className="num wr-th-sort" onClick={() => toggleSort('returnPct')}>
                  收益率{sortMark('returnPct')}
                </th>
                <th>卖出原因</th>
                <th>执行规则</th>
                <th>状态</th>
                <th>异常标注</th>
                <th>标记</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const ret = r.trade.returnPct;
                const category = tradeViewCategory(r);
                const anomalies = r.trade.anomalies.map((a) => ANOMALY_LABELS[a]).join('、');
                return (
                  <tr
                    key={r.id}
                    className={onSelect ? 'wr-row-click' : undefined}
                    onClick={onSelect ? () => onSelect(r) : undefined}
                    title={onSelect ? '点击查看交易详情' : undefined}
                  >
                    {/* 实际动作发生日（见 actionDate）；悬停 title 始终给出记录日，便于复盘核对选股日 */}
                    <td className="mono" title={`记录日 ${r.date}`}>
                      {actionDate(r)}
                    </td>
                    <td>{r.strategyName}</td>
                    <td>
                      <span className="wr-stock">{r.name}</span>
                      <span className="wr-code">{r.code}</span>
                    </td>
                    <td
                      className="mono"
                      title={
                        r.trade.status === 'invalid' && !r.trade.invalidDate
                          ? '老数据未落盘判定日，此处显示记录日'
                          : undefined
                      }
                    >
                      {signalDate(r) ?? '—'}
                    </td>
                    <td className="num mono">
                      {r.trade.buyPrice == null ? '—' : r.trade.buyPrice.toFixed(2)}
                    </td>
                    <td className="num mono">
                      {r.trade.sellPrice == null ? '—' : r.trade.sellPrice.toFixed(2)}
                    </td>
                    <td className="num mono">
                      {(() => {
                        const tp = tradeTriggerPrice(r);
                        return tp == null ? '—' : tp.toFixed(2);
                      })()}
                    </td>
                    <td className="num mono">{r.trade.holdDays == null ? '—' : r.trade.holdDays}</td>
                    <td
                      className={`num mono ${
                        ret == null ? '' : ret >= 0 ? 'ret-pos' : 'ret-neg'
                      }`}
                    >
                      {ret == null ? '—' : `${ret.toFixed(2)}%`}
                    </td>
                    <td>{SELL_REASON_LABELS[r.trade.sellReason]}</td>
                    <td className="wr-rule-note">
                      {tradeInvalidNote(r) ??
                        (category === 'recorded'
                          ? r.buyTiming === 't_close'
                            ? '记录日尾盘买入（收盘价待定）'
                            : '次日开盘买入'
                          : tradeRuleNote(r))}
                    </td>
                    <td>
                      <span className={`wr-status wr-status-${category}`}>
                        {TRADE_VIEW_STATUS_LABELS[category]}
                      </span>
                    </td>
                    <td className="wr-anom">{anomalies || '—'}</td>
                    <td className="wr-tags">
                      {r.trade.excludedFromStats && <span className="chip warn">已排除分母</span>}
                      {r.trade.sellReason === 'ambiguous_intraday' && (
                        <span className="chip muted">歧义</span>
                      )}
                      {r.trade.ruleVersion === 'v1-legacy' && (
                        <span className="chip muted">历史规则</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
