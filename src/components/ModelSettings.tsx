import { useEffect, useState } from 'react';
import { PROVIDER_PRESETS, clearConfig, readConfig, saveConfig } from '@/lib/crypto';

interface Props {
  onClose: () => void;
  onChange: () => void;
}

export function ModelSettings({ onClose, onChange }: Props) {
  const [provider, setProvider] = useState('deepseek');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    readConfig().then((c) => {
      if (!c) {
        const p = PROVIDER_PRESETS[0];
        setBaseUrl(p.baseUrl);
        setModel(p.model);
        return;
      }
      setProvider(c.public.provider);
      setBaseUrl(c.public.baseUrl);
      setModel(c.public.model);
      setApiKey(c.apiKey);
      setHasKey(c.public.hasKey);
    });
  }, []);

  const pickPreset = (id: string) => {
    setProvider(id);
    const p = PROVIDER_PRESETS.find((x) => x.id === id);
    if (p && p.id !== 'custom') {
      setBaseUrl(p.baseUrl);
      setModel(p.model);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await saveConfig({ provider, baseUrl, model, apiKey });
      setHasKey(!!apiKey);
      setMsg('已保存到本机（Key 经 AES-GCM 加密后存入 localStorage）');
      onChange();
    } catch (e) {
      setMsg('保存失败：' + String((e as Error).message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="drawer-mask" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>模型配置</h2>
          <span className="muted">本地优先 · 无云端账号</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </header>

        <section className="panel">
          <header className="panel-head">
            <h2>服务商</h2>
          </header>
          <div className="strategy-grid">
            {PROVIDER_PRESETS.map((p) => (
              <button
                key={p.id}
                className={`strategy-card ${provider === p.id ? 'on' : ''}`}
                onClick={() => pickPreset(p.id)}
              >
                <div className="sc-top">
                  <span className="sc-name">{p.name}</span>
                  <span className="sc-badge">{provider === p.id ? '已选' : '未选'}</span>
                </div>
                <div className="sc-desc">{p.baseUrl || '自填 Base URL / 模型名'}</div>
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <header className="panel-head">
            <h2>连接参数</h2>
            {hasKey && <span className="src-tag ok">已配置 Key</span>}
          </header>

          <div className="form-row">
            <label>Base URL</label>
            <input
              className="input"
              style={{ flex: 1 }}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.deepseek.com/v1"
            />
          </div>
          <div className="form-row">
            <label>模型名</label>
            <input
              className="input"
              style={{ flex: 1 }}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="deepseek-chat"
            />
          </div>
          <div className="form-row">
            <label>API Key</label>
            <input
              className="input"
              style={{ flex: 1 }}
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
            />
          </div>

          <div className="add-row">
            <button className="btn primary" onClick={handleSave} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              className="btn"
              onClick={() => {
                clearConfig();
                setApiKey('');
                setHasKey(false);
                setMsg('已清除本机配置');
                onChange();
              }}
            >
              清除
            </button>
            {msg && <span className="chip info">{msg}</span>}
          </div>
        </section>

        <section className="panel">
          <header className="panel-head">
            <h2>安全边界（如实说明）</h2>
          </header>
          <div className="notes">
            <div>
              Key 使用 Web Crypto API（PBKDF2 派生 + AES-GCM）加密后存入本机 localStorage，
              <strong>不明文落盘</strong>。
            </div>
            <div className="warn-text">
              但密钥材料同样存放在 localStorage，这属于<strong>混淆级保护</strong>：可防止明文泄露与随手翻阅，
              无法防御同源脚本或本机恶意软件。需要强隔离时应改用后端托管 Key 的方案。
            </div>
            <div>调用链路：浏览器 → 本机 Node 服务（127.0.0.1:8787）→ 模型服务。本机服务不保存 Key、不记录对话内容。</div>
            <div>本机代理同时解决浏览器直连的跨域限制，因此无需服务商支持 CORS。</div>
          </div>
        </section>
      </div>
    </div>
  );
}
