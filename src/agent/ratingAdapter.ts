/**
 * 评星 → fuse 输入适配层。
 *
 * 铁律：**不改 fuse.ts**。
 * fuse 的输入是 memories + edges，它自己按边计算 trust 与权重。
 * 所以这里做的是"在喂给 fuse 之前，把低分记忆对应的边标记成 rejected"：
 *   - fuse 会跳过 rejected 边（社会贡献里不再计这一条）
 *   - trustStats 会把它们算成 rejected（发件人的信任分下降）
 *
 * 这与"接收方给了差评"的语义一致，而且 E1–E4 的输入里没有 ratings，数字不会变。
 */
import type { Memory, ProvenanceEdge } from '../types';

export const ACCEPT_THRESHOLD = 3;

/** 平均分：忽略 null；一张都没评返回 null。 */
export function averageRating(ratings: Array<number | null> | undefined): number | null {
  if (!ratings || ratings.length === 0) return null;
  const scored = ratings.filter((r): r is number => typeof r === 'number');
  if (scored.length === 0) return null;
  return scored.reduce((sum, r) => sum + r, 0) / scored.length;
}

/** 某条记忆对应的"是否算被接受"。没评过 = 接受（与产品默认一致）。 */
export function isAcceptedByRating(memory: Memory | undefined): boolean {
  if (!memory) return true;
  const avg = averageRating(memory.ratings);
  if (avg === null) return true;
  return avg >= ACCEPT_THRESHOLD;
}

/**
 * 统计 accepted / rejected。
 * 已拒绝的边原样计入 rejected；其余按对应记忆的平均分判定。
 */
export function ratingsToCounts(
  edges: ProvenanceEdge[],
  memories: Memory[],
): { accepted: number; rejected: number } {
  const memoryById = new Map(memories.map((m) => [m.id, m]));
  let accepted = 0;
  let rejected = 0;

  for (const edge of edges) {
    if (edge.rejected) {
      rejected += 1;
      continue;
    }
    if (isAcceptedByRating(memoryById.get(edge.memoryId))) accepted += 1;
    else rejected += 1;
  }
  return { accepted, rejected };
}

/**
 * 给 fuse 用的边：低分记忆的边被标成 rejected（返回新数组，不改入参）。
 * 已拒绝的边保持原样；找不到对应记忆的边保持原样。
 */
export function adaptEdgesForFuse(edges: ProvenanceEdge[], memories: Memory[]): ProvenanceEdge[] {
  const memoryById = new Map(memories.map((m) => [m.id, m]));
  return edges.map((edge) => {
    if (edge.rejected) return edge;
    const memory = memoryById.get(edge.memoryId);
    if (!memory) return edge;
    if (isAcceptedByRating(memory)) return edge;
    return { ...edge, rejected: true };
  });
}
