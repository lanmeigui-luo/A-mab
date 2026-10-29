import { useEffect, useState } from 'react';
import { SourceStatusBar } from '@/components/SourceStatusBar';
import { MarketOverview } from '@/components/MarketOverview';
import { WatchList } from '@/components/WatchList';
import { StockDetail } from '@/components/StockDetail';
import { StrategyScreen } from '@/components/StrategyScreen';
import { BoardPage } from '@/components/BoardPage';
import { CapabilityMatrix } from '@/components/CapabilityMatrix';
import { DataBackup } from '@/components/DataBackup';
import { ModelSettings } from '@/components/ModelSettings';
import { WinRateScreen } from '@/components/WinRateScreen';
import { usePolling } from '@/hooks/usePolling';
import { useWatchList } from '@/hooks/useWatchList';
import { useStrategyParams } from '@/hooks/useStrategyParams';
import { useColorBlind } from '@/hooks/useColorBlind';
import { useWinRateRecorder } from '@/hooks/useWinRateRecorder';
import { marketApi } from '@/services/market';
import { INDEX_DEFS } from '@/domain/types';
import type { BoardType } from '@/domain/board';
import type { ScreenResponse, StrategyDef } from '@/domain/strategy';

const INDEX_CODES = INDEX_DEFS.map((d) => d.code);

type TabKey = 'watch' | 'strategy' | 'board' | 'capability' | 'winrate';

export default function App() {
  const [tab, setTab] = useState<TabKey>('watch');

  const health = usePolling(() => marketApi.health(), 30000);
  // 手动重连：按需求 1.5 重试 3 次、间隔 2 秒，失败后保留上次数据并标注
  const [reconnecting, setReconnecting] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const reconnect = async () => {
    setReconnecting(true);
    setRetryNote(null);
    let lastErr = '';
    for (let i = 1; i <= 3; i++) {
      try {
        const h = await marketApi.health();
        if (h?.ok) {
          setRetryNote(`第 ${i} 次重连成功`);
          setReconnecting(false);
          return;
        }
        lastErr = '通道仍不可用';
      } catch (e) {
        lastErr = String((e as Error).message || e);
      }
      if (i < 3) await new Promise((r) => setTimeout(r, 2000));
    }
    setRetryNote(`重试 3 次仍失败（${lastErr}）· 已保留上次数据，数据可能已过期`);
    setReconnecting(false);
  };

  const quotes = usePolling(() => marketApi.quotes(INDEX_CODES), 5000);
  const stats = usePolling(() => marketApi.marketStats(), 10000);
  const sentiment = usePolling(() => marketApi.sentiment(), 30000);
  const turnover = usePolling(() => marketApi.turnover(), 10000);

  const wl = useWatchList();
  const sp = useStrategyParams();
  const cb = useColorBlind();

  // P2b 修复：应用打开即跑一次每日周期（记录/结算）。
  // 此前该调用点从未落地，导致 winrate Tab 始终 recordsLength=0（仅窗口命中时才可能因别处触发，实际没有任何调用点）。
  const recorder = useWinRateRecorder();
  useEffect(() => {
    recorder.runDailyCycle().catch(() => undefined);
  }, [recorder.runDailyCycle]);
  const [detail, setDetail] = useState<{ fullCode: string; name: string } | null>(null);

  const watchQuotes = usePolling(
    () => (wl.fullCodes.length ? marketApi.quotes(wl.fullCodes) : Promise.resolve(null)),
    3000,
    [wl.fullCodes.join(',')],
  );

  // 战法：定义只拉一次；选股结果手动触发
  const [strategies, setStrategies] = useState<StrategyDef[]>([]);
  const [selected, setSelected] = useState<string[]>(['ultra-short', 'trend-break']);
  const [poolSize, setPoolSize] = useState(100);
  const [screen, setScreen] = useState<ScreenResponse | null>(null);
  const [screenErr, setScreenErr] = useState<string | null>(null);
  const [screening, setScreening] = useState(false);

  useEffect(() => {
    marketApi
      .strategies()
      .then((r) => setStrategies(r.rows))
      .catch(() => setStrategies([]));
  }, []);

  const runScreen = async (useWatchAsPool = false) => {
    setScreening(true);
    setScreenErr(null);
    try {
      const r = await marketApi.screen({
        sortBy: 'changePct',
        poolSize,
        ids: selected,
        codes: useWatchAsPool ? wl.fullCodes : undefined,
        params: sp.params,
      });
      setScreen(r);
    } catch (e) {
      setScreenErr(String((e as Error).message || e));
    } finally {
      setScreening(false);
    }
  };

  // 板块行情：切换类型时重新拉取
  const [boardType, setBoardType] = useState<BoardType>('industry');
  const boards = usePolling(() => marketApi.boardList(boardType), 30000, [boardType]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);

  const toggleStrategy = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const detailQuote = detail
    ? watchQuotes.data?.rows.find((r) => r.fullCode === detail.fullCode)
    : undefined;

  return (
    <div className="app">
      <SourceStatusBar
        health={health.data}
        error={health.error}
        onReconnect={reconnect}
        reconnecting={reconnecting}
        retryNote={retryNote}
      />

      <main className="main">
        {/* 大盘总览：全局固定，所有 Tab 可见 */}
        <MarketOverview
          resp={quotes.data}
          error={quotes.error}
          stats={stats.data}
          sentiment={sentiment.data}
          turnover={turnover.data}
          onOpenIndex={(fullCode, name) => setDetail({ fullCode, name })}
        />

        <nav className="tabs">
          <button className={`tab ${tab === 'watch' ? 'on' : ''}`} onClick={() => setTab('watch')}>
            自选股
          </button>
          <button className={`tab ${tab === 'strategy' ? 'on' : ''}`} onClick={() => setTab('strategy')}>
            战法选股
          </button>
          <button className={`tab ${tab === 'board' ? 'on' : ''}`} onClick={() => setTab('board')}>
            板块行情
          </button>
          <button className={`tab ${tab === 'capability' ? 'on' : ''}`} onClick={() => setTab('capability')}>
            数据源矩阵
          </button>
          <button className={`tab ${tab === 'winrate' ? 'on' : ''}`} onClick={() => setTab('winrate')}>
            战法胜率
          </button>
          <span className="spacer" />
          <label className="check" title="用暖色（涨）/ 冷色（跌）替代红绿，便于红绿色盲辨识">
            <input type="checkbox" checked={cb.on} onChange={cb.toggle} />
            色盲友好
          </label>
          <button className="tab" onClick={() => setBackupOpen(true)}>
            备份
          </button>
          <button className="tab" onClick={() => setSettingsOpen(true)}>
            设置 · 模型配置
          </button>
        </nav>

        {tab === 'watch' ? (
          <WatchList
            items={wl.items}
            resp={watchQuotes.data}
            error={watchQuotes.error}
            onAdd={wl.add}
            onRemove={wl.remove}
            onOpenKline={(fullCode, name) => setDetail({ fullCode, name })}
            storageOk={wl.storageOk}
          />
        ) : tab === 'strategy' ? (
          <StrategyScreen
            strategies={strategies}
            resp={screen}
            error={screenErr}
            loading={screening}
            selected={selected}
            onToggle={toggleStrategy}
            poolSize={poolSize}
            onPoolSize={setPoolSize}
            onRun={() => runScreen(false)}
            watchCodes={wl.fullCodes}
            onRunWithWatch={() => runScreen(true)}
            params={sp.params}
            onParamChange={sp.setParam}
            onResetParams={sp.resetStrategy}
            onAnalyze={(fullCode, name) => setDetail({ fullCode, name })}
          />
        ) : tab === 'board' ? (
          <BoardPage
            list={boards.data?.ok ? boards.data.rows : null}
            loading={boards.loading}
            error={boards.error ?? (boards.data?.ok === false ? boards.data.reason ?? null : null)}
            type={boardType}
            onType={setBoardType}
            elapsedMs={boards.data?.elapsedMs}
            source="AkShare（新浪板块）"
            onOpenKline={(fullCode, name) => setDetail({ fullCode, name })}
          />
        ) : tab === 'winrate' ? (
          <WinRateScreen />
        ) : (
          <CapabilityMatrix />
        )}
      </main>

      {backupOpen && <DataBackup onClose={() => setBackupOpen(false)} />}

      {settingsOpen && (
        <ModelSettings onClose={() => setSettingsOpen(false)} onChange={() => undefined} />
      )}

      {detail && (
        <StockDetail
          fullCode={detail.fullCode}
          name={detail.name}
          quote={detailQuote}
          resp={watchQuotes.data}
          onClose={() => setDetail(null)}
        />
      )}

      <footer className="footer">
        <span>数据来源：{watchQuotes.data?.sourceLabel ?? quotes.data?.sourceLabel ?? '未连接'}</span>
        <span>本应用仅供学习研究，不构成投资建议，股市有风险，入市需谨慎。</span>
      </footer>
    </div>
  );
}
