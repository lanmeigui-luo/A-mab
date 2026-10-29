import { useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { usePolling } from '@/hooks/usePolling';
import { marketApi, type EvalResponse } from '@/services/market';
import { KlineChart, type SubIndicator } from '@/components/KlineChart';
import { DeepAnalysis } from '@/components/DeepAnalysis';
import type { Quote, QuoteResponse, MinuteResponse, KlineResponse } from '@/domain/types';
import { changeColor, formatChange, formatPct } from '@/lib/market-colors';
import { DASH, fmtAmount, fmtNum, fmtVolume } from '@/lib/format';
import { calcMA, rangeStats } from '@/lib/indicators';
import { useWinRateStore } from '@/hooks/useWinRateStore';
import { computeWinRateStats, filterWinRateRecords } from '@/lib/winrate-stats';
import { TRADE_STATUS_LABELS } from '@/domain/winrate';

interface Props {
  fullCode: string;
  name: string;
  quote?: Quote;
  resp: QuoteResponse | null;
  onClose: () => void;
}

type PeriodKey = 'minute' | 'day' | 'week' | 'month' | 'm5' | 'm15' | 'm30' | 'm60';

const PERIODS: { key: PeriodKey; label: string; available: boolean }[] = [
  { key: 'minute', label: '分时', available: true },
  { key: 'day', label: '日K', available: true },
  { key: 'week', label: '周K', available: true },
  { key: 'month', label: '月K', available: true },
  { key: 'm60', label: '60分', available: true },
  { key: 'm30', label: '30分', available: true },
  { key: 'm15', label: '15分', available: true },
  { key: 'm5', label: '5分', available: true },
];

const FQ: { key: 'qfq' | 'hfq' | 'none'; label: string }[] = [
  { key: 'qfq', label: '前复权' },
  { key: 'hfq', label: '后复权' },
  { key: 'none', label: '不复权' },
];

export function StockDetail({ fullCode, name, quote, resp, onClose }: Props) {
  const [period, setPeriod] = useState<PeriodKey>('minute');
  const [fq, setFq] = useState<'qfq' | 'hfq' | 'none'>('qfq');
  const [showMa, setShowMa] = useState(true);
  const [showBoll, setShowBoll] = useState(false);
  const [sub, setSub] = useState<SubIndicator>('vol');
  const [count, setCount] = useState(120);
  const [deepOpen, setDeepOpen] = useState(false);

  // 右边缘侧栏宽度（可拖拽左缘伸缩）
  const [width, setWidth] = useState(460);
  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const nw = Math.min(920, Math.max(340, startW + (startX - ev.clientX)));
      setWidth(nw);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // 单股评估：命中战法 + 评分 + 买卖计划（与选股结果同一套规则）
  const ev = usePolling<EvalResponse>(() => marketApi.eval(fullCode), 60000, [fullCode]);
  const tradePlan = ev.data?.tradePlan ?? null;
  const signals = ev.data?.strategies ?? [];

  const isIntraday = period === 'minute';
  const isMinute = period.startsWith('m') && period !== 'month';

  // 分时（腾讯当日分钟序列）：仅在分时周期激活轮询，避免空轮询
  const minute = usePolling<MinuteResponse>(
    () => marketApi.minute(fullCode),
    15000,
    [fullCode],
    isIntraday,
  );

  const kline = usePolling<KlineResponse>(
    () =>
      isMinute
        ? marketApi.klineMin(fullCode.slice(2), period.slice(1), fq, 320)
        : marketApi.kline(fullCode, period, fq, count),
    isMinute ? 60000 : 30000,
    [fullCode, period, fq, count],
    !isIntraday,
  );

  // 当前周期实际使用的取数通道（分时→minute，其余→kline）
  const active = isIntraday ? minute : kline;

  const contextText = useMemo(() => {
    const lines = [
      `标的：${quote?.name ?? name}（${fullCode}）`,
      `行情快照：现价 ${quote?.price ?? DASH}，涨跌幅 ${
        quote?.changePct != null ? quote.changePct.toFixed(2) + '%' : DASH
      }，换手率 ${quote?.turnoverRate != null ? quote.turnoverRate.toFixed(2) + '%' : DASH}`,
      `成交：成交量 ${fmtVolume(quote?.volume ?? null)}，成交额 ${fmtAmount(quote?.amountWan ?? null)}`,
      `振幅 ${quote?.amplitude != null ? quote.amplitude + '%' : DASH} · PE ${
        quote?.pe != null ? quote.pe.toFixed(2) : DASH
      }`,
      `涨停价 ${quote?.limitUpPrice ?? DASH}（现价等于涨停价即为涨停状态）`,
      '量比：数据缺失（当前通道不提供，不得推测）',
      '主力净流入：数据缺失（本页未接入资金流排名，不得推测）',
    ];

    if (isIntraday) {
      const rows = minute.data?.rows ?? [];
      const last = rows[rows.length - 1];
      const prevClose = quote?.prevClose;
      lines.push(
        `分时（腾讯当日分钟序列，数据源 ${minute.data?.sourceLabel ?? DASH}）：共 ${rows.length} 个分钟点`,
      );
      if (last) {
        const pct =
          prevClose != null && prevClose !== 0
            ? ((last.price - prevClose) / prevClose) * 100
            : null;
        lines.push(
          `当前价 ${fmtNum(last.price)}，均价 ${fmtNum(last.avg)}，相对昨收 ${
            pct != null ? pct.toFixed(2) + '%' : DASH
          }`,
          `累计成交 ${fmtVolume(last.cumVolume)}，累计成交额 ${fmtAmount(last.cumAmount / 10000)}`,
        );
      }
    } else {
      const rows = kline.data?.rows ?? [];
      const ma = rows.length ? calcMA(rows) : null;
      const stats = rows.length ? rangeStats(rows) : null;
      const last = rows[rows.length - 1];
      if (last && ma) {
        const i = rows.length - 1;
        lines.push(
          `K线（${period}，${
            isMinute ? 'AkShare 东财分钟线' : fq
          }）：最新 ${last.date} 开${last.open} 高${last.high} 低${last.low} 收${last.close} 量${last.volume}`,
          `均线：MA5 ${fmtNum(ma.ma5[i])} / MA10 ${fmtNum(ma.ma10[i])} / MA20 ${fmtNum(ma.ma20[i])} / MA60 ${fmtNum(ma.ma60[i])}`,
        );
      }
      if (stats) {
        lines.push(
          `区间统计：${stats.days} 根，涨跌 ${stats.changePct?.toFixed(2)}%，最高 ${stats.high}，最低 ${stats.low}`,
        );
      }
    }

    lines.push('事件与公告：数据缺失（本页未接入公告通道，不得推测）');
    return lines.join('\n');
  }, [quote, name, fullCode, minute.data, kline.data, period, fq, isIntraday, isMinute]);

  const color = changeColor(quote?.changePct ?? null);

  // P5a：个股联动 —— 复用 store + computeWinRateStats / filterWinRateRecords，按 6 位 code 过滤
  const wr = useWinRateStore();
  const stockCode = fullCode.slice(2);
  const stockRecords = useMemo(
    () => filterWinRateRecords(wr.records, { code: stockCode, excludeAnomaly: true }),
    [wr.records, stockCode],
  );
  const stockStats = useMemo(
    () => computeWinRateStats(wr.records, { code: stockCode, excludeAnomaly: true }),
    [wr.records, stockCode],
  );
  const stockLatest = useMemo(() => {
    if (stockRecords.length === 0) return null;
    const sorted = [...stockRecords].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      const ra = a.recordedAt ?? '';
      const rb = b.recordedAt ?? '';
      return ra < rb ? 1 : -1;
    });
    return sorted[0];
  }, [stockRecords]);
  const stockWinRate = useMemo(() => {
    let closed = 0;
    let wins = 0;
    for (const s of stockStats.byStrategy) {
      closed += s.closed;
      wins += s.wins;
    }
    return closed > 0 ? { rate: wins / closed, closed } : null;
  }, [stockStats]);

  return (
    <aside className="detail-panel" style={{ width }}>
      <div className="detail-resize" onMouseDown={startResize} title="拖拽调整宽度" />
      <header className="drawer-head">
        <h2>{quote?.name ?? name}</h2>
        <span className="mono muted">{fullCode}</span>
        <span className="price" style={{ color }}>
          {fmtNum(quote?.price ?? null)}
        </span>
        <span className="pct" style={{ color }}>
          {quote ? formatPct(quote.changePct) + '%' : DASH}
        </span>
        <span className="pct" style={{ color }}>
          {formatChange(quote?.change ?? null)}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          收起
        </button>
      </header>

        <div className="toolbar">
          <div className="seg">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                className={`seg-btn ${period === p.key ? 'on' : ''} ${p.available ? '' : 'disabled'}`}
                title={p.available ? '' : '分钟线通道暂不可用（阶段 4 接入）'}
                onClick={() => p.available && setPeriod(p.key)}
                disabled={!p.available}
              >
                {p.label}
              </button>
            ))}
          </div>

          {!isIntraday && (
            <div className="seg">
              {FQ.map((f) => (
                <button
                  key={f.key}
                  className={`seg-btn ${fq === f.key ? 'on' : ''}`}
                  onClick={() => setFq(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}

          {!isIntraday && (
            <label className="check">
              <input type="checkbox" checked={showMa} onChange={(e) => setShowMa(e.target.checked)} />
              MA
            </label>
          )}
          {!isIntraday && (
            <label className="check">
              <input type="checkbox" checked={showBoll} onChange={(e) => setShowBoll(e.target.checked)} />
              BOLL
            </label>
          )}

          {/* 副图指标切换（需求 7.2 P1，分时模式不显示） */}
          {!isIntraday && (
            <div className="seg">
              {([
                { key: 'vol', label: '成交量' },
                { key: 'macd', label: 'MACD' },
                { key: 'kdj', label: 'KDJ' },
                { key: 'rsi', label: 'RSI' },
              ] as { key: SubIndicator; label: string }[]).map((s) => (
                <button
                  key={s.key}
                  className={`seg-btn ${sub === s.key ? 'on' : ''}`}
                  onClick={() => setSub(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}

          {!isIntraday && (
            <div className="seg">
              {[60, 120, 250].map((c) => (
                <button key={c} className={`seg-btn ${count === c ? 'on' : ''}`} onClick={() => setCount(c)}>
                  {c}
                </button>
              ))}
            </div>
          )}

          <span className="spacer" />
          <span className="src-tag ok">{active.data?.sourceLabel ?? '加载中'}</span>
          {active.data?.elapsedMs != null && <span className="muted">{active.data.elapsedMs} ms</span>}
          <button className="btn primary" onClick={() => setDeepOpen(true)}>
            深度分析
          </button>
        </div>

        {active.error ? (
          <div className="alert error">
            {isIntraday ? '分时' : 'K 线'}获取失败：{active.error}（已保留上一次数据）
          </div>
        ) : null}

        {active.loading && !active.data ? (
          <div className="empty">加载中…</div>
        ) : active.data && active.data.rows.length === 0 ? (
          <div className="empty">{isIntraday ? '今日暂无分时数据' : '暂无该周期 K 线数据'}</div>
        ) : (
          <KlineChart
            rows={isIntraday ? [] : (kline.data?.rows ?? [])}
            intraday={isIntraday ? (minute.data?.rows ?? []) : null}
            prevClose={quote?.prevClose}
            showMa={showMa}
            showBoll={showBoll}
            sub={sub}
            plan={tradePlan}
            signals={signals}
          />
        )}

        {/* —— 战法信号区（需求 7.1）—— */}
        <section className="detail-section">
          <div className="ds-head">
            战法信号
            {ev.data?.contextAvailable && (
              <span className="muted">
                {' '}· 上下文：资金{ev.data.contextAvailable.fund ? '✓' : '✕'} 板块
                {ev.data.contextAvailable.board ? '✓' : '✕'} 涨停池
                {ev.data.contextAvailable.limitPool ? '✓' : '✕'}
              </span>
            )}
            {ev.data?.elapsedMs != null && <span className="muted"> · {ev.data.elapsedMs} ms</span>}
          </div>
          {ev.error && <div className="alert error">战法评估失败：{ev.error}</div>}
          {!ev.error && signals.length === 0 && (
            <div className="empty">
              {ev.data?.ok === false
                ? (ev.data.reason ?? '无法评估')
                : '当前未命中任何战法'}
            </div>
          )}
          {signals.length > 0 && (
            <div className="cond-box">
              {signals.map((s) => (
                <div key={s.id} className="cond-group">
                  <strong>
                    {s.name}
                    <span className="muted"> · 条件命中 {(s.hitRatio * 100).toFixed(0)}%</span>
                  </strong>
                  <ul>
                    {s.conds.map((c) => (
                      <li key={c.key} className={c.pass ? 'pass' : 'fail'}>
                        {c.pass ? '✓' : c.na ? '–' : '✕'} {c.key}：{c.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* —— 买卖计划区（需求 7.3）—— */}
        <section className="detail-section">
          <div className="ds-head">
            买卖计划
            {tradePlan && (
              <span className="muted">
                {' '}· 依据「{tradePlan.strategyName}」 · 建议仓位 {tradePlan.suggestPositionPct}% · 持有{' '}
                {tradePlan.holding}
              </span>
            )}
          </div>
          {!tradePlan ? (
            <div className="empty">无可用战法依据，不给出买卖价</div>
          ) : (
            <div className="plan-box">
              <div className="plan-grid">
                <div>
                  <span>买入区间</span>
                  <strong>
                    {tradePlan.buyBlockedByLimitUp
                      ? '涨停不可买入'
                      : tradePlan.buyLow != null
                        ? `${fmtNum(tradePlan.buyLow)}~${fmtNum(tradePlan.buyHigh)}`
                        : '不可算'}
                  </strong>
                  <em>{tradePlan.buyBasis}</em>
                </div>
                <div>
                  <span>加仓价</span>
                  <strong>{tradePlan.addPrice != null ? fmtNum(tradePlan.addPrice) : DASH}</strong>
                  <em>{tradePlan.addBasis}</em>
                </div>
                <div>
                  <span>止损价</span>
                  <strong>
                    {tradePlan.stop != null ? fmtNum(tradePlan.stop) : DASH}
                    {tradePlan.stopLossPct != null ? `（${tradePlan.stopLossPct}%）` : ''}
                  </strong>
                  <em>{tradePlan.stopBasis}</em>
                </div>
                <div>
                  <span>目标1</span>
                  <strong>
                    {tradePlan.target1 != null ? fmtNum(tradePlan.target1) : DASH}
                    {tradePlan.target1GainPct != null ? `（+${tradePlan.target1GainPct}%）` : ''}
                  </strong>
                  <em>{tradePlan.target1Basis}</em>
                </div>
                <div>
                  <span>目标2</span>
                  <strong>
                    {tradePlan.target2 != null ? fmtNum(tradePlan.target2) : DASH}
                    {tradePlan.target2GainPct != null ? `（+${tradePlan.target2GainPct}%）` : ''}
                  </strong>
                  <em>{tradePlan.target2Basis}</em>
                </div>
                <div>
                  <span>盈亏比</span>
                  <strong>
                    {tradePlan.profitLossRatio != null ? tradePlan.profitLossRatio.toFixed(2) : DASH}
                  </strong>
                  <em>{tradePlan.note}</em>
                </div>
              </div>
              {tradePlan.missing.length > 0 && (
                <div className="muted">
                  输入缺失：{tradePlan.missing.join('、')}（对应项不可算，未用固定值硬凑）
                </div>
              )}
              {/* 隔夜持股法专有：次日强制卖出窗口与开盘情形处置（需求 4.2 / 6.3） */}
              {tradePlan.sellWindow && (
                <div className="sell-box">
                  <div className="plan-head">次日卖出计划 · {tradePlan.sellWindow}</div>
                  {!!tradePlan.sellRules?.length && (
                    <ul className="sell-rules">
                      {tradePlan.sellRules.map((r) => (
                        <li key={r.case}>
                          <span className="sr-case">{r.case}</span>
                          <span className="sr-action">{r.action}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {tradePlan.overnightRisk && (
                    <div className="sell-risk">风险提示：{tradePlan.overnightRisk}</div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        <div className="detail-metrics">
          <div className="metric">
            <div className="metric-label">换手率</div>
            <div className="metric-value">{quote?.turnoverRate != null ? quote.turnoverRate + '%' : DASH}</div>
          </div>
          <div className="metric">
            <div className="metric-label">成交量</div>
            <div className="metric-value">{fmtVolume(quote?.volume ?? null)}</div>
          </div>
          <div className="metric">
            <div className="metric-label">成交额</div>
            <div className="metric-value">{fmtAmount(quote?.amountWan ?? null)}</div>
          </div>
          <div className="metric">
            <div className="metric-label">振幅</div>
            <div className="metric-value">{quote?.amplitude != null ? quote.amplitude + '%' : DASH}</div>
          </div>
          <div className="metric">
            <div className="metric-label">涨停价</div>
            <div className="metric-value">{fmtNum(quote?.limitUpPrice ?? null)}</div>
          </div>
          <div className="metric">
            <div className="metric-label">量比</div>
            <div className="metric-value muted">{DASH}</div>
            <div className="metric-note">通道不提供，非模拟值</div>
          </div>
        </div>

        {/* —— 该股战法胜率记录（P5a 跨页面联动，纯数据展示，不涉及单笔详情弹窗）—— */}
        <section className="detail-section">
          <div className="ds-head">该股战法胜率记录</div>
          {stockRecords.length === 0 ? (
            <div className="empty">该股暂无战法胜率记录</div>
          ) : (
            <>
              <div className="plan-head">
                {stockWinRate ? (
                  <>
                    该股历史胜率：<strong>{(stockWinRate.rate * 100).toFixed(0)}%</strong>（共{' '}
                    {stockWinRate.closed} 次平仓）
                  </>
                ) : (
                  <>该股历史胜率：暂无平仓记录（共 {stockRecords.length} 次记录）</>
                )}
              </div>
              {stockLatest && (
                <div className="muted" style={{ marginTop: 6 }}>
                  最近一次：{stockLatest.strategyName} · {stockLatest.date} ·{' '}
                  {stockLatest.trade.status === 'closed' && stockLatest.trade.returnPct != null
                    ? `${stockLatest.trade.returnPct > 0 ? '+' : ''}${stockLatest.trade.returnPct}%`
                    : (TRADE_STATUS_LABELS[stockLatest.trade.status] ?? stockLatest.trade.status)}
                </div>
              )}
            </>
          )}
        </section>

        <div className="notes">
          <div>数据来源：{resp?.sourceLabel ?? active.data?.sourceLabel ?? DASH}</div>
          {isIntraday && (
            <div className="warn-text">
              分时走腾讯当日分钟序列，仅含<b>当日</b>数据；盘后或休市时段可能返回空，属正常现象，不会用模拟数据填补。
            </div>
          )}
          {isMinute && (
            <div className="warn-text">
              分钟线走 AkShare（东财）通道，该通道在本机<b>间歇性可达</b>（已内置 6 次代理/直连交替重试）。
              若下方显示获取失败，请稍后重试或切回日K；不会用模拟数据填补。
            </div>
          )}
          {active.data?.notes?.map((n) => <div key={n}>{n}</div>)}
        </div>

      {deepOpen && (
        <DeepAnalysis
          kind="stock"
          title={`${quote?.name ?? name} ${fullCode}`}
          contextText={contextText}
          onClose={() => setDeepOpen(false)}
        />
      )}
    </aside>
  );
}
