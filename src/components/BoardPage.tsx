import { useEffect, useMemo, useState } from 'react';
import type { BoardConsResponse, BoardRow, BoardStock, BoardType } from '@/domain/board';
import { BOARD_TYPES } from '@/domain/board';
import { marketApi } from '@/services/market';
import { changeColor, formatPct } from '@/lib/market-colors';
import { DASH, fmtNum } from '@/lib/format';
import { DeepAnalysis } from '@/components/DeepAnalysis';

interface Props {
  list: BoardRow[] | null;
  loading: boolean;
  error: string | null;
  type: BoardType;
  onType: (t: BoardType) => void;
  elapsedMs?: number;
  source?: string;
}

type SortKey = 'changePct' | 'amount' | 'leadChangePct';
/** 视图模式：卡片视图突出涨跌幅/领涨股，列表视图看全字段 */
type ViewMode = 'list' | 'card';

function yuan(v: number | null): string {
  if (v == null) return DASH;
  const yi = v / 1e8;
  return yi >= 1 ? yi.toFixed(2) + ' 亿' : (v / 1e4).toFixed(2) + ' 万';
}

function BoardDetail({
  board,
  onClose,
  onOpenKline,
}: {
  board: BoardRow;
  onClose: () => void;
  onOpenKline: (fullCode: string, name: string) => void;
}) {
  const [resp, setResp] = useState<BoardConsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deepOpen, setDeepOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    marketApi
      .boardCons(board.label)
      .then((r) => alive && setResp(r))
      .catch((e) => alive && setErr(String(e.message || e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [board.label]);

  const rows = useMemo(
    () => [...(resp?.rows ?? [])].sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity)),
    [resp],
  );

  const boardContext = useMemo(() => {
    const top = rows.slice(0, 8);
    const lines = [
      `板块：${board.name}（${board.label}）`,
      `板块涨跌幅：${board.changePct != null ? board.changePct.toFixed(2) + '%' : DASH}`,
      `成分股数量：${board.count ?? DASH} · 板块均价：${board.avgPrice ?? DASH}`,
      `板块总成交额：${yuan(board.amount)}`,
      `领涨股：${board.leadName ?? DASH}（${
        board.leadChangePct != null ? formatPct(board.leadChangePct) + '%' : DASH
      }）`,
      '',
      '成分股涨跌幅前 8（真实数据）：',
      ...top.map((s) => `  ${s.code} ${s.name} ${s.changePct != null ? s.changePct.toFixed(2) + '%' : DASH} 换手${s.turnoverRate != null ? s.turnoverRate.toFixed(2) + '%' : DASH}`),
      '',
      '板块净流入：数据缺失（新浪源不提供，不得推测）',
      '板块内涨跌家数：数据缺失（新浪源不提供，不得推测）',
      '细分概念/二级行业：数据缺失（未接入，不得推测）',
    ];
    return lines.join('\n');
  }, [board, rows]);

  return (
    <div className="drawer-mask" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>{board.name}</h2>
          <span className="mono muted">{board.label}</span>
          <span className="price" style={{ color: changeColor(board.changePct) }}>
            {board.changePct != null ? board.changePct.toFixed(2) + '%' : DASH}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="detail-metrics">
          <div className="metric">
            <div className="metric-label">成分股</div>
            <div className="metric-value">{board.count ?? DASH}</div>
          </div>
          <div className="metric">
            <div className="metric-label">板块均价</div>
            <div className="metric-value">{fmtNum(board.avgPrice)}</div>
          </div>
          <div className="metric">
            <div className="metric-label">总成交额</div>
            <div className="metric-value">{yuan(board.amount)}</div>
          </div>
          <div className="metric">
            <div className="metric-label">领涨股</div>
            <div className="metric-value" style={{ fontSize: 14 }}>
              {board.leadName ?? DASH}
            </div>
            <div className="metric-note">
              {board.leadPrice != null ? `${board.leadPrice} ` : ''}
              {board.leadChangePct != null ? formatPct(board.leadChangePct) + '%' : ''}
            </div>
          </div>
        </div>

        <section className="panel">
          <header className="panel-head">
            <h2>成分股</h2>
            <span className="muted">按涨跌幅降序 · {resp?.count ?? 0} 只</span>
            <span className="spacer" />
          <span className="src-tag ok">AkShare（新浪板块）</span>
          {resp?.elapsedMs != null && <span className="muted">{resp.elapsedMs} ms</span>}
          <button className="btn primary" onClick={() => setDeepOpen(true)}>
            板块深度分析
          </button>
        </header>

          {err && <div className="alert error">成分股获取失败：{err}</div>}
          {loading && <div className="empty">加载中…</div>}
          {!loading && rows.length === 0 && <div className="empty">暂无成分股</div>}

          {rows.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>代码</th>
                    <th>名称</th>
                    <th className="num">现价</th>
                    <th className="num">涨跌幅</th>
                    <th className="num">换手率</th>
                    <th className="num">成交额</th>
                    <th className="num">PE</th>
                    <th className="num">流通市值</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s: BoardStock) => {
                    const color = changeColor(s.changePct);
                    return (
                      <tr key={s.code}>
                        <td className="mono muted">{s.code}</td>
                        <td>{s.name}</td>
                        <td className="num mono" style={{ color }}>{fmtNum(s.price)}</td>
                        <td className="num mono" style={{ color }}>
                          {s.changePct != null ? formatPct(s.changePct) + '%' : DASH}
                        </td>
                        <td className="num mono">
                          {s.turnoverRate != null ? s.turnoverRate.toFixed(2) + '%' : DASH}
                        </td>
                        <td className="num mono">{yuan(s.amount)}</td>
                        <td className="num mono">{fmtNum(s.pe)}</td>
                        <td className="num mono">
                          {s.floatMvWan != null ? (s.floatMvWan / 10000).toFixed(2) + ' 亿' : DASH}
                        </td>
                        <td>
                          <button className="link" onClick={() => onOpenKline(s.fullCode, s.name)}>
                            K线
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="notes">
            <div>成交额单位已由元自动换算为万元/亿元；流通市值由万元换算为亿元</div>
            <div>命中战法与确定性评分需逐股拉取 K 线计算，暂未在本页展示</div>
          </div>
        </section>
      </div>

      {deepOpen && (
        <DeepAnalysis
          kind="board"
          title={`${board.name} ${board.label}`}
          contextText={boardContext}
          onClose={() => setDeepOpen(false)}
        />
      )}
    </div>
  );
}

export function BoardPage({
  list,
  loading,
  error,
  type,
  onType,
  elapsedMs,
  source,
  onOpenKline,
}: Props & { onOpenKline: (fullCode: string, name: string) => void }) {
  const [keyword, setKeyword] = useState('');
  const [view, setView] = useState<ViewMode>('list');
  const [sort, setSort] = useState<SortKey>('changePct');
  const [desc, setDesc] = useState(true);
  const [detail, setDetail] = useState<BoardRow | null>(null);

  const rows = useMemo(() => {
    const arr = (list ?? []).filter((b) => !keyword || (b.name ?? '').includes(keyword));
    return [...arr].sort((a, b) => {
      const av = (a[sort] ?? -Infinity) as number;
      const bv = (b[sort] ?? -Infinity) as number;
      return desc ? bv - av : av - bv;
    });
  }, [list, keyword, sort, desc]);

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>板块行情</h2>
        <span className="muted">
          {list?.length ?? 0} 个板块
          {elapsedMs ? ` · ${elapsedMs} ms` : ''}
        </span>
        <span className="spacer" />
        <input
          className="input"
          placeholder="搜索板块"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </header>

      <div className="toolbar">
        <div className="seg">
          {BOARD_TYPES.map((t) => (
            <button
              key={t.key}
              className={`seg-btn ${type === t.key ? 'on' : ''}`}
              onClick={() => onType(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="seg">
          {([
            { k: 'changePct', label: '涨跌幅' },
            { k: 'amount', label: '成交额' },
            { k: 'leadChangePct', label: '领涨股' },
          ] as { k: SortKey; label: string }[]).map((s) => (
            <button
              key={s.k}
              className={`seg-btn ${sort === s.k ? 'on' : ''}`}
              onClick={() => (sort === s.k ? setDesc(!desc) : (setSort(s.k), setDesc(true)))}
            >
              {s.label} {sort === s.k ? (desc ? '↓' : '↑') : ''}
            </button>
          ))}
        </div>

        <span className="spacer" />
        {/* 卡片 / 列表视图切换（需求第六章） */}
        <div className="seg">
          {([
            { k: 'list', label: '列表' },
            { k: 'card', label: '卡片' },
          ] as { k: ViewMode; label: string }[]).map((v) => (
            <button
              key={v.k}
              className={`seg-btn ${view === v.k ? 'on' : ''}`}
              onClick={() => setView(v.k)}
            >
              {v.label}
            </button>
          ))}
        </div>
        {source && <span className="src-tag ok">{source}</span>}
      </div>

      {error && <div className="alert error">板块列表获取失败：{error}</div>}
      {loading && !list && <div className="empty">加载中…</div>}
      {!loading && rows.length === 0 && <div className="empty">未找到匹配板块</div>}

      {rows.length > 0 && view === 'card' && (
        <div className="board-cards">
          {rows.map((b) => (
            <button key={b.label} className="board-card" onClick={() => setDetail(b)}>
              <div className="bc-top">
                <span className="bc-name">{b.name}</span>
                <span className="bc-pct" style={{ color: changeColor(b.changePct) }}>
                  {b.changePct != null ? formatPct(b.changePct) + '%' : DASH}
                </span>
              </div>
              <div className="bc-row">
                <span className="muted">成交额</span>
                <span className="mono">{yuan(b.amount)}</span>
              </div>
              <div className="bc-row">
                <span className="muted">领涨股</span>
                <span>
                  {b.leadName ?? DASH}
                  {b.leadChangePct != null && (
                    <em style={{ color: changeColor(b.leadChangePct), fontStyle: 'normal' }}>
                      {' '}{formatPct(b.leadChangePct)}%
                    </em>
                  )}
                </span>
              </div>
              <div className="bc-row">
                <span className="muted">公司家数</span>
                <span className="mono">{b.count ?? DASH}</span>
              </div>
              <div className="bc-foot muted">点击看成分股 · 净流入未接入</div>
            </button>
          ))}
        </div>
      )}

      {rows.length > 0 && view === 'list' && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>板块</th>
                <th className="num">涨跌幅</th>
                <th className="num">总成交额</th>
                <th className="num">均价</th>
                <th className="num">公司家数</th>
                <th>领涨股</th>
                <th className="num">领涨涨幅</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.label}>
                  <td>{b.name}</td>
                  <td className="num mono" style={{ color: changeColor(b.changePct) }}>
                    {b.changePct != null ? formatPct(b.changePct) + '%' : DASH}
                  </td>
                  <td className="num mono">{yuan(b.amount)}</td>
                  <td className="num mono">{fmtNum(b.avgPrice)}</td>
                  <td className="num mono">{b.count ?? DASH}</td>
                  <td>{b.leadName ?? DASH}</td>
                  <td className="num mono" style={{ color: changeColor(b.leadChangePct) }}>
                    {b.leadChangePct != null ? formatPct(b.leadChangePct) + '%' : DASH}
                  </td>
                  <td>
                    <button className="link" onClick={() => setDetail(b)}>
                      成分股
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="notes">
        <div>
          数据源：AkShare → 新浪板块。新浪的 label 可直接下钻成分股，三类板块口径一致、响应约 150-260ms
        </div>
        <div>
          弃用同花顺概念板块行情：实测返回两个月前的日期（2026-07-31），不能用于实时排序
        </div>
        <div>板块净流入与板块内涨跌家数：新浪源不提供，暂不展示（不使用模拟值）</div>
      </div>

      {detail && (
        <BoardDetail board={detail} onClose={() => setDetail(null)} onOpenKline={onOpenKline} />
      )}
    </section>
  );
}
