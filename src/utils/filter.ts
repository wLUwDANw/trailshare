/**
 * 可见性过滤（纯函数）。
 *
 * 层叠规则：
 *   Day 隐藏     → 这一天整个跳过
 *   Place 隐藏   → 这个地点整个跳过
 *   Photo 隐藏   → 跳过这张照片（配文随之消失）
 *   Caption 隐藏 → 照片保留，配文不打包
 *
 * 关键：这是"不打包"，不是"打包后不可见"。被过滤掉的内容不会出现在 SharePackage 里。
 *
 * 纯函数：不读 IndexedDB、不读 Date.now()、不改入参。
 */
import type { Place, Trip, TripPhoto, VisibilityState } from '../types';

export interface VisiblePhoto {
  photo: TripPhoto;
  /** 这张照片的配文是否要打包 */
  includeCaption: boolean;
}

export interface VisiblePlace {
  dayId: string;
  dayDate: string;
  place: Place;
  /** 至少一张（否则这个地点不会出现在结果里） */
  visiblePhotos: VisiblePhoto[];
}

export interface FilterResult {
  /** 按日期升序；同一天的多个地点保持原始顺序 */
  visiblePlaces: VisiblePlace[];
}

function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function applyVisibility(trip: Trip, visibility: VisibilityState): FilterResult {
  const hiddenDays = new Set(visibility.hiddenDayIds ?? []);
  const hiddenPlaces = new Set(visibility.hiddenPlaceIds ?? []);
  const hiddenPhotos = new Set(visibility.hiddenPhotoIds ?? []);
  const hiddenCaptions = new Set(visibility.hiddenCaptionPhotoIds ?? []);

  const collected: VisiblePlace[] = [];

  for (const day of trip.days) {
    if (hiddenDays.has(day.id)) continue;

    for (const place of day.places) {
      if (hiddenPlaces.has(place.id)) continue;

      const visiblePhotos: VisiblePhoto[] = [];
      for (const photo of place.photos) {
        if (hiddenPhotos.has(photo.id)) continue;
        visiblePhotos.push({
          photo,
          includeCaption: hasText(photo.caption) && !hiddenCaptions.has(photo.id),
        });
      }

      // 一张可见照片都没有的地点没有意义：不打包，也不出现在时间线里
      if (visiblePhotos.length === 0) continue;

      collected.push({ dayId: day.id, dayDate: day.date, place, visiblePhotos });
    }
  }

  // 按日期排序；同一天保持加入顺序（稳定排序）
  const ordered = collected
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (a.item.dayDate === b.item.dayDate) return a.index - b.index;
      return a.item.dayDate < b.item.dayDate ? -1 : 1;
    })
    .map((x) => x.item);

  return { visiblePlaces: ordered };
}

/** 可见内容的粗略统计，只给编辑/预览用，不进分享包。 */
export function visibleStats(result: FilterResult): { places: number; photos: number } {
  let photos = 0;
  for (const item of result.visiblePlaces) photos += item.visiblePhotos.length;
  return { places: result.visiblePlaces.length, photos };
}
