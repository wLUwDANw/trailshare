import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTrips,
  coverPhotoOf,
  dayPhotoCount,
  deleteTrip,
  getTrip,
  listTrips,
  newPlace,
  newTrip,
  newTripPhoto,
  putTrip,
  todayString,
  tripStats,
} from '../src/store/trips';
import { getVisibility, putVisibility } from '../src/store/visibility';
import type { Trip } from '../src/types';

function sampleTrip(id = 't1', createdAt = '2026-10-01T00:00:00.000Z'): Trip {
  return {
    id,
    title: '洛阳',
    createdAt,
    days: [
      {
        id: 'd1',
        date: '2026-10-01',
        places: [
          {
            id: 'p1',
            name: '龙门',
            tag: 'heritage',
            intensity: 'high',
            coverIndex: 1,
            photos: [
              newTripPhoto(new Uint8Array([1]).buffer, '一'),
              newTripPhoto(new Uint8Array([2]).buffer),
            ],
          },
        ],
      },
      {
        id: 'd2',
        date: '2026-10-02',
        places: [],
      },
    ],
  };
}

beforeEach(async () => {
  await clearTrips();
});

describe('Trip 存储', () => {
  it('newTrip 生成 id / createdAt / 空 days', () => {
    const t = newTrip('测试', new Date('2026-10-01T00:00:00.000Z'));
    expect(t.id.startsWith('t_')).toBe(true);
    expect(t.title).toBe('测试');
    expect(t.days).toEqual([]);
    expect(t.createdAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('put / get 往返，嵌套照片与配文都在', async () => {
    const trip = sampleTrip();
    await putTrip(trip);
    const loaded = await getTrip('t1');
    expect(loaded?.title).toBe('洛阳');
    expect(loaded?.days.length).toBe(2);
    expect(loaded?.days[0].places[0].photos.length).toBe(2);
    expect(loaded?.days[0].places[0].photos[0].caption).toBe('一');
  });

  it('get 不存在的 id → null', async () => {
    expect(await getTrip('nope')).toBeNull();
  });

  it('listTrips 按 createdAt 倒序', async () => {
    await putTrip(sampleTrip('t1', '2026-10-01T00:00:00.000Z'));
    await putTrip(sampleTrip('t2', '2026-10-05T00:00:00.000Z'));
    const list = await listTrips();
    expect(list.map((t) => t.id)).toEqual(['t2', 't1']);
  });

  it('put 覆盖同 id', async () => {
    await putTrip(sampleTrip());
    const changed = sampleTrip();
    changed.title = '改名';
    await putTrip(changed);
    expect((await getTrip('t1'))?.title).toBe('改名');
    expect((await listTrips()).length).toBe(1);
  });

  it('deleteTrip 删除旅程', async () => {
    await putTrip(sampleTrip());
    await deleteTrip('t1');
    expect(await getTrip('t1')).toBeNull();
  });

  it('deleteTrip 连带清掉 visibility 行', async () => {
    await putTrip(sampleTrip());
    await putVisibility({
      id: 't1::g1',
      tripId: 't1',
      groupId: 'g1',
      hiddenDayIds: ['d1'],
      hiddenPlaceIds: [],
      hiddenPhotoIds: [],
      hiddenCaptionPhotoIds: [],
    });
    expect((await getVisibility('t1', 'g1')).hiddenDayIds).toEqual(['d1']);
    await deleteTrip('t1');
    expect((await getVisibility('t1', 'g1')).hiddenDayIds).toEqual([]);
  });

  it('tripStats 统计天数 / 地点 / 照片', () => {
    expect(tripStats(sampleTrip())).toEqual({ days: 2, places: 1, photos: 2 });
  });

  it('coverPhotoOf 优先 coverPlaceId，其次第一个有照片的地点', () => {
    const trip = sampleTrip();
    const fallback = coverPhotoOf(trip);
    expect(fallback?.caption).toBeUndefined();
    expect(new Uint8Array(fallback!.image)[0]).toBe(2); // coverIndex=1

    trip.coverPlaceId = 'p1';
    expect(coverPhotoOf(trip)).not.toBeNull();
  });

  it('没有任何照片时 coverPhotoOf 返回 null', () => {
    const trip = sampleTrip();
    trip.days[0].places[0].photos = [];
    expect(coverPhotoOf(trip)).toBeNull();
  });

  it('todayString 形如 YYYY-MM-DD', () => {
    expect(todayString(new Date('2026-03-05T10:00:00'))).toBe('2026-03-05');
  });

  it('dayPhotoCount 统计某天照片数', () => {
    expect(dayPhotoCount(sampleTrip(), 'd1')).toBe(2);
    expect(dayPhotoCount(sampleTrip(), 'd2')).toBe(0);
    expect(dayPhotoCount(sampleTrip(), 'nope')).toBe(0);
  });

  it('newPlace 默认值完整', () => {
    const p = newPlace();
    expect(p.tag).toBe('nature');
    expect(p.intensity).toBe('mid');
    expect(p.coverIndex).toBe(0);
    expect(p.photos).toEqual([]);
  });
});
