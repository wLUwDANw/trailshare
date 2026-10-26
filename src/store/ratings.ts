/**
 * 逐张照片的评星。评星存在 Memory.ratings 里（下标对应 photos），
 * 不单独开表——主库 schema 不归本阶段改，而评星本来就是记忆的一部分。
 */
import { getMemory, photosOf, putMemory } from './memories';

export const MIN_SCORE = 1;
export const MAX_SCORE = 5;

function assertScore(score: number | null): void {
  if (score === null) return;
  if (!Number.isInteger(score) || score < MIN_SCORE || score > MAX_SCORE) {
    throw new Error(`评分必须是 ${MIN_SCORE}–${MAX_SCORE} 的整数，或 null`);
  }
}

/** 设某张照片的评分；score=null 表示取消。 */
export async function setPhotoRating(
  memoryId: string,
  photoIndex: number,
  score: number | null,
): Promise<void> {
  assertScore(score);
  const memory = await getMemory(memoryId);
  if (!memory) throw new Error('找不到这条记忆');

  const count = photosOf(memory).length;
  if (!Number.isInteger(photoIndex) || photoIndex < 0 || photoIndex >= count) {
    throw new Error(`照片下标越界：${photoIndex}（共 ${count} 张）`);
  }

  const ratings: Array<number | null> = Array.from({ length: count }, (_, i) => memory.ratings?.[i] ?? null);
  ratings[photoIndex] = score;
  await putMemory({ ...memory, ratings });
}

/** 读某条记忆的评分表；长度对齐照片数，未评的位置是 null。 */
export async function getMemoryRatings(memoryId: string): Promise<Array<number | null>> {
  const memory = await getMemory(memoryId);
  if (!memory) return [];
  const count = photosOf(memory).length;
  return Array.from({ length: count }, (_, i) => memory.ratings?.[i] ?? null);
}
