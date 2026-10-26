/**
 * IndexedDB 初始化。Store 层只做 CRUD，不包含任何算法。
 *
 * 注意：thumbBlob 以 ArrayBuffer 落库（方案 4.3），读出来后由调用方转 Uint8Array。
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ChainRecord, KeyPairRecord, Memory, ProvenanceEdge } from '../types';

export const DB_NAME = 'trailshare';
export const DB_VERSION = 1;

interface TrailShareDB extends DBSchema {
  memories: { key: string; value: Memory; indexes: { 'by-kind': string; 'by-tag': string } };
  edges: { key: string; value: ProvenanceEdge; indexes: { 'by-memory': string } };
  chain: { key: number; value: ChainRecord };
  keys: { key: string; value: KeyPairRecord };
}

export type TrailDB = IDBPDatabase<TrailShareDB>;

let dbPromise: Promise<TrailDB> | null = null;

export function getDB(): Promise<TrailDB> {
  if (!dbPromise) {
    dbPromise = openDB<TrailShareDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('memories')) {
          const store = db.createObjectStore('memories', { keyPath: 'id' });
          store.createIndex('by-kind', 'kind');
          store.createIndex('by-tag', 'tag');
        }
        if (!db.objectStoreNames.contains('edges')) {
          const store = db.createObjectStore('edges', { keyPath: 'id' });
          store.createIndex('by-memory', 'memoryId');
        }
        if (!db.objectStoreNames.contains('chain')) {
          db.createObjectStore('chain', { keyPath: 'seq' });
        }
        if (!db.objectStoreNames.contains('keys')) {
          db.createObjectStore('keys', { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

/** 测试或"重新初始化"时使用。 */
export async function closeDB(): Promise<void> {
  if (!dbPromise) return;
  const db = await dbPromise;
  db.close();
  dbPromise = null;
}

export async function clearAll(): Promise<void> {
  const db = await getDB();
  await Promise.all([
    db.clear('memories'),
    db.clear('edges'),
    db.clear('chain'),
    db.clear('keys'),
  ]);
}
