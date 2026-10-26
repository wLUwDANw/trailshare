/**
 * Trip（旅程）存储。
 *
 * 为什么单独开一个 IndexedDB：主库 `src/store/db.ts` 的表结构是 memories/edges/chain/keys，
 * 本轮白名单不允许改它。旅程是"编辑中的草稿"，和记忆/溯源边没有事务关联，
 * 放独立小库反而更干净（和 `store/friends.ts` 同样的处理）。
 *
 * 一个 Trip 是整体读写：days / places / photos 全嵌在一个对象里，
 * 编辑时改内存模型再 `putTrip()` 覆盖。照片是压缩后的字节，别在上面存 File/Blob。
 */
import { openDB, type IDBPDatabase } from 'idb';
import { uuid } from '../utils/id';
import type { Place, Trip, TripPhoto } from '../types';

const DB_NAME = 'trailshare-trips';
const DB_VERSION = 1;
const TRIPS = 'trips';
const VISIBILITY = 'visibility';

let dbPromise: Promise<IDBPDatabase> | null = null;

/** visibility.ts 也用这个连接；两个 store 在同一个 upgrade 里建。 */
export function getTripDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(TRIPS)) {
          db.createObjectStore(TRIPS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(VISIBILITY)) {
          db.createObjectStore(VISIBILITY, { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

export function todayString(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function newTrip(title = '未命名旅程', now: Date = new Date()): Trip {
  return {
    id: `t_${uuid().slice(0, 8)}`,
    title,
    createdAt: now.toISOString(),
    days: [],
  };
}

export function newPlace(tag: Place['tag'] = 'nature'): Place {
  return {
    id: `p_${uuid().slice(0, 8)}`,
    name: '',
    tag,
    intensity: 'mid',
    coverIndex: 0,
    photos: [],
  };
}

export function newTripPhoto(image: ArrayBuffer, caption?: string): TripPhoto {
  return {
    id: `ph_${uuid().slice(0, 8)}`,
    image,
    ...(caption?.trim() ? { caption } : {}),
  };
}

export async function listTrips(): Promise<Trip[]> {
  const db = await getTripDB();
  const rows = (await db.getAll(TRIPS)) as Trip[];
  // 新建的在前
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export async function getTrip(id: string): Promise<Trip | null> {
  const db = await getTripDB();
  return ((await db.get(TRIPS, id)) as Trip | undefined) ?? null;
}

export async function putTrip(trip: Trip): Promise<void> {
  const db = await getTripDB();
  await db.put(TRIPS, trip);
}

/** 删 Trip 时顺手清掉它的所有 visibility 行，避免孤儿数据。 */
export async function deleteTrip(id: string): Promise<void> {
  const db = await getTripDB();
  await db.delete(TRIPS, id);
  const all = (await db.getAll(VISIBILITY)) as Array<{ id: string; tripId: string }>;
  await Promise.all(
    all.filter((v) => v.tripId === id).map((v) => db.delete(VISIBILITY, v.id)),
  );
}

/** 仅供测试 / "清空站点数据"使用。 */
export async function clearTrips(): Promise<void> {
  const db = await getTripDB();
  await db.clear(TRIPS);
  await db.clear(VISIBILITY);
}

export function tripStats(trip: Trip): { days: number; places: number; photos: number } {
  let places = 0;
  let photos = 0;
  for (const day of trip.days) {
    places += day.places.length;
    for (const place of day.places) photos += place.photos.length;
  }
  return { days: trip.days.length, places, photos };
}

/** 封面：优先 trip.coverPlaceId 的第一张，否则第一个有照片的地点的第一张。 */
export function coverPhotoOf(trip: Trip): TripPhoto | null {
  const preferred = trip.coverPlaceId
    ? trip.days.flatMap((d) => d.places).find((p) => p.id === trip.coverPlaceId)
    : undefined;
  const candidates = preferred ? [preferred, ...trip.days.flatMap((d) => d.places)] : trip.days.flatMap((d) => d.places);
  for (const place of candidates) {
    if (place.photos.length > 0) return place.photos[Math.min(place.coverIndex, place.photos.length - 1)] ?? null;
  }
  return null;
}

/** 一天里所有地点的照片数（Trip 列表页展示用）。 */
export function dayPhotoCount(trip: Trip, dayId: string): number {
  const day = trip.days.find((d) => d.id === dayId);
  if (!day) return 0;
  return day.places.reduce((n, p) => n + p.photos.length, 0);
}
