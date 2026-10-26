/** Memories CRUD。 */
import { getDB } from './db';
import { deleteEdgesByMemoryId } from './provenance';
import { fromStorage, toStorage } from '../utils/binary';
import type { Memory } from '../types';

/**
 * 取组内照片。兼容两种历史数据：
 * - 新记录：photos[]
 * - 旧记录：只有 thumbBlob（迁移前的单图）
 */
export function photosOf(memory: Memory): ArrayBuffer[] {
  if (Array.isArray(memory.photos) && memory.photos.length > 0) return memory.photos;
  return memory.thumbBlob ? [memory.thumbBlob] : [];
}

/** 封面下标兜底：缺失/非整数/越界一律回落到 0。 */
export function safeCoverIndex(memory: Memory, count: number): number {
  if (count <= 0) return 0;
  const i = memory.coverIndex;
  if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= count) return 0;
  return i;
}

export function coverOf(memory: Memory): ArrayBuffer | null {
  const photos = photosOf(memory);
  if (photos.length === 0) return null;
  return photos[safeCoverIndex(memory, photos.length)] ?? null;
}

/**
 * 写库前归一化：照片统一转成独立的 ArrayBuffer（Safari 的 Uint8Array 坑），
 * 并把旧的 thumbBlob/thumbMime 迁到 photos[] 上，之后不再写入这两个字段。
 */
function normalize(memory: Memory): Memory {
  const photos = photosOf(memory).map((p) => toStorage(fromStorage(p)));
  const out: Memory = {
    ...memory,
    photos,
    coverIndex: safeCoverIndex(memory, photos.length),
  };
  delete out.thumbBlob;
  delete out.thumbMime;
  return out;
}

export async function putMemory(memory: Memory): Promise<void> {
  const db = await getDB();
  await db.put('memories', normalize(memory));
}

export async function getMemory(id: string): Promise<Memory | null> {
  const db = await getDB();
  const row = await db.get('memories', id);
  return row ? normalize(row) : null;
}

export async function listMemories(): Promise<Memory[]> {
  const db = await getDB();
  const rows = await db.getAll('memories');
  return rows
    .map((m) => normalize(m))
    .sort((a, b) => new Date(b.takenAt).getTime() - new Date(a.takenAt).getTime());
}

/**
 * 删除一条记忆，并连带删除它关联的溯源边。
 *
 * 三条约定（对应"删除记忆"的需求）：
 * 1. 记忆不存在也不报错（幂等）
 * 2. 关联边一定清掉——否则 explain() 会继续把这条边当成有效来源
 * 3. chain 表不动：链只追加，删除记忆不改变历史
 */
export async function deleteMemory(memoryId: string): Promise<void> {
  const db = await getDB();
  await db.delete('memories', memoryId);
  await deleteEdgesByMemoryId(memoryId);
}

export async function countMemories(): Promise<number> {
  const db = await getDB();
  return db.count('memories');
}
