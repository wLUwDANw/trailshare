/** ProvenanceEdges CRUD。拒绝的信物也会落一条边（rejected: true），供 trust 计算。 */
import { getDB } from './db';
import type { ProvenanceEdge } from '../types';

export async function putEdge(edge: ProvenanceEdge): Promise<void> {
  const db = await getDB();
  await db.put('edges', edge);
}

export async function listEdges(): Promise<ProvenanceEdge[]> {
  const db = await getDB();
  const rows = await db.getAll('edges');
  return rows.sort((a, b) => new Date(a.acceptedAt).getTime() - new Date(b.acceptedAt).getTime());
}

export async function findEdgeByShareId(shareId: string): Promise<ProvenanceEdge | null> {
  const rows = await listEdges();
  return rows.find((e) => e.shareId === shareId) ?? null;
}

/**
 * 删除某条记忆关联的全部溯源边，返回删除数量。
 * 没有任何关联边时返回 0，不抛错（幂等）。
 *
 * 注意：这里只动 edges 表。chain 表一个字都不碰——链的不可变性靠"只追加"保证，
 * 删记忆不等于改写历史，链上那条"曾被接受"的记录依然在。
 */
export async function deleteEdgesByMemoryId(memoryId: string): Promise<number> {
  const db = await getDB();
  const edges = await db.getAllFromIndex('edges', 'by-memory', memoryId);
  await Promise.all(edges.map((e) => db.delete('edges', e.id)));
  return edges.length;
}
