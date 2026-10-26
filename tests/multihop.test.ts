import { describe, expect, it } from 'vitest';
import { multihopDecay, hopWeight, finalTarget } from '../src/agent/multihop';
import { DEFAULT_FUSE_CONFIG } from '../src/agent/fuse';
import { buildHopChain, NOW, daysAgo, makeEdge, makeMemory, PK } from '../src/experiments/fixtures';
import type { FuseConfig, Hop } from '../src/types';

function hops(): Hop[] {
  const { memories, edges } = buildHopChain();
  return [
    { from: 'A', to: 'B', edge: edges[0], memory: memories[0] },
    { from: 'B', to: 'C', edge: edges[1], memory: memories[1] },
    { from: 'C', to: 'D', edge: edges[2], memory: memories[2] },
  ];
}

const config: FuseConfig = DEFAULT_FUSE_CONFIG;

describe('multihop', () => {
  it('跳数从 1 递增，累积权重单调下降', () => {
    const rows = multihopDecay({ hops: hops(), now: NOW, config });
    expect(rows.map((r) => r.depth)).toEqual([1, 2, 3]);
    expect(rows[0].accumulatedWeight).toBeLessThanOrEqual(1);
    expect(rows[1].accumulatedWeight).toBeLessThan(rows[0].accumulatedWeight);
    expect(rows[2].accumulatedWeight).toBeLessThan(rows[1].accumulatedWeight);
  });

  it('本跳衰减 = 单跳权重，等于累积权重之比', () => {
    const rows = multihopDecay({ hops: hops(), now: NOW, config });
    expect(rows[0].attenuation).toBeCloseTo(rows[0].singleHopWeight, 6);
    expect(rows[1].attenuation).toBeCloseTo(rows[1].accumulatedWeight / rows[0].accumulatedWeight, 3);
    expect(rows[2].attenuation).toBeCloseTo(rows[2].accumulatedWeight / rows[1].accumulatedWeight, 3);
  });

  it('首跳没有上游，间接份额为 0', () => {
    const rows = multihopDecay({ hops: hops(), now: NOW, config });
    expect(rows[0].indirectShare).toBe(0);
    expect(rows[0].directShare).toBe(1);
  });

  it('链越长，间接份额越高', () => {
    const rows = multihopDecay({ hops: hops(), now: NOW, config });
    expect(rows[2].indirectShare).toBeGreaterThan(rows[0].indirectShare);
  });

  it('目标节点正确', () => {
    expect(finalTarget(hops())).toBe('D');
    expect(finalTarget([])).toBeNull();
  });

  it('验证加成让单跳权重更高', () => {
    const { memories, edges } = buildHopChain();
    const hop = { from: 'A', to: 'B', edge: edges[0], memory: memories[0] } as Hop;
    const verified = hopWeight(hop, [edges[0]], NOW, config);
    const unverified = hopWeight(
      { ...hop, edge: { ...edges[0], verified: false } },
      [edges[0]],
      NOW,
      config,
    );
    expect(verified / unverified).toBeCloseTo(1.2, 6);
  });

  it('时间越久，单跳权重越低', () => {
    const staleEdge = makeEdge({
      id: 'e_stale',
      memoryId: 'm_stale',
      shareId: 's_stale',
      fromName: 'A',
      fromPubkey: PK.A,
      acceptedAt: daysAgo(500),
      verified: true,
    });
    const staleMemory = makeMemory({
      id: 'm_stale',
      kind: 'gift',
      tag: 'nature',
      intensity: 'mid',
      takenAt: daysAgo(500),
      acceptedAt: daysAgo(500),
      fromName: 'A',
      fromPubkey: PK.A,
      shareId: 's_stale',
    });
    const fresh = hopWeight(hops()[0], [hops()[0].edge], NOW, config);
    const stale = hopWeight(
      { from: 'A', to: 'B', edge: staleEdge, memory: staleMemory },
      [staleEdge],
      NOW,
      config,
    );
    expect(stale).toBeLessThan(fresh);
  });

  it('纯函数：重复调用结果一致，且空链返回空数组', () => {
    const a = multihopDecay({ hops: hops(), now: NOW, config });
    const b = multihopDecay({ hops: hops(), now: NOW, config });
    expect(a).toEqual(b);
    expect(multihopDecay({ hops: [], now: NOW, config })).toEqual([]);
  });
});
