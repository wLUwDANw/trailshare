/**
 * 照片列表的纯函数状态机（无 DOM、无 IO、无随机）。
 *
 * 为什么单独抽出来：选择文件的 change 事件里混着"追加 / 去重 / 上限 / 封面索引修正"
 * 四件事，写在 UI 里既难测也容易出错——之前的 Bug 就是把它写成了"整体覆盖"。
 * 这里全部改成纯函数：进一个状态、出一个新状态，UI 只负责调函数 + 渲染。
 *
 * 约定：
 * - 状态不可变：所有函数都返回新对象，不修改入参
 * - coverIndex 永远指向 photos 的下标；空列表时为 0
 * - 追加不改变封面（除非原本就是空列表）
 */

export interface PhotoEntry {
  /** name + size + lastModified 的哈希，用于去重 */
  id: string;
  name: string;
  size: number;
  lastModified: number;
  /** 压缩后的数据（不是原图） */
  data: ArrayBuffer;
}

export interface PhotoListState {
  photos: PhotoEntry[];
  coverIndex: number;
}

export const MAX_PHOTOS = 5;

export interface AppendSkipped {
  /** 因为 id 重复被跳过的数量 */
  duplicate: number;
  /** 因为超过上限被截断的数量 */
  overflow: number;
}

/**
 * 生成照片 id：对 "name|size|lastModified" 做 FNV-1a 32 位哈希。
 * 纯函数、同步、不依赖 crypto.subtle，所以 Node 里也能测。
 * 同一张照片重复选择会得到同一个 id —— 这正是去重想要的。
 */
export function photoIdOf(name: string, size: number, lastModified: number): string {
  const input = `${name}|${size}|${lastModified}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `p_${hash.toString(16).padStart(8, '0')}`;
}

function emptyState(): PhotoListState {
  return { photos: [], coverIndex: 0 };
}

/**
 * 追加照片（Bug 1 的修复点：追加，不是覆盖）。
 *
 * - 按 id 去重：已存在的不追加，计入 duplicate
 * - 超过 MAX_PHOTOS 的截断，计入 overflow
 * - coverIndex 保持不变；只有"原本是空列表"时才归 0
 * - 不因为追加而把封面跳到新图
 */
export function appendPhotos(
  state: PhotoListState,
  newOnes: PhotoEntry[],
): { state: PhotoListState; skipped: AppendSkipped } {
  const seen = new Set(state.photos.map((p) => p.id));
  const accepted: PhotoEntry[] = [];
  let duplicate = 0;
  let overflow = 0;

  for (const photo of newOnes) {
    if (seen.has(photo.id)) {
      duplicate += 1;
      continue;
    }
    if (state.photos.length + accepted.length >= MAX_PHOTOS) {
      overflow += 1;
      continue;
    }
    seen.add(photo.id);
    accepted.push(photo);
  }

  if (accepted.length === 0) {
    // 一张都没进来：状态原样返回（仍然返回新对象，保持不可变语义）
    return { state: { photos: state.photos.slice(), coverIndex: state.coverIndex }, skipped: { duplicate, overflow } };
  }

  const photos = [...state.photos, ...accepted];
  // 原本空列表 → 第一张自动成为封面；否则封面索引原地不动
  const coverIndex = state.photos.length === 0 ? 0 : state.coverIndex;

  return { state: { photos, coverIndex }, skipped: { duplicate, overflow } };
}

/**
 * 删除指定下标的照片，并修正封面索引：
 * - index < coverIndex  → 封面整体左移一位
 * - index === coverIndex → 封面回到第 0 张
 * - index > coverIndex  → 封面不动
 * - 删空 → { [], 0 }
 */
export function removePhoto(state: PhotoListState, index: number): PhotoListState {
  if (!Number.isInteger(index) || index < 0 || index >= state.photos.length) return state;

  const photos = state.photos.filter((_, i) => i !== index);
  if (photos.length === 0) return emptyState();

  let coverIndex = state.coverIndex;
  if (index < coverIndex) coverIndex -= 1;
  else if (index === coverIndex) coverIndex = 0;

  // 兜底：任何情况下封面都必须落在合法范围内
  if (coverIndex < 0 || coverIndex >= photos.length) coverIndex = 0;

  return { photos, coverIndex };
}

/** 设置封面：下标非法时原样返回（同一个对象，方便调用方做引用比较）。 */
export function setCover(state: PhotoListState, index: number): PhotoListState {
  if (!Number.isInteger(index) || index < 0 || index >= state.photos.length) return state;
  if (index === state.coverIndex) return state;
  return { photos: state.photos, coverIndex: index };
}

/** 清空。 */
export function clearPhotos(): PhotoListState {
  return emptyState();
}

/** 便捷判断：还能不能再加。 */
export function isFull(state: PhotoListState): boolean {
  return state.photos.length >= MAX_PHOTOS;
}
