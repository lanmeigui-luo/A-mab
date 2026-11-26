import { buildNavContext, type NavContext } from '@/domain/nav-context';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Quote, QuoteResponse } from '@/domain/types';
import { changeColor, formatChange, formatPct } from '@/lib/market-colors';
import { DASH, fmtAmount, fmtNum } from '@/lib/format';
import type { WatchItem } from '@/hooks/useWatchList';
import { normalizeKey, searchStocks, highlightSegments, type StockHit } from '@/lib/stock-search';
import { STOCK_ROWS, stockOf } from '@/lib/stock-index';

interface Props {
  items: WatchItem[];
  resp: QuoteResponse | null;
  error: string | null;
  onAdd: (code: string, name?: string) => { ok: boolean; reason?: string };
  onRemove: (code: string) => void;
  onOpenKline: (fullCode: string, name: string, nav?: NavContext | null) => void;
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
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [composing, setComposing] = useState(false);
  const comboRef = useRef<HTMLDivElement | null>(null);
  const [dropUp, setDropUp] = useState(false);
  const [listMaxH, setListMaxH] = useState(344);

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
        const k = normalizeKey(keyword);
        if (!k) return true;
        const name = quote?.name ?? item.name ?? '';
        if (item.code.includes(k) || normalizeKey(name).includes(k)) return true;
        // 顶部过滤也走同一份字典：可用拼音首字母/全拼筛已有自选
        const row = stockOf(item.code);
        return !!row && (row.ini.includes(k) || row.py.includes(k));
      });
    // 默认按涨跌幅降序；无行情的排在末尾
    return list.sort((a, b) => (b.quote?.changePct ?? -Infinity) - (a.quote?.changePct ?? -Infinity));
  }, [items, byCode, keyword]);

  /** 联想候选：本地字典匹配，最多 10 条；中文输入法合成期间不查，避免拼音过程抖动 */
  const hits = useMemo<StockHit[]>(() => {
    const q = input.trim();
    if (!q || composing) return [];
    return searchStocks(STOCK_ROWS, q, 10);
  }, [input, composing]);

  const showList = listOpen && hits.length > 0;

  // 自选股面板常在页面底部：下方空间不足时向上翻，并按可用高度收缩，避免被视口裁切
  useLayoutEffect(() => {
    if (!showList) {
      setDropUp(false);
      return;
    }
    const el = comboRef.current?.querySelector('input');
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 16;
    const above = r.top - 16;
    const need = Math.min(hits.length * 32 + 10, 344);
    const up = below < need && above > below;
    setDropUp(up);
    setListMaxH(Math.max(140, Math.min(344, up ? above : below)));
  }, [showList, hits.length]);

  // 点击组件外关闭下拉
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) setListOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const pick = (hit: StockHit) => {
    const r = onAdd(hit.code, hit.name);
    if (r.ok) {
      setInput('');
      setNotice(null);
      setListOpen(false);
      setActive(0);
    } else {
      setNotice(r.reason ?? '添加失败');
    }
  };

  const handleAdd = () => {
    const raw = input.trim();
    if (!raw) return;
    if (showList && hits[active]) {
      pick(hits[active]);
      return;
    }
    if (!/^\d{6}$/.test(raw)) {
      setNotice('未找到匹配的股票');
      return;
    }
    const r = onAdd(raw);
    if (r.ok) {
      setInput('');
      setNotice(null);
      setListOpen(false);
      setActive(0);
    } else {
      setNotice(r.reason ?? '添加失败');
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' && showList) {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, hits.length - 1));
      return;
    }
    if (e.key === 'ArrowUp' && showList) {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Escape') {
      setListOpen(false);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  /** 命中片段用 <mark> 标红；未命中的字段原样文本 */
  const highlight = (text: string, q: string) =>
    highlightSegments(text, q).map((seg, i) =>
      seg.hit ? <mark key={i} className="combo-hit">{seg.text}</mark> : <span key={i}>{seg.text}</span>);

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
        <div className="combo" ref={comboRef}>
          <input
            className="input combo-input"
            placeholder="代码 / 名称 / 拼音，如 600519、崇达、cdjs"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setListOpen(true);
              setActive(0);
            }}
            onFocus={() => setListOpen(true)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => {
              setComposing(false);
              setListOpen(true);
            }}
            onKeyDown={onKeyDown}
            autoComplete="off"
            spellCheck={false}
            aria-autocomplete="list"
            aria-expanded={showList}
          />
          {showList && (
            <ul className={'combo-list' + (dropUp ? ' up' : '')} role="listbox" style={{ maxHeight: listMaxH }}>
              {hits.map((h, i) => (
                <li
                  key={h.code}
                  role="option"
                  aria-selected={i === active}
                  className={'combo-item' + (i === active ? ' active' : '')}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    // preventDefault：避免 input 先 blur 导致候选消失、点击落空
                    e.preventDefault();
                    pick(h);
                  }}
                >
                  <span className="combo-name">{highlight(h.name, h.kind === 'name' ? input : '')}</span>
                  <span className="combo-code">({highlight(h.code, h.kind === 'code' ? input : '')})</span>
                  <span className="combo-ini">{highlight(h.ini, h.kind === 'ini' ? input : '')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button className="btn primary" onClick={handleAdd}>
          添加自选
        </button>
        {notice && <span className="chip warn">{notice}</span>}
      </div>

      {items.length === 0 ? (
        <div className="empty">暂无自选股，输入代码、名称或拼音首字母后点击「添加自选」</div>
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
                        onClick={() => onOpenKline(item.fullCode, quote?.name ?? item.name ?? item.code,
                          buildNavContext('watchlist', rows.map((r) => ({
                            id: r.item.fullCode, fullCode: r.item.fullCode, name: r.quote?.name ?? r.item.name ?? r.item.code,
                          })), { id: item.fullCode, fullCode: item.fullCode, name: quote?.name ?? item.name ?? item.code }, 'self'))}
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
