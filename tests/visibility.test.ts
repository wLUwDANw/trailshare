import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearTrips } from '../src/store/trips';
import {
  countedHidden,
  deleteVisibility,
  emptyVisibility,
  getVisibility,
  isHidden,
  listVisibility,
  putVisibility,
  visibilityId,
  withHidden,
} from '../src/store/visibility';

beforeEach(async () => {
  await clearTrips();
});

describe('Visibility 存储', () => {
  it('没有记录时返回全可见的空状态', async () => {
    const v = await getVisibility('t1', 'g1');
    expect(v.hiddenDayIds).toEqual([]);
    expect(v.hiddenPlaceIds).toEqual([]);
    expect(v.hiddenPhotoIds).toEqual([]);
    expect(v.hiddenCaptionPhotoIds).toEqual([]);
    expect(v.id).toBe('t1::g1');
  });

  it('id 由 tripId 与 groupId 拼成', () => {
    expect(visibilityId('t1', 'g2')).toBe('t1::g2');
    expect(emptyVisibility('t1', 'g2').groupId).toBe('g2');
  });

  it('put / get 按 group 独立', async () => {
    await putVisibility({ ...emptyVisibility('t1', 'g1'), hiddenDayIds: ['d1'] });
    await putVisibility({ ...emptyVisibility('t1', 'g2'), hiddenDayIds: ['d2'] });

    expect((await getVisibility('t1', 'g1')).hiddenDayIds).toEqual(['d1']);
    expect((await getVisibility('t1', 'g2')).hiddenDayIds).toEqual(['d2']);
    expect((await getVisibility('t1', 'g3')).hiddenDayIds).toEqual([]);
  });

  it('listVisibility 只返回同一趟旅程的组', async () => {
    await putVisibility({ ...emptyVisibility('t1', 'g1') });
    await putVisibility({ ...emptyVisibility('t1', 'g2') });
    await putVisibility({ ...emptyVisibility('t2', 'g1') });
    const list = await listVisibility('t1');
    expect(list.map((v) => v.groupId)).toEqual(['g1', 'g2']);
  });

  it('deleteVisibility 只删指定组', async () => {
    await putVisibility({ ...emptyVisibility('t1', 'g1'), hiddenDayIds: ['d1'] });
    await putVisibility({ ...emptyVisibility('t1', 'g2'), hiddenDayIds: ['d2'] });
    await deleteVisibility('t1', 'g1');
    expect((await getVisibility('t1', 'g1')).hiddenDayIds).toEqual([]);
    expect((await getVisibility('t1', 'g2')).hiddenDayIds).toEqual(['d2']);
  });

  it('withHidden 追加且不修改入参', () => {
    const base = emptyVisibility('t1', 'g1');
    const after = withHidden(base, 'day', 'd1', true);
    expect(base.hiddenDayIds).toEqual([]);
    expect(after.hiddenDayIds).toEqual(['d1']);
    expect(after).not.toBe(base);
  });

  it('withHidden 去重 / 取消', () => {
    let v = emptyVisibility('t1', 'g1');
    v = withHidden(v, 'photo', 'ph1', true);
    v = withHidden(v, 'photo', 'ph1', true);
    expect(v.hiddenPhotoIds).toEqual(['ph1']);
    v = withHidden(v, 'photo', 'ph1', false);
    expect(v.hiddenPhotoIds).toEqual([]);
  });

  it('四种 kind 落到各自的数组', () => {
    let v = emptyVisibility('t1', 'g1');
    v = withHidden(v, 'day', 'd1', true);
    v = withHidden(v, 'place', 'p1', true);
    v = withHidden(v, 'photo', 'ph1', true);
    v = withHidden(v, 'caption', 'ph2', true);
    expect(v.hiddenDayIds).toEqual(['d1']);
    expect(v.hiddenPlaceIds).toEqual(['p1']);
    expect(v.hiddenPhotoIds).toEqual(['ph1']);
    expect(v.hiddenCaptionPhotoIds).toEqual(['ph2']);
  });

  it('isHidden 与 countedHidden 一致', () => {
    const v = withHidden(withHidden(emptyVisibility('t1', 'g1'), 'day', 'd1', true), 'caption', 'ph1', true);
    expect(isHidden(v, 'day', 'd1')).toBe(true);
    expect(isHidden(v, 'day', 'd2')).toBe(false);
    expect(isHidden(v, 'caption', 'ph1')).toBe(true);
    expect(countedHidden(v)).toEqual({ days: 1, places: 0, photos: 0, captions: 1 });
  });

  it('取消父级隐藏不会自动打开子级', () => {
    let v = emptyVisibility('t1', 'g1');
    v = withHidden(v, 'day', 'd1', true);
    v = withHidden(v, 'photo', 'ph1', true);
    v = withHidden(v, 'day', 'd1', false);
    expect(isHidden(v, 'day', 'd1')).toBe(false);
    expect(isHidden(v, 'photo', 'ph1')).toBe(true);
  });
});
