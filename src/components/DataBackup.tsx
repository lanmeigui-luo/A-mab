import { useRef, useState } from 'react';
import { useWatchList } from '@/hooks/useWatchList';
import { useStrategyParams } from '@/hooks/useStrategyParams';
import { useColorBlind } from '@/hooks/useColorBlind';

/**
 * 本地数据备份（需求：本地优先 + 提供导出/导入 JSON 备份）
 * 覆盖：自选股、战法参数覆盖、色盲模式开关。
 * 模型 Key 不导出（加密存本地，导出等于明文泄露，故明确排除并说明）。
 */
export function DataBackup({ onClose }: { onClose: () => void }) {
  const wl = useWatchList();
  const sp = useStrategyParams();
  const cb = useColorBlind();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const snapshot = () => ({
    app: 'A股博弈雷达',
    version: 1,
    exportedAt: new Date().toISOString(),
    watchlist: JSON.parse(wl.exportJson()),
    strategyParams: JSON.parse(sp.exportJson()),
    colorBlind: cb.on,
    excluded: ['模型 API Key（加密存本地，不随备份导出）'],
  });

  const doExport = () => {
    const blob = new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `astock-radar-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMsg('已导出到本地下载目录');
  };

  const doImport = async (file: File) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data?.watchlist?.items) wl.importJson(JSON.stringify(data.watchlist));
      if (data?.strategyParams?.params) sp.importJson(JSON.stringify(data.strategyParams));
      if (typeof data?.colorBlind === 'boolean' && data.colorBlind !== cb.on) cb.toggle();
      setMsg('导入完成：自选股 ' + (data?.watchlist?.items?.length ?? 0) + ' 条');
    } catch (e) {
      setMsg('导入失败：' + String((e as Error).message || e));
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>本地数据备份</h3>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>关闭</button>
        </header>

        <div className="backup-body">
          <div className="backup-row">
            <button className="btn primary" onClick={doExport}>导出 JSON</button>
            <button className="btn" onClick={() => fileRef.current?.click()}>导入 JSON</button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) doImport(f);
                e.target.value = '';
              }}
            />
          </div>

          <ul className="backup-list">
            <li>自选股：{wl.items.length} 条</li>
            <li>战法参数覆盖：{Object.keys(sp.params).length} 个战法</li>
            <li>色盲友好模式：{cb.on ? '开' : '关'}</li>
            <li className="muted">模型 API Key 不导出（本机加密存储，导出即等于明文泄露）</li>
          </ul>

          {!wl.storageOk && <div className="alert warn">本机 localStorage 不可用，备份功能受限</div>}
          {msg && <div className="alert info">{msg}</div>}
        </div>
      </div>
    </div>
  );
}
