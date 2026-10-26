/**
 * 基于融合结果的推荐（纯函数）。
 * 排除"你正要去的目的地"本身，按得分取 topK，并给出可读理由。
 */
import { ALL_TAGS, TAG_LABELS } from '../types';
import type { FuseOutput, Recommendation, Tag, TagContribution } from '../types';

export function buildReason(tag: Tag, contrib: TagContribution | undefined): string {
  if (!contrib) return '';
  const parts: string[] = [];
  if (contrib.self > 0) parts.push(`你自己的照片里有${TAG_LABELS[tag]}`);
  if (contrib.social.length > 0) {
    const names = Array.from(new Set(contrib.social.map((s) => s.fromName))).join('、');
    parts.push(`${names}分享过${TAG_LABELS[tag]}`);
  }
  return parts.join('，');
}

export function recommend(
  destinationTag: Tag,
  fuseOutput: FuseOutput,
  topK = 3,
): Recommendation[] {
  const candidates = ALL_TAGS.filter((tag) => tag !== destinationTag)
    .map((tag) => ({
      tag,
      score: fuseOutput.scores[tag],
      reason: buildReason(tag, fuseOutput.contributions[tag]),
    }))
    // 同分时按 ALL_TAGS 顺序稳定排序，保证纯函数可复现
    .sort((a, b) => b.score - a.score || ALL_TAGS.indexOf(a.tag) - ALL_TAGS.indexOf(b.tag))
    .slice(0, topK);

  return candidates;
}

/**
 * 全标签排行榜（不排除任何标签）。反事实检验要用这一版：
 * recommend() 会把"被解释的标签"当成目的地排除掉，那样被解释标签自己的分数
 * 永远不参与比较，忠实度指标会失真。
 */
export function rankTags(fuseOutput: FuseOutput, topK = 3): Tag[] {
  return ALL_TAGS.filter((tag) => fuseOutput.scores[tag] > 0)
    .slice()
    .sort((a, b) => fuseOutput.scores[b] - fuseOutput.scores[a] || ALL_TAGS.indexOf(a) - ALL_TAGS.indexOf(b))
    .slice(0, topK);
}
