/**
 * 溯源回答生成。
 *
 * 关键设计：解释必须引用**具体的来源边 id**，而不是笼统的"因为朋友推荐"。
 * 只有这样，"反事实忠实度"才能自动计算——把引用的边拿掉，看推荐是否真的变。
 *
 * ★ LLM 分层（MD-2）的三条铁律：
 * 1. 排序由 fuse() + rankTags() 决定，LLM 不参与；
 * 2. 引用哪些来源边由本文件的规则逻辑决定，LLM 不能新增/删除；
 * 3. LLM 只做两件事：把问题解析成槽位（query_parse_llm）、把已有回答换个说法（llm_paraphrase）。
 *    换完之后必须过 self_check，引用编号一个不多一个不少，否则退回规则版。
 *
 * 为什么 explain() 保持同步：现有测试与反事实检验都把它当纯函数同步调用。
 * LLM 版本另开 explainWithLLM()，这样"决策路径"永远不会因为网络而变形。
 */
import { TAG_LABELS } from '../types';
import type { Explanation, FuseOutput, Memory, ProvenanceEdge, Tag } from '../types';
import { configFromEnv, type LLMConfig } from './llm_client';
import { parseQuery } from './query_parse_llm';
import { paraphrase } from './llm_paraphrase';
import { selfCheck } from './self_check';

const KEYWORD_MAP: Array<[string[], Tag]> = [
  [['人文', '历史', '古迹', '博物馆'], 'heritage'],
  [['自然', '风光', '山', '湖', '户外'], 'nature'],
  [['水乡', '古镇', '江南'], 'watertown'],
  [['都市', '城市', '夜景', '逛街'], 'metropolis'],
  [['美食', '吃', '小吃', '餐厅'], 'food'],
  [['休闲', '放松', '度假', '温泉'], 'leisure'],
];

export function extractTag(question: string): Tag | null {
  for (const [words, tag] of KEYWORD_MAP) {
    if (words.some((w) => question.includes(w))) return tag;
  }
  return null;
}

/** 纯规则的回答构造：给定 tag，产出回答文本 + 引用的边。 */
function buildExplanation(
  tag: Tag,
  fuseOutput: FuseOutput,
  memories: Memory[],
  edges: ProvenanceEdge[],
): Explanation {
  const contrib = fuseOutput.contributions[tag];
  const validEdgeIds = new Set(edges.map((e) => e.id));
  const citedEdges = contrib.social
    .filter((s) => s.weight > 0 && (validEdgeIds.size === 0 || validEdgeIds.has(s.edgeId)))
    .map((s) => s.edgeId);

  const citedMemoryIds = memories.filter((m) => m.kind === 'self' && m.tag === tag).map((m) => m.id);

  const parts: string[] = [];
  if (contrib.self > 0) {
    parts.push(`你自己的照片里有${TAG_LABELS[tag]}类记忆`);
  }
  if (contrib.social.length > 0) {
    const names = Array.from(new Set(contrib.social.map((s) => s.fromName))).join('、');
    const marks = contrib.social.map((s) => `[gift:${s.shareId}]`).join(' ');
    parts.push(`你从${names}那里接受了${TAG_LABELS[tag]}的分享 ${marks}`);
  }

  if (parts.length === 0) {
    return {
      tag,
      answer: `没有找到推荐${TAG_LABELS[tag]}的证据（你自己的记忆和朋友的信物里都没有）。`,
      citedEdgeIds: [],
      citedMemoryIds: [],
    };
  }

  return {
    tag,
    answer: `${parts.join('，')}。`,
    citedEdgeIds: citedEdges,
    citedMemoryIds,
  };
}

/** 兼容方案 9.4 的签名：memories / edges 用于校验引用是否真实存在。 */
export function explain(
  question: string,
  fuseOutput: FuseOutput,
  memories: Memory[] = [],
  edges: ProvenanceEdge[] = [],
): Explanation {
  const tag = extractTag(question);
  if (!tag) {
    return {
      tag: 'nature',
      answer: '无法从问题中识别语义标签（可试试"为什么推荐自然风光"）。',
      citedEdgeIds: [],
      citedMemoryIds: [],
    };
  }
  return buildExplanation(tag, fuseOutput, memories, edges);
}

/** explainWithLLM 的返回值：在规则结果上追加"这次到底用没用 LLM"的元信息。 */
export interface LLMExplanation extends Explanation {
  /** 最终回答是否来自 LLM 润色 */
  usedLLM: boolean;
  /** 当前环境是否配置了 LLM（用于 UI 决定要不要显示"规则版"角标） */
  llmConfigured: boolean;
  /** 没走 LLM 的原因，便于调试与展示 */
  fallbackReason?: string;
}

/**
 * 完整调用链（只在 UI 层用）：
 *   规则回答 → （可选）润色 → self_check → 通过就用润色稿，否则重试一次，再失败退回规则稿。
 *
 * 永远不 throw：所有失败都收敛成 fallbackReason。
 */
export async function explainWithLLM(
  question: string,
  fuseOutput: FuseOutput,
  memories: Memory[] = [],
  edges: ProvenanceEdge[] = [],
  config: LLMConfig | null = configFromEnv(),
): Promise<LLMExplanation> {
  const configured = Boolean(config && config.apiKey);

  // 1. 查询解析（LLM 可选，失败自动退回关键词匹配）
  const parsed = await parseQuery(question, configured ? config : null);
  const tag = parsed.tag ?? extractTag(question);

  // 2. 规则 Agent 产出回答与引用——这一步完全不看 LLM
  const rule: Explanation = tag
    ? buildExplanation(tag, fuseOutput, memories, edges)
    : explain(question, fuseOutput, memories, edges);

  if (!configured) {
    return { ...rule, usedLLM: false, llmConfigured: false, fallbackReason: 'LLM 未配置' };
  }

  if (rule.citedEdgeIds.length === 0) {
    // 没有可引用的来源边就没有"编号一致性"可校验，润色没有意义
    return {
      ...rule,
      usedLLM: false,
      llmConfigured: true,
      fallbackReason: '没有可引用的来源边，跳过润色',
    };
  }

  // 3. 润色 + 校验；失败重试一次
  let lastReason = '润色未通过引用校验';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const llmAnswer = await paraphrase(rule.answer, rule.citedEdgeIds, config);
      const check = selfCheck(llmAnswer, rule.citedEdgeIds, edges);
      if (check.passed) {
        return { ...rule, answer: llmAnswer, usedLLM: true, llmConfigured: true };
      }
      lastReason = check.reason ?? lastReason;
    } catch (err) {
      lastReason = err instanceof Error ? err.message : '润色失败';
    }
  }

  // 4. 两次都不过 → 退回规则版，把原因带回去给 UI 标注
  return { ...rule, usedLLM: false, llmConfigured: true, fallbackReason: lastReason };
}

/** 给一句话解释补上可读的来源清单（UI 用，不影响算法）。 */
export function summarizeCitations(
  explanation: Explanation,
  edges: ProvenanceEdge[],
): Array<{ edge: ProvenanceEdge; label: string }> {
  const ids = new Set(explanation.citedEdgeIds);
  return edges
    .filter((e) => ids.has(e.id))
    .map((e) => ({
      edge: e,
      label: `${e.fromName}（${e.fromPubkey.slice(0, 8)}）`,
    }));
}
