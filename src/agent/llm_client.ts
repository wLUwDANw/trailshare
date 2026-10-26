/**
 * LLM 客户端（OpenAI 兼容接口）。
 *
 * ★ 核心原则：LLM 只能润色表达，不能参与决策。
 *   这个文件只负责"把消息发出去、把文本拿回来"，不认识 tag、不认识来源边、
 *   更不参与排序。任何决策逻辑都不允许下沉到这里。
 *
 * 安全提示（很重要）：
 * VITE_ 前缀的变量会被 Vite 打进前端产物，等于把这个 Key 公开给所有能打开页面的人。
 * 所以这套配置只适合本地演示 / 内网试用；生产环境必须换成服务端代理，
 * 由服务端持有 Key，前端只调自己的接口。
 */

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ChatMessage {
  role: string;
  content: string;
}

export const DEFAULT_MODEL = 'deepseek-chat';
export const LLM_TIMEOUT_MS = 10_000;
export const LLM_MAX_RETRIES = 1; // 失败重试 1 次 → 最多 2 次请求

/** 连续失败达到这个次数就熔断，避免每次提问都卡满超时。 */
const BREAKER_THRESHOLD = 2;
const BREAKER_COOLDOWN_MS = 60_000;

let consecutiveFailures = 0;
let breakerOpenUntil = 0;

/** 从 Vite 环境变量读配置。没配 baseUrl 或 Key 就返回 null。 */
export function configFromEnv(): LLMConfig | null {
  const env = import.meta.env as Record<string, string | undefined>;
  const baseUrl = String(env?.VITE_LLM_BASE_URL ?? '').trim();
  const apiKey = String(env?.VITE_LLM_API_KEY ?? '').trim();
  const model = String(env?.VITE_LLM_MODEL ?? '').trim() || DEFAULT_MODEL;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model };
}

/** 没配 Key 时返回 false。UI 可以据此决定是否提示"当前是规则版"。 */
export function isConfigured(): boolean {
  return configFromEnv() !== null;
}

/** 仅供测试/演示：手动复位熔断器。 */
export function resetBreaker(): void {
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
}

export class LLMNotConfiguredError extends Error {
  constructor() {
    super('LLM 未配置：缺少 VITE_LLM_BASE_URL 或 VITE_LLM_API_KEY');
    this.name = 'LLMNotConfiguredError';
  }
}

export class LLMUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMUnavailableError';
  }
}

function isOpen(): boolean {
  return Date.now() < breakerOpenUntil;
}

/**
 * 发一次 chat 请求，返回助手文本。
 * 失败会重试 1 次；两次都失败则抛错，调用方必须 catch 并降级到规则版本。
 */
export async function chat(messages: ChatMessage[], config: LLMConfig): Promise<string> {
  if (!config || !config.apiKey || !config.baseUrl) throw new LLMNotConfiguredError();
  if (isOpen()) {
    throw new LLMUnavailableError('LLM 暂时不可用（熔断中），已直接降级');
  }

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0.2,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${body ? `：${body.slice(0, 120)}` : ''}`);
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };
      if (data.error?.message) throw new Error(data.error.message);

      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new Error('LLM 返回了空内容');
      }

      consecutiveFailures = 0;
      return content.trim();
    } catch (err) {
      lastError = err;
      // 超时也走重试；最后一次失败后跳出
      if (attempt === LLM_MAX_RETRIES) break;
    } finally {
      clearTimeout(timer);
    }
  }

  consecutiveFailures += 1;
  if (consecutiveFailures >= BREAKER_THRESHOLD) {
    breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    consecutiveFailures = 0;
  }

  const reason =
    lastError instanceof Error
      ? lastError.name === 'AbortError'
        ? `请求超时（${LLM_TIMEOUT_MS / 1000}s）`
        : lastError.message
      : '未知错误';
  throw new LLMUnavailableError(`LLM 调用失败：${reason}`);
}
