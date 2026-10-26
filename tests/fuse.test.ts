import { describe, expect, it } from 'vitest';
import { fuse, normalizeScores, DEFAULT_FUSE_CONFIG } from '../src/agent/fuse';
import { rankTags, recommend, buildReason } from '../src/agent/recommend';
import { makeMemory, makeEdge, daysAgo, NOW, PK } from '../src/experiments/fixtures';
import type { FuseConfig, FuseInput, ProvenanceEdge, Memory } from '../src/types';

function cfg(strategy: FuseConfig['strategy'], extra: Partial<FuseConfig> = {}): FuseConfig {
  return { ...DEFAULT_FUSE_CONFIG, strategy, ...extra };
}

function baseInput(memories: Memory[], edges: ProvenanceEdge[], strategy: FuseConfig['strategy']): FuseInput {
  return { memories, edges, now: NOW, config: cfg(strategy) };
}

const natureGift = makeMemory({
  id: 'g1',
  kind: 'gift',
  tag: 'nature',
  intensity: 'high',
  takenAt: daysAgo(30),
  acceptedAt: daysAgo(10),
  fromName: 'A',
  fromPubkey: PK.A,
  shareId: 's_g1',
});

const edgeA: ProvenanceEdge = makeEdge({
  id: 'e_g1',
  memoryId: 'g1',
  shareId: 's_g1',
  fromName: 'A',
  fromPubkey: PK.A,
  acceptedAt: daysAgo(10),
  verified: true,
});

describe('fuse · 三种策略', () => {
  it('voting：每条边一票，不看时间与信任', () => {
    const old = makeMemory({
      ...natureGift,
      id: 'g_old',
      acceptedAt: daysAgo(3000),
      shareId: 's_old',
    });
    const oldEdge: ProvenanceEdge = { ...edgeA, id: 'e_old', memoryId: 'g_old', shareId: 's_old', acceptedAt: daysAgo(3000) };
    const out = fuse(baseInput([natureGift, old], [edgeA, oldEdge], 'voting'));
    expect(out.scores.nature).toBe(2);
  });

  it('trust：信任高的朋友权重更大', () => {
    const giftA = natureGift;
    const giftB = makeMemory({
      id: 'g_b',
      kind: 'gift',
      tag: 'nature',
      intensity: 'mid',
      takenAt: daysAgo(10),
      acceptedAt: daysAgo(10),
      fromName: 'B',
      fromPubkey: PK.B,
      shareId: 's_b',
    });
    const edgeB: ProvenanceEdge = {
      ...edgeA,
      id: 'e_b',
      memoryId: 'g_b',
      shareId: 's_b',
      fromPubkey: PK.B,
      fromName: 'B',
    };
    // A 有 3 次接受 → trust 3/4；B 只有 1 次 → trust 1/2
    const extraA = [1, 2].map((i) => ({
      ...edgeA,
      id: `e_a${i}`,
      memoryId: '',
      shareId: `s_a${i}`,
    }));
    const out = fuse(baseInput([giftA, giftB], [edgeA, ...extraA, edgeB], 'trust'));
    const a = out.contributions.nature.social.find((s) => s.fromPubkey === PK.A)!;
    const b = out.contributions.nature.social.find((s) => s.fromPubkey === PK.B)!;
    expect(a.weight).toBeGreaterThan(b.weight);
  });

  it('verified：验证通过额外加成', () => {
    const unverified: ProvenanceEdge = { ...edgeA, verified: false };
    const withBonus = fuse(baseInput([natureGift], [edgeA], 'verified')).scores.nature;
    const without = fuse(baseInput([natureGift], [unverified], 'verified')).scores.nature;
    expect(withBonus / without).toBeCloseTo(1.2, 6);
  });

  it('trust 与 verified 的差别只在验证加成', () => {
    const t = fuse(baseInput([natureGift], [edgeA], 'trust')).scores.nature;
    const v = fuse(baseInput([natureGift], [edgeA], 'verified')).scores.nature;
    expect(v / t).toBeCloseTo(1.2, 6);
  });

  it('被拒绝的边不贡献分数，但压低发件人权重', () => {
    const rejected: ProvenanceEdge = {
      ...edgeA,
      id: 'e_rej',
      memoryId: '',
      shareId: 's_rej',
      rejected: true,
    };
    const withoutReject = fuse(baseInput([natureGift], [edgeA], 'verified')).scores.nature;
    const withReject = fuse(baseInput([natureGift], [edgeA, rejected], 'verified')).scores.nature;
    expect(withReject).toBeLessThan(withoutReject);
    expect(withReject).toBeGreaterThan(0);
  });
});

describe('fuse · 时间衰减', () => {
  it('越老的记忆权重越低', () => {
    const fresh = makeMemory({
      id: 's1',
      kind: 'self',
      tag: 'food',
      intensity: 'mid',
      takenAt: daysAgo(5),
    });
    const stale = makeMemory({
      id: 's2',
      kind: 'self',
      tag: 'food',
      intensity: 'mid',
      takenAt: daysAgo(300),
    });
    const freshOnly = fuse(baseInput([fresh], [], 'verified')).scores.food;
    const both = fuse(baseInput([fresh, stale], [], 'verified')).scores.food;
    const staleOnly = fuse(baseInput([stale], [], 'verified')).scores.food;
    expect(freshOnly).toBeGreaterThan(staleOnly);
    expect(both).toBeCloseTo(freshOnly + staleOnly, 6);
  });

  it('半衰期可配置', () => {
    const m = makeMemory({ id: 's1', kind: 'self', tag: 'food', intensity: 'mid', takenAt: daysAgo(90) });
    const fast = fuse({ ...baseInput([m], [], 'verified'), config: cfg('verified', { halfLifeDays: 30 }) });
    const slow = fuse({ ...baseInput([m], [], 'verified'), config: cfg('verified', { halfLifeDays: 365 }) });
    expect(slow.scores.food).toBeGreaterThan(fast.scores.food);
  });
});

describe('fuse · 边界与纯函数性质', () => {
  it('边指向不存在的记忆时忽略，不抛错', () => {
    const orphan: ProvenanceEdge = { ...edgeA, memoryId: 'missing' };
    const out = fuse(baseInput([natureGift], [orphan], 'verified'));
    expect(out.scores.nature).toBe(0);
  });

  it('gift 记忆不直接计分（只通过边计分）', () => {
    const out = fuse(baseInput([natureGift], [], 'verified'));
    expect(out.scores.nature).toBe(0);
  });

  it('相同输入必得相同输出，且不修改入参', () => {
    const input = baseInput([natureGift], [edgeA], 'verified');
    const snapshot = JSON.stringify(input, (k, v) => (k === 'thumbBlob' ? 'blob' : v));
    const a = fuse(input);
    const b = fuse(input);
    expect(a).toEqual(b);
    expect(JSON.stringify(input, (k, v) => (k === 'thumbBlob' ? 'blob' : v))).toBe(snapshot);
  });

  it('contributions 的 self + social 之和等于 score', () => {
    const out = fuse(baseInput([natureGift], [edgeA], 'verified'));
    for (const tag of Object.keys(out.scores) as Array<keyof typeof out.scores>) {
      const contrib = out.contributions[tag];
      const socialSum = contrib.social.reduce((n, s) => n + s.weight, 0);
      expect(out.scores[tag]).toBeCloseTo(contrib.self + socialSum, 9);
    }
  });

  it('normalizeScores 归一化且全零时不炸', () => {
    const out = fuse(baseInput([natureGift], [edgeA], 'verified'));
    const norm = normalizeScores(out.scores);
    const total = Object.values(norm).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 9);
    const zeros = normalizeScores({ heritage: 0, nature: 0, watertown: 0, metropolis: 0, food: 0, leisure: 0 });
    expect(Object.values(zeros).every((v) => v === 0)).toBe(true);
  });
});

describe('recommend / rankTags', () => {
  it('排除目的地本身，按分数降序', () => {
    const metro = makeMemory({ id: 'm', kind: 'self', tag: 'metropolis', intensity: 'high', takenAt: daysAgo(1) });
    const food = makeMemory({ id: 'f', kind: 'self', tag: 'food', intensity: 'high', takenAt: daysAgo(1) });
    const out = fuse(baseInput([metro, food], [], 'verified'));
    const recs = recommend('metropolis', out, 3);
    expect(recs.map((r) => r.tag)).not.toContain('metropolis');
    expect(recs[0].tag).toBe('food');
  });

  it('rankTags 不排除任何标签', () => {
    const metro = makeMemory({ id: 'm', kind: 'self', tag: 'metropolis', intensity: 'high', takenAt: daysAgo(1) });
    const out = fuse(baseInput([metro], [], 'verified'));
    expect(rankTags(out, 3)).toEqual(['metropolis']);
  });

  it('得分为 0 的标签不进排行榜', () => {
    const out = fuse(baseInput([], [], 'verified'));
    expect(rankTags(out, 3)).toEqual([]);
  });

  it('理由能同时提到自己与朋友', () => {
    const selfNature = makeMemory({
      id: 's',
      kind: 'self',
      tag: 'nature',
      intensity: 'mid',
      takenAt: daysAgo(3),
    });
    const out = fuse(baseInput([selfNature, natureGift], [edgeA], 'verified'));
    const reason = buildReason('nature', out.contributions.nature);
    expect(reason).toContain('你自己');
    expect(reason).toContain('A');
  });
});
