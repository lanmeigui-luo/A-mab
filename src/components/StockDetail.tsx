import { useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { usePolling } from '@/hooks/usePolling';
import { marketApi, type EvalResponse } from '@/services/market';
import { KlineChart, type SubIndicator } from '@/components/KlineChart';
import { DeepAnalysis } from '@/components/DeepAnalysis';
import type { Quote, QuoteResponse } from '@/domain/types';
import { changeColor, formatChange, formatPct } from '@/lib/market-colors';
import { DASH, fmtAmount, fmtNum, fmtVolume } from '@/lib/format';
import { calcMA, rangeStats } from '@/lib/indicators';

interface Props {
  fullCode: string;
  name: string;
  quote?: Quote;
  resp: QuoteResponse | null;
  onClose: () => void;
}

type PeriodKey = 'day' | 'week' | 'month' | 'm5' | 'm15' | 'm30' | 'm60';

const PERIODS: { key: PeriodKey; label: string; available: boolean }[] = [
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
  const [period, setPeriod] = useState<PeriodKey>('day');
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

  const isMinute = period.startsWith('m') && period !== 'month';

  const kline = usePolling(
    () =>
      isMinute
        ? marketApi.klineMin(fullCode.slice(2), period.slice(1), fq, 320)
        : marketApi.kline(fullCode, period, fq, count),
    isMinute ? 60000 : 30000,
    [fullCode, period, fq, count],
  );

  const contextText = useMemo(() => {
    const rows = kline.data?.rows ?? [];
    const ma = rows.length ? calcMA(rows) : null;
    const stats = rows.length ? rangeStats(rows) : null;
    const last = rows[rows.length - 1];
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
    lines.push('事件与公告：数据缺失（本页未接入公告通道，不得推测）');
    return lines.join('\n');
  }, [quote, name, fullCode, kline.data, period, fq, isMinute]);

  const color = changeColor(quote?.changePct ?? null);

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

          <label className="check">
            <input type="checkbox" checked={showMa} onChange={(e) => setShowMa(e.target.checked)} />
            MA
          </label>
          <label className="check">
            <input type="checkbox" checked={showBoll} onChange={(e) => setShowBoll(e.target.checked)} />
            BOLL
          </label>

          {/* 副图指标切换（需求 7.2 P1） */}
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

          <div className="seg">
            {[60, 120, 250].map((c) => (
              <button key={c} className={`seg-btn ${count === c ? 'on' : ''}`} onClick={() => setCount(c)}>
                {c}
              </button>
            ))}
          </div>

          <span className="spacer" />
          <span className="src-tag ok">{kline.data?.sourceLabel ?? '加载中'}</span>
          {kline.data?.elapsedMs != null && <span className="muted">{kline.data.elapsedMs} ms</span>}
          <button className="btn primary" onClick={() => setDeepOpen(true)}>
            深度分析
          </button>
        </div>

        {kline.error ? (
          <div className="alert error">K 线获取失败：{kline.error}（已保留上一次数据）</div>
        ) : null}

        {kline.loading && !kline.data ? (
          <div className="empty">加载中…</div>
        ) : kline.data && kline.data.rows.length === 0 ? (
          <div className="empty">暂无该周期 K 线数据</div>
        ) : (
          <KlineChart
            rows={kline.data?.rows ?? []}
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

        <div className="notes">
          <div>数据来源：{resp?.sourceLabel ?? kline.data?.sourceLabel ?? DASH}</div>
          {isMinute && (
            <div className="warn-text">
              分钟线走 AkShare（东财）通道，该通道在本机<b>间歇性可达</b>（已内置 6 次代理/直连交替重试）。
              若下方显示获取失败，请稍后重试或切回日K；不会用模拟数据填补。
            </div>
          )}
          {kline.data?.notes?.map((n) => <div key={n}>{n}</div>)}
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
