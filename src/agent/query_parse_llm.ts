/**
 * 查询解析（LLM 优先，规则兜底）。
 *
 * ★ 核心原则：这里只把"自然语言问题"翻译成结构化槽位，
 *   不决定推荐、不决定引用哪条来源边。解析结果拿去做别的事之前，
 *   必须经过 explain() 的规则逻辑。
 *
 * 解析结果必须过校验：
 * - tag 只能是六类之一，否则置 null（宁可退回规则，也不接受脏标签）
 * - timeRange 必须是一对合法的 ISO 日期，且 start <= end
 * - keywords 只保留字符串、去重、最多 8 个
 */
import { ALL_TAGS } from '../types';
import type { Tag } from '../types';
import { chat, type LLMConfig, type ChatMessage } from './llm_client';
import { extractTag } from './explain';

export interface ParsedQuery {
  tag: Tag | null;
  timeRange?: { start: string; end: string };
  keywords: string[];
}

const SYSTEM_PROMPT = `你是旅行偏好查询解析器。只输出一个 JSON 对象，不要输出解释、不要用 Markdown 代码块。

字段定义：
- "tag"：字符串或 null。只能取以下六类之一：heritage（人文历史）、nature（自然风光）、
  watertown（水乡古镇）、metropolis（都市风光）、food（美食探索）、leisure（休闲度假）。
  无法判断时填 null，禁止臆测。
- "timeRange"：可选，形如 {"start":"YYYY-MM-DD","end":"YYYY-MM-DD"}。
  只有问题里出现明确时间范围时才输出，否则省略该字段。
- "keywords"：字符串数组，最多 6 个，取自问题中的关键词。

禁止编造问题中没有出现的信息。`;

/** 规则兜底：复用 explain.ts 里那套关键词匹配，行为和以前完全一致。 */
export function parseQueryByRule(question: string): ParsedQuery {
  return { tag: extractTag(question), keywords: [] };
}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/** 宽松地从模型输出里挖出第一个 JSON 对象；挖不到返回 null。 */
export function parseJsonLoose(text: string): unknown {
  const body = stripFences(text);
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

/** 把任意 LLM 输出收敛成合法 ParsedQuery。越界的一律丢弃，不抛错。 */
export function normalizeParsed(raw: unknown): ParsedQuery {
  const out: ParsedQuery = { tag: null, keywords: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;

  const obj = raw as Record<string, unknown>;

  if (typeof obj.tag === 'string' && (ALL_TAGS as readonly string[]).includes(obj.tag)) {
    out.tag = obj.tag as Tag;
  }

  const range = obj.timeRange;
  if (
    typeof range === 'object' &&
    range !== null &&
    isIsoDate((range as Record<string, unknown>).start) &&
    isIsoDate((range as Record<string, unknown>).end)
  ) {
    const start = (range as Record<string, string>).start;
    const end = (range as Record<string, string>).end;
    if (start <= end) out.timeRange = { start, end };
  }

  if (Array.isArray(obj.keywords)) {
    const seen = new Set<string>();
    for (const item of obj.keywords) {
      if (typeof item !== 'string') continue;
      const word = item.trim();
      if (!word || word.length > 24 || seen.has(word)) continue;
      seen.add(word);
      out.keywords.push(word);
      if (out.keywords.length >= 8) break;
    }
  }

  return out;
}

/**
 * 有 config 走 LLM，任何失败（网络、超时、JSON 不合法、字段越界）都退回规则。
 * 这个函数永远不会 throw —— 调用方不需要 try/catch。
 */
export async function parseQuery(
  question: string,
  config: LLMConfig | null,
): Promise<ParsedQuery> {
  const fallback = parseQueryByRule(question);
  if (!config || !config.apiKey) return fallback;

  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: question },
    ];
    const raw = await chat(messages, config);
    const parsed = parseJsonLoose(raw);
    if (parsed === null) return fallback;
    // 字段越界一律收敛（tag 不是六类之一 → null），不抛错
    return normalizeParsed(parsed);
  } catch {
    return fallback;
  }
}
