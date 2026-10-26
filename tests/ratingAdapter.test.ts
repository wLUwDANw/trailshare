import { describe, expect, it } from 'vitest';
import {
  adaptEdgesForFuse,
  averageRating,
  isAcceptedByRating,
  ratingsToCounts,
} from '../src/agent/ratingAdapter';
import type { Memory, ProvenanceEdge } from '../src/types';

function memory(id: string, ratings?: Array<number | null>): Memory {
  return {
    id,
    kind: 'gift',
    tag: 'nature',
    intensity: 'mid',
    takenAt: '2026-10-01T00:00:00.000Z',
    ...(ratings ? { ratings } : {}),
  };
}

function edge(id: string, memoryId: string, rejected = false): ProvenanceEdge {
  return {
    id,
    memoryId,
    shareId: 's_1',
    fromPubkey: 'ed25519:aa',
    fromName: 'A',
    commitment: 'sha256:00',
    signature: 'ed25519:00',
    chainAnchor: null,
    verified: true,
    acceptedAt: '2026-10-01T00:00:00.000Z',
    ...(rejected ? { rejected: true } : {}),
  };
}

describe('averageRating', () => {
  it('忽略 null；全 null 返回 null', () => {
    expect(averageRating([5, null, 3])).toBe(4);
    expect(averageRating([null, null])).toBeNull();
    expect(averageRating(undefined)).toBeNull();
    expect(averageRating([])).toBeNull();
  });
});

describe('ratingsToCounts', () => {
  it('全部未评 → 全部算 accepted', () => {
    const counts = ratingsToCounts([edge('e1', 'm1'), edge('e2', 'm2')], [memory('m1'), memory('m2')]);
    expect(counts).toEqual({ accepted: 2, rejected: 0 });
  });

  it('平均分 ≥ 3 → accepted', () => {
    expect(ratingsToCounts([edge('e1', 'm1')], [memory('m1', [3, 4])])).toEqual({
      accepted: 1,
      rejected: 0,
    });
  });

  it('平均分 < 3 → rejected', () => {
    expect(ratingsToCounts([edge('e1', 'm1')], [memory('m1', [1, 2])])).toEqual({
      accepted: 0,
      rejected: 1,
    });
  });

  it('3 星 + 5 星 → 平均 4 → accepted', () => {
    expect(isAcceptedByRating(memory('m1', [3, 5]))).toBe(true);
  });

  it('1 星 + 2 星 → 平均 1.5 → rejected', () => {
    expect(isAcceptedByRating(memory('m1', [1, 2]))).toBe(false);
  });

  it('已经拒绝的边始终计入 rejected', () => {
    const counts = ratingsToCounts([edge('e1', 'm1', true)], [memory('m1', [5])]);
    expect(counts).toEqual({ accepted: 0, rejected: 1 });
  });

  it('找不到对应记忆的边按 accepted 处理（保守）', () => {
    expect(ratingsToCounts([edge('e1', 'missing')], [])).toEqual({ accepted: 1, rejected: 0 });
  });
});

describe('adaptEdgesForFuse', () => {
  it('低分记忆的边被标记为 rejected，其余不变', () => {
    const edges = [edge('e1', 'good'), edge('e2', 'bad'), edge('e3', 'unrated')];
    const memories = [memory('good', [5]), memory('bad', [1]), memory('unrated')];
    const adapted = adaptEdgesForFuse(edges, memories);

    expect(adapted[0].rejected).toBeUndefined();
    expect(adapted[1].rejected).toBe(true);
    expect(adapted[2].rejected).toBeUndefined();
    // 不改入参
    expect(edges[1].rejected).toBeUndefined();
  });

  it('原本就 rejected 的边保持原样', () => {
    const adapted = adaptEdgesForFuse([edge('e1', 'm1', true)], [memory('m1', [5])]);
    expect(adapted[0].rejected).toBe(true);
  });
});
