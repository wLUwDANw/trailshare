import { describe, expect, it } from 'vitest';
import { applyVisibility, visibleStats } from '../src/utils/filter';
import type { Trip, VisibilityState } from '../src/types';

function photo(id: string, caption?: string) {
  return { id, image: new ArrayBuffer(4), ...(caption ? { caption } : {}) };
}

function trip(): Trip {
  return {
    id: 't1',
    title: '洛阳',
    createdAt: '2026-10-01T00:00:00.000Z',
    days: [
      {
        id: 'd1',
        date: '2026-10-01',
        places: [
          { id: 'p1', name: '龙门', tag: 'heritage', intensity: 'high', coverIndex: 0, photos: [photo('a', '配文A'), photo('b')] },
        ],
      },
      {
        id: 'd2',
        date: '2026-10-02',
        places: [
          { id: 'p2', name: '老君山', tag: 'nature', intensity: 'mid', coverIndex: 0, photos: [photo('c', '配文C')] },
          { id: 'p2b', name: '山顶', tag: 'nature', intensity: 'high', coverIndex: 0, photos: [photo('d')] },
        ],
      },
      {
        id: 'd3',
        date: '2026-10-03',
        places: [
          { id: 'p3', name: '洛邑', tag: 'watertown', intensity: 'low', coverIndex: 0, photos: [photo('e')] },
        ],
      },
    ],
  };
}

function vis(partial: Partial<VisibilityState> = {}): VisibilityState {
  return {
    id: 't1::g1',
    tripId: 't1',
    groupId: 'g1',
    hiddenDayIds: [],
    hiddenPlaceIds: [],
    hiddenPhotoIds: [],
    hiddenCaptionPhotoIds: [],
    ...partial,
  };
}

describe('applyVisibility', () => {
  it('无屏蔽 → 全部可见', () => {
    const result = applyVisibility(trip(), vis());
    expect(result.visiblePlaces.map((v) => v.place.id)).toEqual(['p1', 'p2', 'p2b', 'p3']);
    expect(visibleStats(result)).toEqual({ places: 4, photos: 5 });
  });

  it('屏蔽一整天 → 该天所有地点/照片/配文都不可见', () => {
    const result = applyVisibility(trip(), vis({ hiddenDayIds: ['d2'] }));
    expect(result.visiblePlaces.map((v) => v.place.id)).toEqual(['p1', 'p3']);
    for (const item of result.visiblePlaces) expect(item.dayDate).not.toBe('2026-10-02');
  });

  it('屏蔽一个地点 → 该地点全部不可见', () => {
    const result = applyVisibility(trip(), vis({ hiddenPlaceIds: ['p2'] }));
    expect(result.visiblePlaces.map((v) => v.place.id)).toEqual(['p1', 'p2b', 'p3']);
  });

  it('屏蔽一张照片 → 只少这一张', () => {
    const result = applyVisibility(trip(), vis({ hiddenPhotoIds: ['a'] }));
    const first = result.visiblePlaces.find((v) => v.place.id === 'p1')!;
    expect(first.visiblePhotos.map((v) => v.photo.id)).toEqual(['b']);
  });

  it('屏蔽一个配文 → 照片还在，includeCaption 变 false', () => {
    const result = applyVisibility(trip(), vis({ hiddenCaptionPhotoIds: ['a'] }));
    const first = result.visiblePlaces.find((v) => v.place.id === 'p1')!;
    const a = first.visiblePhotos.find((v) => v.photo.id === 'a')!;
    expect(a.includeCaption).toBe(false);
    // 没被屏蔽的配文仍然包含
    const c = result.visiblePlaces.find((v) => v.place.id === 'p2')!.visiblePhotos[0];
    expect(c.includeCaption).toBe(true);
  });

  it('全部屏蔽 → 空结果', () => {
    const result = applyVisibility(trip(), vis({ hiddenDayIds: ['d1', 'd2', 'd3'] }));
    expect(result.visiblePlaces).toEqual([]);
    expect(visibleStats(result)).toEqual({ places: 0, photos: 0 });
  });

  it('日期乱序也按日期升序输出，同一天保持原顺序', () => {
    const t = trip();
    t.days.reverse();
    const result = applyVisibility(t, vis());
    expect(result.visiblePlaces.map((v) => v.dayDate)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-02',
      '2026-10-03',
    ]);
    expect(result.visiblePlaces[1].place.id).toBe('p2');
    expect(result.visiblePlaces[2].place.id).toBe('p2b');
  });

  it('不修改入参', () => {
    const t = trip();
    const before = JSON.stringify(t);
    applyVisibility(t, vis({ hiddenDayIds: ['d1'], hiddenPhotoIds: ['b'] }));
    expect(JSON.stringify(t)).toBe(before);
  });

  it('一个地点的照片被全部屏蔽 → 该地点不出现在结果里', () => {
    const result = applyVisibility(trip(), vis({ hiddenPhotoIds: ['c'] }));
    expect(result.visiblePlaces.map((v) => v.place.id)).not.toContain('p2');
  });
});
