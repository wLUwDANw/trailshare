/**
 * ★ 主线 6：多跳传播分析（纯函数）。
 *
 * 问题：A 推荐给 B，B 又推荐给 C，C 的推荐在多大程度上受 A 影响？每跳衰减多少？
 *
 * 模型：
 *  单跳权重 w = trust(发件人) × decay(距接受时长) × (已验证 ? verifiedBonus : 1)
 *  累积权重   = 沿路径累乘（A 的影响经过 n 跳后剩下的比例）
 *
 * 归因说明（诚实标注）：directShare 是一个**启发式归因**，不是因果分解。
 * 做法：把累积权重写成各跳权重之积，取对数后按各跳的 |log w| 占比分摊。
 *   directShare(d) = |log w_d| / Σ_{i≤d} |log w_i|
 * 好处是严格可加、随链变长单调下降（直接朋友的相对贡献被更上游的链条稀释），
 * 这与直觉一致，也让 E4 的"间接份额"随跳数单调上升。换任何权重都会改变数值。
 */
import type { FuseConfig, Hop, MultihopRow } from '../types';
import { decay, daysSince } from '../utils/time';
import { trustStats } from '../utils/trust';

export interface MultihopInput {
  hops: Hop[];
  now: Date;
  config: FuseConfig;
}

export function hopWeight(hop: Hop, allEdges: Hop['edge'][], now: Date, config: FuseConfig): number {
  const stats = trustStats(hop.edge.fromPubkey, allEdges);
  const anchor = hop.memory.acceptedAt ?? hop.edge.acceptedAt;
  let w = stats.trust * decay(daysSince(anchor, now), config.halfLifeDays);
  if (stats.rejected > 0) {
    const ratio = stats.rejected / (stats.accepted + stats.rejected);
    w *= Math.max(0, 1 - config.trustRejectedPenalty * ratio);
  }
  if (config.strategy === 'verified' && hop.edge.verified) w *= config.verifiedBonus;
  // 投票策略下退化为"每跳都算 1 票"，衰减只看时间——用于对照
  if (config.strategy === 'voting') {
    w = decay(daysSince(anchor, now), config.halfLifeDays);
  }
  return w;
}

export function multihopDecay(input: MultihopInput): MultihopRow[] {
  const { hops, now, config } = input;
  const allEdges = hops.map((h) => h.edge);
  const rows: MultihopRow[] = [];

  let accumulated = 1; // 源头自身的影响力记为 1
  let logSum = 0; // Σ |log w_i|

  hops.forEach((hop, index) => {
    const w = hopWeight(hop, allEdges, now, config);
    accumulated *= w;

    // 归因：按对数贡献分摊，w=0 时用极小值兜底，避免 log(0)
    const cost = Math.abs(Math.log(Math.max(w, 1e-12)));
    logSum += cost;
    const directShare = logSum > 0 ? cost / logSum : 1;

    rows.push({
      target: hop.to,
      depth: index + 1,
      singleHopWeight: Number(w.toFixed(4)),
      accumulatedWeight: Number(accumulated.toFixed(4)),
      attenuation: Number(w.toFixed(4)),
      directShare: Number(directShare.toFixed(4)),
      indirectShare: Number((1 - directShare).toFixed(4)),
    });
  });

  return rows;
}

/** 从 hops 里取最后一个节点作为最终受影响的用户。 */
export function finalTarget(hops: Hop[]): string | null {
  return hops.length > 0 ? hops[hops.length - 1].to : null;
}
