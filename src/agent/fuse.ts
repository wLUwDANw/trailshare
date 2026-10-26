/**
 * ★ 主线 2：冲突融合（纯函数）。
 *
 * 输入：自己的记忆 + 朋友的信物边 + 当前时间 + 策略
 * 输出：每个 tag 的得分，以及得分的可解释拆解（self / social[*]）
 *
 * 三种策略共用同一个函数，靠 config.strategy 切换：
 *  A voting   —— 每个朋友一票（基线）
 *  B trust    —— 信任 × 时间衰减
 *  C verified —— 信任 × 时间衰减 × 验证加成（主策略）
 *
 * 为什么必须有基线：没有对照的实验不算实验。E3 用 A/B/C 三列对比。
 */
import { ALL_TAGS } from '../types';
import type {
  FuseConfig,
  FuseInput,
  FuseOutput,
  Memory,
  ProvenanceEdge,
  SocialContribution,
  Tag,
  TagContribution,
} from '../types';
import { decay, daysSince } from '../utils/time';
import { trustStats } from '../utils/trust';

export const DEFAULT_FUSE_CONFIG: FuseConfig = {
  halfLifeDays: 90,
  trustRejectedPenalty: 0.3,
  verifiedBonus: 1.2,
  strategy: 'verified',
};

function zeroScores(): Record<Tag, number> {
  const out = {} as Record<Tag, number>;
  for (const t of ALL_TAGS) out[t] = 0;
  return out;
}

function zeroContributions(): Record<Tag, TagContribution> {
  const out = {} as Record<Tag, TagContribution>;
  for (const t of ALL_TAGS) out[t] = { self: 0, social: [] };
  return out;
}

/** 某个发件人的社会边权重（不含 tag 归属，只看"人 × 时间 × 验证"）。 */
function socialWeight(
  edge: ProvenanceEdge,
  acceptedAt: string,
  allEdges: ProvenanceEdge[],
  now: Date,
  config: FuseConfig,
): number {
  if (config.strategy === 'voting') return 1;

  const stats = trustStats(edge.fromPubkey, allEdges);
  let w = stats.trust * decay(daysSince(acceptedAt, now), config.halfLifeDays);

  // 有过拒绝记录的发件人额外打折：信任基线已含拒绝，这里再显式惩罚一次，
  // 让"骗过一次"的代价高于"少接受过一次"。
  if (stats.rejected > 0) {
    const rejectRatio = stats.rejected / (stats.accepted + stats.rejected);
    w *= Math.max(0, 1 - config.trustRejectedPenalty * rejectRatio);
  }

  if (config.strategy === 'verified' && edge.verified) w *= config.verifiedBonus;
  return w;
}

export function fuse(input: FuseInput): FuseOutput {
  const { memories, edges, now, config } = input;
  const scores = zeroScores();
  const contributions = zeroContributions();

  /* 个人部分：所有策略相同 */
  for (const m of memories) {
    if (m.kind !== 'self') continue;
    const w = decay(daysSince(m.takenAt, now), config.halfLifeDays);
    scores[m.tag] += w;
    contributions[m.tag].self += w;
  }

  /* 社会部分：三策略在此分叉 */
  const memoryById = new Map<string, Memory>(memories.map((m) => [m.id, m]));
  const seen = new Set<string>();

  for (const edge of edges) {
    if (edge.rejected) continue;
    if (seen.has(edge.id)) continue; // 同一条边只计一次，防止重复导入放大权重
    const memory = memoryById.get(edge.memoryId);
    if (!memory || memory.kind !== 'gift') continue;

    const anchorTime = memory.acceptedAt ?? edge.acceptedAt;
    const w = socialWeight(edge, anchorTime, edges, now, config);
    if (w <= 0) continue;

    seen.add(edge.id);
    scores[memory.tag] += w;
    const item: SocialContribution = {
      fromPubkey: edge.fromPubkey,
      fromName: edge.fromName,
      weight: w,
      edgeId: edge.id,
      shareId: edge.shareId,
    };
    contributions[memory.tag].social.push(item);
  }

  // 社会贡献按权重降序，UI 和 explain 都取前面的
  for (const t of ALL_TAGS) {
    contributions[t].social.sort((a, b) => b.weight - a.weight);
  }

  return { scores, contributions };
}

/** 归一化成 0..1 的分布，仅用于展示，不参与排序。 */
export function normalizeScores(scores: Record<Tag, number>): Record<Tag, number> {
  const total = ALL_TAGS.reduce((n, t) => n + Math.max(0, scores[t]), 0);
  const out = {} as Record<Tag, number>;
  for (const t of ALL_TAGS) out[t] = total > 0 ? Math.max(0, scores[t]) / total : 0;
  return out;
}
