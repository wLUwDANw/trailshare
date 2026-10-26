/** 本地哈希链 CRUD + 追加。 */
import { getDB } from './db';
import { appendChain, verifyChainLink, type ChainEvent } from '../crypto/chain';
import type { ChainRecord } from '../types';

export async function listChain(): Promise<ChainRecord[]> {
  const db = await getDB();
  const rows = await db.getAll('chain');
  return rows.sort((a, b) => a.seq - b.seq);
}

export async function lastChain(): Promise<ChainRecord | null> {
  const rows = await listChain();
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

export async function putChainRecord(record: ChainRecord): Promise<void> {
  const db = await getDB();
  await db.put('chain', record);
}

/** 追加一条链记录，返回新记录。ts 由调用方传入，保证可复现。 */
export async function appendChainRecord(
  event: ChainEvent,
  refId: string,
  sig: string,
  ts: string,
): Promise<ChainRecord> {
  const prev = await lastChain();
  const record = appendChain(prev, event, refId, sig, ts);
  const db = await getDB();
  await db.put('chain', record);
  return record;
}

export async function chainHealth(): Promise<{ ok: boolean; brokenAt: number | null; length: number }> {
  const rows = await listChain();
  const result = verifyChainLink(rows);
  return { ok: result.ok, brokenAt: result.brokenAt, length: rows.length };
}
