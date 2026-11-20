import { useEffect, useMemo, useState } from 'react';
import type { WinRateRecord } from '../domain/winrate';
import {
  SELL_REASON_LABELS,
  TRADE_VIEW_STATUS_LABELS,
  ANOMALY_LABELS,
  tradeTriggerPrice,
  tradeRuleNote,
  tradeInvalidNote,
  tradeViewCategory,
  placeholderKind,
  isPlaceholderRecord,
  isRecordedTabVisible,
  type TradeViewCategory,
} from '../domain/winrate';
import { shouldShowIntradayUnfilled } from '../lib/trade-consistency';
import { floatingReturnPct } from '../lib/floating-return';
import { paginate } from '../lib/paginate';
import { Pagination } from './Pagination';
import { filterByToolbar } from '../lib/record-filters';
import { toFullCode } from '../lib/full-code';
import { usePolling } from '../hooks/usePolling';
import { marketApi } from '../services/market';
import type { QuoteResponse } from '../domain/types';

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

/**
 * 已记录行的买入计划文案（按买入风格 + 买入时机）。
 * entryStyle 是 buyTiming 的补充维度（互补不取代）：有 entryStyle 的新记录展示盘中实时口径，
 * 老记录（无 entryStyle）回退原有 buyTiming 文案，零回归。
 */
function buyTimingPlanLabel(
  t: WinRateRecord['buyTiming'],
  style: WinRateRecord['entryStyle'],
): string {
  if (style === 'instant') return '9:30 开盘价判定买入（高开 / 一字板 / 低开则未成交）';
  if (style === 'intraday_limit') return '盘中价格进入买入区间即买入（14:50 未触发交日K复核）';
  if (style === 'daily_only') return '记录日尾盘买入（仅日K结算）';
  if (t === 't_close') return '记录日尾盘买入（收盘价待定）';
  if (t === 't_close_or_next_open') return '记录日收盘优先，买不到顺延次日';
  return '次日开盘买入';
}

/**
 * 混合时机顺延留痕（零字段方案）：实际买入/判定日与记录日不同即为顺延。
 * 不加 anomaly —— winrate-stats 的 excludeAnomaly 会把带任意 anomaly 的记录排除胜率分母。
 */
function deferredNote(r: WinRateRecord): string {
  if (r.buyTiming !== 't_close_or_next_open') return '';
  const actual = r.trade.buyDate ?? r.trade.invalidDate;
  if (!actual) return '';
  return actual === r.date ? ' · 记录日收盘买入' : ' · 记录日买不到，顺延次日';
}

/** 交易明细表：支持按战法/时间/收益率排序，按状态筛选；异常标注仅经 ANOMALY_LABELS 取中文 */
export function WinRateTradeTable({ records, onSelect }: Props) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  // 分页：默认每页 100 条；pageSize=0 表示「全部」。Tab 或每页条数变化时回到第 1 页。
  const [pageSize, setPageSize] = useState<50 | 100 | 0>(100);
  const [page, setPage] = useState(1);
  // 工具栏三条件：股票模糊搜索 / 战法单选 / 单日日期
  const [searchKeyword, setSearchKeyword] = useState('');
  const [filterStrategy, setFilterStrategy] = useState('');
  const [filterDate, setFilterDate] = useState('');
  useEffect(() => {
    setPage(1);
  }, [statusFilter, pageSize, searchKeyword, filterStrategy, filterDate]);

  // 【持仓浮盈】一次性提取所有 open + 有买入价的 fullCode，用 usePolling 30s 批量拉现价。
  // 失败保留上次数据（usePolling 自带），拿不到就回退 '—'，绝不在渲染循环里单只请求。
  const holdingCodes = useMemo(() => {
    const set = new Set<string>();
    for (const r of records) {
      if (r.trade.status === 'open' && r.trade.buyPrice != null) set.add(toFullCode(r.code));
    }
    return [...set].sort();
  }, [records]);
  const codesKey = holdingCodes.join(',');
  const quoteResp = usePolling<QuoteResponse>(
    () => marketApi.quotes(holdingCodes),
    30_000,
    [codesKey],
    holdingCodes.length > 0,
  );
  const priceByCode = useMemo(() => {
    const m = new Map<string, number>();
    for (const q of quoteResp.data?.rows ?? []) {
      if (q?.price != null && q.price > 0) m.set(q.fullCode, q.price);
    }
    return m;
  }, [quoteResp.data]);

  const strategyOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of records) {
      if (r.strategyId && r.strategyName) m.set(r.strategyId, r.strategyName);
    }
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [records]);

  const rows = useMemo(() => {
    let r = records;
    // 按视图分类筛选：open 且 buyPrice==null 归「已记录」，「持仓中」严格为已买入未卖出。
    // 「已记录」Tab 额外纳入两类审计占位记录；tradeViewCategory 本身口径不变（G5 零回归）。
    if (statusFilter !== 'all') {
      r = r.filter((x) => {
        if (statusFilter === 'recorded') {
          // no_signal 占位仅展示到 T+1 交易日 17:00；「全部」Tab 不走这里，永久保留。
          if (!isRecordedTabVisible(x)) return false;
          if (isPlaceholderRecord(x)) return true;
        }
        return tradeViewCategory(x) === statusFilter;
      });
    }
    // 工具栏三条件叠加在当前视图（statusFilter 结果）之上；日期按表格首列 actionDate 判定。
    r = r.filter((x) =>
      filterByToolbar(
        [{ code: x.code, name: x.name, strategyId: x.strategyId, date: actionDate(x) }],
        { keyword: searchKeyword, strategyId: filterStrategy, date: filterDate },
      ).length > 0,
    );
    // 若某日已有真实记录（快照事后补跑成功），剔除该日的 snapshot_missing 占位，避免状态矛盾。
    const realDates = new Set(
      records.filter((x) => !isPlaceholderRecord(x)).map((x) => x.date),
    );
    r = r.filter(
      (x) => !(placeholderKind(x) === 'snapshot_missing' && realDates.has(x.date)),
    );
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
  }, [records, statusFilter, sortKey, sortDir, searchKeyword, filterStrategy, filterDate]);

  // rows 已按日期倒序（默认 sortKey='date' / sortDir='desc'）排列，切片保证最新记录在第 1 页。
  const pageSlice = useMemo(() => paginate(rows, page, pageSize), [rows, page, pageSize]);
  const pageRows = pageSlice.rows;

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
        <div className="wr-table-filters">
          <input
            className="wr-filter-input"
            type="search"
            placeholder="搜代码/名称"
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
          />
          <select
            className="wr-filter-select"
            value={filterStrategy}
            onChange={(e) => setFilterStrategy(e.target.value)}
          >
            <option value="">全部战法</option>
            {strategyOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
          <input
            className="wr-filter-input wr-filter-date"
            type="date"
            value={filterDate}
            onChange={(e) => setFilterDate(e.target.value)}
          />
        </div>
        <Pagination
          variant="inline"
          page={pageSlice.page}
          totalPages={pageSlice.totalPages}
          total={pageSlice.total}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
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
              {pageRows.map((r) => {
                const ret = r.trade.returnPct;
                const category = tradeViewCategory(r);
                // 持仓记录：用批量行情里的实时现价算浮动收益率；无现价回退 '—'
                const isFloating = r.trade.status === 'open' && r.trade.buyPrice != null;
                const livePrice = isFloating ? priceByCode.get(toFullCode(r.code)) : undefined;
                const displayRet = isFloating
                  ? floatingReturnPct(r.trade.buyPrice, livePrice)
                  : ret;
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
                        displayRet == null ? '' : displayRet >= 0 ? 'ret-pos' : 'ret-neg'
                      }${isFloating ? ' wr-floating' : ''}`}
                      title={isFloating ? '浮动盈亏（基于实时现价，30 秒刷新）' : '最终收益率'}
                    >
                      {displayRet == null
                        ? '—'
                        : `${isFloating && displayRet > 0 ? '+' : ''}${displayRet.toFixed(2)}%`}
                    </td>
                    <td>{placeholderKind(r) ? '—' : SELL_REASON_LABELS[r.trade.sellReason]}</td>
                    <td className="wr-rule-note">
                      {(() => {
                        const pk = placeholderKind(r);
                        if (pk) return ANOMALY_LABELS[pk];
                        const invalid = tradeInvalidNote(r);
                        const defer = deferredNote(r);
                        if (invalid) return invalid + defer;
                        if (category === 'recorded') return buyTimingPlanLabel(r.buyTiming, r.entryStyle);
                        return tradeRuleNote(r) + defer;
                      })()}
                    </td>
                    <td>
                      <span className={`wr-status wr-status-${category}`}>
                        {/* 盘中 14:50 未成交为软标记（status 仍 open，晚间日K兜底可翻案），
                            此处单独展示「未成交（待复核）」让状态流转可见；不改 tradeViewCategory 分类口径 */}
                        {placeholderKind(r) === 'no_signal'
                          ? '无信号'
                          : placeholderKind(r) === 'snapshot_missing'
                          ? '快照缺失（当天软件未运行）'
                          : shouldShowIntradayUnfilled(r.trade)
                          ? '未成交（待复核）'
                          : TRADE_VIEW_STATUS_LABELS[category]}
                      </span>
                    </td>
                    <td className="wr-anom">{anomalies || '—'}</td>
                    <td className="wr-tags">
                      {r.trade.monitorBought && <span className="chip">盘中买入</span>}
                      {r.trade.monitorClosed && <span className="chip">盘中平仓</span>}
                      {shouldShowIntradayUnfilled(r.trade) && (
                        <span className="chip warn">盘中未成交·待复核</span>
                      )}
                      {r.trade.entrySource === 'daily_k' && <span className="chip muted">日K兜底</span>}
                      {r.trade.excludedFromStats && <span className="chip warn">已排除分母</span>}
                      {r.trade.anomalies.includes('t_plus_1_violation') && (
                        <span className="chip warn">T+1 违规</span>
                      )}
                      {r.trade.anomalies.includes('missing_plan_anomaly') && (
                        <span className="chip warn">计划残缺</span>
                      )}
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

      <Pagination
        variant="bottom"
        page={pageSlice.page}
        totalPages={pageSlice.totalPages}
        total={pageSlice.total}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </div>
  );
}
