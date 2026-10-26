/**
 * LLM 润色（只改表达，不改事实）。
 *
 * ★ 核心原则：LLM 只能润色表达，不能参与决策。
 *   这个函数拿到的 ruleAnswer 已经由规则 Agent 生成完毕，来源边也选好了。
 *   模型唯一被允许做的事是"换一种说法"，引用编号必须原样保留。
 *
 * 注意：这里不做校验 —— 校验在 self_check.ts，由调用方（explain.ts）执行。
 * 把"生成"和"校验"分开，才能保证校验逻辑不被 prompt 一句话绕过。
 */
import { chat, type ChatMessage, type LLMConfig } from './llm_client';
import { extractGiftIds } from './self_check';

export const PARAPHRASE_SYSTEM_PROMPT = `你只能润色以下回答的表达，不能：
1. 新增任何来源边引用
2. 删除任何来源边引用
3. 改变引用的 [gift:s_xxx] 编号
4. 编造规则回答中没有的事实`;

/**
 * 润色。
 * - 没配置 config：直接原样返回，不产生任何网络请求
 * - 模型返回空串：抛错，让调用方降级
 */
export async function paraphrase(
  ruleAnswer: string,
  citedEdgeIds: string[],
  config: LLMConfig | null,
): Promise<string> {
  if (!config || !config.apiKey) return ruleAnswer;

  // 白名单优先用回答里真实出现的编号：模型要"保留"的就是这些字符串。
  // citedEdgeIds 是内部边 ID，作为补充信息一并给出。
  const markers = extractGiftIds(ruleAnswer).map((id) => `[gift:${id}]`);
  const allowMarkers = markers.length > 0 ? markers.join('、') : '（无）';

  const userMessage = [
    `规则回答：${ruleAnswer}`,
    `回答中允许出现的引用编号：${allowMarkers}`,
    `允许引用的边 ID：${citedEdgeIds.length > 0 ? citedEdgeIds.join(', ') : '（无）'}`,
    '输出：润色后的回答，必须包含原回答中所有 [gift:s_xxx] 编号，一个不多一个不少。',
    '只输出润色后的正文，不要加引号、不要加解释、不要用 Markdown 代码块。',
  ].join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: PARAPHRASE_SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  const polished = await chat(messages, config);
  const text = polished.trim();
  if (!text) throw new Error('LLM 返回了空的润色结果');
  return text;
}
