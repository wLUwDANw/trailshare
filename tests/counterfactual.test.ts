import { describe, expect, it } from 'vitest';
import { fuse } from '../src/agent/fuse';
import { explain, extractTag, summarizeCitations } from '../src/agent/explain';
import { faithfulness, faithfulnessBatch, withoutSocial } from '../src/agent/counterfactual';
import { makeMemory, makeEdge, daysAgo, NOW, PK } from '../src/experiments/fixtures';
import type { FuseInput, Memory, ProvenanceEdge } from '../src/types';

function gift(params: {
  id: string;
  tag: Memory['tag'];
  from: string;
  fromPubkey: string;
  acceptedDaysAgo: number;
  verified?: boolean;
}): { memory: Memory; edge: ProvenanceEdge } {
  const memory = makeMemory({
    id: params.id,
    kind: 'gift',
    tag: params.tag,
    intensity: 'high',
    takenAt: daysAgo(params.acceptedDaysAgo + 5),
    acceptedAt: daysAgo(params.acceptedDaysAgo),
    fromName: params.from,
    fromPubkey: params.fromPubkey,
    shareId: `s_${params.id}`,
  });
  const edge = makeEdge({
    id: `e_${params.id}`,
    memoryId: params.id,
    shareId: `s_${params.id}`,
    fromName: params.from,
    fromPubkey: params.fromPubkey,
    acceptedAt: daysAgo(params.acceptedDaysAgo),
    verified: params.verified ?? true,
  });
  return { memory, edge };
}

/**
 * 场景：A 被接受过两次（trust 2/3），B 只被接受过一次（trust 1/2），
 * 三条边新鲜度接近，所以自然/休闲的权重高于人文。
 * 移除自然那条边后，自然从榜单消失 → 典型的"忠实解释"。
 */
function buildInput(): FuseInput {
  const a1 = gift({ id: 'g1', tag: 'nature', from: 'A', fromPubkey: PK.A, acceptedDaysAgo: 5 });
  const a2 = gift({ id: 'g2', tag: 'leisure', from: 'A', fromPubkey: PK.A, acceptedDaysAgo: 6 });
  const b1 = gift({ id: 'g3', tag: 'heritage', from: 'B', fromPubkey: PK.B, acceptedDaysAgo: 5 });

  return {
    memories: [a1.memory, a2.memory, b1.memory],
    edges: [a1.edge, a2.edge, b1.edge],
    now: NOW,
    config: {
      halfLifeDays: 90,
      trustRejectedPenalty: 0.3,
      verifiedBonus: 1.2,
      strategy: 'verified',
    },
  };
}

describe('explain', () => {
  it('能从中文问题里抽出标签', () => {
    expect(extractTag('为什么推荐自然风光')).toBe('nature');
    expect(extractTag('有什么好吃的')).toBe('food');
    expect(extractTag('想去古镇看看')).toBe('watertown');
    expect(extractTag('今天天气不错')).toBeNull();
  });

  it('回答引用具体的 shareId 与边 id', () => {
    const input = buildInput();
    const out = fuse(input);
    const exp = explain('为什么推荐自然风光？', out, input.memories, input.edges);
    expect(exp.tag).toBe('nature');
    expect(exp.citedEdgeIds).toEqual(['e_g1']);
    expect(exp.answer).toContain('A');
    expect(exp.answer).toContain('[gift:s_g1]');
  });

  it('没有证据时明确说没有，不编造', () => {
    const input = buildInput();
    const out = fuse(input);
    const exp = explain('为什么推荐水乡古镇？', out, input.memories, input.edges);
    expect(exp.citedEdgeIds).toEqual([]);
    expect(exp.answer).toContain('没有找到');
  });

  it('识别不出的问题不会硬套标签', () => {
    const input = buildInput();
    const out = fuse(input);
    const exp = explain('你好', out, input.memories, input.edges);
    expect(exp.citedEdgeIds).toEqual([]);
    expect(exp.answer).toContain('无法从问题中识别');
  });

  it('summarizeCitations 能映射回边', () => {
    const input = buildInput();
    const out = fuse(input);
    const exp = explain('为什么推荐自然风光？', out, input.memories, input.edges);
    const cites = summarizeCitations(exp, input.edges);
    expect(cites).toHaveLength(1);
    expect(cites[0].label).toContain('A');
  });
});

describe('faithfulness', () => {
  it('移除被引用的边后推荐翻转 → 忠实度 1', () => {
    const input = buildInput();
    const out = fuse(input);
    const exp = explain('为什么推荐自然风光？', out, input.memories, input.edges);
    const result = faithfulness(exp, input);
    expect(result.before[0]).toBe('nature');
    expect(result.after).not.toContain('nature');
    expect(result.flipped).toBe(true);
    expect(result.score).toBe(1);
  });

  it('移除不改变 top-3 的边 → 不翻转，忠实度 0', () => {
    const input = buildInput();
    // 追加一条极老的边：权重趋近 0，本来就没进 top-3，移除它当然不改变结果
    const old = gift({ id: 'g9', tag: 'food', from: 'C', fromPubkey: PK.C, acceptedDaysAgo: 3000 });
    const withOld: FuseInput = {
      ...input,
      memories: [...input.memories, old.memory],
      edges: [...input.edges, old.edge],
    };
    const exp = { tag: 'food' as const, answer: '', citedEdgeIds: [old.edge.id], citedMemoryIds: [] };
    const result = faithfulness(exp, withOld);
    expect(result.before).toEqual(result.after);
    expect(result.flipped).toBe(false);
    expect(result.score).toBe(0);
  });

  it('不修改输入（纯函数）', () => {
    const input = buildInput();
    const before = input.edges.length;
    const out = fuse(input);
    const exp = explain('为什么推荐自然风光？', out, input.memories, input.edges);
    faithfulness(exp, input);
    expect(input.edges).toHaveLength(before);
  });

  it('解释没有引用任何边时，移除后结果不变', () => {
    const input = buildInput();
    const out = fuse(input);
    const exp = explain('为什么推荐水乡古镇？', out, input.memories, input.edges);
    const result = faithfulness(exp, input);
    expect(result.before).toEqual(result.after);
    expect(result.flipped).toBe(false);
    expect(result.score).toBe(0);
  });

  it('批量评测的比率按可检验条数算', () => {
    const input = buildInput();
    const out = fuse(input);
    const exps = ['自然风光', '人文历史', '水乡古镇'].map((label) =>
      explain(`为什么推荐${label}？`, out, input.memories, input.edges),
    );
    const testable = exps.filter((e) => e.citedEdgeIds.length > 0);
    const batch = faithfulnessBatch(testable, input);
    expect(batch.total).toBe(2);
    expect(batch.rate).toBeGreaterThanOrEqual(0);
    expect(batch.rate).toBeLessThanOrEqual(1);
    expect(batch.details.every((d) => typeof d.flipped === 'boolean')).toBe(true);
  });

  it('批量评测不互相污染（每条都基于完整输入）', () => {
    const input = buildInput();
    const out = fuse(input);
    const expNature = explain('为什么推荐自然风光？', out, input.memories, input.edges);
    const expLeisure = explain('为什么推荐休闲度假？', out, input.memories, input.edges);
    const batch = faithfulnessBatch([expNature, expLeisure], input);
    expect(batch.details[0].before).toEqual(batch.details[1].before);
  });

  it('消融掉全部社会边后只剩个人证据', () => {
    const input = buildInput();
    const out = fuse(withoutSocial(input));
    expect(out.scores.nature).toBe(0);
    expect(out.scores.heritage).toBe(0);
  });
});
