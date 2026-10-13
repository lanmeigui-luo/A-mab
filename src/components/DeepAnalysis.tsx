import { useEffect, useRef, useState } from 'react';
import { readConfig } from '@/lib/crypto';
import { extractJson, streamChat } from '@/services/llm';
import { DASH } from '@/lib/format';

interface Props {
  kind: 'stock' | 'board';
  title: string;
  /** 已组装好的结构化数据（真实字段，缺失项已标注） */
  contextText: string;
  onClose: () => void;
}

const STOCK_KEYS = ['结论', '确定性', '买入区间', '止损', '目标1', '目标2', '风险', '失效条件'];
const BOARD_KEYS = ['板块强度', '持续性判断', '核心分支', '风险点', '值得跟踪的细分方向'];

function buildMessages(kind: 'stock' | 'board', contextText: string) {
  const keys = kind === 'stock' ? STOCK_KEYS : BOARD_KEYS;
  const system =
    '你是一名 A 股短线交易分析师，只做客观分析，不做承诺。' +
    '你必须严格基于给定的结构化数据作答，不得编造任何未在数据中出现的价格、指标或事件。' +
    '若某项缺乏数据支撑，必须显式说明「数据缺失」而非推测。' +
    '分析结论必须给出失效条件。';

  const user =
    `以下是${kind === 'stock' ? '个股' : '板块'}的真实结构化数据：\n\n` +
    contextText +
    '\n\n请按以下要求输出：\n' +
    '1) 先给出不超过 300 字的分析正文\n' +
    '2) 再输出一个 JSON 代码块，字段严格为：\n' +
    JSON.stringify(Object.fromEntries(keys.map((k) => [k, ''])), null, 2) +
    '\n3) 若当前处于涨停状态，买入区间字段必须填「涨停不可买入」\n' +
    '4) JSON 中不得出现数据里没有的数值';

  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

export function DeepAnalysis({ kind, title, contextText, onClose }: Props) {
  const [ready, setReady] = useState<{ baseUrl: string; model: string; apiKey: string } | null>(null);
  const [checking, setChecking] = useState(true);
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [json, setJson] = useState<Record<string, unknown> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    readConfig().then((c) => {
      if (c && c.apiKey && c.public.baseUrl && c.public.model) {
        setReady({ baseUrl: c.public.baseUrl, model: c.public.model, apiKey: c.apiKey });
      }
      setChecking(false);
    });
  }, []);

  const run = async () => {
    if (!ready) return;
    setRunning(true);
    setError(null);
    setText('');
    setJson(null);
    setTruncated(false);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const r = await streamChat({
        baseUrl: ready.baseUrl,
        apiKey: ready.apiKey,
        model: ready.model,
        messages: buildMessages(kind, contextText),
        onDelta: (d) => setText((prev) => prev + d),
        signal: ctrl.signal,
      });
      setTruncated(r.truncated);
      setJson(extractJson(r.text));
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setRunning(false);
    }
  };

  const keys = kind === 'stock' ? STOCK_KEYS : BOARD_KEYS;

  return (
    <div className="drawer-mask" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>{kind === 'stock' ? '个股深度分析' : '板块深度分析'}</h2>
          <span className="mono muted">{title}</span>
          <span className="spacer" />
          {ready && <span className="src-tag ok">{ready.model}</span>}
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </header>

        <section className="panel">
          <header className="panel-head">
            <h2>投喂给模型的结构化数据</h2>
            <span className="muted">全部为真实字段，缺失项已标注</span>
          </header>
          <pre className="ctx-box">{contextText}</pre>
        </section>

        {checking ? (
          <div className="empty">检查模型配置…</div>
        ) : !ready ? (
          <div className="alert error">
            模型未连接：请先在「设置 → 模型配置」中填写 Base URL / API Key / 模型名。
            <strong>未配置时不会编造任何分析结论。</strong>
          </div>
        ) : (
          <section className="panel">
            <header className="panel-head">
              <h2>模型输出</h2>
              <span className="spacer" />
              {!running && (
                <button className="btn primary" onClick={run}>
                  开始分析
                </button>
              )}
              {running && (
                <button className="btn" onClick={() => abortRef.current?.abort()}>
                  中断
                </button>
              )}
            </header>

            {error && <div className="alert error">调用失败：{error}（不降级为模拟结论）</div>}
            {truncated && <div className="alert warn">输出中断，已保留已生成内容</div>}

            {text ? (
              <pre className="stream-box">{text}</pre>
            ) : (
              !running && <div className="empty">点击「开始分析」，模型将流式返回结果</div>
            )}

            {json && (
              <div className="factor-box">
                <div className="factor-head">结构化结果</div>
                <div className="factor-grid">
                  {keys.map((k) => (
                    <div key={k} className="factor">
                      <div className="f-top">
                        <span>{k}</span>
                      </div>
                      <div className="f-detail">
                        {typeof json[k] === 'string' && json[k] ? String(json[k]) : DASH}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="notes">
              <div>模型结论仅供参考，不构成投资建议；高确定性不等于必涨</div>
              <div>提示词已约束：不得编造数据中不存在的数值，缺失必须显式声明</div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
