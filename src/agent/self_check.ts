/**
 * self_check：LLM 输出的引用一致性校验（纯函数，无网络、无 IO）。
 *
 * 为什么必须有这一层：
 * prompt 只是"请求"，不是"保证"。模型完全可能多编一个 [gift:s_fake]、
 * 漏掉一条真实来源，或者把回答包成 JSON。这里用**代码**兜底，
 * 而不是指望模型听话。
 *
 * 判定规则：
 * 1. 输出为空 / 像结构化数据（JSON、代码块）→ 直接失败
 * 2. LLM 多引用了库里真实存在、但规则 Agent 没引用的边 → extraIds 非空
 * 3. LLM 漏引用了规则 Agent 引用过的边 → missingIds 非空
 * 4. LLM 引用了库里根本不存在的边 → fakeIds 非空
 * 任一项非空 → passed = false，调用方退回规则版回答。
 *
 * ID 口径：回答文本里出现的是 shareId（形如 s_xxxx），而 explain() 的
 * citedEdgeIds 是内部边 ID（形如 e_xxxx）。这里统一折算成 shareId 再比对，
 * 避免"同一来源两种写法"被误判。
 */
import type { ProvenanceEdge } from '../types';

export interface SelfCheckResult {
  passed: boolean;
  reason?: string;
  /** LLM 多引用的边（这些边在库里存在，但规则 Agent 没引用） */
  extraIds: string[];
  /** LLM 漏引用的边（规则 Agent 引用了，但输出里没有） */
  missingIds: string[];
  /** LLM 编造的、库里不存在的边 */
  fakeIds: string[];
}

const GIFT_ID_RE = /\[gift:([^\]]+)\]/g;

/** 从文本里按出现顺序提取去重后的 [gift:xxx] 编号。 */
export function extractGiftIds(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(GIFT_ID_RE)) {
    const id = match[1].trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 输出像 JSON / 代码块时，即使里面混着合法编号也不能当回答用。 */
export function looksLikeStructured(text: string): boolean {
  const t = text.trim();
  if (t.startsWith('```')) return true;
  if (t.startsWith('{')) return true;
  // 注意：以 [gift:...] 开头是正常的引用标记，不是 JSON 数组
  if (t.startsWith('[')) return !t.startsWith('[gift:');
  return false;
}

export function selfCheck(
  llmOutput: string,
  expectedEdgeIds: string[],
  allEdges: ProvenanceEdge[],
): SelfCheckResult {
  const clean = (ids: string[]): string[] => Array.from(new Set(ids));

  if (typeof llmOutput !== 'string' || llmOutput.trim().length === 0) {
    return {
      passed: false,
      reason: 'LLM 输出为空',
      extraIds: [],
      missingIds: clean(expectedEdgeIds),
      fakeIds: [],
    };
  }

  if (looksLikeStructured(llmOutput)) {
    return {
      passed: false,
      reason: 'LLM 输出疑似 JSON/代码块，不是可展示的回答',
      extraIds: [],
      missingIds: clean(expectedEdgeIds),
      fakeIds: [],
    };
  }

  // 边 ID / shareId 双向映射：两边都折算成 shareId 再比较
  const byId = new Map<string, string>();
  const known = new Set<string>();
  for (const edge of allEdges) {
    if (edge.id) byId.set(edge.id, edge.shareId);
    if (edge.shareId) {
      byId.set(edge.shareId, edge.shareId);
      known.add(edge.shareId);
    }
  }
  const canonical = (token: string): string => byId.get(token) ?? token;

  const expected = clean(expectedEdgeIds.map(canonical));
  const extractedRaw = extractGiftIds(llmOutput);
  const extracted = clean(extractedRaw.map(canonical));

  const fakeRaw = extractedRaw.filter((token) => !known.has(canonical(token)));
  const fakeIds = clean(fakeRaw);

  const extraIds = clean(
    extractedRaw.filter((token) => {
      const c = canonical(token);
      return known.has(c) && !expected.includes(c);
    }),
  );

  const missingIds = expected.filter((id) => !extracted.includes(id));

  // 期望非空但一个引用都没有：这是最典型的"润色时把编号删干净"
  if (expected.length > 0 && extractedRaw.length === 0) {
    return {
      passed: false,
      reason: 'LLM 输出里没有任何 [gift:...] 引用，原回答的引用全部丢失',
      extraIds: [],
      missingIds,
      fakeIds: [],
    };
  }

  const reasons: string[] = [];
  if (fakeIds.length > 0) reasons.push(`编造了不存在的来源：${fakeIds.join('、')}`);
  if (extraIds.length > 0) reasons.push(`多引用了 ${extraIds.length} 条来源：${extraIds.join('、')}`);
  if (missingIds.length > 0) reasons.push(`漏引用了 ${missingIds.length} 条来源：${missingIds.join('、')}`);

  const passed = reasons.length === 0;
  return {
    passed,
    ...(passed ? {} : { reason: reasons.join('；') }),
    extraIds,
    missingIds,
    fakeIds,
  };
}
