import { describe, expect, it } from 'vitest';
import {
  groupPlacesCommitmentInput,
  groupPlacesCommitmentValue,
  verifyGroupPlacesCommitment,
  type GroupPlacesCommitmentInput,
} from '../src/crypto/commitment';

function group(partial: Partial<GroupPlacesCommitmentInput> = {}): GroupPlacesCommitmentInput {
  return {
    groupId: 'g1',
    saltB64: 'c2FsdA==',
    places: [
      { placeId: 'p1', tag: 'heritage', intensity: 'high' },
      { placeId: 'p2', tag: 'nature', intensity: 'mid' },
    ],
    ...partial,
  };
}

describe('v2026.4 组织承诺', () => {
  it('相同的可见地点 + 相同盐 → 承诺相同', () => {
    expect(groupPlacesCommitmentValue([group()])).toBe(groupPlacesCommitmentValue([group()]));
  });

  it('改任一 place 的 tag → 承诺变化', () => {
    const a = groupPlacesCommitmentValue([group()]);
    const b = groupPlacesCommitmentValue([
      group({ places: [{ placeId: 'p1', tag: 'food', intensity: 'high' }, { placeId: 'p2', tag: 'nature', intensity: 'mid' }] }),
    ]);
    expect(a).not.toBe(b);
  });

  it('屏蔽一个 place（从列表移除）→ 承诺变化', () => {
    const full = groupPlacesCommitmentValue([group()]);
    const hidden = groupPlacesCommitmentValue([group({ places: [group().places[0]] })]);
    expect(full).not.toBe(hidden);
  });

  it('place 顺序不影响承诺（按 placeId 排序）', () => {
    const reversed = group({ places: [group().places[1], group().places[0]] });
    expect(groupPlacesCommitmentValue([group()])).toBe(groupPlacesCommitmentValue([reversed]));
  });

  it('group 顺序不影响承诺（按 groupId 排序）', () => {
    const g1 = group({ groupId: 'g1', saltB64: 'a' });
    const g2 = group({ groupId: 'g2', saltB64: 'b', places: [{ placeId: 'p9', tag: 'food', intensity: 'low' }] });
    expect(groupPlacesCommitmentValue([g1, g2])).toBe(groupPlacesCommitmentValue([g2, g1]));
  });

  it('盐变化 → 承诺变化', () => {
    expect(groupPlacesCommitmentValue([group()])).not.toBe(
      groupPlacesCommitmentValue([group({ saltB64: 'b3RoZXI=' })]),
    );
  });

  it('输入字符串包含 groupId / salt / 每个 place 的三元组', () => {
    const input = groupPlacesCommitmentInput([group()]);
    expect(input).toContain('g1');
    expect(input).toContain('c2FsdA==');
    expect(input).toContain('p1||heritage||high');
    expect(input).toContain('p2||nature||mid');
  });

  it('verify 对正确值与错误值分别返回 true / false', () => {
    const value = groupPlacesCommitmentValue([group()]);
    expect(verifyGroupPlacesCommitment(value, [group()])).toBe(true);
    expect(verifyGroupPlacesCommitment(value, [group({ saltB64: 'x' })])).toBe(false);
  });
});
