/**
 * 屏蔽状态（Visibility）存储：**每个 group 独立一份**。
 *
 * 语义不是"打包后不可见"，而是"根本不打包"——被隐藏的条目不会出现在 SharePackage 里。
 * 层叠关系见 src/utils/filter.ts 的 applyVisibility()。
 */
import { getTripDB } from './trips';
import type { VisibilityState } from '../types';

export type HiddenKind = 'day' | 'place' | 'photo' | 'caption';

const STORE = 'visibility';

export function visibilityId(tripId: string, groupId: string): string {
  return `${tripId}::${groupId}`;
}

export function emptyVisibility(tripId: string, groupId: string): VisibilityState {
  return {
    id: visibilityId(tripId, groupId),
    tripId,
    groupId,
    hiddenDayIds: [],
    hiddenPlaceIds: [],
    hiddenPhotoIds: [],
    hiddenCaptionPhotoIds: [],
  };
}

/** 缺记录时返回空状态（全可见），不写库。 */
export async function getVisibility(tripId: string, groupId: string): Promise<VisibilityState> {
  const db = await getTripDB();
  const row = (await db.get(STORE, visibilityId(tripId, groupId))) as VisibilityState | undefined;
  return row ?? emptyVisibility(tripId, groupId);
}

export async function putVisibility(state: VisibilityState): Promise<void> {
  const db = await getTripDB();
  await db.put(STORE, state);
}

export async function listVisibility(tripId: string): Promise<VisibilityState[]> {
  const db = await getTripDB();
  const all = (await db.getAll(STORE)) as VisibilityState[];
  return all.filter((v) => v.tripId === tripId).sort((a, b) => (a.groupId < b.groupId ? -1 : 1));
}

export async function deleteVisibility(tripId: string, groupId: string): Promise<void> {
  const db = await getTripDB();
  await db.delete(STORE, visibilityId(tripId, groupId));
}

/* ---------------- 纯函数：勾选状态 ---------------- */

function idsOf(state: VisibilityState, kind: HiddenKind): string[] {
  switch (kind) {
    case 'day':
      return state.hiddenDayIds;
    case 'place':
      return state.hiddenPlaceIds;
    case 'photo':
      return state.hiddenPhotoIds;
    case 'caption':
      return state.hiddenCaptionPhotoIds;
  }
}

function withIds(state: VisibilityState, kind: HiddenKind, ids: string[]): VisibilityState {
  const next: VisibilityState = {
    ...state,
    hiddenDayIds: [...state.hiddenDayIds],
    hiddenPlaceIds: [...state.hiddenPlaceIds],
    hiddenPhotoIds: [...state.hiddenPhotoIds],
    hiddenCaptionPhotoIds: [...state.hiddenCaptionPhotoIds],
  };
  switch (kind) {
    case 'day':
      next.hiddenDayIds = ids;
      break;
    case 'place':
      next.hiddenPlaceIds = ids;
      break;
    case 'photo':
      next.hiddenPhotoIds = ids;
      break;
    case 'caption':
      next.hiddenCaptionPhotoIds = ids;
      break;
  }
  return next;
}

export function isHidden(state: VisibilityState, kind: HiddenKind, id: string): boolean {
  return idsOf(state, kind).includes(id);
}

/** 纯函数：返回新状态，不改入参。隐藏用去重追加，取消用过滤。 */
export function withHidden(
  state: VisibilityState,
  kind: HiddenKind,
  id: string,
  hidden: boolean,
): VisibilityState {
  const current = idsOf(state, kind);
  const next = hidden
    ? current.includes(id)
      ? current
      : [...current, id]
    : current.filter((x) => x !== id);
  if (next === current) return state;
  return withIds(state, kind, next);
}

/**
 * 取消某个 Day 的隐藏时，它的子项仍然保持各自的隐藏状态——
 * 层叠过滤是"隐藏优先"，父级打开不应该把子级也打开。
 */
export function countedHidden(state: VisibilityState): {
  days: number;
  places: number;
  photos: number;
  captions: number;
} {
  return {
    days: state.hiddenDayIds.length,
    places: state.hiddenPlaceIds.length,
    photos: state.hiddenPhotoIds.length,
    captions: state.hiddenCaptionPhotoIds.length,
  };
}
