import { useMemo, useState } from 'react';
import type { Quote, QuoteResponse } from '@/domain/types';
import { changeColor, formatChange, formatPct } from '@/lib/market-colors';
import { DASH, fmtAmount, fmtNum } from '@/lib/format';
import type { WatchItem } from '@/hooks/useWatchList';

interface Props {
  items: WatchItem[];
  resp: QuoteResponse | null;
  error: string | null;
  onAdd: (code: string) => { ok: boolean; reason?: string };
  onRemove: (code: string) => void;
  onOpenKline: (fullCode: string, name: string) => void;
  storageOk: boolean;
}

/** 交易状态判定：只使用上游直供字段，不做推算 */
function tradeState(q: Quote): { label: string; cls: string } {
  if (q.volume === 0) return { label: '停牌', cls: 'state-halt' };
  if (q.limitUpPrice != null && q.price != null && Math.abs(q.price - q.limitUpPrice) < 1e-6) {
    return { label: '涨停', cls: 'state-up' };
  }
  if (q.price == null) return { label: '无数据', cls: 'state-none' };
  return { label: '正常', cls: 'state-ok' };
}

export function WatchList({ items, resp, error, onAdd, onRemove, onOpenKline, storageOk }: Props) {
  const [input, setInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const byCode = useMemo(() => {
    const m = new Map<string, Quote>();
    for (const q of resp?.rows ?? []) m.set(q.fullCode, q);
    return m;
  }, [resp]);

  const rows = useMemo(() => {
    const list = items
      .map((it) => ({ item: it, quote: byCode.get(it.fullCode) }))
      .filter(({ item, quote }) => {
        if (!keyword) return true;
        const k = keyword.toLowerCase();
        return item.code.includes(k) || (quote?.name ?? item.name ?? '').toLowerCase().includes(k);
      });
    // 默认按涨跌幅降序；无行情的排在末尾
    return list.sort((a, b) => (b.quote?.changePct ?? -Infinity) - (a.quote?.changePct ?? -Infinity));
  }, [items, byCode, keyword]);

  const handleAdd = () => {
    const code = input.trim();
    const r = onAdd(code);
    if (r.ok) {
      setInput('');
      setNotice(null);
    } else {
      setNotice(r.reason ?? '添加失败');
    }
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>自选股</h2>
        <span className="muted">
          {items.length} 只 · 3 秒刷新{resp?.cached ? ' · 缓存' : ''}
        </span>
        <span className="spacer" />
        <input
          className="input"
          placeholder="搜索代码或名称"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </header>

      {error && <div className="alert error">自选股行情获取失败：{error}（已保留上一次数据）</div>}
      {!storageOk && <div className="alert error">本地存储不可用，自选股本次会话后不会保留</div>}

      <div className="add-row">
        <input
          className="input"
          placeholder="输入 6 位代码添加，如 600519"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          maxLength={6}
        />
        <button className="btn primary" onClick={handleAdd}>
          添加自选
        </button>
        {notice && <span className="chip warn">{notice}</span>}
      </div>

      {items.length === 0 ? (
        <div className="empty">暂无自选股，输入代码点击「添加自选」</div>
      ) : rows.length === 0 ? (
        <div className="empty">未找到匹配结果</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>代码</th>
                <th>名称</th>
                <th className="num">现价</th>
                <th className="num">涨跌幅</th>
                <th className="num">涨跌额</th>
                <th className="num">换手率</th>
                <th className="num">量比</th>
                <th className="num">成交额</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ item, quote }) => {
                const st = quote ? tradeState(quote) : { label: '加载中', cls: 'state-none' };
                const color = changeColor(quote?.changePct ?? null);
                return (
                  <tr key={item.code}>
                    <td className="mono muted">{item.code}</td>
                    <td>{quote?.name ?? item.name ?? DASH}</td>
                    <td className="num mono" style={{ color }}>
                      {fmtNum(quote?.price ?? null)}
                    </td>
                    <td className="num mono" style={{ color }}>
                      {quote ? formatPct(quote.changePct) + '%' : DASH}
                    </td>
                    <td className="num mono" style={{ color }}>
                      {formatChange(quote?.change ?? null)}
                    </td>
                    <td className="num mono">{quote?.turnoverRate != null ? quote.turnoverRate + '%' : DASH}</td>
                    <td className="num mono muted" title="当前通道不提供量比">
                      {DASH}
                    </td>
                    <td className="num mono">{fmtAmount(quote?.amountWan ?? null)}</td>
                    <td>
                      <span className={'state ' + st.cls}>{st.label}</span>
                    </td>
                    <td>
                      <button
                        className="link"
                        onClick={() => onOpenKline(item.fullCode, quote?.name ?? item.name ?? item.code)}
                      >
                        K线
                      </button>
                      <span className="sep">·</span>
                      <button className="link danger" onClick={() => onRemove(item.code)}>
                        删除
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
        <div>量比：当前行情通道不提供，显示「—」而非推测值</div>
        <div>成交量单位「手」，成交额已按万元/亿元自动换算</div>
      </div>
    </section>
  );
}
