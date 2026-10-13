import { Fragment, useMemo, useState } from 'react';
import type {
  BlockedStat,
  NearMiss,
  OvernightMeta,
  ScreenHit,
  ScreenResponse,
  StrategyDef,
  TradePlan,
} from '@/domain/strategy';
import { changeColor, formatPct } from '@/lib/market-colors';
import { DASH, fmtNum } from '@/lib/format';

interface Props {
  strategies: StrategyDef[];
  resp: ScreenResponse | null;
  error: string | null;
  loading: boolean;
  selected: string[];
  onToggle: (id: string) => void;
  poolSize: number;
  onPoolSize: (n: number) => void;
  onRun: () => void;
  watchCodes: string[];
  onRunWithWatch: () => void;
  /** 战法参数覆盖 */
  params: Record<string, Record<string, number>>;
  onParamChange: (strategyId: string, key: string, value: number) => void;
  onResetParams: (strategyId: string) => void;
  /** 打开个股详情（K线 / 深度分析） */
  onAnalyze: (fullCode: string, name: string) => void;
}

/** 战法分组展示顺序 */
const CATEGORY_ORDER = ['打板类', '尾盘类', '趋势类', '回调类', '量价类', '事件类'];

/** 参数中文名与步长（仅列出可安全调整的数值型参数） */
const PARAM_LABELS: Record<string, { label: string; step: number; unit?: string }> = {
  volRatioMin: { label: '量比下限', step: 0.1 },
  volRatioMax: { label: '量比上限', step: 0.1 },
  turnoverMin: { label: '换手下限', step: 0.5, unit: '%' },
  turnoverMax: { label: '换手上限', step: 0.5, unit: '%' },
  turnoverBan: { label: '换手黑名单', step: 1, unit: '%' },
  floatMvMinYi: { label: '流通市值下限', step: 10, unit: '亿' },
  floatMvMaxYi: { label: '流通市值上限', step: 10, unit: '亿' },
  volVsPrevMin: { label: '量/前日下限', step: 0.1 },
  sealAmtPctOfFloat: { label: '封单占流通', step: 0.5, unit: '%' },
  bodyRatioMin: { label: '实体占比下限', step: 5, unit: '%' },
  sealEarly: { label: '封板时间起', step: 10000 },
  sealLate: { label: '封板时间止', step: 10000 },
  boardTopN: { label: '板块涨幅前', step: 1 },
  boardLimitUpMin: { label: '板块内涨停≥', step: 1 },
  boardMin: { label: '关注板位下限', step: 1 },
  boardMax: { label: '关注板位上限', step: 1 },
  promoteRateMin: { label: '晋级率下限', step: 0.01 },
  maxBoardMin: { label: '连板高度下限', step: 1 },
  brokenRateMax: { label: '炸板率上限', step: 1, unit: '%' },
  atrExpandMin: { label: 'ATR放大倍数', step: 0.05 },
  volMa5Over20Min: { label: '5日均量/20日均量', step: 0.05 },
  bias60Max: { label: '距MA60乖离上限', step: 1, unit: '%' },
  bottomRangeMax: { label: '脱离底部上限', step: 1, unit: '%' },
  chg20Min: { label: '阶段涨幅下限', step: 1, unit: '%' },
  prevGainMin: { label: '前期涨幅下限', step: 1, unit: '%' },
  prevGainMax: { label: '前期涨幅上限', step: 1, unit: '%' },
  volShrinkMin: { label: '缩量比下限', step: 0.05 },
  volShrinkMax: { label: '缩量比上限', step: 0.05 },
  drawdownMin: { label: '回撤下限', step: 1, unit: '%' },
  adjustDaysMax: { label: '调整天数上限', step: 1 },
  prevBoardMin: { label: '前期连板下限', step: 1 },
  prevBoardMax: { label: '前期连板上限', step: 1 },
  restDaysMin: { label: '断板天数下限', step: 1 },
  restDaysMax: { label: '断板天数上限', step: 1 },
  defenseLow: { label: '防守线上浮', step: 0.5, unit: '%' },
  volSumRatioMin: { label: '量能累和比下限', step: 0.1 },
  biasMain: { label: 'BIAS阈值(主板)', step: 0.5, unit: '%' },
  biasGem: { label: 'BIAS阈值(创业科创)', step: 0.5, unit: '%' },
  rsiMax: { label: 'RSI上限', step: 1 },
  kdjJMax: { label: 'KDJ J上限', step: 1 },
  bias20Max: { label: '20日乖离上限', step: 1, unit: '%' },
  boardChangeMin: { label: '板块涨幅下限', step: 0.5, unit: '%' },
  prevLimitUpPerfMin: { label: '昨日涨停溢价下限', step: 0.5, unit: '%' },
  fundNetMin: { label: '主力净流入下限', step: 1000000 },
  changeMin: { label: '涨幅下限', step: 0.5, unit: '%' },
  changeMax: { label: '涨幅上限', step: 0.5, unit: '%' },
  aboveRateMin: { label: '分时水上比例下限', step: 0.05 },
  devFromAvgMax: { label: '偏离均价上限', step: 0.5, unit: '%' },
  boardFundTopN: { label: '板块资金流前', step: 1 },
  minListedDays: { label: '上市天数下限', step: 10, unit: '天' },
  limitDownMax: { label: '跌停家数上限', step: 1, unit: '家' },
  limitDownForceEmpty: { label: '跌停强制空仓', step: 1, unit: '家' },
  indexDropMax: { label: '大盘跌幅下限', step: 0.1, unit: '%' },
};

/** 当前是否处于隔夜持股法的选股窗口（14:30-14:55） */
function inOvernightWindow(now = new Date()): boolean {
  const m = now.getHours() * 60 + now.getMinutes();
  return m >= 14 * 60 + 30 && m <= 14 * 60 + 55;
}

function hhmm(d = new Date()): string {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/**
 * 隔夜持股法 0 命中时的解释。
 * 硬指标叠加后经常一只不剩，只显示「无个股命中」用户无法区分
 * 是今天真没票还是系统坏了 —— 这里把卡在哪一条、最接近的几只都摊开。
 */
function OvernightEmpty({ meta }: { meta: OvernightMeta }) {
  return (
    <div className="ov-empty">
      {meta.emptyBySentiment ? (
        <div className="alert error">
          <div>
            <strong>情绪周期触发强制空仓</strong>：{meta.emptyHint}
          </div>
          {meta.retreatDetail && <div className="ov-retreat">{meta.retreatDetail}</div>}
        </div>
      ) : (
        <div className="alert warn">
          <div>
            <strong>今日无符合条件个股，必须空仓等待</strong>，不强行交易：{meta.emptyHint}
          </div>
        </div>
      )}

      {!!meta.blockedTop?.length && (
        <div className="ov-block">
          <div className="ov-h">卡点统计 · 精算候选被这几条挡住</div>
          <div className="ov-chips">
            {meta.blockedTop.map((b: BlockedStat) => (
              <span key={b.key} className="ov-chip">
                {b.key}
                <strong>{b.count}</strong>
              </span>
            ))}
          </div>
        </div>
      )}

      {!!meta.nearMiss?.length && (
        <div className="ov-block">
          <div className="ov-h">最接近的候选（还差这几条）</div>
          <table className="table ov-table">
            <thead>
              <tr>
                <th>代码</th>
                <th>名称</th>
                <th className="num">涨幅</th>
                <th className="num">换手</th>
                <th className="num">流通市值</th>
                <th>未通过条件</th>
              </tr>
            </thead>
            <tbody>
              {meta.nearMiss.map((n: NearMiss) => (
                <tr key={n.code}>
                  <td className="mono muted">{n.code}</td>
                  <td>{n.name}</td>
                  <td className="num mono">{n.changePct != null ? n.changePct.toFixed(2) + '%' : DASH}</td>
                  <td className="num mono">{n.turnoverRate != null ? n.turnoverRate.toFixed(2) + '%' : DASH}</td>
                  <td className="num mono">{n.floatMvYi != null ? n.floatMvYi.toFixed(0) + '亿' : DASH}</td>
                  <td className="cell-fail">
                    {(n.blockedBy ?? []).map((k) => (
                      <span key={k} className="tag fail">{k}</span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** 隔夜持股法专有：次日强制卖出窗口与开盘情形处置（需求 4.2 / 6.3） */
function OvernightSellPlan({ tp }: { tp: TradePlan }) {
  if (!tp.sellWindow) return null;
  return (
    <div className="sell-box">
      <div className="plan-head">次日卖出计划 · {tp.sellWindow}</div>
      {!!tp.sellRules?.length && (
        <ul className="sell-rules">
          {tp.sellRules.map((r) => (
            <li key={r.case}>
              <span className="sr-case">{r.case}</span>
              <span className="sr-action">{r.action}</span>
            </li>
          ))}
        </ul>
      )}
      {tp.overnightRisk && <div className="sell-risk">风险提示：{tp.overnightRisk}</div>}
    </div>
  );
}

/** 信号强度：由评分与命中率共同决定 */
function signalLevel(hit: ScreenHit): { label: string; cls: string } {
  const s = hit.score.total ?? 0;
  const multi = hit.strategies.length > 1 ? 6 : 0;
  const v = s + multi;
  if (v >= 90) return { label: '极强', cls: 'sig-1' };
  if (v >= 75) return { label: '强', cls: 'sig-2' };
  if (v >= 60) return { label: '中', cls: 'sig-3' };
  return { label: '弱', cls: 'sig-4' };
}

function buyRange(tp: TradePlan | null | undefined): string {
  if (!tp) return DASH;
  if (tp.buyBlockedByLimitUp) return '涨停不可买入';
  if (tp.buyLow == null || tp.buyHigh == null) return '不可算';
  return `${fmtNum(tp.buyLow)}~${fmtNum(tp.buyHigh)}`;
}

export function StrategyScreen({
  strategies,
  resp,
  error,
  loading,
  selected,
  onToggle,
  poolSize,
  onPoolSize,
  onRun,
  watchCodes,
  onRunWithWatch,
  params,
  onParamChange,
  onResetParams,
  onAnalyze,
}: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [paramOpen, setParamOpen] = useState<string | null>(null);
  const [boardFilter, setBoardFilter] = useState('');
  /** 复盘模式：非选股窗口时用最近交易日数据演算（仅隔夜持股法有意义） */
  const [reviewMode, setReviewMode] = useState(false);

  const rows = useMemo(() => resp?.hits ?? [], [resp]);

  // 隔夜持股法：选股窗口外给出提示 + 复盘开关
  const ovDef = useMemo(() => strategies.find((s) => s.id === 'overnight-hold') ?? null, [strategies]);
  const ovOn = ovDef != null && selected.includes(ovDef.id);
  const inWindow = inOvernightWindow();
  const showWindowTip = ovOn && !inWindow;

  // 战法命中统计：命中数量 + 平均确定性评分（需求第二章）
  const statByStrategy = useMemo(() => {
    const m = new Map<string, { n: number; sum: number }>();
    for (const h of rows) {
      for (const s of h.strategies) {
        const cur = m.get(s.id) ?? { n: 0, sum: 0 };
        cur.n += 1;
        cur.sum += h.score.total ?? 0;
        m.set(s.id, cur);
      }
    }
    return m;
  }, [rows]);

  // 可选板块（来自命中结果），用于按板块筛选（需求第六章末）
  const boardOptions = useMemo(() => {
    const set = new Set<string>();
    for (const h of rows) if (h.boardName) set.add(h.boardName);
    return [...set].sort();
  }, [rows]);

  const filtered = useMemo(
    () => (boardFilter ? rows.filter((h) => h.boardName === boardFilter) : rows),
    [rows, boardFilter],
  );

  const groups = useMemo(() => {
    const map = new Map<string, StrategyDef[]>();
    for (const s of strategies) {
      const k = s.category || '其他';
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(s);
    }
    const keys = [...map.keys()].sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a);
      const ib = CATEGORY_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    return keys.map((k) => ({ category: k, items: map.get(k)! }));
  }, [strategies]);

  const usableCount = useMemo(() => strategies.filter((s) => s.available !== false).length, [strategies]);

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>战法选股</h2>
        <span className="muted">规则引擎本地计算 · 共 {strategies.length} 种，已接入 {usableCount} 种</span>
        <span className="spacer" />
        <label className="check">
          候选池
          <select
            className="input"
            style={{ height: 30, minWidth: 80 }}
            value={poolSize}
            onChange={(e) => onPoolSize(Number(e.target.value))}
          >
            <option value={60}>60</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
            <option value={3000}>3000</option>
            <option value={5000}>5000</option>
          </select>
        </label>
        <button className="btn primary" onClick={onRun} disabled={loading || !selected.length}>
          {loading ? '执行中…' : '执行选股'}
        </button>
      </header>

      {groups.map((g) => (
        <div className="strategy-group" key={g.category}>
          <div className="sg-title">{g.category}</div>
          <div className="strategy-grid">
            {g.items.map((s) => {
              const on = selected.includes(s.id);
              const disabled = s.available === false;
              const st = statByStrategy.get(s.id);
              const openThis = paramOpen === s.id;
              const overrides = params[s.id] ?? {};
              const paramKeys = Object.keys(s.params ?? {}).filter((k) => PARAM_LABELS[k]);
              return (
                <div key={s.id} className="strategy-wrap">
                  <button
                    className={`strategy-card ${on ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
                    disabled={disabled}
                    title={disabled ? s.unavailableReason : undefined}
                    onClick={() => !disabled && onToggle(s.id)}
                  >
                    <div className="sc-top">
                      <span className="sc-name">{s.name}</span>
                      <span className="sc-badge">{disabled ? '待接入' : on ? '已选' : '未选'}</span>
                    </div>
                    <div className="sc-desc">{s.desc}</div>
                    <div className="sc-meta">
                      <span>{s.holding}</span>
                      <span className="sc-risk">{s.risk}</span>
                    </div>
                    {s.window && (
                      <div className="sc-window">
                        选股 {s.window.select} · 买入 {s.window.buy} · 卖出 {s.window.sell}
                      </div>
                    )}
                    {s.winRateNote && <div className="sc-rate">参考胜率 {s.winRateNote}</div>}
                    <div className="sc-stat">
                      {disabled ? (
                        <span className="muted">—</span>
                      ) : st ? (
                        <>命中 <strong>{st.n}</strong> 只 · 均分 <strong>{(st.sum / st.n).toFixed(1)}</strong></>
                      ) : (
                        <span className="muted">尚未执行</span>
                      )}
                    </div>
                    {disabled && <div className="sc-na">数据源未接入，不产生信号</div>}
                  </button>
                  {!disabled && paramKeys.length > 0 && (
                    <div className="sc-param-bar">
                      <button className="link" onClick={() => setParamOpen(openThis ? null : s.id)}>
                        {openThis ? '收起参数' : `参数（${Object.keys(overrides).length ? '已改' : '默认'}）`}
                      </button>
                      {Object.keys(overrides).length > 0 && (
                        <button className="link" onClick={() => onResetParams(s.id)}>恢复默认</button>
                      )}
                    </div>
                  )}
                  {openThis && (
                    <div className="param-box">
                      {paramKeys.map((k) => {
                        const meta = PARAM_LABELS[k];
                        const defVal = s.params[k];
                        return (
                          <label key={k} className="param-row">
                            <span className="param-label">
                              {meta.label}{meta.unit ? `（${meta.unit}）` : ''}
                            </span>
                            <input
                              className="input"
                              type="number"
                              step={meta.step}
                              value={overrides[k] ?? defVal}
                              onChange={(e) => onParamChange(s.id, k, Number(e.target.value))}
                            />
                            <span className="param-def muted">默认 {defVal}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {!selected.length && <div className="empty">请至少选择一个战法</div>}

      {showWindowTip && (
        <div className="alert warn ov-window">
          <div>
            <strong>隔夜持股法</strong>的选股窗口为 {ovDef?.window?.select ?? '14:30-14:55'}，
            当前 {hhmm()} 不在窗口内 —— 此窗口外的结果不具备尾盘决策意义。
          </div>
          {ovDef?.window && (
            <div className="muted">
              完整节奏：{ovDef.window.select} 选股 · {ovDef.window.buy} 尾盘买入 · {ovDef.window.sell} 强制卖出
            </div>
          )}
          {ovDef?.reviewable && (
            <label className="check" style={{ marginTop: 6 }}>
              <input
                type="checkbox"
                checked={reviewMode}
                onChange={(e) => setReviewMode(e.target.checked)}
              />
              复盘模式：用最近一个交易日的数据演算（仅供复盘，不是盘中信号）
            </label>
          )}
          {!reviewMode && (
            <div className="muted">未开启复盘模式时，结果仅用于查看规则命中情况，不构成隔夜买入依据。</div>
          )}
        </div>
      )}

      {resp?.ok && ovOn && (reviewMode || inWindow) && (
        <div className={`alert ${reviewMode ? 'info' : 'ok'}`}>
          {reviewMode
            ? '复盘模式：以下结果由最近一个交易日的数据演算得出，已标注为复盘，不作为盘中实时信号。'
            : `当前处于选股窗口（${ovDef?.window?.select}），结果为盘中实时计算。`}
        </div>
      )}

      {error && <div className="alert error">选股失败：{error}</div>}

      {resp?.ok === false && (
        <div className="alert error">
          <div>选股未完成：{resp.reason ?? '未知原因'}</div>
          {resp.needCustomPool && (
            <div style={{ marginTop: 8 }}>
              <button
                className="btn primary"
                onClick={onRunWithWatch}
                disabled={loading || !selected.length || watchCodes.length === 0}
              >
                用自选股（{watchCodes.length} 只）作为候选池执行
              </button>
              {watchCodes.length === 0 && <span className="muted"> · 请先添加自选股</span>}
            </div>
          )}
        </div>
      )}

      {resp?.trading === false && resp?.ok && (
        <div className="alert warn">
          当前处于非交易时段（候选池现价为 0），结果基于最近收盘数据，仅供参考
        </div>
      )}

      {resp?.ok && (
        <>
          <div className="screen-summary">
            <span>
              扫描 <strong>{resp.poolScanned ?? resp.poolSize}</strong> 只
              {resp.prefiltered ? `（预筛剔除 ${resp.prefiltered} 只，${resp.poolSize} 只进入精算）` : ''} ·
              命中 <strong>{resp.hitCount}</strong> 只
            </span>
            <span className="muted">{resp.elapsedMs} ms{resp.cached ? ' · 缓存' : ''}</span>
            {boardOptions.length > 0 && (
              <label className="check">
                板块筛选
                <select
                  className="input"
                  style={{ height: 28, minWidth: 120 }}
                  value={boardFilter}
                  onChange={(e) => setBoardFilter(e.target.value)}
                >
                  <option value="">全部</option>
                  {boardOptions.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </label>
            )}
            <span className="spacer" />
            <span className="muted">候选池：{resp.source.pool} · K线：{resp.source.kline}</span>
          </div>

          {filtered.length === 0 ? (
            resp.overnight ? (
              <OvernightEmpty meta={resp.overnight} />
            ) : (
              <div className="empty">候选池中无个股命中所选战法</div>
            )
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>代码</th>
                    <th>名称</th>
                    <th className="num">现价</th>
                    <th className="num">涨跌幅</th>
                    <th>所属板块</th>
                    <th className="num">板块涨跌</th>
                    <th>命中战法</th>
                    <th className="num">确定性</th>
                    <th>信号</th>
                    <th>买入区间</th>
                    <th className="num">止损</th>
                    <th className="num">目标1</th>
                    <th className="num">盈亏比</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((h) => {
                    const sig = signalLevel(h);
                    const color = changeColor(h.changePct);
                    const open = expanded === h.code;
                    const tp = h.tradePlan;
                    return (
                      <Fragment key={h.code}>
                        <tr>
                          <td className="mono muted">{h.code}</td>
                          <td>{h.name}</td>
                          <td className="num mono" style={{ color }}>{fmtNum(h.price)}</td>
                          <td className="num mono" style={{ color }}>{formatPct(h.changePct)}%</td>
                          <td className="cell-board">{h.boardName ?? DASH}</td>
                          <td className="num mono" style={{ color: changeColor(h.boardPct) }}>
                            {h.boardPct != null ? formatPct(h.boardPct) + '%' : DASH}
                          </td>
                          <td>
                            {h.strategies.map((s) => (
                              <span key={s.id} className="tag">{s.name}</span>
                            ))}
                          </td>
                          <td className="num mono">
                            <strong>{h.score.total ?? DASH}</strong>
                            {h.score.multiplier != null && h.score.multiplier !== 1 && (
                              <span className="muted"> ×{h.score.multiplier}</span>
                            )}
                            <span className="muted"> / 覆盖 {h.score.coverage}%</span>
                          </td>
                          <td><span className={'state ' + sig.cls}>{sig.label}</span></td>
                          <td className="cell-plan" title={tp?.buyBasis}>{buyRange(tp)}</td>
                          <td className="num mono" title={tp?.stopBasis}>
                            {tp?.stop != null ? fmtNum(tp.stop) : DASH}
                          </td>
                          <td className="num mono" title={tp?.target1Basis}>
                            {tp?.target1 != null ? fmtNum(tp.target1) : DASH}
                          </td>
                          <td className="num mono">
                            {tp?.profitLossRatio != null ? tp.profitLossRatio.toFixed(2) : DASH}
                          </td>
                          <td>
                            <button className="link" onClick={() => onAnalyze(h.fullCode, h.name)}>分析</button>
                            <button className="link" onClick={() => setExpanded(open ? null : h.code)}>
                              {open ? '收起' : '明细'}
                            </button>
                          </td>
                        </tr>
                        {open && (
                          <tr className="expand-row">
                            <td colSpan={14}>
                              <div className="factor-box">
                                <div className="factor-head">
                                  确定性评分构成 · {h.score.note}
                                  {h.score.cycle && (
                                    <span className="tag">情绪周期：{h.score.cycle}（×{h.score.multiplier}）</span>
                                  )}
                                </div>
                                <div className="factor-grid">
                                  {h.score.factors.map((f) => (
                                    <div key={f.key} className={`factor ${f.available ? '' : 'missing'}`}>
                                      <div className="f-top">
                                        <span>{f.name}</span>
                                        <span className="f-weight">权重 {(f.weight * 100).toFixed(0)}%</span>
                                        <span className="f-score">{f.available ? f.score : '未纳入'}</span>
                                      </div>
                                      <div className="f-detail">{f.detail}</div>
                                    </div>
                                  ))}
                                </div>
                                {tp && (
                                  <div className="plan-box">
                                    <div className="plan-head">
                                      买卖计划 · 依据「{tp.strategyName}」 · 建议仓位 {tp.suggestPositionPct}% · 持有 {tp.holding}
                                    </div>
                                    <div className="plan-grid">
                                      <div><span>买入区间</span><strong>{buyRange(tp)}</strong><em>{tp.buyBasis}</em></div>
                                      <div><span>加仓价</span><strong>{tp.addPrice != null ? fmtNum(tp.addPrice) : DASH}</strong><em>{tp.addBasis}</em></div>
                                      <div><span>止损价</span><strong>{tp.stop != null ? fmtNum(tp.stop) : DASH}</strong><em>{tp.stopBasis}</em></div>
                                      <div><span>目标1</span><strong>{tp.target1 != null ? fmtNum(tp.target1) : DASH}</strong><em>{tp.target1Basis}</em></div>
                                      <div><span>目标2</span><strong>{tp.target2 != null ? fmtNum(tp.target2) : DASH}</strong><em>{tp.target2Basis}</em></div>
                                      <div><span>盈亏比</span><strong>{tp.profitLossRatio != null ? tp.profitLossRatio.toFixed(2) : DASH}</strong><em>{tp.note}</em></div>
                                    </div>
                                    {tp.missing.length > 0 && (
                                      <div className="muted">输入缺失：{tp.missing.join('、')}（对应项不可算，未用固定值硬凑）</div>
                                    )}
                                  </div>
                                )}
                                {tp && <OvernightSellPlan tp={tp} />}
                                <div className="cond-box">
                                  {h.strategies.map((s) => (
                                    <div key={s.id} className="cond-group">
                                      <strong>{s.name}</strong>
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
                                <div className="ind-box muted">
                                  MA5 {fmtNum(h.indicators.ma5)} / MA10 {fmtNum(h.indicators.ma10)} / MA20{' '}
                                  {fmtNum(h.indicators.ma20)} / MA60 {fmtNum(h.indicators.ma60)} · 量能比{' '}
                                  {fmtNum(h.indicators.volRatio20)} · 20日涨幅 {fmtNum(h.indicators.chg20)}% ·
                                  K线 {h.indicators.bars} 根
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="notes">
            {resp.notes.map((n) => <div key={n}>{n}</div>)}
            {resp.errors.slice(0, 3).map((e) => <div key={e}>{e}</div>)}
          </div>
        </>
      )}
    </section>
  );
}
