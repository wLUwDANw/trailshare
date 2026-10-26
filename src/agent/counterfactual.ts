/**
 * ★ 主线 3：反事实忠实度（纯函数）。
 *
 * 定义：一条溯源解释的忠实度 = 把解释引用的来源边移除后，推荐结果翻转的概率。
 *
 * 为什么这个指标重要：LLM 的"解释"常是事后编的。我们不靠人工标注，
 * 而是用"拿掉它，结果会不会变"来自动测量解释是否真的对应决策依据。
 */
import { fuse } from './fuse';
import { rankTags } from './recommend';
import type { Explanation, FaithfulnessResult, FuseInput, Tag } from '../types';

export function faithfulness(
  explanation: Explanation,
  fullInput: FuseInput,
  topK = 3,
): FaithfulnessResult {
  const before = rankTags(fuse(fullInput), topK);

  const cited = new Set(explanation.citedEdgeIds);
  const counterfactualInput: FuseInput = {
    ...fullInput,
    edges: fullInput.edges.filter((e) => !cited.has(e.id)),
  };
  const after = rankTags(fuse(counterfactualInput), topK);

  const flipped = JSON.stringify(before) !== JSON.stringify(after);
  return { before, after, flipped, score: flipped ? 1 : 0 };
}

export interface BatchFaithfulnessDetail {
  question: string;
  tag: Tag;
  cited: number;
  before: Tag[];
  after: Tag[];
  flipped: boolean;
}

export interface BatchFaithfulnessResult {
  total: number;
  faithful: number;
  rate: number;
  details: BatchFaithfulnessDetail[];
}

/**
 * 批量评测：对每条解释单独做反事实（每条都用完整输入，互不影响）。
 * 注意不能累积移除——否则后面的解释会被前面的操作污染。
 */
export function faithfulnessBatch(
  explanations: Explanation[],
  fullInput: FuseInput,
  topK = 3,
): BatchFaithfulnessResult {
  const details: BatchFaithfulnessDetail[] = explanations.map((exp) => {
    const r = faithfulness(exp, fullInput, topK);
    return {
      question: exp.answer,
      tag: exp.tag,
      cited: exp.citedEdgeIds.length,
      before: r.before,
      after: r.after,
      flipped: r.flipped,
    };
  });
  const faithful = details.filter((d) => d.flipped).length;
  return {
    total: details.length,
    faithful,
    rate: details.length > 0 ? faithful / details.length : 0,
    details,
  };
}

/** 消融：移除全部社会边，只看个人记忆能推出什么（用于对照）。 */
export function withoutSocial(fullInput: FuseInput): FuseInput {
  return { ...fullInput, edges: [] };
}
