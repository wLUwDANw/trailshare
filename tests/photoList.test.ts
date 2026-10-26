import { describe, expect, it } from 'vitest';
import {
  appendPhotos,
  clearPhotos,
  isFull,
  photoIdOf,
  removePhoto,
  setCover,
  MAX_PHOTOS,
  type PhotoEntry,
  type PhotoListState,
} from '../src/utils/photoList';

/** 造一张测试照片。n 不同 → name/size/mtime 都不同 → id 不同。 */
function entry(n: number): PhotoEntry {
  const name = `p${n}.jpg`;
  const size = 1000 + n;
  const lastModified = 1_700_000_000_000 + n;
  return {
    id: photoIdOf(name, size, lastModified),
    name,
    size,
    lastModified,
    data: new ArrayBuffer(4),
  };
}

function listOf(...ns: number[]): PhotoListState {
  return { photos: ns.map(entry), coverIndex: 0 };
}

describe('photoIdOf', () => {
  it('同样的 name+size+lastModified 永远得到同一个 id', () => {
    expect(photoIdOf('a.jpg', 100, 1000)).toBe(photoIdOf('a.jpg', 100, 1000));
  });

  it('任一字段不同就得到不同 id', () => {
    const base = photoIdOf('a.jpg', 100, 1000);
    expect(photoIdOf('b.jpg', 100, 1000)).not.toBe(base);
    expect(photoIdOf('a.jpg', 101, 1000)).not.toBe(base);
    expect(photoIdOf('a.jpg', 100, 1001)).not.toBe(base);
  });
});

describe('appendPhotos · 追加而不是覆盖', () => {
  it('空列表追加 1 张 → 长度 1，coverIndex = 0', () => {
    const { state, skipped } = appendPhotos({ photos: [], coverIndex: 0 }, [entry(1)]);
    expect(state.photos).toHaveLength(1);
    expect(state.coverIndex).toBe(0);
    expect(skipped).toEqual({ duplicate: 0, overflow: 0 });
  });

  it('1 张列表追加 2 张 → 长度 3，coverIndex 仍为 0，顺序为旧图在前', () => {
    const first = entry(1);
    const { state } = appendPhotos({ photos: [first], coverIndex: 0 }, [entry(2), entry(3)]);
    expect(state.photos).toHaveLength(3);
    expect(state.photos[0].id).toBe(first.id);
    expect(state.coverIndex).toBe(0);
  });

  it('追加重复照片（相同 id）→ 长度不变，skipped.duplicate = 1', () => {
    const one = entry(1);
    const { state, skipped } = appendPhotos({ photos: [one], coverIndex: 0 }, [entry(1)]);
    expect(state.photos).toHaveLength(1);
    expect(skipped.duplicate).toBe(1);
    expect(skipped.overflow).toBe(0);
  });

  it('同一批里自带重复也会去重', () => {
    const { state, skipped } = appendPhotos({ photos: [], coverIndex: 0 }, [entry(1), entry(1), entry(2)]);
    expect(state.photos).toHaveLength(2);
    expect(skipped.duplicate).toBe(1);
  });

  it('从 4 张追加 3 张 → 长度 5，skipped.overflow = 2', () => {
    const { state, skipped } = appendPhotos(listOf(1, 2, 3, 4), [entry(5), entry(6), entry(7)]);
    expect(state.photos).toHaveLength(MAX_PHOTOS);
    expect(skipped.overflow).toBe(2);
    expect(skipped.duplicate).toBe(0);
  });

  it('已满 5 张再追加 → 长度 5，overflow = N，coverIndex 不变', () => {
    const full: PhotoListState = { photos: [1, 2, 3, 4, 5].map(entry), coverIndex: 2 };
    const { state, skipped } = appendPhotos(full, [entry(6), entry(7)]);
    expect(state.photos).toHaveLength(MAX_PHOTOS);
    expect(skipped.overflow).toBe(2);
    expect(state.coverIndex).toBe(2);
  });

  it('追加不改变封面（不会跳到新图）', () => {
    const state: PhotoListState = { photos: [1, 2].map(entry), coverIndex: 1 };
    const { state: next } = appendPhotos(state, [entry(3)]);
    expect(next.coverIndex).toBe(1);
  });

  it('不修改入参（纯函数）', () => {
    const state = listOf(1, 2);
    const snapshot = state.photos.map((p) => p.id);
    appendPhotos(state, [entry(3)]);
    expect(state.photos).toHaveLength(2);
    expect(state.photos.map((p) => p.id)).toEqual(snapshot);
  });

  it('isFull 与上限一致', () => {
    expect(isFull(listOf(1, 2, 3, 4))).toBe(false);
    expect(isFull(listOf(1, 2, 3, 4, 5))).toBe(true);
  });
});

describe('removePhoto · 封面索引修正', () => {
  it('删除非封面且索引小于封面 → coverIndex 减 1', () => {
    const state: PhotoListState = { photos: [1, 2, 3, 4, 5].map(entry), coverIndex: 3 };
    const next = removePhoto(state, 1);
    expect(next.photos).toHaveLength(4);
    expect(next.coverIndex).toBe(2);
    expect(next.photos.some((p) => p.id === entry(2).id)).toBe(false);
  });

  it('删除封面本身 → coverIndex = 0', () => {
    const state: PhotoListState = { photos: [1, 2, 3].map(entry), coverIndex: 1 };
    const next = removePhoto(state, 1);
    expect(next.photos).toHaveLength(2);
    expect(next.coverIndex).toBe(0);
  });

  it('删除非封面且索引大于封面 → coverIndex 不变', () => {
    const state: PhotoListState = { photos: [1, 2, 3, 4].map(entry), coverIndex: 1 };
    const next = removePhoto(state, 3);
    expect(next.photos).toHaveLength(3);
    expect(next.coverIndex).toBe(1);
  });

  it('删除唯一一张 → 空列表，coverIndex = 0', () => {
    const next = removePhoto(listOf(1), 0);
    expect(next.photos).toEqual([]);
    expect(next.coverIndex).toBe(0);
  });

  it('越界索引原样返回', () => {
    const state = listOf(1, 2);
    expect(removePhoto(state, -1)).toBe(state);
    expect(removePhoto(state, 2)).toBe(state);
  });
});

describe('setCover / clearPhotos', () => {
  it('setCover 合法下标生效', () => {
    const next = setCover(listOf(1, 2, 3), 2);
    expect(next.coverIndex).toBe(2);
  });

  it('setCover 越界（负数、等于长度）→ 原样返回', () => {
    const state = listOf(1, 2, 3);
    expect(setCover(state, -1)).toBe(state);
    expect(setCover(state, 3)).toBe(state);
    expect(setCover(state, 1.5)).toBe(state);
  });

  it('clearPhotos → 空列表', () => {
    const next = clearPhotos();
    expect(next.photos).toEqual([]);
    expect(next.coverIndex).toBe(0);
  });
});
