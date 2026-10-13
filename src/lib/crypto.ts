/**
 * API Key 本地加密存储（Web Crypto API：PBKDF2 派生 + AES-GCM）
 *
 * ⚠️ 诚实说明：密钥材料也存放在 localStorage，这属于**混淆级保护**，
 * 能防止明文泄露与随手翻阅，但无法防御同源脚本或本机恶意软件。
 * 真正的强隔离需要后端托管 Key（见 /api/llm 的 proxy 模式）。
 * UI 上会如实标注这一边界，不假称「银行级加密」。
 */

const KEY_STORE = 'radar.llm.keyring.v1';
const SECRET_STORE = 'radar.llm.config.v1';

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out as Uint8Array;
}

/** 取（或首次生成）设备密钥材料 */
async function getKeyMaterial(): Promise<Uint8Array> {
  const existing = localStorage.getItem(KEY_STORE);
  if (existing) return unb64(existing);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  localStorage.setItem(KEY_STORE, b64(salt));
  return salt as Uint8Array;
}

async function deriveKey(): Promise<CryptoKey> {
  const material = await getKeyMaterial();
  const base = await crypto.subtle.importKey('raw', material as BufferSource, 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: material as BufferSource, iterations: 100_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptSecret(plain: string): Promise<string> {
  const key = await deriveKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plain);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return b64(iv) + '.' + b64(new Uint8Array(ct));
}

export async function decryptSecret(packed: string): Promise<string> {
  const [ivB64, ctB64] = packed.split('.');
  if (!ivB64 || !ctB64) throw new Error('密文格式不正确');
  const key = await deriveKey();
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(ivB64) as BufferSource },
    key,
    unb64(ctB64) as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

export interface LlmConfig {
  provider: string;
  baseUrl: string;
  model: string;
  /** 加密后的 Key，明文不落盘 */
  apiKeyEnc: string;
  updatedAt: number;
}

export interface LlmConfigPublic {
  provider: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  updatedAt: number;
}

export const PROVIDER_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'dashscope', name: '通义千问（兼容模式）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'moonshot', name: 'Kimi（Moonshot）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'openrouter', name: 'OpenRouter（含免费模型）', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat-v3:free' },
  { id: 'custom', name: '自定义 OpenAI 兼容', baseUrl: '', model: '' },
] as const;

export async function saveConfig(cfg: {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}): Promise<void> {
  const apiKeyEnc = cfg.apiKey ? await encryptSecret(cfg.apiKey) : '';
  const payload: LlmConfig = {
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKeyEnc,
    updatedAt: Date.now(),
  };
  localStorage.setItem(SECRET_STORE, JSON.stringify(payload));
}

export async function readConfig(): Promise<{ public: LlmConfigPublic; apiKey: string } | null> {
  const raw = localStorage.getItem(SECRET_STORE);
  if (!raw) return null;
  try {
    const cfg = JSON.parse(raw) as LlmConfig;
    let apiKey = '';
    if (cfg.apiKeyEnc) {
      try {
        apiKey = await decryptSecret(cfg.apiKeyEnc);
      } catch {
        apiKey = '';
      }
    }
    return {
      public: {
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        hasKey: !!apiKey,
        updatedAt: cfg.updatedAt,
      },
      apiKey,
    };
  } catch {
    return null;
  }
}

export function clearConfig(): void {
  localStorage.removeItem(SECRET_STORE);
}
