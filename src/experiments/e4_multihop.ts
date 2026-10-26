/**
 * E4 · 多跳传播衰减。
 *
 * 构造一条 A→B→C→D 的推荐链（不需要真实多用户，用构造数据即可）：
 * A 分享自然风光给 B，B 把同一语义转发给 C，C 再转发给 D。
 * 计算 D 的推荐里，A 的影响还剩多少、每跳衰减多少。
 *
 * 注意：这是**构造场景下的模型计算**，不是真实用户实验。
 * 样本为 1 条链，结论只能说明模型行为，不能外推为"社会影响的经验规律"。
 */
import { multihopDecay } from '../agent/multihop';
import type { FuseConfig, Hop, MultihopRow } from '../types';
import { buildHopChain, NOW } from './fixtures';

export interface E4Result {
  rows: MultihopRow[];
  table: string;
  hops: Hop[];
  config: FuseConfig;
}

export const E4_CONFIG: FuseConfig = {
  halfLifeDays: 90,
  trustRejectedPenalty: 0.3,
  verifiedBonus: 1.2,
  strategy: 'verified',
};

export function buildHops(): Hop[] {
  const { memories, edges } = buildHopChain();
  const [m1, m2, m3] = memories;
  const [e1, e2, e3] = edges;
  return [
    { from: 'A', to: 'B', edge: e1, memory: m1 },
    { from: 'B', to: 'C', edge: e2, memory: m2 },
    { from: 'C', to: 'D', edge: e3, memory: m3 },
  ];
}

export function runE4(): E4Result {
  const hops = buildHops();
  const rows = multihopDecay({ hops, now: NOW, config: E4_CONFIG });

  const lines: string[] = [];
  lines.push('| 跳数 | 路径 | 单跳权重 | 累积权重 | 直接份额 | 间接份额 |');
  lines.push('|---|---|---|---|---|---|');
  rows.forEach((r, i) => {
    const path = `${hops[i].from}→${hops[i].to}`;
    lines.push(
      `| ${r.depth} | ${path} | ${r.singleHopWeight.toFixed(3)} | ${r.accumulatedWeight.toFixed(3)} | ${(r.directShare * 100).toFixed(1)}% | ${(r.indirectShare * 100).toFixed(1)}% |`,
    );
  });

  return { rows, table: lines.join('\n'), hops, config: E4_CONFIG };
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('e4_multihop.ts');
if (isMain) {
  const r = runE4();
  console.log('E4 · 多跳传播衰减（A→B→C→D）\n');
  console.log(r.table);
  console.log('');
  const last = r.rows[r.rows.length - 1];
  console.log(
    `到第 ${last.depth} 跳，源头 A 的影响只剩初始的 ${(last.accumulatedWeight * 100).toFixed(1)}%；间接份额 ${(last.indirectShare * 100).toFixed(1)}%。`,
  );
}
