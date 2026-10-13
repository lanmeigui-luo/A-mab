import type { HealthInfo } from '@/domain/types';

interface Props {
  health: HealthInfo | null;
  error: string | null;
  /** 手动重连：重新探测全部通道 */
  onReconnect?: () => void;
  reconnecting?: boolean;
  /** 重连结果提示（需求 1.5：断开后重试 3 次、间隔 2 秒） */
  retryNote?: string | null;
}

/**
 * 数据源状态栏 —— 必须与行情红涨绿跌区分：
 * 通道健康状态用蓝/琥珀/灰，不用红绿。
 */
export function SourceStatusBar({ health, error, onReconnect, reconnecting, retryNote }: Props) {
  const tdx = health?.tdxMcp;
  const tencent = health?.channels?.tencent;
  const sina = health?.channels?.sina;

  return (
    <header className="status-bar">
      <span className={`dot ${health?.ok ? 'ok' : 'bad'}`} />
      <strong>A股博弈雷达</strong>

      {/* 主数据源：通达信直连（pytdx，不依赖 WorkBuddy 会话） */}
      <span
        className={`chip ${tdx?.available ? 'ok' : 'warn'}`}
        title={tdx?.reason ?? (tdx?.plan || '')}
      >
        通达信：{tdx?.available ? '已连接（直连）' : '未连接'}
        {tdx?.elapsedMs != null ? ` · ${tdx.elapsedMs}ms` : ''}
        {tdx?.calls && tdx.calls.fail > 0 ? ` · 失败 ${tdx.calls.fail}` : ''}
      </span>

      {tencent && (
        <span className={`chip ${tencent.lastError ? 'warn' : 'info'}`}>
          腾讯（补充）{tencent.lastError ? '异常' : `${tencent.lastMs ?? '—'} ms`}
          {tencent.fail > 0 ? ` · 失败 ${tencent.fail}` : ''}
        </span>
      )}
      {sina && (
        <span className={`chip ${sina.lastError ? 'warn' : 'info'}`}>
          新浪（备用）{sina.lastError ? '异常' : '就绪'}
          {sina.fail > 0 ? ` · 失败 ${sina.fail}` : ''}
        </span>
      )}

      <span className="spacer" />
      {retryNote && <span className="chip warn">{retryNote}</span>}
      {error && <span className="chip warn">{error}</span>}
      {onReconnect && (
        <button className="btn-mini" onClick={onReconnect} disabled={reconnecting}>
          {reconnecting ? '重连中…' : '重新连接'}
        </button>
      )}
      <span className="muted">本地优先 · 数据仅存本机</span>
    </header>
  );
}
