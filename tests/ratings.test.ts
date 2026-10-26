import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearAll } from '../src/store/db';
import { putMemory } from '../src/store/memories';
import { getMemoryRatings, setPhotoRating } from '../src/store/ratings';

function memory(id: string, photoCount = 2) {
  return {
    id,
    kind: 'gift' as const,
    photos: Array.from({ length: photoCount }, (_, i) => new Uint8Array([i + 1]).buffer),
    coverIndex: 0,
    tag: 'nature' as const,
    intensity: 'high' as const,
    takenAt: '2026-10-01T12:00:00.000Z',
  };
}

beforeEach(async () => {
  await clearAll();
});

describe('评星存储', () => {
  it('设置评分 → 读取正确', async () => {
    await putMemory(memory('m1'));
    await setPhotoRating('m1', 0, 5);
    expect(await getMemoryRatings('m1')).toEqual([5, null]);
  });

  it('取消评分 → 变 null', async () => {
    await putMemory(memory('m1'));
    await setPhotoRating('m1', 1, 2);
    await setPhotoRating('m1', 1, null);
    expect(await getMemoryRatings('m1')).toEqual([null, null]);
  });

  it('多张照片独立评分', async () => {
    await putMemory(memory('m1', 3));
    await setPhotoRating('m1', 0, 1);
    await setPhotoRating('m1', 1, 3);
    await setPhotoRating('m1', 2, 5);
    expect(await getMemoryRatings('m1')).toEqual([1, 3, 5]);
  });

  it('评分越界（0 / 6）→ 抛错', async () => {
    await putMemory(memory('m1'));
    await expect(setPhotoRating('m1', 0, 0)).rejects.toThrow(/1–5/);
    await expect(setPhotoRating('m1', 0, 6)).rejects.toThrow(/1–5/);
  });

  it('照片下标越界 → 抛错', async () => {
    await putMemory(memory('m1', 2));
    await expect(setPhotoRating('m1', 2, 3)).rejects.toThrow(/下标越界/);
    await expect(setPhotoRating('m1', -1, 3)).rejects.toThrow(/下标越界/);
  });

  it('记忆不存在 → 抛错', async () => {
    await expect(setPhotoRating('nope', 0, 3)).rejects.toThrow(/找不到/);
  });

  it('未评过的记忆读取为全 null', async () => {
    await putMemory(memory('m1', 2));
    expect(await getMemoryRatings('m1')).toEqual([null, null]);
  });
});
