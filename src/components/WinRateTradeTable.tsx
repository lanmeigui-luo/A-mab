import { useMemo, useState } from 'react';
import type { WinRateRecord, TradeStatus } from '../domain/winrate';
import {
  SELL_REASON_LABELS,
  TRADE_STATUS_LABELS,
  ANOMALY_LABELS,
} from '../domain/winrate';

type SortKey = 'date' | 'strategyName' | 'returnPct';
type StatusFilter = 'all' | TradeStatus;

interface Props {
  /** 已按页面筛选（战法/时间/来源/持有周期）过滤后的记录 */
  records: WinRateRecord[];
  /** 行点击：打开单笔详情弹层（P5b） */
  onSelect?: (record: WinRateRecord) => void;
}

const STATUS_FILTERS: { v: StatusFilter; l: string }[] = [
  { v: 'all', l: '全部' },
  { v: 'open', l: '持仓中' },
  { v: 'closed', l: '已平仓' },
  { v: 'invalid', l: '未成交' },
];

/** 交易明细表：支持按战法/时间/收益率排序，按状态筛选；异常标注仅经 ANOMALY_LABELS 取中文 */
export function WinRateTradeTable({ records, onSelect }: Props) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const rows = useMemo(() => {
    let r = records;
    if (statusFilter !== 'all') r = r.filter((x) => x.trade.status === statusFilter);
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
        av = a.date;
        bv = b.date;
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
                <th className="num">买入价</th>
                <th className="num">卖出价</th>
                <th className="num">持有天数</th>
                <th className="num wr-th-sort" onClick={() => toggleSort('returnPct')}>
                  收益率{sortMark('returnPct')}
                </th>
                <th>卖出原因</th>
                <th>状态</th>
                <th>异常标注</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const ret = r.trade.returnPct;
                const anomalies = r.trade.anomalies.map((a) => ANOMALY_LABELS[a]).join('、');
                return (
                  <tr
                    key={r.id}
                    className={onSelect ? 'wr-row-click' : undefined}
                    onClick={onSelect ? () => onSelect(r) : undefined}
                    title={onSelect ? '点击查看交易详情' : undefined}
                  >
                    <td className="mono">{r.date}</td>
                    <td>{r.strategyName}</td>
                    <td>
                      <span className="wr-stock">{r.name}</span>
                      <span className="wr-code">{r.code}</span>
                    </td>
                    <td className="num mono">
                      {r.trade.buyPrice == null ? '—' : r.trade.buyPrice.toFixed(2)}
                    </td>
                    <td className="num mono">
                      {r.trade.sellPrice == null ? '—' : r.trade.sellPrice.toFixed(2)}
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
                    <td>
                      <span className={`wr-status wr-status-${r.trade.status}`}>
                        {TRADE_STATUS_LABELS[r.trade.status]}
                      </span>
                    </td>
                    <td className="wr-anom">{anomalies || '—'}</td>
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
