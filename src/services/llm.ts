/** 模型深度分析：调用本地代理 /api/llm/chat，流式读取 */

export interface LlmChatParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: { role: 'system' | 'user'; content: string }[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
}

export async function streamChat(params: LlmChatParams): Promise<{ text: string; truncated: boolean }> {
  const res = await fetch('/api/llm/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      model: params.model,
      messages: params.messages,
      temperature: params.temperature ?? 0.3,
      maxTokens: params.maxTokens ?? 2048,
    }),
    signal: params.signal,
  });

  if (!res.ok || !res.body) {
    let msg = 'HTTP ' + res.status;
    try {
      const j = await res.json();
      msg = j?.error || msg;
    } catch {
      /* 忽略 */
    }
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let buf = '';
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const delta = j?.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            text += delta;
            params.onDelta(delta);
          }
        } catch {
          /* 单行解析失败不影响整体 */
        }
      }
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      // 用户中断：保留已输出内容并标记
      truncated = true;
    } else {
      truncated = true;
      throw e;
    }
  }

  return { text, truncated };
}

/** 从模型输出中提取 JSON 块（容错：允许 ```json 包裹） */
export function extractJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
