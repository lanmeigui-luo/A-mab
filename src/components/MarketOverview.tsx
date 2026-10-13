import {
  INDEX_DEFS,
  type MarketStats,
  type Quote,
  type QuoteResponse,
  type SentimentStats,
  type TurnoverStats,
} from '@/domain/types';
import { changeColor, formatChange, formatPct } from '@/lib/market-colors';
import { DASH, fmtIndex, fmtUpdatedAt } from '@/lib/format';

interface Props {
  resp: QuoteResponse | null;
  error: string | null;
  stats: MarketStats | null;
  sentiment: SentimentStats | null;
  turnover: TurnoverStats | null;
  /** 点击指数进入该指数的分时 / K 线页 */
  onOpenIndex?: (fullCode: string, name: string) => void;
}

/** 单个指数卡 */
function IndexCard({
  def,
  quote,
  onOpen,
}: {
  def: (typeof INDEX_DEFS)[number];
  quote?: Quote;
  onOpen?: (fullCode: string, name: string) => void;
}) {
  const pct = quote?.changePct ?? null;
  const color = changeColor(pct);
  const stale = !quote;

  return (
    <button
      className="idx-card"
      onClick={() => onOpen?.(def.code, def.name)}
      title={onOpen ? `查看 ${def.name} 的 K 线 / 分时` : undefined}
    >
      <div className="idx-name">{def.name}</div>
      <div className="idx-value" style={{ color }}>{fmtIndex(quote?.price ?? null)}</div>
      <div className="idx-delta" style={{ color }}>
        <span>{formatChange(quote?.change ?? null)}</span>
        <span>{formatPct(pct)}%</span>
      </div>
      {stale && <div className="idx-stale">无数据</div>}
    </button>
  );
}

/** 成交额自动切换单位：元 → 亿元 / 万亿元 */
function fmtAmount(yuan: number | null): string {
  if (yuan == null) return DASH;
  const yi = yuan / 1e8;
  if (yi >= 10000) return (yi / 10000).toFixed(2) + ' 万亿';
  if (yi >= 1) return yi.toFixed(0) + ' 亿';
  return (yuan / 1e4).toFixed(0) + ' 万';
}

export function MarketOverview({ resp, error, stats, sentiment, turnover, onOpenIndex }: Props) {
  const byCode = new Map<string, Quote>();
  for (const q of resp?.rows ?? []) byCode.set(q.fullCode, q);

  const firstUpdated = resp?.rows?.[0]?.updatedAt ?? '';

  return (
    <section className="panel overview">
      <header className="panel-head">
        <h2>大盘总览</h2>
        <span className="muted">
          数据时点 {firstUpdated ? fmtUpdatedAt(firstUpdated) : DASH}
          {resp?.cached ? ' · 缓存' : ''}
        </span>
        <span className="spacer" />
        <span className={`src-tag ${resp?.degraded ? 'warn' : 'ok'}`}>
          {resp?.sourceLabel ?? '未连接'}
        </span>
        {resp?.elapsedMs != null && <span className="muted">{resp.elapsedMs} ms</span>}
      </header>

      {error && <div className="alert error">行情获取失败：{error}（已保留上一次数据）</div>}

      <div className="idx-grid">
        {INDEX_DEFS.map((def) => (
          <IndexCard key={def.code} def={def} quote={byCode.get(def.code)} onOpen={onOpenIndex} />
        ))}
      </div>

      {/* 成交额：分市场（沪/深/北）+ 合计 */}
      <div className="metric-row">
        <div className="metric">
          <div className="metric-label">
            成交额
            {turnover?.sourceLabel && <span className="src-mini">{turnover.sourceLabel}</span>}
          </div>
          {turnover?.available ? (
            <>
              <div className="metric-value">{fmtAmount(turnover.totalYuan)}</div>
              <div className="metric-note">
                沪 {fmtAmount(turnover.shYuan)} · 深 {fmtAmount(turnover.szYuan)} · 北{' '}
                {fmtAmount(turnover.bjYuan)}
              </div>
              <div className="metric-note muted">
                {turnover.vsPrevYuan != null
                  ? `较上一交易日同期 ${turnover.vsPrevYuan > 0 ? '+' : ''}${fmtAmount(Math.abs(turnover.vsPrevYuan))}`
                  : (turnover.vsPrevReason ?? '同期增减待接入')}
              </div>
            </>
          ) : (
            <>
              <div className="metric-value muted">待接入</div>
              <div className="metric-note">{turnover?.reason ?? '正在获取分市场成交额…'}</div>
            </>
          )}
        </div>

        {/* 情绪指标：晋级率 / 昨日涨停今日表现（需求第五章） */}
        <div className="metric">
          <div className="metric-label">
            情绪指标
            {sentiment?.sourceLabel && <span className="src-mini">{sentiment.sourceLabel}</span>}
          </div>
          <div className="metric-value">
            晋级率{' '}
            {sentiment?.promoteRate != null ? (
              <span style={{ color: sentiment.promoteRate >= 0.23 ? '#DC2626' : sentiment.promoteRate < 0.15 ? '#16A34A' : '#6B7280' }}>
                {(sentiment.promoteRate * 100).toFixed(1)}%
              </span>
            ) : (
              <span className="muted">{sentiment?.promotePoolSize != null ? `池 ${sentiment.promotePoolSize} 家 <10` : DASH}</span>
            )}
          </div>
          <div className="metric-note">
            昨日涨停今日{' '}
            {sentiment?.prevLimitUpPerf != null ? (
              <span style={{ color: changeColor(sentiment.prevLimitUpPerf) }}>
                {formatPct(sentiment.prevLimitUpPerf)}%
              </span>
            ) : (
              DASH
            )}
            {sentiment?.prevLimitUpDate ? ` · 基准 ${sentiment.prevLimitUpDate}` : ''}
          </div>
          <div className="metric-note muted">
            晋级率 ≥23% 主升（评分 ×1.15）· &lt;15% 退潮（×0.85）
          </div>
        </div>
      </div>

      {resp?.notes?.length ? (
        <ul className="notes">
          {resp.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}

      <div className="metric-row">
        <div className="metric">
          <div className="metric-label">
            涨跌家数
            {stats?.sourceLabel && <span className="src-mini">{stats.sourceLabel}</span>}
          </div>
          {stats?.available ? (
            <>
              <div className="metric-value up-down">
                <span className="up">涨 {stats.up ?? DASH}</span>
                <span className="down">跌 {stats.down ?? DASH}</span>
                <span className="flat">平 {stats.flat ?? DASH}</span>
              </div>
              <div className="ud-bar">
                {stats.up != null && stats.down != null && stats.flat != null && (
                  <>
                    <span className="seg-up" style={{ flex: Math.max(stats.up, 1) }} />
                    <span className="seg-down" style={{ flex: Math.max(stats.down, 1) }} />
                    <span className="seg-flat" style={{ flex: Math.max(stats.flat, 1) }} />
                  </>
                )}
              </div>
              <div className="metric-note">
                涨停 {stats.limitUp ?? DASH} · 跌停 {stats.limitDown ?? DASH} · 停牌 {stats.suspension ?? DASH}
                {stats.up != null && stats.down != null && stats.down > 0 && (
                  <> · 涨跌比 {(stats.up / stats.down).toFixed(2)}</>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="metric-value muted">待接入</div>
              <div className="metric-note">{stats?.reason ?? '正在获取全市场涨跌家数…'}</div>
            </>
          )}
        </div>

        <div className="metric">
          <div className="metric-label">
            市场情绪
            {sentiment?.sourceLabel && <span className="src-mini">{sentiment.sourceLabel}</span>}
          </div>
          {sentiment?.available ? (
            <>
              <div className="metric-value">{sentiment.limitUpCount ?? DASH} 家涨停</div>
              <div className="metric-note">
                最高 {sentiment.maxBoard ?? DASH} 板 · 炸板 {sentiment.brokenCount ?? DASH} 次 · 炸板率{' '}
                {sentiment.brokenRate != null ? sentiment.brokenRate + '%' : DASH}
              </div>
            </>
          ) : (
            <>
              <div className="metric-value muted">待接入</div>
              <div className="metric-note">{sentiment?.reason ?? '正在获取涨停池…'}</div>
            </>
          )}
        </div>

        <div className="metric">
          <div className="metric-label">成交额</div>
          <div className="metric-value muted">待接入</div>
          <div className="metric-note">沪深分市场成交额待接入（指数成交额已在卡片中体现）</div>
        </div>
      </div>
    </section>
  );
}
